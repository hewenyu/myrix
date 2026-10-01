// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package controller contains the TenantCell reconciler: the only component
// allowed to change a cell's lifecycle phase or its replica count.
package controller

import (
	"context"
	"errors"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
	"github.com/myrix/apps/cell-manager/internal/cell/k8s"
	"github.com/myrix/apps/cell-manager/internal/driver"
	"github.com/myrix/apps/cell-manager/internal/state"
)

// Clock is injected so tests do not depend on wall time.
type Clock interface {
	Now() time.Time
}

// RealClock returns wall-clock time.
type RealClock struct{}

// Now implements Clock.
func (RealClock) Now() time.Time { return time.Now() }

// CellReconciler reconciles TenantCell objects.
//
// Authorisation: the ServiceAccount behind this manager is bound only to a
// Role in the Runtime namespace. The reconciler refuses to touch objects in
// any other namespace, so a misconfiguration cannot silently turn it into a
// cluster-wide operator.
type CellReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// Driver is the runtime driver client. Nil means "no driver", which the
	// machine treats as unreachable: never Ready, never scaled down.
	Driver driver.Client
	// Recorder emits Kubernetes events; may be nil in tests.
	Recorder record.EventRecorder
	// Clock is the injected time source.
	Clock Clock
	// Namespace is the only namespace this manager may manage workloads in.
	// Empty disables the check (used by envtest-style tests).
	Namespace string
}

// +kubebuilder:rbac:groups=myrix.io,resources=tenantcells,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=myrix.io,resources=tenantcells/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch;delete

// Reconcile implements the control loop.
func (r *CellReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var cell v1alpha1.TenantCell
	if err := r.Get(ctx, req.NamespacedName, &cell); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !cell.DeletionTimestamp.IsZero() {
		// Deletion of a TenantCell must not delete tenant data. Owner
		// references and the Retain retention policy keep the PVC; we add no
		// finalizer that could ever remove it.
		logger.V(1).Info("cell is being deleted; leaving the PVC in place", "cell", cell.Name)
		return ctrl.Result{}, nil
	}

	if r.Namespace != "" && cell.Namespace != r.Namespace {
		// Fail closed and loudly: this should be impossible with a namespaced
		// Role, but a misconfigured cache must not produce cross-namespace
		// writes.
		err := fmt.Errorf("cell %s/%s is outside the authorised runtime namespace %q", cell.Namespace, cell.Name, r.Namespace)
		r.event(&cell, corev1.EventTypeWarning, "NamespaceNotAuthorised", err.Error())
		return ctrl.Result{}, err
	}

	if err := state.ValidateSpec(&cell); err != nil {
		return r.rejectInvalid(ctx, &cell, err)
	}

	obs, err := r.observe(ctx, &cell)
	if err != nil {
		return ctrl.Result{}, err
	}
	before := cell.Status.Phase
	decision := state.Decide(obs)

	// Apply the workload before recording status, so a crash in between
	// leaves the cell in a state the next loop repairs (the phase still says
	// Draining/Starting, and scale-down requires a fresh proof).
	//
	// applyWorkload only patches when something actually differs, so calling
	// it on every pass is cheap and keeps spec changes (image, storage class,
	// scheduling) converging even in phases that take no action.
	if err := r.applyWorkload(ctx, &cell, decision.Replicas); err != nil {
		return ctrl.Result{}, err
	}

	if err := r.applyStatus(ctx, &cell, obs, decision); err != nil {
		return ctrl.Result{}, err
	}

	r.emit(&cell, before, decision)
	if decision.RequeueAfter > 0 {
		return ctrl.Result{RequeueAfter: decision.RequeueAfter}, nil
	}
	return ctrl.Result{Requeue: true}, nil
}

// observe gathers Kubernetes state and, for the phases that need it, the
// runtime driver's answers.
func (r *CellReconciler) observe(ctx context.Context, cell *v1alpha1.TenantCell) (state.Observation, error) {
	obs := state.Observation{
		Now:                r.now(),
		Generation:         cell.Generation,
		Phase:              cell.Status.Phase,
		ObservedGeneration: cell.Status.ObservedGeneration,
		BootID:             cell.Status.BootID,
		WakeAttempts:       cell.Status.WakeAttempts,
		Tier:               cell.Spec.Tier,
		WantRunning:        cell.Spec.WantRunning,
		IdleTimeout:        time.Duration(cell.Spec.IdleTimeout()) * time.Second,
		MaxWakeAttempts:    cell.Spec.MaxWakeAttemptsOrDefault(),
		ReadyTimeout:       time.Duration(cell.Spec.ReadyTimeout()) * time.Second,
	}
	if cell.Status.WakeStartedAt != nil {
		obs.WakeStartedAt = cell.Status.WakeStartedAt.Time
	}
	if cell.Status.ReadySince != nil {
		obs.ReadySince = cell.Status.ReadySince.Time
	}
	if cell.Status.LastIdleProofAt != nil {
		obs.LastIdleProofAt = cell.Status.LastIdleProofAt.Time
	}

	var sts appsv1.StatefulSet
	err := r.Get(ctx, types.NamespacedName{Namespace: cell.Namespace, Name: k8s.StatefulSetName(cell)}, &sts)
	switch {
	case err == nil:
		if sts.Status.Replicas > 1 {
			// Should be impossible; treat as a hard error rather than
			// silently correcting, because it means something else wrote.
			return obs, fmt.Errorf("statefulset %s/%s has %d replicas; cells are 0/1 only", sts.Namespace, sts.Name, sts.Status.Replicas)
		}
		obs.Replicas = sts.Status.Replicas
		obs.ReadyReplicas = sts.Status.ReadyReplicas
	case apierrors.IsNotFound(err):
		obs.Replicas = 0
	default:
		return obs, err
	}

	var pod corev1.Pod
	err = r.Get(ctx, types.NamespacedName{Namespace: cell.Namespace, Name: k8s.PodName(cell)}, &pod)
	switch {
	case err == nil:
		obs.PodExists = true
		obs.PodReady = podReady(&pod)
	case apierrors.IsNotFound(err):
	default:
		return obs, err
	}

	// A missing driver client is treated exactly like an unreachable driver:
	// the machine then refuses to report Ready and refuses to scale down.
	d := r.Driver
	if d == nil {
		return obs, nil
	}

	switch cell.Status.Phase {
	case v1alpha1.PhaseStarting, v1alpha1.PhaseWaking:
		ep := driver.Endpoint{BaseURL: k8s.DriverEndpoint(cell, r.podIP(ctx, cell))}
		if !ep.Valid() {
			return obs, nil
		}
		info, derr := d.Ready(ctx, ep)
		if derr != nil {
			r.event(cell, corev1.EventTypeWarning, "DriverUnavailable", derr.Error())
			return obs, nil
		}
		obs.DriverReachable = true
		obs.ReadyBootID = info.BootID
	case v1alpha1.PhaseDraining:
		ep := driver.Endpoint{BaseURL: k8s.DriverEndpoint(cell, r.podIP(ctx, cell))}
		if !ep.Valid() {
			return obs, nil
		}
		drain, derr := d.Drain(ctx, ep)
		if derr != nil {
			r.event(cell, corev1.EventTypeWarning, "DriverUnavailable", derr.Error())
			return obs, nil
		}
		obs.DriverReachable = true
		obs.Drain = &drain
		proof, perr := d.IdleProof(ctx, ep)
		if perr != nil {
			// "driver refused" and "transport failed" are different facts:
			// only a refusal becomes an idle-proof rejection.
			var rejection *driver.IdleProofRejection
			if errors.As(perr, &rejection) {
				obs.IdleRejection = rejection
			} else {
				r.event(cell, corev1.EventTypeWarning, "DriverUnavailable", perr.Error())
			}
			return obs, nil
		}
		if verr := proof.Validate(obs.BootID, obs.IdleTimeout, obs.Now); verr != nil {
			var rejection *driver.IdleProofRejection
			if errors.As(verr, &rejection) {
				obs.IdleRejection = rejection
			}
			return obs, nil
		}
		obs.Idle = &proof
	}
	return obs, nil
}

func (r *CellReconciler) podIP(ctx context.Context, cell *v1alpha1.TenantCell) string {
	var pod corev1.Pod
	if err := r.Get(ctx, types.NamespacedName{Namespace: cell.Namespace, Name: k8s.PodName(cell)}, &pod); err != nil {
		return ""
	}
	return pod.Status.PodIP
}

func podReady(pod *corev1.Pod) bool {
	if pod.DeletionTimestamp != nil {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// applyWorkload creates or updates the StatefulSet and Service at the desired
// replica count. The PVC is never touched.
func (r *CellReconciler) applyWorkload(ctx context.Context, cell *v1alpha1.TenantCell, replicas int32) error {
	desired := k8s.StatefulSet(cell, replicas)
	if err := controllerutil.SetControllerReference(cell, desired, r.Scheme); err != nil {
		return fmt.Errorf("setting controller reference: %w", err)
	}

	existing := &appsv1.StatefulSet{}
	err := r.Get(ctx, types.NamespacedName{Namespace: cell.Namespace, Name: desired.Name}, existing)
	switch {
	case apierrors.IsNotFound(err):
		if err := r.Create(ctx, desired); err != nil && !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("creating statefulset: %w", err)
		}
		r.event(cell, corev1.EventTypeNormal, "WorkloadCreated", fmt.Sprintf("created StatefulSet at replicas=%d", replicas))
	case err != nil:
		return err
	default:
		// Cross-tenant guardrail: never adopt an object labelled for another
		// tenant.
		if other := existing.Labels[v1alpha1.LabelTenant]; other != "" && other != cell.Spec.TenantID {
			err := fmt.Errorf("statefulset %s/%s is labelled for tenant %q but cell %q wants tenant %q; refusing to modify",
				existing.Namespace, existing.Name, other, cell.Name, cell.Spec.TenantID)
			r.event(cell, corev1.EventTypeWarning, "TenantLabelMismatch", err.Error())
			return err
		}
		patch := client.MergeFrom(existing.DeepCopy())
		changed := false
		if existing.Spec.Replicas == nil || *existing.Spec.Replicas != replicas {
			existing.Spec.Replicas = &replicas
			changed = true
		}
		if !equality.Semantic.DeepEqual(existing.Spec.Template, desired.Spec.Template) {
			existing.Spec.Template = desired.Spec.Template
			changed = true
		}
		if !labelsSuperset(existing.Labels, desired.Labels) {
			if existing.Labels == nil {
				existing.Labels = map[string]string{}
			}
			for k, v := range desired.Labels {
				existing.Labels[k] = v
			}
			changed = true
		}
		if changed {
			if err := r.Patch(ctx, existing, patch); err != nil {
				return fmt.Errorf("patching statefulset: %w", err)
			}
			r.event(cell, corev1.EventTypeNormal, "WorkloadUpdated", fmt.Sprintf("reconciled StatefulSet to replicas=%d", replicas))
		}
	}

	svc := k8s.Service(cell)
	if err := controllerutil.SetControllerReference(cell, svc, r.Scheme); err != nil {
		return fmt.Errorf("setting controller reference on service: %w", err)
	}
	existingSvc := &corev1.Service{}
	err = r.Get(ctx, types.NamespacedName{Namespace: svc.Namespace, Name: svc.Name}, existingSvc)
	switch {
	case apierrors.IsNotFound(err):
		if err := r.Create(ctx, svc); err != nil && !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("creating service: %w", err)
		}
	case err != nil:
		return err
	default:
		patch := client.MergeFrom(existingSvc.DeepCopy())
		if !portsEqual(existingSvc.Spec.Ports, svc.Spec.Ports) {
			existingSvc.Spec.Ports = svc.Spec.Ports
			if err := r.Patch(ctx, existingSvc, patch); err != nil {
				return fmt.Errorf("patching service: %w", err)
			}
		}
	}
	return nil
}

func portsEqual(a, b []corev1.ServicePort) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Port != b[i].Port || a[i].Name != b[i].Name || a[i].TargetPort != b[i].TargetPort {
			return false
		}
	}
	return true
}

// applyStatus writes the phase, conditions and bookkeeping fields.
func (r *CellReconciler) applyStatus(ctx context.Context, cell *v1alpha1.TenantCell, obs state.Observation, d state.Decision) error {
	for attempt := 0; attempt < 3; attempt++ {
		latest := &v1alpha1.TenantCell{}
		if err := r.Get(ctx, types.NamespacedName{Namespace: cell.Namespace, Name: cell.Name}, latest); err != nil {
			return client.IgnoreNotFound(err)
		}
		patch := client.MergeFrom(latest.DeepCopy())

		latest.Status.Phase = d.Phase
		latest.Status.ObservedGeneration = d.ObservedGeneration
		latest.Status.Message = d.Message
		latest.Status.ReadyReplicas = obs.ReadyReplicas
		if d.BootID != "" {
			latest.Status.BootID = d.BootID
		} else {
			switch d.Phase {
			case v1alpha1.PhaseSleeping, v1alpha1.PhaseStopped, v1alpha1.PhaseFailed, "":
				// A cell that is not serving must not keep a stale bootId:
				// grants are bound to the live boot.
				latest.Status.BootID = ""
			}
		}
		if d.SetWakeStartedAt {
			latest.Status.WakeStartedAt = &metav1.Time{Time: obs.Now}
		}
		if d.ClearWakeStartedAt {
			latest.Status.WakeStartedAt = nil
		}
		if d.SetReadySince {
			latest.Status.ReadySince = &metav1.Time{Time: obs.Now}
		}
		if d.ClearReadySince {
			latest.Status.ReadySince = nil
		}
		if d.SetLastIdleProofAt {
			latest.Status.LastIdleProofAt = &metav1.Time{Time: obs.Now}
		}
		if d.ResetIdleProofAt {
			latest.Status.LastIdleProofAt = nil
		}
		if d.BumpWakeAttempt {
			latest.Status.WakeAttempts++
		}
		if d.ResetWakeAttempts {
			latest.Status.WakeAttempts = 0
		}

		meta.SetStatusCondition(&latest.Status.Conditions, metav1.Condition{
			Type:               v1alpha1.ConditionReady,
			Status:             conditionStatus(d.Ready),
			ObservedGeneration: d.ObservedGeneration,
			Reason:             d.Reason,
			Message:            d.Message,
		})
		meta.SetStatusCondition(&latest.Status.Conditions, metav1.Condition{
			Type:               v1alpha1.ConditionIdleProof,
			Status:             conditionStatus(obs.Idle != nil),
			ObservedGeneration: d.ObservedGeneration,
			Reason:             idleProofReason(obs),
			Message:            idleProofMessage(obs),
		})
		meta.SetStatusCondition(&latest.Status.Conditions, metav1.Condition{
			Type:               v1alpha1.ConditionDrained,
			Status:             conditionStatus(obs.Drain != nil && obs.Drain.Drained),
			ObservedGeneration: d.ObservedGeneration,
			Reason:             drainedReason(obs),
			Message:            drainedMessage(obs),
		})

		if err := r.Status().Patch(ctx, latest, patch); err != nil {
			if apierrors.IsConflict(err) {
				continue
			}
			return fmt.Errorf("patching cell status: %w", err)
		}
		cell.Status = latest.Status
		return nil
	}
	return fmt.Errorf("patching cell %s status: too many conflicts", cell.Name)
}

func idleProofReason(obs state.Observation) string {
	if obs.Idle != nil {
		return v1alpha1.ReasonIdleConfirmed
	}
	if obs.IdleRejection != nil {
		return obs.IdleRejection.Code
	}
	return v1alpha1.ReasonBusyNotIdle
}

func idleProofMessage(obs state.Observation) string {
	if obs.Idle != nil {
		return "explicit idle proof accepted for the current bootId"
	}
	if obs.IdleRejection != nil {
		return obs.IdleRejection.Error()
	}
	return "no explicit idle proof observed"
}

func drainedReason(obs state.Observation) string {
	if obs.Drain == nil {
		return v1alpha1.ReasonDrainInProgress
	}
	if obs.Drain.Drained {
		return v1alpha1.ReasonDrainComplete
	}
	if obs.Drain.Reason != "" {
		return obs.Drain.Reason
	}
	return v1alpha1.ReasonBusyNotIdle
}

func drainedMessage(obs state.Observation) string {
	if obs.Drain == nil {
		return "drain not requested yet"
	}
	if obs.Drain.Drained {
		return "driver confirmed admission closed, no active turns, empty inbox, flushed"
	}
	if obs.Drain.Reason != "" {
		return obs.Drain.Reason
	}
	return "driver has not confirmed the drain"
}

func conditionStatus(ok bool) metav1.ConditionStatus {
	if ok {
		return metav1.ConditionTrue
	}
	return metav1.ConditionFalse
}

func (r *CellReconciler) emit(cell *v1alpha1.TenantCell, before v1alpha1.Phase, d state.Decision) {
	if string(before) == string(d.Phase) {
		return
	}
	switch d.Action {
	case state.ActionScaleUp:
		r.event(cell, corev1.EventTypeNormal, "ScaleUp", d.Message)
	case state.ActionScaleDown:
		r.event(cell, corev1.EventTypeNormal, "ScaleDown", d.Message)
	case state.ActionFail:
		r.event(cell, corev1.EventTypeWarning, "WakeFailed", d.Message)
	}
	r.event(cell, corev1.EventTypeNormal, "PhaseChanged", fmt.Sprintf("%s -> %s: %s", orNone(string(before)), d.Phase, d.Message))
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func (r *CellReconciler) event(cell *v1alpha1.TenantCell, eventType, reason, message string) {
	if r.Recorder == nil {
		return
	}
	r.Recorder.Event(cell, eventType, reason, message)
}

func (r *CellReconciler) driver() driver.Client {
	if r.Driver == nil {
		return driver.Client(nil)
	}
	return r.Driver
}

func (r *CellReconciler) now() time.Time {
	if r.Clock == nil {
		return time.Now()
	}
	return r.Clock.Now()
}

// rejectInvalid records a rejection and never touches workloads for an object
// whose identity is ambiguous.
func (r *CellReconciler) rejectInvalid(ctx context.Context, cell *v1alpha1.TenantCell, invalid error) (ctrl.Result, error) {
	reason := "InvalidSpec"
	var ve *state.ValidationError
	if asValidation(invalid, &ve) {
		reason = ve.Reason
	}
	r.event(cell, corev1.EventTypeWarning, reason, invalid.Error())

	latest := &v1alpha1.TenantCell{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: cell.Namespace, Name: cell.Name}, latest); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	patch := client.MergeFrom(latest.DeepCopy())
	latest.Status.Phase = v1alpha1.PhaseFailed
	latest.Status.Message = invalid.Error()
	meta.SetStatusCondition(&latest.Status.Conditions, metav1.Condition{
		Type:               v1alpha1.ConditionReady,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: latest.Generation,
		Reason:             reason,
		Message:            invalid.Error(),
	})
	if err := r.Status().Patch(ctx, latest, patch); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	// No requeue: the object must be corrected by a human or the control
	// plane; polling a permanently invalid object would be noise.
	return ctrl.Result{}, nil
}

func asValidation(err error, target **state.ValidationError) bool {
	return errors.As(err, target)
}

func labelsSuperset(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}

// SetupWithManager registers the reconciler. Writes are restricted to the
// manager's own namespace by the namespace-scoped cache and the RBAC Role.
func (r *CellReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.TenantCell{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Named("tenantcell").
		Complete(r)
}

// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package controller_test

import (
	"context"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
	"github.com/myrix/apps/cell-manager/internal/cell/k8s"
	"github.com/myrix/apps/cell-manager/internal/controller"
	"github.com/myrix/apps/cell-manager/internal/driver"
)

const ns = "myrix-runtime"

var testNow = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

type fixedClock struct{ t time.Time }

func (c fixedClock) Now() time.Time { return c.t }

// fakeDriver is the injectable driver boundary. Each field makes one answer
// available; anything left nil fails the corresponding call, which is what an
// unreachable driver looks like.
type fakeDriver struct {
	ready    *driver.ReadyInfo
	drain    *driver.DrainResult
	idle     *driver.IdleProof
	readyErr error
	drainErr error
	idleErr  error

	readyCalls int
	drainCalls int
	idleCalls  int
}

func (f *fakeDriver) Ready(context.Context, driver.Endpoint) (driver.ReadyInfo, error) {
	f.readyCalls++
	if f.readyErr != nil {
		return driver.ReadyInfo{}, f.readyErr
	}
	if f.ready == nil {
		return driver.ReadyInfo{}, driver.ErrUnavailable
	}
	return *f.ready, nil
}

func (f *fakeDriver) Drain(context.Context, driver.Endpoint) (driver.DrainResult, error) {
	f.drainCalls++
	if f.drainErr != nil {
		return driver.DrainResult{}, f.drainErr
	}
	if f.drain == nil {
		return driver.DrainResult{}, driver.ErrUnavailable
	}
	return *f.drain, nil
}

func (f *fakeDriver) IdleProof(context.Context, driver.Endpoint) (driver.IdleProof, error) {
	f.idleCalls++
	if f.idleErr != nil {
		return driver.IdleProof{}, f.idleErr
	}
	if f.idle == nil {
		return driver.IdleProof{}, driver.ErrUnavailable
	}
	return *f.idle, nil
}

func newScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatalf("clientgo scheme: %v", err)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("myrix scheme: %v", err)
	}
	return scheme
}

func newCell(mutate ...func(*v1alpha1.TenantCell)) *v1alpha1.TenantCell {
	cell := &v1alpha1.TenantCell{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "cell-t1",
			Namespace:  ns,
			UID:        types.UID("11111111-1111-1111-1111-111111111111"),
			Generation: 3,
			Labels: map[string]string{
				v1alpha1.LabelTenant: "t1",
				v1alpha1.LabelCell:   "cell-t1",
			},
		},
		Spec: v1alpha1.TenantCellSpec{
			TenantID:    "t1",
			Tier:        v1alpha1.TierShared,
			WantRunning: true,
			Runtime: v1alpha1.RuntimeSpec{
				Image: "registry.example.com/myrix/runtime:0.1.0-dev",
			},
			Storage: v1alpha1.StorageSpec{Size: "10Gi"},
		},
	}
	for _, m := range mutate {
		m(cell)
	}
	return cell
}

func newReconciler(t *testing.T, objects []client.Object, d driver.Client) (*controller.CellReconciler, client.Client) {
	t.Helper()
	scheme := newScheme(t)
	builder := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&v1alpha1.TenantCell{})
	if len(objects) > 0 {
		builder = builder.WithObjects(objects...)
	}
	c := builder.Build()
	return &controller.CellReconciler{
		Client:    c,
		Scheme:    scheme,
		Driver:    d,
		Recorder:  record.NewFakeRecorder(64),
		Clock:     fixedClock{testNow},
		Namespace: ns,
	}, c
}

func reconcile(t *testing.T, r *controller.CellReconciler, name string) ctrl.Result {
	t.Helper()
	res, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: ns, Name: name},
	})
	if err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	return res
}

func getCell(t *testing.T, c client.Client, name string) *v1alpha1.TenantCell {
	t.Helper()
	var cell v1alpha1.TenantCell
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, &cell); err != nil {
		t.Fatalf("get cell: %v", err)
	}
	return &cell
}

func getSts(t *testing.T, c client.Client, name string) *appsv1.StatefulSet {
	t.Helper()
	var sts appsv1.StatefulSet
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, &sts); err != nil {
		t.Fatalf("get statefulset: %v", err)
	}
	return &sts
}

func condition(t *testing.T, cell *v1alpha1.TenantCell, condType string) *metav1.Condition {
	t.Helper()
	return meta.FindStatusCondition(cell.Status.Conditions, condType)
}

// --- waking ---------------------------------------------------------------

func TestStoppedCellScalesUpOnWakeRequest(t *testing.T) {
	cell := newCell()
	r, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	sts := getSts(t, c, cell.Name)
	if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 1 {
		t.Fatalf("replicas = %v, want 1", sts.Spec.Replicas)
	}
	got := getCell(t, c, cell.Name)
	if got.Status.Phase != v1alpha1.PhaseStarting {
		t.Fatalf("phase = %q, want Starting", got.Status.Phase)
	}
	if cond := condition(t, got, v1alpha1.ConditionReady); cond == nil || cond.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %+v, want False", cond)
	}
	if got.Status.WakeStartedAt == nil {
		t.Fatal("wakeStartedAt must be stamped when a wake begins")
	}
	var svc corev1.Service
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: k8s.ServiceName(cell)}, &svc); err != nil {
		t.Fatalf("driver service missing: %v", err)
	}
}

// --- ready ----------------------------------------------------------------

func TestBootWithUnreachableDriverIsNotReady(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Status.Phase = v1alpha1.PhaseStarting
		c.Status.ObservedGeneration = 3
		c.Status.WakeStartedAt = &metav1.Time{Time: testNow.Add(-5 * time.Second)}
		c.Spec.Runtime.DriverBaseURL = "http://127.0.0.1:1"
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	r, c := newReconciler(t, []client.Object{cell, sts, pod}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	got := getCell(t, c, cell.Name)
	if got.Status.Phase == v1alpha1.PhaseReady {
		t.Fatal("driver unreachable but phase moved to Ready")
	}
	if cond := condition(t, got, v1alpha1.ConditionReady); cond == nil || cond.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %+v, want False", cond)
	}
	if cond := condition(t, got, v1alpha1.ConditionReady); cond.Reason != v1alpha1.ReasonDriverUnavailable {
		t.Fatalf("reason = %q, want %q", cond.Reason, v1alpha1.ReasonDriverUnavailable)
	}
}

func TestBootWithReadyPodAndDriverBecomesReady(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Status.Phase = v1alpha1.PhaseWaking
		c.Status.ObservedGeneration = 3
		c.Status.WakeStartedAt = &metav1.Time{Time: testNow.Add(-5 * time.Second)}
		c.Spec.Runtime.DriverBaseURL = "http://127.0.0.1:8404"
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	d := &fakeDriver{ready: &driver.ReadyInfo{BootID: "boot-7", Status: "ok"}}
	r, c := newReconciler(t, []client.Object{cell, sts, pod}, d)

	reconcile(t, r, cell.Name)

	got := getCell(t, c, cell.Name)
	if got.Status.Phase != v1alpha1.PhaseReady {
		t.Fatalf("phase = %q, want Ready", got.Status.Phase)
	}
	if got.Status.BootID != "boot-7" {
		t.Fatalf("bootId = %q, want boot-7", got.Status.BootID)
	}
	if cond := condition(t, got, v1alpha1.ConditionReady); cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("Ready condition = %+v, want True", cond)
	}
	if got.Status.WakeStartedAt != nil {
		t.Fatal("wakeStartedAt must be cleared once ready")
	}
	if got.Status.ReadySince == nil {
		t.Fatal("readySince must be stamped once ready")
	}
}

func TestStaleGenerationIsNotReady(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Status.Phase = v1alpha1.PhaseReady
		c.Status.ObservedGeneration = 2 // generation is 3
		c.Status.BootID = "boot-7"
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	d := &fakeDriver{ready: &driver.ReadyInfo{BootID: "boot-7"}}
	r, c := newReconciler(t, []client.Object{cell, sts, pod}, d)

	reconcile(t, r, cell.Name)

	got := getCell(t, c, cell.Name)
	if got.Status.Phase == v1alpha1.PhaseReady {
		t.Fatal("stale observedGeneration must not stay Ready")
	}
	if cond := condition(t, got, v1alpha1.ConditionReady); cond == nil || cond.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %+v, want False", cond)
	}
	if got.Status.ReadySince != nil {
		t.Fatal("readySince must be cleared while readiness is re-proven")
	}
	if got.Status.WakeStartedAt == nil {
		t.Fatal("wakeStartedAt must be stamped while readiness is re-proven")
	}
}

// --- draining / scale to zero --------------------------------------------

func TestBusyCellIsNotScaledToZero(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Status.Phase = v1alpha1.PhaseDraining
		c.Status.ObservedGeneration = 3
		c.Status.BootID = "boot-7"
		c.Status.ReadySince = &metav1.Time{Time: testNow.Add(-time.Hour)}
		c.Spec.Runtime.DriverBaseURL = "http://127.0.0.1:8404"
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	d := &fakeDriver{
		drain: &driver.DrainResult{Drained: true, BootID: "boot-7"},
		idle: &driver.IdleProof{
			BootID:        "boot-7",
			NoActiveTurns: false, // busy!
			InboxEmpty:    true,
			Flushed:       true,
			LastCommandAt: testNow.Add(-time.Hour),
			ObservedAt:    testNow.Add(-time.Second),
		},
	}
	r, c := newReconciler(t, []client.Object{cell, sts, pod}, d)

	reconcile(t, r, cell.Name)

	got := getSts(t, c, cell.Name)
	if got.Spec.Replicas == nil || *got.Spec.Replicas != 1 {
		t.Fatalf("replicas = %v, want 1: a busy cell must never be scaled down", got.Spec.Replicas)
	}
	status := getCell(t, c, cell.Name)
	if status.Status.Phase != v1alpha1.PhaseDraining {
		t.Fatalf("phase = %q, want Draining", status.Status.Phase)
	}
	if cond := condition(t, status, v1alpha1.ConditionIdleProof); cond == nil || cond.Status != metav1.ConditionFalse {
		t.Fatalf("IdleProof condition = %+v, want False", cond)
	}
	if status.Status.LastIdleProofAt == nil {
		t.Fatal("a refused idle proof must be timestamped so the quiet clock restarts")
	}
}

func TestIdleProvenCellIsScaledToZeroAndPvcKept(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Status.Phase = v1alpha1.PhaseDraining
		c.Status.ObservedGeneration = 3
		c.Status.BootID = "boot-7"
		c.Status.ReadySince = &metav1.Time{Time: testNow.Add(-2 * time.Hour)}
		c.Status.LastIdleProofAt = &metav1.Time{Time: testNow.Add(-time.Hour)}
		c.Spec.Runtime.DriverBaseURL = "http://127.0.0.1:8404"
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: k8s.PVCName(cell), Namespace: ns},
	}
	d := &fakeDriver{
		drain: &driver.DrainResult{Drained: true, BootID: "boot-7"},
		idle: &driver.IdleProof{
			BootID:        "boot-7",
			NoActiveTurns: true,
			InboxEmpty:    true,
			Flushed:       true,
			LastCommandAt: testNow.Add(-time.Hour),
			ObservedAt:    testNow.Add(-time.Second),
		},
	}
	r, c := newReconciler(t, []client.Object{cell, sts, pod, pvc}, d)

	reconcile(t, r, cell.Name)

	got := getSts(t, c, cell.Name)
	if got.Spec.Replicas == nil || *got.Spec.Replicas != 0 {
		t.Fatalf("replicas = %v, want 0", got.Spec.Replicas)
	}
	status := getCell(t, c, cell.Name)
	if status.Status.Phase != v1alpha1.PhaseSleeping {
		t.Fatalf("phase = %q, want Sleeping", status.Status.Phase)
	}
	if status.Status.BootID != "" {
		t.Fatalf("bootId = %q, want cleared after sleep", status.Status.BootID)
	}

	// The PVC must survive: scaling to zero is not a data deletion.
	var kept corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: k8s.PVCName(cell)}, &kept); err != nil {
		t.Fatalf("PVC was removed on scale-down: %v", err)
	}
	// And the StatefulSet must be configured never to delete it either.
	if got.Spec.PersistentVolumeClaimRetentionPolicy == nil {
		t.Fatal("StatefulSet has no PVC retention policy")
	}
	if got.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		t.Fatalf("whenScaled = %q, want Retain", got.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled)
	}
	if got.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		t.Fatalf("whenDeleted = %q, want Retain", got.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted)
	}
}

func TestDrainRefusalKeepsCellRunning(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Status.Phase = v1alpha1.PhaseDraining
		c.Status.ObservedGeneration = 3
		c.Status.BootID = "boot-7"
		c.Spec.Runtime.DriverBaseURL = "http://127.0.0.1:8404"
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	d := &fakeDriver{
		drain: &driver.DrainResult{Drained: false, BootID: "boot-7", Reason: "a turn is still active", RejectionCode: driver.RejectActiveTurns},
	}
	r, c := newReconciler(t, []client.Object{cell, sts, pod}, d)

	reconcile(t, r, cell.Name)

	got := getSts(t, c, cell.Name)
	if got.Spec.Replicas == nil || *got.Spec.Replicas != 1 {
		t.Fatalf("replicas = %v, want 1", got.Spec.Replicas)
	}
	status := getCell(t, c, cell.Name)
	if cond := condition(t, status, v1alpha1.ConditionDrained); cond == nil || cond.Status != metav1.ConditionFalse {
		t.Fatalf("Drained condition = %+v, want False", cond)
	}
}

// --- invalid identity -----------------------------------------------------

func TestInvalidTenantLabelIsRejectedWithoutWorkload(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Labels[v1alpha1.LabelTenant] = "t2" // contradicts spec.tenantId = t1
	})
	r, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	var stsList appsv1.StatefulSetList
	if err := c.List(context.Background(), &stsList, client.InNamespace(ns)); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(stsList.Items) != 0 {
		t.Fatalf("created %d workloads for an invalid cell, want 0", len(stsList.Items))
	}
	got := getCell(t, c, cell.Name)
	if got.Status.Phase != v1alpha1.PhaseFailed {
		t.Fatalf("phase = %q, want Failed", got.Status.Phase)
	}
	cond := condition(t, got, v1alpha1.ConditionReady)
	if cond == nil || cond.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %+v, want False", cond)
	}
	if cond.Reason != v1alpha1.ReasonTenantLabelMissing {
		t.Fatalf("reason = %q, want %q", cond.Reason, v1alpha1.ReasonTenantLabelMissing)
	}
}

func TestInvalidTierIsRejected(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Spec.Tier = "platinum"
	})
	r, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	got := getCell(t, c, cell.Name)
	cond := condition(t, got, v1alpha1.ConditionReady)
	if cond == nil || cond.Reason != v1alpha1.ReasonInvalidTier {
		t.Fatalf("condition = %+v, want reason %q", cond, v1alpha1.ReasonInvalidTier)
	}
	if got.Status.Phase != v1alpha1.PhaseFailed {
		t.Fatalf("phase = %q, want Failed", got.Status.Phase)
	}
}

func TestMissingCellLabelIsAccepted(t *testing.T) {
	// The cell label is a convenience; its absence must not block a cell.
	cell := newCell(func(c *v1alpha1.TenantCell) {
		delete(c.Labels, v1alpha1.LabelCell)
	})
	r, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	if got := getCell(t, c, cell.Name); got.Status.Phase != v1alpha1.PhaseStarting {
		t.Fatalf("phase = %q, want Starting", got.Status.Phase)
	}
}

func TestForeignNamespaceIsRefused(t *testing.T) {
	cell := newCell()
	cell.Namespace = "kube-system"
	r, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})

	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: "kube-system", Name: cell.Name},
	}); err == nil {
		t.Fatal("reconcile of a foreign namespace returned no error")
	}

	var stsList appsv1.StatefulSetList
	if err := c.List(context.Background(), &stsList); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(stsList.Items) != 0 {
		t.Fatalf("created %d workloads outside the authorised namespace", len(stsList.Items))
	}
}

func TestExistingWorkloadForAnotherTenantIsNotAdopted(t *testing.T) {
	cell := newCell()
	foreign := k8s.StatefulSet(cell, 1)
	foreign.Labels[v1alpha1.LabelTenant] = "t9"
	r, c := newReconciler(t, []client.Object{cell, foreign}, &fakeDriver{})

	_, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: ns, Name: cell.Name},
	})
	if err == nil {
		t.Fatal("adopted a StatefulSet labelled for another tenant")
	}
	if !strings.Contains(err.Error(), "refusing to modify") {
		t.Fatalf("unexpected error: %v", err)
	}
	got := getSts(t, c, cell.Name)
	if got.Labels[v1alpha1.LabelTenant] != "t9" {
		t.Fatalf("tenant label was overwritten: %v", got.Labels)
	}
}

// --- wantRunning setter ---------------------------------------------------

func TestWantRunningSetter(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Spec.WantRunning = false
	})
	_, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})
	setter := &controller.WantRunningClient{Client: c, Namespace: ns}

	if err := setter.SetWantRunning(context.Background(), ns, cell.Name, true); err != nil {
		t.Fatalf("SetWantRunning: %v", err)
	}
	if !getCell(t, c, cell.Name).Spec.WantRunning {
		t.Fatal("wantRunning was not set")
	}
	// Idempotent.
	if err := setter.SetWantRunning(context.Background(), ns, cell.Name, true); err != nil {
		t.Fatalf("second SetWantRunning: %v", err)
	}
	// Outside the authorised namespace: refused.
	if err := setter.SetWantRunning(context.Background(), "kube-system", cell.Name, false); err == nil {
		t.Fatal("setter accepted a write outside its namespace")
	}
	// Missing object surfaces the API error.
	err := setter.SetWantRunning(context.Background(), ns, "nope", false)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("error = %v, want NotFound", err)
	}
}

func TestDedicatedCellIsResident(t *testing.T) {
	cell := newCell(func(c *v1alpha1.TenantCell) {
		c.Spec.Tier = v1alpha1.TierDedicated
		c.Spec.WantRunning = true
		c.Status.Phase = v1alpha1.PhaseReady
		c.Status.ObservedGeneration = 3
		c.Status.BootID = "boot-7"
		c.Status.ReadySince = &metav1.Time{Time: testNow.Add(-30 * 24 * time.Hour)}
	})
	sts := readySts(cell)
	pod := readyPod(cell)
	r, c := newReconciler(t, []client.Object{cell, sts, pod}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	got := getSts(t, c, cell.Name)
	if got.Spec.Replicas == nil || *got.Spec.Replicas != 1 {
		t.Fatalf("dedicated replicas = %v, want 1 (resident)", got.Spec.Replicas)
	}
	status := getCell(t, c, cell.Name)
	if status.Status.Phase != v1alpha1.PhaseReady {
		t.Fatalf("phase = %q, want Ready", status.Status.Phase)
	}
	if cond := condition(t, status, v1alpha1.ConditionReady); cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("Ready condition = %+v, want True", cond)
	}
}

func TestDeletedCellIsLeftAlone(t *testing.T) {
	cell := newCell()
	deleted := metav1.NewTime(testNow)
	cell.DeletionTimestamp = &deleted
	cell.Finalizers = []string{"myrix.io/keep-pvc"}
	r, c := newReconciler(t, []client.Object{cell}, &fakeDriver{})

	reconcile(t, r, cell.Name)

	var stsList appsv1.StatefulSetList
	if err := c.List(context.Background(), &stsList, client.InNamespace(ns)); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(stsList.Items) != 0 {
		t.Fatal("reconciled a cell that is being deleted")
	}
}

// --- test fixtures --------------------------------------------------------

func readySts(cell *v1alpha1.TenantCell) *appsv1.StatefulSet {
	sts := k8s.StatefulSet(cell, 1)
	sts.Status = appsv1.StatefulSetStatus{Replicas: 1, ReadyReplicas: 1}
	return sts
}

func readyPod(cell *v1alpha1.TenantCell) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: k8s.PodName(cell), Namespace: cell.Namespace, Labels: k8s.SelectorLabels(cell)},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			PodIP: "10.0.0.7",
			Conditions: []corev1.PodCondition{{
				Type:   corev1.PodReady,
				Status: corev1.ConditionTrue,
			}},
		},
	}
}

// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package v1alpha1 contains the TenantCell API types managed by the Myrix Cell
// Manager. The CRD is the single source of truth for cell *lifecycle*: which
// phase a cell is in, whether it runs, and what the last observed boot
// identity was. Business session bindings live in the control-plane database
// and are deliberately not modelled here (see ADR-0014).
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Tier is the commercial/isolation tier of a cell.
type Tier string

const (
	// TierShared cells are scaled to zero while idle. The controller must
	// obtain an explicit idle proof from the runtime driver before it may
	// scale the StatefulSet down.
	TierShared Tier = "shared"
	// TierDedicated cells are intended to stay resident. The controller
	// never drives them to zero, but a driver-proven drain is still
	// honoured if a human writes Draining into the status.
	TierDedicated Tier = "dedicated"
)

// Phase is the cell lifecycle phase. Phase transitions are exclusively the
// controller's job; every other actor only mutates spec.wantRunning or the
// status subresource via optimistic concurrency.
type Phase string

const (
	// PhaseStopped means replicas are zero. The PVC must be preserved.
	PhaseStopped Phase = "Stopped"
	// PhaseStarting means replicas were raised and the cell is booting.
	PhaseStarting Phase = "Starting"
	// PhaseReady means the pod passed readiness and reported a bootId for
	// the current generation.
	PhaseReady Phase = "Ready"
	// PhaseDraining means admission is closed and the controller is waiting
	// for an explicit idle proof before scaling to zero.
	PhaseDraining Phase = "Draining"
	// PhaseSleeping means the driver acknowledged the drain plus process
	// exit; replicas are zero but the wake path is armed.
	PhaseSleeping Phase = "Sleeping"
	// PhaseWaking means a command arrived while the cell was sleeping and
	// the controller is raising replicas again.
	PhaseWaking Phase = "Waking"
	// PhaseFailed means a bounded number of wake attempts failed.
	PhaseFailed Phase = "Failed"
)

// Condition types set on TenantCell.status.conditions.
const (
	// ConditionReady mirrors Kubernetes readiness plus observedGeneration
	// freshness.
	ConditionReady = "Ready"
	// ConditionIdleProof is True only while the runtime driver has
	// confirmed an idle proof for the current bootId.
	ConditionIdleProof = "IdleProof"
	// ConditionDrained is True once the driver reported a completed drain
	// (admission closed, no active turns, empty inbox, flushed).
	ConditionDrained = "Drained"
)

// Reason strings. They are part of the operator contract: alerts and docs
// reference them verbatim.
const (
	ReasonAwaitingReadiness  = "AwaitingReadiness"
	ReasonBootIDMismatch     = "BootIDMismatch"
	ReasonDriverUnavailable  = "DriverUnavailable"
	ReasonBusyNotIdle        = "BusyNotIdle"
	ReasonIdleConfirmed      = "IdleConfirmed"
	ReasonDrainInProgress    = "DrainInProgress"
	ReasonDrainComplete      = "DrainComplete"
	ReasonWakeRequested      = "WakeRequested"
	ReasonResident           = "Resident"
	ReasonWakeTimeout        = "WakeTimeout"
	ReasonInvalidTier        = "InvalidTier"
	ReasonInvalidWantRunning = "InvalidWantRunning"
	ReasonTenantLabelMissing = "TenantLabelMissing"
)

// TenantCellSpec is the desired lifecycle state of one tenant cell.
type TenantCellSpec struct {
	// TenantID identifies the owning tenant. It must equal the value of the
	// myrix.io/tenant label; the controller refuses to act when they differ.
	// +kubebuilder:validation:MinLength=1
	TenantID string `json:"tenantId"`

	// Tier is the deployment tier: shared (scale to zero) or dedicated
	// (resident).
	// +kubebuilder:validation:Enum=shared;dedicated
	Tier Tier `json:"tier"`

	// WantRunning is the wake/sleep intent. It is only meaningful for
	// TierShared. The session router flips it through the Cell Manager's
	// internal API; the router itself holds no Kubernetes permissions.
	WantRunning bool `json:"wantRunning"`

	// IdleTimeoutSeconds is the quiet period required before the controller
	// may ask the driver for an idle proof. Defaults to 900 (15 minutes).
	// +kubebuilder:validation:Minimum=0
	// +optional
	IdleTimeoutSeconds *int32 `json:"idleTimeoutSeconds,omitempty"`

	// MaxWakeAttempts bounds consecutive Failed wake cycles before the
	// controller stops retrying and waits for a human or a new generation.
	// Defaults to 5.
	// +kubebuilder:validation:Minimum=0
	// +optional
	MaxWakeAttempts *int32 `json:"maxWakeAttempts,omitempty"`

	// Runtime describes the cell container image. The image is supplied by
	// the operator: this repository does not publish a runtime image yet.
	Runtime RuntimeSpec `json:"runtime"`

	// Storage describes the per-tenant RWO volume that holds DSH_HOME.
	Storage StorageSpec `json:"storage"`
}

// RuntimeSpec configures the cell process. Image and command are operator
// inputs; nothing here claims a published artifact.
type RuntimeSpec struct {
	// Image is the cell (DSH + Myrix bundle) image reference.
	// +kubebuilder:validation:MinLength=1
	Image string `json:"image"`

	// ImagePullPolicy defaults to IfNotPresent.
	// +kubebuilder:validation:Enum=Always;IfNotPresent;Never
	// +optional
	ImagePullPolicy string `json:"imagePullPolicy,omitempty"`

	// Command overrides the image entrypoint. It exists because the runtime
	// image is not published yet and the process layout may change.
	// +optional
	Command []string `json:"command,omitempty"`

	// Args overrides the image arguments.
	// +optional
	Args []string `json:"args,omitempty"`

	// DriverBaseURL is the in-cluster base URL of the runtime driver
	// (for example http://127.0.0.1:8404). It is the real API path the
	// controller calls for /v1/ready, /v1/admin/drain and /v1/admin/idle.
	// Defaults to the driver port on the pod IP.
	// +optional
	DriverBaseURL string `json:"driverBaseURL,omitempty"`

	// CredentialsSecret is the name of the per-tenant Secret holding this
	// tenant's model-gateway credential and the JWKS used to verify
	// control-plane grants. It is created per tenant by the control plane
	// and must never be shared between tenants; the controller mounts it
	// read-only and does not read its contents.
	// +optional
	CredentialsSecret string `json:"credentialsSecret,omitempty"`

	// DriverPort is the container port the driver listens on. Defaults to
	// 8404.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	// +optional
	DriverPort *int32 `json:"driverPort,omitempty"`

	// ReadyTimeoutSeconds bounds a single Starting/Waking transition.
	// Defaults to 120.
	// +kubebuilder:validation:Minimum=1
	// +optional
	ReadyTimeoutSeconds *int32 `json:"readyTimeoutSeconds,omitempty"`

	// Resources are applied to the cell container. Left empty the operator
	// must size them from the Phase 0 measurements; there is no default.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// RuntimeClassName is an optional stronger runtime (for example
	// gVisor) for dedicated tiers. It does not replace the pod security
	// baseline.
	// +optional
	RuntimeClassName *string `json:"runtimeClassName,omitempty"`

	// NodeSelector restricts scheduling, used for dedicated node pools.
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`

	// Tolerations for dedicated node pools.
	// +optional
	Tolerations []corev1.Toleration `json:"tolerations,omitempty"`
}

// StorageSpec configures the per-tenant volume. One cell is one tenant is one
// DSH_HOME on one ReadWriteOnce volume; the PVC is never deleted by the
// controller (retention policy Keep).
type StorageSpec struct {
	// Size is the requested volume size, for example "10Gi".
	// +kubebuilder:validation:MinLength=1
	Size string `json:"size"`

	// StorageClassName is optional; empty means cluster default.
	// +optional
	StorageClassName string `json:"storageClassName,omitempty"`
}

// TenantCellStatus is the observed lifecycle state.
type TenantCellStatus struct {
	// Phase is the authoritative lifecycle phase.
	// +optional
	Phase Phase `json:"phase,omitempty"`

	// ObservedGeneration is the spec generation the observations below
	// belong to. Ready is never true when it lags metadata.generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// BootID is the identity of the currently running cell process. It is
	// part of the grant audience checks; a stale bootId must not be treated
	// as ready.
	// +optional
	BootID string `json:"bootId,omitempty"`

	// LastIdleProofAt is when the driver last confirmed the idle proof for
	// the current bootId.
	// +optional
	LastIdleProofAt *metav1.Time `json:"lastIdleProofAt,omitempty"`

	// ReadyReplicas mirrors the StatefulSet ready replica count.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// WakeStartedAt is when the current Starting/Waking transition began.
	// It is emitted only while starting or waking and removed afterwards,
	// which keeps the object immutable while a boot is in flight.
	// +optional
	WakeStartedAt *metav1.Time `json:"wakeStartedAt,omitempty"`

	// ReadySince is when the cell last became ready. It is the start of the
	// quiet period that may eventually lead to a sleep; it is removed on
	// transition out of Ready.
	// +optional
	ReadySince *metav1.Time `json:"readySince,omitempty"`

	// WakeAttempts counts consecutive failed wake cycles.
	// +optional
	WakeAttempts int32 `json:"wakeAttempts,omitempty"`

	// Message is a human-readable explanation of the current phase.
	// +optional
	Message string `json:"message,omitempty"`

	// Conditions follow the usual Kubernetes condition contract.
	// +optional
	// +patchMergeKey=type
	// +patchStrategy=merge
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// TenantCell is the CRD that owns cell lifecycle.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=tcell,scope=Namespaced
// +kubebuilder:printcolumn:name="Tenant",type=string,JSONPath=`.spec.tenantId`
// +kubebuilder:printcolumn:name="Tier",type=string,JSONPath=`.spec.tier`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Boot",type=string,JSONPath=`.status.bootId`
type TenantCell struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   TenantCellSpec   `json:"spec"`
	Status TenantCellStatus `json:"status,omitempty"`
}

// TenantCellList contains TenantCell objects.
// +kubebuilder:object:root=true
type TenantCellList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []TenantCell `json:"items"`
}

// Defaults applied by tenantCellFor when a field is unset. They are exported
// so tests and documentation share one source.
const (
	DefaultIdleTimeoutSeconds = int32(900)
	DefaultMaxWakeAttempts    = int32(5)
	DefaultDriverPort         = int32(8404)
	DefaultReadyTimeoutSecond = int32(120)
	DefaultImagePullPolicy    = "IfNotPresent"
)

// IdleTimeout returns the effective idle timeout.
func (s TenantCellSpec) IdleTimeout() int32 {
	if s.IdleTimeoutSeconds != nil {
		return *s.IdleTimeoutSeconds
	}
	return DefaultIdleTimeoutSeconds
}

// MaxWakeAttemptsOrDefault returns the effective wake attempt budget.
func (s TenantCellSpec) MaxWakeAttemptsOrDefault() int32 {
	if s.MaxWakeAttempts != nil {
		return *s.MaxWakeAttempts
	}
	return DefaultMaxWakeAttempts
}

// ReadyTimeout returns the effective single-transition wake budget.
func (s TenantCellSpec) ReadyTimeout() int32 {
	if s.Runtime.ReadyTimeoutSeconds != nil {
		return *s.Runtime.ReadyTimeoutSeconds
	}
	return DefaultReadyTimeoutSecond
}

// DriverPortOrDefault returns the effective driver port.
func (s TenantCellSpec) DriverPortOrDefault() int32 {
	if s.Runtime.DriverPort != nil {
		return *s.Runtime.DriverPort
	}
	return DefaultDriverPort
}

// ImagePullPolicyOrDefault returns the effective image pull policy.
func (s TenantCellSpec) ImagePullPolicyOrDefault() string {
	if s.Runtime.ImagePullPolicy != "" {
		return s.Runtime.ImagePullPolicy
	}
	return DefaultImagePullPolicy
}

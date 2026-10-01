// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package state implements the TenantCell lifecycle state machine as a pure
// function. The reconciler gathers observations (Kubernetes objects plus the
// runtime driver answers), then calls Decide; nothing in this package performs
// I/O, so every transition and every refusal is unit-testable.
//
// Invariants enforced here (see docs/adr/0014-cell-lifecycle.md):
//
//  1. Replicas are only ever 0 or 1.
//  2. A shared cell is never scaled to zero without an explicit driver idle
//     proof that matches the current bootId. A quiet timer is not a proof.
//  3. Once a cell enters Draining, admission is closed; the only way back to
//     serving is down and up again (Draining -> Sleeping -> Waking -> Ready).
//     Draining never transitions straight back to Ready.
//  4. A command that arrives while a drain is pending is never forwarded to a
//     dying process: it flips wantRunning and waits for Sleeping, then wakes.
//  5. Ready is only reported for the current metadata.generation and only
//     when Kubernetes readiness and the driver bootId agree.
package state

import (
	"errors"
	"fmt"
	"time"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
	"github.com/myrix/apps/cell-manager/internal/driver"
)

// Action tells the reconciler what side effect to apply after the decision.
type Action string

const (
	// ActionNone means the observed state already matches the desired state.
	ActionNone Action = "None"
	// ActionScaleUp means set StatefulSet replicas to 1.
	ActionScaleUp Action = "ScaleUp"
	// ActionScaleDown means set StatefulSet replicas to 0 (PVC retained).
	ActionScaleDown Action = "ScaleDown"
	// ActionFail means the wake cycle failed and the attempt budget must be
	// bumped.
	ActionFail Action = "Fail"
)

// Requeue delays used by the machine. They are exported so tests and alerting
// documentation agree on the numbers.
const (
	RequeueBoot       = 2 * time.Second
	RequeueAfterProof = 30 * time.Second
	RequeueFailed     = 60 * time.Second
)

// Observation is everything the machine is allowed to look at.
type Observation struct {
	// Now is the injected clock reading.
	Now time.Time
	// Generation is metadata.generation of the TenantCell.
	Generation int64

	// --- status as currently recorded ---
	Phase              v1alpha1.Phase
	ObservedGeneration int64
	BootID             string
	WakeStartedAt      time.Time
	ReadySince         time.Time
	LastIdleProofAt    time.Time
	WakeAttempts       int32

	// --- spec ---
	Tier            v1alpha1.Tier
	WantRunning     bool
	IdleTimeout     time.Duration
	MaxWakeAttempts int32
	ReadyTimeout    time.Duration

	// --- Kubernetes observations ---
	Replicas      int32
	ReadyReplicas int32
	PodExists     bool
	PodReady      bool

	// --- driver observations for the current phase ---
	//
	// DriverReachable is false when the driver call failed. Failures never
	// produce a scale-down and never produce Ready.
	DriverReachable bool
	// ReadyBootID is the bootId reported by GET /v1/ready.
	ReadyBootID string
	// Drain is the answer to POST /v1/admin/drain.
	Drain *driver.DrainResult
	// Idle is the proof returned by POST /v1/admin/idle.
	Idle *driver.IdleProof
	// IdleRejection is set when a proof was obtained and rejected (busy,
	// inbox not empty, bootId mismatch, quiet period not elapsed, ...).
	IdleRejection *driver.IdleProofRejection
}

// Decision is the machine's answer.
type Decision struct {
	// Phase is the phase to record.
	Phase v1alpha1.Phase
	// Replicas is the desired StatefulSet replica count (0 or 1).
	Replicas int32
	// Action is the side effect to apply.
	Action Action
	// Reason is the condition reason for the phase transition.
	Reason string
	// Message is the human-readable explanation.
	Message string
	// RequeueAfter is 0 for "requeue immediately".
	RequeueAfter time.Duration
	// Ready is the value the Ready condition must take.
	Ready bool
	// BootID is the boot identity to record (empty means "clear").
	BootID string
	// SetWakeStartedAt stamps status.wakeStartedAt with Now.
	SetWakeStartedAt bool
	// ClearWakeStartedAt removes status.wakeStartedAt.
	ClearWakeStartedAt bool
	// SetReadySince stamps status.readySince with Now.
	SetReadySince bool
	// ClearReadySince removes status.readySince.
	ClearReadySince bool
	// SetLastIdleProofAt stamps status.lastIdleProofAt with Now. A refused
	// proof restarts the quiet clock so the controller does not hammer a
	// busy cell.
	SetLastIdleProofAt bool
	// ResetIdleProofAt clears status.lastIdleProofAt.
	ResetIdleProofAt bool
	// BumpWakeAttempt increments WakeAttempts.
	BumpWakeAttempt bool
	// ResetWakeAttempts zeroes WakeAttempts.
	ResetWakeAttempts bool
	// ObservedGeneration is the generation to record.
	ObservedGeneration int64
}

// EffectiveWantRunning reports whether the cell should be running. Dedicated
// cells are resident: spec.wantRunning is always true for them.
func EffectiveWantRunning(tier v1alpha1.Tier, wantRunning bool) bool {
	return tier == v1alpha1.TierDedicated || wantRunning
}

// Decide computes the next lifecycle step.
func Decide(o Observation) Decision {
	want := EffectiveWantRunning(o.Tier, o.WantRunning)

	switch o.Phase {

	// ---------------------------------------------------------------- Stopped
	case v1alpha1.PhaseStopped:
		if want {
			return Decision{
				Phase:              v1alpha1.PhaseStarting,
				Replicas:           1,
				Action:             ActionScaleUp,
				Reason:             v1alpha1.ReasonWakeRequested,
				Message:            "wake requested: scaling cell up",
				RequeueAfter:       RequeueBoot,
				SetWakeStartedAt:   true,
				ObservedGeneration: o.Generation,
			}
		}
		return settled(o, v1alpha1.PhaseStopped, 0, ActionNone, "Stopped", "cell is stopped; PVC retained", false)

	// ------------------------------------------------------- Starting / Waking
	case v1alpha1.PhaseStarting, v1alpha1.PhaseWaking:
		if o.WakeStartedAt.IsZero() {
			d := settled(o, o.Phase, 1, ActionNone, v1alpha1.ReasonAwaitingReadiness, "waiting for pod readiness", false)
			d.SetWakeStartedAt = true
			d.RequeueAfter = RequeueBoot
			return d
		}
		if o.ReadyTimeout > 0 && o.Now.Sub(o.WakeStartedAt) > o.ReadyTimeout {
			return Decision{
				Phase:              v1alpha1.PhaseFailed,
				Replicas:           1,
				Action:             ActionFail,
				Reason:             v1alpha1.ReasonWakeTimeout,
				Message:            fmt.Sprintf("cell did not become ready within %s", o.ReadyTimeout),
				RequeueAfter:       RequeueFailed,
				BumpWakeAttempt:    true,
				ObservedGeneration: o.Generation,
			}
		}
		if !o.PodReady || o.ReadyReplicas < 1 {
			return settled(o, o.Phase, 1, ActionNone, v1alpha1.ReasonAwaitingReadiness, "pod is not ready yet", false)
		}
		if !o.DriverReachable {
			return settled(o, o.Phase, 1, ActionNone, v1alpha1.ReasonDriverUnavailable,
				"driver /v1/ready is unreachable; refusing to report ready", false)
		}
		if o.ReadyBootID == "" {
			return settled(o, o.Phase, 1, ActionNone, v1alpha1.ReasonBootIDMismatch,
				"driver reported no bootId; refusing to report ready", false)
		}
		// Kubernetes readiness and the driver agree for this generation.
		return Decision{
			Phase:              v1alpha1.PhaseReady,
			Replicas:           1,
			Action:             ActionScaleUp,
			Reason:             v1alpha1.ReasonResident,
			Message:            "cell is ready",
			Ready:              true,
			BootID:             o.ReadyBootID,
			SetReadySince:      true,
			ClearWakeStartedAt: true,
			ResetWakeAttempts:  true,
			ResetIdleProofAt:   true,
			ObservedGeneration: o.Generation,
		}

	// ------------------------------------------------------------------ Ready
	case v1alpha1.PhaseReady:
		// Repair path: the workload disappeared (someone scaled it by hand, a
		// node drain removed the pod). Never claim Ready with zero replicas.
		if o.Replicas == 0 && !o.PodExists && o.ReadyReplicas == 0 {
			if want {
				return Decision{
					Phase:              v1alpha1.PhaseStarting,
					Replicas:           1,
					Action:             ActionScaleUp,
					Reason:             v1alpha1.ReasonWakeRequested,
					Message:            "recorded Ready but no cell process exists; scaling up again",
					RequeueAfter:       RequeueBoot,
					SetWakeStartedAt:   true,
					ClearReadySince:    true,
					BootID:             "",
					ObservedGeneration: o.Generation,
				}
			}
			return settled(o, v1alpha1.PhaseStopped, 0, ActionNone, "Stopped", "cell is stopped; PVC retained", false)
		}
		if o.ObservedGeneration != o.Generation {
			// The spec changed. Readiness must be re-proven for the new
			// generation before Ready is reported again.
			// The process itself is still the same one, so the recorded
			// bootId stays; only the readiness claim is withdrawn.
			return Decision{
				Phase:              v1alpha1.PhaseStarting,
				Replicas:           1,
				Action:             ActionScaleUp,
				Reason:             v1alpha1.ReasonAwaitingReadiness,
				Message:            fmt.Sprintf("spec generation %d not yet observed (observed %d); re-proving readiness", o.Generation, o.ObservedGeneration),
				SetWakeStartedAt:   true,
				ClearReadySince:    true,
				ObservedGeneration: o.Generation,
			}
		}
		if !want {
			// The sleep handshake starts by moving the phase, so the session
			// router stops delivering immediately.
			return Decision{
				Phase:              v1alpha1.PhaseDraining,
				Replicas:           1,
				Action:             ActionNone,
				Reason:             v1alpha1.ReasonDrainInProgress,
				Message:            "wantRunning=false: closing admission and draining",
				ClearReadySince:    true,
				ObservedGeneration: o.Generation,
			}
		}
		if o.Tier == v1alpha1.TierShared {
			quietSince := o.ReadySince
			if o.LastIdleProofAt.After(quietSince) {
				quietSince = o.LastIdleProofAt
			}
			if o.IdleTimeout > 0 && !quietSince.IsZero() && o.Now.Sub(quietSince) >= o.IdleTimeout {
				return Decision{
					Phase:              v1alpha1.PhaseDraining,
					Replicas:           1,
					Action:             ActionNone,
					Reason:             v1alpha1.ReasonDrainInProgress,
					Message:            fmt.Sprintf("shared cell quiet for %s; draining", o.Now.Sub(quietSince).Truncate(time.Second)),
					ClearReadySince:    true,
					ObservedGeneration: o.Generation,
				}
			}
		}
		d := settled(o, v1alpha1.PhaseReady, 1, ActionNone, v1alpha1.ReasonResident, "cell is ready", true)
		d.BootID = o.BootID
		return d

	// --------------------------------------------------------------- Draining
	case v1alpha1.PhaseDraining:
		// Converged: the process is already gone and we are not scaling
		// anything down, so no idle proof is required; record reality.
		if o.Replicas == 0 && !o.PodExists {
			return settled(o, v1alpha1.PhaseSleeping, 0, ActionNone, v1alpha1.ReasonDrainComplete,
				"cell process is already stopped; PVC retained", false)
		}
		if !o.DriverReachable {
			// Fail closed: no proof, no scale-down. `want` is deliberately
			// ignored here so a wake request cannot shortcut the handshake.
			return settled(o, v1alpha1.PhaseDraining, 1, ActionNone, v1alpha1.ReasonDriverUnavailable,
				"driver unreachable during drain; refusing to scale down", false)
		}
		if o.Drain == nil {
			return settled(o, v1alpha1.PhaseDraining, 1, ActionNone, v1alpha1.ReasonDrainInProgress,
				"waiting for POST /v1/admin/drain acknowledgement", false)
		}
		if !o.Drain.Drained {
			msg := "driver reports the cell is not drained yet"
			if o.Drain.Reason != "" {
				msg = "driver refused drain: " + o.Drain.Reason
			}
			code := v1alpha1.ReasonBusyNotIdle
			if o.Drain.RejectionCode != "" {
				code = o.Drain.RejectionCode
			}
			return settled(o, v1alpha1.PhaseDraining, 1, ActionNone, code, msg, false)
		}
		if o.BootID != "" && o.Drain.BootID != o.BootID {
			return settled(o, v1alpha1.PhaseDraining, 1, ActionNone, v1alpha1.ReasonBootIDMismatch,
				fmt.Sprintf("drain bootId %q does not match recorded bootId %q; refusing to scale down", o.Drain.BootID, o.BootID), false)
		}
		if o.Idle == nil {
			reason := v1alpha1.ReasonBusyNotIdle
			if o.IdleRejection != nil {
				reason = o.IdleRejection.Code
			}
			d := settled(o, v1alpha1.PhaseDraining, 1, ActionNone, reason,
				idleRefusalMessage(o.IdleRejection), false)
			if o.IdleRejection != nil {
				d.SetLastIdleProofAt = true
				d.RequeueAfter = RequeueAfterProof
			}
			return d
		}
		if err := o.Idle.Validate(o.BootID, o.IdleTimeout, o.Now); err != nil {
			d := settled(o, v1alpha1.PhaseDraining, 1, ActionNone, rejectionCode(err), err.Error(), false)
			d.SetLastIdleProofAt = true
			d.RequeueAfter = RequeueAfterProof
			return d
		}
		// Drain acknowledged AND idle proven: the only place a cell may
		// sleep. A command that arrived meanwhile is not lost: it flipped
		// wantRunning, and the Sleeping branch wakes the cell again.
		return Decision{
			Phase:              v1alpha1.PhaseSleeping,
			Replicas:           0,
			Action:             ActionScaleDown,
			Reason:             v1alpha1.ReasonIdleConfirmed,
			Message:            "idle proven (no active turns, empty inbox, flushed, bootId match); scaling to zero, PVC retained",
			SetLastIdleProofAt: true,
			BootID:             "",
			ObservedGeneration: o.Generation,
		}

	// -------------------------------------------------------------- Sleeping
	case v1alpha1.PhaseSleeping:
		if want {
			return Decision{
				Phase:              v1alpha1.PhaseWaking,
				Replicas:           1,
				Action:             ActionScaleUp,
				Reason:             v1alpha1.ReasonWakeRequested,
				Message:            "command waiting: waking cell from zero",
				RequeueAfter:       RequeueBoot,
				SetWakeStartedAt:   true,
				ObservedGeneration: o.Generation,
			}
		}
		return settled(o, v1alpha1.PhaseSleeping, 0, ActionNone, "Sleeping", "cell is asleep; PVC retained", false)

	// ---------------------------------------------------------------- Failed
	case v1alpha1.PhaseFailed:
		if o.MaxWakeAttempts > 0 && o.WakeAttempts >= o.MaxWakeAttempts {
			d := settled(o, v1alpha1.PhaseFailed, o.Replicas, ActionNone, v1alpha1.ReasonWakeTimeout,
				fmt.Sprintf("wake attempt budget exhausted (%d); waiting for a new generation or a manual reset", o.MaxWakeAttempts), false)
			d.RequeueAfter = RequeueFailed
			return d
		}
		if want {
			return Decision{
				Phase:              v1alpha1.PhaseWaking,
				Replicas:           1,
				Action:             ActionScaleUp,
				Reason:             v1alpha1.ReasonWakeRequested,
				Message:            "retrying wake",
				RequeueAfter:       RequeueBoot,
				SetWakeStartedAt:   true,
				ObservedGeneration: o.Generation,
			}
		}
		d := settled(o, v1alpha1.PhaseFailed, o.Replicas, ActionNone, "Failed", "cell failed and no wake is requested", false)
		d.RequeueAfter = RequeueFailed
		return d

	// ----------------------------------------------------------------- empty
	case "":
		// A fresh object with no status is treated as Stopped.
		if want {
			return Decision{
				Phase:              v1alpha1.PhaseStarting,
				Replicas:           1,
				Action:             ActionScaleUp,
				Reason:             v1alpha1.ReasonWakeRequested,
				Message:            "cell created with wantRunning: scaling up",
				RequeueAfter:       RequeueBoot,
				SetWakeStartedAt:   true,
				ObservedGeneration: o.Generation,
			}
		}
		return settled(o, v1alpha1.PhaseStopped, 0, ActionNone, "Stopped", "cell created stopped; PVC retained", false)
	}

	// Unknown phase: fail closed and let the reconciler normalise it.
	d := settled(o, v1alpha1.PhaseFailed, o.Replicas, ActionFail, "UnknownPhase",
		fmt.Sprintf("unrecognised phase %q; refusing to act", o.Phase), false)
	d.RequeueAfter = RequeueFailed
	return d
}

func base(o Observation, phase v1alpha1.Phase, replicas int32, action Action, reason, message string, ready bool) Decision {
	return Decision{
		Phase:              phase,
		Replicas:           replicas,
		Action:             action,
		Reason:             reason,
		Message:            message,
		Ready:              ready,
		RequeueAfter:       RequeueBoot,
		ObservedGeneration: o.Generation,
	}
}

// settled is base plus "keep the recorded bootId when we are still serving".
func settled(o Observation, phase v1alpha1.Phase, replicas int32, action Action, reason, message string, ready bool) Decision {
	d := base(o, phase, replicas, action, reason, message, ready)
	switch phase {
	case v1alpha1.PhaseStarting, v1alpha1.PhaseReady, v1alpha1.PhaseDraining, v1alpha1.PhaseWaking:
		// Keep the recorded boot identity while the cell may still be
		// serving; every other phase starts from a clean boot.
		d.BootID = o.BootID
	}
	return d
}

func idleRefusalMessage(r *driver.IdleProofRejection) string {
	if r == nil {
		return "no explicit idle proof yet; refusing to scale down"
	}
	return r.Error()
}

// rejectionCode turns a proof rejection into a condition reason, so alerts can
// match the precise refusal instead of a generic "busy".
func rejectionCode(err error) string {
	var rejection *driver.IdleProofRejection
	if errors.As(err, &rejection) && rejection.Code != "" {
		return rejection.Code
	}
	return v1alpha1.ReasonBusyNotIdle
}

// RequeueImmediately reports whether the decision asks for a zero-delay
// requeue.
func (d Decision) RequeueImmediately() bool { return d.RequeueAfter == 0 }

// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package state_test

import (
	"errors"
	"testing"
	"time"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
	"github.com/myrix/apps/cell-manager/internal/driver"
	"github.com/myrix/apps/cell-manager/internal/state"
)

var now = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

// sharedCell is a healthy, idle, shared cell that has been quiet for a while.
// Individual tests shade the fields they care about.
func sharedCell() state.Observation {
	return state.Observation{
		Now:                now,
		Generation:         3,
		Phase:              v1alpha1.PhaseReady,
		ObservedGeneration: 3,
		BootID:             "boot-1",
		ReadySince:         now.Add(-2 * time.Hour),
		LastIdleProofAt:    now.Add(-2 * time.Hour),
		Tier:               v1alpha1.TierShared,
		WantRunning:        true,
		IdleTimeout:        15 * time.Minute,
		MaxWakeAttempts:    5,
		ReadyTimeout:       2 * time.Minute,
		Replicas:           1,
		ReadyReplicas:      1,
		PodExists:          true,
		PodReady:           true,
		DriverReachable:    true,
		ReadyBootID:        "boot-1",
	}
}

func idleProof() *driver.IdleProof {
	return &driver.IdleProof{
		ProofID:       "proof-1",
		BootID:        "boot-1",
		NoActiveTurns: true,
		InboxEmpty:    true,
		Flushed:       true,
		LastCommandAt: now.Add(-30 * time.Minute),
		ObservedAt:    now.Add(-time.Second),
	}
}

func draining(o state.Observation) state.Observation {
	o.Phase = v1alpha1.PhaseDraining
	o.Drain = &driver.DrainResult{Drained: true, BootID: "boot-1"}
	o.Idle = idleProof()
	return o
}

// --- The single most important invariant --------------------------------

func TestBusyCellIsNeverScaledDown(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*state.Observation)
		code    string
		contact bool // expect driver contact (idle proof attempted)
	}{
		{
			name: "active turn",
			mutate: func(o *state.Observation) {
				o.Idle = idleProof()
				o.Idle.NoActiveTurns = false
			},
			code:    driver.RejectActiveTurns,
			contact: true,
		},
		{
			name: "inbox not empty",
			mutate: func(o *state.Observation) {
				o.Idle = idleProof()
				o.Idle.InboxEmpty = false
			},
			code:    driver.RejectInboxNotEmpty,
			contact: true,
		},
		{
			name: "not flushed",
			mutate: func(o *state.Observation) {
				o.Idle = idleProof()
				o.Idle.Flushed = false
			},
			code:    driver.RejectNotFlushed,
			contact: true,
		},
		{
			name: "driver still busy (drain refused)",
			mutate: func(o *state.Observation) {
				o.Drain = &driver.DrainResult{Drained: false, BootID: "boot-1", Reason: "a turn is still active", RejectionCode: driver.RejectActiveTurns}
				o.Idle = nil
			},
			code:    driver.RejectActiveTurns,
			contact: false,
		},
		{
			name: "quiet period not elapsed",
			mutate: func(o *state.Observation) {
				o.Idle = idleProof()
				o.Idle.LastCommandAt = now.Add(-1 * time.Minute)
			},
			code:    driver.RejectQuietNotElapsed,
			contact: true,
		},
		{
			name: "stale proof",
			mutate: func(o *state.Observation) {
				o.Idle = idleProof()
				o.Idle.ObservedAt = now.Add(-10 * time.Minute)
				o.Idle.LastCommandAt = now.Add(-40 * time.Minute)
			},
			code:    driver.RejectStaleProof,
			contact: true,
		},
		{
			name: "proof from a previous boot",
			mutate: func(o *state.Observation) {
				o.Idle = idleProof()
				o.Idle.BootID = "boot-0"
			},
			code:    driver.RejectBootIDMismatch,
			contact: true,
		},
		{
			name: "no proof at all",
			mutate: func(o *state.Observation) {
				o.Idle = nil
			},
			code:    "",
			contact: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := draining(sharedCell())
			tc.mutate(&o)
			d := state.Decide(o)
			if d.Action == state.ActionScaleDown {
				t.Fatalf("busy cell was scaled down: %+v", d)
			}
			if d.Replicas != 1 {
				t.Fatalf("replicas = %d, want 1 while not idle", d.Replicas)
			}
			if d.Phase != v1alpha1.PhaseDraining {
				t.Fatalf("phase = %q, want Draining", d.Phase)
			}
			if d.Ready {
				t.Fatal("a draining cell must not be reported Ready")
			}
			if tc.code != "" && d.Reason != tc.code {
				t.Fatalf("reason = %q, want %q (message: %s)", d.Reason, tc.code, d.Message)
			}
		})
	}
}

func TestUnreachableDriverNeverScalesDown(t *testing.T) {
	o := draining(sharedCell())
	o.DriverReachable = false
	o.Drain = nil
	o.Idle = nil
	d := state.Decide(o)
	if d.Action == state.ActionScaleDown {
		t.Fatal("scaled down without a reachable driver")
	}
	if d.Reason != v1alpha1.ReasonDriverUnavailable {
		t.Fatalf("reason = %q, want %q", d.Reason, v1alpha1.ReasonDriverUnavailable)
	}
}

func TestIdleProvenCellSleeps(t *testing.T) {
	o := draining(sharedCell())
	// A command arrived while the drain was in flight, but the cell is
	// genuinely idle and flushed: sleeping is correct, and the flush proof
	// guarantees the command is durable before exit.
	o.WantRunning = true
	d := state.Decide(o)
	if d.Action != state.ActionScaleDown || d.Replicas != 0 || d.Phase != v1alpha1.PhaseSleeping {
		t.Fatalf("decision = %+v, want scale-down to Sleeping", d)
	}
	if d.BootID != "" {
		t.Fatalf("bootId = %q, want cleared on sleep", d.BootID)
	}
	if !d.SetLastIdleProofAt {
		t.Fatal("accepted idle proof must be timestamped")
	}
	if d.Ready {
		t.Fatal("sleeping cell must not be Ready")
	}
}

// --- Drain/wake race -----------------------------------------------------

func TestCommandDuringDrainWaitsForSleepThenWakes(t *testing.T) {
	// Step 1: a command arrives while Draining. The cell must not be Ready
	// and must not be handed to the router.
	o := draining(sharedCell())
	o.WantRunning = true
	step1 := state.Decide(o)
	if step1.Ready {
		t.Fatal("draining cell must not be Ready even when a command is waiting")
	}
	if step1.Phase == v1alpha1.PhaseReady {
		t.Fatal("Draining must never transition directly back to Ready")
	}

	// Step 2: idle proof accepted; the cell sleeps.
	step2 := state.Decide(o)
	if step2.Phase != v1alpha1.PhaseSleeping || step2.Replicas != 0 {
		t.Fatalf("step2 = %+v, want Sleeping/0", step2)
	}

	// Step 3: the queued command drives wantRunning=true; the cell wakes.
	o2 := sharedCell()
	o2.Phase = v1alpha1.PhaseSleeping
	o2.Replicas = 0
	o2.ReadyReplicas = 0
	o2.PodExists = false
	o2.PodReady = false
	o2.BootID = ""
	o2.WantRunning = true
	step3 := state.Decide(o2)
	if step3.Phase != v1alpha1.PhaseWaking || step3.Replicas != 1 || step3.Action != state.ActionScaleUp {
		t.Fatalf("step3 = %+v, want Waking/1 scale-up", step3)
	}

	// Step 4: the new boot becomes ready with a new bootId.
	o3 := o2
	o3.Phase = v1alpha1.PhaseWaking
	o3.Replicas = 1
	o3.ReadyReplicas = 1
	o3.PodExists = true
	o3.PodReady = true
	o3.WakeStartedAt = now.Add(-5 * time.Second)
	o3.ReadyBootID = "boot-2"
	step4 := state.Decide(o3)
	if step4.Phase != v1alpha1.PhaseReady || !step4.Ready || step4.BootID != "boot-2" {
		t.Fatalf("step4 = %+v, want Ready with boot-2", step4)
	}
}

func TestDrainingNeverReturnsToReadyInOneStep(t *testing.T) {
	// Exhaustively vary the drain observations: no combination may produce
	// Ready directly from Draining.
	bools := []bool{true, false}
	for _, reachable := range bools {
		for _, drained := range bools {
			for _, want := range bools {
				for _, hasIdle := range bools {
					for _, hasDrain := range bools {
						o := draining(sharedCell())
						o.DriverReachable = reachable
						o.WantRunning = want
						o.Idle = nil
						if hasDrain {
							o.Drain = &driver.DrainResult{Drained: drained, BootID: "boot-1"}
						} else {
							o.Drain = nil
						}
						if hasIdle {
							o.Idle = idleProof()
						}
						d := state.Decide(o)
						if d.Phase == v1alpha1.PhaseReady || d.Ready {
							t.Fatalf("Draining -> Ready with reachable=%v drained=%v want=%v idle=%v: %+v",
								reachable, drained, want, hasIdle, d)
						}
						if d.Phase == v1alpha1.PhaseSleeping && d.Replicas != 0 {
							t.Fatalf("Sleeping with replicas=%d", d.Replicas)
						}
					}
				}
			}
		}
	}
}

func TestWantRunningFalseStartsSleepHandshake(t *testing.T) {
	o := sharedCell()
	o.WantRunning = false
	d := state.Decide(o)
	if d.Phase != v1alpha1.PhaseDraining || d.Replicas != 1 {
		t.Fatalf("decision = %+v, want Draining at replicas=1 (process still up)", d)
	}
	if d.Action == state.ActionScaleDown {
		t.Fatal("scale-down must never happen in the Draining transition itself")
	}
	if d.Ready {
		t.Fatal("draining cell must not be Ready")
	}
	if !d.ClearReadySince {
		t.Fatal("leaving Ready must clear readySince so the quiet clock restarts")
	}
}

// --- Idle timeout --------------------------------------------------------

func TestIdleTimeoutOnlyForSharedTier(t *testing.T) {
	shared := sharedCell()
	shared.ReadySince = now.Add(-16 * time.Minute)
	shared.LastIdleProofAt = time.Time{}
	if d := state.Decide(shared); d.Phase != v1alpha1.PhaseDraining {
		t.Fatalf("idle shared cell: phase = %q, want Draining", d.Phase)
	}

	dedicated := sharedCell()
	dedicated.Tier = v1alpha1.TierDedicated
	dedicated.ReadySince = now.Add(-30 * 24 * time.Hour)
	dedicated.LastIdleProofAt = time.Time{}
	d := state.Decide(dedicated)
	if d.Phase != v1alpha1.PhaseReady || !d.Ready {
		t.Fatalf("dedicated cell must stay Ready: %+v", d)
	}
}

func TestRecentCommandPostponesSleep(t *testing.T) {
	o := sharedCell()
	o.ReadySince = now.Add(-2 * time.Hour)
	o.LastIdleProofAt = now.Add(-1 * time.Minute) // a refused proof restarts the clock
	d := state.Decide(o)
	if d.Phase != v1alpha1.PhaseReady || !d.Ready {
		t.Fatalf("decision = %+v, want still Ready", d)
	}
}

func TestZeroIdleTimeoutDisablesIdleSleep(t *testing.T) {
	o := sharedCell()
	o.IdleTimeout = 0
	o.ReadySince = now.Add(-100 * time.Hour)
	d := state.Decide(o)
	if d.Phase != v1alpha1.PhaseReady {
		t.Fatalf("phase = %q, want Ready when idleTimeout is 0", d.Phase)
	}
}

// --- Readiness / generation ---------------------------------------------

func TestStaleGenerationIsNotReady(t *testing.T) {
	o := sharedCell()
	o.Generation = 7 // spec changed after the observations were made
	o.ObservedGeneration = 3
	d := state.Decide(o)
	if d.Ready {
		t.Fatal("stale generation must not be Ready")
	}
	if d.Phase != v1alpha1.PhaseStarting {
		t.Fatalf("phase = %q, want Starting (re-prove readiness)", d.Phase)
	}
	if d.Action != state.ActionScaleUp {
		t.Fatalf("action = %q, want ScaleUp", d.Action)
	}
}

func TestReadyRequiresReadyReplicaAndBootID(t *testing.T) {
	o := sharedCell()
	o.Phase = v1alpha1.PhaseStarting
	o.WakeStartedAt = now.Add(-time.Second)
	o.ReadyReplicas = 0
	o.PodReady = false
	d := state.Decide(o)
	if d.Ready {
		t.Fatal("Ready with zero ready replicas")
	}

	o.ReadyReplicas = 1
	o.PodReady = true
	o.ReadyBootID = ""
	d = state.Decide(o)
	if d.Ready {
		t.Fatal("Ready without a bootId")
	}

	o.ReadyBootID = "boot-1"
	d = state.Decide(o)
	if !d.Ready || d.Phase != v1alpha1.PhaseReady || d.BootID != "boot-1" {
		t.Fatalf("decision = %+v, want Ready/boot-1", d)
	}
	if !d.ResetIdleProofAt || !d.ClearWakeStartedAt || !d.ResetWakeAttempts {
		t.Fatalf("becoming Ready must reset proof/wake bookkeeping: %+v", d)
	}
}

func TestReadyIsNotReportedWhenDriverUnreachable(t *testing.T) {
	o := sharedCell()
	o.Phase = v1alpha1.PhaseWaking
	o.WakeStartedAt = now.Add(-time.Second)
	o.DriverReachable = false
	d := state.Decide(o)
	if d.Ready || d.Phase == v1alpha1.PhaseReady {
		t.Fatalf("decision = %+v, want not Ready", d)
	}
	if d.Reason != v1alpha1.ReasonDriverUnavailable {
		t.Fatalf("reason = %q", d.Reason)
	}
}

func TestWakeTimeoutFailsAndBumpsAttempts(t *testing.T) {
	o := sharedCell()
	o.Phase = v1alpha1.PhaseWaking
	o.WakeStartedAt = now.Add(-5 * time.Minute)
	o.PodReady = false
	o.ReadyReplicas = 0
	o.ReadyTimeout = 2 * time.Minute
	d := state.Decide(o)
	if d.Phase != v1alpha1.PhaseFailed || !d.BumpWakeAttempt {
		t.Fatalf("decision = %+v, want Failed with attempt bump", d)
	}
	if d.Reason != v1alpha1.ReasonWakeTimeout {
		t.Fatalf("reason = %q", d.Reason)
	}
}

// --- Replicas are 0/1 only ----------------------------------------------

func TestReplicasAreAlwaysZeroOrOne(t *testing.T) {
	phases := []v1alpha1.Phase{
		"", v1alpha1.PhaseStopped, v1alpha1.PhaseStarting, v1alpha1.PhaseReady,
		v1alpha1.PhaseDraining, v1alpha1.PhaseSleeping, v1alpha1.PhaseWaking,
		v1alpha1.PhaseFailed, "SomethingElse",
	}
	for _, phase := range phases {
		for _, want := range []bool{true, false} {
			for _, tier := range []v1alpha1.Tier{v1alpha1.TierShared, v1alpha1.TierDedicated} {
				o := draining(sharedCell())
				o.Phase = phase
				o.WantRunning = want
				o.Tier = tier
				d := state.Decide(o)
				if d.Replicas != 0 && d.Replicas != 1 {
					t.Fatalf("phase=%q want=%v tier=%q produced replicas=%d", phase, want, tier, d.Replicas)
				}
			}
		}
	}
}

// --- Lifecycle walk ------------------------------------------------------

func TestFullSharedLifecycle(t *testing.T) {
	// created, wantRunning=false
	o := sharedCell()
	o.Phase = ""
	o.ObservedGeneration = 0
	o.BootID = ""
	o.Replicas = 0
	o.ReadyReplicas = 0
	o.PodExists = false
	o.PodReady = false
	o.WantRunning = false
	d := state.Decide(o)
	if d.Phase != v1alpha1.PhaseStopped || d.Action == state.ActionScaleUp {
		t.Fatalf("fresh idle cell = %+v, want Stopped without scale-up", d)
	}

	// wake request
	o.WantRunning = true
	d = state.Decide(o)
	if d.Phase != v1alpha1.PhaseStarting || d.Action != state.ActionScaleUp || !d.SetWakeStartedAt {
		t.Fatalf("wake = %+v, want Starting/ScaleUp", d)
	}

	// boot
	o.Phase = v1alpha1.PhaseStarting
	o.ObservedGeneration = o.Generation
	o.WakeStartedAt = now.Add(-time.Second)
	o.Replicas = 1
	o.ReadyReplicas = 1
	o.PodExists = true
	o.PodReady = true
	o.ReadyBootID = "boot-1"
	d = state.Decide(o)
	if d.Phase != v1alpha1.PhaseReady || !d.Ready {
		t.Fatalf("boot = %+v, want Ready", d)
	}

	// long idle -> drain
	o.Phase = v1alpha1.PhaseReady
	o.BootID = "boot-1"
	o.ReadySince = now.Add(-1 * time.Hour)
	o.LastIdleProofAt = time.Time{}
	d = state.Decide(o)
	if d.Phase != v1alpha1.PhaseDraining {
		t.Fatalf("idle = %+v, want Draining", d)
	}

	// drain + proof -> sleeping
	o.Phase = v1alpha1.PhaseDraining
	o.Drain = &driver.DrainResult{Drained: true, BootID: "boot-1"}
	o.Idle = idleProof()
	d = state.Decide(o)
	if d.Phase != v1alpha1.PhaseSleeping || d.Replicas != 0 || d.Action != state.ActionScaleDown {
		t.Fatalf("drain = %+v, want Sleeping/0", d)
	}

	// converged: replicas already 0
	o.Replicas = 0
	o.ReadyReplicas = 0
	o.PodExists = false
	o.Drain = nil
	o.Idle = nil
	d = state.Decide(o)
	if d.Phase != v1alpha1.PhaseSleeping || d.Action != state.ActionNone {
		t.Fatalf("converged = %+v, want Sleeping/None", d)
	}
}

func TestUnknownPhaseFailsClosed(t *testing.T) {
	o := sharedCell()
	o.Phase = "WhoKnows"
	o.BootID = ""
	d := state.Decide(o)
	if d.Action != state.ActionFail {
		t.Fatalf("action = %q, want Fail", d.Action)
	}
	if d.Ready {
		t.Fatal("unknown phase must not be Ready")
	}
}

func TestFailedRespectsAttemptBudget(t *testing.T) {
	o := sharedCell()
	o.Phase = v1alpha1.PhaseFailed
	o.WakeAttempts = 5
	o.MaxWakeAttempts = 5
	o.WantRunning = true
	d := state.Decide(o)
	if d.Phase != v1alpha1.PhaseFailed || d.Action == state.ActionScaleUp {
		t.Fatalf("decision = %+v, want no further scale-up after budget exhaustion", d)
	}

	o.WakeAttempts = 4
	d = state.Decide(o)
	if d.Phase != v1alpha1.PhaseWaking || d.Action != state.ActionScaleUp {
		t.Fatalf("decision = %+v, want one more wake retry", d)
	}
}

// --- IdleProof.Validate unit table ---------------------------------------

func TestIdleProofValidationTable(t *testing.T) {
	base := func() driver.IdleProof { return *idleProof() }
	cases := []struct {
		name    string
		mutate  func(*driver.IdleProof)
		boot    string
		quiet   time.Duration
		wantErr string
	}{
		{name: "accepted", mutate: func(*driver.IdleProof) {}, boot: "boot-1", quiet: 15 * time.Minute},
		{name: "no current boot", mutate: func(*driver.IdleProof) {}, boot: "", quiet: time.Minute, wantErr: driver.RejectBootIDMismatch},
		{name: "boot mismatch", mutate: func(*driver.IdleProof) {}, boot: "boot-2", quiet: time.Minute, wantErr: driver.RejectBootIDMismatch},
		{name: "active turn", mutate: func(p *driver.IdleProof) { p.NoActiveTurns = false }, boot: "boot-1", quiet: time.Minute, wantErr: driver.RejectActiveTurns},
		{name: "inbox", mutate: func(p *driver.IdleProof) { p.InboxEmpty = false }, boot: "boot-1", quiet: time.Minute, wantErr: driver.RejectInboxNotEmpty},
		{name: "unflushed", mutate: func(p *driver.IdleProof) { p.Flushed = false }, boot: "boot-1", quiet: time.Minute, wantErr: driver.RejectNotFlushed},
		{name: "missing timestamps", mutate: func(p *driver.IdleProof) { p.ObservedAt = time.Time{} }, boot: "boot-1", quiet: time.Minute, wantErr: driver.RejectInvalidProof},
		{name: "future proof", mutate: func(p *driver.IdleProof) { p.ObservedAt = now.Add(time.Hour) }, boot: "boot-1", quiet: time.Minute, wantErr: driver.RejectInvalidProof},
		{name: "stale proof", mutate: func(p *driver.IdleProof) { p.ObservedAt = now.Add(-10 * time.Minute) }, boot: "boot-1", quiet: time.Minute, wantErr: driver.RejectStaleProof},
		{
			name: "quiet not elapsed",
			mutate: func(p *driver.IdleProof) {
				p.LastCommandAt = now.Add(-5 * time.Minute)
			},
			boot: "boot-1", quiet: 15 * time.Minute, wantErr: driver.RejectQuietNotElapsed,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := base()
			tc.mutate(&p)
			err := p.Validate(tc.boot, tc.quiet, now)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected rejection: %v", err)
				}
				return
			}
			var rejection *driver.IdleProofRejection
			if !errors.As(err, &rejection) {
				t.Fatalf("error = %v, want IdleProofRejection", err)
			}
			if rejection.Code != tc.wantErr {
				t.Fatalf("code = %q, want %q", rejection.Code, tc.wantErr)
			}
		})
	}
}

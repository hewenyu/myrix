// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package driver talks to the myrix-runtime-driver inside a cell process.
//
// The wire contract is defined by docs/implementation/runtime-driver.md. Paths are
// real; whether a given deployment has a reachable driver behind them is a
// deployment fact, not an assumption of this package. When the driver is
// unreachable the controller fails closed: it never scales a cell down and
// never marks it Ready.
package driver

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// Fault codes returned by the client. Callers must treat every unknown error
// as a hard failure (fail closed).
var (
	// ErrUnavailable means the driver could not be reached at all.
	ErrUnavailable = errors.New("runtime driver unavailable")
	// ErrUnexpectedStatus means the driver answered with a non-2xx status.
	ErrUnexpectedStatus = errors.New("runtime driver returned unexpected status")
	// ErrMalformedResponse means the driver answered with a body we cannot
	// trust (missing bootId, missing idle-proof fields, invalid timestamps).
	ErrMalformedResponse = errors.New("runtime driver returned malformed response")
)

// Endpoint is a resolved driver address for one cell pod.
type Endpoint struct {
	// PodIP is the pod IP of the ready cell pod (replicas 0/1, so this is
	// unambiguous).
	PodIP string
	// Port is the driver port.
	Port int32
	// BaseURL, when set, overrides PodIP:Port entirely. It exists for tests
	// and for deployments that front the driver with a Service or a mesh.
	BaseURL string
}

// String renders a safe, loggable endpoint description.
func (e Endpoint) String() string {
	if e.BaseURL != "" {
		return e.BaseURL
	}
	if e.PodIP == "" {
		return ""
	}
	return net.JoinHostPort(e.PodIP, strconv.Itoa(int(e.Port)))
}

// URL returns the base URL used for driver calls.
func (e Endpoint) URL() string {
	if e.BaseURL != "" {
		return strings.TrimRight(e.BaseURL, "/")
	}
	if e.PodIP == "" {
		return ""
	}
	return "http://" + net.JoinHostPort(e.PodIP, strconv.Itoa(int(e.Port)))
}

// Valid reports whether the endpoint can be dialled.
func (e Endpoint) Valid() bool { return e.URL() != "" }

// ReadyInfo is the answer of GET /v1/ready.
type ReadyInfo struct {
	BootID string `json:"bootId"`
	Status string `json:"status"`
}

// DrainResult is the answer of POST /v1/admin/drain. Drained is the driver's
// assertion that admission is closed, no turn is active, the inbox is empty
// and the session buffer was flushed.
type DrainResult struct {
	Drained bool   `json:"drained"`
	BootID  string `json:"bootId"`
	// Reason explains a refusal (for example "active turn").
	Reason string `json:"reason,omitempty"`
	// RejectionCode is the machine-readable refusal code; when present it is
	// used verbatim as the condition reason. It reuses the IdleProof
	// rejection codes (ActiveTurns, InboxNotEmpty, NotFlushed, ...).
	RejectionCode string `json:"rejectionCode,omitempty"`
}

// IdleProof is the answer of POST /v1/admin/idle. It is the *only* evidence
// that may drive a scale-to-zero: a quiet timer alone is not a proof, because
// a long turn looks quiet.
type IdleProof struct {
	// ProofID identifies this proof for audit; optional but recommended.
	ProofID string `json:"proofId,omitempty"`
	// BootID is the boot identity the proof was produced for. It must match
	// the bootId the controller observed when the pod became ready, so a
	// proof from a previous incarnation can never authorise a scale-down.
	BootID string `json:"bootId"`
	// NoActiveTurns is true when no agent turn is running.
	NoActiveTurns bool `json:"noActiveTurns"`
	// InboxEmpty is true when no command is queued in the cell.
	InboxEmpty bool `json:"inboxEmpty"`
	// Flushed is true when the session buffer has been written to disk.
	Flushed bool `json:"flushed"`
	// LastCommandAt is when the driver last accepted a command.
	LastCommandAt time.Time `json:"lastCommandAt"`
	// ObservedAt is when the driver produced the proof.
	ObservedAt time.Time `json:"observedAt"`
}

// IdleProofRejection explains why a proof was not accepted.
type IdleProofRejection struct {
	Code   string
	Reason string
}

func (r *IdleProofRejection) Error() string { return r.Code + ": " + r.Reason }

// Rejection codes. They are mirrored into condition reasons, so alerts can
// match on them.
const (
	RejectBootIDMismatch  = "BootIDMismatch"
	RejectActiveTurns     = "ActiveTurns"
	RejectInboxNotEmpty   = "InboxNotEmpty"
	RejectNotFlushed      = "NotFlushed"
	RejectQuietNotElapsed = "QuietPeriodNotElapsed"
	RejectStaleProof      = "StaleProof"
	RejectInvalidProof    = "InvalidProof"
)

// Validate checks a proof against the expected boot identity and the required
// quiet period. It is the single place where "may we scale to zero?" is
// decided, so every rejection is explicit and testable.
//
// expectedBootID must be the bootId returned by GET /v1/ready for the pod that
// is currently serving; requiredQuiet is spec.idleTimeoutSeconds.
func (p IdleProof) Validate(expectedBootID string, requiredQuiet time.Duration, now time.Time) error {
	if expectedBootID == "" {
		return &IdleProofRejection{RejectBootIDMismatch, "no bootId observed for the current pod"}
	}
	if p.BootID != expectedBootID {
		return &IdleProofRejection{RejectBootIDMismatch, fmt.Sprintf("proof bootId %q does not match current bootId %q", p.BootID, expectedBootID)}
	}
	if !p.NoActiveTurns {
		return &IdleProofRejection{RejectActiveTurns, "a turn is still active"}
	}
	if !p.InboxEmpty {
		return &IdleProofRejection{RejectInboxNotEmpty, "the cell inbox is not empty"}
	}
	if !p.Flushed {
		return &IdleProofRejection{RejectNotFlushed, "the session buffer is not flushed"}
	}
	if p.ObservedAt.IsZero() || p.LastCommandAt.IsZero() {
		return &IdleProofRejection{RejectInvalidProof, "proof is missing observedAt or lastCommandAt"}
	}
	if p.ObservedAt.After(now.Add(time.Minute)) {
		return &IdleProofRejection{RejectInvalidProof, "observedAt is in the future"}
	}
	if p.ObservedAt.Before(now.Add(-2 * time.Minute)) {
		return &IdleProofRejection{RejectStaleProof, "proof is older than two minutes"}
	}
	if elapsed := p.ObservedAt.Sub(p.LastCommandAt); elapsed < requiredQuiet {
		return &IdleProofRejection{RejectQuietNotElapsed, fmt.Sprintf("only %s of the required %s quiet period elapsed", elapsed.Truncate(time.Second), requiredQuiet)}
	}
	return nil
}

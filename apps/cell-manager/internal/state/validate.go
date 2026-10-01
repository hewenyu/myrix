// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package state

import (
	"errors"
	"fmt"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
)

// Spec validation errors. Every one of them must prevent the reconciler from
// touching any workload: an object whose identity is ambiguous is never acted
// on (fail closed).
var (
	// ErrTenantIDMissing means spec.tenantId is empty.
	ErrTenantIDMissing = errors.New("spec.tenantId is required")
	// ErrTenantLabelMismatch means the myrix.io/tenant label does not match
	// spec.tenantId. This is the cross-tenant guardrail: it makes it
	// impossible for a cell to be labelled as another tenant's.
	ErrTenantLabelMismatch = errors.New("myrix.io/tenant label does not match spec.tenantId")
	// ErrCellLabelMismatch means the myrix.io/cell label does not match
	// metadata.name.
	ErrCellLabelMismatch = errors.New("myrix.io/cell label does not match metadata.name")
	// ErrCellNameMissing means metadata.name is empty.
	ErrCellNameMissing = errors.New("metadata.name is required")
	// ErrInvalidTier means spec.tier is not shared or dedicated.
	ErrInvalidTier = errors.New("spec.tier must be shared or dedicated")
	// ErrDedicatedWantRunning means a dedicated cell was asked to stop. The
	// two would contradict each other; the operator must choose.
	ErrDedicatedWantRunning = errors.New("dedicated cells are resident; spec.wantRunning=false is not a valid way to stop them")
	// ErrImageMissing means spec.runtime.image is empty.
	ErrImageMissing = errors.New("spec.runtime.image is required")
	// ErrStorageSizeMissing means spec.storage.size is empty.
	ErrStorageSizeMissing = errors.New("spec.storage.size is required")
	// ErrNegativeIdleTimeout means the idle timeout is negative.
	ErrNegativeIdleTimeout = errors.New("spec.idleTimeoutSeconds must be >= 0")
)

// ValidationError decorates a rejection with the condition reason the
// reconciler must publish.
type ValidationError struct {
	Reason string
	Err    error
}

func (e *ValidationError) Error() string { return e.Err.Error() }
func (e *ValidationError) Unwrap() error { return e.Err }

// ValidateSpec rejects semantically invalid TenantCell objects.
func ValidateSpec(cell *v1alpha1.TenantCell) error {
	if cell.Name == "" {
		return &ValidationError{v1alpha1.ReasonInvalidWantRunning, ErrCellNameMissing}
	}
	if cell.Spec.TenantID == "" {
		return &ValidationError{v1alpha1.ReasonTenantLabelMissing, ErrTenantIDMissing}
	}
	if got := cell.Labels[v1alpha1.LabelTenant]; got != cell.Spec.TenantID {
		return &ValidationError{v1alpha1.ReasonTenantLabelMissing, fmt.Errorf("%w: label=%q spec=%q", ErrTenantLabelMismatch, got, cell.Spec.TenantID)}
	}
	if got := cell.Labels[v1alpha1.LabelCell]; got != "" && got != cell.Name {
		return &ValidationError{v1alpha1.ReasonInvalidWantRunning, fmt.Errorf("%w: label=%q name=%q", ErrCellLabelMismatch, got, cell.Name)}
	}
	switch cell.Spec.Tier {
	case v1alpha1.TierShared:
		// wantRunning may be true or false.
	case v1alpha1.TierDedicated:
		if !cell.Spec.WantRunning {
			return &ValidationError{v1alpha1.ReasonInvalidTier, ErrDedicatedWantRunning}
		}
	default:
		return &ValidationError{v1alpha1.ReasonInvalidTier, fmt.Errorf("%w: got %q", ErrInvalidTier, cell.Spec.Tier)}
	}
	if cell.Spec.Runtime.Image == "" {
		return &ValidationError{v1alpha1.ReasonInvalidWantRunning, ErrImageMissing}
	}
	if cell.Spec.Storage.Size == "" {
		return &ValidationError{v1alpha1.ReasonInvalidWantRunning, ErrStorageSizeMissing}
	}
	if cell.Spec.IdleTimeoutSeconds != nil && *cell.Spec.IdleTimeoutSeconds < 0 {
		return &ValidationError{v1alpha1.ReasonInvalidWantRunning, ErrNegativeIdleTimeout}
	}
	return nil
}

// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package controller

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
)

// WantRunningSetter is the injection point the session router uses. The router
// holds no Kubernetes permissions itself: it calls this narrow interface and
// the manager performs the write with its own (namespace-scoped) credentials.
type WantRunningSetter interface {
	// SetWantRunning sets spec.wantRunning on one cell. It is idempotent.
	SetWantRunning(ctx context.Context, namespace, cellName string, want bool) error
}

// WantRunningClient implements WantRunningSetter against the Kubernetes API.
type WantRunningClient struct {
	Client client.Client
	// Namespace is the only namespace this setter may touch.
	Namespace string
}

// SetWantRunning implements WantRunningSetter.
func (w *WantRunningClient) SetWantRunning(ctx context.Context, namespace, cellName string, want bool) error {
	if w.Namespace != "" && namespace != w.Namespace {
		return fmt.Errorf("namespace %q is outside the authorised runtime namespace %q", namespace, w.Namespace)
	}
	for attempt := 0; attempt < 5; attempt++ {
		var cell v1alpha1.TenantCell
		if err := w.Client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: cellName}, &cell); err != nil {
			return err
		}
		if cell.Spec.WantRunning == want || (cell.Spec.Tier == v1alpha1.TierDedicated && want) {
			return nil
		}
		patch := client.MergeFrom(cell.DeepCopy())
		cell.Spec.WantRunning = want
		if err := w.Client.Patch(ctx, &cell, patch); err != nil {
			if apierrors.IsConflict(err) {
				continue
			}
			return err
		}
		return nil
	}
	return fmt.Errorf("setting wantRunning on %s/%s: too many conflicts", namespace, cellName)
}

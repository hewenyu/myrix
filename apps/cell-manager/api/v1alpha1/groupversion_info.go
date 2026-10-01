// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// GroupName is the API group served by the Cell Manager.
const GroupName = "myrix.io"

// Version is the API version served by the Cell Manager.
const Version = "v1alpha1"

// GroupVersion is the group/version for TenantCell.
var GroupVersion = schema.GroupVersion{Group: GroupName, Version: Version}

// SchemeBuilder registers the API types with a runtime.Scheme.
var SchemeBuilder = runtime.NewSchemeBuilder(addKnownTypes)

// AddToScheme registers TenantCell and TenantCellList.
var AddToScheme = SchemeBuilder.AddToScheme

func addKnownTypes(scheme *runtime.Scheme) error {
	scheme.AddKnownTypes(GroupVersion, &TenantCell{}, &TenantCellList{})
	metav1.AddToGroupVersion(scheme, GroupVersion)
	return nil
}

// Labels and annotations owned by the Cell Manager.
const (
	// LabelTenant carries the tenant id on every managed object. Cross-tenant
	// guardrails in the controller compare it against spec.tenantId.
	LabelTenant = "myrix.io/tenant"
	// LabelCell carries the TenantCell name on every managed object.
	LabelCell = "myrix.io/cell"
	// LabelManagedBy marks controller-owned objects.
	LabelManagedBy = "app.kubernetes.io/managed-by"
	// ManagedByValue is the value of LabelManagedBy.
	ManagedByValue = "myrix-cell-manager"

	// AnnotationBootID records the bootId a resource was reconciled for.
	AnnotationBootID = "myrix.io/boot-id"
	// AnnotationDrainedAt records when the driver confirmed the drain.
	AnnotationDrainedAt = "myrix.io/drained-at"
)

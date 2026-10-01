// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package k8s builds the namespaced Kubernetes objects owned by one
// TenantCell. One cell is one StatefulSet (replicas 0 or 1), one headless
// Service and one ReadWriteOnce volume holding DSH_HOME. The builders are pure
// so manifests can be asserted in unit tests without a cluster.
package k8s

import (
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
)

// Names and paths that the runtime image must honour. They are part of the
// contract with the image builder; there is no published image in this
// repository yet.
const (
	// ContainerName is the single container in a cell pod.
	ContainerName = "cell"
	// DriverPortName is the named container port for the runtime driver.
	DriverPortName = "driver"
	// DSHHomePath is the mount point of the per-tenant volume. It is a
	// writable path inside an otherwise read-only root filesystem.
	DSHHomePath = "/var/lib/myrix/dsh-home"
	// TempPath is a writable emptyDir for runtime temp files.
	TempPath = "/tmp"
	// NonRootUID is the UID the cell runs as. It has no meaning on the host
	// and exists only to satisfy runAsNonRoot.
	NonRootUID = int64(65532)
	// NonRootGID is the primary group for the cell process.
	NonRootGID = int64(65532)

	// EnvCellID and EnvTenantID let the driver assert its own identity
	// without trusting the network.
	EnvCellID   = "MYRIX_CELL_ID"
	EnvTenantID = "MYRIX_TENANT_ID"
	// EnvDSHHome pins DSH_HOME explicitly instead of relying on HOME.
	EnvDSHHome = "DSH_HOME"
	// EnvDriverPort tells the driver which port to bind.
	EnvDriverPort = "MYRIX_DRIVER_PORT"

	// VolumeDSHHome is the per-tenant volume name.
	VolumeDSHHome = "dsh-home"
	// VolumeTemp is the ephemeral scratch volume name.
	VolumeTemp = "tmp"
	// VolumeCredentials is the per-tenant credential secret volume.
	VolumeCredentials = "credentials"
	// CredentialsPath is where the per-tenant Secret is mounted, read-only.
	// One cell is one tenant, so this mount is never shared.
	CredentialsPath = "/var/run/myrix/credentials"
)

// StatefulSetName returns the StatefulSet (and TenantCell) name.
func StatefulSetName(cell *v1alpha1.TenantCell) string { return cell.Name }

// ServiceName returns the headless Service name for the cell.
func ServiceName(cell *v1alpha1.TenantCell) string { return cell.Name + "-driver" }

// PVCName returns the PersistentVolumeClaim name produced by the
// volumeClaimTemplate for ordinal 0. It is recorded here so tests and runbooks
// refer to the same name; the controller never deletes it.
func PVCName(cell *v1alpha1.TenantCell) string {
	return fmt.Sprintf("%s-%s-0", VolumeDSHHome, cell.Name)
}

// PodName returns the pod name for ordinal 0.
func PodName(cell *v1alpha1.TenantCell) string { return cell.Name + "-0" }

// ObjectLabels are the labels applied to every managed object.
func ObjectLabels(cell *v1alpha1.TenantCell) map[string]string {
	return map[string]string{
		v1alpha1.LabelTenant:    cell.Spec.TenantID,
		v1alpha1.LabelCell:      cell.Name,
		v1alpha1.LabelManagedBy: v1alpha1.ManagedByValue,
	}
}

// SelectorLabels identify the pods of one cell. They are immutable in a
// StatefulSet, so they stay minimal.
func SelectorLabels(cell *v1alpha1.TenantCell) map[string]string {
	return map[string]string{v1alpha1.LabelCell: cell.Name}
}

// Service builds the headless Service that gives the cell a stable DNS name.
// It selects only this cell's pods, so it can never route to another tenant.
func Service(cell *v1alpha1.TenantCell) *corev1.Service {
	labels := ObjectLabels(cell)
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ServiceName(cell),
			Namespace: cell.Namespace,
			Labels:    labels,
		},
		Spec: corev1.ServiceSpec{
			ClusterIP:                corev1.ClusterIPNone,
			Selector:                 SelectorLabels(cell),
			PublishNotReadyAddresses: false,
			Ports: []corev1.ServicePort{{
				Name:       DriverPortName,
				Port:       cell.Spec.DriverPortOrDefault(),
				TargetPort: intstr.FromString(DriverPortName),
				Protocol:   corev1.ProtocolTCP,
			}},
		},
	}
}

// StatefulSet builds the cell workload at the given replica count. The caller
// is responsible for passing only 0 or 1; StatefulSet panics are avoided by
// clamping here as a second line of defence.
func StatefulSet(cell *v1alpha1.TenantCell, replicas int32) *appsv1.StatefulSet {
	if replicas > 1 {
		replicas = 1
	}
	if replicas < 0 {
		replicas = 0
	}
	labels := ObjectLabels(cell)
	selector := SelectorLabels(cell)
	driverPort := cell.Spec.DriverPortOrDefault()
	port := cell.Spec.DriverPortOrDefault()
	_ = port

	trueVal := true
	falseVal := false
	runAsUser := NonRootUID
	runAsGroup := NonRootGID
	fsGroup := NonRootGID

	volumeClaim := corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:   VolumeDSHHome,
			Labels: labels,
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(cell.Spec.Storage.Size),
				},
			},
		},
	}
	if cell.Spec.Storage.StorageClassName != "" {
		className := cell.Spec.Storage.StorageClassName
		volumeClaim.Spec.StorageClassName = &className
	}

	container := corev1.Container{
		Name:            ContainerName,
		Image:           cell.Spec.Runtime.Image,
		ImagePullPolicy: corev1.PullPolicy(cell.Spec.ImagePullPolicyOrDefault()),
		Command:         cell.Spec.Runtime.Command,
		Args:            cell.Spec.Runtime.Args,
		Env: []corev1.EnvVar{
			{Name: EnvCellID, Value: cell.Name},
			{Name: EnvTenantID, Value: cell.Spec.TenantID},
			{Name: EnvDSHHome, Value: DSHHomePath},
			{Name: EnvDriverPort, Value: fmt.Sprintf("%d", driverPort)},
		},
		Ports: []corev1.ContainerPort{{
			Name:          DriverPortName,
			ContainerPort: driverPort,
			Protocol:      corev1.ProtocolTCP,
		}},
		VolumeMounts: []corev1.VolumeMount{
			{Name: VolumeDSHHome, MountPath: DSHHomePath},
			{Name: VolumeTemp, MountPath: TempPath},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &falseVal,
			ReadOnlyRootFilesystem:   &trueVal,
			RunAsNonRoot:             &trueVal,
			RunAsUser:                &runAsUser,
			RunAsGroup:               &runAsGroup,
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		// Probes use HTTP because the image intentionally contains no shell.
		ReadinessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path:   "/v1/ready",
					Port:   intstr.FromString(DriverPortName),
					Scheme: corev1.URISchemeHTTP,
				},
			},
			PeriodSeconds:    2,
			TimeoutSeconds:   2,
			FailureThreshold: 30,
		},
		LivenessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path:   "/v1/ready",
					Port:   intstr.FromString(DriverPortName),
					Scheme: corev1.URISchemeHTTP,
				},
			},
			// A stuck process holds the JSONL lock (plan §2.3); the liveness
			// probe is what eventually kills it. The generous threshold
			// keeps a slow-but-alive cell from being killed mid-turn.
			PeriodSeconds:    10,
			TimeoutSeconds:   3,
			FailureThreshold: 6,
		},
	}

	podSpec := corev1.PodSpec{
		// The cell never talks to the Kubernetes API, so it gets no token.
		AutomountServiceAccountToken: &falseVal,
		EnableServiceLinks:           &falseVal,
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   &trueVal,
			RunAsUser:      &runAsUser,
			RunAsGroup:     &runAsGroup,
			FSGroup:        &fsGroup,
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{container},
		Volumes: []corev1.Volume{{
			Name: VolumeTemp,
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{
					SizeLimit: quantityPtr("256Mi"),
				},
			},
		}},
	}
	// The per-tenant credential Secret is mounted read-only and with a
	// restrictive mode: the cell process is the only reader, and it is the
	// only tenant's secret in this pod.
	if cell.Spec.Runtime.CredentialsSecret != "" {
		mode := int32(0o400)
		podSpec.Volumes = append(podSpec.Volumes, corev1.Volume{
			Name: VolumeCredentials,
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName:  cell.Spec.Runtime.CredentialsSecret,
					DefaultMode: &mode,
					Optional:    boolPtr(false),
				},
			},
		})
		podSpec.Containers[0].VolumeMounts = append(podSpec.Containers[0].VolumeMounts, corev1.VolumeMount{
			Name:      VolumeCredentials,
			MountPath: CredentialsPath,
			ReadOnly:  true,
		})
	}
	if cell.Spec.Runtime.RuntimeClassName != nil && *cell.Spec.Runtime.RuntimeClassName != "" {
		podSpec.RuntimeClassName = cell.Spec.Runtime.RuntimeClassName
	}
	if len(cell.Spec.Runtime.NodeSelector) > 0 {
		podSpec.NodeSelector = cell.Spec.Runtime.NodeSelector
	}
	if len(cell.Spec.Runtime.Tolerations) > 0 {
		podSpec.Tolerations = cell.Spec.Runtime.Tolerations
	}
	if len(cell.Spec.Runtime.Resources.Requests) > 0 || len(cell.Spec.Runtime.Resources.Limits) > 0 {
		podSpec.Containers[0].Resources = cell.Spec.Runtime.Resources
	}

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      StatefulSetName(cell),
			Namespace: cell.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas:            &replicas,
			ServiceName:         ServiceName(cell),
			PodManagementPolicy: appsv1.ParallelPodManagement,
			Selector:            &metav1.LabelSelector{MatchLabels: selector},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec:       podSpec,
			},
			VolumeClaimTemplates: []corev1.PersistentVolumeClaim{volumeClaim},
			// Both retention modes are Retain: scaling to zero or deleting
			// the TenantCell must never delete the tenant's DSH_HOME.
			PersistentVolumeClaimRetentionPolicy: &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			},
			UpdateStrategy: appsv1.StatefulSetUpdateStrategy{
				Type: appsv1.RollingUpdateStatefulSetStrategyType,
			},
			RevisionHistoryLimit: int32Ptr(5),
		},
	}
}

// DriverEndpoint resolves the base URL of the driver for a cell pod. A
// spec-level driverBaseURL wins (used by tests and by deployments that front
// the driver with a Service or a mesh); otherwise the pod IP and the driver
// port are used directly.
func DriverEndpoint(cell *v1alpha1.TenantCell, podIP string) string {
	if base := cell.Spec.Runtime.DriverBaseURL; base != "" {
		return base
	}
	if podIP == "" {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", podIP, cell.Spec.DriverPortOrDefault())
}

func quantityPtr(s string) *resource.Quantity {
	q := resource.MustParse(s)
	return &q
}

func int32Ptr(v int32) *int32 { return &v }

// Int32Ptr is exported for tests and for callers that build specs.
func Int32Ptr(v int32) *int32 { return int32Ptr(v) }

// StringPtr returns a pointer to s; convenient for spec builders and tests.
func StringPtr(s string) *string { return &s }

func boolPtr(b bool) *bool { return &b }

// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package k8s_test

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
	"github.com/myrix/apps/cell-manager/internal/cell/k8s"
)

func testCell() *v1alpha1.TenantCell {
	return &v1alpha1.TenantCell{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "cell-t1",
			Namespace: "myrix-runtime",
			UID:       types.UID("11111111-1111-1111-1111-111111111111"),
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
			Storage: v1alpha1.StorageSpec{Size: "10Gi", StorageClassName: "fast-rwo"},
		},
	}
}

func TestSecurityBaseline(t *testing.T) {
	sts := k8s.StatefulSet(testCell(), 1)
	spec := sts.Spec.Template.Spec

	if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
		t.Fatal("automountServiceAccountToken must be false")
	}
	if spec.SecurityContext == nil || spec.SecurityContext.RunAsNonRoot == nil || !*spec.SecurityContext.RunAsNonRoot {
		t.Fatal("pod must run as non-root")
	}
	if spec.SecurityContext.SeccompProfile == nil || spec.SecurityContext.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatal("pod must use seccomp RuntimeDefault")
	}
	if len(spec.Containers) != 1 {
		t.Fatalf("containers = %d, want exactly 1", len(spec.Containers))
	}
	c := spec.Containers[0]
	sc := c.SecurityContext
	if sc == nil {
		t.Fatal("container has no security context")
	}
	if sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Fatal("container root filesystem must be read-only")
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Fatal("allowPrivilegeEscalation must be false")
	}
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatal("container must run as non-root")
	}
	if sc.RunAsUser == nil || *sc.RunAsUser == 0 {
		t.Fatal("container must not run as uid 0")
	}
	if sc.Capabilities == nil || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" {
		t.Fatalf("capabilities = %+v, want drop ALL and nothing added", sc.Capabilities)
	}
	if len(sc.Capabilities.Add) != 0 {
		t.Fatalf("capabilities must not be added: %+v", sc.Capabilities.Add)
	}
	if sc.Privileged != nil && *sc.Privileged {
		t.Fatal("container must not be privileged")
	}

	// Exactly two writable mounts: DSH_HOME and an ephemeral scratch dir.
	if len(c.VolumeMounts) != 2 {
		t.Fatalf("volume mounts = %+v, want DSH_HOME and tmp only", c.VolumeMounts)
	}
	mounts := map[string]string{}
	for _, m := range c.VolumeMounts {
		mounts[m.Name] = m.MountPath
	}
	if mounts[k8s.VolumeDSHHome] != k8s.DSHHomePath {
		t.Fatalf("DSH_HOME mount = %q, want %q", mounts[k8s.VolumeDSHHome], k8s.DSHHomePath)
	}
	if mounts[k8s.VolumeTemp] != k8s.TempPath {
		t.Fatalf("tmp mount = %q, want %q", mounts[k8s.VolumeTemp], k8s.TempPath)
	}

	// No host namespaces, no host paths.
	if spec.HostNetwork || spec.HostPID || spec.HostIPC {
		t.Fatal("cell pod must not use host namespaces")
	}
	for _, v := range spec.Volumes {
		if v.HostPath != nil {
			t.Fatalf("host path volume %q is not allowed", v.Name)
		}
	}
}

func TestReplicasAreClampedToZeroOrOne(t *testing.T) {
	for _, tc := range []struct{ in, want int32 }{{-3, 0}, {0, 0}, {1, 1}, {2, 1}, {99, 1}} {
		sts := k8s.StatefulSet(testCell(), tc.in)
		if sts.Spec.Replicas == nil || *sts.Spec.Replicas != tc.want {
			t.Fatalf("replicas(%d) = %v, want %d", tc.in, sts.Spec.Replicas, tc.want)
		}
	}
}

func TestPerTenantVolumeIsRWOPreservedAndNeverShared(t *testing.T) {
	cell := testCell()
	sts := k8s.StatefulSet(cell, 0)

	if len(sts.Spec.VolumeClaimTemplates) != 1 {
		t.Fatalf("volumeClaimTemplates = %d, want 1 per tenant", len(sts.Spec.VolumeClaimTemplates))
	}
	pvc := sts.Spec.VolumeClaimTemplates[0]
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		t.Fatalf("accessModes = %+v, want ReadWriteOnce", pvc.Spec.AccessModes)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != "fast-rwo" {
		t.Fatalf("storageClassName = %v, want fast-rwo", pvc.Spec.StorageClassName)
	}
	if got := pvc.Spec.Resources.Requests.Storage().String(); got != "10Gi" {
		t.Fatalf("storage request = %q, want 10Gi", got)
	}
	if pvc.Labels[v1alpha1.LabelTenant] != "t1" {
		t.Fatalf("PVC tenant label = %q", pvc.Labels[v1alpha1.LabelTenant])
	}
	if got := k8s.PVCName(cell); got != "dsh-home-cell-t1-0" {
		t.Fatalf("PVC name = %q", got)
	}
	if sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		t.Fatal("scaling must retain the PVC")
	}
	if sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		t.Fatal("deleting the cell must retain the PVC")
	}
}

func TestServiceSelectsOnlyOneCell(t *testing.T) {
	t1 := testCell()
	t2 := testCell()
	t2.Name = "cell-t2"
	t2.Labels[v1alpha1.LabelCell] = "cell-t2"
	t2.Spec.TenantID = "t2"
	t2.Labels[v1alpha1.LabelTenant] = "t2"

	svc1 := k8s.Service(t1)
	svc2 := k8s.Service(t2)
	if svc1.Spec.Selector[v1alpha1.LabelCell] == svc2.Spec.Selector[v1alpha1.LabelCell] {
		t.Fatal("two cells share a service selector")
	}
	if svc1.Spec.ClusterIP != corev1.ClusterIPNone {
		t.Fatal("driver service must be headless")
	}
	if svc1.Spec.Selector[v1alpha1.LabelCell] != t1.Name {
		t.Fatalf("selector = %+v", svc1.Spec.Selector)
	}
	// The tenant label is not part of the selector: it is mutable metadata,
	// and selectors are immutable.
	if _, ok := svc1.Spec.Selector[v1alpha1.LabelTenant]; ok {
		t.Fatal("tenant label must not be a service selector")
	}
}

func TestPodTemplateLabelsAreImmutableSelectorSafe(t *testing.T) {
	cell := testCell()
	sts := k8s.StatefulSet(cell, 1)
	for k, v := range sts.Spec.Selector.MatchLabels {
		if sts.Spec.Template.Labels[k] != v {
			t.Fatalf("selector %s=%s not present on the pod template", k, v)
		}
	}
	if sts.Spec.ServiceName != k8s.ServiceName(cell) {
		t.Fatalf("serviceName = %q, want %q", sts.Spec.ServiceName, k8s.ServiceName(cell))
	}
}

func TestEnvPinsCellIdentity(t *testing.T) {
	cell := testCell()
	sts := k8s.StatefulSet(cell, 1)
	env := map[string]string{}
	for _, e := range sts.Spec.Template.Spec.Containers[0].Env {
		env[e.Name] = e.Value
	}
	if env[k8s.EnvCellID] != "cell-t1" {
		t.Fatalf("%s = %q", k8s.EnvCellID, env[k8s.EnvCellID])
	}
	if env[k8s.EnvTenantID] != "t1" {
		t.Fatalf("%s = %q", k8s.EnvTenantID, env[k8s.EnvTenantID])
	}
	if env[k8s.EnvDSHHome] != k8s.DSHHomePath {
		t.Fatalf("%s = %q", k8s.EnvDSHHome, env[k8s.EnvDSHHome])
	}
}

func TestProbesUseHTTPNotShell(t *testing.T) {
	sts := k8s.StatefulSet(testCell(), 1)
	c := sts.Spec.Template.Spec.Containers[0]
	if c.ReadinessProbe == nil || c.ReadinessProbe.HTTPGet == nil {
		t.Fatal("readiness probe must be an HTTP GET (the image has no shell)")
	}
	if c.ReadinessProbe.HTTPGet.Path != "/v1/ready" {
		t.Fatalf("readiness path = %q, want /v1/ready", c.ReadinessProbe.HTTPGet.Path)
	}
	if c.LivenessProbe == nil || c.LivenessProbe.HTTPGet == nil {
		t.Fatal("liveness probe must be an HTTP GET")
	}
	if c.ReadinessProbe.Exec != nil || c.LivenessProbe.Exec != nil {
		t.Fatal("probes must not exec into the container")
	}
}

func TestDriverEndpointResolution(t *testing.T) {
	cell := testCell()
	if got := k8s.DriverEndpoint(cell, "10.0.0.7"); got != "http://10.0.0.7:8404" {
		t.Fatalf("endpoint = %q", got)
	}
	if got := k8s.DriverEndpoint(cell, ""); got != "" {
		t.Fatalf("endpoint with no pod IP = %q, want empty", got)
	}
	custom := testCell()
	custom.Spec.Runtime.DriverBaseURL = "https://cell-t1-driver.myrix-runtime.svc:8443/"
	custom.Spec.Runtime.DriverPort = k8s.Int32Ptr(9999)
	if got := k8s.DriverEndpoint(custom, "10.0.0.7"); got != "https://cell-t1-driver.myrix-runtime.svc:8443/" {
		t.Fatalf("explicit endpoint = %q", got)
	}
}

func TestRuntimeOverridesAreHonoured(t *testing.T) {
	cell := testCell()
	cell.Spec.Runtime.Command = []string{"/usr/local/bin/dsh"}
	cell.Spec.Runtime.Args = []string{"serve", "--profile", "myrix-base"}
	cell.Spec.Runtime.ImagePullPolicy = "Never"
	cell.Spec.Runtime.NodeSelector = map[string]string{"myrix.io/pool": "dedicated"}
	cell.Spec.Runtime.RuntimeClassName = k8s.StringPtr("gvisor")

	sts := k8s.StatefulSet(cell, 1)
	c := sts.Spec.Template.Spec.Containers[0]
	if len(c.Command) != 1 || c.Command[0] != "/usr/local/bin/dsh" {
		t.Fatalf("command = %+v", c.Command)
	}
	if len(c.Args) != 3 || c.Args[2] != "myrix-base" {
		t.Fatalf("args = %+v", c.Args)
	}
	if c.ImagePullPolicy != corev1.PullNever {
		t.Fatalf("imagePullPolicy = %q", c.ImagePullPolicy)
	}
	if sts.Spec.Template.Spec.NodeSelector["myrix.io/pool"] != "dedicated" {
		t.Fatalf("nodeSelector = %+v", sts.Spec.Template.Spec.NodeSelector)
	}
	if sts.Spec.Template.Spec.RuntimeClassName == nil || *sts.Spec.Template.Spec.RuntimeClassName != "gvisor" {
		t.Fatalf("runtimeClassName = %v", sts.Spec.Template.Spec.RuntimeClassName)
	}
}

func TestEveryManagedObjectCarriesTenantLabel(t *testing.T) {
	cell := testCell()
	sts := k8s.StatefulSet(cell, 1)
	svc := k8s.Service(cell)
	for name, labels := range map[string]map[string]string{
		"statefulset":       sts.Labels,
		"pod template":      sts.Spec.Template.Labels,
		"volume claim tmpl": sts.Spec.VolumeClaimTemplates[0].Labels,
		"service":           svc.Labels,
	} {
		if labels[v1alpha1.LabelTenant] != cell.Spec.TenantID {
			t.Fatalf("%s tenant label = %q, want %q", name, labels[v1alpha1.LabelTenant], cell.Spec.TenantID)
		}
		if labels[v1alpha1.LabelManagedBy] != v1alpha1.ManagedByValue {
			t.Fatalf("%s managed-by label = %q", name, labels[v1alpha1.LabelManagedBy])
		}
	}
}

func TestPerTenantSecretIsMountedReadOnly(t *testing.T) {
	cell := testCell()
	cell.Spec.Runtime.CredentialsSecret = "cell-t1-credentials"
	sts := k8s.StatefulSet(cell, 1)
	pod := sts.Spec.Template.Spec

	var secretVolume *corev1.Volume
	for i := range pod.Volumes {
		if pod.Volumes[i].Name == k8s.VolumeCredentials {
			secretVolume = &pod.Volumes[i]
		}
	}
	if secretVolume == nil || secretVolume.Secret == nil {
		t.Fatal("credentials secret volume is missing")
	}
	if secretVolume.Secret.SecretName != "cell-t1-credentials" {
		t.Fatalf("secret name = %q", secretVolume.Secret.SecretName)
	}
	if secretVolume.Secret.DefaultMode == nil || *secretVolume.Secret.DefaultMode != 0o400 {
		t.Fatalf("secret mode = %v, want 0400", secretVolume.Secret.DefaultMode)
	}
	if secretVolume.Secret.Optional == nil || *secretVolume.Secret.Optional {
		t.Fatal("credentials secret must not be optional")
	}

	var mount *corev1.VolumeMount
	for i := range pod.Containers[0].VolumeMounts {
		if pod.Containers[0].VolumeMounts[i].Name == k8s.VolumeCredentials {
			mount = &pod.Containers[0].VolumeMounts[i]
		}
	}
	if mount == nil || !mount.ReadOnly {
		t.Fatal("credentials must be mounted read-only")
	}
	if mount.MountPath != k8s.CredentialsPath {
		t.Fatalf("mount path = %q", mount.MountPath)
	}
}

func TestNoCredentialsSecretMeansNoMount(t *testing.T) {
	sts := k8s.StatefulSet(testCell(), 1)
	for _, v := range sts.Spec.Template.Spec.Volumes {
		if v.Secret != nil {
			t.Fatalf("unexpected secret volume %q", v.Name)
		}
	}
	if len(sts.Spec.Template.Spec.Containers[0].VolumeMounts) != 2 {
		t.Fatalf("mounts = %+v, want only DSH_HOME and tmp", sts.Spec.Template.Spec.Containers[0].VolumeMounts)
	}
}

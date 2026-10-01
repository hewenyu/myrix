// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package chart tests the Myrix Helm chart by rendering it with the Helm Go
// SDK. It runs as a plain `go test`, so it needs neither a cluster nor the
// helm binary; it does need the chart on disk, which is why it lives in this
// repository and not in a published module.
package chart_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/chartutil"
	"helm.sh/helm/v3/pkg/engine"
	"sigs.k8s.io/yaml"
)

const (
	releaseName      = "myrix"
	managerImageRepo = "registry.example.com/myrix/cell-manager"
)

// chartPath locates deploy/helm/myrix. It starts from MYRIX_REPO_ROOT when
// set, otherwise it walks up from the test working directory, so the test
// keeps working if the module is vendored elsewhere.
func chartPath(t *testing.T) string {
	t.Helper()
	rel := filepath.Join("deploy", "helm", "myrix")
	if root := os.Getenv("MYRIX_REPO_ROOT"); root != "" {
		path := filepath.Join(root, rel)
		if _, err := os.Stat(filepath.Join(path, "Chart.yaml")); err != nil {
			t.Fatalf("MYRIX_REPO_ROOT=%s does not contain %s: %v", root, rel, err)
		}
		return path
	}
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(dir, rel)
		if _, err := os.Stat(filepath.Join(candidate, "Chart.yaml")); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find %s above the test working directory; set MYRIX_REPO_ROOT", rel)
		}
		dir = parent
	}
}

// render runs the chart templates the same way `helm template` does.
func render(t *testing.T, values map[string]any) (map[string]string, error) {
	t.Helper()
	c, err := loader.Load(chartPath(t))
	if err != nil {
		t.Fatalf("load chart: %v", err)
	}
	merged := map[string]any{
		"cellManager": map[string]any{
			"image": map[string]any{"repository": managerImageRepo},
		},
	}
	for k, v := range values {
		if sub, ok := merged[k].(map[string]any); ok {
			if incoming, ok := v.(map[string]any); ok {
				for kk, vv := range incoming {
					sub[kk] = vv
				}
				continue
			}
		}
		merged[k] = v
	}
	opts := chartutil.ReleaseOptions{Name: releaseName, Namespace: "default", Revision: 1, IsInstall: true}
	caps := chartutil.DefaultCapabilities.Copy()
	caps.KubeVersion = chartutil.KubeVersion{Version: "v1.29.0", Major: "1", Minor: "29"}
	cfg, err := chartutil.ToRenderValuesWithSchemaValidation(c, merged, opts, caps, false)
	if err != nil {
		return nil, err
	}
	out, err := engine.Render(c, cfg)
	if err != nil {
		return nil, err
	}
	// engine.Render emits one pseudo-file per template plus NOTES.txt; drop
	// empties so assertions only look at delivered objects.
	for k, v := range out {
		if strings.TrimSpace(v) == "" {
			delete(out, k)
		}
	}
	return out, nil
}

func mustRender(t *testing.T, values map[string]any) map[string]string {
	t.Helper()
	out, err := render(t, values)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return out
}

// docs expands a rendered stream into typed documents.
func docs(t *testing.T, rendered map[string]string) []map[string]any {
	t.Helper()
	var all []map[string]any
	for name, body := range rendered {
		for _, part := range strings.Split(body, "\n---") {
			if strings.TrimSpace(part) == "" {
				continue
			}
			// Strip leading comment-only lines that precede the document.
			lines := strings.Split(part, "\n")
			for i, l := range lines {
				if strings.HasPrefix(strings.TrimSpace(l), "#") || strings.TrimSpace(l) == "" {
					continue
				}
				lines = lines[i:]
				break
			}
			part = strings.Join(lines, "\n")
			if !strings.Contains(part, "apiVersion:") {
				continue
			}
			var doc map[string]any
			if err := yaml.Unmarshal([]byte(part), &doc); err != nil {
				t.Fatalf("%s: invalid YAML: %v\n%s", name, err, part)
			}
			if len(doc) == 0 {
				continue
			}
			doc["__source"] = name
			all = append(all, doc)
		}
	}
	return all
}

func byKind(documents []map[string]any, kind string) []map[string]any {
	var out []map[string]any
	for _, d := range documents {
		if d["kind"] == kind {
			out = append(out, d)
		}
	}
	return out
}

func dig(t *testing.T, m map[string]any, path ...string) any {
	t.Helper()
	var cur any = m
	for _, p := range path {
		asMap, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = asMap[p]
	}
	return cur
}

// --- rendering ------------------------------------------------------------

func TestChartRendersBothProfiles(t *testing.T) {
	profiles := []string{"values-saas.yaml", "values-private.yaml"}
	for _, profile := range profiles {
		t.Run(profile, func(t *testing.T) {
			path := filepath.Join(chartPath(t), profile)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", profile, err)
			}
			var values map[string]any
			if err := yaml.Unmarshal(raw, &values); err != nil {
				t.Fatalf("parse %s: %v", profile, err)
			}
			// The private profile ships an empty cell image placeholder.
			if tenantCells, ok := values["tenantCells"].(map[string]any); ok {
				for _, v := range tenantCells {
					if cell, ok := v.(map[string]any); ok {
						if runtime, ok := cell["runtime"].(map[string]any); ok && runtime["image"] == "" {
							runtime["image"] = "registry.example.com/myrix/runtime:0.1.0-dev"
						}
					}
				}
			}
			out := mustRender(t, values)
			if len(docs(t, out)) == 0 {
				t.Fatal("chart rendered no objects")
			}
		})
	}
}

// --- the chart must refuse unsafe configurations --------------------------

func TestChartRefusesUnsafeValues(t *testing.T) {
	cases := []struct {
		name    string
		values  map[string]any
		wantErr string
	}{
		{
			name:    "no manager image",
			values:  map[string]any{"cellManager": map[string]any{"image": map[string]any{"repository": ""}}},
			wantErr: "cellManager.image.repository is required",
		},
		{
			name: "inline token in a private deployment",
			values: map[string]any{
				"profile":     "private",
				"cellManager": map[string]any{"internal": map[string]any{"token": "oops"}},
			},
			wantErr: "must not be set with profile=private",
		},
		{
			name: "replicas without leader election",
			values: map[string]any{
				"cellManager": map[string]any{"replicaCount": 3, "leaderElection": false},
			},
			wantErr: "leaderElection must be true",
		},
		{
			name: "default-deny policy with no allowed peer",
			values: map[string]any{
				"networkPolicy": map[string]any{"runtime": map[string]any{"bff": map[string]any{"namespace": ""}}},
			},
			wantErr: "networkPolicy.runtime.bff.namespace is required",
		},
		{
			name: "invalid tier",
			values: map[string]any{
				"tenantCells": map[string]any{"c1": map[string]any{"tier": "platinum", "runtime": map[string]any{"image": "x"}}},
			},
			wantErr: "tier must be shared or dedicated",
		},
		{
			name: "cell without an image",
			values: map[string]any{
				"tenantCells": map[string]any{"c1": map[string]any{"runtime": map[string]any{"image": ""}}},
			},
			wantErr: "runtime.image is required",
		},
		{
			name: "dedicated cell asked to stop",
			values: map[string]any{
				"tenantCells": map[string]any{"c1": map[string]any{
					"tier": "dedicated", "wantRunning": false, "runtime": map[string]any{"image": "x"},
				}},
			},
			wantErr: "must be resident",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := render(t, tc.values)
			if err == nil {
				t.Fatalf("chart rendered without error, want %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

// --- authorisation scope --------------------------------------------------

func TestNoClusterScopedRBAC(t *testing.T) {
	out := mustRender(t, nil)
	for _, d := range docs(t, out) {
		switch d["kind"] {
		case "ClusterRole", "ClusterRoleBinding":
			t.Fatalf("chart grants cluster-scoped RBAC (%s): %v", d["kind"], d["metadata"])
		}
	}
}

func TestRBACIsNamespaceScopedAndNarrow(t *testing.T) {
	out := mustRender(t, nil)
	documents := docs(t, out)
	roles := byKind(documents, "Role")
	if len(roles) == 0 {
		t.Fatal("no Role rendered")
	}

	var runtimeRole map[string]any
	for _, role := range roles {
		ns := dig(t, role, "metadata", "namespace")
		if ns == "myrix-runtime" {
			runtimeRole = role
		}
	}
	if runtimeRole == nil {
		t.Fatal("no Role rendered in the runtime namespace")
	}

	rules, ok := runtimeRole["rules"].([]any)
	if !ok || len(rules) == 0 {
		t.Fatalf("runtime Role has no rules: %v", runtimeRole)
	}
	for _, r := range rules {
		rule := r.(map[string]any)
		verbs := toStrings(rule["verbs"])
		resources := toStrings(rule["resources"])
		for _, v := range verbs {
			if v == "*" {
				t.Fatalf("wildcard verb granted: %v", rule)
			}
		}
		for _, res := range resources {
			if res == "*" {
				t.Fatalf("wildcard resource granted: %v", rule)
			}
		}
		// PVCs and Secrets must never be writable: the PVC holds the tenant's
		// DSH_HOME and the Secret holds the tenant's credential.
		if contains(resources, "persistentvolumeclaims") || contains(resources, "secrets") {
			for _, v := range verbs {
				switch v {
				case "get", "list", "watch":
				default:
					t.Fatalf("%s grants %q, which could destroy tenant data or leak credentials: %v", resources, v, rule)
				}
			}
		}
		// No cluster-scoped resources of any kind.
		for _, res := range resources {
			switch res {
			case "nodes", "namespaces", "persistentvolumes", "clusterroles", "clusterrolebindings":
				t.Fatalf("cluster-scoped resource granted: %v", rule)
			}
		}
	}
}

func TestServiceAccountTokenOnlyWhereNeeded(t *testing.T) {
	out := mustRender(t, nil)
	dep := byKind(docs(t, out), "Deployment")
	if len(dep) != 1 {
		t.Fatalf("expected one Deployment, got %d", len(dep))
	}
	// The manager talks to the API server, so it needs its token. The cells
	// are built by the Go controller and must not have one; that assertion
	// lives in internal/cell/k8s/objects_test.go.
	if got := dig(t, dep[0], "spec", "template", "spec", "automountServiceAccountToken"); got != true {
		t.Fatalf("manager automountServiceAccountToken = %v, want true", got)
	}
}

// --- network policy baseline ---------------------------------------------

func TestRuntimeNetworkPolicyDefaultsToDeny(t *testing.T) {
	out := mustRender(t, nil)
	var defaultDeny map[string]any
	for _, np := range byKind(docs(t, out), "NetworkPolicy") {
		if dig(t, np, "metadata", "namespace") != "myrix-runtime" {
			continue
		}
		if strings.Contains(dig(t, np, "metadata", "name").(string), "default-deny") {
			defaultDeny = np
		}
	}
	if defaultDeny == nil {
		t.Fatal("runtime namespace has no default-deny NetworkPolicy")
	}
	selector := dig(t, defaultDeny, "spec", "podSelector")
	if selector == nil || len(selector.(map[string]any)) != 0 {
		t.Fatalf("default-deny podSelector = %v, want {} so new cells inherit the deny", selector)
	}
	types := toStrings(dig(t, defaultDeny, "spec", "policyTypes"))
	if !contains(types, "Ingress") || !contains(types, "Egress") {
		t.Fatalf("default-deny policyTypes = %v, want both directions", types)
	}
}

func TestRuntimeEgressOnlyReachesGatewayAndWorks(t *testing.T) {
	out := mustRender(t, nil)
	allowedNamespaces := map[string]bool{}
	for _, np := range byKind(docs(t, out), "NetworkPolicy") {
		if dig(t, np, "metadata", "namespace") != "myrix-runtime" {
			continue
		}
		name := dig(t, np, "metadata", "name").(string)
		if !strings.Contains(name, "egress") {
			continue
		}
		egress, _ := dig(t, np, "spec", "egress").([]any)
		if len(egress) == 0 {
			t.Fatal("egress policy allows nothing")
		}
		for _, rule := range egress {
			for _, peer := range toStringsOfMaps(dig(t, rule.(map[string]any), "to")) {
				if ipBlock, ok := peer["ipBlock"]; ok {
					block := ipBlock.(map[string]any)["cidr"]
					if block == "0.0.0.0/0" || block == "::/0" {
						t.Fatalf("egress to the whole internet is allowed: %v", block)
					}
				}
				if nsSelector, ok := peer["namespaceSelector"].(map[string]any); ok {
					labels, _ := nsSelector["matchLabels"].(map[string]any)
					allowedNamespaces[labels["kubernetes.io/metadata.name"].(string)] = true
				}
			}
		}
	}
	if len(allowedNamespaces) == 0 {
		t.Fatal("no egress peers resolved")
	}
	for ns := range allowedNamespaces {
		switch ns {
		case "myrix-gateway", "myrix-works", "kube-system":
		default:
			t.Fatalf("egress to unexpected namespace %q", ns)
		}
	}
	if !allowedNamespaces["myrix-gateway"] || !allowedNamespaces["myrix-works"] {
		t.Fatalf("egress must reach the gateway and works service, got %v", allowedNamespaces)
	}
}

func TestRuntimeIngressOnlyFromBFF(t *testing.T) {
	out := mustRender(t, nil)
	for _, np := range byKind(docs(t, out), "NetworkPolicy") {
		if dig(t, np, "metadata", "namespace") != "myrix-runtime" {
			continue
		}
		name := dig(t, np, "metadata", "name").(string)
		if !strings.Contains(name, "ingress") {
			continue
		}
		ingress, _ := dig(t, np, "spec", "ingress").([]any)
		if len(ingress) != 1 {
			t.Fatalf("ingress rules = %d, want exactly 1 (from the BFF)", len(ingress))
		}
		for _, peer := range toStringsOfMaps(dig(t, ingress[0].(map[string]any), "from")) {
			nsSelector, ok := peer["namespaceSelector"].(map[string]any)
			if !ok {
				t.Fatalf("ingress peer is not a namespace selector: %v", peer)
			}
			labels, _ := nsSelector["matchLabels"].(map[string]any)
			if labels["kubernetes.io/metadata.name"] != "myrix-system" {
				t.Fatalf("ingress allowed from %v, want only the BFF namespace", labels)
			}
		}
	}
}

// --- deployment security baseline ----------------------------------------

func TestManagerSecurityBaseline(t *testing.T) {
	out := mustRender(t, nil)
	dep := byKind(docs(t, out), "Deployment")[0]
	podSpec := dig(t, dep, "spec", "template", "spec").(map[string]any)
	containers := podSpec["containers"].([]any)
	if len(containers) != 1 {
		t.Fatalf("containers = %d, want 1", len(containers))
	}
	c := containers[0].(map[string]any)
	sc := c["securityContext"].(map[string]any)

	if sc["allowPrivilegeEscalation"] != false {
		t.Fatal("allowPrivilegeEscalation must be false")
	}
	if sc["readOnlyRootFilesystem"] != true {
		t.Fatal("readOnlyRootFilesystem must be true")
	}
	if sc["runAsNonRoot"] != true {
		t.Fatal("runAsNonRoot must be true")
	}
	if sc["runAsUser"] == float64(0) {
		t.Fatal("must not run as uid 0")
	}
	caps := sc["capabilities"].(map[string]any)
	if !contains(toStrings(caps["drop"]), "ALL") {
		t.Fatalf("capabilities.drop = %v, want ALL", caps["drop"])
	}
	if _, ok := caps["add"]; ok {
		t.Fatalf("capabilities.add must be empty, got %v", caps["add"])
	}
	seccomp := sc["seccompProfile"].(map[string]any)
	if seccomp["type"] != "RuntimeDefault" {
		t.Fatalf("seccompProfile = %v, want RuntimeDefault", seccomp)
	}

	// The manager only needs a scratch dir; nothing else may be writable.
	var mounts []string
	for _, m := range c["volumeMounts"].([]any) {
		mounts = append(mounts, m.(map[string]any)["mountPath"].(string))
	}
	for _, m := range mounts {
		switch m {
		case "/tmp", "/etc/myrix":
		default:
			t.Fatalf("unexpected volume mount %q on the manager", m)
		}
	}
}

func TestLeaderElectionIsWired(t *testing.T) {
	out := mustRender(t, nil)
	dep := byKind(docs(t, out), "Deployment")[0]
	args := toStrings(dig(t, dep, "spec", "template", "spec", "containers").([]any)[0].(map[string]any)["args"])
	if !contains(args, "--leader-elect=true") {
		t.Fatalf("args = %v, want --leader-elect=true", args)
	}
	if !contains(args, "--runtime-namespace=myrix-runtime") {
		t.Fatalf("args = %v, want the runtime namespace pinned", args)
	}
}

// --- CRD ------------------------------------------------------------------

func TestCRDIsShippedAndOwnsLifecycleOnly(t *testing.T) {
	path := filepath.Join(chartPath(t), "crds", "tenantcell-crd.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("CRD not shipped with the chart: %v", err)
	}
	var crd map[string]any
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		t.Fatalf("CRD is not valid YAML: %v", err)
	}
	if crd["kind"] != "CustomResourceDefinition" {
		t.Fatalf("kind = %v", crd["kind"])
	}
	if dig(t, crd, "spec", "group") != "myrix.io" {
		t.Fatalf("group = %v", dig(t, crd, "spec", "group"))
	}
	if dig(t, crd, "spec", "scope") != "Namespaced" {
		t.Fatal("TenantCell must be namespaced: one runtime namespace holds the cells")
	}

	// The spec must not contain business bindings: the CRD owns lifecycle.
	specProps := dig(t, crd, "spec", "versions").([]any)[0].(map[string]any)
	schema := dig(t, specProps, "schema", "openAPIV3Schema", "properties", "spec", "properties").(map[string]any)
	for _, forbidden := range []string{"sessions", "bindings", "ownerUserId", "workId", "members", "grants"} {
		if _, ok := schema[forbidden]; ok {
			t.Fatalf("TenantCell spec contains business field %q; bindings belong to the control plane", forbidden)
		}
	}
	for _, required := range []string{"tenantId", "tier", "wantRunning", "runtime", "storage"} {
		if _, ok := schema[required]; !ok {
			t.Fatalf("TenantCell spec is missing %q", required)
		}
	}

	// Status must expose the lifecycle observations the router and the
	// control plane rely on.
	statusSchema := dig(t, specProps, "schema", "openAPIV3Schema", "properties", "status", "properties").(map[string]any)
	for _, required := range []string{"phase", "observedGeneration", "bootId", "conditions"} {
		if _, ok := statusSchema[required]; !ok {
			t.Fatalf("TenantCell status is missing %q", required)
		}
	}
	if _, ok := specProps["subresources"].(map[string]any)["status"]; !ok {
		t.Fatal("TenantCell must expose the status subresource")
	}
}

func TestContractConfigMapDocumentsTheRealDriverPaths(t *testing.T) {
	out := mustRender(t, nil)
	cms := byKind(docs(t, out), "ConfigMap")
	if len(cms) == 0 {
		t.Fatal("no contract ConfigMap rendered")
	}
	body, _ := dig(t, cms[0], "data", "contract.yaml").(string)
	for _, want := range []string{"/v1/ready", "/v1/admin/drain", "/v1/admin/idle", "POST /internal/v1/cells/{cell}/want-running", "replicas are 0/1 only"} {
		if !strings.Contains(body, want) {
			t.Fatalf("contract ConfigMap does not document %q:\n%s", want, body)
		}
	}
}

// --- helpers --------------------------------------------------------------

func toStrings(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func toStringsOfMaps(v any) []map[string]any {
	list, _ := v.([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

var _ = chart.Chart{}

{{/* Copyright 2026 The Myrix Authors */}}
{{/* SPDX-License-Identifier: Apache-2.0 */}}
{{- /*
Guardrails that run on every render. They encode rules that are easy to break
by editing values and expensive to break in production:
  1. An empty image reference that would silently pull `library/nothing`.
  2. A plaintext internal token in a private (production) deployment.
  3. A multi-replica manager without leader election.
  4. Default-deny NetworkPolicy with no allowed peer, which locks the platform
     out entirely.
  5. A dedicated cell asked to stop, which contradicts "dedicated is resident".

Included from cell-contract.yaml so it runs once per render.
*/ -}}
{{- define "myrix.validate" -}}
{{- if not .Values.cellManager.image.repository -}}
{{- fail "cellManager.image.repository is required: this chart ships no default image" -}}
{{- end -}}
{{- if not .Values.runtime.namespace -}}
{{- fail "runtime.namespace is required" -}}
{{- end -}}
{{- if and (eq .Values.profile "private") .Values.cellManager.internal.token -}}
{{- fail "cellManager.internal.token must not be set with profile=private: provide cellManager.internal.existingSecret instead" -}}
{{- end -}}
{{- if and .Values.cellManager.internal.enabled (not (or .Values.cellManager.internal.existingSecret .Values.cellManager.internal.token)) -}}
{{- /* A random token is generated and preserved by lookup; nothing to fail. */ -}}
{{- end -}}
{{- if and (gt (int .Values.cellManager.replicaCount) 1) (not .Values.cellManager.leaderElection) -}}
{{- fail "cellManager.leaderElection must be true when replicaCount > 1, otherwise two replicas can scale the same cell twice" -}}
{{- end -}}
{{- if and .Values.networkPolicy.enabled (not .Values.networkPolicy.runtime.bff.namespace) -}}
{{- fail "networkPolicy.runtime.bff.namespace is required: without it the default-deny policy would block the router" -}}
{{- end -}}
{{- if and .Values.cellManager.tls.enabled .Values.cellManager.tls.certManager.enabled (not .Values.cellManager.tls.certManager.issuerRef.name) -}}
{{- fail "cellManager.tls.certManager.issuerRef.name is required when cert-manager issuance is enabled" -}}
{{- end -}}
{{- $tiers := dict "shared" true "dedicated" true -}}
{{- range $name, $cell := .Values.tenantCells -}}
{{- $tier := default $.Values.cellDefaults.tier $cell.tier -}}
{{- if not (hasKey $tiers $tier) -}}
{{- fail (printf "tenantCells.%s.tier must be shared or dedicated" $name) -}}
{{- end -}}
{{- if and $cell.runtime (not $cell.runtime.image) -}}
{{- fail (printf "tenantCells.%s.runtime.image is required: no cell image is published by this repository" $name) -}}
{{- end -}}
{{- if and (eq $tier "dedicated") (hasKey $cell "wantRunning") (not $cell.wantRunning) -}}
{{- fail (printf "tenantCells.%s is dedicated and must be resident; wantRunning=false is not a valid way to stop it" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

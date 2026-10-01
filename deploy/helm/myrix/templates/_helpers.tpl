{{/* Copyright 2026 The Myrix Authors */}}
{{/* SPDX-License-Identifier: Apache-2.0 */}}

{{- define "myrix.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "myrix.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "myrix.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels shared by every object in the release. */}}
{{- define "myrix.labels" -}}
helm.sh/chart: {{ include "myrix.chart" . }}
app.kubernetes.io/name: {{ include "myrix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: myrix
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "myrix.cellManager.labels" -}}
{{ include "myrix.labels" . }}
app.kubernetes.io/component: cell-manager
{{- end -}}

{{- define "myrix.cellManager.selectorLabels" -}}
app.kubernetes.io/name: {{ include "myrix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: cell-manager
{{- end -}}

{{- define "myrix.cellManager.serviceAccountName" -}}
{{- if .Values.cellManager.serviceAccount.create -}}
{{- default (printf "%s-cell-manager" (include "myrix.fullname" .)) .Values.cellManager.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.cellManager.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The container image. Fails loudly when the operator has not supplied one:
     this repository does not publish a runtime or manager image. */}}
{{- define "myrix.cellManager.image" -}}
{{- $repo := required "cellManager.image.repository is required: the Cell Manager image is operator-supplied and not published by this repository" .Values.cellManager.image.repository -}}
{{- $tag := default .Chart.AppVersion .Values.cellManager.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

{{- define "myrix.runtime.namespace" -}}
{{- required "runtime.namespace is required" .Values.runtime.namespace -}}
{{- end -}}

{{- define "myrix.internal.enabled" -}}
{{- if .Values.cellManager.internal.enabled -}}true{{- else -}}false{{- end -}}
{{- end -}}

{{/* Name of the Secret holding the internal API bearer token. */}}
{{- define "myrix.internal.secretName" -}}
{{- if .Values.cellManager.internal.existingSecret -}}
{{- .Values.cellManager.internal.existingSecret -}}
{{- else -}}
{{- printf "%s-internal-token" (include "myrix.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "myrix.cellManager.internalSecretKey" -}}
{{- default "token" .Values.cellManager.internal.secretKey -}}
{{- end -}}

{{- define "myrix.contractConfigMapName" -}}
{{- default (printf "%s-cell-contract" (include "myrix.fullname" .)) .Values.cellDefaults.contractConfigMap.name -}}
{{- end -}}

{{- define "myrix.cellManager.tlsSecretName" -}}
{{- if .Values.cellManager.tls.secretName -}}
{{- .Values.cellManager.tls.secretName -}}
{{- else -}}
{{- printf "%s-internal-tls" (include "myrix.fullname" .) -}}
{{- end -}}
{{- end -}}

// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Package apiserver exposes the Cell Manager's internal control surface. It is
// not a public API: it is reachable only from the session router inside the
// cluster, is protected by a shared bearer token, and can do exactly one
// thing - flip spec.wantRunning on a cell.
package apiserver

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/myrix/apps/cell-manager/internal/controller"
)

// Server is the internal HTTP surface.
type Server struct {
	// Namespace is the only namespace this surface may act on.
	Namespace string
	// Token is the shared bearer token. An empty token disables the server:
	// fail closed rather than expose an unauthenticated write path.
	Token string
	// Cells is the wantRunning setter, normally backed by the manager's
	// service account.
	Cells controller.WantRunningSetter
}

// Handler builds the http.Handler. Returns nil when the server is not
// configured, so callers can skip starting it.
func (s *Server) Handler() http.Handler {
	if s.Token == "" || s.Cells == nil {
		return nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/v1/cells/", s.handleCell)
	return mux
}

type wantRunningRequest struct {
	WantRunning *bool `json:"wantRunning"`
}

type errorBody struct {
	Error  string `json:"error"`
	Reason string `json:"reason"`
}

// handleCell serves POST /internal/v1/cells/{cell}/want-running.
func (s *Server) handleCell(w http.ResponseWriter, r *http.Request) {
	if !s.authorised(r) {
		writeJSON(w, http.StatusUnauthorized, errorBody{Error: "unauthorized", Reason: "missing or invalid internal token"})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/internal/v1/cells/")
	cellName, action, ok := strings.Cut(path, "/")
	if !ok || cellName == "" || action != "want-running" {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "not_found", Reason: "unknown path"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, errorBody{Error: "method_not_allowed", Reason: "use POST"})
		return
	}
	var body wantRunningRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid_request", Reason: "body must be {\"wantRunning\": bool}"})
		return
	}
	if body.WantRunning == nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid_request", Reason: "wantRunning is required"})
		return
	}
	if err := s.Cells.SetWantRunning(r.Context(), s.Namespace, cellName, *body.WantRunning); err != nil {
		writeJSON(w, http.StatusConflict, errorBody{Error: "write_failed", Reason: err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"cell": cellName, "wantRunning": *body.WantRunning})
}

func (s *Server) authorised(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	presented := strings.TrimPrefix(header, prefix)
	if len(presented) != len(s.Token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(s.Token)) == 1
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

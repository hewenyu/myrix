// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package apiserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/myrix/apps/cell-manager/internal/apiserver"
)

type recordingSetter struct {
	namespace string
	cell      string
	want      bool
	calls     int
	err       error
}

func (s *recordingSetter) SetWantRunning(_ context.Context, namespace, cell string, want bool) error {
	s.calls++
	s.namespace, s.cell, s.want = namespace, cell, want
	return s.err
}

func TestDisabledWithoutToken(t *testing.T) {
	s := &apiserver.Server{Namespace: "myrix-runtime", Cells: &recordingSetter{}}
	if h := s.Handler(); h != nil {
		t.Fatal("server must not start without a token")
	}
	s2 := &apiserver.Server{Namespace: "myrix-runtime", Token: "t"}
	if h := s2.Handler(); h != nil {
		t.Fatal("server must not start without a setter")
	}
}

func TestAuthorisationAndRouting(t *testing.T) {
	setter := &recordingSetter{}
	s := &apiserver.Server{Namespace: "myrix-runtime", Token: "s3cret", Cells: setter}
	h := s.Handler()

	cases := []struct {
		name       string
		method     string
		path       string
		auth       string
		body       string
		wantStatus int
		wantCalls  int
	}{
		{"no token", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "", `{"wantRunning":true}`, http.StatusUnauthorized, 0},
		{"wrong token", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "Bearer nope", `{"wantRunning":true}`, http.StatusUnauthorized, 0},
		{"wrong scheme", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "Basic s3cret", `{"wantRunning":true}`, http.StatusUnauthorized, 0},
		{"unknown path", http.MethodPost, "/internal/v1/tenants/t1", "Bearer s3cret", `{}`, http.StatusNotFound, 0},
		{"wrong method", http.MethodGet, "/internal/v1/cells/cell-t1/want-running", "Bearer s3cret", "", http.StatusMethodNotAllowed, 0},
		{"bad body", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "Bearer s3cret", `{`, http.StatusBadRequest, 0},
		{"missing field", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "Bearer s3cret", `{}`, http.StatusBadRequest, 0},
		{"ok true", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "Bearer s3cret", `{"wantRunning":true}`, http.StatusAccepted, 1},
		{"ok false", http.MethodPost, "/internal/v1/cells/cell-t1/want-running", "Bearer s3cret", `{"wantRunning":false}`, http.StatusAccepted, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := setter.calls
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if setter.calls != tc.wantCalls {
				t.Fatalf("setter calls = %d, want %d", setter.calls, tc.wantCalls)
			}
			if setter.calls != before {
				if setter.namespace != "myrix-runtime" {
					t.Fatalf("namespace = %q", setter.namespace)
				}
				if setter.cell != "cell-t1" {
					t.Fatalf("cell = %q", setter.cell)
				}
			}
		})
	}
}

func TestLastWriteWins(t *testing.T) {
	setter := &recordingSetter{}
	h := (&apiserver.Server{Namespace: "myrix-runtime", Token: "s3cret", Cells: setter}).Handler()
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/cells/cell-t1/want-running", strings.NewReader(`{"wantRunning":false}`))
	req.Header.Set("Authorization", "Bearer s3cret")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if setter.want {
		t.Fatal("wantRunning = true, want false")
	}
}

func TestWriteFailureIsReported(t *testing.T) {
	setter := &recordingSetter{err: errors.New("conflict")}
	h := (&apiserver.Server{Namespace: "myrix-runtime", Token: "s3cret", Cells: setter}).Handler()
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/cells/cell-t1/want-running", strings.NewReader(`{"wantRunning":true}`))
	req.Header.Set("Authorization", "Bearer s3cret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["error"] != "write_failed" {
		t.Fatalf("body = %+v", body)
	}
}

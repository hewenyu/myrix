// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package driver_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/myrix/apps/cell-manager/internal/driver"
)

func TestHTTPClientUsesTheDocumentedPaths(t *testing.T) {
	var (
		gotReady, gotDrain, gotIdle string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/ready":
			gotReady = r.Method
			_, _ = w.Write([]byte(`{"bootId":"boot-1","status":"ok"}`))
		case "/v1/admin/drain":
			gotDrain = r.Method
			_, _ = w.Write([]byte(`{"drained":true,"bootId":"boot-1"}`))
		case "/v1/admin/idle":
			gotIdle = r.Method
			_, _ = w.Write([]byte(`{"bootId":"boot-1","noActiveTurns":true,"inboxEmpty":true,"flushed":true,` +
				`"lastCommandAt":"2026-09-30T10:00:00Z","observedAt":"2026-09-30T11:59:59Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := driver.NewHTTPClient()
	ep := driver.Endpoint{BaseURL: srv.URL}
	ctx := context.Background()

	info, err := c.Ready(ctx, ep)
	if err != nil {
		t.Fatalf("Ready: %v", err)
	}
	if info.BootID != "boot-1" {
		t.Fatalf("bootId = %q", info.BootID)
	}
	drain, err := c.Drain(ctx, ep)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if !drain.Drained {
		t.Fatal("drain not acknowledged")
	}
	proof, err := c.IdleProof(ctx, ep)
	if err != nil {
		t.Fatalf("IdleProof: %v", err)
	}
	if !proof.NoActiveTurns || !proof.InboxEmpty || !proof.Flushed {
		t.Fatalf("proof = %+v", proof)
	}

	if gotReady != http.MethodGet {
		t.Fatalf("GET /v1/ready used %q", gotReady)
	}
	if gotDrain != http.MethodPost || gotIdle != http.MethodPost {
		t.Fatalf("drain=%q idle=%q, want POST", gotDrain, gotIdle)
	}
}

func TestHTTPClientFailsClosed(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		wantErr error
	}{
		{
			name:    "non-2xx",
			handler: func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", http.StatusInternalServerError) },
			wantErr: driver.ErrUnexpectedStatus,
		},
		{
			name:    "malformed json",
			handler: func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("not json")) },
			wantErr: driver.ErrMalformedResponse,
		},
		{
			name:    "ready without bootId",
			handler: func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"status":"ok"}`)) },
			wantErr: driver.ErrMalformedResponse,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()
			_, err := driver.NewHTTPClient().Ready(context.Background(), driver.Endpoint{BaseURL: srv.URL})
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestHTTPClientUnreachableDriver(t *testing.T) {
	// A closed server: the real failure mode we must never mistake for idle.
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	c := driver.NewHTTPClient()
	if _, err := c.Ready(context.Background(), driver.Endpoint{BaseURL: url}); !errors.Is(err, driver.ErrUnavailable) {
		t.Fatalf("Ready error = %v, want ErrUnavailable", err)
	}
	if _, err := c.IdleProof(context.Background(), driver.Endpoint{BaseURL: url}); !errors.Is(err, driver.ErrUnavailable) {
		t.Fatalf("IdleProof error = %v, want ErrUnavailable", err)
	}
	if _, err := c.Drain(context.Background(), driver.Endpoint{}); !errors.Is(err, driver.ErrUnavailable) {
		t.Fatalf("Drain with empty endpoint = %v, want ErrUnavailable", err)
	}
}

func TestEndpointRendering(t *testing.T) {
	if got := (driver.Endpoint{PodIP: "10.0.0.7", Port: 8404}).URL(); got != "http://10.0.0.7:8404" {
		t.Fatalf("URL = %q", got)
	}
	if got := (driver.Endpoint{BaseURL: "http://x:1/"}).URL(); got != "http://x:1" {
		t.Fatalf("URL = %q", got)
	}
	if (driver.Endpoint{}).Valid() {
		t.Fatal("empty endpoint must be invalid")
	}
	var nilish *driver.IdleProofRejection
	if nilish != nil {
		t.Fatal("unreachable")
	}
}

func TestTimeoutIsApplied(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`{"bootId":"b"}`))
	}))
	defer srv.Close()

	c := &driver.HTTPClient{Timeout: 20 * time.Millisecond}
	_, err := c.Ready(context.Background(), driver.Endpoint{BaseURL: srv.URL})
	if !errors.Is(err, driver.ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable on timeout", err)
	}
	if !strings.Contains(err.Error(), "/v1/ready") {
		t.Fatalf("error should name the path: %v", err)
	}
}

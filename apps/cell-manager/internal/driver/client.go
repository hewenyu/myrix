// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

package driver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is the injectable driver boundary used by the reconciler. Production
// uses HTTPClient; tests use fakes. A nil or failing client must make the
// controller fail closed.
type Client interface {
	// Ready performs GET /v1/ready and returns the current bootId.
	Ready(ctx context.Context, ep Endpoint) (ReadyInfo, error)
	// Drain performs POST /v1/admin/drain: close admission, wait for idle,
	// flush. It is the second half of the scale-to-zero handshake.
	Drain(ctx context.Context, ep Endpoint) (DrainResult, error)
	// IdleProof performs POST /v1/admin/idle and returns explicit evidence
	// that the cell may be scaled to zero.
	IdleProof(ctx context.Context, ep Endpoint) (IdleProof, error)
}

// HTTPClient is the real driver client. Paths follow tech-design-v1 §3.2:
//
//	GET  {base}/v1/ready
//	POST {base}/v1/admin/drain
//	POST {base}/v1/admin/idle
//
// The driver's /v1/admin/idle endpoint is the "explicit idle proof" API. If a
// deployment's driver does not implement it yet, the controller stays in
// Draining forever rather than guessing; see docs/implementation/cell-manager.md.
type HTTPClient struct {
	// HTTPClient is the underlying client; defaults to a client with a 10s
	// timeout.
	HTTPClient *http.Client
	// Timeout bounds each individual call. Defaults to 10s.
	Timeout time.Duration
}

// NewHTTPClient returns an HTTPClient with sane defaults.
func NewHTTPClient() *HTTPClient {
	return &HTTPClient{Timeout: 10 * time.Second}
}

func (c *HTTPClient) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &http.Client{Timeout: timeout}
}

// Ready implements Client.
func (c *HTTPClient) Ready(ctx context.Context, ep Endpoint) (ReadyInfo, error) {
	var out ReadyInfo
	if err := c.do(ctx, ep, http.MethodGet, "/v1/ready", nil, &out); err != nil {
		return ReadyInfo{}, err
	}
	if out.BootID == "" {
		return ReadyInfo{}, fmt.Errorf("%w: /v1/ready returned no bootId", ErrMalformedResponse)
	}
	return out, nil
}

// Drain implements Client.
func (c *HTTPClient) Drain(ctx context.Context, ep Endpoint) (DrainResult, error) {
	var out DrainResult
	if err := c.do(ctx, ep, http.MethodPost, "/v1/admin/drain", bytes.NewReader([]byte("{}")), &out); err != nil {
		return DrainResult{}, err
	}
	if out.Drained && out.BootID == "" {
		return DrainResult{}, fmt.Errorf("%w: /v1/admin/drain reported drained without a bootId", ErrMalformedResponse)
	}
	return out, nil
}

// IdleProof implements Client.
func (c *HTTPClient) IdleProof(ctx context.Context, ep Endpoint) (IdleProof, error) {
	var out IdleProof
	if err := c.do(ctx, ep, http.MethodPost, "/v1/admin/idle", bytes.NewReader([]byte("{}")), &out); err != nil {
		return IdleProof{}, err
	}
	return out, nil
}

func (c *HTTPClient) do(ctx context.Context, ep Endpoint, method, path string, body io.Reader, out any) error {
	base := ep.URL()
	if base == "" {
		return fmt.Errorf("%w: empty driver endpoint", ErrUnavailable)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("%w: %s %s: %v", ErrUnavailable, method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: reading %s response: %v", ErrUnavailable, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("%w: %s %s returned %d", ErrUnexpectedStatus, method, path, resp.StatusCode)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: %s %s: %v", ErrMalformedResponse, method, path, err)
	}
	return nil
}

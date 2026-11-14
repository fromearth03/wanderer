package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Science is a thin client for the internal Python service.
type Science struct {
	base   string
	client *http.Client
	sem    Sem // the Python service is single-worker; keep its queue short
}

func NewScience(base string) *Science {
	return &Science{base: base, client: &http.Client{Timeout: 120 * time.Second}, sem: make(Sem, 3)}
}

func (s *Science) Call(ctx context.Context, path string, in any, out any) error {
	if err := s.sem.Acquire(ctx); err != nil {
		return err
	}
	defer s.sem.Release()
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return &apiError{503, "science_unavailable", "science service unreachable: " + err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Detail any `json:"detail"`
		}
		_ = json.Unmarshal(body, &e)
		msg := fmt.Sprint(e.Detail)
		if e.Detail == nil {
			msg = snippet(body)
		}
		status := 502
		if resp.StatusCode < 500 {
			status = resp.StatusCode
		}
		return &apiError{status, "science_error", "science " + path + ": " + msg}
	}
	if out != nil {
		return json.Unmarshal(body, out)
	}
	return nil
}

func (s *Science) Healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/health", nil)
	resp, err := s.client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

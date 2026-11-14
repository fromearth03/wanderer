package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// singleflight: identical concurrent calls share one execution.
// ---------------------------------------------------------------------------

type flightCall struct {
	wg  sync.WaitGroup
	val any
	err error
}

type Flight struct {
	mu sync.Mutex
	m  map[string]*flightCall
}

func (f *Flight) Do(key string, fn func() (any, error)) (any, error) {
	f.mu.Lock()
	if f.m == nil {
		f.m = map[string]*flightCall{}
	}
	if c, ok := f.m[key]; ok {
		f.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &flightCall{}
	c.wg.Add(1)
	f.m[key] = c
	f.mu.Unlock()

	func() {
		defer func() {
			if r := recover(); r != nil {
				c.err = fmt.Errorf("panic: %v", r)
			}
		}()
		c.val, c.err = fn()
	}()
	c.wg.Done()

	f.mu.Lock()
	delete(f.m, key)
	f.mu.Unlock()
	return c.val, c.err
}

// ---------------------------------------------------------------------------
// In-memory TTL cache for small JSON results.
// ---------------------------------------------------------------------------

type ttlEntry struct {
	val     any
	expires time.Time
}

type TTLCache struct {
	mu  sync.Mutex
	m   map[string]ttlEntry
	max int
}

func NewTTLCache(max int) *TTLCache { return &TTLCache{m: map[string]ttlEntry{}, max: max} }

func (c *TTLCache) Get(k string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || time.Now().After(e.expires) {
		if ok {
			delete(c.m, k)
		}
		return nil, false
	}
	return e.val, true
}

func (c *TTLCache) Set(k string, v any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.max {
		now := time.Now()
		for key, e := range c.m {
			if now.After(e.expires) {
				delete(c.m, key)
			}
		}
		for key := range c.m { // still full: drop arbitrary entries
			if len(c.m) < c.max {
				break
			}
			delete(c.m, key)
		}
	}
	c.m[k] = ttlEntry{val: v, expires: time.Now().Add(ttl)}
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

type Sem chan struct{}

func (s Sem) Acquire(ctx context.Context) error {
	select {
	case s <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s Sem) Release() { <-s }

// ---------------------------------------------------------------------------
// HTTP fetch with retry and exponential backoff.
// ---------------------------------------------------------------------------

type permanentError struct{ error }

func (p permanentError) Unwrap() error { return p.error }

// FetchOpts controls one fetch.
type FetchOpts struct {
	Attempts   int
	PerAttempt time.Duration
	Validate   func([]byte) error // non-nil error => retry (bad body, e.g. "Server busy")
	Sem        Sem                // optional concurrency limit
	MaxBytes   int64
	Label      string
}

var httpClient = &http.Client{
	Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 15 * time.Second,
	},
}

const userAgent = "wanderer-spherex-explorer/1.0 (NASA Space Apps 2026)"

func fetchBytes(ctx context.Context, url string, o FetchOpts) ([]byte, error) {
	if o.Attempts <= 0 {
		o.Attempts = 4
	}
	if o.PerAttempt <= 0 {
		o.PerAttempt = 60 * time.Second
	}
	if o.MaxBytes <= 0 {
		o.MaxBytes = 64 << 20
	}
	var lastErr error
	backoff := time.Second
	for attempt := 1; attempt <= o.Attempts; attempt++ {
		if attempt > 1 {
			sleep := backoff + time.Duration(rand.Int64N(int64(backoff/2)+1))
			slog.Warn("retrying upstream", "label", o.Label, "attempt", attempt, "sleep", sleep.String(), "err", lastErr)
			select {
			case <-time.After(sleep):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			backoff *= 2
			if backoff > 16*time.Second {
				backoff = 16 * time.Second
			}
		}
		body, err := fetchOnce(ctx, url, o)
		if err == nil {
			return body, nil
		}
		lastErr = err
		var pe permanentError
		if errors.As(err, &pe) || ctx.Err() != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("%s: giving up after %d attempts: %w", o.Label, o.Attempts, lastErr)
}

func fetchOnce(ctx context.Context, url string, o FetchOpts) ([]byte, error) {
	if o.Sem != nil {
		if err := o.Sem.Acquire(ctx); err != nil {
			return nil, err
		}
		defer o.Sem.Release()
	}
	actx, cancel := context.WithTimeout(ctx, o.PerAttempt)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, http.MethodGet, url, nil)
	if err != nil {
		return nil, permanentError{err}
	}
	req.Header.Set("User-Agent", userAgent)
	start := time.Now()
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, o.MaxBytes))
	if err != nil {
		return nil, err
	}
	slog.Debug("upstream", "label", o.Label, "status", resp.StatusCode, "bytes", len(body), "ms", time.Since(start).Milliseconds())
	switch {
	case resp.StatusCode == 429 || resp.StatusCode >= 500:
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	case resp.StatusCode >= 400:
		return nil, permanentError{fmt.Errorf("upstream status %d: %s", resp.StatusCode, snippet(body))}
	}
	if o.Validate != nil {
		if err := o.Validate(body); err != nil {
			return nil, err
		}
	}
	return body, nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 160 {
		s = s[:160] + "..."
	}
	return s
}

// ---------------------------------------------------------------------------
// Disk cache helpers
// ---------------------------------------------------------------------------

func hashKey(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

type DiskCache struct {
	Root  string
	MaxMB int64
}

// Path returns <root>/<kind>/<k[:2]>/<k><ext>, creating the directory.
func (d *DiskCache) Path(kind, key, ext string) string {
	dir := filepath.Join(d.Root, kind, key[:2])
	_ = os.MkdirAll(dir, 0o755)
	return filepath.Join(dir, key+ext)
}

func exists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Size() > 0
}

func touch(p string) {
	now := time.Now()
	_ = os.Chtimes(p, now, now)
}

// writeAtomic writes via a temp file + rename so readers never see half a file.
func writeAtomic(p string, data []byte) error {
	tmp := fmt.Sprintf("%s.tmp%d", p, rand.Int64())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (d *DiskCache) ReadJSON(kind, key string, maxAge time.Duration, v any) bool {
	p := d.Path(kind, key, ".json")
	st, err := os.Stat(p)
	if err != nil || (maxAge > 0 && time.Since(st.ModTime()) > maxAge) {
		return false
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

func (d *DiskCache) WriteJSON(kind, key string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = writeAtomic(d.Path(kind, key, ".json"), b)
}

// JanitorLoop keeps the FITS/PNG cache under MaxMB by deleting the least
// recently used files (mtime is refreshed on every cache hit).
func (d *DiskCache) JanitorLoop(ctx context.Context, every time.Duration) {
	d.Sweep()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.Sweep()
		}
	}
}

func (d *DiskCache) Sweep() {
	type f struct {
		p    string
		size int64
		mt   time.Time
	}
	var files []f
	var total int64
	for _, kind := range []string{"fits", "png", "hips"} {
		_ = filepath.WalkDir(filepath.Join(d.Root, kind), func(p string, e fs.DirEntry, err error) error {
			if err != nil || e.IsDir() {
				return nil
			}
			info, err := e.Info()
			if err != nil {
				return nil
			}
			if strings.Contains(e.Name(), ".tmp") && time.Since(info.ModTime()) > time.Hour {
				_ = os.Remove(p)
				return nil
			}
			files = append(files, f{p, info.Size(), info.ModTime()})
			total += info.Size()
			return nil
		})
	}
	limit := d.MaxMB << 20
	if total <= limit {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mt.Before(files[j].mt) })
	removed := 0
	for _, x := range files {
		if total <= limit*9/10 {
			break
		}
		if os.Remove(x.p) == nil {
			total -= x.size
			removed++
		}
	}
	slog.Info("cache sweep", "removed", removed, "remaining_mb", total>>20)
}

// ---------------------------------------------------------------------------
// HTTP JSON helpers
// ---------------------------------------------------------------------------

type apiError struct {
	Status int
	Code   string
	Msg    string
}

func (e *apiError) Error() string { return e.Msg }

func errBad(code, msg string) *apiError { return &apiError{400, code, msg} }
func errNotFound(code, msg string) *apiError {
	return &apiError{404, code, msg}
}
func errUpstream(msg string) *apiError { return &apiError{502, "upstream", msg} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		http.Error(w, `{"error":"encode failed","code":"internal"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func writeErr(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeJSON(w, ae.Status, map[string]string{"error": ae.Msg, "code": ae.Code})
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		writeJSON(w, 504, map[string]string{"error": "upstream timed out: " + err.Error(), "code": "timeout"})
		return
	}
	slog.Error("request failed", "err", err)
	writeJSON(w, 502, map[string]string{"error": err.Error(), "code": "upstream"})
}

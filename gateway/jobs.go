package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type JobState string

const (
	JobQueued  JobState = "queued"
	JobRunning JobState = "running"
	JobDone    JobState = "done"
	JobError   JobState = "error"
)

type Job struct {
	ID       string   `json:"job"`
	Kind     string   `json:"kind"`
	State    JobState `json:"state"`
	Progress float64  `json:"progress"`
	Message  string   `json:"message"`
	Result   any      `json:"result,omitempty"`
	// Partial holds the items measured so far (spectrum points, track frames)
	// while the job runs; cleared when the job is done (result has them all).
	Partial []any `json:"partial,omitempty"`
	// Cached is true when the result came from the memo (no work was done).
	Cached  bool      `json:"cached,omitempty"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
}

// JobUpdate is what we push over the websocket.
type JobUpdate struct {
	Job      string   `json:"job"`
	Kind     string   `json:"kind"`
	State    JobState `json:"state"`
	Progress float64  `json:"progress"`
	Message  string   `json:"message"`
	Result   any      `json:"result,omitempty"`
	Partial  []any    `json:"partial,omitempty"`
	Cached   bool     `json:"cached,omitempty"`
}

type Jobs struct {
	mu    sync.Mutex
	jobs  map[string]*Job
	byKey map[string]string // dedupe identical running jobs
	subs  map[string]map[chan JobUpdate]struct{}
	slots Sem // max concurrent jobs
	// memo keeps finished results by job key (memory + MemoDir on disk), so a
	// repeat request answers at once. Empty MemoDir = memory only.
	memo    map[string]json.RawMessage
	MemoDir string
}

func NewJobs() *Jobs {
	j := &Jobs{jobs: map[string]*Job{}, byKey: map[string]string{}, subs: map[string]map[chan JobUpdate]struct{}{}, slots: make(Sem, 3), memo: map[string]json.RawMessage{}}
	go j.gcLoop()
	return j
}

// Reporter lets a job body publish progress.
type Reporter func(progress float64, msg string)

type partialKey struct{}
type skipMemoKey struct{}

// maxPartial caps the partial list sent with each update.
const maxPartial = 300

// SkipMemo marks the running job's result as degraded (some downloads failed),
// so it is returned but not saved: the next request runs it again.
func SkipMemo(ctx context.Context) {
	if f, ok := ctx.Value(skipMemoKey{}).(func()); ok {
		f()
	}
}

// EmitPartial appends one finished item (a spectrum point, a track frame) to
// the running job's partial list. It is sent with the next progress report.
// Outside a job (e.g. cache warming) it does nothing.
func EmitPartial(ctx context.Context, item any) {
	if f, ok := ctx.Value(partialKey{}).(func(any)); ok {
		f(item)
	}
}

func (j *Jobs) memoPath(key string) string {
	if j.MemoDir == "" {
		return ""
	}
	h := sha1.Sum([]byte(key))
	return filepath.Join(j.MemoDir, hex.EncodeToString(h[:])+".json")
}

// Memo returns a memoized result for key (memory first, then disk).
func (j *Jobs) Memo(key string) (json.RawMessage, bool) {
	j.mu.Lock()
	b, ok := j.memo[key]
	j.mu.Unlock()
	if ok {
		return b, true
	}
	p := j.memoPath(key)
	if p == "" {
		return nil, false
	}
	data, err := os.ReadFile(p)
	if err != nil || !json.Valid(data) {
		return nil, false
	}
	var env struct {
		Key    string          `json:"key"`
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal(data, &env) != nil || env.Key != key || len(env.Result) == 0 {
		return nil, false
	}
	j.mu.Lock()
	j.memo[key] = env.Result
	j.mu.Unlock()
	return env.Result, true
}

func (j *Jobs) putMemo(key string, res any) {
	b, err := json.Marshal(res)
	if err != nil {
		return
	}
	j.mu.Lock()
	j.memo[key] = b
	j.mu.Unlock()
	if p := j.memoPath(key); p != "" {
		env, _ := json.Marshal(map[string]any{"key": key, "saved": time.Now().UTC(), "result": json.RawMessage(b)})
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
			_ = writeAtomic(p, env)
		}
	}
}

// Start launches fn in a goroutine. Identical requests (same key) that are still
// queued, running or finished in the last 10 minutes reuse the same job, and a
// memoized result is returned as an already finished job.
func (j *Jobs) Start(kind, key string, fn func(ctx context.Context, report Reporter) (any, error)) string {
	return j.StartWith(kind, key, false, fn)
}

// StartWith is Start with force: true skips the memo and finished jobs and
// runs the work again (a job that is still running is reused).
func (j *Jobs) StartWith(kind, key string, force bool, fn func(ctx context.Context, report Reporter) (any, error)) string {
	j.mu.Lock()
	if id, ok := j.byKey[key]; ok {
		if jb, ok := j.jobs[id]; ok && jb.State != JobError && (!force || jb.State == JobQueued || jb.State == JobRunning) {
			j.mu.Unlock()
			return id
		}
	}
	j.mu.Unlock()
	var memo json.RawMessage
	if !force {
		memo, _ = j.Memo(key)
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	id := kind + "-" + hex.EncodeToString(b)
	now := time.Now()
	jb := &Job{ID: id, Kind: kind, State: JobQueued, Message: "queued", Created: now, Updated: now}
	if memo != nil {
		jb.State, jb.Progress, jb.Message, jb.Result, jb.Cached = JobDone, 1, "done (saved result)", memo, true
	}
	j.mu.Lock()
	// Another identical request may have started a job while we read the memo.
	if oid, ok := j.byKey[key]; ok {
		if ob, ok := j.jobs[oid]; ok && ob.State != JobError && (!force || ob.State == JobQueued || ob.State == JobRunning) {
			j.mu.Unlock()
			return oid
		}
	}
	j.jobs[id] = jb
	j.byKey[key] = id
	j.mu.Unlock()
	if memo != nil {
		return id
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
		defer cancel()
		ctx = context.WithValue(ctx, partialKey{}, func(item any) { j.addPartial(id, item) })
		var skip atomic.Bool
		ctx = context.WithValue(ctx, skipMemoKey{}, func() { skip.Store(true) })
		if err := j.slots.Acquire(ctx); err != nil {
			j.finish(id, nil, err)
			return
		}
		defer j.slots.Release()
		j.update(id, JobRunning, 0, "started", nil)
		start := time.Now()
		var res any
		var err error
		func() {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("job panic: %v", r)
				}
			}()
			res, err = fn(ctx, func(p float64, msg string) { j.update(id, JobRunning, p, msg, nil) })
		}()
		slog.Info("job finished", "job", id, "ms", time.Since(start).Milliseconds(), "err", err)
		if err == nil && res != nil && !skip.Load() {
			j.putMemo(key, res)
		}
		j.finish(id, res, err)
	}()
	return id
}

// Wait blocks until the job is done or failed (or ctx ends).
func (j *Jobs) Wait(ctx context.Context, id string) (Job, error) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for {
		jb, ok := j.Get(id)
		if !ok {
			return Job{}, fmt.Errorf("unknown job %s", id)
		}
		if jb.State == JobDone || jb.State == JobError {
			return jb, nil
		}
		select {
		case <-ctx.Done():
			return jb, ctx.Err()
		case <-t.C:
		}
	}
}

func (j *Jobs) addPartial(id string, item any) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if jb, ok := j.jobs[id]; ok && jb.State != JobDone && jb.State != JobError && len(jb.Partial) < maxPartial {
		jb.Partial = append(jb.Partial, item)
	}
}

func (j *Jobs) finish(id string, res any, err error) {
	if err != nil {
		j.update(id, JobError, 1, err.Error(), nil)
		return
	}
	j.update(id, JobDone, 1, "done", res)
}

func (j *Jobs) update(id string, st JobState, p float64, msg string, res any) {
	j.mu.Lock()
	jb, ok := j.jobs[id]
	if !ok {
		j.mu.Unlock()
		return
	}
	if p < jb.Progress && st == JobRunning {
		p = jb.Progress
	}
	jb.State, jb.Progress, jb.Message, jb.Updated = st, p, msg, time.Now()
	if res != nil {
		jb.Result = res
	}
	if st == JobDone || st == JobError {
		jb.Partial = nil
	}
	u := JobUpdate{Job: id, Kind: jb.Kind, State: st, Progress: p, Message: msg, Result: jb.Result, Cached: jb.Cached}
	if st == JobRunning {
		u.Result = nil
		u.Partial = append([]any(nil), jb.Partial...)
	}
	for ch := range j.subs[id] {
		select {
		case ch <- u:
		default: // slow subscriber: drop intermediate updates
		}
	}
	j.mu.Unlock()
}

func (j *Jobs) Get(id string) (Job, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	jb, ok := j.jobs[id]
	if !ok {
		return Job{}, false
	}
	c := *jb
	c.Partial = append([]any(nil), jb.Partial...)
	return c, true
}

func (j *Jobs) subscribe(id string, ch chan JobUpdate) (JobUpdate, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	jb, ok := j.jobs[id]
	if !ok {
		return JobUpdate{}, false
	}
	if j.subs[id] == nil {
		j.subs[id] = map[chan JobUpdate]struct{}{}
	}
	j.subs[id][ch] = struct{}{}
	u := JobUpdate{Job: id, Kind: jb.Kind, State: jb.State, Progress: jb.Progress, Message: jb.Message, Cached: jb.Cached}
	if jb.State == JobDone {
		u.Result = jb.Result
	} else {
		u.Partial = append([]any(nil), jb.Partial...)
	}
	return u, true
}

func (j *Jobs) unsubscribe(ch chan JobUpdate) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for id, m := range j.subs {
		delete(m, ch)
		if len(m) == 0 {
			delete(j.subs, id)
		}
	}
}

func (j *Jobs) gcLoop() {
	for range time.Tick(5 * time.Minute) {
		j.mu.Lock()
		for id, jb := range j.jobs {
			if (jb.State == JobDone || jb.State == JobError) && time.Since(jb.Updated) > time.Hour {
				delete(j.jobs, id)
			}
		}
		for k, id := range j.byKey {
			jb, ok := j.jobs[id]
			if !ok || ((jb.State == JobDone) && time.Since(jb.Updated) > 10*time.Minute) {
				delete(j.byKey, k)
			}
		}
		j.mu.Unlock()
	}
}

// ServeWS handles /ws: the client sends {"subscribe": "<job>"} (any number of
// times) and receives JobUpdate messages.
func (j *Jobs) ServeWS(w http.ResponseWriter, r *http.Request) {
	// The server's Read/WriteTimeout would otherwise also apply to the hijacked
	// connection and kill long-lived sockets.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	ch := make(chan JobUpdate, 64)
	defer j.unsubscribe(ch)

	go func() {
		defer cancel()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			var msg struct {
				Subscribe string `json:"subscribe"`
			}
			if json.Unmarshal(data, &msg) != nil || msg.Subscribe == "" {
				select {
				case ch <- JobUpdate{State: JobError, Message: `expected {"subscribe": "<job>"}`}:
				default:
				}
				continue
			}
			u, ok := j.subscribe(msg.Subscribe, ch)
			if !ok {
				u = JobUpdate{Job: msg.Subscribe, State: JobError, Message: "unknown job"}
			}
			select {
			case ch <- u:
			default:
			}
		}
	}()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			c.Close(websocket.StatusNormalClosure, "")
			return
		case u := <-ch:
			b, _ := json.Marshal(u)
			wctx, wc := context.WithTimeout(ctx, 10*time.Second)
			err := c.Write(wctx, websocket.MessageText, b)
			wc()
			if err != nil {
				return
			}
		case <-ping.C:
			pctx, pc := context.WithTimeout(ctx, 10*time.Second)
			err := c.Ping(pctx)
			pc()
			if err != nil {
				return
			}
		}
	}
}

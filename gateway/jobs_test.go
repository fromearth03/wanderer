package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestJobsOverWebSocket(t *testing.T) {
	jobs := NewJobs()
	release := make(chan struct{})
	id := jobs.Start("test", "k1", func(ctx context.Context, report Reporter) (any, error) {
		<-release
		report(0.5, "half way")
		return map[string]int{"answer": 42}, nil
	})
	if again := jobs.Start("test", "k1", nil); again != id {
		t.Fatalf("identical job not deduplicated: %s vs %s", again, id)
	}
	srv := httptest.NewUnstartedServer(withLogging(http.HandlerFunc(jobs.ServeWS)))
	srv.Config.ReadTimeout = time.Second
	srv.Config.WriteTimeout = time.Second
	srv.Start()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"subscribe":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	var first JobUpdate
	_, b, err := c.Read(ctx)
	if err != nil || json.Unmarshal(b, &first) != nil || first.Job != id {
		t.Fatalf("first message %s %v", b, err)
	}
	time.Sleep(2500 * time.Millisecond) // longer than the server timeouts
	close(release)
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var u JobUpdate
		if err := json.Unmarshal(b, &u); err != nil {
			t.Fatal(err)
		}
		if u.State == JobDone {
			if !strings.Contains(string(b), `"answer":42`) || u.Progress != 1 {
				t.Fatalf("done message %s", b)
			}
			break
		}
	}
	j, ok := jobs.Get(id)
	if !ok || j.State != JobDone {
		t.Fatalf("poll state %+v", j)
	}
}

func TestJobsMemoAndPartial(t *testing.T) {
	dir := t.TempDir()
	jobs := NewJobs()
	jobs.MemoDir = dir
	runs := 0
	release := make(chan struct{})
	body := func(ctx context.Context, report Reporter) (any, error) {
		runs++
		EmitPartial(ctx, map[string]int{"i": 1})
		report(0.5, "one point")
		<-release
		return map[string]int{"answer": 7}, nil
	}
	id := jobs.Start("spec", "k", body)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		jb, _ := jobs.Get(id)
		if len(jb.Partial) == 1 {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("partial never appeared")
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)
	if jb, err := jobs.Wait(ctx, id); err != nil || jb.State != JobDone || jb.Partial != nil {
		t.Fatalf("wait %+v %v", jb, err)
	}
	// a fresh Jobs (as after a restart) answers from disk without running
	again := NewJobs()
	again.MemoDir = dir
	id2 := again.Start("spec", "k", func(context.Context, Reporter) (any, error) { t.Fatal("ran again"); return nil, nil })
	jb, _ := again.Get(id2)
	b, _ := json.Marshal(jb)
	if jb.State != JobDone || !jb.Cached || !strings.Contains(string(b), `"answer":7`) {
		t.Fatalf("memo job %s", b)
	}
	// force reruns
	ran := make(chan struct{})
	id3 := again.StartWith("spec", "k", true, func(context.Context, Reporter) (any, error) { close(ran); return 1, nil })
	if id3 == id2 {
		t.Fatal("force reused the memo job")
	}
	select {
	case <-ran:
	case <-ctx.Done():
		t.Fatal("force did not rerun")
	}
	if runs != 1 {
		t.Fatalf("runs %d", runs)
	}
}

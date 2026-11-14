package main

// HiPS sky tile proxy with a disk cache. The sky map asks /api/hips/<survey
// path>/... instead of the archive directly: the first request for a tile goes
// to IRSA (about 1.3 s per tile from here), every later one is served from disk
// in milliseconds, and the browser sees one origin (no CORS, one connection pool).

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const hipsUpstream = "https://irsa.ipac.caltech.edu/data/hips/"

var (
	hipsPathRE = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_./-]*$`)
	hipsSem    = make(Sem, 8)
	hipsClient = &http.Client{Timeout: 90 * time.Second}
)

func hipsContentType(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".fits":
		return "application/fits"
	case ".json":
		return "application/json"
	}
	return "text/plain; charset=utf-8"
}

func (a *App) hipsLocal(p string) string {
	return filepath.Join(a.cfg.CacheDir, "hips", filepath.FromSlash(p))
}

// fetchHiPS returns the local path of a cached tile, downloading it once.
func (a *App) fetchHiPS(ctx context.Context, p string) (string, error) {
	local := a.hipsLocal(p)
	if exists(local) {
		touch(local)
		return local, nil
	}
	if _, ok := a.mem.Get("hips404:" + p); ok {
		return "", errNotFound("not_found", "no such sky tile")
	}
	_, err := a.flight.Do("hips:"+p, func() (any, error) {
		if err := hipsSem.Acquire(ctx); err != nil {
			return nil, err
		}
		defer hipsSem.Release()
		req, err := http.NewRequestWithContext(ctx, "GET", hipsUpstream+p, nil)
		if err != nil {
			return nil, err
		}
		res, err := hipsClient.Do(req)
		if err != nil {
			return nil, errUpstream("sky tile archive unreachable: " + err.Error())
		}
		defer res.Body.Close()
		if res.StatusCode == 404 {
			a.mem.Set("hips404:"+p, true, time.Hour)
			return nil, errNotFound("not_found", "no such sky tile")
		}
		if res.StatusCode != 200 {
			return nil, errUpstream(fmt.Sprintf("sky tile archive answered %d", res.StatusCode))
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
		if err != nil {
			return nil, errUpstream("sky tile download failed")
		}
		if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
			return nil, err
		}
		return nil, writeAtomic(local, body)
	})
	if err != nil {
		return "", err
	}
	return local, nil
}

func (a *App) handleHiPS(w http.ResponseWriter, r *http.Request) error {
	p := r.PathValue("path")
	if !hipsPathRE.MatchString(p) || strings.Contains(p, "..") {
		return errBad("bad_param", "bad sky tile path")
	}
	ctx, cancel := reqCtx(r, 90*time.Second)
	defer cancel()
	local, err := a.fetchHiPS(ctx, p)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", hipsContentType(p))
	if strings.HasSuffix(p, "properties") {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=604800")
	}
	http.ServeFile(w, r, local)
	return nil
}

// warmHiPS fetches what the sky map needs for its first draw of the default
// surveys (properties, low resolution all-sky images), so a fresh visit paints fast.
func (a *App) warmHiPS(ctx context.Context) {
	start := time.Now()
	for _, s := range []string{"CDS/2MASS/Color", "CDS/DSS2/color", "CDS/AllWISE/RGB-W4-W2-W1"} {
		for _, f := range []string{"properties", "Norder3/Allsky.jpg"} {
			if ctx.Err() != nil {
				return
			}
			c, cancel := context.WithTimeout(ctx, 2*time.Minute)
			if _, err := a.fetchHiPS(c, s+"/"+f); err != nil {
				slog.Warn("warm: hips", "path", s+"/"+f, "err", err)
			}
			cancel()
		}
	}
	slog.Info("warm: hips ready", "ms", time.Since(start).Milliseconds())
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type App struct {
	cfg     Config
	cache   *DiskCache
	irsa    *IRSA
	jpl     *JPL
	sci     *Science
	jobs    *Jobs
	presets []Preset
	flight  Flight
	mem     *TTLCache
}

func NewApp(cfg Config) (*App, error) {
	if err := os.MkdirAll(cfg.CacheDir, 0o755); err != nil {
		return nil, err
	}
	dc := &DiskCache{Root: cfg.CacheDir, MaxMB: cfg.CacheMaxMB}
	reg, err := NewRegistry(cfg.CacheDir)
	if err != nil {
		return nil, err
	}
	mem := NewTTLCache(5000)
	a := &App{
		cfg:   cfg,
		cache: dc,
		irsa:  &IRSA{sem: make(Sem, cfg.IRSAWorkers), cache: dc, mem: mem, reg: reg},
		jpl:   &JPL{sem: make(Sem, 2), cache: dc, mem: mem},
		sci:   NewScience(cfg.ScienceURL),
		jobs:  NewJobs(),
		mem:   mem,
	}
	a.jobs.MemoDir = filepath.Join(cfg.CacheDir, "jobs")
	a.presets, err = loadPresets()
	if err != nil {
		return nil, fmt.Errorf("presets: %w", err)
	}
	for _, p := range a.presets {
		reg.Add(p.registryEpochs())
	}
	return a, nil
}

func (a *App) Routes() http.Handler {
	mux := http.NewServeMux()
	h := func(pattern string, fn func(http.ResponseWriter, *http.Request) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if err := fn(w, r); err != nil {
				writeErr(w, err)
			}
		})
	}
	h("GET /api/health", a.handleHealth)
	h("GET /api/resolve", a.handleResolve)
	h("GET /api/epochs", a.handleEpochs)
	h("GET /api/cutout.png", a.handleCutoutPNG)
	h("GET /api/cutout.fits", a.handleCutoutFITS)
	h("GET /api/cutout/meta", a.handleMeta)
	h("GET /api/diff.png", a.handleDiffPNG)
	h("GET /api/known", a.handleKnown)
	h("POST /api/project", a.handleProject)
	h("GET /api/spectrum", a.handleSpectrum)
	h("GET /api/track", a.handleTrack)
	h("GET /api/movers", a.handleMovers)
	h("GET /api/jobs/{job}", a.handleJob)
	h("GET /api/presets", a.handlePresets)
	h("GET /api/rgb", a.handleRGBPick)         // rgb.go
	h("GET /api/rgb.png", a.handleRGBPNG)      // rgb.go
	h("GET /api/hips/{path...}", a.handleHiPS) // hips.go
	a.orbitRoutes(h)                           // GET /api/spherex/tle, GET /api/orbit (orbit.go)
	mux.HandleFunc("GET /ws", a.jobs.ServeWS)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, map[string]string{"error": "no such endpoint: " + r.Method + " " + r.URL.Path, "code": "not_found"})
	})
	return withRecover(withLogging(withCORS(mux)))
}

// ---------------------------------------------------------------------------
// middleware
// ---------------------------------------------------------------------------

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusWriter) WriteHeader(c int) { s.status = c; s.ResponseWriter.WriteHeader(c) }
func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = 200
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Unwrap lets the websocket library reach the Hijacker.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		slog.Info("http", "method", r.Method, "path", r.URL.Path, "query", r.URL.RawQuery, "status", sw.status, "bytes", sw.bytes, "ms", time.Since(start).Milliseconds())
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				slog.Error("panic", "err", v, "path", r.URL.Path)
				writeJSON(w, 500, map[string]string{"error": "internal error", "code": "internal"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// query helpers
// ---------------------------------------------------------------------------

func qFloat(r *http.Request, name string, def float64, required bool) (float64, error) {
	s := strings.TrimSpace(r.URL.Query().Get(name))
	if s == "" {
		if required {
			return 0, errBad("missing_param", "missing parameter: "+name)
		}
		return def, nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, errBad("bad_param", "parameter "+name+" must be a number")
	}
	return v, nil
}

func qInt(r *http.Request, name string, def int) (int, error) {
	s := strings.TrimSpace(r.URL.Query().Get(name))
	if s == "" {
		return def, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0, errBad("bad_param", "parameter "+name+" must be an integer")
	}
	return v, nil
}

func qPos(r *http.Request) (float64, float64, error) {
	ra, err := qFloat(r, "ra", 0, true)
	if err != nil {
		return 0, 0, err
	}
	dec, err := qFloat(r, "dec", 0, true)
	if err != nil {
		return 0, 0, err
	}
	if dec < -90 || dec > 90 {
		return 0, 0, errBad("bad_param", "dec must be within -90..90")
	}
	ra = math.Mod(ra, 360)
	if ra < 0 {
		ra += 360
	}
	return ra, dec, nil
}

func qCollection(r *http.Request) (string, error) {
	c := r.URL.Query().Get("collection")
	if c == "" {
		return "spherex_dr1", nil
	}
	if _, ok := collections[c]; !ok {
		return "", errBad("bad_collection", "collection must be spherex_dr1 or spherex_dr1_deep")
	}
	return c, nil
}

func reqCtx(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, 200, map[string]any{"ok": true, "science": a.sci.Healthy(r.Context()), "version": version})
	return nil
}

var planetIDs = map[string]string{
	"mercury": "199", "venus": "299", "moon": "301", "mars": "499", "jupiter": "599",
	"saturn": "699", "uranus": "799", "neptune": "899", "pluto": "999",
}

func (a *App) handleResolve(w http.ResponseWriter, r *http.Request) error {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		return errBad("missing_param", "missing parameter: name")
	}
	ctx, cancel := reqCtx(r, 90*time.Second)
	defer cancel()
	force := r.URL.Query().Get("kind")
	tryMoving := func() (Resolved, error) {
		cmd := name
		if id, ok := planetIDs[strings.ToLower(name)]; ok {
			cmd = id
		}
		now := time.Now().UTC().Truncate(time.Minute)
		if t, err := qFloat(r, "mjd", 0, false); err == nil && t > 0 {
			now = mjdToTime(t)
		}
		e, err := a.jpl.Ephemeris(ctx, cmd, now, now.Add(time.Hour), "1h")
		if err != nil {
			return Resolved{}, err
		}
		p := e.Points[0]
		target := e.Target
		if target == "" {
			target = name
		}
		return Resolved{Name: target, RA: round(p.RA, 6), Dec: round(p.Dec, 6), Kind: "moving", Source: "JPL Horizons", MJD: p.MJD}, nil
	}
	tryFixed := func() (Resolved, bool, error) { return a.jpl.Sesame(ctx, name) }

	if force == "moving" || (force == "" && looksMoving(name)) {
		res, err := tryMoving()
		if err == nil {
			writeJSON(w, 200, res)
			return nil
		}
		if force == "moving" {
			return err
		}
	}
	res, ok, err := tryFixed()
	if err == nil && ok {
		writeJSON(w, 200, res)
		return nil
	}
	if force != "fixed" {
		if m, merr := tryMoving(); merr == nil {
			writeJSON(w, 200, m)
			return nil
		} else if ae, ok := merr.(*apiError); ok && ae.Code == "ambiguous" {
			return merr
		}
	}
	if err != nil {
		return errUpstream("name resolvers failed: " + err.Error())
	}
	return errNotFound("not_found", "could not resolve "+strconvQuote(name))
}

func strconvQuote(s string) string { return strconv.Quote(s) }

func (a *App) handleEpochs(w http.ResponseWriter, r *http.Request) error {
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	coll, err := qCollection(r)
	if err != nil {
		return err
	}
	det, err := qInt(r, "det", 0)
	if err != nil {
		return err
	}
	tmin, err := qFloat(r, "start", 0, false)
	if err != nil {
		return err
	}
	tmax, err := qFloat(r, "stop", 0, false)
	if err != nil {
		return err
	}
	max, err := qInt(r, "max", 3000)
	if err != nil {
		return err
	}
	if max < 1 {
		max = 1
	}
	ctx, cancel := reqCtx(r, 4*time.Minute)
	defer cancel()
	all, err := a.irsa.Query(ctx, coll, ra, dec, 0.001, 0, 0)
	if err != nil {
		return err
	}
	eps := make([]Epoch, 0, len(all))
	for _, e := range all {
		if (det > 0 && e.Det != det) || (tmin > 0 && e.MJD < tmin) || (tmax > 0 && e.MJD > tmax) {
			continue
		}
		eps = append(eps, e)
	}
	matched := len(eps)
	if len(eps) > max { // thin evenly in time (deep fields have ~20k images)
		thin := make([]Epoch, 0, max)
		for i := 0; i < max; i++ {
			thin = append(thin, eps[i*len(eps)/max])
		}
		eps = thin
	}
	writeJSON(w, 200, map[string]any{"ra": ra, "dec": dec, "collection": coll, "count": len(eps), "total": matched, "truncated": matched > len(eps), "epochs": eps})
	return nil
}

// cutoutFor resolves id + position to a cached FITS path.
func (a *App) cutoutFor(ctx context.Context, id string, ra, dec float64, size int) (string, Epoch, error) {
	if id == "" {
		return "", Epoch{}, errBad("missing_param", "missing parameter: id")
	}
	e, err := a.irsa.Lookup(ctx, id, ra, dec)
	if err != nil {
		return "", Epoch{}, err
	}
	p, err := a.irsa.Cutout(ctx, e, ra, dec, size)
	return p, e, err
}

var stretches = map[string]bool{"asinh": true, "linear": true, "log": true, "zscale": true, "sqrt": true}
var cmaps = map[string]bool{"gray": true, "inferno": true, "viridis": true, "ice": true, "nebula": true}

func (a *App) handleCutoutPNG(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	size, err := qInt(r, "size", 200)
	if err != nil {
		return err
	}
	size = normSize(size)
	stretch := orDefault(q.Get("stretch"), "asinh")
	cmap := orDefault(q.Get("cmap"), "gray")
	sub := orDefault(q.Get("sub"), "none")
	if !stretches[stretch] {
		return errBad("bad_param", "stretch must be asinh, linear, log, sqrt or zscale")
	}
	if !cmaps[cmap] {
		return errBad("bad_param", "cmap must be gray, inferno, viridis, ice or nebula")
	}
	if sub != "none" && sub != "zodi" {
		return errBad("bad_param", "sub must be none or zodi")
	}
	ctx, cancel := reqCtx(r, 4*time.Minute)
	defer cancel()
	fitsPath, _, err := a.cutoutFor(ctx, q.Get("id"), ra, dec, size)
	if err != nil {
		return err
	}
	// align=<epoch id>: resample onto that epoch's cutout grid so blinks and
	// flipbooks of differently rotated visits line up pixel for pixel.
	refPath := ""
	if al := q.Get("align"); al != "" && al != q.Get("id") {
		refPath, _, err = a.cutoutFor(ctx, al, ra, dec, size)
		if err != nil {
			return err
		}
	}
	key := hashKey("png", fitsPath, stretch, cmap, sub)
	if refPath != "" {
		key = hashKey("png-aligned", fitsPath, refPath, stretch, cmap, sub)
	}
	out := a.cache.Path("png", key, ".png")
	if !exists(out) {
		_, err = a.flight.Do(key, func() (any, error) {
			if exists(out) {
				return nil, nil
			}
			req := map[string]any{"fits": fitsPath, "out": out, "stretch": stretch, "cmap": cmap, "sub": sub}
			if refPath != "" {
				req["ref"] = refPath
			}
			return nil, a.sci.Call(ctx, "/render", req, nil)
		})
		if err != nil {
			return err
		}
	} else {
		touch(out)
	}
	servePNG(w, r, out)
	return nil
}

func (a *App) handleCutoutFITS(w http.ResponseWriter, r *http.Request) error {
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	size, err := qInt(r, "size", 200)
	if err != nil {
		return err
	}
	ctx, cancel := reqCtx(r, 4*time.Minute)
	defer cancel()
	id := r.URL.Query().Get("id")
	p, _, err := a.cutoutFor(ctx, id, ra, dec, size)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/fits")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="spherex_%s.fits"`, strings.ReplaceAll(id, ".", "_")))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
	return nil
}

func servePNG(w http.ResponseWriter, r *http.Request, p string) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	http.ServeFile(w, r, p)
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func (a *App) meta(ctx context.Context, id string, ra, dec float64, size int) (map[string]any, error) {
	fitsPath, e, err := a.cutoutFor(ctx, id, ra, dec, size)
	if err != nil {
		return nil, err
	}
	key := hashKey("meta", fitsPath, fmt.Sprintf("%.6f,%.6f", ra, dec))
	if v, ok := a.mem.Get(key); ok {
		return v.(map[string]any), nil
	}
	var m map[string]any
	if err := a.sci.Call(ctx, "/meta", map[string]any{"fits": fitsPath, "ra": ra, "dec": dec}, &m); err != nil {
		return nil, err
	}
	m["id"] = e.ID
	m["collection"] = e.Collection
	m["band"] = e.Band
	if v, ok := m["det"]; !ok || v == nil {
		m["det"] = e.Det
	}
	a.mem.Set(key, m, 6*time.Hour)
	return m, nil
}

func (a *App) handleMeta(w http.ResponseWriter, r *http.Request) error {
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	size, err := qInt(r, "size", 200)
	if err != nil {
		return err
	}
	ctx, cancel := reqCtx(r, 4*time.Minute)
	defer cancel()
	m, err := a.meta(ctx, r.URL.Query().Get("id"), ra, dec, normSize(size))
	if err != nil {
		return err
	}
	writeJSON(w, 200, m)
	return nil
}

func (a *App) diff(ctx context.Context, idA, idB string, ra, dec float64, size int, stretch string) (string, map[string]any, error) {
	pa, _, err := a.cutoutFor(ctx, idA, ra, dec, size)
	if err != nil {
		return "", nil, err
	}
	pb, _, err := a.cutoutFor(ctx, idB, ra, dec, size)
	if err != nil {
		return "", nil, err
	}
	key := hashKey("diff", pa, pb, stretch)
	out := a.cache.Path("png", key, ".png")
	if exists(out) {
		touch(out)
		if v, ok := a.mem.Get(key); ok {
			return out, v.(map[string]any), nil
		}
		return out, nil, nil
	}
	v, err := a.flight.Do(key, func() (any, error) {
		var res map[string]any
		err := a.sci.Call(ctx, "/diff", map[string]any{"a": pa, "b": pb, "out": out, "stretch": stretch}, &res)
		return res, err
	})
	if err != nil {
		return "", nil, err
	}
	res, _ := v.(map[string]any)
	a.mem.Set(key, res, 24*time.Hour)
	return out, res, nil
}

func (a *App) handleDiffPNG(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	size, err := qInt(r, "size", 200)
	if err != nil {
		return err
	}
	stretch := orDefault(q.Get("stretch"), "linear")
	if stretch != "linear" && stretch != "asinh" {
		return errBad("bad_param", "diff stretch must be linear or asinh")
	}
	if q.Get("a") == "" || q.Get("b") == "" {
		return errBad("missing_param", "parameters a and b (epoch ids) are required")
	}
	ctx, cancel := reqCtx(r, 5*time.Minute)
	defer cancel()
	out, res, err := a.diff(ctx, q.Get("a"), q.Get("b"), ra, dec, normSize(size), stretch)
	if err != nil {
		return err
	}
	if res != nil {
		if v, ok := res["rms"].(float64); ok {
			w.Header().Set("X-Diff-RMS", strconv.FormatFloat(v, 'g', 6, 64))
		}
	}
	servePNG(w, r, out)
	return nil
}

func (a *App) handleKnown(w http.ResponseWriter, r *http.Request) error {
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	mjd, err := qFloat(r, "mjd", 0, true)
	if err != nil {
		return err
	}
	radius, err := qFloat(r, "radius", 0.2, false)
	if err != nil {
		return err
	}
	vlim, err := qFloat(r, "vmag", 20, false)
	if err != nil {
		return err
	}
	kind := orDefault(r.URL.Query().Get("kind"), "a")
	ctx, cancel := reqCtx(r, 3*time.Minute)
	defer cancel()
	bodies, err := a.jpl.Known(ctx, kind, ra, dec, mjd, radius, vlim)
	if err != nil {
		return err
	}
	if bodies == nil {
		bodies = []Body{}
	}
	writeJSON(w, 200, map[string]any{"ra": ra, "dec": dec, "mjd": mjd, "radius": radius, "kind": kind, "count": len(bodies), "bodies": bodies})
	return nil
}

func (a *App) handleProject(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ID     string       `json:"id"`
		RA     float64      `json:"ra"`
		Dec    float64      `json:"dec"`
		Size   int          `json:"size"`
		Points [][2]float64 `json:"points"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		return errBad("bad_body", "invalid JSON body: "+err.Error())
	}
	if len(in.Points) > 5000 {
		return errBad("bad_body", "too many points (max 5000)")
	}
	ctx, cancel := reqCtx(r, 4*time.Minute)
	defer cancel()
	p, _, err := a.cutoutFor(ctx, in.ID, in.RA, in.Dec, normSize(in.Size))
	if err != nil {
		return err
	}
	pts := in.Points
	if pts == nil {
		pts = [][2]float64{}
	}
	var res map[string]any
	if err := a.sci.Call(ctx, "/project", map[string]any{"fits": p, "points": pts}, &res); err != nil {
		return err
	}
	writeJSON(w, 200, res)
	return nil
}

func (a *App) handleJob(w http.ResponseWriter, r *http.Request) error {
	j, ok := a.jobs.Get(r.PathValue("job"))
	if !ok {
		return errNotFound("unknown_job", "no such job (jobs expire one hour after finishing)")
	}
	writeJSON(w, 200, j)
	return nil
}

func (a *App) handlePresets(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, 200, map[string]any{"presets": a.presets})
	return nil
}

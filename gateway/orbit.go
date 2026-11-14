package main

// Orbit endpoints for the 3D views.
//
//   GET /api/spherex/tle   CelesTrak GP elements (OMM JSON) for SPHEREx, NORAD 63182.
//                          Cached 6 h in memory and on disk; on upstream failure the
//                          last good disk copy (or a built-in copy) is served, marked stale.
//   GET /api/orbit         Heliocentric state vectors (JPL Horizons, EPHEM_TYPE=VECTORS,
//                          CENTER='500@10', ecliptic J2000, au) for one object over
//                          start..stop, plus one orbit of Mercury..Jupiter starting today.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

func (a *App) orbitRoutes(h func(string, func(http.ResponseWriter, *http.Request) error)) {
	h("GET /api/spherex/tle", a.handleSpherexTLE)
	h("GET /api/orbit", a.handleOrbit)
}

// ---------------------------------------------------------------------------
// SPHEREx TLE (CelesTrak GP, OMM JSON)
// ---------------------------------------------------------------------------

const spherexNORAD = 63182

var celestrakURL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=63182&FORMAT=json"

// builtinSpherexOMM is the element set fetched on 2026-11-14, used only when
// CelesTrak is unreachable and no disk copy exists yet.
const builtinSpherexOMM = `{"OBJECT_NAME":"SPHEREX (MIDEX 9)","OBJECT_ID":"2025-047E","EPOCH":"2026-11-14T01:18:11.500128","MEAN_MOTION":14.74308339,"ECCENTRICITY":0.0011582,"INCLINATION":97.9569,"RA_OF_ASC_NODE":140.1785,"ARG_OF_PERICENTER":73.9821,"MEAN_ANOMALY":286.2663,"EPHEMERIS_TYPE":0,"CLASSIFICATION_TYPE":"U","NORAD_CAT_ID":63182,"ELEMENT_SET_NO":999,"REV_AT_EPOCH":9012,"BSTAR":0.00015185,"MEAN_MOTION_DDOT":0,"MEAN_MOTION_DOT":9.56e-6}`

type TLEResp struct {
	NORAD   int             `json:"norad"`
	Name    string          `json:"name"`
	Epoch   string          `json:"epoch"`
	Source  string          `json:"source"`
	Fetched string          `json:"fetched"`
	Stale   bool            `json:"stale"`
	OMM     json.RawMessage `json:"omm"`
}

// parseOMM validates a CelesTrak GP JSON body and returns the SPHEREx record.
func parseOMM(b []byte) (json.RawMessage, string, string, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(b, &arr); err != nil {
		return nil, "", "", fmt.Errorf("celestrak: not a JSON array: %s", snippet(b))
	}
	for _, raw := range arr {
		var rec struct {
			Name   string  `json:"OBJECT_NAME"`
			Epoch  string  `json:"EPOCH"`
			NORAD  int     `json:"NORAD_CAT_ID"`
			MeanMo float64 `json:"MEAN_MOTION"`
		}
		if json.Unmarshal(raw, &rec) == nil && rec.NORAD == spherexNORAD && rec.MeanMo > 0 && rec.Epoch != "" {
			return raw, rec.Name, rec.Epoch, nil
		}
	}
	return nil, "", "", fmt.Errorf("celestrak: no element set for NORAD %d", spherexNORAD)
}

func (a *App) spherexTLE(ctx context.Context) (TLEResp, error) {
	const key = "spherex-tle-63182"
	if v, ok := a.mem.Get(key); ok {
		return v.(TLEResp), nil
	}
	v, err := a.flight.Do(key, func() (any, error) {
		var cached TLEResp
		if a.cache.ReadJSON("orbit", hashKey(key), 6*time.Hour, &cached) {
			return cached, nil
		}
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 40*time.Second)
		defer cancel()
		body, err := fetchBytes(fctx, celestrakURL, FetchOpts{Attempts: 2, PerAttempt: 15 * time.Second, Label: "celestrak",
			Validate: func(b []byte) error { _, _, _, err := parseOMM(b); return err }})
		if err == nil {
			raw, name, epoch, perr := parseOMM(body)
			if perr == nil {
				r := TLEResp{NORAD: spherexNORAD, Name: name, Epoch: epoch, Source: "CelesTrak GP", Fetched: time.Now().UTC().Format(time.RFC3339), OMM: raw}
				a.cache.WriteJSON("orbit", hashKey(key), r)
				return r, nil
			}
			err = perr
		}
		// stale disk copy, any age
		if a.cache.ReadJSON("orbit", hashKey(key), 0, &cached) {
			cached.Stale = true
			return cached, nil
		}
		raw, name, epoch, _ := parseOMM([]byte("[" + builtinSpherexOMM + "]"))
		return TLEResp{NORAD: spherexNORAD, Name: name, Epoch: epoch, Source: "built-in copy (CelesTrak unreachable: " + err.Error() + ")", Fetched: "2026-11-14T02:00:00Z", Stale: true, OMM: raw}, nil
	})
	if err != nil {
		return TLEResp{}, err
	}
	r := v.(TLEResp)
	ttl := 6 * time.Hour
	if r.Stale {
		ttl = 10 * time.Minute // retry upstream soon
	}
	a.mem.Set(key, r, ttl)
	return r, nil
}

func (a *App) handleSpherexTLE(w http.ResponseWriter, r *http.Request) error {
	resp, err := a.spherexTLE(r.Context())
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "public, max-age=1800")
	writeJSON(w, 200, resp)
	return nil
}

// ---------------------------------------------------------------------------
// Heliocentric vectors (JPL Horizons)
// ---------------------------------------------------------------------------

// VecPoint is [jd_tdb, x, y, z] in au, Sun centred, ecliptic J2000.
type VecPoint [4]float64

type OrbitBody struct {
	Name       string     `json:"name"`
	ID         string     `json:"id,omitempty"`
	PeriodDays float64    `json:"period_days,omitempty"`
	Points     []VecPoint `json:"points"`
	Now        *VecPoint  `json:"now,omitempty"`
}

type OrbitResp struct {
	Name    string      `json:"name"`
	Center  string      `json:"center"`
	Frame   string      `json:"frame"`
	Units   string      `json:"units"`
	Start   string      `json:"start"`
	Stop    string      `json:"stop"`
	Step    string      `json:"step"`
	NowJD   float64     `json:"now_jd"`
	Object  OrbitBody   `json:"object"`
	Planets []OrbitBody `json:"planets"`
	Warning string      `json:"warning,omitempty"`
}

var planetDefs = []struct {
	Name, ID string
	Period   float64 // days
}{
	{"Mercury", "199", 87.969}, {"Venus", "299", 224.701}, {"Earth", "399", 365.256},
	{"Mars", "499", 686.980}, {"Jupiter", "599", 4332.59},
}

func horizonsVectorsURL(command string, start, stop time.Time, step string) string {
	q := url.Values{}
	q.Set("format", "json")
	q.Set("COMMAND", "'"+command+"'")
	q.Set("OBJ_DATA", "NO")
	q.Set("MAKE_EPHEM", "YES")
	q.Set("EPHEM_TYPE", "VECTORS")
	q.Set("CENTER", "'500@10'")
	q.Set("REF_PLANE", "ECLIPTIC")
	q.Set("REF_SYSTEM", "ICRF")
	q.Set("START_TIME", "'"+start.UTC().Format("2006-01-02 15:04")+"'")
	q.Set("STOP_TIME", "'"+stop.UTC().Format("2006-01-02 15:04")+"'")
	q.Set("STEP_SIZE", "'"+step+"'")
	q.Set("VEC_TABLE", "1")
	q.Set("OUT_UNITS", "AU-D")
	q.Set("CSV_FORMAT", "YES")
	return "https://ssd.jpl.nasa.gov/api/horizons.api?" + q.Encode()
}

// parseVectors reads the $$SOE..$$EOE rows "JDTDB, Calendar, X, Y, Z," of a
// Horizons VECTORS (VEC_TABLE=1, CSV) JSON response.
func parseVectors(b []byte) (string, []VecPoint, error) {
	var r horizonsResp
	if err := json.Unmarshal(b, &r); err != nil {
		return "", nil, fmt.Errorf("horizons: %w", err)
	}
	if r.Error != "" {
		return "", nil, fmt.Errorf("horizons: %s", r.Error)
	}
	res := r.Result
	i, j := strings.Index(res, "$$SOE"), strings.Index(res, "$$EOE")
	if i < 0 || j < i {
		return "", nil, horizonsNoEphemError(res)
	}
	target := ""
	if m := targetRe.FindStringSubmatch(res); m != nil {
		target = strings.TrimSpace(m[1])
	}
	var pts []VecPoint
	sc := bufio.NewScanner(strings.NewReader(res[i+5 : j]))
	for sc.Scan() {
		f := strings.Split(sc.Text(), ",")
		if len(f) < 5 {
			continue
		}
		var p VecPoint
		ok := true
		for k, col := range []int{0, 2, 3, 4} {
			v, err := strconv.ParseFloat(strings.TrimSpace(f[col]), 64)
			if err != nil || math.IsNaN(v) {
				ok = false
				break
			}
			p[k] = v
		}
		if ok {
			pts = append(pts, p)
		}
	}
	if len(pts) == 0 {
		return target, nil, fmt.Errorf("horizons: empty vector table")
	}
	return target, pts, nil
}

var stepRe = regexp.MustCompile(`^(\d{1,5})\s*(m|h|d)$`)

// parseStep validates a Horizons step like "2 d", "12 h", "30 m" and returns its length.
func parseStep(s string) (string, time.Duration, error) {
	m := stepRe.FindStringSubmatch(strings.ToLower(strings.TrimSpace(s)))
	if m == nil {
		return "", 0, errBad("bad_param", "step must look like 2 d, 12 h or 30 m")
	}
	n, _ := strconv.Atoi(m[1])
	if n <= 0 {
		return "", 0, errBad("bad_param", "step must be positive")
	}
	unit := map[string]time.Duration{"m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
	return fmt.Sprintf("%d %s", n, m[2]), time.Duration(n) * unit, nil
}

// autoStep picks a whole-hour step giving about n samples over the span.
func autoStep(span time.Duration, n int) string {
	h := int(math.Round(span.Hours() / float64(n)))
	if h < 1 {
		h = 1
	}
	if h%24 == 0 {
		return fmt.Sprintf("%d d", h/24)
	}
	return fmt.Sprintf("%d h", h)
}

// vectors fetches and caches one Horizons vector table. Past ranges are cached
// on disk forever, others for maxAge; an old disk copy is served if Horizons fails.
func (a *App) vectors(ctx context.Context, command string, start, stop time.Time, step string, maxAge time.Duration) (string, []VecPoint, error) {
	u := horizonsVectorsURL(command, start, stop, step)
	key := hashKey("horizons-vec", u)
	type res struct {
		Target string     `json:"target"`
		Points []VecPoint `json:"points"`
	}
	if v, ok := a.mem.Get(key); ok {
		r := v.(res)
		return r.Target, r.Points, nil
	}
	v, err := a.jpl.flight.Do(key, func() (any, error) {
		var c res
		age := maxAge
		if stop.Before(time.Now().Add(-48 * time.Hour)) {
			age = 0
		}
		if a.cache.ReadJSON("orbit", key, age, &c) && len(c.Points) > 0 {
			return c, nil
		}
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		body, err := fetchBytes(fctx, u, FetchOpts{Attempts: 3, PerAttempt: 60 * time.Second, Sem: a.jpl.sem, Label: "horizons-vectors"})
		if err != nil {
			if a.cache.ReadJSON("orbit", key, 0, &c) && len(c.Points) > 0 {
				return c, nil
			}
			return nil, errUpstream("JPL Horizons failed: " + err.Error())
		}
		t, pts, err := parseVectors(body)
		if err != nil {
			return nil, err
		}
		c = res{t, pts}
		a.cache.WriteJSON("orbit", key, c)
		return c, nil
	})
	if err != nil {
		return "", nil, err
	}
	r := v.(res)
	a.mem.Set(key, r, 6*time.Hour)
	return r.Target, r.Points, nil
}

// objectVectors tries each COMMAND form for a user-typed name (aliases such as 3I/ATLAS included).
func (a *App) objectVectors(ctx context.Context, name string, start, stop time.Time, step string) (string, []VecPoint, error) {
	var lastErr error
	for _, cmd := range horizonsCommands(name) {
		t, pts, err := a.vectors(ctx, cmd, start, stop, step, 6*time.Hour)
		if err == nil {
			return t, pts, nil
		}
		lastErr = err
		if ae, ok := err.(*apiError); ok && ae.Code == "upstream" {
			break
		}
	}
	return "", nil, lastErr
}

func timeToJD(t time.Time) float64 { return float64(t.UnixMilli())/86400000.0 + 2440587.5 }

func (a *App) planetOrbits(ctx context.Context, today time.Time) []OrbitBody {
	out := make([]OrbitBody, len(planetDefs))
	var wg sync.WaitGroup
	for i, p := range planetDefs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			span := time.Duration(p.Period*24) * time.Hour
			step := autoStep(span, 200)
			_, sd, _ := parseStep(step)
			_, pts, err := a.vectors(ctx, p.ID, today, today.Add(span+sd), step, 36*time.Hour)
			b := OrbitBody{Name: p.Name, ID: p.ID, PeriodDays: p.Period, Points: pts}
			if err == nil && len(pts) > 0 {
				first := pts[0]
				b.Now = &first
			}
			out[i] = b
		}()
	}
	wg.Wait()
	return out
}

func (a *App) handleOrbit(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	name := strings.TrimSpace(q.Get("name"))
	if name == "" {
		name = "3I/ATLAS"
	}
	if len(name) > 80 {
		return errBad("bad_param", "name is too long")
	}
	now := time.Now().UTC()
	today := now.Truncate(24 * time.Hour)
	start, err := parseWhen(q.Get("start"), today.AddDate(0, -9, 0))
	if err != nil {
		return err
	}
	stop, err := parseWhen(q.Get("stop"), today.AddDate(0, 9, 0))
	if err != nil {
		return err
	}
	if !stop.After(start) {
		return errBad("bad_param", "stop must be after start")
	}
	if stop.Sub(start) > 20*365*24*time.Hour {
		return errBad("bad_param", "time span is limited to 20 years")
	}
	step := strings.TrimSpace(q.Get("step"))
	if step == "" {
		step = autoStep(stop.Sub(start), 400)
	}
	step, sd, err := parseStep(step)
	if err != nil {
		return err
	}
	if n := stop.Sub(start) / sd; n > 3000 {
		return errBad("bad_param", fmt.Sprintf("too many points (%d); use a larger step", n))
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()

	var (
		wg      sync.WaitGroup
		planets []OrbitBody
		nowPts  []VecPoint
		nowErr  error
	)
	wg.Add(2)
	go func() { defer wg.Done(); planets = a.planetOrbits(ctx, today) }()
	go func() {
		defer wg.Done()
		_, nowPts, nowErr = a.objectVectors(ctx, name, today, today.Add(24*time.Hour), "1 d")
	}()
	target, pts, err := a.objectVectors(ctx, name, start, stop, step)
	wg.Wait()
	if err != nil {
		return err
	}
	resp := OrbitResp{
		Name: name, Center: "Sun (body centre)", Frame: "ecliptic J2000 (ICRF)", Units: "au",
		Start: start.Format(time.RFC3339), Stop: stop.Format(time.RFC3339), Step: step,
		NowJD:   timeToJD(now),
		Object:  OrbitBody{Name: target, Points: pts},
		Planets: planets,
	}
	if nowErr == nil && len(nowPts) > 0 {
		p := nowPts[0]
		resp.Object.Now = &p
	}
	for _, p := range planets {
		if len(p.Points) == 0 {
			resp.Warning = "some planet orbits could not be loaded from JPL Horizons"
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, 200, resp)
	return nil
}

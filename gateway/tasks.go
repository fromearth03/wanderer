package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Spectrum: aperture photometry of one position in many epochs.
// ---------------------------------------------------------------------------

type SpecPoint struct {
	ID      string   `json:"id"`
	Det     int      `json:"det"`
	MJD     float64  `json:"mjd"`
	WaveUm  *float64 `json:"wave_um"`
	BandUm  *float64 `json:"bandwidth_um"`
	Flux    *float64 `json:"flux"`
	Err     *float64 `json:"err"`
	OK      bool     `json:"ok"`
	Reason  string   `json:"reason,omitempty"`
	BadFrac float64  `json:"bad_fraction"`
}

// pickSpread chooses up to max epochs spread across detectors (and so across
// wavelength) and, within a detector, evenly across time.
func pickSpread(eps []Epoch, max int) []Epoch {
	if len(eps) <= max {
		return eps
	}
	byDet := map[int][]Epoch{}
	for _, e := range eps {
		byDet[e.Det] = append(byDet[e.Det], e)
	}
	dets := make([]int, 0, len(byDet))
	for d := range byDet {
		dets = append(dets, d)
	}
	sort.Ints(dets)
	quota := map[int]int{}
	left := max
	for left > 0 {
		progress := false
		for _, d := range dets {
			if left == 0 {
				break
			}
			if quota[d] < len(byDet[d]) {
				quota[d]++
				left--
				progress = true
			}
		}
		if !progress {
			break
		}
	}
	var out []Epoch
	for _, d := range dets {
		list, n := byDet[d], quota[d]
		for i := 0; i < n; i++ {
			idx := int(math.Round(float64(i) * float64(len(list)-1) / math.Max(float64(n-1), 1)))
			if n == 1 {
				idx = len(list) / 2
			}
			out = append(out, list[idx])
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MJD < out[j].MJD })
	return out
}

func (a *App) handleSpectrum(w http.ResponseWriter, r *http.Request) error {
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	coll, err := qCollection(r)
	if err != nil {
		return err
	}
	max, err := qInt(r, "max", 60)
	if err != nil {
		return err
	}
	if max < 1 {
		max = 1
	}
	if max > 120 {
		max = 120
	}
	rArc, err := qFloat(r, "r", 12, false)
	if err != nil {
		return err
	}
	rArc = math.Min(math.Max(rArc, 4), 60)
	key := spectrumKey(coll, ra, dec, max, rArc)
	id := a.jobs.StartWith("spectrum", key, qForce(r), func(ctx context.Context, report Reporter) (any, error) {
		return a.runSpectrum(ctx, report, coll, ra, dec, max, rArc)
	})
	writeJSON(w, 202, map[string]string{"job": id})
	return nil
}

func spectrumKey(coll string, ra, dec float64, max int, rArc float64) string {
	return fmt.Sprintf("spectrum|%s|%.5f|%.5f|%d|%.1f", coll, ra, dec, max, rArc)
}

func trackKey(cmd string, start, stop time.Time, coll string, max int) string {
	return fmt.Sprintf("track|%s|%s|%s|%s|%d", strings.ToLower(cmd), start.Format(time.RFC3339), stop.Format(time.RFC3339), coll, max)
}

// qForce: force=1 reruns a job even when a saved result exists.
func qForce(r *http.Request) bool {
	v := r.URL.Query().Get("force")
	return v == "1" || v == "true"
}

func (a *App) runSpectrum(ctx context.Context, report Reporter, coll string, ra, dec float64, max int, rArc float64) (any, error) {
	report(0.01, "finding SPHEREx images")
	eps, err := a.irsa.Query(ctx, coll, ra, dec, 0.001, 0, 0)
	if err != nil {
		return nil, err
	}
	if len(eps) == 0 {
		return nil, errNotFound("no_data", "no SPHEREx images cover this position")
	}
	sel := pickSpread(eps, max)
	// cutout big enough for the aperture + annulus
	size := int(math.Ceil(rArc*3.5*2/6.15)) + 12
	if size < 48 {
		size = 48
	}
	points := make([]SpecPoint, len(sel))
	var mu sync.Mutex
	done := 0
	var wg sync.WaitGroup
	work := make(chan int)
	for wk := 0; wk < 4; wk++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				e := sel[i]
				pt := SpecPoint{ID: e.ID, Det: e.Det, MJD: e.MJD}
				p, err := a.irsa.Cutout(ctx, e, ra, dec, size)
				if err == nil {
					var res struct {
						Flux    *float64 `json:"flux"`
						Err     *float64 `json:"err"`
						Wave    *float64 `json:"wave_um"`
						Band    *float64 `json:"bandwidth_um"`
						MJD     *float64 `json:"mjd"`
						OK      bool     `json:"ok"`
						Reason  string   `json:"reason"`
						BadFrac float64  `json:"bad_fraction"`
					}
					err = a.sci.Call(ctx, "/photometry", map[string]any{"fits": p, "ra": ra, "dec": dec, "r_arcsec": rArc}, &res)
					if err == nil {
						pt.Flux, pt.Err, pt.WaveUm, pt.BandUm, pt.OK, pt.Reason, pt.BadFrac = res.Flux, res.Err, res.Wave, res.Band, res.OK, res.Reason, res.BadFrac
						if res.MJD != nil {
							pt.MJD = *res.MJD
						}
					}
				}
				if err != nil {
					pt.Reason = err.Error()
					SkipMemo(ctx) // a download or measurement failed: do not save this result
				}
				EmitPartial(ctx, pt)
				mu.Lock()
				points[i] = pt
				done++
				n := done
				mu.Unlock()
				report(0.02+0.97*float64(n)/float64(len(sel)), fmt.Sprintf("measured %d of %d images", n, len(sel)))
			}
		}()
	}
	for i := range sel {
		select {
		case work <- i:
		case <-ctx.Done():
		}
	}
	close(work)
	wg.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	sort.Slice(points, func(i, j int) bool {
		wi, wj := math.Inf(1), math.Inf(1)
		if points[i].WaveUm != nil {
			wi = *points[i].WaveUm
		}
		if points[j].WaveUm != nil {
			wj = *points[j].WaveUm
		}
		return wi < wj
	})
	good := 0
	for _, p := range points {
		if p.OK {
			good++
		}
	}
	return map[string]any{
		"ra": ra, "dec": dec, "collection": coll, "aperture_arcsec": rArc, "unit": "mJy",
		"total_epochs": len(eps), "used": len(sel), "good": good, "points": points,
	}, nil
}

// ---------------------------------------------------------------------------
// Track: SPHEREx images along a solar-system object's path.
// ---------------------------------------------------------------------------

func parseWhen(s string, def time.Time) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return def, nil
	}
	if v, err := strconv.ParseFloat(s, 64); err == nil && v > 40000 && v < 80000 {
		return mjdToTime(v), nil
	}
	for _, layout := range []string{"2006-01-02", "2006-01-02T15:04", "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05", "2006-01-02 15:04"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, errBad("bad_param", "dates must be YYYY-MM-DD, ISO 8601 or MJD")
}

var (
	defaultTrackStart = time.Date(2025, 4, 20, 0, 0, 0, 0, time.UTC)
	defaultTrackStop  = time.Date(2026, 5, 20, 0, 0, 0, 0, time.UTC)
)

type trackSample struct {
	RA, Dec, T0, T1 float64
}

// trackSamples picks sample points along the ephemeris: a new sample whenever
// the object moved stepDeg from the previous one or maxDays passed. Each sample's
// time window spans from the previous to the next sample (plus a margin).
func trackSamples(pts []EphemPoint, stepDeg, maxDays float64) []trackSample {
	if len(pts) == 0 {
		return nil
	}
	idx := []int{0}
	for i := 1; i < len(pts); i++ {
		l := pts[idx[len(idx)-1]]
		if angSep(l.RA, l.Dec, pts[i].RA, pts[i].Dec) >= stepDeg || pts[i].MJD-l.MJD >= maxDays {
			idx = append(idx, i)
		}
	}
	if last := len(pts) - 1; idx[len(idx)-1] != last {
		idx = append(idx, last)
	}
	out := make([]trackSample, 0, len(idx))
	for k, i := range idx {
		t0, t1 := pts[i].MJD, pts[i].MJD
		if k > 0 {
			t0 = pts[idx[k-1]].MJD
		}
		if k+1 < len(idx) {
			t1 = pts[idx[k+1]].MJD
		}
		margin := 0.05
		out = append(out, trackSample{RA: pts[i].RA, Dec: pts[i].Dec, T0: t0 - margin, T1: t1 + margin})
	}
	return out
}

// interpEphem returns the interpolated position at mjd (nil if outside).
func interpEphem(pts []EphemPoint, mjd float64) (EphemPoint, bool) {
	n := len(pts)
	if n == 0 || mjd < pts[0].MJD || mjd > pts[n-1].MJD {
		return EphemPoint{}, false
	}
	i := sort.Search(n, func(i int) bool { return pts[i].MJD >= mjd })
	if i == 0 {
		return pts[0], true
	}
	p0, p1 := pts[i-1], pts[i]
	f := (mjd - p0.MJD) / (p1.MJD - p0.MJD)
	dra := p1.RA - p0.RA
	if dra > 180 {
		dra -= 360
	} else if dra < -180 {
		dra += 360
	}
	ra := math.Mod(p0.RA+f*dra+360, 360)
	out := EphemPoint{MJD: mjd, RA: ra, Dec: p0.Dec + f*(p1.Dec-p0.Dec),
		RateRA: p0.RateRA + f*(p1.RateRA-p0.RateRA), RateDec: p0.RateDec + f*(p1.RateDec-p0.RateDec), Mag: p0.Mag}
	return out, true
}

type TrackFrame struct {
	Epoch   Epoch    `json:"epoch"`
	MJD     float64  `json:"mjd"`
	RA      float64  `json:"ra"`
	Dec     float64  `json:"dec"`
	RateRA  float64  `json:"rate_ra"`
	RateDec float64  `json:"rate_dec"`
	Mag     *float64 `json:"mag"`
}

func (a *App) handleTrack(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	name := strings.TrimSpace(q.Get("name"))
	if name == "" {
		return errBad("missing_param", "missing parameter: name")
	}
	// Default: the whole SPHEREx DR1 time span.
	start, err := parseWhen(q.Get("start"), defaultTrackStart)
	if err != nil {
		return err
	}
	stop, err := parseWhen(q.Get("stop"), defaultTrackStop)
	if err != nil {
		return err
	}
	if !stop.After(start) {
		return errBad("bad_param", "stop must be after start")
	}
	if stop.Sub(start) > 400*24*time.Hour {
		return errBad("bad_param", "track span is limited to 400 days")
	}
	coll, err := qCollection(r)
	if err != nil {
		return err
	}
	max, err := qInt(r, "max", 60)
	if err != nil {
		return err
	}
	max = int(math.Min(math.Max(float64(max), 1), 300))
	cmd := name
	if id, ok := planetIDs[strings.ToLower(name)]; ok {
		cmd = id
	}
	key := trackKey(cmd, start, stop, coll, max)
	id := a.jobs.StartWith("track", key, qForce(r), func(ctx context.Context, report Reporter) (any, error) {
		return a.runTrack(ctx, report, name, cmd, start, stop, coll, max)
	})
	writeJSON(w, 202, map[string]string{"job": id})
	return nil
}

func (a *App) runTrack(ctx context.Context, report Reporter, name, cmd string, start, stop time.Time, coll string, max int) (any, error) {
	report(0.02, "asking JPL Horizons for the path")
	span := stop.Sub(start)
	stepMin := int(math.Max(60, math.Ceil(span.Minutes()/400)))
	eph, err := a.jpl.Ephemeris(ctx, cmd, start, stop, fmt.Sprintf("%dm", stepMin))
	if err != nil {
		return nil, err
	}
	pts := eph.Points
	report(0.1, fmt.Sprintf("path has %d points; searching SPHEREx images", len(pts)))

	// IRSA answers small-circle queries in a few seconds but large circles take
	// close to a minute, so sample the path every ~0.5 deg (or 4 days) and ask for
	// images covering each sample point during the time the object is near it.
	// Each hit is then checked: the object's position at the image time must be
	// inside the image footprint.
	segs := trackSamples(pts, 0.5, 4)
	for step := 0.75; len(segs) > 400 && step <= 3; step += 0.25 {
		segs = trackSamples(pts, step, 8) // long or fast paths: sparser samples
	}
	if len(segs) > 400 {
		return nil, errBad("too_long", fmt.Sprintf("path needs %d sky searches; pick a shorter date range", len(segs)))
	}
	var mu sync.Mutex
	frames := map[string]TrackFrame{}
	done := 0
	var firstErr error
	var wg sync.WaitGroup
	work := make(chan trackSample)
	for wk := 0; wk < 4; wk++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for s := range work {
				eps, err := a.irsa.Query(ctx, coll, s.RA, s.Dec, 0.01, s.T0, s.T1)
				mu.Lock()
				done++
				n := done
				if err != nil && firstErr == nil {
					firstErr = err
				}
				for _, e := range eps {
					p, ok := interpEphem(pts, e.MJD)
					if !ok || !polygonContains(parsePolygon(e.Region), p.RA, p.Dec) {
						continue
					}
					if _, seen := frames[e.ID]; !seen {
						f := TrackFrame{Epoch: e, MJD: e.MJD, RA: round(p.RA, 6), Dec: round(p.Dec, 6), RateRA: p.RateRA, RateDec: p.RateDec, Mag: p.Mag}
						frames[e.ID] = f
						EmitPartial(ctx, f)
					}
				}
				nf := len(frames)
				mu.Unlock()
				report(0.1+0.88*float64(n)/float64(len(segs)), fmt.Sprintf("searched %d of %d path segments, %d images on the path", n, len(segs), nf))
			}
		}()
	}
	for _, s := range segs {
		select {
		case work <- s:
		case <-ctx.Done():
		}
	}
	close(work)
	wg.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if len(frames) == 0 && firstErr != nil {
		return nil, firstErr
	}
	if firstErr != nil {
		SkipMemo(ctx) // some sky searches failed: the frame list may be incomplete
	}
	list := make([]TrackFrame, 0, len(frames))
	for _, f := range frames {
		list = append(list, f)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].MJD < list[j].MJD })
	total := len(list)
	if len(list) > max {
		picked := make([]TrackFrame, 0, max)
		for i := 0; i < max; i++ {
			picked = append(picked, list[int(math.Round(float64(i)*float64(len(list)-1)/float64(max-1)))])
		}
		list = picked
	}
	// thin the ephemeris for the sky overlay
	path := pts
	if len(path) > 400 {
		stride := len(path) / 400
		var thin []EphemPoint
		for i := 0; i < len(path); i += stride + 1 {
			thin = append(thin, path[i])
		}
		path = thin
	}
	target := eph.Target
	if target == "" {
		target = name
	}
	return map[string]any{
		"name": name, "target": target, "collection": coll,
		"start": start.Format(time.RFC3339), "stop": stop.Format(time.RFC3339),
		"ephemeris": path, "frames": list, "total_frames": total,
	}, nil
}

// ---------------------------------------------------------------------------
// Movers: difference-image detections matched to JPL known bodies.
// ---------------------------------------------------------------------------

func (a *App) handleMovers(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	idA, idB := q.Get("a"), q.Get("b")
	if idA == "" || idB == "" {
		return errBad("missing_param", "parameters a and b (epoch ids) are required")
	}
	for _, id := range []string{idA, idB} {
		if _, _, _, err := parseEpochID(id); err != nil {
			return err
		}
	}
	size, err := qInt(r, "size", 200)
	if err != nil {
		return err
	}
	size = normSize(size)
	nsig, err := qFloat(r, "nsigma", 5, false)
	if err != nil {
		return err
	}
	vlim, err := qFloat(r, "vmag", 20, false)
	if err != nil {
		return err
	}
	key := fmt.Sprintf("movers|%s|%s|%.5f|%.5f|%d|%.1f|%.1f", idA, idB, ra, dec, size, nsig, vlim)
	id := a.jobs.StartWith("movers", key, qForce(r), func(ctx context.Context, report Reporter) (any, error) {
		return a.runMovers(ctx, report, idA, idB, ra, dec, size, nsig, vlim)
	})
	writeJSON(w, 202, map[string]string{"job": id})
	return nil
}

type KnownPx struct {
	Body
	X      *float64 `json:"x"`
	Y      *float64 `json:"y"`
	InView bool     `json:"in_view"`
}

func (a *App) runMovers(ctx context.Context, report Reporter, idA, idB string, ra, dec float64, size int, nsig, vlim float64) (any, error) {
	report(0.05, "downloading both images")
	var pa, pb string
	var errA, errB error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pa, _, errA = a.cutoutFor(ctx, idA, ra, dec, size) }()
	go func() { defer wg.Done(); pb, _, errB = a.cutoutFor(ctx, idB, ra, dec, size) }()
	wg.Wait()
	if errA != nil {
		return nil, errA
	}
	if errB != nil {
		return nil, errB
	}
	report(0.35, "subtracting the images and looking for sources")
	var det struct {
		Sources    []map[string]any `json:"sources"`
		Candidates int              `json:"candidates"`
		Rejected   int              `json:"rejected"`
		Reasons    map[string]int   `json:"rejected_reasons"`
		RMS        float64          `json:"rms"`
		MJDA       float64          `json:"mjd_a"`
		MJDB       float64          `json:"mjd_b"`
		Width      int              `json:"width"`
		Height     int              `json:"height"`
	}
	if err := a.sci.Call(ctx, "/detect", map[string]any{"a": pa, "b": pb, "nsigma": nsig}, &det); err != nil {
		return nil, err
	}
	report(0.5, fmt.Sprintf("%d candidate sources; asking JPL which known bodies were there", len(det.Sources)))
	radius := float64(size) * 6.15 / 3600 / 2 * 1.45
	var ka, kb []Body
	var eA, eB error
	wg.Add(2)
	go func() { defer wg.Done(); ka, eA = a.jpl.Known(ctx, "a", ra, dec, det.MJDA, radius, vlim) }()
	go func() { defer wg.Done(); kb, eB = a.jpl.Known(ctx, "a", ra, dec, det.MJDB, radius, vlim) }()
	wg.Wait()
	report(0.9, "matching detections to known bodies")
	project := func(bodies []Body) []KnownPx {
		out := make([]KnownPx, len(bodies))
		pts := make([][2]float64, len(bodies))
		for i, b := range bodies {
			out[i] = KnownPx{Body: b}
			pts[i] = [2]float64{b.RA, b.Dec}
		}
		if len(pts) == 0 {
			return out
		}
		var res struct {
			Pixels [][]float64 `json:"pixels"`
		}
		if a.sci.Call(ctx, "/project", map[string]any{"fits": pa, "points": pts}, &res) == nil {
			for i := range out {
				if i < len(res.Pixels) && len(res.Pixels[i]) == 2 {
					x, y := res.Pixels[i][0], res.Pixels[i][1]
					out[i].X, out[i].Y = &x, &y
					out[i].InView = x >= 0 && y >= 0 && x <= float64(det.Width) && y <= float64(det.Height)
				}
			}
		}
		return out
	}
	kpa, kpb := project(ka), project(kb)
	// match: negative blobs = in A only (body at time A), positive = in B only
	matchTol := 3.0 // pixels (~18 arcsec)
	for _, s := range det.Sources {
		sx, _ := s["x"].(float64)
		sy, _ := s["y"].(float64)
		sign, _ := s["sign"].(float64)
		list := kpb
		if sign < 0 {
			list = kpa
		}
		best, bestD := "", math.Inf(1)
		for _, k := range list {
			if k.X == nil {
				continue
			}
			d := math.Hypot(*k.X-sx, *k.Y-sy)
			if d < bestD {
				best, bestD = k.Name, d
			}
		}
		if bestD <= matchTol {
			s["match"] = best
			s["match_dist_px"] = round(bestD, 2)
		} else {
			s["match"] = nil
		}
	}
	diffURL := "/api/diff.png?" + url.Values{"a": {idA}, "b": {idB}, "ra": {fmt.Sprint(ra)}, "dec": {fmt.Sprint(dec)}, "size": {strconv.Itoa(size)}}.Encode()
	res := map[string]any{
		"a": idA, "b": idB, "ra": ra, "dec": dec, "size": size,
		"mjd_a": det.MJDA, "mjd_b": det.MJDB, "dt_hours": round((det.MJDB-det.MJDA)*24, 3),
		"rms": det.RMS, "sources": det.Sources,
		"candidates": det.Candidates, "rejected": det.Rejected, "rejected_reasons": det.Reasons, "known_a": kpa, "known_b": kpb,
		"diff_url": diffURL, "width": det.Width, "height": det.Height,
	}
	var warn []string
	if eA != nil {
		warn = append(warn, "JPL lookup for epoch A failed: "+eA.Error())
	}
	if eB != nil {
		warn = append(warn, "JPL lookup for epoch B failed: "+eB.Error())
	}
	if len(warn) > 0 {
		res["warnings"] = warn
	}
	return res, nil
}

package main

// False-colour SPHEREx images: three detectors of the same spot, from the same
// survey window, each stretched on its own and resampled onto one grid.
//   GET /api/rgb       ?ra&dec&collection[&near=MJD]  -> {r, g, b: Epoch, window}
//   GET /api/rgb.png   ?ra&dec&size&stretch[&r&g&b ids | &collection&near]

import (
	"context"
	"math"
	"net/http"
	"sort"
	"time"
)

// Channel detectors in order of preference: blue = short wave, red = long wave.
var rgbDets = map[string][]int{"b": {1, 2}, "g": {3, 4}, "r": {6, 5}}

type rgbPick struct {
	R      Epoch      `json:"r"`
	G      Epoch      `json:"g"`
	B      Epoch      `json:"b"`
	Window [2]float64 `json:"window"`
}

// pickRGB chooses one image per channel inside one survey window (gaps > 30
// days split windows), each the closest in time to the window's middle. When
// near > 0 the window containing (or closest to) that MJD is used.
func pickRGB(eps []Epoch, near float64) (rgbPick, bool) {
	sorted := append([]Epoch(nil), eps...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].MJD < sorted[j].MJD })
	var wins [][]Epoch
	for _, e := range sorted {
		if n := len(wins); n > 0 && e.MJD-wins[n-1][len(wins[n-1])-1].MJD < 30 {
			wins[n-1] = append(wins[n-1], e)
		} else {
			wins = append(wins, []Epoch{e})
		}
	}
	if near > 0 {
		sort.SliceStable(wins, func(i, j int) bool { return winDist(wins[i], near) < winDist(wins[j], near) })
	}
	for _, w := range wins {
		mid := (w[0].MJD + w[len(w)-1].MJD) / 2
		var p rgbPick
		ok := true
		for _, ch := range []string{"b", "g", "r"} {
			var best *Epoch
			for _, det := range rgbDets[ch] {
				for i := range w {
					if w[i].Det == det && (best == nil || math.Abs(w[i].MJD-mid) < math.Abs(best.MJD-mid)) {
						best = &w[i]
					}
				}
				if best != nil {
					break
				}
			}
			if best == nil {
				ok = false
				break
			}
			switch ch {
			case "b":
				p.B = *best
			case "g":
				p.G = *best
			case "r":
				p.R = *best
			}
		}
		if ok {
			p.Window = [2]float64{w[0].MJD, w[len(w)-1].MJD}
			return p, true
		}
	}
	return rgbPick{}, false
}

func winDist(w []Epoch, t float64) float64 {
	if t < w[0].MJD {
		return w[0].MJD - t
	}
	if t > w[len(w)-1].MJD {
		return t - w[len(w)-1].MJD
	}
	return 0
}

func (a *App) rgbPickFor(ctx context.Context, r *http.Request, ra, dec float64) (rgbPick, error) {
	coll, err := qCollection(r)
	if err != nil {
		return rgbPick{}, err
	}
	near, err := qFloat(r, "near", 0, false)
	if err != nil {
		return rgbPick{}, err
	}
	eps, err := a.irsa.Query(ctx, coll, ra, dec, 0.001, 0, 0)
	if err != nil {
		return rgbPick{}, err
	}
	p, ok := pickRGB(eps, near)
	if !ok {
		return rgbPick{}, errNotFound("no_rgb", "no survey window has short, middle and long wavelength images of this spot")
	}
	return p, nil
}

func (a *App) handleRGBPick(w http.ResponseWriter, r *http.Request) error {
	ra, dec, err := qPos(r)
	if err != nil {
		return err
	}
	ctx, cancel := reqCtx(r, 3*time.Minute)
	defer cancel()
	p, err := a.rgbPickFor(ctx, r, ra, dec)
	if err != nil {
		return err
	}
	writeJSON(w, 200, p)
	return nil
}

func (a *App) handleRGBPNG(w http.ResponseWriter, r *http.Request) error {
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
	switch stretch {
	case "asinh", "linear", "log", "sqrt", "zscale":
	default:
		return errBad("bad_param", "stretch must be asinh, linear, log, sqrt or zscale")
	}
	ctx, cancel := reqCtx(r, 5*time.Minute)
	defer cancel()
	idR, idG, idB := q.Get("r"), q.Get("g"), q.Get("b")
	if idR == "" || idG == "" || idB == "" {
		p, err := a.rgbPickFor(ctx, r, ra, dec)
		if err != nil {
			return err
		}
		idR, idG, idB = p.R.ID, p.G.ID, p.B.ID
	}
	paths := make([]string, 3)
	errs := make([]error, 3)
	done := make(chan struct{}, 3)
	for i, id := range []string{idR, idG, idB} {
		go func() {
			paths[i], _, errs[i] = a.cutoutFor(ctx, id, ra, dec, size)
			done <- struct{}{}
		}()
	}
	for range 3 {
		<-done
	}
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	key := hashKey("rgb", paths[0], paths[1], paths[2], stretch)
	out := a.cache.Path("png", key, ".png")
	if !exists(out) {
		if _, err := a.flight.Do(key, func() (any, error) {
			var res map[string]any
			err := a.sci.Call(ctx, "/rgb", map[string]any{"r": paths[0], "g": paths[1], "b": paths[2], "out": out, "stretch": stretch, "sub": "zodi"}, &res)
			return res, err
		}); err != nil {
			return err
		}
	} else {
		touch(out)
	}
	w.Header().Set("X-RGB-R", idR)
	w.Header().Set("X-RGB-G", idG)
	w.Header().Set("X-RGB-B", idB)
	servePNG(w, r, out)
	return nil
}

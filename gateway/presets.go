package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"
)

//go:embed presets/presets.json
var presetsJSON []byte

// PresetEpoch is an epoch the preset recommends. URL is the IBE access URL; it is
// registered at startup so preset ids work before any /api/epochs call.
type PresetEpoch struct {
	Epoch
	URL string `json:"url"`
}

type presetFile struct {
	Presets []struct {
		Preset
		Sources []PresetEpoch `json:"sources"`
	} `json:"presets"`
}

// Preset is a curated, verified demo target (see presets/VERIFIED.md).
type Preset struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	LookFor     string         `json:"look_for"`
	View        string         `json:"view"` // blink | diff | flipbook | spectrum | track
	RA          float64        `json:"ra"`
	Dec         float64        `json:"dec"`
	Collection  string         `json:"collection"`
	Size        int            `json:"size"`
	Stretch     string         `json:"stretch,omitempty"`
	Cmap        string         `json:"cmap,omitempty"`
	Sub         string         `json:"sub,omitempty"`
	Detector    int            `json:"detector,omitempty"`
	Epochs      []string       `json:"epochs"`             // recommended epoch ids, in display order (first two = blink pair)
	Track       map[string]any `json:"track,omitempty"`    // {name, start, stop} for /api/track
	Spectrum    map[string]any `json:"spectrum,omitempty"` // {max, r} for /api/spectrum
	Markers     []Marker       `json:"markers,omitempty"`  // things to point at
	Frames      []PresetFrame  `json:"frames,omitempty"`   // per-epoch centres (track presets)
	Credits     string         `json:"credits,omitempty"`
	epochs      []PresetEpoch
}

// PresetFrame is one epoch shown centred on a moving object.
type PresetFrame struct {
	ID   string  `json:"id"`
	RA   float64 `json:"ra"`
	Dec  float64 `json:"dec"`
	MJD  float64 `json:"mjd"`
	Note string  `json:"note,omitempty"`
}

type Marker struct {
	Label string  `json:"label"`
	RA    float64 `json:"ra"`
	Dec   float64 `json:"dec"`
	MJD   float64 `json:"mjd,omitempty"`
}

func loadPresets() ([]Preset, error) {
	var f presetFile
	if err := json.Unmarshal(presetsJSON, &f); err != nil {
		return nil, err
	}
	out := make([]Preset, 0, len(f.Presets))
	for _, p := range f.Presets {
		pr := p.Preset
		pr.epochs = p.Sources
		if pr.Epochs == nil {
			pr.Epochs = []string{}
		}
		if _, ok := collections[pr.Collection]; !ok {
			return nil, fmt.Errorf("preset %s: bad collection %q", pr.ID, pr.Collection)
		}
		out = append(out, pr)
	}
	return out, nil
}

func (p Preset) registryEpochs() []Epoch {
	out := make([]Epoch, 0, len(p.epochs))
	for _, s := range p.epochs {
		e := s.Epoch
		e.AccessURL = s.URL
		if e.ID == "" || e.AccessURL == "" {
			continue
		}
		out = append(out, e)
	}
	return out
}

// WarmPresets fills the cache for every preset (SIA lists, cutouts, PNGs,
// diffs, JPL overlays) so the demo is instant even on a fresh server.
func (a *App) WarmPresets(ctx context.Context) {
	start := time.Now()
	go a.warmHiPS(ctx)
	for _, p := range a.presets {
		if ctx.Err() != nil {
			return
		}
		pctx, cancel := context.WithTimeout(ctx, 40*time.Minute)
		if _, err := a.irsa.Query(pctx, p.Collection, p.RA, p.Dec, 0.001, 0, 0); err != nil {
			slog.Warn("warm: epochs", "preset", p.ID, "err", err)
		}
		stretch, cmap, sub := orDefault(p.Stretch, "asinh"), orDefault(p.Cmap, "gray"), orDefault(p.Sub, "zodi")
		size := normSize(p.Size)
		// Fetch in parallel; the IRSA semaphore keeps it at 4 requests at a time.
		var wg sync.WaitGroup
		for i, id := range p.Epochs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := a.warmPNG(pctx, id, "", p.RA, p.Dec, size, stretch, cmap, sub); err != nil {
					slog.Warn("warm: cutout", "preset", p.ID, "id", id, "err", err)
				}
				if i > 0 && (p.View == "blink" || p.View == "flipbook") {
					if err := a.warmPNG(pctx, id, p.Epochs[0], p.RA, p.Dec, size, stretch, cmap, sub); err != nil {
						slog.Warn("warm: aligned", "preset", p.ID, "id", id, "err", err)
					}
				}
			}()
		}
		for _, f := range p.Frames {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := a.warmPNG(pctx, f.ID, "", f.RA, f.Dec, size, stretch, cmap, sub); err != nil {
					slog.Warn("warm: frame", "preset", p.ID, "id", f.ID, "err", err)
				}
			}()
		}
		wg.Wait()
		if len(p.Epochs) >= 2 && (p.View == "blink" || p.View == "diff") {
			if _, _, err := a.diff(pctx, p.Epochs[0], p.Epochs[1], p.RA, p.Dec, size, "linear"); err != nil {
				slog.Warn("warm: diff", "preset", p.ID, "err", err)
			}
			for _, id := range p.Epochs[:2] {
				if m, err := a.meta(pctx, id, p.RA, p.Dec, size); err == nil {
					if mjd, ok := m["mjd"].(float64); ok {
						_, _ = a.jpl.Known(pctx, "a", p.RA, p.Dec, mjd, 0.2, 20)
					}
				}
			}
		}
		if p.View == "spectrum" && p.Spectrum != nil {
			max, _ := p.Spectrum["max"].(float64)
			r, _ := p.Spectrum["r"].(float64)
			if max <= 0 {
				max = 60
			}
			if r <= 0 {
				r = 12
			}
			// Run it as a job so the result is memoized (the page then opens it at
			// once) and a visitor asking meanwhile attaches to the same job.
			coll, ra, dec, mx := p.Collection, p.RA, p.Dec, int(max)
			key := spectrumKey(coll, ra, dec, mx, r)
			if _, ok := a.jobs.Memo(key); !ok {
				id := a.jobs.Start("spectrum", key, func(ctx context.Context, report Reporter) (any, error) {
					return a.runSpectrum(ctx, report, coll, ra, dec, mx, r)
				})
				if jb, err := a.jobs.Wait(pctx, id); err != nil || jb.State == JobError {
					slog.Warn("warm: spectrum", "preset", p.ID, "err", err, "msg", jb.Message)
				}
			}
		}
		if p.View == "track" && p.Track != nil {
			name, _ := p.Track["name"].(string)
			st, _ := p.Track["start"].(string)
			sp, _ := p.Track["stop"].(string)
			t0, err0 := parseWhen(st, time.Time{})
			t1, err1 := parseWhen(sp, time.Time{})
			if name != "" && err0 == nil && err1 == nil && t1.After(t0) {
				a.warmTrack(pctx, p.ID, name, t0, t1, p.Collection)
			}
		}
		if p.View == "flipbook" {
			// The flipbook page plays up to 48 epochs of one detector picked evenly
			// from /api/epochs (default max 3000); warm exactly those.
			if all, err := a.irsa.Query(pctx, p.Collection, p.RA, p.Dec, 0.001, 0, 0); err == nil {
				thin := all
				if len(thin) > 3000 {
					thin = make([]Epoch, 0, 3000)
					for i := 0; i < 3000; i++ {
						thin = append(thin, all[i*len(all)/3000])
					}
				}
				var det []Epoch
				for _, e := range thin {
					if e.Det == p.Detector {
						det = append(det, e)
					}
				}
				pick := det
				if len(det) > 48 {
					pick = make([]Epoch, 48)
					for i := range pick {
						pick[i] = det[int(math.Round(float64(i)*float64(len(det)-1)/47))]
					}
				}
				a.warmMany(pctx, p.ID, len(pick), func(i int) error {
					return a.warmPNG(pctx, pick[i].ID, "", p.RA, p.Dec, size, stretch, cmap, sub)
				})
			}
		}
		cancel()
		slog.Info("warm: preset ready", "preset", p.ID)
	}
	// The Track page's default: a name and no dates (the whole DR1 span).
	for _, name := range []string{"3I/ATLAS"} {
		tctx, cancel := context.WithTimeout(ctx, 60*time.Minute)
		a.warmTrack(tctx, "track-default", name, defaultTrackStart, defaultTrackStop, "spherex_dr1")
		cancel()
	}
	slog.Info("warm: all presets ready", "ms", time.Since(start).Milliseconds())
}

func (a *App) warmPNG(ctx context.Context, id, align string, ra, dec float64, size int, stretch, cmap, sub string) error {
	if _, err := a.meta(ctx, id, ra, dec, size); err != nil {
		return err
	}
	fitsPath, _, err := a.cutoutFor(ctx, id, ra, dec, size)
	if err != nil {
		return err
	}
	req := map[string]any{"fits": fitsPath, "stretch": stretch, "cmap": cmap, "sub": sub}
	key := hashKey("png", fitsPath, stretch, cmap, sub)
	if align != "" {
		refPath, _, err := a.cutoutFor(ctx, align, ra, dec, size)
		if err != nil {
			return err
		}
		key = hashKey("png-aligned", fitsPath, refPath, stretch, cmap, sub)
		req["ref"] = refPath
	}
	out := a.cache.Path("png", key, ".png")
	if exists(out) {
		return nil
	}
	req["out"] = out
	return a.sci.Call(ctx, "/render", req, nil)
}

// warmMany runs fn(0..n-1) with a few workers (IRSA's semaphore caps real fetches at 4).
func (a *App) warmMany(ctx context.Context, preset string, n int, fn func(i int) error) {
	var wg sync.WaitGroup
	work := make(chan int)
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				if err := fn(i); err != nil {
					slog.Warn("warm: item", "preset", preset, "i", i, "err", err)
				}
			}
		}()
	}
	for i := 0; i < n && ctx.Err() == nil; i++ {
		work <- i
	}
	close(work)
	wg.Wait()
}

// warmTrack runs a track and caches every returned frame exactly as the Track
// page requests its stamps (64 px, asinh, gray, zodi subtracted).
func (a *App) warmTrack(ctx context.Context, label, name string, t0, t1 time.Time, coll string) {
	cmd := name
	if id, ok := planetIDs[strings.ToLower(name)]; ok {
		cmd = id
	}
	key := trackKey(cmd, t0, t1, coll, 60)
	var out struct {
		Frames []TrackFrame `json:"frames"`
	}
	if b, ok := a.jobs.Memo(key); ok && json.Unmarshal(b, &out) == nil {
		// saved result: only the stamps below may still need warming
	} else {
		res, err := a.runTrack(ctx, func(float64, string) {}, name, cmd, t0, t1, coll, 60)
		if err != nil {
			slog.Warn("warm: track", "preset", label, "name", name, "err", err)
			return
		}
		a.jobs.putMemo(key, res)
		m, _ := res.(map[string]any)
		out.Frames, _ = m["frames"].([]TrackFrame)
	}
	frames := out.Frames
	a.warmMany(ctx, label, len(frames), func(i int) error {
		f := frames[i]
		return a.warmPNG(ctx, f.Epoch.ID, "", f.RA, f.Dec, 64, "asinh", "gray", "zodi")
	})
	slog.Info("warm: track ready", "preset", label, "name", name, "frames", len(frames))
}

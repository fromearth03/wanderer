package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const siaBase = "https://irsa.ipac.caltech.edu/SIA"

var collections = map[string]string{ // collection -> short code used in ids
	"spherex_dr1":      "dr1",
	"spherex_dr1_deep": "deep",
}

func collectionFromShort(s string) (string, bool) {
	for k, v := range collections {
		if v == s {
			return k, true
		}
	}
	return "", false
}

// Epoch is one SPHEREx image (one detector of one exposure) covering a point.
type Epoch struct {
	ID         string  `json:"id"`
	ObsID      string  `json:"obs_id"`
	Det        int     `json:"det"`
	Band       string  `json:"band"`
	MJD        float64 `json:"mjd"`
	Date       string  `json:"date"`
	Exptime    float64 `json:"exptime"`
	EmMinUm    float64 `json:"em_min_um"`
	EmMaxUm    float64 `json:"em_max_um"`
	Collection string  `json:"collection"`

	AccessURL string `json:"-"`
	Region    string `json:"-"`
}

// epochRecord is what we persist for the id -> URL registry.
type epochRecord struct {
	Epoch
	URL    string `json:"url"`
	Region string `json:"region,omitempty"`
}

var idRe = regexp.MustCompile(`^([A-Za-z0-9_]+)_D([1-6])\.(dr1|deep)$`)

func makeEpochID(obsID string, det int, collection string) string {
	return fmt.Sprintf("%s_D%d.%s", obsID, det, collections[collection])
}

func parseEpochID(id string) (obsID string, det int, collection string, err error) {
	m := idRe.FindStringSubmatch(id)
	if m == nil {
		return "", 0, "", errBad("bad_id", "invalid epoch id: "+id)
	}
	det, _ = strconv.Atoi(m[2])
	collection, _ = collectionFromShort(m[3])
	return m[1], det, collection, nil
}

// parseSIACSV parses an IRSA SIA v2 CSV response. The trailing cloud_access
// column contains unquoted JSON with commas, so rows can have more fields than
// the header; every column we use comes before it, so mapping by header index
// is safe.
func parseSIACSV(body []byte, collection string) ([]Epoch, error) {
	r := csv.NewReader(bytes.NewReader(body))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.ReuseRecord = false
	header, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("sia: read header: %w", err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.TrimSpace(h)] = i
	}
	for _, need := range []string{"obs_id", "energy_bandpassname", "t_min", "access_url"} {
		if _, ok := col[need]; !ok {
			return nil, fmt.Errorf("sia: missing column %q (body starts %q)", need, snippet(body))
		}
	}
	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}
	num := func(rec []string, name string) float64 {
		v, err := strconv.ParseFloat(get(rec, name), 64)
		if err != nil {
			return math.NaN()
		}
		return v
	}
	var out []Epoch
	seen := map[string]bool{}
	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("sia: parse row: %w", err)
		}
		if t := get(rec, "dataproduct_type"); t != "" && t != "image" {
			continue
		}
		band := get(rec, "energy_bandpassname")
		det := 0
		if strings.HasPrefix(band, "SPHEREx-D") {
			det, _ = strconv.Atoi(strings.TrimPrefix(band, "SPHEREx-D"))
		}
		if det < 1 || det > 6 {
			continue
		}
		obsID := get(rec, "obs_id")
		coll := get(rec, "obs_collection")
		if coll == "" {
			coll = collection
		}
		if _, ok := collections[coll]; !ok {
			coll = collection
		}
		tmin, tmax := num(rec, "t_min"), num(rec, "t_max")
		mjd := tmin
		if !math.IsNaN(tmax) && tmax > tmin {
			mjd = (tmin + tmax) / 2
		}
		e := Epoch{
			ID:         makeEpochID(obsID, det, coll),
			ObsID:      obsID,
			Det:        det,
			Band:       band,
			MJD:        round(mjd, 6),
			Date:       mjdToTime(mjd).Format("2006-01-02T15:04:05Z"),
			Exptime:    zeroNaN(num(rec, "t_exptime")),
			EmMinUm:    round(zeroNaN(num(rec, "em_min"))*1e6, 4),
			EmMaxUm:    round(zeroNaN(num(rec, "em_max"))*1e6, 4),
			Collection: coll,
			AccessURL:  get(rec, "access_url"),
			Region:     get(rec, "s_region"),
		}
		if e.AccessURL == "" || seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].MJD == out[j].MJD {
			return out[i].Det < out[j].Det
		}
		return out[i].MJD < out[j].MJD
	})
	return out, nil
}

func zeroNaN(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func round(v float64, n int) float64 {
	p := math.Pow(10, float64(n))
	return math.Round(v*p) / p
}

// validateSIA rejects busy pages and HTML error pages that come back as HTTP 200.
func validateSIA(b []byte) error {
	head := b
	if len(head) > 400 {
		head = head[:400]
	}
	if !bytes.Contains(head, []byte("obs_id")) && !bytes.HasPrefix(bytes.TrimSpace(b), []byte("s_ra")) {
		return fmt.Errorf("sia: unexpected body %q", snippet(b))
	}
	return nil
}

func validateFITS(b []byte) error {
	if len(b) < 2880 || !bytes.HasPrefix(b, []byte("SIMPLE")) {
		return fmt.Errorf("not a FITS file (%d bytes): %q", len(b), snippet(b[:min(len(b), 80)]))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Registry: epoch id -> access URL, persisted so ids survive restarts.
// ---------------------------------------------------------------------------

type Registry struct {
	mu   sync.RWMutex
	m    map[string]epochRecord
	path string
	f    *os.File
}

func NewRegistry(dir string) (*Registry, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	r := &Registry{m: map[string]epochRecord{}, path: filepath.Join(dir, "epochs.jsonl")}
	if f, err := os.Open(r.path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var rec epochRecord
			if json.Unmarshal(sc.Bytes(), &rec) == nil && rec.ID != "" {
				r.m[rec.ID] = rec
			}
		}
		f.Close()
	}
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	r.f = f
	return r, nil
}

func (r *Registry) Add(eps []Epoch) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var buf bytes.Buffer
	for _, e := range eps {
		if old, ok := r.m[e.ID]; ok && old.URL == e.AccessURL {
			continue
		}
		rec := epochRecord{Epoch: e, URL: e.AccessURL, Region: e.Region}
		r.m[e.ID] = rec
		b, _ := json.Marshal(rec)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if buf.Len() > 0 && r.f != nil {
		_, _ = r.f.Write(buf.Bytes())
	}
}

func (r *Registry) Get(id string) (Epoch, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rec, ok := r.m[id]
	if !ok {
		return Epoch{}, false
	}
	e := rec.Epoch
	e.AccessURL = rec.URL
	e.Region = rec.Region
	return e, true
}

// ---------------------------------------------------------------------------
// IRSA client
// ---------------------------------------------------------------------------

type IRSA struct {
	sem    Sem
	cache  *DiskCache
	mem    *TTLCache
	flight Flight
	reg    *Registry
}

func siaURL(collection string, ra, dec, radius float64, tmin, tmax float64) string {
	q := url.Values{}
	q.Set("COLLECTION", collection)
	q.Set("POS", fmt.Sprintf("CIRCLE %.6f %.6f %g", ra, dec, radius))
	if tmin > 0 && tmax > tmin {
		q.Set("TIME", fmt.Sprintf("%.5f %.5f", tmin, tmax))
	}
	q.Set("RESPONSEFORMAT", "CSV")
	q.Set("MAXREC", "30000") // deep-field points have ~20k images
	// url.Values encodes spaces as '+', which IRSA accepts.
	return siaBase + "?" + q.Encode()
}

// Query runs an SIA query (cached in memory and on disk) and registers ids.
func (c *IRSA) Query(ctx context.Context, collection string, ra, dec, radius, tmin, tmax float64) ([]Epoch, error) {
	if _, ok := collections[collection]; !ok {
		return nil, errBad("bad_collection", "collection must be spherex_dr1 or spherex_dr1_deep")
	}
	u := siaURL(collection, ra, dec, radius, tmin, tmax)
	key := hashKey("sia", u)
	if v, ok := c.mem.Get(key); ok {
		return v.([]Epoch), nil
	}
	v, err := c.flight.Do(key, func() (any, error) {
		var recs []epochRecord
		if c.cache.ReadJSON("sia", key, 7*24*time.Hour, &recs) {
			eps := make([]Epoch, len(recs))
			for i, r := range recs {
				eps[i] = r.Epoch
				eps[i].AccessURL, eps[i].Region = r.URL, r.Region
			}
			return eps, nil
		}
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
		defer cancel()
		start := time.Now()
		body, err := fetchBytes(fctx, u, FetchOpts{Attempts: 4, PerAttempt: 90 * time.Second, Validate: validateSIA, Sem: c.sem, Label: "sia"})
		if err != nil {
			return nil, errUpstream("IRSA SIA query failed: " + err.Error())
		}
		eps, err := parseSIACSV(body, collection)
		if err != nil {
			return nil, errUpstream(err.Error())
		}
		slog.Info("sia query", "collection", collection, "ra", ra, "dec", dec, "radius", radius, "rows", len(eps), "ms", time.Since(start).Milliseconds())
		recs = make([]epochRecord, len(eps))
		for i, e := range eps {
			recs[i] = epochRecord{Epoch: e, URL: e.AccessURL, Region: e.Region}
		}
		c.cache.WriteJSON("sia", key, recs)
		return eps, nil
	})
	if err != nil {
		return nil, err
	}
	eps := v.([]Epoch)
	c.reg.Add(eps)
	c.mem.Set(key, eps, time.Hour)
	return eps, nil
}

// Lookup maps an epoch id to its record, re-running a point query if needed.
func (c *IRSA) Lookup(ctx context.Context, id string, ra, dec float64) (Epoch, error) {
	_, _, coll, err := parseEpochID(id)
	if err != nil {
		return Epoch{}, err
	}
	if e, ok := c.reg.Get(id); ok {
		return e, nil
	}
	if _, err := c.Query(ctx, coll, ra, dec, 0.001, 0, 0); err != nil {
		return Epoch{}, err
	}
	if e, ok := c.reg.Get(id); ok {
		return e, nil
	}
	return Epoch{}, errNotFound("unknown_id", "epoch id not found at this position: "+id)
}

func normSize(size int) int {
	if size <= 0 {
		size = 200
	}
	if size < 16 {
		size = 16
	}
	if size > 800 {
		size = 800
	}
	return size
}

// Cutout returns the local path of a cached cutout FITS (EPSF table removed).
func (c *IRSA) Cutout(ctx context.Context, e Epoch, ra, dec float64, size int) (string, error) {
	size = normSize(size)
	key := hashKey("cutout", e.AccessURL, fmt.Sprintf("%.5f", ra), fmt.Sprintf("%.5f", dec), strconv.Itoa(size))
	path := c.cache.Path("fits", key, ".fits")
	if exists(path) {
		touch(path)
		return path, nil
	}
	_, err := c.flight.Do(key, func() (any, error) {
		if exists(path) {
			return path, nil
		}
		u := fmt.Sprintf("%s?center=%.6f,%.6f&size=%dpx", e.AccessURL, ra, dec, size)
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 6*time.Minute)
		defer cancel()
		start := time.Now()
		body, err := fetchBytes(fctx, u, FetchOpts{Attempts: 7, PerAttempt: 90 * time.Second, Validate: validateFITS, Sem: c.sem, Label: "cutout", MaxBytes: 128 << 20})
		if err != nil {
			return nil, errUpstream("IRSA cutout failed: " + err.Error())
		}
		slim, err := stripHDUs(body, map[string]bool{"EPSF": true})
		if err != nil {
			slog.Warn("fits strip failed, caching full file", "err", err)
			slim = body
		}
		if err := writeAtomic(path, slim); err != nil {
			return nil, err
		}
		slog.Info("cutout fetched", "id", e.ID, "size", size, "bytes", len(body), "kept", len(slim), "ms", time.Since(start).Milliseconds())
		return path, nil
	})
	if err != nil {
		return "", err
	}
	return path, nil
}

// ---------------------------------------------------------------------------
// FITS HDU stripping (drops the ~4 MB EPSF table we never use).
// ---------------------------------------------------------------------------

const fitsBlock = 2880

func stripHDUs(b []byte, drop map[string]bool) ([]byte, error) {
	if err := validateFITS(b); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.Grow(len(b) / 3)
	off := 0
	for off < len(b) {
		hdrStart := off
		cards := map[string]string{}
		ended := false
		for !ended {
			if off+fitsBlock > len(b) {
				return nil, errors.New("truncated FITS header")
			}
			blk := b[off : off+fitsBlock]
			off += fitsBlock
			for i := 0; i < fitsBlock; i += 80 {
				card := string(blk[i : i+80])
				kw := strings.TrimSpace(card[:8])
				if kw == "END" {
					ended = true
					break
				}
				if len(card) > 10 && card[8:10] == "= " {
					val := strings.TrimSpace(card[10:])
					if strings.HasPrefix(val, "'") {
						if j := strings.Index(val[1:], "'"); j >= 0 {
							val = strings.TrimSpace(val[1 : 1+j])
						}
					} else if j := strings.Index(val, "/"); j >= 0 {
						val = strings.TrimSpace(val[:j])
					}
					cards[kw] = val
				}
			}
		}
		bitpix, _ := strconv.Atoi(cards["BITPIX"])
		naxis, _ := strconv.Atoi(cards["NAXIS"])
		pcount, _ := strconv.ParseInt(cards["PCOUNT"], 10, 64)
		gcount := int64(1)
		if g, err := strconv.ParseInt(cards["GCOUNT"], 10, 64); err == nil && g > 0 {
			gcount = g
		}
		var n int64
		if naxis > 0 {
			n = 1
			for i := 1; i <= naxis; i++ {
				v, err := strconv.ParseInt(cards["NAXIS"+strconv.Itoa(i)], 10, 64)
				if err != nil {
					return nil, fmt.Errorf("bad NAXIS%d", i)
				}
				n *= v
			}
		}
		dataLen := int64(abs(bitpix)/8) * gcount * (pcount + n)
		padded := (dataLen + fitsBlock - 1) / fitsBlock * fitsBlock
		end := int64(off) + padded
		if end > int64(len(b)) {
			return nil, errors.New("truncated FITS data")
		}
		if !drop[cards["EXTNAME"]] || hdrStart == 0 {
			out.Write(b[hdrStart:end])
		}
		off = int(end)
		if len(b)-off < fitsBlock { // trailing junk / padding
			break
		}
	}
	return out.Bytes(), nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

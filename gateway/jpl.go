package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// JPL Small-Body Identification (sb_ident)
// ---------------------------------------------------------------------------

type Body struct {
	Name     string   `json:"name"`
	RA       float64  `json:"ra"`
	Dec      float64  `json:"dec"`
	Vmag     *float64 `json:"vmag"`
	RateRA   float64  `json:"rate_ra"`  // arcsec/hour (dRA*cosDec)
	RateDec  float64  `json:"rate_dec"` // arcsec/hour
	DistArcs float64  `json:"dist_arcsec"`
}

type sbIdentResp struct {
	Fields       []string   `json:"fields"`
	FieldsFirst  []string   `json:"fields_first"`
	FieldsSecond []string   `json:"fields_second"`
	Data         [][]string `json:"data"`
	DataFirst    [][]string `json:"data_first_pass"`
	DataSecond   [][]string `json:"data_second_pass"`
	Error        string     `json:"error"`
	Message      string     `json:"message"`
}

func sbIdentURL(kind string, ra, dec, jd, hw, vlim float64) string {
	q := url.Values{}
	q.Set("sb-kind", kind)
	q.Set("lat", "0")
	q.Set("lon", "0")
	q.Set("alt", "0")
	q.Set("obs-time", fmt.Sprintf("%.6f", jd))
	q.Set("two-pass", "true")
	q.Set("suppress-first-pass", "true")
	q.Set("vmag-lim", fmt.Sprintf("%g", vlim))
	q.Set("fov-ra-center", raToHMS(ra))
	q.Set("fov-dec-center", decToDMS(dec))
	q.Set("fov-ra-hwidth", fmt.Sprintf("%.4f", hw))
	q.Set("fov-dec-hwidth", fmt.Sprintf("%.4f", hw))
	return "https://ssd-api.jpl.nasa.gov/sb_ident.api?" + q.Encode()
}

// parseSBIdent parses sb_ident JSON (field names looked up by text).
func parseSBIdent(b []byte, ra0, dec0 float64) ([]Body, error) {
	var r sbIdentResp
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("sb_ident: %w (body %q)", err, snippet(b))
	}
	if r.Error != "" {
		return nil, fmt.Errorf("sb_ident: %s %s", r.Error, r.Message)
	}
	fields, data := r.FieldsSecond, r.DataSecond
	if len(data) == 0 && len(r.DataFirst) > 0 {
		fields, data = r.FieldsFirst, r.DataFirst
	}
	if len(data) == 0 && len(r.Data) > 0 {
		fields, data = r.Fields, r.Data
	}
	idx := func(pred func(string) bool) int {
		for i, f := range fields {
			if pred(strings.ToLower(f)) {
				return i
			}
		}
		return -1
	}
	iName := idx(func(s string) bool { return strings.Contains(s, "name") })
	iRA := idx(func(s string) bool { return strings.Contains(s, "ra") && strings.Contains(s, "hh") })
	iDec := idx(func(s string) bool { return strings.Contains(s, "dec") && strings.Contains(s, "dd") })
	iMag := idx(func(s string) bool { return strings.Contains(s, "mag") })
	iRR := idx(func(s string) bool { return strings.HasPrefix(s, "ra rate") })
	iDR := idx(func(s string) bool { return strings.HasPrefix(s, "dec rate") })
	if len(data) > 0 && (iName < 0 || iRA < 0 || iDec < 0) {
		return nil, fmt.Errorf("sb_ident: unexpected fields %v", fields)
	}
	out := make([]Body, 0, len(data))
	for _, row := range data {
		at := func(i int) string {
			if i < 0 || i >= len(row) {
				return ""
			}
			return strings.TrimSpace(row[i])
		}
		ra, err1 := parseSexagesimal(at(iRA), true)
		dec, err2 := parseSexagesimal(at(iDec), false)
		if err1 != nil || err2 != nil {
			continue
		}
		b := Body{Name: at(iName), RA: round(ra, 6), Dec: round(dec, 6)}
		if v, err := strconv.ParseFloat(at(iMag), 64); err == nil {
			b.Vmag = &v
		}
		b.RateRA, _ = strconv.ParseFloat(at(iRR), 64)
		b.RateDec, _ = strconv.ParseFloat(at(iDR), 64)
		b.DistArcs = round(angSep(ra0, dec0, ra, dec)*3600, 1)
		out = append(out, b)
	}
	return out, nil
}

type JPL struct {
	sem    Sem
	cache  *DiskCache
	mem    *TTLCache
	flight Flight
}

func (j *JPL) Known(ctx context.Context, kind string, ra, dec, mjd, radius, vlim float64) ([]Body, error) {
	if kind != "a" && kind != "c" {
		return nil, errBad("bad_kind", "kind must be a (asteroids) or c (comets)")
	}
	if radius <= 0 {
		radius = 0.2
	}
	radius = math.Min(radius, 2)
	if vlim <= 0 {
		vlim = 20
	}
	u := sbIdentURL(kind, ra, dec, mjdToJD(mjd), radius, vlim)
	key := hashKey("sbident", u)
	if v, ok := j.mem.Get(key); ok {
		return v.([]Body), nil
	}
	v, err := j.flight.Do(key, func() (any, error) {
		var bodies []Body
		if j.cache.ReadJSON("jpl", key, 0, &bodies) {
			return bodies, nil
		}
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
		defer cancel()
		body, err := fetchBytes(fctx, u, FetchOpts{Attempts: 3, PerAttempt: 90 * time.Second, Sem: j.sem, Label: "sb_ident",
			Validate: func(b []byte) error {
				if len(b) == 0 || b[0] != '{' {
					return fmt.Errorf("sb_ident: non-JSON body %q", snippet(b))
				}
				return nil
			}})
		if err != nil {
			return nil, errUpstream("JPL sb_ident failed: " + err.Error())
		}
		bodies, err = parseSBIdent(body, ra, dec)
		if err != nil {
			return nil, errUpstream(err.Error())
		}
		j.cache.WriteJSON("jpl", key, bodies)
		return bodies, nil
	})
	if err != nil {
		return nil, err
	}
	bodies := v.([]Body)
	j.mem.Set(key, bodies, 6*time.Hour)
	return bodies, nil
}

// ---------------------------------------------------------------------------
// JPL Horizons
// ---------------------------------------------------------------------------

type EphemPoint struct {
	MJD     float64  `json:"mjd"`
	RA      float64  `json:"ra"`
	Dec     float64  `json:"dec"`
	RateRA  float64  `json:"rate_ra"`  // arcsec/hour, dRA*cosD
	RateDec float64  `json:"rate_dec"` // arcsec/hour
	Mag     *float64 `json:"mag"`
}

type Ephemeris struct {
	Target string       `json:"target"`
	Points []EphemPoint `json:"points"`
}

type horizonsResp struct {
	Result string `json:"result"`
	Error  string `json:"error"`
}

var targetRe = regexp.MustCompile(`Target body name:\s*(.+?)\s{2,}`)

// parseHorizons parses the CSV ephemeris inside a Horizons JSON response
// requested with CAL_FORMAT=JD, ANG_FORMAT=DEG, CSV_FORMAT=YES, QUANTITIES=1,3,9.
func parseHorizons(b []byte) (Ephemeris, error) {
	var r horizonsResp
	if err := json.Unmarshal(b, &r); err != nil {
		return Ephemeris{}, fmt.Errorf("horizons: %w", err)
	}
	if r.Error != "" {
		return Ephemeris{}, fmt.Errorf("horizons: %s", r.Error)
	}
	res := r.Result
	soe := strings.Index(res, "$$SOE")
	eoe := strings.Index(res, "$$EOE")
	if soe < 0 || eoe < soe {
		return Ephemeris{}, horizonsNoEphemError(res)
	}
	var e Ephemeris
	if m := targetRe.FindStringSubmatch(res); m != nil {
		e.Target = strings.TrimSpace(m[1])
	}
	// header line: last non-separator line before $$SOE
	pre := strings.Split(res[:soe], "\n")
	header := ""
	for i := len(pre) - 1; i >= 0; i-- {
		l := strings.TrimSpace(pre[i])
		if l == "" || strings.HasPrefix(l, "***") {
			continue
		}
		header = l
		break
	}
	cols := strings.Split(header, ",")
	find := func(pred func(string) bool) int {
		for i, c := range cols {
			if pred(strings.TrimSpace(c)) {
				return i
			}
		}
		return -1
	}
	iT := find(func(s string) bool { return strings.HasPrefix(s, "Date") })
	iRA := find(func(s string) bool { return strings.HasPrefix(s, "R.A.") })
	iDec := find(func(s string) bool { return strings.HasPrefix(s, "DEC") })
	iRR := find(func(s string) bool { return strings.HasPrefix(s, "dRA") })
	iDR := find(func(s string) bool { return strings.HasPrefix(s, "d(DEC)") })
	iMag := find(func(s string) bool { return s == "APmag" || s == "T-mag" })
	if iT < 0 || iRA < 0 || iDec < 0 {
		return Ephemeris{}, fmt.Errorf("horizons: unexpected header %q", header)
	}
	for _, line := range strings.Split(res[soe+5:eoe], "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, ",")
		at := func(i int) string {
			if i < 0 || i >= len(f) {
				return ""
			}
			return strings.TrimSpace(f[i])
		}
		jd, err := strconv.ParseFloat(at(iT), 64)
		if err != nil {
			continue
		}
		ra, err1 := strconv.ParseFloat(at(iRA), 64)
		dec, err2 := strconv.ParseFloat(at(iDec), 64)
		if err1 != nil || err2 != nil {
			continue
		}
		p := EphemPoint{MJD: round(jd-2400000.5, 6), RA: ra, Dec: dec}
		p.RateRA, _ = strconv.ParseFloat(at(iRR), 64)
		p.RateDec, _ = strconv.ParseFloat(at(iDR), 64)
		if v, err := strconv.ParseFloat(at(iMag), 64); err == nil {
			p.Mag = &v
		}
		e.Points = append(e.Points, p)
	}
	if len(e.Points) == 0 {
		return e, fmt.Errorf("horizons: empty ephemeris")
	}
	return e, nil
}

func horizonsNoEphemError(res string) error {
	low := strings.ToLower(res)
	switch {
	case strings.Contains(low, "no matches found"):
		return errNotFound("not_found", "Horizons: no object matches this name")
	case strings.Contains(low, "multiple") || strings.Contains(low, "matching small-bodies"):
		// keep a few candidate lines for the user
		lines := strings.Split(res, "\n")
		var cand []string
		for _, l := range lines {
			t := strings.TrimSpace(l)
			if t == "" || strings.HasPrefix(t, "*") || strings.HasPrefix(t, "-") {
				continue
			}
			if len(cand) < 8 && (len(t) > 0 && (t[0] >= '0' && t[0] <= '9' || t[0] == '-')) {
				cand = append(cand, strings.Join(strings.Fields(t), " "))
			}
		}
		return &apiError{409, "ambiguous", "Horizons: several objects match, be more specific: " + strings.Join(cand, "; ")}
	}
	return fmt.Errorf("horizons: no ephemeris in response: %q", snippet([]byte(res)))
}

func horizonsURL(command string, start, stop time.Time, step string) string {
	q := url.Values{}
	q.Set("format", "json")
	q.Set("COMMAND", "'"+command+"'")
	q.Set("OBJ_DATA", "NO")
	q.Set("MAKE_EPHEM", "YES")
	q.Set("EPHEM_TYPE", "OBSERVER")
	q.Set("CENTER", "'500@399'")
	q.Set("START_TIME", "'"+start.UTC().Format("2006-01-02 15:04")+"'")
	q.Set("STOP_TIME", "'"+stop.UTC().Format("2006-01-02 15:04")+"'")
	q.Set("STEP_SIZE", "'"+step+"'")
	q.Set("QUANTITIES", "'1,3,9'")
	q.Set("ANG_FORMAT", "DEG")
	q.Set("CAL_FORMAT", "JD")
	q.Set("CSV_FORMAT", "YES")
	q.Set("EXTRA_PREC", "YES")
	return "https://ssd.jpl.nasa.gov/api/horizons.api?" + q.Encode()
}

// horizonsCommands returns the COMMAND strings to try for a user-typed name.
var interstellarRe = regexp.MustCompile(`(?i)^(\d+I)(/.*)?$`)

// horizonsAliases maps popular names Horizons does not accept to designations it does.
var horizonsAliases = map[string]string{
	"3i/atlas": "C/2025 N1", "atlas 3i": "C/2025 N1", "3i atlas": "C/2025 N1",
	"2i/borisov": "C/2019 Q4", "1i/oumuamua": "A/2017 U1", "oumuamua": "A/2017 U1",
}

func horizonsCommands(name string) []string {
	n := strings.TrimSpace(name)
	var cmds []string
	if a, ok := horizonsAliases[strings.ToLower(n)]; ok {
		cmds = append(cmds, "DES="+a+";CAP;", a)
	}
	if m := interstellarRe.FindStringSubmatch(n); m != nil && m[2] != "" {
		cmds = append(cmds, strings.ToUpper(m[1])) // "3I/ATLAS" -> "3I"
	}
	cmds = append(cmds, n)
	if !strings.HasSuffix(n, ";") {
		cmds = append(cmds, n+";")
	}
	if regexp.MustCompile(`^[CPDXI]/\d{4}`).MatchString(n) {
		cmds = append(cmds, "DES="+n+";CAP;")
	}
	return cmds
}

func (j *JPL) Ephemeris(ctx context.Context, name string, start, stop time.Time, step string) (Ephemeris, error) {
	var lastErr error
	for _, cmd := range horizonsCommands(name) {
		u := horizonsURL(cmd, start, stop, step)
		key := hashKey("horizons", u)
		if v, ok := j.mem.Get(key); ok {
			return v.(Ephemeris), nil
		}
		v, err := j.flight.Do(key, func() (any, error) {
			var e Ephemeris
			if stop.Before(time.Now().Add(-48*time.Hour)) && j.cache.ReadJSON("jpl", key, 0, &e) {
				return e, nil
			}
			fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
			defer cancel()
			body, err := fetchBytes(fctx, u, FetchOpts{Attempts: 3, PerAttempt: 60 * time.Second, Sem: j.sem, Label: "horizons"})
			if err != nil {
				return nil, errUpstream("JPL Horizons failed: " + err.Error())
			}
			e, err = parseHorizons(body)
			if err != nil {
				return nil, err
			}
			j.cache.WriteJSON("jpl", key, e)
			return e, nil
		})
		if err == nil {
			e := v.(Ephemeris)
			j.mem.Set(key, e, 6*time.Hour)
			return e, nil
		}
		lastErr = err
		if ae, ok := err.(*apiError); ok && ae.Code == "ambiguous" {
			// a trailing ';' (small-body only) often disambiguates; keep trying
			continue
		}
	}
	return Ephemeris{}, lastErr
}

// ---------------------------------------------------------------------------
// CDS Sesame
// ---------------------------------------------------------------------------

type sesameXML struct {
	Targets []struct {
		Resolvers []struct {
			Name  string  `xml:"name,attr"`
			Oname string  `xml:"oname"`
			Otype string  `xml:"otype"`
			RA    float64 `xml:"jradeg"`
			Dec   float64 `xml:"jdedeg"`
			Has   string  `xml:"jpos"`
			PM    *struct {
				RA  float64 `xml:"pmRA"`
				Dec float64 `xml:"pmDE"`
			} `xml:"pm"`
		} `xml:"Resolver"`
	} `xml:"Target"`
}

type Resolved struct {
	Name   string  `json:"name"`
	RA     float64 `json:"ra"`
	Dec    float64 `json:"dec"`
	Kind   string  `json:"kind"`
	Source string  `json:"source"`
	Otype  string  `json:"otype,omitempty"`
	MJD    float64 `json:"mjd,omitempty"`
	// For fixed objects with a catalogue proper motion, ra/dec are moved to
	// the SPHEREx DR1 mid epoch (2025.75); J2000 values are kept here.
	RAJ2000  *float64 `json:"ra_j2000,omitempty"`
	DecJ2000 *float64 `json:"dec_j2000,omitempty"`
	PMRA     *float64 `json:"pm_ra_masyr,omitempty"`
	PMDec    *float64 `json:"pm_dec_masyr,omitempty"`
	Epoch    float64  `json:"epoch,omitempty"`
}

// sphereXEpoch is the Julian year used to propagate proper motions.
const sphereXEpoch = 2025.75

// applyPM moves a J2000 position by its proper motion (mas/yr, pmRA includes cos dec).
func applyPM(r *Resolved, pmra, pmdec float64) {
	if math.Abs(pmra) < 50 && math.Abs(pmdec) < 50 { // < 0.06 px over 25 yr: ignore
		return
	}
	ra0, dec0 := r.RA, r.Dec
	dt := sphereXEpoch - 2000.0
	dec := dec0 + pmdec*dt/3.6e6
	ra := ra0 + pmra*dt/3.6e6/math.Cos(deg2rad((dec0+dec)/2))
	ra = math.Mod(ra+360, 360)
	r.RAJ2000, r.DecJ2000 = &ra0, &dec0
	r.PMRA, r.PMDec = &pmra, &pmdec
	r.RA, r.Dec, r.Epoch = round(ra, 6), round(dec, 6), sphereXEpoch
}

func parseSesame(b []byte) (Resolved, bool) {
	var s sesameXML
	if err := xml.Unmarshal(b, &s); err != nil {
		return Resolved{}, false
	}
	for _, t := range s.Targets {
		for _, r := range t.Resolvers {
			if r.Has == "" {
				continue
			}
			src := "CDS Sesame"
			name := strings.TrimSpace(strings.TrimPrefix(r.Oname, "NAME "))
			if r.Name != "" {
				src += " (" + strings.SplitN(r.Name, ",", 2)[0] + ")"
			}
			res := Resolved{Name: name, RA: round(r.RA, 6), Dec: round(r.Dec, 6), Kind: "fixed", Source: src, Otype: r.Otype}
			if r.PM != nil {
				applyPM(&res, r.PM.RA, r.PM.Dec)
			}
			return res, true
		}
	}
	return Resolved{}, false
}

func (j *JPL) Sesame(ctx context.Context, name string) (Resolved, bool, error) {
	key := hashKey("sesame", strings.ToLower(strings.TrimSpace(name)))
	if v, ok := j.mem.Get(key); ok {
		r := v.(Resolved)
		return r, r.Name != "", nil
	}
	u := "https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/SNV?" + url.PathEscape(strings.TrimSpace(name))
	body, err := fetchBytes(ctx, u, FetchOpts{Attempts: 2, PerAttempt: 20 * time.Second, Label: "sesame"})
	if err != nil {
		return Resolved{}, false, err
	}
	r, ok := parseSesame(body)
	if ok && r.Name == "" {
		r.Name = name
	}
	j.mem.Set(key, r, 24*time.Hour)
	return r, ok, nil
}

var movingNameRe = regexp.MustCompile(`(?i)^(\d+I(/.*)?|[CPDXI]/\d{4}.*|\d{4}\s?[A-Z]{2}\d*|\(?\d{1,7}\)?(\s+\S+)?|mercury|venus|moon|mars|jupiter|saturn|uranus|neptune|pluto|ceres|vesta|pallas|juno|hygiea|eros|apophis|bennu|ryugu|psyche)$`)

func looksMoving(name string) bool { return movingNameRe.MatchString(strings.TrimSpace(name)) }

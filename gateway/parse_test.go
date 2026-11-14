package main

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestParseSIACSV(t *testing.T) {
	eps, err := parseSIACSV(fixture(t, "sia_ra180_dec0.csv"), "spherex_dr1")
	if err != nil {
		t.Fatal(err)
	}
	if len(eps) != 3 {
		t.Fatalf("want 3 epochs, got %d", len(eps))
	}
	e := eps[0]
	if e.ObsID != "2025W20_2D_0234_1" {
		t.Errorf("obs_id %q", e.ObsID)
	}
	if e.Collection != "spherex_dr1" || !strings.HasSuffix(e.ID, ".dr1") {
		t.Errorf("collection/id %q %q", e.Collection, e.ID)
	}
	if !strings.HasPrefix(e.AccessURL, "https://irsa.ipac.caltech.edu/ibe/data/spherex/") || !strings.HasSuffix(e.AccessURL, ".fits") {
		t.Errorf("access_url %q (cloud_access JSON must not shift columns)", e.AccessURL)
	}
	if !strings.HasPrefix(e.Region, "POLYGON ICRS") {
		t.Errorf("region %q", e.Region)
	}
	for i := 1; i < len(eps); i++ {
		if eps[i].MJD < eps[i-1].MJD {
			t.Errorf("not sorted by mjd")
		}
	}
	// the D6 row: em_min 4.4115e-06 m
	var d6 *Epoch
	for i := range eps {
		if eps[i].Det == 6 && d6 == nil {
			d6 = &eps[i]
		}
	}
	if d6 == nil {
		t.Fatal("no D6 row")
	}
	if !near(d6.EmMinUm, 4.4115, 1e-4) || !near(d6.EmMaxUm, 5.0096, 1e-4) || d6.Band != "SPHEREx-D6" {
		t.Errorf("D6 row %+v", *d6)
	}
	if !near(d6.MJD, (60811.905839+60811.907171)/2, 1e-5) {
		t.Errorf("mjd %v", d6.MJD)
	}
	if d6.ID != "2025W20_2D_0234_1_D6.dr1" {
		t.Errorf("id %q", d6.ID)
	}
}

func TestValidateBodies(t *testing.T) {
	if validateSIA([]byte("Server busy, retry later.")) == nil {
		t.Error("busy body accepted as SIA")
	}
	if validateFITS([]byte("Server busy, retry later.")) == nil {
		t.Error("busy body accepted as FITS")
	}
	fits := make([]byte, 2880)
	copy(fits, "SIMPLE  =                    T")
	if validateFITS(fits) != nil {
		t.Error("valid FITS header rejected")
	}
	if validateSIA(fixture(t, "sia_ra180_dec0.csv")) != nil {
		t.Error("real SIA CSV rejected")
	}
}

func TestEpochID(t *testing.T) {
	id := makeEpochID("2025W21_1B_0570_1", 2, "spherex_dr1")
	if id != "2025W21_1B_0570_1_D2.dr1" {
		t.Fatalf("id %q", id)
	}
	obs, det, coll, err := parseEpochID(id)
	if err != nil || obs != "2025W21_1B_0570_1" || det != 2 || coll != "spherex_dr1" {
		t.Fatalf("roundtrip %q %d %q %v", obs, det, coll, err)
	}
	if _, _, c, err := parseEpochID("2025W17_4B_0021_1_D1.deep"); err != nil || c != "spherex_dr1_deep" {
		t.Fatalf("deep id: %q %v", c, err)
	}
	for _, bad := range []string{"", "x", "../../etc/passwd_D1.dr1", "2025W21_1B_0570_1_D7.dr1", "2025W21_1B_0570_1_D2.foo"} {
		if _, _, _, err := parseEpochID(bad); err == nil {
			t.Errorf("accepted bad id %q", bad)
		}
	}
}

func TestSexagesimal(t *testing.T) {
	if got := raToHMS(180); got != "12-00-00.00" {
		t.Errorf("ra 180 -> %s", got)
	}
	if got := raToHMS(359.99999999); got != "00-00-00.00" {
		t.Errorf("ra wrap -> %s", got)
	}
	// 1h 59m 59.996s rounds up and must carry into minutes and hours
	ra := (1 + 59.0/60 + 59.996/3600) * 15
	if got := raToHMS(ra); got != "02-00-00.00" {
		t.Errorf("ra carry -> %s", got)
	}
	decCases := map[float64]string{
		0:                            "00-00-00.0",
		-0.5:                         "M00-30-00.0",
		-0.0001:                      "M00-00-00.4",
		45.5:                         "45-30-00.0",
		-16.8:                        "M16-48-00.0",
		-(10 + 59.0/60 + 59.96/3600): "M11-00-00.0", // carry
		-0.00001:                     "00-00-00.0",  // rounds to zero, no M
		89.99999999:                  "90-00-00.0",
	}
	for in, want := range decCases {
		if got := decToDMS(in); got != want {
			t.Errorf("dec %v -> %s, want %s", in, got, want)
		}
	}
	for _, c := range []struct {
		s     string
		hours bool
		want  float64
	}{
		{"11:56:10.54", true, (11 + 56.0/60 + 10.54/3600) * 15},
		{"-00 31'41.3\"", false, -(31.0/60 + 41.3/3600)},
		{"+00 09'01.1\"", false, 9.0/60 + 1.1/3600},
		{"M16-48-00.0", false, -16.8},
	} {
		got, err := parseSexagesimal(c.s, c.hours)
		if err != nil || !near(got, c.want, 1e-9) {
			t.Errorf("parse %q -> %v %v, want %v", c.s, got, err, c.want)
		}
	}
	// format then parse back
	for _, d := range []float64{-89.5, -12.3456, -0.25, 0.25, 33.3333, 66.6} {
		s := decToDMS(d)
		back, err := parseSexagesimal(s, false)
		if err != nil || !near(back, d, 0.1/3600+1e-9) {
			t.Errorf("roundtrip %v -> %s -> %v", d, s, back)
		}
	}
}

func TestParseSBIdent(t *testing.T) {
	bodies, err := parseSBIdent(fixture(t, "sb_ident_ra180.json"), 180, -0.5)
	if err != nil {
		t.Fatal(err)
	}
	if len(bodies) == 0 {
		t.Fatal("no bodies")
	}
	b := bodies[0]
	if b.Name != "4454 Kumiko (1988 VW)" {
		t.Errorf("name %q", b.Name)
	}
	if !near(b.RA, (11+56.0/60+10.54/3600)*15, 1e-5) || !near(b.Dec, -(31.0/60+41.3/3600), 1e-5) {
		t.Errorf("pos %v %v", b.RA, b.Dec)
	}
	if b.Vmag == nil || *b.Vmag != 18.7 {
		t.Errorf("vmag %v", b.Vmag)
	}
	if !near(b.RateRA, -2.902, 1e-9) || !near(b.RateDec, 1.581, 1e-9) {
		t.Errorf("rates %v %v", b.RateRA, b.RateDec)
	}
	if _, err := parseSBIdent([]byte(`{"error":"bad","message":"x"}`), 0, 0); err == nil {
		t.Error("error response not reported")
	}
	empty, err := parseSBIdent([]byte(`{"n_second_pass":0}`), 0, 0)
	if err != nil || len(empty) != 0 {
		t.Errorf("empty response: %v %v", empty, err)
	}
}

func TestParseHorizons(t *testing.T) {
	e, err := parseHorizons(fixture(t, "horizons_3i.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Points) < 30 {
		t.Fatalf("points %d", len(e.Points))
	}
	p := e.Points[0]
	if !near(p.MJD, 2460857.5-2400000.5, 1e-6) || !near(p.RA, 271.97791, 1e-6) || !near(p.Dec, -18.69701, 1e-6) {
		t.Errorf("first point %+v", p)
	}
	if !near(p.RateRA, -72.4871, 1e-6) || !near(p.RateDec, 1.454030, 1e-6) {
		t.Errorf("rates %+v", p)
	}
	if p.Mag == nil || *p.Mag != 19.434 {
		t.Errorf("mag %v", p.Mag)
	}
	if !strings.Contains(e.Target, "ATLAS") {
		t.Errorf("target %q", e.Target)
	}
	_, err = parseHorizons(fixture(t, "horizons_mars_ambiguous.json"))
	if ae, ok := err.(*apiError); !ok || ae.Code != "ambiguous" || !strings.Contains(ae.Msg, "499") {
		t.Errorf("ambiguous: %v", err)
	}
	_, err = parseHorizons(fixture(t, "horizons_nomatch.json"))
	if ae, ok := err.(*apiError); !ok || ae.Code != "not_found" {
		t.Errorf("no match: %v", err)
	}
}

func TestParseSesame(t *testing.T) {
	r, ok := parseSesame(fixture(t, "sesame_m42.xml"))
	if !ok || !near(r.RA, 83.8201, 1e-4) || !near(r.Dec, -5.3876, 1e-4) || r.Kind != "fixed" {
		t.Errorf("m42 %+v %v", r, ok)
	}
	if _, ok := parseSesame(fixture(t, "sesame_notfound.xml")); ok {
		t.Error("not-found resolved")
	}
}

func TestPolygonAndInterp(t *testing.T) {
	poly := parsePolygon("POLYGON ICRS 179.90555498896921 2.689618831033705 183.0326993908378 1.159880681261039 181.63375853878617 -2.0419441326466714 178.48236908873372 -0.49469008454306224 179.90555498896921 2.689618831033705")
	if len(poly) != 4 {
		t.Fatalf("poly %v", poly)
	}
	if !polygonContains(poly, 180, 0) {
		t.Error("180,0 should be inside")
	}
	if polygonContains(poly, 185, 0) || polygonContains(poly, 0, 0) {
		t.Error("outside point reported inside")
	}
	// RA wrap-around polygon
	wrap := [][2]float64{{359, -1}, {1, -1}, {1, 1}, {359, 1}}
	if !polygonContains(wrap, 0.2, 0) || polygonContains(wrap, 2, 0) {
		t.Error("wrap polygon")
	}
	pts := []EphemPoint{{MJD: 1, RA: 359.5, Dec: 0}, {MJD: 2, RA: 0.5, Dec: 1}}
	p, ok := interpEphem(pts, 1.5)
	if !ok || !(near(p.RA, 0, 1e-9) || near(p.RA, 360, 1e-9)) || !near(p.Dec, 0.5, 1e-9) {
		t.Errorf("interp %+v %v", p, ok)
	}
	if _, ok := interpEphem(pts, 3); ok {
		t.Error("extrapolated")
	}
}

func TestMJD(t *testing.T) {
	tm := mjdToTime(60811.905838646)
	if tm.Format("2006-01-02T15:04:05") != "2025-05-16T21:44:24" {
		t.Errorf("mjd->time %v", tm)
	}
	if !near(timeToMJD(time.Date(2025, 5, 16, 0, 0, 0, 0, time.UTC)), 60811, 1e-9) {
		t.Error("time->mjd")
	}
}

func TestTrackSamples(t *testing.T) {
	var pts []EphemPoint
	for i := 0; i < 100; i++ { // 0.1 deg per step, 0.25 d per step
		pts = append(pts, EphemPoint{MJD: 60000 + float64(i)*0.25, RA: 10 + float64(i)*0.1, Dec: 0})
	}
	s := trackSamples(pts, 0.5, 4)
	if len(s) < 19 || len(s) > 22 {
		t.Errorf("samples %d", len(s))
	}
	for i, x := range s {
		if x.T1 <= x.T0 {
			t.Errorf("sample %d window %v..%v", i, x.T0, x.T1)
		}
	}
}

func TestStripHDUs(t *testing.T) {
	mk := func(cards ...string) []byte {
		var b []byte
		for _, c := range cards {
			b = append(b, []byte(padCard(c))...)
		}
		b = append(b, []byte(padCard("END"))...)
		for len(b)%2880 != 0 {
			b = append(b, ' ')
		}
		return b
	}
	prim := mk("SIMPLE  =                    T", "BITPIX  =                    8", "NAXIS   =                    0", "EXTEND  =                    T")
	img := mk("XTENSION= 'IMAGE   '", "BITPIX  =                  -32", "NAXIS   =                    2", "NAXIS1  =                   10", "NAXIS2  =                   10", "PCOUNT  =                    0", "GCOUNT  =                    1", "EXTNAME = 'IMAGE   '")
	img = append(img, make([]byte, 2880)...) // 400 bytes padded
	tbl := mk("XTENSION= 'BINTABLE'", "BITPIX  =                    8", "NAXIS   =                    2", "NAXIS1  =                 8712", "NAXIS2  =                    1", "PCOUNT  =                    0", "GCOUNT  =                    1", "EXTNAME = 'EPSF    '           / psf")
	tbl = append(tbl, make([]byte, 8712+(2880-8712%2880))...)
	all := append(append(append([]byte{}, prim...), img...), tbl...)
	out, err := stripHDUs(all, map[string]bool{"EPSF": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(prim)+len(img) {
		t.Errorf("stripped len %d want %d", len(out), len(prim)+len(img))
	}
	if _, err := stripHDUs(all[:len(all)-100], nil); err == nil {
		t.Error("truncated file accepted")
	}
}

func padCard(s string) string {
	for len(s) < 80 {
		s += " "
	}
	return s
}

func TestPickSpread(t *testing.T) {
	var eps []Epoch
	for d := 1; d <= 6; d++ {
		for i := 0; i < 50; i++ {
			eps = append(eps, Epoch{ID: makeEpochID("x", d, "spherex_dr1") + string(rune('a'+i%26)), Det: d, MJD: float64(i)})
		}
	}
	sel := pickSpread(eps, 60)
	if len(sel) != 60 {
		t.Fatalf("picked %d", len(sel))
	}
	per := map[int]int{}
	for _, e := range sel {
		per[e.Det]++
	}
	for d := 1; d <= 6; d++ {
		if per[d] != 10 {
			t.Errorf("det %d got %d", d, per[d])
		}
	}
}

func TestSesameProperMotion(t *testing.T) {
	r, ok := parseSesame(fixture(t, "sesame_barnard.xml"))
	if !ok || r.RAJ2000 == nil || r.Epoch != sphereXEpoch {
		t.Fatalf("barnard %+v", r)
	}
	// 25.75 yr * 10.362 "/yr = 266.8" north
	if d := (r.Dec - *r.DecJ2000) * 3600; !near(d, 10362.394*25.75/1000, 0.5) {
		t.Errorf("dec shift %v arcsec", d)
	}
	if d := (r.RA - *r.RAJ2000) * 3600 * math.Cos(deg2rad(r.Dec)); !near(d, -801.551*25.75/1000, 0.5) {
		t.Errorf("ra shift %v arcsec", d)
	}
}

func TestHorizonsCommands(t *testing.T) {
	c := horizonsCommands("3I/ATLAS")
	if c[0] != "DES=C/2025 N1;CAP;" || !strings.Contains(strings.Join(c, "|"), "|3I|") {
		t.Errorf("3I/ATLAS commands %v", c)
	}
	if c := horizonsCommands("3I"); c[0] != "3I" {
		t.Errorf("3I commands %v", c)
	}
}

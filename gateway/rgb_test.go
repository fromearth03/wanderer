package main

import "testing"

func TestPickRGB(t *testing.T) {
	ep := func(id string, det int, mjd float64) Epoch { return Epoch{ID: id, Det: det, MJD: mjd} }
	eps := []Epoch{
		ep("w1d1", 1, 60811.0), ep("w1d3", 3, 60811.5), ep("w1d5", 5, 60812.0), // window 1: no D6, D5 stands in
		ep("w2d2", 2, 61030.0), ep("w2d4", 4, 61030.2), ep("w2d6", 6, 61030.4), ep("w2d6b", 6, 61035.0),
	}
	p, ok := pickRGB(eps, 0)
	if !ok || p.B.ID != "w1d1" || p.G.ID != "w1d3" || p.R.ID != "w1d5" {
		t.Fatalf("first window pick %+v %v", p, ok)
	}
	p, ok = pickRGB(eps, 61031)
	if !ok || p.B.ID != "w2d2" || p.G.ID != "w2d4" || p.R.ID != "w2d6" {
		t.Fatalf("near pick %+v %v", p, ok)
	}
	if _, ok := pickRGB([]Epoch{ep("x", 1, 1), ep("y", 3, 2)}, 0); ok {
		t.Fatal("picked without a red channel")
	}
	for _, bad := range []string{"../etc/passwd", "/abs", "a/../b", "a b"} {
		if hipsPathRE.MatchString(bad) && !containsDotDot(bad) {
			t.Fatalf("hips path %q accepted", bad)
		}
	}
}

func containsDotDot(s string) bool {
	for i := 0; i+1 < len(s); i++ {
		if s[i] == '.' && s[i+1] == '.' {
			return true
		}
	}
	return false
}

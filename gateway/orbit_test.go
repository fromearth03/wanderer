package main

import (
	"encoding/json"
	"testing"
	"time"
)

const vecFixture = "Target body name: ATLAS (C/2025 N1)               {source: JPL#55}\nCenter body name: Sun (10)\n" +
	"            JDTDB,            Calendar Date (TDB),                      X,                      Y,                      Z,\n" +
	"$$SOE\n" +
	"2460857.500000000, A.D. 2025-Jul-01 00:00:00.0000,  2.748770279514102E-01, -4.496238203546724E+00,  2.891654803550928E-01,\n" +
	"2460858.500000000, A.D. 2025-Jul-02 00:00:00.0000,  2.610250071639810E-01, -4.463699126150419E+00,  2.876950753496730E-01,\n" +
	"$$EOE\n"

func TestParseVectors(t *testing.T) {
	b, _ := json.Marshal(map[string]string{"result": vecFixture})
	target, pts, err := parseVectors(b)
	if err != nil {
		t.Fatal(err)
	}
	if target != "ATLAS (C/2025 N1)" {
		t.Errorf("target %q", target)
	}
	if len(pts) != 2 || pts[0][0] != 2460857.5 || pts[1][2] > -4.46 || pts[0][3] < 0.28 {
		t.Errorf("points %v", pts)
	}
	b, _ = json.Marshal(map[string]string{"result": "No matches found."})
	if _, _, err := parseVectors(b); err == nil {
		t.Error("expected error for no match")
	}
}

func TestParseStep(t *testing.T) {
	for in, want := range map[string]string{"2 d": "2 d", "12h": "12 h", " 30 M ": "30 m"} {
		got, _, err := parseStep(in)
		if err != nil || got != want {
			t.Errorf("parseStep(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "0 d", "2 y", "1;d", "x"} {
		if _, _, err := parseStep(bad); err == nil {
			t.Errorf("parseStep(%q) should fail", bad)
		}
	}
	if s := autoStep(365*24*time.Hour, 200); s != "44 h" {
		t.Errorf("autoStep year = %q", s)
	}
}

func TestParseOMM(t *testing.T) {
	raw, name, epoch, err := parseOMM([]byte("[" + builtinSpherexOMM + "]"))
	if err != nil || name == "" || epoch == "" || len(raw) == 0 {
		t.Fatal(name, epoch, err)
	}
	for _, bad := range []string{"Server busy", "[]", `[{"NORAD_CAT_ID":1}]`} {
		if _, _, _, err := parseOMM([]byte(bad)); err == nil {
			t.Errorf("parseOMM(%q) should fail", bad)
		}
	}
}

func TestTimeToJD(t *testing.T) {
	if jd := timeToJD(time.Date(2000, 1, 1, 12, 0, 0, 0, time.UTC)); jd != 2451545.0 {
		t.Errorf("jd %v", jd)
	}
}

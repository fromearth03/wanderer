package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

const mjdUnixEpoch = 40587.0 // MJD of 1970-01-01T00:00:00Z

func mjdToTime(mjd float64) time.Time {
	sec := (mjd - mjdUnixEpoch) * 86400
	whole := math.Floor(sec)
	return time.Unix(int64(whole), int64((sec-whole)*1e9)).UTC()
}

func timeToMJD(t time.Time) float64 {
	return float64(t.UnixNano())/86400e9 + mjdUnixEpoch
}

func mjdToJD(mjd float64) float64 { return mjd + 2400000.5 }

// raToHMS formats RA (deg) as hh-mm-ss.ss for JPL sb_ident.
func raToHMS(ra float64) string {
	ra = math.Mod(ra, 360)
	if ra < 0 {
		ra += 360
	}
	// work in hundredths of a second of time to get carries right
	total := int64(math.Round(ra / 15 * 3600 * 100))
	total %= 24 * 3600 * 100
	h := total / (3600 * 100)
	m := (total / (60 * 100)) % 60
	cs := total % (60 * 100)
	return fmt.Sprintf("%02d-%02d-%02d.%02d", h, m, cs/100, cs%100)
}

// decToDMS formats Dec (deg) as dd-mm-ss.s; negative values use a leading M
// (sb_ident does not accept "-").
func decToDMS(dec float64) string {
	sign := ""
	if dec < 0 {
		sign = "M"
	}
	total := int64(math.Round(math.Abs(dec) * 3600 * 10)) // tenths of arcsec
	d := total / (3600 * 10)
	m := (total / (60 * 10)) % 60
	ds := total % (60 * 10)
	if total == 0 {
		sign = ""
	}
	return fmt.Sprintf("%s%02d-%02d-%02d.%d", sign, d, m, ds/10, ds%10)
}

// parseSexagesimal parses "hh:mm:ss.s", "hh mm ss", "-dd mm'ss.s\"" and similar.
// hours=true multiplies by 15.
func parseSexagesimal(s string, hours bool) (float64, error) {
	s = strings.TrimSpace(s)
	neg := false
	if strings.HasPrefix(s, "-") || strings.HasPrefix(s, "M") {
		neg = true
		s = s[1:]
	} else if strings.HasPrefix(s, "+") {
		s = s[1:]
	}
	repl := strings.NewReplacer(":", " ", "'", " ", "\"", " ", "h", " ", "m", " ", "s", " ", "d", " ", "-", " ")
	parts := strings.Fields(repl.Replace(s))
	if len(parts) == 0 || len(parts) > 3 {
		return 0, fmt.Errorf("bad sexagesimal %q", s)
	}
	v := 0.0
	div := 1.0
	for _, p := range parts {
		f, err := strconv.ParseFloat(p, 64)
		if err != nil {
			return 0, fmt.Errorf("bad sexagesimal %q: %w", s, err)
		}
		v += f / div
		div *= 60
	}
	if hours {
		v *= 15
	}
	if neg {
		v = -v
	}
	return v, nil
}

func deg2rad(d float64) float64 { return d * math.Pi / 180 }
func rad2deg(r float64) float64 { return r * 180 / math.Pi }

// angSep returns the angular separation in degrees.
func angSep(ra1, dec1, ra2, dec2 float64) float64 {
	r1, d1, r2, d2 := deg2rad(ra1), deg2rad(dec1), deg2rad(ra2), deg2rad(dec2)
	sd := math.Sin((d2 - d1) / 2)
	sr := math.Sin((r2 - r1) / 2)
	a := sd*sd + math.Cos(d1)*math.Cos(d2)*sr*sr
	return rad2deg(2 * math.Asin(math.Min(1, math.Sqrt(a))))
}

// parsePolygon parses an STC-S "POLYGON ICRS ra dec ra dec ..." string.
func parsePolygon(s string) [][2]float64 {
	f := strings.Fields(s)
	var nums []float64
	for _, x := range f {
		if v, err := strconv.ParseFloat(x, 64); err == nil {
			nums = append(nums, v)
		}
	}
	var pts [][2]float64
	for i := 0; i+1 < len(nums); i += 2 {
		pts = append(pts, [2]float64{nums[i], nums[i+1]})
	}
	if n := len(pts); n > 1 && pts[0] == pts[n-1] {
		pts = pts[:n-1]
	}
	return pts
}

// polygonContains tests whether (ra, dec) is inside a small spherical polygon,
// using a gnomonic projection centred on the point (valid for fields << 90 deg).
func polygonContains(poly [][2]float64, ra, dec float64) bool {
	if len(poly) < 3 {
		return false
	}
	ra0, dec0 := deg2rad(ra), deg2rad(dec)
	xs := make([]float64, len(poly))
	ys := make([]float64, len(poly))
	for i, p := range poly {
		r, d := deg2rad(p[0]), deg2rad(p[1])
		cosc := math.Sin(dec0)*math.Sin(d) + math.Cos(dec0)*math.Cos(d)*math.Cos(r-ra0)
		if cosc <= 0 {
			return false
		}
		xs[i] = math.Cos(d) * math.Sin(r-ra0) / cosc
		ys[i] = (math.Cos(dec0)*math.Sin(d) - math.Sin(dec0)*math.Cos(d)*math.Cos(r-ra0)) / cosc
	}
	// ray casting from origin along +x
	inside := false
	n := len(xs)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		if (ys[i] > 0) != (ys[j] > 0) {
			xCross := xs[j] + (0-ys[j])*(xs[i]-xs[j])/(ys[i]-ys[j])
			if xCross > 0 {
				inside = !inside
			}
		}
	}
	return inside
}

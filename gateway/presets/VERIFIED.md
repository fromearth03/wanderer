# Preset verification notes

Every preset in `presets.json` was checked on 2026-11-14 by running the local
gateway and science services against the live IRSA, JPL and CDS services and
looking at the real cutouts. `presets.json` is generated from
`presets_spec.json` by `build_presets.py` (it embeds the IBE access URL of each
epoch so the ids work on a fresh server).

Pixel positions below are PNG coordinates (origin top-left) of the epoch A grid.

## asteroid-holda: 872 Holda (blink)

- Field: RA 179.80, Dec +1.101, `spherex_dr1`, 200 px (20.5 arcmin), detector D2.
- How found: JPL sb_ident on the overlap of two D2 exposures at RA 180, Dec 0
  (radius 1.3 deg, V < 17.5) gave 872 Holda (V 14.5, 10 arcsec/h). `/api/track?name=Holda`
  (2025-05-14 to 2025-06-10) then listed 110 SPHEREx frames on its path; from those
  I picked the D2 pair with the closest wavelength at the target.
- Epoch A `2025W21_1B_0345_1_D2.dr1`, MJD 60815.7782 (2025-05-20 18:40 UTC), 1.244 um.
- Epoch B `2025W21_2C_0020_1_D2.dr1`, MJD 60817.6125 (2025-05-22 14:42 UTC), 1.234 um.
- Gap 44.0 h. Holda moved 0.133 deg (about 78 px).
- `/api/movers` result: the two strongest single-epoch detections are Holda,
  A-only blob at (68.5, 79.1) SNR 105 and B-only blob at (133.1, 121.4) SNR 102,
  both within 0.5 px of the JPL predictions (68.2, 79.2) and (133.5, 121.6), and both
  carry the pipeline OUTLIER flag. A third A-only blob at (79.0, 126.5) SNR 5.9
  matches 4979 Otawara (V 17.8) predicted at (78.8, 127.0).
- Checked by eye: blink and diff PNGs show the dot vanish and reappear; diff shows a
  blue dot and an orange dot at the predicted places.
- Lesson learned (now in the code): SPHEREx flags moving objects as OUTLIER
  (bit 19). The science service must not mask that bit, or asteroids disappear.

## comet-3i-atlas: interstellar comet 3I/ATLAS (track)

- `/api/track?name=3I&start=2025-08-01&stop=2025-08-25` resolves to
  "ATLAS (C/2025 N1)" in Horizons and returns 160 SPHEREx frames whose footprint
  contains the comet at the image time.
- Aperture photometry (r = 12 arcsec) at the Horizons position in all D5/D6 frames
  (64 px cutouts) shows the comet only where the LVF wavelength at the comet is close
  to the 4.26 um CO2 band:

  | epoch | MJD | wavelength | flux (mJy) | SNR |
  |---|---|---|---|---|
  | 2025W31_2A_0219_3_D5 | 60888.677 | 4.213 um | 4.69 | 26.5 |
  | 2025W32_2D_0189_3_D5 | 60895.537 | 4.200 um | 1.38 | 9.9 |
  | 2025W33_1B_0399_2_D5 | 60900.156 | 4.338 um | 1.47 | 9.9 |
  | 2025W33_1B_0399_4_D5 | 60900.159 | 4.413 um | 0.80 | 5.9 |
  | 2025W31_2A_0156_2_D6 | 60888.336 | 4.788 um | 0.07 | 0.3 |
  | 2025W33_1B_0010_4_D5 | 60898.053 | 3.845 um | -0.09 | -0.9 |

  The other D5/D6 frames on the path, at 3.88 to 4.13 um and 4.42 to 4.88 um, give
  SNR below 3, except two more sub-exposures of visit 0399 (4.38 and 4.41 um, SNR 4
  and 6). Controls:
  - `2025W31_2A_0219_1_D5` at 4.141 um, two minutes before the SNR 26 frame and at
    the same place (the comet moved under 1 px): 0.19 mJy, SNR 1.8. So the 4.21 um
    signal is not a background star but light that exists only near the CO2 band.
  - The same sky positions in March 2026, when the comet was gone:
    247.7134 -16.9174 at 4.10 um gives SNR 1.0, 244.5582 -16.4960 at 4.37 um gives
    SNR -0.7. No star sits under those detections.
- Checked by eye: 64 px zscale cutouts of the 4.21 um frame show a large diffuse blob
  at the centre; the 4.79 and 3.85 um frames show nothing there. zscale shows the coma
  best, so the preset uses it.

## nep-deep-field: north ecliptic pole flipbook (flipbook)

- Field RA 270.2, Dec +66.6, `spherex_dr1_deep`, detector D1, 200 px.
- `/api/epochs?...&det=1` gives 3782 D1 images (all detectors: about 20000).
  I measured the wavelength at the field centre for 40 of them spread over time and
  kept the nine between 0.878 and 0.920 um (MJD 60815 to 61062):
  0256_1 0.890, 0152_1 0.913, 0051_4 0.893, 0399_4 0.896, 0503_3 0.878,
  0622_4 0.920, 0409_4 0.919, 0590_4 0.887, 0045_3 0.880 um.
- Rendered all nine with `align=2025W21_1B_0256_1_D1.deep`: stars and a small
  elongated galaxy (PNG about x 128, y 70) sit on the same pixels in every frame; the
  frame borders rotate (visit 0399 is turned about 45 degrees). This checked the new
  `align` option and the noise-anchored asinh stretch (frames now look the same).
- `/api/movers` between the first and last frame (8 months) finds no real mover, only
  star residuals (no known asteroids at this ecliptic latitude, sb_ident returned 0).
  The preset text does not promise a mover; it explains cadence and rotation.

## barnards-star: Barnard's Star proper motion (blink)

- CDS Sesame gives J2000 RA 269.452077, Dec +4.693365 and proper motion
  (-801.6, +10362.4) mas/yr. `/api/resolve` now moves this to epoch 2025.75:
  RA 269.446324, Dec +4.767485 (otherwise the star would be 4.4 arcmin off centre).
- DR1 covers it from MJD 60902 to 61165. Pair (both D6):
  A `2025W33_2C_0321_1_D6.dr1`, MJD 60902.8654 (2025-08-15), 4.93 um;
  B `2026W19_1A_0046_1_D6.dr1`, MJD 61164.1338 (2026-05-04), 4.79 um.
- Expected motion in 261.3 days: +7.4 arcsec in Dec, -0.6 arcsec in RA.
  Measured flux-weighted centroids: Dec +4.767138 to +4.769276, a shift of +7.7 arcsec
  (1.25 px). The D3 pair at the same times gives +5.1 arcsec (noisier, more saturated).
- Checked at 48 px; the preset uses 200 px because the Compare page always requests
  200 px (so the warm-up caches what the page asks for). Re-checked the 200 px diff below.
- The star core is saturated (OVERFLOW, SUR_ERROR flags), so the diff masks the core;
  the diff clearly shows a blue half and an orange half on opposite sides of the black
  core along the motion direction. The preset text says this honestly: the motion is
  about one pixel, visible as a hop when zoomed in, not a big jump.

## cats-eye-spectrum: NGC 6543 spectrum from the deep field (spectrum)

- `/api/resolve?name=NGC 6543` gives RA 269.639183, Dec +66.632986 (PN).
- `spherex_dr1_deep` has 20761 images covering it (MJD 60789 to 61174).
- `/api/spectrum?ra=269.639183&dec=66.632986&collection=spherex_dr1_deep&max=60&r=12`
  measured 60 epochs spread over all six detectors; 51 were good (5 failed with IRSA
  503 after retries, 4 had too many flagged pixels).
- Result: continuum about 160 to 230 mJy from 1.1 to 4.8 um, rising to about 300 mJy
  below 0.83 um, and a clear line peak at 1.834 to 1.840 um (309 and 371 mJy, errors
  about 0.6 mJy) on both sides of which the flux drops back to 160 to 200 mJy:
  hydrogen Paschen alpha (1.875 um) entering the LVF passband. Smaller bumps at
  2.58, 3.27 and 4.68 um are single points and are not claimed in the preset text.
- Scatter between neighbouring points (about 10 to 20 percent) is larger than the
  photon errors: the nebula is extended and pointing/PSF differ per visit.

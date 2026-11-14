# Wanderer: see the SPHEREx sky move

**Live:** https://wanderer.stellar-trace.tech
**NASA Space Apps Challenge 2026**, challenge *Planet X and SPHEREx*. Team: Wanderer.

Since 2025, NASA's SPHEREx mission has photographed the whole sky every six months in 102 colours of
near-infrared light. Anything that moves between those photos, such as asteroids, comets and nearby fast stars,
shows up as a change. Wanderer is a public web tool that makes those changes easy for anyone to see.

## What it does

- **Explore:** pick any spot by name, coordinates or a click on the real sky map, and see every SPHEREx image
  that covers it.
- **Timeline:** every visit as a date-versus-wavelength chart. The two survey windows six months apart stand out,
  and the best matching image pairs are chosen for you.
- **Compare:** blink, swipe, side by side, difference image and flipbook. Every frame is turned north up from its
  own sky coordinates, so images taken six months apart line up.
- **Known objects:** asteroids and comets predicted by NASA JPL for the exact time of each image are drawn on top
  and move with the flipbook.
- **Find movers:** aligns two images, subtracts them, rejects leftover star residue and matches what remains to
  JPL's catalogue. On the asteroid 872 Holda example it finds Holda in both images and the fainter 4979 Otawara.
- **Track:** give a comet or asteroid name; Wanderer asks JPL Horizons where it was, finds every SPHEREx image that
  caught it and plays them as a movie, with its path in 3D around the Sun (showcase: interstellar comet 3I/ATLAS).
- **Spectrum:** SPHEREx builds a spectrum from many visits. Wanderer measures the target in each one and plots
  brightness against wavelength live as points arrive.
- **SPHEREx right now:** the real current position of the spacecraft over Earth from its live orbital elements,
  and an interactive 3D model of the observatory and its six-detector focal plane.
- **Focus mode:** turn it on and every control explains its purpose in a bubble above it. Dark and light themes.
  Your target, image pair and running jobs are kept when you change pages or reload.

## How it works

```
browser --> web (Caddy: static app, HTTPS) --> gateway (Go) --> science (Python, internal only)
                                                 |--> NASA/IPAC IRSA (SPHEREx images, cutouts)
                                                 |--> NASA JPL SSD (sb_ident, Horizons)
                                                 |--> CDS Sesame (names), CelesTrak (orbit)
```

- `gateway/` Go 1.25: all external requests, retries, caching on disk, background jobs streamed over WebSocket.
- `science/` Python 3.12 (FastAPI, astropy, numpy, scipy): FITS reading, sky coordinate maths, alignment,
  difference images, source detection, photometry.
- `web/` React + TypeScript (Vite), Aladin Lite sky map, three.js 3D views.

Only small cutouts are downloaded, never the full 66 MB images. A SPHEREx detector sees a different wavelength
across its width (a linear variable filter), so Wanderer always reports the wavelength at the target and prefers
image pairs taken at matching wavelengths.

## Run it

Local development:

```sh
scripts/dev.sh            # science on :8091, gateway on :8080
cd web && npm install && npm run dev   # app on http://localhost:5173
```

With Docker:

```sh
docker compose up -d --build                                                  # http://localhost:8000
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build # public HTTPS
```

## Data and credits

- SPHEREx Data Release 1 spectral images: NASA/JPL-Caltech/IPAC, via NASA/IPAC Infrared Science Archive (IRSA).
- Small-body positions and ephemerides: NASA JPL Solar System Dynamics (SB Identification API, Horizons).
- Earth textures: NASA Visible Earth (Blue Marble, Black Marble). SPHEREx images: NASA/JPL-Caltech
  (PIA26531, PIA26543, PIA26352, PIA23869). See `web/public/img/CREDITS.md` and `web/public/textures/CREDITS.md`.
- Name resolution: CDS Sesame (Strasbourg). Sky map: Aladin Lite (CDS) with 2MASS HiPS.
- SPHEREx orbital elements: CelesTrak.
- Star backdrop: Yale Bright Star Catalogue, 5th edition.

Wanderer is not an official NASA product and uses no NASA insignia or logos.

## Use of AI tools

In line with the Space Apps rules on Super Intelligence (SI) tools: a large language model coding assistant was
used to help write and review source code, documentation and the data pipeline in this repository, under the
team's direction. All science results shown come from real mission data, and the team checked them against the
original archives. No images or video in this project are AI generated.

## License

MIT, see `LICENSE`.

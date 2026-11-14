# Texture and image credits

All images here are in the public domain (NASA). Resized for the web (WebP; 2048 x 1024 plus 512 x 256 placeholders), except the star catalogue.

- `earth-day-2k.webp`, `earth-day-512.webp`: NASA Earth Observatory / Visible Earth, Blue Marble Next Generation with topography and
  bathymetry, December 2004 (Reto Stockli, NASA Earth Observatory).
  Source: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry
  (file `world.topo.bathy.200412.3x5400x2700.jpg`).
- `earth-night-2k.webp`, `earth-night-512.webp`: NASA Earth Observatory, Black Marble 2016 (Joshua Stevens, using Suomi NPP VIIRS data
  from Miguel Roman, NASA GSFC). Source: https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/
  (file `BlackMarble_2016_01deg.jpg`).
- `earth-ocean-1k.webp`: water mask derived by Wanderer from the Blue Marble image above (blue, dark pixels), used
  only to place the sun glint on the oceans.
- `stars-hip.bin`: 25,493 stars brighter than V = 7.5 from the Hipparcos Main Catalogue (ESA 1997, ESA SP-1200),
  VizieR catalogue I/239 (CDS Strasbourg, via the CfA mirror). Positions (ICRS), V magnitude and B-V colour packed
  into 6 bytes per star. (The NASA SVS Deep Star Maps were not reachable from the build machine, so the sky is drawn
  from the catalogue instead.)
- `still-spherex.jpg`: rendered by Wanderer from its own code model of SPHEREx, built from NASA/JPL-Caltech images
  PIA25784, PIA26531, PIA26537 and PIA26543 (photojournal.jpl.nasa.gov). Not an official NASA image.

Orbit data: SPHEREx elements from CelesTrak (NORAD 63182); planet and comet positions from JPL Horizons.

"""Wanderer science service.

All FITS pixel work for the gateway: render cutouts to PNG, read metadata
(including the per-pixel wavelength of the SPHEREx linear variable filter),
difference two epochs, project sky points to PNG pixels, aperture photometry
and difference-image source detection.

Coordinate convention for everything returned to the gateway:
PNG pixel coordinates are continuous, (0, 0) is the top-left corner of the PNG
and the centre of the top-left pixel is (0.5, 0.5). The PNG is the FITS array
flipped vertically (FITS row 0 is the bottom row).
"""

from __future__ import annotations

import os
import threading
import warnings
from collections import OrderedDict
from typing import Optional

import numpy as np
from astropy.io import fits
from astropy.utils.exceptions import AstropyWarning
from astropy.visualization import ZScaleInterval
from astropy.wcs import FITSFixedWarning, WCS
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field
from scipy import ndimage

warnings.simplefilter("ignore", category=AstropyWarning)
warnings.simplefilter("ignore", category=FITSFixedWarning)

VERSION = "1.0.0"
app = FastAPI(title="wanderer-science", version=VERSION)

# FLAGS bits that mean "do not trust this pixel" (names from the FLAGS header).
OUTLIER_BIT = 1 << 19
SOURCE_BIT = 1 << 21
# ghosts, crosstalk, halos and blooms: features that come and go between visits
ARTIFACT_BITS = (1 << 20) | (1 << 22) | (1 << 23) | (1 << 24) | (1 << 26) | (1 << 28)
BAD_BITS = (
    (1 << 0)  # TRANSIENT
    | (1 << 1)  # OVERFLOW
    | (1 << 2)  # SUR_ERROR
    | (1 << 6)  # NONFUNC
    | (1 << 9)  # MISSING_DATA
    | (1 << 10)  # HOT
    | (1 << 11)  # COLD
    | (1 << 15)  # NONLINEAR
    # OUTLIER (1 << 19) is deliberately NOT masked: the pipeline sets it on pixels
    # that disagree with other visits, which is exactly where asteroids are.
    | (1 << 25)  # STREAK
    | (1 << 27)  # SNOWBALL
)

ARCSEC_PER_RAD = 206264.80624709636


# --------------------------------------------------------------------------
# FITS loading with a small in-process cache
# --------------------------------------------------------------------------


class Cutout:
    def __init__(self, path: str):
        if not os.path.isfile(path):
            raise HTTPException(404, f"fits not found: {path}")
        with open(path, "rb") as fh:
            if fh.read(6) != b"SIMPLE":
                raise HTTPException(422, "not a FITS file")
        with fits.open(path, memmap=False) as hdul:
            names = [h.name for h in hdul]
            if "IMAGE" not in names:
                raise HTTPException(422, "FITS has no IMAGE extension")
            self.header = hdul["IMAGE"].header.copy()
            self.image = np.asarray(hdul["IMAGE"].data, dtype=np.float64)
            self.zodi = (
                np.asarray(hdul["ZODI"].data, dtype=np.float64) if "ZODI" in names else None
            )
            self.flags = np.asarray(hdul["FLAGS"].data, dtype=np.int64) if "FLAGS" in names else None
            self.variance = (
                np.asarray(hdul["VARIANCE"].data, dtype=np.float64) if "VARIANCE" in names else None
            )
            self.wcs = WCS(self.header, naxis=2)
            self.wave_wcs = None
            if "WCS-WAVE" in names and self.header.get("CTYPE1W", "").startswith("WAVE"):
                try:
                    wh = self.header.copy()
                    for k in list(wh.keys()):
                        if k[:2] in ("A_", "B_") or k[:3] in ("AP_", "BP_"):
                            del wh[k]
                    self.wave_wcs = WCS(wh, fobj=hdul, key="W")
                except Exception:  # noqa: BLE001
                    self.wave_wcs = None
        self.h, self.w = self.image.shape

    # -- helpers ----------------------------------------------------------

    def data(self, sub: str = "none") -> np.ndarray:
        img = self.image.copy()
        if sub == "zodi" and self.zodi is not None:
            img = img - self.zodi
        return img

    def bad_mask(self) -> np.ndarray:
        bad = ~np.isfinite(self.image)
        if self.flags is not None:
            bad |= (self.flags & BAD_BITS) != 0
        return bad

    def mjd(self) -> Optional[float]:
        for k in ("MJD-AVG", "MJD-OBS"):
            if k in self.header:
                return float(self.header[k])
        return None

    def world_to_fits(self, ra, dec):
        x, y = self.wcs.world_to_pixel_values(np.atleast_1d(ra), np.atleast_1d(dec))
        return np.asarray(x, dtype=float), np.asarray(y, dtype=float)

    def fits_to_png(self, x, y):
        return x + 0.5, self.h - 0.5 - y

    def png_to_fits(self, px, py):
        return px - 0.5, self.h - 0.5 - py

    def wave_at(self, x: float, y: float):
        if self.wave_wcs is None:
            return None, None
        try:
            wl, bw = self.wave_wcs.pixel_to_world_values(np.array([x]), np.array([y]))
            wl, bw = float(wl[0]), float(bw[0])
            if not np.isfinite(wl):
                return None, None
            return wl, (bw if np.isfinite(bw) else None)
        except Exception:  # noqa: BLE001
            return None, None

    def pixscale_arcsec(self) -> float:
        try:
            m = self.wcs.pixel_scale_matrix
            return float(np.sqrt(abs(np.linalg.det(m))) * 3600.0)
        except Exception:  # noqa: BLE001
            return 6.15


_cache: "OrderedDict[tuple, Cutout]" = OrderedDict()
_cache_lock = threading.Lock()
_CACHE_MAX = 24


def load(path: str) -> Cutout:
    path = os.path.abspath(path)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        raise HTTPException(404, f"fits not found: {path}")
    key = (path, st.st_mtime_ns, st.st_size)
    with _cache_lock:
        c = _cache.get(key)
        if c is not None:
            _cache.move_to_end(key)
            return c
    c = Cutout(path)
    with _cache_lock:
        _cache[key] = c
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return c


# --------------------------------------------------------------------------
# Stretches and colormaps
# --------------------------------------------------------------------------


def _lut(stops):
    """Build a 256x3 uint8 LUT from (position, (r, g, b)) stops."""
    pos = np.array([s[0] for s in stops], dtype=float)
    cols = np.array([s[1] for s in stops], dtype=float)
    x = np.linspace(0, 1, 256)
    out = np.stack([np.interp(x, pos, cols[:, i]) for i in range(3)], axis=1)
    return np.clip(out, 0, 255).astype(np.uint8)


CMAPS = {
    "gray": _lut([(0, (0, 0, 0)), (1, (255, 255, 255))]),
    "inferno": _lut(
        [
            (0.0, (0, 0, 4)),
            (0.13, (31, 12, 72)),
            (0.25, (85, 15, 109)),
            (0.38, (136, 34, 106)),
            (0.5, (186, 54, 85)),
            (0.63, (227, 89, 51)),
            (0.75, (249, 140, 10)),
            (0.88, (249, 201, 50)),
            (1.0, (252, 255, 164)),
        ]
    ),
    "viridis": _lut(
        [
            (0.0, (68, 1, 84)),
            (0.13, (72, 36, 117)),
            (0.25, (65, 68, 135)),
            (0.38, (53, 95, 141)),
            (0.5, (42, 120, 142)),
            (0.63, (33, 145, 140)),
            (0.75, (34, 168, 132)),
            (0.88, (122, 209, 81)),
            (1.0, (253, 231, 37)),
        ]
    ),
    # Deep space blue to white, good for faint nebulosity.
    "ice": _lut(
        [
            (0.0, (2, 4, 16)),
            (0.3, (14, 40, 92)),
            (0.6, (40, 130, 190)),
            (0.85, (160, 220, 245)),
            (1.0, (255, 255, 255)),
        ]
    ),
    # Infrared "nebula" palette: black, violet, magenta, orange, white.
    "nebula": _lut(
        [
            (0.0, (0, 0, 0)),
            (0.25, (40, 10, 80)),
            (0.5, (150, 30, 120)),
            (0.75, (245, 130, 50)),
            (1.0, (255, 250, 230)),
        ]
    ),
}

# Diverging: blue (B fainter than A / object left) through dark grey to orange.
DIVERGING = _lut(
    [
        (0.0, (80, 170, 255)),
        (0.25, (30, 80, 170)),
        (0.5, (18, 18, 24)),
        (0.75, (190, 80, 20)),
        (1.0, (255, 200, 90)),
    ]
)

STRETCHES = ("asinh", "linear", "log", "zscale", "sqrt")


def stretch_to_unit(img: np.ndarray, stretch: str) -> np.ndarray:
    """Map finite pixels to [0, 1]; NaN stays NaN."""
    finite = np.isfinite(img)
    if not finite.any():
        return np.full(img.shape, np.nan)
    vals = img[finite]
    if stretch == "zscale":
        try:
            lo, hi = ZScaleInterval().get_limits(vals)
        except Exception:  # noqa: BLE001
            lo, hi = np.percentile(vals, [1, 99.5])
        out = (img - lo) / max(hi - lo, 1e-12)
        return np.clip(out, 0, 1)
    lo, hi = np.percentile(vals, [0.5, 99.8])
    if stretch in ("asinh", "log", "sqrt"):
        # Anchor black just below the sky level so the noise stays dark grey
        # and faint sources still show.
        # The top end is tied to the noise, not to the brightest star, so a
        # flipbook of many visits keeps the same look from frame to frame.
        med, mad = float(np.median(vals)), _mad(vals)
        if mad > 0:
            lo = med - 2.0 * mad
            hi = med + 200.0 * mad
    if hi <= lo:
        hi = lo + 1e-12
    x = np.clip((img - lo) / (hi - lo), 0, 1)
    if stretch == "asinh":
        a = 0.05
        x = np.arcsinh(x / a) / np.arcsinh(1 / a)
    elif stretch == "log":
        a = 50.0
        x = np.log1p(a * x) / np.log1p(a)
    elif stretch == "sqrt":
        x = np.sqrt(x)
    return x


def _mad(v: np.ndarray) -> float:
    v = v[np.isfinite(v)]
    if v.size == 0:
        return 0.0
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def to_png(unit: np.ndarray, lut: np.ndarray, out: str, nan_rgb=(0, 0, 0)) -> None:
    """unit is a FITS-oriented array in [0, 1] (NaN allowed). Writes a north-of-row-0-flipped PNG."""
    idx = np.nan_to_num(unit, nan=0.0)
    idx = np.clip((idx * 255).round(), 0, 255).astype(np.uint8)
    rgb = lut[idx]
    rgb[~np.isfinite(unit)] = nan_rgb
    rgb = np.flipud(rgb)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + ".tmp.png"
    Image.fromarray(rgb, "RGB").save(tmp, optimize=False, compress_level=6)
    os.replace(tmp, out)


# --------------------------------------------------------------------------
# Meta
# --------------------------------------------------------------------------


def stats_of(img: np.ndarray) -> dict:
    v = img[np.isfinite(img)]
    if v.size == 0:
        return {"min": None, "max": None, "median": None, "mad": None}
    return {
        "min": float(v.min()),
        "max": float(v.max()),
        "median": float(np.median(v)),
        "mad": _mad(v),
    }


def meta_of(c: Cutout, ra: Optional[float] = None, dec: Optional[float] = None) -> dict:
    h = c.header
    if ra is None or dec is None:
        x0, y0 = (c.w - 1) / 2.0, (c.h - 1) / 2.0
    else:
        xs, ys = c.world_to_fits(ra, dec)
        x0, y0 = float(xs[0]), float(ys[0])
    wl, bw = c.wave_at(x0, y0)
    w = c.wcs.wcs
    sip = None
    if c.wcs.sip is not None:
        sip = {
            "a_order": int(h.get("A_ORDER", 0)),
            "b_order": int(h.get("B_ORDER", 0)),
            "a": c.wcs.sip.a.tolist(),
            "b": c.wcs.sip.b.tolist(),
        }
    # Corners in PNG order: top-left, top-right, bottom-right, bottom-left.
    cx = np.array([-0.5, c.w - 0.5, c.w - 0.5, -0.5])
    cy = np.array([c.h - 0.5, c.h - 0.5, -0.5, -0.5])
    cra, cdec = c.wcs.pixel_to_world_values(cx, cy)
    in_frame = bool(-0.5 <= x0 <= c.w - 0.5 and -0.5 <= y0 <= c.h - 0.5)
    tx, ty = c.fits_to_png(x0, y0)
    return {
        "mjd": c.mjd(),
        "date_obs": h.get("DATE-AVG") or h.get("DATE-OBS"),
        "det": int(h.get("DETECTOR", 0)) or None,
        "obsid": h.get("OBSID"),
        "width": int(c.w),
        "height": int(c.h),
        "wave_um_at_target": wl,
        "bandwidth_um": bw,
        "pixscale_arcsec": c.pixscale_arcsec(),
        "target_px": [float(tx), float(ty)],
        "target_in_frame": in_frame,
        "wcs": {
            "crval": [float(v) for v in w.crval],
            "crpix": [float(v) for v in w.crpix],
            "cd": c.wcs.pixel_scale_matrix.tolist(),
            "ctype": [str(t) for t in w.ctype],
            "sip": sip,
        },
        "corners": [[float(a), float(b)] for a, b in zip(cra, cdec)],
        "stats": stats_of(c.image),
        "bunit": h.get("BUNIT"),
    }


# --------------------------------------------------------------------------
# Reprojection and difference
# --------------------------------------------------------------------------


def reproject_onto(src: Cutout, dst: Cutout, arr: np.ndarray, order: int = 1) -> np.ndarray:
    """Resample src-grid array onto the dst pixel grid. NaN where src has no data."""
    yy, xx = np.mgrid[0 : dst.h, 0 : dst.w]
    ra, dec = dst.wcs.pixel_to_world_values(xx.ravel().astype(float), yy.ravel().astype(float))
    sx, sy = src.wcs.world_to_pixel_values(ra, dec)
    good = np.isfinite(arr)
    filled = np.where(good, arr, 0.0)
    coords = np.vstack([np.asarray(sy, float), np.asarray(sx, float)])
    val = ndimage.map_coordinates(filled, coords, order=order, mode="constant", cval=np.nan)
    wgt = ndimage.map_coordinates(good.astype(float), coords, order=1, mode="constant", cval=0.0)
    val = np.where(wgt > 0.99, val, np.nan)
    return val.reshape(dst.h, dst.w)


def _bg_sub(img: np.ndarray, bad: np.ndarray) -> np.ndarray:
    out = img.copy()
    out[bad] = np.nan
    v = out[np.isfinite(out)]
    if v.size:
        out -= np.median(v)
    return out


def psf_sigma(img: np.ndarray) -> Optional[float]:
    """Median Gaussian sigma (pixels) of bright, isolated stars, from second moments."""
    finite = np.isfinite(img)
    if finite.sum() < 100:
        return None
    s = _mad(img[finite]) or 1.0
    z = np.where(finite, img, 0.0)
    peaks = (z == ndimage.maximum_filter(z, size=7)) & (z > 25 * s)
    ys, xs = np.nonzero(peaks)
    h, w = img.shape
    yy, xx = np.mgrid[-4:5, -4:5]
    rr = xx**2 + yy**2
    sig = []
    for y, x in zip(ys, xs):
        if y < 5 or x < 5 or y >= h - 5 or x >= w - 5:
            continue
        st = img[y - 4 : y + 5, x - 4 : x + 5]
        if not np.isfinite(st).all():
            continue
        st = np.clip(st, 0, None) * (rr <= 16)
        tot = st.sum()
        if tot <= 0:
            continue
        cx, cy = (st * xx).sum() / tot, (st * yy).sum() / tot
        m2 = (st * ((xx - cx) ** 2 + (yy - cy) ** 2)).sum() / tot
        if m2 > 0:
            sig.append(np.sqrt(m2 / 2.0))
        if len(sig) >= 40:
            break
    if len(sig) < 3:
        return None
    return float(np.median(sig))


def _smooth_nan(img: np.ndarray, sigma: float) -> np.ndarray:
    good = np.isfinite(img)
    out = ndimage.gaussian_filter(np.where(good, img, 0.0), sigma)
    wgt = ndimage.gaussian_filter(good.astype(float), sigma)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(wgt > 0.5, out / wgt, np.nan)
    out[~good] = np.nan
    return out


def diff_arrays(a: Cutout, b: Cutout, match: bool = True):
    """Returns (A_bgsub, B_on_A_bgsub, diff, sigma, scale).

    B is resampled onto A's pixel grid, the sharper image is blurred to the
    other's PSF width, and B is scaled to A by the ratio of summed flux in
    pixels bright in both images. B minus A: positive = only in B.
    """
    A = _bg_sub(a.data("zodi"), a.bad_mask())
    Bsrc = _bg_sub(b.data("zodi"), b.bad_mask())
    B = reproject_onto(b, a, Bsrc)
    both = np.isfinite(A) & np.isfinite(B)
    scale = 1.0
    if match and both.sum() > 50:
        pa, pb = psf_sigma(np.where(both, A, np.nan)), psf_sigma(np.where(both, B, np.nan))
        if pa and pb and abs(pa - pb) > 0.05:
            k = float(np.sqrt(abs(pa**2 - pb**2)))
            if pa > pb:
                B = _smooth_nan(B, k)
            else:
                A = _smooth_nan(A, k)
            both = np.isfinite(A) & np.isfinite(B)
        sa, sb = _mad(A[both]), _mad(B[both])
        # Global flux normalisation only: LVF wavelength changes alter star colours.
        sel = both & (A > 8 * max(sa, 1e-12)) & (B > 8 * max(sb, 1e-12))
        if sel.sum() > 20:
            s = float(np.sum(A[sel]) / np.sum(B[sel]))
            if np.isfinite(s) and 0.2 < s < 5:
                scale = s
    D = scale * B - A
    sig = _mad(D[np.isfinite(D)]) or 1.0
    return A, B * scale, D, sig, scale


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------


class RenderReq(BaseModel):
    fits: str
    out: str
    stretch: str = "asinh"
    cmap: str = "gray"
    sub: str = "none"
    ref: Optional[str] = None  # resample onto this cutout's pixel grid (aligned blink)


class RgbReq(BaseModel):
    r: str  # FITS for the red channel (longest wavelength)
    g: str
    b: str
    out: str
    stretch: str = "asinh"
    sub: str = "zodi"


class MetaReq(BaseModel):
    fits: str
    ra: Optional[float] = None
    dec: Optional[float] = None


class DiffReq(BaseModel):
    a: str
    b: str
    out: str
    stretch: str = "linear"
    match: bool = True
    limit_sigma: float = 6.0


class ProjectReq(BaseModel):
    fits: str
    points: list[list[float]] = Field(default_factory=list)


class PhotReq(BaseModel):
    fits: str
    ra: float
    dec: float
    r_arcsec: float = 12.0
    annulus_in_arcsec: Optional[float] = None
    annulus_out_arcsec: Optional[float] = None


class DetectReq(BaseModel):
    a: str
    b: str
    nsigma: float = 5.0
    max_sources: int = 50
    include_rejected: bool = False  # also return rejected candidates, with "rejected" reason


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "version": VERSION}


@app.post("/render")
def render(req: RenderReq):
    if req.stretch not in STRETCHES:
        raise HTTPException(400, f"stretch must be one of {STRETCHES}")
    if req.cmap not in CMAPS:
        raise HTTPException(400, f"cmap must be one of {sorted(CMAPS)}")
    c = load(req.fits)
    img = c.data(req.sub)
    img[~np.isfinite(c.image)] = np.nan
    grid = c
    if req.ref and os.path.abspath(req.ref) != os.path.abspath(req.fits):
        grid = load(req.ref)
        img = reproject_onto(c, grid, img)
    unit = stretch_to_unit(img, req.stretch)
    to_png(unit, CMAPS[req.cmap], req.out)
    m = meta_of(grid)
    m["out"] = req.out
    m["aligned_to_ref"] = grid is not c
    return m


@app.post("/rgb")
def rgb(req: RgbReq):
    """False-colour image from three cutouts of the same spot: each channel is
    resampled onto the green cutout's pixel grid and stretched on its own."""
    if req.stretch not in STRETCHES:
        raise HTTPException(400, f"stretch must be one of {STRETCHES}")
    grid = load(req.g)
    chans = []
    for path in (req.r, req.g, req.b):
        c = load(path)
        img = c.data(req.sub)
        img[~np.isfinite(c.image)] = np.nan
        if c is not grid and os.path.abspath(path) != os.path.abspath(req.g):
            img = reproject_onto(c, grid, img)
        chans.append(stretch_to_unit(img, req.stretch))
    cube = np.stack(chans, axis=-1)
    nodata = ~np.isfinite(cube).all(axis=-1)
    rgb8 = np.clip(np.nan_to_num(cube, nan=0.0) * 255, 0, 255).round().astype(np.uint8)
    rgb8[nodata] = 0
    rgb8 = np.flipud(rgb8)
    os.makedirs(os.path.dirname(os.path.abspath(req.out)), exist_ok=True)
    tmp = req.out + ".tmp.png"
    Image.fromarray(rgb8, "RGB").save(tmp, optimize=False, compress_level=6)
    os.replace(tmp, req.out)
    m = meta_of(grid)
    m["out"] = req.out
    m["coverage"] = float(1.0 - nodata.mean())
    return m


@app.post("/meta")
def meta(req: MetaReq):
    return meta_of(load(req.fits), req.ra, req.dec)


@app.post("/diff")
def diff(req: DiffReq):
    a, b = load(req.a), load(req.b)
    A, B, D, sig, scale = diff_arrays(a, b, req.match)
    z = D / sig
    lim = max(req.limit_sigma, 1.0)
    if req.stretch == "asinh":
        unit = 0.5 + 0.5 * np.arcsinh(z / 2.0) / np.arcsinh(lim * 4 / 2.0)
    else:
        unit = 0.5 + 0.5 * np.clip(z / lim, -1, 1)
    unit = np.clip(unit, 0, 1)
    to_png(unit, DIVERGING, req.out, nan_rgb=(0, 0, 0))
    overlap = float(np.isfinite(D).mean())
    return {
        "rms": float(sig),
        "scale": scale,
        "overlap": overlap,
        "out": req.out,
        "mjd_a": a.mjd(),
        "mjd_b": b.mjd(),
    }


@app.post("/project")
def project(req: ProjectReq):
    c = load(req.fits)
    if not req.points:
        return {"pixels": [], "width": c.w, "height": c.h}
    pts = np.asarray(req.points, dtype=float).reshape(-1, 2)
    x, y = c.world_to_fits(pts[:, 0], pts[:, 1])
    px, py = c.fits_to_png(x, y)
    pixels = [
        [float(a), float(b)] if np.isfinite(a) and np.isfinite(b) else None for a, b in zip(px, py)
    ]
    return {"pixels": pixels, "width": c.w, "height": c.h}


def _aperture_weights(shape, x0, y0, r, sub=5):
    """Fractional pixel coverage of a circle (sub-sampled)."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - x0, yy - y0)
    wgt = np.zeros(shape)
    full = d <= r - 0.75
    wgt[full] = 1.0
    edge = (d > r - 0.75) & (d < r + 0.75)
    if edge.any():
        offs = (np.arange(sub) + 0.5) / sub - 0.5
        ox, oy = np.meshgrid(offs, offs)
        ey, ex = np.nonzero(edge)
        for i, j in zip(ey, ex):
            wgt[i, j] = np.mean(np.hypot(j + ox - x0, i + oy - y0) <= r)
    return wgt, d


@app.post("/photometry")
def photometry(req: PhotReq):
    c = load(req.fits)
    xs, ys = c.world_to_fits(req.ra, req.dec)
    x0, y0 = float(xs[0]), float(ys[0])
    ps = c.pixscale_arcsec()
    r = max(req.r_arcsec / ps, 1.0)
    rin = (req.annulus_in_arcsec / ps) if req.annulus_in_arcsec else r * 2.0
    rout = (req.annulus_out_arcsec / ps) if req.annulus_out_arcsec else r * 3.5
    wl, bw = c.wave_at(x0, y0)
    base = {
        "mjd": c.mjd(),
        "wave_um": wl,
        "bandwidth_um": bw,
        "det": int(c.header.get("DETECTOR", 0)) or None,
        "x": x0,
        "y": y0,
        "unit": "mJy",
    }
    if not (r <= x0 <= c.w - 1 - r and r <= y0 <= c.h - 1 - r):
        return {**base, "flux": None, "err": None, "ok": False, "reason": "target outside cutout"}
    img = c.data("none")
    bad = c.bad_mask()
    wgt, d = _aperture_weights(img.shape, x0, y0, r)
    ann = (d >= rin) & (d <= rout) & ~bad
    ap_bad = (wgt > 0) & bad
    nap = float(wgt.sum())
    bad_frac = float(wgt[ap_bad].sum() / nap) if nap else 1.0
    if ann.sum() < 10:
        return {**base, "flux": None, "err": None, "ok": False, "reason": "background annulus empty"}
    bvals = img[ann]
    # sigma-clipped background
    for _ in range(3):
        med, s = np.median(bvals), _mad(bvals)
        keep = np.abs(bvals - med) < 3 * max(s, 1e-12)
        if keep.all():
            break
        bvals = bvals[keep]
    bkg = float(np.median(bvals))
    bkg_sig = _mad(bvals)
    use = (wgt > 0) & ~bad
    # Replace bad aperture pixels by the background so they do not bias the sum.
    src = np.where(use, img - bkg, 0.0)
    total = float(np.sum(src * wgt))  # MJy/sr * pixels
    sr_pix = (ps / ARCSEC_PER_RAD) ** 2
    to_mjy = 1e6 * sr_pix * 1e3  # MJy/sr * sr -> Jy -> mJy
    if c.variance is not None:
        var = np.where(use, c.variance, 0.0)
        var_sum = float(np.nansum(var * wgt**2))
    else:
        var_sum = nap * bkg_sig**2
    var_sum += nap**2 * bkg_sig**2 / max(len(bvals), 1)
    flux = total * to_mjy
    err = float(np.sqrt(max(var_sum, 0.0))) * to_mjy
    return {
        **base,
        "flux": flux,
        "err": err,
        "ok": bool(np.isfinite(flux) and bad_frac < 0.3),
        "bad_fraction": bad_frac,
        "background": bkg,
        "r_px": r,
    }


@app.post("/detect")
def detect(req: DetectReq):
    a, b = load(req.a), load(req.b)
    A, B, D, sig, scale = diff_arrays(a, b, True)
    valid = np.isfinite(D)
    Dz = np.where(valid, D / sig, 0.0)
    # Matched filter: smooth by roughly the PSF and re-normalise.
    sm = ndimage.gaussian_filter(Dz, 1.0)
    vs = sm[valid]
    s_sm = _mad(vs) or 1.0
    sm = sm / s_sm
    sm[~ndimage.binary_erosion(valid, iterations=3)] = 0.0
    sa = _mad(A[np.isfinite(A)]) or 1.0
    sb = _mad(B[np.isfinite(B)]) or 1.0
    Az = np.where(np.isfinite(A), A / sa, np.nan)
    Bz = np.where(np.isfinite(B), B / sb, np.nan)
    sources = []
    for sign in (1, -1):
        mask = (sign * sm) > req.nsigma
        lab, n = ndimage.label(mask)
        if n == 0:
            continue
        idx = np.arange(1, n + 1)
        peaks = ndimage.maximum(sign * sm, lab, idx)
        sizes = ndimage.sum(np.ones_like(sm), lab, idx)
        coms = ndimage.center_of_mass(np.where(mask, sign * sm, 0), lab, idx)
        for pk, npix, (cy, cx) in zip(peaks, sizes, coms):
            if npix < 2:
                continue
            iy, ix = int(round(cy)), int(round(cx))
            # A real mover is present in one epoch only: around the blob, the
            # "other" epoch must look like sky. PSF shape changes across the
            # focal plane leave offset residuals on stars, so look 2 px around.
            other = Az if sign > 0 else Bz
            this = Bz if sign > 0 else Az
            y0, y1 = max(iy - 2, 0), min(iy + 3, a.h)
            x0, x1 = max(ix - 2, 0), min(ix + 3, a.w)
            o = other[y0:y1, x0:x1]
            t = this[y0:y1, x0:x1]
            other_peak = float(np.nanmax(o)) if np.isfinite(o).any() else np.nan
            this_peak = float(np.nanmax(t)) if np.isfinite(t).any() else np.nan
            clean = bool(
                np.isfinite(other_peak)
                and np.isfinite(this_peak)
                and other_peak < max(5.0, 0.15 * this_peak)
            )
            # The pipeline marks pixels that disagree with other visits as OUTLIER.
            src_img = b if sign > 0 else a
            if src_img is b:
                bx, by = b.world_to_fits(*a.wcs.pixel_to_world_values(np.array([cx]), np.array([cy])))
                bx, by = int(round(bx[0])), int(round(by[0]))
            else:
                bx, by = ix, iy
            outlier = False
            artifact_bits = 0
            if src_img.flags is not None and 0 <= by < src_img.h and 0 <= bx < src_img.w:
                fy0, fy1 = max(by - 1, 0), min(by + 2, src_img.h)
                fx0, fx1 = max(bx - 1, 0), min(bx + 2, src_img.w)
                outlier = bool((src_img.flags[fy0:fy1, fx0:fx1] & OUTLIER_BIT).any())
                artifact_bits = int(np.bitwise_or.reduce(src_img.flags[fy0:fy1, fx0:fx1].ravel()) & ARTIFACT_BITS)
            else:
                artifact_bits = 0
            # Catalogued star in the OTHER epoch at this spot: a static star, so a
            # one-epoch blob here is an image defect, not a mover.
            oth_img = a if src_img is b else b
            if src_img is b:
                ox, oy = ix, iy
            else:
                ox, oy = [int(round(v[0])) for v in b.world_to_fits(*a.wcs.pixel_to_world_values(np.array([cx]), np.array([cy])))]
            other_catalog = False
            if oth_img.flags is not None and 0 <= oy < oth_img.h and 0 <= ox < oth_img.w:
                other_catalog = bool(oth_img.flags[oy, ox] & SOURCE_BIT)
            # Sharpness: cosmic rays and hot pixels put most flux in one pixel,
            # real sources follow the ~1.5 px PSF.
            tz = (Bz if sign > 0 else Az)[max(iy - 1, 0) : iy + 2, max(ix - 1, 0) : ix + 2]
            tz = np.clip(np.nan_to_num(tz), 0, None)
            sharp = float(tz.max() / tz.sum()) if tz.sum() > 0 else 1.0
            ra, dec = a.wcs.pixel_to_world_values(np.array([cx]), np.array([cy]))
            px, py = a.fits_to_png(cx, cy)
            sources.append(
                {
                    "x": float(px),
                    "y": float(py),
                    "ra": float(ra[0]),
                    "dec": float(dec[0]),
                    "snr": float(pk),
                    "sign": int(sign),
                    "npix": int(npix),
                    "single_epoch": clean,
                    "outlier_flag": outlier,
                    "sharpness": sharp,
                    "_artifact": artifact_bits,
                    "_other_catalog": other_catalog,
                }
            )
    # Reject what a real mover cannot look like:
    #  - "static": a source is present at that spot in BOTH epochs (star residual
    #    from PSF changes or sub-pixel misregistration);
    #  - "dipole": a positive and a negative blob within 2.5 px with similar
    #    strength (same star, slightly shifted or reshaped). A mover's two
    #    positions are far apart unless it barely moved, and then it is not
    #    separable at 6 arcsec pixels anyway.
    for s_ in sources:
        s_["rejected"] = None if s_["single_epoch"] else "static"
        if not s_["rejected"] and s_.pop("_other_catalog"):
            s_["rejected"] = "catalog_star_in_other_epoch"
        elif not s_["rejected"] and s_["sharpness"] > 0.6:
            s_["rejected"] = "too_sharp"
        elif not s_["rejected"] and s_["_artifact"]:
            s_["rejected"] = "artifact_flag"
        s_.pop("_other_catalog", None)
        s_.pop("_artifact", None)
    for i, s1 in enumerate(sources):
        for s2 in sources[i + 1 :]:
            if s1["sign"] == s2["sign"]:
                continue
            d = np.hypot(s1["x"] - s2["x"], s1["y"] - s2["y"])
            ratio = s1["snr"] / max(s2["snr"], 1e-9)
            if d <= 2.5 and 1 / 3 <= ratio <= 3:
                for t in (s1, s2):
                    t["rejected"] = t["rejected"] or "dipole"
    reasons: dict = {}
    for s_ in sources:
        if s_["rejected"]:
            reasons[s_["rejected"]] = reasons.get(s_["rejected"], 0) + 1
    kept = [s_ for s_ in sources if not s_["rejected"]]
    out = sources if req.include_rejected else kept
    out.sort(key=lambda s: (s["rejected"] is not None, -s["snr"]))
    return {
        "sources": out[: req.max_sources],
        "candidates": len(sources),
        "rejected": len(sources) - len(kept),
        "rejected_reasons": reasons,
        "rms": float(sig),
        "scale": scale,
        "mjd_a": a.mjd(),
        "mjd_b": b.mjd(),
        "width": a.w,
        "height": a.h,
    }

// Typed mock of the gateway (VITE_MOCK=1). It draws synthetic SPHEREx-like cutouts
// on a canvas: a fixed star field, one asteroid that moves between epochs and one
// fast star that shifts across the 6 month gap, so Blink, Flipbook and Movers show
// real motion while the gateway is not running. Nothing here is real data.
import type {
  Api, Cmap, CutoutMeta, CutoutParams, DiffParams, Epoch, EpochList, JobStatus, KnownBody,
  Resolved, Stretch,
} from './types';
import { mjdToIso } from './client';
import { FALLBACK_PRESETS as PRESETS } from './presets';

const PIX = 6.15; // arcsec per pixel
const DET_RANGE: Record<number, [number, number]> = {
  1: [0.75, 1.09], 2: [1.1, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.0],
};
const D2R = Math.PI / 180;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e6) / 1e6;
  };
}
const hash = (str: string) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- epochs ----------
function makeEpochs(ra: number, dec: number, collection: string): Epoch[] {
  const r = rng(hash(`${ra.toFixed(3)}${dec.toFixed(3)}${collection}`));
  const out: Epoch[] = [];
  const deep = collection === 'spherex_dr1_deep';
  const windows: [number, number][] = deep
    ? [[60811, 60833], [60860, 60870], [60905, 60915], [60950, 60960], [60990, 61000], [61028, 61037]]
    : [[60811, 60833], [61028, 61037]];
  let n = 0;
  for (const [w0, w1] of windows) {
    for (let det = 1; det <= 6; det++) {
      const visits = deep ? 3 + Math.floor(r() * 3) : 2 + Math.floor(r() * 3);
      const start = w0 + r() * (w1 - w0 - visits);
      for (let v = 0; v < visits; v++) {
        const mjd = +(start + v * (0.9 + r() * 0.3) + det * 0.013).toFixed(5);
        const [lo, hi] = DET_RANGE[det];
        // Linear variable filter: the target lands on a different column each visit.
        const c = lo + (hi - lo) * (0.08 + 0.84 * r());
        const bw = c / (det <= 4 ? 41 : det === 5 ? 110 : 130);
        const obs = `2025W${String(Math.floor(mjd)).slice(-3)}_${String(1000 + (n++ % 9000)).padStart(4, '0')}`;
        out.push({
          id: `${obs}_D${det}~${deep ? 'deep' : 'wide'}`,
          obs_id: obs,
          det,
          band: `SPHEREx-D${det}`,
          mjd,
          date: mjdToIso(mjd),
          exptime: 112.0,
          em_min_um: +(c - bw / 2).toFixed(4),
          em_max_um: +(c + bw / 2).toFixed(4),
          collection,
        });
      }
    }
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}
const epochIndex = new Map<string, Epoch>();
function epochById(id: string): Epoch | undefined {
  return epochIndex.get(id);
}

// ---------- synthetic sky ----------
interface Star { dx: number; dy: number; f: number; }
const fields = new Map<string, Star[]>();
function field(ra: number, dec: number): Star[] {
  // Fixed per target (rounded) so every epoch of the same target shows the same stars.
  const key = `${ra.toFixed(2)},${dec.toFixed(2)}`;
  let s = fields.get(key);
  if (!s) {
    const r = rng(hash(key));
    s = [];
    for (let i = 0; i < 260; i++) s.push({ dx: (r() - 0.5) * 320, dy: (r() - 0.5) * 320, f: Math.pow(r(), 4) * 9 + 0.15 });
    fields.set(key, s);
  }
  return s;
}

// Sky offsets in pixels for the two mock movers.
function asteroidOffset(mjd: number): [number, number] {
  // Moves ~11 px per day along a tilted line, wrapping inside the field.
  const t = ((mjd - 60800) * 11) % 170;
  return [-85 + t, -40 + t * 0.45];
}
function fastStarOffset(mjd: number): [number, number] {
  const yrs = (mjd - 60811) / 365.25;
  return [22 + yrs * 18, 30 - yrs * 12];
}

function skyToPix(ra0: number, dec0: number, size: number, ra: number, dec: number): [number, number] {
  const c = size / 2;
  let dra = ra - ra0;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  return [c - (dra * Math.cos(dec0 * D2R) * 3600) / PIX, c - ((dec - dec0) * 3600) / PIX];
}
function pixToSky(ra0: number, dec0: number, size: number, x: number, y: number): [number, number] {
  const c = size / 2;
  const dec = dec0 - ((y - c) * PIX) / 3600;
  const ra = ra0 - ((x - c) * PIX) / 3600 / Math.cos(dec0 * D2R);
  return [(ra + 360) % 360, dec];
}

function renderFloat(p: { id: string; ra: number; dec: number; size: number; sub: boolean }): Float32Array {
  const { size } = p;
  const ep = epochById(p.id);
  const mjd = ep?.mjd ?? 60811;
  const det = ep?.det ?? 1;
  const isTrack = p.id.startsWith('trk');
  const r = rng(hash(p.id + size));
  const img = new Float32Array(size * size);
  const bg = p.sub ? 0.02 : 0.35 + det * 0.06; // zodiacal light grows with wavelength
  for (let i = 0; i < img.length; i++) img[i] = bg + (r() - 0.5) * 0.12 + (r() - 0.5) * 0.06;
  const sigma = 0.75 + det * 0.08;
  const add = (x: number, y: number, f: number) => {
    const rad = Math.ceil(sigma * 4);
    const xi = Math.round(x), yi = Math.round(y);
    for (let yy = yi - rad; yy <= yi + rad; yy++) {
      if (yy < 0 || yy >= size) continue;
      for (let xx = xi - rad; xx <= xi + rad; xx++) {
        if (xx < 0 || xx >= size) continue;
        const d2 = (xx - x) ** 2 + (yy - y) ** 2;
        img[yy * size + xx] += f * Math.exp(-d2 / (2 * sigma * sigma));
      }
    }
  };
  const c = size / 2;
  const colour = 0.7 + 0.12 * det;
  if (isTrack) {
    // Track stamps follow the object: stars drift, the object stays centred.
    const st = field(Math.round(p.ra), Math.round(p.dec));
    const shift = (p.ra * 3600) / PIX;
    for (const s of st) add(c + ((s.dx + shift) % 320) - 0, c + s.dy, s.f * colour);
    add(c, c, 5.5);
    add(c - 1.4, c + 0.8, 1.8); // faint coma
    return img;
  }
  for (const s of field(p.ra, p.dec)) add(c + s.dx, c + s.dy, s.f * colour);
  const [ax, ay] = asteroidOffset(mjd);
  add(c + ax, c + ay, 3.2);
  const [fx, fy] = fastStarOffset(mjd);
  add(c + fx, c + fy, 6 * (det >= 4 ? 1.6 : 0.8));
  return img;
}

const CMAPS: Record<Cmap, number[][]> = {
  gray: [[0, 0, 0], [255, 255, 255]],
  inferno: [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]],
  magma: [[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]],
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  cividis: [[0, 32, 77], [65, 77, 107], [124, 123, 120], [188, 175, 111], [255, 234, 70]],
};
function lut(cmap: Cmap, t: number): number[] {
  const stops = CMAPS[cmap] || CMAPS.gray;
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f);
}
function stretchFn(s: Stretch, t: number): number {
  t = Math.min(1, Math.max(0, t));
  switch (s) {
    case 'asinh': return Math.asinh(t * 10) / Math.asinh(10);
    case 'log': return Math.log10(1 + 99 * t) / 2;
    case 'sqrt': return Math.sqrt(t);
    case 'zscale': return Math.min(1, t * 2.2);
    default: return t;
  }
}
function pct(arr: Float32Array, q: number) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))];
}
function toDataUrl(size: number, fill: (o: Uint8ClampedArray) => void): string {
  if (typeof document === 'undefined') return '';
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const id = ctx.createImageData(size, size);
  fill(id.data);
  ctx.putImageData(id, 0, 0);
  return cv.toDataURL('image/png');
}

const urlCache = new Map<string, string>();
function cutout(p: CutoutParams): string {
  const key = JSON.stringify(p);
  const hit = urlCache.get(key);
  if (hit) return hit;
  const img = renderFloat(p);
  const lo = pct(img, 0.02), hi = pct(img, 0.998);
  const url = toDataUrl(p.size, (o) => {
    for (let i = 0; i < img.length; i++) {
      const [r, g, b] = lut(p.cmap, stretchFn(p.stretch, (img[i] - lo) / (hi - lo || 1)));
      o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b; o[i * 4 + 3] = 255;
    }
  });
  urlCache.set(key, url);
  return url;
}
function diff(p: DiffParams): string {
  const key = 'diff' + JSON.stringify(p);
  const hit = urlCache.get(key);
  if (hit) return hit;
  const a = renderFloat({ id: p.a, ra: p.ra, dec: p.dec, size: p.size, sub: true });
  const b = renderFloat({ id: p.b, ra: p.ra, dec: p.dec, size: p.size, sub: true });
  const d = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = b[i] - a[i];
  let m = 0;
  for (const v of d) m = Math.max(m, Math.abs(v));
  m = m * 0.6 || 1;
  const url = toDataUrl(p.size, (o) => {
    for (let i = 0; i < d.length; i++) {
      let t = d[i] / m;
      t = Math.max(-1, Math.min(1, p.stretch === 'asinh' ? Math.asinh(t * 4) / Math.asinh(4) : t));
      // diverging: blue (B fainter) to near-white to red (B brighter)
      const w = 1 - Math.abs(t);
      const r = t > 0 ? 255 : 255 * w + 40 * (1 - w);
      const g = 255 * w + (t > 0 ? 60 : 110) * (1 - w);
      const bl = t < 0 ? 255 : 255 * w + 40 * (1 - w);
      o[i * 4] = r * 0.92; o[i * 4 + 1] = g * 0.92; o[i * 4 + 2] = bl * 0.92; o[i * 4 + 3] = 255;
    }
  });
  urlCache.set(key, url);
  return url;
}

// ---------- jobs ----------
type JobRun = { status: JobStatus; listeners: Set<(s: JobStatus) => void> };
const jobs = new Map<string, JobRun>();
let jobN = 0;
function runJob(steps: string[], durationMs: number, result: () => unknown): string {
  const job = `mock-${++jobN}`;
  const run: JobRun = { status: { job, state: 'queued', progress: 0, message: 'Queued', result: undefined }, listeners: new Set() };
  jobs.set(job, run);
  const push = (s: Partial<JobStatus>) => {
    run.status = { ...run.status, ...s };
    for (const l of run.listeners) l(run.status);
  };
  (async () => {
    await delay(250);
    for (let i = 0; i < steps.length; i++) {
      push({ state: 'running', progress: i / steps.length, message: steps[i] });
      await delay(durationMs / steps.length);
    }
    push({ state: 'done', progress: 1, message: 'Done', result: result() });
  })();
  return job;
}

const NAMES: Record<string, Resolved> = {
  m42: { name: 'M42', ra: 83.822, dec: -5.391, kind: 'fixed', source: 'mock Sesame' },
  "barnard's star": { name: "Barnard's Star", ra: 269.452, dec: 4.6934, kind: 'fixed', source: 'mock Sesame' },
  '3i/atlas': { name: '3I/ATLAS', ra: 270.5, dec: -18.9, kind: 'moving', source: 'mock Horizons' },
  ceres: { name: '1 Ceres', ra: 236.1, dec: -15.2, kind: 'moving', source: 'mock Horizons' },
};

export const mockApi: Api = {
  mode: 'mock',
  async health() {
    await delay(50);
    return { ok: true, science: true, version: 'mock' };
  },
  async resolve(name) {
    await delay(220);
    const k = name.trim().toLowerCase();
    if (NAMES[k]) return NAMES[k];
    if (!k) throw new Error('Type a name first.');
    const h = hash(k);
    return { name: name.trim(), ra: (h % 36000) / 100, dec: ((h >>> 8) % 12000) / 100 - 60, kind: 'fixed', source: 'mock Sesame' };
  },
  async epochs(ra, dec, collection): Promise<EpochList> {
    await delay(300);
    const epochs = makeEpochs(ra, dec, collection);
    for (const e of epochs) epochIndex.set(e.id, e);
    return { ra, dec, collection, count: epochs.length, epochs };
  },
  cutoutUrl: cutout,
  diffUrl: diff,
  async meta(id, ra, dec, size): Promise<CutoutMeta> {
    await delay(120);
    const ep = epochById(id);
    const w = ep ? (ep.em_min_um + ep.em_max_um) / 2 : 1.5;
    const corners = [[0, 0], [size, 0], [size, size], [0, size]].map(([x, y]) => pixToSky(ra, dec, size, x, y));
    return {
      id, mjd: ep?.mjd ?? 60811, date_obs: ep?.date ?? '', det: ep?.det ?? 1, width: size, height: size,
      wave_um_at_target: +w.toFixed(4), bandwidth_um: ep ? +(ep.em_max_um - ep.em_min_um).toFixed(4) : 0.04,
      pixscale_arcsec: PIX,
      wcs: { crval: [ra, dec], crpix: [size / 2, size / 2], cd: [[-PIX / 3600, 0], [0, PIX / 3600]] },
      corners, stats: { min: 0.1, max: 9.5, median: 0.42, mad: 0.03 },
    };
  },
  async known(ra, dec, mjd): Promise<KnownBody[]> {
    await delay(260);
    const size = 200;
    const c = size / 2;
    const [ax, ay] = asteroidOffset(mjd);
    const [ara, adec] = pixToSky(ra, dec, size, c + ax, c + ay);
    const out: KnownBody[] = [{ name: '(48213) 2001 QF95', ra: ara, dec: adec, vmag: 17.8, rate_ra: 31.2, rate_dec: 14.1 }];
    const [bra, bdec] = pixToSky(ra, dec, size, c - 60, c + 70);
    out.push({ name: '(5202) 1983 EX', ra: bra, dec: bdec, vmag: 19.6 });
    return out;
  },
  async project(_id, ra, dec, size, points) {
    await delay(60);
    return points.map(([pr, pd]) => skyToPix(ra, dec, size, pr, pd));
  },
  async presets() {
    await delay(150);
    return PRESETS;
  },
  async startSpectrum(ra, dec, collection, max) {
    const list = makeEpochs(ra, dec, collection).slice(0, max);
    return runJob(['Listing SPHEREx epochs', 'Downloading cutouts from IRSA', 'Measuring the target in each image', 'Sorting by wavelength'], 3200, () => ({
      ra, dec, unit: 'MJy/sr',
      points: list.map((e, i) => {
        const w = (e.em_min_um + e.em_max_um) / 2;
        const cont = 3.2 * Math.exp(-((w - 1.7) ** 2) / 1.6) + 0.9 * w / 5;
        const line = (c: number, a: number, s: number) => a * Math.exp(-((w - c) ** 2) / (2 * s * s));
        const flux = cont + line(1.875, 2.4, 0.03) + line(3.29, 1.6, 0.04) + line(4.05, 1.1, 0.04) + line(1.282, 0.7, 0.02);
        const r = rng(hash(e.id + i));
        return { wave_um: w, flux: +(flux + (r() - 0.5) * 0.15).toFixed(4), err: 0.08 + 0.02 * r(), mjd: e.mjd, det: e.det, id: e.id };
      }),
    }));
  },
  async startTrack(name) {
    return runJob(['Asking JPL Horizons for the path', 'Finding SPHEREx images along the path', 'Cutting stamps centred on the object', 'Done'], 3600, () => {
      const eph: { mjd: number; ra: number; dec: number }[] = [];
      for (let i = 0; i <= 40; i++) {
        const mjd = 60860 + i * 1.5;
        eph.push({ mjd, ra: 268 + i * 0.12, dec: -18.2 - i * 0.035 - Math.sin(i / 9) * 0.3 });
      }
      const frames = [3, 7, 12, 16, 21, 27, 31, 36].map((k, i) => ({
        id: `trk${i}_${eph[k].mjd}`, mjd: eph[k].mjd, date: mjdToIso(eph[k].mjd), det: (i % 6) + 1, ra: eph[k].ra, dec: eph[k].dec,
        wave_um: +(DET_RANGE[(i % 6) + 1][0] + 0.12).toFixed(3),
      }));
      for (const f of frames) epochIndex.set(f.id, { id: f.id, obs_id: f.id, det: f.det, band: `SPHEREx-D${f.det}`, mjd: f.mjd, date: f.date, exptime: 112, em_min_um: f.wave_um - 0.01, em_max_um: f.wave_um + 0.01, collection: 'spherex_dr1' });
      return { name, ephemeris: eph, frames };
    });
  },
  async startMovers(ra, dec, a, b, size) {
    return runJob(['Fetching both images', 'Aligning B onto A', 'Subtracting and finding changes', 'Matching with JPL known bodies'], 3000, () => {
      const ea = epochById(a), eb = epochById(b);
      const c = size / 2;
      const cand = [];
      for (const [ep, sign] of [[ea, -1], [eb, 1]] as const) {
        if (!ep) continue;
        const [ax, ay] = asteroidOffset(ep.mjd);
        const [r2, d2] = pixToSky(ra, dec, size, c + ax, c + ay);
        cand.push({ x: c + ax, y: c + ay, ra: r2, dec: d2, snr: 14 + (sign > 0 ? 2.1 : 0), sign, match: { name: '(48213) 2001 QF95', vmag: 17.8, sep_arcsec: 2.3 } });
      }
      const [ux, uy] = [c + 38, c - 52];
      const [r3, d3] = pixToSky(ra, dec, size, ux, uy);
      cand.push({ x: ux, y: uy, ra: r3, dec: d3, snr: 6.4, sign: 1, match: null });
      const known = cand.filter((c) => c.match).map((c) => ({ name: c.match!.name, vmag: 17.8, x: c.x + 1.2, y: c.y - 0.8, in_view: true }));
      return { a, b, size, width: size, height: size, known_a: known.slice(0, 1), known_b: known.slice(1), candidates: cand };
    });
  },
  async jobStatus(job) {
    const r = jobs.get(job);
    if (!r) throw new Error('Unknown job');
    return r.status;
  },
  watchJob(job, cb) {
    const r = jobs.get(job);
    if (!r) return () => {};
    r.listeners.add(cb);
    cb(r.status);
    return () => r.listeners.delete(cb);
  },
};

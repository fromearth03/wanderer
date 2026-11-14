// Real gateway client. Talks to /api and /ws on the same origin
// (Vite dev proxy or nginx forward them to the Go gateway on :8080).
import type {
  Api, CutoutMeta, DiffParams, CutoutParams, Epoch, EpochList, Health, JobStatus, KnownBody,
  MoverCandidate, MoversResult, Preset, PresetView, Resolved, SpectrumResult, TrackResult,
} from './types';
import { FALLBACK_PRESETS } from './presets';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('The Wanderer server cannot be reached.', 'network', 0);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`Unexpected reply from server (${res.status}).`, 'bad_json', res.status);
  }
  if (!res.ok) {
    throw new ApiError(body?.error || `Request failed (${res.status}).`, body?.code || 'http', res.status);
  }
  return body as T;
}

const qs = (o: Record<string, string | number | boolean | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

const num = (v: any, d = 0): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : d;
};
const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

export function normEpoch(e: any): Epoch {
  const det = num(pick(e, 'det', 'detector'), 0) || parseInt(String(e?.band || '').replace(/\D/g, ''), 10) || 1;
  const mjd = num(e.mjd ?? e.t_min);
  return {
    id: String(e.id),
    obs_id: String(e.obs_id ?? e.id),
    det,
    band: e.band || `SPHEREx-D${det}`,
    mjd,
    date: e.date || mjdToIso(mjd),
    exptime: num(e.exptime ?? e.t_exptime),
    em_min_um: num(e.em_min_um ?? (e.em_min ? e.em_min * 1e6 : 0)),
    em_max_um: num(e.em_max_um ?? (e.em_max ? e.em_max * 1e6 : 0)),
    collection: e.collection || 'spherex_dr1',
  };
}

export function mjdToIso(mjd: number): string {
  return new Date((mjd - 40587) * 86400000).toISOString();
}

function normPreset(p: any, i: number): Preset {
  const raw = String(p.view || p.kind || p.mode || p.type || 'timeline').toLowerCase();
  const map: Record<string, PresetView> = {
    blink: 'blink', asteroid: 'blink', compare: 'blink', diff: 'diff', difference: 'diff', track: 'track', comet: 'track',
    flipbook: 'flipbook', flip: 'flipbook', deep: 'flipbook', motion: 'motion', pm: 'motion', proper_motion: 'motion',
    star: 'motion', spectrum: 'spectrum', timeline: 'timeline', side: 'side', swipe: 'swipe',
  };
  const eps: string[] = Array.isArray(p.epochs) ? p.epochs.map(String) : [];
  const desc = [p.description || p.desc || p.why || '', p.look_for ? `Look for: ${p.look_for}` : ''].filter(Boolean).join(' ');
  return {
    id: String(p.id ?? i),
    title: p.title || p.name || `Preset ${i + 1}`,
    description: desc,
    ra: num(p.ra),
    dec: num(p.dec),
    collection: p.collection || 'spherex_dr1',
    view: map[raw] || 'timeline',
    name: p.track?.name || p.name || p.target || p.object,
    a: p.a ?? p.epoch_a ?? eps[0],
    b: p.b ?? p.epoch_b ?? eps[1],
    det: p.detector !== undefined ? num(p.detector) : p.det !== undefined ? num(p.det) : undefined,
    start: p.track?.start ?? p.start,
    stop: p.track?.stop ?? p.stop,
    max: p.spectrum?.max !== undefined ? num(p.spectrum.max) : undefined,
    r: p.spectrum?.r !== undefined ? num(p.spectrum.r) : undefined,
    size: p.size ? num(p.size) : undefined,
    stretch: p.stretch,
    cmap: p.cmap,
  };
}

export function normSpectrum(r: any): SpectrumResult {
  const arr = Array.isArray(r) ? r : r?.points || r?.spectrum || r?.photometry || [];
  return {
    ra: num(r?.ra),
    dec: num(r?.dec),
    unit: r?.unit || r?.flux_unit || 'MJy/sr',
    total: r?.total_epochs !== undefined ? num(r.total_epochs) : undefined,
    used: r?.used !== undefined ? num(r.used) : undefined,
    points: arr
      .map((p: any) => ({
        wave_um: num(p.wave_um ?? p.wave ?? p.wavelength_um),
        flux: num(p.flux),
        err: num(p.err ?? p.flux_err),
        mjd: p.mjd !== undefined ? num(p.mjd) : undefined,
        det: p.det !== undefined ? num(p.det) : undefined,
        id: p.id,
        ok: p.ok !== false && p.flux !== null && p.flux !== undefined && p.wave_um !== null,
      }))
      .filter((p: { wave_um: number; flux: number; ok: boolean }) => p.ok && p.wave_um > 0 && isFinite(p.flux))
      .map(({ ok: _ok, ...rest }: any) => rest),
  };
}

export function normTrack(r: any): TrackResult {
  const eph = r?.ephemeris || r?.path || r?.ephem || [];
  const frames = r?.frames || r?.images || r?.epochs || r?.stamps || [];
  return {
    name: r?.target || r?.name || '',
    total: r?.total_frames !== undefined ? num(r.total_frames) : undefined,
    ephemeris: eph.map((p: any) => ({ mjd: num(p.mjd), ra: num(p.ra), dec: num(p.dec) })),
    frames: frames.map((f: any) => {
      const e = f.epoch || {};
      const mjd = num(f.mjd ?? e.mjd ?? f.t_min);
      return {
        id: String(e.id ?? f.id),
        mjd,
        date: e.date || f.date || f.date_obs || mjdToIso(mjd),
        det: num(e.det ?? f.det ?? f.detector, 1),
        ra: num(f.ra ?? f.target_ra),
        dec: num(f.dec ?? f.target_dec),
        wave_um: f.wave_um ?? f.wave_um_at_target,
        mag: f.mag ?? null,
      };
    }),
  };
}

export function normMovers(r: any, a: string, b: string, size: number): MoversResult {
  // `candidates` is a count in newer gateway builds; the list lives in `sources`.
  const list: any[] = [r?.sources, r?.candidates, r?.movers].find(Array.isArray) || [];
  const known = [...(r?.known_a || []), ...(r?.known_b || [])];
  const vmagOf = (name: string) => {
    const k = known.find((x: any) => x?.name === name);
    return k && k.vmag !== undefined && k.vmag !== null ? num(k.vmag) : null;
  };
  return {
    a: r?.a || a,
    b: r?.b || b,
    size: num(r?.size, size),
    width: num(r?.width, num(r?.size, size)),
    height: num(r?.height, num(r?.size, size)),
    dtHours: r?.dt_hours !== undefined ? num(r.dt_hours) : undefined,
    rms: r?.rms !== undefined ? num(r.rms) : undefined,
    rejected: typeof r?.rejected === 'number' ? r.rejected : undefined,
    known: [
      ...(r?.known_a || []).map((k: any) => ({ ...k, when: 'A' })),
      ...(r?.known_b || []).map((k: any) => ({ ...k, when: 'B' })),
    ]
      .filter((k: any) => k.in_view && typeof k.x === 'number' && typeof k.y === 'number')
      .map((k: any) => ({ name: String(k.name), vmag: k.vmag ?? null, x: k.x, y: k.y, when: k.when })),
    candidates: list.map((c: any): MoverCandidate => {
      let m: any = c.match || c.known || (c.name ? { name: c.name, vmag: c.vmag, sep_arcsec: c.sep_arcsec } : null);
      if (typeof m === 'string') m = { name: m, vmag: vmagOf(m), sep_arcsec: c.match_dist_px !== undefined ? num(c.match_dist_px) * 6.15 : 0 };
      return {
        x: num(c.x),
        y: num(c.y),
        ra: num(c.ra),
        dec: num(c.dec),
        snr: num(c.snr),
        sign: num(c.sign, 1),
        match: m && m.name ? { name: String(m.name), vmag: m.vmag ?? null, sep_arcsec: num(m.sep_arcsec ?? m.sep) } : null,
      };
    }),
  };
}

function normJob(s: any, job: string): JobStatus {
  return {
    job: s?.job || job,
    state: s?.state || 'queued',
    progress: num(s?.progress),
    message: s?.message || '',
    result: s?.result,
    partial: Array.isArray(s?.partial) ? s.partial : undefined,
    cached: s?.cached === true,
  };
}

// One shared WebSocket for all job subscriptions, with reconnect and a polling fallback.
type Listener = (s: JobStatus) => void;
class JobSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private open = false;
  private retry = 0;
  private failed = false;

  private connect() {
    if (this.ws || this.failed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.failed = true;
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.retry = 0;
      for (const job of this.listeners.keys()) ws.send(JSON.stringify({ subscribe: job }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (!msg?.job) return;
        const set = this.listeners.get(msg.job);
        if (set) for (const l of set) l(normJob(msg, msg.job));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.open = false;
      if (this.listeners.size === 0) return;
      this.retry++;
      if (this.retry > 5) {
        this.failed = true;
        return;
      }
      setTimeout(() => this.connect(), Math.min(4000, 300 * 2 ** this.retry));
    };
  }

  get usable() {
    return !this.failed;
  }

  subscribe(job: string, l: Listener) {
    let set = this.listeners.get(job);
    if (!set) {
      set = new Set();
      this.listeners.set(job, set);
    }
    set.add(l);
    this.connect();
    if (this.open && this.ws) this.ws.send(JSON.stringify({ subscribe: job }));
    return () => {
      set!.delete(l);
      if (set!.size === 0) this.listeners.delete(job);
    };
  }
}

const socket = new JobSocket();
const epochCache = new Map<string, Promise<EpochList>>();
const metaCache = new Map<string, Promise<CutoutMeta>>();

export const liveApi: Api = {
  mode: 'live',
  health: () => getJson<Health>('/api/health'),
  resolve: (name) => getJson<Resolved>(`/api/resolve?${qs({ name })}`),
  epochs(ra, dec, collection) {
    const key = `${ra.toFixed(5)},${dec.toFixed(5)},${collection}`;
    let p = epochCache.get(key);
    if (!p) {
      p = getJson<any>(`/api/epochs?${qs({ ra, dec, collection })}`).then((r) => {
        const epochs = (r?.epochs || []).map(normEpoch).sort((x: Epoch, y: Epoch) => x.mjd - y.mjd);
        return { ra: num(r?.ra, ra), dec: num(r?.dec, dec), collection: r?.collection || collection, count: epochs.length, epochs };
      });
      p.catch(() => epochCache.delete(key));
      epochCache.set(key, p);
    }
    return p;
  },
  cutoutUrl: (p: CutoutParams) =>
    `/api/cutout.png?${qs({ id: p.id, ra: p.ra, dec: p.dec, size: p.size, stretch: p.stretch, cmap: p.cmap, sub: p.sub ? 'zodi' : '' })}`,
  diffUrl: (p: DiffParams) => `/api/diff.png?${qs({ a: p.a, b: p.b, ra: p.ra, dec: p.dec, size: p.size, stretch: p.stretch })}`,
  meta(id, ra, dec, size) {
    const key = `${id}|${ra}|${dec}|${size}`;
    let p = metaCache.get(key);
    if (!p) {
      p = getJson<CutoutMeta>(`/api/cutout/meta?${qs({ id, ra, dec, size })}`);
      p.catch(() => metaCache.delete(key));
      metaCache.set(key, p);
    }
    return p;
  },
  async known(ra, dec, mjd, radius, kind) {
    const r = await getJson<any>(`/api/known?${qs({ ra, dec, mjd, radius, kind })}`);
    return (r?.bodies || []).map((b: any): KnownBody => ({
      name: String(b.name),
      ra: num(b.ra),
      dec: num(b.dec),
      vmag: b.vmag === undefined || b.vmag === null || b.vmag === '' ? null : num(b.vmag),
      rate_ra: b.rate_ra !== undefined ? num(b.rate_ra) : undefined,
      rate_dec: b.rate_dec !== undefined ? num(b.rate_dec) : undefined,
    }));
  },
  async project(id, ra, dec, size, points) {
    if (points.length === 0) return [];
    const r = await getJson<{ pixels: number[][] }>('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ra, dec, size, points }),
    });
    return r.pixels || [];
  },
  async presets() {
    const r = await getJson<any>('/api/presets');
    const arr = Array.isArray(r) ? r : r?.presets || [];
    return arr.length ? arr.map(normPreset) : FALLBACK_PRESETS;
  },
  async startSpectrum(ra, dec, collection, max, opts) {
    return (await getJson<{ job: string }>(`/api/spectrum?${qs({ ra, dec, collection, max, r: opts?.r, force: opts?.force ? 1 : undefined })}`)).job;
  },
  async startTrack(name, start, stop, opts) {
    return (await getJson<{ job: string }>(`/api/track?${qs({ name, start, stop, force: opts?.force ? 1 : undefined })}`)).job;
  },
  async startMovers(ra, dec, a, b, size, opts) {
    return (await getJson<{ job: string }>(`/api/movers?${qs({ ra, dec, a, b, size, force: opts?.force ? 1 : undefined })}`)).job;
  },
  async jobStatus(job) {
    return normJob(await getJson<any>(`/api/jobs/${encodeURIComponent(job)}`), job);
  },
  watchJob(job, cb) {
    let done = false;
    let timer: number | undefined;
    const emit = (s: JobStatus) => {
      if (done) return;
      cb(s);
      if (s.state === 'done' || s.state === 'error') stop();
    };
    const unsub = socket.subscribe(job, emit);
    // A fast job can finish before the subscribe reaches the server, so also poll.
    // Polling is slow while the socket works and becomes the main path if it fails.
    const poll = async () => {
      if (done) return;
      try {
        emit(await this.jobStatus(job));
      } catch {
        /* keep trying */
      }
      if (!done) timer = window.setTimeout(poll, socket.usable ? 2500 : 1000);
    };
    poll();
    function stop() {
      done = true;
      unsub();
      if (timer) clearTimeout(timer);
    }
    return stop;
  },
};

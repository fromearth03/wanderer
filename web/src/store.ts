// One global store for everything the user chose (target, pair, display settings,
// theme, focus mode) and for running jobs. Settings persist to localStorage; job
// watchers live here, not in page components, so a spectrum keeps building while
// you look at another page.
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { api, type Cmap, type Epoch, type JobState, type Stretch } from './api';
import { bestPair, windowsOf } from './lib/epochs';

export type PairKind = 'short' | 'long';
export type PairSource = 'auto' | 'user' | 'preset';
export type JobKind = 'spectrum' | 'track' | 'movers';

export interface SpectrumParams { ra: number; dec: number; coll: string; max: number; r?: number }
export interface TrackParams { name: string; start: string; stop: string }
export interface MoversParams { ra: number; dec: number; a: string; b: string; size: number }
type ParamsOf<K extends JobKind> = K extends 'spectrum' ? SpectrumParams : K extends 'track' ? TrackParams : MoversParams;

export interface JobEntry {
  key: string;
  kind: JobKind;
  params: SpectrumParams | TrackParams | MoversParams;
  job: string;
  state: JobState | 'starting';
  progress: number;
  message: string;
  partial?: unknown[];
  result?: unknown;
  error?: string;
  cached?: boolean;
  started: number;
}

export interface WanderState {
  // target and pair (mirrored into the URL so links stay shareable)
  ra: number | null;
  dec: number | null;
  name: string;
  coll: string;
  a: string;
  b: string;
  mode: string;
  det: number | null;
  pair: PairKind;
  pairSource: PairSource;
  pickSlot: 'A' | 'B';
  // display settings
  stretch: Stretch;
  cmap: Cmap;
  size: number;
  sub: boolean;
  known: boolean;
  knownKind: 'a' | 'c';
  dets: boolean[];
  blinkMs: number;
  fps: number;
  theme: 'dark' | 'light';
  focus: boolean;
  spectrumMax: number;
  spectrumLog: boolean;
  spectrumLines: boolean;
  track: TrackParams;
  // wavelength at the target per image id, for the current target only
  waves: Record<string, number>;
  wavesFor: string;
  jobs: Record<string, JobEntry>;

  set: (patch: Partial<WanderState>) => void;
  setWaves: (forKey: string, w: Record<string, number>) => void;
  runJob: <K extends JobKind>(kind: K, params: ParamsOf<K>, force?: boolean) => string;
  autoPair: (epochs: Epoch[]) => void;
}

export const DEFAULT_COLL = 'spherex_dr1';

const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode or full storage: settings are just not remembered */
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

// ---- job keys (client side; the gateway has its own) ----
export const spectrumKey = (p: SpectrumParams) => `spectrum|${p.coll}|${p.ra.toFixed(5)}|${p.dec.toFixed(5)}|${p.max}|${p.r ?? 12}`;
export const trackKey = (p: TrackParams) => `track|${p.name.trim().toLowerCase()}|${p.start}|${p.stop}`;
export const moversKey = (p: MoversParams) => `movers|${p.a}|${p.b}|${p.ra.toFixed(5)}|${p.dec.toFixed(5)}|${p.size}`;
export function jobKey(kind: JobKind, p: any): string {
  return kind === 'spectrum' ? spectrumKey(p) : kind === 'track' ? trackKey(p) : moversKey(p);
}
export const targetKey = (s: { ra: number | null; dec: number | null; coll: string }) =>
  s.ra === null || s.dec === null ? '' : `${s.coll}|${s.ra.toFixed(5)}|${s.dec.toFixed(5)}`;

function starter(kind: JobKind, p: any, force: boolean): Promise<string> {
  if (kind === 'spectrum') return api.startSpectrum(p.ra, p.dec, p.coll, p.max, { r: p.r, force });
  if (kind === 'track') return api.startTrack(p.name, p.start || undefined, p.stop || undefined, { force });
  return api.startMovers(p.ra, p.dec, p.a, p.b, p.size, { force });
}

// Live watchers by job key. Module level: they survive page changes.
const watchers = new Map<string, () => void>();
// Auto-pair refinements already started, by target+kind.
const refined = new Set<string>();

export const useStore = create<WanderState>()(
  persist(
    (set, get) => ({
      ra: null,
      dec: null,
      name: '',
      coll: DEFAULT_COLL,
      a: '',
      b: '',
      mode: '',
      det: null,
      pair: 'long',
      pairSource: 'auto',
      pickSlot: 'A',
      stretch: 'asinh',
      cmap: 'gray',
      size: 200,
      sub: true,
      known: false,
      knownKind: 'a',
      dets: [true, true, true, true, true, true],
      blinkMs: 700,
      fps: 3,
      theme: 'dark',
      focus: false,
      spectrumMax: 60,
      spectrumLog: false,
      spectrumLines: true,
      track: { name: '', start: '', stop: '' },
      waves: {},
      wavesFor: '',
      jobs: {},

      set: (patch) => set(patch),

      setWaves: (forKey, w) =>
        set((s) => (s.wavesFor === forKey ? { waves: { ...s.waves, ...w } } : { wavesFor: forKey, waves: { ...w } })),

      runJob: (kind, params, force = false) => {
        const key = jobKey(kind, params);
        const cur = get().jobs[key];
        if (!force && cur && watchers.has(key)) return key; // already watching
        if (!force && cur && cur.state === 'done' && cur.result !== undefined) return key; // finished, kept
        watchers.get(key)?.();
        watchers.delete(key);
        const patch = (p: Partial<JobEntry>) =>
          set((s) => {
            const e = s.jobs[key];
            return e ? { jobs: { ...s.jobs, [key]: { ...e, ...p } } } : {};
          });
        set((s) => ({
          jobs: {
            ...s.jobs,
            [key]: { key, kind, params, job: '', state: 'starting', progress: 0, message: force ? 'Starting a fresh run' : 'Starting', started: Date.now() },
          },
        }));
        let stopped = false;
        watchers.set(key, () => {
          stopped = true;
        });
        starter(kind, params, force).then(
          (job) => {
            if (stopped) return;
            patch({ job, state: 'queued' });
            const stop = api.watchJob(job, (st) => {
              patch({
                state: st.state,
                progress: st.progress,
                message: st.message,
                cached: st.cached,
                ...(st.partial ? { partial: st.partial } : {}),
                ...(st.state === 'done' ? { result: st.result, partial: undefined } : {}),
                ...(st.state === 'error' ? { error: st.message || 'The job failed.' } : { error: undefined }),
              });
              if (st.state === 'done' || st.state === 'error') watchers.delete(key);
            });
            watchers.set(key, stop);
          },
          (e: any) => {
            watchers.delete(key);
            patch({ state: 'error', error: e?.message || String(e), message: 'could not start' });
          },
        );
        return key;
      },

      autoPair: (epochs) => {
        const s = get();
        if (epochs.length < 2 || s.ra === null || s.dec === null) return;
        const have = epochs.some((e) => e.id === s.a) && epochs.some((e) => e.id === s.b);
        if (have && s.pairSource !== 'auto') return;
        const tk = targetKey(s);
        const waves = s.wavesFor === tk ? s.waves : {};
        if (!have) {
          const p = bestPair(epochs, s.pair, waves);
          if (p) set({ a: p[0].id, b: p[1].id, pairSource: 'auto' });
        }
        // Refine in the background: measure the wavelength at the target for a few
        // candidate images (cheap 32 px cutouts) and switch to the closest pair.
        const rk = `${tk}|${s.pair}`;
        if (refined.has(rk)) return;
        refined.add(rk);
        const st = get();
        const A = epochs.find((e) => e.id === st.a);
        const B = epochs.find((e) => e.id === st.b);
        if (!A || !B) return;
        const same = epochs.filter((e) => e.det === A.det);
        const near = (t: number, n: number) => [...same].sort((x, y) => Math.abs(x.mjd - t) - Math.abs(y.mjd - t)).slice(0, n);
        // Images taken minutes apart see the target at almost the same wavelength,
        // so sample each survey window evenly instead of taking the nearest ones.
        const spread = (t: number, n: number) => {
          const win = windowsOf(same).find(([w0, w1]) => t >= w0 - 0.01 && t <= w1 + 0.01);
          const inWin = win ? same.filter((e) => e.mjd >= win[0] - 0.01 && e.mjd <= win[1] + 0.01) : near(t, n);
          if (inWin.length <= n) return inWin;
          return Array.from({ length: n }, (_, i) => inWin[Math.round((i * (inWin.length - 1)) / (n - 1))]);
        };
        const cand = st.pair === 'short' ? [A, ...spread(A.mjd, 9)].filter((e) => Math.abs(e.mjd - A.mjd) <= 4) : [A, B, ...spread(A.mjd, 6), ...spread(B.mjd, 6)];
        const todo = [...new Map(cand.map((e) => [e.id, e])).values()].filter((e) => waves[e.id] === undefined);
        const ra = st.ra!, dec = st.dec!;
        const queue = [...todo];
        const worker = async () => {
          while (queue.length) {
            const e = queue.shift()!;
            try {
              const m = await api.meta(e.id, ra, dec, 32);
              if (isFinite(m.wave_um_at_target)) get().setWaves(tk, { [e.id]: m.wave_um_at_target });
            } catch {
              /* skip this image */
            }
          }
        };
        Promise.all([worker(), worker(), worker()]).then(() => {
          const now = get();
          if (targetKey(now) !== tk || now.pairSource !== 'auto') return;
          const pool = epochs.filter((e) => now.waves[e.id] !== undefined);
          const p = bestPair(pool.length >= 2 ? pool : epochs, now.pair, now.waves);
          if (p && (p[0].id !== now.a || p[1].id !== now.b)) set({ a: p[0].id, b: p[1].id });
        });
      },
    }),
    {
      name: 'wanderer.state',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        ra: s.ra, dec: s.dec, name: s.name, coll: s.coll, a: s.a, b: s.b, mode: s.mode, det: s.det, pair: s.pair, pairSource: s.pairSource,
        stretch: s.stretch, cmap: s.cmap, size: s.size, sub: s.sub, known: s.known, knownKind: s.knownKind, dets: s.dets,
        blinkMs: s.blinkMs, fps: s.fps, theme: s.theme, focus: s.focus, spectrumMax: s.spectrumMax, spectrumLog: s.spectrumLog,
        spectrumLines: s.spectrumLines, track: s.track,
        // Only what is needed to pick jobs up again after a reload; results come
        // back from the gateway, which keeps finished results.
        jobs: Object.fromEntries(
          Object.values(s.jobs)
            .filter((j) => j.state !== 'error')
            .sort((x, y) => y.started - x.started)
            .slice(0, 6)
            .map((j) => [j.key, { key: j.key, kind: j.kind, params: j.params, job: j.job, state: 'starting', progress: 0, message: 'Reconnecting', started: j.started }]),
        ),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Re-attach to jobs from before the reload (the gateway reuses the running job or its saved result).
        const list = Object.values(state.jobs || {});
        setTimeout(() => {
          useStore.setState({ jobs: {} });
          for (const j of list) useStore.getState().runJob(j.kind, j.params as any);
        }, 0);
      },
    },
  ),
);

/** The job entry for a key, or undefined. */
export const useJobEntry = (key: string | null) => useStore((s) => (key ? s.jobs[key] : undefined));

export const isRunning = (j?: JobEntry) => !!j && (j.state === 'starting' || j.state === 'queued' || j.state === 'running');

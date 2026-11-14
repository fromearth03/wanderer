// Shapes from CONTRACT.md. Job result shapes (spectrum, track, movers) and presets
// are not fixed by the contract, so client.ts normalizes whatever the gateway sends
// into the types below.

export type Collection = 'spherex_dr1' | 'spherex_dr1_deep';
export type Stretch = 'linear' | 'asinh' | 'log' | 'sqrt' | 'zscale';
export type Cmap = 'gray' | 'inferno' | 'viridis' | 'magma' | 'cividis';

export interface Health {
  ok: boolean;
  science: boolean;
  version: string;
}

export interface Resolved {
  name: string;
  ra: number;
  dec: number;
  kind: 'fixed' | 'moving';
  source: string;
}

export interface Epoch {
  id: string;
  obs_id: string;
  det: number;
  band: string;
  mjd: number;
  date: string;
  exptime: number;
  em_min_um: number;
  em_max_um: number;
  collection: Collection | string;
}

export interface EpochList {
  ra: number;
  dec: number;
  collection: string;
  count: number;
  epochs: Epoch[];
}

export interface Wcs {
  crval: number[];
  crpix: number[];
  cd: number[][];
  sip?: unknown;
}

export interface CutoutMeta {
  id: string;
  mjd: number;
  date_obs: string;
  det: number;
  width: number;
  height: number;
  wave_um_at_target: number;
  bandwidth_um: number;
  pixscale_arcsec: number;
  wcs: Wcs;
  corners: number[][];
  stats: { min: number; max: number; median: number; mad: number };
}

export interface KnownBody {
  name: string;
  ra: number;
  dec: number;
  vmag: number | null;
  rate_ra?: number;
  rate_dec?: number;
}

export type JobState = 'queued' | 'running' | 'done' | 'error';

export interface JobStatus<R = unknown> {
  job: string;
  state: JobState;
  progress: number;
  message: string;
  result?: R;
  /** Items measured so far while the job runs (spectrum points, track frames). */
  partial?: unknown[];
  /** True when the gateway answered from a saved result. */
  cached?: boolean;
}

export interface JobOpts {
  /** Run again even when a saved result exists. */
  force?: boolean;
  /** Spectrum aperture radius in arcsec. */
  r?: number;
}

export interface SpectrumPoint {
  wave_um: number;
  flux: number;
  err: number;
  mjd?: number;
  det?: number;
  id?: string;
}

export interface SpectrumResult {
  ra: number;
  dec: number;
  unit: string;
  total?: number;
  used?: number;
  points: SpectrumPoint[];
}

export interface TrackPoint {
  mjd: number;
  ra: number;
  dec: number;
}

export interface TrackFrame {
  id: string;
  mjd: number;
  date: string;
  det: number;
  ra: number;
  dec: number;
  wave_um?: number;
  mag?: number | null;
}

export interface TrackResult {
  name: string;
  total?: number;
  ephemeris: TrackPoint[];
  frames: TrackFrame[];
}

export interface MoverCandidate {
  x: number;
  y: number;
  ra: number;
  dec: number;
  snr: number;
  sign: number;
  match: { name: string; vmag: number | null; sep_arcsec: number } | null;
}

export interface MoversResult {
  a: string;
  b: string;
  size: number;
  width?: number;
  height?: number;
  dtHours?: number;
  rms?: number;
  /** Detections thrown out as star leftovers, dipoles or artefacts. */
  rejected?: number;
  known: { name: string; vmag: number | null; x: number; y: number; when: 'A' | 'B' }[];
  candidates: MoverCandidate[];
}

export type PresetView = 'blink' | 'diff' | 'side' | 'swipe' | 'track' | 'flipbook' | 'motion' | 'spectrum' | 'timeline';

export interface Preset {
  id: string;
  title: string;
  description: string;
  ra: number;
  dec: number;
  collection: string;
  view: PresetView;
  name?: string;
  a?: string;
  b?: string;
  det?: number;
  start?: string;
  stop?: string;
  max?: number;
  r?: number;
  size?: number;
  stretch?: string;
  cmap?: string;
}

export interface CutoutParams {
  id: string;
  ra: number;
  dec: number;
  size: number;
  stretch: Stretch;
  cmap: Cmap;
  sub: boolean;
}

export interface DiffParams {
  a: string;
  b: string;
  ra: number;
  dec: number;
  size: number;
  stretch: Stretch;
}

export interface Api {
  mode: 'mock' | 'live';
  health(): Promise<Health>;
  resolve(name: string): Promise<Resolved>;
  epochs(ra: number, dec: number, collection: string): Promise<EpochList>;
  cutoutUrl(p: CutoutParams): string;
  diffUrl(p: DiffParams): string;
  meta(id: string, ra: number, dec: number, size: number): Promise<CutoutMeta>;
  known(ra: number, dec: number, mjd: number, radius: number, kind: 'a' | 'c'): Promise<KnownBody[]>;
  project(id: string, ra: number, dec: number, size: number, points: number[][]): Promise<number[][]>;
  presets(): Promise<Preset[]>;
  startSpectrum(ra: number, dec: number, collection: string, max: number, opts?: JobOpts): Promise<string>;
  startTrack(name: string, start?: string, stop?: string, opts?: JobOpts): Promise<string>;
  startMovers(ra: number, dec: number, a: string, b: string, size: number, opts?: JobOpts): Promise<string>;
  jobStatus(job: string): Promise<JobStatus>;
  /** Live updates for a job. Returns an unsubscribe function. */
  watchJob(job: string, cb: (s: JobStatus) => void): () => void;
}

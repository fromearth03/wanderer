// Shared data types and maths for the heliocentric view (HelioTrack).
import * as THREE from 'three';
import { msToJD, jdToMs } from './support';

export type Vec = [number, number, number, number]; // jd, x, y, z (au, ecliptic J2000)
export type Body = { name: string; id?: string; period_days?: number; points: Vec[]; now?: Vec };
export type OrbitData = {
  name: string;
  now_jd: number;
  start: string;
  stop: string;
  step: string;
  object: Body;
  planets: Body[];
  warning?: string;
};

export const AU_KM = 149597870.7;

export function toJD(t: number | string | Date): number | null {
  if (t instanceof Date) return msToJD(t.getTime());
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) return null;
    if (t < 100000) return t + 2400000.5;
    if (t < 1e7) return t;
    return msToJD(t);
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? msToJD(ms) : null;
}

/** Linear interpolation of a time-ordered vector table at jd (clamped). */
export function at(points: Vec[], jd: number): [number, number, number] | null {
  const n = points.length;
  if (!n) return null;
  if (jd <= points[0][0]) return [points[0][1], points[0][2], points[0][3]];
  if (jd >= points[n - 1][0]) return [points[n - 1][1], points[n - 1][2], points[n - 1][3]];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= jd) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const f = (jd - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

/** Planet position at any time from one sampled orbit (orbits repeat with the period). */
export function planetAt(b: Body, jd: number) {
  if (!b.points.length || !b.period_days) return null;
  const p0 = b.points[0][0];
  const P = b.period_days;
  const t = p0 + ((((jd - p0) % P) + P) % P);
  return at(b.points, t);
}

/** Ecliptic (x, y, z) to scene: ecliptic plane is the XZ plane, north up. */
export const sc = (p: [number, number, number] | null, out = new THREE.Vector3()) => (p ? out.set(p[0], p[2], -p[1]) : out.set(0, 0, 0));

export const dateStr = (jd: number) => new Date(jdToMs(jd)).toISOString().slice(0, 10);

/** Key of a body that can be focused: 'sun', 'comet' or a planet's Horizons id. */
export type BodyKey = string;

/** Ecliptic position (au) of a body on a date. */
export function bodyEcl(data: OrbitData, key: BodyKey, jd: number): [number, number, number] | null {
  if (key === 'sun') return [0, 0, 0];
  if (key === 'comet') return at(data.object.points, jd);
  const b = data.planets.find((p) => p.id === key);
  return b ? planetAt(b, jd) : null;
}

/** Look and facts per planet. size = drawn radius in au (enlarged); radiusKm = real mean radius. */
export const PLANETS: Record<string, { color: string; size: number; radiusKm: number; tilt: number; spin: number; tex?: string }> = {
  '199': { color: '#a39d94', size: 0.035, radiusKm: 2439.7, tilt: 0.03, spin: 0.05, tex: '/textures/planet-mercury.webp' },
  '299': { color: '#e8d5a6', size: 0.06, radiusKm: 6051.8, tilt: 177.4, spin: -0.03, tex: '/textures/planet-venus.webp' },
  '399': { color: '#6b9bd8', size: 0.064, radiusKm: 6371.0, tilt: 23.44, spin: 0.25, tex: '/textures/earth-day-2k.webp' },
  '499': { color: '#c96a43', size: 0.045, radiusKm: 3389.5, tilt: 25.19, spin: 0.24, tex: '/textures/planet-mars.webp' },
  '599': { color: '#d4b48e', size: 0.16, radiusKm: 69911, tilt: 3.13, spin: 0.6, tex: '/textures/planet-jupiter.webp' },
};

export const SUN_SIZE = 0.1; // au, drawn (real 0.00465 au)
export const SUN_RADIUS_KM = 695700;

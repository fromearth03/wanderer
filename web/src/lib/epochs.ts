import type { Epoch } from '../api';

export const midWave = (e: Epoch) => (e.em_min_um + e.em_max_um) / 2;

/** Short label for a wavelength range: a single value when narrow, else the band. */
export function bandText(e: Epoch): string {
  const w = e.em_max_um - e.em_min_um;
  return w < 0.1 ? `${midWave(e).toFixed(3)} \u00b5m` : `band ${e.em_min_um.toFixed(2)} to ${e.em_max_um.toFixed(2)} \u00b5m`;
}

/**
 * Choose an A/B pair from the same detector with close wavelengths.
 * short: neighbouring days (asteroids move a lot in a day).
 * long: different survey windows, about six months apart (fast stars, brown dwarfs).
 */
export function bestPair(epochs: Epoch[], kind: 'short' | 'long', waves: Record<string, number> = {}): [Epoch, Epoch] | null {
  // When exact wavelengths at the target are known (Timeline measure), only use those images.
  const measured = epochs.filter((e) => waves[e.id] !== undefined);
  if (measured.length >= 2) {
    const p = bestPair(measured.map((e) => ({ ...e, em_min_um: waves[e.id], em_max_um: waves[e.id] })), kind);
    if (p) return [epochs.find((e) => e.id === p[0].id)!, epochs.find((e) => e.id === p[1].id)!];
  }
  let best: [Epoch, Epoch] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < epochs.length; i++) {
    for (let j = i + 1; j < epochs.length; j++) {
      const a = epochs[i], b = epochs[j];
      if (a.det !== b.det) continue;
      const dt = Math.abs(b.mjd - a.mjd);
      const dw = Math.abs(midWave(a) - midWave(b)) / midWave(a);
      let score: number;
      if (kind === 'short') {
        if (dt < 0.3 || dt > 4) continue;
        score = dw * 100 + Math.abs(dt - 1);
      } else {
        if (dt < 60) continue;
        score = dw * 100 - dt / 365;
      }
      if (score < bestScore) {
        bestScore = score;
        best = a.mjd <= b.mjd ? [a, b] : [b, a];
      }
    }
  }
  if (!best && epochs.length >= 2) {
    // Fall back to any two images from the most common detector.
    const byDet = new Map<number, Epoch[]>();
    for (const e of epochs) byDet.set(e.det, [...(byDet.get(e.det) || []), e]);
    const list = [...byDet.values()].sort((x, y) => y.length - x.length)[0];
    if (list && list.length >= 2) best = [list[0], list[list.length - 1]];
    else best = [epochs[0], epochs[epochs.length - 1]];
  }
  return best;
}

export function windowsOf(epochs: Epoch[], gapDays = 30): [number, number][] {
  const out: [number, number][] = [];
  for (const e of epochs) {
    const last = out[out.length - 1];
    if (last && e.mjd - last[1] < gapDays) last[1] = e.mjd;
    else out.push([e.mjd, e.mjd]);
  }
  return out;
}

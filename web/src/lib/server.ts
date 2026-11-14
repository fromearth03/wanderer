// What the gateway can do. Gateway 1.1 added the colour view (/api/rgb) and the
// cached sky tile proxy (/api/hips); older gateways get the earlier behaviour.
import { useEffect, useState } from 'react';
import type { Epoch } from '../api';

let caps: Promise<{ rgb: boolean; hips: boolean }> | null = null;

export function serverCaps() {
  if (!caps) {
    caps = fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        const [maj, min] = String(h?.version || '0.0').split('.').map((x: string) => parseInt(x, 10) || 0);
        const v11 = maj > 1 || (maj === 1 && min >= 1);
        return { rgb: v11, hips: v11 };
      })
      .catch(() => ({ rgb: false, hips: false }));
  }
  return caps;
}

export function useServerCaps() {
  const [c, setC] = useState<{ rgb: boolean; hips: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    serverCaps().then((x) => alive && setC(x));
    return () => {
      alive = false;
    };
  }, []);
  return c;
}

export interface RgbPick {
  r: Epoch;
  g: Epoch;
  b: Epoch;
  window: [number, number];
}

const picks = new Map<string, Promise<RgbPick>>();

/** Three images (short, middle, long wavelength) of the spot from one survey window. */
export function rgbPick(ra: number, dec: number, collection: string, near?: number): Promise<RgbPick> {
  const k = `${ra.toFixed(5)}|${dec.toFixed(5)}|${collection}|${near ? Math.round(near) : ''}`;
  let p = picks.get(k);
  if (!p) {
    const q = new URLSearchParams({ ra: String(ra), dec: String(dec), collection });
    if (near) q.set('near', String(near));
    p = fetch(`/api/rgb?${q}`).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Colour view not available (${r.status}).`);
      return body as RgbPick;
    });
    p.catch(() => picks.delete(k));
    picks.set(k, p);
  }
  return p;
}

export function rgbUrl(p: RgbPick, ra: number, dec: number, size: number, stretch: string): string {
  const q = new URLSearchParams({ ra: String(ra), dec: String(dec), size: String(size), stretch, r: p.r.id, g: p.g.id, b: p.b.id });
  return `/api/rgb.png?${q}`;
}

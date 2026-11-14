import { useEffect, useRef, useState } from 'react';
import { api, type Epoch } from '../api';
import type { Mark } from '../components/FrameView';

export interface KnownMark {
  x: number;
  y: number;
  name: string;
  vmag: number | null;
}

const cache = new Map<string, KnownMark[]>();

/**
 * For each epoch id needed on screen: ask /api/known for bodies at that epoch's time,
 * then /api/project to turn their sky positions into cutout pixels. Results are cached
 * per epoch so flipbook markers move frame by frame without refetching.
 */
export function useKnown(epochs: Epoch[], ra: number | null, dec: number | null, size: number, kind: 'a' | 'c', enabled: boolean) {
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inflight = useRef(new Set<string>());
  const key = (id: string) => `${id}|${ra}|${dec}|${size}|${kind}`;
  const ids = epochs.map((e) => e.id).join(',');

  useEffect(() => {
    if (!enabled || ra === null || dec === null) return;
    let alive = true;
    const todo = epochs.filter((e) => !cache.has(key(e.id)) && !inflight.current.has(key(e.id)));
    if (!todo.length) return;
    setBusy(true);
    (async () => {
      for (const e of todo) {
        if (!alive) break;
        const k = key(e.id);
        inflight.current.add(k);
        try {
          const radius = Math.max(0.05, (size * 6.15) / 3600 * 0.75);
          const bodies = await api.known(ra, dec, e.mjd, radius, kind);
          const px = await api.project(e.id, ra, dec, size, bodies.map((b) => [b.ra, b.dec]));
          const marks = bodies
            .map((b, i) => ({ x: px[i]?.[0], y: px[i]?.[1], name: b.name, vmag: b.vmag }))
            .filter((m) => typeof m.x === 'number' && m.x >= -5 && m.x <= size + 5 && m.y >= -5 && m.y <= size + 5);
          cache.set(k, marks);
          setError('');
        } catch (err: any) {
          setError(err?.message || 'Known object lookup failed.');
        } finally {
          inflight.current.delete(k);
        }
        if (alive) force((n) => n + 1);
      }
      if (alive) setBusy(false);
    })();
    return () => {
      alive = false;
      setBusy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, ra, dec, size, kind, enabled]);

  const marksFor = (id: string | undefined): Mark[] => {
    if (!enabled || !id) return [];
    return (cache.get(key(id)) || []).map((m) => ({
      x: m.x,
      y: m.y,
      color: '#e8e6e1',
      r: 6,
      label: `${m.name}${m.vmag !== null ? ` V${m.vmag.toFixed(1)}` : ''}`,
    }));
  };
  const countFor = (id: string | undefined) => (id ? cache.get(key(id))?.length : undefined);
  return { marksFor, countFor, busy, error };
}

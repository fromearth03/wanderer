import { useEffect, useState } from 'react';
import { api, type CutoutMeta } from '../api';

/**
 * Fetch cutout metadata (WCS, wavelength at target) for many images, two at a time.
 * The API layer caches each request, so the same image is never asked for twice.
 */
export function useMetaMap(items: { id: string; ra: number; dec: number }[], size: number, enabled = true) {
  const [map, setMap] = useState<Record<string, CutoutMeta>>({});
  const key = items.map((i) => `${i.id}@${i.ra.toFixed(5)},${i.dec.toFixed(5)}`).join('|');
  useEffect(() => {
    if (!enabled || !items.length) return;
    let alive = true;
    const queue = [...items];
    const worker = async () => {
      while (queue.length && alive) {
        const it = queue.shift()!;
        try {
          const m = await api.meta(it.id, it.ra, it.dec, size);
          if (alive) setMap((s) => (s[it.id] ? s : { ...s, [it.id]: m }));
        } catch {
          /* leave this image unrotated */
        }
      }
    };
    worker();
    worker();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size, enabled]);
  return map;
}

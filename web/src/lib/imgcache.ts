// Decoded image cache shared by every page. Holding the Image objects keeps the
// browser's decoded copies alive, so going back to a page or stepping a
// flipbook shows images at once instead of decoding again.
const MAX = 240;
const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<void>>();

export const isDecoded = (url: string) => cache.has(url);

export function prefetchImage(url: string): Promise<void> {
  if (!url) return Promise.resolve();
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit); // most recently used last
    return Promise.resolve();
  }
  const p0 = pending.get(url);
  if (p0) return p0;
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  const p = im
    .decode()
    .then(() => {
      cache.set(url, im);
      while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
    })
    .catch(() => {
      /* not available (IRSA busy): the page shows its own message */
    })
    .finally(() => pending.delete(url));
  pending.set(url, p);
  return p;
}

/** Prefetch in order, a few at a time, so other requests keep free connections. */
export function prefetchQueue(urls: string[], concurrency = 2): () => void {
  let alive = true;
  const queue = urls.filter((u) => u && !cache.has(u));
  const run = async () => {
    while (alive && queue.length) await prefetchImage(queue.shift()!);
  };
  for (let i = 0; i < concurrency; i++) run();
  return () => {
    alive = false;
  };
}

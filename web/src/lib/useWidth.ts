import { useCallback, useRef, useState } from 'react';

export function useWidth<T extends HTMLElement>(initial = 800) {
  const [w, setW] = useState(initial);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(Math.max(260, Math.floor(el.getBoundingClientRect().width)));
    ro.current = new ResizeObserver((es) => setW(Math.max(260, Math.floor(es[0].contentRect.width))));
    ro.current.observe(el);
  }, []);
  return [ref, w] as const;
}


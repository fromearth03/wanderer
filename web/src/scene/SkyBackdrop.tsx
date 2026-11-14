import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/format';
import { useStore } from '../store';
import { createStarfield, type Starfield } from './starfield';

/** Fixed full-window star backdrop behind the app shell. Eases to the current target. */
export default function SkyBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  const sf = useRef<Starfield | null>(null);
  const ra = useStore((s) => s.ra);
  const dec = useStore((s) => s.dec);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    let alive = true;
    const canvas = ref.current;
    if (!canvas) return;
    // Start after the page has painted, so the stars never compete with the first images.
    const idle = (cb: () => void) => ((window as any).requestIdleCallback ? (window as any).requestIdleCallback(cb, { timeout: 2500 }) : setTimeout(cb, 1200));
    new Promise<void>((r) => idle(r))
      .then(() => (alive ? createStarfield(canvas, { reduced: prefersReducedMotion(), accent: '#e08d3c' }) : Promise.reject(new Error('gone'))))
      .then(
      (s) => {
        if (!alive) return s.dispose();
        sf.current = s;
        const st = useStore.getState();
        s.setTarget(st.ra, st.dec);
        canvas.classList.add('on');
      },
      () => {
        /* no WebGL or no data: the plain background stays */
      },
    );
    return () => {
      alive = false;
      sf.current?.dispose();
      sf.current = null;
    };
  }, []);
  useEffect(() => sf.current?.setTarget(ra, dec), [ra, dec]);

  return <canvas ref={ref} className="sky-backdrop" aria-hidden="true" data-theme-hidden={theme === 'light' ? '' : undefined} />;
}

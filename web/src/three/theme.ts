// Colours for the 3D views, read from the app's CSS variables so the scenes
// follow the current theme. Every value has a neutral fallback.
import { useEffect, useState } from 'react';

export type ThreePalette = {
  bg: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  det: string[]; // D1..D6 data colours
  dark: boolean;
};

const FALLBACK_DARK: ThreePalette = {
  bg: '#0b0d10',
  text: '#e6e6e3',
  muted: '#8b8f96',
  line: '#2a2e35',
  accent: '#d9822b',
  det: ['#6f8fd6', '#5aa9b8', '#74ad7a', '#c9b45a', '#d08a4a', '#c8675d'],
  dark: true,
};

const FALLBACK_LIGHT: ThreePalette = {
  ...FALLBACK_DARK,
  bg: '#f6f5f2',
  text: '#1b1d21',
  muted: '#62666d',
  line: '#d6d4cf',
  dark: false,
};

function isDark(): boolean {
  if (typeof document === 'undefined') return true;
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light') return false;
  if (t === 'dark') return true;
  return !window.matchMedia?.('(prefers-color-scheme: light)').matches;
}

/** Turns any CSS colour (rgba, hsl, names) into #rrggbb for three.js. */
function toHex(css: string, fallback: string): string {
  const v = css.trim();
  if (!v) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map((c) => c + c).join('');
  const m = v.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('');
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (c) {
      c.fillStyle = fallback;
      c.fillStyle = v;
      const out = String(c.fillStyle);
      if (/^#[0-9a-f]{6}$/i.test(out)) return out;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export function readPalette(): ThreePalette {
  const dark = isDark();
  const fb = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  if (typeof document === 'undefined') return fb;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, f: string) => toHex(cs.getPropertyValue(name), f);
  return {
    bg: get('--bg', fb.bg),
    text: get('--text', fb.text),
    muted: get('--muted', fb.muted),
    line: get('--line-2', get('--line', fb.line)),
    accent: get('--accent', fb.accent),
    det: fb.det.map((d, i) => get(`--d${i + 1}`, d)),
    dark,
  };
}

/** Palette that updates when the page switches theme (data-theme or class change). */
export function usePalette(): ThreePalette {
  const [p, setP] = useState<ThreePalette>(readPalette);
  useEffect(() => {
    const update = () => setP(readPalette());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener?.('change', update);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', update);
    };
  }, []);
  return p;
}

/** Linear variable filter ranges of the six SPHEREx detectors, micrometres. */
export const DETECTORS = [
  { det: 1, lo: 0.75, hi: 1.11, array: 'SWIR' },
  { det: 2, lo: 1.11, hi: 1.64, array: 'SWIR' },
  { det: 3, lo: 1.64, hi: 2.42, array: 'SWIR' },
  { det: 4, lo: 2.42, hi: 3.82, array: 'MWIR' },
  { det: 5, lo: 3.82, hi: 4.42, array: 'MWIR' },
  { det: 6, lo: 4.42, hi: 5.0, array: 'MWIR' },
] as const;

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_COLL, useStore, type PairKind, type WanderState } from '../store';

export interface Target {
  ra: number | null;
  dec: number | null;
  name: string;
  coll: string;
  a: string;
  b: string;
  mode: string;
  det: number | null;
  pair: PairKind;
}

const KEYS = ['ra', 'dec', 'name', 'coll', 'a', 'b', 'mode', 'det', 'pair'] as const;
type Key = (typeof KEYS)[number];
type Patch = Partial<Record<Key, string | number | null | undefined>> & { pairSource?: WanderState['pairSource'] };

/** Pages where the URL should carry the target. */
export const TARGET_ROUTES = ['/explore', '/timeline', '/compare', '/movers', '/spectrum'];

function toStore(patch: Patch): Partial<WanderState> {
  const out: Partial<WanderState> = {};
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? parseFloat(v) : NaN;
    return isFinite(n) ? n : null;
  };
  for (const [k, v] of Object.entries(patch) as [string, unknown][]) {
    if (k === 'ra' || k === 'dec' || k === 'det') (out as any)[k] = num(v);
    else if (k === 'coll') out.coll = (v as string) || DEFAULT_COLL;
    else if (k === 'pair') out.pair = v === 'short' ? 'short' : 'long';
    else if (k === 'pairSource') out.pairSource = v as WanderState['pairSource'];
    else (out as any)[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/** Search string for the current store target (only target keys), plus mock/theme from the URL. */
export function searchOf(s: Pick<WanderState, Key>, current = ''): string {
  const out = new URLSearchParams();
  if (s.ra !== null && s.dec !== null) {
    out.set('ra', String(+s.ra.toFixed(6)));
    out.set('dec', String(+s.dec.toFixed(6)));
    if (s.name) out.set('name', s.name);
    if (s.coll && s.coll !== DEFAULT_COLL) out.set('coll', s.coll);
    if (s.a) out.set('a', s.a);
    if (s.b) out.set('b', s.b);
    if (s.mode) out.set('mode', s.mode);
    if (s.det !== null) out.set('det', String(s.det));
    if (s.pair === 'short') out.set('pair', 'short');
  }
  const cur = new URLSearchParams(current);
  for (const k of ['mock', 'theme']) {
    const v = cur.get(k);
    if (v) out.set(k, v);
  }
  const str = out.toString();
  return str ? `?${str}` : '';
}

/**
 * The target lives in the global store (persisted). The URL mirrors it so every
 * screen stays shareable and deep-linkable; a URL with ra/dec wins on load.
 */
export function useTarget() {
  const nav = useNavigate();
  const loc = useLocation();
  const ra = useStore((s) => s.ra);
  const dec = useStore((s) => s.dec);
  const name = useStore((s) => s.name);
  const coll = useStore((s) => s.coll);
  const a = useStore((s) => s.a);
  const b = useStore((s) => s.b);
  const mode = useStore((s) => s.mode);
  const det = useStore((s) => s.det);
  const pair = useStore((s) => s.pair);
  const target: Target = useMemo(() => ({ ra, dec, name, coll, a, b, mode, det, pair }), [ra, dec, name, coll, a, b, mode, det, pair]);

  const update = useCallback(
    (patch: Patch, path?: string, replace = false) => {
      const sp: Partial<WanderState> = toStore(patch);
      // A pair chosen by hand (or by a preset) is never replaced by the auto pair.
      if (('a' in patch || 'b' in patch) && !patch.pairSource) sp.pairSource = patch.a || patch.b ? 'user' : 'auto';
      useStore.getState().set(sp);
      const st = useStore.getState();
      const to = path ?? loc.pathname;
      nav({ pathname: to, search: TARGET_ROUTES.includes(to) ? searchOf(st, loc.search) : searchOf({ ...st, ra: null, dec: null }, loc.search) }, { replace });
    },
    [nav, loc.pathname, loc.search],
  );

  const has = ra !== null && dec !== null;
  return { target, update, has };
}

/** Keeps URL and store in step. Mounted once in the app shell. */
export function UrlSync() {
  const loc = useLocation();
  const nav = useNavigate();
  const first = useRef(true);
  useEffect(() => {
    const sp = new URLSearchParams(loc.search);
    const st = useStore.getState();
    if (sp.get('ra') !== null && sp.get('dec') !== null) {
      const patch: Patch = {};
      for (const k of KEYS) patch[k] = sp.get(k);
      const next = toStore(patch);
      const changed = (Object.keys(next) as (keyof WanderState)[]).some((k) => {
        const v = next[k], cur = st[k];
        return typeof v === 'number' && typeof cur === 'number' ? Math.abs(v - cur) > 1e-6 : v !== cur;
      });
      if (changed) {
        const keepPair = next.a === st.a && next.b === st.b;
        useStore.getState().set({ ...next, pairSource: keepPair ? st.pairSource : next.a && next.b ? 'user' : 'auto' });
      }
    } else if (st.ra !== null && st.dec !== null && TARGET_ROUTES.includes(loc.pathname)) {
      // No target in the URL: show the remembered one (first load, or a bare link).
      nav({ pathname: loc.pathname, search: searchOf(st, loc.search) }, { replace: true });
    }
    first.current = false;
  }, [loc.pathname, loc.search, nav]);

  // When the store changes outside update() (auto pair), mirror it into the URL.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.a === prev.a && s.b === prev.b) return;
        if (!TARGET_ROUTES.includes(window.location.pathname)) return;
        const want = searchOf(s, window.location.search);
        if (want !== window.location.search && `?${new URLSearchParams(window.location.search)}` !== want) nav({ pathname: window.location.pathname, search: want }, { replace: true });
      }),
    [nav],
  );
  return null;
}

/** Search string for nav links, built from the store. */
export function useCarry(): string {
  const loc = useLocation();
  const s = useStore(useShallow((x) => ({ ra: x.ra, dec: x.dec, name: x.name, coll: x.coll, a: x.a, b: x.b, mode: x.mode, det: x.det, pair: x.pair })));
  return searchOf(s, loc.search);
}

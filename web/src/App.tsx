import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { FocusLayer } from './components/FocusMode';
import RouteBoundary from './components/RouteBoundary';
import TimeStrip from './components/TimeStrip';
import { Icon, IconButton, Logo } from './components/ui';
import { ex, type ExplainKey } from './explain';
import { fmtDec, fmtRa } from './lib/format';
import { save } from './lib/storage';
import { searchOf, TARGET_ROUTES, UrlSync, useCarry, useTarget } from './lib/target';
import Explore from './pages/Explore';
import { useStore } from './store';

// Page chunks. The same loaders are called on nav hover so the chunk is ready on click.
const LOADERS: Record<string, () => Promise<unknown>> = {
  '/timeline': () => import('./pages/Timeline'),
  '/compare': () => import('./pages/Compare'),
  '/movers': () => import('./pages/Movers'),
  '/track': () => import('./pages/Track'),
  '/spectrum': () => import('./pages/Spectrum'),
  '/docs': () => import('./pages/Docs'),
  '/about': () => import('./pages/About'),
};
const Timeline = lazy(() => import('./pages/Timeline'));
const Compare = lazy(() => import('./pages/Compare'));
const Movers = lazy(() => import('./pages/Movers'));
const Track = lazy(() => import('./pages/Track'));
const Spectrum = lazy(() => import('./pages/Spectrum'));
const Docs = lazy(() => import('./pages/Docs'));
const About = lazy(() => import('./pages/About'));
const SkyBackdrop = lazy(() => import('./scene/SkyBackdrop'));
const prefetched = new Set<string>();
const prefetch = (to: string) => {
  if (prefetched.has(to) || !LOADERS[to]) return;
  prefetched.add(to);
  LOADERS[to]().catch(() => prefetched.delete(to));
};

const NAV: { to: string; label: string; key: ExplainKey }[] = [
  { to: '/', label: 'Explore', key: 'nav.explore' },
  { to: '/timeline', label: 'Timeline', key: 'nav.timeline' },
  { to: '/compare', label: 'Compare', key: 'nav.compare' },
  { to: '/movers', label: 'Movers', key: 'nav.movers' },
  { to: '/track', label: 'Track', key: 'nav.track' },
  { to: '/spectrum', label: 'Spectrum', key: 'nav.spectrum' },
  { to: '/docs', label: 'Docs', key: 'nav.docs' },
  { to: '/about', label: 'About', key: 'nav.about' },
];

function useHealth() {
  const [h, setH] = useState<'live' | 'mock' | 'down' | 'wait'>('wait');
  useEffect(() => {
    let alive = true;
    const check = () =>
      api.health().then(
        (r) => alive && setH(api.mode === 'mock' ? 'mock' : r.ok ? 'live' : 'down'),
        () => alive && setH('down'),
      );
    check();
    const t = setInterval(check, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return h;
}

function useThemeEffect() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    // A ?theme= in the address bar (screenshots) wins over the saved choice.
    let t = theme;
    try {
      const q = new URLSearchParams(location.search).get('theme');
      if (q === 'light' || q === 'dark') t = q;
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute('data-theme', t);
    save('wanderer.theme', t); // read by the inline script in index.html to avoid a flash
  }, [theme]);
  return theme;
}

function Header() {
  const theme = useThemeEffect();
  const focus = useStore((s) => s.focus);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const health = useHealth();
  const carry = useCarry();
  const plain = searchOf({ ra: null, dec: null, name: '', coll: '', a: '', b: '', mode: '', det: null, pair: 'long' }, loc.search);
  useEffect(() => setMenu(false), [loc.pathname]);
  const statusText = { live: 'Live data', mock: 'Mock data', down: 'Server offline', wait: 'Connecting' }[health];
  return (
    <>
      <header className="hdr">
        <Link to={{ pathname: '/', search: carry }} className="brand" data-explain={ex('nav.home')} aria-label="Wanderer home">
          <Logo />
          <span className="brand-name">Wanderer</span>
          <span className="brand-sub">SPHEREx sky change explorer</span>
        </Link>
        <nav className={`nav${menu ? ' open' : ''}`} aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={{ pathname: n.to, search: TARGET_ROUTES.includes(n.to) ? carry : plain }} end={n.to === '/'} onMouseEnter={() => prefetch(n.to)} onFocus={() => prefetch(n.to)} data-explain={ex(n.key)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hdr-right">
          <TargetChip />
          <span className={`status-dot ${health}`} title={statusText}>
            <span>{statusText}</span>
          </span>
          <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })} explain={ex('header.theme')}>
            {theme === 'dark' ? Icon.sun : Icon.moon}
          </IconButton>
          <button
            type="button"
            className={`icon-btn${focus ? ' on' : ''}`}
            aria-pressed={focus}
            aria-label="Focus mode"
            title="Focus mode"
            onClick={() => set({ focus: !focus })}
            data-explain={ex('header.focus')}
            data-focus-toggle=""
          >
            {Icon.crosshair}
          </button>
          <IconButton label="Menu" onClick={() => setMenu((m) => !m)} explain={ex('nav.menu')} className="menu-btn" on={menu}>
            {Icon.menu}
          </IconButton>
        </div>
      </header>
      <FocusLayer on={focus} />
    </>
  );
}

/** Current target in the header, with a clear button. */
function TargetChip() {
  const { target, has, update } = useTarget();
  if (!has) return null;
  return (
    <span className="tgt" title={`RA ${fmtRa(target.ra!)}, Dec ${fmtDec(target.dec!)}`}>
      <span className="tgt-name">{target.name || 'Target'}</span>
      <span className="mono tgt-pos">
        {target.ra!.toFixed(3)} {target.dec! >= 0 ? '+' : ''}
        {target.dec!.toFixed(3)}
      </span>
      {target.coll === 'spherex_dr1_deep' && <span className="tgt-coll">deep</span>}
      <button type="button" className="tgt-x" aria-label="Clear target" title="Clear target" onClick={() => update({ ra: null, dec: null, name: null, a: null, b: null, mode: null, det: null }, '/')} data-explain={ex('target.clear')}>
        {'×'}
      </button>
    </span>
  );
}

export default function App() {
  const loc = useLocation();
  return (
    <div className="shell">
      <Suspense fallback={null}>
        <SkyBackdrop />
      </Suspense>
      <UrlSync />
      <Header />
      <main className="main">
        <RouteBoundary resetKey={loc.pathname}>
          <Suspense fallback={<div className="page muted">Loading...</div>}>
            <Routes>
              <Route path="/" element={<Explore />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/compare" element={<Compare />} />
              <Route path="/movers" element={<Movers />} />
              <Route path="/track" element={<Track />} />
              <Route path="/spectrum" element={<Spectrum />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="/about" element={<About />} />
              {/* /lab: 3D demo route, added by the 3D work in src/three. */}
              <Route path="*" element={<Explore />} />
            </Routes>
          </Suspense>
        </RouteBoundary>
      </main>
      <TimeStrip />
    </div>
  );
}

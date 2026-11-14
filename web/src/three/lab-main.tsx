// Standalone test page for the 3D components: http://localhost:5173/lab.html
// Query: ?only=model|fpa|now|helio  &theme=light|dark
import { StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { PerfOverlay, PERF } from './perf';

const SpherexModel = lazy(() => import('./SpherexModel'));
const SpherexNow = lazy(() => import('./SpherexNow'));
const HelioTrack = lazy(() => import('./HelioTrack'));
const FocalPlaneInset = lazy(() => import('./FocalPlaneInset'));

const only = new URLSearchParams(location.search).get('only');

// Sample marks only (daily, 2025-08-07 to 2025-08-15, MJD 60894 to 60902); the app passes real frame times.
const SAMPLE_MARKS = Array.from({ length: 9 }, (_, i) => 60894 + i);

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  if (only && only !== id) return null;
  return (
    <section style={{ margin: '0 0 28px' }} id={id}>
      <h2 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>{title}</h2>
      <Suspense fallback={<div style={{ height: 520 }}>Loading</div>}>{children}</Suspense>
    </section>
  );
}

function toggleTheme() {
  const el = document.documentElement;
  el.setAttribute('data-theme', el.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}

function Lab() {
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>Wanderer 3D lab</h1>
        <button
          type="button"
          className="w3-btn"
          onClick={toggleTheme}
          data-explain="Switch this test page between the dark and light theme."
        >
          Theme
        </button>
      </header>
      {PERF ? <PerfOverlay /> : null}
      <Section id="model" title="SpherexModel">
        <SpherexModel height={560} />
      </Section>
      <Section id="fpa" title="FocalPlaneInset">
        <div style={{ maxWidth: 420 }}>
          <FocalPlaneInset highlight={3} markWaveUm={2.0} />
        </div>
      </Section>
      <Section id="now" title="SpherexNow">
        <SpherexNow height={560} />
      </Section>
      <Section id="helio" title="HelioTrack (3I/ATLAS, sample marks)">
        <HelioTrack name="3I/ATLAS" start="2025-05-01" stop="2026-05-01" step="1 d" markTimes={SAMPLE_MARKS} height={560} />
      </Section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
);

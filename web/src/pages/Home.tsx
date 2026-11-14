import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ex } from '../explain';
import './home.css';

const SpherexNow = lazy(() => import('../three/SpherexNow'));
const SpherexModel = lazy(() => import('../three/SpherexModel'));
const HelioTrack = lazy(() => import('../three/HelioTrack'));
const FocalPlaneInset = lazy(() => import('../three/FocalPlaneInset'));

const HOLDA = 'ra=179.8&dec=1.101&coll=spherex_dr1&a=2025W21_1B_0345_1_D2.dr1&b=2025W21_2C_0020_1_D2.dr1';

const EXAMPLES = [
  {
    to: `/compare?${HOLDA}&mode=diff`,
    img: '/api/diff.png?a=2025W21_1B_0345_1_D2.dr1&b=2025W21_2C_0020_1_D2.dr1&ra=179.8&dec=1.101&size=200&stretch=linear',
    kind: 'Asteroid',
    title: '872 Holda moves 8 arcminutes in 44 hours',
    text: 'Two real SPHEREx images subtracted. Blue is where the asteroid was, orange is where it went.',
  },
  {
    to: '/track?name=3I%2FATLAS',
    img: '/img/spherex-orbit.jpg',
    kind: 'Interstellar comet',
    title: '3I/ATLAS, a visitor from another star',
    text: 'Wanderer follows it through 60 SPHEREx images and shows its path through the Solar System in 3D.',
  },
  {
    to: '/compare?ra=83.822&dec=-5.391&coll=spherex_dr1&mode=colour',
    img: '/api/rgb.png?ra=83.822&dec=-5.391&size=200&collection=spherex_dr1',
    kind: 'Infrared colour',
    title: 'The Orion Nebula in SPHEREx colours',
    text: 'Three SPHEREx detectors from 1 to 5 microns combined into one false colour picture.',
  },
  {
    to: "/spectrum?ra=269.639183&dec=66.632986&coll=spherex_dr1_deep&name=Cat%27s%20Eye%20Nebula",
    img: '/img/spherex-dust-cloud.jpg',
    kind: 'Spectrum',
    title: 'A rainbow built from many visits',
    text: "SPHEREx sees a slightly different colour on every pass. Stack the Cat's Eye Nebula visits and hydrogen lights up.",
  },
];

/** Times (MJD) of the 35 real SPHEREx images of 3I/ATLAS, 1 to 15 August 2025, from the track job. */
const ATLAS_FRAMES = [60888.33, 60888.34, 60888.67, 60888.68, 60893.97, 60894.11, 60894.24, 60894.25, 60894.58, 60894.59, 60895.0, 60895.54, 60895.61, 60895.74, 60896.35, 60896.36, 60896.42, 60896.76, 60897.03, 60898.05, 60898.11, 60898.12, 60898.25, 60898.26, 60898.73, 60899.0, 60900.16, 60900.43, 60900.7, 60901.1, 60901.11, 60901.45, 60901.78, 60902.39, 60902.53];

const FACTS = [
  ['102', 'infrared colours'],
  ['0.75 to 5.0', 'microns'],
  ['6 months', 'to map the whole sky'],
  ['about 650 km', 'pole to pole orbit'],
];

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Wraps a 3D view so a plain mouse wheel scrolls the page instead of zooming.
 * Ctrl (or Cmd on Mac) + wheel, and trackpad pinch (which arrives as ctrl+wheel), still zoom.
 * The capture-phase listener stops the event before it reaches the canvas controls.
 */
function ScrollSafe({ className, children }: { className: string; children: ReactNode }) {
  const [hint, setHint] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    // Native capture listener (React wheel handlers are passive, so they cannot preventDefault).
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // stop the browser zooming the whole page; the 3D view still gets the event
        return;
      }
      e.stopPropagation(); // keep the 3D controls from eating the scroll, so the page scrolls
      setHint(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHint(false), 1400);
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true });
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div ref={ref} className={`${className} scroll-safe`}>
      {children}
      <div className={`zoom-hint${hint ? ' on' : ''}`} aria-hidden="true">
        Hold {IS_MAC ? '\u2318' : 'Ctrl'} and scroll to zoom
      </div>
    </div>
  );
}

function Fallback({ h }: { h: number | string }) {
  return <div className="home-3d-wait" style={{ height: h }} />;
}

export default function Home() {
  const [probe, setProbe] = useState(false);
  return (
    <div className="home">
      <section className={`home-hero${probe ? ' is-probe' : ''}`}>
        <div className="home-hero-3d">
          <Suspense fallback={<Fallback h="100%" />}>
            <SpherexNow height="100%" showControls={false} showReadout interactive wheelZoom="modifier" frameX={0.22} onFocusChange={setProbe} />
          </Suspense>
        </div>
        <div className="home-hero-text">
          <p className="home-eyebrow">NASA Space Apps 2026, Planet X and SPHEREx</p>
          <h1>See the SPHEREx sky move.</h1>
          <p className="home-lead">
            Since 2025 NASA&apos;s SPHEREx telescope has photographed the entire sky every six months in 102 colours of
            infrared light. Wanderer lines those photos up so anyone can watch asteroids drift, comets pass and nearby stars
            race across the sky.
          </p>
          <div className="home-cta">
            <Link className="btn btn-primary btn-lg" to="/explore" data-explain={ex('home.start')}>
              Start exploring
            </Link>
            <Link className="btn btn-lg" to={`/compare?${HOLDA}&mode=blink`} data-explain={ex('home.asteroid')}>
              Watch an asteroid move
            </Link>
          </div>
          <dl className="home-facts">
            {FACTS.map(([v, k]) => (
              <div key={k}>
                <dt className="mono">{v}</dt>
                <dd>{k}</dd>
              </div>
            ))}
          </dl>
        </div>
        <button
          type="button"
          className="home-scroll"
          onClick={() => document.getElementById('home-examples')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          data-explain={ex('home.scroll')}
        >
          <span>Scroll to explore</span>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <p className="home-hero-note">Live: SPHEREx right now, from its current orbital elements. Drag to look around.</p>
      </section>

      <section className="home-sec" id="home-examples">
        <header className="home-sec-head">
          <h2>Real changes, found in real data</h2>
          <p>Asteroids, an interstellar comet, nebulae: every result comes from real SPHEREx images in the NASA/IPAC IRSA archive. Pick one to open it.</p>
        </header>
        <div className="home-cards">
          {EXAMPLES.map((e) => (
            <Link key={e.title} to={e.to} className="home-card" data-explain={ex('home.example')}>
              <div className="home-card-img">
                <img src={e.img} alt="" loading="lazy" />
              </div>
              <div className="home-card-body">
                <span className="home-card-kind">{e.kind}</span>
                <h3>{e.title}</h3>
                <p>{e.text}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="home-sec home-split">
        <ScrollSafe className="home-split-3d">
          <Suspense fallback={<Fallback h={560} />}>
            <SpherexModel height={560} showPartList={false} autoRotate />
          </Suspense>
        </ScrollSafe>
        <div className="home-split-text">
          <h2>Meet the telescope</h2>
          <p>
            SPHEREx is a 20 cm infrared telescope inside three nested cone shaped shields that, with radiators alone,
            keep it at roughly minus 200 degrees Celsius. It circles Earth pole to pole, always looking away from our planet, and steps across
            the sky taking a new picture every couple of minutes.
          </p>
          <p>
            In front of its six detectors sit filters whose colour changes smoothly from one edge to the other. Each time the
            telescope steps, a star lands on a new colour. Six months later the whole sky has been seen in all 102 colours.
          </p>
          <div className="home-fpa">
            <Suspense fallback={null}>
              <FocalPlaneInset />
            </Suspense>
          </div>
          <Link className="btn" to="/docs" data-explain={ex('home.docs')}>
            How it works
          </Link>
        </div>
      </section>

      <section className="home-sec">
        <header className="home-sec-head">
          <h2>3I/ATLAS through the Solar System</h2>
          <p>
            The third object ever seen arriving from interstellar space. Its path is from NASA JPL Horizons; the marks show
            when SPHEREx photographed it in August 2025.
          </p>
        </header>
        <div className="home-wide-3d">
          <Suspense fallback={<Fallback h={560} />}>
            <HelioTrack name="3I/ATLAS" start="2025-05-01" stop="2026-05-01" step="1 d" markTimes={ATLAS_FRAMES} markLabel="SPHEREx images" height={560} wheelZoom="modifier" />
          </Suspense>
        </div>
      </section>

      <footer className="home-foot">
        <span>Wanderer, NASA Space Apps 2026. Not an official NASA product.</span>
        <span>Data: SPHEREx via NASA/IPAC IRSA, NASA JPL Solar System Dynamics, CelesTrak, CDS.</span>
      </footer>
    </div>
  );
}

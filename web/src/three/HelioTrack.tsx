// Heliocentric 3D view of a solar system object's path (JPL Horizons vectors via
// the gateway) with the orbits of Mercury to Jupiter, a time slider, and the
// times SPHEREx took frames marked on the path. Default export for React.lazy().
import { Suspense, memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { Starfield } from './Starfield';
import * as THREE from 'three';
import { ThreeGuard, fmt, jdToMs, msToJD, useInView, FORCE_HQ } from './support';
import { usePalette, type ThreePalette } from './theme';
import { PerfProbe, useRenderCount } from './perf';
import './three.css';

export type HelioTrackProps = {
  /** Object name as typed by the user; aliases such as 3I/ATLAS work (default 3I/ATLAS). */
  name?: string;
  /** Path range: YYYY-MM-DD, ISO 8601 or MJD. Gateway default is 9 months either side of today. */
  start?: string;
  stop?: string;
  /** Horizons step such as "2 d" or "12 h" (default: about 400 points). */
  step?: string;
  /** Times to mark on the path, e.g. SPHEREx frame times. Numbers below 100000 are MJD, others JD; strings are ISO dates. */
  markTimes?: Array<number | string | Date>;
  /** Legend text for the marks (default "SPHEREx frames"). */
  markLabel?: string;
  height?: number | string;
  endpoint?: string;
  className?: string;
};

type Vec = [number, number, number, number]; // jd, x, y, z (au, ecliptic J2000)
type Body = { name: string; id?: string; period_days?: number; points: Vec[]; now?: Vec };
type OrbitData = {
  name: string;
  now_jd: number;
  start: string;
  stop: string;
  step: string;
  object: Body;
  planets: Body[];
  warning?: string;
};

const AU_KM = 149597870.7;
type Speeds = { v: number[]; min: number; max: number; span: number };

function toJD(t: number | string | Date): number | null {
  if (t instanceof Date) return msToJD(t.getTime());
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) return null;
    if (t < 100000) return t + 2400000.5;
    if (t < 1e7) return t;
    return msToJD(t);
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? msToJD(ms) : null;
}

/** Linear interpolation of a time-ordered vector table at jd (clamped). */
function at(points: Vec[], jd: number): [number, number, number] | null {
  const n = points.length;
  if (!n) return null;
  if (jd <= points[0][0]) return [points[0][1], points[0][2], points[0][3]];
  if (jd >= points[n - 1][0]) return [points[n - 1][1], points[n - 1][2], points[n - 1][3]];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= jd) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const f = (jd - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

/** Planet position at any time from one sampled orbit (orbits repeat with the period). */
function planetAt(b: Body, jd: number) {
  if (!b.points.length || !b.period_days) return null;
  const p0 = b.points[0][0];
  const P = b.period_days;
  const t = p0 + ((((jd - p0) % P) + P) % P);
  return at(b.points, t);
}

/** Ecliptic (x, y, z) to scene: ecliptic plane is the XZ plane, north up. */
const sc = (p: [number, number, number] | null, out = new THREE.Vector3()) => (p ? out.set(p[0], p[2], -p[1]) : out.set(0, 0, 0));

const dateStr = (jd: number) => new Date(jdToMs(jd)).toISOString().slice(0, 10);

export default function HelioTrack({
  name = '3I/ATLAS',
  start,
  stop,
  step,
  markTimes = [],
  markLabel = 'SPHEREx frames',
  height = 520,
  endpoint = '/api/orbit',
  className,
}: HelioTrackProps) {
  useRenderCount('helio');
  const [data, setData] = useState<OrbitData | null>(null);
  const [err, setErr] = useState<string>('');
  const [reload, setReload] = useState(0);
  const [jd, setJdState] = useState<number | null>(null);
  const jdRef = useRef(0);
  const setJd = (v: number) => {
    jdRef.current = v;
    setJdState(v);
  };
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<'tilt' | 'top' | 'side'>('tilt');

  useEffect(() => {
    let dead = false;
    setErr('');
    setData(null);
    const q = new URLSearchParams({ name });
    if (start) q.set('start', start);
    if (stop) q.set('stop', stop);
    if (step) q.set('step', step);
    fetch(`${endpoint}?${q}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || 'HTTP ' + r.status);
        return j as OrbitData;
      })
      .then((j) => {
        if (dead) return;
        if (!j.object?.points?.length) throw new Error('no path returned');
        setData(j);
        const pts = j.object.points;
        const t0 = pts[0][0];
        const t1 = pts[pts.length - 1][0];
        let first = j.now_jd >= t0 && j.now_jd <= t1 ? j.now_jd : null;
        if (first === null) {
          const m = marksRef.current.find((x) => x >= t0 && x <= t1);
          let qi = 0;
          pts.forEach((q, i) => {
            if (Math.hypot(q[1], q[2], q[3]) < Math.hypot(pts[qi][1], pts[qi][2], pts[qi][3])) qi = i;
          });
          first = m ?? pts[qi][0];
        }
        setJd(first);
      })
      .catch((e: Error) => !dead && setErr(e.message || 'failed'));
    return () => {
      dead = true;
    };
  }, [name, start, stop, step, endpoint, reload]);

  const range = useMemo(() => {
    const pts = data?.object.points;
    return pts?.length ? { t0: pts[0][0], t1: pts[pts.length - 1][0] } : null;
  }, [data]);

  const marks = useMemo(
    () =>
      markTimes
        .map(toJD)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b),
    [markTimes],
  );
  const speeds = useMemo<Speeds>(() => {
    const pts = data?.object.points ?? [];
    const v = pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dt = b[0] - a[0];
      return dt > 0 ? (Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) * AU_KM) / (dt * 86400) : 0;
    });
    const min = v.length ? Math.min(...v) : 0;
    const max = v.length ? Math.max(...v) : 0;
    return { v, min, max, span: max - min };
  }, [data]);
  const marksRef = useRef(marks);
  marksRef.current = marks;

  // play: sweep the whole range in about 14 seconds
  useEffect(() => {
    if (!playing || !range) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const nv = jdRef.current + ((range.t1 - range.t0) / 14) * dt;
      if (nv >= range.t1) {
        setJd(range.t1);
        setPlaying(false);
        return;
      }
      jdRef.current = nv; // the scene reads this every frame
      if (now - lastUi > 150) {
        lastUi = now; // slider and readout: about 7 updates a second
        setJdState(nv);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, range]);

  const info = useMemo(() => {
    if (!data || jd === null) return null;
    const p = at(data.object.points, jd);
    const e = data.planets.find((b) => b.id === '399');
    const ep = e ? planetAt(e, jd) : null;
    const pts = data.object.points;
    const ta = Math.max(pts[0][0], jd - 0.5);
    const tb = Math.min(pts[pts.length - 1][0], jd + 0.5);
    const p2 = at(pts, tb);
    const p1 = at(pts, ta);
    if (!p) return null;
    const rSun = Math.hypot(p[0], p[1], p[2]);
    const rEarth = ep ? Math.hypot(p[0] - ep[0], p[1] - ep[1], p[2] - ep[2]) : NaN;
    const v = p1 && p2 && tb > ta ? (Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) * AU_KM) / ((tb - ta) * 86400) : NaN;
    // closest approach to the Sun within the range
    let qi = 0;
    data.object.points.forEach((q, i) => {
      const a = data.object.points[qi];
      if (Math.hypot(q[1], q[2], q[3]) < Math.hypot(a[1], a[2], a[3])) qi = i;
    });
    const q = data.object.points[qi];
    return { rSun, rEarth, v, periJd: q[0], periR: Math.hypot(q[1], q[2], q[3]) };
  }, [data, jd]);

  const still = data && jd !== null ? <HelioSvg data={data} jd={jd} marks={marks} /> : <div className="w3-loading">Loading orbit</div>;

  return (
    <div className={'w3-root w3-helio ' + (className ?? '')} style={{ height }}>
      {err ? (
        <div className="w3-error">
          <p>
            Could not load the orbit of {name}: {err}
          </p>
          <button
            type="button"
            className="w3-btn"
            onClick={() => setReload((k) => k + 1)}
            data-explain="Ask JPL Horizons for the orbit again."
          >
            Try again
          </button>
        </div>
      ) : !data || jd === null ? (
        <div className="w3-loading">Loading orbit of {name} from JPL Horizons</div>
      ) : (
        <ThreeGuard still={still} label="view of the orbit">
          <HelioCanvas data={data} jdRef={jdRef} marks={marks} view={view} speeds={speeds} />
        </ThreeGuard>
      )}

      {data && range && jd !== null ? (
        <>
          <div className="w3-toolbar">
            {(
              [
                ['tilt', 'Angled', 'Look at the orbits from above at an angle.'],
                ['top', 'From above', 'Look straight down on the plane of the planets, like a map of the solar system.'],
                ['side', 'Edge on', 'Look along the plane of the planets to see how steeply the path is tilted.'],
              ] as const
            ).map(([v, label, explain]) => (
              <button key={v} type="button" className="w3-btn" aria-pressed={view === v} onClick={() => setView(v)} data-explain={explain}>
                {label}
              </button>
            ))}
          </div>

          <div className="w3-readout">
            <div className="w3-readout-head">
              <span>{data.object.name || name}</span>
            </div>
            <dl>
              <dt>Date</dt>
              <dd>{dateStr(jd)}</dd>
              <dt>From Sun</dt>
              <dd>{info ? `${fmt(info.rSun, 2)} au` : '-'}</dd>
              <dt>From Earth</dt>
              <dd>{info ? `${fmt(info.rEarth, 2)} au` : '-'}</dd>
              <dt>Speed</dt>
              <dd>{info ? `${fmt(info.v, 1)} km/s` : '-'}</dd>
            </dl>
            <div className="w3-readout-foot">
              Closest to the Sun in this range: {info ? `${fmt(info.periR, 2)} au on ${dateStr(info.periJd)}` : '-'}.
              {marks.length ? ` Marked: ${marks.length} ${markLabel}.` : ''} Positions: JPL Horizons, Sun centred.
            </div>
          </div>

          <div className="w3-timebar">
            <button
              type="button"
              className="w3-btn"
              aria-pressed={playing}
              onClick={() => {
                if (!playing && jd >= range.t1) setJd(range.t0);
                setPlaying((p) => !p);
              }}
              data-explain="Play the motion along the path from the first date to the last. Press again to pause."
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="w3-btn"
              onClick={() => {
                setPlaying(false);
                setJd(Math.min(range.t1, Math.max(range.t0, data.now_jd)));
              }}
              data-explain="Jump to today's date (or the nearest end of the path if today is outside it)."
            >
              Today
            </button>
            <input
              type="range"
              min={range.t0}
              max={range.t1}
              step={(range.t1 - range.t0) / 1000}
              value={jd}
              onChange={(e) => {
                setPlaying(false);
                setJd(+e.target.value);
              }}
              aria-label="Date along the path"
              data-explain="Drag to move through time. The object and the planets move to where they were on that date."
            />
            <span className="w3-num">{dateStr(jd)}</span>
          </div>
          <div className="w3-legend">
            <span className="w3-num">{fmt(speeds.min, 0)}</span>
            <span className="w3-ramp" style={{ background: `linear-gradient(90deg, #4f6f93, #c9b48a, ${'var(--w3-accent)'})` }} />
            <span className="w3-num">{fmt(speeds.max, 0)} km/s</span> path coloured by speed
            <span className="w3-key w3-key-mark" /> {markLabel}
            <span className="w3-key w3-key-planet" /> planets on this date. Coma and tails drawn schematically.
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3D (all motion is driven from jdRef inside useFrame: no React renders while playing)
// ---------------------------------------------------------------------------

type View = 'tilt' | 'top' | 'side';
type SceneProps = { data: OrbitData; jdRef: MutableRefObject<number>; marks: number[]; view: View; speeds: Speeds };

const HelioCanvas = memo(function HelioCanvas(props: SceneProps) {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box);
  const [low, setLow] = useState(false);
  return (
    <div ref={box} className="w3-stage">
      <Canvas
        frameloop={inView ? 'always' : 'never'}
        dpr={low ? 1 : [1, 1.5]}
        camera={{ position: [0, 6, 8], fov: 35, near: 0.01, far: 500 }}
        gl={{ antialias: !low, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      >
        <PerformanceMonitor onDecline={() => setLow(!FORCE_HQ)} onIncline={() => setLow(false)} flipflops={3} />
        <color attach="background" args={[SPACE]} />
        <Suspense fallback={null}>
          <PerfProbe name="helio" />
          <HelioScene {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
});

const SPACE = '#030408';

const PLANET_LOOK: Record<string, { color: string; size: number }> = {
  '199': { color: '#9c968e', size: 0.04 },
  '299': { color: '#e3cf9c', size: 0.06 },
  '399': { color: '#5d8fd0', size: 0.065 },
  '499': { color: '#c4653d', size: 0.05 },
  '599': { color: '#d2b48c', size: 0.12 },
};

let softDot: THREE.Texture | null = null;
/** Soft round sprite shared by the glow and particle materials. */
function dotTexture() {
  if (softDot) return softDot;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  if (c) {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  }
  softDot = new THREE.CanvasTexture(cv);
  return softDot;
}

function jupiterTexture() {
  const cv = document.createElement('canvas');
  cv.width = 8;
  cv.height = 128;
  const c = cv.getContext('2d');
  if (c) {
    const bands = ['#d8c3a0', '#b48a63', '#e6d6b8', '#a87a55', '#dcc7a4', '#c09a73', '#e9dcc3', '#a97d58', '#d9c4a2'];
    bands.forEach((b, i) => {
      c.fillStyle = b;
      c.fillRect(0, (i * 128) / bands.length, 8, 128 / bands.length + 1);
    });
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Colour ramp for speed: steel blue (slow), sand, accent (fast). */
function speedColor(f: number, accent: THREE.Color, out = new THREE.Color()) {
  const a = new THREE.Color('#4f6f93');
  const b = new THREE.Color('#c9b48a');
  return f < 0.5 ? out.copy(a).lerp(b, f * 2) : out.copy(b).lerp(accent, (f - 0.5) * 2);
}

function PlanetBody({ body, jdRef, pal }: { body: Body; jdRef: MutableRefObject<number>; pal: ThreePalette }) {
  const look = PLANET_LOOK[body.id ?? ''] ?? { color: '#aaaaaa', size: 0.035 };
  const g = useRef<THREE.Group>(null);
  const line = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(body.points.map((p) => sc([p[1], p[2], p[3]], new THREE.Vector3())));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(body.points.length * 4), 4));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    l.frustumCulled = false;
    return l;
  }, [body]);
  const jtex = useMemo(() => (body.id === '599' ? jupiterTexture() : null), [body.id]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      jtex?.dispose();
    },
    [line, jtex],
  );
  const base = useMemo(() => new THREE.Color(pal.muted).lerp(new THREE.Color(look.color), 0.35), [pal.muted, look.color]);
  const last = useRef(NaN);
  useFrame(() => {
    const jd = jdRef.current;
    if (jd === last.current) return;
    last.current = jd;
    const p = planetAt(body, jd);
    if (g.current && p) sc(p, g.current.position);
    // orbit drawn as a trail: bright just behind the planet, fading around the orbit
    const P = body.period_days ?? 365;
    const ca = line.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < body.points.length; i++) {
      let lag = (jd - body.points[i][0]) / P; // fraction of an orbit since the planet was here
      lag = ((lag % 1) + 1) % 1;
      const a = 0.08 + 0.7 * Math.pow(1 - lag, 3);
      ca.setXYZW(i, base.r, base.g, base.b, a);
    }
    ca.needsUpdate = true;
  });
  return (
    <group>
      <primitive object={line} />
      <group ref={g}>
        <mesh rotation={[0.05, 0, 0]}>
          <sphereGeometry args={[look.size, 24, 16]} />
          <meshStandardMaterial color={jtex ? '#ffffff' : look.color} map={jtex} roughness={0.85} metalness={0} />
        </mesh>
        <Html className="w3-tag" zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          {body.name}
        </Html>
      </group>
    </group>
  );
}

const N_COMA = 500;
const N_ION = 450;
const N_DUST = 650;

/** Nucleus, coma and the two tails, drawn schematically (lengths exaggerated, scaled with distance from the Sun). */
function Comet({ data, jdRef, R, accent }: { data: OrbitData; jdRef: MutableRefObject<number>; R: number; accent: string }) {
  const g = useRef<THREE.Group>(null);
  const rnd = useMemo(() => {
    const a = new Float32Array((N_COMA + N_ION + N_DUST) * 4);
    for (let i = 0; i < a.length; i++) a[i] = Math.random();
    return a;
  }, []);
  const { points, geo, mat } = useMemo(() => {
    const n = N_COMA + N_ION + N_DUST;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    const coma = new THREE.Color('#e8e4d8');
    const ion = new THREE.Color('#6f9ad8');
    const dust = new THREE.Color('#e2cfa6');
    for (let i = 0; i < n; i++) {
      const c = i < N_COMA ? coma : i < N_COMA + N_ION ? ion : dust;
      col.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.035,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, geo, mat };
  }, []);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  const tmp = useMemo(
    () => ({ n: new THREE.Vector3(), s: new THREE.Vector3(), v: new THREE.Vector3(), u: new THREE.Vector3(), w: new THREE.Vector3() }),
    [],
  );
  const last = useRef(NaN);
  useFrame(() => {
    const jd = jdRef.current;
    if (jd === last.current) return;
    last.current = jd;
    const pts = data.object.points;
    const p = at(pts, jd);
    const p2 = at(pts, Math.min(pts[pts.length - 1][0], jd + 1));
    const p1 = at(pts, Math.max(pts[0][0], jd - 1));
    if (!p || !p1 || !p2) return;
    const n = sc(p, tmp.n);
    if (g.current) g.current.position.copy(n);
    const r = n.length();
    const anti = tmp.s.copy(n).normalize(); // straight away from the Sun
    const vel = sc([p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], tmp.v).normalize();
    const side = tmp.u.crossVectors(anti, vel).normalize();
    const lat = tmp.w.crossVectors(side, anti).normalize();
    const act = Math.min(2.5, Math.max(0.08, Math.pow(2.2 / Math.max(r, 0.3), 2))); // activity rises near the Sun
    const scale = Math.max(0.6, R / 4);
    const L = 0.55 * act * scale;
    const pa = geo.attributes.position as THREE.BufferAttribute;
    const gauss = (i: number) => (rnd[i] + rnd[(i + 7) % rnd.length] + rnd[(i + 13) % rnd.length] - 1.5) * 1.15;
    let k = 0;
    for (let i = 0; i < N_COMA; i++, k++) {
      const c = 0.04 * Math.sqrt(act) * scale;
      pa.setXYZ(k, gauss(k * 4) * c, gauss(k * 4 + 1) * c, gauss(k * 4 + 2) * c);
    }
    for (let i = 0; i < N_ION; i++, k++) {
      const s = Math.pow(rnd[k * 4], 0.8);
      const wdt = 0.012 * scale * (0.3 + s);
      const x = anti.x * L * 1.3 * s + side.x * gauss(k * 4 + 1) * wdt + lat.x * gauss(k * 4 + 2) * wdt;
      const y = anti.y * L * 1.3 * s + side.y * gauss(k * 4 + 1) * wdt + lat.y * gauss(k * 4 + 2) * wdt;
      const z = anti.z * L * 1.3 * s + side.z * gauss(k * 4 + 1) * wdt + lat.z * gauss(k * 4 + 2) * wdt;
      pa.setXYZ(k, x, y, z);
    }
    for (let i = 0; i < N_DUST; i++, k++) {
      const s = Math.pow(rnd[k * 4], 0.9);
      const wdt = 0.03 * scale * (0.2 + s);
      const bend = -0.55 * L * s * s; // dust lags behind the motion, so the tail curves
      const x = anti.x * L * s + vel.x * bend + side.x * gauss(k * 4 + 1) * wdt * 0.4 + lat.x * gauss(k * 4 + 2) * wdt;
      const y = anti.y * L * s + vel.y * bend + side.y * gauss(k * 4 + 1) * wdt * 0.4 + lat.y * gauss(k * 4 + 2) * wdt;
      const z = anti.z * L * s + vel.z * bend + side.z * gauss(k * 4 + 1) * wdt * 0.4 + lat.z * gauss(k * 4 + 2) * wdt;
      pa.setXYZ(k, x, y, z);
    }
    pa.needsUpdate = true;
    mat.size = 0.05 * scale;
  });
  return (
    <group ref={g}>
      <primitive object={points} />
      <mesh>
        <sphereGeometry args={[R * 0.012, 16, 12]} />
        <meshBasicMaterial color={accent} />
      </mesh>
      <Html className="w3-tag w3-tag-strong" zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        {data.object.name || data.name}
      </Html>
    </group>
  );
}

function HelioScene({ data, jdRef, marks, view, speeds }: SceneProps) {
  useRenderCount('helio/scene');
  const pal = usePalette();
  const { camera, scene } = useThree();
  const controls = useRef<React.ElementRef<typeof OrbitControls>>(null);
  const accent = useMemo(() => new THREE.Color(pal.accent), [pal.accent]);
  const objPts = useMemo(() => data.object.points.map((p) => sc([p[1], p[2], p[3]], new THREE.Vector3())), [data]);

  // path coloured by speed; the part still to come is dimmer
  const path = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(objPts);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(objPts.length * 4), 4));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    l.frustumCulled = false;
    return l;
  }, [objPts]);
  useEffect(
    () => () => {
      path.geometry.dispose();
      (path.material as THREE.Material).dispose();
    },
    [path],
  );
  const lastIdx = useRef(-1);
  useFrame(() => {
    const pts = data.object.points;
    const jd = jdRef.current;
    let i = 0;
    while (i < pts.length && pts[i][0] <= jd) i++;
    if (i === lastIdx.current) return;
    lastIdx.current = i;
    const ca = path.geometry.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let k = 0; k < pts.length; k++) {
      speedColor(speeds.span > 0 ? (speeds.v[k] - speeds.min) / speeds.span : 0.5, accent, c);
      ca.setXYZW(k, c.r, c.g, c.b, k < i ? 1 : 0.32);
    }
    ca.needsUpdate = true;
  });

  // SPHEREx frame times: one instanced mesh
  const markMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ color: pal.det[2] }),
      Math.max(1, marks.length),
    );
    m.count = marks.length;
    return m;
  }, [marks.length, pal.det]);
  useEffect(
    () => () => {
      markMesh.geometry.dispose();
      (markMesh.material as THREE.Material).dispose();
      markMesh.dispose();
    },
    [markMesh],
  );

  // fit: largest of the object path (capped) and Mars' orbit
  const R = useMemo(() => {
    let r = 1.7;
    for (const p of objPts) r = Math.max(r, Math.min(p.length(), 6));
    return r;
  }, [objPts]);

  useEffect(() => {
    const o = new THREE.Object3D();
    marks.forEach((m, i) => {
      sc(at(data.object.points, m), o.position);
      o.scale.setScalar(R * 0.007);
      o.updateMatrix();
      markMesh.setMatrixAt(i, o.matrix);
    });
    markMesh.instanceMatrix.needsUpdate = true;
  }, [marks, data, markMesh, R]);

  // depth cue: far objects fade into the background
  useEffect(() => {
    scene.fog = new THREE.FogExp2(SPACE, 0.2 / R);
    return () => {
      scene.fog = null;
    };
  }, [scene, R]);

  const grid = useMemo(() => {
    const gh = new THREE.PolarGridHelper(Math.ceil(R), 12, Math.ceil(R), 96, pal.muted, pal.muted);
    const m = gh.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.09;
    m.depthWrite = false;
    return gh;
  }, [R, pal.muted]);
  useEffect(() => () => grid.dispose(), [grid]);

  const goal = useRef<THREE.Vector3 | null>(null);
  useEffect(() => {
    const d = R * 2.6;
    goal.current =
      view === 'top'
        ? new THREE.Vector3(0, d, 0.0001)
        : view === 'side'
          ? new THREE.Vector3(0, 0.0001, d)
          : new THREE.Vector3(0, d * 0.55, d * 0.85);
  }, [view, R]);
  useFrame((_, dt) => {
    if (!goal.current) return;
    camera.position.lerp(goal.current, Math.min(1, dt * 3));
    controls.current?.target.set(0, 0, 0);
    controls.current?.update();
    if (camera.position.distanceTo(goal.current) < 0.01) goal.current = null;
  });

  const corona = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: dotTexture(),
        color: new THREE.Color(4, 3.4, 2.4),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    [],
  );
  useEffect(() => () => corona.dispose(), [corona]);

  return (
    <>
      <Starfield frame="ecliptic" brightness={0.8} />
      <ambientLight intensity={0.06} />
      <pointLight position={[0, 0, 0]} intensity={2.6} decay={0} color="#fff3e0" />
      <primitive object={grid} />
      {/* the Sun and its corona glow */}
      <mesh>
        <sphereGeometry args={[0.055, 24, 16]} />
        <meshBasicMaterial color={[6, 5.4, 4.2]} toneMapped={false} fog={false} />
      </mesh>
      <sprite material={corona} scale={[0.75, 0.75, 1]} />
      <Html position={[0, 0, 0]} className="w3-tag" zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        Sun
      </Html>
      {data.planets
        .filter((b) => b.points.length)
        .map((b) => (
          <PlanetBody key={b.name} body={b} jdRef={jdRef} pal={pal} />
        ))}
      <primitive object={path} />
      <primitive object={markMesh} />
      <Comet data={data} jdRef={jdRef} R={R} accent={pal.accent} />
      <OrbitControls ref={controls} makeDefault enableDamping minDistance={0.5} maxDistance={60} onStart={() => (goal.current = null)} />
    </>
  );
}
// ---------------------------------------------------------------------------
// still fallback: the same data drawn top down in SVG
// ---------------------------------------------------------------------------

function HelioSvg({ data, jd, marks }: { data: OrbitData; jd: number; marks: number[] }) {
  const pal = usePalette();
  let R = 1.8;
  for (const p of data.object.points) R = Math.max(R, Math.min(Math.hypot(p[1], p[2]), 6));
  R *= 1.08;
  const X = (x: number) => x;
  const Y = (y: number) => -y;
  const path = (pts: Vec[]) => pts.map((p) => `${X(p[1]).toFixed(3)},${Y(p[2]).toFixed(3)}`).join(' ');
  const o = at(data.object.points, jd);
  return (
    <figure className="w3-still">
      <svg
        viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`}
        role="img"
        aria-label={`Top down map of the path of ${data.object.name} around the Sun`}
      >
        <circle cx={0} cy={0} r={R * 0.02} fill="#f3ead2" />
        {data.planets.map((b) => {
          const p = planetAt(b, jd);
          return (
            <g key={b.name}>
              <polyline points={path(b.points)} fill="none" stroke={pal.muted} strokeOpacity={0.5} strokeWidth={R * 0.003} />
              {p ? <circle cx={X(p[0])} cy={Y(p[1])} r={R * 0.012} fill={pal.text} /> : null}
            </g>
          );
        })}
        <polyline points={path(data.object.points)} fill="none" stroke={pal.accent} strokeWidth={R * 0.005} />
        {marks.map((m, i) => {
          const p = at(data.object.points, m);
          return p ? <circle key={i} cx={X(p[0])} cy={Y(p[1])} r={R * 0.008} fill={pal.det[2]} /> : null;
        })}
        {o ? <circle cx={X(o[0])} cy={Y(o[1])} r={R * 0.016} fill={pal.accent} /> : null}
      </svg>
      <figcaption>
        {data.object.name} seen from above the plane of the planets on {dateStr(jd)}. Data: JPL Horizons.
      </figcaption>
    </figure>
  );
}

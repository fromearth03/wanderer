// Heliocentric 3D view of a solar system object's path (JPL Horizons vectors via
// the gateway) with Mercury to Jupiter, the Sun, a time slider that plays by
// default, and the times SPHEREx took frames marked on the path. Click a body
// to fly to it. Default export for React.lazy().
import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { Starfield } from './Starfield';
import * as THREE from 'three';
import { ThreeGuard, fmt, useInView, FORCE_HQ } from './support';
import { usePalette } from './theme';
import { PerfProbe, useRenderCount } from './perf';
import { AU_KM, PLANETS, at, bodyEcl, dateStr, planetAt, sc, toJD, type BodyKey, type OrbitData, type Vec } from './helio-core';
import { Comet, EclipticGrid, HoverRings, Marks, Planet, Sun, type PickApi } from './helio-bodies';
import { CameraRig, type HelioCtl, type HelioView } from './helio-camera';
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
  /** 'always' (default): the mouse wheel zooms. 'modifier': the wheel scrolls the page; Ctrl or Cmd + wheel, or pinch, zooms. */
  wheelZoom?: 'always' | 'modifier';
};

type Speeds = { v: number[]; min: number; max: number; span: number };

/** Text drawn over the 3D scene, which is always dark space whatever the page theme. */
const SCENE_TEXT = '#e4e6ea';
const SCENE_MUTED = '#a9afb8';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Facts for the info card of one body on one date. */
function bodyFacts(data: OrbitData, k: BodyKey, jd: number) {
  const p = bodyEcl(data, k, jd);
  if (!p) return null;
  const e = data.planets.find((b) => b.id === '399');
  const ep = e ? planetAt(e, jd) : null;
  let ta = jd - 0.5;
  let tb = jd + 0.5;
  if (k === 'comet') {
    const pts = data.object.points;
    ta = Math.max(pts[0][0], ta);
    tb = Math.min(pts[pts.length - 1][0], tb);
  }
  const p1 = bodyEcl(data, k, ta);
  const p2 = bodyEcl(data, k, tb);
  const rSun = Math.hypot(p[0], p[1], p[2]);
  const rEarth = ep && k !== '399' ? Math.hypot(p[0] - ep[0], p[1] - ep[1], p[2] - ep[2]) : NaN;
  const v =
    k !== 'sun' && p1 && p2 && tb > ta ? (Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) * AU_KM) / ((tb - ta) * 86400) : NaN;
  const planet = data.planets.find((b) => b.id === k);
  return { rSun, rEarth, v, period: planet?.period_days };
}

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
  wheelZoom = 'always',
}: HelioTrackProps) {
  useRenderCount('helio');
  const root = useRef<HTMLDivElement>(null);
  const onScreen = useInView(root);
  const [data, setData] = useState<OrbitData | null>(null);
  const [err, setErr] = useState<string>('');
  const [reload, setReload] = useState(0);
  const [jd, setJdState] = useState<number | null>(null);
  const jdRef = useRef(0);
  const setJd = (v: number) => {
    jdRef.current = v;
    setJdState(v);
  };
  const [playing, setPlaying] = useState(true);
  const [view, setView] = useState<HelioView>('tilt');
  const [focus, setFocusState] = useState<BodyKey | null>(null);
  const [hint, setHint] = useState(false);
  const ctl = useRef<HelioCtl>({ focus: null, view: 'tilt', nonce: 0, zoom: 0, lastInput: -1e9 });

  const follow = useCallback((k: BodyKey) => {
    ctl.current.focus = k;
    setFocusState(k);
  }, []);
  const fly = useCallback((k: BodyKey | null, v?: HelioView) => {
    const c = ctl.current;
    c.focus = k;
    if (v) c.view = v;
    c.nonce++;
    c.lastInput = performance.now();
    setFocusState(k);
    if (v) setView(v);
  }, []);

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
          first = m !== undefined ? Math.max(t0, m - 20) : pts[qi][0] - 60;
        }
        setJd(Math.max(t0, first));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(markTimes)],
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

  // play: about 9 days per second (a year in about 40 s), looping; paused while off screen or the tab is hidden
  useEffect(() => {
    if (!playing || !range || !onScreen) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const rate = Math.max(3, (range.t1 - range.t0) / 40);
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      let nv = jdRef.current + rate * dt;
      if (nv >= range.t1) nv = range.t0;
      jdRef.current = nv; // the scene reads this every frame
      if (now - lastUi > 200) {
        lastUi = now; // slider and readout: 5 updates a second
        setJdState(nv);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, range, onScreen]);

  // 'modifier' wheel mode: a plain wheel scrolls the page, Ctrl/Cmd + wheel (and trackpad pinch) zooms
  useEffect(() => {
    const el = root.current;
    if (!el || wheelZoom !== 'modifier') return;
    let t = 0;
    const on = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (!(e.target instanceof HTMLCanvasElement)) return;
      e.stopPropagation(); // keep it from the camera controls; the page scrolls as usual
      setHint(true);
      window.clearTimeout(t);
      t = window.setTimeout(() => setHint(false), 1300);
    };
    el.addEventListener('wheel', on, { capture: true, passive: true });
    return () => {
      el.removeEventListener('wheel', on, { capture: true });
      window.clearTimeout(t);
    };
  }, [wheelZoom, data]);

  const shown = focus ?? 'comet';
  const facts = useMemo(() => (data && jd !== null ? bodyFacts(data, shown, jd) : null), [data, jd, shown]);
  const peri = useMemo(() => {
    if (!data) return null;
    let qi = 0;
    const pts = data.object.points;
    pts.forEach((q, i) => {
      if (Math.hypot(q[1], q[2], q[3]) < Math.hypot(pts[qi][1], pts[qi][2], pts[qi][3])) qi = i;
    });
    return { jd: pts[qi][0], r: Math.hypot(pts[qi][1], pts[qi][2], pts[qi][3]) };
  }, [data]);
  const objName = data?.object.name || name;
  const bodyName = (k: BodyKey) => (k === 'sun' ? 'Sun' : k === 'comet' ? objName : (data?.planets.find((b) => b.id === k)?.name ?? k));

  const still = data && jd !== null ? <HelioSvg data={data} jd={jd} marks={marks} /> : <div className="w3-loading">Loading orbit</div>;
  const btn = { minWidth: 28 } as const;

  return (
    <div ref={root} className={'w3-root w3-helio ' + (className ?? '')} style={{ height }}>
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
          <HelioCanvas data={data} jdRef={jdRef} marks={marks} speeds={speeds} ctl={ctl} onPick={fly} onFollow={follow} />
        </ThreeGuard>
      )}

      {data && range && jd !== null ? (
        <>
          <div className="w3-toolbar">
            <button
              type="button"
              className="w3-btn"
              aria-pressed={focus === null}
              onClick={() => fly(null, view)}
              data-explain="Fly back out to see the whole inner solar system, with the Sun in the middle."
            >
              Whole system
            </button>
            {(
              [
                ['tilt', 'Angled', 'Look at the orbits from above at an angle.'],
                ['top', 'From above', 'Look straight down on the plane of the planets, like a map of the solar system.'],
                ['side', 'Edge on', 'Look along the plane of the planets to see how steeply the path is tilted.'],
              ] as const
            ).map(([v, label, explain]) => (
              <button
                key={v}
                type="button"
                className="w3-btn"
                aria-pressed={focus === null && view === v}
                onClick={() => fly(null, v)}
                data-explain={explain}
              >
                {label}
              </button>
            ))}
            <span className="w3-sep" />
            <button
              type="button"
              className="w3-btn"
              style={btn}
              aria-label="Zoom in"
              onClick={() => {
                ctl.current.zoom += 1;
              }}
              data-explain="Zoom in towards the middle of the view."
            >
              +
            </button>
            <button
              type="button"
              className="w3-btn"
              style={btn}
              aria-label="Zoom out"
              onClick={() => {
                ctl.current.zoom -= 1;
              }}
              data-explain="Zoom out to see more of the solar system."
            >
              -
            </button>
            <select
              className="w3-btn"
              value={focus ?? ''}
              onChange={(e) => fly(e.target.value || null)}
              aria-label="Fly to"
              data-explain="Pick a body to fly the camera to it and follow it. You can also click a planet, the Sun or the comet in the view."
            >
              <option value="">Fly to...</option>
              <option value="sun">Sun</option>
              {data.planets
                .filter((b) => b.points.length && b.id)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              <option value="comet">{objName}</option>
            </select>
          </div>

          <div className="w3-readout">
            <div className="w3-readout-head">
              <span>{bodyName(shown)}</span>
              {focus ? (
                <button
                  type="button"
                  className="w3-btn"
                  style={{ padding: '0 6px', fontSize: 11 }}
                  onClick={() => fly(null, view)}
                  data-explain="Stop following this body and fly back out to the whole system."
                >
                  Back
                </button>
              ) : null}
            </div>
            <dl>
              <dt>Date</dt>
              <dd>{dateStr(jd)}</dd>
              <dt>From Sun</dt>
              <dd>{shown === 'sun' ? '-' : facts ? `${fmt(facts.rSun, 2)} au` : '-'}</dd>
              <dt>From Earth</dt>
              <dd>{facts && Number.isFinite(facts.rEarth) ? `${fmt(facts.rEarth, 2)} au` : '-'}</dd>
              {shown !== 'sun' ? (
                <>
                  <dt>Speed</dt>
                  <dd>{facts ? `${fmt(facts.v, 1)} km/s` : '-'}</dd>
                </>
              ) : null}
              {facts?.period ? (
                <>
                  <dt>Year</dt>
                  <dd>{facts.period > 1000 ? `${fmt(facts.period / 365.25, 2)} Earth yr` : `${fmt(facts.period, 0)} days`}</dd>
                </>
              ) : null}
              {shown !== 'comet' && PLANETS[shown] ? (
                <>
                  <dt>Radius</dt>
                  <dd>{`${Math.round(PLANETS[shown].radiusKm).toLocaleString('en-GB')} km`}</dd>
                </>
              ) : null}
              {shown === 'sun' ? (
                <>
                  <dt>Radius</dt>
                  <dd>695,700 km</dd>
                </>
              ) : null}
            </dl>
            <div className="w3-readout-foot">
              {shown === 'comet' ? (
                <>
                  Closest to the Sun in this range: {peri ? `${fmt(peri.r, 2)} au on ${dateStr(peri.jd)}` : '-'}.
                  {marks.length ? ` Marked: ${marks.length} ${markLabel}.` : ''} Interstellar: it passes through once and leaves.
                </>
              ) : shown === 'sun' ? (
                <>The planets and the comet move under the Sun's gravity. Positions: JPL Horizons, Sun centred.</>
              ) : (
                <>Orbits the Sun once per {bodyName(shown)} year. Positions: JPL Horizons, Sun centred.</>
              )}
              {focus ? null : ' Click any body to fly to it.'}
            </div>
          </div>

          {hint ? (
            <div
              role="status"
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                padding: '8px 14px',
                borderRadius: 4,
                background: 'rgba(5, 7, 12, 0.78)',
                color: '#f1f1ee',
                fontSize: 13,
                zIndex: 40,
                pointerEvents: 'none',
              }}
            >
              {IS_MAC ? 'Hold ⌘ and scroll to zoom' : 'Hold Ctrl and scroll to zoom'}
            </div>
          ) : null}

          <div className="w3-timebar">
            <button
              type="button"
              className="w3-btn"
              aria-pressed={playing}
              onClick={() => {
                if (!playing && jd >= range.t1) setJd(range.t0);
                setPlaying((p) => !p);
              }}
              data-explain="Pause or play the motion of the planets and the comet through the dates of the path. It starts again from the first date at the end."
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
            <span className="w3-num" style={{ color: SCENE_TEXT }}>{dateStr(jd)}</span>
          </div>
          <div className="w3-legend" style={{ color: SCENE_MUTED }}>
            <span className="w3-num">{fmt(speeds.min, 0)}</span>
            <span className="w3-ramp" style={{ background: `linear-gradient(90deg, #4f6f93, #c9b48a, ${'var(--w3-accent)'})` }} />
            <span className="w3-num">{fmt(speeds.max, 0)} km/s</span> path coloured by speed
            <span className="w3-key w3-key-mark" /> {markLabel}
            <span>
              Sizes not to scale: planets about 350 to 2,000 times larger (more when far away), the Sun about 20 times; distances true. Tails schematic.
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3D (all motion is driven from jdRef inside useFrame: no React renders while playing)
// ---------------------------------------------------------------------------

type SceneProps = {
  data: OrbitData;
  jdRef: MutableRefObject<number>;
  marks: number[];
  speeds: Speeds;
  ctl: MutableRefObject<HelioCtl>;
  onPick: (k: BodyKey | null) => void;
  onFollow: (k: BodyKey) => void;
};

const HelioCanvas = memo(function HelioCanvas(props: SceneProps) {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box);
  const [low, setLow] = useState(false);
  return (
    <div ref={box} className="w3-stage">
      <Canvas
        frameloop={inView ? 'always' : 'never'}
        dpr={low ? 1 : [1, 1.5]}
        camera={{ position: [0, 6, 8], fov: 35, near: 0.002, far: 500 }}
        gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      >
        <PerformanceMonitor onDecline={() => setLow(!FORCE_HQ)} onIncline={() => setLow(false)} flipflops={3} />
        <color attach="background" args={[SPACE]} />
        <Suspense fallback={null}>
          <PerfProbe name="helio" />
          <HelioScene {...props} />
        </Suspense>
        {low ? null : (
          <EffectComposer multisampling={4} enableNormalPass={false}>
            <Bloom mipmapBlur luminanceThreshold={1.25} luminanceSmoothing={0.25} intensity={0.85} radius={0.7} />
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          </EffectComposer>
        )}
      </Canvas>
    </div>
  );
});

const SPACE = '#020308';

/** Colour ramp for speed: steel blue (slow), sand, accent (fast). */
function speedColor(f: number, accent: THREE.Color, out = new THREE.Color()) {
  const a = new THREE.Color('#4f6f93');
  const b = new THREE.Color('#c9b48a');
  return f < 0.5 ? out.copy(a).lerp(b, f * 2) : out.copy(b).lerp(accent, (f - 0.5) * 2);
}

function HelioScene({ data, jdRef, marks, speeds, ctl, onPick, onFollow }: SceneProps) {
  useRenderCount('helio/scene');
  const pal = usePalette();
  const { scene } = useThree();
  const accent = useMemo(() => new THREE.Color(pal.accent), [pal.accent]);
  const objPts = useMemo(() => data.object.points.map((p) => sc([p[1], p[2], p[3]], new THREE.Vector3())), [data]);

  const hover = useRef<BodyKey | null>(null);
  const focusRef = useRef<BodyKey | null>(null);
  const pick = useMemo<PickApi>(() => ({ hover, focus: focusRef, onPick: (k) => onPick(k) }), [onPick]);
  useFrame(() => {
    focusRef.current = ctl.current.focus;
  });

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
      ca.setXYZW(k, c.r, c.g, c.b, k < i ? 0.95 : 0.3);
    }
    ca.needsUpdate = true;
  });

  // fit: largest of the object path (capped) and Mars' orbit
  const R = useMemo(() => {
    let r = 1.7;
    for (const p of objPts) r = Math.max(r, Math.min(p.length(), 6));
    return r;
  }, [objPts]);

  // depth cue: far objects fade a little into the background
  useEffect(() => {
    scene.fog = new THREE.FogExp2(SPACE, 0.12 / R);
    return () => {
      scene.fog = null;
    };
  }, [scene, R]);

  return (
    <>
      <Starfield frame="ecliptic" brightness={0.85} />
      <ambientLight intensity={0.045} />
      <pointLight position={[0, 0, 0]} intensity={3.2} decay={0} color="#fff4e6" />
      <EclipticGrid R={R} dark={pal.dark} />
      <Sun pick={pick} />
      {data.planets
        .filter((b) => b.points.length)
        .map((b) => (
          <Planet key={b.name} body={b} jdRef={jdRef} pick={pick} />
        ))}
      <primitive object={path} />
      <Marks data={data} marks={marks} jdRef={jdRef} color={pal.det[2]} />
      <Comet data={data} jdRef={jdRef} pick={pick} label={data.object.name || data.name} />
      <HoverRings data={data} jdRef={jdRef} pick={pick} />
      <CameraRig data={data} jdRef={jdRef} ctl={ctl} R={R} hover={hover} onFollow={onFollow} />
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

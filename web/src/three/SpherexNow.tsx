// "SPHEREx right now": the real position of the observatory, propagated in the
// browser (SGP4 via satellite.js) from CelesTrak elements served by the gateway.
// Earth uses NASA Blue Marble (day) and Black Marble (night), the terminator and
// ocean glint come from the real Sun direction, the stars are real (Hipparcos).
// Default export so pages can React.lazy() it.
import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerformanceMonitor, useTexture } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js';
import { SpherexSpacecraft } from './SpherexSpacecraft';
import { Starfield } from './Starfield';
import { StudioEnvironment, ThreeGuard, fmt, useInView, FORCE_HQ } from './support';
import { usePalette } from './theme';
import { PerfProbe, useRenderCount } from './perf';
import './three.css';

export type SpherexNowProps = {
  /** CSS height (default 520px). */
  height?: number | string;
  /** Show the latitude / longitude / altitude / speed readout (default true). */
  showReadout?: boolean;
  /** Show time and camera buttons (default true). */
  showControls?: boolean;
  /** Let the visitor drag and zoom the camera (default true). Use false for a background or hero panel so page scroll is not captured. */
  interactive?: boolean;
  /** Gateway endpoint for the elements (default /api/spherex/tle). */
  endpoint?: string;
  className?: string;
};

type TleResp = { name: string; epoch: string; source: string; fetched: string; stale: boolean; omm: OMMJsonObject };

// Built-in copy (CelesTrak, 2026-11-14) so the view still works if the gateway is down.
const BUILTIN_OMM = {
  OBJECT_NAME: 'SPHEREX (MIDEX 9)',
  OBJECT_ID: '2025-047E',
  EPOCH: '2026-11-14T01:18:11.500128',
  MEAN_MOTION: 14.74308339,
  ECCENTRICITY: 0.0011582,
  INCLINATION: 97.9569,
  RA_OF_ASC_NODE: 140.1785,
  ARG_OF_PERICENTER: 73.9821,
  MEAN_ANOMALY: 286.2663,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 63182,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 9012,
  BSTAR: 0.00015185,
  MEAN_MOTION_DOT: 9.56e-6,
  MEAN_MOTION_DDOT: 0,
} as unknown as OMMJsonObject;

const UP_OFFSET = new THREE.Vector3(0, 1.4, 0);
const RE = 6378.137; // km, scene unit
const MODEL_SCALE = 0.028; // scene units per metre
/** How much larger than life the spacecraft is drawn (scene unit = one Earth radius). */
const ENLARGEMENT = Math.round((MODEL_SCALE * RE * 1000) / 10000) * 10000;

type Clock = { real0: number; sim0: number; rate: number };
const simNow = (c: Clock) => c.sim0 + (Date.now() - c.real0) * c.rate;

/** ECI (TEME, km) to scene coordinates: Earth's north pole along +Y. */
const toScene = (x: number, y: number, z: number, out = new THREE.Vector3()) => out.set(x / RE, z / RE, -y / RE);

/** Unit vector to the Sun in ECI of date (low precision, about 0.01 degree). */
function sunEci(ms: number): [number, number, number] {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = (280.46 + 0.9856474 * n) * rad;
  const g = (357.528 + 0.9856003 * n) * rad;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 4e-7 * n) * rad;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}

type State = { ok: boolean; lat: number; lon: number; alt: number; speed: number; ms: number; pos: [number, number, number] };

function sample(sat: SatRec, ms: number): State {
  const d = new Date(ms);
  const pv = propagate(sat, d);
  const p = pv && typeof pv.position === 'object' ? pv.position : null;
  const v = pv && typeof pv.velocity === 'object' ? pv.velocity : null;
  if (!p || !v) return { ok: false, lat: NaN, lon: NaN, alt: NaN, speed: NaN, ms, pos: [0, 0, 0] };
  const geo = eciToGeodetic(p, gstime(d));
  return {
    ok: true,
    lat: (geo.latitude * 180) / Math.PI,
    lon: ((((geo.longitude * 180) / Math.PI + 540) % 360) - 180),
    alt: geo.height,
    speed: Math.hypot(v.x, v.y, v.z),
    ms,
    pos: [p.x, p.y, p.z],
  };
}

const RATES = [
  { rate: 1, label: 'Live', explain: 'Show where SPHEREx is at this very moment, moving in real time.' },
  { rate: 60, label: '60x', explain: 'Speed time up 60 times: one minute passes every second.' },
  { rate: 600, label: '600x', explain: 'Speed time up 600 times: one full orbit around Earth (about 98 minutes) takes about 10 seconds.' },
];

export default function SpherexNow({
  height = 520,
  showReadout = true,
  showControls = true,
  interactive = true,
  endpoint = '/api/spherex/tle',
  className,
}: SpherexNowProps) {
  useRenderCount('now');
  const [tle, setTle] = useState<TleResp | null>(null);
  const [tleNote, setTleNote] = useState<string>('');
  const clock = useRef<Clock>({ real0: Date.now(), sim0: Date.now(), rate: 1 });
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(false);
  // the readout is written straight into the DOM 4 times a second: no React renders while it runs
  const out = useRef<Record<'utc' | 'lat' | 'lon' | 'alt' | 'speed', HTMLElement | null>>({ utc: null, lat: null, lon: null, alt: null, speed: null });
  // the 2D fallback map only needs a fresh position every few seconds
  const [slow, setSlow] = useState<State | null>(null);

  useEffect(() => {
    let dead = false;
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((j: TleResp) => {
        if (dead) return;
        if (!j?.omm) throw new Error('no elements');
        setTle(j);
        setTleNote(j.stale ? 'older stored elements (CelesTrak not reachable)' : '');
      })
      .catch(() => {
        if (dead) return;
        setTle({
          name: 'SPHEREX (MIDEX 9)',
          epoch: String((BUILTIN_OMM as { EPOCH: string }).EPOCH),
          source: 'built-in copy',
          fetched: '',
          stale: true,
          omm: BUILTIN_OMM,
        });
        setTleNote('built-in elements from 14 Nov 2026 (gateway not reachable)');
      });
    return () => {
      dead = true;
    };
  }, [endpoint]);

  const sat = useMemo(() => {
    if (!tle) return null;
    try {
      return json2satrec(tle.omm);
    } catch {
      return null;
    }
  }, [tle]);

  useEffect(() => {
    if (!sat) return;
    let n = 0;
    const tick = () => {
      const s = sample(sat, simNow(clock.current));
      const o = out.current;
      if (o.utc) o.utc.textContent = new Date(s.ms).toISOString().slice(0, 19).replace('T', ' ');
      if (o.lat) o.lat.textContent = s.ok ? `${fmt(Math.abs(s.lat), 2)} ${s.lat >= 0 ? 'N' : 'S'}` : '-';
      if (o.lon) o.lon.textContent = s.ok ? `${fmt(Math.abs(s.lon), 2)} ${s.lon >= 0 ? 'E' : 'W'}` : '-';
      if (o.alt) o.alt.textContent = s.ok ? `${fmt(s.alt, 1)} km` : '-';
      if (o.speed) o.speed.textContent = s.ok ? `${fmt(s.speed, 2)} km/s` : '-';
      if (n++ % 20 === 0) setSlow(s);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [sat]);

  const setClockRate = (r: number) => {
    const c = clock.current;
    const now = Date.now();
    clock.current = r === 1 ? { real0: now, sim0: now, rate: 1 } : { real0: now, sim0: simNow(c), rate: r };
    setRate(r);
  };

  const live = rate === 1;
  const still = <GroundTrackStill sat={sat} st={slow} />;
  const bind = (k: keyof typeof out.current) => (el: HTMLElement | null) => {
    out.current[k] = el;
  };

  return (
    <div className={'w3-root w3-now ' + (className ?? '')} style={{ height }}>
      <ThreeGuard still={still} label="view of SPHEREx around Earth">
        {sat ? (
          <NowCanvas sat={sat} clock={clock} follow={follow && interactive} interactive={interactive} />
        ) : (
          <div className="w3-loading">Loading orbit elements</div>
        )}
      </ThreeGuard>

      {showControls ? (
        <div className="w3-toolbar">
          {RATES.map((r) => (
            <button
              key={r.rate}
              type="button"
              className="w3-btn"
              aria-pressed={rate === r.rate}
              onClick={() => setClockRate(r.rate)}
              data-explain={r.explain}
            >
              {r.label}
            </button>
          ))}
          {interactive ? <span className="w3-sep" /> : null}
          {interactive ? (
            <button
              type="button"
              className="w3-btn"
              aria-pressed={follow}
              onClick={() => setFollow((v) => !v)}
              data-explain="Switch between a view of the whole Earth with the orbit and a close camera that rides along with SPHEREx."
            >
              {follow ? 'Whole Earth' : 'Ride along'}
            </button>
          ) : null}
        </div>
      ) : null}

      {showReadout ? (
        <div className="w3-readout" aria-live="off">
          <div className="w3-readout-head">
            <span>SPHEREx {live ? 'right now' : 'simulated'}</span>
            <span className={'w3-dot' + (live ? ' is-live' : '')} />
          </div>
          <dl>
            <dt>UTC</dt>
            <dd ref={bind('utc')}>-</dd>
            <dt>Latitude</dt>
            <dd ref={bind('lat')}>-</dd>
            <dt>Longitude</dt>
            <dd ref={bind('lon')}>-</dd>
            <dt>Altitude</dt>
            <dd ref={bind('alt')}>-</dd>
            <dt>Speed</dt>
            <dd ref={bind('speed')}>-</dd>
          </dl>
          <div className="w3-readout-foot">
            Polar orbit, NORAD 63182. Elements:{' '}
            {tle ? `${tle.source}, epoch ${tle.epoch.slice(0, 16).replace('T', ' ')} UTC` : 'loading'}
            {tleNote ? `, ${tleNote}` : ''}. Spacecraft drawn about {ENLARGEMENT.toLocaleString('en-US')} times true size so it can be
            seen; Earth, orbit and Sun direction are to scale.
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3D scene
// ---------------------------------------------------------------------------

function NowCanvas({ sat, clock, follow, interactive }: { sat: SatRec; clock: MutableRefObject<Clock>; follow: boolean; interactive: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box);
  const [low, setLow] = useState(false);
  return (
    <div ref={box} className="w3-stage" style={interactive ? undefined : { pointerEvents: 'none' }}>
      <Canvas
        frameloop={inView ? 'always' : 'never'}
        dpr={low ? 1 : [1, 1.5]}
        camera={{ position: [0, 1.2, 4], fov: 35, near: 0.005, far: 500 }}
        gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      >
        <PerformanceMonitor onDecline={() => setLow(!FORCE_HQ)} onIncline={() => setLow(false)} flipflops={3} />
        <color attach="background" args={['#020306']} />
        <Suspense fallback={null}>
          <PerfProbe name="now" />
          <NowScene sat={sat} clock={clock} follow={follow} interactive={interactive} />
        </Suspense>
        {low ? null : (
          <EffectComposer multisampling={2} enableNormalPass={false}>
            <Bloom mipmapBlur luminanceThreshold={12} luminanceSmoothing={0.3} intensity={0.45} radius={0.6} />
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          </EffectComposer>
        )}
      </Canvas>
    </div>
  );
}

const earthVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Linear-light shading: day side lit by the Sun, city lights only where it is
// night, a sun glint on water (ocean mask), and a thin blue limb haze.
const earthFrag = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D oceanMap;
uniform vec3 sunDir;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(sunDir);
  vec3 V = normalize(cameraPosition - vW);
  float d = dot(N, L);
  float dayK = smoothstep(-0.12, 0.18, d);
  vec3 day = texture2D(dayMap, vUv).rgb;
  vec3 night = texture2D(nightMap, vUv).rgb;
  float ocean = texture2D(oceanMap, vUv).r;
  vec3 col = day * (0.02 + 1.35 * max(d, 0.0));
  // ocean glint (Blinn-Phong), only on water and only in daylight
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0) * ocean * smoothstep(0.0, 0.2, d);
  col += vec3(1.0, 0.95, 0.85) * spec * 14.0;
  // limb haze on the day side
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.18, 0.35, 0.8) * fres * smoothstep(-0.15, 0.4, d) * 0.6;
  // city lights only on the night side, fading through twilight
  vec3 lights = pow(night, vec3(1.4)) * 1.6 * (1.0 - smoothstep(-0.18, 0.05, d));
  gl_FragColor = vec4(mix(lights, col, dayK), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Thin Fresnel shell: blue scattering seen at the day limb.
const atmoFrag = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(1.0 - abs(dot(N, V)), 4.0);
  float lit = smoothstep(-0.25, 0.35, dot(N, normalize(sunDir)));
  vec3 c = vec3(0.25, 0.5, 1.0) * rim * lit * 1.3;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Low-res textures first (fast suspense), the 2k ones swapped in when loaded. */
function useEarthTextures() {
  const [dayLo, nightLo, ocean] = useTexture(['/textures/earth-day-512.webp', '/textures/earth-night-512.webp', '/textures/earth-ocean-1k.webp']);
  const [hi, setHi] = useState<[THREE.Texture, THREE.Texture] | null>(null);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    let dead = false;
    const loader = new THREE.TextureLoader();
    Promise.all([loader.loadAsync('/textures/earth-day-2k.webp'), loader.loadAsync('/textures/earth-night-2k.webp')])
      .then(([d, n]) => {
        if (dead) {
          d.dispose();
          n.dispose();
          return;
        }
        for (const t of [d, n]) {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy());
        }
        setHi([d, n]);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [gl]);
  useEffect(() => {
    dayLo.colorSpace = THREE.SRGBColorSpace;
    nightLo.colorSpace = THREE.SRGBColorSpace;
    dayLo.needsUpdate = nightLo.needsUpdate = true;
  }, [dayLo, nightLo]);
  useEffect(() => () => hi?.forEach((t) => t.dispose()), [hi]);
  return { day: hi?.[0] ?? dayLo, night: hi?.[1] ?? nightLo, ocean };
}

const TRAIL_N = 200;

function NowScene({
  sat,
  clock,
  follow,
  interactive,
}: {
  sat: SatRec;
  clock: MutableRefObject<Clock>;
  follow: boolean;
  interactive: boolean;
}) {
  useRenderCount('now/scene');
  const pal = usePalette();
  const { day, night, ocean } = useEarthTextures();
  const earth = useRef<THREE.Mesh>(null);
  const craft = useRef<THREE.Group>(null);
  const sunLight = useRef<THREE.DirectionalLight>(null);
  const sunDisc = useRef<THREE.Mesh>(null);
  const controls = useRef<React.ElementRef<typeof OrbitControls>>(null);
  const { camera } = useThree();

  const uniforms = useMemo(
    () => ({
      dayMap: { value: day },
      nightMap: { value: night },
      oceanMap: { value: ocean },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
    }),
    // textures are swapped below without rebuilding the material
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    uniforms.dayMap.value = day;
    uniforms.nightMap.value = night;
    uniforms.oceanMap.value = ocean;
  }, [day, night, ocean, uniforms]);

  // orbit trail: one and a half orbits of points, brightest just behind the craft
  const trail = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 4), 4));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false });
    const line = new THREE.Line(g, m);
    line.frustumCulled = false;
    return { g, m, line, times: new Float64Array(TRAIL_N), t0: -Infinity };
  }, []);
  const nadirGeo = useMemo(() => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), []);
  const nadirLine = useMemo(() => new THREE.Line(nadirGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45 })), [nadirGeo]);
  const accent = useMemo(() => new THREE.Color(pal.accent), [pal.accent]);
  useEffect(() => {
    (nadirLine.material as THREE.LineBasicMaterial).color.set(pal.muted);
  }, [pal, nadirLine]);
  useEffect(
    () => () => {
      trail.g.dispose();
      trail.m.dispose();
      nadirGeo.dispose();
      (nadirLine.material as THREE.Material).dispose();
    },
    [trail, nadirGeo, nadirLine],
  );

  const periodMs = ((2 * Math.PI) / sat.no) * 60000; // sat.no is mean motion in rad/min
  const prevSat = useRef<THREE.Vector3 | null>(null);
  const placed = useRef(false);
  const userMoved = useRef(false);
  const tmp = useMemo(
    () => ({
      r: new THREE.Vector3(),
      s: new THREE.Vector3(),
      x: new THREE.Vector3(),
      z: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      p: new THREE.Vector3(),
      q: new THREE.Vector3(),
    }),
    [],
  );

  useFrame((_, dt) => {
    const ms = simNow(clock.current);
    const d = new Date(ms);
    const pv = propagate(sat, d);
    if (!pv || typeof pv.position !== 'object') return;
    const p = pv.position;
    const satPos = toScene(p.x, p.y, p.z, tmp.p);
    const [sx, sy, sz] = sunEci(ms);
    const sun = toScene(sx * RE, sy * RE, sz * RE, tmp.s).normalize();

    uniforms.sunDir.value.copy(sun);
    if (earth.current) earth.current.rotation.y = gstime(d);
    if (sunLight.current) sunLight.current.position.copy(sun).multiplyScalar(20);
    if (sunDisc.current) sunDisc.current.position.copy(camera.position).addScaledVector(sun, 300);

    // attitude: telescope (+Y) away from Earth, solar panel (-X) toward the Sun
    const r = tmp.r.copy(satPos).normalize();
    const sPerp = tmp.x.copy(sun).addScaledVector(r, -sun.dot(r));
    if (sPerp.lengthSq() < 1e-6) sPerp.set(1, 0, 0).addScaledVector(r, -r.x);
    sPerp.normalize();
    const xAxis = sPerp.multiplyScalar(-1);
    const zAxis = tmp.z.crossVectors(xAxis, r).normalize();
    tmp.m.makeBasis(xAxis, r, zAxis);
    if (craft.current) {
      craft.current.position.copy(satPos);
      craft.current.quaternion.setFromRotationMatrix(tmp.m);
    }

    const pos = nadirGeo.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, satPos.x, satPos.y, satPos.z);
    pos.setXYZ(1, r.x, r.y, r.z);
    pos.needsUpdate = true;

    // trail positions: recomputed only every quarter orbit; colours every frame
    if (ms - trail.t0 > periodMs * 0.25 || ms < trail.t0) {
      trail.t0 = ms;
      const pa = trail.g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < TRAIL_N; i++) {
        const t = ms - periodMs + (i / (TRAIL_N - 1)) * periodMs * 1.5;
        trail.times[i] = t;
        const q = propagate(sat, new Date(t));
        if (q && typeof q.position === 'object') {
          toScene(q.position.x, q.position.y, q.position.z, tmp.q);
          pa.setXYZ(i, tmp.q.x, tmp.q.y, tmp.q.z);
        }
      }
      pa.needsUpdate = true;
    }
    const ca = trail.g.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < TRAIL_N; i++) {
      const dtm = (trail.times[i] - ms) / periodMs; // < 0 behind the craft
      const a = dtm <= 0 ? 0.95 * Math.exp(dtm * 3.2) : 0.12 * Math.exp(-dtm * 2);
      ca.setXYZW(i, accent.r, accent.g, accent.b, a);
    }
    ca.needsUpdate = true;

    const ctl = controls.current;
    if (!placed.current && ctl) {
      placed.current = true;
      const dir = satPos.clone().normalize();
      camera.position.copy(dir.multiplyScalar(5.0).add(UP_OFFSET));
      ctl.target.set(0, 0, 0);
      ctl.update();
    }
    if (ctl) {
      if (follow) {
        if (prevSat.current) camera.position.add(tmp.z.copy(satPos).sub(prevSat.current));
        ctl.target.copy(satPos);
      } else {
        if (ctl.target.lengthSq() > 0) ctl.target.set(0, 0, 0);
        if (!userMoved.current) {
          // keep SPHEREx on the visible side of the Earth until the visitor takes the camera
          const want = tmp.z.copy(satPos).normalize().multiplyScalar(5.0).add(UP_OFFSET);
          camera.position.lerp(want, Math.min(1, dt * 0.6));
        }
      }
      prevSat.current = (prevSat.current ?? new THREE.Vector3()).copy(satPos);
    }
  });

  // move the camera when switching between whole Earth and ride along
  useEffect(() => {
    const ctl = controls.current;
    if (!ctl || !prevSat.current) return;
    const s = prevSat.current.clone();
    userMoved.current = false;
    if (follow) {
      const r = s.clone().normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(r).normalize();
      camera.position.copy(s).addScaledVector(r, 0.16).addScaledVector(side, 0.22);
      ctl.target.copy(s);
    } else {
      camera.position.copy(s.normalize().multiplyScalar(5.0).add(UP_OFFSET));
      ctl.target.set(0, 0, 0);
    }
    ctl.update();
  }, [follow, camera]);

  return (
    <>
      <Starfield frame="equatorial" brightness={1.5} />
      <StudioEnvironment intensity={0.12} />
      <ambientLight intensity={0.03} />
      <directionalLight ref={sunLight} intensity={3.2} color="#fff6ea" />
      {/* the Sun: about 0.53 degrees across, bright enough to bloom */}
      <mesh ref={sunDisc}>
        <sphereGeometry args={[1.4, 24, 16]} />
        <meshBasicMaterial color={[90, 82, 70]} toneMapped={false} fog={false} />
      </mesh>
      <mesh ref={earth}>
        <sphereGeometry args={[1, 96, 64]} />
        <shaderMaterial vertexShader={earthVert} fragmentShader={earthFrag} uniforms={uniforms} />
      </mesh>
      <mesh scale={1.018}>
        <sphereGeometry args={[1, 64, 48]} />
        <shaderMaterial
          vertexShader={earthVert}
          fragmentShader={atmoFrag}
          uniforms={uniforms}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <primitive object={trail.line} />
      <primitive object={nadirLine} />
      <group ref={craft}>
        <group scale={MODEL_SCALE} position={[0, -1.3 * MODEL_SCALE, 0]}>
          <SpherexSpacecraft accent={pal.accent} detColors={pal.det} lite />
        </group>
      </group>
      <OrbitControls
        ref={controls}
        makeDefault
        enabled={interactive}
        enablePan={false}
        enableDamping
        minDistance={0.12}
        maxDistance={12}
        onStart={() => (userMoved.current = true)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// still fallback: Blue Marble map with the live ground track (no WebGL needed)
// ---------------------------------------------------------------------------

function GroundTrackStill({ sat, st }: { sat: SatRec | null; st: State | null }) {
  const pal = usePalette();
  const track = useMemo(() => {
    if (!sat || !st) return [] as string[];
    const period = ((2 * Math.PI) / sat.no) * 60000;
    const segs: string[] = [];
    let cur: string[] = [];
    let lastLon: number | null = null;
    for (let i = 0; i <= 200; i++) {
      const s = sample(sat, st.ms + (i / 200 - 0.5) * period);
      if (!s.ok) continue;
      if (lastLon !== null && Math.abs(s.lon - lastLon) > 180) {
        segs.push(cur.join(' '));
        cur = [];
      }
      cur.push(`${(s.lon + 180).toFixed(2)},${(90 - s.lat).toFixed(2)}`);
      lastLon = s.lon;
    }
    if (cur.length) segs.push(cur.join(' '));
    return segs;
  }, [sat, st]);
  return (
    <figure className="w3-still w3-map">
      <svg viewBox="0 0 360 180" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map of Earth with the current ground track of SPHEREx">
        <image href="/textures/earth-day-2k.webp" x="0" y="0" width="360" height="180" preserveAspectRatio="none" />
        {track.map((pts, i) => (
          <polyline key={i} points={pts} fill="none" stroke={pal.accent} strokeWidth={0.6} />
        ))}
        {st?.ok ? <circle cx={st.lon + 180} cy={90 - st.lat} r={2.2} fill={pal.accent} stroke="#000" strokeWidth={0.4} /> : null}
      </svg>
      <figcaption>Ground track of SPHEREx for one orbit. Earth: NASA Blue Marble.</figcaption>
    </figure>
  );
}

// "SPHEREx right now": the real position of the observatory, propagated in the
// browser (SGP4 via satellite.js) from CelesTrak elements served by the gateway.
// Earth: NASA Blue Marble (day, 4k), Black Marble (night lights), GEBCO relief and
// ocean mask; terminator, glint and atmosphere follow the real Sun direction.
// The stars are real (Hipparcos). Click the spacecraft to fly to it.
// Default export so pages can React.lazy() it.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, PerformanceMonitor, useTexture } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js';
import { SpherexSpacecraft } from './SpherexSpacecraft';
import { Starfield } from './Starfield';
import { FORCE_HQ, StudioEnvironment, ThreeGuard, fmt, useInView } from './support';
import { usePalette } from './theme';
import { PerfProbe, PERF, useRenderCount } from './perf';
import './three.css';

export type SpherexNowProps = {
  /** CSS height (default 520px). */
  height?: number | string;
  /** Show the latitude / longitude / altitude / speed readout (default true). */
  showReadout?: boolean;
  /** Show the time and camera toolbar (default true). Without it a small corner control is shown instead. */
  showControls?: boolean;
  /** Let the visitor drag, zoom and click the spacecraft (default true). False: a passive background. */
  interactive?: boolean;
  /** Gateway endpoint for the elements (default /api/spherex/tle). */
  endpoint?: string;
  /** Shift the Earth sideways in the frame, -0.5..0.5 of the width (positive moves it right). Default 0. */
  frameX?: number;
  /** Starting time speed: 1 is live. Default: 1 with the toolbar, 60 without it. */
  initialRate?: number;
  /** 'always' (default): the mouse wheel zooms. 'modifier': only Ctrl/Cmd + wheel or pinch zooms, so the page can scroll. */
  wheelZoom?: 'always' | 'modifier';
  /** Called when the camera flies to the spacecraft (true) or back to the Earth (false). */
  onFocusChange?: (focused: boolean) => void;
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

const RE = 6378.137; // km, scene unit
const MODEL_SCALE = 0.05; // scene units per metre: the 2.6 m craft is drawn about 0.13 Earth radii tall
/** How much larger than life the spacecraft is drawn (scene unit = one Earth radius). */
const ENLARGEMENT = Math.round((MODEL_SCALE * RE * 1000) / 10000) * 10000;
const ATMO = 1.025; // atmosphere shell radius
const EARTH_MIN = 1.7; // closest camera distance to the Earth's centre in the Earth view
const EARTH_MAX = 14;
const CRAFT_MIN = 0.22; // camera distance to the craft when focused
const CRAFT_MAX = 1.4;
const CAM_FLOOR = 1.08; // the camera never goes below this radius (outside Earth and atmosphere)
const FLY_MS = 1200;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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
    lon: (((geo.longitude * 180) / Math.PI + 540) % 360) - 180,
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

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type Live = 'utc' | 'lat' | 'lon' | 'alt' | 'speed' | 'plat' | 'plon' | 'palt' | 'pspeed';

/** Shared between the page controls and the 3D scene without React renders. */
type SceneApi = { zoom: (factor: number) => void };

export default function SpherexNow({
  height = 520,
  showReadout = true,
  showControls = true,
  interactive = true,
  endpoint = '/api/spherex/tle',
  frameX = 0,
  initialRate,
  wheelZoom = 'always',
  onFocusChange,
  className,
}: SpherexNowProps) {
  useRenderCount('now');
  const [tle, setTle] = useState<TleResp | null>(null);
  const [tleNote, setTleNote] = useState<string>('');
  const startRate = initialRate ?? (showControls ? 1 : 60);
  const clock = useRef<Clock>({ real0: Date.now(), sim0: Date.now(), rate: startRate });
  const [rate, setRate] = useState(startRate);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    onFocusChange?.(focus);
  }, [focus, onFocusChange]);
  // Esc flies back out to the whole Earth
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);
  const out = useRef<Partial<Record<Live, HTMLElement | null>>>({});
  const [slow, setSlow] = useState<State | null>(null);
  const api = useRef<SceneApi | null>(null);
  const hint = useRef<HTMLDivElement>(null);

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

  // live numbers are written straight into the DOM 4 times a second: no React renders
  useEffect(() => {
    if (!sat) return;
    let n = 0;
    const tick = () => {
      const s = sample(sat, simNow(clock.current));
      const o = out.current;
      const put = (k: Live, v: string) => {
        const el = o[k];
        if (el) el.textContent = v;
      };
      const lat = s.ok ? `${fmt(Math.abs(s.lat), 2)} ${s.lat >= 0 ? 'N' : 'S'}` : '-';
      const lon = s.ok ? `${fmt(Math.abs(s.lon), 2)} ${s.lon >= 0 ? 'E' : 'W'}` : '-';
      const alt = s.ok ? `${fmt(s.alt, 1)} km` : '-';
      const spd = s.ok ? `${fmt(s.speed, 2)} km/s` : '-';
      put('utc', new Date(s.ms).toISOString().slice(0, 19).replace('T', ' '));
      put('lat', lat);
      put('lon', lon);
      put('alt', alt);
      put('speed', spd);
      put('plat', lat);
      put('plon', lon);
      put('palt', alt);
      put('pspeed', spd);
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

  const showHint = useCallback(() => {
    const el = hint.current;
    if (!el) return;
    el.classList.add('is-on');
    window.clearTimeout(Number(el.dataset.t || 0));
    el.dataset.t = String(window.setTimeout(() => el.classList.remove('is-on'), 1500));
  }, []);

  const live = rate === 1;
  const still = <GroundTrackStill sat={sat} st={slow} />;
  const bind = (k: Live) => (el: HTMLElement | null) => {
    out.current[k] = el;
  };
  const periodMin = sat ? (2 * Math.PI) / sat.no : NaN;
  const inclDeg = sat ? (sat.inclo * 180) / Math.PI : NaN;
  const modifier = wheelZoom === 'modifier';

  return (
    <div className={'w3-root w3-now ' + (modifier ? 'w3-wheel-mod ' : '') + (className ?? '')} style={{ height }}>
      <ThreeGuard still={still} label="view of SPHEREx around Earth">
        {sat ? (
          <NowCanvas
            sat={sat}
            clock={clock}
            focus={focus && interactive}
            interactive={interactive}
            frameX={frameX}
            modifier={modifier}
            api={api}
            onProbe={() => setFocus(true)}
            onPlainWheel={showHint}
          />
        ) : (
          <div className="w3-loading">Loading orbit elements</div>
        )}
      </ThreeGuard>

      <div className="w3-hint" ref={hint} aria-hidden="true">
        Hold {isMac ? '⌘' : 'Ctrl'} and scroll to zoom
      </div>

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
              aria-pressed={focus}
              onClick={() => setFocus((v) => !v)}
              data-explain="Fly the camera to SPHEREx and show its details, or fly back to the whole Earth."
            >
              {focus ? 'Back to Earth' : 'Fly to SPHEREx'}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="w3-corner">
          <span className={'w3-badge' + (live ? ' is-live' : '')}>{live ? 'Live' : `${rate}x`}</span>
          <button
            type="button"
            className="w3-btn"
            onClick={() => setClockRate(live ? 60 : 1)}
            data-explain={
              live
                ? 'Speed time up 60 times so you can watch SPHEREx move around its orbit.'
                : 'Go back to real time: show where SPHEREx is at this very moment.'
            }
          >
            {live ? 'Speed up' : 'Go live'}
          </button>
          {interactive ? (
            <>
              <button
                type="button"
                className="w3-btn w3-btn-sq"
                onClick={() => api.current?.zoom(0.8)}
                data-explain="Zoom in."
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                className="w3-btn w3-btn-sq"
                onClick={() => api.current?.zoom(1.25)}
                data-explain="Zoom out."
                aria-label="Zoom out"
              >
                -
              </button>
              <button
                type="button"
                className={'w3-btn' + (focus ? ' w3-btn-strong' : '')}
                onClick={() => setFocus((v) => !v)}
                data-explain={
                  focus
                    ? 'Fly the camera back out to the whole Earth. The Esc key does the same.'
                    : 'Fly the camera to SPHEREx and show its details. You can also click the spacecraft itself.'
                }
              >
                {focus ? 'Back to Earth' : 'Fly to SPHEREx'}
              </button>
            </>
          ) : null}
        </div>
      )}

      {focus && interactive ? (
        <div className="w3-readout w3-probe" aria-live="off">
          <div className="w3-readout-head">
            <span>SPHEREx</span>
            <span className={'w3-dot' + (live ? ' is-live' : '')} />
          </div>
          <dl>
            <dt>Latitude</dt>
            <dd ref={bind('plat')}>-</dd>
            <dt>Longitude</dt>
            <dd ref={bind('plon')}>-</dd>
            <dt>Altitude</dt>
            <dd ref={bind('palt')}>-</dd>
            <dt>Speed</dt>
            <dd ref={bind('pspeed')}>-</dd>
            <dt>Orbit period</dt>
            <dd>{fmt(periodMin, 1)} min</dd>
            <dt>Inclination</dt>
            <dd>{fmt(inclDeg, 2)} deg</dd>
          </dl>
          <ul className="w3-facts">
            <li>Launched 11 March 2025 on a SpaceX Falcon 9 from Vandenberg, California, together with NASA's PUNCH mission.</li>
            <li>Telescope aperture 20 cm. Size 2.6 m tall, 3.2 m across the outer shield.</li>
            <li>102 colour bands from 0.75 to 5.0 micrometres.</li>
            <li>Maps the whole sky every 6 months.</li>
          </ul>
          <div className="w3-readout-foot">Sources: NASA/JPL. Orbit numbers from the current CelesTrak elements.</div>
          <button
            type="button"
            className="w3-btn"
            onClick={() => setFocus(false)}
            data-explain="Fly the camera back out to the view of the whole Earth."
          >
            Back to Earth
          </button>
        </div>
      ) : showReadout ? (
        <div className="w3-readout" aria-live="off">
          <div className="w3-readout-head">
            <span>SPHEREx {live ? 'right now' : `at ${rate}x speed`}</span>
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
            Polar orbit, NORAD 63182. Elements: {tle ? `${tle.source}, epoch ${tle.epoch.slice(0, 16).replace('T', ' ')} UTC` : 'loading'}
            {tleNote ? `, ${tleNote}` : ''}. Spacecraft drawn about {ENLARGEMENT.toLocaleString('en-US')} times true size so it can be seen;
            Earth, orbit and Sun direction are to scale.{interactive ? ' Click the spacecraft for details.' : ''}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3D scene
// ---------------------------------------------------------------------------

type CanvasProps = {
  sat: SatRec;
  clock: MutableRefObject<Clock>;
  focus: boolean;
  interactive: boolean;
  frameX: number;
  modifier: boolean;
  api: MutableRefObject<SceneApi | null>;
  onProbe: () => void;
  onPlainWheel: () => void;
};

function NowCanvas(props: CanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box);
  const [low, setLow] = useState(false);
  return (
    <div ref={box} className="w3-stage" style={props.interactive ? undefined : { pointerEvents: 'none' }}>
      <Canvas
        frameloop={inView ? 'always' : 'never'}
        dpr={low ? 1 : [1, 1.5]}
        camera={{ position: [0, 1.4, 5], fov: 35, near: 0.05, far: 500 }}
        gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      >
        {/* quality only ever steps down once per session: no flipping, no remounts, no black frames */}
        <PerformanceMonitor onDecline={() => !FORCE_HQ && setLow(true)} flipflops={1} />
        <color attach="background" args={['#020306']} />
        <Suspense fallback={null}>
          <PerfProbe name="now" />
          <NowScene {...props} />
        </Suspense>
        <EffectComposer multisampling={0} enableNormalPass={false}>
          {/* only the Sun disc (HDR value ~90) is above this threshold */}
          <Bloom mipmapBlur luminanceThreshold={20} luminanceSmoothing={0.1} intensity={low ? 0 : 0.5} radius={0.6} />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
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

// Linear-light shading. Land relief from a GEBCO normal map; a small, subtle sun
// glint only on water (GEBCO ocean mask); city lights only on the night side.
const earthFrag = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D oceanMap;
uniform sampler2D normalMap;
uniform vec3 sunDir;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(sunDir);
  vec3 V = normalize(cameraPosition - vW);
  float ocean = texture2D(oceanMap, vUv).r;
  // tangent frame on the sphere: east and north (the Earth spins about +Y)
  vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-5, 0.0, 0.0));
  vec3 B = cross(N, T);
  vec3 nm = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
  vec3 Nl = normalize(mix(N, normalize(T * nm.x + B * nm.y + N * nm.z), 1.0 - ocean));
  float d = dot(N, L);
  float dl = dot(Nl, L);
  float dayK = smoothstep(-0.10, 0.22, d);
  vec3 day = texture2D(dayMap, vUv).rgb;
  vec3 night = texture2D(nightMap, vUv).rgb;
  vec3 col = day * (0.015 + 1.25 * max(dl, 0.0));
  // ocean glint: narrow and faint, never above the bloom threshold
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float spec = (pow(nh, 1800.0) * 0.16 + pow(nh, 160.0) * 0.012) * ocean * smoothstep(0.0, 0.25, d);
  col += vec3(0.95, 0.92, 0.85) * spec;
  // warm tint along the terminator
  col *= mix(vec3(1.0), vec3(1.08, 0.86, 0.7), exp(-pow(d / 0.12, 2.0)) * 0.6);
  vec3 lights = pow(night, vec3(1.5)) * 1.4 * (1.0 - smoothstep(-0.16, 0.06, d));
  gl_FragColor = vec4(mix(lights, col, dayK), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Thin atmosphere shell: Rayleigh-blue on the day limb, reddened near the terminator.
const atmoFrag = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float mu = dot(N, normalize(sunDir));
  float rim = pow(1.0 - abs(dot(N, V)), 2.6);
  float lit = smoothstep(-0.28, 0.45, mu);
  vec3 blue = vec3(0.24, 0.48, 1.0) * lit;
  vec3 dusk = vec3(1.0, 0.5, 0.25) * exp(-pow(mu / 0.12, 2.0)) * 0.22 * lit;
  gl_FragColor = vec4((blue + dusk) * rim * 0.9, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

let flatNormal: THREE.DataTexture | null = null;
const flat = () => {
  if (!flatNormal) {
    flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    flatNormal.needsUpdate = true;
  }
  return flatNormal;
};

/** Low-res textures first (fast suspense), the 4k day map, night lights and relief swapped in when loaded. */
function useEarthTextures() {
  const [dayLo, nightLo, ocean] = useTexture([
    '/textures/earth-day-512.webp',
    '/textures/earth-night-512.webp',
    '/textures/earth-ocean-1k.webp',
  ]);
  const [hi, setHi] = useState<{ day?: THREE.Texture; night?: THREE.Texture; normal?: THREE.Texture }>({});
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    let dead = false;
    const loader = new THREE.TextureLoader();
    const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
    const load = (url: string, key: 'day' | 'night' | 'normal', srgb: boolean) =>
      loader
        .loadAsync(url)
        .then((t) => {
          if (dead) return t.dispose();
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = aniso;
          setHi((h) => ({ ...h, [key]: t }));
        })
        .catch(() => undefined);
    load('/textures/earth-day-4k.webp', 'day', true);
    load('/textures/earth-night-2k.webp', 'night', true);
    load('/textures/earth-normal-2k.webp', 'normal', false);
    return () => {
      dead = true;
    };
  }, [gl]);
  useEffect(() => {
    dayLo.colorSpace = THREE.SRGBColorSpace;
    nightLo.colorSpace = THREE.SRGBColorSpace;
    dayLo.needsUpdate = nightLo.needsUpdate = true;
  }, [dayLo, nightLo]);
  useEffect(() => () => Object.values(hi).forEach((t) => t?.dispose()), [hi]);
  return { day: hi.day ?? dayLo, night: hi.night ?? nightLo, normal: hi.normal ?? flat(), ocean };
}

const TRAIL_N = 220;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Shifts the rendered view sideways (camera view offset, not CSS): the canvas stays full width.
 *  Eases back to centre while the spacecraft is focused. */
function FrameOffset({ frameX, focus }: { frameX: number; focus: boolean }) {
  const { camera, size } = useThree();
  const cur = useRef(frameX);
  const applied = useRef<string>('');
  useFrame((_, dt) => {
    const want = focus ? 0 : frameX;
    cur.current += (want - cur.current) * Math.min(1, dt * 3);
    if (Math.abs(want - cur.current) < 1e-4) cur.current = want;
    const key = `${cur.current.toFixed(4)}|${size.width}|${size.height}`;
    if (key === applied.current) return;
    applied.current = key;
    const cam = camera as THREE.PerspectiveCamera;
    if (Math.abs(cur.current) > 1e-4) cam.setViewOffset(size.width, size.height, -cur.current * size.width, 0, size.width, size.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  });
  return null;
}

function NowScene({ sat, clock, focus, interactive, frameX, modifier, api, onProbe, onPlainWheel }: CanvasProps) {
  useRenderCount('now/scene');
  const pal = usePalette();
  const { day, night, ocean, normal } = useEarthTextures();
  const earth = useRef<THREE.Mesh>(null);
  const craft = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const sunLight = useRef<THREE.DirectionalLight>(null);
  const sunDisc = useRef<THREE.Mesh>(null);
  const controls = useRef<React.ElementRef<typeof OrbitControls>>(null);
  const { camera, gl } = useThree();
  const [hot, setHot] = useState(false);

  const uniforms = useMemo(
    () => ({
      dayMap: { value: day as THREE.Texture },
      nightMap: { value: night as THREE.Texture },
      oceanMap: { value: ocean as THREE.Texture },
      normalMap: { value: normal as THREE.Texture },
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
    uniforms.normalMap.value = normal;
  }, [day, night, ocean, normal, uniforms]);

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
  const accent = useMemo(() => new THREE.Color(pal.accent), [pal.accent]);
  useEffect(
    () => () => {
      trail.g.dispose();
      trail.m.dispose();
    },
    [trail],
  );

  const periodMs = ((2 * Math.PI) / sat.no) * 60000; // sat.no is mean motion in rad/min
  const st = useRef({
    placed: false,
    lastUser: -1e9, // last time the visitor touched the camera
    prevSat: new THREE.Vector3(),
    hasPrev: false,
    fly: null as null | { t0: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toCraft: boolean },
    mode: 'earth' as 'earth' | 'craft',
    offset: new THREE.Vector3(), // camera offset from the craft in the craft view
  });
  const tmp = useMemo(
    () => ({
      r: new THREE.Vector3(),
      s: new THREE.Vector3(),
      x: new THREE.Vector3(),
      z: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      p: new THREE.Vector3(),
      q: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      ray: new THREE.Ray(),
      sph: new THREE.Sphere(new THREE.Vector3(), ATMO),
    }),
    [],
  );

  /**
   * The whole-Earth view: a steady vantage on the sunlit side, a little above the equator and turned
   * 40 degrees toward the terminator so day, night and city lights all show. It follows the Sun, not
   * the craft, so the default view never chases the spacecraft around its orbit.
   */
  const earthView = (sunDir: THREE.Vector3, dist: number, out: THREE.Vector3) => {
    out.copy(sunDir).normalize().applyAxisAngle(Y_AXIS, -0.7);
    out.y = out.y * 0.5 + 0.28;
    return out.normalize().multiplyScalar(dist);
  };
  const craftView = (satPos: THREE.Vector3, sun: THREE.Vector3, out: THREE.Vector3) => {
    const r = tmp.a.copy(satPos).normalize();
    const side = tmp.b.copy(sun).addScaledVector(r, -sun.dot(r)).normalize();
    // from the sunlit side, slightly above the craft, looking back across it
    return out.copy(satPos).addScaledVector(r, 0.22).addScaledVector(side, 0.42);
  };

  // start a fly-in or fly-out whenever focus changes
  useEffect(() => {
    const ctl = controls.current;
    if (!st.current.placed || !ctl) return;
    st.current.fly = { t0: performance.now(), fromPos: camera.position.clone(), fromTarget: ctl.target.clone(), toCraft: focus };
    st.current.mode = 'earth';
  }, [focus, camera]);

  // zoom API for the + / - buttons, and Ctrl/Cmd + wheel in 'modifier' mode
  const zoomBy = useCallback(
    (factor: number) => {
      const ctl = controls.current;
      if (!ctl) return;
      const off = tmp.q.copy(camera.position).sub(ctl.target);
      const lo = st.current.mode === 'craft' ? CRAFT_MIN : EARTH_MIN;
      const hi = st.current.mode === 'craft' ? CRAFT_MAX : EARTH_MAX;
      off.setLength(THREE.MathUtils.clamp(off.length() * factor, lo, hi));
      camera.position.copy(ctl.target).add(off);
      if (st.current.mode === 'craft') st.current.offset.copy(off);
      st.current.lastUser = performance.now();
      ctl.update();
    },
    [camera, tmp],
  );
  useEffect(() => {
    api.current = { zoom: zoomBy };
    return () => {
      api.current = null;
    };
  }, [api, zoomBy]);

  useEffect(() => {
    if (!modifier || !interactive) return;
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      // Close to the craft any wheel zooms (the visitor is clearly interacting); around the Earth only
      // Ctrl/Cmd + wheel or a trackpad pinch zooms, so a plain wheel scrolls the page.
      if (e.ctrlKey || e.metaKey || st.current.mode === 'craft') {
        e.preventDefault(); // also covers trackpad pinch, which arrives as ctrl + wheel
        zoomBy(Math.exp(e.deltaY * 0.0025));
      } else onPlainWheel();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [gl, modifier, interactive, zoomBy, onPlainWheel]);

  // touch: in 'modifier' mode one finger scrolls the page, two fingers rotate and zoom
  useEffect(() => {
    const ctl = controls.current;
    if (!ctl) return;
    if (modifier) {
      ctl.touches.ONE = -1 as unknown as THREE.TOUCH;
      ctl.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
      gl.domElement.style.touchAction = 'pan-y';
    }
  }, [modifier, gl]);

  useEffect(() => {
    gl.domElement.style.cursor = hot && !focus ? 'pointer' : '';
  }, [hot, focus, gl]);

  useFrame((_, dt) => {
    const ms = simNow(clock.current);
    const d = new Date(ms);
    const pv = propagate(sat, d);
    if (!pv || typeof pv.position !== 'object') return;
    const p = pv.position;
    const satPos = toScene(p.x, p.y, p.z, tmp.p);
    const [sx, sy, sz] = sunEci(ms);
    const sun = toScene(sx * RE, sy * RE, sz * RE, tmp.s).normalize();
    const s = st.current;
    const ctl = controls.current;
    const now = performance.now();

    uniforms.sunDir.value.copy(sun);
    if (earth.current) earth.current.rotation.y = gstime(d);
    if (sunLight.current) {
      sunLight.current.position.copy(satPos).addScaledVector(sun, 10);
      sunLight.current.target.position.copy(satPos);
      sunLight.current.target.updateMatrixWorld();
    }
    // the Sun disc is hidden whenever the Earth (with its atmosphere) is in front of it
    if (sunDisc.current) {
      tmp.ray.set(camera.position, sun);
      sunDisc.current.visible = !tmp.ray.intersectsSphere(tmp.sph);
      sunDisc.current.position.copy(camera.position).addScaledVector(sun, 300);
    }

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
    if (ring.current) {
      ring.current.position.copy(satPos);
      ring.current.quaternion.copy(camera.quaternion);
      const mat = ring.current.material as THREE.MeshBasicMaterial;
      mat.opacity = s.mode !== 'craft' && hot ? 0.55 : 0;
    }

    // trail positions: recomputed every quarter orbit; colours every frame
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
      const f = (trail.times[i] - ms) / periodMs; // < 0 behind the craft
      const a = f <= 0 ? 0.95 * Math.exp(f * 3.2) : 0.1 * Math.exp(-f * 2);
      ca.setXYZW(i, accent.r, accent.g, accent.b, a);
    }
    ca.needsUpdate = true;

    if (!ctl) return;
    if (!s.placed) {
      s.placed = true;
      earthView(sun, 5.2, camera.position);
      ctl.target.set(0, 0, 0);
      ctl.update();
    }
    const cam = camera as THREE.PerspectiveCamera;

    if (s.fly) {
      // eased flight; the end point moves with the craft
      const k = ease(Math.min(1, (now - s.fly.t0) / FLY_MS));
      const toPos = s.fly.toCraft ? craftView(satPos, sun, tmp.a) : earthView(sun, 5.2, tmp.a);
      const toTarget = s.fly.toCraft ? tmp.b.copy(satPos) : tmp.b.set(0, 0, 0);
      camera.position.lerpVectors(s.fly.fromPos, toPos, k);
      ctl.target.lerpVectors(s.fly.fromTarget, toTarget, k);
      cam.near = THREE.MathUtils.lerp(cam.near, s.fly.toCraft ? 0.01 : 0.05, k);
      cam.updateProjectionMatrix();
      if (k >= 1) {
        s.mode = s.fly.toCraft ? 'craft' : 'earth';
        s.offset.copy(camera.position).sub(satPos);
        s.fly = null;
        s.lastUser = now;
      }
    } else if (s.mode === 'craft') {
      // ride along: keep the visitor's chosen offset while the craft moves
      if (s.hasPrev) camera.position.add(tmp.q.copy(satPos).sub(s.prevSat));
      ctl.target.copy(satPos);
    } else if (now - s.lastUser > 6000) {
      // idle: ease back to the steady whole-Earth view, keeping the visitor's zoom
      const dist = camera.position.length();
      camera.position.lerp(earthView(sun, dist, tmp.a), Math.min(1, dt * 0.15)).setLength(dist);
    }
    ctl.minDistance = s.mode === 'craft' ? CRAFT_MIN : s.fly ? 0 : EARTH_MIN;
    ctl.maxDistance = s.mode === 'craft' ? CRAFT_MAX : s.fly ? Infinity : EARTH_MAX;
    ctl.enableZoom = interactive && !modifier; // in 'modifier' mode the wheel handler above does all zooming
    // never inside the Earth or its atmosphere, whatever the controls do
    if (camera.position.length() < CAM_FLOOR) camera.position.setLength(CAM_FLOOR);
    s.prevSat.copy(satPos);
    s.hasPrev = true;
    if (PERF) {
      const v = satPos.clone().project(camera);
      (window as unknown as { __w3probe?: number[] }).__w3probe = [
        ((v.x + 1) / 2) * gl.domElement.clientWidth,
        ((1 - v.y) / 2) * gl.domElement.clientHeight,
      ];
    }
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (interactive) setHot(true);
  };
  const outp = () => setHot(false);
  const up = (e: ThreeEvent<PointerEvent>) => {
    if (!interactive || focus || e.delta > 6) return; // a drag is not a click
    e.stopPropagation();
    onProbe();
  };

  return (
    <>
      <FrameOffset frameX={frameX} focus={focus} />
      <Starfield frame="equatorial" brightness={1.5} />
      <StudioEnvironment intensity={0.35} />
      <hemisphereLight args={['#9fb6e0', '#0b1020', 0.25]} />
      <directionalLight ref={sunLight} intensity={3.4} color="#fff6ea" />
      {/* the Sun: about 0.53 degrees across, bright enough to bloom, hidden behind the Earth */}
      <mesh ref={sunDisc} renderOrder={-5}>
        <sphereGeometry args={[1.4, 24, 16]} />
        <meshBasicMaterial color={[90, 82, 70]} toneMapped={false} fog={false} />
      </mesh>
      <mesh ref={earth}>
        <sphereGeometry args={[1, 128, 96]} />
        <shaderMaterial vertexShader={earthVert} fragmentShader={earthFrag} uniforms={uniforms} />
      </mesh>
      <mesh scale={ATMO}>
        <sphereGeometry args={[1, 96, 64]} />
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
      {/* thin ring around the craft: shows it can be clicked */}
      <mesh ref={ring}>
        <ringGeometry args={[0.12, 0.123, 64]} />
        <meshBasicMaterial color={pal.text} transparent opacity={0} depthWrite={false} />
      </mesh>
      <group ref={craft} onPointerOver={over} onPointerOut={outp} onPointerUp={up}>
        <group scale={MODEL_SCALE} position={[0, -1.3 * MODEL_SCALE, 0]}>
          <SpherexSpacecraft accent={pal.accent} detColors={pal.det} lite />
        </group>
        {/* larger invisible hit target so the small craft is easy to click */}
        <mesh>
          <sphereGeometry args={[0.11, 12, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <OrbitControls
        ref={controls}
        makeDefault
        enabled={interactive}
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        rotateSpeed={0.6}
        zoomSpeed={0.7}
        minDistance={EARTH_MIN}
        maxDistance={EARTH_MAX}
        onStart={() => (st.current.lastUser = performance.now())}
        onEnd={() => (st.current.lastUser = performance.now())}
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
      <svg
        viewBox="0 0 360 180"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Map of Earth with the current ground track of SPHEREx"
      >
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

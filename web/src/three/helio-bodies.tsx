// Bodies of the heliocentric view: the Sun, textured planets with orbit trails,
// the comet with coma and tails, SPHEREx marks and the ecliptic grid. All
// motion is read from jdRef inside useFrame, so playing causes no React renders.
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { PLANETS, SUN_SIZE, at, bodyEcl, planetAt, sc, type Body, type BodyKey, type OrbitData } from './helio-core';
import {
  atmoFrag,
  atmoVert,
  billboardVert,
  comaFrag,
  coronaFrag,
  gridFrag,
  gridVert,
  sunFrag,
  sunVert,
  tailFrag,
  tailVert,
} from './helio-shaders';

/** Label colours: the scene is always dark space, whatever the page theme. */
const TAG = '#b9bfc8';
const TAG_STRONG = '#f3f1ea';

export type PickApi = {
  hover: MutableRefObject<BodyKey | null>;
  focus: MutableRefObject<BodyKey | null>;
  onPick: (k: BodyKey) => void;
};

/** Comet activity (tail and coma scale) from distance to the Sun in au. */
export const cometActivity = (r: number) => Math.min(2.2, Math.max(0.05, Math.pow(1.7 / Math.max(r, 0.3), 2.2)));
/** Drawn tail length in au (schematic, grows towards the Sun). */
export const tailLength = (r: number) => 0.85 * cometActivity(r);

/** Invisible, slightly larger sphere that is easy to click, at least ~10 px wide. */
function HitSphere({ k, size, pick }: { k: BodyKey; size: number; pick: PickApi }) {
  const m = useRef<THREE.Mesh>(null);
  const { gl } = useThree();
  const wp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    if (!m.current) return;
    m.current.getWorldPosition(wp);
    m.current.scale.setScalar(Math.max(size * 1.4, camera.position.distanceTo(wp) * 0.014));
  });
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    pick.hover.current = k;
    gl.domElement.style.cursor = 'pointer';
  };
  const out = () => {
    if (pick.hover.current === k) pick.hover.current = null;
    gl.domElement.style.cursor = '';
  };
  useEffect(() => () => void (gl.domElement.style.cursor = ''), [gl]);
  // A WebGL object, not a DOM element, so it cannot carry data-explain; the "Fly to" list and the
  // info card explain the same action in words.
  const handlers = {
    onPointerOver: over,
    onPointerOut: out,
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > 6) return; // a drag, not a click
      e.stopPropagation();
      pick.onPick(k);
    },
  };
  return (
    <mesh ref={m} visible={false} {...handlers}>
      <sphereGeometry args={[1, 12, 8]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

export function Sun({ pick }: { pick: PickApi }) {
  const corona = useRef<THREE.Mesh>(null);
  const mats = useMemo(() => {
    const sun = new THREE.ShaderMaterial({
      vertexShader: sunVert,
      fragmentShader: sunFrag,
      uniforms: { uTime: { value: 0 } },
      toneMapped: false,
    });
    const cor = new THREE.ShaderMaterial({
      vertexShader: billboardVert,
      fragmentShader: coronaFrag,
      uniforms: { uTime: { value: 0 }, uInner: { value: 1 / 6 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    return { sun, cor };
  }, []);
  useEffect(() => () => (mats.sun.dispose(), mats.cor.dispose()), [mats]);
  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    mats.sun.uniforms.uTime.value = t;
    mats.cor.uniforms.uTime.value = t;
    corona.current?.quaternion.copy(camera.quaternion);
  });
  return (
    <group>
      <mesh material={mats.sun}>
        <sphereGeometry args={[SUN_SIZE, 48, 32]} />
      </mesh>
      <mesh ref={corona} material={mats.cor} scale={SUN_SIZE * 12} renderOrder={2}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <HitSphere k="sun" size={SUN_SIZE} pick={pick} />
      <Html position={[SUN_SIZE * 0.7, SUN_SIZE, 0]} className="w3-tag" zIndexRange={[10, 0]} style={{ pointerEvents: 'none', color: TAG }}>
        Sun
      </Html>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Planets
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Painted stand-in used until (or if) the NASA map loads. */
function proceduralTexture(id: string): THREE.Texture {
  const W = 512;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  const r = rng(id.charCodeAt(0) * 97 + id.length);
  if (c) {
    if (id === '599') {
      const bands = [
        '#e6dcc6',
        '#c49a72',
        '#efe5cf',
        '#b07c56',
        '#e8d8bb',
        '#c8a27c',
        '#f0e6d0',
        '#a8774f',
        '#ddc8a8',
        '#bf9670',
        '#e3d4b8',
      ];
      bands.forEach((b, i) => {
        c.fillStyle = b;
        c.fillRect(0, (i * H) / bands.length, W, H / bands.length + 1);
      });
      for (let i = 0; i < 900; i++) {
        c.fillStyle = `rgba(${r() > 0.5 ? '255,250,240' : '120,80,50'},${0.05 + r() * 0.08})`;
        const y = r() * H;
        c.beginPath();
        c.ellipse(r() * W, y, 6 + r() * 30, 1 + r() * 3, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = 'rgba(178,88,60,0.85)';
      c.beginPath();
      c.ellipse(W * 0.3, H * 0.64, 18, 9, 0, 0, Math.PI * 2);
      c.fill();
    } else if (id === '299') {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#d9c79a');
      g.addColorStop(0.5, '#efe0b4');
      g.addColorStop(1, '#d6c293');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      for (let i = 0; i < 260; i++) {
        c.strokeStyle = `rgba(${r() > 0.5 ? '255,248,225' : '170,140,90'},${0.06 + r() * 0.08})`;
        c.lineWidth = 2 + r() * 6;
        const y = r() * H;
        c.beginPath();
        c.moveTo(0, y);
        for (let x = 0; x <= W; x += 32) c.lineTo(x, y + Math.sin(x / 60 + i) * 8 + (x / W) * 20 * (r() - 0.5));
        c.stroke();
      }
    } else if (id === '499') {
      c.fillStyle = '#b5623b';
      c.fillRect(0, 0, W, H);
      for (let i = 0; i < 260; i++) {
        c.fillStyle = `rgba(${r() > 0.55 ? '90,45,30' : '214,140,96'},${0.1 + r() * 0.15})`;
        c.beginPath();
        c.ellipse(r() * W, H * 0.2 + r() * H * 0.6, 10 + r() * 40, 5 + r() * 18, r() * 3, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = 'rgba(245,240,235,0.9)';
      c.fillRect(0, 0, W, 10);
      c.fillRect(0, H - 8, W, 8);
    } else {
      c.fillStyle = id === '399' ? '#2c5fa0' : '#8f8a84';
      c.fillRect(0, 0, W, H);
      for (let i = 0; i < 700; i++) {
        const rr = 1 + Math.pow(r(), 3) * 14;
        c.fillStyle = `rgba(${r() > 0.5 ? '60,58,55' : '190,185,178'},${0.12 + r() * 0.2})`;
        c.beginPath();
        c.arc(r() * W, r() * H, rr, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function usePlanetMap(id: string) {
  const { gl } = useThree();
  const [tex, setTex] = useState<THREE.Texture>(() => proceduralTexture(id));
  useEffect(() => {
    const url = PLANETS[id]?.tex;
    if (!url) return;
    let dead = false;
    let loaded: THREE.Texture | null = null;
    new THREE.TextureLoader().load(
      url,
      (t) => {
        if (dead) return t.dispose();
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy());
        loaded = t;
        setTex(t);
      },
      undefined,
      () => undefined, // keep the painted stand-in
    );
    return () => {
      dead = true;
      loaded?.dispose();
    };
  }, [id, gl]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

const ATMO: Record<string, { color: string; power: number; strength: number }> = {
  '299': { color: '#ffe2a8', power: 2.2, strength: 0.9 },
  '399': { color: '#6fa6ff', power: 2.6, strength: 1.1 },
  '499': { color: '#f0a070', power: 3.5, strength: 0.35 },
};

export function Planet({
  body,
  jdRef,
  pick,
  label = true,
}: {
  body: Body;
  jdRef: MutableRefObject<number>;
  pick: PickApi;
  label?: boolean;
}) {
  const id = body.id ?? '';
  const look = PLANETS[id] ?? { color: '#aaaaaa', size: 0.035, radiusKm: 0, tilt: 0, spin: 0.1 };
  const g = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Mesh>(null);
  const map = usePlanetMap(id);
  const line = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(body.points.map((p) => sc([p[1], p[2], p[3]], new THREE.Vector3())));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(body.points.length * 4), 4));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    l.frustumCulled = false;
    return l;
  }, [body]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );
  const atmo = useMemo(() => {
    const a = ATMO[id];
    if (!a) return null;
    return new THREE.ShaderMaterial({
      vertexShader: atmoVert,
      fragmentShader: atmoFrag,
      uniforms: { uColor: { value: new THREE.Color(a.color) }, uPower: { value: a.power }, uStrength: { value: a.strength } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, [id]);
  useEffect(() => () => atmo?.dispose(), [atmo]);
  const base = useMemo(() => new THREE.Color(look.color).multiplyScalar(1.15), [look.color]);
  const last = useRef(NaN);
  const shell = useRef<THREE.Group>(null);
  const tag = useRef<THREE.Group>(null);
  const hide = (look.size * 1.6) / (2 * Math.PI * Math.max(0.2, Math.hypot(body.points[0]?.[1] ?? 1, body.points[0]?.[2] ?? 0)));
  useFrame(({ camera }, dt) => {
    if (spin.current) spin.current.rotation.y += look.spin * Math.min(dt, 0.1);
    // never smaller than a few pixels, so the planets read as coloured discs in the overview
    if (g.current && shell.current) {
      const k = Math.max(1, (camera.position.distanceTo(g.current.position) * 0.0055) / look.size);
      shell.current.scale.setScalar(k);
      tag.current?.position.set(look.size * k * 0.6, look.size * k * 0.9, 0);
    }
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
      // gap where the planet sits, so the line does not cut across its disc
      const a = Math.min(lag, 1 - lag) < hide ? 0 : 0.12 + 0.78 * Math.pow(1 - lag, 2.2);
      ca.setXYZW(i, base.r, base.g, base.b, a);
    }
    ca.needsUpdate = true;
  });
  return (
    <group>
      <primitive object={line} />
      <group ref={g}>
        <group ref={shell} rotation={[0, 0, (look.tilt * Math.PI) / 180]}>
          <mesh ref={spin}>
            <sphereGeometry args={[look.size, 48, 32]} />
            <meshStandardMaterial map={map} roughness={0.95} metalness={0} />
          </mesh>
          {atmo ? (
            <mesh material={atmo} scale={1.06}>
              <sphereGeometry args={[look.size, 32, 24]} />
            </mesh>
          ) : null}
        </group>
        <HitSphere k={id} size={look.size} pick={pick} />
        {label ? (
          <group ref={tag}>
            <Html className="w3-tag" zIndexRange={[10, 0]} style={{ pointerEvents: 'none', color: TAG }}>
              {body.name}
            </Html>
          </group>
        ) : null}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Comet
// ---------------------------------------------------------------------------

const N_ION = 1400;
const N_DUST = 5200;

function tailMaterial(color: string, rate: number, bend: number, wave: number, size: number, intensity: number) {
  return new THREE.ShaderMaterial({
    vertexShader: tailVert,
    fragmentShader: tailFrag,
    uniforms: {
      uTime: { value: 0 },
      uRate: { value: rate },
      uAnti: { value: new THREE.Vector3(1, 0, 0) },
      uVel: { value: new THREE.Vector3(0, 0, 1) },
      uSide: { value: new THREE.Vector3(0, 1, 0) },
      uLat: { value: new THREE.Vector3(0, 0, 1) },
      uL: { value: 0.3 },
      uW: { value: 0.02 },
      uBend: { value: bend },
      uWave: { value: wave },
      uSize: { value: size },
      uPx: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uI: { value: intensity },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function seedGeometry(n: number) {
  const geo = new THREE.BufferGeometry();
  const s = new Float32Array(n * 4);
  for (let i = 0; i < s.length; i++) s[i] = Math.random();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(s, 4));
  return geo;
}

export function Comet({ data, jdRef, pick, label }: { data: OrbitData; jdRef: MutableRefObject<number>; pick: PickApi; label: string }) {
  const g = useRef<THREE.Group>(null);
  const coma = useRef<THREE.Mesh>(null);
  const parts = useMemo(() => {
    const ion = new THREE.Points(seedGeometry(N_ION), tailMaterial('#6f98ff', 0.55, 0, 0.6, 0.032, 0.42));
    const dust = new THREE.Points(seedGeometry(N_DUST), tailMaterial('#f2dcae', 0.16, 0.95, 0, 0.055, 0.24));
    ion.frustumCulled = false;
    dust.frustumCulled = false;
    const comaMat = new THREE.ShaderMaterial({
      vertexShader: billboardVert,
      fragmentShader: comaFrag,
      uniforms: { uI: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { ion, dust, comaMat };
  }, []);
  useEffect(
    () => () => {
      for (const p of [parts.ion, parts.dust]) {
        p.geometry.dispose();
        (p.material as THREE.Material).dispose();
      }
      parts.comaMat.dispose();
    },
    [parts],
  );
  const tmp = useMemo(
    () => ({ n: new THREE.Vector3(), s: new THREE.Vector3(), v: new THREE.Vector3(), u: new THREE.Vector3(), w: new THREE.Vector3() }),
    [],
  );
  const comaSize = useRef(0.05);
  useFrame(({ camera, clock, gl }) => {
    const t = clock.elapsedTime;
    const px = gl.getPixelRatio() * (gl.domElement.clientHeight || 500) * 0.9;
    const jd = jdRef.current;
    const pts = data.object.points;
    const p = at(pts, jd);
    const p2 = at(pts, Math.min(pts[pts.length - 1][0], jd + 1));
    const p1 = at(pts, Math.max(pts[0][0], jd - 1));
    if (!p || !p1 || !p2) return;
    const n = sc(p, tmp.n);
    if (g.current) g.current.position.copy(n);
    const r = n.length();
    const anti = tmp.s.copy(n).normalize();
    const vel = sc([p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], tmp.v).normalize();
    const side = tmp.u.crossVectors(anti, vel).normalize();
    const lat = tmp.w.crossVectors(side, anti).normalize();
    const act = cometActivity(r);
    const L = tailLength(r);
    for (const [pt, len, w] of [
      [parts.ion, L * 1.35, 0.035],
      [parts.dust, L, 0.09],
    ] as const) {
      const u = (pt.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = t;
      u.uAnti.value.copy(anti);
      u.uVel.value.copy(lat); // dust lags behind the motion: bend against the velocity, projected off the anti-Sun line
      u.uSide.value.copy(side);
      u.uLat.value.copy(lat);
      u.uL.value = len;
      u.uW.value = w * Math.max(0.35, Math.sqrt(act)) * Math.max(0.6, L);
      u.uPx.value = px;
    }
    // bend direction: minus the part of the velocity perpendicular to the anti-Sun line
    const vperp = tmp.v.sub(tmp.n.copy(anti).multiplyScalar(vel.dot(anti))).normalize();
    (parts.dust.material as THREE.ShaderMaterial).uniforms.uVel.value.copy(vperp);
    (parts.ion.material as THREE.ShaderMaterial).uniforms.uVel.value.copy(vperp);
    comaSize.current = 0.05 + 0.11 * Math.sqrt(act);
    if (coma.current) {
      coma.current.quaternion.copy(camera.quaternion);
      coma.current.scale.setScalar(Math.max(comaSize.current, camera.position.distanceTo(g.current?.position ?? camera.position) * 0.022));
    }
    parts.comaMat.uniforms.uI.value = 0.55 + 0.45 * Math.min(1, act);
  });
  return (
    <group ref={g}>
      <primitive object={parts.dust} />
      <primitive object={parts.ion} />
      <mesh ref={coma} material={parts.comaMat} renderOrder={3}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <HitSphere k="comet" size={0.03} pick={pick} />
      <Html className="w3-tag w3-tag-strong" zIndexRange={[10, 0]} style={{ pointerEvents: 'none', color: TAG_STRONG }}>
        {label}
      </Html>
    </group>
  );
}

// ---------------------------------------------------------------------------
// SPHEREx marks: dim before the date, lit after, pulsing for a while when passed
// ---------------------------------------------------------------------------

export function Marks({ data, marks, jdRef, color }: { data: OrbitData; marks: number[]; jdRef: MutableRefObject<number>; color: string }) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, transparent: true, depthWrite: false }),
      Math.max(1, marks.length),
    );
    m.count = marks.length;
    m.frustumCulled = false;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, marks.length) * 3), 3);
    return m;
  }, [marks.length]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    },
    [mesh],
  );
  const pos = useMemo(() => marks.map((m) => sc(at(data.object.points, m), new THREE.Vector3())), [marks, data]);
  const col = useMemo(() => new THREE.Color(color), [color]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const lastJd = useRef(NaN);
  const anyPulse = useRef(true);
  useFrame(({ camera, clock }) => {
    const jd = jdRef.current;
    if (jd === lastJd.current && !anyPulse.current) return;
    lastJd.current = jd;
    anyPulse.current = false;
    const t = clock.elapsedTime;
    for (let i = 0; i < marks.length; i++) {
      const d = jd - marks[i];
      const s0 = Math.max(0.006, camera.position.distanceTo(pos[i]) * 0.0022);
      let s = s0;
      if (d < 0) c.copy(col).multiplyScalar(0.35);
      else if (d < 14) {
        anyPulse.current = true;
        const k = 1 - d / 14;
        s = s0 * (1 + 0.9 * k + 0.35 * k * Math.sin(t * 9 + i));
        c.copy(col)
          .lerp(new THREE.Color(1, 1, 1), 0.6 * k)
          .multiplyScalar(1 + 0.25 * k);
      } else c.copy(col);
      o.position.copy(pos[i]);
      o.scale.setScalar(s);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    anyPulse.current = true; // marks follow the camera distance too
  });
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------------------
// Ecliptic grid
// ---------------------------------------------------------------------------

export function EclipticGrid({ R, dark }: { R: number; dark: boolean }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: gridVert,
        fragmentShader: gridFrag,
        uniforms: { uColor: { value: new THREE.Color('#8fa3c0') }, uOpacity: { value: 0.22 }, uMax: { value: R * 1.25 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [R],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => {
    mat.uniforms.uOpacity.value = dark ? 0.22 : 0.26;
  }, [mat, dark]);
  return (
    <mesh material={mat} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
      <planeGeometry args={[R * 2.6, R * 2.6]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Hover ring around the body under the pointer (and a thin one on the focused body)
// ---------------------------------------------------------------------------

function ringMaterial(opacity: number) {
  return new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
}

export function HoverRings({ data, jdRef, pick }: { data: OrbitData; jdRef: MutableRefObject<number>; pick: PickApi }) {
  const hover = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => new THREE.RingGeometry(0.88, 1, 64), []);
  const mats = useMemo(() => [ringMaterial(0.6)], []);
  useEffect(() => () => (geo.dispose(), mats.forEach((m) => m.dispose())), [geo, mats]);
  const v = useMemo(() => new THREE.Vector3(), []);
  const size = (k: BodyKey) => (k === 'sun' ? SUN_SIZE * 1.5 : k === 'comet' ? 0.05 : (PLANETS[k]?.size ?? 0.04) * 1.6);
  useFrame(({ camera, clock }) => {
    for (const [m, k, pulse] of [[hover.current, pick.hover.current, true]] as const) {
      if (!m) continue;
      const p = k ? bodyEcl(data, k, jdRef.current) : null;
      m.visible = !!p && k !== pick.focus.current; // no ring around the body already in focus
      if (!p || !k) continue;
      sc(p, v);
      m.position.copy(v);
      m.quaternion.copy(camera.quaternion);
      const px = camera.position.distanceTo(v) * 0.018;
      const s = Math.max(size(k), px) * (pulse ? 1 + 0.06 * Math.sin(clock.elapsedTime * 5) : 1);
      m.scale.setScalar(s);
    }
  });
  return (
    <>
      <mesh ref={hover} geometry={geo} material={mats[0]} renderOrder={20} visible={false} />
    </>
  );
}

export { planetAt };

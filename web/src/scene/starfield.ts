// A light star backdrop: the real bright stars (Yale Bright Star Catalogue, about
// 9000 stars) on the inside of a sphere, placed by RA/Dec, coloured by B-V and
// sized by magnitude. The camera sits at the centre and looks toward the current
// target. Plain three.js, no React; rendering only happens while something moves.
import * as THREE from 'three';

export interface Starfield {
  setTarget(ra: number | null, dec: number | null): void;
  dispose(): void;
}

const R = 100;

/** RA/Dec (degrees) to a unit vector. North is +y; east (growing RA) is on the left when looking out. */
export function radec(ra: number, dec: number, r = R): THREE.Vector3 {
  const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(d) * Math.cos(a) * r, Math.sin(d) * r, -Math.cos(d) * Math.sin(a) * r);
}

// B-V colour index to an approximate star colour.
const BV: [number, [number, number, number]][] = [
  [-0.4, [0.62, 0.7, 1.0]],
  [0.0, [0.8, 0.85, 1.0]],
  [0.4, [0.98, 0.97, 1.0]],
  [0.8, [1.0, 0.94, 0.86]],
  [1.2, [1.0, 0.82, 0.62]],
  [1.7, [1.0, 0.7, 0.45]],
];
function bvColor(bv: number): [number, number, number] {
  if (bv <= BV[0][0]) return BV[0][1];
  for (let i = 1; i < BV.length; i++) {
    if (bv <= BV[i][0]) {
      const [b0, c0] = BV[i - 1], [b1, c1] = BV[i];
      const t = (bv - b0) / (b1 - b0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return BV[BV.length - 1][1];
}

const VERT = `
attribute float size;
attribute vec3 tint;
varying vec3 vTint;
varying float vAlpha;
uniform float dpr;
void main() {
  vTint = tint;
  vAlpha = clamp(size / 3.0, 0.35, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * dpr;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  float core = smoothstep(1.0, 0.0, r);
  float a = core * core * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vTint * a, a);
}`;
const RING_FRAG = `
uniform vec3 color;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(0.78, 0.84, r) * smoothstep(1.0, 0.94, r);
  float c = smoothstep(0.2, 0.0, r);
  a = max(a, c);
  if (a < 0.02) discard;
  gl_FragColor = vec4(color * a, a);
}`;

export async function createStarfield(canvas: HTMLCanvasElement, opts: { reduced: boolean; accent: string }): Promise<Starfield> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1000);

  const res = await fetch('/data/bsc5.json');
  const data = (await res.json()) as { stars: number[] };
  const n = Math.floor(data.stars.length / 4);
  const pos = new Float32Array(n * 3), size = new Float32Array(n), tint = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [ra, dec, v, bv] = data.stars.slice(i * 4, i * 4 + 4);
    const p = radec(ra, dec);
    pos.set([p.x, p.y, p.z], i * 3);
    size[i] = Math.max(1.1, 0.9 + 1.25 * Math.pow(Math.max(0, 6.8 - v), 1.05));
    const c = bvColor(bv);
    tint.set(c, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { dpr: { value: dpr } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  scene.add(new THREE.Points(geo, mat));

  // Target marker: a thin ring on the sphere.
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  ringGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array([26]), 1));
  ringGeo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(3), 3));
  const ringMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: RING_FRAG, uniforms: { dpr: { value: dpr }, color: { value: new THREE.Color(opts.accent) } }, transparent: true, depthWrite: false });
  const ring = new THREE.Points(ringGeo, ringMat);
  ring.visible = false;
  scene.add(ring);

  // ---- camera motion ----
  let look = radec(80, 10, 1); // default view: Orion and Taurus
  let from = look.clone(), to = look.clone(), t0 = 0;
  const EASE_MS = 1800;
  const par = { x: 0, y: 0, tx: 0, ty: 0 };
  let drift = 0;
  let raf = 0, last = performance.now();
  let hasTarget = false;

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  };
  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(100, now - last);
    last = now;
    let moving = false;
    if (t0) {
      const k = Math.min(1, (now - t0) / EASE_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      look = from.clone().lerp(to, e).normalize();
      if (k >= 1) t0 = 0;
      else moving = true;
    }
    if (!opts.reduced) {
      par.x += (par.tx - par.x) * 0.06;
      par.y += (par.ty - par.y) * 0.06;
      if (Math.abs(par.tx - par.x) > 1e-4 || Math.abs(par.ty - par.y) > 1e-4) moving = true;
      void dt; // no idle drift: the sky only moves with the pointer or a new target (saves CPU)
    }
    const dir = look.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), drift + par.x * 0.035);
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    dir.applyAxisAngle(side, -par.y * 0.025);
    camera.up.set(0, 1, 0);
    camera.lookAt(dir);
    renderer.render(scene, camera);
    if (moving && !document.hidden) raf = requestAnimationFrame(frame);
  };
  function kick() {
    if (!raf && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  const onMove = (e: PointerEvent) => {
    if (opts.reduced) return;
    par.tx = e.clientX / window.innerWidth - 0.5;
    par.ty = e.clientY / window.innerHeight - 0.5;
    kick();
  };
  const onVis = () => kick();
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVis);
  resize();

  return {
    setTarget(ra, dec) {
      hasTarget = ra !== null && dec !== null;
      if (hasTarget) {
        const v = radec(ra!, dec!, 1);
        ring.geometry.attributes.position.setXYZ(0, v.x * (R - 1), v.y * (R - 1), v.z * (R - 1));
        ring.geometry.attributes.position.needsUpdate = true;
        ring.visible = true;
        // Fold the current drift into the start so the ease begins where the eye is.
        from = look.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), drift);
        drift = 0;
        to = v;
        if (opts.reduced) {
          look = to.clone();
          t0 = 0;
        } else t0 = performance.now();
      } else ring.visible = false;
      kick();
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      geo.dispose();
      mat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      renderer.dispose();
    },
  };
}

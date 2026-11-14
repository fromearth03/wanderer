// Real star background: about 25,500 Hipparcos stars brighter than V = 7.5
// (ESA Hipparcos catalogue, I/239 via VizieR), placed at their true RA/Dec,
// coloured by B-V and sized by magnitude. Drawn as an inside-out sky that
// follows the camera, so it always sits at infinity.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

type Frame = 'equatorial' | 'ecliptic';

let cache: Promise<Float32Array> | null = null;

/** Loads stars-hip.bin: header "HIP1" + count, then per star uint16 ra, int16 dec, uint8 (V+2)*20, int8 (B-V)*50. */
function loadStars(): Promise<Float32Array> {
  if (!cache) {
    cache = fetch('/textures/stars-hip.bin')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('stars ' + r.status))))
      .then((buf) => {
        const dv = new DataView(buf);
        const n = dv.getUint32(4, true);
        const out = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          const o = 8 + i * 6;
          out[i * 4] = (dv.getUint16(o, true) / 65535) * 360;
          out[i * 4 + 1] = (dv.getInt16(o + 2, true) / 32767) * 90;
          out[i * 4 + 2] = dv.getUint8(o + 4) / 20 - 2;
          out[i * 4 + 3] = dv.getInt8(o + 5) / 50;
        }
        return out;
      })
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

/** Approximate star colour from B-V (blackbody-like, slightly desaturated). */
function bvColor(bv: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [-0.4, [0.64, 0.73, 1.0]],
    [0.0, [0.82, 0.87, 1.0]],
    [0.4, [0.97, 0.97, 1.0]],
    [0.65, [1.0, 0.95, 0.86]],
    [1.0, [1.0, 0.86, 0.68]],
    [1.5, [1.0, 0.76, 0.52]],
    [2.0, [1.0, 0.66, 0.42]],
  ];
  if (bv <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (bv <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const f = (bv - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

const vert = /* glsl */ `
attribute float size;
attribute vec3 color;
varying vec3 vColor;
uniform float pxScale;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999; // always at the far plane
  gl_PointSize = size * pxScale;
}`;

const frag = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a *= a;
  gl_FragColor = vec4(vColor * a, a);
}`;

const OBL = (23.4392911 * Math.PI) / 180;

export function Starfield({ frame = 'equatorial', brightness = 1 }: { frame?: Frame; brightness?: number }) {
  const [data, setData] = useState<Float32Array | null>(null);
  const pts = useRef<THREE.Points>(null);
  useEffect(() => {
    let dead = false;
    loadStars()
      .then((d) => !dead && setData(d))
      .catch(() => undefined); // no stars is fine
    return () => {
      dead = true;
    };
  }, []);

  const geo = useMemo(() => {
    if (!data) return null;
    const n = data.length / 4;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const R = 100;
    const ce = Math.cos(OBL);
    const se = Math.sin(OBL);
    for (let i = 0; i < n; i++) {
      const ra = (data[i * 4] * Math.PI) / 180;
      const de = (data[i * 4 + 1] * Math.PI) / 180;
      const v = data[i * 4 + 2];
      let x = Math.cos(de) * Math.cos(ra);
      let y = Math.cos(de) * Math.sin(ra);
      let z = Math.sin(de);
      if (frame === 'ecliptic') {
        const y2 = y * ce + z * se;
        const z2 = -y * se + z * ce;
        y = y2;
        z = z2;
      }
      // scene axes: x, z (north up), -y
      pos[i * 3] = x * R;
      pos[i * 3 + 1] = z * R;
      pos[i * 3 + 2] = -y * R;
      const flux = Math.pow(10, -0.4 * (v - 1.5));
      const b = Math.min(1.6, 0.16 + flux * 0.7) * brightness;
      const c = bvColor(data[i * 4 + 3]);
      col[i * 3] = c[0] * b;
      col[i * 3 + 1] = c[1] * b;
      col[i * 3 + 2] = c[2] * b;
      size[i] = Math.max(1.6, Math.min(6.5, 1.6 + (6.8 - v) * 0.75));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    return g;
  }, [data, frame, brightness]);

  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: { pxScale: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
      }),
    [],
  );
  useEffect(() => () => geo?.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);

  useFrame(({ camera, gl }) => {
    if (pts.current) pts.current.position.copy(camera.position);
    mat.uniforms.pxScale.value = gl.getPixelRatio();
  });

  if (!geo) return null;
  return <points ref={pts} geometry={geo} material={mat} renderOrder={-10} frustumCulled={false} />;
}

// GLSL for the heliocentric view: the Sun's surface and corona, planet
// atmospheres, the comet's coma and tails, and the fading ecliptic grid.

const NOISE = /* glsl */ `
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

export const sunVert = /* glsl */ `
varying vec3 vObj;
varying vec3 vViewN;
void main() {
  vObj = normalize(position);
  vViewN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Granulated photosphere with limb darkening; HDR so that only the Sun passes the bloom threshold. */
export const sunFrag = /* glsl */ `
uniform float uTime;
varying vec3 vObj;
varying vec3 vViewN;
${NOISE}
void main() {
  vec3 p = vObj * 5.0;
  float big = fbm(p * 0.6 + vec3(0.0, uTime * 0.02, uTime * 0.015));
  float gran = fbm(p * 3.2 + vec3(uTime * 0.12, -uTime * 0.08, uTime * 0.05) + big * 2.0);
  float spots = smoothstep(0.66, 0.74, fbm(p * 0.9 + 11.0 + uTime * 0.01));
  float mu = clamp(vViewN.z, 0.0, 1.0);
  float limb = 0.35 + 0.65 * pow(mu, 0.55);
  vec3 hot = vec3(1.0, 0.78, 0.38);
  vec3 warm = vec3(1.0, 0.42, 0.08);
  vec3 col = mix(warm, hot, smoothstep(0.3, 0.75, gran * 0.8 + big * 0.4));
  col *= 1.0 - spots * 0.55;
  col = mix(col * vec3(1.0, 0.7, 0.45), col, mu); // redder limb
  gl_FragColor = vec4(col * limb * 1.8, 1.0);
}`;

export const billboardVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Corona and glow around the Sun: radial falloff broken into slowly turning streamers. */
export const coronaFrag = /* glsl */ `
uniform float uTime;
uniform float uInner; // Sun radius as a fraction of the half size of the quad
varying vec2 vUv;
${NOISE}
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = atan(d.y, d.x);
  float x = max(r - uInner, 0.0) / (1.0 - uInner);
  float rays = fbm(vec3(cos(a) * 2.5, sin(a) * 2.5, uTime * 0.05)) ;
  rays = 0.55 + 0.9 * pow(rays, 2.0);
  float glow = exp(-x * 11.0) * 1.3 * rays + exp(-x * 4.0) * 0.18 + exp(-x * 34.0) * 2.2;
  glow *= smoothstep(1.0, 0.7, r);
  vec3 col = mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.86, 0.62), exp(-x * 6.0));
  gl_FragColor = vec4(col * glow, 1.0);
}`;

export const atmoVert = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** Thin limb glow on the day side (the Sun is at the origin). */
export const atmoFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uPower;
uniform float uStrength;
varying vec3 vN;
varying vec3 vP;
void main() {
  vec3 V = normalize(cameraPosition - vP);
  vec3 L = normalize(-vP);
  float f = pow(1.0 - clamp(dot(vN, V), 0.0, 1.0), uPower);
  float day = smoothstep(-0.25, 0.45, dot(vN, L));
  float a = f * day * uStrength;
  gl_FragColor = vec4(uColor * a, a);
}`;

/** Coma: bright false nucleus inside a soft, slightly green glow. */
export const comaFrag = /* glsl */ `
uniform float uI;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = exp(-r * r * 9.0) * 0.32 + exp(-r * 28.0) * 1.1 + exp(-r * 9.0) * 0.18;
  a *= smoothstep(1.0, 0.75, r);
  vec3 col = mix(vec3(0.55, 0.85, 0.74), vec3(1.0, 0.98, 0.94), exp(-r * 10.0));
  gl_FragColor = vec4(col * a * uI, 1.0);
}`;

/**
 * Tail particles. Each particle flows from the nucleus to the tail end and
 * starts again (seed.x is its phase). Ion tail: straight along the anti-Sun
 * direction. Dust tail: curves back along the orbit (uBend).
 */
export const tailVert = /* glsl */ `
attribute vec4 seed;
uniform float uTime;
uniform float uRate;
uniform vec3 uAnti;
uniform vec3 uVel;
uniform vec3 uSide;
uniform vec3 uLat;
uniform float uL;
uniform float uW;
uniform float uBend;
uniform float uWave;
uniform float uSize;
uniform float uPx;
varying float vA;
varying float vS;
void main() {
  float s = fract(seed.x + uTime * uRate * (0.7 + 0.6 * seed.w));
  float g1 = (seed.y - 0.5) * 2.0;
  float g2 = (seed.z - 0.5) * 2.0;
  g1 = g1 * abs(g1);
  g2 = g2 * abs(g2);
  float spread = uW * (0.12 + s);
  vec3 p = uAnti * uL * s - uVel * uBend * uL * s * s + uSide * g1 * spread * (1.0 + uBend * 1.5) + uLat * g2 * spread;
  p += uSide * sin(s * 14.0 - uTime * 2.2 + seed.w * 6.283) * uWave * uW * s;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vA = pow(1.0 - s, 1.6) * smoothstep(0.0, 0.04, s);
  vS = s;
  float far = clamp(-mv.z / 1.5, 1.0, 6.0); // keep the tail visible from far away
  vA *= sqrt(far);
  gl_PointSize = clamp(uSize * uPx * (0.6 + s * 1.6) / max(-mv.z, 0.001), 1.6, 48.0);
}`;

export const tailFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
varying float vA;
varying float vS;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a = a * a * vA * uI;
  gl_FragColor = vec4(uColor * a, a);
}`;

export const gridVert = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** Ecliptic plane: rings every 1 au and spokes every 30 degrees, fading with distance from the Sun and the camera. */
export const gridFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uMax;
varying vec3 vW;
void main() {
  float r = length(vW.xz);
  float fr = abs(fract(r + 0.5) - 0.5) / max(fwidth(r), 1e-5);
  float ring = 1.0 - min(fr, 1.0);
  float ang = atan(vW.z, vW.x) / (6.2831853 / 12.0);
  float fa = abs(fract(ang + 0.5) - 0.5) / max(fwidth(ang), 1e-5);
  float spoke = (1.0 - min(fa, 1.0)) * 0.45 * smoothstep(0.4, 1.2, r);
  float fill = 0.05 * (1.0 - smoothstep(0.0, uMax, r));
  float a = (max(ring, spoke) + fill) * (1.0 - smoothstep(uMax * 0.55, uMax, r));
  float dc = distance(vW, cameraPosition);
  a *= exp(-dc / (uMax * 2.2));
  gl_FragColor = vec4(uColor, a * uOpacity);
}`;

// Camera for the heliocentric view: eased flights to a body (and back to the
// whole system), following the focused body as it moves, button zoom, and a
// slow cinematic drift when nobody touches the view.
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { PLANETS, SUN_SIZE, bodyEcl, sc, type BodyKey, type OrbitData } from './helio-core';
import { tailLength } from './helio-bodies';

export type HelioView = 'tilt' | 'top' | 'side';

/** Commands from the page to the camera. The page writes, the scene reads every frame. */
export type HelioCtl = {
  focus: BodyKey | null;
  view: HelioView;
  nonce: number; // bump to start a flight to `focus` (or to the whole system with `view`)
  zoom: number; // pending zoom steps: +1 closer, -1 further
  lastInput: number; // performance.now() of the last user input
};

const FLY_S = 1.2;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Radius used for zoom limits and the flight distance. */
export function bodyRadius(k: BodyKey, r = 1) {
  if (k === 'sun') return SUN_SIZE;
  if (k === 'comet') return Math.max(0.03, 0.05 + 0.11 * Math.sqrt(Math.min(2.2, Math.pow(1.7 / Math.max(r, 0.3), 2.2))) * 0.3);
  return PLANETS[k]?.size ?? 0.04;
}

const v0dist = (v: HelioView, R: number) => (v === 'tilt' ? R * 1.85 : R * 2.3);

export function CameraRig({
  data,
  jdRef,
  ctl,
  R,
  hover,
  onFollow,
}: {
  data: OrbitData;
  jdRef: MutableRefObject<number>;
  ctl: MutableRefObject<HelioCtl>;
  R: number;
  /** Body under the pointer, if any: the wheel zooms straight at it. */
  hover: MutableRefObject<BodyKey | null>;
  /** Called when a wheel zoom has come close to a body: the camera follows it from then on. */
  onFollow: (k: BodyKey) => void;
}) {
  const { camera, gl } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const st = useMemo(
    () => ({
      nonce: -1,
      fly: null as null | {
        t: number;
        t0: number;
        fromCam: THREE.Vector3;
        fromTgt: THREE.Vector3;
        dir: THREE.Vector3;
        dist: number;
        key: BodyKey | null;
      },
      last: new THREE.Vector3(),
      hasLast: false,
      zoom: null as null | { t: number; t0: number; from: number; to: number },
      wz: null as null | { P: THREE.Vector3; key: BodyKey | null; f: number },
      focusSeen: undefined as BodyKey | null | undefined,
      p: new THREE.Vector3(),
      tmp: new THREE.Vector3(),
    }),
    [],
  );

  const presetDir = (v: HelioView) =>
    v === 'top' ? new THREE.Vector3(0, 1, 0.0001) : v === 'side' ? new THREE.Vector3(0, 0.02, 1) : new THREE.Vector3(0.32, 0.36, 0.88);

  // camera starts at the angled overview
  useEffect(() => {
    camera.position.copy(
      presetDir('tilt')
        .normalize()
        .multiplyScalar(R * 1.85),
    );
    camera.lookAt(0, 0, 0);
  }, [camera, R]);

  const target = (k: BodyKey | null, out: THREE.Vector3) => (k ? sc(bodyEcl(data, k, jdRef.current), out) : out.set(0, 0, 0));

  // Wheel zoom towards the point under the pointer: a body if one is under it, otherwise the
  // point on the plane of the planets. Camera and orbit centre move together, so repeated
  // zooming lands where the pointer is, not on the Sun. When a body is focused, zoom is
  // straight at it. In 'modifier' mode the page stops plain wheel events before they get here.
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const on = (e: WheelEvent) => {
      const c = controls.current;
      if (!c) return;
      e.preventDefault();
      e.stopPropagation(); // the orbit controls' own wheel zoom is not used
      const s = ctl.current;
      s.lastInput = performance.now();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const f = Math.exp(THREE.MathUtils.clamp(dy, -250, 250) * 0.0022);
      const P = new THREE.Vector3();
      let key: BodyKey | null = null;
      if (s.focus) P.copy(c.target);
      else if (hover.current) {
        key = hover.current;
        target(key, P);
      } else {
        const r = el.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        if (!ray.ray.intersectPlane(plane, P) || P.length() > R * 3) P.copy(c.target);
      }
      st.wz = { P, key, f: (st.wz?.f ?? 1) * f };
      st.zoom = null;
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, R, data]);

  useFrame((_, dtRaw) => {
    const c = controls.current;
    if (!c) return;
    const dt = Math.min(dtRaw, 0.1);
    const s = ctl.current;
    const now = performance.now();

    // new flight request
    if (s.nonce !== st.nonce) {
      st.nonce = s.nonce;
      const k = s.focus;
      const p = target(k, st.p);
      let dir: THREE.Vector3;
      let dist: number;
      if (!k) {
        dir = presetDir(s.view).normalize();
        dist = v0dist(s.view, R);
      } else {
        const toCam = st.tmp.copy(camera.position).sub(p).normalize();
        const r = p.length();
        if (k === 'sun') {
          dir = toCam
            .clone()
            .add(new THREE.Vector3(0, 0.3, 0))
            .normalize();
          dist = SUN_SIZE * 14;
        } else if (k === 'comet') {
          // look at the tails from the side, a little above the plane
          const anti = p.clone().normalize();
          const side = new THREE.Vector3().crossVectors(anti, new THREE.Vector3(0, 1, 0)).normalize();
          if (side.dot(toCam) < 0) side.negate();
          dir = side
            .multiplyScalar(0.85)
            .add(new THREE.Vector3(0, 0.45, 0))
            .sub(anti.multiplyScalar(0.25))
            .normalize();
          dist = Math.max(0.3, tailLength(r) * 1.35);
        } else {
          // from the side, a little sunward, so the lit side and the terminator both show
          const sunward = p.clone().normalize().negate();
          const tangent = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunward).normalize();
          if (tangent.dot(toCam) < 0) tangent.negate();
          dir = sunward.multiplyScalar(0.55).add(tangent.multiplyScalar(0.75)).add(new THREE.Vector3(0, 0.2, 0)).normalize();
          dist = bodyRadius(k) * 9;
        }
      }
      st.fly = { t: 0, t0: now, fromCam: camera.position.clone(), fromTgt: c.target.clone(), dir, dist, key: k };
      st.zoom = null;
      st.hasLast = false;
      st.wz = null;
      c.autoRotate = false;
    }

    // a user drag or wheel cancels the flight (the camera keeps following the focus)
    if (st.fly && s.lastInput > now - 30 && st.fly.t > 0.05) {
      st.fly = null;
      st.hasLast = false;
    }

    if (st.fly) {
      const f = st.fly;
      f.t = Math.min(1, (now - f.t0) / (FLY_S * 1000));
      const e = ease(f.t);
      const p = target(f.key, st.p);
      const endCam = st.tmp.copy(f.dir).multiplyScalar(f.dist).add(p);
      c.target.lerpVectors(f.fromTgt, p, e);
      // arc a little outwards on long flights so the move reads as a swoop
      camera.position.lerpVectors(f.fromCam, endCam, e);
      const lift = Math.sin(Math.PI * e) * Math.min(1.5, f.fromCam.distanceTo(endCam) * 0.12);
      camera.position.y += lift;
      camera.lookAt(c.target);
      if (f.t >= 1) {
        st.fly = null;
        st.hasLast = false;
      }
    } else if (s.focus) {
      // follow the focused body: move camera and target by the body's motion
      const p = target(s.focus, st.p);
      if (st.hasLast) {
        const d = st.tmp.copy(p).sub(st.last);
        camera.position.add(d);
        c.target.add(d);
      }
      st.last.copy(p);
      st.hasLast = true;
      // ease the orbit centre onto the body (after a wheel zoom it starts a little off)
      c.target.lerp(p, 1 - Math.exp(-dt * 2.5));
      if (s.focus === 'comet') c.minDistance = 0.03;
    }

    // a focus set without a flight (wheel zoom close to a body)
    if (s.focus !== st.focusSeen) {
      st.focusSeen = s.focus;
      c.minDistance = s.focus ? bodyRadius(s.focus) * 2.2 : 0.05;
      if (!st.fly) st.hasLast = false;
    }

    // wheel zoom, eased over a few frames
    if (st.wz && !st.fly) {
      const w = st.wz;
      if (w.key) target(w.key, w.P);
      const step = Math.pow(w.f, Math.min(1, dt * 14));
      w.f /= step;
      if (Math.abs(Math.log(w.f)) < 0.002) st.wz = null;
      const dCam = camera.position.distanceTo(w.P);
      const dT = camera.position.distanceTo(c.target);
      const minD = w.key ? bodyRadius(w.key) * 2.4 : s.focus ? c.minDistance : 0.06;
      let k = step;
      if (k < 1 && dCam * k < minD) k = Math.min(1, minD / Math.max(dCam, 1e-6));
      if (k > 1 && dT * k > c.maxDistance) k = Math.max(1, c.maxDistance / Math.max(dT, 1e-6));
      camera.position.sub(w.P).multiplyScalar(k).add(w.P);
      if (!s.focus) c.target.sub(w.P).multiplyScalar(k).add(w.P);
      // close to the body the pointer was on: follow it as it moves
      if (w.key && !s.focus && dCam * k < bodyRadius(w.key) * 30) {
        s.focus = w.key;
        onFollow(w.key);
      }
    }

    // + / - buttons
    if (s.zoom !== 0) {
      const d0 = camera.position.distanceTo(c.target);
      const to = THREE.MathUtils.clamp(d0 * Math.pow(0.6, s.zoom), c.minDistance, c.maxDistance);
      st.zoom = { t: 0, t0: now, from: d0, to };
      s.zoom = 0;
      s.lastInput = now;
    }
    if (st.zoom && !st.fly) {
      const z = st.zoom;
      z.t = Math.min(1, (now - z.t0) / 450);
      const d = z.from + (z.to - z.from) * ease(z.t);
      const dir = st.tmp.copy(camera.position).sub(c.target).normalize();
      camera.position.copy(c.target).add(dir.multiplyScalar(d));
      if (z.t >= 1) st.zoom = null;
    }

    // cinematic drift after a few idle seconds
    c.autoRotate = !st.fly && now - s.lastInput > 4500;
  });

  return (
    <OrbitControls
      ref={controls as never}
      makeDefault
      enableDamping
      dampingFactor={0.07}
      rotateSpeed={0.6}
      zoomSpeed={0.9}
      autoRotateSpeed={0.35}
      minDistance={0.05}
      maxDistance={R * 7}
      onStart={() => (ctl.current.lastInput = performance.now())}
      onEnd={() => (ctl.current.lastInput = performance.now())}
    />
  );
}

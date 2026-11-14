// Optional performance probe for the 3D views, enabled with ?perf=1 in the URL.
// Records per canvas: draw calls, triangles, JS time per frame, frames per
// second, and React renders per second of the components that opt in.
import { useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export const PERF = typeof location !== 'undefined' && /[?&]perf=1\b/.test(location.search);

type Stat = { calls: number; tris: number; ms: number; frames: number; renders: number };
const stats = new Map<string, Stat>();
const get = (name: string) => {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { calls: 0, tris: 0, ms: 0, frames: 0, renders: 0 }));
  return s;
};

/** Counts React renders of the calling component (no-op unless ?perf=1). */
export function useRenderCount(name: string) {
  if (PERF) get(name).renders++;
}

/** Put inside a <Canvas>: measures every rendered frame. */
export function PerfProbe({ name }: { name: string }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    if (!PERF) return;
    gl.info.autoReset = false;
    let t0 = 0;
    const prev = scene.onAfterRender;
    const s = get(name);
    const start = () => {
      t0 = performance.now();
      gl.info.reset();
    };
    scene.onAfterRender = () => {
      s.ms += performance.now() - t0;
      s.frames++;
      s.calls = gl.info.render.calls;
      s.tris = gl.info.render.triangles;
    };
    (scene.userData as { perfStart?: () => void }).perfStart = start;
    return () => {
      scene.onAfterRender = prev;
      gl.info.autoReset = true;
    };
  }, [gl, scene, name]);
  useFrame(({ scene: sc }) => (sc.userData as { perfStart?: () => void }).perfStart?.(), -1000);
  return null;
}

type Row = { name: string; fps: number; ms: number; calls: number; tris: number; renders: number };

/** DOM overlay listing every probe once per second. */
export function PerfOverlay() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const out: Row[] = [];
      stats.forEach((s, name) => {
        out.push({ name, fps: s.frames / dt, ms: s.frames ? s.ms / s.frames : 0, calls: s.calls, tris: s.tris, renders: s.renders / dt });
        s.frames = 0;
        s.ms = 0;
        s.renders = 0;
      });
      (window as unknown as { __w3perf?: Row[] }).__w3perf = out;
      setRows(out);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!PERF) return null;
  return (
    <div className="w3-perf">
      <table>
        <thead>
          <tr>
            <th>view</th>
            <th>fps</th>
            <th>JS ms/frame</th>
            <th>draw calls</th>
            <th>triangles</th>
            <th>React renders/s</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td>{r.fps.toFixed(1)}</td>
              <td>{r.ms.toFixed(2)}</td>
              <td>{r.calls}</td>
              <td>{r.tris}</td>
              <td>{r.renders.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

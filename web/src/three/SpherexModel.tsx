// Interactive SPHEREx observatory model: orbit, hover labels, exploded view and
// the focal plane inset. Default export so pages can React.lazy() it.
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { Group } from 'three';
import { ContactShadows, Environment, Lightformer, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { PARTS, SpherexSpacecraft, type PartId } from './SpherexSpacecraft';
import FocalPlaneInset from './FocalPlaneInset';
import { Still, ThreeGuard, useInView, FORCE_HQ } from './support';
import { usePalette } from './theme';
import { PerfProbe, useRenderCount } from './perf';
import './three.css';

export type SpherexModelProps = {
  /** CSS height of the viewer (default 520px). */
  height?: number | string;
  /** Show the list of parts beside the model (default true). */
  showPartList?: boolean;
  /** Start in the exploded view. */
  initialExploded?: boolean;
  /** Show the focal plane inset from the start. */
  initialFocalPlane?: boolean;
  /** Slow turntable rotation until the visitor drags (default true). */
  autoRotate?: boolean;
  className?: string;
};

const STILL = '/textures/still-spherex.jpg';

export default function SpherexModel(props: SpherexModelProps) {
  const still = (
    <Still
      src={STILL}
      alt="Rendered model of the SPHEREx observatory: three nested cone shaped photon shields above a hexagonal spacecraft body with one solar panel"
      caption="SPHEREx observatory model, 2.6 m tall and 3.2 m across the outer shield."
    />
  );
  return (
    <div className={'w3-root ' + (props.className ?? '')} style={{ height: props.height ?? 520 }}>
      <ThreeGuard still={still} label="model of SPHEREx">
        <ModelView {...props} />
      </ThreeGuard>
    </div>
  );
}

function ModelView({ showPartList = true, initialExploded = false, initialFocalPlane = false, autoRotate = true }: SpherexModelProps) {
  useRenderCount('model');
  const pal = usePalette();
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box);
  const [exploded, setExploded] = useState(initialExploded);
  const [fpa, setFpa] = useState(initialFocalPlane);
  const [hovered, setHovered] = useState<PartId | null>(null);
  const [spin, setSpin] = useState(autoRotate);
  const [resetKey, setResetKey] = useState(0);
  const [zoomOn, setZoomOn] = useState(false);
  const [low, setLow] = useState(false);
  // the turntable stops by itself after a while so an idle viewer costs nothing (demand frame loop)
  useEffect(() => {
    if (!spin) return;
    const id = window.setTimeout(() => setSpin(false), 30000);
    return () => window.clearTimeout(id);
  }, [spin]);
  const active = PARTS.find((p) => p.id === hovered) ?? null;

  return (
    <div className="w3-model" ref={box}>
      <div className="w3-stage">
        <Canvas
          key={resetKey}
          frameloop={inView ? 'demand' : 'never'}
          dpr={low ? 1 : [1, 1.5]}
          shadows
          camera={{ position: [-3.2, 2.9, 5.4], fov: 32, near: 0.05, far: 100 }}
          gl={{ antialias: !low, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
          onPointerMissed={() => setHovered(null)}
        >
          <PerformanceMonitor onDecline={() => setLow(!FORCE_HQ)} onIncline={() => setLow(false)} flipflops={3} />
          <Suspense fallback={null}>
            <PerfProbe name="model" />
            <SpaceEnvironment />
            <ambientLight intensity={0.04} />
            {/* the Sun, from the solar panel side, casting soft shadows */}
            <directionalLight
              position={[-6, 3.5, 2]}
              intensity={3.2}
              color="#fff4e6"
              castShadow
              shadow-mapSize={[1024, 1024]}
              shadow-bias={-0.0004}
              shadow-normalBias={0.02}
              shadow-radius={4}
              shadow-camera-left={-2.5}
              shadow-camera-right={2.5}
              shadow-camera-top={2.5}
              shadow-camera-bottom={-2.5}
            />
            {/* cool rim light from behind, earthshine from below */}
            <directionalLight position={[3, 1.5, -5]} intensity={1.4} color="#9db8ff" />
            <directionalLight position={[1, -5, 1]} intensity={0.35} color="#7fa3d9" />
            <ContactShadows key={exploded ? 'x' : 'a'} position={[0, -1.36, 0]} scale={6} blur={2.6} far={3} opacity={0.45} frames={90} resolution={256} color="#000000" />
            <Spin on={spin} />
            <Fit exploded={exploded}>
              <SpherexSpacecraft
                exploded={exploded}
                hovered={hovered}
                onHover={setHovered}
                interactive
                showLabels
                accent={pal.accent}
                detColors={pal.det}
                shadows={!low}
              />
            </Fit>
            <OrbitControls
              makeDefault
              enablePan={false}
              enableZoom={zoomOn}
              enableDamping
              minDistance={2.5}
              maxDistance={14}
              target={[0, 0, 0]}
              autoRotate={spin}
              autoRotateSpeed={0.6}
              onStart={() => {
                setSpin(false);
                setZoomOn(true);
              }}
            />
          </Suspense>
        </Canvas>

        <div className="w3-toolbar">
          <button
            type="button"
            className="w3-btn"
            aria-pressed={exploded}
            onClick={() => setExploded((v) => !v)}
            data-explain="Pull the parts of SPHEREx apart so you can see the telescope and detectors hidden inside the three cone shaped shields. Press again to put it back together."
          >
            Exploded view
          </button>
          <button
            type="button"
            className="w3-btn"
            aria-pressed={fpa}
            onClick={() => setFpa((v) => !v)}
            data-explain="Show or hide a diagram of the six infrared detectors at the heart of the telescope and the range of wavelengths each one sees."
          >
            Focal plane
          </button>
          <button
            type="button"
            className="w3-btn"
            onClick={() => {
              setResetKey((k) => k + 1);
              setSpin(autoRotate);
            }}
            data-explain="Put the camera back to the starting angle."
          >
            Reset view
          </button>
        </div>

        <div className="w3-caption">
          {zoomOn ? 'Drag to turn, scroll to zoom.' : 'Drag to turn (then scroll to zoom).'} 2.6 m tall, 3.2 m across.
        </div>

        {fpa ? (
          <div className="w3-inset">
            <FocalPlaneInset highlight={null} />
          </div>
        ) : null}
      </div>

      {showPartList ? (
        <aside className="w3-parts" aria-label="Parts of SPHEREx">
          <div className="w3-parts-title">Parts</div>
          <ul>
            {PARTS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={'w3-part' + (hovered === p.id ? ' is-on' : '')}
                  onMouseEnter={() => setHovered(p.id)}
                  onMouseLeave={() => setHovered((h) => (h === p.id ? null : h))}
                  onFocus={() => setHovered(p.id)}
                  onBlur={() => setHovered((h) => (h === p.id ? null : h))}
                  onClick={() => {
                    setHovered(p.id);
                    if (p.id === 'telescope' || p.id === 'fpa') setExploded(true);
                  }}
                  data-explain={`Highlight the ${p.label.toLowerCase()} on the model and read what it does.`}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <p className="w3-part-text">{active ? active.text : 'Point at a part of the model, or at a name here, to read what it does.'}</p>
        </aside>
      ) : null}
    </div>
  );
}

/** Zooms out a little in the exploded view so the lifted shields stay in frame. */
function Fit({ exploded, children }: { exploded: boolean; children: ReactNode }) {
  const g = useRef<Group>(null);
  useFrame(({ invalidate }, dt) => {
    const el = g.current;
    if (!el) return;
    const ts = exploded ? 0.8 : 1;
    const ty = exploded ? -1.5 : -1.3;
    if (Math.abs(el.scale.x - ts) < 1e-3 && Math.abs(el.position.y - ty) < 1e-3) return;
    const k = Math.min(1, dt * 4);
    el.scale.setScalar(el.scale.x + (ts - el.scale.x) * k);
    el.position.y += (ty - el.position.y) * k;
    invalidate();
  });
  return (
    <group ref={g} position={[0, -1.3, 0]}>
      {children}
    </group>
  );
}

/**
 * Reflections for the aluminised shields: a dark sky with a strong warm key
 * (the Sun), a broad blue-grey band below (earthshine) and a few soft strips,
 * rendered once into a cube map. No downloads.
 */
function SpaceEnvironment() {
  return (
    <Environment resolution={128} frames={1} background={false}>
      <color attach="background" args={['#030407']} />
      <Lightformer form="circle" intensity={14} color="#fff2df" position={[-8, 4, 2]} scale={2.2} />
      <Lightformer form="rect" intensity={1.4} color="#3d5d8f" position={[0, -6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[20, 20, 1]} />
      <Lightformer form="rect" intensity={2.2} color="#e8ecf4" position={[4, 2, -6]} scale={[1.2, 9, 1]} />
      <Lightformer form="rect" intensity={1.2} color="#c9d4e6" position={[6, 1, 4]} scale={[0.8, 7, 1]} />
      <Lightformer form="rect" intensity={0.55} color="#8f9bb0" position={[0, 2, 9]} scale={[14, 6, 1]} />
      <Lightformer form="rect" intensity={0.45} color="#6f7a8c" position={[-9, 0, -3]} rotation={[0, Math.PI / 2, 0]} scale={[10, 6, 1]} />
      <Lightformer form="ring" intensity={0.8} color="#a8b4c8" position={[0, 9, 0]} rotation={[Math.PI / 2, 0, 0]} scale={4} />
    </Environment>
  );
}

/** Keeps the demand frame loop running while the turntable spins. */
function Spin({ on }: { on: boolean }) {
  useFrame(({ invalidate }) => {
    if (on) invalidate();
  });
  const invalidate = useThree((st) => st.invalidate);
  useEffect(() => {
    if (on) invalidate();
  }, [on, invalidate]);
  return null;
}

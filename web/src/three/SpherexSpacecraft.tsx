// The SPHEREx observatory built from primitives at true scale (metres).
// Published size: 2.6 m tall, 3.2 m across the outer photon shield (NASA/JPL, PIA25784).
// Layout follows NASA/JPL photos and renders (PIA26543, PIA26531, PIA26537):
// three nested conical photon shields on V-groove radiator discs, a 20 cm
// telescope inside, hexagonal bus below, one fixed solar panel on the side,
// two star trackers and radio antennas on the bus.
// Model axes: +Y is the telescope boresight, -X is the solar panel normal (faces the Sun).
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { DETECTORS } from './theme';

export type PartId = 'outer' | 'middle' | 'inner' | 'vgroove' | 'telescope' | 'fpa' | 'bus' | 'solar' | 'trackers' | 'antennas' | 'adapter';

export type PartInfo = {
  id: PartId;
  label: string;
  text: string;
  anchor: [number, number, number];
  explode: [number, number, number];
};

export const PARTS: PartInfo[] = [
  {
    id: 'outer',
    label: 'Outer photon shield',
    text: 'Largest of three nested aluminium cones, 3.2 m across. Blocks sunlight and earthshine from reaching the telescope.',
    anchor: [1.45, 2.45, 0],
    explode: [0, 0.75, 0],
  },
  {
    id: 'middle',
    label: 'Middle photon shield',
    text: 'Second cone. The gaps between the cones let heat radiate away to cold space.',
    anchor: [-1.2, 2.3, 0.3],
    explode: [0, 0.5, 0],
  },
  {
    id: 'inner',
    label: 'Inner photon shield',
    text: 'Innermost cone around the telescope. Together the shields keep the optics below about minus 210 C without any coolant.',
    anchor: [0.9, 2.05, -0.4],
    explode: [0, 0.27, 0],
  },
  {
    id: 'vgroove',
    label: 'V-groove radiators',
    text: 'Stacked, slightly angled discs under the shields. Each one reflects heat from the bus out sideways into space, stage by stage.',
    anchor: [0.62, 0.7, 0.2],
    explode: [0, 0.1, 0],
  },
  {
    id: 'telescope',
    label: 'Telescope',
    text: '20 cm aperture, all-aluminium three-mirror telescope with a wide 3.5 by 11.3 degree field of view.',
    anchor: [0.05, 1.3, 0],
    explode: [0, 0.2, 0],
  },
  {
    id: 'fpa',
    label: 'Focal plane (6 detectors)',
    text: 'Two arrays of three 2048 by 2048 pixel infrared detectors. A dichroic splits the light: D1 to D3 short-wave, D4 to D6 mid-wave. Each carries a linear variable filter.',
    anchor: [0.3, 0.95, 0.1],
    explode: [0.55, 0.32, 0],
  },
  {
    id: 'bus',
    label: 'Spacecraft bus',
    text: 'Hexagonal body built by BAE Systems (formerly Ball Aerospace) with computer, batteries, radio and reaction wheels.',
    anchor: [0.55, 0.35, 0.35],
    explode: [0, 0, 0],
  },
  {
    id: 'solar',
    label: 'Solar panel',
    text: 'One fixed panel. The whole observatory turns so the panel faces the Sun while the shields face away from it.',
    anchor: [-0.8, 0.95, 0.5],
    explode: [-0.45, 0, 0],
  },
  {
    id: 'trackers',
    label: 'Star trackers',
    text: 'Two small cameras that recognise star patterns to tell the spacecraft exactly where it is pointing.',
    anchor: [0.75, 0.75, -0.15],
    explode: [0.3, 0.05, 0],
  },
  {
    id: 'antennas',
    label: 'Antennas',
    text: 'Radio antennas for commands and science data downlink to ground stations.',
    anchor: [0.35, 0.0, -0.4],
    explode: [0.1, -0.2, -0.1],
  },
  {
    id: 'adapter',
    label: 'Launch adapter ring',
    text: 'Ring that held SPHEREx on the Falcon 9 rocket until separation in March 2025.',
    anchor: [-0.3, 0.02, 0.3],
    explode: [0, -0.3, 0],
  },
];

const SHIELDS: Record<'outer' | 'middle' | 'inner', { rb: number; rt: number; y0: number; y1: number }> = {
  outer: { rb: 0.5, rt: 1.6, y0: 0.72, y1: 2.6 },
  middle: { rb: 0.45, rt: 1.36, y0: 0.74, y1: 2.47 },
  inner: { rb: 0.4, rt: 1.1, y0: 0.76, y1: 2.33 },
};

// ---------------------------------------------------------------------------
// textures and materials
// ---------------------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  if (c) draw(c);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function solarTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = '#0d1420';
    c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) {
        c.fillStyle = (i + j) % 2 ? '#18243a' : '#1a2840';
        c.fillRect(i * 32 + 2, j * 32 + 2, 28, 28);
      }
    c.strokeStyle = '#b9a46a';
    c.lineWidth = 4;
    c.strokeRect(2, 2, 252, 252);
  });
}

/** One detector tile: brightness ramps along the filter direction (short to long wavelength). */
export function detectorTexture(color: string) {
  return canvasTexture(128, 128, (c) => {
    const g = c.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0, '#111');
    g.addColorStop(1, color);
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    for (let x = 8; x < 128; x += 12) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, 128);
      c.stroke();
    }
  });
}

/** Shield panels: vertical seams between aluminised panels plus faint brushing. Used as bump and roughness maps. */
function seamTexture() {
  const t = canvasTexture(512, 128, (c) => {
    c.fillStyle = '#808080';
    c.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 4000; i++) {
      const v = 118 + Math.random() * 20;
      c.fillStyle = `rgb(${v},${v},${v})`;
      c.fillRect(Math.random() * 512, Math.random() * 128, 1, 6 + Math.random() * 30);
    }
    c.fillStyle = '#3a3a3a';
    for (let k = 0; k < 8; k++) c.fillRect(k * 64, 0, 3, 128);
    c.fillRect(0, 62, 512, 2);
  });
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}

/** Crinkled multi-layer insulation blanket (greyscale, tinted by the material colour). */
function mliTexture() {
  const t = canvasTexture(256, 256, (c) => {
    c.fillStyle = '#c8c8c8';
    c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 260; i++) {
      const v = 165 + Math.random() * 90;
      c.fillStyle = `rgba(${v},${v},${v},0.55)`;
      c.beginPath();
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      c.moveTo(x, y);
      for (let k = 0; k < 3; k++) c.lineTo(x + (Math.random() - 0.5) * 70, y + (Math.random() - 0.5) * 70);
      c.closePath();
      c.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** White radiator panel with a fine grid of fasteners. */
function radiatorTexture() {
  return canvasTexture(128, 128, (c) => {
    c.fillStyle = '#e4e3dd';
    c.fillRect(0, 0, 128, 128);
    c.strokeStyle = 'rgba(0,0,0,0.18)';
    c.lineWidth = 1;
    for (let k = 8; k < 128; k += 30) {
      c.beginPath();
      c.moveTo(k, 0);
      c.lineTo(k, 128);
      c.moveTo(0, k);
      c.lineTo(128, k);
      c.stroke();
    }
  });
}

type SharedTex = { seam: THREE.Texture; mli: THREE.Texture; solar: THREE.Texture; radiator: THREE.Texture };
let shared: SharedTex | null = null;
const tex = (): SharedTex => (shared ??= { seam: seamTexture(), mli: mliTexture(), solar: solarTexture(), radiator: radiatorTexture() });

function makeMaterials(lite = false) {
  const t = tex();
  if (lite) return liteMaterials(t);
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  const phys = (o: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(o);
  return {
    // aluminised shields: brushed (anisotropic) metal with panel seams
    shield: phys({
      color: '#d9dbdf',
      metalness: 1,
      roughness: 0.3,
      roughnessMap: t.seam,
      bumpMap: t.seam,
      bumpScale: 1.2,
      anisotropy: 0.75,
      anisotropyRotation: Math.PI / 2,
      side: THREE.DoubleSide,
    }),
    shieldIn: phys({
      color: '#c6c9ce',
      metalness: 1,
      roughness: 0.26,
      roughnessMap: t.seam,
      bumpMap: t.seam,
      bumpScale: 1,
      anisotropy: 0.6,
      anisotropyRotation: Math.PI / 2,
      side: THREE.DoubleSide,
    }),
    alu: phys({ color: '#c9ccd1', metalness: 1, roughness: 0.32, anisotropy: 0.5 }),
    dark: std({ color: '#2a2c30', metalness: 0.4, roughness: 0.5, bumpMap: t.mli, bumpScale: 0.6 }),
    black: std({ color: '#060607', metalness: 0.05, roughness: 0.95, side: THREE.DoubleSide }),
    gold: std({ color: '#e0b155', metalness: 1, roughness: 0.3, bumpMap: t.mli, bumpScale: 2 }),
    white: std({ color: '#ffffff', map: t.radiator, metalness: 0, roughness: 0.7 }),
    solar: phys({ map: t.solar, metalness: 0.3, roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.15 }),
    mirror: std({ color: '#eceef2', metalness: 1, roughness: 0.04 }),
  };
}
/** Cheaper set for small on-screen use: no anisotropy or bump maps, rougher metal (no sparkling glints under bloom). */
function liteMaterials(t: SharedTex) {
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  return {
    shield: std({ color: '#d3d5d9', metalness: 0.9, roughness: 0.45, envMapIntensity: 0.9, side: THREE.DoubleSide }),
    shieldIn: std({ color: '#c0c3c8', metalness: 0.9, roughness: 0.5, envMapIntensity: 0.9, side: THREE.DoubleSide }),
    alu: std({ color: '#c9ccd1', metalness: 0.9, roughness: 0.5, envMapIntensity: 0.9 }),
    dark: std({ color: '#2a2c30', metalness: 0.4, roughness: 0.6 }),
    black: std({ color: '#060607', metalness: 0.05, roughness: 0.95, side: THREE.DoubleSide }),
    gold: std({ color: '#e0b155', metalness: 0.9, roughness: 0.5, envMapIntensity: 0.9 }),
    white: std({ color: '#ffffff', map: t.radiator, metalness: 0, roughness: 0.75 }),
    solar: std({ map: t.solar, metalness: 0.3, roughness: 0.35 }) as THREE.MeshStandardMaterial,
    mirror: std({ color: '#eceef2', metalness: 0.9, roughness: 0.4, envMapIntensity: 0.9 }),
  };
}
type Mats = ReturnType<typeof liteMaterials>;

// ---------------------------------------------------------------------------
// parts
// ---------------------------------------------------------------------------

type PartProps = {
  id: PartId;
  info: PartInfo;
  progress: React.MutableRefObject<number>;
  hovered: PartId | null;
  interactive: boolean;
  ghost?: boolean; // shields turn see-through in the exploded view
  explodedTarget: boolean;
  accent: string;
  onHover?: (id: PartId | null) => void;
  showLabel: boolean;
  children: (m: Mats) => ReactNode;
  lite: boolean;
  glow?: boolean;
};

function Part({
  id,
  info,
  progress,
  hovered,
  interactive,
  ghost,
  explodedTarget,
  accent,
  onHover,
  showLabel,
  children,
  lite,
  glow,
}: PartProps) {
  const g = useRef<THREE.Group>(null);
  const mats = useMemo(() => makeMaterials(lite) as Mats, [lite]);
  const isHot = hovered === id || !!glow;

  const invalidate = useThree((st) => st.invalidate);
  useEffect(() => {
    const acc = new THREE.Color(accent);
    for (const m of Object.values(mats)) {
      m.emissive.copy(isHot ? acc : new THREE.Color(0));
      m.emissiveIntensity = isHot ? 0.3 : 0;
    }
    invalidate();
  }, [isHot, mats, accent, invalidate]);

  useEffect(() => {
    const see = !!ghost && explodedTarget;
    for (const m of [mats.shield, mats.shieldIn]) {
      m.transparent = see;
      m.opacity = see ? 0.22 : 1;
      m.depthWrite = !see;
      m.needsUpdate = true;
    }
    invalidate();
  }, [ghost, explodedTarget, mats, invalidate]);

  useEffect(
    () => () => Object.values(mats).forEach((m) => m.dispose()), // textures are shared, kept for the page's lifetime
    [mats],
  );

  useFrame(() => {
    const p = progress.current;
    g.current?.position.set(info.explode[0] * p, info.explode[1] * p, info.explode[2] * p);
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onHover?.(id);
  };
  const out = () => {
    if (hovered === id) onHover?.(null);
  };
  const noRay = ghost && explodedTarget;
  return (
    <group
      ref={g}
      name={id}
      onPointerOver={interactive && !noRay ? over : undefined}
      onPointerOut={interactive && !noRay ? out : undefined}
    >
      {children(mats)}
      {showLabel && isHot ? (
        <Html position={info.anchor} className="w3-label" zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <strong>{info.label}</strong>
          <span>{info.text}</span>
        </Html>
      ) : null}
    </group>
  );
}

function Shield({ which, m }: { which: 'outer' | 'middle' | 'inner'; m: Mats }) {
  const s = SHIELDS[which];
  const h = s.y1 - s.y0;
  const mat = which === 'outer' ? m.shield : m.shieldIn;
  return (
    <group position={[0, s.y0 + h / 2, 0]}>
      <mesh material={mat}>
        <cylinderGeometry args={[s.rt, s.rb, h, 72, 1, true]} />
      </mesh>
      {/* stiffening ring at the base */}
      <mesh position={[0, -h / 2 + 0.02, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.alu}>
        <torusGeometry args={[s.rb + 0.012, 0.01, 6, 48]} />
      </mesh>
      <mesh position={[0, h / 2, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.alu}>
        <torusGeometry args={[s.rt, 0.012, 6, 96]} />
      </mesh>
    </group>
  );
}

function Tracker({ z, m }: { z: number; m: Mats }) {
  return (
    <group position={[0.5, 0.5, z]} rotation={[0, 0, -0.55]}>
      <mesh material={m.gold} position={[0, 0, 0]}>
        <boxGeometry args={[0.1, 0.08, 0.1]} />
      </mesh>
      <mesh material={m.dark} position={[0, 0.1, 0]}>
        <cylinderGeometry args={[0.045, 0.045, 0.12, 24]} />
      </mesh>
      <mesh material={m.alu} position={[0, 0.21, 0]}>
        <cylinderGeometry args={[0.09, 0.05, 0.11, 24, 1, true]} />
      </mesh>
      <mesh material={m.black} position={[0, 0.21, 0]}>
        <cylinderGeometry args={[0.086, 0.047, 0.108, 24, 1, true]} />
      </mesh>
      {[0.18, 0.22, 0.255].map((y, i) => (
        <mesh key={i} material={m.black} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.055 + i * 0.012, 0.004, 4, 24]} />
        </mesh>
      ))}
    </group>
  );
}

export type SpacecraftProps = {
  exploded?: boolean;
  hovered?: PartId | null;
  onHover?: (id: PartId | null) => void;
  interactive?: boolean;
  showLabels?: boolean;
  accent?: string;
  detColors?: string[];
  /** Cast and receive shadows (enable a shadow-casting light in the scene). */
  shadows?: boolean;
  /** Cheaper materials for small on-screen use (default false). */
  lite?: boolean;
  /** Tint every part with the accent colour (hover feedback). */
  glow?: boolean;
};

/** The observatory as a three.js group, base of the launch ring at y = 0. */
export function SpherexSpacecraft({
  exploded = false,
  hovered = null,
  onHover,
  interactive = false,
  showLabels = false,
  accent = '#d9822b',
  detColors,
  shadows = false,
  lite = false,
  glow = false,
}: SpacecraftProps) {
  const progress = useRef(exploded ? 1 : 0);
  const root = useRef<THREE.Group>(null);
  useFrame(({ invalidate }, dt) => {
    const target = exploded ? 1 : 0;
    const p = progress.current;
    if (p === target) return;
    progress.current = Math.abs(target - p) < 0.002 ? target : p + (target - p) * Math.min(1, dt * 4);
    invalidate(); // keep rendering until the parts have settled (demand frame loop)
  });
  useEffect(() => {
    root.current?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = shadows;
        o.receiveShadow = shadows;
      }
    });
  }, [shadows]);
  const detTex = useMemo(
    () =>
      DETECTORS.map((d, i) =>
        detectorTexture(detColors?.[i] ?? ['#6f8fd6', '#5aa9b8', '#74ad7a', '#c9b45a', '#d08a4a', '#c8675d'][d.det - 1]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detColors?.join(',')],
  );
  useEffect(() => () => detTex.forEach((t) => t.dispose()), [detTex]);

  const common = { progress, hovered, glow, interactive, explodedTarget: exploded, accent, onHover, showLabel: showLabels, lite };
  const info = (id: PartId) => PARTS.find((p) => p.id === id)!;

  return (
    <group ref={root}>
      <Part id="adapter" info={info('adapter')} {...common}>
        {(m) => (
          <mesh material={m.alu} position={[0, 0.045, 0]}>
            <cylinderGeometry args={[0.33, 0.37, 0.09, 48]} />
          </mesh>
        )}
      </Part>

      <Part id="bus" info={info('bus')} {...common}>
        {(m) => (
          <group>
            <mesh material={m.dark} position={[0, 0.335, 0]}>
              <cylinderGeometry args={[0.5, 0.5, 0.5, 6]} />
            </mesh>
            {/* electronics boxes in gold blanket and white radiator plates on the hexagon faces */}
            {[0, 2, 4].map((k) => {
              const a = (k * Math.PI) / 3;
              return (
                <mesh key={k} material={m.gold} position={[Math.cos(a) * 0.45, 0.33, Math.sin(a) * 0.45]} rotation={[0, -a, 0]}>
                  <boxGeometry args={[0.06, 0.26, 0.3]} />
                </mesh>
              );
            })}
            {[1, 3, 5].map((k) => {
              const a = (k * Math.PI) / 3;
              return (
                <mesh key={k} material={m.white} position={[Math.cos(a) * 0.437, 0.36, Math.sin(a) * 0.437]} rotation={[0, -a, 0]}>
                  <boxGeometry args={[0.012, 0.36, 0.42]} />
                </mesh>
              );
            })}
            <mesh material={m.alu} position={[0, 0.595, 0]}>
              <cylinderGeometry args={[0.5, 0.5, 0.03, 6]} />
            </mesh>
          </group>
        )}
      </Part>

      <Part id="vgroove" info={info('vgroove')} {...common}>
        {(m) => (
          <group>
            {[0.625, 0.66, 0.695].map((y, i) => (
              <mesh key={i} material={m.shield} position={[0, y, 0]}>
                <cylinderGeometry args={[0.6 - i * 0.025, 0.5 - i * 0.02, 0.012, 64]} />
              </mesh>
            ))}
            {/* low-conductance struts: V-groove stack to the outer shield */}
            {Array.from({ length: 8 }, (_, k) => {
              const a = (k / 8) * Math.PI * 2 + 0.2;
              const p0 = new THREE.Vector3(Math.cos(a) * 0.56, 0.6, Math.sin(a) * 0.56);
              const p1 = new THREE.Vector3(Math.cos(a + 0.18) * 0.63, 0.9, Math.sin(a + 0.18) * 0.63);
              const mid = p0.clone().add(p1).multiplyScalar(0.5);
              const dir = p1.clone().sub(p0);
              const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
              return (
                <mesh key={'s' + k} material={m.alu} position={mid} quaternion={q}>
                  <cylinderGeometry args={[0.007, 0.007, dir.length(), 6]} />
                </mesh>
              );
            })}
            {/* spacers in the V-groove gaps between the three shields */}
            {Array.from({ length: 12 }, (_, k) => {
              const a = (k / 12) * Math.PI * 2;
              const y = k % 2 ? 1.55 : 1.15;
              const fr = (yy: number, sh: { rb: number; rt: number; y0: number; y1: number }) =>
                sh.rb + ((sh.rt - sh.rb) * (yy - sh.y0)) / (sh.y1 - sh.y0);
              const r0 = fr(y, SHIELDS.inner);
              const r1 = fr(y, SHIELDS.outer);
              return (
                <mesh
                  key={'g' + k}
                  material={m.alu}
                  position={[(Math.cos(a) * (r0 + r1)) / 2, y, (Math.sin(a) * (r0 + r1)) / 2]}
                  rotation={[0, -a, Math.PI / 2]}
                >
                  <cylinderGeometry args={[0.005, 0.005, r1 - r0, 5]} />
                </mesh>
              );
            })}
          </group>
        )}
      </Part>

      <Part id="telescope" info={info('telescope')} {...common}>
        {(m) => (
          <group>
            {/* optical bench with the mirrors */}
            <mesh material={m.alu} position={[-0.04, 0.84, 0]}>
              <boxGeometry args={[0.42, 0.14, 0.34]} />
            </mesh>
            {/* aperture baffle, 20 cm clear aperture */}
            <mesh material={m.alu} position={[-0.06, 1.08, 0]}>
              <cylinderGeometry args={[0.13, 0.13, 0.36, 40, 1, true]} />
            </mesh>
            <mesh material={m.black} position={[-0.06, 1.08, 0]}>
              <cylinderGeometry args={[0.122, 0.122, 0.355, 40, 1, true]} />
            </mesh>
            {/* primary mirror at the bottom of the baffle, seen from above */}
            <mesh material={m.mirror} position={[-0.06, 0.915, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.112, 48]} />
            </mesh>
            <mesh material={m.black} position={[-0.06, 0.912, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.112, 0.124, 48]} />
            </mesh>
            {/* secondary mirror on a three-leg spider */}
            <mesh material={m.mirror} position={[-0.06, 1.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.035, 24]} />
            </mesh>
            {[0, 1, 2].map((k) => {
              const a = (k / 3) * Math.PI * 2;
              return (
                <mesh
                  key={k}
                  material={m.black}
                  position={[-0.06 + Math.cos(a) * 0.078, 1.205, Math.sin(a) * 0.078]}
                  rotation={[0, -a, Math.PI / 2]}
                >
                  <boxGeometry args={[0.004, 0.088, 0.004]} />
                </mesh>
              );
            })}
          </group>
        )}
      </Part>

      <Part id="fpa" info={info('fpa')} {...common}>
        {(m) => (
          <group position={[0.2, 0.86, 0]}>
            <mesh material={m.gold}>
              <boxGeometry args={[0.12, 0.1, 0.2]} />
            </mesh>
            {/* six detector tiles: two rows (SWIR, MWIR) of three */}
            {DETECTORS.map((d, i) => (
              <mesh key={d.det} position={[i < 3 ? -0.028 : 0.028, 0.051, (i % 3) * 0.058 - 0.058]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.05, 0.05]} />
                <meshStandardMaterial map={detTex[i]} roughness={0.4} metalness={0.2} />
              </mesh>
            ))}
          </group>
        )}
      </Part>

      {(['inner', 'middle', 'outer'] as const).map((w) => (
        <Part key={w} id={w} info={info(w)} ghost {...common}>
          {(m) => <Shield which={w} m={m} />}
        </Part>
      ))}

      <Part id="solar" info={info('solar')} {...common}>
        {(m) => (
          <group>
            <mesh material={m.dark} position={[-0.6, 0.4, 0]}>
              <boxGeometry args={[0.22, 0.04, 0.06]} />
            </mesh>
            <mesh position={[-0.73, 0.42, 0]} rotation={[0, -Math.PI / 2, 0]}>
              <boxGeometry args={[1.0, 0.95, 0.025]} />
              <meshStandardMaterial attach="material-0" color="#cfcfcb" />
              <meshStandardMaterial attach="material-1" color="#cfcfcb" />
              <meshStandardMaterial attach="material-2" color="#cfcfcb" />
              <meshStandardMaterial attach="material-3" color="#cfcfcb" />
              <primitive object={m.solar} attach="material-4" />
              <primitive object={m.white} attach="material-5" />
            </mesh>
          </group>
        )}
      </Part>

      <Part id="trackers" info={info('trackers')} {...common}>
        {(m) => (
          <group>
            <Tracker z={0.13} m={m} />
            <Tracker z={-0.13} m={m} />
          </group>
        )}
      </Part>

      <Part id="antennas" info={info('antennas')} {...common}>
        {(m) => (
          <group>
            <mesh material={m.white} position={[0.3, 0.07, -0.22]}>
              <cylinderGeometry args={[0.065, 0.065, 0.025, 24]} />
            </mesh>
            <mesh material={m.dark} position={[0.3, 0.035, -0.22]}>
              <cylinderGeometry args={[0.012, 0.012, 0.05, 8]} />
            </mesh>
            <mesh material={m.white} position={[-0.22, 0.07, 0.24]}>
              <cylinderGeometry args={[0.055, 0.055, 0.02, 24]} />
            </mesh>
            {/* radomes */}
            <mesh material={m.white} position={[0.3, 0.055, -0.22]} rotation={[Math.PI, 0, 0]}>
              <sphereGeometry args={[0.05, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
            </mesh>
            <mesh material={m.white} position={[-0.22, 0.06, 0.24]} rotation={[Math.PI, 0, 0]}>
              <sphereGeometry args={[0.042, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
            </mesh>
          </group>
        )}
      </Part>
    </group>
  );
}

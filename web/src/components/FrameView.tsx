import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CutoutMeta } from '../api';
import { ex } from '../explain';
import { isDecoded } from '../lib/imgcache';

// One square image panel with shared zoom/pan, overlay markers, a pixel scale bar and an N/E compass.
// View coordinates are in image pixels so panels of different on-screen sizes stay in sync.

export interface View {
  s: number;
  tx: number;
  ty: number;
}
export const VIEW0: View = { s: 1, tx: 0, ty: 0 };

export interface Layer {
  src: string;
  visible?: boolean;
  clipLeftPct?: number; // show only the part right of this percentage (swipe)
  key: string;
  /** CD matrix of this image. Each SPHEREx image has its own roll angle, so every layer is
   *  rotated to north up, east left from its own WCS before images are compared. */
  cd?: number[][] | null;
  marks?: Mark[]; // in this image's PNG pixels
  dims?: [number, number];
}

/** 2x2 matrix taking PNG pixel offsets (y down) to a north-up, east-left display. */
export function northUp(cd?: number[][] | null): number[][] | null {
  if (!cd || cd.length !== 2 || cd[0].length !== 2) return null;
  const [[a, b], [c, d]] = cd;
  const s = Math.sqrt(Math.abs(a * d - b * c));
  if (!s || !isFinite(s)) return null;
  return [[-a / s, b / s], [-c / s, d / s]];
}

export interface Mark {
  x: number;
  y: number;
  label?: string;
  color: string;
  r?: number;
  dashed?: boolean;
  strong?: boolean;
}

function clampView(v: View, size: number): View {
  const s = Math.max(1, Math.min(24, v.s));
  const min = -(s - 1) * size;
  return { s, tx: Math.min(0, Math.max(min, v.tx)), ty: Math.min(0, Math.max(min, v.ty)) };
}

export function zoomAbout(v: View, f: number, size: number, ux = size / 2, uy = size / 2): View {
  // Keep the image point currently at (ux, uy) frame coords (image px units) fixed.
  const s2 = Math.max(1, Math.min(24, v.s * f));
  const iu = (ux - v.tx) / v.s, iv = (uy - v.ty) / v.s;
  return clampView({ s: s2, tx: ux - s2 * iu, ty: uy - s2 * iv }, size);
}

const SCALES = [6, 10, 15, 30, 60, 120, 300, 600, 1200]; // arcsec

export default function FrameView(props: {
  layers: Layer[];
  size: number;
  view: View;
  onView: (v: View) => void;
  label?: ReactNode;
  meta?: CutoutMeta | null;
  marks?: Mark[];
  single?: boolean;
  children?: ReactNode;
  status?: string;
  dims?: [number, number]; // real PNG width/height when known (cutouts near a detector edge can be smaller)
}) {
  const { size, view } = props;
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(400);
  const [loaded, setLoaded] = useState<Record<string, 'ok' | 'err'>>({});
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const last = useRef<{ x: number; y: number; d: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(es[0].contentRect.width || 400));
    ro.observe(el);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = r.width / size;
      props.onView(zoomAbout(viewRef.current, e.deltaY < 0 ? 1.2 : 1 / 1.2, size, (e.clientX - r.left) / k, (e.clientY - r.top) / k));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', wheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, props.onView]);

  const k = w / size; // display px per image px at zoom 1

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    last.current = null;
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    const prev = last.current;
    last.current = { x: cx, y: cy, d };
    if (!prev) return;
    let v = { ...viewRef.current, tx: viewRef.current.tx + (cx - prev.x) / k, ty: viewRef.current.ty + (cy - prev.y) / k };
    if (d && prev.d) {
      const r = box.current!.getBoundingClientRect();
      v = zoomAbout(v, d / prev.d, size, (cx - r.left) / k, (cy - r.top) / k);
    }
    props.onView(clampView(v, size));
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    last.current = null;
  };

  // Scale bar
  const pix = props.meta?.pixscale_arcsec || 6.15;
  const arcPerPx = pix / (k * view.s);
  const bar = SCALES.find((a) => a / arcPerPx >= 50) ?? SCALES[SCALES.length - 1];
  const barPx = bar / arcPerPx;
  const barLabel = bar >= 60 ? `${bar / 60} arcmin` : `${bar} arcsec`;

  // Layers with a known WCS are drawn north up, east left, so the compass is fixed for them.
  const firstVisible = props.layers.find((l) => l.visible !== false);
  const oriented = !!northUp(firstVisible?.cd);

  const unit = 1 / (k * view.s); // one screen px in image units
  const stage = { transform: `translate(${view.tx * k}px, ${view.ty * k}px) scale(${view.s})` };
  const anyLoading = props.layers.some((l) => l.visible !== false && !loaded[l.src]);
  const anyErr = props.layers.some((l) => l.visible !== false && loaded[l.src] === 'err');

  return (
    <div
      ref={box}
      className={`frame${props.single ? ' single' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => props.onView(VIEW0)}
      data-explain={ex('compare.viewport')}
    >
      {props.layers.map((l, li) => {
        const M = northUp(l.cd);
        const W = l.dims?.[0] ?? props.dims?.[0] ?? props.meta?.width ?? size;
        const H = l.dims?.[1] ?? props.dims?.[1] ?? props.meta?.height ?? size;
        const ox = W / 2, oy = H / 2;
        const place = (x: number, y: number): [number, number] => (M ? [ox + M[0][0] * (x - ox) + M[0][1] * (y - oy), oy + M[1][0] * (x - ox) + M[1][1] * (y - oy)] : [x, y]);
        const marks = [...(l.marks || []), ...(li === 0 ? props.marks || [] : [])];
        return (
          <div key={l.key} className="stage-clip" style={{ position: 'absolute', inset: 0, clipPath: l.clipLeftPct !== undefined ? `inset(0 0 0 ${l.clipLeftPct}%)` : undefined, visibility: l.visible === false ? 'hidden' : 'visible' }}>
            <div className="stage" style={stage}>
              <div style={{ position: 'absolute', inset: 0, transform: M ? `matrix(${M[0][0]}, ${M[1][0]}, ${M[0][1]}, ${M[1][1]}, 0, 0)` : undefined, transformOrigin: '50% 50%' }}>
                <img src={l.src} alt="" draggable={false} style={{ opacity: loaded[l.src] === 'ok' || isDecoded(l.src) ? 1 : 0 }} onLoad={() => setLoaded((s) => ({ ...s, [l.src]: 'ok' }))} onError={() => setLoaded((s) => ({ ...s, [l.src]: 'err' }))} />
              </div>
              {marks.length > 0 && (
                <svg className="ov" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                  {marks.map((m, i) => {
                    const [x, y] = place(m.x, m.y);
                    return (
                      <g key={i}>
                        <circle cx={x} cy={y} r={m.r ?? 4.5} fill="none" stroke={m.color} strokeWidth={m.strong ? 2.6 : 1.6} strokeDasharray={m.dashed ? '3 3' : undefined} vectorEffect="non-scaling-stroke" />
                        {m.label && (
                          <text x={x + (m.r ?? 4.5) + 2 * unit} y={y - (m.r ?? 4.5)} fill={m.color} fontSize={11 * unit} fontFamily="IBM Plex Mono, monospace" paintOrder="stroke" stroke="rgba(0,0,0,0.85)" strokeWidth={3 * unit}>
                            {m.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>
          </div>
        );
      })}
      {props.label && <div className="lbl">{props.label}</div>}
      {(anyLoading || anyErr || props.status) && (
        <div className="loading">{props.status || (anyErr ? 'Image not available. IRSA may be busy, try again in a moment.' : 'Fetching cutout from IRSA...')}</div>
      )}
      <div className="scale">
        <i style={{ width: barPx }} />
        {barLabel}
      </div>
      {oriented ? (
        <svg className="compass" viewBox="-30 -30 60 60" aria-label="Compass: north is up, east is left">
          <circle r="27" fill="rgba(0,0,0,0.45)" />
          <line x1={0} y1={0} x2={0} y2={-18} stroke="#d9822b" strokeWidth={2} />
          <line x1={0} y1={0} x2={-18} y2={0} stroke="#c8ccd2" strokeWidth={2} />
          <text x={0} y={-21} fill="#d9822b" fontSize="11" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontWeight="600">
            N
          </text>
          <text x={-24} y={4} fill="#c8ccd2" fontSize="11" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontWeight="600">
            E
          </text>
        </svg>
      ) : null}
      {props.children}
    </div>
  );
}

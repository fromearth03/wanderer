// Focal plane diagram: the six SPHEREx detectors and their linear variable
// filters (the wavelength each pixel column sees changes across the detector).
// Plain SVG, no WebGL, safe for every page.
import { useState } from 'react';
import { DETECTORS, usePalette } from './theme';
import './three.css';

export type FocalPlaneInsetProps = {
  /** Highlight one detector (1..6), e.g. the detector of the frame on screen. */
  highlight?: number | null;
  /** Mark a wavelength in micrometres (e.g. the wavelength at the target pixel). */
  markWaveUm?: number | null;
  className?: string;
};

const W = 112; // detector size in the drawing
const GAP = 10;

export default function FocalPlaneInset({ highlight = null, markWaveUm = null, className }: FocalPlaneInsetProps) {
  const pal = usePalette();
  const [cursor, setCursor] = useState<{ det: number; um: number; x: number; y: number } | null>(null);
  const rows = [
    { name: 'Short-wave array (SWIR)', dets: DETECTORS.slice(0, 3) },
    { name: 'Mid-wave array (MWIR)', dets: DETECTORS.slice(3) },
  ];
  const width = 3 * W + 2 * GAP + 20;
  const rowH = W + 44;
  const height = rows.length * rowH + 8;
  return (
    <figure className={'w3-fpa ' + (className ?? '')}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="SPHEREx focal plane: six detectors with linear variable filters">
        <defs>
          {DETECTORS.map((d) => (
            <linearGradient key={d.det} id={`w3-lvf-${d.det}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor={pal.det[d.det - 1]} stopOpacity="0.18" />
              <stop offset="1" stopColor={pal.det[d.det - 1]} stopOpacity="0.95" />
            </linearGradient>
          ))}
        </defs>
        {rows.map((row, r) => {
          const y0 = r * rowH + 18;
          return (
            <g key={row.name}>
              <text x={10} y={y0 - 6} className="w3-svg-label">
                {row.name}
              </text>
              {row.dets.map((d, i) => {
                const x0 = 10 + i * (W + GAP);
                const hot = highlight === d.det;
                const markX =
                  markWaveUm != null && markWaveUm >= d.lo && markWaveUm <= d.hi ? x0 + ((markWaveUm - d.lo) / (d.hi - d.lo)) * W : null;
                return (
                  <g key={d.det}>
                    <rect
                      x={x0}
                      y={y0}
                      width={W}
                      height={W}
                      fill={`url(#w3-lvf-${d.det})`}
                      stroke={hot ? pal.accent : pal.line}
                      strokeWidth={hot ? 2 : 1}
                      onMouseMove={(e) => {
                        const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                        const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
                        setCursor({ det: d.det, um: d.lo + f * (d.hi - d.lo), x: x0 + f * W, y: y0 });
                      }}
                      onMouseLeave={() => setCursor(null)}
                    >
                      <title>{`D${d.det}: ${d.lo.toFixed(2)} to ${d.hi.toFixed(2)} um`}</title>
                    </rect>
                    {/* filter stripes: each column of pixels sees a slightly longer wavelength */}
                    {Array.from({ length: 16 }, (_, k) => (
                      <line
                        key={k}
                        x1={x0 + ((k + 1) * W) / 17}
                        x2={x0 + ((k + 1) * W) / 17}
                        y1={y0 + 1}
                        y2={y0 + W - 1}
                        stroke={pal.bg}
                        strokeOpacity={0.25}
                        pointerEvents="none"
                      />
                    ))}
                    <text x={x0 + 6} y={y0 + 16} className="w3-svg-det" pointerEvents="none">
                      D{d.det}
                    </text>
                    <text x={x0} y={y0 + W + 13} className="w3-svg-num">
                      {d.lo.toFixed(2)}
                    </text>
                    <text x={x0 + W} y={y0 + W + 13} textAnchor="end" className="w3-svg-num">
                      {d.hi.toFixed(2)} um
                    </text>
                    {markX != null ? (
                      <line x1={markX} x2={markX} y1={y0 - 3} y2={y0 + W + 3} stroke={pal.accent} strokeWidth={2} pointerEvents="none" />
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
        {cursor ? (
          <g pointerEvents="none">
            <line x1={cursor.x} x2={cursor.x} y1={cursor.y} y2={cursor.y + W} stroke={pal.text} strokeOpacity={0.7} />
            <text x={Math.min(cursor.x + 4, width - 70)} y={cursor.y + W - 6} className="w3-svg-num w3-svg-strong">
              {cursor.um.toFixed(2)} um
            </text>
          </g>
        ) : null}
      </svg>
      <figcaption>
        Each detector has a linear variable filter: the wavelength changes from left to right, about 17 colour steps per detector, 102 in
        total. A dichroic mirror sends the same patch of sky to both arrays at once.
      </figcaption>
    </figure>
  );
}

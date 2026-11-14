import { useMemo, useState, type MouseEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type Epoch } from '../api';
import { ex } from '../explain';
import { windowsOf } from '../lib/epochs';
import { detColor, fmtDate } from '../lib/format';
import { TARGET_ROUTES, useTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { useWidth } from '../lib/useWidth';
import { useStore } from '../store';

const GAP = 26; // px between survey windows (the months in between are left out)
const ROW = 6; // px per detector row
const TOP = 14;

interface Seg {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
}

/**
 * Persistent strip along the bottom of the app: every SPHEREx image of the
 * current target, one row per detector, survey windows side by side with the
 * gap between them cut out. A and B are marked; click to choose them.
 */
export default function TimeStrip() {
  const loc = useLocation();
  const { target, update, has } = useTarget();
  const show = has && TARGET_ROUTES.includes(loc.pathname);
  const data = useAsync(() => (show ? api.epochs(target.ra!, target.dec!, target.coll) : null), [show, target.ra, target.dec, target.coll]);
  const pick = useStore((s) => s.pickSlot);
  const set = useStore((s) => s.set);
  const [ref, width] = useWidth<HTMLDivElement>(900);
  const [hover, setHover] = useState<Epoch | null>(null);
  const all = data.data?.epochs;

  const segs: Seg[] = useMemo(() => {
    if (!all?.length) return [];
    const wins = windowsOf(all);
    const avail = Math.max(100, width - 16 - GAP * (wins.length - 1));
    const weight = wins.map(([a, b]) => Math.max(1, b - a) ** 0.6 + 0.5);
    const tot = weight.reduce((x, y) => x + y, 0);
    let x = 8;
    return wins.map(([t0, t1], i) => {
      const w = (avail * weight[i]) / tot;
      const seg = { t0: t0 - 0.2, t1: t1 + 0.2, x0: x, x1: x + w };
      x += w + GAP;
      return seg;
    });
  }, [all, width]);

  if (!show) return null;
  const xOf = (mjd: number) => {
    const s = segs.find((g) => mjd >= g.t0 && mjd <= g.t1) ?? segs[0];
    return s ? s.x0 + ((mjd - s.t0) / (s.t1 - s.t0 || 1)) * (s.x1 - s.x0) : 0;
  };
  const yOf = (det: number) => TOP + (det - 1) * ROW;
  const H = TOP + ROW * 6 + 16;

  const nearest = (ev: MouseEvent<SVGSVGElement>): Epoch | null => {
    if (!all?.length) return null;
    const r = ev.currentTarget.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const det = Math.min(6, Math.max(1, Math.floor((py - TOP) / ROW) + 1));
    let best: Epoch | null = null;
    let bd = Infinity;
    for (const e of all) {
      const d = Math.abs(xOf(e.mjd) - px) + (e.det === det ? 0 : 6);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return bd < 24 ? best : null;
  };
  const choose = (e: Epoch) => {
    if (pick === 'A') update({ a: e.id }, undefined, true);
    else update({ b: e.id }, undefined, true);
    set({ pickSlot: pick === 'A' ? 'B' : 'A' });
  };
  const A = all?.find((e) => e.id === target.a);
  const B = all?.find((e) => e.id === target.b);
  const info = hover ?? null;

  return (
    <div className="strip" aria-label="SPHEREx images of the current target">
      <div className="strip-side">
        <div className="strip-title">
          {target.name || `${target.ra!.toFixed(3)}, ${target.dec!.toFixed(3)}`}
          <span className="muted"> {data.data ? `${data.data.count} images` : data.loading ? 'loading' : ''}</span>
        </div>
        <div className="strip-pick" role="group" aria-label="Which image a click sets">
          <span className="muted">Click sets</span>
          <button type="button" aria-pressed={pick === 'A'} onClick={() => set({ pickSlot: 'A' })} data-explain={ex('strip.slot')}>
            A
          </button>
          <button type="button" aria-pressed={pick === 'B'} onClick={() => set({ pickSlot: 'B' })} data-explain={ex('strip.slot')}>
            B
          </button>
        </div>
        <div className="strip-info mono">{info ? `D${info.det} ${fmtDate(info.date)}` : A && B ? `A ${fmtDate(A.date, false)}  B ${fmtDate(B.date, false)}` : ''}</div>
      </div>
      <div className="strip-chart" ref={ref}>
        {all && all.length > 0 ? (
          <svg
            width={width}
            height={H}
            role="img"
            aria-label="Image dates by detector"
            onClick={(ev) => {
              const e = nearest(ev);
              if (e) choose(e);
            }}
            onMouseMove={(ev) => setHover(nearest(ev))}
            onMouseLeave={() => setHover(null)}
            data-explain={ex('strip.chart')}
          >
            {segs.map((g, i) => (
              <g key={i}>
                <rect className="strip-seg" x={g.x0} y={TOP - 2} width={g.x1 - g.x0} height={ROW * 6 + 4} />
                <text x={g.x0} y={H - 3}>
                  {fmtDate(g.t0 + 0.2, false)}
                </text>
                {g.x1 - g.x0 > 150 && (
                  <text x={g.x1} y={H - 3} textAnchor="end">
                    {fmtDate(g.t1 - 0.2, false)}
                  </text>
                )}
                {i > 0 && (
                  <text className="strip-gap" x={g.x0 - GAP / 2} y={TOP + ROW * 3 + 3} textAnchor="middle">
                    //
                  </text>
                )}
              </g>
            ))}
            {all.map((e) => (
              <line key={e.id} x1={xOf(e.mjd)} x2={xOf(e.mjd)} y1={yOf(e.det)} y2={yOf(e.det) + ROW - 1} stroke={detColor(e.det)} strokeWidth={1.7} />
            ))}
            {hover && <line className="strip-hover" x1={xOf(hover.mjd)} x2={xOf(hover.mjd)} y1={TOP - 4} y2={TOP + ROW * 6 + 2} />}
            {[A, B].map((e, i) =>
              e ? (
                <g key={i} className="strip-mark">
                  <line x1={xOf(e.mjd)} x2={xOf(e.mjd)} y1={TOP - 4} y2={TOP + ROW * 6 + 2} strokeDasharray={i === 1 ? '2 2' : undefined} />
                  <text x={xOf(e.mjd)} y={TOP - 5} textAnchor="middle">
                    {i === 0 ? 'A' : 'B'}
                  </text>
                </g>
              ) : null,
            )}
          </svg>
        ) : (
          <div className="strip-empty muted">{data.loading ? 'Asking IRSA for every SPHEREx image of this spot...' : data.error ? data.error : 'No SPHEREx images here.'}</div>
        )}
      </div>
    </div>
  );
}

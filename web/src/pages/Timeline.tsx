import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, type CutoutMeta, type Epoch } from '../api';
import { Chip, ErrorBox, Note, PanelHead, Segmented, SideHead } from '../components/ui';
import { targetKey, useStore } from '../store';
import { NoTarget } from '../components/NoTarget';
import { ex } from '../explain';
import { bandText, bestPair, midWave, windowsOf } from '../lib/epochs';
import { DET_RANGES, detColor, fmtDate, um } from '../lib/format';
import { useTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';

export { useWidth } from '../lib/useWidth';
import { useWidth } from '../lib/useWidth';

export function useMeta(id: string, ra: number | null, dec: number | null, size = 200) {
  return useAsync<CutoutMeta>(() => (id && ra !== null && dec !== null ? api.meta(id, ra, dec, size) : null), [id, ra, dec, size]);
}

const FocalPlaneInset = lazy(() => import('../three/FocalPlaneInset'));

const WAVE_MIN = 0.7, WAVE_MAX = 5.2;
const NO_WAVES: Record<string, number> = {};

export default function Timeline() {
  const { target, update, has } = useTarget();
  const data = useAsync(() => (has ? api.epochs(target.ra!, target.dec!, target.coll) : null), [target.ra, target.dec, target.coll]);
  const dets = useStore((s) => s.dets);
  const pick = useStore((s) => s.pickSlot);
  const set = useStore((s) => s.set);
  const setDets = (f: (d: boolean[]) => boolean[]) => set({ dets: f(dets) });
  const setPick = (p: 'A' | 'B') => set({ pickSlot: p });
  const tk = targetKey(target);
  const waves = useStore((s) => (s.wavesFor === tk ? s.waves : NO_WAVES));
  const setWavesFor = useStore((s) => s.setWaves);
  const autoPair = useStore((s) => s.autoPair);
  const [range, setRange] = useState('all');
  const [ref, width] = useWidth<HTMLDivElement>();
  const all = data.data?.epochs || [];
  const shown = all.filter((e) => dets[e.det - 1]);
  const windows = useMemo(() => windowsOf(all), [all]);
  const A = all.find((e) => e.id === target.a);
  const B = all.find((e) => e.id === target.b);
  const metaA = useMeta(target.a, target.ra, target.dec);
  const metaB = useMeta(target.b, target.ra, target.dec);
  const [scan, setScan] = useState<{ done: number; total: number; running: boolean } | null>(null);
  const scanAlive = useRef(true);
  useEffect(() => {
    scanAlive.current = true;
    return () => {
      scanAlive.current = false;
    };
  }, []);
  useEffect(() => setScan(null), [target.ra, target.dec, target.coll]);
  useEffect(() => {
    if (all.length) autoPair(all);
  }, [all, autoPair]);
  const waveOf = (e: Epoch) => waves[e.id] ?? (e.id === target.a ? metaA.data?.wave_um_at_target : e.id === target.b ? metaB.data?.wave_um_at_target : undefined);

  if (!has) return <NoTarget title="Timeline" />;

  const choose = (e: Epoch) => {
    if (pick === 'A') {
      update({ a: e.id }, undefined, true);
      setPick('B');
    } else {
      update({ b: e.id }, undefined, true);
      setPick('A');
    }
  };
  const measure = async () => {
    const todo = shown.filter((e) => waves[e.id] === undefined);
    if (!todo.length) return;
    let done = 0;
    setScan({ done, total: todo.length, running: true });
    const queue = [...todo];
    const worker = async () => {
      while (queue.length && scanAlive.current) {
        const e = queue.shift()!;
        try {
          const m = await api.meta(e.id, target.ra!, target.dec!, 32);
          if (isFinite(m.wave_um_at_target)) setWavesFor(tk, { [e.id]: m.wave_um_at_target });
        } catch {
          /* skip this one */
        }
        done++;
        if (scanAlive.current) setScan({ done, total: todo.length, running: queue.length > 0 || done < todo.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (scanAlive.current) setScan({ done, total: todo.length, running: false });
  };
  const auto = (kind: 'short' | 'long') => {
    const p = bestPair(shown.length >= 2 ? shown : all, kind, waves);
    if (p) update({ a: p[0].id, b: p[1].id, pair: kind, pairSource: 'auto' }, undefined, true);
  };

  // ---- chart geometry ----
  const H = width < 600 ? 300 : 360;
  const m = { l: 48, r: 14, t: 26, b: 34 };
  let t0 = all.length ? all[0].mjd : 60800, t1 = all.length ? all[all.length - 1].mjd : 61040;
  if (range !== 'all') {
    const w = windows[parseInt(range, 10)];
    if (w) [t0, t1] = w;
  }
  const pad = Math.max(0.6, (t1 - t0) * 0.04);
  t0 -= pad;
  t1 += pad;
  const x = (mjd: number) => m.l + ((mjd - t0) / (t1 - t0)) * (width - m.l - m.r);
  const ly = (w: number) => Math.log(w);
  const y = (w: number) => m.t + (1 - (ly(w) - ly(WAVE_MIN)) / (ly(WAVE_MAX) - ly(WAVE_MIN))) * (H - m.t - m.b);
  const ticks: number[] = [];
  {
    const span = t1 - t0;
    const step = span > 150 ? 30 : span > 40 ? 7 : span > 10 ? 2 : 1;
    const start = new Date((t0 - 40587) * 86400000);
    start.setUTCHours(0, 0, 0, 0);
    if (step === 30) start.setUTCDate(1);
    let d = start.getTime() / 86400000 + 40587;
    while (d < t1) {
      if (d > t0) ticks.push(d);
      if (step === 30) {
        const dt = new Date((d - 40587) * 86400000);
        dt.setUTCMonth(dt.getUTCMonth() + 1);
        d = dt.getTime() / 86400000 + 40587;
      } else d += step;
    }
  }
  const visible = shown.filter((e) => e.mjd >= t0 && e.mjd <= t1);

  return (
    <div className="view">
      <div className="stage">
      {data.error && <ErrorBox message={data.error} onRetry={data.retry} />}
          <section className="panel">
            <PanelHead title={`${data.data ? data.data.count : '...'} images, ${target.coll === 'spherex_dr1_deep' ? 'deep fields' : 'all-sky survey'}`}>
              <div className="row" style={{ gap: 6 }}>
                {[1, 2, 3, 4, 5, 6].map((d) => (
                  <Chip key={d} pressed={dets[d - 1]} onClick={() => setDets((s) => s.map((v, i) => (i === d - 1 ? !v : v)))} explain={ex('timeline.det')} color={detColor(d)}>
                    D{d}
                  </Chip>
                ))}
              </div>
            </PanelHead>
            <div className="row" style={{ marginBottom: 10 }}>
              <Segmented
                label="Time range"
                value={range}
                onChange={setRange}
                options={[
                  { value: 'all', label: 'Whole mission', explain: ex('timeline.zoomWindow') },
                  ...windows.slice(0, 6).map((_w, i) => ({ value: String(i), label: `Window ${i + 1}`, explain: ex('timeline.zoomWindow') })),
                ]}
              />
            </div>
            <div ref={ref} data-explain={ex('timeline.chart')}>
              {data.loading && !data.data ? (
                <div className="empty">
                  <span className="spinner" style={{ display: 'inline-block' }} /> Asking IRSA for every SPHEREx image of this spot...
                </div>
              ) : (
                <svg className="tl-svg" width={width} height={H} role="img" aria-label="Timeline of SPHEREx images: date versus wavelength">
                  {range === 'all' &&
                    windows.map((w, i) => (
                      <g key={i}>
                        <rect className="win" x={x(w[0]) - 4} y={m.t - 18} width={Math.max(8, x(w[1]) - x(w[0]) + 8)} height={H - m.t - m.b + 18} rx={4} />
                        <text className="wintext" x={x(w[0]) > width - 160 ? x(w[1]) + 4 : x(w[0]) - 2} y={m.t - 6} textAnchor={x(w[0]) > width - 160 ? 'end' : 'start'}>
                          {windows.length <= 3 ? `Survey window ${i + 1}` : `W${i + 1}`}
                        </text>
                      </g>
                    ))}
                  {range === 'all' && windows.length === 2 && x(windows[1][0]) - x(windows[0][1]) > 120 && (
                    <g>
                      <line x1={x(windows[0][1]) + 10} x2={x(windows[1][0]) - 10} y1={H - m.b - 14} y2={H - m.b - 14} stroke="var(--text-3)" strokeDasharray="3 4" />
                      <text x={(x(windows[0][1]) + x(windows[1][0])) / 2} y={H - m.b - 20} textAnchor="middle" style={{ fill: 'var(--text-2)' }}>
                        {Math.round(windows[1][0] - windows[0][1])} days later, same sky again
                      </text>
                    </g>
                  )}
                  {[0.75, 1, 1.5, 2, 3, 4, 5].map((w) => (
                    <g key={w}>
                      <line className="gl" x1={m.l} x2={width - m.r} y1={y(w)} y2={y(w)} />
                      <text x={m.l - 6} y={y(w) + 3} textAnchor="end">
                        {w}
                      </text>
                    </g>
                  ))}
                  <text x={10} y={m.t + (H - m.t - m.b) / 2} transform={`rotate(-90 10 ${m.t + (H - m.t - m.b) / 2})`} textAnchor="middle">
                    wavelength at target (micron)
                  </text>
                  {[1, 2, 3, 4, 5, 6].map((d) => (
                    <rect key={d} x={m.l - 3} width={3} y={y(DET_RANGES[d][1])} height={y(DET_RANGES[d][0]) - y(DET_RANGES[d][1])} fill={detColor(d)} />
                  ))}
                  <line className="ax" x1={m.l} x2={width - m.r} y1={H - m.b} y2={H - m.b} />
                  {ticks.map((t) => (
                    <g key={t}>
                      <line className="ax" x1={x(t)} x2={x(t)} y1={H - m.b} y2={H - m.b + 4} />
                      <text x={x(t)} y={H - m.b + 16} textAnchor="middle">
                        {fmtDate(t, false).slice(t1 - t0 > 150 ? 0 : 5, t1 - t0 > 150 ? 7 : 10)}
                      </text>
                    </g>
                  ))}
                  {visible.map((e) => {
                    const cx = x(e.mjd);
                    const isA = e.id === target.a, isB = e.id === target.b;
                    const wv = waveOf(e);
                    const cy = y(wv ?? midWave(e));
                    return (
                      <g
                        key={e.id}
                        className="pt"
                        role="button"
                        tabIndex={0}
                        aria-label={`D${e.det} ${fmtDate(e.date)} ${um(wv ?? midWave(e))}`}
                        onClick={() => choose(e)}
                        onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && choose(e)}
                        data-explain={ex('timeline.point')}
                      >
                        <title>{`D${e.det}  ${fmtDate(e.date)}  ${wv !== undefined ? `${um(wv)} at target` : `band ${um(e.em_min_um)} to ${um(e.em_max_um)}`}`}</title>
                        <line x1={cx} x2={cx} y1={y(e.em_max_um)} y2={y(e.em_min_um)} stroke={detColor(e.det)} strokeWidth={2} opacity={0.55} />
                        <circle className="mk" cx={cx} cy={cy} r={isA || isB ? 5 : wv !== undefined ? 4 : 3.2} fill={wv !== undefined ? detColor(e.det) : 'var(--panel-solid)'} stroke={detColor(e.det)} strokeWidth={1.6} />
                        <circle cx={cx} cy={cy} r={9} fill="transparent" />
                        {isA && <circle className="sel-a" cx={cx} cy={cy} r={8.5} />}
                        {isB && <circle className="sel-b" cx={cx} cy={cy} r={8.5} />}
                        {isA && (
                          <text className="tag" x={cx + 10} y={cy - 8} style={{ fill: 'var(--accent)' }}>
                            A
                          </text>
                        )}
                        {isB && (
                          <text className="tag" x={cx + 10} y={cy - 8} style={{ fill: 'var(--accent)' }}>
                            B
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>
            {data.data && data.data.count === 0 && <Note warn>No SPHEREx images cover this exact point in this collection.</Note>}
            <div className="row" style={{ marginTop: 10, fontSize: 12.5 }}>
              <span className="muted">
                Hollow marks sit at the centre of their detector band. Filled marks show the exact wavelength measured at your target.
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn-sm" onClick={measure} disabled={!shown.length || !!scan?.running} data-explain={ex('timeline.measure')}>
                {scan?.running ? `Measuring ${scan.done}/${scan.total}...` : `Measure wavelengths (${shown.filter((e) => waves[e.id] === undefined).length} images)`}
              </button>
            </div>
            {scan?.running && (
              <div className="progress" style={{ marginTop: 8 }}>
                <i style={{ width: `${(100 * scan.done) / Math.max(1, scan.total)}%` }} />
              </div>
            )}
          </section>

          <section className="panel">
            <PanelHead title={shown.length > 400 ? `Image list (first 400 of ${shown.length})` : 'Image list'} />
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Detector</th>
                    <th>Date (UTC)</th>
                    <th>MJD</th>
                    <th>Wavelength</th>
                    <th>Exposure</th>
                    <th>Pick</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 400).map((e, i) => (
                    <tr key={e.id} className={e.id === target.a || e.id === target.b ? 'sel' : ''} onClick={() => choose(e)} data-explain={ex('timeline.row')} style={{ cursor: 'pointer' }}>
                      <td className="muted">{i + 1}</td>
                      <td>
                        <i className="det-dot" style={{ background: detColor(e.det) }} /> D{e.det}
                      </td>
                      <td>{fmtDate(e.date)}</td>
                      <td>{e.mjd.toFixed(3)}</td>
                      <td>{waves[e.id] !== undefined ? `${um(waves[e.id])} at target` : `band ${e.em_min_um.toFixed(2)} to ${e.em_max_um.toFixed(2)} \u00b5m`}</td>
                      <td>{e.exptime ? `${e.exptime.toFixed(0)} s` : ''}</td>
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>{e.id === target.a ? 'A' : e.id === target.b ? 'B' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
      </div>

        <aside className="side">
          <SideHead title="Timeline" sub="Every time SPHEREx photographed this spot. Each mark is one image. Pick image A and image B to compare." />
          <section className="sect">
            <PanelHead title="Your pair" />
            <div className="pickbox">
              <button type="button" className={`pick a${pick === 'A' ? ' active' : ''}`} onClick={() => setPick('A')} data-explain={ex('timeline.pickA')}>
                <div className="pl">Image A {pick === 'A' ? '(picking)' : ''}</div>
                <div className="pd">{A ? <EpochLine e={A} wave={metaA.data?.wave_um_at_target} /> : 'Click a mark'}</div>
              </button>
              <button type="button" className={`pick b${pick === 'B' ? ' active' : ''}`} onClick={() => setPick('B')} data-explain={ex('timeline.pickB')}>
                <div className="pl">Image B {pick === 'B' ? '(picking)' : ''}</div>
                <div className="pd">{B ? <EpochLine e={B} wave={metaB.data?.wave_um_at_target} /> : 'Click a mark'}</div>
              </button>
            </div>
            {A && B && (
              <p className="mono" style={{ fontSize: 12, color: 'var(--text-2)', margin: '10px 0 0' }}>
                Gap {Math.abs(B.mjd - A.mjd) < 2 ? `${(Math.abs(B.mjd - A.mjd) * 24).toFixed(1)} hours` : `${Math.abs(B.mjd - A.mjd).toFixed(1)} days`}
                {metaA.data && metaB.data && `, wavelength differs by ${Math.abs(metaA.data.wave_um_at_target - metaB.data.wave_um_at_target).toFixed(3)} µm`}
              </p>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-sm" onClick={() => auto('short')} disabled={all.length < 2} data-explain={ex('timeline.auto')}>
                Best pair: next day
              </button>
              <button type="button" className="btn btn-sm" onClick={() => auto('long')} disabled={all.length < 2} data-explain={ex('timeline.auto')}>
                Best pair: 6 months
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => update({ a: target.b, b: target.a }, undefined, true)} disabled={!A || !B} data-explain={ex('timeline.swap')}>
                Swap
              </button>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary" disabled={!A || !B} onClick={() => update({ mode: 'blink' }, '/compare')} data-explain={ex('timeline.compare')}>
                Compare A and B
              </button>
              <button type="button" className="btn" disabled={!all.length} onClick={() => update({ mode: 'flip', det: A?.det ?? null }, '/compare')} data-explain={ex('timeline.flipbook')}>
                Flipbook
              </button>
            </div>
          </section>

          <section className="sect prose-sm">
            <PanelHead title="Why the colour changes" />
            <LvfDiagram a={A} b={B} waveA={metaA.data?.wave_um_at_target} waveB={metaB.data?.wave_um_at_target} />
            <Suspense fallback={null}>
              <FocalPlaneInset highlight={A?.det ?? null} markWaveUm={metaA.data?.wave_um_at_target ?? null} />
            </Suspense>
            <p>
              Each SPHEREx detector sits behind a <b>linear variable filter</b>: a strip of glass whose colour changes smoothly from one edge to the other. Where your target lands on the detector decides which infrared wavelength it is seen at. On the next visit the
              spacecraft points slightly differently, so the same star can be seen at another wavelength, even with the same detector.
            </p>
            <p>
              For a fair blink, choose two images whose wavelengths at the target are close. Otherwise a star may look brighter or fainter just because of its colour. The best pair buttons do this for you.
            </p>
          </section>
        </aside>
    </div>
  );
}

function EpochLine({ e, wave }: { e: Epoch; wave?: number }) {
  return (
    <>
      <span style={{ color: detColor(e.det) }}>D{e.det}</span> {fmtDate(e.date)}
      <br />
      {wave !== undefined ? `${um(wave)} at target` : bandText(e)}
    </>
  );
}

export function LvfDiagram({ a, b, waveA, waveB }: { a?: Epoch; b?: Epoch; waveA?: number; waveB?: number }) {
  const det = a?.det ?? b?.det ?? 1;
  const [lo, hi] = DET_RANGES[det];
  const W = 300, H = 74;
  const px = (w: number) => 10 + ((w - lo) / (hi - lo)) * (W - 20);
  const wa = waveA ?? (a ? midWave(a) : undefined);
  const wb = waveB ?? (b && b.det === det ? midWave(b) : undefined);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Linear variable filter diagram">
      <defs>
        <linearGradient id="lvfg" x1="0" x2="1">
          <stop offset="0" stopColor="var(--d1)" />
          <stop offset="0.5" stopColor="var(--d4)" />
          <stop offset="1" stopColor="var(--d6)" />
        </linearGradient>
      </defs>
      <rect x={10} y={18} width={W - 20} height={22} rx={2} fill="url(#lvfg)" opacity={0.55} />
      <text x={10} y={12} style={{ fill: 'var(--muted)', font: '10px var(--mono)' }}>
        Detector D{det}: {lo} {'µm'}
      </text>
      <text x={W - 10} y={12} textAnchor="end" style={{ fill: 'var(--muted)', font: '10px var(--mono)' }}>
        {hi} {'µm'}
      </text>
      {wa !== undefined && wa >= lo && wa <= hi && (
        <g>
          <line x1={px(wa)} x2={px(wa)} y1={14} y2={46} stroke="var(--accent)" strokeWidth={2.5} />
          <text x={px(wa)} y={60} textAnchor="middle" style={{ fill: 'var(--accent)', font: '600 10.5px var(--mono)' }}>
            A {wa.toFixed(3)}
          </text>
        </g>
      )}
      {wb !== undefined && wb >= lo && wb <= hi && (
        <g>
          <line x1={px(wb)} x2={px(wb)} y1={14} y2={46} stroke="var(--text)" strokeWidth={2} strokeDasharray="3 2" />
          <text x={px(wb)} y={72} textAnchor="middle" style={{ fill: 'var(--text)', font: '600 10.5px var(--mono)' }}>
            B {wb.toFixed(3)}
          </text>
        </g>
      )}
    </svg>
  );
}

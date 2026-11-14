import { useEffect, useMemo } from 'react';
import { normSpectrum, type SpectrumResult } from '../api';
import { NoTarget } from '../components/NoTarget';
import { ErrorBox, JobBar, Note, PanelHead, SideHead, Slider, Toggle } from '../components/ui';
import { ex } from '../explain';
import { DET_RANGES, detColor, fmtDate } from '../lib/format';
import { useTarget } from '../lib/target';
import { isRunning, spectrumKey, useJobEntry, useStore } from '../store';
import { useWidth } from './Timeline';

const FEATURES = [
  { w: 1.282, n: 'Paβ' },
  { w: 1.875, n: 'Paα' },
  { w: 2.166, n: 'Brγ' },
  { w: 3.05, n: 'H₂O ice' },
  { w: 3.29, n: 'PAH' },
  { w: 4.05, n: 'Brα' },
  { w: 4.27, n: 'CO₂ ice' },
  { w: 4.67, n: 'CO ice' },
];

export default function Spectrum() {
  const { target, has } = useTarget();
  const max = useStore((s) => s.spectrumMax);
  const log = useStore((s) => s.spectrumLog);
  const lines = useStore((s) => s.spectrumLines);
  const set = useStore((s) => s.set);
  const runJob = useStore((s) => s.runJob);
  const params = has ? { ra: target.ra!, dec: target.dec!, coll: target.coll, max } : null;
  const key = params ? spectrumKey(params) : null;
  const entry = useJobEntry(key);
  const running = isRunning(entry);
  const [ref, width] = useWidth<HTMLDivElement>();
  // Finished result, or the points measured so far while the job runs.
  const res: SpectrumResult | null = useMemo(
    () => (entry?.result !== undefined ? normSpectrum(entry.result) : entry?.partial?.length ? normSpectrum({ points: entry.partial, unit: 'mJy' }) : null),
    [entry?.result, entry?.partial],
  );
  // Links from showcase cards carry auto=1: open the (usually already saved) spectrum at once.
  // The gateway answers instantly when this exact spectrum was built before.
  const auto = typeof location !== 'undefined' && new URLSearchParams(location.search).get('auto') === '1';
  useEffect(() => {
    if (auto && params && !entry) runJob('spectrum', params, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, key]);
  if (!has || !params) return <NoTarget title="Spectrum" />;

  const run = (force = false) => runJob('spectrum', params, force);
  const pts = res?.points || [];
  const partialOnly = entry?.result === undefined && !!res;
  const H = width < 600 ? 300 : 400;
  const m = { l: 56, r: 16, t: 28, b: 40 };
  const x = (w: number) => m.l + ((w - 0.7) / (5.1 - 0.7)) * (width - m.l - m.r);
  const vals = pts.flatMap((p) => [p.flux - p.err, p.flux + p.err]);
  let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
  if (log) lo = Math.max(lo, Math.max(1e-3, hi * 1e-3));
  const pad = (hi - lo) * 0.08 || 1;
  const f = (v: number) => (log ? Math.log10(Math.max(v, lo)) : v);
  const y0 = log ? f(lo) : lo - pad, y1 = log ? f(hi) + 0.05 : hi + pad;
  const y = (v: number) => m.t + (1 - (f(v) - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const yTicks = Array.from({ length: 5 }, (_, i) => (log ? Math.pow(10, y0 + ((y1 - y0) * i) / 4) : y0 + ((y1 - y0) * i) / 4));
  const title = res ? `${pts.length} good measurements${partialOnly ? ' so far' : res.used ? ` of ${res.used} images` : ''}` : 'Spectrum';

  return (
    <div className="view">
      <aside className="side">
        <SideHead title="Spectrum" sub="Brightness of the target at each infrared wavelength, measured in many SPHEREx images." />
        <section className="sect">
          <PanelHead title="Build" />
          <Slider label="Images to measure" value={max} min={10} max={120} step={10} onChange={(v) => set({ spectrumMax: v })} explain={ex('spectrum.max')} />
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" onClick={() => run(!!entry && !running)} disabled={running} data-explain={ex('spectrum.run')}>
              {running ? 'Measuring...' : entry?.result !== undefined ? 'Build again' : 'Build spectrum'}
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            <JobBar status={entry} />
            {entry?.error && <ErrorBox message={entry.error} onRetry={() => run(true)} />}
          </div>
          <Note>The job keeps running if you open another page. Finished spectra are saved, so coming back is instant. Build again measures everything afresh.</Note>
        </section>
        <section className="sect">
          <PanelHead title="Display" />
          <div className="stack" style={{ gap: 8 }}>
            <Toggle checked={log} onChange={(v) => set({ spectrumLog: v })} explain={ex('spectrum.log')}>
              Log scale
            </Toggle>
            <Toggle checked={lines} onChange={(v) => set({ spectrumLines: v })} explain={ex('spectrum.lines')}>
              Mark known features
            </Toggle>
          </div>
        </section>
        <section className="sect prose-sm">
          <PanelHead title="How SPHEREx makes a spectrum" />
          <p>
            Each of the six detectors sits behind a filter whose colour changes smoothly from one edge to the other, so one snapshot sees the sky in a gradient of colours. As the spacecraft steps across the sky, a given star lands on a new part of the filter and is photographed at a new
            wavelength each time.
          </p>
          <p>Measure the star in every image, sort by wavelength, and you get its spectrum from 0.75 to 5 micron. Bumps show glowing hydrogen, water and carbon dioxide ice, and organic molecules (PAHs).</p>
        </section>
      </aside>

      <div className="stage">
        <section className="panel">
          <PanelHead title={title} />
          <div ref={ref}>
            {!res ? (
              <div className="empty">
                {running ? (
                  <>
                    <h3>Measuring...</h3>
                    <p>Each image is fetched from IRSA and measured. Points appear here one by one as they are measured.</p>
                  </>
                ) : (
                  <>
                    <h3>No spectrum yet</h3>
                    <p>Press Build spectrum to measure the target in up to {max} SPHEREx images.</p>
                  </>
                )}
              </div>
            ) : pts.length === 0 && !partialOnly ? (
              <div className="empty">
                <h3>No clean measurements</h3>
                <p>None of the {res.used ?? ''} images gave a usable brightness here. Very bright targets saturate the detector, and flagged pixels are skipped. Try a fainter target or more images.</p>
              </div>
            ) : (
              <svg className="chart-svg" width={width} height={H} role="img" aria-label="Spectrum: brightness versus wavelength">
                {[1, 2, 3, 4, 5, 6].map((d) => (
                  <g key={d}>
                    <rect x={x(DET_RANGES[d][0])} width={x(DET_RANGES[d][1]) - x(DET_RANGES[d][0])} y={H - m.b + 1} height={4} fill={detColor(d)} opacity={0.8} />
                    <text x={(x(DET_RANGES[d][0]) + x(DET_RANGES[d][1])) / 2} y={m.t - 10} textAnchor="middle" style={{ fill: detColor(d) }}>
                      D{d}
                    </text>
                  </g>
                ))}
                {yTicks.map((v, i) => (
                  <g key={i}>
                    <line className="gl" x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
                    <text x={m.l - 6} y={y(v) + 3} textAnchor="end">
                      {Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2)}
                    </text>
                  </g>
                ))}
                {[0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((w) => (
                  <text key={w} x={x(w)} y={H - m.b + 18} textAnchor="middle">
                    {w}
                  </text>
                ))}
                <text x={(m.l + width - m.r) / 2} y={H - 4} textAnchor="middle">
                  wavelength (micron)
                </text>
                <text x={12} y={(m.t + H - m.b) / 2} transform={`rotate(-90 12 ${(m.t + H - m.b) / 2})`} textAnchor="middle">
                  brightness ({res.unit})
                </text>
                {lines &&
                  FEATURES.map((ft, i) => (
                    <g className="feat" key={ft.n}>
                      <line x1={x(ft.w)} x2={x(ft.w)} y1={m.t} y2={H - m.b} />
                      <text x={x(ft.w) + 3} y={m.t + 10 + (i % 3) * 12}>
                        {ft.n}
                      </text>
                    </g>
                  ))}
                {pts.map((p, i) => (
                  <g key={i} tabIndex={0} role="img" aria-label={`${p.wave_um.toFixed(3)} micron, ${p.flux.toFixed(3)}`} data-explain={ex('spectrum.point')}>
                    <title>{`${p.wave_um.toFixed(3)} µm  ${p.flux.toFixed(3)} ± ${p.err.toFixed(3)} ${res.unit}${p.mjd ? `  ${fmtDate(p.mjd)}` : ''}`}</title>
                    <line x1={x(p.wave_um)} x2={x(p.wave_um)} y1={y(p.flux - p.err)} y2={y(p.flux + p.err)} stroke={detColor(p.det ?? 1)} opacity={0.6} />
                    <circle cx={x(p.wave_um)} cy={y(p.flux)} r={3.4} fill={detColor(p.det ?? Math.max(1, [1, 2, 3, 4, 5, 6].find((d) => p.wave_um <= DET_RANGES[d][1]) ?? 6))} />
                  </g>
                ))}
              </svg>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, normMovers, type MoversResult } from '../api';
import FrameView, { VIEW0, type Mark, type View } from '../components/FrameView';
import { NoTarget } from '../components/NoTarget';
import { ErrorBox, JobBar, Note, PanelHead, Segmented, SideHead } from '../components/ui';
import { ex } from '../explain';
import { detColor, fmtDate } from '../lib/format';
import { useTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { isRunning, moversKey, useJobEntry, useStore } from '../store';
import { useMeta } from './Timeline';

const MATCHED = '#9fb89a';
const UNKNOWN = '#d9822b';
const PREDICTED = '#c8ccd2';

export default function Movers() {
  const { target, update, has } = useTarget();
  const data = useAsync(() => (has ? api.epochs(target.ra!, target.dec!, target.coll) : null), [target.ra, target.dec, target.coll]);
  const epochs = data.data?.epochs || [];
  const autoPair = useStore((s) => s.autoPair);
  const runJob = useStore((s) => s.runJob);
  const [base, setBase] = useState<'diff' | 'a' | 'b'>('diff');
  const [sel, setSel] = useState<number | null>(null);
  const [view, setView] = useState<View>(VIEW0);
  const size = 200;

  useEffect(() => {
    if (epochs.length) autoPair(epochs);
  }, [epochs, autoPair]);
  useEffect(() => setSel(null), [target.a, target.b]);

  const A = epochs.find((e) => e.id === target.a);
  const B = epochs.find((e) => e.id === target.b);
  const metaA = useMeta(target.a, target.ra, target.dec, size);
  const metaB = useMeta(target.b, target.ra, target.dec, size);
  const params = has && target.a && target.b ? { ra: target.ra!, dec: target.dec!, a: target.a, b: target.b, size } : null;
  const entry = useJobEntry(params ? moversKey(params) : null);
  const running = isRunning(entry);
  const result: MoversResult | null = useMemo(
    () => (entry?.result !== undefined ? normMovers(entry.result, target.a, target.b, size) : null),
    [entry?.result, target.a, target.b],
  );
  const onView = useCallback((v: View) => setView(v), []);
  if (!has) return <NoTarget title="Movers" />;

  const run = (force = false) => params && runJob('movers', params, force);
  const marks: Mark[] = (result?.candidates || []).map((c, i) => ({
    x: c.x,
    y: c.y,
    r: sel === i ? 9 : 7,
    color: c.match ? MATCHED : UNKNOWN,
    strong: sel === i,
    dashed: c.sign < 0,
    label: `${i + 1}`,
  }));
  for (const k of result?.known || []) {
    marks.push({ x: k.x, y: k.y, r: 3.5, color: PREDICTED, dashed: k.when === 'A', label: `${k.name} (${k.when})` });
  }
  const src =
    !A || !B
      ? ''
      : base === 'diff'
        ? api.diffUrl({ a: A.id, b: B.id, ra: target.ra!, dec: target.dec!, size, stretch: 'asinh' })
        : api.cutoutUrl({ id: base === 'a' ? A.id : B.id, ra: target.ra!, dec: target.dec!, size, stretch: 'asinh', cmap: 'gray', sub: true });
  const nMatch = result?.candidates.filter((c) => c.match).length ?? 0;

  return (
    <div className="view">
      <div className="stage">
      {data.error && <ErrorBox message={data.error} onRetry={data.retry} />}
        <section className="panel">
          <PanelHead title="Candidates on the image">
            <Segmented
              label="Background image"
              value={base}
              onChange={setBase}
              options={[
                { value: 'diff', label: 'Difference', explain: ex('movers.base') },
                { value: 'a', label: 'Image A', explain: ex('movers.base') },
                { value: 'b', label: 'Image B', explain: ex('movers.base') },
              ]}
            />
          </PanelHead>
          {src ? (
            <FrameView single size={size} view={view} onView={onView} layers={[{ key: base, src, cd: (base === 'b' ? metaB.data : metaA.data)?.wcs?.cd }]} marks={base === 'b' ? [] : marks} dims={result ? [result.width ?? size, result.height ?? size] : undefined} status={running ? 'Searching for movers...' : undefined} label={<b>{base === 'diff' ? 'B minus A' : base === 'a' ? 'Image A' : 'Image B'}</b>} />
          ) : (
            <div className="empty">{data.loading ? 'Finding SPHEREx images...' : 'Choose an image pair on the Timeline first.'}</div>
          )}
          <div className="legend">
            <span>
              <i style={{ borderColor: MATCHED }} /> matches a known body
            </span>
            <span>
              <i style={{ borderColor: UNKNOWN }} /> unidentified
            </span>
            <span>
              <i style={{ borderColor: PREDICTED }} /> JPL predicted position
            </span>
            <span>dashed: at the time of A, solid: at the time of B</span>
          </div>
        </section>
      </div>

        <aside className="side">
          <SideHead title="Movers" sub="Image B is aligned on image A and subtracted. Spots that changed more than the noise are listed and checked against every asteroid and comet JPL predicts in the field." />
          <section className="sect">
            <PanelHead title="Pair" />
            <dl className="kv">
              <dt>A</dt>
              <dd>{A ? <><span style={{ color: detColor(A.det) }}>D{A.det}</span> {fmtDate(A.date)}</> : '?'}</dd>
              <dt>B</dt>
              <dd>{B ? <><span style={{ color: detColor(B.det) }}>D{B.det}</span> {fmtDate(B.date)}</> : '?'}</dd>
              {A && B && (
                <>
                  <dt>Gap</dt>
                  <dd>{Math.abs(B.mjd - A.mjd) < 2 ? `${(Math.abs(B.mjd - A.mjd) * 24).toFixed(1)} h` : `${Math.abs(B.mjd - A.mjd).toFixed(1)} days`}</dd>
                  <dt>Detectors</dt>
                  <dd>
                    D{A.det} / D{B.det}
                  </dd>
                </>
              )}
            </dl>
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary" onClick={() => run(!!result)} disabled={!A || !B || running} data-explain={ex('movers.run')}>
                {running ? 'Searching...' : result ? 'Search again' : 'Find movers'}
              </button>
              <button type="button" className="btn" onClick={() => update({ mode: 'blink' }, '/compare')} disabled={!A || !B} data-explain={ex('movers.compare')}>
                Blink this pair
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <JobBar status={entry} />
              {entry?.error && <ErrorBox message={entry.error} onRetry={() => run(true)} />}
            </div>
          </section>

          {result && (
            <section className="sect">
              <PanelHead title={`${result.candidates.length} candidates, ${nMatch} identified${result.rejected ? `, ${result.rejected} star leftovers rejected` : ''}`} />
              {result.rms !== undefined && (
                <p className="mono muted" style={{ fontSize: 12, marginTop: 0 }}>
                  difference noise (rms) {result.rms.toPrecision(3)}
                  {result.dtHours !== undefined ? `, gap ${result.dtHours.toFixed(1)} h` : ''}
                </p>
              )}
              {result.candidates.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Nothing changed more than the noise. Try a pair from neighbouring days, when asteroids are still in the field.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Match</th>
                        <th>S/N</th>
                        <th>In</th>
                        <th>RA, Dec</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.candidates.map((c, i) => (
                        <tr key={i} className={sel === i ? 'sel' : ''} onClick={() => setSel(sel === i ? null : i)} style={{ cursor: 'pointer' }} data-explain={ex('movers.row')}>
                          <td>{i + 1}</td>
                          <td style={{ color: c.match ? MATCHED : UNKNOWN }}>{c.match ? `${c.match.name}${c.match.vmag !== null ? ` V${Number(c.match.vmag).toFixed(1)}` : ''}` : 'unidentified'}</td>
                          <td>{c.snr.toFixed(1)}</td>
                          <td>{c.sign < 0 ? 'A' : 'B'}</td>
                          <td>
                            {c.ra.toFixed(4)}, {c.dec.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Note>Unidentified does not mean a discovery. Most are noise, cosmic rays or image edges. A real new object shows up in several image pairs along a straight line.</Note>
            </section>
          )}
        </aside>
    </div>
  );
}

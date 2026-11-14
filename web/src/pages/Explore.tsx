import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Preset } from '../api';
import { ErrorBox, Note, PanelHead, Segmented, SideHead } from '../components/ui';
import { ex } from '../explain';
import { DET_RANGES, detColor, fmtDate, fmtDec, fmtRa, parseCoords } from '../lib/format';
import { useTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { useStore } from '../store';
import { rgbPick, rgbUrl, useServerCaps } from '../lib/server';

const SkyMap = lazy(() => import('../components/SkyMap'));
const SpherexNow = lazy(() => import('../three/SpherexNow'));

const VIEW_LABEL: Record<string, string> = {
  blink: 'Blink pair', diff: 'Difference', side: 'Side by side', swipe: 'Swipe', track: 'Track', flipbook: 'Flipbook', motion: 'Six month blink', spectrum: 'Spectrum', timeline: 'Timeline',
};

export default function Explore() {
  const { target, update, has } = useTarget();
  const nav = useNavigate();
  const set = useStore((s) => s.set);
  const runJob = useStore((s) => s.runJob);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [raTxt, setRaTxt] = useState('');
  const [decTxt, setDecTxt] = useState('');
  // With no target the stage shows SPHEREx itself; the sky map is one click away.
  const [skyWanted, setSkyWanted] = useState(false);
  const showSky = has || skyWanted;
  const caps = useServerCaps();
  const rgb = useAsync(() => (has && caps?.rgb ? rgbPick(target.ra!, target.dec!, target.coll) : null), [has, caps?.rgb, target.ra, target.dec, target.coll]);
  const presets = useAsync(() => api.presets(), []);
  const epochs = useAsync(() => (has ? api.epochs(target.ra!, target.dec!, target.coll) : null), [target.ra, target.dec, target.coll]);
  const fresh = { a: null, b: null, mode: null, det: null };

  const openTrack = (name: string, start = '', stop = '') => {
    const p = { name, start, stop };
    set({ track: p });
    runJob('track', p);
    nav({ pathname: '/track', search: `?name=${encodeURIComponent(name)}${start ? `&start=${start}` : ''}${stop ? `&stop=${stop}` : ''}` });
  };

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr('');
    const c = parseCoords(q);
    if (c) {
      update({ ra: c.ra, dec: c.dec, name: null, ...fresh });
      return;
    }
    if (!q.trim()) {
      setErr('Type a name such as M42, or coordinates such as 180.0 0.0.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.resolve(q.trim());
      if (r.kind === 'moving') {
        openTrack(q.trim());
        return;
      }
      update({ ra: r.ra, dec: r.dec, name: r.name, ...fresh });
    } catch (e: any) {
      setErr(e?.message || 'Name not found.');
    } finally {
      setBusy(false);
    }
  };

  const setCoords = () => {
    const ra = parseFloat(raTxt), dec = parseFloat(decTxt);
    if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) {
      setErr('Right ascension must be 0 to 360 and declination -90 to 90 degrees.');
      return;
    }
    setErr('');
    update({ ra, dec, name: null, ...fresh });
  };

  const openPreset = (p: Preset) => {
    const base = { ra: p.ra, dec: p.dec, name: p.name || p.title, coll: p.collection, a: p.a || null, b: p.b || null, det: p.det ?? null, pairSource: p.a && p.b ? ('preset' as const) : ('auto' as const) };
    switch (p.view) {
      case 'track':
        openTrack(p.name || p.title, p.start || '', p.stop || '');
        return;
      case 'blink':
        update({ ...base, mode: 'blink', pair: 'short' }, '/compare');
        return;
      case 'motion':
        update({ ...base, mode: 'blink', pair: 'long' }, '/compare');
        return;
      case 'diff':
      case 'side':
      case 'swipe':
        update({ ...base, mode: p.view, pair: 'short' }, '/compare');
        return;
      case 'flipbook':
        update({ ...base, mode: 'flip' }, '/compare');
        return;
      case 'spectrum': {
        // Same parameters as the server's warm-up, so the saved result opens at once.
        const max = p.max ?? 60;
        set({ spectrumMax: max });
        runJob('spectrum', { ra: p.ra, dec: p.dec, coll: p.collection, max, r: p.r });
        update(base, '/spectrum');
        return;
      }
      default:
        update(base, '/timeline');
    }
  };

  const list = epochs.data?.epochs || [];
  const dets = [1, 2, 3, 4, 5, 6].map((d) => list.filter((e) => e.det === d).length);
  const footDeg = (200 * 6.15) / 3600;

  return (
    <div className="view view-map">
      <aside className="side">
        <SideHead title="Explore" sub="SPHEREx photographs the whole sky in infrared, again and again. Pick a spot to see every image of it and what changed between them." />
        <section className="sect">
          <form className="searchbar" onSubmit={search}>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="M42, Barnard's Star, 3I/ATLAS, 180 0" aria-label="Object name or coordinates" data-explain={ex('explore.search')} />
            <button className="btn btn-primary" type="submit" disabled={busy} data-explain={ex('explore.go')}>
              {busy ? 'Finding...' : 'Find'}
            </button>
          </form>
          <div className="row coords">
            <label className="field">
              <span>RA (deg)</span>
              <input className="input mono" inputMode="decimal" value={raTxt} onChange={(e) => setRaTxt(e.target.value)} placeholder={target.ra?.toFixed(4) ?? '180.0'} data-explain={ex('explore.ra')} />
            </label>
            <label className="field">
              <span>Dec (deg)</span>
              <input className="input mono" inputMode="decimal" value={decTxt} onChange={(e) => setDecTxt(e.target.value)} placeholder={target.dec?.toFixed(4) ?? '0.0'} data-explain={ex('explore.dec')} />
            </label>
            <button type="button" className="btn" onClick={setCoords} data-explain={ex('explore.setCoords')}>
              Set
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            <Segmented
              label="Collection"
              value={target.coll}
              onChange={(v) => update({ coll: v, ...fresh })}
              options={[
                { value: 'spherex_dr1', label: 'All-sky survey', explain: ex('explore.coll.wide') },
                { value: 'spherex_dr1_deep', label: 'Deep fields', explain: ex('explore.coll.deep') },
              ]}
            />
          </div>
          {err && (
            <div style={{ marginTop: 10 }}>
              <ErrorBox message={err} />
            </div>
          )}
        </section>

        <section className="sect">
          <PanelHead title="Target" />
          {!has ? (
            <p className="muted small">No target yet. Click anywhere on the sky map, search above, or open one of the examples below.</p>
          ) : (
            <>
              <dl className="kv">
                {target.name && (
                  <>
                    <dt>Name</dt>
                    <dd>{target.name}</dd>
                  </>
                )}
                <dt>RA</dt>
                <dd>
                  {fmtRa(target.ra!)} <span className="muted">{target.ra!.toFixed(4)}</span>
                </dd>
                <dt>Dec</dt>
                <dd>
                  {fmtDec(target.dec!)} <span className="muted">{target.dec!.toFixed(4)}</span>
                </dd>
                <dt>Images</dt>
                <dd>{epochs.loading ? 'searching IRSA...' : epochs.data ? `${epochs.data.count} SPHEREx images` : '?'}</dd>
                {list.length > 0 && (
                  <>
                    <dt>Dates</dt>
                    <dd>
                      {fmtDate(list[0].date, false)} to {fmtDate(list[list.length - 1].date, false)}
                    </dd>
                  </>
                )}
              </dl>
              {list.length > 0 && (
                <table className="det-table" aria-label="Images per detector">
                  <tbody>
                    <tr>
                      {dets.map((_n, i) => (
                        <th key={i} title={`${DET_RANGES[i + 1][0]} to ${DET_RANGES[i + 1][1]} micron`}>
                          <i className="det-dot" style={{ background: detColor(i + 1) }} />D{i + 1}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      {dets.map((n, i) => (
                        <td key={i}>{n}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              )}
              {rgb.data && (
                <figure className="fig target-rgb">
                  <img src={rgbUrl(rgb.data, target.ra!, target.dec!, 200, 'asinh')} alt="SPHEREx false colour image of the target" loading="lazy" />
                  <figcaption>
                    SPHEREx false colour, 20.5 arcmin: red D{rgb.data.r.det}, green D{rgb.data.g.det}, blue D{rgb.data.b.det}, {fmtDate(rgb.data.b.date, false)}.
                  </figcaption>
                </figure>
              )}
              {epochs.error && <ErrorBox message={epochs.error} onRetry={epochs.retry} />}
              {epochs.data && epochs.data.count === 0 && <Note warn>SPHEREx has no images of this exact spot in this collection yet. Try the other collection or a nearby point.</Note>}
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-primary" onClick={() => update({}, '/timeline')} data-explain={ex('explore.openTimeline')}>
                  Open timeline
                </button>
                <button type="button" className="btn" onClick={() => update({ mode: 'blink' }, '/compare')} data-explain={ex('explore.openCompare')}>
                  Compare
                </button>
                <button type="button" className="btn" onClick={() => update({}, '/spectrum')} data-explain={ex('explore.openSpectrum')}>
                  Spectrum
                </button>
              </div>
            </>
          )}
        </section>

        <section className="sect">
          <PanelHead title="Examples" />
          {presets.error && <ErrorBox message={presets.error} onRetry={presets.retry} />}
          <ul className="preset-list">
            {(presets.data || []).map((p) => (
              <li key={p.id}>
                <button type="button" className="preset" onClick={() => openPreset(p)} data-explain={ex('explore.preset')}>
                  <span className="preset-top">
                    <b>{p.title}</b>
                    <span className="muted">{VIEW_LABEL[p.view] || p.view}</span>
                  </span>
                  <span className="preset-desc">{p.description}</span>
                  <span className="preset-pos mono">
                    {p.view === 'track' ? p.name : `${p.ra.toFixed(3)}, ${p.dec >= 0 ? '+' : ''}${p.dec.toFixed(3)}`}, {p.collection === 'spherex_dr1_deep' ? 'deep fields' : 'all-sky'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {presets.loading && !presets.data && <p className="muted small">Loading examples...</p>}
        </section>

        {showSky && (
        <section className="sect">
          <PanelHead title="SPHEREx right now" />
          {/* Mount point for the live 3D spacecraft view (src/three). The still image after it shows until the 3D view has loaded. */}
          <div id="hero-3d" className="mount-3d" data-mount="explore">
            <Suspense fallback={null}>
              <SpherexNow height={220} showReadout={false} showControls={false} interactive={false} />
            </Suspense>
          </div>
          <figure className="fig fig-fallback">
            <img src="/img/spherex-orbit.jpg" alt="Artist's concept of SPHEREx in orbit above Earth, its cone-shaped photon shields facing away from the planet" loading="lazy" />
            <figcaption>SPHEREx in a polar orbit about 700 km above Earth (artist's concept, PIA26531). Credit: NASA/JPL-Caltech.</figcaption>
          </figure>
        </section>
        )}
      </aside>

      <div className={`stage stage-map${showSky ? '' : ' stage-hero'}`}>
        {showSky ? (
          <>
            <Suspense fallback={<div className="frame loading">Loading sky map...</div>}>
              <SkyMap ra={target.ra} dec={target.dec} fov={has ? 1.2 : 60} footprintDeg={has ? footDeg : undefined} onPick={(ra, dec) => update({ ra, dec, name: null, ...fresh })} explain={ex('explore.sky')} />
            </Suspense>
            <div className="sky-legend">
              <span>
                <i className="lg-target" /> target
              </span>
              <span>
                <i className="lg-box" /> SPHEREx cutout, 20.5 arcmin
              </span>
            </div>
            {!has && (
              <button type="button" className="btn btn-sm view-toggle" onClick={() => setSkyWanted(false)} data-explain={ex('explore.showCraft')}>
                Show SPHEREx
              </button>
            )}
          </>
        ) : (
          <div className="hero-stage">
            <div className="hero-3d">
              <Suspense fallback={<div className="frame loading">Loading SPHEREx...</div>}>
                <SpherexNow height="100%" showReadout showControls={false} interactive={false} />
              </Suspense>
            </div>
            <div className="hero-cap">
              <h2>SPHEREx, where it is right now</h2>
              <p>NASA's SPHEREx circles Earth over the poles every 98 minutes and photographs the whole sky in 102 infrared colours every six months. Pick a spot in the sky to see every image it took there and what moved.</p>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => setSkyWanted(true)} data-explain={ex('explore.showSky')}>
                  Open the sky map
                </button>
                <span className="muted small">or search, or open an example on the left</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

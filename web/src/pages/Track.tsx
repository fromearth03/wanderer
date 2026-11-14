import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, normTrack, type TrackResult } from '../api';
import FrameView, { VIEW0, northUp, type View } from '../components/FrameView';
import { useMetaMap } from '../lib/metas';
import { ErrorBox, Icon, JobBar, Note, PanelHead, SideHead, Slider } from '../components/ui';
import { ex } from '../explain';
import { detColor, fmtDate, prefersReducedMotion, um } from '../lib/format';
import { isRunning, trackKey, useJobEntry, useStore, type TrackParams } from '../store';

const SkyMap = lazy(() => import('../components/SkyMap'));
const HelioTrack = lazy(() => import('../three/HelioTrack'));
const EXAMPLES = ['3I/ATLAS', 'Ceres', 'Vesta', '2024 YR4'];
const STAMP = 64;

export default function Track() {
  const [sp, setSp] = useSearchParams();
  const saved = useStore((s) => s.track);
  const set = useStore((s) => s.set);
  const runJob = useStore((s) => s.runJob);
  const fps = useStore((s) => s.fps);
  // A link with ?name= brings its own dates (none = whole mission); otherwise use the saved track.
  const fromUrl = !!sp.get('name');
  const [name, setName] = useState(sp.get('name') || saved.name);
  const [start, setStart] = useState(fromUrl ? sp.get('start') || '' : saved.start);
  const [stop, setStop] = useState(fromUrl ? sp.get('stop') || '' : saved.stop);
  const entry = useJobEntry(saved.name ? trackKey(saved) : null);
  const running = isRunning(entry);
  const reduced = useMemo(prefersReducedMotion, []);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<View>(VIEW0);
  const auto = useRef(false);

  const run = (n = name, force = false, dates = { start, stop }) => {
    const nm = n.trim();
    if (!nm) return;
    const { start, stop } = dates;
    const p: TrackParams = { name: nm, start, stop };
    set({ track: p });
    const next = new URLSearchParams(sp);
    next.set('name', nm);
    start ? next.set('start', start) : next.delete('start');
    stop ? next.set('stop', stop) : next.delete('stop');
    setSp(next, { replace: true });
    setFrame(0);
    runJob('track', p, force);
  };
  // A link with ?name= (from Explore or a preset) starts that track; the store
  // makes this idempotent, so a job already running is just shown.
  useEffect(() => {
    if (auto.current) return;
    auto.current = true;
    if (fromUrl) run(sp.get('name')!, false, { start: sp.get('start') || '', stop: sp.get('stop') || '' });
    else if (saved.name) {
      const next = new URLSearchParams(sp);
      next.set('name', saved.name);
      if (saved.start) next.set('start', saved.start);
      if (saved.stop) next.set('stop', saved.stop);
      setSp(next, { replace: true });
      runJob('track', saved);
    } else {
      // First visit: open the 3I/ATLAS example (its result is saved on the server, so it is instant).
      api.presets().then((ps) => {
        const p = ps.find((x) => x.view === 'track');
        if (!p || useStore.getState().track.name) return;
        const n = p.name || '3I/ATLAS';
        setName(n);
        setStart(p.start || '');
        setStop(p.stop || '');
        run(n, false, { start: p.start || '', stop: p.stop || '' });
      }, () => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result: TrackResult | null = useMemo(() => {
    if (entry?.result !== undefined) return normTrack(entry.result);
    if (entry?.partial?.length) {
      const r = normTrack({ frames: entry.partial });
      r.frames.sort((x, y) => x.mjd - y.mjd);
      return r;
    }
    return null;
  }, [entry?.result, entry?.partial]);
  const done = entry?.result !== undefined;
  const frames = result?.frames || [];
  const cur = frames[Math.min(frame, frames.length - 1)];
  useEffect(() => {
    if (done && frames.length > 1) setPlaying(!reduced);
  }, [done, frames.length, reduced]);
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1000 / fps);
    return () => clearInterval(t);
  }, [playing, fps, frames.length]);

  const markTimes = useMemo(() => frames.map((f) => f.mjd), [frames]);
  const path = useMemo(() => result?.ephemeris.map((p) => [p.ra, p.dec]) || [], [result]);
  const markers = useMemo(() => frames.map((f, i) => ({ ra: f.ra, dec: f.dec, name: `${i + 1}` })), [frames]);
  const center = useMemo(() => {
    const pts = path.length ? path : frames.map((f) => [f.ra, f.dec]);
    if (!pts.length) return null;
    const ras = pts.map((p) => p[0]), decs = pts.map((p) => p[1]);
    return { ra: (Math.min(...ras) + Math.max(...ras)) / 2, dec: (Math.min(...decs) + Math.max(...decs)) / 2 };
  }, [path, frames]);
  const spanDeg = useMemo(() => {
    const pts = path.length >= 2 ? path : frames.map((f) => [f.ra, f.dec]);
    if (pts.length < 2) return 2;
    const ras = pts.map((p) => p[0]), decs = pts.map((p) => p[1]);
    return Math.min(60, Math.max(0.5, Math.max(Math.max(...ras) - Math.min(...ras), Math.max(...decs) - Math.min(...decs)) * 1.3));
  }, [path, frames]);
  const stampUrl = (f: { id: string; ra: number; dec: number }) => api.cutoutUrl({ id: f.id, ra: f.ra, dec: f.dec, size: STAMP, stretch: 'asinh', cmap: 'gray', sub: true });
  const stampMeta = useMetaMap(done ? frames : [], STAMP);
  const rot = (id: string) => {
    const M = northUp(stampMeta[id]?.wcs?.cd);
    return M ? { transform: `matrix(${M[0][0]}, ${M[1][0]}, ${M[0][1]}, ${M[1][1]}, 0, 0)` } : undefined;
  };
  const onView = useCallback((v: View) => setView(v), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run();
  };
  const label = result?.name || saved.name || name;

  return (
    <div className="view">
      <aside className="side">
        <SideHead title="Track" sub="Follow a named asteroid or comet through every SPHEREx image that caught it. Paths come from NASA JPL Horizons." />
        <section className="sect">
          <form className="stack" onSubmit={submit} style={{ gap: 8 }}>
            <label className="field">
              <span>Object</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="3I/ATLAS" data-explain={ex('track.name')} />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>From (optional)</span>
                <input className="input mono" type="date" value={start} onChange={(e) => setStart(e.target.value)} data-explain={ex('track.start')} />
              </label>
              <label className="field">
                <span>To (optional)</span>
                <input className="input mono" type="date" value={stop} onChange={(e) => setStop(e.target.value)} data-explain={ex('track.stop')} />
              </label>
            </div>
            <div className="row">
              <button className="btn btn-primary" type="submit" disabled={running || !name.trim()} data-explain={ex('track.run')}>
                {running ? 'Tracking...' : 'Track it'}
              </button>
              {done && (
                <button type="button" className="btn" onClick={() => run(saved.name, true, saved)} data-explain={ex('track.rerun')}>
                  Run again
                </button>
              )}
            </div>
          </form>
          <div className="row" style={{ marginTop: 10, gap: 4 }}>
            <span className="muted small">Try</span>
            {EXAMPLES.map((n) => (
              <button
                key={n}
                type="button"
                className="link-btn"
                onClick={() => {
                  setName(n);
                  run(n);
                }}
                data-explain={ex('track.quick')}
              >
                {n}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <JobBar status={entry} />
            {entry?.error && <ErrorBox message={entry.error} onRetry={() => run(saved.name, true, saved)} />}
          </div>
        </section>
        {cur && (
          <section className="sect">
            <PanelHead title="Playback" />
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => setPlaying((p) => !p)} data-explain={ex('track.play')}>
                {playing ? Icon.pause : Icon.play} {playing ? 'Pause' : 'Play'}
              </button>
              <Slider label="Speed" value={fps} min={1} max={10} onChange={(v) => set({ fps: v })} explain={ex('track.fps')} display={`${fps} fps`} width={150} />
            </div>
            <Slider label="Stamp" value={frame} min={0} max={Math.max(0, frames.length - 1)} onChange={(v) => { setFrame(v); setPlaying(false); }} explain={ex('track.frame')} display={`${frame + 1} of ${frames.length}`} />
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Date</dt>
              <dd>{fmtDate(cur.date)}</dd>
              <dt>Detector</dt>
              <dd>D{cur.det}</dd>
              <dt>Position</dt>
              <dd>
                {cur.ra.toFixed(4)}, {cur.dec.toFixed(4)}
              </dd>
              {cur.mag !== null && cur.mag !== undefined && (
                <>
                  <dt>Magnitude</dt>
                  <dd>{Number(cur.mag).toFixed(1)}</dd>
                </>
              )}
            </dl>
          </section>
        )}
        <section className="sect prose-sm">
          <Note>Each stamp is 64 pixels (6.6 arcmin), centred where JPL says the object was at that moment. The object should sit in the dashed circle while stars drift past.</Note>
        </section>
      </aside>

      <div className="stage">
        {done && frames.length === 0 && <Note>JPL knows where {label} was, but no SPHEREx image in the released data covered it at the right time.</Note>}
        {result ? (
          <div className="grid-2 stage-grid">
            <section className="panel">
              <PanelHead title={`${label}: ${frames.length} SPHEREx stamps${done ? '' : ' so far'}`} />
              {cur && (
                <FrameView
                  single
                  size={STAMP}
                  view={view}
                  onView={onView}
                  layers={[{ key: cur.id, src: stampUrl(cur), cd: stampMeta[cur.id]?.wcs?.cd }]}
                  marks={[{ x: STAMP / 2, y: STAMP / 2, r: 5, color: '#d9822b', dashed: true }]}
                  label={
                    <>
                      <b>
                        {frame + 1}/{frames.length}
                      </b>{' '}
                      <span style={{ color: detColor(cur.det) }}>D{cur.det}</span>
                      <br />
                      {fmtDate(cur.date)}
                      {cur.wave_um ? (
                        <>
                          <br />
                          {um(cur.wave_um)}
                        </>
                      ) : null}
                    </>
                  }
                />
              )}
              <div className="stamps" style={{ marginTop: 12 }}>
                {frames.map((f, i) => (
                  <button key={f.id + i} type="button" className={`stamp${i === frame ? ' on' : ''}`} onClick={() => { setFrame(i); setPlaying(false); }} data-explain={ex('track.stamp')} aria-label={`Stamp ${i + 1}, ${fmtDate(f.date)}`}>
                    <img src={stampUrl(f)} alt="" loading="lazy" style={rot(f.id)} />
                    <span>
                      {i + 1} {fmtDate(f.date, false).slice(5)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
            <section className="panel">
              <PanelHead title="Path on the sky" />
              <div className="track-map">
                <Suspense fallback={<div className="frame loading">Loading sky map...</div>}>
                  <SkyMap ra={center?.ra ?? null} dec={center?.dec ?? null} fov={spanDeg} path={path} markers={markers} explain={ex('track.map')} />
                </Suspense>
              </div>
              <p className="muted small">Line: path predicted by JPL Horizons. Numbered circles: the SPHEREx stamps.</p>
              {/* 3D view around the Sun (src/three): the path from JPL Horizons with the SPHEREx frame times marked. */}
              {done && (
                <div id="track-3d" className="mount-3d" data-mount="track">
                  <PanelHead title="Path around the Sun" />
                  <Suspense fallback={<p className="muted small">Loading the 3D view...</p>}>
                    <HelioTrack name={saved.name} start={saved.start || undefined} stop={saved.stop || undefined} markTimes={markTimes} height={360} />
                  </Suspense>
                </div>
              )}
            </section>
          </div>
        ) : (
          !running &&
          !entry?.error && (
            <div className="empty">
              <h3>Nothing tracked yet</h3>
              <p>Type a name or pick an example. 3I/ATLAS is the third known interstellar object, and SPHEREx observed it in August 2025.</p>
            </div>
          )
        )}
        {running && !result && (
          <div className="empty">
            <h3>Searching along the path</h3>
            <p>Stamps appear here as soon as they are found. You can open another page; the search keeps going.</p>
          </div>
        )}
      </div>
    </div>
  );
}

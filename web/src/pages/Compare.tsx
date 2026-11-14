import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Cmap, type Epoch, type Stretch } from '../api';
import FrameView, { VIEW0, zoomAbout, type Layer, type View } from '../components/FrameView';
import { NoTarget } from '../components/NoTarget';
import { ErrorBox, Icon, IconButton, Note, PanelHead, Segmented, Select, SideHead, Slider, Toggle } from '../components/ui';
import { ex } from '../explain';
import { bandText } from '../lib/epochs';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { prefetchQueue } from '../lib/imgcache';
import { rgbPick, rgbUrl, useServerCaps } from '../lib/server';
import { detColor, fmtDate, prefersReducedMotion, um } from '../lib/format';
import { useKnown } from '../lib/known';
import { useMetaMap } from '../lib/metas';
import { useTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { useMeta } from './Timeline';

type Mode = 'blink' | 'swipe' | 'side' | 'diff' | 'flip' | 'rgb';
const MODES: Mode[] = ['blink', 'swipe', 'side', 'diff', 'flip', 'rgb'];

const STRETCHES: { value: Stretch; label: string }[] = [
  { value: 'asinh', label: 'Asinh' },
  { value: 'linear', label: 'Linear' },
  { value: 'log', label: 'Log' },
  { value: 'sqrt', label: 'Square root' },
  { value: 'zscale', label: 'Z-scale' },
];
const CMAPS: { value: Cmap; label: string }[] = [
  { value: 'gray', label: 'Grey' },
  { value: 'inferno', label: 'Inferno' },
  { value: 'magma', label: 'Magma' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'cividis', label: 'Cividis' },
];

const epochLabel = (e: Epoch) => `D${e.det}  ${fmtDate(e.date)}${e.em_max_um - e.em_min_um < 0.1 ? `  ${bandText(e)}` : ''}`;

export default function Compare() {
  const { target, update, has } = useTarget();
  const data = useAsync(() => (has ? api.epochs(target.ra!, target.dec!, target.coll) : null), [target.ra, target.dec, target.coll]);
  const epochs = data.data?.epochs || [];
  const mode: Mode = (MODES as string[]).includes(target.mode) ? (target.mode as Mode) : 'blink';
  const st = useStore(
    useShallow((s) => ({ stretch: s.stretch, cmap: s.cmap, sub: s.sub, size: s.size, known: s.known, kind: s.knownKind, blinkMs: s.blinkMs, fps: s.fps, set: s.set, autoPair: s.autoPair, pairSource: s.pairSource })),
  );
  const { stretch, cmap, sub, size, known, kind, blinkMs, fps, set } = st;
  const [view, setView] = useState<View>(VIEW0);
  const reduced = useMemo(prefersReducedMotion, []);
  const [playing, setPlaying] = useState(!reduced);
  const [showB, setShowB] = useState(false);
  const [swipe, setSwipe] = useState(50);
  const [frame, setFrame] = useState(0);

  // Default pair: same detector, closest wavelength at the target (refined in the background).
  useEffect(() => {
    if (epochs.length) st.autoPair(epochs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochs, target.a, target.b, target.pair]);

  const A = epochs.find((e) => e.id === target.a);
  const B = epochs.find((e) => e.id === target.b);
  const caps = useServerCaps();
  const rgb = useAsync(
    () => (mode === 'rgb' && caps?.rgb && target.ra !== null && target.dec !== null ? rgbPick(target.ra, target.dec, target.coll, A?.mjd) : null),
    [mode, caps?.rgb, target.ra, target.dec, target.coll, A?.mjd],
  );
  const metaG = useMeta(mode === 'rgb' ? rgb.data?.g.id ?? '' : '', target.ra, target.dec, size);
  const metaA = useMeta(target.a, target.ra, target.dec, size);
  const metaB = useMeta(target.b, target.ra, target.dec, size);

  // Flipbook frames: all epochs of one detector, in date order.
  const flipDet = target.det ?? A?.det ?? 1;
  const MAX_FRAMES = 48;
  const allFrames = useMemo(() => epochs.filter((e) => e.det === flipDet), [epochs, flipDet]);
  // Deep fields can have hundreds of images per detector; play an even sample across time.
  const frames = useMemo(
    () => (allFrames.length <= MAX_FRAMES ? allFrames : Array.from({ length: MAX_FRAMES }, (_, i) => allFrames[Math.round((i * (allFrames.length - 1)) / (MAX_FRAMES - 1))])),
    [allFrames],
  );
  const cur = frames[Math.min(frame, frames.length - 1)];
  const flipMeta = useMetaMap(
    mode === 'flip' && target.ra !== null && target.dec !== null ? frames.map((f) => ({ id: f.id, ra: target.ra!, dec: target.dec! })) : [],
    size,
  );

  const url = useCallback(
    (e?: Epoch) => (e && target.ra !== null && target.dec !== null ? api.cutoutUrl({ id: e.id, ra: target.ra, dec: target.dec, size, stretch, cmap, sub }) : ''),
    [target.ra, target.dec, size, stretch, cmap, sub],
  );

  // Blink timer
  useEffect(() => {
    if (mode !== 'blink' || !playing) return;
    const t = setInterval(() => setShowB((b) => !b), blinkMs);
    return () => clearInterval(t);
  }, [mode, playing, blinkMs]);
  // Flipbook timer
  useEffect(() => {
    if (mode !== 'flip' || !playing || frames.length < 2) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1000 / fps);
    return () => clearInterval(t);
  }, [mode, playing, fps, frames.length]);
  useEffect(() => setFrame(0), [flipDet]);
  // Prefetch into the shared decoded-image cache: A and B first, then the
  // flipbook frames nearest the current one. Two at a time, so the browser keeps
  // free connections for everything else (cold cutouts are slow).
  useEffect(() => {
    const urls = [url(A), url(B)];
    if (mode === 'flip' && frames.length) {
      const order = frames.map((_f, i) => i).sort((x, y) => Math.abs(x - frame) - Math.abs(y - frame));
      for (const i of order) urls.push(url(frames[i]));
    }
    // Wait until the visible images had their turn, then fill the cache.
    let stop = () => {};
    const t = setTimeout(() => (stop = prefetchQueue(urls, 2)), mode === 'flip' ? 300 : 1200);
    return () => {
      clearTimeout(t);
      stop();
    };
    // Re-plan when the frame moves by a few steps, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, frames, url, A?.id, B?.id, Math.floor(frame / 4)]);
  const needKnown = mode === 'flip' ? frames.slice(Math.max(0, frame - 1), frame + 4) : [A, B].filter(Boolean) as Epoch[];
  const kn = useKnown(needKnown, target.ra, target.dec, size, kind, known && mode !== 'diff');

  const onView = useCallback((v: View) => setView(v), []);
  const setMode = (m: Mode) => {
    update({ mode: m }, undefined, true);
    setPlaying(!reduced);
  };

  if (!has) return <NoTarget title="Compare" />;

  const tag = (which: 'A' | 'B', e?: Epoch, w?: number) =>
    e ? (
      <>
        <b className={which === 'A' ? 'ta' : 'tb'}>{which}</b> <span style={{ color: detColor(e.det) }}>D{e.det}</span> {fmtDate(e.date)}
        <br />
        {w !== undefined ? `${um(w)} at target` : bandText(e)}
        {known && kn.countFor(e.id) !== undefined ? `, ${kn.countFor(e.id)} known` : ''}
      </>
    ) : null;

  const common = { size, view, onView };
  let viewer: JSX.Element;
  if (!A || !B) {
    viewer = <div className="empty">{data.loading ? 'Finding SPHEREx images...' : epochs.length < 2 ? 'This target needs at least two SPHEREx images to compare.' : 'Choose image A and image B.'}</div>;
  } else if (mode === 'blink') {
    const layers: Layer[] = [
      { key: 'a', src: url(A), visible: !showB, cd: metaA.data?.wcs?.cd, marks: kn.marksFor(A.id) },
      { key: 'b', src: url(B), visible: showB, cd: metaB.data?.wcs?.cd, marks: kn.marksFor(B.id) },
    ];
    viewer = <FrameView {...common} single layers={layers} meta={metaA.data} label={showB ? tag('B', B, metaB.data?.wave_um_at_target) : tag('A', A, metaA.data?.wave_um_at_target)} />;
  } else if (mode === 'swipe') {
    viewer = (
      <FrameView
        {...common}
        single
        layers={[
          { key: 'a', src: url(A), cd: metaA.data?.wcs?.cd, marks: kn.marksFor(A.id) },
          { key: 'b', src: url(B), clipLeftPct: swipe, cd: metaB.data?.wcs?.cd, marks: kn.marksFor(B.id).map((m) => ({ ...m, color: '#c8ccd2' })) },
        ]}
        meta={metaA.data}
        label={
          <>
            {tag('A', A, metaA.data?.wave_um_at_target)}
            <br />
            {tag('B', B, metaB.data?.wave_um_at_target)}
          </>
        }
      >
        <div className="swipe-line" style={{ left: `${swipe}%` }} />
      </FrameView>
    );
  } else if (mode === 'side') {
    viewer = (
      <div className="frames two">
        <FrameView {...common} layers={[{ key: 'a', src: url(A), cd: metaA.data?.wcs?.cd, marks: kn.marksFor(A.id) }]} meta={metaA.data} label={tag('A', A, metaA.data?.wave_um_at_target)} />
        <FrameView {...common} layers={[{ key: 'b', src: url(B), cd: metaB.data?.wcs?.cd, marks: kn.marksFor(B.id) }]} meta={metaB.data} label={tag('B', B, metaB.data?.wave_um_at_target)} />
      </div>
    );
  } else if (mode === 'diff') {
    viewer = (
      <FrameView
        {...common}
        single
        layers={[{ key: 'd', src: api.diffUrl({ a: A.id, b: B.id, ra: target.ra!, dec: target.dec!, size, stretch: stretch === 'asinh' ? 'asinh' : 'linear' }), cd: metaA.data?.wcs?.cd }]}
        meta={metaA.data}
        label={
          <>
            <b>B minus A</b>
            <br />
            {fmtDate(A.date, false)} to {fmtDate(B.date, false)}
          </>
        }
      />
    );
  } else if (mode === 'rgb') {
    const p = rgb.data;
    viewer =
      caps && !caps.rgb ? (
        <div className="empty">The colour view needs the updated Wanderer server (gateway 1.1). Restart the gateway to use it.</div>
      ) : rgb.error ? (
        <ErrorBox message={rgb.error} onRetry={rgb.retry} />
      ) : !p ? (
        <div className="empty">Choosing three images from one survey window...</div>
      ) : (
        <FrameView
          {...common}
          single
          layers={[{ key: 'rgb', src: rgbUrl(p, target.ra!, target.dec!, size, stretch), cd: metaG.data?.wcs?.cd }]}
          meta={metaG.data}
          label={
            <>
              <b>SPHEREx false colour</b>
              <br />
              <span style={{ color: '#ff8a7a' }}>R</span> D{p.r.det} <span style={{ color: '#8fe0a0' }}>G</span> D{p.g.det} <span style={{ color: '#9fb4ff' }}>B</span> D{p.b.det}
              <br />
              {fmtDate(p.b.date, false)} to {fmtDate(p.r.date, false)}
            </>
          }
        />
      );
  } else {
    viewer = cur ? (
      <FrameView
        {...common}
        single
        layers={[{ key: 'f', src: url(cur), cd: flipMeta[cur.id]?.wcs?.cd, marks: kn.marksFor(cur.id) }]}
        meta={flipMeta[cur.id] ?? metaA.data}
        label={
          <>
            <b>
              Frame {frame + 1}/{frames.length}
            </b>{' '}
            <span style={{ color: detColor(cur.det) }}>D{cur.det}</span>
            <br />
            {fmtDate(cur.date)}
            <br />
            {flipMeta[cur.id] ? `${um(flipMeta[cur.id].wave_um_at_target)} at target` : bandText(cur)}
          </>
        }
      />
    ) : (
      <div className="empty">No images from detector D{flipDet}.</div>
    );
  }

  return (
    <div className="view">
      <div className="stage">
      {data.error && <ErrorBox message={data.error} onRetry={data.retry} />}
        <div className="viewer-bar">
          <Segmented
            label="Viewer mode"
            role="tablist"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'blink', label: 'Blink', explain: ex('compare.mode.blink') },
              { value: 'swipe', label: 'Swipe', explain: ex('compare.mode.swipe') },
              { value: 'side', label: 'Side by side', explain: ex('compare.mode.side') },
              { value: 'diff', label: 'Difference', explain: ex('compare.mode.diff') },
              { value: 'flip', label: 'Flipbook', explain: ex('compare.mode.flip') },
              { value: 'rgb', label: 'Colour', explain: ex('compare.mode.rgb') },
            ]}
          />
          <span className="spacer" />
          <div className="row" style={{ gap: 4 }}>
            <IconButton label="Zoom in" onClick={() => setView((v) => zoomAbout(v, 1.5, size))} explain={ex('compare.zoomIn')}>
              {Icon.plus}
            </IconButton>
            <IconButton label="Zoom out" onClick={() => setView((v) => zoomAbout(v, 1 / 1.5, size))} explain={ex('compare.zoomOut')}>
              {Icon.minus}
            </IconButton>
            <IconButton label="Reset view" onClick={() => setView(VIEW0)} explain={ex('compare.zoomReset')}>
              {Icon.reset}
            </IconButton>
            <span className="mono muted small">{view.s.toFixed(1)}x</span>
          </div>
        </div>
          <section className="panel">
            {viewer}
            {mode === 'blink' && A && B && (
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-sm" onClick={() => setPlaying((p) => !p)} data-explain={ex('compare.blinkPlay')}>
                  {playing ? Icon.pause : Icon.play} {playing ? 'Pause' : 'Blink'}
                </button>
                {!playing && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowB((b) => !b)} data-explain={ex('compare.blinkPlay')}>
                    Showing {showB ? 'B' : 'A'}, switch
                  </button>
                )}
                <Slider label="Speed" value={blinkMs} min={150} max={2000} step={50} onChange={(v) => set({ blinkMs: v })} explain={ex('compare.blinkSpeed')} display={`${blinkMs} ms`} width={200} />
              </div>
            )}
            {mode === 'swipe' && (
              <div style={{ marginTop: 12, maxWidth: 760, marginInline: 'auto' }}>
                <Slider label="Divider" value={swipe} min={0} max={100} onChange={setSwipe} explain={ex('compare.swipe')} display={`A ${swipe}% | B ${100 - swipe}%`} />
              </div>
            )}
            {mode === 'diff' && (
              <div className="row" style={{ marginTop: 12 }}>
                <span className="legend-div">
                  brighter in A <i /> brighter in B
                </span>
                <span className="muted small">Image B is aligned onto image A, then A is subtracted. A moving object shows as a blue and orange pair.</span>
              </div>
            )}
            {mode === 'rgb' && rgb.data && (
              <>
                <div className="rgb-key">
                  <span>
                    <b style={{ color: 'var(--d6)' }}>Red</b> D{rgb.data.r.det}, {rgb.data.r.em_min_um.toFixed(2)} to {rgb.data.r.em_max_um.toFixed(2)} µm, {fmtDate(rgb.data.r.date)}
                  </span>
                  <span>
                    <b style={{ color: 'var(--d3)' }}>Green</b> D{rgb.data.g.det}, {rgb.data.g.em_min_um.toFixed(2)} to {rgb.data.g.em_max_um.toFixed(2)} µm, {fmtDate(rgb.data.g.date)}
                  </span>
                  <span>
                    <b style={{ color: 'var(--d1)' }}>Blue</b> D{rgb.data.b.det}, {rgb.data.b.em_min_um.toFixed(2)} to {rgb.data.b.em_max_um.toFixed(2)} µm, {fmtDate(rgb.data.b.date)}
                  </span>
                </div>
                <Note>
                  Infrared turned into colour: the longest wavelengths are shown red, the shortest blue. Hot stars look blue, cool stars and dust red. The three images are taken hours apart, so anything that moved in between shows as separate dots of one colour.
                </Note>
              </>
            )}
            {mode === 'flip' && (
              <div className="stack" style={{ marginTop: 12, gap: 10 }}>
                <div className="row">
                  <IconButton label="Previous frame" onClick={() => setFrame((f) => (f - 1 + frames.length) % Math.max(1, frames.length))} explain={ex('compare.flipPrev')}>
                    {Icon.prev}
                  </IconButton>
                  <button type="button" className="btn btn-sm" onClick={() => setPlaying((p) => !p)} data-explain={ex('compare.flipPlay')}>
                    {playing ? Icon.pause : Icon.play} {playing ? 'Pause' : 'Play'}
                  </button>
                  <IconButton label="Next frame" onClick={() => setFrame((f) => (f + 1) % Math.max(1, frames.length))} explain={ex('compare.flipNext')}>
                    {Icon.next}
                  </IconButton>
                  <Slider label="Speed" value={fps} min={1} max={12} onChange={(v) => set({ fps: v })} explain={ex('compare.flipFps')} display={`${fps} fps`} width={150} />
                  <Select
                    label="Detector"
                    value={String(flipDet)}
                    onChange={(v) => update({ det: v }, undefined, true)}
                    options={[1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: `D${d} (${epochs.filter((e) => e.det === d).length} images)` }))}
                    explain={ex('compare.flipDet')}
                  />
                </div>
                <Slider label="Frame" value={frame} min={0} max={Math.max(0, frames.length - 1)} onChange={(v) => { setFrame(v); setPlaying(false); }} explain={ex('compare.flipFrame')} display={cur ? fmtDate(cur.date) : ''} />
                {allFrames.length > frames.length && (
                  <p className="muted small">
                    Playing {frames.length} of {allFrames.length} images from D{flipDet}, spread evenly in time.
                  </p>
                )}
                <div className="filmstrip" aria-label="Frames">
                  {frames.map((f, i) => (
                    <button key={f.id} type="button" className={i === frame ? 'on' : ''} style={i === frame ? undefined : { background: detColor(f.det), opacity: 0.55 }} onClick={() => { setFrame(i); setPlaying(false); }} aria-label={`Frame ${i + 1}, ${fmtDate(f.date)}`} data-explain={ex('compare.flipFrame')} />
                  ))}
                </div>
              </div>
            )}
          </section>
      </div>

        <aside className="side">
          <SideHead title="Compare" sub="Stars stay put. Asteroids, comets and nearby fast stars shift between images. Blink is the fastest way for your eye to catch them.">
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => update({}, '/timeline')} data-explain={ex('compare.timeline')}>
                Timeline
              </button>
              <button type="button" className="btn btn-sm" disabled={!A || !B} onClick={() => update({}, '/movers')} data-explain={ex('compare.movers')}>
                Find movers in this pair
              </button>
            </div>
          </SideHead>
          <section className="sect">
            <PanelHead title="Images" />
            <div className="stack" style={{ gap: 10 }}>
              <Select label="Image A" value={target.a} onChange={(v) => update({ a: v }, undefined, true)} options={epochs.map((e) => ({ value: e.id, label: epochLabel(e) }))} explain={ex('compare.epochA')} />
              <Select label="Image B" value={target.b} onChange={(v) => update({ b: v }, undefined, true)} options={epochs.map((e) => ({ value: e.id, label: epochLabel(e) }))} explain={ex('compare.epochB')} />
              {A && B && (
                <dl className="kv">
                  <dt>Time gap</dt>
                  <dd>{Math.abs(B.mjd - A.mjd) < 2 ? `${(Math.abs(B.mjd - A.mjd) * 24).toFixed(1)} h` : `${Math.abs(B.mjd - A.mjd).toFixed(1)} days`}</dd>
                  <dt>Wave A</dt>
                  <dd>{metaA.data ? um(metaA.data.wave_um_at_target) : metaA.loading ? 'measuring...' : bandText(A)}</dd>
                  <dt>Wave B</dt>
                  <dd>{metaB.data ? um(metaB.data.wave_um_at_target) : metaB.loading ? 'measuring...' : bandText(B)}</dd>
                  <dt>Pixel</dt>
                  <dd>{(metaA.data?.pixscale_arcsec ?? 6.15).toFixed(2)} arcsec</dd>
                </dl>
              )}
              {A && B && st.pairSource === 'auto' && <p className="muted small">Picked automatically: same detector, closest wavelength at the target.</p>}
              {A && B && A.det === B.det && metaA.data && metaB.data && Math.abs(metaA.data.wave_um_at_target - metaB.data.wave_um_at_target) / metaA.data.wave_um_at_target > 0.03 && (
                <Note warn>
                  SPHEREx saw your target at {um(metaA.data.wave_um_at_target)} in A and {um(metaB.data.wave_um_at_target)} in B, so stars may change brightness for that reason alone. Measure wavelengths on the Timeline to find a closer pair.
                </Note>
              )}
              {A && B && A.det !== B.det && <Note warn>A and B come from different detectors, so they see different infrared colours. Stars can change brightness for that reason alone.</Note>}
            </div>
          </section>

          <section className="sect">
            <PanelHead title="Display" />
            <div className="stack" style={{ gap: 10 }}>
              <div className="grid-2" style={{ gap: 10 }}>
                <Select label="Stretch" value={stretch} onChange={(v) => set({ stretch: v })} options={STRETCHES} explain={ex('compare.stretch')} />
                <Select label="Colour map" value={cmap} onChange={(v) => set({ cmap: v })} options={CMAPS} explain={ex('compare.cmap')} />
              </div>
              <Select
                label="Cutout size"
                value={String(size)}
                onChange={(v) => {
                  set({ size: parseInt(v, 10) });
                  setView(VIEW0);
                }}
                options={[
                  { value: '100', label: '100 px (10 arcmin)' },
                  { value: '200', label: '200 px (20.5 arcmin)' },
                  { value: '300', label: '300 px (31 arcmin)' },
                ]}
                explain={ex('compare.size')}
              />
              <Toggle checked={sub} onChange={(v) => set({ sub: v })} explain={ex('compare.zodi')}>
                Remove zodiacal glow
              </Toggle>
            </div>
          </section>

          <section className="sect">
            <PanelHead title="Known objects" />
            <Toggle checked={known} onChange={(v) => set({ known: v })} explain={ex('compare.known')}>
              Mark known asteroids and comets (JPL)
            </Toggle>
            <div style={{ marginTop: 10 }}>
              <Segmented
                label="Object type"
                value={kind}
                onChange={(v) => set({ knownKind: v })}
                options={[
                  { value: 'a', label: 'Asteroids', explain: ex('compare.knownKind') },
                  { value: 'c', label: 'Comets', explain: ex('compare.knownKind') },
                ]}
              />
            </div>
            {known && kn.busy && (
              <div className="jobline">
                <span className="spinner" /> Asking JPL which bodies were here...
              </div>
            )}
            {known && kn.error && <ErrorBox message={kn.error} />}
            {known && mode === 'diff' && <p className="muted small">Markers are shown on the image modes, not on the difference image.</p>}
            <Note>Positions come from the JPL Small-Body Identification service for the exact time of each image, so in the flipbook the markers move with the objects.</Note>
          </section>
        </aside>
    </div>
  );
}

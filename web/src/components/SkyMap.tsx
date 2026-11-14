import { useEffect, useRef, useState } from 'react';
import { ex } from '../explain';
import { Icon, IconButton } from './ui';
import { serverCaps } from '../lib/server';

// Aladin Lite v3 sky map. Aladin's own buttons are hidden; ours carry data-explain.

export interface SkyMarker {
  ra: number;
  dec: number;
  name: string;
}

export interface SkyMapProps {
  ra: number | null;
  dec: number | null;
  fov?: number;
  footprintDeg?: number; // side of the SPHEREx cutout box in degrees
  path?: number[][]; // [[ra, dec], ...] polyline
  markers?: SkyMarker[];
  onPick?: (ra: number, dec: number) => void;
  explain?: string;
  showSurveyPicker?: boolean;
}

// HiPS served by IRSA (the same archive as the SPHEREx images). The SPHEREx DR1 HiPS is a
// cube of 102 colours; a slider picks the slice. The CDS mirrors do not answer from
// here (tested 2026-11-14: alasky 404, alaskybis timeout), IRSA takes about 1.3 s per
// tile, so gateway 1.1 proxies and caches the tiles: repeat tiles come from disk.
const DIRECT = 'https://irsa.ipac.caltech.edu/data/hips';
let hipsBase = DIRECT;
const hipsReady = serverCaps().then((c) => {
  if (c.hips) hipsBase = `${window.location.origin}/api/hips`;
});
const surveyUrl = (id: string) => `${hipsBase}/${id}`;
export const SURVEYS = [
  { id: 'CDS/2MASS/Color', label: '2MASS near infrared', cube: false },
  { id: 'SPHEREx/spherex_allsky_cube', label: 'SPHEREx all-sky (one colour)', cube: true },
  { id: 'CDS/AllWISE/RGB-W4-W2-W1', label: 'WISE mid infrared', cube: false },
  { id: 'CDS/DSS2/color', label: 'DSS visible light', cube: false },
];
const TILE_RE = /Norder\d+\/(Dir\d+\/Npix\d+|Allsky)\.(jpg|png|webp)/;

/** True once the first sky tile has arrived (then the skeleton fades out). */
function useFirstTile() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (performance.getEntriesByType('resource').some((e) => TILE_RE.test(e.name))) {
      const t = setTimeout(() => setDone(true), 300);
      return () => clearTimeout(t);
    }
    let po: PerformanceObserver | null = null;
    const fallback = setTimeout(() => setDone(true), 25000);
    try {
      po = new PerformanceObserver((list) => {
        if (list.getEntries().some((e) => TILE_RE.test(e.name))) {
          setTimeout(() => setDone(true), 250);
          po?.disconnect();
        }
      });
      po.observe({ type: 'resource', buffered: false });
    } catch {
      setDone(true);
    }
    return () => {
      po?.disconnect();
      clearTimeout(fallback);
    };
  }, []);
  return done;
}

let aladinModule: Promise<any> | null = null;
function loadAladin() {
  if (!aladinModule) {
    aladinModule = import('aladin-lite').then(async (m) => {
      const A = m.default ?? m;
      await A.init;
      return A;
    });
  }
  return aladinModule;
}

function box(ra: number, dec: number, side: number): number[][] {
  const h = side / 2;
  const c = Math.cos((dec * Math.PI) / 180) || 1e-6;
  return [
    [ra - h / c, dec - h],
    [ra + h / c, dec - h],
    [ra + h / c, dec + h],
    [ra - h / c, dec + h],
  ];
}

export default function SkyMap(props: SkyMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const inst = useRef<{ A: any; al: any; ov: any; cat: any } | null>(null);
  const starting = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState('');
  const [grid, setGrid] = useState(false);
  const [survey, setSurvey] = useState(SURVEYS[0].id);
  const [slice, setSlice] = useState(20);
  const [cursor, setCursor] = useState<{ ra: number; dec: number } | null>(null);
  const painted = useFirstTile();
  const pickRef = useRef(props.onPick);
  pickRef.current = props.onPick;

  useEffect(() => {
    if (starting.current || !hostRef.current) return;
    starting.current = true;
    Promise.all([loadAladin(), hipsReady])
      .then(([A]) => {
        if (!hostRef.current) return;
        const al = A.aladin(hostRef.current, {
          survey: surveyUrl(SURVEYS[0].id),
          fov: props.fov ?? 3,
          target: props.ra !== null && props.dec !== null ? `${props.ra} ${props.dec}` : '83.82 -5.39',
          cooFrame: 'ICRSd',
          showReticle: true,
          reticleColor: '#d9822b',
          reticleSize: 26,
          showZoomControl: false,
          showLayersControl: false,
          showFullscreenControl: false,
          showGotoControl: false,
          showFrame: false,
          showProjectionControl: false,
          showSettingsControl: false,
          showCooGridControl: false,
          showSimbadPointerControl: false,
          showShareControl: false,
          showContextMenu: false,
          showCooLocation: false,
          showFov: false,
          showStatusBar: false,
          log: false, // no startup ping to alasky.unistra.fr (privacy, and it fails offline)
        });
        const ov = A.graphicOverlay({ color: '#c8ccd2', lineWidth: 2 });
        al.addOverlay(ov);
        const cat = A.catalog({ name: 'markers', sourceSize: 14, color: '#d9822b', shape: 'circle', displayLabel: true, labelColumn: 'name', labelColor: '#d9822b', labelFont: '12px IBM Plex Mono, monospace' });
        al.addCatalog(cat);
        al.on('click', (e: any) => {
          if (!e || e.isDragging) return;
          if (typeof e.ra === 'number' && typeof e.dec === 'number') pickRef.current?.((e.ra + 360) % 360, e.dec);
        });
        al.on('mouseMove', (e: any) => {
          if (e && typeof e.ra === 'number') setCursor({ ra: (e.ra + 360) % 360, dec: e.dec });
        });
        inst.current = { A, al, ov, cat };
        // Aladin sizes its canvas from window resize events; nudge it whenever our box changes size
        // (for example when the map is created inside a panel that is still laying out).
        let t: number | undefined;
        const nudge = () => {
          clearTimeout(t);
          t = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
        };
        new ResizeObserver(nudge).observe(hostRef.current);
        setTimeout(nudge, 300);
        // Aladin adds its own logo link; give it an explanation too so Focus mode covers it.
        const tagAladinLinks = () => hostRef.current?.querySelectorAll('a, button, input, select').forEach((el) => el.setAttribute('data-explain', ex('explore.aladin')));
        tagAladinLinks();
        setTimeout(tagAladinLinks, 1500);
        setReady(true);
      })
      .catch((e) => setFailed(e?.message || 'The sky map could not start (WebGL2 is needed).'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Target, footprint, path and markers.
  useEffect(() => {
    const i = inst.current;
    if (!ready || !i) return;
    const { A, al, ov, cat } = i;
    try {
      ov.removeAll();
      cat.removeAll();
      if (props.ra !== null && props.dec !== null) {
        al.gotoRaDec(props.ra, props.dec);
        if (props.footprintDeg) ov.add(A.polygon(box(props.ra, props.dec, props.footprintDeg), { color: '#c8ccd2', lineWidth: 2 }));
      }
      if (props.path && props.path.length > 1) ov.add(A.polyline(props.path, { color: '#d9822b', lineWidth: 2 }));
      if (props.markers?.length) cat.addSources(props.markers.map((m) => A.source(m.ra, m.dec, { name: m.name })));
    } catch {
      /* drawing errors must not break the page */
    }
  }, [ready, props.ra, props.dec, props.footprintDeg, props.path, props.markers]);

  useEffect(() => {
    if (ready && props.fov) inst.current?.al.setFoV(props.fov);
  }, [ready, props.fov]);

  const zoom = (f: number) => {
    const al = inst.current?.al;
    if (!al) return;
    const [w] = al.getFov();
    al.setFoV(Math.max(0.02, Math.min(180, w * f)));
  };
  const recenter = () => {
    const al = inst.current?.al;
    if (!al || props.ra === null || props.dec === null) return;
    al.gotoRaDec(props.ra, props.dec);
    al.setFoV(props.fov ?? Math.max(0.6, (props.footprintDeg ?? 0.3) * 4));
  };
  const toggleGrid = () => {
    const al = inst.current?.al;
    if (!al) return;
    const n = !grid;
    setGrid(n);
    try {
      al.setCooGrid({ enabled: n, color: '#c8ccd2', opacity: 0.5, labelSize: 12 });
    } catch {
      /* ignore */
    }
  };
  const changeSurvey = (id: string) => {
    setSurvey(id);
    try {
      inst.current?.al.setImageSurvey(surveyUrl(id));
      if (SURVEYS.find((s) => s.id === id)?.cube) setTimeout(() => applySlice(slice), 800);
    } catch {
      /* ignore */
    }
  };
  const applySlice = (n: number) => {
    setSlice(n);
    try {
      inst.current?.al.getBaseImageLayer()?.setSliceNumber(n);
    } catch {
      /* ignore */
    }
  };
  const isCube = !!SURVEYS.find((s) => s.id === survey)?.cube;

  return (
    <>
      <div className="aladin-host" ref={hostRef} data-explain={props.explain} />
      <div className={`sky-skeleton${painted ? ' done' : ''}`} aria-hidden={painted}>
        <span>
          <span className="spinner" /> Loading sky tiles from IRSA...
        </span>
      </div>
      {failed && (
        <div className="frame loading" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          {failed}
        </div>
      )}
      {props.showSurveyPicker !== false && (
        <div className="sky-hud">
          <select className="select" value={survey} onChange={(e) => changeSurvey(e.target.value)} data-explain={ex('explore.survey')} aria-label="Background survey" style={{ fontSize: 12.5, padding: '7px 28px 7px 9px' }}>
            {SURVEYS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {isCube && (
            <label className="hud-card" style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 170 }}>
              <span className="hl">SPHEREx colour {slice + 1} of 102</span>
              <input type="range" min={0} max={101} value={slice} onChange={(e) => applySlice(parseInt(e.target.value, 10))} data-explain={ex('explore.slice')} aria-label="SPHEREx colour channel" />
            </label>
          )}
          {cursor && (
            <div className="hud-card">
              <div className="hl">Cursor</div>
              {cursor.ra.toFixed(4)} {cursor.dec >= 0 ? '+' : ''}
              {cursor.dec.toFixed(4)}
            </div>
          )}
        </div>
      )}
      <div className="sky-tools">
        <IconButton label="Zoom in" onClick={() => zoom(0.5)} explain={ex('explore.zoomIn')}>
          {Icon.plus}
        </IconButton>
        <IconButton label="Zoom out" onClick={() => zoom(2)} explain={ex('explore.zoomOut')}>
          {Icon.minus}
        </IconButton>
        <IconButton label="Recenter on target" onClick={recenter} explain={ex('explore.recenter')}>
          {Icon.target}
        </IconButton>
        <IconButton label="Coordinate grid" onClick={toggleGrid} explain={ex('explore.grid')} on={grid}>
          {Icon.grid}
        </IconButton>
      </div>
    </>
  );
}

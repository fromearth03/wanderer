import { lazy, Suspense, useState } from 'react';
import { Segmented } from '../components/ui';
import { EXPLAIN, ex } from '../explain';

const SpherexModel = lazy(() => import('../three/SpherexModel'));
const FocalPlaneInset = lazy(() => import('../three/FocalPlaneInset'));

const SECTIONS = [
  ['what', 'What Wanderer does'],
  ['spherex', 'How SPHEREx works'],
  ['screens', 'Screens'],
  ['state', 'Your work is kept'],
  ['focus', 'Focus mode'],
  ['controls', 'Control reference'],
  ['data', 'Data sources and credits'],
  ['arch', 'Architecture'],
  ['limits', 'Limits and honesty'],
] as const;

const SCREENS: { id: string; title: string; text: string }[] = [
  { id: 'explore', title: 'Layout and Explore', text: 'Every screen has the same layout: the page tabs along the top, a side panel on the left with the controls, the viewer filling the rest, and the image strip along the bottom. Explore is the home screen. The viewer is a real infrared map of the sky (2MASS, the SPHEREx all-sky map in any of its 102 colours, WISE, or visible light) drawn by Aladin Lite, with your target marked by a small reticle and the SPHEREx cutout drawn as a square. Search by name, type coordinates or click on the sky. The side panel says how many SPHEREx images cover the point, per detector, and lists tested examples.' },
  { id: 'timeline', title: 'Image strip and Timeline', text: 'The image strip at the bottom of the screen shows every SPHEREx image of the current target on every page that has a target: one row per detector D1 to D6, the survey windows side by side with the months between them cut out, and A and B marked. Click near a tick to make that image A or B. The Timeline page shows the same images in full: date along the bottom, wavelength up the side, colour by detector. Measure wavelengths fills in the exact wavelength SPHEREx saw at your target for each image.' },
  { id: 'compare-blink', title: 'Compare: Blink', text: 'A and B take turns in the same place. Your eye is very good at catching a dot that jumps. Speed is adjustable. Every frame shows its date, detector and the wavelength at the target, plus a scale bar and a compass. When you have not picked a pair yourself, Wanderer picks two images from the same detector and then measures a few candidates in the background to find the pair with the closest wavelength at your target.' },
  { id: 'compare-side', title: 'Compare: Side by side and Swipe', text: 'Both images at once with zoom and pan locked together, so the same star is always in the same spot. Swipe puts one image over the other with a divider you drag.' },
  { id: 'compare-diff', title: 'Compare: Difference', text: 'Image B is aligned pixel by pixel onto image A and A is subtracted. Stars cancel out. Something that moved leaves a blue spot where it was (brighter in A) and an orange spot where it went (brighter in B).' },
  { id: 'compare-rgb', title: 'Compare: Colour', text: 'A true SPHEREx false colour picture of the target: three detectors from one survey window (for example D1 as blue, D3 as green, D6 as red), each stretched on its own and resampled onto one pixel grid by the science service. Hot stars look blue, cool stars and dust red. The three images are taken hours apart, so an asteroid shows up as separate single-colour dots.' },
  { id: 'compare-flip', title: 'Compare: Flipbook and known objects', text: 'All images from one detector played in date order. With known objects switched on, Wanderer asks JPL which asteroids and comets were in the field at the moment of each frame, so the labelled markers move with them.' },
  { id: 'movers', title: 'Movers', text: 'An automatic search. The science service subtracts the aligned pair, finds spots that changed more than the noise, and the gateway checks each against the JPL list of known bodies. Muted green circles match a known object, orange ones are unidentified, grey dots are where JPL predicts known bodies.' },
  { id: 'track', title: 'Track', text: 'Type the name of an asteroid or comet. JPL Horizons gives its path; Wanderer finds every SPHEREx image along that path and cuts a stamp centred on the object. Stamps appear while the search is still running. Play them as a movie and see the path drawn on the sky.' },
  { id: 'spectrum', title: 'Spectrum', text: 'Measures the brightness at the target in many images. Because each image sees a different colour, the measurements together form a spectrum from 0.75 to 5 microns. The plot grows point by point while the images are measured. Labels mark common features such as hydrogen lines and ices.' },
];

function Shot({ id, theme }: { id: string; theme: string }) {
  const [hide, setHide] = useState<Record<string, boolean>>({});
  const d = `/docs/shots/${id}-${theme}-desktop.png`;
  const m = `/docs/shots/${id}-${theme}-mobile.png`;
  return (
    <div className="shot-grid">
      {!hide.d && (
        <a href={d} target="_blank" rel="noreferrer" data-explain={ex('docs.shot')}>
          <img src={d} alt={`${id} screen, ${theme} theme, desktop`} loading="lazy" onError={() => setHide((h) => ({ ...h, d: true }))} />
        </a>
      )}
      {!hide.m && (
        <a href={m} target="_blank" rel="noreferrer" data-explain={ex('docs.shot')}>
          <img src={m} alt={`${id} screen, ${theme} theme, phone`} loading="lazy" onError={() => setHide((h) => ({ ...h, m: true }))} />
        </a>
      )}
      {hide.d && hide.m && <p className="muted">Screenshot not generated yet. Run npm run shots.</p>}
    </div>
  );
}

export default function Docs() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
  const groups = new Map<string, { label: string; text: string }[]>();
  for (const v of Object.values(EXPLAIN)) {
    const list = groups.get(v.screen) || [];
    list.push({ label: v.label, text: v.text });
    groups.set(v.screen, list);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">How Wanderer works</h1>
        <p className="page-lede">A guide for curious people, judges and developers: the telescope, every screen and control, where the data comes from, and how the pieces fit together.</p>
      </div>
      <div className="docs">
        <nav className="toc" aria-label="Contents">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} data-explain={ex('docs.toc')}>
              {label}
            </a>
          ))}
        </nav>
        <article className="prose">
          <h2 id="what">What Wanderer does</h2>
          <p>
            Wanderer lets anyone open real images from NASA's SPHEREx space telescope and see the sky change over time. The ancient Greeks called the planets <i>planetes</i>, wanderers, because they move against the fixed stars. SPHEREx photographs the whole sky again and again, so
            the same trick still works: line up two images of the same patch, and whatever moved is a wanderer. That can be an asteroid, a comet, an interstellar visitor such as 3I/ATLAS, or a nearby star or brown dwarf drifting across the sky.
          </p>
          <p>
            Built for the NASA Space Apps 2026 challenge <b>Planet X and SPHEREx</b>: in the spirit of Clyde Tombaugh, who found Pluto in 1930 by blinking two photographic plates, Wanderer gives everyone a blink comparator for the infrared sky, plus tools that do the
            searching automatically.
          </p>

          <h2 id="spherex">How SPHEREx works</h2>
          <div className="figrow">
            <figure className="fig">
              <img src="/img/spherex-design.jpg" alt="Illustration of the SPHEREx spacecraft: three nested cone-shaped photon shields around the telescope, on top of the spacecraft bus" loading="lazy" />
              <figcaption>SPHEREx design (PIA23869). Credit: NASA/JPL-Caltech.</figcaption>
            </figure>
            <figure className="fig">
              <img src="/img/spherex-dust-cloud.jpg" alt="SPHEREx infrared image of a dusty star forming cloud, shown in several infrared colours" loading="lazy" />
              <figcaption>Early SPHEREx image of a dust cloud in several infrared colours (PIA26352). Credit: NASA/JPL-Caltech.</figcaption>
            </figure>
          </div>
          {/* Mount point for the interactive focal plane model (src/three). */}
          <div id="docs-3d" className="mount-3d" data-mount="docs">
            <Suspense fallback={<p className="muted small">Loading the 3D model...</p>}>
              <SpherexModel height={460} />
            </Suspense>
          </div>
          <p>Drag to turn the model, and point at a part to see its name. The three nested cones are photon shields that keep the telescope cold enough to see heat-like infrared light.</p>
          <p>
            SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer) launched in March 2025. From a polar orbit it maps the entire sky every six months in 102 infrared colours between 0.75 and 5 microns, light that is just too red
            for human eyes. Its pixels are 6.15 arcseconds wide, about the size of a coin seen from 800 metres.
          </p>
          <h3>Six detectors, one rainbow filter each</h3>
          <Suspense fallback={null}>
            <FocalPlaneInset />
          </Suspense>
          <p>
            The camera has six detectors. D1 to D3 cover the short wave infrared (0.75 to 2.4 microns) and D4 to D6 the mid wave infrared (2.4 to 5 microns). In front of each sits a <b>linear variable filter</b>: a filter whose colour changes smoothly from one edge of the
            detector to the other. A single snapshot therefore sees each part of the sky at a different colour.
          </p>
          <p>
            This matters for comparing images. Two visits with the same detector can see the same star at slightly different wavelengths, because the star fell on a different column of the filter. Wanderer always reports the wavelength at your target, not just the
            detector, and its best pair buttons pick images whose wavelengths are close so that only real changes stand out.
          </p>
          <h3>Survey rhythm</h3>
          <p>
            In the all-sky survey (collection <code>spherex_dr1</code>) a typical point is covered by a few days of visits, then again about six months later when SPHEREx has gone half way around the Sun. Asteroids move a lot within a day, so neighbouring-day pairs suit
            them. Nearby stars and brown dwarfs move slowly, so the six month gap is the one to use. Near the ecliptic poles SPHEREx crosses the same patch on almost every orbit; these <b>deep fields</b> (<code>spherex_dr1_deep</code>) have many more epochs and make the best
            flipbooks.
          </p>

          <h2 id="screens">Screens</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <Segmented
              label="Screenshot theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'dark', label: 'Dark theme', explain: ex('docs.shotTheme') },
                { value: 'light', label: 'Light theme', explain: ex('docs.shotTheme') },
              ]}
            />
          </div>
          {SCREENS.map((s) => (
            <section key={s.id}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <Shot id={s.id} theme={theme} />
            </section>
          ))}

          <h2 id="state">Your work is kept</h2>
          <p>
            Wanderer remembers what you were doing. The target, the A and B pair, the viewer mode, the display settings (stretch, colour map, cutout size, zodiacal glow), the detector filter, the theme and Focus mode live in one store that is saved in your browser, so they
            survive a page change and a reload. The address bar always mirrors the target and pair, so any view can still be shared as a link; a link with a target in it wins over what was saved.
          </p>
          <p>
            Long tasks (Movers, Track, Spectrum) run on the server as jobs. They keep running and updating while you look at another page: go from Spectrum to Compare and back, and the plot is still growing or already finished. Points of a spectrum and stamps of a track are
            shown as soon as they are measured. Finished results are saved on the server by their settings, so asking again (or opening a tested example) answers at once. Build again, Search again and Run again force a fresh run.
          </p>
          <p>
            Behind every page is the real sky: about 9,000 bright stars from the Yale Bright Star Catalogue, placed by their positions and coloured by their B-V colour. The view turns to your target and marks it with a small ring. It follows the pointer a little,
            and stands still when the tab is hidden or your system asks for reduced motion.
          </p>
          <p>
            Sky map tiles come from IRSA, which answers in about 1.3 seconds per tile from here. The gateway keeps every tile it has fetched on disk and serves repeats in under a millisecond, and it fetches the low resolution all-sky images at start-up, so the map paints in
            about 2 seconds instead of 6 to 7. Images fade in when ready, the next flipbook frames are fetched ahead, and decoded images stay in memory when you change page.
          </p>
          <p>If something on a page fails, that page shows an error panel with a Retry button instead of going blank; the rest of the app keeps working.</p>

          <h2 id="focus">Focus mode</h2>
          <p>
            The crosshair button in the header turns on Focus mode. While it is on, pointing at any button, slider, menu, tab or link shows a speech bubble above it that says what it does. On a phone, the first tap explains and a second tap uses the control. The bubbles and
            the table below come from the same text, so they never disagree.
          </p>
          <Shot id="focus" theme={theme} />

          <h2 id="controls">Control reference</h2>
          {[...groups.entries()].map(([screen, list]) => (
            <section key={screen}>
              <h3>{screen}</h3>
              <div className="table-wrap">
                <table className="data ctl-table">
                  <thead>
                    <tr>
                      <th>Control</th>
                      <th>What it does</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.label}>
                        <td>{c.label}</td>
                        <td>{c.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <h2 id="data">Data sources and credits</h2>
          <ul>
            <li>
              <b>SPHEREx images</b>: NASA/IPAC Infrared Science Archive (IRSA), Data Release 1, through its Simple Image Access service and image cutout service. SPHEREx is a NASA mission led by Caltech with JPL; data processed by the SPHEREx Science Data Center at IPAC.
            </li>
            <li>
              <b>Known asteroids and comets</b>: JPL Solar System Dynamics, Small-Body Identification API (sb_ident) and the Horizons ephemeris system.
            </li>
            <li>
              <b>Name lookup</b>: CDS Sesame name resolver (SIMBAD, NED, VizieR), Strasbourg astronomical Data Centre.
            </li>
            <li>
              <b>Sky map</b>: Aladin Lite v3 by CDS, showing the SPHEREx DR1 all-sky HiPS cube and the 2MASS, AllWISE and DSS2 HiPS surveys served by IRSA.
            </li>
            <li>
              <b>Photographs and illustrations</b>: NASA Image and Video Library, public domain, each with its credit line (PIA26531, PIA26543, PIA26352, PIA23869).
            </li>
            <li>
              <b>Star backdrop</b>: Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren 1991), CDS catalogue V/50.
            </li>
            <li>
              <b>Type</b>: Public Sans (the open US government typeface) and IBM Plex Mono, SIL Open Font License.
            </li>
          </ul>
          <p>Wanderer is a hackathon project and is not an official NASA product. It does not use NASA logos or branding.</p>

          <h2 id="arch">Architecture</h2>
          <div className="arch">{`browser  --->  web (nginx: this React app, proxies /api and /ws)
                 |
                 v
           gateway (Go, :8080)  --->  IRSA SIA + cutouts (max 4 at once, retry when busy)
                 |               --->  JPL sb_ident, JPL Horizons, CDS Sesame
                 v
           science (Python FastAPI, internal)  : FITS pixels, stretch, reprojection,
                                                 difference images, photometry, detection
shared cache volume: gateway writes FITS + PNG, science reads FITS and writes PNG`}</div>
          <p style={{ marginTop: 10 }}>
            Long tasks (movers, track, spectrum) run as jobs. The browser starts a job over HTTP, subscribes to it on the <code>/ws</code> WebSocket and gets live progress plus a growing <code>partial</code> list (spectrum points, track frames); if the socket drops it
            falls back to polling <code>/api/jobs/&#123;id&#125;</code>. The gateway saves each finished result by its parameters, in memory and on disk, and returns it at once next time unless <code>force=1</code> is passed. On start-up it also prepares the tested
            examples, including the example spectrum. In the browser, one global store (zustand) holds the target, settings and job watchers, so leaving a page never stops a job.
          </p>

          <h2 id="limits">Limits and honesty</h2>
          <ul>
            <li>A candidate marked unidentified is not a discovery. Most are noise, cosmic ray hits or edges. A real new object would appear in several pairs along a straight line.</li>
            <li>Known object positions are computed for an observer at the centre of the Earth, which is accurate to about one SPHEREx pixel for main belt asteroids. Very close objects can be offset.</li>
            <li>The IRSA archive sometimes answers that it is busy. Wanderer retries, and you can press Retry.</li>
          </ul>
        </article>
      </div>
    </div>
  );
}

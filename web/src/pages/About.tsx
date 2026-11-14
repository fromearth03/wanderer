import { ex } from '../explain';

const LINKS = [
  { href: 'https://irsa.ipac.caltech.edu/Missions/spherex.html', label: 'SPHEREx at NASA/IPAC IRSA', what: 'Image archive and cutout service used for every SPHEREx image.' },
  { href: 'https://spherex.caltech.edu/', label: 'SPHEREx mission (Caltech)', what: 'The SPHEREx science team.' },
  { href: 'https://ssd.jpl.nasa.gov/', label: 'JPL Solar System Dynamics', what: 'Small-Body Identification and Horizons, for known asteroids and comets.' },
  { href: 'https://cds.unistra.fr/', label: 'CDS Strasbourg', what: 'Sesame name resolver, Aladin Lite and HiPS sky surveys.' },
  { href: 'https://www.spaceappschallenge.org/', label: 'NASA Space Apps Challenge', what: 'The hackathon this was built for.' },
];

export default function About() {
  return (
    <div className="page">
      <div className="docs">
        <figure className="fig" style={{ position: 'sticky', top: 12 }}>
          <img src="/img/spherex-assembly.jpg" alt="Engineers beside the SPHEREx observatory during final assembly, its three cone-shaped photon shields on top" loading="lazy" />
          <figcaption>SPHEREx in final assembly, 2025 (PIA26543). Credit: NASA/JPL-Caltech/BAE Systems.</figcaption>
        </figure>
        <div className="prose">
          <h2>About Wanderer</h2>
          <p>
            <b>NASA Space Apps 2026: Planet X and SPHEREx.</b> In 1930 Clyde Tombaugh found Pluto by blinking two photographic plates taken days apart. SPHEREx now photographs the whole sky in 102 infrared colours every six months. The challenge: make it easy for anyone to look
            through those images and see what moves.
          </p>
          <p>Wanderer is our answer: a blink comparator, flipbook, difference imager, mover finder, object tracker and spectrum builder for SPHEREx, running on the real public data. "Planet" is Greek for wanderer.</p>

          <h2>Team</h2>
          <p className="muted">Team names and roles go here.</p>

          <h2>Data and credits</h2>
          <ul>
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} target="_blank" rel="noreferrer" data-explain={ex('about.link')}>
                  {l.label}
                </a>
                : {l.what}
              </li>
            ))}
          </ul>
          <p>Photographs and illustrations: NASA Image and Video Library, public domain (PIA26531, PIA26543, PIA26352, PIA23869). Each image carries its own credit line.</p>

          <h2>Not an official NASA product</h2>
          <p>
            Wanderer was made during a hackathon. It is not an official NASA product and is not endorsed by NASA, Caltech, IPAC, JPL or CDS. It uses no NASA insignia or logos. All images and catalogues belong to their providers and are used under their public data policies.
          </p>
          <p>Sky map by Aladin Lite (CDS, GPL-3). Fonts: Public Sans (the open US government typeface) and IBM Plex Mono, both under the SIL Open Font License.</p>
        </div>
      </div>
    </div>
  );
}

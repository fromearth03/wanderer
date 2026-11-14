// Built-in example targets. Used by the mock layer, and by the live client when the
// gateway has no curated presets yet. Coordinates are real.
import type { Preset } from './types';

export const FALLBACK_PRESETS: Preset[] = [
  { id: 'ast', title: 'Ecliptic field', description: 'Most asteroids orbit close to the ecliptic, the plane of the planets. Blink two images from neighbouring days and look for a dot that hops.', ra: 180.0, dec: 0.0, collection: 'spherex_dr1', view: 'blink' },
  { id: '3i', title: '3I/ATLAS, interstellar comet', description: 'Only the third object known to come from another star. SPHEREx imaged it in 2025. Follow its path.', ra: 270.5, dec: -18.9, collection: 'spherex_dr1', view: 'track', name: '3I/ATLAS' },
  { id: 'nep', title: 'North ecliptic pole deep field', description: 'SPHEREx passes over the poles on every orbit, so this patch has many epochs. Play them as a flipbook.', ra: 270.2, dec: 66.6, collection: 'spherex_dr1_deep', view: 'flipbook' },
  { id: 'barnard', title: "Barnard's Star", description: 'The fastest moving star in our sky, about 10 arcseconds a year. Compare the two survey windows six months apart.', ra: 269.452, dec: 4.6934, collection: 'spherex_dr1', view: 'motion', name: "Barnard's Star" },
  { id: 'm82', title: 'Cigar Galaxy (M82)', description: 'A starburst galaxy where stars are forming fast. Its dust glows strongly near 3.3 micron. Build its spectrum from many SPHEREx visits.', ra: 148.9685, dec: 69.6797, collection: 'spherex_dr1', view: 'spectrum', name: 'M82' },
];


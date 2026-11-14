// One source of truth for every control explanation. Each interactive element carries
// data-explain={ex('key')}; Focus mode shows the text and the Docs page builds its
// control reference table from this same map.

export interface Explain {
  screen: string;
  label: string;
  text: string;
}

export const EXPLAIN = {
  // Header and navigation
  'nav.home': { screen: 'Header', label: 'Wanderer logo', text: 'Go back to the Explore page, where you pick a place in the sky.' },
  'nav.explore': { screen: 'Header', label: 'Explore tab', text: 'Search for an object or click on the sky map to choose where to look.' },
  'nav.timeline': { screen: 'Header', label: 'Timeline tab', text: 'See every date SPHEREx photographed your target and pick two images to compare.' },
  'nav.compare': { screen: 'Header', label: 'Compare tab', text: 'Put two SPHEREx images of the same spot side by side, blink them or play them as a movie to spot things that moved.' },
  'nav.movers': { screen: 'Header', label: 'Movers tab', text: 'Let the computer subtract two images and list everything that changed, checked against known asteroids.' },
  'nav.track': { screen: 'Header', label: 'Track tab', text: 'Follow a named asteroid or comet through all the SPHEREx images that caught it.' },
  'nav.spectrum': { screen: 'Header', label: 'Spectrum tab', text: 'Measure how bright the target is at many infrared colours, using many SPHEREx visits.' },
  'nav.docs': { screen: 'Header', label: 'Docs tab', text: 'Read how Wanderer and the SPHEREx telescope work, with a guide to every control.' },
  'nav.about': { screen: 'Header', label: 'About tab', text: 'The challenge, the team and where all the data comes from.' },
  'nav.menu': { screen: 'Header', label: 'Menu button', text: 'Open or close the list of pages on small screens.' },
  'header.theme': { screen: 'Header', label: 'Theme switch', text: 'Switch between the dark night mode and the light day mode. Your choice is remembered.' },
  'header.focus': { screen: 'Header', label: 'Focus mode (crosshair)', text: 'Turn on explanation bubbles. While on, point at or tap any control to learn what it does. Tap a control twice on a phone to use it.' },
  'strip.chart': { screen: 'Image strip', label: 'Image strip', text: 'Every SPHEREx image of your target along the bottom of the screen: one row per detector D1 to D6, survey windows side by side with the months between them cut out. Click near a tick to make that image A or B.' },
  'strip.slot': { screen: 'Image strip', label: 'A and B switch', text: 'Choose whether the next click on the strip sets image A or image B. It flips to the other one after each click.' },
  'target.clear': { screen: 'Header', label: 'Clear target', text: 'Forget the current target and start a new search.' },

  // Explore
  'explore.search': { screen: 'Explore', label: 'Search box', text: 'Type an object name like M42 or Ceres, or coordinates like 180.0 0.0 (right ascension and declination in degrees).' },
  'explore.go': { screen: 'Explore', label: 'Find button', text: 'Look up the name or coordinates and move the sky map there.' },
  'explore.coll.wide': { screen: 'Explore', label: 'All-sky collection', text: 'Use the all-sky survey: every part of the sky, seen in two passes about six months apart.' },
  'explore.coll.deep': { screen: 'Explore', label: 'Deep fields collection', text: 'Use the deep fields near the ecliptic poles, which SPHEREx revisits on almost every orbit, so they have many more dates.' },
  'explore.sky': { screen: 'Explore', label: 'Sky map', text: 'A real infrared map of the whole sky. Drag to pan, scroll or pinch to zoom, click to set your target there.' },
  'explore.survey': { screen: 'Explore', label: 'Background survey', text: 'Choose which existing sky survey is drawn behind the SPHEREx footprint: 2MASS near infrared, the SPHEREx all-sky map itself, WISE mid infrared or visible light.' },
  'explore.slice': { screen: 'Explore', label: 'SPHEREx colour', text: 'Pick which of the 102 SPHEREx infrared colours the all-sky map shows. Low numbers are about 0.75 micron, high numbers about 5 micron.' },
  'explore.aladin': { screen: 'Explore', label: 'Aladin logo', text: 'The sky map is drawn by Aladin Lite from the CDS in Strasbourg. This link opens its website.' },
  'explore.zoomIn': { screen: 'Explore', label: 'Zoom in', text: 'Zoom the sky map in for a closer look.' },
  'explore.zoomOut': { screen: 'Explore', label: 'Zoom out', text: 'Zoom the sky map out to see more of the sky.' },
  'explore.recenter': { screen: 'Explore', label: 'Recenter', text: 'Bring the sky map back to your target with the cutout box in view.' },
  'explore.grid': { screen: 'Explore', label: 'Coordinate grid', text: 'Show or hide lines of right ascension and declination on the sky map.' },
  'explore.preset': { screen: 'Explore', label: 'Preset card', text: 'Jump straight to a hand picked example that shows something real moving or changing.' },
  'explore.showSky': { screen: 'Explore', label: 'Open the sky map', text: 'Swap the live SPHEREx view for the sky map, where a click picks your target.' },
  'explore.showCraft': { screen: 'Explore', label: 'Show SPHEREx', text: 'Go back to the live view of where SPHEREx is in its orbit right now.' },
  'explore.openTimeline': { screen: 'Explore', label: 'Open timeline', text: 'List every SPHEREx image of this target and choose two to compare.' },
  'explore.openCompare': { screen: 'Explore', label: 'Quick compare', text: 'Skip the timeline and open the compare viewer with an automatically chosen pair of images.' },
  'explore.openSpectrum': { screen: 'Explore', label: 'Spectrum of target', text: 'Build a 0.75 to 5 micron spectrum of whatever sits at the target.' },
  'explore.ra': { screen: 'Explore', label: 'RA field', text: 'Right ascension of the target in degrees, from 0 to 360. Like longitude on the sky.' },
  'explore.dec': { screen: 'Explore', label: 'Dec field', text: 'Declination of the target in degrees, from -90 to +90. Like latitude on the sky.' },
  'explore.setCoords': { screen: 'Explore', label: 'Set coordinates', text: 'Use the typed right ascension and declination as the new target.' },

  // Timeline
  'timeline.chart': { screen: 'Timeline', label: 'Epoch chart', text: 'Each mark is one SPHEREx photo of your target. Left to right is date, up and down is infrared wavelength.' },
  'timeline.point': { screen: 'Timeline', label: 'Epoch mark', text: 'One SPHEREx image. Click to make it image A or image B for comparing.' },
  'timeline.det': { screen: 'Timeline', label: 'Detector chip', text: 'Show or hide images from this detector. D1 to D3 see shorter infrared colours, D4 to D6 longer ones.' },
  'timeline.pickA': { screen: 'Timeline', label: 'Pick A', text: 'The next epoch you click becomes image A, the earlier view.' },
  'timeline.pickB': { screen: 'Timeline', label: 'Pick B', text: 'The next epoch you click becomes image B, the later view.' },
  'timeline.auto': { screen: 'Timeline', label: 'Best pair', text: 'Let Wanderer choose two images from the same detector, far apart in time but close in wavelength, so stars look the same and only movers change.' },
  'timeline.swap': { screen: 'Timeline', label: 'Swap A and B', text: 'Swap which image is A and which is B.' },
  'timeline.compare': { screen: 'Timeline', label: 'Compare these two', text: 'Open the compare viewer with image A and image B.' },
  'timeline.flipbook': { screen: 'Timeline', label: 'Play all as flipbook', text: 'Open the compare viewer and play every image from one detector as a movie.' },
  'timeline.zoomWindow': { screen: 'Timeline', label: 'Time range', text: 'Show the whole mission or zoom into one survey window to separate images taken on neighbouring days.' },
  'timeline.measure': { screen: 'Timeline', label: 'Measure wavelengths', text: 'Fetch each shown image and read the exact wavelength SPHEREx saw at your target. Slow (each image comes from the archive) but it shows the rainbow filter at work.' },
  'timeline.row': { screen: 'Timeline', label: 'Epoch row', text: 'One SPHEREx image in the list. Click to make it image A or B, depending on which pick button is active.' },

  // Compare
  'compare.mode.blink': { screen: 'Compare', label: 'Blink mode', text: 'Flip back and forth between A and B in the same spot. Anything that jumps has moved. This is how Pluto was found in 1930.' },
  'compare.mode.swipe': { screen: 'Compare', label: 'Swipe mode', text: 'Slide a divider across to wipe from image A to image B.' },
  'compare.mode.side': { screen: 'Compare', label: 'Side by side', text: 'Show A and B next to each other. Zoom and pan stay linked.' },
  'compare.mode.diff': { screen: 'Compare', label: 'Difference mode', text: 'Subtract A from B. Things that stayed the same fade to nothing; orange got brighter in B, blue was brighter in A.' },
  'compare.mode.flip': { screen: 'Compare', label: 'Flipbook mode', text: 'Play every image from one detector in date order as a short movie.' },
  'compare.mode.rgb': { screen: 'Compare', label: 'Colour mode', text: 'Show the target in false colour: three SPHEREx detectors from one survey window, the longest infrared wavelength as red, the middle as green, the shortest as blue.' },
  'compare.epochA': { screen: 'Compare', label: 'Image A', text: 'Choose the first image (A). Usually the earlier date.' },
  'compare.epochB': { screen: 'Compare', label: 'Image B', text: 'Choose the second image (B). Usually the later date.' },
  'compare.stretch': { screen: 'Compare', label: 'Stretch', text: 'How brightness is mapped to the screen. Asinh and log bring out faint things next to bright stars.' },
  'compare.cmap': { screen: 'Compare', label: 'Colour map', text: 'Which colours are used to paint brightness. Grey is honest; the others make faint detail easier to see.' },
  'compare.zodi': { screen: 'Compare', label: 'Remove zodiacal glow', text: 'Subtract the smooth glow of sunlit dust in the solar system that SPHEREx measures in every image.' },
  'compare.size': { screen: 'Compare', label: 'Cutout size', text: 'How big a patch of sky to fetch, in SPHEREx pixels. Each pixel is 6.15 arcseconds.' },
  'compare.blinkPlay': { screen: 'Compare', label: 'Blink play or pause', text: 'Start or stop the automatic flipping between A and B.' },
  'compare.blinkSpeed': { screen: 'Compare', label: 'Blink speed', text: 'How long each image stays on screen while blinking.' },
  'compare.swipe': { screen: 'Compare', label: 'Swipe divider', text: 'Drag to move the divider between image A (left) and image B (right).' },
  'compare.flipPlay': { screen: 'Compare', label: 'Flipbook play or pause', text: 'Start or stop the flipbook movie.' },
  'compare.flipFrame': { screen: 'Compare', label: 'Frame scrubber', text: 'Drag to step through the flipbook one image at a time.' },
  'compare.flipFps': { screen: 'Compare', label: 'Frames per second', text: 'How fast the flipbook plays.' },
  'compare.flipDet': { screen: 'Compare', label: 'Flipbook detector', text: 'Which detector to play. Each detector sees its own range of infrared colours.' },
  'compare.flipPrev': { screen: 'Compare', label: 'Previous frame', text: 'Step back one image in the flipbook.' },
  'compare.flipNext': { screen: 'Compare', label: 'Next frame', text: 'Step forward one image in the flipbook.' },
  'compare.known': { screen: 'Compare', label: 'Known objects', text: 'Ask NASA JPL which known asteroids or comets were in this patch at the moment each image was taken, and mark them.' },
  'compare.knownKind': { screen: 'Compare', label: 'Asteroids or comets', text: 'Choose whether the known object markers show asteroids or comets.' },
  'compare.zoomIn': { screen: 'Compare', label: 'Zoom in', text: 'Magnify the images. All panels zoom together.' },
  'compare.zoomOut': { screen: 'Compare', label: 'Zoom out', text: 'Shrink the images back. All panels zoom together.' },
  'compare.zoomReset': { screen: 'Compare', label: 'Reset view', text: 'Return to the full image with no zoom or pan.' },
  'compare.viewport': { screen: 'Compare', label: 'Image panel', text: 'Drag to pan, scroll or pinch to zoom. All panels move together so the same star stays in the same place.' },
  'compare.movers': { screen: 'Compare', label: 'Find movers in this pair', text: 'Send this A and B pair to the automatic mover finder.' },
  'compare.timeline': { screen: 'Compare', label: 'Back to timeline', text: 'Go back to the list of dates to choose a different pair.' },

  // Movers
  'movers.run': { screen: 'Movers', label: 'Find movers', text: 'Start the search: subtract the two images, find spots that changed and check each against known solar system objects.' },
  'movers.row': { screen: 'Movers', label: 'Candidate row', text: 'Highlight this candidate on the image.' },
  'movers.base': { screen: 'Movers', label: 'Background image', text: 'Draw the candidate circles on the difference image, image A or image B.' },
  'movers.compare': { screen: 'Movers', label: 'Open in compare', text: 'Open this pair in the blink viewer to check the candidates by eye.' },

  // Track
  'track.name': { screen: 'Track', label: 'Object name', text: 'Name of an asteroid or comet as JPL knows it, for example 3I/ATLAS, Ceres or 2024 YR4.' },
  'track.start': { screen: 'Track', label: 'Start date', text: 'Only look for images taken after this date. Leave empty for the whole mission.' },
  'track.stop': { screen: 'Track', label: 'Stop date', text: 'Only look for images taken before this date. Leave empty for the whole mission.' },
  'track.run': { screen: 'Track', label: 'Track it', text: 'Ask JPL Horizons where the object was each day, then find every SPHEREx image that caught it.' },
  'track.rerun': { screen: 'Track', label: 'Run again', text: 'Search the path again from scratch instead of opening the saved result, for example after new data was released.' },
  'track.quick': { screen: 'Track', label: 'Example object', text: 'Fill in the name of a well known moving object to try.' },
  'track.play': { screen: 'Track', label: 'Play stamps', text: 'Play the stamps as a movie. The object stays in the middle while the stars slide past.' },
  'track.frame': { screen: 'Track', label: 'Stamp scrubber', text: 'Step through the stamps one at a time.' },
  'track.stamp': { screen: 'Track', label: 'Stamp', text: 'One SPHEREx image centred on where the object was predicted to be. Click to show it large.' },
  'track.fps': { screen: 'Track', label: 'Movie speed', text: 'How many stamps per second the movie plays.' },
  'track.map': { screen: 'Track', label: 'Path map', text: 'The predicted path of the object across the real sky. Dots mark the SPHEREx images.' },

  // Spectrum
  'spectrum.run': { screen: 'Spectrum', label: 'Build spectrum', text: 'Measure the target in many SPHEREx images. Each one sees a slightly different infrared colour, so together they make a spectrum.' },
  'spectrum.max': { screen: 'Spectrum', label: 'Number of images', text: 'How many images to measure. More gives a fuller spectrum but takes longer.' },
  'spectrum.log': { screen: 'Spectrum', label: 'Log scale', text: 'Show brightness on a logarithmic scale so faint and bright parts both fit.' },
  'spectrum.lines': { screen: 'Spectrum', label: 'Feature labels', text: 'Mark wavelengths where common gases and dust glow or absorb, such as water ice and hydrogen.' },
  'spectrum.point': { screen: 'Spectrum', label: 'Measurement', text: 'One brightness measurement from one SPHEREx image.' },

  // Docs and About
  'docs.toc': { screen: 'Docs', label: 'Contents link', text: 'Jump to this section of the documentation.' },
  'docs.shot': { screen: 'Docs', label: 'Screenshot', text: 'Open the full size screenshot in a new tab.' },
  'docs.shotTheme': { screen: 'Docs', label: 'Screenshot theme', text: 'Show the screenshots in dark or light theme.' },
  'about.link': { screen: 'About', label: 'External link', text: 'Open this data source or organisation in a new tab.' },
  'common.retry': { screen: 'All', label: 'Retry', text: 'Try the request again. The IRSA archive is sometimes busy.' },
  'common.goExplore': { screen: 'All', label: 'Choose a target', text: 'Go to Explore to choose where in the sky to look.' },
} satisfies Record<string, Explain>;

export type ExplainKey = keyof typeof EXPLAIN;

export function ex(key: ExplainKey): string {
  return EXPLAIN[key].text;
}

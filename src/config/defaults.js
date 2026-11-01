export const DEFAULT_PARAMS = {
  count: 0, // fish (0: midges only)
  paused: false,
  simSpeed: 1, // simulation steps per drawn frame (fast-forward, e.g. to train the midges)

  // Motion (px/s, px/s²)
  minSpeed: 40,
  maxSpeed: 140,
  maxForce: 260,

  // Senses: neighbours and the shore are both seen within this vision cone
  perception: 55,
  separation: 22,
  fov: 270, // degrees
  maxNeighbors: 48,

  // Shore (banks and islands), seen within the vision cone
  wallWeight: 3,

  // Rule weights
  alignWeight: 1.0,
  cohesionWeight: 0.8,
  separationWeight: 1.6,

  // Swimming animation
  swimWiggle: 0.18, // tail swing (body undulation amplitude)
  swimBeat: 1, // tail-beat frequency multiplier

  // Light: shadows fall away from the sun
  sunAzimuth: 322, // degrees, clockwise from north (screen up)
  sunElevation: 31, // degrees above the horizon; lower = longer shadows
  shadowDarkness: 0.4, // fraction of light a shadow blocks
  plantSelfShadow: 0.18, // how much shaded plant bases darken (tops stay sunlit)
  floatHeight: 4, // px the floating scum (and, lower, the lily pads) sits above its shadow

  // Weather
  showClouds: true, // drifting cloud shadows over the whole scene
  windDirection: 60, // degrees the wind blows towards, clockwise from north (screen up)
  cloudSpeed: 14, // px/s the cloud shadows drift with the wind; also how lively the ripples are
  cloudCover: 0.45, // 0 = clear sky .. 1 = overcast
  cloudSize: 1400, // world px per cloud noise tile
  cloudSoftness: 0.1, // width of the wispy cloud edges
  cloudDarkness: 0.2, // fraction of light a cloud core blocks

  // Water
  showWaterMotion: true, // deep-water swirl, shallow caustics and ripples
  murkSurface: 0.18, // how much a fish right below the surface fades into the water
  murkDeep: 0.88, // ... and one on the deepest bottom
  swirlStrength: 0.07, // brightness change of the deep-water silt swirl
  swirlSize: 900, // world px per swirl noise tile
  swirlSpeed: 0.004, // noise tiles per second the eddies turn over
  causticStrength: 0.03, // brightness of a caustic line
  causticDepth: 0.65, // water depth (0..1) beyond which no caustics reach the floor
  causticSize: 240, // world px per caustic noise tile
  causticSpeed: 0.025, // how fast the caustic web shifts
  rippleStrength: 0.2, // opacity of the ripple glints
  rippleWavelength: 7, // world px between ripple crests
  rippleSpeed: 5, // crest phase speed, rad/s
  refraction: 1.2, // px the floor wobbles through the ripples

  // Fish depth cues
  deepFade: 0.5, // how much deep fish lose their colour and sharpness

  // Silt stirred up by fish swimming near the floor
  siltAmount: 1, // how much each fish kicks up
  siltSettle: 3, // seconds for a cloud to settle back
  siltOpacity: 0.75, // opacity of the densest cloud

  // Plants and fish wakes
  plantBreeze: 1, // how far plants lean in the wind
  plantBend: 1.4, // how far fish push plants aside
  logCount: 4, // fallen tree trunks, from the banks into the water
  logLandClearing: 0.3, // 0 = land plants ignore trunks .. 1 = bent fully clear of them
  logMurk: 2.5, // how quickly submerged trunks fade into the murk with depth
  plantDeepSparseness: 0.6, // 0 = even growth .. 1 = no plants at the deep edge of the plant zone
  sludgeAmount: 0.5, // how much of the shallow-mid floor is covered in sludge
  // Floor details (0 = none; drawn into the cached floor, so free per frame)
  floorLitter: 0.5, // fallen leaves, thickest near the banks
  floorStones: 0.4, // pebble beds in the shallows
  floorTwigs: 0.3, // sunken twigs and branches
  showInsects: true,
  insectTrails: true, // fading motion trails behind flying midges and dragonflies (they show when fast-forwarding)
  // Midges: how each one behaves is in its genes (sim/Insects.js GENES); these are the world they live in.
  insectCount: Infinity, // most midges alive at once (Infinity: no limit, so food decides)
  insectStart: 100, // midges per spawn (random genomes, or the profile's); nothing spawns by itself
  insectWind: 1, // how far the wind carries them
  insectBodyTime: 12, // seconds a body lies before it is gone
  insectHunger: 0.03, // energy a midge burns per second flying at 70 px/s (full = 1)
  flowerNectar: 1, // meals (full energy) a flower holds
  flowerRegrow: 50, // seconds a drunk-dry flower takes to refill
  flowerRefills: 6, // refills before a flower wilts and rests (0 = never), varied per flower
  flowerDormancy: 100, // seconds a wilted flower rests before refilling, varied per flower
  // Dragonflies: an evolving predator population (their behaviour is in their genes)
  showDragonflies: true,
  dragonflyMutationRate: 0.1, // chance each gene mutates in a newly emerged dragonfly
  dragonflyMutationSize: 0.08, // typical mutation, as a fraction of the gene's range
  dragonflyProfile: null, // the chosen dragonfly profile, if any
  dragonflyLocked: false, // every dragonfly carries the profile's genome exactly, no mutations
  dragonflyCap: Infinity, // most dragonflies alive at once (Infinity: no limit)
  dragonflyStart: 6, // dragonflies per spawn (random genes, or the profile's); nothing spawns by itself
  dragonflyHunger: 0.025, // energy a dragonfly burns per second flying at 130 px/s
  dragonflyMeal: 0.38, // energy a dragonfly gets from a midge (scaled by its digestion gene)
  mutationRate: 0.1, // chance each gene mutates in a hatchling
  mutationSize: 0.08, // typical mutation, as a fraction of the gene's range
  midgeProfile: null, // the chosen profile ({ name, genes, ... }), if any
  midgeLocked: false, // every midge carries the profile's genome exactly, no mutations
  // How much of each plant kind grows (1 = as generated, 0 = none)
  plantRush: 1,
  plantReed: 1,
  plantCattail: 1,
  plantIris: 1, // yellow flowers (midge food)
  plantShrub: 1,
  plantPickerelweed: 1, // purple flowers (midge food)
  plantShallowDensity: 0.5, // share of the shallowest water and shore fringe that is planted (rest: open gaps)
  wakeRadius: 16, // px of water a swimming fish disturbs
  wakeStrength: 10, // how hard fish push the water
  wakeFade: 3, // rate (1/s) the disturbance settles
  scumDrag: 12, // how far fish shove the scum fronds
  scumCohesion: 0.3, // rate (1/s) neighbouring fronds drift together, closing gaps

  // Visualisation
  boidSize: 6,
  pixelSize: 1, // CSS px per rendered pixel (1 = full resolution)
  visionMode: 'off', // 'all' | 'selected' | 'off'
  showVelocity: false,
  showSteering: false,
  showPlants: true, // reeds, cattails, iris, shrubs and lily pads (display only)
  velocityScale: 0.22, // px of arrow per px/s
  steeringScale: 0.08, // px of arrow per px/s²
  colorLevels: 24, // colour levels per channel (lo-fi palette depth)
  dithering: true, // ordered (Bayer) dithering between colour levels
  vignette: 0.45, // darkening towards the corners
}

/**
 * Murk for a new map: every pond's water is a little different, from clearer
 * to murkier (ranges kept around the defaults so it always reads as a pond).
 */
export function randomMurk() {
  const r = (a, b) => Math.round((a + Math.random() * (b - a)) * 100) / 100
  return { murkSurface: r(0.05, 0.35), murkDeep: r(0.65, 0.97), logMurk: Math.round(r(1.5, 4) * 10) / 10 }
}

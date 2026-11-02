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
  sunElevation: 31, // degrees above the horizon; lower = longer shadows, dimmer and warmer light
  sunBrightness: 1.25, // overall sunlight (the sun's height scales it further)
  shadowDarkness: 0.4, // fraction of light a shadow blocks
  plantSelfShadow: 0.18, // how much shaded plant bases darken (tops stay sunlit)
  floatHeight: 4, // px the floating scum (and, lower, the lily pads) sits above its shadow

  // Weather
  showClouds: true, // drifting cloud shadows over the whole scene
  windDirection: 60, // degrees the wind blows towards, clockwise from north (screen up)
  cloudSpeed: 14, // px/s the cloud shadows drift with the wind; also how lively the ripples are
  windAuto: true, // the wind changes by itself (else it blows exactly as set)
  windVariability: 0.4, // auto wind: 0 = steady; up to 1, each change turns it up to ±90°, speed 0..2x the set speed
  windChangeEvery: 40, // seconds (on average) between the wind settling on a new direction and strength
  cloudCover: 0.45, // 0 = clear sky .. 1 = overcast
  cloudSize: 1400, // world px per cloud noise tile
  cloudSoftness: 0.1, // width of the wispy cloud edges
  cloudDarkness: 0.2, // fraction of light a cloud core blocks

  // Water
  showWaterMotion: true, // deep-water swirl, shallow caustics and ripples
  murkSurface: 0.18, // how much a fish right below the surface fades into the water
  murkDeep: 0.88, // ... and one on the deepest bottom
  depthEffect: 1.6, // how strongly depth shows: 1 = as the murk says; higher, everything fades and darkens sooner with depth
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
  waterTint: 0, // water colour in the middle and deep: 0 = peaty blue-green, 1 = muddy brown
  waterDepth: 1, // how deep the water is, as a multiple of the generated depth (the shore stays put)
  landAmount: 1, // how much of the map is land: 0 = open water to the banks, 1 = as generated, 2 = mostly land
  plantDeepSparseness: 0.6, // 0 = even growth .. 1 = no plants at the deep edge of the plant zone
  sludgeAmount: 0.5, // how much of the shallow-mid floor is covered in sludge
  // Floor details (0 = none; drawn into the cached floor, so free per frame)
  floorLitter: 0.5, // fallen leaves, thickest near the banks
  floorStones: 0.4, // pebble beds in the shallows
  floorTwigs: 0.3, // sunken twigs and branches
  showInsects: true,
  insectTrails: true, // fading motion trails behind flying midges (they show when fast-forwarding)
  // Midges: how each one flies is in its genes (species/midges.js MIDGE_GENES); these are the world they live in.
  insectStart: 100, // midges per spawn (random genomes, or the profile's); nothing spawns or is born by itself
  midgeVisionMode: 'selected', // midges' vision rings: 'all' | 'selected' | 'off'
  midgeLookEvery: 4, // midge tick rate: steps between looks at midges, flowers, scum and pads (taking turns)
  insectWind: 1, // how far the wind carries them
  insectHunger: 0.03, // energy a midge burns per second flying at 70 px/s (full = 1)
  insectBodyTime: 12, // seconds a dead midge's body lies before it is gone
  midgeLifespan: 120, // seconds from hatching before a midge ages
  midgeAgeSlow: 0.97, // past its lifespan, a midge's speeds x this every second
  midgeAgeBurn: 1.03, // past its lifespan, a midge's energy burn x this every second
  eggHatchTime: 15, // seconds a midge egg on the scum takes to hatch
  flowerNectar: 1, // meals (full energy) a flower holds
  flowerRegrow: 50, // seconds a drunk-dry flower takes to refill
  flowerRefills: 6, // refills before a flower wilts and rests (0 = never), varied per flower
  flowerDormancy: 100, // seconds a wilted flower rests before refilling, varied per flower
  mutationRate: 0.1, // chance each gene mutates in a hatchling
  mutationSize: 0.08, // typical mutation, as a fraction of the gene's range
  mutationFlip: 0.05, // chance a mutation flips the gene's sign instead
  midgeProfile: null, // the chosen profile ({ name, genes, ... }), if any
  midgeLocked: false, // every midge carries the profile's genome exactly, no mutations
  // How much of each plant kind grows (1 = as generated, 0 = none)
  plantRush: 1,
  plantReed: 1,
  plantCattail: 1,
  plantIris: 1, // yellow flowers (midge food)
  plantShrub: 1,
  plantPickerelweed: 1, // purple flowers (midge food)
  flowerVariation: 1.5, // how far each plant's flower (and cattail spike) strays from its kind's colour (0 = all alike)
  plantShallowDensity: 0.5, // share of the shallowest water and shore fringe that is planted (rest: open gaps)
  wakeRadius: 16, // px of water a swimming fish disturbs
  wakeStrength: 10, // how hard fish push the water
  wakeFade: 3, // rate (1/s) the disturbance settles
  scumAmount: 1, // how much duckweed scum covers the shallows (0 = none, 1 = as generated)
  scumAmongPlants: 0.5, // scum among the plants: 0 = none, 1 = as much as in open shallows, 2 = crowding into them
  padAmount: 1, // how many lily pad colonies grow (0 = none, 1 = as generated)
  scumDrag: 12, // how far fish shove the scum fronds
  scumCohesion: 0.3, // rate (1/s) neighbouring fronds drift together, closing gaps

  // Visualisation
  boidSize: 6,
  pixelSize: 1, // CSS px per rendered pixel (1 = full resolution)
  fishVisionMode: 'selected', // fish range rings: 'all' | 'selected' | 'off'
  fishLookEvery: 1, // fish tick rate: steps between looks at the shoal (taking turns)
  showVelocity: false,
  showSteering: false,
  showPlants: true, // reeds, cattails, iris, shrubs and lily pads (display only)
  velocityScale: 0.22, // px of arrow per px/s
  steeringScale: 0.08, // px of arrow per px/s²
  colorLevels: 24, // colour levels per channel (lo-fi palette depth)
  dithering: true, // ordered (Bayer) dithering between colour levels
  vignette: 0.45, // darkening towards the corners
}

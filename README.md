# Boid Evolution

A pond ecosystem simulated in the browser, built to keep changing over time instead of settling into one steady state. Fish and midges live in a pond that is drawn from scratch for every new map. Every creature runs on the GPU through one shared base boid, so new species and behaviours plug into the same machinery.

![A pond with schools of koi among plants, logs and lily pads, with the control panel on the right](docs/screenshot.png)

**The main goal is fish:** emergent schooling and foraging behaviour, and bodies that evolve under the pressures of the pond. The insects and the world around them are there to give the fish an environment worth adapting to.

## Why

Most boid demos fix their rules and tune them by hand. Here, as little as possible is scripted:

- **Behaviour emerges.** Schools, swarms, colonies and territories aren't programmed as groups. They come out of each individual's own rules and genes, and survive only if they help it feed and breed.
- **Traits evolve.** Each creature carries its own genome. Offspring inherit their mother's genome with mutations (now and then a mutation flips a gene's sign, so every gene also has a meaning when negative), and selection keeps whatever works in the current pond.
- **The world keeps changing.** Flowers drain and refill on their own cycles, clouds and plant shade move, predators rise and crash after their prey, and every new map has a different layout. No strategy stays best forever.

## What's in the pond

### Fish (the focus)

- Thousands of boids simulated entirely on the GPU (WebGL2 fragment-shader GPGPU): spatial hashing, sorting and neighbour search with a vision cone.
- Steering by alignment, cohesion and separation, plus avoiding the shore, banks and islands.
- Animated swimming (tail beat and body undulation), and murk that fades deeper fish.
- Every creature has a real height (z, with its vertical speed) as well as its place on the map: 0 is the water surface, below is negative. Fish swim at their own depth, wandering slowly up and down and rising over or diving under trunks at a limited rate, and a trunk is solid until they have actually cleared it. Midges fly at a height above the water. Click one to see its position and velocity in x, y and z.
- Per-fish traits already live in a GPU texture with room for a genome.

**Where it's heading:** fish get genomes like the insects have, covering behaviour (how they school, forage, flee and rest) and body (size, shape, fins, colour). Body traits will cost and gain something real in the pond, such as speed against energy, or size against hiding among plants. The fish then feed on the midges and are hunted in turn, so both behaviour and bodies evolve against a living, shifting ecosystem.

### Midges

- Small flies, boids on the GPU (tens of thousands run comfortably). A midge sees everything within its vision gene: other midges, flowers, scum and lily pads.
- Each thing it recognises pulls or pushes it by a gene of its own. Other midges act through cohesion, alignment and separation (1/distance², like personal space). Every other item has a signed weight, + to approach and − to avoid, so evolution decides. Flowers only pull as hard as the midge is hungry.
- A midge knows flowers only by their colour as drawn. Colour genes (red, green, blue) and a tolerance gene set which flowers draw it. Each flower's colour strays a little from its kind's, and it fades towards withered as it is drunk dry, so how full it looks is the cue. Only touching one tells whether it is open.
- Speed genes set its cruise speed (its own propulsion) and its min and max speed.
- Flying burns energy, more the faster. A hungry midge that touches a flower with nectar stops on it and drinks. It leaves after its eat-time gene's seconds, when the flower runs dry, or when its flock or the things it senses pull hard enough.
- With energy above its laying gene, scum draws it, and the further above, the harder. Touching scum, it lays an egg there, which costs 30% of its energy. The egg hatches after a set time (the Midges tab, World section) into a midge with a mutated copy of its genome.
- Past the lifespan (a slider), every second it gets slower and burns more energy, each by a multiplier you set, until it starves of old age. Otherwise it dies when its energy runs out. What selects is how many eggs a midge lays before then.
- It flies at the height its flight-height gene sets, climbing and sinking at a limited rate. Hungry with a flower it likes in sight, or ready to lay with scum in sight, it glides down, because it can only land or lay when it is low. The wind carries it harder the higher it flies.
- It sees rain within its vision: how much of what it sees is under rain clouds, and which way there is more. A rain gene steers it towards or away from the rain. A raindrop falling through a flying midge kills it, and these are the same drops drawn on the water.
- Its urge to rest is a rest gene plus four inputs, each weighed by a gene of its own: hunger, the urge to lay, the rain it sees, and a threat (fish moving in the water under it). Above 0 it comes down and rests where it is, on the water or the ground. Resting it burns little and is safe from rain, but it neither eats nor lays. It takes off once the urge drops below −0.15.
- Click a midge to see what it weighs, live: its inputs, the genes they pass through, and what they drive (steering, rest, height). Each line is green for a positive value and red for a negative one.
- Laying an egg on the water, or falling there dead, sends out a small round ripple.

### Dragonflies

Removed for now: they will be remade on the shared base boid.

### The world

- Each map is laid out from scratch: banks, islands, logs, and several kinds of plant spread across land, shallows and deeper water.
- Lily pads, drifting scum, silt, and a cached floor of leaf litter, pebbles and sunken twigs, lit by the sun and casting small shadows.
- Fallen trunks in a range of colours, some birch-like; they carry lichen (more near the water), algae at the waterline, and now and then shelf fungi on their drier stretches. Their colours are baked once per trunk layout.
- Lily colonies come in pink, white or yellow, with open blooms and buds.
- The Pond tab sets how much of the map is land (same map, floor raised or lowered), the water depth, and how far the scum spreads, including how far it creeps in among the plants.
- Sun and moving cloud shadows (which the creatures react to), wind (it wanders around the set direction and speed, changing gradually every so often), ripples, caustics and refraction.
- Rain (Weather): by default it starts and stops by itself, with showers and dry spells taking turns (how often it rains and how long showers last are sliders). The rain toggle shows whether it is raining, and flipping it takes the rain over by hand. The clouds thicken and darken over a few seconds, and while it rains its strength drifts around a set strength. Each drop is a real point that lands under a cloud. Its ring spreads over the water, from a midge's ripple up to three times its size, and stays whole even where it spreads into sunlight. The midges' sim uses the very same drops.
- Resizing the window keeps the world while it still fits (only the view is cropped), so a fullscreen browser showing its toolbar does not reset the pond. A bigger window lays it out again.
- **New map** lays out new shores and a new floor. **Randomize world** keeps the map's shape but rerolls its conditions: the plant mix, water depth, colour (peaty blue-green to muddy brown) and murk, trunks, floor details, sun, wind and clouds. Varying the world is how the creatures are kept from fitting one pond.

## Running it

```bash
npm install
npm run dev       # open the printed local URL
npm run build     # production build in dist/
```

A WebGL2-capable browser is required.

Nothing spawns by itself: the pond starts empty.
- **Fish:** use the Count slider in the Fish tab.
- **Midges:** use *Spawn random flock* in the Midges tab.

The panel's tabs come in two groups: **Creatures** (Fish, Midges) and **World** (Pond, Water, Weather, View). Next to *Play* / *Pause*, the sim speed slider fast-forwards the whole world. Click a fish or midge to inspect it: its range, what it sees and an arrow per force acting on it (Escape deselects). Hover over the tab at the bottom of the screen to see every population on one graph.

## Training and profiles

Evolution runs in the app: raise the sim speed at the top of the panel to fast-forward. (Headless training is gone for now, since the simulation runs on the GPU.)

In the app, each species' tab can:
- save a profile of either the **population average** (tagged *avg*) or the **selected individual's exact genes** (tagged *one*);
- import and export profiles (each species has its own format);
- spawn a population from a profile, or give it to everyone alive;
- lock everyone to a profile, so behaviour stops changing.

## Project layout

```
src/
  gpu/boids/   the GPU base boid (BoidKernel), its shader generator (codegen) and item sources
  gpu/         the pond on the GPU (nectar, items, shelter: PondGpu) and GPU fields (scum, silt, sway)
  species/     species definitions: genes, senses, forces and behaviour (fish, midges)
  render/      WebGL2 renderer and shaders (water, plants, creatures, clouds, focus overlay)
  sim/         CPU-side world: map, plants, lily pads, logs, genetics, profiles
  engine/      Engine: owns the world, steps the species, feeds the renderer
  components/  React UI: control panel, species tabs, population drawer
  config/      Default parameters and the world randomizer
```

Built with Vite, React 18, Tailwind CSS v4 and raw WebGL2.

## Adding a species

A species is one definition file in `src/species/` that the GPU base boid (`src/gpu/boids/BoidKernel.js`) runs:

- `genes`: its genome (`{ key, label, min, max }`); in GLSL each one reads as `G_<KEY>`. A boid's genes sit side by side in one texture, so a longer genome costs no extra texture units.
- `auxTextures`: 1 or 2 four-float textures of per-boid state that the species' own code reads (`aux`, `aux1`) and writes (`o_aux`, `o_aux1`) each step.
- `senses`: what it recognises. `flock` is its own kind, through the shared neighbour grid. `items` are fixed things from `gpu/PondGpu.js` (flowers, scum, lily pads), each giving the shader a pull `P_<key>`, a count `N_<key>` and the nearest one, `NEAR_<key>`.
- `tickParam` and `remember`: its tick rate, the param holding how many steps pass between looks around (the panel's Tick rate slider). Above 1 the boids take turns: each step a share of them senses its flock and items and keeps what it sensed in a small per-boid texture, and the rest recall theirs instead of scanning. `remember` names the flock totals `pre` declares that are kept (`{ n: 'int', sc: 'vec2' }`); the item senses are kept as the species' code uses them. Midges look every 4 steps by default, fish every step.
- `glsl`: its own code. `pre` sets how far it sees, `visit` runs for each neighbour, and `act` turns the senses into forces and moves it.
- `forces`: the force vectors to show. The selected boid's arrows and legend come from these.
- `spawn`, `describe`, `alive`: how a new one starts, how the selected one is described in the panel, and whether it counts as alive.
- `signals` (optional): `[key, glsl]` scalars the selected boid's debug pass writes out alongside its forces (midges: hunger, urge to lay, rain seen, threat, urge to rest, target height), which the panel uses for the gene diagram. `glsl.sense` (optional) is extra sensing that runs with the flock and items, on its sensing ticks.
- `lays` and `egg` (optional): births. The shader marks a lay in `aux1`, and `engine/Laying.js` reads it back and places an egg (`egg()`, with a mutated copy of the genome) in a free slot. Midges use this.

Range rings, selection, the force overlay, profiles and stats come from the base for free.

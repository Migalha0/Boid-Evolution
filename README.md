# Boid Evolution

A pond ecosystem simulated in the browser, built to keep changing over time instead of settling into one steady state. Fish, midges and dragonflies live in a pond that is drawn from scratch for every new map. They eat, breed, die, and pass their traits on with small mutations.

![A pond with schools of koi among plants, logs and lily pads, with the control panel on the right](docs/screenshot.png)

**The main goal is fish:** emergent schooling and foraging behaviour, and bodies that evolve under the pressures of the pond. The insects and the world around them are there to give the fish an environment worth adapting to.

## Why

Most boid demos fix their rules and tune them by hand. Here, as little as possible is scripted:

- **Behaviour emerges.** Schools, swarms, colonies and territories aren't programmed as groups. They come out of each individual's own rules and genes, and survive only if they help it feed and breed.
- **Traits evolve.** Each creature carries its own genome. Offspring inherit their mother's genome with mutations, and selection keeps whatever works in the current pond.
- **The world keeps changing.** Flowers drain and refill on their own cycles, clouds and plant shade move, predators rise and crash after their prey, and every new map has a different layout. No strategy stays best forever.

## What's in the pond

### Fish (the focus)

- Thousands of boids simulated entirely on the GPU (WebGL2 fragment-shader GPGPU): spatial hashing, sorting and neighbour search with a vision cone.
- Steering by alignment, cohesion and separation, plus avoiding the shore, banks and islands.
- Animated swimming (tail beat and body undulation), swim depth, and murk that fades deeper fish.
- Per-fish traits already live in a GPU texture with room for a genome.

**Where it's heading:** fish get genomes like the insects have, covering behaviour (how they school, forage, flee and rest) and body (size, shape, fins, colour). Body traits will cost and gain something real in the pond, such as speed against energy, or size against hiding among plants. The fish then feed on the midges and are hunted in turn, so both behaviour and bodies evolve against a living, shifting ecosystem.

### Midges

- Small flies that dance over flowers and scum mats, simulated on the CPU.
- They burn energy flying (more the faster they fly), drink nectar from flowers, and lay egg rafts on the water only when well fed.
- Their genes cover speed, search range, hunger, swarming, landing and resting, flower and scum preferences, shade, cohesion and separation, vigilance, sun-shyness, laying and brood size.
- Energy is conserved: each egg carries energy from its mother, so all of it comes from nectar.

### Dragonflies

- A separate species that hunts the midges. Their numbers follow the midges' with a delay.
- Their genes cover speed, agility, sight, chase patience, gut (fast and lean against slow and thorough digestion), ambush against patrol, territoriality, perching, laying, brood size, and an inherited body colour that shows lineages.
- They are cold-blooded, so they are slower in the shade. They also miss more often when the midge they strike at is in a dense swarm.

### The world

- Each map is laid out from scratch: banks, islands, logs, and several kinds of plant spread across land, shallows and deeper water.
- Nectar-bearing flowers (iris and pickerelweed) fade as they are drunk. Each one refills, and rests now and then on its own cycle.
- Lily pads, drifting scum, silt, and a cached floor of leaf litter, pebbles and sunken twigs.
- Sun and moving cloud shadows (which the creatures react to), wind, ripples, caustics and refraction.

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
- **Dragonflies:** use *Spawn random dragonflies* in the Dragonflies tab. They need midges to eat.

The sim speed slider at the top fast-forwards the whole world. Hover over the tab at the bottom of the screen to see every population on one graph.

## Training and profiles

Evolution can run in the app or headless, much faster than real time:

```bash
npm run train -- --minutes 120 --maps 6 --out profiles/run1.json
npm run train -- --from profiles/run1.json --dragon-from profiles/run1-dragonflies.json   # continue
npm run train -- showDragonflies=0 insectHunger=0.02                                       # change world params
```

Each run writes one profile per species: the mean genome of the population, plus the world it was trained in.

In the app, each species' tab can:
- save, import and export profiles (each species has its own format);
- spawn a population from a profile;
- lock everyone to a profile, so behaviour stops changing.

Headless training has no scum and no shade, so the genes tied to those are only shaped in the app.

## Project layout

```
src/
  gpu/         GPU fish simulation and GPU fields (scum, silt, sway)
  render/      WebGL2 renderer and shaders (water, plants, insects, clouds)
  sim/         CPU simulation: map, plants, lily pads, logs, midges, dragonflies, genetics, profiles
  engine/      Engine: owns the world, steps the sims, feeds the renderer
  components/  React UI: control panel, species tabs, population drawer
  config/      Default parameters
scripts/
  train.mjs    Headless training
```

Built with Vite, React 18, Tailwind CSS v4 and raw WebGL2.

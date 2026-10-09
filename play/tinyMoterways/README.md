# Tiny Motorways

A small traffic-puzzle game in the spirit of Mini Motorways, built with Three.js and strict
TypeScript. Houses and destinations of matching colors appear on a grid; you draw the roads that
let cars collect pins before a destination overflows. There are no asset files: the scene is
low-poly geometry and every sound is synthesised with the Web Audio API.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Then open the address Vite prints (http://localhost:5173 by default).

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload. |
| `npm run build` | Type-checks (`tsc`) and writes a production build to `dist/`. |
| `npm run preview` | Serves the production build. |
| `npm run check` | Headless self-check of the rules and the traffic model (about 40 s). Needs Node 22.6 or newer, which runs the TypeScript directly. |
| `npm run balance` | The same checks, then five seeded games of every city played to the end by the test autopilot, with the week it loses in. |

## Cities

| City | Difficulty | What makes it hard |
| --- | --- | --- |
| Tokyo | Normal | Railway lines with only a few level crossings; tunnels are scarce. |
| Los Angeles | Normal | Suburbs on the far side of two wide river channels; a starting motorway. |
| Rio de Janeiro | Hard | Granite ridges across the middle, one tunnel to start, less road each week, car parks that overflow sooner. |
| Stockholm | Expert | Six islands, two bridges, colors arriving from day 3, and the fastest-growing demand. |

## Controls

### Mouse and keyboard

| Input | Action |
| --- | --- |
| Left drag | Use the selected tool (the road tool draws along the drag). |
| Right drag | Erase, whatever tool is selected. |
| Middle drag | Pan the camera. |
| Wheel | Zoom about the pointer. |
| `Space` | Pause / resume. |
| `1` / `2` | Normal / double speed. |

### Touch

| Gesture | Action |
| --- | --- |
| One finger | Use the selected tool. A ring and crosshair mark the target cell so it is not hidden under the fingertip. |
| Two fingers | Pan and pinch-zoom. Two fingers never draw; a second finger landing mid-stroke ends the stroke where it is. |
| Tap a toolbar button | Choose Road, Erase, Motorway, Roundabout or Signal. |
| Gear button | Sound, dark mode, sound test, change city. |

The camera always frames the whole city. Panning or zooming only borrows it: about three seconds
after you stop (and are not mid-stroke) it eases back.

Placing tools (motorway, roundabout, signal) act where the pointer is *released*, so you can slide
to the right spot first and watch the preview.

## Rules of each tool

### Road
- Drag from cell to cell. The road follows the direction the pointer moves, snapped to the eight
  compass directions, so a 45° drag gives a clean diagonal and a fast drag leaves no gaps.
- One road tile per new ground cell. Erasing refunds it.
- **Water needs a bridge, mountains and railways need a tunnel.** One item carries one *straight*
  crossing along a grid axis. Turning on the water, branching off sideways or starting a second
  crossing each cost another, and two different crossings cannot be joined mid-water. Crossing cells
  cost no tiles. Erasing the whole crossing refunds the item.
- **Diagonals** cost the same as any step and are a true √2 cells long for the cars. A diagonal may
  not cross another diagonal (or a diagonal driveway), may not clip the corner of water, a mountain
  or a railway, and may not squeeze between two buildings; it may pass one. Bridges and tunnels
  never run diagonally. When a diagonal step is refused, the tool lays it as a corner instead (one
  cell along, one across) if open ground allows.
- Roads never attach to a building directly. Buildings join the network through their driveway or
  entrance (below).
- Drawing over a road that is waiting to be removed cancels the removal.

### Houses and driveways
- Every house has a driveway pointing at one of its eight neighbouring cells, and joins the network
  **only** through that cell. The stub is always drawn: pale while that cell has no road, paved once
  it has.
- **Turning a driveway is free and builds nothing.** Drag one cell out of the house and release: the
  driveway swings to that cell. Keep dragging and the road starts from there. Drawing a road up to a
  house also swings its driveway round to meet it.
- A driveway can face any neighbour that is open ground (not water, mountain, rail or a building),
  subject to the diagonal rules above.
- Cars that are out when a driveway is turned come home by the new one; if it now faces empty
  ground they are let in by the old way, which then closes.

### Destinations and car parks
- A destination is a building with a car park in front of it: 2×2 cells (three bays) or 3×2 (six).
- It has **one entrance**: the gap in the kerb, marked with a painted arrow in each lane and a stub
  of pale road until you connect it. Pointing the road tool at any part of the destination rings the
  one cell a road has to reach. Roads cannot be drawn through the car park or the building (the
  cursor turns red there).
- One car drives in at a time and one out. A car needs a free bay before it turns in; otherwise it
  waits on the road and a queue forms behind it, so give busy destinations some road to queue on.

### Erase
- Erases the roads of the cell under the pointer. A road with cars on it turns red and stays until
  they are off it, then disappears and is refunded; nothing is ever pulled out from under a car.
  Cars cut off from their destination hand the pin back and drive home.
- **Motorways are erased by their deck:** click or drag across the raised part. Only the motorway
  goes; the roads at its two ends stay. Erasing an end cell removes the motorway along with that
  cell's roads.
- Erasing any cell of a roundabout (or its island) removes the whole roundabout and refunds it.
- Houses and destinations cannot be erased.

### Motorway
- Press on one cell, release on another. Both ends must be open ground, at least four cells apart.
- It flies over roads, buildings, railways and mountains for free. **Flying over water also uses a
  bridge** (refunded with the motorway), so it is never a free substitute for one.
- Cars drive it 1.8× faster. Pillars are placed only on open ground, never on a road or building.
- A ramp may not pass over a building while it is still too low to clear it, and nothing is built
  under a ramp afterwards; mid-span the deck clears every building.
- The deck turns see-through whenever the pointer (or the finger using a tool) is at
  or near it, so it never hides what is underneath while you work.

### Roundabout
- A 3×3 one-way ring round an island. While the tool is selected the pointer carries a preview of
  the ring itself: grey where it can go, red where it cannot (it needs nine cells of open ground with
  no building, motorway end or other roundabout).
- Roads already inside the footprint are absorbed and their tiles refunded; roads leading out stay
  attached. New roads can join any of the eight ring cells from any side, diagonals included.
- **Placed on a road with cars on it, it is queued:** the roads under it close to new traffic (they
  turn red, with a pale ring showing where it will be) and it builds itself the moment the last car
  has left, usually within a couple of seconds. Erasing there cancels it and reopens the road.
- Traffic already on the ring goes before traffic joining it.

### Signal
- Tap a junction of three or more roads to add a signal, tap again to take it back.
- Each road axis through the junction gets a green phase in turn, with an all-red pause between.
  Turning cars still give way to oncoming traffic within their phase.

### Saving
- The game saves itself to the browser's storage every few seconds, after each weekly pick, and when
  the tab is hidden or closed. Opening the page again picks it up, paused, in the same city.
- Cars are not saved: on loading, every car is back in its garage and the pins it was heading for
  are still waiting. A roundabout that was waiting for cars to clear is simply built.
- A finished game is forgotten; starting a city from the menu replaces the saved one.

### The week
- A day lasts 13 seconds, with the sun crossing the sky once; a week is seven days.
- Each Sunday midnight the game pauses and offers two deliveries: an upgrade (motorway, roundabout,
  signal, bridge or tunnel) bundled with road tiles. Pick one.
- A destination that fills its pin meter starts a countdown; if it runs out, the game is over.

## How traffic behaves

Cars drive on the right in real lanes and never overlap. Three rules, in order
(`src/simulation/TrafficEngine.ts`):

1. **Right of way.** A car needs permission for each node before entering it. Permission is given
   longest-wait-first, never while its path would touch what is left of another car's.
2. **Keep junctions clear.** A car is only let into a place where it would be in someone's way if
   there is room for it to stand beyond. A ring of queues each waiting on the next is detected and
   released together.
3. **Never touch.** Each step a car moves only as far as its body stays clear of every other.

Practical consequences worth knowing as a player: cars leave a gap at each driveway and car-park
entrance that someone may need to turn across, so a street lined with houses holds roughly one
queued car per cell; and a car waiting for a bay blocks the lane behind it.

## Adding a city

Everything about a city is one `CityConfig` object in `src/levels/CityConfigs.ts`. Add one and
append it to the `CITIES` array at the bottom of that file; the menu, the game and the self-check
pick it up from there.

```ts
const MY_CITY: CityConfig = {
  id: 'my-city',
  name: 'My City',
  difficulty: 'Hard',                       // 'Normal' | 'Hard' | 'Expert', shown on the menu card
  tagline: 'One line for the menu card.',
  width: 36,                                // grid size in cells
  height: 24,
  features: [
    // every cell within width/2 of the polyline becomes that terrain; later entries override earlier ones
    { terrain: 'water', path: [[10, -1], [12, 12], [9, 25]], width: 2 },
    { terrain: 'rail', path: [[-1, 8], [37, 8]], width: 1 },
    { terrain: 'ground', path: [[20, 8]], width: 1 },               // a level crossing through the rail
    { terrain: 'mountain', path: [[28, 3], [33, 6]], width: 2.2 },
  ],
  // optional: zones: { residential: [...rects], commercial: [...rects] } to keep houses and destinations apart
  palette: { ground: '#F4F1EA', water: '#A9D6E5', bank: '#E6E1D5', channel: 1 },
  start: { tiles: 30, bridges: 1, tunnels: 1, motorways: 0, roundabouts: 0, lights: 1 },
  weeklyTiles: [20, 24],                    // road tiles bundled with each weekly pick
  upgradeWeights: { motorway: 1, roundabout: 3, light: 3, bridge: 2, tunnel: 3 },   // 0 never offers that upgrade
  colorUnlockDays: [0, 3, 8, 14, 21],       // the day each color first appears
  spawn: { interval: 7.5, houseDist: [3, 7], destSpacing: 3, startArea: 0.4, areaPerDay: 0.02, destEveryDays: 6, housesPerDest: [2, 4] },
  demand: { pinInterval: 6.5, weeklyFactor: 0.92, minInterval: 1.2, maxPins: [6, 7], overflowSeconds: 28 },
};
```

Every field is documented on the `CityConfig` type in `src/types.ts`. The levers that set
difficulty, roughly in order of effect: `start.tiles` and `weeklyTiles` (how much road you get),
`colorUnlockDays` and `spawn.destEveryDays` (how fast the city asks for more),
`demand.weeklyFactor` (how fast pins speed up) and `demand.overflowSeconds` (how long a full
destination survives).

Then run `npm run balance`. It plays five seeded games of each city with a careful but unimaginative
autopilot (it connects everything by the cheapest legal road, and never uses motorways, roundabouts
or signals) and prints the week it loses in. For reference it currently lasts 7 to 13 weeks on the
Normal cities, 5 to 7 on Rio and 4 to 7 on Stockholm; a person using the upgrades should outlast it.
The self-check also fails if a city marked harder turns out easier for the autopilot than one
marked easier.

Terrain tips: leave at least one way between any two parts of the map that needs no upgrade, or
start the player with the upgrade that opens one. The game never places a building in, or directly
in front of, a one-cell gap through water, rail or mountain, so level crossings stay usable.

## Project layout

| File | Role |
| --- | --- |
| `src/types.ts` | Shared types: grid, cars, buildings, city configuration. |
| `src/levels/CityConfigs.ts` | The cities, the color palette and the upgrade catalogue. |
| `src/simulation/RoadGraph.ts` | The grid, every building rule and its cost, and the lane geometry cars drive. |
| `src/simulation/TrafficEngine.ts` | Every car: routing, right of way, queues, car parks. |
| `src/simulation/CityDirector.ts` | The calendar, where buildings appear, pin demand, the weekly draft, game over. |
| `src/renderer/ThreeRenderer.ts` | Three.js scene: camera, day and night, roads, buildings, cars, pointer feedback. |
| `src/audio/SynthAudio.ts` | Procedural sound. |
| `src/ui/Overlay.ts` | HTML/SVG HUD, toolbar, dialogs, sound-test panel. |
| `src/main.ts` | Input (mouse, touch, keyboard) and the game loop. |
| `scripts/selfcheck.ts` | The headless self-check and balance run. |

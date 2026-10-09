// Headless check of the simulation: `npm run check`. Fails loudly if the rules or the traffic model break.
import { CITIES } from '../src/levels/CityConfigs.ts';
import { LEVEL_GAP, MOTORWAY_MIN, RoadGraph, overlap, samplePiece } from '../src/simulation/RoadGraph.ts';
import { TrafficEngine } from '../src/simulation/TrafficEngine.ts';
import { CityDirector, DAY_SECONDS, planDestination } from '../src/simulation/CityDirector.ts';
import { SOUNDS, SynthAudio } from '../src/audio/SynthAudio.ts';
import type { Car, CityConfig, Destination, House, Inventory } from '../src/types.ts';

const STEP = 1 / 60;

function check(ok: unknown, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
}

function seeded(seed: number) {   // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const [tokyo] = CITIES;
const open: CityConfig = { ...tokyo, name: 'Open ground', features: [] };   // the Tokyo grid with nothing in the way
const plenty = (): Inventory => ({ tiles: 500, bridges: 9, tunnels: 9, motorways: 9, roundabouts: 9, lights: 9 });
type XY = [number, number];

/** A hand-built scene: a graph plus the buildings and traffic on it. */
function scene(inv: Inventory = plenty(), config: CityConfig = tokyo) {
  const g = new RoadGraph(config, inv);
  const city = { houses: [] as House[], dests: [] as Destination[], score: 0 };
  const traffic = new TrafficEngine(g, city as unknown as CityDirector, () => {});
  let ids = 1;
  const at = (x: number, y: number) => g.cell(x, y);
  return {
    g, inv, city, traffic, at,
    /** Lay road through the given cells; true if every step was accepted. */
    road: (...pts: XY[]) => pts.slice(1).every((p, i) => g.addRoad(at(...pts[i]), at(...p))),
    /** A house on `xy` with its driveway pointing at the neighbouring cell `face`. */
    house(xy: XY, face: XY, color = 0): House {
      const h: House = { id: ids++, cell: at(...xy), color, cars: 2, facing: at(...face) };
      check(g.isFree(h.cell) && g.canFace(h.cell, h.facing), `house at ${xy} can face ${face}`);
      g.addHouse(h.cell, h.facing);
      city.houses.push(h);
      return h;
    },
    /** A destination whose car park is entered at `xy`, driving in the direction `dir`. */
    dest(xy: XY, dir: XY, color = 0, length = 2): Destination {
      const plan = planDestination(g, at(...xy), dir[0], dir[1], length)!;
      check(plan && plan.cells.every(c => g.isFree(c)), `destination fits at ${xy}`);
      const d: Destination = { ...plan, id: ids++, color, pins: 0, assigned: 0, maxPins: 6, overflow: 0, pinIn: 0, entering: null, leaving: null };
      g.addDest(d.cell, d.entry, d.cells);
      city.dests.push(d);
      return d;
    },
  };
}

/**
 * Watches a traffic engine for the things that must never happen. Call the returned function after
 * every step: it fails if two cars overlap (parked ones included), if a car jumps, or if one
 * appears or vanishes anywhere but in its own garage.
 */
function watch(g: RoadGraph, traffic: TrafficEngine, what: string) {
  const last = new Map<number, { x: number; z: number; state: string; home: number }>();
  let steps = 0;
  return () => {
    steps++;
    const cars = traffic.cars, seen = new Set<number>();
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i], p = a.pos;
      seen.add(a.id);
      check(Number.isFinite(p.x + p.y + p.z + p.heading), `${what}: car position is finite`);
      const was = last.get(a.id);
      const where = `${what}: car ${a.id} (${a.state}) at ${p.x.toFixed(2)},${p.z.toFixed(2)} after ${(steps * STEP).toFixed(1)}s`;
      if (!was) check(Math.hypot(p.x - g.x(a.house.cell), p.z - g.y(a.house.cell)) < 0.5, `${where} appeared away from its garage`);
      else check(Math.hypot(p.x - was.x, p.z - was.z) < 0.12, `${where} jumped from ${was.x.toFixed(2)},${was.z.toFixed(2)}`);
      last.set(a.id, { x: p.x, z: p.z, state: a.state, home: a.house.cell });
      for (let k = i + 1; k < cars.length; k++) {
        const b = cars[k], q = b.pos;
        if (Math.abs(p.x - q.x) > 0.4 || Math.abs(p.z - q.z) > 0.4 || Math.abs(p.y - q.y) >= LEVEL_GAP) continue;
        check(!overlap(p.x, p.z, p.heading, q.x, q.z, q.heading, -0.004), `${where} overlaps car ${b.id} (${b.state}) at ${q.x.toFixed(2)},${q.z.toFixed(2)}`);
      }
    }
    for (const [id, was] of last) {
      if (seen.has(id)) continue;
      check(was.state === 'toHome' && Math.hypot(was.x - g.x(was.home), was.z - g.y(was.home)) < 0.5, `${what}: car ${id} vanished at ${was.x.toFixed(2)},${was.z.toFixed(2)}`);
      last.delete(id);
    }
  };
}

/** Run a hand-built scene with bottomless demand, checking the invariants every step. Returns trips completed. */
function drive(s: ReturnType<typeof scene>, seconds: number, what: string, each?: (t: number) => void): number {
  const guard = watch(s.g, s.traffic, what), before = s.city.score;
  for (let i = 0; i < seconds / STEP; i++) {
    for (const d of s.city.dests) d.pins = Math.max(d.pins, 4);
    s.traffic.update(STEP);
    guard();
    each?.(i * STEP);
  }
  return s.city.score - before;
}

// ---------- build rules and refunds ----------
{
  const s = scene({ tiles: 20, bridges: 1, tunnels: 1, motorways: 1, roundabouts: 1, lights: 1 });
  const { g, inv, at } = s, start = { ...inv };
  const row = 10, cells = [12, 13, 14, 15, 16].map(x => at(x, row));
  for (let i = 1; i < cells.length; i++) check(g.addRoad(cells[i - 1], cells[i]), 'draw on open ground');
  check(inv.tiles === 15, 'a road costs one tile per cell');
  check(!g.addRoad(cells[0], cells[2]), 'non-adjacent cells cannot be linked');

  // river crossing at y = 10: one bridge covers the whole straight span, water cells cost no tiles
  const river: number[] = [];
  for (let x = 11, wet = false; ; x--) {
    const c = at(x, row);
    river.push(c);
    if (g.terrain[c] === 'water') wet = true;
    else if (wet) break;
  }
  let from = cells[0];
  for (const c of river) {
    check(g.addRoad(from, c), 'draw across the river');
    from = c;
  }
  const dry = river.filter(c => g.terrain[c] === 'ground').length;
  check(dry < river.length && inv.bridges === 0 && inv.tiles === 15 - dry, 'one bridge for the whole crossing, tiles only on the banks');
  check(g.findPath(cells[4], id => id === from, { toward: from })?.length === cells.length + river.length, 'path runs the full road');

  check(g.addRoad(cells[2], at(14, 9)) && g.toggleLight(cells[2]) && inv.lights === 0, 'light on a 3-way junction');
  check(g.toggleLight(cells[2]) && inv.lights === 1 && g.toggleLight(cells[2]), 'a light can be taken off and put back');

  // erasing only marks roads as closing; with no cars on them the next sweep removes and refunds them
  for (const c of [...g.nodes.keys()]) g.erase(c);
  check(g.nodes.size > 0 && inv.tiles < start.tiles, 'erased roads stay until swept');
  check(!g.findPath(cells[0], id => id === cells[4]), 'closing roads are not offered to new trips');
  check(g.addRoad(cells[0], cells[1]) && !g.closing.has(g.linkKey(cells[0], cells[1])), 'drawing over a closing road cancels the erase');
  g.erase(cells[0]);
  g.sweep(() => false);
  check(g.nodes.size === 0, 'sweeping removes every unused closing road');
  check(JSON.stringify(inv) === JSON.stringify(start), `erase refunds everything (${JSON.stringify(inv)})`);
}

// ---------- bridges and tunnels: one item per straight crossing ----------
{
  const { g, inv, at, road } = scene({ tiles: 60, bridges: 4, tunnels: 3, motorways: 0, roundabouts: 0, lights: 0 });
  // Tokyo Bay: on row 19 the shore is at x = 26 and everything east of it is open water
  check(road([24, 19], [25, 19], [26, 19]), 'approach road');
  const link = (ax: number, ay: number, bx: number, by: number) => g.addRoad(at(ax, ay), at(bx, by));
  check(link(26, 19, 27, 19) && inv.bridges === 3, 'entering the water starts a bridge');
  check(link(27, 19, 28, 19) && inv.bridges === 3, 'carrying straight on is the same bridge');
  check(!link(28, 19, 29, 20), 'bridges cannot run diagonally');
  check(link(28, 19, 28, 20) && inv.bridges === 2, 'turning on the water costs another bridge');
  check(link(28, 20, 28, 21) && inv.bridges === 2, 'and that one also carries straight on');
  check(link(27, 19, 27, 20) && inv.bridges === 1, 'branching off sideways costs another bridge');
  check(!link(27, 20, 28, 20), 'two different bridges cannot be joined mid-water');
  check(link(27, 20, 26, 20) && inv.bridges === 0, 'a further turn costs the last bridge');
  check(!link(28, 21, 29, 21) && inv.bridges === 0, 'no bridges left, no more crossings');
  const tiles = inv.tiles;
  for (const c of [...g.nodes.keys()]) g.erase(c);
  g.sweep(() => false);
  check(inv.bridges === 4 && inv.tiles > tiles && g.spans.size === 0, 'every bridge is refunded exactly once');

  // the rail line at y = 6 needs a tunnel; a second pass under it elsewhere needs a second
  check(link(10, 7, 10, 6) && link(10, 6, 10, 5) && inv.tunnels === 2, 'one tunnel under the railway');
  check(link(15, 7, 15, 6) && link(15, 6, 15, 5) && inv.tunnels === 1, 'a second crossing costs a second tunnel');
}

// ---------- motorways: long, dry-footed, and no free bridges ----------
{
  const { g, inv, at } = scene({ tiles: 10, bridges: 1, tunnels: 0, motorways: 3, roundabouts: 0, lights: 0 });
  check(MOTORWAY_MIN === 4 && !g.addMotorway(at(12, 12), at(15, 13)), 'a motorway shorter than four cells is refused');
  check(g.addMotorway(at(12, 12), at(16, 12)) && inv.motorways === 2 && inv.bridges === 1, 'four cells over dry land costs just the motorway');
  check(!g.addMotorway(at(12, 14), at(6, 14)), 'a motorway cannot end on water');
  check(g.addMotorway(at(12, 14), at(3, 14)) && inv.motorways === 1 && inv.bridges === 0, 'flying over the river also takes a bridge');
  check(!g.addMotorway(at(12, 16), at(3, 16)), 'and without a bridge left it is refused');
  check(g.addMotorway(at(12, 16), at(12, 3)) && inv.motorways === 0, 'flying over the railway is free');
  for (const c of [...g.nodes.keys()]) g.erase(c);
  g.sweep(() => false);
  check(inv.motorways === 3 && inv.bridges === 1 && g.nodes.size === 0, 'motorways and their bridges are refunded exactly');

  // the deck clears a building in mid-span, but its ramps are too low to pass over one
  const low = scene({ tiles: 10, bridges: 0, tunnels: 0, motorways: 2, roundabouts: 0, lights: 0 }, open);
  low.house([13, 12], [13, 13]);
  low.house([16, 14], [16, 15]);
  check(!low.g.addMotorway(low.at(12, 12), low.at(20, 12)) && low.inv.motorways === 2, 'a motorway whose ramp would cut through a house is refused');
  check(low.g.addMotorway(low.at(12, 14), low.at(20, 14)) && low.inv.motorways === 1, 'one that passes over a house in mid-span is fine');
  check(low.g.underRamp(low.at(12, 14), low.at(20, 14)).includes(low.at(13, 14)) && !low.g.underRamp(low.at(12, 14), low.at(20, 14)).includes(low.at(16, 14)), 'and the cells under its ramps are known, so nothing is built there later');

  // a motorway can be erased on its own, by its deck, leaving the roads at both ends alone
  const a = at(12, 12), b = at(16, 12);
  check(g.addRoad(at(11, 12), a) && g.addRoad(b, at(17, 12)) && g.addMotorway(a, b) && inv.motorways === 2, 'a motorway between two roads');
  check(g.motorways().length === 1 && g.motorways()[0].join() === [a, b].join(), 'it is listed once, by its ends');
  const tiles = inv.tiles;
  check(g.eraseMotorway(a, b) && !g.eraseMotorway(a, b) && !g.eraseMotorway(at(11, 12), a), 'erasing it once works; twice, or on a plain road, does nothing');
  g.sweep(() => false);
  check(inv.motorways === 3 && inv.tiles === tiles && g.motorways().length === 0, 'the motorway is refunded and nothing else is');
  check(g.nodes.get(a)!.links.has(at(11, 12)) && g.nodes.get(b)!.links.has(at(17, 12)), 'and the roads at its ends are still there');
}

// ---------- diagonals ----------
{
  const s = scene({ tiles: 60, bridges: 2, tunnels: 0, motorways: 0, roundabouts: 0, lights: 0 });
  const { g, inv, at, road } = s;
  check(road([12, 12], [13, 13], [14, 14]) && inv.tiles === 57, 'diagonal steps cost one tile per cell like any other');
  check(!road([13, 12], [12, 13]), 'a diagonal may not cross another diagonal');
  check(road([13, 12], [14, 13]), 'but may run alongside one');
  // row 18: water starts at x = 28, so the corner between (27,18) and (28,17) belongs to the bay
  check(g.terrain[at(28, 18)] === 'water' && g.terrain[at(27, 18)] === 'ground' && g.terrain[at(28, 17)] === 'ground', 'test corner is on the shore');
  check(!road([27, 18], [28, 17]), 'a diagonal may not clip the corner of water');
  check(g.terrain[at(13, 6)] === 'ground' && g.terrain[at(12, 6)] === 'rail' && !road([12, 5], [13, 6]) && !road([13, 6], [14, 7]), 'nor the corner of a railway');
  s.house([16, 16], [16, 15]);
  check(road([15, 16], [16, 17]), 'a diagonal may pass one building');
  s.house([18, 16], [18, 15]);
  s.house([19, 17], [19, 18]);
  check(!road([18, 17], [19, 16]), 'but not squeeze between two');
  check(!g.addRoad(at(16, 16), at(17, 16)) && !g.addRoad(at(15, 15), at(16, 16)), 'roads never attach to a building directly');
  check(Math.abs(g.edgeLen(at(12, 12), at(13, 13)) - Math.SQRT2) < 1e-9, 'a diagonal step is root two long');
  const straight = g.findPath(at(12, 12), id => id === at(14, 14))!;
  check(straight.length === 3, 'routes use diagonals');
}

// ---------- driveways ----------
{
  const s = scene({ tiles: 30, bridges: 0, tunnels: 0, motorways: 0, roundabouts: 0, lights: 0 });
  const { g, inv, at, road } = s;
  const home = s.house([12, 12], [13, 12]);
  const linked = (to: XY) => { const l = g.nodes.get(home.cell)!.links.get(at(...to)); return !!l && !l.closing; };
  const face = (to: XY) => { const ok = g.setDriveway(home.cell, at(...to)); if (ok) home.facing = at(...to); g.sweep(() => false); return ok; };
  const nodes = g.nodes.size;
  check(face([12, 11]) && inv.tiles === 30 && g.nodes.size === nodes, 'turning a driveway costs nothing and builds nothing');
  check(!linked([12, 11]) && !g.findPath(home.cell, () => true), 'facing empty ground connects nothing');
  check(!face([12, 11]), 'facing the way it already faces is not a change');
  check(road([11, 11], [12, 11], [13, 11], [14, 11]) && linked([12, 11]), 'a road laid past the driveway picks the house up');
  check(face([13, 13]) && !linked([12, 11]) && !linked([13, 13]) && g.nodes.has(at(12, 11)) && inv.tiles === 26, 'turning away disconnects and leaves the road alone');
  check(face([13, 11]) && linked([13, 11]), 'driveways can face diagonally and connect to a road there');
  check(g.findPath(home.cell, id => id === at(14, 11))?.[1] === at(13, 11), 'the house joins the network only through the cell it faces');
  s.house([11, 13], [10, 13]);
  check(!face([11, 13]), 'a driveway cannot face another building');
  check(!g.setDriveway(home.cell, at(14, 12)), 'nor a cell that is not a neighbour');
  const shore = s.house([8, 10], [9, 10]);
  check(g.terrain[at(7, 10)] === 'water' && !g.setDriveway(shore.cell, at(7, 10)), 'nor water');
  check(!road([13, 12], [12, 11]), 'a road may not cross a diagonal driveway');
  check(!g.erase(home.cell), 'a house cannot be erased');
  g.erase(at(13, 11));
  g.sweep(() => false);
  check(!linked([13, 11]) && g.doors.get(home.cell) === at(13, 11), 'erasing the road outside disconnects the house but keeps its driveway');
  check(road([12, 11], [13, 11]) && linked([13, 11]), 'and redrawing it reconnects');
}

// ---------- roundabouts: 3x3, one-way, joined from any side ----------
{
  const s = scene({ tiles: 40, bridges: 0, tunnels: 0, motorways: 0, roundabouts: 1, lights: 1 });
  const { g, inv, at, road } = s;
  check(road([11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12]) && road([14, 10], [14, 11], [14, 12], [14, 13], [14, 14]), 'a crossroads to convert');
  check(g.toggleLight(at(14, 12)) && inv.tiles === 29 && inv.lights === 0, 'with a signal on it');
  check(g.addRoundabout(14, 12) && inv.roundabouts === 0, 'roundabout placed over the crossroads');
  check(inv.tiles === 34 && inv.lights === 1, 'the five cells it took over and the signal are refunded');
  const ring = [...g.rings.values()][0];
  check(ring.length === 8 && g.blocked.has(at(14, 12)) && !g.nodes.has(at(14, 12)), 'eight cells round an island');
  check(ring.every(c => Math.abs(Math.hypot(g.px(c) - 14, g.pz(c) - 12) - 1) < 1e-9), 'all eight sit on one circle');
  const [west, north, east, south] = [at(12, 12), at(14, 10), at(16, 12), at(14, 14)];
  for (const [spoke, cell] of [[west, at(13, 12)], [north, at(14, 11)], [east, at(15, 12)], [south, at(14, 13)]]) check(g.nodes.get(spoke)!.links.has(cell), 'the four roads stayed attached');
  check(road([12, 10], [13, 11]) && road([16, 14], [15, 13]), 'diagonal roads join the corner cells');
  const hops = (a: number, b: number) => g.findPath(a, id => id === b, { toward: b })!.length;
  check(hops(west, south) === 5 && hops(south, west) === 9, 'traffic circulates one way: a quarter turn out, three quarters back');
  check(hops(at(12, 10), at(16, 14)) === 7 && hops(at(16, 14), at(12, 10)) === 7, 'corner to corner is half way round either way');
  check(!g.addRoad(at(13, 12), at(14, 12)) && !g.addRoad(at(13, 12), at(14, 11)), 'nothing can be drawn across the island or between ring cells');
  check(!g.strict(at(14, 13)) || g.nodes.get(at(14, 13))!.links.size > 2, 'ring cells with no road joining are plain bends');
  check(g.erase(at(14, 12)), 'erasing the island erases the roundabout');
  g.sweep(() => false);
  check(inv.roundabouts === 1 && g.rings.size === 0 && !g.blocked.has(at(14, 12)) && g.isFree(at(14, 12)), 'and refunds it');
}

// ---------- roundabouts over busy roads: built as soon as the cars on them have left ----------
{
  const s = scene({ tiles: 60, bridges: 0, tunnels: 0, motorways: 0, roundabouts: 2, lights: 0 }, open);
  const { g, inv, at, road } = s;
  check(road([8, 12], [9, 12], [10, 12], [11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12], [18, 12], [19, 12], [20, 12]) && road([14, 9], [14, 10], [14, 11], [14, 12], [14, 13], [14, 14], [14, 15]), 'a crossroads on a long road');
  for (const x of [8, 9, 10]) { s.house([x, 11], [x, 12]); s.house([x, 13], [x, 12]); }
  const shop = s.dest([21, 12], [1, 0], 0, 3), guard = watch(g, s.traffic, 'pending roundabout');
  const step = (seconds: number, until?: () => boolean) => {
    for (let i = 0; i < seconds / STEP; i++) {
      shop.pins = Math.max(shop.pins, 5);
      s.traffic.update(STEP);
      guard();
      if (until?.()) return true;
    }
    return !until;
  };
  const onIt = () => s.traffic.cars.some(c => c.state !== 'parked' && Math.abs(c.pos.x - 14) < 0.8 && Math.abs(c.pos.z - 12) < 0.3);
  check(step(30, onIt), 'a car is driving over the crossroads');
  const tiles = inv.tiles;
  check(g.canRoundabout(14, 12) && g.addRoundabout(14, 12), 'a roundabout can still be placed there');
  check(g.rings.size === 0 && g.pending.has(at(14, 12)) && inv.roundabouts === 1 && inv.tiles === tiles, 'it is paid for but waits: nothing is rebuilt under a car');
  check(!g.findPath(at(8, 12), id => id === at(20, 12)), 'meanwhile the crossroads is closed to new trips');
  check(!g.addRoundabout(15, 12), 'and a second roundabout cannot overlap the one that is waiting');
  check(step(20, () => g.rings.size === 1), 'the roundabout is built once the crossroads is empty');
  check(!g.pending.size && !g.closing.size && inv.roundabouts === 1 && inv.tiles === tiles + 5, 'with its five road tiles handed back, and nothing left closed');
  check([at(12, 12), at(16, 12), at(14, 10), at(14, 14)].every(c => [...g.nodes.get(c)!.links.keys()].some(m => g.nodes.get(m)!.ring >= 0)), 'all four roads still join it');
  const before = s.city.score;
  step(40);
  check(s.city.score - before >= 12, `and traffic carries on through it (${s.city.score - before} trips in 40 s)`);

  // calling a waiting roundabout off puts the road back exactly as it was
  check(step(30, () => s.traffic.cars.some(c => c.state !== 'parked' && Math.abs(c.pos.x - 18) < 0.8 && Math.abs(c.pos.z - 12) < 0.3)), 'a car is on the stretch further along');
  check(g.addRoundabout(18, 12) && g.pending.has(at(18, 12)) && inv.roundabouts === 0, 'a second roundabout waits there');
  check(g.erase(at(18, 12)) && !g.pending.size && !g.closing.size && inv.roundabouts === 1, 'erasing it cancels it, refunds it and reopens the road');
  check(!!g.findPath(at(8, 12), id => id === at(20, 12)) && g.rings.size === 1, 'so trips run through again and nothing was built');
}

// ---------- lane geometry: every route is one continuous line ----------
{
  const { g, at, road } = scene();
  const pts: XY[] = [[10, 10], [11, 10], [12, 11], [13, 11], [12, 12], [12, 13], [13, 13], [14, 12], [15, 12]];
  check(road(...pts), 'a road with 45, 90 and 135 degree bends');
  const r = pts.map(p => at(...p));
  const a = { x: 0, y: 0, z: 0, heading: 0 }, b = { ...a };
  const pieces = [g.stub(r[0], r[1], false)];
  for (let i = 0; i + 1 < r.length; i++) {
    pieces.push(g.run(r[i], r[i + 1]));
    if (i + 2 < r.length) pieces.push(g.turn(r[i], r[i + 1], r[i + 2]));
  }
  pieces.push(g.stub(r[r.length - 2], r[r.length - 1], true));
  let total = 0;
  for (let i = 0; i + 1 < pieces.length; i++) {
    samplePiece(pieces[i], pieces[i].length, a);
    samplePiece(pieces[i + 1], 0, b);
    check(Math.hypot(a.x - b.x, a.z - b.z) < 1e-3, `lane pieces ${i} and ${i + 1} meet`);
    total += pieces[i].length;
  }
  check(total > 7 && total < 12, `route length is the true driven distance (${total.toFixed(2)})`);
  // the two directions pass each other round every bend, the 135 degree hairpin at r[3] included:
  // the inside lane pivots short of the corner while the outside lane swings wide round it
  check(!g.strict(r[1]) && !g.strict(r[5]), 'plain bends are free-flowing');
  check(!g.strict(r[3]) && g.conflictUntil(g.turn(r[2], r[3], r[4]), g.turn(r[4], r[3], r[2])) === -Infinity, 'and so is a 135 degree hairpin');
  check(g.turn(r[4], r[3], r[2]).length > 2 * g.turn(r[2], r[3], r[4]).length, 'whose inside lane is a tight pivot and whose outside lane goes the long way round');
}

// ---------- traffic: every road feature carries cars, and nothing ever touches or jumps ----------
{
  const s = scene();
  const { g, at, road } = s;
  // three driveways -> junction -> roundabout -> signalled crossroads -> motorway -> car park
  check(road([11, 11], [11, 12], [11, 13]) && road([11, 12], [12, 12], [13, 12]) && g.addRoundabout(14, 12), 'houses to roundabout');
  check(road([15, 12], [16, 12], [17, 12], [18, 12]) && road([17, 10], [17, 11], [17, 12], [17, 13]) && g.toggleLight(at(17, 12)), 'signalled crossroads');
  check(g.addMotorway(at(18, 12), at(18, 17)) && road([18, 17], [19, 17], [20, 17]), 'motorway');
  s.house([10, 12], [11, 12]);
  s.house([11, 10], [11, 11]);
  s.house([11, 14], [11, 13]);
  s.dest([20, 18], [0, 1]);
  const trips = drive(s, 120, 'features');
  check(trips >= 18, `cars complete trips through every feature (${trips})`);
}

// ---------- signals: opposing left turns take turns instead of driving through each other ----------
{
  const s = scene();
  const { g, at, road } = s;
  check(road([11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12], [18, 12], [19, 12]) && road([15, 8], [15, 9], [15, 10], [15, 11], [15, 12], [15, 13], [15, 14], [15, 15], [15, 16]), 'crossroads');
  check(g.toggleLight(at(15, 12)), 'signal placed');
  // red cars come from the west and turn left to the north; blue from the east turning left to the south
  for (const xy of [[10, 12], [11, 11], [11, 13]] as XY[]) s.house(xy, [11, 12], 0);
  for (const xy of [[20, 12], [19, 11], [19, 13]] as XY[]) s.house(xy, [19, 12], 1);
  s.dest([16, 9], [1, 0], 0);
  s.dest([14, 15], [-1, 0], 1);
  const trips = drive(s, 150, 'signal');
  check(trips >= 30, `both left-turning streams get through the signal (${trips})`);
}

// ---------- diagonal junctions: lanes, right of way and signals with slanted arms ----------
{
  const s = scene();
  const { g, at, road } = s;
  check(road([11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 11], [17, 10], [18, 10], [19, 10]) && road([15, 12], [16, 13], [17, 14], [18, 14], [19, 14]), 'a Y of diagonals');
  check(road([17, 10], [17, 11], [17, 12], [17, 13], [17, 14]) && g.toggleLight(at(17, 10)), 'a cross link, with a signal where it meets a diagonal');
  check(g.isJunction(g.nodes.get(at(15, 12))!) && g.isJunction(g.nodes.get(at(17, 14))!), 'diagonal arms make junctions');
  s.house([10, 12], [11, 12], 0);
  s.house([11, 11], [11, 12], 0);
  s.house([12, 13], [12, 12], 0);
  s.house([11, 13], [11, 12], 1);
  s.house([12, 11], [12, 12], 1);
  s.house([13, 13], [13, 12], 1);
  const a = s.dest([20, 10], [1, 0], 0), b = s.dest([20, 14], [1, 0], 1);
  let longest = 0;
  const trips = drive(s, 150, 'diagonal junctions', () => { for (const c of s.traffic.cars) longest = Math.max(longest, c.d); });
  check(trips >= 40, `traffic flows through diagonal junctions (${trips})`);
  // house (10,12) to either car park: 4 straight cells, 2 diagonals, 2 more straight, then the entrance
  const route = g.findPath(at(10, 12), id => id === a.cell, { toward: a.cell })!;
  const length = route.slice(1).reduce((sum, c, i) => sum + g.edgeLen(route[i], c), 0);
  check(Math.abs(length - (8 + 2 * Math.SQRT2)) < 1e-6, `route length counts diagonals at root two (${length.toFixed(3)})`);
  check(longest > 9 && b.cells.length === 4, 'cars really drove the whole way');
}

// ---------- gridlock: a saturated grid keeps moving, with no car ever forced through another ----------
{
  const s = scene();
  const { road } = s;
  for (const y of [11, 13, 15]) check(road([10, y], [11, y], [12, y], [13, y], [14, y], [15, y], [16, y], [17, y], [18, y]), 'grid row');
  for (const x of [12, 14, 16]) check(road([x, 9], [x, 10], [x, 11], [x, 12], [x, 13], [x, 14], [x, 15], [x, 16], [x, 17]), 'grid column');
  // each side of the grid mixes houses and destinations, so every color has to cross every other
  s.house([9, 11], [10, 11], 0); s.house([10, 10], [10, 11], 0); s.house([9, 15], [10, 15], 0); s.house([10, 16], [10, 15], 0);
  s.dest([19, 11], [1, 0], 0); s.dest([19, 15], [1, 0], 0);
  s.house([12, 8], [12, 9], 1); s.house([11, 9], [12, 9], 1); s.house([16, 8], [16, 9], 1); s.house([17, 9], [16, 9], 1);
  s.dest([12, 18], [0, 1], 1); s.dest([16, 18], [0, 1], 1);
  s.house([19, 13], [18, 13], 2); s.house([18, 14], [18, 13], 2);
  s.dest([9, 13], [-1, 0], 2);
  s.house([14, 18], [14, 17], 3); s.house([15, 17], [14, 17], 3);
  s.dest([14, 8], [0, -1], 3);
  let late = 0;
  const trips = drive(s, 300, 'gridlock', t => { if (t >= 220 && !late) late = s.city.score; });
  check(trips >= 120, `a saturated grid still delivers (${trips})`);
  check(s.city.score - late >= 20, `and is still flowing after five minutes (${s.city.score - late} trips in the last 80 s)`);
  console.log(`grid stress      : ${trips} trips in 300 s, ${s.city.score - late} of them in the last 80 s, ${s.traffic.cars.length} cars out`);
}

// ---------- car parks: limited bays, one car in and one out at a time, the rest queue on the road ----------
{
  const s = scene();
  const { g, at, road } = s;
  check(road([11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12]), 'one road');
  for (const [xy, face] of [[[10, 12], [11, 12]], [[11, 11], [11, 12]], [[11, 13], [11, 12]], [[12, 11], [12, 12]], [[12, 13], [12, 12]], [[13, 11], [13, 12]]] as [XY, XY][]) s.house(xy, face);
  const shop = s.dest([18, 12], [1, 0]);
  check(shop.bays.length === 3 && shop.entry === at(17, 12) && shop.cells.length === 4, 'a 2x2 destination has three bays and one entrance');
  // bays are spaced evenly along the row, all of them clear of the cell cars drive in through
  const wide = planDestination(g, at(18, 16), 1, 0, 3)!, along = wide.bays.map(b => b.z - 16);
  check(wide.bays.length === 6 && along.every((u, i) => Math.abs(u - (2 / 3 + i / 3)) < 1e-9), `six bays a third of a cell apart (${along.map(u => u.toFixed(2))})`);
  check(wide.bays.every(b => Math.abs(b.x - 18.06) < 1e-9) && along[0] - 0.5 > 0.16, 'in one straight row, starting beyond the entrance lane');
  check(g.nodes.get(shop.cell)!.links.size === 1, 'the car park is joined to the road only at its entrance');
  const guard = watch(g, s.traffic, 'car park');
  let queued = 0, most = 0, hold = true;
  for (let i = 0; i < 90 / STEP; i++) {
    shop.pins = Math.max(shop.pins, 6);
    const parked = s.traffic.cars.filter(c => c.state === 'parked');
    if (hold) for (const c of parked) c.timer = 9;   // nobody leaves until the car park has been seen full
    s.traffic.update(STEP);
    guard();
    const inside = s.traffic.cars.filter(c => c.bay >= 0).length;
    most = Math.max(most, inside);
    check(inside <= shop.bays.length && inside === shop.bays.filter(b => b.car).length, 'never more cars inside than bays');
    for (const state of ['toDest', 'toHome']) check(s.traffic.cars.filter(c => c.bay >= 0 && c.state === state).length <= 1, 'one car drives in at a time, and one out');
    if (parked.length === shop.bays.length) {
      const waiting = s.traffic.cars.filter(c => c.state === 'toDest' && c.v < 0.05 && Math.hypot(c.pos.x - 17, c.pos.z - 12) < 3).length;
      queued = Math.max(queued, waiting);
      if (waiting >= 2 && i > 20 / STEP) hold = false;
    }
  }
  check(most === shop.bays.length && queued >= 2, `a full car park makes the next cars queue on the road (${queued} waiting)`);
  check(!hold && s.city.score >= 12, `and they are served once spaces free up (${s.city.score} trips)`);
}

// ---------- erasing under traffic: the road waits for its cars, and nobody teleports ----------
{
  const s = scene({ tiles: 9, bridges: 0, tunnels: 0, motorways: 0, roundabouts: 0, lights: 0 });
  const { g, inv, at, road } = s;
  check(road([11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12]) && inv.tiles === 2, 'one road, seven tiles');
  const home = s.house([10, 12], [11, 12]), shop = s.dest([18, 12], [1, 0]);
  const guard = watch(g, s.traffic, 'erase');
  const step = (seconds: number, until?: () => boolean) => {
    for (let i = 0; i < seconds / STEP; i++) {
      shop.pins = Math.max(shop.pins, 4);
      s.traffic.update(STEP);
      guard();
      if (until?.()) return true;
    }
    return !until;
  };
  const cut = at(14, 12), onCut = (c: Car) => c.state !== 'parked' && Math.hypot(c.pos.x - 14, c.pos.z - 12) < 0.3;
  check(step(20, () => s.traffic.cars.some(onCut)), 'a car reaches the middle of the road');
  check(g.erase(cut), 'erase the cell under it');
  s.traffic.settle();
  check(g.nodes.has(cut) && inv.tiles === 2, 'the cell stays, unrefunded, while a car is on it');
  check(step(10, () => !g.nodes.has(cut)), 'the cell goes once it is empty');
  check(inv.tiles === 3, 'and only then is its tile refunded');
  // cars cut off from the destination turn round and drive home; cars beyond the cut wait in the car park
  step(30);
  check(s.traffic.cars.every(c => c.state === 'parked') && home.cars + s.traffic.cars.length === 2, 'stranded cars are parked or home, none lost');
  check(shop.assigned === 0, 'pins of cancelled trips are handed back');
  // rebuild the road: everyone gets home, by road
  check(g.addRoad(at(13, 12), cut) && g.addRoad(cut, at(15, 12)), 'road rebuilt');
  shop.pins = 0;
  for (let i = 0; i < 40 / STEP && home.cars < 2; i++) {
    s.traffic.update(STEP);
    guard();
  }
  check(home.cars === 2 && s.traffic.cars.length === 0, 'every car drives home once the road is back');
  check(g.erase(at(12, 12)) && (s.traffic.settle(), !g.nodes.has(at(12, 12))) && inv.tiles === 3, 'an empty road goes at once, with no simulation step');
}

// ---------- driveways under traffic: cars out on a trip come home by the new driveway ----------
{
  const s = scene();
  const { g, at, road } = s;
  check(road([11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12]) && road([11, 12], [11, 11], [12, 11]), 'a road with a side loop past the house');
  const home = s.house([12, 10], [12, 11]), shop = s.dest([18, 12], [1, 0]);
  const guard = watch(g, s.traffic, 'driveway');
  const step = (seconds: number, until?: () => boolean) => {
    for (let i = 0; i < seconds / STEP; i++) {
      s.traffic.update(STEP);
      guard();
      if (until?.()) return true;
    }
    return !until;
  };
  shop.pins = 2;
  check(step(20, () => s.traffic.cars.length === 2 && s.traffic.cars.every(c => c.pos.x > 14)), 'both cars are out');
  // swing the driveway round to a new stub of road; the old side loop is no longer the way in
  check(road([12, 12], [13, 11]) && g.setDriveway(home.cell, at(13, 11)), 'driveway re-pointed while the cars are away');
  home.facing = at(13, 11);
  s.traffic.settle();
  const ways = new Set<number>();
  check(step(40, () => { for (const c of s.traffic.cars) if (c.state === 'toHome' && c.pi >= c.path.length - 2) ways.add(c.route[c.route.length - 2]); return home.cars === 2; }), 'both cars get home');
  check(ways.size === 1 && ways.has(at(13, 11)), 'and both came in by the new driveway');
  check(!g.nodes.get(home.cell)!.links.has(at(12, 11)), 'the old connection is gone');

  // pointed at empty ground while a car is out: it still gets home, by the old way, which then closes
  shop.pins = 1;
  check(step(20, () => s.traffic.cars.some(c => c.pos.x > 14)), 'a car is out again');
  check(g.setDriveway(home.cell, at(11, 10)), 'driveway pointed at empty ground');
  s.traffic.settle();
  check(g.nodes.get(home.cell)!.links.get(at(13, 11))?.closing === true, 'the old driveway is kept, closing, for the car that is out');
  check(step(40, () => home.cars === 2), 'it still drives home, by the old driveway');
  s.traffic.settle();
  check(g.nodes.get(home.cell)!.links.size === 0, 'and then the old driveway goes');
}

// ---------- motorway pillars keep off the roads beneath ----------
{
  const { g, at, road } = scene();
  for (const y of [10, 12, 14, 16]) check(road([10, y], [11, y], [12, y], [13, y], [14, y], [15, y], [16, y], [17, y], [18, y], [19, y]), 'roads under the flyover');
  check(road([14, 8], [14, 9], [14, 10]) && road([14, 16], [14, 17], [14, 18]) && g.addMotorway(at(14, 8), at(14, 18)), 'flyover along a column, crossing four roads');
  check(g.addMotorway(at(10, 9), at(19, 17)), 'and one slanting across them');
  for (const [a, b] of [[at(14, 8), at(14, 18)], [at(10, 9), at(19, 17)]]) {
    const spots = g.pillars(a, b);
    check(spots.length >= 2, `the flyover still gets pillars (${spots.length})`);
    for (const p of spots) {
      // measured independently of the graph's own clearance test: the four roads run along rows 10, 12, 14 and 16
      const onRoad = p.x > 9.6 && p.x < 19.4 && [10, 12, 14, 16].some(y => Math.abs(p.z - y) < 0.4);
      check(!onRoad && g.roadClearance(p.x, p.z) >= 0.2, `pillar at ${p.x.toFixed(2)},${p.z.toFixed(2)} is clear of the roads`);
    }
  }
}

// ---------- no artificial jams: cars only ever wait for a reason ----------

const line = (a: XY, b: XY): XY[] => {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + Math.sign(b[0] - a[0]) * i, a[1] + Math.sign(b[1] - a[1]) * i] as XY);
};

/**
 * Like `drive`, but also times the longest any car spends standing still inside a box it is meant to
 * keep clear (the part of a turn where it is in the way of other movements through the node).
 */
function flow(s: ReturnType<typeof scene>, seconds: number, what: string) {
  const stood = new Map<number, number>();
  let worst = 0, late = 0;
  const trips = drive(s, seconds, what, t => {
    if (t >= seconds - 60 && !late) late = s.city.score;
    for (const car of s.traffic.cars) {
      const piece = car.path[car.pi];
      const boxed = car.state !== 'parked' && car.v < 0.01 && piece.kind === 'turn' && !s.g.nodes.get(piece.from)!.building && s.g.blocksUntil(piece) > car.s;
      stood.set(car.id, boxed ? (stood.get(car.id) ?? 0) + STEP : 0);
      worst = Math.max(worst, stood.get(car.id)!);
    }
  });
  return { trips, last: s.city.score - late, worst };
}

{
  // One busy road from an estate to three car parks, with a different shape in the middle each time.
  // Nothing crosses it there, so any car standing still in the middle is standing for no reason.
  const through = (name: string, middle: (s: ReturnType<typeof scene>) => boolean) => {
    const s = scene(plenty(), open);
    check(s.road(...line([4, 12], [10, 12])) && middle(s) && s.road(...line([20, 12], [25, 12])) && s.road(...line([22, 12], [22, 10])) && s.road(...line([24, 12], [24, 14])), `${name}: road laid`);
    for (const x of [4, 5, 6, 7, 8]) { s.house([x, 11], [x, 12]); s.house([x, 13], [x, 12]); }
    s.dest([22, 9], [0, -1], 0, 3); s.dest([24, 15], [0, 1], 0, 3); s.dest([26, 12], [1, 0], 0, 3);
    let idle = 0;
    const trips = drive(s, 150, name, () => {
      for (const car of s.traffic.cars) if (car.state !== 'parked' && car.v < 0.3 && car.pos.x > 10.5 && car.pos.x < 19.5) idle += STEP;
    });
    return { trips, idle };
  };
  const shapes: [string, (s: ReturnType<typeof scene>) => boolean][] = [
    ['straight', s => s.road(...line([10, 12], [20, 12]))],
    ['right-angle bends', s => s.road([10, 12], [11, 12], [12, 12], [12, 11], [12, 10], [13, 10], [14, 10], [14, 11], [14, 12], ...line([15, 12], [20, 12]))],
    ['zigzag of diagonals', s => s.road([10, 12], [11, 11], [12, 12], [13, 11], [14, 12], [15, 11], [16, 12], [17, 11], [18, 12], [19, 11], [20, 12])],
    ['135 degree hairpins', s => s.road(...line([10, 12], [14, 12]), [13, 11], [14, 10], [15, 10], [16, 10], [17, 10], [16, 11], [17, 12], [18, 12], [19, 12], [20, 12])],
    ['roundabout, straight over', s => s.road(...line([10, 12], [20, 12])) && s.g.addRoundabout(15, 12)],
    ['roundabout, out by a corner', s => s.road(...line([10, 12], [14, 12])) && s.g.addRoundabout(15, 12) && s.road([16, 11], [17, 10], [18, 10], [19, 11], [20, 12])],
    ['roundabout, in at a slant', s => s.road([10, 12], [11, 12], [12, 12], [13, 13], [14, 14]) && s.g.addRoundabout(15, 12) && s.road([14, 14], [14, 13]) && s.road(...line([16, 12], [20, 12]))],
  ];
  const report: string[] = [];
  for (const [name, middle] of shapes) {
    const r = through(name, middle);
    report.push(`${name} ${r.trips} trips / ${r.idle.toFixed(0)} s idle`);
    check(r.trips >= 95 && r.idle < 15, `cars do not stop on an empty road: ${name} (${r.trips} trips, ${r.idle.toFixed(1)} car-seconds standing)`);
  }
  console.log(`road shapes      : ${report.join(', ')}`);
}

{
  // Four streets of houses meet at one hub, every color bound for the far end of the street opposite,
  // so all of it crosses in the middle. The houses start `gap` cells from the hub: at 2 their
  // driveways open straight onto the junction's approaches, which is where queues used to seize up.
  const hub = (centre: 'crossroads' | 'roundabout', gap: number) => {
    const s = scene(plenty(), open);
    check(s.road(...line([7, 12], [23, 12])) && s.road(...line([15, 4], [15, 18])) && (centre === 'crossroads' || s.g.addRoundabout(15, 12)), `${centre}: roads laid`);
    for (const k of [0, 1, 2]) {
      for (const side of [-1, 1]) {
        s.house([15 - gap - k, 12 + side], [15 - gap - k, 12], 0); s.house([15 + gap + k, 12 + side], [15 + gap + k, 12], 1);
        s.house([15 + side, 12 - gap - k], [15, 12 - gap - k], 2); s.house([15 + side, 12 + gap + k], [15, 12 + gap + k], 3);
      }
    }
    s.dest([24, 12], [1, 0], 0, 3); s.dest([6, 12], [-1, 0], 1, 3); s.dest([15, 19], [0, 1], 2, 3); s.dest([15, 3], [0, -1], 3, 3);
    return flow(s, 240, `${centre} hub`);
  };
  for (const centre of ['crossroads', 'roundabout'] as const) {
    for (const gap of [4, 2]) {
      const r = hub(centre, gap);
      console.log(`${(centre + ' hub').padEnd(17)}: houses ${gap} cells out, ${r.trips} trips in 240 s, ${r.last} in the last 60 s, longest stand in a box ${r.worst.toFixed(1)} s`);
      check(r.trips >= 240 && r.last >= 45, `a ${centre} with houses ${gap} cells away keeps flowing (${r.trips} trips, ${r.last} in the last minute)`);
      check(r.worst < 10, `and nobody is left standing in the junction (${r.worst.toFixed(1)} s)`);
    }
  }
}

// ---------- audio: every sound path, run against a strict stand-in for the Web Audio API ----------
{
  // The stand-in throws wherever a browser would: non-finite numbers, times in the past, exponential
  // ramps to zero, starting a source twice. It cannot say what anything sounds like.
  let now = 0, sources = 0, scheduled = 0;
  const param = (value = 0) => {
    const ok = (v: number, t: number) => {
      check(Number.isFinite(v) && Number.isFinite(t), 'audio parameters are finite numbers');
      check(t >= 0, 'audio events are not scheduled before time zero');
      scheduled++;
    };
    return {
      value,
      setValueAtTime: ok,
      linearRampToValueAtTime: ok,
      exponentialRampToValueAtTime: (v: number, t: number) => { ok(v, t); check(v > 0, 'an exponential ramp ends above zero'); },
      setTargetAtTime: (v: number, t: number, c: number) => { ok(v, t); check(c > 0, 'a time constant is positive'); },
      cancelScheduledValues: (t: number) => ok(0, t),
    };
  };
  const node = (extra: object = {}) => ({ connect: <T>(to: T) => { check(to && typeof to === 'object', 'nodes connect to nodes'); return to; }, ...extra });
  const ctx = {
    state: 'running',
    get currentTime() { return now; },
    destination: node(),
    resume: async () => {},
    suspend: async () => {},
    createGain: () => node({ gain: param(1) }),
    createDelay: () => node({ delayTime: param() }),
    createAnalyser: () => node({ fftSize: 2048, getFloatTimeDomainData: (out: Float32Array) => out.fill(0.25) }),
    createOscillator: () => {
      let state = 0;
      return node({
        type: 'sine', frequency: param(440),
        start: (t = 0) => { check(state++ === 0 && t >= 0, 'an oscillator starts once'); sources++; },
        stop: (t = 0) => { check(state === 1 && t >= 0, 'and stops after it has started'); },
      });
    },
  };
  const audio = new SynthAudio(() => ctx as unknown as AudioContext);
  for (const name of SOUNDS) audio.play(name);   // before the first gesture: nothing exists yet, and nothing may throw
  check(sources === 0 && audio.level() === 0 && !audio.running, 'no sound is attempted before audio is unlocked');
  audio.unlock();
  audio.unlock();
  check(sources === 2 && audio.running, 'unlocking builds the graph once: the hum and its wobble');
  for (const name of SOUNDS) {
    const before = sources, events = scheduled;
    now += 3;
    audio.play(name);
    check(name === 'hum' ? scheduled > events : sources > before, `"${name}" plays`);
  }
  for (let color = 0; color < 5; color++) { now += 1; audio.chime(color, true); }
  audio.setDanger(0); audio.setDanger(0.5); audio.setDanger(1);
  check(Math.abs(audio.level() - 0.25) < 1e-6, 'the level meter reads the analyser');
  const quiet = sources;
  check(audio.toggleMute() && (SOUNDS.forEach(name => audio.play(name)), sources === quiet), 'muted, no sound is started');
  check(!audio.toggleMute() && (audio.play('pop'), sources === quiet + 1), 'and unmuting brings them back');
  audio.setActive(false);
  audio.setActive(true);
}

// ---------- autopilot: a careful but unimaginative player ----------

const DIRS: XY[] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

/**
 * The cheapest legal road from `from` to any cell accepted by `goal`, obeying the same rules as the
 * player: tiles for new ground cells, one bridge or tunnel per straight crossing, diagonals only over
 * open ground. With `dry` it may not start any new bridge or tunnel. Returns the cells in order and
 * what building them would cost.
 */
function cheapestRoad(g: RoadGraph, from: number, goal: (cell: number) => boolean, dry = false) {
  const wet = (c: number) => (g.terrain[c] === 'ground' ? '' : g.terrain[c] === 'water' ? 'bridges' : 'tunnels');
  const key = (c: number, d: number) => c * 9 + d + 1;   // d = -1 before the first step
  const cost = new Map<number, number>([[key(from, -1), 0]]), prev = new Map<number, number>();
  const open: [number, number, number][] = [[0, from, -1]];
  let end = goal(from) ? key(from, -1) : -1;
  while (open.length && end < 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[best][0]) best = i;
    const [at, cur, dir] = open.splice(best, 1)[0];
    if (at > cost.get(key(cur, dir))!) continue;
    for (let d = 0; d < 8 && end < 0; d++) {
      const x = g.x(cur) + DIRS[d][0], y = g.y(cur) + DIRS[d][1];
      if (!g.inBounds(x, y)) continue;
      const next = g.cell(x, y), here = g.nodes.get(cur), there = g.nodes.get(next), linked = !!here?.links.has(next);
      if (g.solid(next) || (wet(cur) && d !== dir && dir >= 0)) continue;   // crossings run straight
      if (!linked) {
        if (dry && wet(next) && !there) continue;
        if (d > 3 && (wet(cur) || wet(next) || !g.diagonalOk(cur, next))) continue;
        if (there && there.ring >= 0 && here && here.ring === there.ring) continue;
        if (there && wet(next) && g.spans.get(there.span)?.axis !== (DIRS[d][0] ? 0 : 1)) continue;   // no joining a crossing sideways
      } else if (here!.links.get(next)!.closing || !g.canGo(cur, next) && !g.canGo(next, cur)) continue;
      const step = linked ? 0.02 : (there ? 0.3 : wet(next) ? (wet(cur) ? 0.2 : 7) : 1) + (d > 3 ? 0.1 : 0);
      const k = key(next, d), total = at + step;
      if (total >= (cost.get(k) ?? Infinity)) continue;
      cost.set(k, total);
      prev.set(k, key(cur, dir));
      if (goal(next)) end = k;
      else open.push([total, next, d]);
    }
  }
  if (end < 0) return null;
  const cells: number[] = [];
  for (let k = end; k !== undefined; k = prev.get(k)!) cells.unshift(Math.floor(k / 9));
  const need = { tiles: 0, bridges: 0, tunnels: 0 };
  cells.forEach((c, i) => {
    if (g.nodes.has(c)) return;
    const slot = wet(c);
    if (!slot) need.tiles++;
    else if (i === 0 || wet(cells[i - 1]) !== slot || !!g.nodes.get(cells[i - 1])) need[slot as 'bridges' | 'tunnels']++;
  });
  return { cells, need };
}

/**
 * Plays a city the way a careful beginner would: every house gets the cheapest road to a destination
 * of its own color, and every destination to a house of its color, as soon as that can be afforded.
 * Houses are swung round to face an existing road when that is free, and bridges and tunnels are used
 * only where there is no other way. It never erases anything and never uses motorways, roundabouts or
 * signals. With `unlimited` it ignores the inventory.
 */
function autopilot(g: RoadGraph, city: CityDirector, inv: Inventory, unlimited: boolean) {
  const short = { bridges: false, tunnels: false };
  let spent = 0;
  /** Every road cell joined to `from` by road. */
  const network = (from: number) => {
    const net = new Set<number>();
    for (const queue = g.nodes.get(from) && !g.nodes.get(from)!.building ? [from] : []; queue.length;) {
      const c = queue.pop()!;
      if (net.has(c)) continue;
      net.add(c);
      for (const [m, link] of g.nodes.get(c)!.links) if (!link.closing && !g.nodes.get(m)!.building) queue.push(m);
    }
    return net;
  };
  return {
    short,
    get spent() { return spent; },
    /** Which draft option it takes: whichever unblocks a stuck building, otherwise the most road. */
    pick: () => [...city.draft!].sort((a, b) => {
      const worth = (o: typeof a) => o.tiles + (o.kind === 'bridge' && short.bridges ? 40 : 0) + (o.kind === 'tunnel' && short.tunnels ? 40 : 0);
      return worth(b) - worth(a);
    })[0],
    think() {
      if (unlimited) Object.assign(inv, { tiles: 999, bridges: 99, tunnels: 99 });
      short.bridges = short.tunnels = false;
      for (const b of [...city.houses, ...city.dests]) {
        // the doors of the buildings this one has to reach: any one of them will do
        const partners = ('facing' in b ? city.dests : city.houses).filter(o => o.color === b.color).map(o => g.doors.get(o.cell)!);
        const door = g.doors.get(b.cell)!, mine = network(door);
        if (!partners.length || partners.some(p => mine.has(p))) continue;
        const goal = new Set<number>(partners);
        for (const p of partners) for (const c of network(p)) goal.add(c);
        if ('facing' in b) {
          // a house next to such a road just turns its driveway: that costs nothing
          const beside = DIRS.map(([dx, dy]) => g.cell(g.x(b.cell) + dx, g.y(b.cell) + dy)).find(n => goal.has(n) && g.nodes.has(n) && g.canFace(b.cell, n));
          if (beside !== undefined && g.setDriveway(b.cell, beside)) {
            b.facing = beside;
            continue;
          }
        }
        let plan = cheapestRoad(g, door, c => goal.has(c));
        if (!plan) continue;
        if (plan.need.bridges > inv.bridges || plan.need.tunnels > inv.tunnels) {
          // no bridge or tunnel to spare: ask for one at the next draft, and meanwhile go the long way round if there is one
          if (plan.need.bridges > inv.bridges) short.bridges = true;
          if (plan.need.tunnels > inv.tunnels) short.tunnels = true;
          plan = cheapestRoad(g, door, c => goal.has(c), true);
        }
        if (!plan || plan.need.tiles > inv.tiles) continue;
        const before = inv.tiles;
        for (let i = 1; i < plan.cells.length; i++) {
          if (g.nodes.get(plan.cells[i - 1])?.links.has(plan.cells[i])) continue;
          check(g.addRoad(plan.cells[i - 1], plan.cells[i]), `autopilot's planned road is legal (${g.x(plan.cells[i - 1])},${g.y(plan.cells[i - 1])} to ${g.x(plan.cells[i])},${g.y(plan.cells[i])})`);
        }
        spent += before - inv.tiles;
      }
    },
  };
}

// ---------- saving: a game written out and read back carries on where it was ----------
{
  const config = tokyo, inv = { ...config.start };
  const g = new RoadGraph(config, inv), city = new CityDirector(config, g, inv, () => {}, seeded(3)), traffic = new TrafficEngine(g, city, () => {});
  const pilot = autopilot(g, city, inv, false);
  for (let step = 0; city.day < 16 && !city.over; step++) {
    city.update(STEP);
    if (city.draft && city.week < 2) city.choose(pilot.pick());   // stop on the second draft, so one is saved open
    if (city.draft) break;
    if (step % 30 === 0) pilot.think();
    traffic.update(STEP);
  }
  inv.roundabouts++;
  const busy = [...g.nodes.values()].find(n => !n.building && g.canRoundabout(g.x(n.id), g.y(n.id)) && traffic.cars.some(c => c.state !== 'parked' && c.route.includes(n.id)));
  if (busy) g.addRoundabout(g.x(busy.id), g.y(busy.id));
  const data = JSON.parse(JSON.stringify({ inv, graph: g.save(), director: city.save() }));   // exactly what the browser stores

  const inv2 = data.inv as Inventory, g2 = new RoadGraph(config, inv2), city2 = new CityDirector(config, g2, inv2, () => {}, seeded(4)), traffic2 = new TrafficEngine(g2, city2, () => {});
  g2.load(data.graph);
  city2.load(data.director);
  g2.sweep(() => false);
  check(city2.time === city.time && city2.score === city.score && city2.week === city.week && !!city2.draft === !!city.draft, 'the clock, the score and an open draft come back');
  check(city2.houses.length === city.houses.length && city2.dests.length === city.dests.length && city2.dests.every((d, i) => d.pins === city.dests[i].pins && d.cell === city.dests[i].cell), 'and every building, with its pins');
  check(city2.houses.every(h => h.cars === 2) && city2.dests.every(d => d.assigned === 0 && d.bays.every(b => !b.car)), 'every car is back in its garage');
  check(!g2.closing.size && !g2.pending.size && g2.rings.size === g.rings.size + g.pending.size, 'a roundabout that was waiting for cars is simply built');
  check(g2.spans.size === g.spans.size && g2.doors.size === g.doors.size && inv2.tiles >= inv.tiles && inv2.bridges === inv.bridges && inv2.roundabouts === inv.roundabouts, 'crossings, driveways and the inventory are the same (plus the tiles that roundabout handed back)');
  const reach = (graph: RoadGraph, c: CityDirector) => c.houses.map(h => c.dests.filter(d => d.color === h.color).map(d => graph.findPath(h.cell, id => id === d.cell)?.length ?? 0).join()).join(';');
  check(busy ? reach(g2, city2).length > 0 : reach(g2, city2) === reach(g, city), 'and every house reaches what it reached before');
  if (city2.draft) city2.choose(city2.draft[0]);
  const guard = watch(g2, traffic2, 'loaded game'), before = city2.score;
  for (let i = 0; i < 40 / STEP && !city2.over; i++) {
    city2.update(STEP);
    if (city2.draft) city2.choose(city2.draft[0]);
    traffic2.update(STEP);
    guard();
  }
  check(city2.score - before >= 8, `the loaded game plays on (${city2.score - before} trips in 40 s)`);
}

// ---------- every city gets harder for as long as it is played, and every upgrade can turn up ----------
for (const config of CITIES) {
  const { demand, upgradeWeights } = config;
  const every = (week: number) => Math.max(demand.minInterval, demand.pinInterval * demand.weeklyFactor ** week);
  let floor = 0;
  while (every(floor) > demand.minInterval) check(every(floor + 1) < every(floor) && floor++ < 40, `${config.name}: pins come faster every week`);
  // however good the roads, a car park takes one car in at a time: saturated, it serves 0.56 pins a second
  const supply = 0.6;
  let beyond = 0;
  while (1 / every(beyond) <= supply) check(beyond++ < floor, `${config.name}: demand ends up beyond what a car park can serve`);
  // the weekly draft: each kind with a weight is offered sooner or later
  const city = new CityDirector(config, new RoadGraph(config, { ...config.start }), { ...config.start }, () => {}, seeded(7)) as unknown as { rollDraft(): { kind: string }[] };
  const seen = new Map<string, number>();
  for (let i = 0; i < 400; i++) for (const o of city.rollDraft()) seen.set(o.kind, (seen.get(o.kind) ?? 0) + 1);
  for (const [kind, weight] of Object.entries(upgradeWeights)) check(weight === 0 || seen.has(kind), `${config.name}: the ${kind} is offered`);
  console.log(`${config.name.padEnd(17)}: a pin every ${every(0).toFixed(1)} s in week 1, ${every(7).toFixed(1)} s in week 8, ${demand.minInterval} s from week ${floor + 1}; more than a car park can serve from week ${beyond + 1}; a motorway is offered in ${Math.round(((seen.get('motorway') ?? 0) / 400) * 100)}% of weeks`);
}

// ---------- soak: the autopilot plays each city, with the real inventory and weekly drafts ----------

function soak(config: CityConfig, seed: number, weeks: number) {
  const inv = { ...config.start };
  const g = new RoadGraph(config, inv);
  const city = new CityDirector(config, g, inv, () => {}, seeded(seed));
  const traffic = new TrafficEngine(g, city, () => {});
  const guard = watch(g, traffic, `${config.name} soak`), pilot = autopilot(g, city, inv, false);
  let peakCars = 0, step = 0;

  while (!city.over && city.week < weeks) {
    city.update(STEP);
    if (city.draft) city.choose(pilot.pick());
    if (step++ % 30 === 0) pilot.think();
    traffic.update(STEP);
    guard();
    peakCars = Math.max(peakCars, traffic.cars.length);
    for (const house of city.houses) {
      check(house.cars + traffic.cars.filter(c => c.house === house).length === 2, 'every house owns exactly 2 cars');
    }
    for (const d of city.dests) {
      check(d.assigned === traffic.cars.filter(c => c.dest === d && c.state === 'toDest').length, 'pin reservations match cars en route');
    }
    check(Object.values(inv).every(n => n >= 0), 'the inventory never goes negative');
  }
  // nothing was built in, or right in front of, a one-cell gap through water, mountain or rail
  const solid = (x: number, y: number) => g.inBounds(x, y) && g.terrain[g.cell(x, y)] !== 'ground';
  const gap = (x: number, y: number) => g.inBounds(x, y) && !solid(x, y) && ((solid(x - 1, y) && solid(x + 1, y)) || (solid(x, y - 1) && solid(x, y + 1)));
  for (const cell of [...city.houses.map(h => h.cell), ...city.dests.flatMap(d => d.cells)]) {
    const x = g.x(cell), y = g.y(cell);
    check(![[0, 0], ...DIRS.slice(0, 4)].some(([dx, dy]) => gap(x + dx, y + dy)), `${config.name}: no building blocks the gap beside ${x},${y}`);
  }
  console.log(
    `${config.name.padEnd(17)}: seed ${seed}, ${city.over ? `lost in week ${city.week + 1} (day ${city.day})` : `alive after ${weeks} weeks`}, `
    + `${city.score} trips, ${city.houses.length} houses, ${city.dests.length} destinations, peak ${peakCars} cars, ${inv.tiles} tiles unspent`,
  );
  check(city.score > 20, `${config.name} delivers pins`);
  check(city.houses.length > 6 && city.dests.length > 1, `${config.name} keeps growing`);
  return city.over ? city.week + 1 : Infinity;
}

// `npm run balance` plays five seeds of every city to the end; `npm run check` plays two for eight weeks
const balance = process.argv.includes('--balance');
const lasted = CITIES.map(config => (balance ? [1, 2, 3, 4, 5] : [1, 2]).map(seed => soak(config, seed, balance ? 25 : Number(process.env.WEEKS ?? 8))));
const typical = lasted.map(weeks => [...weeks].sort((a, b) => a - b)[weeks.length >> 1]);
CITIES.forEach((config, i) => {
  console.log(`${config.name.padEnd(17)}: ${config.difficulty.toLowerCase()}, the autopilot loses in week ${lasted[i].map(w => (w === Infinity ? 'none' : w)).join(', ')}`);
  check(Math.max(...lasted[i]) >= 4, `${config.name} is survivable past week 3 on autopilot`);
});
// each step up in difficulty should cost the same player some weeks
const rank = { Normal: 0, Hard: 1, Expert: 2 };
CITIES.forEach((a, i) => CITIES.forEach((b, k) => {
  if (rank[a.difficulty] < rank[b.difficulty]) check(typical[i] >= typical[k], `${a.name} (${a.difficulty}) is no harder than ${b.name} (${b.difficulty}) for the autopilot`);
}));

console.log('selfcheck passed');

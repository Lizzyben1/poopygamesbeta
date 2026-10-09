import { UPGRADES } from '../levels/CityConfigs.ts';
import type { RoadGraph } from './RoadGraph.ts';
import type { Bay, CityConfig, Destination, Emit, House, Inventory, Rect, UpgradeKind, UpgradeOption } from '../types.ts';

export const DAY_SECONDS = 13;   // one week of play is about a minute and a half

/** Car-park layout, in cells measured in from the kerb: the lane cars drive in along, the row of bays, the lane out. */
export const LOT = { aisle: 0.17, bay: 0.56, back: 0.88, pitch: 1 / 3 };   // three bays to a cell, evenly spaced

export type Footprint = Pick<Destination, 'cell' | 'entry' | 'cells' | 'lot' | 'bays'>;

/**
 * Lay out a destination `length` cells wide and two deep. Cars drive in from the outside cell
 * `entry` to `cell` along (dx, dy); the car park is the row of cells to their right, with three
 * bays per cell, and the building is the row behind it. Null if any of it would leave the map.
 */
export function planDestination(g: RoadGraph, cell: number, dx: number, dy: number, length: number): Footprint | null {
  const x = g.x(cell), y = g.y(cell), rx = -dy, ry = dx;
  const cells: number[] = [], lot: number[] = [], bays: Bay[] = [];
  if (!g.inBounds(x - dx, y - dy)) return null;
  for (let k = 0; k < length; k++) {
    for (const back of [0, 1]) {
      const cx = x + rx * k + dx * back, cy = y + ry * k + dy * back;
      if (cx < 1 || cy < 1 || cx > g.width - 2 || cy > g.height - 2) return null;
      cells.push(g.cell(cx, cy));
      if (!back) lot.push(g.cell(cx, cy));
    }
    for (const u of k ? [k - LOT.pitch, k, k + LOT.pitch] : []) {
      bays.push({ x: x + rx * u + dx * (LOT.bay - 0.5), y: 0, z: y + ry * u + dy * (LOT.bay - 0.5), heading: Math.atan2(dx, dy), car: null });
    }
  }
  return { cell, entry: g.cell(x - dx, y - dy), cells, lot, bays };
}

const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const AROUND = [...SIDES, [1, 1], [-1, 1], [-1, -1], [1, -1]];

/**
 * Runs the city: the calendar, where and when buildings appear, pin demand,
 * the weekly upgrade draft and the game-over condition.
 */
export class CityDirector {
  time = 0;
  score = 0;
  over = false;
  /** Set at Sunday midnight; the simulation waits until `choose` is called. */
  draft: UpgradeOption[] | null = null;
  readonly houses: House[] = [];
  readonly dests: Destination[] = [];

  private config: CityConfig;
  private graph: RoadGraph;
  private inv: Inventory;
  private emit: Emit;
  private rng: () => number;
  private spawnIn = 0;
  private weeksDone = 0;
  private nextId = 1;

  constructor(config: CityConfig, graph: RoadGraph, inv: Inventory, emit: Emit, rng: () => number = Math.random) {
    this.config = config;
    this.graph = graph;
    this.inv = inv;
    this.emit = emit;
    this.rng = rng;
  }

  /**
   * The city as plain data. Cars are not saved: on loading, every car is back in its garage and the
   * pins of trips that were under way are still waiting.
   */
  save() {
    return {
      time: this.time, score: this.score, draft: this.draft, spawnIn: this.spawnIn, weeksDone: this.weeksDone, nextId: this.nextId,
      houses: this.houses.map(h => ({ ...h, cars: 2 })),
      dests: this.dests.map(d => ({ ...d, assigned: 0, entering: null, leaving: null, bays: d.bays.map(b => ({ ...b, car: null })) })),
    };
  }

  /** Put back what `save` returned, into a director freshly made for the same city and a loaded graph. */
  load(data: ReturnType<CityDirector['save']>) {
    const { houses, dests, ...rest } = data;
    Object.assign(this, rest);
    this.houses.push(...houses);
    this.dests.push(...dests);
  }

  get day() { return Math.floor(this.time / DAY_SECONDS); }
  get week() { return Math.floor(this.day / 7); }
  /** Fraction of the map (measured from its centre) that buildings currently spawn in. */
  get reach() { return Math.min(1, this.config.spawn.startArea + this.config.spawn.areaPerDay * this.day); }

  update(dt: number) {
    if (this.over || this.draft) return;
    this.time += dt;
    if (this.week > this.weeksDone) {
      this.weeksDone = this.week;
      this.draft = this.rollDraft();
      this.emit({ type: 'week', options: this.draft });
      return;
    }
    if ((this.spawnIn -= dt) <= 0) {
      this.spawnIn = this.config.spawn.interval;
      this.spawn();
    }

    const { demand } = this.config;
    const every = Math.max(demand.minInterval, demand.pinInterval * demand.weeklyFactor ** this.week);
    for (const d of this.dests) {
      if ((d.pinIn -= dt) <= 0) {
        d.pinIn = every * (0.7 + 0.6 * this.rng());
        d.pins = Math.min(d.pins + 1, d.maxPins + 4);
      }
      if (d.pins < d.maxPins) {
        d.overflow = Math.max(0, d.overflow - (2 * dt) / demand.overflowSeconds);
        continue;
      }
      if (d.overflow === 0) this.emit({ type: 'overflow' });
      d.overflow += dt / demand.overflowSeconds;
      if (d.overflow >= 1) {
        this.over = true;
        this.emit({ type: 'gameOver', dest: d });
        return;
      }
    }
  }

  /** Apply the player's weekly pick and resume. */
  choose(option: UpgradeOption) {
    this.inv.tiles += option.tiles;
    this.inv[UPGRADES[option.kind].slot]++;
    this.draft = null;
  }

  private rollDraft(): UpgradeOption[] {
    const weights = this.config.upgradeWeights;
    const pool = (Object.keys(UPGRADES) as UpgradeKind[]).filter(k => weights[k] > 0);
    const [lo, hi] = this.config.weeklyTiles;
    const options: UpgradeOption[] = [];
    while (options.length < 2 && pool.length) {
      let roll = this.rng() * pool.reduce((sum, k) => sum + weights[k], 0);
      const i = Math.max(0, pool.findIndex(k => (roll -= weights[k]) <= 0));
      options.push({ kind: pool.splice(i, 1)[0], tiles: lo + Math.floor(this.rng() * (hi - lo + 1)) });
    }
    return options;
  }

  /**
   * One spawn event. Priorities: every unlocked color gets a destination, then the color with the
   * thinnest supply gets a house, then (if the calendar allows) a new destination raises demand.
   */
  private spawn() {
    const { spawn } = this.config;
    const colors = this.config.colorUnlockDays.filter(d => d <= this.day).length;
    const count = (list: { color: number }[], c: number) => list.filter(e => e.color === c).length;

    for (let c = 0; c < colors; c++) {
      if (count(this.dests, c) || !this.addDest(c)) continue;
      this.addHouse(c);
      this.addHouse(c);
      return;
    }
    const target = Math.min(spawn.housesPerDest[1], spawn.housesPerDest[0] + this.week * 0.3);
    let neediest = 0, lowest = Infinity;
    for (let c = 0; c < colors; c++) {
      if (!count(this.dests, c)) continue;
      const supply = count(this.houses, c) / (count(this.dests, c) * target) + this.rng() * 0.05;
      if (supply < lowest) {
        lowest = supply;
        neediest = c;
      }
    }
    if (lowest < 1) this.addHouse(neediest);
    else if (this.dests.length < colors + Math.floor(this.day / spawn.destEveryDays)) this.addDest(Math.floor(this.rng() * colors));
  }

  /** Every cell that belongs to a building. */
  private taken(): number[] {
    return [...this.houses.map(h => h.cell), ...this.dests.flatMap(d => d.cells)];
  }

  /** Is `cell` at least `gap` cells (corner to corner) from every cell in `others`? */
  private apart(cell: number, others: number[], gap: number): boolean {
    const g = this.graph, x = g.x(cell), y = g.y(cell);
    return others.every(o => Math.max(Math.abs(g.x(o) - x), Math.abs(g.y(o) - y)) >= gap);
  }

  /** Is this a one-cell gap through water, mountain or rail, such as a level crossing? */
  private gap(x: number, y: number): boolean {
    const g = this.graph, solid = (cx: number, cy: number) => g.inBounds(cx, cy) && g.terrain[g.cell(cx, cy)] !== 'ground';
    return g.inBounds(x, y) && g.terrain[g.cell(x, y)] === 'ground' && ((solid(x - 1, y) && solid(x + 1, y)) || (solid(x, y - 1) && solid(x, y + 1)));
  }

  /**
   * Would a building here be in the way: standing in a doorway, in or right in front of a gap that
   * roads need to get through, under a motorway ramp, or with an existing diagonal road clipping its corner?
   */
  private awkward(cell: number): boolean {
    const g = this.graph, x = g.x(cell), y = g.y(cell);
    for (const out of g.doors.values()) if (out === cell) return true;
    if (this.gap(x, y) || SIDES.some(([dx, dy]) => this.gap(x + dx, y + dy))) return true;
    if (g.motorways().some(([a, b]) => g.underRamp(a, b).includes(cell))) return true;   // a motorway ramp is too low to build under
    return [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([sx, sy]) => {
      if (!g.inBounds(x + sx, y + sy)) return false;
      const a = g.cell(x + sx, y), b = g.cell(x, y + sy);
      return !!g.nodes.get(a)?.links.has(b) || g.doors.get(a) === b || g.doors.get(b) === a;
    });
  }

  private addDest(color: number): boolean {
    const g = this.graph, { spawn, demand } = this.config;
    const taken = this.taken(), plans = new Map<number, Footprint>();
    const length = this.rng() < Math.min(0.7, 0.3 + 0.06 * this.week) ? 3 : 2;   // bigger car parks as the city grows
    const first = Math.floor(this.rng() * 4);
    const open = (c: number) => g.terrain[c] === 'ground' && !g.solid(c);
    const cell = this.place(this.config.zones?.commercial, c => {
      // try the four ways it could face and keep the first that fits
      for (let turn = 0; turn < 4; turn++) {
        const [dx, dy] = SIDES[(first + turn) % 4], plan = planDestination(g, c, dx, dy, length);
        if (!plan || !open(plan.entry)) continue;
        if (!plan.cells.every(k => g.isFree(k) && !this.awkward(k) && this.apart(k, taken, spawn.destSpacing))) continue;
        // the entrance needs somewhere for a road to arrive from
        const ex = g.x(plan.entry), ey = g.y(plan.entry);
        if (!SIDES.some(([sx, sy]) => g.inBounds(ex + sx, ey + sy) && open(g.cell(ex + sx, ey + sy)) && !plan.cells.includes(g.cell(ex + sx, ey + sy)))) continue;
        plans.set(c, plan);
        // spread destinations out, same-color ones especially
        let near = 12;
        for (const d of this.dests) near = Math.min(near, g.edgeLen(c, d.cell) * (d.color === color ? 0.5 : 1));
        return near + this.rng() * 3;
      }
      return -Infinity;
    });
    const plan = plans.get(cell);
    if (!plan) return false;
    g.addDest(plan.cell, plan.entry, plan.cells);
    const [lo, hi] = demand.maxPins;
    this.dests.push({
      ...plan, id: this.nextId++, color, pins: 0, assigned: 0, overflow: 0, entering: null, leaving: null,
      maxPins: lo + Math.floor(this.rng() * (hi - lo + 1)),
      pinIn: demand.pinInterval + 5,   // a grace period to get connected
    });
    this.emit({ type: 'spawn', kind: 'dest' });
    return true;
  }

  private addHouse(color: number): boolean {
    const g = this.graph, [lo, hi] = this.config.spawn.houseDist, taken = this.taken();
    const near = (cell: number, reach: number) => this.houses.filter(h => h.color === color && g.edgeLen(cell, h.cell) < reach).length;
    // build next to the matching destination with the fewest houses in range, so supply follows demand
    let target = -1;
    for (const d of this.dests) {
      if (d.color === color && (target < 0 || near(d.entry, hi) < near(target, hi))) target = d.entry;
    }
    if (target < 0) return false;
    const steps = g.groundSteps(target);
    const early = this.houses.length < 4;   // opening houses must be reachable without a bridge or tunnel
    const cell = this.place(this.config.zones?.residential, c => {
      const dist = g.edgeLen(c, target), walkable = steps[c] >= 0 && steps[c] <= hi * 2;
      if (dist < lo || dist > hi || (early && !walkable)) return -Infinity;
      if (!g.isFree(c) || this.awkward(c) || !this.apart(c, taken, 2) || this.faceFor(c, target) < 0) return -Infinity;
      // neighbourhoods cluster by color, and only spill across water or rail once the near side is full
      return Math.min(near(c, 3.5), 2) + (walkable ? 5 : 0) + this.rng() * 2;
    });
    if (cell < 0) return false;
    const facing = this.faceFor(cell, target);
    g.addHouse(cell, facing);
    this.houses.push({ id: this.nextId++, cell, color, cars: 2, facing });
    this.emit({ type: 'spawn', kind: 'house' });
    return true;
  }

  /**
   * Which neighbour a new house's driveway should point at: open ground, ideally a cell that already
   * has a road, otherwise the one nearest its destination. -1 if the house would be boxed in.
   */
  private faceFor(cell: number, toward: number): number {
    const g = this.graph, x = g.x(cell), y = g.y(cell);
    let best = -1, bestScore = -Infinity;
    for (const [dx, dy] of AROUND) {
      if (!g.inBounds(x + dx, y + dy)) continue;
      const n = g.cell(x + dx, y + dy), node = g.nodes.get(n);
      if (!g.canFace(cell, n)) continue;
      const score = (node && !node.building ? 3 : 0) - g.edgeLen(n, toward) - (dx && dy ? 0.3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }

  /**
   * Sample cells and return the best-scoring one (-1 if none fit). Candidates stay inside the active
   * area, a rectangle growing from the map centre day by day, unless it has no room left.
   */
  private place(zone: Rect[] | undefined, score: (cell: number) => number): number {
    const g = this.graph, { width: w, height: h } = g;
    const rects = zone ?? [{ x: 1, y: 1, w: w - 2, h: h - 2 }];
    const total = rects.reduce((sum, r) => sum + r.w * r.h, 0);
    for (const area of [this.reach, 1]) {
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < 120; i++) {
        let roll = this.rng() * total;
        const r = rects.find(q => (roll -= q.w * q.h) <= 0) ?? rects[0];
        const x = r.x + Math.floor(this.rng() * r.w), y = r.y + Math.floor(this.rng() * r.h);
        if (Math.abs(x - (w - 1) / 2) > (area * w) / 2 || Math.abs(y - (h - 1) / 2) > (area * h) / 2) continue;
        const s = score(g.cell(x, y));
        if (s > bestScore) {
          bestScore = s;
          best = g.cell(x, y);
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
}

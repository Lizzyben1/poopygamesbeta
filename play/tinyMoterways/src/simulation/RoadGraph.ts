import type { CityConfig, EdgeKind, Inventory, Link, PathSample, Piece, RoadNode, Span, Terrain, Vec3 } from '../types.ts';

export const CORNER = 0.5;          // how far along each edge a node's rounded corner reaches
export const LANE = 0.135;          // cars keep this far right of the centre line
export const CAR_LENGTH = 0.32;
export const CAR_WIDTH = 0.17;
export const BRIDGE_Y = 0.2;
export const MOTORWAY_Y = 0.95;     // deck height: clear of the tallest building, which stands 0.83 high
export const MOTORWAY_SPEED = 1.8;  // speed multiplier on flyovers
export const LEVEL_GAP = 0.25;      // cars further apart than this in height are on different decks
export const MOTORWAY_MIN = 4;      // shortest flyover, in cells
export const RING_RADIUS = 1;       // a roundabout's eight cells sit on a circle this far from its centre
export const FORK = 0.5;            // two turns out of the same lane have parted company this far in
export const FLANK = 0.45;          // where roads meet at a sharp angle their lanes stay side by side this far out
const PIVOT = 0.5;                  // how much shorter the handles of a turn round the inside of a sharp bend are

const smooth = (u: number) => {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
};

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - u * dx, py - ay - u * dy);
}

/** Do two car-sized rectangles overlap? `pad` grows both on every side. Headings are rotations about Y. */
export function overlap(ax: number, az: number, ah: number, bx: number, bz: number, bh: number, pad = 0): boolean {
  const dx = bx - ax, dz = bz - az, hl = CAR_LENGTH / 2 + pad, hw = CAR_WIDTH / 2 + pad;
  if (dx * dx + dz * dz > 4 * (hl * hl + hw * hw)) return false;
  // separating-axis test on the four edge normals
  const afx = Math.sin(ah), afz = Math.cos(ah), bfx = Math.sin(bh), bfz = Math.cos(bh);
  const along = Math.abs(afx * bfx + afz * bfz), across = Math.abs(afx * bfz - afz * bfx);
  const long = hl + hl * along + hw * across, wide = hw + hl * across + hw * along;
  return Math.abs(dx * afx + dz * afz) <= long && Math.abs(dx * afz - dz * afx) <= wide
    && Math.abs(dx * bfx + dz * bfz) <= long && Math.abs(dx * bfz - dz * bfx) <= wide;
}

/** Position and heading `s` cells along a lane piece. */
export function samplePiece(p: Piece, s: number, out: PathSample): PathSample {
  let i = 0;
  while (i < p.n - 2 && p.c[i + 1] < s) i++;
  const j = Math.min(i + 1, p.n - 1), span = p.c[j] - p.c[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (s - p.c[i]) / span)) : 0;
  out.x = p.x[i] + (p.x[j] - p.x[i]) * f;
  out.y = p.y[i] + (p.y[j] - p.y[i]) * f;
  out.z = p.z[i] + (p.z[j] - p.z[i]) * f;
  let turn = p.h[j] - p.h[i];
  if (turn > Math.PI) turn -= 2 * Math.PI;
  else if (turn < -Math.PI) turn += 2 * Math.PI;
  out.heading = p.h[i] + turn * f;
  return out;
}

/** Build a lane piece from flat [x, y, z, heading] samples. */
export function makePiece(key: number, kind: Piece['kind'], from: number, node: number, to: number, limit: number, pts: number[]): Piece {
  const n = pts.length / 4;
  const p: Piece = {
    key, kind, from, node, to, limit, n, length: 0,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), h: new Float32Array(n), c: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    p.x[i] = pts[4 * i];
    p.y[i] = pts[4 * i + 1];
    p.z[i] = pts[4 * i + 2];
    p.h[i] = pts[4 * i + 3];
    if (i) p.c[i] = p.c[i - 1] + Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1], p.z[i] - p.z[i - 1]);
  }
  p.length = p.c[n - 1];
  return p;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() { return this.ids.length; }

  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      ids[i] = ids[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0], id = ids.pop()!, key = keys.pop()!, n = ids.length;
    if (!n) return top;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && keys[child + 1] < keys[child]) child++;
      if (keys[child] >= key) break;
      ids[i] = ids[child];
      keys[i] = keys[child];
      i = child;
    }
    ids[i] = id;
    keys[i] = key;
    return top;
  }
}

export interface PathOptions {
  /** The goal cell, to steer the search. Leave out for a nearest-of-many search. */
  toward?: number;
  /** A neighbour of the start to avoid if at all possible: going there would be a U-turn. */
  avoid?: number;
  /** Allow roads that are pending removal. Only for cars that were promised them before the erase. */
  legacy?: boolean;
}

/**
 * The city grid: terrain, road nodes (one per cell) and the edges between them.
 * Owns every rule about what may be built where and what it costs, and the lane geometry cars drive.
 */
export class RoadGraph {
  readonly width: number;
  readonly height: number;
  readonly terrain: Terrain[];
  readonly nodes = new Map<number, RoadNode>();
  /** Roundabout id -> its cells in driving order. */
  readonly rings = new Map<number, number[]>();
  readonly spans = new Map<number, Span>();
  /** Links the player erased that still carry cars, as link keys. See `sweep`. */
  readonly closing = new Set<number>();
  /** Cells filled by something that is not a road: destination buildings and roundabout islands. */
  readonly blocked = new Set<number>();
  /** Roundabouts placed over roads that still had cars on them, by centre cell. See `addRoundabout`. */
  readonly pending = new Set<number>();
  /** Building cell -> the one outside cell it opens onto: a house's driveway or a car park's entrance. */
  readonly doors = new Map<number, number>();
  /** Set by the traffic engine: is any car on, or committed to, the roads of this cell? */
  occupied: (cell: number) => boolean = () => false;
  /** Bumped on every road change so traffic re-routes and the renderer rebuilds. */
  version = 0;

  private inv: Inventory;
  private nextId = 1;   // bridge, tunnel and roundabout ids
  private islands = new Map<number, number>();   // roundabout centre cell -> roundabout id
  private m: number;    // radix for packing node ids into keys
  private pieces = new Map<number, Piece>();
  private clashes = new Map<number, Map<number, number>>();
  private blockAt = new Map<number, number>();
  private strictAt = new Map<number, boolean>();
  private stopAt = new Map<number, number>();
  private acuteAt = new Map<number, boolean>();
  private prints = new Map<number, Float32Array>();
  private strictVersion = -1;
  private p0: PathSample = { x: 0, y: 0, z: 0, heading: 0 };
  private p2: PathSample = { x: 0, y: 0, z: 0, heading: 0 };

  constructor(config: CityConfig, inv: Inventory) {
    this.width = config.width;
    this.height = config.height;
    this.inv = inv;
    this.m = this.width * this.height + 1;
    this.terrain = new Array<Terrain>(this.width * this.height).fill('ground');
    for (const f of config.features) {
      for (let id = 0; id < this.terrain.length; id++) {
        for (let k = 0; k < Math.max(1, f.path.length - 1); k++) {
          const [ax, ay] = f.path[k], [bx, by] = f.path[Math.min(k + 1, f.path.length - 1)];
          if (distToSegment(this.x(id), this.y(id), ax, ay, bx, by) <= f.width / 2) this.terrain[id] = f.terrain;
        }
      }
    }
  }

  // ---------- saving ----------

  /** Everything the player has built, as plain data. Terrain is not saved: it comes from the city. */
  save() {
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()].map(n => ({ ...n, links: [...n.links].filter(([m]) => m > n.id).map(([m, l]) => [m, l.kind, l.closing] as [number, EdgeKind, boolean]) })),
      rings: [...this.rings], spans: [...this.spans], islands: [...this.islands], doors: [...this.doors],
      blocked: [...this.blocked], pending: [...this.pending],
    };
  }

  /** Put back what `save` returned, into a graph freshly made for the same city. */
  load(data: ReturnType<RoadGraph['save']>) {
    this.nextId = data.nextId;
    for (const n of data.nodes) this.nodes.set(n.id, { ...n, links: new Map() });
    for (const n of data.nodes) {
      for (const [m, kind, closing] of n.links) {
        this.link(n.id, m, kind);
        if (!closing) continue;
        this.nodes.get(n.id)!.links.get(m)!.closing = true;
        this.closing.add(this.linkKey(n.id, m));
      }
    }
    for (const [k, v] of data.rings) this.rings.set(k, v);
    for (const [k, v] of data.spans) this.spans.set(k, v);
    for (const [k, v] of data.islands) this.islands.set(k, v);
    for (const [k, v] of data.doors) this.doors.set(k, v);
    for (const c of data.blocked) this.blocked.add(c);
    for (const c of data.pending) this.pending.add(c);
    this.reshape();
  }

  // ---------- grid helpers ----------

  cell(x: number, y: number) { return y * this.width + x; }
  x(id: number) { return id % this.width; }
  y(id: number) { return Math.floor(id / this.width); }
  inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  isFree(id: number) { return this.terrain[id] === 'ground' && !this.nodes.has(id) && !this.blocked.has(id); }
  /** Is this cell part of a building or a roundabout island? */
  solid(id: number) { return this.blocked.has(id) || !!this.nodes.get(id)?.building; }
  linkKey(a: number, b: number) { return Math.min(a, b) * this.m + Math.max(a, b); }

  /** World position of a cell's node: the cell centre unless a roundabout has pulled it onto its circle. */
  px(id: number) { return this.nodes.get(id)?.x ?? this.x(id); }
  pz(id: number) { return this.nodes.get(id)?.y ?? this.y(id); }
  edgeLen(a: number, b: number) { return Math.hypot(this.px(a) - this.px(b), this.pz(a) - this.pz(b)); }

  /** Steps from `from` to every cell reachable over open ground (-1 elsewhere): "can a plain road get there?" */
  groundSteps(from: number): Int16Array {
    const steps = new Int16Array(this.terrain.length).fill(-1);
    const queue = [from];
    steps[from] = 0;
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q], cx = this.x(cur), cy = this.y(cur);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!this.inBounds(cx + dx, cy + dy)) continue;
          const next = this.cell(cx + dx, cy + dy);
          if (steps[next] >= 0 || this.terrain[next] !== 'ground') continue;
          steps[next] = steps[cur] + 1;
          queue.push(next);
        }
      }
    }
    return steps;
  }

  // ---------- topology ----------

  /** Roundabouts are one-way; everything else runs both ways. */
  canGo(a: number, b: number): boolean {
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return false;
    const ring = this.rings.get(na.ring);
    return !ring || na.ring !== nb.ring || ring[(ring.indexOf(a) + 1) % ring.length] === b;
  }

  /** Three or more road arms meet here. Driveways and roundabout cells don't count. */
  isJunction(n: RoadNode): boolean {
    return !n.building && n.ring < 0 && this.arms(n) >= 3;
  }

  /** Road arms at a node, not counting driveways and car-park entrances. */
  arms(n: RoadNode): number {
    let arms = 0;
    for (const m of n.links.keys()) if (!this.nodes.get(m)!.building) arms++;
    return arms;
  }

  /**
   * A node where a stopped car would block someone else's way through: a junction, a signal, or a
   * bend so tight that the two directions cannot pass. Cars only enter these when they can clear them.
   */
  strict(id: number): boolean {
    this.fresh();
    let is = this.strictAt.get(id);
    if (is === undefined) {
      const n = this.nodes.get(id);
      is = false;
      if (n && !n.building) {
        const through = [...n.links.keys()].filter(m => !this.nodes.get(m)!.building);
        is = n.light || through.length >= 3
          || (through.length === 2 && this.conflictUntil(this.turn(through[0], id, through[1]), this.turn(through[1], id, through[0])) > -Infinity);
      }
      this.strictAt.set(id, is);
    }
    return is;
  }

  /** Per-node answers depend on which roads meet there, so they are thrown away whenever the network changes. */
  private fresh() {
    if (this.strictVersion === this.version) return;
    this.strictAt.clear();
    this.stopAt.clear();
    this.acuteAt.clear();
    this.blockAt.clear();
    this.strictVersion = this.version;
  }

  /**
   * How far before the turn at `node` a car arriving from `from` has to wait to be in nobody's way.
   * Usually just short of the corner, but where roads meet at 45 degrees their lanes run close
   * together for a while, and the stop line moves back until a waiting car is clear of them all.
   */
  stopBack(from: number, node: number): number {
    this.fresh();
    const key = from * this.m + node, known = this.stopAt.get(key);
    if (known !== undefined) return known;
    const n = this.nodes.get(node), len = this.edgeLen(from, node), start = len - this.reach(node, from);
    const me: PathSample = { x: 0, y: 0, z: 0, heading: 0 }, it: PathSample = { ...me };
    const hits = () => Math.abs(me.y - it.y) < LEVEL_GAP && overlap(me.x, me.z, me.heading, it.x, it.z, it.heading, 0.02);
    let back = 0.08;
    for (const arms = n ? [...n.links.keys()] : []; back < 0.7; back += 0.12) {
      this.lanePoint(from, node, start - back, me);
      const blocked = arms.some(a => {
        if (a === from) return false;
        // the lanes of every other arm, in and out, over the first cell or so
        const reach = Math.min(1.1, this.edgeLen(node, a));
        for (let t = 0.15; t <= reach; t += 0.1) {
          if ((this.lanePoint(node, a, t, it), hits()) || (this.lanePoint(a, node, this.edgeLen(node, a) - t, it), hits())) return true;
        }
        // and every movement through the node that starts on another arm
        return arms.some(b => {
          if (b === a || !this.canGo(a, node) || !this.canGo(node, b)) return false;
          const turn = this.turn(a, node, b);
          for (let s = 0; s <= turn.length; s += 0.08) if ((samplePiece(turn, s, it), hits())) return true;
          return false;
        });
      }) || arms.some(b => {
        // and the far end of a hairpin out of this very lane, which swings back alongside it
        if (b === from || !this.canGo(node, b)) return false;
        const turn = this.turn(from, node, b);
        for (let s = FORK; s <= turn.length; s += 0.08) if ((samplePiece(turn, s, it), hits())) return true;
        return false;
      });
      if (!blocked) break;
    }
    this.stopAt.set(key, back);
    return back;
  }

  /**
   * Does another road leave `node` within 60 degrees of the one toward `arm`? Where roads meet that
   * sharply their lanes run side by side for a while, so right of way has to cover that stretch too.
   */
  acute(node: number, arm: number): boolean {
    this.fresh();
    const key = node * this.m + arm;
    let is = this.acuteAt.get(key);
    if (is === undefined) {
      const nx = this.px(node), nz = this.pz(node), ax = this.px(arm) - nx, az = this.pz(arm) - nz, al = Math.hypot(ax, az);
      is = false;
      for (const m of this.nodes.get(node)?.links.keys() ?? []) {
        const bx = this.px(m) - nx, bz = this.pz(m) - nz;
        if (m !== arm && (ax * bx + az * bz) / (al * Math.hypot(bx, bz)) > 0.5) is = true;
      }
      this.acuteAt.set(key, is);
    }
    return is;
  }

  /**
   * A* from `start` to the first node satisfying `isGoal`. Buildings are dead ends, roundabouts are
   * one-way and roads pending removal are off limits unless `legacy` is set.
   */
  findPath(start: number, isGoal: (id: number) => boolean, opts: PathOptions = {}): number[] | null {
    if (!this.nodes.has(start)) return null;
    const toward = opts.toward ?? -1;
    const h = (id: number) => (toward < 0 ? 0 : this.edgeLen(id, toward) / MOTORWAY_SPEED);
    const cost = new Map<number, number>([[start, 0]]);
    const from = new Map<number, number>();
    const done = new Set<number>();
    const open = new MinHeap();
    open.push(start, h(start));
    while (open.size) {
      const cur = open.pop();
      if (done.has(cur)) continue;
      done.add(cur);
      if (cur !== start && isGoal(cur)) {
        const path = [cur];
        while (path[0] !== start) path.unshift(from.get(path[0])!);
        return path;
      }
      const node = this.nodes.get(cur)!;
      if (node.building && cur !== start) continue;   // buildings are dead ends, never shortcuts
      const g = cost.get(cur)!;
      for (const [next, link] of node.links) {
        if (done.has(next) || (link.closing && !opts.legacy) || !this.canGo(cur, next)) continue;
        let ng = g + this.edgeLen(cur, next) / (link.kind === 'motorway' ? MOTORWAY_SPEED : 1);
        if (cur === start && next === opts.avoid) ng += 3;   // turning straight back is a last resort
        if (ng < (cost.get(next) ?? Infinity)) {
          cost.set(next, ng);
          from.set(next, cur);
          open.push(next, ng + h(next));
        }
      }
    }
    return null;
  }

  // ---------- building ----------

  /** A house on `cell` with its driveway pointing at the neighbouring cell `facing`. */
  addHouse(cell: number, facing: number) {
    this.ensure(cell).building = 'house';
    this.doors.set(cell, facing);
    this.doorways();
    this.version++;
  }

  /** A destination filling `cells`. Its car park's node is `cell`, reached only from the outside cell `entry`. */
  addDest(cell: number, entry: number, cells: number[]) {
    this.ensure(cell).building = 'dest';
    for (const c of cells) if (c !== cell) this.blocked.add(c);
    this.doors.set(cell, entry);
    this.doorways();
    this.version++;
  }

  /** May a house on `house` point its driveway at `facing`? Any of the 8 neighbours on open ground. */
  canFace(house: number, facing: number): boolean {
    const dx = Math.abs(this.x(house) - this.x(facing)), dy = Math.abs(this.y(house) - this.y(facing));
    if (house === facing || dx > 1 || dy > 1 || this.terrain[facing] !== 'ground' || this.solid(facing)) return false;
    return !(dx && dy) || this.diagonalOk(house, facing);
  }

  /**
   * Re-point a house's driveway. Free, and it builds nothing: the house is connected exactly when the
   * cell it faces carries a road. The old connection closes like an erased road, once its cars are off.
   */
  setDriveway(house: number, facing: number): boolean {
    const n = this.nodes.get(house);
    if (n?.building !== 'house' || this.doors.get(house) === facing || !this.canFace(house, facing)) return false;
    for (const [m, link] of n.links) {
      if (link.closing) continue;
      link.closing = true;
      this.closing.add(this.linkKey(house, m));
    }
    this.doors.set(house, facing);
    this.doorways();
    this.version++;
    return true;
  }

  /** Join every building to the road outside its door, if there is one. */
  private doorways() {
    for (const [cell, out] of this.doors) {
      const road = this.nodes.get(out), link = this.nodes.get(cell)!.links.get(out);
      if (!road || road.building) continue;
      if (!link) this.link(cell, out, 'drive');
      else if (link.closing && [...road.links.values()].some(l => !l.closing && l.kind !== 'drive')) {
        link.closing = false;   // the road outside is back before the old connection had gone
        this.closing.delete(this.linkKey(cell, out));
      }
    }
  }

  /**
   * May a road or driveway run diagonally between these two cells? Not across another diagonal, not
   * clipping the corner of water, mountain or rail, and not squeezed between two buildings.
   */
  diagonalOk(a: number, b: number): boolean {
    const c1 = this.cell(this.x(b), this.y(a)), c2 = this.cell(this.x(a), this.y(b));
    if (this.terrain[c1] !== 'ground' || this.terrain[c2] !== 'ground') return false;
    if (this.solid(c1) && this.solid(c2)) return false;
    return !this.nodes.get(c1)?.links.has(c2) && this.doors.get(c1) !== c2 && this.doors.get(c2) !== c1;
  }

  /**
   * Connect two adjacent cells, paying a road tile per new ground cell. Water needs a bridge and
   * mountains or rail a tunnel: one item covers one straight crossing along a grid axis, so turning
   * on the water, branching off sideways or starting a second crossing each cost another.
   * Roads never touch buildings: those join through their driveway or entrance.
   * Drawing over a road that is pending removal cancels the removal.
   */
  addRoad(a: number, b: number): boolean {
    const dx = Math.abs(this.x(a) - this.x(b)), dy = Math.abs(this.y(a) - this.y(b));
    if (a === b || dx > 1 || dy > 1 || this.solid(a) || this.solid(b)) return false;
    const na = this.nodes.get(a), nb = this.nodes.get(b), old = na?.links.get(b);
    if (old) {
      if (!old.closing || old.kind !== 'road') return false;
      old.closing = false;
      this.closing.delete(this.linkKey(a, b));
      this.doorways();
      this.version++;
      return true;
    }
    if (na && nb && na.ring >= 0 && na.ring === nb.ring) return false;
    const wetA = this.spanSlot(a), wetB = this.spanSlot(b), axis = dx ? 0 : 1;
    // bridges and tunnels run straight along the grid; diagonals are for open ground
    if (dx && dy && (wetA || wetB || !this.diagonalOk(a, b))) return false;
    // two existing crossing cells may only be re-joined along their own shared crossing
    if (na && nb && wetA && wetB && (na.span !== nb.span || this.spans.get(na.span)?.axis !== axis)) return false;

    const before = { ...this.inv };
    const made: number[] = [], minted: number[] = [];
    for (const [id, other] of [[a, b], [b, a]]) {
      if (this.nodes.has(id)) continue;
      const node = this.ensure(id), slot = this.spanSlot(id), o = this.nodes.get(other);
      made.push(id);
      if (!slot) {
        node.paid = true;
        this.inv.tiles--;
        continue;
      }
      const carried = o && o.span >= 0 ? this.spans.get(o.span) : undefined;
      if (carried && carried.slot === slot && carried.axis === axis) {
        node.span = o!.span;                // the same straight crossing carries on
      } else {
        node.span = this.nextId++;
        this.spans.set(node.span, { slot, axis });
        minted.push(node.span);
        this.inv[slot]--;
      }
    }
    if (this.inv.tiles < 0 || this.inv.bridges < 0 || this.inv.tunnels < 0) {
      Object.assign(this.inv, before);
      for (const id of made) this.nodes.delete(id);
      for (const id of minted) this.spans.delete(id);
      return false;
    }
    this.link(a, b, 'road');
    this.doorways();
    this.version++;
    return true;
  }

  /** Does the straight line between two cells pass over water? */
  overWater(a: number, b: number): boolean {
    const ax = this.x(a), ay = this.y(a), bx = this.x(b), by = this.y(b), n = Math.ceil(Math.hypot(bx - ax, by - ay) * 4);
    for (let i = 0; i <= n; i++) {
      if (this.terrain[this.cell(Math.round(ax + ((bx - ax) * i) / n), Math.round(ay + ((by - ay) * i) / n))] === 'water') return true;
    }
    return false;
  }

  /**
   * May a motorway run from a to b? Both ends on open ground, at least MOTORWAY_MIN cells apart.
   * It flies over roads, buildings, rail and mountains for free, but crossing water also takes a bridge.
   */
  canMotorway(a: number, b: number): boolean {
    if (a < 0 || b < 0 || this.inv.motorways < 1 || this.nodes.get(a)?.links.has(b)) return false;
    if (Math.hypot(this.x(a) - this.x(b), this.y(a) - this.y(b)) < MOTORWAY_MIN) return false;
    if (this.overWater(a, b) && this.inv.bridges < 1) return false;
    if (this.underRamp(a, b).some(c => this.solid(c))) return false;   // the deck would cut through a building
    return [a, b].every(id => this.terrain[id] === 'ground' && !this.solid(id) && (this.nodes.get(id)?.ring ?? -1) < 0);
  }

  /**
   * The cells under the two ramps of a motorway a -> b, where the deck is still too low to clear a
   * building. Nothing may stand there: not when the motorway is placed, and not afterwards.
   */
  underRamp(a: number, b: number): number[] {
    const ax = this.x(a), ay = this.y(a), dx = this.x(b) - ax, dy = this.y(b) - ay, len = Math.hypot(dx, dy), cells = new Set<number>();
    for (let t = 0; t <= len; t += 0.2) {
      if (MOTORWAY_Y * smooth(Math.min(t, len - t) - CORNER) > 0.88) continue;
      // the deck is about two thirds of a cell wide, so look a little to either side of its centre line
      for (const side of [-0.3, 0, 0.3]) {
        const x = Math.round(ax + (dx * t - dy * side) / len), y = Math.round(ay + (dy * t + dx * side) / len);
        if (this.inBounds(x, y)) cells.add(this.cell(x, y));
      }
    }
    return [...cells];
  }

  addMotorway(a: number, b: number): boolean {
    if (!this.canMotorway(a, b)) return false;
    this.ensure(a);
    this.ensure(b);
    this.link(a, b, 'motorway');
    this.inv.motorways--;
    if (this.overWater(a, b)) this.inv.bridges--;
    this.doorways();
    this.version++;
    return true;
  }

  /** The eight cells round (cx, cy) in driving order: the island stays on the driver's left. */
  private ringCells(cx: number, cy: number): number[] {
    return [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1]].map(([dx, dy]) => this.cell(cx + dx, cy + dy));
  }

  /** May a roundabout be centred on (cx, cy)? It needs a 3x3 of open ground with no building, motorway or other roundabout on it. */
  canRoundabout(cx: number, cy: number): boolean {
    return this.inv.roundabouts >= 1 && this.roundaboutFits(cx, cy);
  }

  private roundaboutFits(cx: number, cy: number): boolean {
    if (!this.inBounds(cx - 1, cy - 1) || !this.inBounds(cx + 1, cy + 1)) return false;
    return [this.cell(cx, cy), ...this.ringCells(cx, cy)].every(c => {
      const n = this.nodes.get(c);
      if (this.terrain[c] !== 'ground' || this.solid(c)) return false;
      return !n || (n.ring < 0 && ![...n.links.values()].some(l => l.closing || l.kind === 'motorway'));
    });
  }

  /**
   * A 3x3 one-way roundabout centred on (cx, cy): eight road cells circling an island. Roads inside
   * the footprint make way for it; roads leading out stay attached, and new ones can join any of
   * the eight cells from any side, diagonals included.
   *
   * If cars are on those roads it cannot be built under them. The roads are closed to new traffic
   * instead, exactly as if erased, and `sweep` builds the roundabout the moment the last car is off.
   */
  addRoundabout(cx: number, cy: number): boolean {
    if (!this.canRoundabout(cx, cy)) return false;
    const centre = this.cell(cx, cy), cells = [centre, ...this.ringCells(cx, cy)];
    this.inv.roundabouts--;
    if (!cells.some(c => this.occupied(c))) {
      this.buildRoundabout(cx, cy);
      return true;
    }
    for (const c of cells) {
      for (const [m, link] of this.nodes.get(c)?.links ?? []) {
        link.closing = true;
        this.closing.add(this.linkKey(c, m));
      }
    }
    this.pending.add(centre);
    this.version++;
    return true;
  }

  private buildRoundabout(cx: number, cy: number) {
    const centre = this.cell(cx, cy), cells = this.ringCells(cx, cy), inside = new Set([centre, ...cells]), id = this.nextId++;
    for (const c of inside) {
      const n = this.nodes.get(c);
      for (const m of n ? [...n.links.keys()] : []) {
        if (!inside.has(m)) continue;
        n!.links.delete(m);
        this.nodes.get(m)!.links.delete(c);
      }
    }
    this.discard(centre);
    cells.forEach((c, i) => {
      const n = this.ensure(c);
      if (n.paid) { n.paid = false; this.inv.tiles++; }
      if (n.light) { n.light = false; this.inv.lights++; }
      n.ring = id;
      // corner cells are pulled in onto the circle, so the eight nodes form a regular octagon
      const pull = i % 2 ? 1 : Math.SQRT1_2;
      n.x = cx + (this.x(c) - cx) * pull * RING_RADIUS;
      n.y = cy + (this.y(c) - cy) * pull * RING_RADIUS;
    });
    cells.forEach((c, i) => this.link(c, cells[(i + 1) % 8], 'ring'));
    this.rings.set(id, cells);
    this.blocked.add(centre);
    this.islands.set(centre, id);
    this.doorways();
    this.reshape();
  }

  /** The roads closed to make way for the roundabout waiting at `centre`, as link keys. */
  private closedFor(centre: number): number[] {
    return [...this.closing].filter(key => this.pendingAt(Math.floor(key / this.m)) === centre || this.pendingAt(key % this.m) === centre);
  }

  /** Stop waiting to build the roundabout at `centre` and put its roads back in service. */
  private reopen(centre: number) {
    for (const key of this.closedFor(centre)) {
      this.nodes.get(Math.floor(key / this.m))!.links.get(key % this.m)!.closing = false;
      this.closing.delete(key);
    }
    this.pending.delete(centre);
  }

  /** The centre of the roundabout waiting to be built over this cell, or -1. */
  private pendingAt(id: number): number {
    for (const centre of this.pending) if (Math.abs(this.x(centre) - this.x(id)) <= 1 && Math.abs(this.y(centre) - this.y(id)) <= 1) return centre;
    return -1;
  }

  /** Put a signal on a junction, or take it back off. */
  toggleLight(id: number): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    if (n.light) {
      n.light = false;
      this.inv.lights++;
    } else {
      if (this.inv.lights < 1 || !this.isJunction(n)) return false;
      n.light = true;
      this.inv.lights--;
    }
    this.version++;
    return true;
  }

  /**
   * Erase a cell's roads (and the whole roundabout it belongs to). Nothing disappears from under a
   * car: the links are only marked as closing here, and `sweep` removes and refunds them once empty.
   */
  erase(id: number): boolean {
    const n = this.nodes.get(id), ring = this.rings.get(this.islands.get(id) ?? n?.ring ?? -1);
    const waiting = this.pendingAt(id);
    if (waiting >= 0) {
      // erasing under a roundabout that is still waiting to be built calls it off and reopens its roads
      this.reopen(waiting);
      this.inv.roundabouts++;
      this.doorways();
      this.version++;
      return true;
    }
    if ((!n && !ring) || n?.building) return false;
    let any = false;
    for (const c of ring ?? [id]) {
      for (const [m, link] of this.nodes.get(c)!.links) {
        if (link.closing) continue;
        link.closing = any = true;
        this.closing.add(this.linkKey(c, m));
      }
    }
    if (any) this.version++;
    return any;
  }

  /** Erase one motorway and nothing else: its ends keep whatever other roads they have. */
  eraseMotorway(a: number, b: number): boolean {
    const link = this.nodes.get(a)?.links.get(b);
    if (link?.kind !== 'motorway' || link.closing) return false;
    link.closing = true;
    this.closing.add(this.linkKey(a, b));
    this.version++;
    return true;
  }

  /** Every motorway, once each, as its two end cells. */
  motorways(): [number, number][] {
    const out: [number, number][] = [];
    for (const n of this.nodes.values()) for (const [m, link] of n.links) if (link.kind === 'motorway' && m > n.id) out.push([n.id, m]);
    return out;
  }

  /** Remove every closing link that `inUse` says no car needs any more, refunding what it cost. */
  sweep(inUse: (a: number, b: number) => boolean): boolean {
    let any = false;
    // roads closed for a roundabout are not removed: once empty they reopen and the roundabout is built over them
    const held = new Set<number>();
    for (const centre of [...this.pending]) {
      const keys = this.closedFor(centre);
      if (keys.some(key => inUse(Math.floor(key / this.m), key % this.m))) {
        for (const key of keys) held.add(key);
        continue;
      }
      this.reopen(centre);
      if (this.roundaboutFits(this.x(centre), this.y(centre))) this.buildRoundabout(this.x(centre), this.y(centre));
      else this.inv.roundabouts++;   // something was built there in the meantime
      this.doorways();
      any = true;
    }
    for (const key of [...this.closing]) {
      const a = Math.floor(key / this.m), b = key % this.m;
      if (held.has(key) || inUse(a, b)) continue;
      const link = this.nodes.get(a)!.links.get(b)!;
      this.nodes.get(a)!.links.delete(b);
      this.nodes.get(b)!.links.delete(a);
      this.closing.delete(key);
      if (link.kind === 'motorway') {
        this.inv.motorways++;
        if (this.overWater(a, b)) this.inv.bridges++;
      }
      this.discard(a);
      this.discard(b);
      any = true;
    }
    if (any) this.version++;
    return any;
  }

  /** Delete a node nothing connects to any more and hand back what it cost. */
  private discard(id: number) {
    const n = this.nodes.get(id);
    if (!n || n.building || n.links.size) return;
    this.nodes.delete(id);
    if (n.paid) this.inv.tiles++;
    if (n.light) this.inv.lights++;
    const others = [...this.nodes.values()];
    const span = this.spans.get(n.span);
    if (span && !others.some(o => o.span === n.span)) {
      this.spans.delete(n.span);
      this.inv[span.slot]++;
    }
    if (n.ring >= 0 && !others.some(o => o.ring === n.ring)) {
      this.rings.delete(n.ring);
      for (const [centre, ring] of this.islands) {
        if (ring !== n.ring) continue;
        this.islands.delete(centre);
        this.blocked.delete(centre);
      }
      this.inv.roundabouts++;
      this.reshape();
    }
  }

  /** Which inventory item a road needs to cross this cell's terrain. */
  private spanSlot(id: number): 'bridges' | 'tunnels' | null {
    const t = this.terrain[id];
    return t === 'ground' ? null : t === 'water' ? 'bridges' : 'tunnels';
  }

  private ensure(id: number): RoadNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, x: this.x(id), y: this.y(id), links: new Map(), paid: false, span: -1, ring: -1, light: false, building: null };
      this.nodes.set(id, n);
    }
    return n;
  }

  private link(a: number, b: number, kind: EdgeKind) {
    const link: Link = { kind, closing: false };
    this.nodes.get(a)!.links.set(b, link);
    this.nodes.get(b)!.links.set(a, link);
  }

  /** Node positions moved, so every cached lane piece is stale. */
  private reshape() {
    this.pieces.clear();
    this.clashes.clear();
    this.prints.clear();
    this.version++;
  }

  // ---------- geometry (shared by cars and the road mesh so they always agree) ----------

  /** Deck height of a cell: bridges sit above the water, everything else is at grade. */
  nodeY(id: number) { return this.terrain[id] === 'water' ? BRIDGE_Y : 0; }

  /** The straight centre-line point `t` cells along a -> b, with bridge ramps and the motorway hump applied. */
  linePoint(a: number, b: number, t: number, out: Vec3): Vec3 {
    const len = this.edgeLen(a, b), u = t / len, ax = this.px(a), az = this.pz(a), ya = this.nodeY(a);
    out.x = ax + (this.px(b) - ax) * u;
    out.z = az + (this.pz(b) - az) * u;
    out.y = ya + (this.nodeY(b) - ya) * u;
    // the hump starts beyond the rounded corners, so junctions at either end stay flat
    if (this.nodes.get(a)?.links.get(b)?.kind === 'motorway') out.y += MOTORWAY_Y * smooth(Math.min(t, len - t) - CORNER);
    return out;
  }

  /** Like `linePoint` but in the right-hand lane, with the heading of travel. */
  lanePoint(a: number, b: number, t: number, out: PathSample): PathSample {
    this.linePoint(a, b, t, out);
    const dx = this.px(b) - this.px(a), dz = this.pz(b) - this.pz(a), n = Math.hypot(dx, dz) || 1;
    out.x -= (dz / n) * LANE;
    out.z += (dx / n) * LANE;
    out.heading = Math.atan2(dx, dz);
    return out;
  }

  /** Centre-line Bezier rounding the corner at `node` between neighbours `from` and `to`; u runs 0..1. */
  cornerPoint(from: number, node: number, to: number, u: number, out: Vec3): Vec3 {
    const a = this.linePoint(node, from, this.reach(node, from), this.p0);
    const b = this.linePoint(node, to, this.reach(node, to), this.p2);
    const cx = this.px(node), cy = this.nodeY(node), cz = this.pz(node), v = 1 - u;
    out.x = v * v * a.x + 2 * v * u * cx + u * u * b.x;
    out.y = v * v * a.y + 2 * v * u * cy + u * u * b.y;
    out.z = v * v * a.z + 2 * v * u * cz + u * u * b.z;
    return out;
  }

  /** How far along the edge a -> b the rounded corner at `a` extends. */
  reach(a: number, b: number) { return Math.min(CORNER, this.edgeLen(a, b) / 2); }

  private pieceKey(kind: number, from: number, node: number, to: number) {
    return ((kind * this.m + from) * this.m + node) * this.m + to;
  }

  /**
   * The lane through `node` for a car arriving from `from` and leaving toward `to`: a Bezier from the
   * end of the incoming lane to the start of the outgoing one, steered by where those two lanes would
   * meet, so sharp and gentle corners both stay inside the road. `to === from` is a U-turn.
   */
  turn(from: number, node: number, to: number): Piece {
    const key = this.pieceKey(2, from, node, to);
    const hit = this.pieces.get(key);
    if (hit) return hit;
    const l1 = this.edgeLen(from, node), l2 = this.edgeLen(node, to), nx = this.px(node), nz = this.pz(node);
    const a = { ...this.lanePoint(from, node, l1 - this.reach(node, from), this.p0) };
    const b = { ...this.lanePoint(node, to, this.reach(node, to), this.p2) };
    const ux = (nx - this.px(from)) / l1, uz = (nz - this.pz(from)) / l1, vx = (this.px(to) - nx) / l2, vz = (this.pz(to) - nz) / l2;
    const cross = ux * vz - uz * vx, dot = ux * vx + uz * vz;
    let cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    // Steer by the point where the two lanes cross. Round the inside of a sharp bend that is a tight
    // pivot well short of the node, round the outside a wide swing past it, so the two never meet.
    const t = Math.abs(cross) > 0.05 ? ((b.x - a.x) * vz - (b.z - a.z) * vx) / cross : 0;
    const s = Math.abs(cross) > 0.05 ? ((b.x - a.x) * uz - (b.z - a.z) * ux) / cross : 0;
    if (t > 0.01 && s < -0.01) {
      cx = a.x + ux * t;
      cz = a.z + uz * t;
    } else if (dot < -0.7) {
      cx = nx + ux * 0.2;   // doubling back: swing out past the node and round into the opposite lane
      cz = nz + uz * 0.2;
    }
    // a cubic with both handles on the lane lines; a pivot round the inside of a sharp bend keeps its
    // handles short, so the car turns on the spot instead of swinging its nose out over the far lane
    const k = (t > 0.01 && s < -0.01 && dot < -0.5 && t < this.reach(node, from) ? PIVOT : 1) * (2 / 3);
    const c1x = a.x + (cx - a.x) * k, c1z = a.z + (cz - a.z) * k, c2x = b.x + (cx - b.x) * k, c2z = b.z + (cz - b.z) * k;
    const pts: number[] = [], ny = this.nodeY(node), steps = 14;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, w = 1 - u;
      const tx = w * w * (c1x - a.x) + 2 * w * u * (c2x - c1x) + u * u * (b.x - c2x), tz = w * w * (c1z - a.z) + 2 * w * u * (c2z - c1z) + u * u * (b.z - c2z);
      pts.push(
        w * w * w * a.x + 3 * w * w * u * c1x + 3 * w * u * u * c2x + u * u * u * b.x,
        w * w * a.y + 2 * w * u * ny + u * u * b.y,
        w * w * w * a.z + 3 * w * w * u * c1z + 3 * w * u * u * c2z + u * u * u * b.z,
        Math.abs(tx) + Math.abs(tz) > 1e-9 ? Math.atan2(tx, tz) : a.heading,
      );
    }
    const angle = Math.atan2(Math.abs(cross), dot);
    const piece = makePiece(key, 'turn', from, node, to, angle < 0.6 ? 1 : angle < 1.2 ? 0.85 : angle < 1.9 ? 0.7 : 0.5, pts);
    this.pieces.set(key, piece);
    return piece;
  }

  /** The straight stretch of lane a -> b between the corners at its two ends (zero-length between neighbours). */
  run(a: number, b: number): Piece {
    const key = this.pieceKey(1, a, a, b);
    const hit = this.pieces.get(key);
    if (hit) return hit;
    const len = this.edgeLen(a, b), r = this.reach(a, b), span = len - 2 * r, pts: number[] = [];
    const flyover = this.nodes.get(a)?.links.get(b)?.kind === 'motorway';
    const steps = span < 1e-4 ? 0 : flyover ? Math.ceil(span / 0.25) : 1;
    for (let i = 0; i <= steps; i++) {
      const p = this.lanePoint(a, b, r + (steps ? (span * i) / steps : 0), this.p0);
      pts.push(p.x, p.y, p.z, p.heading);
    }
    const piece = makePiece(key, 'run', a, a, b, flyover ? MOTORWAY_SPEED : 1, pts);
    this.pieces.set(key, piece);
    return piece;
  }

  /** The lane from a building's door to the first corner (`arriving` false) or from the last corner in. */
  stub(a: number, b: number, arriving: boolean): Piece {
    const key = this.pieceKey(arriving ? 3 : 0, a, a, b);
    const hit = this.pieces.get(key);
    if (hit) return hit;
    const len = this.edgeLen(a, b), r = this.reach(a, b), pts: number[] = [];
    for (const t of arriving ? [len - r, len] : [0, r]) {
      const p = this.lanePoint(a, b, t, this.p0);
      pts.push(p.x, p.y, p.z, p.heading);
    }
    const piece = makePiece(key, 'stub', a, a, b, 1, pts);
    this.pieces.set(key, piece);
    return piece;
  }

  /**
   * The path between a car park's entrance and one of its bays. `aisle` and `back` are how far in
   * from the kerb the two lanes run. Driving in, a car follows the near lane past the bays and swings
   * into its own nose first; driving out it pulls forward into the far lane and comes back round to
   * the entrance, so nobody ever reverses.
   */
  lot(cell: number, entry: number, bay: Vec3, leaving: boolean, key: number, aisle: number, back: number): Piece {
    const dx = this.x(cell) - this.x(entry), dz = this.y(cell) - this.y(entry);   // the way in
    const ox = (this.x(cell) + this.x(entry)) / 2, oz = (this.y(cell) + this.y(entry)) / 2, rx = -dz, rz = dx;
    const u = (bay.x - ox) * rx + (bay.z - oz) * rz, v = (bay.x - ox) * dx + (bay.z - oz) * dz;
    const pts: number[] = [];
    // (pu, pv) is a point `pu` cells to the right of the entrance and `pv` cells in; (tu, tv) the direction of travel there
    const at = (pu: number, pv: number, tu: number, tv: number) =>
      pts.push(ox + rx * pu + dx * pv, 0, oz + rz * pu + dz * pv, Math.atan2(rx * tu + dx * tv, rz * tu + dz * tv));
    const line = (u0: number, v0: number, u1: number, v1: number) => {
      at(u0, v0, u1 - u0, v1 - v0);
      at(u1, v1, u1 - u0, v1 - v0);
    };
    const bend = (u0: number, v0: number, cu: number, cv: number, u1: number, v1: number) => {
      for (let i = 0; i <= 8; i++) {
        const t = i / 8, w = 1 - t;
        at(w * w * u0 + 2 * w * t * cu + t * t * u1, w * w * v0 + 2 * w * t * cv + t * t * v1, w * (cu - u0) + t * (u1 - cu), w * (cv - v0) + t * (v1 - cv));
      }
    };
    if (leaving) {
      bend(u, v, u, back, u - 0.25, back);
      line(u - 0.25, back, 0.25 - LANE, back);
      bend(0.25 - LANE, back, -LANE, back, -LANE, back - 0.28);
      line(-LANE, back - 0.28, -LANE, 0);
    } else {
      bend(LANE, 0, LANE, aisle, LANE + 0.2, aisle);
      line(LANE + 0.2, aisle, u - 0.25, aisle);
      bend(u - 0.25, aisle, u, aisle, u, v);
    }
    return makePiece(key, 'lot', entry, cell, cell, 0.55, pts);
  }

  /**
   * How far a point is from the nearest thing a pillar must not stand on: the edge of a road at
   * grade, a building or a roundabout island. Negative when the point is on one.
   */
  roadClearance(x: number, z: number): number {
    let best = Infinity;
    for (const n of this.nodes.values()) {
      if (Math.abs(n.x - x) > 3 || Math.abs(n.y - z) > 3) continue;
      if (n.building === 'house') best = Math.min(best, Math.hypot(Math.max(0, Math.abs(n.x - x) - 0.5), Math.max(0, Math.abs(n.y - z) - 0.5)));
      for (const [m, link] of n.links) {
        // roads are half a cell wide plus kerb; bends cut their corner, so allow a little extra
        if (link.kind !== 'motorway') best = Math.min(best, distToSegment(x, z, n.x, n.y, this.px(m), this.pz(m)) - 0.31);
      }
    }
    for (const c of this.blocked) best = Math.min(best, Math.hypot(Math.max(0, Math.abs(this.x(c) - x) - 0.6), Math.max(0, Math.abs(this.y(c) - z) - 0.6)));
    return best;
  }

  /**
   * Where the pillars of the flyover a -> b go: roughly every cell and a quarter, each slid along the
   * deck until it stands clear of the roads and buildings underneath, or left out if it cannot.
   */
  pillars(a: number, b: number): Vec3[] {
    const len = this.edgeLen(a, b), spots: Vec3[] = [], count = Math.max(1, Math.round((len - 2) / 1.25));
    let last = -Infinity;
    for (let i = 0; i < count; i++) {
      const ideal = len / 2 + (i - (count - 1) / 2) * ((len - 2.4) / count);
      for (const slide of [0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6]) {
        const t = ideal + slide, p = this.linePoint(a, b, t, { x: 0, y: 0, z: 0 });
        if (t - last < 0.7 || p.y < MOTORWAY_Y * 0.6 || this.roadClearance(p.x, p.z) < 0.2) continue;
        spots.push(p);
        last = t;
        break;
      }
    }
    return spots;
  }

  /**
   * Every pose a car takes making this turn, as flat [x, y, z, heading, s] with `s` measured from the
   * start of the turn. Where the lane in or out runs beside a sharply angled neighbour, the last or
   * first FLANK of that lane is included too.
   */
  private footprint(p: Piece, before: boolean, after: boolean): Float32Array {
    const key = p.key * 4 + (before ? 1 : 0) + (after ? 2 : 0);
    let print = this.prints.get(key);
    if (!print) {
      const out: number[] = [], at = this.p0;
      const add = (s: number) => out.push(at.x, at.y, at.z, at.heading, s);
      const len = this.edgeLen(p.from, p.node);
      if (before) for (let d = FLANK; d > 0.01; d -= 0.075) add((this.lanePoint(p.from, p.node, len - this.reach(p.node, p.from) - d, at), -d));
      for (let s = 0; s < p.length; s += 0.05) add((samplePiece(p, s, at), s));
      add((samplePiece(p, p.length, at), p.length));
      if (after) for (let d = 0.075; d < FLANK + 0.01; d += 0.075) add((this.lanePoint(p.node, p.to, this.reach(p.node, p.to) + d, at), p.length + d));
      this.prints.set(key, print = new Float32Array(out));
    }
    return print;
  }

  /**
   * How far into the turn `ahead` (measured from its start) a car is still in the way of one making
   * the turn `behind` through the same node; -Infinity if the two never touch. Found by sweeping a
   * slightly padded car along both. Cars out of the same lane follow each other anyway, so those
   * only clash where the leader's path comes back alongside its follower, as on a hairpin.
   */
  conflictUntil(ahead: Piece, behind: Piece): number {
    const a = this.footprint(ahead, this.acute(ahead.node, ahead.from), this.acute(ahead.node, ahead.to));
    const b = this.footprint(behind, this.acute(behind.node, behind.from), this.acute(behind.node, behind.to));
    let row = this.clashes.get(ahead.key);
    if (!row) this.clashes.set(ahead.key, row = new Map());
    const key = behind.key * 32768 + a.length * 128 + b.length % 128;   // footprints grow with their flanks
    let until = row.get(key);
    if (until === undefined) {
      const sameLane = ahead.from === behind.from;
      // the two directions round one bend keep to their own lanes, so they need less margin than strangers
      const pad = ahead.from === behind.to && ahead.to === behind.from ? 0.01 : 0.02;
      until = -Infinity;
      // from the far end back, so the first hit is the last place they clash
      for (let i = a.length - 5; i >= 0 && until === -Infinity; i -= 5) {
        for (let j = 0; j < b.length; j += 5) {
          if (sameLane && a[i + 4] - b[j + 4] < 0.62) continue;   // nose to tail in the same lane is just following
          if (Math.abs(a[i + 1] - b[j + 1]) < LEVEL_GAP && overlap(a[i], a[i + 2], a[i + 3], b[j], b[j + 2], b[j + 3], pad)) {
            until = a[i + 4];
            break;
          }
        }
      }
      row.set(key, until);
    }
    return until;
  }

  /**
   * How far into this turn a stopped car would still be in the way of other traffic through the
   * node; -Infinity if it never is. Cars pulling out of buildings do not count: they wait off the
   * road and hold nobody up, so they cannot be part of a jam that feeds on itself.
   */
  blocksUntil(turn: Piece): number {
    this.fresh();
    let until = this.blockAt.get(turn.key);
    if (until === undefined) {
      until = -Infinity;
      const arms = [...this.nodes.get(turn.node)!.links.keys()];
      for (const a of arms) {
        if (a === turn.from || this.nodes.get(a)!.building || !this.canGo(a, turn.node)) continue;
        for (const b of arms) if (b !== a && this.canGo(turn.node, b)) until = Math.max(until, this.conflictUntil(turn, this.turn(a, turn.node, b)));
      }
      this.blockAt.set(turn.key, until);
    }
    return until;
  }

}

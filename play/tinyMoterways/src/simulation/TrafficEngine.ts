import { FLANK, FORK, LEVEL_GAP, overlap, samplePiece } from './RoadGraph.ts';
import type { RoadGraph } from './RoadGraph.ts';
import { LOT } from './CityDirector.ts';
import type { CityDirector } from './CityDirector.ts';
import type { Car, CarState, Destination, Emit, House, PathSample, Piece } from '../types.ts';

const SPEED = 2.6;        // cells per second on plain road
const ACCEL = 5;
const BRAKE = 14;
const GAP = 0.42;         // following distance along a lane, centre to centre
const PAST = 0.06;         // margin beyond the last point of conflict: one footprint sample
const REQUEST = 0.9;      // how far ahead of a stop line a car asks for right of way
const SLOW = 0.8;         // below this speed a car counts as queueing
const PARK = 0.9;         // seconds spent collecting a pin
const GREEN = 4;
const CLEAR = 0.8;        // all-red pause between signal phases

/** A car's right of way through one node, held from the grant until it is clear of the turn. */
interface Hold { car: Car; turn: Piece; start: number }   // `start`: where on the car's path the turn begins

const push = <T>(map: Map<number, T[]>, key: number, item: T) => {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
};

/**
 * Every car on the road.
 *
 * A car's route is driven as a chain of lane pieces: a stub out of its building, then alternating
 * straight runs and turns through each node, then a stub into its goal. Three rules keep traffic
 * apart, in this order:
 *
 *  1. Right of way. A car needs a hold on a node before it may enter the turn through it. Holds
 *     are granted longest-wait-first, and never while the swept path of the turn touches what is
 *     left of another holder's, so crossing, merging and opposing turning cars take turns, at
 *     signals as much as anywhere. A hold stops mattering to others as its car passes them.
 *  2. Keep conflicts clear. A hold is only granted if the car can get past the last point where it
 *     would be in someone else's way and still have somewhere to stand: the stretch of road from
 *     there to the next line it may have to wait at holds a known number of cars, and the cars
 *     already bound for it are counted. A full stretch only admits another car if the one at its
 *     head is let through at the same time. Following that question from queue to queue is what
 *     finds a ring of cars each waiting for the next; such a ring is released all at once.
 *  3. Never touch. Each step a car only moves as far as its body stays clear of every other car.
 *
 * A destination's car park is entered like any other turn, but only when a bay is free and the car
 * before it has reached its own; otherwise the car waits and a queue forms on the road.
 */
export class TrafficEngine {
  readonly cars: Car[] = [];

  private graph: RoadGraph;
  private city: CityDirector;
  private emit: Emit;
  private m: number;
  private byPiece = new Map<number, Car[]>();   // lane piece -> cars on it
  private byFork = new Map<number, Car[]>();    // incoming lane at a node -> cars turning out of it
  private near = new Map<number, Car[]>();      // grid cell -> cars in it, for the no-touch rule
  private holds = new Map<number, Hold[]>();    // node -> movements with right of way
  private claims = new Map<number, Piece[]>();  // node -> movements kept waiting this step, which nobody may cut in front of
  private log: { car: Car; turn: Piece; was: number; parked: boolean }[] = [];
  private axes = new Map<number, number[]>();   // signal node -> the road axes it cycles through
  private probe: PathSample = { x: 0, y: 0, z: 0, heading: 0 };
  private version = -1;
  private time = 0;
  private dispatchIn = 0;
  private nextId = 1;

  constructor(graph: RoadGraph, city: CityDirector, emit: Emit) {
    this.graph = graph;
    this.city = city;
    this.emit = emit;
    this.m = graph.terrain.length + 1;
    // the graph asks before reshaping roads (a roundabout moves its cells): is anyone on, or promised, this cell?
    graph.occupied = cell => this.cars.some(car => {
      if (car.state === 'parked') return false;
      const from = Math.max(0, (car.pi - 1) >> 1);
      return car.route.slice(from, Math.max(from + 1, car.clear + 1) + 1).includes(cell);
    });
  }

  update(dt: number) {
    this.time += dt;
    this.settle();
    if ((this.dispatchIn -= dt) <= 0) {
      this.dispatchIn = 0.25;
      this.dispatch();
    }
    this.index();
    for (const car of this.cars) this.look(car);
    this.grant(dt);
    for (const car of this.cars) this.plan(car, dt);
    for (let i = this.cars.length - 1; i >= 0; i--) this.advance(this.cars[i]);   // backwards: cars remove themselves
  }

  /**
   * Bring every route up to date with the road network and remove erased roads that no car needs
   * any more. Runs each step, and is safe to call after an edit while the game is paused.
   */
  settle() {
    const g = this.graph;
    if (this.version !== g.version) this.replan();
    if (!g.closing.size && !g.pending.size) return;
    const used = new Set<number>();
    for (const car of this.cars) {
      // a house whose driveway was turned away from the road keeps its old way in until its cars are back
      const home = g.nodes.get(car.house.cell)!;
      if (![...home.links.values()].some(l => !l.closing)) for (const m of home.links.keys()) used.add(g.linkKey(car.house.cell, m));
      if (car.state === 'parked') continue;
      for (let e = Math.max(0, (car.pi - 1) >> 1); e < car.route.length - 1; e++) used.add(g.linkKey(car.route[e], car.route[e + 1]));
    }
    if (g.sweep((a, b) => used.has(g.linkKey(a, b)))) this.replan();
  }

  /** Is the signal at `node` green for traffic arriving from `from`? One phase per road axis through it. */
  isGreen(node: number, from: number): boolean {
    const g = this.graph, n = g.nodes.get(node);
    if (!n || g.nodes.get(from)?.building) return true;   // driveways just give way, whatever the phase
    const axis = (m: number) => {
      const a = Math.atan2(g.pz(m) - n.y, g.px(m) - n.x);
      return a < -0.01 ? a + Math.PI : a > Math.PI - 0.01 ? a - Math.PI : a;
    };
    const same = (a: number, b: number) => Math.min(Math.abs(a - b), Math.PI - Math.abs(a - b)) < 0.3;
    let axes = this.axes.get(node);
    if (!axes) {
      axes = [];
      for (const m of n.links.keys()) {
        const a = axis(m);
        if (!g.nodes.get(m)!.building && !axes.some(b => same(a, b))) axes.push(a);
      }
      this.axes.set(node, axes.sort((a, b) => a - b));
    }
    const mine = axis(from), slot = GREEN + CLEAR, cycle = (this.time + (node % 7)) % (axes.length * slot);
    return same(axes[Math.floor(cycle / slot)], mine) && cycle % slot < GREEN;
  }

  // ---------- routes ----------

  /** Send idle cars to the nearest matching destination that still has an unclaimed pin. */
  private dispatch() {
    for (const house of this.city.houses) {
      if (house.cars < 1) continue;
      const open = this.city.dests.filter(d => d.color === house.color && d.pins > d.assigned);
      if (!open.length) continue;
      const route = this.graph.findPath(house.cell, id => open.some(d => d.cell === id));
      if (!route) continue;
      const dest = open.find(d => d.cell === route[route.length - 1])!;
      const car: Car = { ...this.blank(house, dest), route };
      if (!this.ready(car)) continue;
      this.cars.push(car);
      house.cars--;
      dest.assigned++;
    }
  }

  private blank(house: House, dest: Destination): Car {
    return {
      id: this.nextId++, color: house.color, house, dest, state: 'toDest' as CarState, route: [], path: [], offs: [],
      pi: 0, s: 0, d: 0, v: 0, move: 0, clear: 0, owed: [], ask: -1, wait: 0, lead: null, gap: Infinity, timer: 0, bay: -1,
      pos: { x: 0, y: 0, z: 0, heading: 0 },
    };
  }

  /** Lay out a car at the start of its route. False if another car is still in the doorway. */
  private ready(car: Car): boolean {
    this.plot(car, 0);
    samplePiece(car.path[0], 0, car.pos);
    return !this.cars.some(o => Math.abs(o.pos.y - car.pos.y) < LEVEL_GAP
      && overlap(car.pos.x, car.pos.z, car.pos.heading, o.pos.x, o.pos.z, o.pos.heading, 0.06));
  }

  /** A parked car has its pin: start the drive home, if there is a road and the car park's way out is clear. */
  private leave(car: Car): boolean {
    const g = this.graph, home = car.house.cell, dest = car.dest;
    if (dest.leaving) return false;
    const route = g.findPath(dest.cell, id => id === home, { toward: home }) ?? g.findPath(dest.cell, id => id === home, { toward: home, legacy: true });
    if (!route) return false;
    Object.assign(car, { state: 'toHome', route, path: [], offs: [], pi: 0, s: 0, d: 0, v: 0, clear: 0, owed: [], ask: -1, wait: 0 });
    this.plot(car, 0);
    dest.leaving = car;
    return true;
  }

  /** The path between a destination's entrance and this car's bay, in or out. */
  private lotPiece(car: Car, leaving: boolean): Piece {
    const d = car.dest;
    return this.graph.lot(d.cell, d.entry, d.bays[car.bay], leaving, -(d.id * 64 + car.bay * 2 + (leaving ? 1 : 0)) - 1, LOT.aisle, LOT.back);
  }

  /** Rebuild a car's lane pieces from piece `keep` on, to match its route. */
  private plot(car: Car, keep: number) {
    const g = this.graph, r = car.route, last = 2 * (r.length - 1);
    car.path.length = Math.min(car.path.length, keep);
    for (let p = car.path.length; p <= last; p++) {
      const i = p >> 1;
      // a car with a bay starts or ends its route inside the car park rather than at a door
      const bay = car.bay >= 0 && r[i] === car.dest.cell;
      car.path.push(
        p === 0 ? (bay ? this.lotPiece(car, true) : g.stub(r[0], r[1], false))
          : p === last ? (bay ? this.lotPiece(car, false) : g.stub(r[i - 1], r[i], true))
            : p % 2 ? g.run(r[i], r[i + 1])
              : g.turn(r[i - 1], r[i], r[i + 1]));
    }
    car.offs.length = 0;
    let d = 0;
    for (const piece of car.path) {
      car.offs.push(d);
      d += piece.length;
    }
  }

  /**
   * The road network changed: re-route every car from the first node it is not yet committed to.
   * Roads pending removal are avoided. A car that can no longer reach its destination gives the
   * pin back and drives home; nothing ever leaves the road except by arriving.
   */
  private replan() {
    const g = this.graph;
    this.version = g.version;
    this.axes.clear();
    for (const car of this.cars) {
      if (car.state === 'parked') continue;
      const r = car.route, k = r.length - 1;
      // committed: the edge it is on, plus every turn it already holds right of way through
      const c = Math.min(k, Math.max(car.pi === 0 ? 1 : car.pi % 2 ? (car.pi + 1) / 2 : car.pi / 2 + 1, car.clear + 1));
      const at = r[c], edge = Math.max(0, (car.pi - 1) >> 1);
      const onClosing = !!g.nodes.get(r[edge])?.links.get(r[edge + 1])?.closing;
      const seek = (goal: number, legacy: boolean) =>
        at === goal ? [at] : g.findPath(at, id => id === goal, { toward: goal, avoid: r[c - 1], legacy });
      let tail = car.state === 'toDest' ? seek(car.dest.cell, false) ?? (onClosing ? seek(car.dest.cell, true) : null) : null;
      if (!tail) {
        if (car.state === 'toDest') {
          car.state = 'toHome';
          car.dest.assigned--;
        }
        // if only roads being removed lead home, they stay standing until this car has used them
        tail = seek(car.house.cell, false) ?? seek(car.house.cell, true);
      }
      if (!tail) continue;
      car.route = [...r.slice(0, c), ...tail];
      this.plot(car, car.pi + 1);
    }
  }

  // ---------- each step ----------

  private index() {
    const g = this.graph;
    this.byPiece.clear();
    this.byFork.clear();
    this.near.clear();
    for (const car of this.cars) {
      push(this.near, g.cell(Math.round(car.pos.x), Math.round(car.pos.z)), car);
      if (car.state === 'parked') continue;
      const piece = car.path[car.pi];
      push(this.byPiece, piece.key, car);
      if (piece.kind === 'turn') push(this.byFork, piece.from * this.m + piece.node, car);
    }
  }

  /** Find the car directly ahead on this car's path. */
  private look(car: Car) {
    car.lead = null;
    car.gap = Infinity;
    if (car.state === 'parked') return;
    const { path, offs, d } = car, far = d + 1.4 + (car.v * car.v) / (2 * BRAKE);
    const spot = (o: Car, gap: number) => {
      if (o !== car && gap < car.gap && (gap > 0 || (gap === 0 && o.id < car.id))) {
        car.gap = gap;
        car.lead = o;
      }
    };
    for (let q = car.pi; q < path.length && offs[q] <= far; q++) {
      const piece = path[q];
      for (const o of this.byPiece.get(piece.key) ?? []) spot(o, offs[q] + o.s - d);
      if (piece.kind !== 'turn') continue;
      // a car that peeled off the same lane toward another exit is still in the way until the lanes part
      for (const o of this.byFork.get(piece.from * this.m + piece.node) ?? []) {
        if (o.path[o.pi].key !== piece.key && o.s < FORK) spot(o, offs[q] + o.s - d);
      }
    }
  }

  /** Hand out right of way to the cars at the front of each queue, longest wait first. */
  private grant(dt: number) {
    const g = this.graph, waiters: Car[] = [];
    this.claims.clear();
    for (const car of this.cars) {
      car.ask = -1;
      if (car.state === 'parked') continue;
      const j = car.clear + 1;
      if (j >= car.route.length - 1) continue;
      const start = car.offs[2 * j] - car.d;
      if (this.stopLine(car, j) - car.d > REQUEST + (car.v * car.v) / (2 * BRAKE)) continue;
      // only the front of a queue asks; the cars behind take their turn after it
      if (car.lead && car.gap < start && !this.holdsAt(car.route[j], car.lead)) continue;
      car.ask = j;
      car.wait += dt;
      waiters.push(car);
    }
    // Traffic already on a roundabout goes before traffic joining it. Then cars that are standing in a
    // junction they hold, because moving them is what frees everyone else. Then whoever has waited longest.
    const rank = (car: Car) => {
      const turn = car.path[2 * car.ask], ring = g.nodes.get(turn.node)!.ring;
      return (ring >= 0 && g.nodes.get(turn.from)!.ring === ring ? 2 : 0) + (car.owed.length ? 1 : 0);
    };
    waiters.sort((a, b) => rank(b) - rank(a) || b.wait - a.wait || a.id - b.id);
    const chain = new Set<Car>();
    for (const car of waiters) {
      if (car.clear + 1 !== car.ask) continue;   // already let through as part of someone else's queue
      this.log.length = 0;
      chain.clear();
      if (this.tryGrant(car, car.ask, chain)) for (const entry of this.log) entry.car.wait = 0;
    }
  }

  /**
   * Try to give `car` right of way through the turn at route index `j`. `chain` holds the cars whose
   * requests led here, so a queue that turns out to be waiting on itself is recognised as a ring that
   * can all move together. Anything granted on the way is rolled back if the request fails.
   */
  private tryGrant(car: Car, j: number, chain: Set<Car>): boolean {
    const g = this.graph, turn = car.path[2 * j], node = turn.node;
    if (chain.size > 24) return false;
    if (g.nodes.get(node)?.light && !this.isGreen(node, turn.from)) return false;
    // the last turn into a car park needs a free bay, and the car ahead to have reached its own
    const parking = car.state === 'toDest' && j === car.route.length - 2, dest = car.dest;
    const bay = parking ? dest.bays.findIndex(b => !b.car) : -1;
    if (parking && (dest.entering || bay < 0)) return false;
    const mark = this.log.length, fresh = !chain.has(car);
    chain.add(car);
    const room = this.exitRoom(car, j, chain);
    if (fresh) chain.delete(car);
    // a holder only bars the way with the part of its turn it has not driven yet
    const inWay = room ? (this.holds.get(node) ?? []).filter(h => h.car !== car && h.car.d - h.start - PAST <= g.conflictUntil(h.turn, turn)) : [];
    const barred = room && (inWay.length > 0 || (this.claims.get(node) ?? []).some(c => g.conflictUntil(c, turn) > -Infinity));
    if (room && !barred) {
      push(this.holds, node, { car, turn, start: car.offs[2 * j] });
      this.log.push({ car, turn, was: car.clear, parked: parking });
      car.clear = Math.max(car.clear, j);
      // it keeps the hold until it is out of the turn, and out from beside any sharply angled neighbour
      car.owed.push({ node, until: car.offs[2 * j + 1] + (g.acute(node, turn.to) ? FLANK : 0) });
      if (parking) {
        dest.entering = dest.bays[bay].car = car;
        car.bay = bay;
        this.plot(car, car.path.length - 1);   // the route now ends in that bay
      }
      return true;
    }
    while (this.log.length > mark) {
      const undo = this.log.pop()!;
      this.release(undo.turn.node, undo.car, true);
      undo.car.clear = undo.was;
      undo.car.owed.pop();
      if (!undo.parked) continue;
      undo.car.dest.entering = undo.car.dest.bays[undo.car.bay].car = null;
      undo.car.bay = -1;
      this.plot(undo.car, undo.car.path.length - 1);
    }
    // Ready to go but for the box: nobody may cut in ahead of it. Unless what is in the box is standing
    // still, in which case holding everyone else back as well could only make a jam, never clear one.
    if (barred && !inWay.some(h => h.car.v < 0.05)) push(this.claims, node, turn);
    return false;
  }

  /** How far along its path a car must stop while it has no right of way through the turn at route index `j`. */
  private stopLine(car: Car, j: number): number {
    return car.offs[2 * j] - this.graph.stopBack(car.route[j - 1], car.route[j]);
  }

  private holdsAt(node: number, car: Car): boolean {
    return (this.holds.get(node) ?? []).some(h => h.car === car);
  }

  /**
   * Give up one of a car's holds on a node. A route that doubles back can hold the same node twice:
   * driving on releases the older hold, undoing a grant takes back the newer one.
   */
  private release(node: number, car: Car, newest = false) {
    const list = this.holds.get(node);
    if (!list) return;
    let i = list.findIndex(h => h.car === car);
    if (newest) for (let k = list.length - 1; k > i; k--) if (list[k].car === car) i = k;
    if (i >= 0) list.splice(i, 1);
  }

  /**
   * Can `car` get through the turn at route index `j` and on past the last point where it would be
   * in another movement's way? Turns that cross nobody need no room at all; cars pulling out of a
   * building or doubling back always need the lane they join to be clear.
   */
  private exitRoom(car: Car, j: number, chain: Set<Car>): boolean {
    const g = this.graph, r = car.route, turn = car.path[2 * j], node = r[j];
    const merging = !!g.nodes.get(turn.from)?.building || turn.from === turn.to;
    const blocks = merging ? turn.length : g.blocksUntil(turn);
    if (blocks === -Infinity) return true;
    // the car's centre has to get this far along the turn before it could stop without blocking anyone
    const safe = blocks + PAST;
    // Follow the road on from there to the next line it might have to wait at: a junction, a signal,
    // a box it must keep clear, or the entrance of its goal. `dist` runs from the safe point.
    const last = r.length - 2;
    for (let k = j + 1, dist = turn.length - safe; k <= last; k++) {
      dist += car.path[2 * k - 1].length;
      const line = dist - g.stopBack(r[k - 1], r[k]);
      const waits = k === last || g.strict(r[k]) || g.blocksUntil(car.path[2 * k]) > -Infinity;
      if (line < 0) {
        // that line comes before the safe point: it needs right of way through both nodes, or neither
        if (!this.tryGrant(car, k, chain)) return false;
        if (waits) break;
      } else if (waits) {
        // the stretch up to that line only holds so many cars: count the ones that will need a place on it
        // (cars with right of way through that node will not be stopping, so they do not count)
        const cap = Math.floor(line / GAP) + 1, queue = new Map<Car, number>();
        const add = (o: Car, at: number) => { if (o !== car && !this.holdsAt(r[k], o)) queue.set(o, Math.max(at, queue.get(o) ?? -Infinity)); };
        for (let q = 2 * j + 1; q < 2 * k; q++) for (const o of this.byPiece.get(car.path[q].key) ?? []) add(o, car.offs[q] + o.s);
        // and the cars already let into these nodes that are heading the same way
        for (let m = j; m < k; m++) for (const h of this.holds.get(r[m]) ?? []) if (h.turn.to === r[m + 1]) add(h.car, 0);
        if (queue.size > cap) return false;
        if (queue.size === cap) {
          // full, unless the car at its head can itself be let through (or is one of the cars asking)
          let front = car, far = -Infinity;
          for (const [o, at] of queue) if (at > far) [front, far] = [o, at];
          if (!chain.has(front) && !(front.route[front.clear + 1] === r[k] && front.clear + 2 < front.route.length && this.tryGrant(front, front.clear + 1, chain))) return false;
        }
        break;
      }
      dist += car.path[2 * k].length;
    }
    // nobody may be queueing in the space it needs, unless that queue is about to move
    const need = car.offs[2 * j] + safe + GAP + (g.acute(node, r[j + 1]) ? FLANK : 0);
    for (let q = 2 * j; q < car.path.length && car.offs[q] < need; q++) {
      for (const o of this.byPiece.get(car.path[q].key) ?? []) {
        const at = car.offs[q] + o.s;
        if (o === car || o.v >= SLOW || at > need || at <= car.d) continue;
        if (!this.willMove(o, chain, need - at + 0.02)) return false;
      }
    }
    return true;
  }

  /**
   * Is the queue this car is standing in about to move up by at least `by`? Follow it to its head:
   * that car must have that much open road before its next stop line, or be given right of way there.
   */
  private willMove(car: Car, chain: Set<Car>, by: number): boolean {
    let head = car;
    for (let n = 0; n < 40 && head.lead && head.gap < GAP + 0.25 && !chain.has(head); n++) head = head.lead;
    if (chain.has(head)) return true;
    const j = head.clear + 1;
    if (j >= head.route.length - 1) return true;   // nothing left for it to wait for
    const free = this.stopLine(head, j) - head.d;
    if (Math.min(free, head.gap - GAP) >= by) return true;
    return free < 0.3 && this.tryGrant(head, j, chain);
  }

  /** Choose this step's speed and distance from the car ahead, the next stop line and the bends coming up. */
  private plan(car: Car, dt: number) {
    car.move = 0;
    if (car.state === 'parked') {
      if ((car.timer -= dt) <= 0 && !this.leave(car)) car.timer = 0.3;
      return;
    }
    const { path, offs, d } = car, j = car.clear + 1;
    let room = car.gap - GAP;
    if (j < car.route.length - 1) room = Math.min(room, this.stopLine(car, j) - d);   // no right of way yet: stop at the line
    room = Math.max(0, room);
    let top = SPEED * path[car.pi].limit;
    for (let q = car.pi + 1; q < path.length && offs[q] - d < 1.2; q++) {
      const ahead = SPEED * path[q].limit;
      if (ahead < top) top = Math.min(top, Math.sqrt(ahead * ahead + 2 * ACCEL * (offs[q] - d)));
    }
    const target = Math.min(top, Math.sqrt(2 * BRAKE * room));
    car.v += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - car.v));
    car.move = Math.min(car.v * dt, room);
  }

  /** Move the car, but never into another car: the step is shortened until its body stays clear. */
  private advance(car: Car) {
    if (car.move <= 0) return;
    const { path, offs } = car, end = offs[path.length - 1] + path[path.length - 1].length, at = this.probe;
    for (let step = car.move, tries = 0; tries < 3; tries++, step /= 2) {
      const d = Math.min(end, car.d + step);
      let q = car.pi;
      while (q < path.length - 1 && d >= offs[q + 1]) q++;
      samplePiece(path[q], d - offs[q], at);
      if (this.touches(car, at)) continue;
      for (; car.pi < q; car.pi++) {
        if (car.pi === 0 && car.bay >= 0 && car.state === 'toHome') {
          // out of the car park: its bay and the way out are free again
          car.dest.bays[car.bay].car = null;
          if (car.dest.leaving === car) car.dest.leaving = null;
          car.bay = -1;
        }
      }
      car.d = d;
      car.s = d - offs[q];
      Object.assign(car.pos, at);
      for (let i = car.owed.length - 1; i >= 0; i--) {
        if (d < car.owed[i].until) continue;
        this.release(car.owed[i].node, car);   // clear of that node
        car.owed.splice(i, 1);
      }
      if (d >= end - 1e-4) this.arrive(car);
      return;
    }
    car.v = 0;
  }

  private touches(car: Car, at: PathSample): boolean {
    const g = this.graph, cx = Math.round(at.x), cz = Math.round(at.z);
    for (let z = cz - 1; z <= cz + 1; z++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (!g.inBounds(x, z)) continue;
        for (const o of this.near.get(g.cell(x, z)) ?? []) {
          if (o !== car && Math.abs(o.pos.y - at.y) < LEVEL_GAP && overlap(at.x, at.z, at.heading, o.pos.x, o.pos.z, o.pos.heading)) return true;
        }
      }
    }
    return false;
  }

  private arrive(car: Car) {
    for (const hold of car.owed.splice(0)) this.release(hold.node, car);
    if (car.state === 'toHome') {
      car.house.cars++;
      this.cars.splice(this.cars.indexOf(car), 1);
      return;
    }
    car.state = 'parked';
    car.timer = PARK;
    car.v = 0;
    if (car.dest.entering === car) car.dest.entering = null;
    car.dest.assigned--;
    car.dest.pins = Math.max(0, car.dest.pins - 1);
    this.city.score++;
    this.emit({ type: 'deliver', color: car.color });
  }
}

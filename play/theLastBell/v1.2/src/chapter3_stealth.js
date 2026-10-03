import * as THREE from 'three';
import { createHumanoid, Character, COACH_BILLING_LOOK } from './world.js';
import { createEldarRig, createEldarMaterials, animateEldar } from './combat.js';
import { createBeamMaterial, createBeamGeometry, createMarkTexture, createGlareTexture, CH1_VISION } from './stealth.js';
import { difficulty } from './difficulty.js';
import { Achievements } from './achievements.js';
import { GymFinale } from './chapter3_gym.js';
import {
  setUnderground,
  setRainExposure,
  startSiren,
  stopSiren,
  startAlarm,
  stopAlarm,
  playLockerDoor,
  playDoorBang,
  playStruggle,
  playBreakFree,
  playHideCreak,
  playYankOpen,
  playHeartbeat,
  playChainLock,
  playBreathing,
  playDistantEngine,
  playServo,
  playWhistle,
  playCaughtStinger,
  playLadderStep,
  playRobotCharge,
  playCarDoor,
} from './audio.js';
import { buildLockerRoom } from './chapter3_lockers.js';

/*
 * Chapter 3 — Lights Out. Part 1: the grounds. Part 2: the locker room (then
 * the gym: chapter3_gym.js).
 *
 * ~2:40 AM. Ben and Other Ben climb back out of the oak with the drive and
 * find Coach Billing huddled with his three assistant coaches and seven ELDARs
 * across the field. They duck behind their car; Billing orders a search and
 * locks himself inside the school. The plan: upload the drive in the server
 * room tonight, through the locker room door on the west wing. Other Ben takes
 * the car around front; you cross the grounds alone.
 *
 *   - 3 coaches (lethal): flashlight beams and plain sight out to 1.5x Chapter
 *     1's range, raycast against cover; chase at 90% of your sprint; lose sight
 *     of you for 2.5s and they search ("?"): walk to the last place they saw
 *     you, stop, look hard left and right, then sweep the cover and corners
 *     within ~9m for 6-8s before going back to their rounds. Reaching you = caught.
 *   - 7 ELDAR sentries (non-lethal) at the choke points: a touch grabs you (mash
 *     [SPACE] / click 10 times) and their siren brings the nearest coach running.
 *   - Dumpsters and sheds you can hide in ([E], unless a coach sees you get in).
 *   - The locker room door only opens once nobody's chasing or searching for you;
 *     inside, the grounds and the bunker are unloaded and the locker room loads.
 *
 * Part 2, the locker room: Coach Billing comes out of his office with a
 * flashlight and walks his rounds between you and the gym doors, stopping at
 * every side turning off the walkways to put his light down it. Hide in the
 * lighter-doored lockers (you watch through the vents); if he loses you he
 * checks the lockers right where he last saw you. Get spotted and he radios
 * for backup: another coach smashes in through the door you bolted.
 *   Normal: Billing + 2 ELDARs (spotted: + Coach Tom).
 *   Hard:   Billing + Tom + 2 ELDARs (spotted: + Coach Hale).
 */

// ---- Tunables ------------------------------------------------------------------
const V = CH1_VISION;
const VISION = {
  halfAngle: V.visionHalfAngle,
  beamHalfAngle: V.beamHalfAngle,
  beamReach: V.beamReach, // Chapter 1's: caught in the light (18m), x STANCE below (out of the light: GLIMPSE)
  flashlightMult: V.flashlightMult,
};
// How far the coaches can pick you out (beam, plain sight and the close-range
// check), as a multiple of Chapter 1's, by what you're doing.
const STANCE = {
  crouchStill: 0.8, // crouched, not moving: 14m in the beam
  crouchMove: 1.15, // creeping: 21m
  upright: 1.35, // standing / walking: 24m
  sprint: 1.5, // running: 27m
};
// Out of the beam (the "?" glimpse, and what a searching coach spots you with),
// by stance: meters, and how wide their view is. Crouched you're a dark shape
// low in the grass: only close, and only near the middle of their view.
const GLIMPSE = {
  crouchStill: { range: 8, angle: 0.6 },
  crouchMove: { range: 13, angle: 0.7 },
  upright: { range: 40, angle: 1 },
  sprint: { range: 60, angle: 1 },
};
// Indoors, in the dark locker room: shorter all round (x1.6 under a working light).
const LOCKER_GLIMPSE = {
  crouchStill: { range: 4.5, angle: 0.6 },
  crouchMove: { range: 7.5, angle: 0.7 },
  upright: { range: 15, angle: 1 },
  sprint: { range: 22, angle: 1 },
};
const LOCKER_BEAM_REACH = 15; // x STANCE
const LIT_MULT = 1.6;
const WET_HEARING = 1.5; // footsteps on wet shower tile
const BEAM_SCALE = 1.5; // the visible cones grow with it
const PLAYER_SPRINT = 7.6;
const HUNTER = {
  patrol: 1.8,
  investigate: 2.8,
  search: 3.6,
  chase: PLAYER_SPRINT * 0.9, // 90% of your sprint: you can only just outrun them
  loseSight: 2.5, // seconds out of sight before a chase becomes a search (see SEARCH)
  catchRadius: 1.2,
  closeRange: 16, // (at a sprint; x STANCE / 1.5) seen in plain sight this close (not only in the beam) and the suspicion climbs
  pursuitSight: 50, // a chasing coach keeps you in sight out to here, whichever way it faces
};
// The search ("?") once a chase goes cold. It walks to where it lost you and stops dead,
// looks hard left and right, then sweeps the area (cover, corners, the places it couldn't
// see from that spot) for 6-8 seconds before one last look around and back to its rounds.
// Noise mid-search pulls the whole search over to it.
const SEARCH = {
  halt: 0.6,
  inspectAngle: 1.3, // ~75 degrees each side of the way it came
  inspectHold: 1.05,
  radius: [3.5, 9.5], // meters from the spot
  points: 3,
  sweep: [6, 8], // seconds of sweeping
  cornerLook: [0.9, 1.3], // at each point
  finalLook: 1.8,
};
const SENTRY = {
  patrol: 1.4,
  lunge: 4.9, // faster than your walk, slower than your sprint
  sight: 11 * 1.3, // 14.3m
  halfAngle: THREE.MathUtils.degToRad(32 * 1.3), // 41.6 degrees each side
  grabRadius: 0.95,
  taps: 10,
  stun: 3.0,
  cooldown: 6.0,
  recovery: 1.5,
  lungeTime: 6,
};

// ---- Layout (Chapter 1's grounds; -Z is toward the oak) -------------------------
const CAR_SPOT = { x: 1.5, z: -100, yaw: Math.PI / 2 }; // the Bens' car, on the grass by the oak
const CAR_CAM = new THREE.Vector3(4.0, 1.08, -101.55); // crouched at the car's end, peeking past the hood (clear of the container)
const BEN_HIDE = new THREE.Vector3(0.2, 0, -102.2);
const HUDDLE = new THREE.Vector3(-2, 0, -54);
const MAIN_DOORS = new THREE.Vector3(0, 0, -34.4);
// Respawn points: each one is at least SAFE_SPAWN from every sentry's whole beat
// and from where the coaches restart (_clearSpawn double-checks on every respawn).
// Past the bleachers you get the one on your side of the field.
const SAFE_SPAWN = 15;
const CHECKPOINTS = [
  { pos: new THREE.Vector3(1.2, 0, -102.6), yaw: Math.PI, name: 'behind the car' },
  { pos: new THREE.Vector3(-40.4, 0, -62.6), yaw: -2.78, name: 'behind the west shed' },
  { pos: new THREE.Vector3(36.4, 0, -76), yaw: 2.6, name: 'at the far end of the lot' },
];
const TREE_CHECKPOINT = { pos: new THREE.Vector3(0, 0, -116.8), yaw: Math.PI, name: 'behind the oak' }; // once the car's gone

// The edge of the grounds: invisible walls (you're not leaving Ben behind).
// West of the school the grounds run up past the wing to z = -12; east of it
// they stop at the building line.
const BOUNDS = { minX: -60, maxX: 64, minZ: -124, northWest: -12, northEast: -34.4, schoolHalf: 12.4 };

const HUNTER_DEFS = [
  {
    id: 'lage',
    name: 'Coach Lage',
    callout: "GOT ONE! Coach, I've got one of them!",
    huddle: [-3.6, -55.4],
    route: [ // the courtyard behind the school
      { x: 10, z: -44, pause: 2 },
      { x: -4, z: -45.5, pause: 1.5 },
      { x: -8, z: -55, pause: 2 },
      { x: 6, z: -56, pause: 1.5 },
    ],
  },
  {
    id: 'tom',
    name: 'Coach Tom',
    callout: "End of the line, Ben.",
    huddle: [-0.4, -55.4],
    route: [ // the west approach and the wing
      { x: -20, z: -47, pause: 2 },
      { x: -35, z: -44, pause: 1.5 },
      { x: -35, z: -25, pause: 2.5 },
      { x: -35, z: -44, pause: 1 },
      { x: -24, z: -58, pause: 2 },
    ],
  },
  {
    id: 'hale',
    name: 'Coach Hale',
    callout: 'Nowhere left to run, kid!',
    huddle: [-2.0, -56.1],
    route: [ // the open field
      { x: -8, z: -88, pause: 2 },
      { x: -22, z: -78, pause: 1.5 },
      { x: -10, z: -74, pause: 2 },
      { x: 14, z: -76, pause: 1.5 },
      { x: 4, z: -88, pause: 2 },
    ],
  },
];
const HALE_LOOK = { shirt: 0x2f4a2a, pants: 0x2b2b30, hair: 0x1a1a1a, skin: 0x8d5a3b, scale: 1.1, raincoat: true, whistle: true, cap: true, capColor: 0x6b1d1d };

// ---- The locker room (chapter3_lockers.js builds it; x runs west -> east) --------
const BILLING_ROUNDS = {
  id: 'billing',
  name: 'Coach Billing',
  callout: 'GOTCHA! Nobody sneaks around MY locker room.',
  yankLine: 'Hiding in a locker? Really, Ben?',
  huddle: [15, 4],
  route: [
    { x: 14.6, z: 3.6, pause: 2 }, // outside his office
    { x: 10.8, z: 0.2, pause: 1.5 }, // the sinks
    { x: 5.9, z: 9.0, pause: 1.5 },
    { x: -6, z: 9.2, pause: 2.2 }, // the north walkway: light down the aisles
    { x: -14.4, z: 8.6, pause: 1.5 },
    { x: -14.4, z: -8.4, pause: 2.2 }, // the west aisle, checking the alcove
    { x: -4, z: -9, pause: 1.8 }, // the south walkway: light up the aisles
    { x: 5.9, z: -8.9, pause: 1.2 },
    { x: 12.8, z: -7.6, pause: 1 }, // into the showers
    { x: 19.8, z: -7.6, pause: 2 },
    { x: 18.2, z: -0.6, pause: 2 }, // the gym doors
  ],
};
const LOCKER_CHECKPOINTS = [
  { pos: new THREE.Vector3(-18.4, 0, 0.9), yaw: -Math.PI / 2, name: 'in the entry alcove' },
  { pos: new THREE.Vector3(6.1, 0, -0.6), yaw: -Math.PI / 2, name: 'past the locker banks' },
];
// Coach Tom: the backup Billing calls in if you set off the alarm (he barges in through the exterior door).
const TOM_LOOK = { shirt: 0x8c2a22, pants: 0x2b2b30, hair: 0x5a3a22, skin: 0xb07a52, scale: 1.08, raincoat: true, whistle: true, hood: true };
const TOM_ROUNDS = {
  id: 'tom',
  name: 'Coach Tom',
  callout: 'Billing! I got him! I GOT HIM!',
  yankLine: 'Nice try, kid. I can hear you breathing.',
  huddle: [-19, 0],
  route: [
    { x: -14.4, z: -8.4, pause: 1.8 },
    { x: -4, z: -9, pause: 1.5 },
    { x: 5.9, z: -8.9, pause: 1.5 },
    { x: 5.9, z: 9, pause: 1.8 },
    { x: -6, z: 9.2, pause: 1.5 },
    { x: -14.4, z: 8.6, pause: 1.8 },
  ],
};
// Coach Hale: Hard Mode's third coach (Tom's already in the room there), called in by the alert.
const HALE_ROUNDS = {
  id: 'hale',
  name: 'Coach Hale',
  callout: 'Nowhere left to run, kid!',
  yankLine: 'Knock knock, Ben.',
  huddle: [-19, 0],
  route: [
    { x: -10, z: 8.6, pause: 1.6 },
    { x: -10, z: -8.4, pause: 1.4 },
    { x: 2, z: -8.6, pause: 1.6 },
    { x: 2, z: 8.8, pause: 1.4 },
    { x: 10.8, z: 8.4, pause: 1.6 },
    { x: 10.5, z: -2, pause: 1.4 },
  ],
};
// Side turnings off the locker room's walkways (its spine). Walking past one on his rounds, a
// coach stops, turns square to it and puts his light down it (the locker rows, the entry
// alcove, the shower stalls), then walks on. yaw: the way he looks (0 = +Z).
const LOCKER_PEEKS = [
  ...[2, -2, -10].map((x) => ({ x, z: 9.1, yaw: Math.PI })), // north walkway: down the aisles
  ...[-10, -6, -2, 2].map((x) => ({ x, z: -8.8, yaw: 0 })), // south walkway: up the aisles
  { x: -14.4, z: 0.4, yaw: -Math.PI / 2, hold: 2.0 }, // the west aisle: into the entry alcove
  ...[14.3, 16.5].map((x) => ({ x, z: -7.6, yaw: Math.PI, hold: 1.2 })), // the shower corridor: into the stalls
];
const PEEK_REPEAT = 16; // seconds before the same coach checks the same turning again

// Two ELDAR sentries patrol the room from the start: one the middle aisles, one the east end and the showers.
const SCOUT_ROUTES = [
  [[-6, 8.8], [-6, -8.4], [2, -8.6], [2, 8.8]],
  [[6, 9], [10.8, 8.4], [10.5, 0], [17.5, -2.5], [17.5, -7.6], [11.5, -7.6], [6, -9]],
];
const SCOUT_STATS = { sight: 9.5, halfAngle: THREE.MathUtils.degToRad(38), patrol: 1.5, lunge: 4.6 };

// Sentries pace back and forth across the choke points.
const SENTRY_DEFS = [
  { a: [0.5, -60.5], b: [0.5, -75.5] }, // the gap between the bleachers and the container
  { a: [-10, -41.8], b: [-10, -52] }, // courtyard, west side
  { a: [-31, -38.5], b: [-31, -48] }, // the wing's southwest corner (the way to the door)
  { a: [-29, -76], b: [-29, -94] }, // west field, by the shed
  { a: [19.6, -50], b: [19.6, -68] }, // the lot's west edge
  { a: [-14, -60], b: [-19.5, -70] }, // bleachers to the crates
  { a: [12.5, -40.5], b: [12.5, -52] }, // courtyard, east side
];

// Hiding spots. yaw = the way the opening (lid gap / shed door) faces.
const HIDE_DEFS = [
  { kind: 'dumpster', x: -17, z: -40.35, yaw: Math.PI }, // against the wing's south wall
  { kind: 'dumpster', x: -28.75, z: -34.6, yaw: -Math.PI / 2 }, // right by the locker room door
  { kind: 'dumpster', x: 8.5, z: -47, yaw: Math.PI }, // courtyard, east
  { kind: 'dumpster', x: -4, z: -58, yaw: Math.PI }, // middle of the courtyard
  { kind: 'shed', x: -20, z: -94, yaw: 0 }, // west field, near the oak
  { kind: 'shed', x: 14, z: -84, yaw: 0 }, // by the lot
  { kind: 'shed', x: -38, z: -60, yaw: Math.PI / 2 }, // far west
];

const rand = (a, b) => a + Math.random() * (b - a);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function dampAngle(current, target, t) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ---------------------------------------------------------------------------
// Navigation: a walkability grid over the grounds (solid things rasterized in,
// grown by a walker's radius) + A* with string-pulled paths. The field is full
// of props, and walking straight at a target wedges people against them.
// ---------------------------------------------------------------------------

export class NavGrid {
  constructor({ minX, maxX, minZ, maxZ, cell = 0.8, inflate = 0.45 }) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.inflate = inflate;
    this.w = Math.ceil((maxX - minX) / cell);
    this.h = Math.ceil((maxZ - minZ) / cell);
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heapIdx = new Int32Array(n);
    this.heapF = new Float32Array(n);
    this.stamp = 0;
  }

  build(boxes) {
    this.blocked.fill(0);
    const c = this.cell;
    const r = this.inflate;
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor((b.min.x - r - this.minX) / c));
      const x1 = Math.min(this.w - 1, Math.floor((b.max.x + r - this.minX) / c));
      const z0 = Math.max(0, Math.floor((b.min.z - r - this.minZ) / c));
      const z1 = Math.min(this.h - 1, Math.floor((b.max.z + r - this.minZ) / c));
      for (let iz = z0; iz <= z1; iz++) {
        const cz = this.minZ + (iz + 0.5) * c;
        if (cz < b.min.z - r || cz > b.max.z + r) continue;
        for (let ix = x0; ix <= x1; ix++) {
          const cx = this.minX + (ix + 0.5) * c;
          if (cx >= b.min.x - r && cx <= b.max.x + r) this.blocked[iz * this.w + ix] = 1;
        }
      }
    }
  }

  cellOf(x, z) {
    const ix = Math.floor((x - this.minX) / this.cell);
    const iz = Math.floor((z - this.minZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
    return iz * this.w + ix;
  }

  isFree(x, z) {
    const i = this.cellOf(x, z);
    return i >= 0 && !this.blocked[i];
  }

  /** The closest walkable cell to `i` (spiralling out a few cells), or -1. */
  nearestFree(i) {
    if (i < 0) return -1;
    if (!this.blocked[i]) return i;
    const ix = i % this.w;
    const iz = (i - ix) / this.w;
    for (let r = 1; r <= 4; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = ix + dx;
          const z = iz + dz;
          if (x < 0 || z < 0 || x >= this.w || z >= this.h) continue;
          const j = z * this.w + x;
          if (!this.blocked[j]) return j;
        }
      }
    }
    return -1;
  }

  /** Can you walk straight from a to b? (Sampled along the grid.) */
  lineClear(ax, az, bx, bz) {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const i = this.cellOf(ax + (bx - ax) * t, az + (bz - az) * t);
      if (i >= 0 && this.blocked[i]) return false;
    }
    return true;
  }

  /** Waypoints from `from` to `to` (excluding the start), or null if there's no way. */
  path(from, to) {
    const start = this.nearestFree(this.cellOf(from.x, from.z));
    const goal = this.nearestFree(this.cellOf(to.x, to.z));
    if (start < 0 || goal < 0) return null;
    const exactGoal = this.isFree(to.x, to.z);
    const end = exactGoal ? new THREE.Vector3(to.x, 0, to.z) : this._center(goal, new THREE.Vector3());
    if (start === goal || this.lineClear(from.x, from.z, end.x, end.z)) return [end];

    const W = this.w;
    const stamp = ++this.stamp;
    const gx = goal % W;
    const gz = (goal - gx) / W;
    const hFn = (i) => {
      const x = i % W;
      const dx = Math.abs(x - gx);
      const dz = Math.abs((i - x) / W - gz);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    let size = 0;
    const push = (i, f) => {
      let k = size++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (this.heapF[p] <= f) break;
        this.heapIdx[k] = this.heapIdx[p];
        this.heapF[k] = this.heapF[p];
        k = p;
      }
      this.heapIdx[k] = i;
      this.heapF[k] = f;
    };
    const pop = () => {
      const top = this.heapIdx[0];
      const lastI = this.heapIdx[--size];
      const lastF = this.heapF[size];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= size) break;
        if (c + 1 < size && this.heapF[c + 1] < this.heapF[c]) c++;
        if (this.heapF[c] >= lastF) break;
        this.heapIdx[k] = this.heapIdx[c];
        this.heapF[k] = this.heapF[c];
        k = c;
      }
      this.heapIdx[k] = lastI;
      this.heapF[k] = lastF;
      return top;
    };
    this.g[start] = 0;
    this.seen[start] = stamp;
    this.came[start] = -1;
    push(start, hFn(start));
    let found = false;
    let expansions = 0;
    while (size > 0 && expansions < 40000) {
      const cur = pop();
      if (this.closed[cur] === stamp) continue;
      this.closed[cur] = stamp;
      expansions++;
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = cur % W;
      const cz = (cur - cx) / W;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= W || nz >= this.h) continue;
          const ni = nz * W + nx;
          if (this.blocked[ni] || this.closed[ni] === stamp) continue;
          if (dx && dz && (this.blocked[cz * W + nx] || this.blocked[nz * W + cx])) continue; // no corner cutting
          const ng = this.g[cur] + (dx && dz ? Math.SQRT2 : 1);
          if (this.seen[ni] === stamp && ng >= this.g[ni]) continue;
          this.seen[ni] = stamp;
          this.g[ni] = ng;
          this.came[ni] = cur;
          push(ni, ng + hFn(ni));
        }
      }
    }
    if (!found) return null;
    // Cells back to the start, then pull the string tight (skip every corner you can see past).
    const cells = [];
    for (let i = goal; i !== -1 && i !== start; i = this.came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => this._center(i, new THREE.Vector3()));
    pts[pts.length - 1] = end;
    const out = [];
    let ax = from.x;
    let az = from.z;
    let k = 0;
    while (k < pts.length) {
      let far = k;
      for (let j = pts.length - 1; j > k; j--) {
        if (this.lineClear(ax, az, pts[j].x, pts[j].z)) {
          far = j;
          break;
        }
      }
      out.push(pts[far]);
      ax = pts[far].x;
      az = pts[far].z;
      k = far + 1;
    }
    return out;
  }

  _center(i, out) {
    const ix = i % this.w;
    const iz = (i - ix) / this.w;
    return out.set(this.minX + (ix + 0.5) * this.cell, 0, this.minZ + (iz + 0.5) * this.cell);
  }
}

// ---------------------------------------------------------------------------
// Hiding spots: dumpsters (peek out under the lid) and sheds (through the door slats)
// ---------------------------------------------------------------------------

function buildHideProps(scene) {
  const mats = {
    dumpster: new THREE.MeshStandardMaterial({ color: 0x2c4f30, roughness: 0.75, metalness: 0.25 }),
    lid: new THREE.MeshStandardMaterial({ color: 0x1f3a23, roughness: 0.7, metalness: 0.2 }),
    wheel: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }),
    shed: new THREE.MeshStandardMaterial({ color: 0x55604f, roughness: 0.9 }),
    shedTrim: new THREE.MeshStandardMaterial({ color: 0x3b4136, roughness: 0.9 }),
    door: new THREE.MeshStandardMaterial({ color: 0x6b5238, roughness: 0.85 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x3b3e42, roughness: 1 }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
  const wheelGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10);
  return HIDE_DEFS.map((def, i) => {
    const group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    group.rotation.y = def.yaw; // local +Z = the opening side
    scene.add(group);
    const add = (geo, mat, x, y, z, parent = group) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const spot = { def, kind: def.kind, group, id: i, open: 0, target: 0, speed: 3, fling: false };
    let body;
    let hitbox;
    if (def.kind === 'dumpster') {
      body = add(new THREE.BoxGeometry(1.9, 1.2, 1.2), mats.dumpster, 0, 0.72, 0);
      add(new THREE.BoxGeometry(1.94, 0.08, 0.1), mats.lid, 0, 0.3, 0.62); // bumper rail
      [[-0.8, -0.45], [0.8, -0.45], [-0.8, 0.45], [0.8, 0.45]].forEach(([x, z]) => {
        const w = add(wheelGeo, mats.wheel, x, 0.1, z);
        w.rotation.z = Math.PI / 2;
      });
      // Lid on a hinge along the back edge; opening it lifts the front.
      spot.hinge = new THREE.Group();
      spot.hinge.position.set(0, 1.32, -0.6);
      group.add(spot.hinge);
      add(new THREE.BoxGeometry(1.96, 0.06, 1.26), mats.lid, 0, 0.0, 0.62, spot.hinge);
      spot.openAngle = -1.15; // (rotation.x: lifts the front edge)
      spot.crackAngle = -0.09;
      hitbox = add(new THREE.BoxGeometry(2.0, 1.45, 1.35), mats.hidden, 0, 0.72, 0);
      spot.eyeLocal = new THREE.Vector3(0, 1.06, 0.22);
      spot.exitLocal = new THREE.Vector3(0, 0, 1.35);
      spot.frontLocal = new THREE.Vector3(0, 0, 1.6);
      spot.label = 'Hide in the dumpster';
    } else {
      body = add(new THREE.BoxGeometry(2.6, 2.4, 2.2), mats.shed, 0, 1.2, 0);
      const roof = add(new THREE.BoxGeometry(3.0, 0.12, 2.6), mats.roof, 0, 2.46, 0);
      roof.rotation.x = 0.06;
      [-0.56, 0.56].forEach((x) => add(new THREE.BoxGeometry(0.08, 2.1, 0.06), mats.shedTrim, x, 1.05, 1.12)); // door frame
      add(new THREE.BoxGeometry(1.2, 0.08, 0.06), mats.shedTrim, 0, 2.1, 1.12);
      // Door on a hinge at its left edge, swinging out.
      spot.hinge = new THREE.Group();
      spot.hinge.position.set(-0.5, 0, 1.15);
      group.add(spot.hinge);
      const leaf = add(new THREE.BoxGeometry(1.0, 1.95, 0.05), mats.door, 0.5, 1.0, 0, spot.hinge);
      for (let y = 1.25; y < 1.8; y += 0.12) add(new THREE.BoxGeometry(0.7, 0.03, 0.06), mats.shedTrim, 0, y - 1.0, 0.01, leaf); // vent slats
      spot.leaf = leaf; // hidden while you're inside (you peek out through the slats: the overlay draws them)
      spot.openAngle = 1.3; // (rotation.y: swings out)
      spot.crackAngle = 0.0;
      hitbox = add(new THREE.BoxGeometry(1.4, 2.1, 0.6), mats.hidden, 0, 1.05, 1.2);
      spot.eyeLocal = new THREE.Vector3(0.05, 1.5, 0.6);
      spot.exitLocal = new THREE.Vector3(0.2, 0, 1.9);
      spot.frontLocal = new THREE.Vector3(0.2, 0, 2.1);
      spot.label = 'Hide in the shed';
    }
    hitbox.userData = { interactable: true, label: spot.label, type: 'ch3-hide', spot };
    group.updateMatrixWorld(true);
    spot.body = body;
    spot.hitbox = hitbox;
    spot.eye = group.localToWorld(spot.eyeLocal.clone());
    spot.exit = group.localToWorld(spot.exitLocal.clone());
    spot.front = group.localToWorld(spot.frontLocal.clone());
    spot.lookYaw = def.yaw + Math.PI; // camera yaw (0 looks down -Z) that faces out of the opening
    spot.setAngle = (a) => {
      if (spot.kind === 'dumpster') spot.hinge.rotation.x = a;
      else spot.hinge.rotation.y = a;
    };
    spot.setAngle(0);
    return spot;
  });
}

function updateHideProp(spot, dt) {
  if (spot.open === spot.target) return;
  const step = dt * spot.speed;
  spot.open = spot.target > spot.open ? Math.min(spot.target, spot.open + step) : Math.max(spot.target, spot.open - step);
  spot.setAngle(spot.open);
}

// ---------------------------------------------------------------------------
// A coach on the hunt
// ---------------------------------------------------------------------------

class Hunter {
  constructor(sys, def, character, parts) {
    this.sys = sys;
    this.id = def.id;
    this.name = def.name;
    this.callout = def.callout;
    this.yankLine = def.yankLine || "Thought I didn't see you climb in there?";
    this.route = def.route;
    this.huddle = def.huddle;
    this.coach = character;
    this.light = parts.light;
    this.lightTarget = parts.lightTarget;
    this.beam = parts.beam;
    this.glare = parts.glare;
    this.prop = parts.prop;
    this.lens = parts.lens;
    this.beam.scale.setScalar(BEAM_SCALE);
    this.mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: sys.questionTex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    this.mark.renderOrder = 999;
    this.mark.visible = false;
    sys.scene.add(this.mark);

    this.thinking = false;
    // patrol | peek | pause | heard | investigate | chase | search | yank | idle
    // (search runs through sub-states: go, halt, inspect, check, sweep, look)
    this.state = 'idle';
    this._peek = null;
    this._peekedAt = new Map(); // turning -> when this coach last looked down it
    this._sweepPts = [];
    this._sweepT = 0;
    this._sweepLook = 0;
    this._inspect = 0;
    this._refocusAt = -99;
    this.sub = '';
    this.waypoint = 0;
    this.timer = 0;
    this.suspicion = 0;
    this.visible = false;
    this.litUp = false;
    this.lostT = 0;
    this.alertRun = false;
    this.aimYaw = 0;
    this.sweepBase = 0;
    this.yankSpot = null;
    this.markKind = null;
    this.markPop = 0;
    this.repathT = 0;
    this._investAt = -99;
    this._time = Math.random() * 10;
    this.lastSeen = new THREE.Vector3();
    this.target = new THREE.Vector3(); // where it's walking/running to (chase: you, or where it last saw you)
    this.noiseAt = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._lightPos = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
    this._followTarget = () => this.target;
  }

  get position() {
    return this.coach.position;
  }

  /** HUNTER speeds, scaled for Hard Mode (the chase stays just under your sprint). */
  _speed(kind) {
    return HUNTER[kind] * (kind === 'chase' ? difficulty.chaseMult : difficulty.coachSpeedMult);
  }

  /** Walk (or run) to (x, z) around whatever's in the way. */
  _moveTo(x, z, speed) {
    this._goal = this._goal || new THREE.Vector3();
    this._goal.set(x, 0, z);
    const path = this.sys.nav.path(this.coach.position, this._goal);
    if (path) this.coach.walkRoute(path, speed);
    else this.coach.moveTo(x, z, speed);
  }

  /** Mid-chase: straight at you when there's a clear run, around the cover when there isn't. */
  _updateChaseMove(dt) {
    this.repathT -= dt;
    if (this.repathT > 0) return;
    this.repathT = 0.3;
    const c = this.coach.position;
    if (this.sys.nav.lineClear(c.x, c.z, this.target.x, this.target.z)) {
      if (this.coach.mode !== 'follow') this.coach.follow(this._followTarget, this._speed('chase'));
    } else {
      const path = this.sys.nav.path(c, this.target);
      if (path) this.coach.walkRoute(path, this._speed('chase'));
    }
  }

  lightOn() {
    this.light.intensity = V.lightIntensity;
    this.beam.visible = true;
    this.glare.visible = true;
    this.lens.material.color.set(0xfff6dc);
    this.coach.mesh.userData.rig.holdingFlashlight = true;
  }

  /** Stand at (x, z) facing `yaw` (the huddle, retries). */
  place(x, z, yaw) {
    this.coach.stop();
    this.coach.faceTowards(null);
    this.coach.mesh.position.set(x, 0, z);
    this.coach.mesh.rotation.y = yaw;
    this.aimYaw = yaw;
    this.state = 'idle';
    this.suspicion = 0;
    this.visible = false;
    this.litUp = false;
  }

  /** Start its rounds from waypoint `index` (walking there first). */
  patrolFrom(index, teleport = false) {
    const wp = this.route[index];
    this.waypoint = index;
    this.suspicion = 0;
    this.lostT = 0;
    this.alertRun = false;
    this.yankSpot = null;
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    if (teleport) {
      this.coach.stop();
      this.coach.mesh.position.set(wp.x, 0, wp.z);
      this._enterPause(1.2);
    } else {
      this.state = 'patrol';
      this._moveTo(wp.x, wp.z, this._speed('patrol') + 0.6);
    }
  }

  update(dt) {
    if (this.thinking) this._think(dt);
    this._updateAim(dt);
    this._updateFlashlight();
    this._updateMark(dt);
  }

  _think(dt) {
    const sys = this.sys;
    const coach = this.coach;
    const ppos = sys.player.object.position;
    this.litUp = false;

    switch (this.state) {
      case 'patrol':
        if (coach.mode === 'idle') this._enterPause(this.route[this.waypoint].pause);
        else this._checkPeek();
        break;
      case 'peek':
        this._updatePeek(dt);
        break;
      case 'pause':
        this.timer -= dt;
        this._sweep(0.9, 0.9);
        if (this.timer <= 0) this._advance();
        break;
      case 'heard':
        this.timer -= dt;
        if (this.timer < HUNTER.loseSight - 0.5 && coach.faceTarget !== this.noiseAt) coach.faceTowards(this.noiseAt);
        if (this.timer <= 0) this._resumePatrol();
        break;
      case 'investigate':
        if (coach.mode === 'idle') {
          if (this.sub === 'go') {
            this.sub = 'look';
            this.timer = 3.0;
            this.sweepBase = coach.mesh.rotation.y;
          } else {
            this.timer -= dt;
            this._sweep(1.3, 1.1);
            if (this.timer <= 0) this._resumePatrol();
          }
        }
        break;
      case 'chase':
        this._updateChase(dt);
        return;
      case 'search':
        this._updateSearch(dt);
        if (this.state !== 'search') return; // (found you in a locker, or gave up)
        break;
      case 'yank':
        if (coach.mode === 'idle' && this.yankSpot) sys.yankOpen(this.yankSpot, this);
        return;
      default:
        return;
    }

    // ---- Looking and listening -------------------------------------------------
    const sight = sys.sight(this);
    this.visible = sight.visible;
    if (sight.visible) {
      this.lastSeen.set(ppos.x, 0, ppos.z);
      if (this.state === 'search') {
        this._beginChase(); // it was already looking for you
        return;
      }
      if (sight.inBeam || sight.dist < sight.closeRange) {
        this.litUp = sight.inBeam;
        let rate = (0.45 + sight.proximity * 1.9) * 1.8 * (sight.inBeam ? 1 : 0.6);
        if (sys.player.isSprinting) rate *= 1.35;
        if (sys.player.isCrouching) rate *= 0.55;
        this.suspicion = Math.min(1, this.suspicion + rate * dt);
        if (this.suspicion >= 1) {
          this._beginChase();
          return;
        }
      }
      this._investigate(this.lastSeen); // "?": go take a look (keeping the light on you)
      return;
    }
    this.suspicion = Math.max(0, this.suspicion - 0.35 * dt);

    const dist = Math.hypot(ppos.x - coach.position.x, ppos.z - coach.position.z);
    if (!sys.playerHidden && sys.hears(dist)) {
      this.noiseAt.set(ppos.x, 0, ppos.z);
      if (this.state === 'patrol' || this.state === 'pause' || this.state === 'peek') this._enterHeard();
      else if (this.state === 'heard') this._investigate(this.noiseAt); // still hearing you: come and look
      else if (this.state === 'search') this._refocusSearch(this.noiseAt); // there you are: the search moves over
    }
  }

  _updateChase(dt) {
    const sys = this.sys;
    const ppos = sys.player.object.position;
    const cpos = this.coach.position;
    const inSight = sys.pursuitSight(this);
    this.visible = inSight;
    if (inSight) {
      this.lastSeen.set(ppos.x, 0, ppos.z);
      this.target.copy(this.lastSeen);
      this.lostT = 0;
      this.alertRun = false;
    } else {
      this.target.copy(this.lastSeen);
      const atSpot = Math.hypot(this.lastSeen.x - cpos.x, this.lastSeen.z - cpos.z) < 2;
      if (!this.alertRun || atSpot) this.lostT += dt;
      if (this.lostT > HUNTER.loseSight) {
        this._enterSearch();
        return;
      }
    }
    this._updateChaseMove(dt);
    const d = Math.hypot(ppos.x - cpos.x, ppos.z - cpos.z);
    if (d < HUNTER.catchRadius && !sys.playerHidden) sys.capture(this);
  }

  /** An ELDAR's siren: run straight to where it's holding you. */
  alert(pos) {
    if (this.state === 'yank') return;
    this.lastSeen.set(pos.x, 0, pos.z);
    this._beginChase();
    this.alertRun = true;
  }

  /** It saw you climb in: run over and tear the thing open. */
  yank(spot) {
    this.state = 'yank';
    this.yankSpot = spot;
    this.suspicion = 1;
    this.coach.turnRate = 8;
    this.coach.faceTowards(spot.group.position);
    this._moveTo(spot.front.x, spot.front.z, this._speed('chase'));
  }

  _beginChase() {
    const first = this.state !== 'chase';
    this.state = 'chase';
    this.suspicion = 1;
    this.lostT = 0;
    this.target.copy(this.lastSeen);
    this.coach.turnRate = 8;
    this.coach.faceTowards(null);
    this.repathT = 0; // (picks straight-at-you or around-the-cover next frame)
    if (first) this.sys.onChaseStart(this);
  }

  _enterSearch() {
    this.state = 'search';
    this.sub = 'go';
    this.suspicion = 0.5;
    this.alertRun = false;
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this._moveTo(this.lastSeen.x, this.lastSeen.z, this._speed('search'));
    if (this.sys.onSearchStart) this.sys.onSearchStart(this);
  }

  /** It heard you mid-search: the whole search moves over to the noise (at most every few seconds). */
  _refocusSearch(at) {
    if (this.sub === 'check' || this.sys.time - this._refocusAt < 3) return;
    if ((at.x - this.lastSeen.x) ** 2 + (at.z - this.lastSeen.z) ** 2 < 9) return; // (already searching right there)
    this._refocusAt = this.sys.time;
    this.lastSeen.set(at.x, 0, at.z);
    this.sub = 'go';
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this._moveTo(at.x, at.z, this._speed('search'));
  }

  /**
   * The search, step by step: walk to the spot ('go'), stop dead ('halt'), a hard look
   * left and right ('inspect'), the lockers right there (indoors, 'check'), then a sweep of
   * the cover and corners around it ('sweep') and one last look ('look') before giving up.
   */
  _updateSearch(dt) {
    const coach = this.coach;
    switch (this.sub) {
      case 'go':
        if (coach.mode === 'idle') {
          this.sub = 'halt';
          this.timer = SEARCH.halt;
          this.sweepBase = coach.mesh.rotation.y;
          coach.faceTowards(null);
        }
        break;
      case 'halt':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.sub = 'inspect';
          this._inspect = 0;
          this.timer = SEARCH.inspectHold;
          this._faceYaw(this.sweepBase + SEARCH.inspectAngle); // left...
        }
        break;
      case 'inspect':
        this.timer -= dt;
        if (this.timer <= 0) {
          this._inspect++;
          if (this._inspect === 1) {
            this.timer = SEARCH.inspectHold + 0.2;
            this._faceYaw(this.sweepBase - SEARCH.inspectAngle); // ...and right
          } else {
            // Indoors he yanks open the lockers right where he lost you first.
            const checks = this.sys.lockersNear ? this.sys.lockersNear(this.lastSeen) : [];
            if (checks.length) {
              this.sub = 'check';
              this._checks = checks;
              this._goCheck();
            } else {
              this._beginSweep();
            }
          }
        }
        break;
      case 'check':
        this._updateChecks(dt);
        break;
      case 'sweep':
        this._updateSweep(dt);
        break;
      default: // 'look': one last look around, then back to its rounds
        this.timer -= dt;
        this._sweep(1.4, 1.35);
        if (this.timer <= 0) this._resumePatrol();
        break;
    }
  }

  /** Turn (standing) to face `yaw`. */
  _faceYaw(yaw) {
    const c = this.coach.position;
    this._look.set(c.x + Math.sin(yaw) * 5, 0, c.z + Math.cos(yaw) * 5);
    this.coach.faceTowards(this._look);
  }

  /** Sweep the area: the likeliest hiding places within ~9m of where it lost you, nearest first. */
  _beginSweep() {
    this.sub = 'sweep';
    this._sweepT = rand(SEARCH.sweep[0], SEARCH.sweep[1]);
    this._sweepPts = this.sys.searchPoints ? this.sys.searchPoints(this.lastSeen, this.coach.position, SEARCH.points) : [];
    this._nextSweepPoint();
  }

  _nextSweepPoint() {
    const p = this._sweepT > 0 ? this._sweepPts.shift() : null;
    if (!p) {
      this.sub = 'look';
      this.timer = SEARCH.finalLook;
      this.sweepBase = this.coach.mesh.rotation.y;
      return;
    }
    this._sweepLook = 0;
    this.coach.faceTowards(null);
    this._moveTo(p.x, p.z, this._speed('search') * 0.85);
  }

  _updateSweep(dt) {
    this._sweepT -= dt;
    if (this._sweepLook > 0) {
      // At a corner: a quick, sharp look around it.
      this._sweepLook -= dt;
      this._sweep(2.1, 1.25);
      if (this._sweepLook <= 0) this._nextSweepPoint();
    } else if (this.coach.mode === 'idle' || this._sweepT < -4) {
      if (this.coach.mode !== 'idle') this.coach.stop(); // (wedged somewhere: look from here)
      this._sweepLook = rand(SEARCH.cornerLook[0], SEARCH.cornerLook[1]);
      this.sweepBase = this.coach.mesh.rotation.y;
    }
  }

  // ---- Locker room rounds: a look down every side turning -------------------------------

  /** Walking its rounds past a side turning (an aisle, the alcove, a shower stall): stop and look down it. */
  _checkPeek() {
    const peeks = this.sys.peeks;
    if (!peeks) return;
    const coach = this.coach;
    const c = coach.position;
    const ry = coach.mesh.rotation.y;
    const wp = this.route[this.waypoint];
    for (const pk of peeks) {
      if ((pk.x - c.x) ** 2 + (pk.z - c.z) ** 2 > 0.5 * 0.5) continue; // (square in the mouth of it)
      if (this.sys.time - (this._peekedAt.get(pk) ?? -99) < PEEK_REPEAT) continue;
      if (Math.abs(Math.sin(ry) * Math.sin(pk.yaw) + Math.cos(ry) * Math.cos(pk.yaw)) > 0.55) continue; // (only square to the way he's going)
      if ((wp.x - pk.x) ** 2 + (wp.z - pk.z) ** 2 < 2.25) continue; // (about to stop there anyway)
      this._peekedAt.set(pk, this.sys.time);
      this.state = 'peek';
      this._peek = { yaw: pk.yaw, t: 0, hold: pk.hold ?? rand(1.2, 1.7) };
      coach.stop();
      coach.turnRate = 6.5;
      this._faceYaw(pk.yaw);
      return;
    }
  }

  _updatePeek(dt) {
    const pk = this._peek;
    pk.t += dt;
    if (pk.t < pk.hold) return;
    // Nothing down there: on along the spine to the stop it was heading for.
    this._peek = null;
    this.state = 'patrol';
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    const wp = this.route[this.waypoint];
    this._moveTo(wp.x, wp.z, this._speed('patrol'));
  }

  /** Walk up to the next locker to check. */
  _goCheck() {
    const spot = this._checks[0];
    this._checkT = -1;
    this._opened = false;
    this.coach.faceTowards(null);
    this._moveTo(spot.front.x, spot.front.z, this._speed('search'));
  }

  /** At each locker: face it, yank it open (you're caught if you're in it), then the next. */
  _updateChecks(dt) {
    const spot = this._checks[0];
    if (this._checkT < 0) {
      if (this.coach.mode === 'idle') {
        this._checkT = 0;
        this.coach.faceTowards(spot.group.position);
      }
      return;
    }
    this._checkT += dt;
    if (this._checkT > 0.4 && !this._opened) {
      this._opened = true;
      if (this.sys.checkLocker(spot, this)) return;
    }
    if (this._checkT > 1.5) {
      this._checks.shift();
      if (this._checks.length) this._goCheck();
      else this._beginSweep(); // (not in there: now the rest of the area)
    }
  }

  _enterHeard() {
    this.state = 'heard';
    this.timer = HUNTER.loseSight + 0.2;
    this.coach.stop();
    this.coach.faceTowards(null);
    this.coach.turnRate = 2.2; // turns slowly toward the sound: a moment to slip away
  }

  _investigate(target) {
    const cpos = this.coach.position;
    const fresh = this.state !== 'investigate' || this.sub !== 'go';
    if (this.state !== 'investigate') {
      this.state = 'investigate';
      this.coach.turnRate = 5;
      this.coach.faceTowards(null);
    }
    // (Called every frame while it can see you: re-plan only when you've moved, a few times a second.)
    const moved = (this.target.x - target.x) ** 2 + (this.target.z - target.z) ** 2 > 1.5;
    if (!fresh && !moved && this.sys.time - this._investAt < 0.5) return;
    this._investAt = this.sys.time;
    this.sub = 'go';
    this.target.set(target.x, 0, target.z);
    const dx = target.x - cpos.x;
    const dz = target.z - cpos.z;
    const d = Math.hypot(dx, dz);
    if (d > 2.8) {
      const k = (d - 2.5) / d; // stop a little short (not inside the cover you're behind)
      this._moveTo(cpos.x + dx * k, cpos.z + dz * k, this._speed('investigate'));
    } else if (this.coach.mode !== 'idle') {
      this.coach.stop();
    }
  }

  _enterPause(seconds) {
    this.state = 'pause';
    this.timer = seconds;
    this.sweepBase = this.coach.mesh.rotation.y;
  }

  /** Swing body and light left and right around sweepBase. */
  _sweep(rate, amplitude) {
    const cpos = this.coach.position;
    const yaw = this.sweepBase + Math.sin(this.sys.time * rate + this._time) * amplitude;
    this._look.set(cpos.x + Math.sin(yaw) * 5, 0, cpos.z + Math.cos(yaw) * 5);
    this.coach.faceTowards(this._look);
  }

  _advance() {
    this.waypoint = (this.waypoint + 1) % this.route.length;
    const wp = this.route[this.waypoint];
    this.coach.faceTowards(null);
    this._moveTo(wp.x, wp.z, this._speed('patrol'));
    this.state = 'patrol';
  }

  _resumePatrol() {
    const cpos = this.coach.position;
    let nearest = 0;
    let best = Infinity;
    this.route.forEach((wp, i) => {
      const d = (wp.x - cpos.x) ** 2 + (wp.z - cpos.z) ** 2;
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    this.waypoint = nearest;
    this.suspicion = 0;
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this._moveTo(this.route[nearest].x, this.route[nearest].z, this._speed('patrol'));
    this.state = 'patrol';
  }

  _updateAim(dt) {
    const cpos = this.coach.position;
    const ry = this.coach.mesh.rotation.y;
    const t = this.sys.time + this._time;
    let desired;
    if (this.state === 'chase' || this.state === 'investigate' || (this.state === 'search' && this.sub === 'go')) {
      const tx = this.state === 'search' ? this.lastSeen : this.target;
      desired = Math.hypot(tx.x - cpos.x, tx.z - cpos.z) > 0.5 ? Math.atan2(tx.x - cpos.x, tx.z - cpos.z) : ry;
    } else if (this.state === 'yank' && this.yankSpot) {
      desired = Math.atan2(this.yankSpot.group.position.x - cpos.x, this.yankSpot.group.position.z - cpos.z);
    } else if (this.state === 'search' && this.sub === 'check' && this._checks && this._checks.length) {
      const g = this._checks[0].group.position;
      desired = Math.atan2(g.x - cpos.x, g.z - cpos.z);
    } else if (this.state === 'peek' && this._peek) {
      desired = this._peek.yaw + Math.sin(t * 1.7) * 0.22; // the light probes down the turning (the rows, the alcove, a stall)
    } else if (this.state === 'heard' || (this.state === 'search' && (this.sub === 'halt' || this.sub === 'inspect'))) {
      desired = ry;
    } else if (this.state === 'pause' || this.state === 'search') {
      desired = ry + Math.sin(t * 1.3) * 0.35;
    } else {
      desired = ry + Math.sin(t * 0.8) * 0.28;
    }
    this.aimYaw = dampAngle(this.aimYaw, desired, Math.min(1, dt * 6));
  }

  _updateFlashlight() {
    if (!this.beam.visible) return;
    this.prop.getWorldPosition(this._lightPos);
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    this.light.position.copy(this._lightPos);
    this.lightTarget.position.set(this._lightPos.x + fx * 10, 0.2, this._lightPos.z + fz * 10);
    this.lightTarget.updateMatrixWorld();
    this.beam.position.copy(this._lightPos);
    this.beam.lookAt(this.lightTarget.position);
    // Glare grows sharply as the beam swings toward the camera.
    this._toCam.subVectors(this.sys.camera.position, this._lightPos);
    this._toCam.y = 0;
    const len = this._toCam.length() || 1;
    const facing = Math.max(0, (this._toCam.x * fx + this._toCam.z * fz) / len);
    const f6 = facing ** 6;
    this.glare.position.copy(this._lightPos);
    this.glare.material.opacity = 0.12 + 0.88 * f6;
    this.glare.scale.setScalar(0.35 + f6 * 1.3);
  }

  _updateMark(dt) {
    let kind = null;
    if (this.state === 'chase' || this.state === 'yank') kind = '!';
    else if (this.litUp || this.state === 'heard' || this.state === 'investigate' || this.state === 'search') kind = '?';
    if (kind !== this.markKind) {
      this.markKind = kind;
      this.markPop = 0;
      if (kind) {
        this.mark.material.map = kind === '!' ? this.sys.alertTex : this.sys.questionTex;
        this.mark.material.needsUpdate = true;
      }
    }
    this.mark.visible = kind !== null && this.coach.mesh.visible;
    if (!this.mark.visible) return;
    this.markPop = Math.min(1, this.markPop + dt / 0.25);
    const s = 0.6 * Math.max(0.01, easeOutBack(this.markPop));
    const cpos = this.coach.position;
    this.mark.scale.set(s, s, 1);
    this.mark.position.set(cpos.x, this.coach.mesh.userData.headHeight + 0.65 + Math.sin(this.sys.time * 4) * 0.05, cpos.z);
  }
}

// ---------------------------------------------------------------------------
// An ELDAR sentry: paces a choke point, grabs you if it touches you
// ---------------------------------------------------------------------------

const SENTRY_GLOW_CALM = new THREE.Color(0.75, 0.12, 0.08);
const SENTRY_GLOW_HOT = new THREE.Color(1.0, 0.3, 0.2);
const GRAB_STATES = new Set(['patrol', 'pause', 'return', 'lunge', 'alert']); // (not while stunned or walking out)

class Sentry {
  constructor(sys, def, index) {
    this.sys = sys;
    this.index = index;
    this.stats = { ...SENTRY, ...(def.stats || {}) };
    const built = createEldarRig(sys.eldarMats, {});
    this.root = built.root;
    this.rig = built.rig;
    this.glow = built.glow;
    this.mesh = this.root; // (the player collides with .mesh / .radius)
    this.radius = 0.38;
    sys.scene.add(this.root);
    // A beat between two points, or (the locker room's scouts) a loop of them.
    this.points = null;
    this.pi = 0;
    this.a = new THREE.Vector3(def.a ? def.a[0] : 0, 0, def.a ? def.a[1] : 0);
    this.b = new THREE.Vector3(def.b ? def.b[0] : 0, 0, def.b ? def.b[1] : 0);
    if (def.route) this.setRoute(def.route);
    this.goal = this.b;
    // Red scan cone out of the visor (no real light: they'd cost every shader a light each).
    this.cone = new THREE.Mesh(sys.beamGeometry, sys.sentryBeamMat);
    const len = this.stats.sight / V.beamLength;
    const wide = (Math.tan(this.stats.halfAngle) * this.stats.sight) / (Math.tan(V.beamHalfAngle) * V.beamLength);
    this.cone.scale.set(wide, wide * 0.55, len);
    this.cone.position.set(0, 0.17, 0.1);
    this.cone.rotation.x = 0.16;
    this.cone.frustumCulled = false;
    this.rig.neck.add(this.cone);
    this.anim = { speed: 0, aim: 0, crouch: 0, air: 0, kneel: 0, reach: 0, flinch: 0, roar: 0 };
    this.state = 'idle'; // idle | walk | patrol | pause | alert | lunge | grab | stunned | return
    this.thinking = false;
    this.t = 0;
    this.timer = 0;
    this.scan = 0;
    this.scanT = Math.random() * 10;
    this.cooldown = 0;
    this.lostT = 0;
    this.sightT = 0;
    this.hasSight = false;
    this.moveSpeed = 0;
    this.yaw = 0;
    this.servoT = rand(1, 3);
    this.path = null;
    this._eye = new THREE.Vector3();
    this._walkTo = new THREE.Vector3();
  }

  get position() {
    return this.root.position;
  }

  /** Patrol a loop of [x, z] points instead of a two-point beat. */
  setRoute(route) {
    this.points = route.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.pi = 0;
    this.a = this.points[0];
    this.b = this.points[1];
  }

  place(x, z, yaw) {
    this.root.position.set(x, 0, z);
    this.yaw = yaw;
    this.state = 'idle';
    this.cooldown = 0;
    this.anim.reach = 0;
    this.anim.kneel = 0;
    this.scan = 0;
  }

  /** Walk out to its choke point (scripted), then start pacing. */
  deploy() {
    this._walkTo.copy(this.a);
    this.path = null;
    this.state = 'walk';
  }

  /** Straight onto its beat (retries): at whichever end is farther from `awayFrom` (your respawn point). */
  reset(awayFrom = null) {
    if (this.points) {
      // A loop: start at the point farthest from you, heading for the next one.
      let far = 0;
      let best = -1;
      this.points.forEach((p, i) => {
        const d = awayFrom ? awayFrom.distanceToSquared(p) : 0;
        if (d > best) {
          best = d;
          far = i;
        }
      });
      const p = this.points[far];
      this.pi = (far + 1) % this.points.length;
      const next = this.points[this.pi];
      this.place(p.x, p.z, Math.atan2(next.x - p.x, next.z - p.z));
      this.goal = next;
      this.path = null;
      this.state = 'patrol';
      return;
    }
    let from = this.a;
    let to = this.b;
    if (awayFrom && awayFrom.distanceToSquared(this.b) > awayFrom.distanceToSquared(this.a)) {
      from = this.b;
      to = this.a;
    }
    this.place(from.x, from.z, Math.atan2(to.x - from.x, to.z - from.z));
    this.goal = to;
    this.path = null;
    this.state = 'patrol';
  }

  update(dt) {
    this.t += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const sys = this.sys;
    const pos = this.root.position;
    const pp = sys.player.object.position;
    const dist = Math.hypot(pp.x - pos.x, pp.z - pos.z);
    let scanAmp = 0.35;
    this.moveSpeed = 0;
    const st = this.stats;
    switch (this.state) {
      case 'walk':
        if (this._travel(this._walkTo, st.patrol + 0.8, dt)) {
          this.goal = this.b;
          this.pi = 1;
          this.path = null;
          this.state = 'patrol';
        }
        break;
      case 'patrol':
        // (A loop through the locker room goes around the banks; a grounds beat is a straight line.)
        if (this.points ? this._travel(this.goal, st.patrol, dt) : this._step(this.goal, st.patrol, dt)) {
          this.state = 'pause';
          this.timer = this.points ? rand(0.6, 1.3) : rand(1.2, 2.2);
        }
        break;
      case 'pause':
        scanAmp = 0.75;
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.points) {
            this.pi = (this.pi + 1) % this.points.length;
            this.goal = this.points[this.pi];
            this.path = null;
          } else {
            this.goal = this.goal === this.a ? this.b : this.a;
          }
          this.state = 'patrol';
        }
        break;
      case 'alert': // locked on: visor flares, a chirp, then it comes for you
        this.timer -= dt;
        this._faceToward(pp, dt, 10);
        scanAmp = 0;
        if (this.timer <= 0) {
          this.state = 'lunge';
          this.timer = st.lungeTime;
          this.lostT = 0;
        }
        break;
      case 'lunge':
        scanAmp = 0;
        this.timer -= dt;
        this._updateSight(dt);
        if (this.hasSight) this.lostT = 0;
        else this.lostT += dt;
        this._step(pp, st.lunge, dt);
        if (this.lostT > 1.5 || this.timer <= 0 || sys.playerHidden) {
          // You got away from it (out of sight, or into hiding): it reports you.
          if ((this.lostT > 1.5 || sys.playerHidden) && sys.onSentryLost) sys.onSentryLost(this);
          this._return();
        }
        break;
      case 'grab':
        scanAmp = 0;
        this._faceToward(pp, dt, 12);
        break;
      case 'stunned':
        scanAmp = 0;
        this.timer -= dt;
        if (Math.random() < dt * 8) {
          this.rig.torso.getWorldPosition(_v1);
          _v1.y += 0.3;
          sys.spark(_v1);
        }
        if (this.timer <= 0) {
          this.anim.kneel = 0;
          this._return();
        }
        break;
      case 'return':
        if (this._travel(this._walkTo, st.patrol + 0.4, dt)) {
          this.state = 'patrol';
          this.path = null;
        }
        break;
      default:
        break;
    }

    // Senses: sight (a narrow visor cone), and touch.
    if (this.thinking && !sys.playerHidden && this.cooldown <= 0 && !sys.grab) {
      if ((this.state === 'patrol' || this.state === 'pause' || this.state === 'return') && dist < st.sight * 1.7) {
        this._updateSight(dt);
        if (this.hasSight) this._alert();
      }
      if (dist < st.grabRadius && GRAB_STATES.has(this.state)) sys.startGrab(this);
    }

    // Head scan, visor, pose.
    this.scanT += dt;
    this.scan += (Math.sin(this.scanT * 1.1) * scanAmp - this.scan) * Math.min(1, dt * 4);
    const hot = this.state === 'alert' || this.state === 'lunge' || this.state === 'grab';
    const flicker = this.state === 'stunned' ? (Math.random() < 0.5 ? 0.15 : 1) : 1;
    const pulse = hot ? 0.75 + 0.25 * Math.sin(this.t * 22) : 1;
    this.glow.color.copy(hot ? SENTRY_GLOW_HOT : SENTRY_GLOW_CALM).multiplyScalar(pulse * flicker);
    this.cone.visible = this.state !== 'stunned' && this.state !== 'grab';
    this.anim.speed = this.moveSpeed;
    this.anim.aim += ((hot ? 0.5 : 0) - this.anim.aim) * Math.min(1, dt * 5);
    this.anim.reach += ((this.state === 'grab' ? 1 : this.state === 'lunge' ? 0.55 : 0) - this.anim.reach) * Math.min(1, dt * 8);
    animateEldar(this.rig, dt, this.anim);
    this.rig.neck.rotation.y = this.scan;
    this.root.rotation.y = this.yaw;

    // Servos whir as it turns its head, if you're close enough to hear.
    this.servoT -= dt;
    if (this.servoT <= 0) {
      this.servoT = rand(1.8, 3.2);
      if (dist < 9 && this.state !== 'stunned') playServo(1 - dist / 9);
    }
  }

  /** Walk to `target` along a path around the cover; true on arrival. */
  _travel(target, speed, dt) {
    if (!this.path) this.path = this.sys.nav.path(this.root.position, target) || [target.clone()];
    if (!this.path.length) {
      this.path = null;
      return true;
    }
    if (this._step(this.path[0], speed, dt)) this.path.shift();
    if (!this.path.length) {
      this.path = null;
      return true;
    }
    return false;
  }

  /** Walk toward `target`; true on arrival. */
  _step(target, speed, dt) {
    const pos = this.root.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3) return true;
    const step = Math.min(d, speed * dt);
    pos.x += (dx / d) * step;
    pos.z += (dz / d) * step;
    this.moveSpeed = speed;
    this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), Math.min(1, dt * 7));
    this.sys.pushOut(pos, this.radius);
    return false;
  }

  _faceToward(p, dt, rate) {
    const pos = this.root.position;
    this.yaw = dampAngle(this.yaw, Math.atan2(p.x - pos.x, p.z - pos.z), 1 - Math.exp(-dt * rate));
  }

  _updateSight(dt) {
    this.sightT -= dt;
    if (this.sightT > 0) return;
    this.sightT = 0.15;
    this.hasSight = this.sys.sentrySees(this);
  }

  eye() {
    this.rig.neck.getWorldPosition(this._eye);
    this._eye.y += 0.17;
    return this._eye;
  }

  _alert() {
    this.state = 'alert';
    this.timer = 0.4;
    playRobotCharge(1.3);
    this.sys.onSentryAlert(this);
  }

  _return() {
    const pos = this.root.position;
    if (this.points) {
      // Back onto its loop at the nearest point.
      let best = Infinity;
      this.points.forEach((p, i) => {
        const d = pos.distanceToSquared(p);
        if (d < best) {
          best = d;
          this.pi = i;
        }
      });
      this._walkTo.copy(this.points[this.pi]);
      this.goal = this.points[this.pi];
      this.path = null;
      this.state = 'return';
      return;
    }
    // Back to whichever end of its beat is closer.
    const nearA = pos.distanceToSquared(this.a) < pos.distanceToSquared(this.b);
    this._walkTo.copy(nearA ? this.a : this.b);
    this.goal = nearA ? this.b : this.a;
    this.path = null;
    this.state = 'return';
  }

  grabbed() {
    this.state = 'grab';
  }

  /** Shaken off: sparks, a few seconds on one knee, then a while before it can grab again. */
  stun() {
    this.state = 'stunned';
    this.timer = SENTRY.stun;
    this.cooldown = SENTRY.stun + SENTRY.cooldown;
    this.anim.kneel = 0.6;
  }
}

// ---------------------------------------------------------------------------
// HUD bits: the mash prompt, the hiding crack, the CAUGHT card, the flashlight warning
// ---------------------------------------------------------------------------

function buildHud() {
  const hud = document.getElementById('hud');
  const mash = document.createElement('div');
  mash.id = 'ch3-mash';
  mash.className = 'hidden';
  mash.innerHTML = '<div class="ch3-mash-text"></div><div class="bar"><div></div></div>';
  hud.appendChild(mash);
  const hide = document.createElement('div');
  hide.id = 'ch3-hide';
  hide.innerHTML = '<div class="ch3-hide-label">HIDDEN &middot; [E] STEP OUT</div>';
  document.body.appendChild(hide);
  const caught = document.createElement('div');
  caught.id = 'ch3-caught';
  caught.innerHTML = '<b>CAUGHT</b><span></span>';
  document.body.appendChild(caught);
  const warning = document.createElement('div');
  warning.className = 'ch3-warning hidden';
  warning.textContent = '[WARNING] Flashlight makes you 2x easier to spot!';
  hud.appendChild(warning);
  const bounds = document.createElement('div');
  bounds.id = 'ch3-bounds';
  bounds.textContent = "[WARNING] You can't abandon Ben!";
  hud.appendChild(bounds);
  return {
    bounds,
    mash,
    mashText: mash.querySelector('.ch3-mash-text'),
    mashFill: mash.querySelector('.bar div'),
    hide,
    caught,
    caughtSub: caught.querySelector('span'),
    warning,
  };
}

/** "CHAPTER 3 · LIGHTS OUT / Back on the surface... / 2:41 AM" over black. */
function createChapterCard(fromChapter2) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:16;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:18px;pointer-events:none;font-family:"Courier New",Courier,monospace;text-align:center;color:#d9dee3;';
  const line = (text, css) => {
    const div = document.createElement('div');
    div.textContent = text;
    div.style.cssText = `${css}opacity:0;transition:opacity 1.1s ease;`;
    el.appendChild(div);
    return div;
  };
  const done = fromChapter2 ? line('CHAPTER 2 COMPLETE', 'font-size:30px;letter-spacing:10px;color:#b3413b;position:absolute;') : null;
  const chapter = line('CHAPTER 3 · LIGHTS OUT', 'font-size:13px;letter-spacing:6px;color:#b3413b;');
  const later = line('Back on the surface... Hall High School', 'font-size:22px;letter-spacing:3px;font-style:italic;');
  const clock = line('2:41 AM', 'font-size:46px;letter-spacing:12px;');
  document.body.appendChild(el);
  return {
    async play(wait) {
      el.getBoundingClientRect(); // commit opacity 0 so the fades run
      if (done) {
        done.style.opacity = '1';
        await wait(2.6);
        done.style.opacity = '0';
        await wait(1.2);
      }
      chapter.style.opacity = '1';
      await wait(0.9);
      later.style.opacity = '1';
      await wait(1.6);
      clock.style.opacity = '1';
      await wait(2.2);
      el.style.transition = 'opacity 1s ease';
      el.style.opacity = '0';
      await wait(1.0);
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Chapter 3 controller
// ---------------------------------------------------------------------------

export class Chapter3 {
  /**
   * @param {object} ctx - renderer, camera, player, world, director, stealth, dialogue, wait,
   *   chapter2 (its surface flashlight / combat HUD get tidied away), and ui:
   *   { setObjective, hideObjective, showMessage, setPrompt, setNight, setFlashlight, setScene,
   *     unloadOutdoors, onPartComplete }
   */
  constructor({ renderer, camera, player, world, director, stealth, dialogue, wait, chapter2, ui }) {
    Object.assign(this, { renderer, camera, player, world, director, stealth, dialogue, wait, chapter2, ui });
    this.phase = 'inactive'; // card | opening | sneak | caught | infiltrate | lockers
    this.location = 'none'; // grounds | lockers
    this.cutscene = false;
    this.time = 0;
    this.built = false;
    this.hunters = [];
    this.sentries = [];
    this.spots = [];
    this.hiding = null; // { spot, t, beat }
    this.grab = null; // { sentry, taps, t }
    this.checkpoint = 0;
    this.carGone = false;
    this.lockers = null;
    this._occluderBoxes = [];
    this._colliderBoxes = [];
    this._ray = new THREE.Ray();
    this._hit = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._sight = { visible: false, inBeam: false, dist: 0, proximity: 0, closeRange: 0 };
    this._boundaryWalls = [];
    this._boundsWarnT = 0;
    this._emerging = null;
    this._doorSwing = null;
    this._hudLabel = '';
    this._hudWidth = -1;
    this._heartT = 0;
    // The locker room (part 2) and the gym (chapter3_gym.js).
    this.billing = null; // his Hunter
    this.tom = null;
    this.hale = null;
    this.lockerCrew = []; // all three locker room coaches (updated every frame, parked or not)
    this.startCrew = []; // who walks the room from the start (Billing; + Tom on Hard Mode)
    this.backup = null; // who the alert calls in (Tom; Hale on Hard Mode)
    this.peeks = null; // the locker room's side turnings (see LOCKER_PEEKS)
    this.scouts = []; // the two ELDAR sentries
    this.alarm = null;
    this.lockerToken = 0;
    this.gym = null;
    this._lockersUsed = new Set(); // (achievements) which lockers you've hidden in
    this._hideKinds = new Set(); // ...and which kinds of hiding spot

    // Mash to escape a grab: [SPACE] or any mouse button.
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.grab) {
        e.preventDefault();
        if (!e.repeat) this._tap();
      }
    });
    document.addEventListener('mousedown', () => {
      if (this.grab) this._tap();
    });
  }

  get active() {
    return this.phase !== 'inactive';
  }

  /** Sneaking around (the grounds, or the locker room): hiding, grabs and captures apply. */
  get sneaking() {
    return this.phase === 'sneak' || this.phase === 'lockerSneak';
  }

  /** Any of Chapter 3's cutscenes (the gym's included): letterbox on, no [E] targets. */
  get inCutscene() {
    return this.cutscene || !!(this.gym && this.gym.cutscene);
  }

  get worldScene() {
    return this.world.tree.group.parent;
  }

  /** True while any coach is chasing you, searching for you, or tearing open your hiding spot. */
  get hunted() {
    return this.hunters.some((h) => h.state === 'chase' || h.state === 'search' || h.state === 'yank');
  }

  get playerHidden() {
    return !!this.hiding;
  }

  // ---- Start ---------------------------------------------------------------------

  async start({ fromChapter2 = false } = {}) {
    this.phase = 'card';
    this.cutscene = true;
    this.director.fader.set(1);
    this.player.setInputLocked(true);
    const card = createChapterCard(fromChapter2);
    this._prepareGrounds();
    // Build every shader now (new props, sentries, the third coach, "?" marks, sparks).
    this._prewarm(true);
    this.renderer.compile(this.worldScene, this.camera);
    this._prewarm(false);
    await card.play(this.wait);
    await this._playOpening();
  }

  /** Set the grounds up for 2:40 AM (whichever way you got here) and build Chapter 3's cast + props. */
  _prepareGrounds() {
    const { world, stealth, player, director, camera, ui } = this;
    const scene = this.worldScene;
    this.scene = scene;
    this.location = 'grounds';
    ui.setScene(scene); // (back up from the lab: the camera and marker come with it)
    setUnderground(false);
    ui.setNight({ fog: 0.012, hemi: 0.52, sun: 0.24, ambient: 0.06 }); // more moonlight: you need to read the field
    world.rain.exposureOverride = null;
    document.getElementById('hud').classList.remove('hidden');
    ui.hideObjective();
    if (this.chapter2) {
      this.chapter2.cutscene = false; // (its ending scene hands straight over to us)
      if (this.chapter2.surfaceLight) this.chapter2.surfaceLight.setOn(false);
      if (this.chapter2.combat) this.chapter2.combat.hud.show(false);
      this.chapter2.location = 'none';
    }

    // Chapter 1's stealth system and cast stand down; Chapter 3 borrows the coaches' flashlights.
    stealth.stop();
    stealth.guards.forEach((g) => {
      g.takeover();
      g.lightOff();
      g.aimOverride = null;
      g.mark.visible = false;
    });
    const { coach, coachLage, coachTom, ben, runners, students } = world.npcs;
    [...runners, ...students].forEach((npc) => {
      npc.cancelExit = true;
      npc.stop();
      npc.faceTowards(null);
      npc.mesh.visible = false;
    });
    [coach, coachLage, coachTom, ben].forEach((npc) => {
      npc.cancelExit = true;
      npc.stop();
      npc.faceTowards(null);
      const rig = npc.mesh.userData.rig;
      if (rig.seated) {
        rig.seated = false;
        npc.mesh.userData.headHeight += 0.36 * npc.mesh.scale.y;
      }
      rig.crouch = false;
      rig.pointing = false;
      npc.mesh.visible = true;
    });

    // The main doors start shut; the grounds' props, the cast and the car get staged.
    world.doors.rear.opened = false;
    world.doors.rear.npcHold = 0;
    this._openTreeDoor();
    if (!this.built) this._build();
    this._stageCar(true);
    this._stageHuddle();
    this._rebuildBoxes();

    // Colliders (plus the edge of the grounds), [E] targets, solid characters.
    this._setGroundColliders();
    player.setInteractables(this._interactables());
    player.setCharacters([...this.hunters.map((h) => h.coach), ...this.sentries]);
    ui.setFlashlight(false);
    director.camMove = null;
    director.zoom = null;
    camera.fov = 75;
    camera.updateProjectionMatrix();
    player.crouching = false;
    player.movementFrozen = false;
    player.clearStumble();
    player.setLookTarget(null);
    player.setCameraOverride(true);
    this.checkpoint = 0;
    this.carGone = false;
  }

  _prewarm(on) {
    for (const h of this.hunters) h.mark.visible = on;
    this.sparks[0].sprite.visible = on;
  }

  /** The hatch in the oak, still open from when you went down. */
  _openTreeDoor() {
    const td = this.director.treeDoor;
    td.anim = null;
    td.panelPivot.rotation.y = td.OPEN_ROT;
    td.light.intensity = 7;
    td.seamMat.color.setRGB(1, 0.22, 0.1);
  }

  /** Chapter 3's cast (the third coach, seven sentries) and props (hiding spots), built once. */
  _build() {
    this.built = true;
    const { world, stealth, scene } = this;
    this.questionTex = createMarkTexture('?', '#ffd21f');
    this.alertTex = createMarkTexture('!', '#ff4a3a');
    this.beamGeometry = createBeamGeometry();
    this.sentryBeamMat = createBeamMaterial();
    this.sentryBeamMat.uniforms.uColor.value.set(0xff2a1a);
    this.sentryBeamMat.uniforms.uIntensity.value = 0.14;
    this.eldarMats = createEldarMaterials();
    this.nav = new NavGrid({ minX: -64, maxX: 64, minZ: -128, maxZ: -8, cell: 0.8, inflate: 0.45 });

    // Coach Hale, the third assistant coach. He carries Coach Billing's flashlight
    // (Billing's staying indoors), so the grounds keep the same number of lights.
    const haleMesh = createHumanoid(HALE_LOOK);
    haleMesh.name = 'coach-hale';
    scene.add(haleMesh);
    this.hale = new Character(haleMesh, { radius: 0.4, name: 'Coach Hale' });
    const haleProp = new THREE.Group();
    haleProp.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.24, 8), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.4 })));
    const haleLens = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    haleLens.position.y = -0.121;
    haleLens.rotation.x = Math.PI / 2;
    haleProp.add(haleLens);
    haleProp.position.y = -0.06;
    haleMesh.userData.rig.handR.add(haleProp);

    const parts = (guard, prop, lens) => ({ light: guard.light, lightTarget: guard.lightTarget, beam: guard.beam, glare: guard.glare, prop: prop || guard.prop, lens: lens || guard.lens });
    const characters = { lage: world.npcs.coachLage, tom: world.npcs.coachTom, hale: this.hale };
    const guardParts = {
      lage: parts(stealth.guard('lage')),
      tom: parts(stealth.guard('tom')),
      hale: parts(stealth.guard('billing'), haleProp, haleLens),
    };
    this.hunters = HUNTER_DEFS.map((def) => new Hunter(this, def, characters[def.id], guardParts[def.id]));
    this.sentries = SENTRY_DEFS.map((def, i) => new Sentry(this, def, i));
    this.spots = buildHideProps(scene);
    for (const spot of this.spots) {
      world.colliders.push(spot.body);
      world.stealth.occluders.push(spot.body);
    }
    this.hud = buildHud();

    // Sparks (a stunned sentry): a small pool of sprites.
    const sparkTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 32, 32);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    this.sparks = Array.from({ length: 30 }, () => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkTex, color: 0x9fe8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, vel: new THREE.Vector3(), life: 0 };
    });
    this._spark = 0;

    // The edge of the grounds: invisible walls, only for you (not in world.colliders,
    // so the AI's boxes and nav grid don't see them). Unrendered, like the lab's proxies.
    const B = BOUNDS;
    const wall = (x0, x1, z0, z1) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 4, z1 - z0));
      mesh.position.set((x0 + x1) / 2, 2, (z0 + z1) / 2);
      mesh.name = 'ch3-boundary';
      mesh.updateMatrixWorld(true);
      return mesh;
    };
    this._boundaryWalls = [
      wall(B.minX - 1, B.maxX + 1, B.minZ - 1, B.minZ), // south, behind the oak
      wall(B.minX - 1, B.minX, B.minZ - 1, B.northWest + 1), // west
      wall(B.maxX, B.maxX + 1, B.minZ - 1, B.northEast + 1), // east
      wall(B.minX - 1, -B.schoolHalf + 0.2, B.northWest, B.northWest + 1), // north, west of the school (up to its side wall)
      wall(B.schoolHalf - 0.2, B.maxX + 1, B.northEast, B.northEast + 1), // north, east of the school (the building line)
    ];

    // Colliders changing (the main doors swinging) means new boxes for the AI too.
    const prev = world.events.onCollidersChanged;
    world.events.onCollidersChanged = () => {
      if (prev) prev();
      if (this.location === 'grounds') {
        this._setGroundColliders(); // (main.js just reset them to world.colliders: add the edge back)
        this._rebuildBoxes();
      }
    };
  }

  /** The grounds' solid things for you: the world's, plus the invisible edge. */
  _setGroundColliders() {
    this.player.setColliders([...this.world.colliders, ...this._boundaryWalls]);
  }

  /**
   * Walking into the edge of the grounds: the wall stops you, and a warning
   * says why. (Checked against the way you're pushing, so sliding along it
   * doesn't nag.)
   */
  _updateBounds(dt) {
    const p = this.player;
    this._boundsWarnT = Math.max(0, this._boundsWarnT - dt);
    if (!this.hiding && !p.inputLocked && !p.movementFrozen) {
      const ms = p.moveState;
      const ix = (ms.right ? 1 : 0) - (ms.left ? 1 : 0);
      const iz = (ms.forward ? 1 : 0) - (ms.backward ? 1 : 0);
      if (ix || iz) {
        const yaw = p.getYaw();
        const dx = Math.cos(yaw) * ix - Math.sin(yaw) * iz;
        const dz = -Math.sin(yaw) * ix - Math.cos(yaw) * iz;
        const { x, z } = p.object.position;
        const B = BOUNDS;
        const near = 0.6; // (your radius is 0.35: you're up against it)
        const north = x < -B.schoolHalf ? B.northWest : x > B.schoolHalf ? B.northEast : Infinity;
        const pushing =
          (x < B.minX + near && dx < -0.2) ||
          (x > B.maxX - near && dx > 0.2) ||
          (z < B.minZ + near && dz < -0.2) ||
          (z > north - near && dz > 0.2);
        if (pushing) this._boundsWarnT = 1.8;
      }
    }
    const show = this._boundsWarnT > 0;
    if (show !== this.hud.bounds.classList.contains('show')) this.hud.bounds.classList.toggle('show', show);
  }

  _interactables() {
    if (this.location === 'lockers') return this.lockers.interactables;
    const list = this.spots.map((s) => s.hitbox);
    const door = this.world.lockerRoomDoor.leaf;
    door.userData = { interactable: true, label: 'Enter Locker Room', type: 'ch3-locker-door' };
    list.push(door);
    for (const leaf of this.world.doors.rear.leaves) {
      leaf.userData = { interactable: true, label: 'Main doors (chained shut)', type: 'ch3-locked' };
      list.push(leaf);
    }
    return list;
  }

  /** Your car, parked on the grass by the oak (Ben takes it round front later). */
  _stageCar(show) {
    const { world } = this;
    const car = world.playersCar;
    if (show) {
      car.visible = true;
      car.position.set(CAR_SPOT.x, 0, CAR_SPOT.z);
      car.rotation.set(0, CAR_SPOT.yaw, 0);
      if (!world.colliders.includes(car)) world.colliders.push(car);
      if (!world.stealth.occluders.includes(car)) world.stealth.occluders.push(car);
    } else {
      car.visible = false;
      const ci = world.colliders.indexOf(car);
      if (ci !== -1) world.colliders.splice(ci, 1);
      const oi = world.stealth.occluders.indexOf(car);
      if (oi !== -1) world.stealth.occluders.splice(oi, 1);
    }
    car.updateMatrixWorld(true);
  }

  /** Billing, his three coaches and seven ELDARs in a huddle across the field; Ben underground. */
  _stageHuddle() {
    const { world } = this;
    const billing = world.npcs.coach;
    billing.mesh.position.copy(HUDDLE);
    billing.mesh.rotation.y = Math.PI; // facing the oak
    billing.faceTowards(null);
    for (const h of this.hunters) {
      const [x, z] = h.huddle;
      h.place(x, z, Math.atan2(HUDDLE.x - x, HUDDLE.z - z));
      h.thinking = false;
      h.coach.mesh.visible = true;
      h.lightOn();
    }
    this.sentries.forEach((s, i) => {
      s.place(HUDDLE.x - 4.2 + i * 1.4, HUDDLE.z + 2.4, Math.PI);
      s.thinking = false;
    });
    const ben = world.npcs.ben;
    ben.stop();
    ben.faceTowards(null);
    ben.mesh.visible = false;
    ben.mesh.userData.rig.crouch = false;
  }

  // ---- Opening cutscene ------------------------------------------------------------

  async _playOpening() {
    const { director, dialogue, wait, player, world } = this;
    const ben = world.npcs.ben;
    const billing = world.npcs.coach;
    const treePos = world.tree.group.position;
    this.phase = 'opening';
    this.cutscene = true;
    const huddleLook = new THREE.Vector3(HUDDLE.x, 1.5, HUDDLE.z);

    // Outside the oak, low: the doorway glows red and Ben climbs up out of the dark.
    const outside = director.doorway.clone().sub(treePos).setY(0).normalize();
    const side = new THREE.Vector3(outside.z, 0, -outside.x);
    const extCam = treePos.clone().addScaledVector(outside, 5.4).addScaledVector(side, 2.2).setY(1.15);
    this._place(extCam, director.doorLook);
    director.fader.to(0, 1.6);
    await wait(0.6);
    ben.mesh.visible = true;
    ben.mesh.userData.rig.crouch = true;
    const climbs = (async () => {
      for (let i = 0; i < 4; i++) {
        playLadderStep(0.9 + (i % 2) * 0.12);
        await wait(0.35);
      }
    })();
    await this._emerge(ben, director.doorApproach, 1.5);
    await climbs;
    // He steps aside (you come up right where he's standing).
    const benAside = director.doorApproach.clone().addScaledVector(side, 1.5).addScaledVector(outside, 0.7);
    ben.moveTo(benAside.x, benAside.z, 1.6).then(() => ben.faceTowards(huddleLook));
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await wait(0.9);

    // Your turn: up out of the trunk.
    await director.fader.to(1, 0.2);
    this._place(director.inside.clone().setY(0.35), director.doorway.clone().setY(1.2));
    await director.fader.to(0, 0.25);
    player.setLookTarget(director.doorApproach.clone().setY(1.5));
    await director.moveCamera([director.doorway.clone().setY(1.25), director.doorApproach.clone().setY(1.7)], [0.7, 0.6]);

    // Across the field: flashlights and red visors.
    player.setLookTarget(huddleLook);
    director.zoomTo(26, 2.6);
    await dialogue.say('Other Ben (whispering)', 'Wait. Stop. Look... over by the school.', { style: 'whisper', hold: 1.0 });
    billing.mesh.userData.rig.pointing = true;
    await dialogue.say('Coach Billing (far off)', 'Search the grounds! Do not let those boys leave tonight!', { hold: 1.6 });
    billing.mesh.userData.rig.pointing = false;

    // Down, behind the car.
    director.zoomTo(75, 0.5);
    dialogue.say('Other Ben (whispering)', 'Get down! Behind the car!', { style: 'whisper', hold: 0.9 });
    ben.moveTo(BEN_HIDE.x, BEN_HIDE.z, 5.2);
    const mid = director.doorApproach.clone().lerp(CAR_CAM, 0.5).setY(1.25);
    await director.moveCamera([mid, CAR_CAM.clone()], [0.45, 0.5]);
    ben.faceTowards(huddleLook);
    player.setLookTarget(huddleLook);
    await wait(0.4);

    await dialogue.say('Other Ben (whispering)', "That's every coach he's got. And more of those robots.", { style: 'whisper' });
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await dialogue.say('Other Ben (whispering)', 'Dude. We have class with him in, like, six hours. First period.', { style: 'whisper' });
    await dialogue.say('Other Ben (whispering)', "If he's still in charge of those things when the bell rings, we're done.", { style: 'whisper' });
    await dialogue.say('Other Ben (whispering)', 'The drive. We upload it to the school server room TONIGHT, and his ELDARs turn on him.', { style: 'whisper' });
    player.setLookTarget(new THREE.Vector3(-26, 2.2, -34));
    director.zoomTo(40, 1.4);
    await dialogue.say('Other Ben (whispering)', "Server room's past the locker rooms. See the right wing? The side door by the gym never latches.", { style: 'whisper', hold: 2.0 });
    director.zoomTo(75, 0.8);
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await dialogue.say('Other Ben (whispering)', "I'll wait till they spread out, then roll the car around out front, lights off. For when we need to run.", { style: 'whisper' });
    await dialogue.say('Other Ben (whispering)', 'You get to that locker room door. Stay low. Stay out of their lights. Go.', { style: 'whisper' });

    // Ben slips round to the driver's side and into the car.
    const driverSide = new THREE.Vector3(CAR_SPOT.x - 1.6, 0, CAR_SPOT.z - 1.4);
    ben.moveTo(driverSide.x, driverSide.z, 1.5).then(() => {
      playCarDoor();
      ben.mesh.visible = false;
    });

    // Billing heads for the main doors, goes in, and locks them behind him.
    player.setLookTarget(() => billing.headPosition(this._tmp));
    director.zoomTo(38, 1.2);
    const toDoors = billing.walkRoute([{ x: -0.6, z: -40 }, { x: 0, z: MAIN_DOORS.z - 1.4 }], 3.2);
    await wait(1.0);
    await dialogue.say('Coach Billing (far off)', "Coaches: sweep the grounds. ELDARs: hold the choke points. I'll be inside.", { hold: 1.4 });
    await toDoors;
    world.doors.rear.holdOpen(2.4);
    await wait(0.9);
    // He keeps walking on down the hall; he's only removed once the doors have
    // swung shut in front of him (hiding him in the doorway made him pop out of view).
    billing.moveTo(0, MAIN_DOORS.z + 9, 2.4);
    await wait(1.0);
    while (world.doors.rear.npcHold > 0 || world.doors.rear.progress > 0) await wait(0.1); // the doors swing shut
    billing.mesh.visible = false;
    billing.stop();
    playChainLock();
    await dialogue.say('', '*CLANK.* A chain rattles through the handles. The main doors are locked.', { style: 'narration', hold: 1.4 });

    // The ten of them fan out.
    this.hunters.forEach((h) => h.patrolFrom(0));
    this.sentries.forEach((s) => s.deploy());
    player.setLookTarget(new THREE.Vector3(HUDDLE.x - 6, 1.2, HUDDLE.z - 6));
    director.zoomTo(75, 1.2);
    await wait(1.6);

    // Back to you, crouched behind the car.
    player.setLookTarget(null);
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(CHECKPOINTS[0].pos, CHECKPOINTS[0].yaw, 0.02);
    this._restoreGameplay();
    this._beginSneak();
  }

  /**
   * Hand control back after a cutscene: no letterbox (any chapter's), the HUD
   * and crosshair back on, the camera released, mouse-look and movement live.
   */
  _restoreGameplay() {
    const { player, director } = this;
    this.cutscene = false;
    if (this.chapter2) this.chapter2.cutscene = false;
    director.releaseCamera(75);
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    player.movementFrozen = false;
    player.clearStumble();
    document.getElementById('hud').classList.remove('hidden');
    document.body.classList.remove('cinematic'); // (main.js removes the bars from the DOM once they've slid away)
  }

  /** Rise out of the trunk from underground (the reverse of Coach's descent in Chapter 1). */
  _emerge(character, to, speed) {
    const from = this.director.inside;
    character.mesh.position.set(from.x, -1.3, from.z);
    character.mesh.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
    const total = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    this._emerging = { character, from: from.clone(), total };
    return character.moveTo(to.x, to.z, speed).then(() => {
      character.mesh.position.y = 0;
      this._emerging = null;
    });
  }

  _updateEmerge() {
    const e = this._emerging;
    if (!e) return;
    const pos = e.character.mesh.position;
    const walked = Math.hypot(pos.x - e.from.x, pos.z - e.from.z);
    pos.y = -1.3 * Math.max(0, 1 - walked / 1.4); // up the last rungs, then out onto the grass
  }

  _place(pos, look) {
    this.camera.position.copy(pos);
    const t = typeof look === 'function' ? look() : look;
    const dx = t.x - pos.x;
    const dy = t.y - pos.y;
    const dz = t.z - pos.z;
    this.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    this.player.setLookTarget(look);
  }

  // ---- The sneak -------------------------------------------------------------------

  _beginSneak() {
    this.phase = 'sneak';
    this.sneakT = 0;
    this.hunters.forEach((h) => {
      h.thinking = true;
    });
    this.sentries.forEach((s) => {
      s.thinking = true;
    });
    this.stealth.meterEl.classList.remove('hidden');
    this._refreshObjective();
    this.ui.showMessage('Checkpoint: behind the car.', 2200);
  }

  _refreshObjective() {
    this.ui.setObjective("Reach the locker room door on Hall High School's west wing.", [
      { label: "Coaches catch you if they reach you: stay out of their light", tip: true },
      { label: 'Break line of sight, then hide: they search, then give up', tip: true },
      { label: 'ELDARs grab: mash [SPACE] / click to break free', tip: true },
      { label: "[E] Hide in dumpsters and sheds (if nobody sees you get in)", tip: true },
      { label: '[C] Crouch. Keep your flashlight OFF', tip: true },
    ]);
  }

  /** A coach just spotted you (or was sent running by a siren). */
  onChaseStart(hunter) {
    playWhistle();
    Achievements.flag('ch3_spotted'); // (Shadow Walker is gone)
    if (!this._firstChase) {
      this._firstChase = true;
      this.ui.showMessage(`${hunter.name} spotted you! Break his line of sight!`, 2400);
    }
    // In the locker room, being spotted is enough: Billing radios for backup.
    if (this.location === 'lockers' && !this.alarm && this.phase === 'lockerSneak') this._raiseAlarm(hunter.coach.position);
  }

  onSentryAlert() {
    // (Its visor flares and it lunges: the HUD already says what's happening.)
    Achievements.flag('ch3_spotted');
  }

  // ---- Grabbed by a sentry -----------------------------------------------------------

  startGrab(sentry) {
    if (this.grab || this.hiding || !this.sneaking) return;
    const { player } = this;
    this.grab = { sentry, taps: 0, t: this.time }; // (t: when it got you: Houdini times the escape)
    Achievements.flag('ch3_spotted');
    sentry.grabbed();
    player.movementFrozen = true;
    player.crouching = false;
    player.setLookTarget(() => sentry.eye());
    startSiren();
    this.hud.mash.classList.remove('hidden');
    this._setMash(0);
    // The siren brings a coach straight to you: indoors the ELDARs report to Billing (and
    // only him); on the grounds, whichever coach is nearest.
    const pp = player.object.position;
    let nearest = null;
    if (this.location === 'lockers') {
      nearest = this.billing && this.billing.state !== 'yank' ? this.billing : null;
    } else {
      let best = Infinity;
      for (const h of this.hunters) {
        if (h.state === 'yank') continue;
        const d = h.coach.position.distanceToSquared(pp);
        if (d < best) {
          best = d;
          nearest = h;
        }
      }
    }
    if (nearest) nearest.alert(pp);
  }

  _setMash(taps) {
    this.hud.mashText.textContent = `[TAP SPACE / CLICK RAPIDLY TO ESCAPE: ${taps} / ${SENTRY.taps}]`;
    this.hud.mashFill.style.width = `${(taps / SENTRY.taps) * 100}%`;
  }

  _tap() {
    const g = this.grab;
    if (!g || !this.player.isLocked || !this.sneaking) return;
    g.taps++;
    playStruggle(g.taps);
    this._setMash(g.taps);
    if (g.taps >= SENTRY.taps) this._breakFree();
  }

  _breakFree() {
    const g = this.grab;
    if (!g) return;
    if (this.time - g.t < 1.5) Achievements.unlock('houdini');
    this.grab = null;
    stopSiren();
    playBreakFree();
    this.hud.mash.classList.add('hidden');
    const { player } = this;
    player.movementFrozen = false;
    player.setLookTarget(null);
    const p = player.object.position;
    const s = g.sentry.position;
    // Stumble backward out of its grip; a second and a half to get your legs back.
    player.shove(p.x - s.x, p.z - s.z, 6.5, { stumble: 0.75, dip: 0.32, roll: 0.14, recovery: SENTRY.recovery });
    g.sentry.stun();
    this.ui.showMessage('You tear free! RUN!', 1600);
  }

  _endGrab() {
    if (!this.grab) return;
    const s = this.grab.sentry;
    this.grab = null;
    stopSiren();
    this.hud.mash.classList.add('hidden');
    this.player.movementFrozen = false;
    s.stun();
  }

  // ---- Hiding ----------------------------------------------------------------------

  _enterHide(spot) {
    if (this.hiding || this.grab || !this.sneaking) return;
    const { player } = this;
    // Anyone see you climb in? Then they're coming to drag you out.
    const witness = this.hunters.find((h) => h.state !== 'yank' && (h.visible || h.litUp || (h.state === 'chase' && h.lostT < 0.25)));
    this.hiding = { spot, t: 0, beat: 0, witness };
    // (Achievements: three different lockers; both a dumpster and a shed.)
    if (spot.kind === 'locker') {
      this._lockersUsed.add(spot);
      if (this._lockersUsed.size >= 3) Achievements.unlock('locker_legend');
    } else {
      this._hideKinds.add(spot.kind);
      if (this._hideKinds.has('dumpster') && this._hideKinds.has('shed')) Achievements.unlock('dumpster_diver');
    }
    spot.target = spot.openAngle;
    spot.speed = 5;
    if (spot.leaf) spot.leaf.visible = false; // (from inside you look out through the slats)
    this._hideSound(spot, true);
    if (this.lockers) this.lockers.setHover(null);
    player.setInteractables([]);
    player.currentTarget = null;
    player.movementFrozen = true;
    player.crouching = false;
    player.setCameraOverride(true);
    this.camera.position.copy(spot.eye);
    player.setLook(spot.lookYaw, -0.05);
    this.hud.hide.className = `show ${this._hideOverlay(spot)}`;
    this.ui.setPrompt('Step out');
    // Pulled shut to a crack.
    this.wait(0.35).then(() => {
      if (this.hiding && this.hiding.spot === spot) {
        spot.target = spot.crackAngle;
        spot.speed = 4;
      }
    });
    if (witness) witness.yank(spot);
    else this.ui.showMessage("Hidden. They can't see you in here.", 1800);
  }

  _exitHide() {
    const h = this.hiding;
    if (!h || h.yanked) return;
    const { player } = this;
    const spot = h.spot;
    this.hiding = null;
    spot.target = spot.openAngle;
    spot.speed = 5;
    if (spot.leaf) spot.leaf.visible = true;
    this.wait(0.8).then(() => {
      if (!this.hiding || this.hiding.spot !== spot) {
        spot.target = 0;
        spot.speed = 3;
      }
    });
    this._hideSound(spot, false);
    this.hud.hide.className = '';
    this.ui.setPrompt(null);
    player.setCameraOverride(false);
    player.movementFrozen = false;
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(spot.exit, spot.lookYaw, 0);
    player.setInteractables(this._interactables());
    // Climbing out with one of them already on the way over: he's right there.
    for (const hu of this.hunters) {
      if (hu.state === 'yank' && hu.yankSpot === spot) {
        hu.yankSpot = null;
        hu.lastSeen.set(spot.exit.x, 0, spot.exit.z);
        hu._beginChase();
      }
    }
  }

  _hideSound(spot, entering) {
    if (spot.kind === 'locker') playLockerDoor(entering);
    else playHideCreak(spot.kind === 'shed' ? 'door' : 'lid');
  }

  /** The peek-out overlay: under a lid, through door slats, or through a locker's vent louvers. */
  _hideOverlay(spot) {
    if (spot.kind === 'locker') return 'louver';
    return spot.kind === 'shed' ? 'door' : 'lid';
  }

  /** A coach saw you get in: the lid / door flies open, and there he is. */
  yankOpen(spot, hunter) {
    if (!this.hiding || this.hiding.spot !== spot || this.hiding.yanked) {
      hunter._resumePatrol(); // (you already got out)
      return;
    }
    this.hiding.yanked = true;
    spot.target = spot.openAngle;
    spot.speed = 9;
    if (spot.leaf) spot.leaf.visible = true;
    playYankOpen();
    this.hud.hide.className = '';
    this.ui.setPrompt(null);
    this.player.setLookTarget(() => hunter.coach.headPosition(this._tmp));
    this.capture(hunter, 'yank');
  }

  _updateHiding(dt) {
    const h = this.hiding;
    if (!h) return;
    h.t += dt;
    if (h.yanked) return;
    // Look around, but only as far as the crack lets you.
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    const yaw = h.spot.lookYaw + THREE.MathUtils.clamp(angleDiff(_euler.y, h.spot.lookYaw), -0.62, 0.62);
    const pitch = THREE.MathUtils.clamp(_euler.x, -0.32, 0.16);
    if (yaw !== _euler.y || pitch !== _euler.x) this.player.setLook(yaw, pitch);
    // Your heartbeat, when one of them is close.
    let nearest = Infinity;
    for (const hu of this.hunters) nearest = Math.min(nearest, hu.coach.position.distanceTo(h.spot.group.position));
    h.beat -= dt;
    if (nearest < 10 && h.beat <= 0) {
      h.beat = 0.55 + nearest * 0.06;
      playHeartbeat(1 - nearest / 12);
    }
  }

  // ---- Caught ---------------------------------------------------------------------

  async capture(hunter, reason = 'caught') {
    if (!this.sneaking) return;
    const resume = this.phase;
    this.phase = 'caught';
    this.cutscene = true;
    Achievements.death(); // (a flawless run is over)
    Achievements.flag('ch3_spotted');
    const { player, director, dialogue, wait } = this;
    this._endGrab();
    this.hunters.forEach((h) => {
      h.thinking = false;
      if (h !== hunter) h.coach.stop();
    });
    this.sentries.forEach((s) => {
      s.thinking = false;
    });
    hunter.coach.stop();
    hunter.coach.faceTowards(player.object.position);
    player.setInputLocked(true);
    if (!this.hiding) player.setLookTarget(() => hunter.coach.headPosition(this._tmp));
    playWhistle();
    playCaughtStinger();
    dialogue.say(hunter.name, reason === 'yank' ? hunter.yankLine : hunter.callout, { hold: 1.3 });
    await wait(1.6);
    await director.fader.to(1, 0.35);
    dialogue.finish();
    this.hud.caughtSub.textContent = 'BACK TO THE LAST CHECKPOINT';
    this.hud.caught.classList.add('show');
    await wait(1.9);
    this._resetToCheckpoint();
    this.hud.caught.classList.remove('show');
    await wait(0.4);
    await director.fader.to(0, 0.6);
    player.setInputLocked(false);
    this.cutscene = false;
    this.phase = resume;
    this.hunters.forEach((h) => {
      h.thinking = true;
    });
    this.sentries.forEach((s) => {
      s.thinking = true;
    });
    this.ui.showMessage(`Caught! Back ${this._checkpoint().name}. Stay in the dark.`, 3000);
  }

  _checkpoint() {
    if (this.location === 'lockers') return LOCKER_CHECKPOINTS[this.checkpoint];
    if (this.checkpoint === 0 && this.carGone) return TREE_CHECKPOINT;
    return CHECKPOINTS[this.checkpoint];
  }

  _resetToCheckpoint() {
    if (this.location === 'lockers') {
      this._resetLockers();
      return;
    }
    const { player } = this;
    const cp = this._checkpoint();
    if (this.hiding) {
      const spot = this.hiding.spot;
      this.hiding = null;
      spot.target = 0;
      spot.speed = 3;
      if (spot.leaf) spot.leaf.visible = true;
      this.hud.hide.className = '';
    }
    this.ui.setPrompt(null);
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.movementFrozen = false;
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(cp.pos, cp.yaw, 0.02);
    player.setInteractables(this._interactables());
    this.ui.setFlashlight(false);
    // Every coach restarts from the waypoint farthest from you; the sentries back on their beats.
    this.hunters.forEach((h) => {
      let far = 0;
      let best = -1;
      h.route.forEach((wp, i) => {
        const d = (wp.x - cp.pos.x) ** 2 + (wp.z - cp.pos.z) ** 2;
        if (d > best) {
          best = d;
          far = i;
        }
      });
      h.patrolFrom(far, true);
      h.markKind = null;
    });
    this.sentries.forEach((s) => s.reset(cp.pos));
    this._clearSpawn(cp.pos);
  }

  /**
   * Respawning: nobody (coach or ELDAR) starts within SAFE_SPAWN of you. The
   * checkpoints are sited for it; this moves anyone who still ends up too close
   * out to the edge of that circle (on open ground), so you can't be spotted
   * the instant the screen fades back in.
   */
  _clearSpawn(pos) {
    const r2 = SAFE_SPAWN * SAFE_SPAWN;
    const tooClose = (p) => (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < r2;
    const pushAway = (p) => {
      let dx = p.x - pos.x;
      let dz = p.z - pos.z;
      let d = Math.hypot(dx, dz);
      if (d < 0.5) {
        dx = 0;
        dz = 1; // (toward the school)
        d = 1;
      }
      for (let extra = 1.5; extra < 12; extra += 1.5) {
        const x = pos.x + (dx / d) * (SAFE_SPAWN + extra);
        const z = pos.z + (dz / d) * (SAFE_SPAWN + extra);
        const i = this.nav.nearestFree(this.nav.cellOf(x, z));
        if (i < 0) continue;
        this.nav._center(i, this._tmp);
        if (!tooClose(this._tmp)) {
          p.x = this._tmp.x;
          p.z = this._tmp.z;
          return;
        }
      }
    };
    for (const h of this.hunters) {
      if (!tooClose(h.coach.position)) continue;
      h.coach.stop();
      pushAway(h.coach.mesh.position);
      h._enterPause(1.2);
    }
    for (const s of this.sentries) {
      if (!tooClose(s.position)) continue;
      pushAway(s.root.position);
      s._return(); // (walks back to its beat)
    }
  }

  // ---- Detection (used by the Hunters and Sentries) ------------------------------------

  /** Walking / running / crouching noise radius check (Chapter 1's hearing). */
  hears(dist) {
    const p = this.player;
    const h = V.hearing;
    let radius;
    if (!p.isMoving) radius = p.isCrouching ? h.crouchStill : h.still;
    else if (p.isCrouching) radius = h.crouchWalk;
    else if (p.isSprinting) radius = h.sprint;
    else radius = h.walk;
    if (this.location === 'lockers' && p.isMoving && this.lockers.wetAt(p.object.position.x, p.object.position.z)) radius *= WET_HEARING;
    return dist < radius;
  }

  /** Detection range multiplier (x Chapter 1's) for what you're doing right now. */
  stanceMult() {
    return STANCE[this.stance()];
  }

  stance() {
    const p = this.player;
    if (p.isCrouching) return p.isMoving ? 'crouchMove' : 'crouchStill';
    return p.isSprinting ? 'sprint' : 'upright';
  }

  /** A coach's eyes: in its flashlight beam, or anywhere in its field of view, with a clear line. */
  sight(hunter) {
    const out = this._sight;
    out.visible = false;
    out.inBeam = false;
    out.proximity = 0;
    if (this.playerHidden) return out;
    const player = this.player;
    const p = player.object.position;
    const c = hunter.coach.position;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const dist = Math.hypot(dx, dz);
    out.dist = dist;
    const fx = Math.sin(hunter.aimYaw);
    const fz = Math.cos(hunter.aimYaw);
    const cosA = dist > 1e-4 ? (dx * fx + dz * fz) / dist : 1;
    const angle = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
    const flash = (player.flashlightOn ? VISION.flashlightMult : 1) * difficulty.sightMult;
    const stance = this.stance();
    const indoors = this.location === 'lockers';
    const glimpse = (indoors ? LOCKER_GLIMPSE : GLIMPSE)[stance];
    const lightMult = indoors && this.lockers.litAt(p.x, p.z) ? LIT_MULT : 1; // standing under a working light
    const beamReach = (indoors ? LOCKER_BEAM_REACH : VISION.beamReach) * STANCE[stance] * flash;
    const sightRange = glimpse.range * flash * lightMult;
    out.closeRange = Math.min(sightRange, HUNTER.closeRange * (STANCE[stance] / STANCE.sprint));
    const lit = angle < VISION.beamHalfAngle && dist < beamReach;
    const inView = angle < VISION.halfAngle * glimpse.angle && dist < sightRange;
    if (!lit && !inView) return out;
    if (!this._clearLine(hunter.coach, p, player.isCrouching)) return out;
    out.visible = true;
    out.inBeam = lit;
    out.proximity = 1 - Math.min(1, dist / (lit ? beamReach : sightRange));
    return out;
  }

  /** Mid-chase: it keeps you in sight whichever way it's facing, as long as nothing's in the way. */
  pursuitSight(hunter) {
    if (this.playerHidden) return false;
    const p = this.player.object.position;
    const c = hunter.coach.position;
    const range = this.location === 'lockers' ? 30 : HUNTER.pursuitSight;
    if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 > range ** 2) return false;
    return this._clearLine(hunter.coach, p, this.player.isCrouching);
  }

  _clearLine(character, p, crouching) {
    const c = character.position;
    this._tmp.set(c.x, character.mesh.userData.headHeight + 0.05, c.z);
    const heights = crouching ? V.crouchedTargets : V.standingTargets;
    for (const h of heights) {
      this._tmp2.set(p.x, h, p.z);
      if (!this._blocked(this._tmp, this._tmp2)) return true;
    }
    return false;
  }

  /** A sentry's visor: a narrow cone, short range, a clear line. */
  sentrySees(sentry) {
    if (this.playerHidden) return false;
    const player = this.player;
    const p = player.object.position;
    const s = sentry.position;
    const dx = p.x - s.x;
    const dz = p.z - s.z;
    const dist = Math.hypot(dx, dz);
    const range = sentry.stats.sight * (player.flashlightOn ? 1.6 : 1) * (player.isCrouching ? 0.75 : 1) * difficulty.sightMult;
    if (dist > range) return false;
    const facing = sentry.yaw + sentry.scan;
    const cosA = dist > 1e-4 ? (dx * Math.sin(facing) + dz * Math.cos(facing)) / dist : 1;
    if (cosA < Math.cos(sentry.stats.halfAngle)) return false;
    const eye = sentry.eye();
    for (const h of player.isCrouching ? V.crouchedTargets : V.standingTargets) {
      this._tmp2.set(p.x, h, p.z);
      if (!this._blocked(eye, this._tmp2)) return true;
    }
    return false;
  }

  /**
   * Where a searching coach should look around `center` (where it lost you): walkable
   * spots SEARCH.radius out that hug cover (a corner, a locker bank, a dumpster) and,
   * best of all, can't be seen from the spot itself: just where somebody would duck.
   * Spread out, reachable, and ordered nearest-first from `from`.
   */
  searchPoints(center, from, count) {
    const nav = this.nav;
    if (!nav) return [];
    const [r0, r1] = SEARCH.radius;
    const cands = [];
    const eye = this._tmp.set(center.x, 1.3, center.z);
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + Math.random() * 0.2;
      const r = rand(r0, r1);
      const cell = nav.nearestFree(nav.cellOf(center.x + Math.sin(a) * r, center.z + Math.cos(a) * r));
      if (cell < 0) continue;
      const p = nav._center(cell, new THREE.Vector3());
      if ((p.x - center.x) ** 2 + (p.z - center.z) ** 2 > (r1 + 1) ** 2) continue;
      let score = Math.random() * 0.6;
      if (this._nearCover(cell)) score += 1;
      if (this._blocked(eye, this._tmp2.set(p.x, 1.0, p.z))) score += 1.5; // hidden from the spot
      cands.push({ p, score });
    }
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    let paths = 0;
    for (const c of cands) {
      if (picked.length >= count || paths >= count * 3) break;
      if (picked.some((q) => q.distanceToSquared(c.p) < 3.5 * 3.5)) continue; // (spread them out)
      paths++;
      if (!nav.path(center, c.p)) continue; // (somewhere it can actually walk to)
      picked.push(c.p);
    }
    // Nearest-first from where the coach is standing.
    const out = [];
    let at = from;
    while (picked.length) {
      let best = 0;
      for (let i = 1; i < picked.length; i++) if (picked[i].distanceToSquared(at) < picked[best].distanceToSquared(at)) best = i;
      at = picked.splice(best, 1)[0];
      out.push(at);
    }
    return out;
  }

  /** Is there something solid within a couple of cells of nav cell `i`? */
  _nearCover(i) {
    const nav = this.nav;
    const w = nav.w;
    const ix = i % w;
    const iz = (i - ix) / w;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = ix + dx;
        const z = iz + dz;
        if (x < 0 || z < 0 || x >= w || z >= nav.h) continue;
        if (nav.blocked[z * w + x]) return true;
      }
    }
    return false;
  }

  /** Is anything solid between two points? (AABBs of the cover: cheap enough for every frame.) */
  _blocked(from, to) {
    const dir = this._dir.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-3) return false;
    dir.divideScalar(len);
    this._ray.set(from, dir);
    const limit = (len - 0.25) ** 2;
    for (const b of this._occluderBoxes) {
      if (this._ray.intersectBox(b, this._hit) && this._hit.distanceToSquared(from) < limit) return true;
    }
    return false;
  }

  _rebuildBoxes() {
    const boxOf = (obj) => {
      obj.updateWorldMatrix(true, true);
      return new THREE.Box3().setFromObject(obj);
    };
    this._occluderBoxes = this.world.stealth.occluders.filter((o) => o.visible !== false).map(boxOf);
    this._colliderBoxes = this.world.colliders
      .map(boxOf)
      .filter((b) => b.max.y > 0.3 && b.min.y < 1.5 && b.max.x - b.min.x < 60);
    if (this.nav) this.nav.build(this._colliderBoxes);
  }

  /** Keep a walker (coach or sentry) out of solid things. */
  pushOut(pos, radius) {
    for (const b of this._colliderBoxes) {
      const cx = THREE.MathUtils.clamp(pos.x, b.min.x, b.max.x);
      const cz = THREE.MathUtils.clamp(pos.z, b.min.z, b.max.z);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x += (dx / d) * (radius - d);
        pos.z += (dz / d) * (radius - d);
      } else {
        const l = pos.x - b.min.x;
        const r = b.max.x - pos.x;
        const n = pos.z - b.min.z;
        const f = b.max.z - pos.z;
        const m = Math.min(l, r, n, f);
        if (m === l) pos.x = b.min.x - radius;
        else if (m === r) pos.x = b.max.x + radius;
        else if (m === n) pos.z = b.min.z - radius;
        else pos.z = b.max.z + radius;
      }
    }
  }

  spark(pos) {
    for (let i = 0; i < 3; i++) {
      const s = this.sparks[this._spark];
      this._spark = (this._spark + 1) % this.sparks.length;
      s.sprite.visible = true;
      s.sprite.position.copy(pos);
      s.vel.set(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).multiplyScalar(2.4);
      s.life = rand(0.25, 0.45);
    }
  }

  _updateSparks(dt) {
    for (const s of this.sparks) {
      if (!s.sprite.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.sprite.visible = false;
        continue;
      }
      s.vel.y -= 9 * dt;
      s.sprite.position.addScaledVector(s.vel, dt);
      s.sprite.scale.setScalar(0.08 + s.life * 0.12);
    }
  }

  // ---- Per frame -------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    if (this.location === 'grounds') {
      for (const u of this.world.updatables) u.update(dt); // rain, the coaches' + Ben's legs, the main doors
      this.hale.update(dt);
      this._updateEmerge();
      this._updateDoorSwing(dt);
      for (const spot of this.spots) updateHideProp(spot, dt);
      this.sentryBeamMat.uniforms.uTime.value = this.time;
      this.stealth.beamMaterial.uniforms.uTime.value = this.time;
      for (const h of this.hunters) {
        h.update(dt);
        this.pushOut(h.coach.position, 0.4);
      }
      for (const s of this.sentries) s.update(dt);
      this._updateSparks(dt);
      if (this.phase === 'sneak') {
        this.sneakT += dt;
        this._updateHiding(dt);
        this._updateCheckpoints();
        this._updateCar();
        this._updateDoorLabel();
      }
      if (this.phase === 'sneak' && !this.cutscene) this._updateBounds(dt);
      else if (this._boundsWarnT > 0) {
        this._boundsWarnT = 0;
        this.hud.bounds.classList.remove('show');
      }
      this._updateHud();
    } else if (this.location === 'lockers' && this.lockers) {
      this._updateLockers(dt);
    } else if (this.location === 'gym' && this.gym) {
      this.gym.update(dt);
    }
  }

  _updateLockers(dt) {
    const L = this.lockers;
    for (const u of L.updatables) u.update(dt);
    for (const spot of this.spots) updateHideProp(spot, dt);
    if (this.billing) {
      for (const h of this.lockerCrew) {
        h.coach.update(dt);
        h.update(dt);
        if (h.coach.mesh.visible) this.pushOut(h.coach.position, 0.4);
      }
      this.lightBeamMat.uniforms.uTime.value = this.time;
    }
    for (const s of this.sentries) s.update(dt);
    if (this.sentryBeamMat) this.sentryBeamMat.uniforms.uTime.value = this.time;
    this._updateSparks(dt);
    if (this.phase === 'lockerSneak') {
      this._updateHiding(dt);
      this._updateLockerCheckpoints();
      // Glow the hideable locker under your crosshair.
      const t = this.player.currentTarget;
      L.setHover(!this.hiding && t && t.userData.type === 'ch3-hide' ? t.userData.spot : null);
      this._updateGymDoorLabel();
    }
    this._updateHud();
  }

  _updateCheckpoints() {
    const p = this.player.object.position;
    if (this.checkpoint < 1 && !this.hunted && p.z > -64) {
      this.checkpoint = p.x < 2 ? 1 : 2; // (the west shed, or the lot: whichever side you came up)
      this.ui.showMessage(`Checkpoint: ${CHECKPOINTS[this.checkpoint].name}.`, 2200);
    }
  }

  /** Once you're well clear (and looking the other way), Ben quietly drives the car round front. */
  _updateCar() {
    if (this.carGone || this.sneakT < 20) return;
    const car = this.world.playersCar;
    const p = this.player.object.position;
    const dx = car.position.x - p.x;
    const dz = car.position.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 38) return;
    const e = this.camera.matrixWorld.elements; // looking away from it?
    const facing = (-e[8] * dx + -e[10] * dz) / d;
    if (facing > 0.3) return;
    this.carGone = true;
    this._stageCar(false);
    this._rebuildBoxes();
    this._setGroundColliders();
    playDistantEngine();
    this.ui.showMessage('Somewhere behind you, an engine turns over... Ben is moving the car out front.', 3400);
  }

  _updateDoorLabel() {
    const leaf = this.world.lockerRoomDoor.leaf;
    const label = this.hunted ? "Locker Room (they're after you: lose them first!)" : 'Enter Locker Room';
    if (leaf.userData.label !== label) {
      leaf.userData.label = label;
      if (this.player.currentTarget === leaf) this.player.currentTarget = null; // re-read the prompt next frame
    }
  }

  _updateHud() {
    const meter = this.stealth;
    if (!this.sneaking) return;
    let fill = this.hunters.reduce((m, h) => Math.max(m, h.suspicion), 0);
    let label = 'HIDDEN';
    let color = '#7d8790';
    if (this.grab) {
      label = 'GRABBED!';
      color = '#e0584f';
      fill = 1;
    } else if (this.hunters.some((h) => h.state === 'chase' || h.state === 'yank')) {
      label = 'SPOTTED!';
      color = '#e0584f';
      fill = 1;
    } else if (this.hunters.some((h) => h.state === 'search')) {
      label = 'SEARCHING ?';
      color = '#e0903a';
      fill = Math.max(fill, 0.6);
    } else if (this.hunters.some((h) => h.litUp)) {
      label = 'IN THE LIGHT!';
      color = '#e0643a';
    } else if (this.hunters.some((h) => h.state === 'investigate' || h.state === 'heard')) {
      label = 'SUSPICIOUS ?';
      color = '#e0b43a';
      fill = Math.max(fill, 0.3);
    } else if (this.sentries.some((s) => s.state === 'alert' || s.state === 'lunge')) {
      label = 'ELDAR ALERT!';
      color = '#e0643a';
      fill = Math.max(fill, 0.5);
    } else if (this.hiding) {
      label = 'IN HIDING';
      color = '#7fbf7f';
    } else if (this.location === 'lockers' && this.lockers.litAt(this.player.object.position.x, this.player.object.position.z)) {
      label = 'UNDER A LIGHT';
      color = '#d8c46a';
      fill = Math.max(fill, 0.15);
    }
    if (label !== this._hudLabel) {
      this._hudLabel = label;
      meter.stateEl.textContent = label;
      meter.stateEl.style.color = color;
      meter.iconEl.style.color = color;
    }
    const width = Math.round(fill * 100);
    if (width !== this._hudWidth) {
      this._hudWidth = width;
      meter.fillEl.style.width = `${width}%`;
    }
    this.hud.warning.classList.toggle('hidden', !this.player.flashlightOn);
  }

  // ---- The locker room door --------------------------------------------------------

  async _playInfiltration() {
    const { player, director, dialogue, wait, world } = this;
    const door = world.lockerRoomDoor;
    this.phase = 'infiltrate';
    this.cutscene = true;
    this.hunters.forEach((h) => {
      h.thinking = false;
    });
    this.sentries.forEach((s) => {
      s.thinking = false;
    });
    this.stealth.meterEl.classList.add('hidden');
    this.hud.warning.classList.add('hidden');
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    player.setInputLocked(true);
    player.setCameraOverride(true);

    // Up to the door... it gives... and you slip through.
    const inFront = door.outside.clone().setY(1.55);
    player.setLookTarget(door.position.clone().setY(1.3));
    await director.moveCamera([inFront], [Math.max(0.4, this.camera.position.distanceTo(inFront) / 3)]);
    // It swings in, away from you: the hinge is on the doorway's +Z jamb and the
    // leaf folds back past square against the vestibule wall, so you slip
    // through on the latch side with the leaf well clear of the camera.
    playHideCreak('door');
    this._doorSwing = { t: 0, from: 0, to: -1.66, seconds: 0.75 };
    await wait(0.7);
    player.setLookTarget(door.position.clone().add(new THREE.Vector3(3, 1.4, -0.25)));
    await director.moveCamera(
      [door.position.clone().add(new THREE.Vector3(-0.2, 1.5, -0.22)), door.position.clone().add(new THREE.Vector3(1.0, 1.5, -0.25))],
      [0.35, 0.4],
    );
    await director.fader.to(1, 0.3);

    // Behind the black: the grounds, the lot and the bunker are unloaded; the locker room loads.
    this._loadLockerRoom();
    const L = this.lockers;
    // (Standing off the latch side, clear of the leaf's sweep as it slams.)
    this._place(L.spawn.position.clone().setY(1.55).add(new THREE.Vector3(0.45, 0, -0.35)), L.doorLook);
    await director.fader.to(0, 0.2);
    await L.entryDoor.slam();
    this.camera.position.x -= 0.08; // (the slam jolts you)
    await wait(0.35);
    await L.entryDoor.throwBolt();
    await wait(0.3);
    this.player.setColliders(L.colliders); // (the door's shut: its box is the closed one now)

    // Back against the door, catching your breath.
    playBreathing(3.6);
    await director.moveCamera([this.camera.position.clone().setY(1.15)], [0.7]);
    await dialogue.say('', 'You slam the steel door and throw the deadbolt. You slide down against it, gasping for air.', { style: 'narration', hold: 1.6 });
    await wait(0.6);
    const roomLook = new THREE.Vector3(2, 1.2, -1);
    player.setLookTarget(roomLook);
    await wait(0.9);
    await dialogue.say('', 'The locker room. Dark, dripping, silent... for now.', { style: 'narration', hold: 1.4 });
    await this._playBillingEntrance();
  }

  /**
   * Across the room a door creaks open: Coach Billing steps out of his office
   * with a flashlight (he has no idea you're in here) and starts his rounds,
   * right between you and the gym.
   */
  async _playBillingEntrance() {
    const { player, director, dialogue, wait } = this;
    const L = this.lockers;
    const b = this.billing;
    const coach = b.coach;
    playLockerDoor(true);
    await wait(0.4);
    await dialogue.say('', 'Somewhere across the room, a door creaks open.', { style: 'narration', hold: 1.0 });
    // Cut to a peek past the end of the locker banks, at the coach's office.
    await director.fader.to(1, 0.25);
    this._place(new THREE.Vector3(9.6, 1.25, 2.9), L.officeDoorStep.clone().setY(1.6));
    L.officeDoor.set(0);
    coach.mesh.position.copy(L.officeInside);
    coach.mesh.rotation.y = Math.PI;
    coach.mesh.visible = true;
    b.aimYaw = Math.PI;
    b.lightOn();
    b.light.intensity = 36;
    await director.fader.to(0, 0.3);
    L.officeDoor.open();
    await wait(0.5);
    await coach.moveTo(L.officeDoorStep.x, L.officeDoorStep.z, 1.3);
    player.setLookTarget(() => coach.headPosition(this._tmp));
    coach.faceTowards(new THREE.Vector3(0, 0, 0));
    await dialogue.say('Coach Billing (muttering)', 'Coaches outside... robots on every door... and those two STILL aren\'t in custody.', { hold: 1.6 });
    coach.faceTowards(new THREE.Vector3(-6, 0, 8));
    await dialogue.say('Coach Billing (muttering)', "They'll turn up. Nobody gets through MY locker room.", { hold: 1.2 });
    b.patrolFrom(1); // (walks off on his rounds)
    b.thinking = false;
    await wait(0.8);
    // Back to you, crouched by the door.
    await director.fader.to(1, 0.25);
    player.setLookTarget(null);
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(LOCKER_CHECKPOINTS[0].pos, LOCKER_CHECKPOINTS[0].yaw, -0.03);
    await director.fader.to(0, 0.3);
    await dialogue.say('', "Coach Billing. And he's right between you and the gym.", { style: 'narration', hold: 1.2 });
    this._restoreGameplay();
    this._beginLockerSneak();
    this.ui.onPartComplete();
    Achievements.unlock('inside_job');
  }

  _beginLockerSneak() {
    this.phase = 'lockerSneak';
    this.checkpoint = 0;
    this.billing.thinking = true;
    // Hard Mode: Coach Tom is already walking the room too (starting well away from you, and from
    // Billing: not trailing him round the same loop).
    if (this.startCrew.length > 1) {
      const placed = [LOCKER_CHECKPOINTS[0].pos, this.billing.coach.position.clone()];
      for (const h of this.startCrew) {
        if (h === this.billing) continue;
        this._deployLockerCoach(h, placed);
        placed.push(h.coach.position.clone());
      }
      this.hunters = this.startCrew.slice();
    }
    this._startScouts(LOCKER_CHECKPOINTS[0].pos);
    this.stealth.meterEl.classList.remove('hidden');
    this._refreshLockerObjective();
    if (this.startCrew.length > 1) this.ui.showMessage("Checkpoint: the entry alcove. HARD MODE: Coach Tom's in here too.", 3400);
    else this.ui.showMessage('Checkpoint: the entry alcove.', 2200);
  }

  /** A coach onto his rounds in the locker room, from the stop farthest from all of `awayFrom` (light on, thinking). */
  _deployLockerCoach(h, awayFrom) {
    h.coach.mesh.visible = true;
    h.lightOn();
    h.light.intensity = 36;
    h.markKind = null;
    h.patrolFrom(this._farthestStop(h, awayFrom), true);
    h.thinking = true;
  }

  /** The stop on `h`'s rounds whose distance to the nearest of `points` is greatest. */
  _farthestStop(h, points) {
    let far = 0;
    let best = -1;
    h.route.forEach((wp, i) => {
      let d = Infinity;
      for (const p of points) d = Math.min(d, (wp.x - p.x) ** 2 + (wp.z - p.z) ** 2);
      if (d > best) {
        best = d;
        far = i;
      }
    });
    return far;
  }

  /** The two ELDAR sentries onto their loops (starting as far from you as they can). */
  _startScouts(awayFrom) {
    this.sentries = this.scouts.slice();
    for (const s of this.sentries) {
      s.root.visible = true;
      s.reset(awayFrom);
      s.cooldown = 0;
      s.anim.kneel = 0;
      s.thinking = true;
    }
    this.player.setCharacters(this.hunters.map((h) => h.coach).concat(this.sentries));
  }

  _refreshLockerObjective() {
    this.ui.setObjective('Cross the locker room to the gym doors. Coach Billing must not see you.', [
      { label: '[E] Hide in the lockers with the lighter doors: you watch through the vents', tip: true },
      { label: 'Coaches catch you on contact. ELDARs grab you and call Billing: mash [SPACE]', tip: true },
      { label: 'Stay out of flashlights, red visors, and the working lights', tip: true },
      { label: `Get spotted and Billing calls in a ${this.startCrew.length > 1 ? 'third' : 'second'} coach`, tip: true },
      { label: 'They check the aisles as they pass, and search hard where they lose you', tip: true },
      { label: 'Wet shower tile is loud. [C] Crouch. Flashlight OFF', tip: true },
    ]);
  }

  _updateDoorSwing(dt) {
    const s = this._doorSwing;
    if (!s) return;
    s.t += dt;
    const k = Math.min(1, s.t / s.seconds);
    this.world.lockerRoomDoor.pivot.rotation.y = s.from + (s.to - s.from) * (1 - (1 - k) ** 2);
    if (k >= 1) this._doorSwing = null;
  }

  _loadLockerRoom() {
    const { player, renderer, camera, ui } = this;
    const lockers = buildLockerRoom();
    this.lockers = lockers;
    stopSiren();
    this.location = 'lockers';
    ui.setScene(lockers.scene); // the camera (with your flashlight) and the marker move in
    ui.unloadOutdoors(); // the grounds, the lot and the bunker are freed
    this.hunters = [];
    this.sentries = [];
    this.spots = lockers.hideSpots;
    this.hiding = null;
    this.grab = null;
    this.alarm = null;
    setRainExposure(0.12); // the storm, muffled through cinderblock
    player.setColliders(lockers.colliders);
    player.setInteractables(lockers.interactables);
    lockers.entryDoor.set(0.75);
    this._setupLockerCast();
    player.setCharacters([this.billing.coach]);
    // Build every shader now (Billing's flashlight, the scouts, the "?" marks, sparks).
    this._prewarmLockers(true);
    renderer.compile(lockers.scene, camera);
    this._prewarmLockers(false);
  }

  /** Billing (a Hunter with his own flashlight), a pool of ELDAR scouts, sparks, nav, sight boxes. */
  _setupLockerCast() {
    const L = this.lockers;
    const scene = L.scene;
    this.scene = scene;
    this.questionTex = createMarkTexture('?', '#ffd21f');
    this.alertTex = createMarkTexture('!', '#ff4a3a');
    this.beamGeometry = createBeamGeometry();
    this.sentryBeamMat = createBeamMaterial();
    this.sentryBeamMat.uniforms.uColor.value.set(0xff2a1a);
    this.sentryBeamMat.uniforms.uIntensity.value = 0.14;
    this.lightBeamMat = createBeamMaterial();
    this.lightBeamMat.uniforms.uIntensity.value = 0.26;
    this.eldarMats = createEldarMaterials();

    // Walkable grid + the boxes that block sight and movement.
    this.nav = new NavGrid({ ...L.nav, cell: 0.4, inflate: 0.36 });
    this._rebuildLockerBoxes();

    // Coach Billing, Coach Tom and Coach Hale, each with a flashlight. Normal: Billing walks the
    // room alone and Tom barges in if you're spotted. Hard: Tom's in here from the start, and the
    // alert brings Hale.
    this.billing = this._makeLockerCoach(BILLING_ROUNDS, COACH_BILLING_LOOK);
    this.tom = this._makeLockerCoach(TOM_ROUNDS, TOM_LOOK);
    this.hale = this._makeLockerCoach(HALE_ROUNDS, HALE_LOOK);
    this.lockerCrew = [this.billing, this.tom, this.hale];
    this.startCrew = difficulty.hard ? [this.billing, this.tom] : [this.billing];
    this.backup = difficulty.hard ? this.hale : this.tom; // (who the alert calls in)
    this.hunters = [this.billing];
    this.peeks = LOCKER_PEEKS; // (the side turnings they check on their rounds)

    // Two ELDAR sentries on patrol from the start (they grab you and report to Billing).
    this.scouts = SCOUT_ROUTES.map((route, i) => {
      const s = new Sentry(this, { route, stats: SCOUT_STATS }, i);
      s.root.visible = false;
      s.root.position.set(0, -50, 0);
      return s;
    });
    this._buildLockerSparks(scene);
  }

  /** A coach for the locker room: a Hunter with his own flashlight (hidden until he's needed). */
  _makeLockerCoach(def, look) {
    const scene = this.lockers.scene;
    const mesh = createHumanoid(look);
    mesh.name = `coach-${def.id}-lockers`;
    mesh.visible = false;
    scene.add(mesh);
    const coach = new Character(mesh, { radius: 0.45, name: def.name });
    const prop = new THREE.Group();
    prop.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.24, 8), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.4 })));
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    lens.position.y = -0.121;
    lens.rotation.x = Math.PI / 2;
    prop.add(lens);
    prop.position.y = -0.06;
    mesh.userData.rig.handR.add(prop);
    const light = new THREE.SpotLight(0xfff1d0, 0, 26, V.beamHalfAngle, 0.45, 1.1);
    const lightTarget = new THREE.Object3D();
    light.target = lightTarget;
    scene.add(light, lightTarget);
    const beam = new THREE.Mesh(this.beamGeometry, this.lightBeamMat);
    beam.visible = false;
    beam.frustumCulled = false;
    scene.add(beam);
    const glare = new THREE.Sprite(new THREE.SpriteMaterial({ map: createGlareTexture(), color: 0xfff4dc, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glare.visible = false;
    scene.add(glare);
    const hunter = new Hunter(this, def, coach, { light, lightTarget, beam, glare, prop, lens });
    hunter.beam.scale.setScalar(1.05);
    return hunter;
  }

  _buildLockerSparks(scene) {
    // Sparks (a stunned scout), in this scene.
    const sparkTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 32, 32);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    this.sparks = Array.from({ length: 30 }, () => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkTex, color: 0x9fe8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, vel: new THREE.Vector3(), life: 0 };
    });
    this._spark = 0;
  }

  _rebuildLockerBoxes() {
    const L = this.lockers;
    const boxOf = (obj) => {
      obj.updateWorldMatrix(true, true);
      return new THREE.Box3().setFromObject(obj);
    };
    this._occluderBoxes = L.occluders.map(boxOf);
    this._colliderBoxes = L.colliders.map(boxOf).filter((b) => b.max.y > 0.3 && b.min.y < 1.5);
    this.nav.build(this._colliderBoxes);
  }

  _prewarmLockers(on) {
    const b = this.billing;
    b.mark.visible = on;
    b.beam.visible = on || b.light.intensity > 0;
    b.glare.visible = on || b.light.intensity > 0;
    b.coach.mesh.visible = on;
    for (const h of this.lockerCrew) {
      if (h === b) continue;
      h.coach.mesh.visible = on;
      h.beam.visible = on;
      h.glare.visible = on;
    }
    for (const s of this.scouts) {
      s.root.visible = on;
      if (on) s.root.position.set(-18, 0, 0);
      else s.root.position.set(0, -50, 0);
    }
    this.sparks[0].sprite.visible = on;
  }

  // ---- The locker room: checkpoints, the alarm, the scouts, the gym doors ---------------

  _updateLockerCheckpoints() {
    const p = this.player.object.position;
    if (this.checkpoint < 1 && !this.hunted && p.x > 5.2) {
      this.checkpoint = 1;
      this.ui.showMessage(`Checkpoint: ${LOCKER_CHECKPOINTS[1].name}.`, 2200);
    }
  }

  _updateGymDoorLabel() {
    const label = this.hunted ? "Gym doors (they're after you: lose them first!)" : 'Push through into the gym';
    for (const leaf of this.lockers.gymDoors.leaves) {
      if (leaf.userData.label !== label) {
        leaf.userData.label = label;
        if (this.player.currentTarget === leaf) this.player.currentTarget = null;
      }
    }
  }

  /** Lost you: he checks the lockers where he last saw you (up to two of them). */
  lockersNear(p) {
    if (this.location !== 'lockers') return [];
    return this.spots
      .filter((s) => s.front.distanceToSquared(p) < 3.4 * 3.4)
      .sort((a, b) => a.front.distanceToSquared(p) - b.front.distanceToSquared(p))
      .slice(0, 2);
  }

  /** He yanks a locker open: you're caught if you're in it; otherwise it bangs shut again. Returns true if caught. */
  checkLocker(spot, hunter) {
    if (this.hiding && this.hiding.spot === spot) {
      if (!this.hiding.yanked) this.yankOpen(spot, hunter);
      return true;
    }
    spot.target = spot.openAngle;
    spot.speed = 6;
    playLockerDoor(true);
    this.wait(0.8).then(() => {
      if (!this.hiding || this.hiding.spot !== spot) {
        spot.target = 0;
        spot.speed = 4;
        playLockerDoor(false);
      }
    });
    return false;
  }

  /** A coach's chase just turned into a search (you broke his line of sight): the alert. */
  onSearchStart(hunter) {
    if (this.location === 'lockers' && !this.alarm && this.phase === 'lockerSneak') this._raiseAlarm(hunter.coach.position);
  }

  /** An ELDAR lunged for you and lost you: it reports it (to Billing): the alert. */
  onSentryLost(sentry) {
    if (this.location === 'lockers' && !this.alarm && this.phase === 'lockerSneak') this._raiseAlarm(sentry.position);
  }

  /**
   * The alert: the klaxon, Billing on his radio, and backup barging in through
   * the exterior door to hunt for you: Coach Tom (2 coaches, 2 ELDARs from
   * here), or on Hard Mode, with Tom already inside, Coach Hale (3 and 2).
   */
  async _raiseAlarm(from) {
    const token = this.lockerToken;
    const L = this.lockers;
    const lastKnown = this.player.object.position.clone().setY(0);
    this.alarm = { t: 0 };
    Achievements.flag('ch3_spotted'); // (the alarm's up: nobody "never got spotted")
    const who = this.backup === this.hale ? 'Hale' : 'Tom';
    this.dialogue.say('Coach Billing (radio)', `${who}! Get in here, the locker room! One of them's loose in here!`, { hold: 1.8 });
    startAlarm();
    L.setAlarm(true);
    this.ui.showMessage('ALERT! Billing is calling in backup...', 3000);
    await this.wait(3.0);
    if (token !== this.lockerToken) return;
    playDoorBang();
    await this.wait(0.9);
    if (token !== this.lockerToken) return;
    L.entryDoor.burst();
    this._tmp.set(L.entryInside.x - 0.6, 1.4, L.entryInside.z);
    this.spark(this._tmp);
    // The backup, flashlight up, straight for where you were last seen.
    const t = this.backup;
    t.coach.stop();
    t.coach.mesh.visible = true;
    t.place(L.entryInside.x, L.entryInside.z, Math.PI / 2);
    t.lightOn();
    t.light.intensity = 36;
    t.markKind = null;
    this.hunters = [...this.startCrew, t];
    this.player.setCharacters(this.hunters.map((h) => h.coach).concat(this.sentries));
    this.dialogue.say(t.name, t === this.hale ? 'Three of us now, kid. Come on out.' : "Alright, kid. Where'd you go?", { hold: 1.2 });
    await this.wait(0.6);
    if (token !== this.lockerToken) return;
    t.thinking = true;
    t.lastSeen.copy(lastKnown);
    t._enterSearch();
    this.player.setColliders(L.colliders); // (the door's swung open)
    this._rebuildLockerBoxes();
    const n = this.hunters.length;
    this.ui.showMessage(`${n === 3 ? 'A third' : 'A second'} coach is in the room! ${n === 3 ? 'Three' : 'Two'} coaches, two ELDARs now.`, 2800);
    await this.wait(14);
    if (token !== this.lockerToken) return;
    stopAlarm(); // (the klaxon winds down; the strobes keep going)
  }

  /** The backup coach out of the picture again (a retry). */
  _parkBackup() {
    const t = this.backup;
    t.thinking = false;
    t.state = 'idle';
    t.coach.stop();
    t.coach.mesh.visible = false;
    t.coach.mesh.position.set(0, 0, -60);
    t.light.intensity = 0;
    t.beam.visible = false;
    t.glare.visible = false;
    t.mark.visible = false;
    this.hunters = this.startCrew.slice();
  }

  /** Caught in the locker room: back to the checkpoint, the alarm and the scouts gone, the door bolted again. */
  _resetLockers() {
    const { player } = this;
    const L = this.lockers;
    const cp = this._checkpoint();
    this.lockerToken++;
    if (this.alarm) {
      this.alarm = null;
      stopAlarm();
      L.setAlarm(false);
    }
    this._endGrab();
    this._parkBackup();
    L.entryDoor.reset();
    if (this.hiding) {
      const spot = this.hiding.spot;
      this.hiding = null;
      spot.target = 0;
      spot.speed = 3;
      if (spot.leaf) spot.leaf.visible = true;
      this.hud.hide.className = '';
    }
    for (const s of this.spots) {
      s.target = 0;
      s.open = 0;
      s.setAngle(0);
      if (s.leaf) s.leaf.visible = true;
    }
    L.setHover(null);
    this.ui.setPrompt(null);
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.movementFrozen = false;
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(cp.pos, cp.yaw, 0.02);
    player.setColliders(L.colliders);
    player.setInteractables(L.interactables);
    this.ui.setFlashlight(false);
    this._rebuildLockerBoxes();
    this._startScouts(cp.pos); // (the two ELDARs back on their loops, away from you)
    // Billing (and on Hard Mode, Tom) restart their rounds from the stop farthest from you
    // (and from each other).
    const placed = [cp.pos];
    for (const h of this.startCrew) {
      h.patrolFrom(this._farthestStop(h, placed), true);
      h.markKind = null;
      placed.push(h.coach.position.clone());
    }
  }

  /** Through the double doors: the gym (and the fight) load behind the black. */
  async _enterGym() {
    const { player, director, wait } = this;
    const L = this.lockers;
    this.phase = 'toGym';
    this.cutscene = true;
    // Made it through the stealth half: who saw you, and did you ever use a light?
    if (!Achievements.flagged('ch3_spotted')) Achievements.unlock('shadow_walker');
    if (!Achievements.flagged('ch3_flashlight')) Achievements.unlock('blind_faith');
    for (const h of this.hunters) h.thinking = false;
    for (const s of this.sentries) s.thinking = false;
    this.stealth.meterEl.classList.add('hidden');
    this.hud.warning.classList.add('hidden');
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    L.setHover(null);
    stopAlarm();
    player.setInputLocked(true);
    player.setCameraOverride(true);
    const step = L.gymDoorStep.clone().setY(1.6);
    player.setLookTarget(L.gymDoorLook);
    await director.moveCamera([step], [Math.max(0.4, this.camera.position.distanceTo(step) / 3)]);
    L.gymDoors.open();
    await wait(0.5);
    await director.moveCamera([L.gymDoorLook.clone().setY(1.6).add(new THREE.Vector3(1.4, 0, 0))], [0.7]);
    await director.fader.to(1, 0.35);
    this._loadGym();
  }

  _loadGym() {
    const L = this.lockers;
    this.location = 'gym';
    this.hunters = [];
    this.sentries = [];
    this.spots = [];
    this.scouts = [];
    this.billing = null;
    this.backup = null;
    this.tom = null;
    this.hale = null;
    this.lockerCrew = [];
    this.startCrew = [];
    this.peeks = null;
    this.lockers = null;
    this.phase = 'gym';
    if (!this.gym) {
      this.gym = new GymFinale({
        renderer: this.renderer,
        camera: this.camera,
        player: this.player,
        director: this.director,
        dialogue: this.dialogue,
        wait: this.wait,
        ui: this.ui,
        NavGrid,
      });
    }
    this.gym.start();
    this.cutscene = false; // (the gym runs its own cutscenes from here)
    this.ui.disposeScene(L.scene); // the locker room's gone for good
  }

  // ---- Hooks main.js calls -------------------------------------------------------------

  handleInteract(target) {
    if (this.location === 'gym' && this.gym) {
      this.gym.handleInteract(target);
      return;
    }
    const data = target.userData;
    switch (data.type) {
      case 'ch3-hide':
        this._enterHide(data.spot);
        break;
      case 'ch3-locker-door':
        if (this.phase !== 'sneak') break;
        if (this.hunted) this.ui.showMessage("They're right on you. Lose them before you go in!", 2600);
        else this._playInfiltration();
        break;
      case 'ch3-locked':
        this.ui.showMessage('Chained shut from the inside. Billing locked himself in.', 2600);
        break;
      case 'ch3-hall-door':
        this.ui.showMessage("Chained from the hallway side. The gym's the only way on.", 2600);
        break;
      case 'ch3-gym-door':
        if (this.phase !== 'lockerSneak' || this.grab) break;
        if (this.hunted) this.ui.showMessage("He's right on you. Lose him before you go through!", 2600);
        else this._enterGym();
        break;
      default:
        break;
    }
  }

  /** [E] with nothing targeted: step out of a hiding spot. Returns true if it used the press. */
  onUse() {
    if (this.hiding && !this.hiding.yanked && this.sneaking) {
      this._exitHide();
      return true;
    }
    return false;
  }

  /** Where main.js should put the bobbing objective marker (or null). */
  markerTarget() {
    if (this.location === 'gym' && this.gym) return this.gym.markerTarget();
    if (this.cutscene || this.hiding) return null;
    if (this.phase === 'sneak') return { key: 'ch3-locker', position: this.world.lockerRoomDoor.marker, scale: 1.1 };
    if (this.phase === 'lockerSneak' && this.lockers) return { key: 'ch3-gym-doors', position: this.lockers.markers.gymDoor, scale: 0.8 };
    return null;
  }
}

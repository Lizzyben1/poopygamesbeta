import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  playGunshot,
  playReloadStep,
  playEmptyClick,
  playHitmarker,
  playBoltFire,
  playBoltImpact,
  playRobotCharge,
  playRobotDeath,
  playLanding,
  playBossRoar,
  playStomp,
  playElectricStun,
  playBottleThrow,
  playBottleSmash,
  playExplosion,
  playPlayerHurt,
  playRicochet,
  playShieldBash,
  playMetalTear,
  playPillarShatter,
  playLaserCharge,
  playLaserBeam,
  playMissileLaunch,
  playEruption,
  playTankCannon,
  playMechStep,
  playSteamVent,
  playMechExplosion,
  playPunchWhoosh,
  playPunchHit,
  playBlock,
  playGlassShatter,
  playParry,
  playHeadsetShatter,
  playLowHeartbeat,
  setLowHealth,
} from './audio.js';
import { difficulty, sandbox } from './difficulty.js';
import { createHumanoid, COACH_BILLING_LOOK, setSeatedPose } from './world.js';
import { createMarkTexture } from './stealth.js';
import { Achievements } from './achievements.js';

/*
 * Chapter 2 combat systems:
 *   - the player's assault rifle: viewmodel (its own scene, drawn over the
 *     world), hitscan bullets, muzzle flash, recoil, 30-round mag, [R] reload
 *   - ELDAR units with zone hitboxes, floating health bars and plasma bolts you
 *     can dodge or hide from. Standard units run and gun; shield units keep the
 *     shield square to you (only their feet take damage) and bash you up close.
 *     Rigs are pooled and share merged geometry.
 *   - Other Ben as a (not very accurate) second gun
 *   - the ELDAR Titan: frontal armor, a red core on its back behind shutters
 *     that only open while it's shorted out by a thrown water bottle, and a
 *     pillar shield phase in the middle
 *   - pooled effects (sparks, tracers, flashes, rings, arcs, debris) and the combat HUD
 * chapter2_lab.js scripts the waves, the cover, and the story around it.
 */

// ---- Tunables (the difficulty lives here) ------------------------------------
export const RIFLE = {
  magazine: 30,
  fireInterval: 0.095, // ~630 rpm
  reloadTime: 1.8,
  damage: 20,
  headMult: 2.5,
  range: 90,
  baseSpread: 0.004, // radians
  maxSpread: 0.03,
  spreadPerShot: 0.0035,
  spreadRecover: 0.06, // per second
};
const PLAYER_MAX_HP = 100;
const REGEN_DELAY = 8.0; // seconds without taking damage before you heal
const REGEN_RATE = 10; // hp per second
const LOW_HP = 0.3; // below this fraction of your health: the red pulse, the heartbeat, the ducked mix
/**
 * Hitstop: whole frames the game holds still (the render keeps going) when a punch lands.
 * main.js reads it every frame; landing a punch sets it.
 */
export const hitstop = { frames: 0 };
// A landed punch's camera kick: it snaps to the offset and springs back over this long.
const KICK_TIME = 0.14;
// Run-and-gun: they shoot while they move (a short charge-up glow is the tell).
export const ELDAR_STATS = {
  standard: {
    hp: 100, speed: 2.6, travelSpeed: 4.4, burst: 4, shotGap: 0.12, cooldown: [1.3, 2.2], telegraph: 0.4,
    damage: 4, spread: 0.02, boltSpeed: 24, range: 40,
  },
  // Armored + a riot shield that always faces you: only the feet / lower legs take
  // damage. Up close it bashes you with the shield.
  shield: {
    hp: 80, speed: 2.3, travelSpeed: 3.6, burst: 2, shotGap: 0.18, cooldown: [2.4, 3.4], telegraph: 0.5,
    damage: 5, spread: 0.03, boltSpeed: 21, range: 30,
    bashRange: 1.8, bashDamage: 25, bashCooldown: 2.2,
  },
  // Chapter 3's heavies: 3x a standard's armor, slow, and a shoulder cannon whose
  // big, slow shells burst (splash) wherever they land.
  tank: {
    hp: 300, speed: 1.45, travelSpeed: 2.3, burst: 1, shotGap: 0.2, cooldown: [2.6, 3.5], telegraph: 0.95,
    damage: 26, spread: 0.012, boltSpeed: 12, range: 48, splash: 3.2,
  },
  // The secret chapter's scrap ELDARs: rusted, fast and unarmed. They run straight for
  // combat.rushTarget (Other Ben's terminal), and maul whoever is standing in the way.
  scrap: {
    hp: 75, speed: 4.6, travelSpeed: 5.4, burst: 0, shotGap: 0.2, cooldown: [9, 9], telegraph: 0.4,
    damage: 0, spread: 0, boltSpeed: 20, range: 0, rush: true, meleeDamage: 9, meleeGap: 0.9,
  },
};
// Armored scrap rushers: a riot shield (only the feet take damage) and a lot of steel, still sprinting for the terminal.
const RUSH_SHIELD = { ...ELDAR_STATS.shield, hp: 130, speed: 3.7, travelSpeed: 4.3, rush: true, meleeDamage: 12, meleeGap: 1.0, bashRange: 0 };
const BOLT_SPEED = 21;
const LEAD = 0.5; // how much ELDARs lead a moving target (0 = aim where you are, 1 = perfect lead)
export const BOSS = {
  coreHp: 100, // 5 rifle hits on the core, in each exposed phase (1 and 3)
  stunTime: 6.5, // how long a water bottle shorts it out (the core is open)
  scale: 2.6,
  stompRadius: 8.0,
  stompDamage: 50,
  boltDamage: 8, // fan volleys
  sweepDamage: 7, // the raking stream
  pillarHp: 1500, // phase 2: ~75 rifle hits of sustained fire
  // Per phase: 1 = exposed, 2 = behind the pillar shield, 3 = exposed + angry.
  turnRate: [1.25, 1.1, 1.8], // rad/s: slow enough to lose you while stunned
  walkSpeed: [1.35, 1.0, 1.9],
  attackEvery: [2.0, 2.6, 1.5], // seconds of walking between attacks
  fanBolts: [11, 9, 13], // per row, 0.06 rad apart: standing still eats a couple per row
  fanRows: [3, 2, 3],
  sweepBolts: [24, 18, 30],
};
const BEN_GUN = { burstGap: [1.3, 2.4], shots: [3, 5], hitChance: 0.33, damage: 14 };

const rand = (a, b) => a + Math.random() * (b - a);
const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _ray = new THREE.Ray();
const _hitPoint = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function dampAngle(current, target, t) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}

/** Turn toward `target` by at most `maxStep` radians. */
function turnToward(current, target, maxStep) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + THREE.MathUtils.clamp(diff, -maxStep, maxStep);
}

/** Distance along a ray to the nearest of `boxes` (or `far` if nothing's closer). */
function rayBoxes(origin, dir, boxes, far) {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);
  let best = far;
  for (let i = 0; i < boxes.length; i++) {
    if (_ray.intersectBox(boxes[i], _hitPoint)) {
      const d = _hitPoint.distanceTo(origin);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function radialTexture(size, stops) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([at, color]) => grad.addColorStop(at, color));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Muzzle flash: a hot core with spiky petals. */
function createFlashTexture() {
  const c = makeCanvas(128);
  const g = c.getContext('2d');
  g.translate(64, 64);
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7 + Math.random() * 0.3);
    const len = 38 + Math.random() * 24;
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,240,200,1)');
    grad.addColorStop(1, 'rgba(255,150,40,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -7);
    g.lineTo(len, 0);
    g.lineTo(0, 7);
    g.closePath();
    g.fill();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  core.addColorStop(0, 'rgba(255,255,240,1)');
  core.addColorStop(0.4, 'rgba(255,210,120,0.8)');
  core.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = core;
  g.fillRect(-30, -30, 60, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft ring for dust/shockwaves and the stomp warning. */
function createRingTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.15)');
  grad.addColorStop(0.9, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// The assault rifle (armory display, Ben's gun, and your viewmodel)
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);

function put(list, geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  geo.applyMatrix4(_m4.compose(_v1.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _one));
  list.push(geo);
  return geo;
}

let rifleGeometries = null;
/** Rifle standing muzzle-up: length along +Y, magazine/grip side toward +Z. The magazine is separate (reloads). */
export function buildRifleGeometries() {
  if (rifleGeometries) return rifleGeometries;
  const polymer = [];
  const metal = [];
  const magazine = [];
  put(metal, new THREE.BoxGeometry(0.05, 0.32, 0.075), 0, 0, 0); // receiver
  put(polymer, new THREE.BoxGeometry(0.052, 0.28, 0.066), 0, 0.3, 0); // handguard
  put(metal, new THREE.CylinderGeometry(0.011, 0.011, 0.26, 8), 0, 0.57, -0.005); // barrel
  put(metal, new THREE.CylinderGeometry(0.018, 0.018, 0.06, 8), 0, 0.72, -0.005); // muzzle brake
  put(magazine, new THREE.BoxGeometry(0.04, 0.2, 0.065), 0, 0.03, 0.105, -0.28); // curved magazine
  put(polymer, new THREE.BoxGeometry(0.04, 0.11, 0.05), 0, -0.13, 0.075, 0.35); // pistol grip
  put(polymer, new THREE.BoxGeometry(0.045, 0.24, 0.07), 0, -0.33, 0.01); // stock
  put(polymer, new THREE.BoxGeometry(0.05, 0.03, 0.1), 0, -0.46, 0.02); // butt pad
  put(metal, new THREE.BoxGeometry(0.03, 0.4, 0.02), 0, 0.1, -0.048); // top rail
  put(metal, new THREE.CylinderGeometry(0.022, 0.022, 0.11, 10), 0, 0.02, -0.078); // optic
  put(polymer, new THREE.BoxGeometry(0.035, 0.05, 0.04), 0, 0.18, 0.05); // foregrip
  rifleGeometries = { polymer: mergeGeometries(polymer), metal: mergeGeometries(metal), magazine: magazine[0] };
  return rifleGeometries;
}

/** A rifle as a Group (userData.magazine = the mag mesh, userData.muzzle = its tip). */
export function createRifleMesh(polymerMat, metalMat) {
  const geo = buildRifleGeometries();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo.polymer, polymerMat), new THREE.Mesh(geo.metal, metalMat));
  const magazine = new THREE.Mesh(geo.magazine, polymerMat);
  group.add(magazine);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.76, -0.005);
  group.add(muzzle);
  group.userData.magazine = magazine;
  group.userData.muzzle = muzzle;
  return group;
}

// ---------------------------------------------------------------------------
// ELDAR units: articulated rigs with zone hitboxes
// ---------------------------------------------------------------------------

export function createEldarMaterials() {
  return {
    plates: new THREE.MeshStandardMaterial({ color: 0xc3ccd4, metalness: 0.55, roughness: 0.32, emissive: 0x06303f }),
    joints: new THREE.MeshStandardMaterial({ color: 0x1c2328, metalness: 0.6, roughness: 0.45, emissive: 0x021018 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff3322 }),
    shield: new THREE.MeshStandardMaterial({ color: 0x2a3036, metalness: 0.7, roughness: 0.3, emissive: 0x140505 }),
    shieldTrim: new THREE.MeshBasicMaterial({ color: 0xff3a2a }),
    core: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
    barBg: new THREE.SpriteMaterial({ color: 0x160404, transparent: true, opacity: 0.85, depthWrite: false }),
    barFill: new THREE.SpriteMaterial({ color: 0xff3a2a, transparent: true, depthWrite: false }),
  };
}

// Every ELDAR shares one set of part geometries, built once and merged per
// joint + material: ~22 draw calls a unit instead of ~35, and a spawn uploads
// nothing new to the GPU (and leaves nothing behind for the garbage collector).
const _geoCache = new Map();
function cachedGeometry(key, build) {
  let geo = _geoCache.get(key);
  if (!geo) {
    geo = build();
    _geoCache.set(key, geo);
  }
  return geo;
}

/** Merge parts ([geometry, x, y, z, rx]) into one geometry. */
function mergeParts(parts) {
  return mergeGeometries(parts.map(([geo, x = 0, y = 0, z = 0, rx = 0]) =>
    geo.applyMatrix4(_m4.compose(_v1.set(x, y, z), _q.setFromEuler(_e.set(rx, 0, 0)), _one))));
}

function rigGeometries() {
  return cachedGeometry('eldar-rig', () => ({
    pelvis: mergeParts([[new THREE.BoxGeometry(0.36, 0.13, 0.2), 0, 0.96, 0]]),
    thigh: mergeParts([[new THREE.CylinderGeometry(0.085, 0.07, 0.4, 10), 0, -0.2, 0]]),
    kneeJoint: new THREE.SphereGeometry(0.07, 10, 8),
    shin: mergeParts([
      [new THREE.CylinderGeometry(0.07, 0.055, 0.42, 10), 0, -0.21, 0],
      [new THREE.BoxGeometry(0.1, 0.24, 0.05), 0, -0.2, 0.06], // shin guard
      [new THREE.BoxGeometry(0.13, 0.07, 0.27), 0, -0.495, 0.04], // foot
    ]),
    abdomen: mergeParts([[new THREE.CylinderGeometry(0.12, 0.14, 0.22, 12), 0, 0.1, 0]]),
    chest: mergeParts([
      [new THREE.BoxGeometry(0.42, 0.34, 0.24), 0, 0.37, 0],
      [new THREE.BoxGeometry(0.3, 0.12, 0.05), 0, 0.47, 0.12, -0.2], // collar
    ]),
    chestCore: mergeParts([[new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), 0, 0.36, 0.125, Math.PI / 2]]),
    neckJoints: mergeParts([
      [new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10), 0, 0.02, 0],
      [new THREE.BoxGeometry(0.17, 0.12, 0.05), 0, 0.15, 0.085], // faceplate
    ]),
    head: mergeParts([[new THREE.CapsuleGeometry(0.1, 0.1, 4, 12), 0, 0.17, 0]]),
    visor: mergeParts([[new THREE.BoxGeometry(0.15, 0.03, 0.02), 0, 0.17, 0.113]]),
    shoulderJoint: new THREE.SphereGeometry(0.085, 10, 8),
    upperArm: [-1, 1].map((s) => mergeParts([
      [new THREE.BoxGeometry(0.14, 0.12, 0.16), s * 0.02, 0.04, 0], // pauldron
      [new THREE.CylinderGeometry(0.055, 0.05, 0.3, 10), 0, -0.16, 0],
    ])),
    elbowJoints: mergeParts([
      [new THREE.SphereGeometry(0.05, 8, 6)],
      [new THREE.BoxGeometry(0.06, 0.12, 0.09), 0, -0.33, 0], // hand
    ]),
    cannonJoints: mergeParts([ // right forearm: elbow + hand + the cannon barrel
      [new THREE.SphereGeometry(0.05, 8, 6)],
      [new THREE.BoxGeometry(0.06, 0.12, 0.09), 0, -0.33, 0],
      [new THREE.CylinderGeometry(0.05, 0.056, 0.24, 10), 0, -0.2, 0.07],
    ]),
    forearm: mergeParts([[new THREE.CylinderGeometry(0.05, 0.042, 0.27, 10), 0, -0.15, 0]]),
    cannonGlow: mergeParts([[new THREE.CylinderGeometry(0.037, 0.037, 0.02, 12), 0, -0.33, 0.07]]),
    shieldSlab: mergeParts([[new THREE.BoxGeometry(0.95, 1.4, 0.07), 0, 0.15, 0.4]]),
    shieldTrim: mergeParts([
      [new THREE.BoxGeometry(0.95, 0.045, 0.08), 0, 0.83, 0.4],
      [new THREE.BoxGeometry(0.95, 0.045, 0.08), 0, -0.53, 0.4],
      [new THREE.BoxGeometry(0.05, 1.28, 0.08), 0, 0.15, 0.405],
    ]),
  }));
}

/**
 * An ELDAR unit for combat (feet at y=0, facing +Z): hip/knee/shoulder/elbow/
 * spine/neck pivots, an arm cannon on the right forearm, invisible hitboxes
 * tagged by zone (head, body, legs, foot, shield, core, pillar). `boss` adds
 * the Titan's chest armor and the shuttered core on its back.
 */
export function createEldarRig(mats, { shield = false, boss = false, tank = false, scrap = false, scale = 1 } = {}) {
  const G = rigGeometries();
  const plates = mats.plates.clone(); // per-unit, so hits can flash it
  const glow = mats.glow.clone(); // per-unit, so the cannon can charge up
  const root = new THREE.Group();
  root.rotation.order = 'YXZ'; // topple over along its own facing
  const body = new THREE.Group();
  root.add(body);
  const hitboxes = [];
  const part = (geo, mat, parent, x = 0, y = 0, z = 0, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    parent.add(m);
    return m;
  };
  const hitbox = (w, h, d, parent, zone, x = 0, y = 0, z = 0) => {
    const geo = cachedGeometry(`hitbox:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
    const m = part(geo, mats.hidden, parent, x, y, z);
    m.userData.zone = zone;
    hitboxes.push(m);
    return m;
  };

  part(G.pelvis, mats.joints, body);
  hitbox(0.42, 0.46, 0.28, body, 'legs', 0, 0.76, 0);
  const legs = [-1, 1].map((s) => {
    const hip = new THREE.Group();
    hip.position.set(s * 0.12, 0.96, 0);
    body.add(hip);
    part(G.thigh, plates, hip);
    const knee = new THREE.Group();
    knee.position.y = -0.43;
    hip.add(knee);
    part(G.kneeJoint, mats.joints, knee);
    part(G.shin, plates, knee);
    hitbox(0.22, 0.38, 0.36, knee, 'foot', 0, -0.35, 0.03); // the lower leg: shin + foot
    return { hip, knee };
  });

  const torso = new THREE.Group();
  torso.position.y = 1.0;
  body.add(torso);
  part(G.abdomen, mats.joints, torso);
  part(G.chest, plates, torso);
  part(G.chestCore, glow, torso);
  hitbox(0.5, 0.62, 0.32, torso, 'body', 0, 0.3, 0);

  const neck = new THREE.Group();
  neck.position.y = 0.6;
  torso.add(neck);
  part(G.neckJoints, mats.joints, neck);
  part(G.head, plates, neck);
  part(G.visor, glow, neck);
  hitbox(0.28, 0.32, 0.3, neck, 'head', 0, 0.16, 0);

  // Anatomical right = -X (index 0), like the humanoids. The cannon rides the right forearm.
  const arms = [-1, 1].map((s, i) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.28, 0.49, 0);
    torso.add(shoulder);
    part(G.shoulderJoint, mats.joints, shoulder);
    part(G.upperArm[i], plates, shoulder);
    const elbow = new THREE.Group();
    elbow.position.y = -0.34;
    shoulder.add(elbow);
    part(i === 0 ? G.cannonJoints : G.elbowJoints, mats.joints, elbow);
    part(G.forearm, plates, elbow);
    return { shoulder, elbow };
  });
  const cannonArm = arms[0].elbow;
  part(G.cannonGlow, glow, cannonArm);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -0.37, 0.07);
  cannonArm.add(muzzle);

  if (shield) {
    // Riot shield braced in front: covers everything from the shins up.
    part(G.shieldSlab, mats.shield, torso);
    part(G.shieldTrim, mats.shieldTrim, torso);
    hitbox(1.0, 1.44, 0.16, torso, 'shield', 0, 0.15, 0.4);
  }

  let core = null;
  let shutters = null;
  if (boss) {
    part(new THREE.BoxGeometry(0.56, 0.42, 0.08), plates, torso, 0, 0.37, 0.15); // chest armor
    part(new THREE.BoxGeometry(0.66, 0.1, 0.3), plates, torso, 0, 0.58, 0); // shoulder yoke
    [-1, 1].forEach((s) => part(new THREE.BoxGeometry(0.035, 0.15, 0.035), mats.joints, neck, s * 0.08, 0.33, -0.02)); // antennae
    part(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 16), mats.joints, torso, 0, 0.36, -0.15, Math.PI / 2); // core housing
    core = part(new THREE.SphereGeometry(0.1, 16, 12), mats.core.clone(), torso, 0, 0.36, -0.17);
    shutters = [-1, 1].map((s) => part(new THREE.BoxGeometry(0.13, 0.27, 0.03), plates, torso, s * 0.066, 0.36, -0.205));
    hitbox(0.28, 0.3, 0.12, torso, 'core', 0, 0.36, -0.2);
  }

  let tankMuzzle = null;
  if (tank) {
    // Heavier plating, a power pack, big pauldrons and a cannon over the right shoulder.
    plates.color.setHex(0x8b949c);
    const g = (key, build) => cachedGeometry(key, build);
    part(g('tank-chest', () => new THREE.BoxGeometry(0.56, 0.42, 0.1)), plates, torso, 0, 0.36, 0.15);
    part(g('tank-pack', () => new THREE.BoxGeometry(0.5, 0.48, 0.18)), mats.joints, torso, 0, 0.36, -0.2);
    [-1, 1].forEach((s) => part(g('tank-pauldron', () => new THREE.BoxGeometry(0.22, 0.16, 0.28)), plates, torso, s * 0.33, 0.6, 0));
    part(g('tank-stripe', () => new THREE.BoxGeometry(0.46, 0.04, 0.02)), glow, torso, 0, 0.2, 0.205);
    const cannon = new THREE.Group();
    cannon.position.set(-0.24, 0.74, 0.02);
    torso.add(cannon);
    part(g('tank-barrel', () => new THREE.CylinderGeometry(0.075, 0.095, 0.66, 12)), mats.joints, cannon, 0, 0, 0.2, Math.PI / 2);
    part(g('tank-muzzle', () => new THREE.CylinderGeometry(0.1, 0.1, 0.08, 12)), glow, cannon, 0, 0, 0.52, Math.PI / 2);
    part(g('tank-mount', () => new THREE.BoxGeometry(0.16, 0.14, 0.22)), plates, cannon, 0, -0.08, -0.06);
    tankMuzzle = new THREE.Object3D();
    tankMuzzle.position.set(0, 0, 0.58);
    cannon.add(tankMuzzle);
  }

  if (scrap) {
    // Salvage: rust-stained, mismatched plating, a bent antenna and a scavenged power pack on its back.
    plates.color.setHex(0x8f7a66);
    plates.metalness = 0.3;
    plates.roughness = 0.75;
    const g = (key, build) => cachedGeometry(key, build);
    part(g('scrap-plate', () => new THREE.BoxGeometry(0.3, 0.24, 0.06)), mats.joints, torso, 0.06, 0.4, 0.15, 0.2);
    part(g('scrap-antenna', () => new THREE.BoxGeometry(0.02, 0.24, 0.02)), mats.joints, neck, 0.07, 0.42, 0, 0);
    part(g('scrap-pack', () => new THREE.BoxGeometry(0.26, 0.3, 0.14)), mats.joints, torso, 0, 0.36, -0.19);
  }

  root.userData.rig = {
    body,
    torso,
    neck,
    hipR: legs[0].hip,
    hipL: legs[1].hip,
    kneeR: legs[0].knee,
    kneeL: legs[1].knee,
    shoulderR: arms[0].shoulder,
    shoulderL: arms[1].shoulder,
    elbowR: arms[0].elbow,
    elbowL: arms[1].elbow,
    phase: Math.random() * Math.PI * 2,
  };
  root.scale.setScalar(scale);
  return { root, rig: root.userData.rig, hitboxes, muzzle: tankMuzzle || muzzle, plates, glow, core, shutters };
}

/** Back to the neutral pose (a pooled rig being reused). */
function resetRigPose(root) {
  const r = root.userData.rig;
  [r.body, r.torso, r.neck, r.hipR, r.hipL, r.kneeR, r.kneeL, r.shoulderR, r.shoulderL, r.elbowR, r.elbowL].forEach((j) => {
    j.rotation.set(0, 0, 0);
  });
  r.body.position.y = 0;
  root.rotation.set(0, 0, 0);
}

/**
 * Pose an ELDAR rig. p = { speed, aim, crouch, air, kneel, lift, shield, flinch,
 * roar, bash, pillar, reach, pull }, blend weights 0..1 (speed in m/s; bash -1..1:
 * pulled back / thrust). Stiff, mechanical, no bounce.
 */
export function animateEldar(rig, dt, p) {
  const k = Math.min(1, dt * 14);
  const set = (joint, value) => {
    joint.rotation.x += (value - joint.rotation.x) * k;
  };
  const setZ = (joint, value) => {
    joint.rotation.z += (value - joint.rotation.z) * k;
  };
  const moving = p.speed > 0.1;
  if (moving) rig.phase += dt * (3.2 + p.speed * 1.6);
  const s = moving ? Math.sin(rig.phase) : 0;
  const w = moving ? Math.min(1, p.speed / 1.6) : 0;
  const c = Math.max(p.crouch || 0, p.kneel || 0);
  const air = p.air || 0;
  const lift = p.lift || 0;
  const roar = p.roar || 0;
  const bash = p.bash || 0;
  const reach = p.reach || 0; // both arms out in front (gripping the wall pillar)
  const pull = p.pull || 0; // leaning back, hauling on it

  set(rig.hipL, s * 0.5 * w - 1.4 * c - 0.8 * air + 0.25 * pull);
  set(rig.hipR, -s * 0.5 * w - 1.4 * c - 0.8 * air - 1.25 * lift - 0.35 * pull);
  set(rig.kneeL, Math.max(0, s) * 0.8 * w + 0.05 + 2.3 * c + 1.3 * air + 0.3 * pull);
  set(rig.kneeR, Math.max(0, -s) * 0.8 * w + 0.05 + 2.3 * c + 1.3 * air + 1.4 * lift + 0.5 * pull);
  // Right arm = the cannon: straight out in front when aiming.
  const aimR = THREE.MathUtils.lerp(s * 0.35 * w - 0.2 * c, -1.52, p.aim || 0) - 2.2 * air - 0.9 * roar;
  set(rig.shoulderR, THREE.MathUtils.lerp(aimR, -1.45, reach));
  set(rig.elbowR, THREE.MathUtils.lerp(THREE.MathUtils.lerp(-0.3, -0.04, p.aim || 0), -0.25, reach));
  if (reach > 0.01) {
    set(rig.shoulderL, THREE.MathUtils.lerp(-0.3, -1.45, reach));
    set(rig.elbowL, -0.25);
  } else if (p.pillar) {
    // Hauling the pillar in front like a tower shield.
    set(rig.shoulderL, -0.95 + 0.25 * roar);
    set(rig.elbowL, -1.0);
  } else if (p.shield) {
    // Riot shield braced in front; a bash pulls it back, then drives it forward.
    set(rig.shoulderL, -0.55 - 0.55 * Math.max(0, bash) + 0.35 * Math.max(0, -bash));
    set(rig.elbowL, -1.35 + 0.95 * Math.max(0, bash));
  } else {
    set(rig.shoulderL, -s * 0.35 * w - 0.2 * c - 2.2 * air - 0.9 * roar);
    set(rig.elbowL, -0.3 - 0.3 * c);
  }
  setZ(rig.shoulderL, 0.9 * roar * (p.pillar ? 0.3 : 1));
  setZ(rig.shoulderR, -0.9 * roar - 0.3 * (p.pillar || 0)); // with the pillar up, the cannon arm swings out past it
  set(rig.torso, 0.06 * w + 0.55 * c + 0.3 * (p.kneel || 0) + (p.flinch || 0) - 0.25 * roar + 0.28 * bash + 0.2 * reach - 0.45 * pull);
  set(rig.neck, 0.5 * (p.kneel || 0) - 0.35 * roar);
  // -0.58 keeps the feet on the floor at full crouch (thigh 0.43 + shin 0.53 folded).
  rig.body.position.y += (-0.58 * c - 0.08 * air - 0.06 * pull - rig.body.position.y) * k;
}

// ---------------------------------------------------------------------------
// The structural pillar the Titan rips out of the wall (the wall mount in the
// lab and the shield it carries are the same model)
// ---------------------------------------------------------------------------

export const PILLAR_SIZE = { width: 2.3, height: 4.6, depth: 0.5 };

let pillarGeometries = null;
/** H-beam column + the wall plating bolted to it, centered, long axis +Y, plating toward -Z. */
function buildPillarGeometries() {
  if (pillarGeometries) return pillarGeometries;
  const H = PILLAR_SIZE.height;
  const beam = [];
  const plateL = [];
  const plateR = [];
  const bolts = [];
  put(beam, new THREE.BoxGeometry(0.62, H, 0.07), 0, 0, 0.2); // front flange
  put(beam, new THREE.BoxGeometry(0.62, H, 0.07), 0, 0, -0.14); // back flange
  put(beam, new THREE.BoxGeometry(0.08, H, 0.3), 0, 0, 0.03); // web
  for (let y = -H / 2 + 0.5; y < H / 2; y += 1.1) put(beam, new THREE.BoxGeometry(0.62, 0.06, 0.34), 0, y, 0.03); // stiffeners
  for (const [list, s] of [[plateL, -1], [plateR, 1]]) {
    put(list, new THREE.BoxGeometry(0.86, H - 0.1, 0.06), s * 0.72, 0, -0.2); // torn-off wall plating
    put(list, new THREE.BoxGeometry(0.1, H - 0.1, 0.1), s * 1.12, 0, -0.19); // its bent edge
  }
  for (let y = -H / 2 + 0.3; y < H / 2; y += 0.55) {
    for (const x of [-0.22, 0.22]) put(bolts, new THREE.CylinderGeometry(0.035, 0.035, 0.05, 6), x, y, 0.25, Math.PI / 2);
  }
  pillarGeometries = {
    beam: mergeGeometries(beam),
    plates: [mergeGeometries(plateL), mergeGeometries(plateR)],
    bolts: mergeGeometries(bolts),
  };
  return pillarGeometries;
}

/**
 * A structural pillar as a Group: userData.plates = [left, right] (they tear off
 * as it takes damage), userData.beamMat (glows hot as it's shot to pieces).
 */
export function createStructuralPillar() {
  const geo = buildPillarGeometries();
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a545c, metalness: 0.75, roughness: 0.42, emissive: 0x000000 });
  const plating = new THREE.MeshStandardMaterial({ color: 0x5b666e, metalness: 0.6, roughness: 0.5 });
  const boltMat = new THREE.MeshStandardMaterial({ color: 0xb7a15a, metalness: 0.8, roughness: 0.35 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo.beam, steel), new THREE.Mesh(geo.bolts, boltMat));
  const plates = geo.plates.map((g) => {
    const m = new THREE.Mesh(g, plating);
    group.add(m);
    return m;
  });
  group.userData.plates = plates;
  group.userData.beamMat = steel;
  return group;
}

// ---------------------------------------------------------------------------
// Effects: sparks, tracers, flashes, floor rings, electric arcs (all pooled)
// ---------------------------------------------------------------------------

class Effects {
  constructor(scene) {
    this.scene = scene;
    const sparkTex = radialTexture(32, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    this.sparks = Array.from({ length: 120 }, () => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: sparkTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, vel: new THREE.Vector3(), life: 0, max: 1, size: 0.1, gravity: 9 };
    });
    this._spark = 0;

    this.tracers = Array.from({ length: 24 }, () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      return { line, life: 0 };
    });
    this._tracer = 0;

    const flashTex = createFlashTexture();
    this.flashes = Array.from({ length: 10 }, () => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, life: 0, max: 1, size: 1 };
    });
    this._flash = 0;

    const ringTex = createRingTexture();
    this.rings = Array.from({ length: 6 }, () => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, life: 0, max: 1, from: 1, to: 2 };
    });
    this._ring = 0;

    // Electric arcs around a stunned Titan: jagged segments re-rolled every few frames.
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(20 * 6 * 3), 3));
    this.arcs = new THREE.LineSegments(
      arcGeo,
      new THREE.LineBasicMaterial({ color: 0xaeeaff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.arcs.frustumCulled = false;
    this.arcs.visible = false;
    scene.add(this.arcs);
    this._arcTimer = 0;

    // Steel chunks (the pillar shield coming apart): tumble, bounce, sink away.
    const chunkGeo = new THREE.BoxGeometry(1, 1, 1);
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x4f5961, metalness: 0.7, roughness: 0.45 });
    this.debris = Array.from({ length: 18 }, () => {
      const mesh = new THREE.Mesh(chunkGeo, this.debrisMat);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, size: new THREE.Vector3(1, 1, 1) };
    });
    this._debris = 0;
  }

  /** Chunks of steel flung from `pos` (roughly along `dir` if given). */
  chunks(pos, { count = 5, speed = 5, size = 0.35, dir = null } = {}) {
    for (let i = 0; i < count; i++) {
      const d = this.debris[this._debris];
      this._debris = (this._debris + 1) % this.debris.length;
      d.mesh.visible = true;
      d.mesh.position.set(pos.x + rand(-0.3, 0.3), pos.y + rand(-0.4, 0.4), pos.z + rand(-0.3, 0.3));
      d.size.set(size * rand(0.5, 1.4), size * rand(0.3, 1.2), size * rand(0.15, 0.5));
      d.mesh.scale.copy(d.size);
      d.vel.set(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1)).normalize();
      if (dir) d.vel.addScaledVector(dir, 1.1).normalize();
      d.vel.multiplyScalar(speed * rand(0.5, 1.1));
      d.spin.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
      d.life = rand(3.5, 5);
    }
  }

  /** Burst of sparks. `dir` (optional) biases where they fly. */
  spark(pos, { count = 8, color = 0xffc070, speed = 4, size = 0.07, life = 0.35, gravity = 9, dir = null } = {}) {
    for (let i = 0; i < count; i++) {
      const s = this.sparks[this._spark];
      this._spark = (this._spark + 1) % this.sparks.length;
      s.sprite.visible = true;
      s.sprite.position.copy(pos);
      s.sprite.material.color.set(color);
      s.vel.set(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize();
      if (dir) s.vel.addScaledVector(dir, 1.2).normalize();
      s.vel.multiplyScalar(speed * rand(0.4, 1.1));
      s.life = s.max = life * rand(0.6, 1.2);
      s.size = size * rand(0.7, 1.3);
      s.gravity = gravity;
    }
  }

  tracer(from, to, color = 0xffe6a8) {
    const t = this.tracers[this._tracer];
    this._tracer = (this._tracer + 1) % this.tracers.length;
    const a = t.line.geometry.attributes.position;
    a.setXYZ(0, from.x, from.y, from.z);
    a.setXYZ(1, to.x, to.y, to.z);
    a.needsUpdate = true;
    t.line.material.color.set(color);
    t.line.visible = true;
    t.life = 0.06;
  }

  flash(pos, { size = 1, color = 0xffd9a0, life = 0.12 } = {}) {
    const f = this.flashes[this._flash];
    this._flash = (this._flash + 1) % this.flashes.length;
    f.sprite.visible = true;
    f.sprite.position.copy(pos);
    f.sprite.material.color.set(color);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.life = f.max = life;
    f.size = size;
  }

  /** Flat ring on the floor that grows from `from` to `to` meters radius. */
  ring(pos, { from = 0.5, to = 4, color = 0xbfd8e0, life = 0.7 } = {}) {
    const r = this.rings[this._ring];
    this._ring = (this._ring + 1) % this.rings.length;
    r.mesh.visible = true;
    r.mesh.position.set(pos.x, 0.03, pos.z);
    r.mesh.material.color.set(color);
    r.life = r.max = life;
    r.from = from;
    r.to = to;
  }

  /** Re-roll lightning between random pairs of `anchors` (world points) while active. */
  setArcs(anchors) {
    this.arcAnchors = anchors;
    this.arcs.visible = !!anchors;
  }

  _rollArcs() {
    const a = this.arcs.geometry.attributes.position;
    const pts = this.arcAnchors;
    for (let i = 0; i < 20; i++) {
      const p0 = pts[Math.floor(Math.random() * pts.length)];
      const p1 = pts[Math.floor(Math.random() * pts.length)];
      let x = p0.x;
      let y = p0.y;
      let z = p0.z;
      for (let j = 0; j < 3; j++) {
        const t = (j + 1) / 3;
        const nx = THREE.MathUtils.lerp(p0.x, p1.x, t) + (j < 2 ? rand(-0.35, 0.35) : 0);
        const ny = THREE.MathUtils.lerp(p0.y, p1.y, t) + (j < 2 ? rand(-0.35, 0.35) : 0);
        const nz = THREE.MathUtils.lerp(p0.z, p1.z, t) + (j < 2 ? rand(-0.35, 0.35) : 0);
        const o = (i * 3 + j) * 2;
        a.setXYZ(o, x, y, z);
        a.setXYZ(o + 1, nx, ny, nz);
        x = nx;
        y = ny;
        z = nz;
      }
    }
    a.needsUpdate = true;
    this.arcs.material.opacity = rand(0.5, 1);
  }

  update(dt) {
    for (const s of this.sparks) {
      if (!s.sprite.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.sprite.visible = false;
        continue;
      }
      s.vel.y -= s.gravity * dt;
      s.sprite.position.addScaledVector(s.vel, dt);
      if (s.sprite.position.y < 0.02) {
        s.sprite.position.y = 0.02;
        s.vel.y *= -0.3;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
      }
      const k = s.life / s.max;
      s.sprite.scale.setScalar(s.size * (0.4 + 0.6 * k));
      s.sprite.material.opacity = k;
    }
    for (const t of this.tracers) {
      if (!t.line.visible) continue;
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.06) * 0.85;
      if (t.life <= 0) t.line.visible = false;
    }
    for (const f of this.flashes) {
      if (!f.sprite.visible) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.sprite.visible = false;
        continue;
      }
      const k = f.life / f.max;
      f.sprite.scale.setScalar(f.size * (1.2 - 0.4 * k));
      f.sprite.material.opacity = k;
    }
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }
      const k = 1 - r.life / r.max;
      r.mesh.scale.setScalar(THREE.MathUtils.lerp(r.from, r.to, 1 - (1 - k) * (1 - k)));
      r.mesh.material.opacity = 1 - k;
    }
    if (this.arcs.visible) {
      this._arcTimer -= dt;
      if (this._arcTimer <= 0) {
        this._arcTimer = 0.05;
        this._rollArcs();
      }
    }
    for (const d of this.debris) {
      if (!d.mesh.visible) continue;
      d.life -= dt;
      const m = d.mesh;
      const half = d.size.y / 2;
      if (m.position.y > half + 0.01 || d.vel.y > 0) {
        d.vel.y -= 13 * dt;
        m.position.addScaledVector(d.vel, dt);
        m.rotation.x += d.spin.x * dt;
        m.rotation.y += d.spin.y * dt;
        m.rotation.z += d.spin.z * dt;
        if (m.position.y < half) {
          // Bounce (a little), then lie still.
          m.position.y = half;
          d.vel.y = Math.abs(d.vel.y) > 2 ? -d.vel.y * 0.3 : 0;
          d.vel.x *= 0.5;
          d.vel.z *= 0.5;
          d.spin.multiplyScalar(0.4);
        }
      }
      if (d.life < 1) m.scale.copy(d.size).multiplyScalar(Math.max(0.01, d.life)); // shrink away
      if (d.life <= 0) m.visible = false;
    }
  }

  clear() {
    this.sparks.forEach((s) => (s.sprite.visible = false));
    this.tracers.forEach((t) => (t.line.visible = false));
    this.flashes.forEach((f) => (f.sprite.visible = false));
    this.rings.forEach((r) => (r.mesh.visible = false));
    this.debris.forEach((d) => (d.mesh.visible = false));
    this.setArcs(null);
  }
}

// ---------------------------------------------------------------------------
// ELDAR plasma bolts: visible, dodgeable, blocked by cover
// ---------------------------------------------------------------------------

class Bolts {
  constructor(scene, effects, size = 56) {
    this.effects = effects;
    const glowTex = radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);
    const coreGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.55, 6);
    this.pool = Array.from({ length: size }, () => {
      const group = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffd6cc }));
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTex, color: 0xff3322, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      group.add(core, glow);
      group.visible = false;
      scene.add(group);
      return { group, core, glow, vel: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(), life: 0, damage: 0, explosive: 0 };
    });
    this._next = 0;
  }

  /** explosive = splash radius (a Tank's shells burst where they land). */
  fire(from, dir, { speed = BOLT_SPEED, damage = 7, size = 1, color = 0xff3322, explosive = 0 } = {}) {
    const b = this.pool[this._next];
    this._next = (this._next + 1) % this.pool.length;
    b.group.visible = true;
    b.group.position.copy(from);
    b.dir.copy(dir);
    b.vel.copy(dir).multiplyScalar(speed);
    b.group.quaternion.setFromUnitVectors(UP, dir);
    b.group.scale.setScalar(size);
    b.glow.scale.setScalar(explosive ? 0.9 : 0.5);
    b.glow.material.color.set(color);
    b.life = explosive ? 5 : 3;
    b.damage = damage;
    b.explosive = explosive;
  }

  update(dt, combat) {
    const p = combat.player.object.position;
    for (const b of this.pool) {
      if (!b.group.visible) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.group.visible = false;
        continue;
      }
      const pos = b.group.position;
      b.prev.copy(pos);
      pos.addScaledVector(b.vel, dt);
      const step = b.prev.distanceTo(pos);
      // Right at the camera the core would fill the screen for a frame: just the glow.
      b.core.visible = pos.distanceToSquared(p) > 1.2;
      // You: a vertical capsule from the knees to just over your eyes.
      let hitPlayer = false;
      for (let i = 1; i <= 3 && !hitPlayer; i++) {
        _v1.lerpVectors(b.prev, pos, i / 3);
        if (_v1.y > 0.25 && _v1.y < p.y + 0.15 && (_v1.x - p.x) ** 2 + (_v1.z - p.z) ** 2 < 0.42 * 0.42) hitPlayer = true;
      }
      if (hitPlayer) {
        b.group.visible = false;
        combat.damagePlayer(b.damage, b.prev);
        if (b.explosive) combat.explode(b.prev, b.explosive, 0);
        continue;
      }
      const wall = rayBoxes(b.prev, b.dir, combat.worldBoxes, step);
      if (wall < step || pos.y < 0.02) {
        b.group.visible = false;
        _v1.copy(b.prev).addScaledVector(b.dir, Math.min(wall, step));
        if (b.explosive) {
          combat.explode(_v1, b.explosive, b.damage * 0.75);
        } else {
          this.effects.spark(_v1, { count: 6, color: 0xff5a3a, speed: 3, size: 0.09, life: 0.3 });
          if (_v1.distanceToSquared(p) < 400) playBoltImpact();
        }
      }
    }
  }

  clear() {
    this.pool.forEach((b) => (b.group.visible = false));
  }
}

// ---------------------------------------------------------------------------
// Thrown water bottles (the Titan's weakness)
// ---------------------------------------------------------------------------

class Bottles {
  constructor(scene, effects) {
    this.effects = effects;
    const bottleMat = new THREE.MeshStandardMaterial({ color: 0xa6dcf2, roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.8 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x1e5fbf, roughness: 0.5 });
    this.pool = Array.from({ length: 4 }, () => {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.3, 10), bottleMat));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), capMat);
      cap.position.y = 0.165;
      group.add(cap);
      group.visible = false;
      scene.add(group);
      return { group, vel: new THREE.Vector3(), spin: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(), life: 0 };
    });
    this._next = 0;
  }

  throw(from, vel) {
    const b = this.pool[this._next];
    this._next = (this._next + 1) % this.pool.length;
    b.group.visible = true;
    b.group.position.copy(from);
    b.vel.copy(vel);
    b.spin.set(rand(8, 14), rand(-2, 2), rand(-3, 3));
    b.life = 4;
  }

  update(dt, combat) {
    for (const b of this.pool) {
      if (!b.group.visible) continue;
      b.life -= dt;
      const pos = b.group.position;
      b.prev.copy(pos);
      b.vel.y -= 9.8 * dt;
      pos.addScaledVector(b.vel, dt);
      b.group.rotation.x += b.spin.x * dt;
      b.group.rotation.y += b.spin.y * dt;
      b.group.rotation.z += b.spin.z * dt;
      const titan = combat.titan;
      const hit = titan && titan.active ? titan.hitTestBottle(pos) : null;
      if (hit) {
        this._smash(b, pos, 0x9fe8ff);
        if (hit === 'body') titan.stun();
        else if (combat.onBottleBlocked) combat.onBottleBlocked(); // shattered on the pillar shield
        continue;
      }
      const step = b.prev.distanceTo(pos);
      b.dir.subVectors(pos, b.prev).normalize();
      const wall = step > 1e-5 ? rayBoxes(b.prev, b.dir, combat.worldBoxes, step) : Infinity;
      if (wall < step || pos.y < 0.05 || b.life <= 0) this._smash(b, pos, 0xbfe9ff);
    }
  }

  _smash(b, pos, color) {
    b.group.visible = false;
    this.effects.spark(pos, { count: 16, color, speed: 3.5, size: 0.08, life: 0.5, gravity: 7 });
    playBottleSmash();
  }

  clear() {
    this.pool.forEach((b) => (b.group.visible = false));
  }
}

// ---------------------------------------------------------------------------
// Your assault rifle: viewmodel + firing + reload
// ---------------------------------------------------------------------------

/** A box stretched between two points (sleeves, forearms). */
function limb(from, to, thickness, material) {
  const len = from.distanceTo(to);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, len), material);
  mesh.position.lerpVectors(from, to, 0.5);
  mesh.lookAt(to);
  return mesh;
}

class Rifle {
  constructor(combat) {
    this.combat = combat;
    // Drawn in its own pass over the world so it never clips into walls.
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 10);
    this.scene.add(new THREE.AmbientLight(0x5a7c8c, 1.3));
    const key = new THREE.DirectionalLight(0xd8f6ff, 2.2);
    key.position.set(-1, 2, 1.5);
    const rim = new THREE.DirectionalLight(0x00e5ff, 0.9);
    rim.position.set(1.5, 0.4, -1);
    this.flashLight = new THREE.PointLight(0xffc27a, 0, 2.5, 2);
    this.flashLight.position.set(0.19, -0.14, -0.9);
    this.scene.add(key, rim, this.flashLight);

    this.rig = new THREE.Group(); // raise / bob / sway
    this.gun = new THREE.Group(); // recoil + reload motion (origin = the receiver)
    this.rig.add(this.gun);
    this.scene.add(this.rig);
    const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7, metalness: 0.15 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x353a3f, roughness: 0.35, metalness: 0.8 });
    this.model = createRifleMesh(polymer, metal);
    // Geometry is muzzle-up (+Y) with the magazine toward +Z: point the muzzle forward (-Z), magazine down.
    this.model.rotation.set(-Math.PI / 2, 0, Math.PI, 'ZYX');
    this.model.scale.setScalar(0.82);
    this.gun.add(this.model);
    this.magazine = this.model.userData.magazine;

    const sleeve = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a679, roughness: 0.8 });
    const hand = (x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.075, 0.1), skin);
      m.position.set(x, y, z);
      this.gun.add(m);
    };
    hand(0, -0.075, 0.1); // grip hand
    hand(0, -0.06, -0.24); // support hand under the handguard
    this.gun.add(limb(new THREE.Vector3(0.01, -0.1, 0.14), new THREE.Vector3(0.12, -0.32, 0.46), 0.085, sleeve));
    this.gun.add(limb(new THREE.Vector3(-0.02, -0.09, -0.2), new THREE.Vector3(-0.3, -0.32, 0.12), 0.085, sleeve));

    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: createFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.position.set(0, 0.012, -0.66);
    this.flash.visible = false;
    this.gun.add(this.flash);

    // A water bottle in your off hand during the Titan fight (lower left).
    this.bottle = new THREE.Group();
    this.bottle.add(new THREE.Mesh(
      new THREE.CylinderGeometry(0.034, 0.034, 0.3, 12),
      new THREE.MeshStandardMaterial({ color: 0xa6dcf2, roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.8 }),
    ));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), new THREE.MeshStandardMaterial({ color: 0x1e5fbf }));
    cap.position.y = 0.165;
    this.bottle.add(cap);
    this.bottle.position.set(-0.24, -0.2, -0.42);
    this.bottle.rotation.set(0.3, 0, 0.35);
    this.bottle.visible = false;
    this.scene.add(this.bottle);

    this.rest = new THREE.Vector3(0.19, -0.19, -0.36);
    this.equipped = false;
    this.dry = false; // out of spare magazines: no more reloads
    this.raise = 0;
    this.ammo = RIFLE.magazine;
    this.cooldown = 0;
    this.triggerHeld = false;
    this.spread = RIFLE.baseSpread;
    this.reloading = false;
    this.reloadT = 0;
    this._reloadStep = 0;
    this.kick = 0;
    this.knocked = 0;
    this.flashT = 0;
    this.time = 0;
    this.bobT = 0;
    this.sway = new THREE.Vector2();
    this._lastYaw = null;
    this._lastPitch = 0;
    this._clicked = false;
    this._basis = { right: new THREE.Vector3(), up: new THREE.Vector3(), fwd: new THREE.Vector3() };
  }

  equip() {
    this.equipped = true;
    this.raise = 0;
    this.ammo = RIFLE.magazine;
    this.reloading = false;
    this.rig.visible = true;
    this.combat.hud.setReload(null);
    this.combat.hud.setAmmo(this.ammo);
  }

  /** Put it away (the gym's first phase, and after it runs dry at the end). */
  unequip() {
    this.equipped = false;
    this.triggerHeld = false;
    this.reloading = false;
    this.rig.visible = false;
    this.flashLight.intensity = 0;
    this.combat.hud.setReload(null);
  }

  reload() {
    if (!this.equipped || this.reloading || this.ammo === RIFLE.magazine || this.raise < 1 || this.dry) return;
    this.reloading = true;
    this.reloadT = 0;
    this._reloadStep = 0;
    this.combat.hud.setReload(0);
  }

  /** Camera right / up / forward in world space. */
  basis() {
    const cam = this.combat.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const b = this._basis;
    b.right.set(e[0], e[1], e[2]);
    b.up.set(e[4], e[5], e[6]);
    b.fwd.set(-e[8], -e[9], -e[10]);
    return b;
  }

  /** Roughly where the muzzle is in the world (tracers start here). */
  muzzleWorld(out) {
    const b = this.basis();
    return out.copy(this.combat.camera.position).addScaledVector(b.right, 0.2).addScaledVector(b.up, -0.13).addScaledVector(b.fwd, 0.8);
  }

  update(dt) {
    if (!this.equipped) return;
    this.raise = Math.min(1, this.raise + dt / 0.5);
    this.cooldown -= dt;
    this.spread = Math.max(RIFLE.baseSpread, this.spread - RIFLE.spreadRecover * dt);
    const staggered = this.combat.player.isStumbling; // knocked flat by a shield bash
    if (this.reloading) {
      this._updateReload(dt);
    } else if (this.triggerHeld && this.raise >= 1 && this.cooldown <= 0 && !staggered) {
      if (this.ammo > 0) {
        this._fire();
      } else {
        if (!this._clicked) playEmptyClick();
        this._clicked = true;
        if (this.dry && this.combat.onDryFire) this.combat.onDryFire();
        this.reload();
      }
    }
    if (!this.triggerHeld) this._clicked = false;
    this._animate(dt);
  }

  _fire() {
    const combat = this.combat;
    const player = combat.player;
    if (!sandbox.infiniteAmmo) this.ammo--; // (Sandbox: the magazine never empties)
    combat.stats.shots++;
    this.cooldown = RIFLE.fireInterval;
    combat.hud.setAmmo(this.ammo);
    const b = this.basis();
    const spread = this.spread * (player.isMoving ? 1.6 : 1) * (player.isCrouching ? 0.7 : 1);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    const dir = _v2.copy(b.fwd).addScaledVector(b.right, Math.cos(a) * r).addScaledVector(b.up, Math.sin(a) * r).normalize();
    const muzzle = this.muzzleWorld(_v3);
    combat.fireHitscan(combat.camera.position, dir, muzzle, { damage: RIFLE.damage, shooter: 'player' });
    this.spread = Math.min(RIFLE.maxSpread, this.spread + RIFLE.spreadPerShot);
    this.kick = 1;
    this.flashT = 0.05;
    combat.muzzleFlash(muzzle);
    combat.recoil(0.0065 + Math.random() * 0.002, (Math.random() - 0.5) * 0.004);
    playGunshot();
    if (this.ammo === 0) this.reload();
  }

  _updateReload(dt) {
    this.reloadT += dt;
    const t = this.reloadT;
    if (t > 0.3 && this._reloadStep < 1) {
      this._reloadStep = 1;
      playReloadStep('out');
    }
    if (t > 1.0 && this._reloadStep < 2) {
      this._reloadStep = 2;
      playReloadStep('in');
    }
    if (t > 1.3 && this._reloadStep < 3) {
      this._reloadStep = 3;
      playReloadStep('rack');
      this.ammo = RIFLE.magazine;
      this.combat.hud.setAmmo(this.ammo);
    }
    this.combat.hud.setReload(Math.min(1, t / RIFLE.reloadTime));
    if (t >= RIFLE.reloadTime) {
      this.reloading = false;
      this.combat.hud.setReload(null);
    }
  }

  _animate(dt) {
    const player = this.combat.player;
    this.time += dt;
    // Sway: the gun lags a little behind where you're looking.
    _euler.setFromQuaternion(this.combat.camera.quaternion, 'YXZ');
    if (this._lastYaw === null) this._lastYaw = _euler.y;
    let dyaw = (_euler.y - this._lastYaw) % (Math.PI * 2);
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const dpitch = _euler.x - this._lastPitch;
    this._lastYaw = _euler.y;
    this._lastPitch = _euler.x;
    const sk = Math.min(1, dt * 8);
    this.sway.x += (THREE.MathUtils.clamp(-dyaw * 0.9, -0.05, 0.05) - this.sway.x) * sk;
    this.sway.y += (THREE.MathUtils.clamp(dpitch * 0.9, -0.05, 0.05) - this.sway.y) * sk;
    // Walk bob.
    const moving = player.isMoving;
    if (moving) this.bobT += dt * (player.isSprinting ? 13 : 9);
    const bobAmp = moving ? (player.isSprinting ? 1.6 : 1) : 0;
    const bobX = Math.sin(this.bobT) * 0.011 * bobAmp;
    const bobY = -Math.abs(Math.cos(this.bobT)) * 0.009 * bobAmp;
    const breathe = Math.sin(this.time * 1.6) * 0.003;
    const raise = 1 - (1 - this.raise) ** 3;
    const reloadP = this.reloading ? Math.sin(Math.min(1, this.reloadT / RIFLE.reloadTime) * Math.PI) : 0;
    const sprint = player.isSprinting ? 1 : 0;
    this.kick = Math.max(0, this.kick - dt * 10);
    this.knocked += ((player.isStumbling ? 1 : 0) - this.knocked) * Math.min(1, dt * 9);

    this.rig.position.set(
      this.rest.x + bobX + this.sway.x + this.knocked * 0.05,
      this.rest.y + bobY + breathe + this.sway.y - (1 - raise) * 0.35 - reloadP * 0.06 - sprint * 0.03 - this.knocked * 0.16,
      this.rest.z,
    );
    this.rig.rotation.z = this.knocked * -0.35;
    this.gun.position.set(0, 0, this.kick * 0.045);
    this.gun.rotation.set(this.kick * 0.06 - reloadP * 0.25 - sprint * 0.12, 0.05 + sprint * 0.25, reloadP * 0.55);

    // The magazine drops out, then a fresh one slides up into the well.
    let drop = 0;
    let shown = true;
    if (this.reloading) {
      const t = this.reloadT;
      if (t >= 0.3 && t < 0.55) drop = ((t - 0.3) / 0.25) * 0.35;
      else if (t >= 0.55 && t < 0.8) shown = false;
      else if (t >= 0.8 && t < 1.0) drop = (1 - (t - 0.8) / 0.2) * 0.25;
    }
    this.magazine.visible = shown;
    this.magazine.position.set(0, 0, drop); // model +Z = down on screen

    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    if (this.flash.visible) {
      this.flash.material.rotation = Math.random() * Math.PI * 2;
      this.flash.scale.setScalar(0.12 + Math.random() * 0.07);
    }
    this.flashLight.intensity = this.flashT > 0 ? 3 : 0;
    this.bottle.visible = this.combat.holding === 'bottle';
  }

  render(renderer) {
    if (!this.equipped && !(this.combat.fists && this.combat.fists.equipped)) return;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------------------
// Combat HUD (DOM): ammo, health, hit markers, damage vignette, boss bar
// ---------------------------------------------------------------------------

class CombatHud {
  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'combat-hud';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="ch-vignette"></div>
      <div class="ch-hitmarker"><i></i><i></i><i></i><i></i></div>
      <div class="ch-boss hidden">
        <div class="ch-boss-name">ELDAR TITAN</div>
        <div class="ch-boss-track"><div class="ch-boss-fill"></div><span style="left:50%"></span></div>
        <div class="ch-pillar hidden">
          <div class="ch-pillar-name">PILLAR SHIELD</div>
          <div class="ch-pillar-track"><div class="ch-pillar-fill"></div></div>
        </div>
      </div>
      <div class="ch-download">DOWNLOAD <b>0%</b></div>
      <div class="ch-timer hidden"></div>
      <div class="ch-warn hidden"></div>
      <div class="ch-callout"></div>
      <div class="ch-guard hidden">GUARD</div>
      <div class="ch-health"><span>HP</span><div class="ch-health-track"><div class="ch-health-fill"></div></div></div>
      <div class="ch-held hidden">WATER BOTTLE <span>[RMB] THROW</span></div>
      <div class="ch-ammo"><b>30</b><span>/ ∞</span><div class="ch-reload hidden"><div></div></div></div>
    `;
    document.getElementById('hud').appendChild(this.root);
    const q = (s) => this.root.querySelector(s);
    this.vignette = q('.ch-vignette');
    this.hitmarker = q('.ch-hitmarker');
    this.boss = q('.ch-boss');
    this.bossName = q('.ch-boss-name');
    this.bossFill = q('.ch-boss-fill');
    this.bossTick = q('.ch-boss-track span');
    this.pillar = q('.ch-pillar');
    this.pillarName = q('.ch-pillar-name');
    this.pillarFill = q('.ch-pillar-fill');
    this.timer = q('.ch-timer');
    this.warnEl = q('.ch-warn');
    this.calloutEl = q('.ch-callout');
    this.guard = q('.ch-guard');
    this.ammoBox = q('.ch-ammo');
    this.downloadBox = q('.ch-download');
    this._timerText = null;
    this.warnT = 0;
    this.calloutT = 0;
    this._bossW = -1;
    this._pillarW = -2;
    this.download = q('.ch-download b');
    this.healthFill = q('.ch-health-fill');
    this.held = q('.ch-held');
    this.ammo = q('.ch-ammo b');
    this.reload = q('.ch-reload');
    this.reloadFill = q('.ch-reload div');
    this.hitT = 0;
    this.hurt = 0;
    this.lowHp = 1;
    this.beat = 0; // 1 on each low-health heartbeat, fading: the red vignette pulses with it
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
  }

  setAmmo(n) {
    this.ammo.textContent = String(n);
    this.ammo.style.color = n <= 6 ? '#e0584f' : '';
  }

  setReload(p) {
    this.reload.classList.toggle('hidden', p === null);
    if (p !== null) this.reloadFill.style.width = `${Math.round(p * 100)}%`;
  }

  setHealth(frac) {
    this.healthFill.style.width = `${Math.max(0, frac) * 100}%`;
    this.healthFill.style.background = frac < 0.35 ? '#e0584f' : '';
    this.lowHp = frac;
  }

  /** 'hit' | 'head' | 'kill' | 'armor' */
  hit(kind) {
    this.hitT = kind === 'kill' ? 0.3 : 0.15;
    this.hitmarker.className = `ch-hitmarker show ${kind}`;
  }

  damaged(amount) {
    this.hurt = Math.min(1, this.hurt + amount / 30);
  }

  /** Called every frame: only touches the DOM when something changed. */
  setBoss(frac, pillarFrac = null) {
    const w = frac === null ? -1 : Math.round(Math.max(0, frac) * 400);
    if (w !== this._bossW) {
      if ((w === -1) !== (this._bossW === -1)) this.boss.classList.toggle('hidden', w === -1);
      this._bossW = w;
      if (w >= 0) this.bossFill.style.width = `${w / 4}%`;
    }
    const p = pillarFrac === null ? -1 : Math.round(Math.max(0, pillarFrac) * 400);
    if (p !== this._pillarW) {
      if ((p === -1) !== (this._pillarW === -1)) this.pillar.classList.toggle('hidden', p === -1);
      this._pillarW = p;
      if (p >= 0) this.pillarFill.style.width = `${p / 4}%`;
    }
  }

  setHeld(on) {
    this.held.classList.toggle('hidden', !on);
  }

  setDownload(pct) {
    this.download.textContent = `${Math.floor(pct)}%`;
  }

  // ---- Chapter 3's gym fight ----------------------------------------------------

  /** The boss bar's title, and the second bar's (null hides the halfway tick). */
  setBossName(name, tick = true) {
    this.bossName.textContent = name;
    this.bossTick.style.display = tick ? '' : 'none';
  }

  setSubName(name) {
    if (this.pillarName.textContent !== name) this.pillarName.textContent = name;
  }

  showDownload(on) {
    this.downloadBox.classList.toggle('hidden', !on);
  }

  showAmmo(on) {
    this.ammoBox.classList.toggle('hidden', !on);
  }

  /** The spare-magazines readout next to the ammo count ("/ ∞", "/ 0"). */
  setReserve(text) {
    this.ammoBox.querySelector('span').textContent = text;
  }

  /** "SURVIVE 0:42" under the boss bar (null hides it). */
  setTimer(text) {
    if (text === this._timerText) return;
    this._timerText = text;
    this.timer.classList.toggle('hidden', text === null);
    if (text !== null) this.timer.textContent = text;
  }

  /** A big warning in the middle of the screen: 'duck' | 'cover' | 'danger'. */
  warn(text, seconds = 1.5, kind = 'danger') {
    this.warnEl.textContent = text;
    this.warnEl.className = `ch-warn ${kind}`;
    this.warnT = seconds;
  }

  /** A quick word by the crosshair ("COUNTER!", "BLOCKED"). */
  callout(text, kind = '') {
    this.calloutEl.textContent = text;
    this.calloutEl.className = `ch-callout show ${kind}`;
    this.calloutT = 0.7;
  }

  setGuard(on) {
    this.guard.classList.toggle('hidden', !on);
  }

  update(dt) {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hitmarker.className = 'ch-hitmarker';
    }
    if (this.warnT > 0) {
      this.warnT -= dt;
      if (this.warnT <= 0) this.warnEl.className = 'ch-warn hidden';
    }
    if (this.calloutT > 0) {
      this.calloutT -= dt;
      if (this.calloutT <= 0) this.calloutEl.className = 'ch-callout';
    }
    this.hurt = Math.max(0, this.hurt - dt * 1.5);
    // Under 30% health the edges of the screen pulse red, in time with your heartbeat.
    this.beat = Math.max(0, this.beat - dt * 2.6);
    const danger = this.lowHp > 0 && this.lowHp < LOW_HP ? 1 - this.lowHp / LOW_HP : 0;
    const low = danger > 0 ? (0.2 + 0.3 * danger) * (0.5 + 0.5 * this.beat * this.beat) : 0;
    const v = Math.round(Math.min(1, this.hurt + low) * 50) / 50;
    if (v !== this._vignette) {
      this._vignette = v; // (only touch the DOM when it changes)
      this.vignette.style.opacity = String(v);
    }
  }
}

// ---------------------------------------------------------------------------
// ELDAR units (standard + shield)
// ---------------------------------------------------------------------------

const CALM_GLOW = new THREE.Color(1.0, 0.2, 0.13);
const SCRAP_GLOW = new THREE.Color(1.0, 0.55, 0.1);
const CHARGE_GLOW = new THREE.Color(1.0, 0.78, 0.62);
const PLATE_EMISSIVE = 0x06303f;
const HIT_EMISSIVE = 0x7a8c9c;

/**
 * Standard units run and gun: always on the move between firing positions,
 * shooting as they go (a short charge-up glow is the tell). Shield units march
 * straight at you with the shield locked square to you, fire now and then, and
 * bash you if you let them get close. Units coming in from the corridor use the
 * fallen pillar as cover once it's down, ducking behind it between bursts.
 */
class Eldar {
  /**
   * entry: { kind: 'pod', pos, yaw } | { kind: 'ladder', top } | { kind: 'door', inside, out, yaw } | { kind: 'drop', at }
   * options.cover: head for the cover behind the fallen pillar when it's there.
   */
  constructor(combat, type, entry, options = {}) {
    this.combat = combat;
    this.type = type;
    this.shielded = type === 'shield';
    this.heavy = type === 'tank';
    this.scrap = type === 'scrap';
    this.calmGlow = this.scrap ? SCRAP_GLOW : CALM_GLOW;
    this.meleeT = 0;
    this.selfDestruct = false; // a scrap unit that reached its target (not a kill)
    this.stats = options.rush && type === 'shield' ? RUSH_SHIELD : ELDAR_STATS[type];
    this.hp = this.maxHp = this.stats.hp;
    const built = combat.rigs.acquire(type); // pooled: no new meshes mid-fight
    this.built = built;
    this.root = built.root;
    this.mesh = this.root; // Player collision reads .mesh / .radius
    this.rig = built.rig;
    this.hitboxes = built.hitboxes;
    this.muzzle = built.muzzle;
    this.plates = built.plates;
    this.glow = built.glow;
    this.bar = built.bar;
    for (const h of this.hitboxes) h.userData.owner = this;
    this.radius = this.heavy ? 0.6 : this.scrap ? 0.34 : 0.38;
    this.wantsCover = !!options.cover;
    this.anim = { speed: 0, aim: 0, crouch: 0, air: 0, shield: this.shielded, flinch: 0, bash: 0, reach: 0 };
    this.state = 'enter'; // enter | fight | cover | bash | rush
    this.t = 0;
    this.entry = entry;
    this.route = [];
    this.spot = null;
    this.coverSlot = null;
    this.coverPhase = 'hidden';
    this.coverT = 0;
    this.holdT = 0;
    this.holdFor = 0;
    this.fireTimer = rand(0.5, 1.4);
    this.telegraph = 0;
    this.burstLeft = 0;
    this.shotGap = 0;
    this.flashT = 0;
    this.moveSpeed = 0;
    this.yaw = 0;
    this.vy = 0;
    this.landed = false;
    this.landT = 0;
    this.glowLevel = 1;
    this.dead = false;
    this.deathT = 0;
    this.removeMe = false;
    this.stuckT = 0;
    this.repathT = 0;
    this.bashT = 0;
    this.bashCooldown = 0.8;
    this.bashDone = false;
    this.sightT = Math.random() * 0.2; // line-of-sight checks are staggered across units
    this.hasSight = false;
    this._last = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._begin(entry);
  }

  get position() {
    return this.root.position;
  }

  get alive() {
    return !this.dead;
  }

  /** Out of its pod/door and in the fight (a valid target for Ben). */
  get engaged() {
    return !this.dead && this.state !== 'enter';
  }

  _begin(entry) {
    const pos = this.root.position;
    if (entry.kind === 'pod') {
      pos.set(entry.pos.x, 0.44, entry.pos.z); // standing on the pod's floor
      this.yaw = entry.yaw;
      this.glowLevel = 0; // wakes up
    } else if (entry.kind === 'ladder') {
      pos.copy(entry.top);
      this.yaw = Math.PI; // back to the rungs, facing down the corridor
      this.vy = 2.2; // a little hop off the top
      this.anim.air = 1;
    } else if (entry.kind === 'drop') {
      pos.set(entry.at.x, entry.height || 7.6, entry.at.z); // down through the ceiling hatch
      const pp = this.combat.player.object.position;
      this.yaw = Math.atan2(pp.x - pos.x, pp.z - pos.z);
      this.vy = 0;
      this.anim.air = 1;
    } else {
      pos.copy(entry.inside);
      this.yaw = entry.yaw;
    }
    this.root.rotation.y = this.yaw;
  }

  eye() {
    this.rig.neck.getWorldPosition(this._eye);
    this._eye.y += 0.15;
    return this._eye;
  }

  aimPoint(out) {
    this.rig.torso.getWorldPosition(out);
    out.y += 0.3;
    return out;
  }

  /** Where Other Ben's hits land (he doesn't aim for the feet). */
  benZone() {
    if (this.shielded) return Math.random() < 0.12 ? 'foot' : 'shield';
    return Math.random() < 0.12 ? 'head' : 'body';
  }

  update(dt) {
    this.t += dt;
    if (this.dead) this._updateDeath(dt);
    else if (this.state === 'enter') this._updateEntry(dt);
    else if (this.state === 'cover') this._updateCover(dt);
    else if (this.state === 'bash') this._updateBash(dt);
    else if (this.state === 'rush') this._updateRush(dt);
    else this._updateFight(dt);

    // Hit flash, cannon charge glow, pose, health bar.
    this.flashT = Math.max(0, this.flashT - dt);
    this.plates.emissive.setHex(this.flashT > 0 ? HIT_EMISSIVE : PLATE_EMISSIVE);
    this.glow.color.copy(this.telegraph > 0 ? CHARGE_GLOW : this.calmGlow).multiplyScalar(this.glowLevel);
    this.anim.speed = this.moveSpeed;
    this.anim.flinch = Math.max(0, this.anim.flinch - dt * 3);
    animateEldar(this.rig, dt, this.anim);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld(true);
    this.combat.updateHealthBar(this.bar, this, this.hp / this.maxHp);
  }

  _updateEntry(dt) {
    const e = this.entry;
    const pos = this.root.position;
    if (e.kind === 'pod') {
      // Visor powers up, then it steps down and out of the tube.
      this.glowLevel = Math.min(1, this.t / 0.6);
      if (this.t > 0.5) {
        const k = Math.min(1, (this.t - 0.5) / 0.8);
        pos.x = e.pos.x + Math.sin(e.yaw) * 1.25 * k;
        pos.z = e.pos.z + Math.cos(e.yaw) * 1.25 * k;
        pos.y = 0.44 * Math.max(0, 1 - k * 2);
        this.moveSpeed = k < 1 ? 1.4 : 0;
        if (k >= 1) this._startFight();
      }
    } else if (e.kind === 'ladder' || e.kind === 'drop') {
      // Drops the whole shaft (or through the ceiling hatch) and lands in a crouch.
      if (!this.landed) {
        this.vy -= 14 * dt;
        pos.y += this.vy * dt;
        if (e.kind === 'ladder') pos.z = Math.max(e.top.z - 0.9, pos.z - dt * 0.9);
        if (pos.y <= 0) {
          pos.y = 0;
          this.landed = true;
          this.landT = 0;
          this.anim.air = 0;
          this.anim.crouch = 1;
          if (this.combat.sfx('land', 0.08)) playLanding();
          this.combat.effects.ring(pos, { from: 0.3, to: 1.8, life: 0.5 });
          this.combat.effects.spark(pos, { count: 10, color: 0xffd08a, speed: 3, size: 0.06, life: 0.35 });
          this.combat.shakeFrom(pos, 0.5);
        }
      } else {
        this.landT += dt;
        if (this.landT > 0.35) this.anim.crouch = 0;
        if (this.landT > 0.6) this._startFight();
      }
    } else if (this.t > 0.5) {
      // Side door: wait for it to open, walk out.
      if (this._moveToward(e.out, 2.2, dt, false)) this._startFight();
    }
  }

  _startFight() {
    this.state = 'fight';
    this.anim.crouch = 0;
    if (this.stats.rush) {
      this.state = 'rush';
      this.route = [];
      this.repathT = 0;
      this.meleeT = 0.3;
      this.stuckT = 0;
      this._last.copy(this.root.position);
      return;
    }
    if (this.shielded) {
      this.route = [];
      this.repathT = 0;
    } else {
      this._pickDestination(null);
    }
  }

  _pickDestination(exclude) {
    const pick = this.combat.claimPosition(this, exclude);
    this.route = this.combat.navigate(this.root.position, pick.pos, pick.cover);
    this.holdT = 0;
    this.holdFor = rand(0.3, 1.1); // only a beat at each spot (it keeps shooting), then on to the next
    this.stuckT = 0;
    this._last.copy(this.root.position);
  }

  _relocate() {
    const old = this.spot || this.coverSlot;
    this.combat.releasePosition(this);
    this._pickDestination(old);
  }

  /** Line of sight to you, re-checked a few times a second. */
  _updateSight(dt) {
    this.sightT -= dt;
    if (this.sightT <= 0) {
      this.sightT = 0.2;
      this.hasSight = this.combat.canSeePlayer(this.eye());
    }
  }

  _updateFight(dt) {
    this._updateSight(dt);
    const pos = this.root.position;
    const pp = this.combat.player.object.position;
    const dist = Math.hypot(pp.x - pos.x, pp.z - pos.z);
    if (this.shielded) {
      this._updateShieldPush(dt, dist);
      return;
    }
    const inHall = this.combat.inTransit(pos); // still coming up the corridor: hurry
    const engaged = this.hasSight && dist < this.stats.range;
    // Always on the move: along the route, a beat at the spot (still shooting), then somewhere new.
    if (this.route.length) {
      let speed = inHall ? this.stats.travelSpeed : this.stats.speed;
      if (this.telegraph > 0 || this.burstLeft > 0) speed *= 0.55; // steadier while it fires
      if (this._moveToward(this.route[0], speed, dt, true, engaged)) this.route.shift();
      this._checkStuck(dt);
    } else {
      this.moveSpeed = 0;
      if (this.coverSlot) {
        this._enterCover();
        return;
      }
      this.holdT += dt;
      if (this.holdT > this.holdFor || dist < 4) this._relocate();
    }
    if (engaged) this._facePlayer(dt, 10);
    this.anim.aim += ((engaged ? 1 : inHall ? 0 : 0.5) - this.anim.aim) * Math.min(1, dt * 6);
    this._fireCycle(dt, engaged);
  }

  /** Shield unit: shield locked square to you, marching in; bashes when it gets close. */
  _updateShieldPush(dt, dist) {
    const pos = this.root.position;
    const pp = this.combat.player.object.position;
    this._facePlayer(dt, 18); // no lag: the shield stays on you whichever way it walks
    this.bashCooldown -= dt;
    if (dist < this.stats.bashRange && this.bashCooldown <= 0 && !this.combat.down) {
      this._startBash();
      return;
    }
    this.repathT -= dt;
    if (this.repathT <= 0) {
      this.repathT = 0.5;
      const dx = pos.x - pp.x;
      const dz = pos.z - pp.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d > 1.35) {
        this._goal.set(pp.x + (dx / d) * 1.2, 0, pp.z + (dz / d) * 1.2); // right up in your face
        this.route = this.combat.navigate(pos, this._goal, false);
      } else {
        this.route = [];
      }
    }
    if (this.route.length) {
      const inHall = this.combat.inTransit(pos);
      let speed = inHall ? this.stats.travelSpeed : this.stats.speed;
      if (this.telegraph > 0 || this.burstLeft > 0) speed *= 0.6;
      if (this._moveToward(this.route[0], speed, dt, true, true)) this.route.shift();
      this._checkStuck(dt);
    } else {
      this.moveSpeed = 0;
    }
    this.anim.aim += ((this.hasSight ? 1 : 0.3) - this.anim.aim) * Math.min(1, dt * 6);
    this._fireCycle(dt, this.hasSight && dist > 3 && dist < this.stats.range);
  }

  /**
   * Scrap units (the secret chapter): sprint at combat.rushTarget, and stop to maul whatever is
   * standing in the way (you, body-blocking a doorway). Reaching the target sets
   * combat.onRushArrive off, and the unit burns itself out on it.
   */
  _updateRush(dt) {
    const combat = this.combat;
    const pos = this.root.position;
    const pp = combat.player.object.position;
    const goal = combat.rushTarget;
    this.meleeT -= dt;
    let blocked = false;
    if (goal && !combat.down) {
      const gx = goal.x - pos.x;
      const gz = goal.z - pos.z;
      const gd = Math.hypot(gx, gz) || 1;
      const px = pp.x - pos.x;
      const pz = pp.z - pos.z;
      const along = (px * gx + pz * gz) / gd; // how far ahead of it (toward the target) you're standing
      const side = Math.abs(px * gz - pz * gx) / gd;
      blocked = along > -0.1 && along < 1.5 && along < gd + 0.5 && side < 0.8;
    }
    if (blocked) {
      // Stopped by your body: it claws at you until you move (or it dies).
      this.moveSpeed = 0;
      this._facePlayer(dt, 14);
      this.anim.reach += (1 - this.anim.reach) * Math.min(1, dt * 10);
      this.anim.aim = 0;
      if (this.meleeT <= 0) {
        this.meleeT = this.stats.meleeGap;
        combat.damagePlayer(this.stats.meleeDamage, pos);
        // (No knockback: shoving you out of the doorway would undo the body-block. A flinch is all you get.)
        combat.player.shove(pp.x - pos.x, pp.z - pos.z, 0, { stumble: 0.08, dip: 0.03, roll: 0.03, recovery: 0.05 });
        combat.shake(0.35);
        playPunchHit(false);
      }
      return;
    }
    this.anim.reach += (0 - this.anim.reach) * Math.min(1, dt * 10);
    if (!goal) {
      this.moveSpeed = 0;
      return;
    }
    if (Math.hypot(goal.x - pos.x, goal.z - pos.z) < 1.3) {
      this.selfDestruct = true;
      if (combat.onRushArrive) combat.onRushArrive(this);
      this._die();
      return;
    }
    this.repathT -= dt;
    if (this.repathT <= 0 || !this.route.length) {
      this.repathT = 0.5;
      this.route = combat.navigate(pos, goal, false);
    }
    if (this.route.length && this._moveToward(this.route[0], this.stats.speed, dt, true)) this.route.shift();
    this.stuckT += dt;
    if (this.stuckT >= 1.0) {
      if (this._last.distanceToSquared(pos) < 0.09) this.repathT = 0; // wedged: find another way
      this._last.copy(pos);
      this.stuckT = 0;
    }
  }

  _startBash() {
    this.state = 'bash';
    this.bashT = 0;
    this.bashDone = false;
    this.telegraph = 0;
    this.burstLeft = 0;
    this.moveSpeed = 0;
  }

  /** Shield pulled back, then driven into you. */
  _updateBash(dt) {
    const pos = this.root.position;
    this.bashT += dt;
    this._facePlayer(dt, 18);
    const t = this.bashT;
    if (t < 0.26) {
      this.anim.bash = -Math.min(1, t / 0.18); // wind up
      this.moveSpeed = 0;
    } else if (t < 0.4) {
      this.anim.bash = 1; // lunge
      const step = 5 * dt;
      pos.x += Math.sin(this.yaw) * step;
      pos.z += Math.cos(this.yaw) * step;
      this.combat.pushOut(pos, this.radius);
      if (!this.bashDone) {
        this.bashDone = true;
        this.combat.shieldBash(this);
      }
    } else if (t < 0.85) {
      this.anim.bash = Math.max(0, 1 - (t - 0.4) / 0.35);
    } else {
      this.anim.bash = 0;
      this.state = 'fight';
      this.bashCooldown = this.stats.bashCooldown;
      this.repathT = 0;
      this.fireTimer = Math.max(this.fireTimer, 0.8);
    }
  }

  _checkStuck(dt) {
    this.stuckT += dt;
    if (this.stuckT < 1.0) return;
    if (this._last.distanceToSquared(this.root.position) < 0.09) {
      // Wedged on something: pick somewhere else (shield units just re-path).
      if (this.shielded) this.repathT = 0;
      else this._relocate();
    }
    this._last.copy(this.root.position);
    this.stuckT = 0;
  }

  _moveToward(target, speed, dt, collide, keepFacing = false) {
    const pos = this.root.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) {
      this.moveSpeed = 0;
      return true;
    }
    const step = Math.min(d, speed * dt);
    pos.x += (dx / d) * step;
    pos.z += (dz / d) * step;
    this.moveSpeed = speed;
    if (!keepFacing) this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), Math.min(1, dt * 8));
    if (collide) this.combat.pushOut(pos, this.radius);
    return false;
  }

  _facePlayer(dt, rate = 6) {
    const pos = this.root.position;
    const pp = this.combat.player.object.position;
    this.yaw = dampAngle(this.yaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), 1 - Math.exp(-dt * rate));
  }

  /** Cooldown -> charge-up tell -> burst, all without stopping. `onBurstEnd` runs after the last shot. */
  _fireCycle(dt, canFire, onBurstEnd = null) {
    if (this.telegraph > 0) {
      this.telegraph -= dt;
      if (this.telegraph <= 0) {
        this.burstLeft = this.stats.burst;
        this.shotGap = 0;
      }
      return;
    }
    if (this.burstLeft > 0) {
      this.shotGap -= dt;
      if (this.shotGap <= 0) {
        this._shoot();
        this.burstLeft--;
        this.shotGap = this.stats.shotGap;
        if (this.burstLeft === 0) {
          this.fireTimer = rand(this.stats.cooldown[0], this.stats.cooldown[1]) * difficulty.fireMult;
          if (onBurstEnd) onBurstEnd();
        }
      }
      return;
    }
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      if (canFire) {
        this.telegraph = this.stats.telegraph * Math.max(0.7, difficulty.fireMult);
        if (this.combat.sfxNear(this.root.position, 'charge', 0.12, 26)) playRobotCharge(this.heavy ? 0.55 : this.shielded ? 0.85 : 1);
      } else {
        this.fireTimer = 0.3;
      }
    }
  }

  _shoot() {
    const combat = this.combat;
    this.muzzle.getWorldPosition(this._from);
    combat.playerAimPoint(this._from, this._aim, this.stats.boltSpeed);
    if (this.heavy) {
      // A slow, glowing shell that bursts where it lands (duck behind something solid).
      combat.fireBolt(this._from, this._aim, {
        damage: this.stats.damage, spread: this.stats.spread, speed: this.stats.boltSpeed, size: 2.8, color: 0xff7a1a, explosive: this.stats.splash,
      });
      combat.effects.flash(this._from, { size: 1.1, color: 0xff8a3a, life: 0.12 });
      combat.shakeFrom(this._from, 0.35);
      if (combat.sfx('tank', 0.1)) playTankCannon(THREE.MathUtils.clamp(1.3 - this._from.distanceTo(combat.player.object.position) / 40, 0.35, 1));
      return;
    }
    combat.fireBolt(this._from, this._aim, { damage: this.stats.damage, spread: this.stats.spread, speed: this.stats.boltSpeed });
    combat.effects.flash(this._from, { size: 0.35, color: 0xff5a40, life: 0.06 });
    const d2 = this._from.distanceToSquared(combat.player.object.position);
    if (combat.sfx('bolt', 0.035)) playBoltFire(rand(0.9, 1.1), THREE.MathUtils.clamp(1.4 - Math.sqrt(d2) / 30, 0.3, 1));
  }

  _enterCover() {
    this.state = 'cover';
    this.coverPhase = 'hidden';
    this.coverT = rand(0.4, 0.9);
    this.anim.crouch = 1;
    this.moveSpeed = 0;
  }

  /** Behind the fallen pillar: hidden -> pop up -> burst -> duck back down. */
  _updateCover(dt) {
    this.moveSpeed = 0;
    this._facePlayer(dt, 8);
    switch (this.coverPhase) {
      case 'hidden': // ducked behind the pillar "reloading"
        this.anim.crouch = 1;
        this.anim.aim += (0.3 - this.anim.aim) * Math.min(1, dt * 5);
        this.coverT -= dt;
        if (this.coverT <= 0) {
          this.coverPhase = 'rising';
          this.coverT = 0.3;
        }
        break;
      case 'rising':
        this.anim.crouch = 0;
        this.anim.aim += (1 - this.anim.aim) * Math.min(1, dt * 8);
        this.coverT -= dt;
        if (this.coverT <= 0) {
          this.hasSight = this.combat.canSeePlayer(this.eye());
          if (this.hasSight) {
            this.coverPhase = 'firing';
            this.fireTimer = 0; // straight into the charge-up
          } else if (Math.random() < 0.3) {
            this._leaveCover(); // can't see you from here: go looking
          } else {
            this.coverPhase = 'hidden';
            this.coverT = rand(0.8, 1.4);
          }
        }
        break;
      case 'firing':
        this.anim.crouch = 0;
        this._fireCycle(dt, true, () => {
          this.coverPhase = 'ducking';
          this.coverT = 0.22;
        });
        break;
      default: // ducking
        this.anim.crouch = 1;
        this.coverT -= dt;
        if (this.coverT <= 0) {
          this.coverPhase = 'hidden';
          this.coverT = rand(0.9, 1.7);
        }
    }
  }

  _leaveCover() {
    this.state = 'fight';
    this.anim.crouch = 0;
    this.wantsCover = false;
    this._relocate();
  }

  /** zone: head | body | legs | foot | shield. Returns 'hit' | 'head' | 'kill' | 'armor' (or null if already down). */
  takeHit(zone, damage) {
    if (this.dead) return null;
    // Shield units: the shield AND every plate on them deflect, front or back.
    // Only the lower legs / feet below the shield take damage.
    if (zone === 'shield' || (this.shielded && zone !== 'foot')) {
      this.anim.flinch = 0.06;
      return 'armor';
    }
    const mult = zone === 'head' ? RIFLE.headMult : zone === 'legs' ? 0.8 : 1;
    this.hp -= damage * mult;
    this.flashT = 0.07;
    this.anim.flinch = 0.22;
    if (this.hp <= 0) {
      this._die();
      return 'kill';
    }
    return zone === 'head' ? 'head' : 'hit';
  }

  _die() {
    this.dead = true;
    this.deathT = 0;
    this.telegraph = 0;
    this.burstLeft = 0;
    this.moveSpeed = 0;
    this.anim.bash = 0;
    this.combat.onUnitDown(this);
    if (this.combat.sfx('death', 0.05)) playRobotDeath();
    const chest = this.aimPoint(this._from);
    this.combat.effects.spark(chest, { count: 18, color: 0x9fe8ff, speed: 5, size: 0.08, life: 0.5 });
    this.combat.effects.flash(chest, { size: 0.9, color: 0x9fe8ff, life: 0.15 });
  }

  _updateDeath(dt) {
    this.deathT += dt;
    this.glowLevel = Math.max(0, 1 - this.deathT * 1.5);
    this.anim.aim = 0;
    this.anim.crouch = Math.min(1, this.deathT * 3) * 0.4;
    const fall = THREE.MathUtils.clamp((this.deathT - 0.2) / 0.6, 0, 1);
    this.root.rotation.x = -1.48 * fall * fall; // topples over backward
    if (this.root.position.y > 0) this.root.position.y = Math.max(0, this.root.position.y - dt * 2);
    if (this.deathT < 2 && Math.random() < dt * 5) {
      this.combat.effects.spark(this.aimPoint(this._from), { count: 4, color: 0x9fe8ff, speed: 3, size: 0.05, life: 0.3 });
    }
    if (this.deathT > 6) this.root.position.y -= dt * 0.35; // the wreck sinks away
    if (this.deathT > 8.5) this.removeMe = true;
  }
}

/** Pre-built ELDAR rigs (+ their health bars), reused spawn after spawn. */
class RigPool {
  constructor(combat) {
    this.combat = combat;
    this.free = { standard: [], shield: [], tank: [], scrap: [] };
  }

  acquire(type) {
    const built = this.free[type].pop() || this._build(type);
    resetRigPose(built.root);
    built.root.visible = true;
    built.plates.emissive.setHex(PLATE_EMISSIVE);
    return built;
  }

  release(built) {
    built.root.visible = false;
    built.root.position.set(0, -60, 0);
    built.bar.bg.visible = false;
    built.bar.fill.visible = false;
    for (const h of built.hitboxes) h.userData.owner = null;
    this.free[built.type].push(built);
  }

  /** Build some up front (behind the loading fade) so a spawn mid-fight costs nothing. */
  fill(type, count) {
    while (this.free[type].length < count) this.release(this._build(type));
  }

  _build(type) {
    const built = createEldarRig(this.combat.mats, {
      shield: type === 'shield',
      tank: type === 'tank',
      scrap: type === 'scrap',
      scale: type === 'tank' ? 1.4 : type === 'scrap' ? 0.92 : 1,
    });
    built.type = type;
    built.bar = this.combat.createHealthBar();
    this.combat.scene.add(built.root);
    return built;
  }
}

// ---------------------------------------------------------------------------
// The ELDAR Titan
// ---------------------------------------------------------------------------

const BOUNDS = { minX: -10.5, maxX: 10.5, minZ: -58.5, maxZ: -38.8 }; // the central chamber
const TITAN_BUSY = new Set(['off', 'drop', 'land', 'intro', 'phaseEnd', 'await', 'rip', 'stagger', 'dying']); // shots just spark off
const TITAN_STUNNABLE = new Set(['walk', 'volley', 'sweep', 'stomp', 'recover']);

/**
 * Phase 1: exposed. A thrown water bottle shorts it out, its core shutters open
 * and you shoot the red core on its back. Phase 2: it rips a structural pillar
 * off the wall and carries it as a shield: bullets and bottles just hit the
 * pillar, so you shoot it apart while backup keeps pouring in. Phase 3: exposed
 * again (and angrier): short it out once more and finish the core. Throughout,
 * it fires fans and raking streams of bolts, and stomps if you get close.
 */
class Titan {
  constructor(combat) {
    this.combat = combat;
    const built = createEldarRig(combat.mats, { boss: true, scale: BOSS.scale });
    this.root = built.root;
    this.mesh = this.root;
    this.rig = built.rig;
    this.hitboxes = built.hitboxes;
    this.muzzle = built.muzzle;
    this.plates = built.plates;
    this.glow = built.glow;
    this.core = built.core;
    this.shutters = built.shutters;

    // The pillar shield (phase 2): hidden until it tears one off the wall.
    const s = BOSS.scale;
    this.heldPillar = createStructuralPillar();
    this.heldPillar.scale.setScalar(1 / s); // torso space is scaled up; keep it wall-sized
    this.heldPillar.position.set(0, 0.04, 0.5); // square in front of its chest, ~0.4m to 5m off the floor
    this.heldPillar.rotation.y = Math.PI; // the torn wall plating faces out
    this.heldPillar.visible = false;
    this.rig.torso.add(this.heldPillar);
    this.pillarBox = new THREE.Mesh(
      new THREE.BoxGeometry(PILLAR_SIZE.width / s, PILLAR_SIZE.height / s, (PILLAR_SIZE.depth + 0.2) / s),
      combat.mats.hidden,
    );
    this.pillarBox.position.copy(this.heldPillar.position);
    this.pillarBox.userData.zone = 'pillar';
    this.rig.torso.add(this.pillarBox);
    this.hitboxes.push(this.pillarBox);
    for (const h of this.hitboxes) h.userData.owner = this;

    this.radius = 1.35;
    this.root.position.set(0, -80, -48); // parked out of sight (but compiled) until it drops in
    combat.scene.add(this.root);
    this.coreLight = new THREE.PointLight(0xff2a1a, 0, 9, 1.6);
    combat.scene.add(this.coreLight);

    // Red warning ring on the floor while it winds up a stomp.
    this.warnRing = new THREE.Mesh(
      new THREE.RingGeometry(BOSS.stompRadius - 0.35, BOSS.stompRadius, 64),
      new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.warnRing.rotation.x = -Math.PI / 2;
    this.warnRing.visible = false;
    combat.scene.add(this.warnRing);

    this.active = false;
    this.aiEnabled = false;
    this.state = 'off';
    this.dead = false;
    this.phase = 1;
    this.coreHp = BOSS.coreHp;
    this.hasPillar = false;
    this.pillarHp = BOSS.pillarHp;
    this.pillarStage = 0;
    this.pillarFlash = 0;
    this.anim = { speed: 0, aim: 0, crouch: 0, air: 0, kneel: 0, lift: 0, roar: 0, flinch: 0, pillar: 0, reach: 0, pull: 0 };
    this.yaw = 0;
    this.vy = 0;
    this.t = 0;
    this.attackT = 3;
    this.stunT = 0;
    this.shutterOpen = 0;
    this.shots = 0;
    this.rows = 0;
    this.shotT = 0;
    this.sweepDir = 1;
    this.coreFlash = 0;
    this._stepSide = 0;
    this._rip = null;
    this._tmp = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    const r = this.rig;
    this._joints = [r.torso, r.neck, r.shoulderL, r.shoulderR, r.elbowL, r.elbowR, r.kneeL, r.kneeR];
    this._anchors = this._joints.map(() => new THREE.Vector3());
  }

  get position() {
    return this.root.position;
  }

  get alive() {
    return this.active && !this.dead;
  }

  get engaged() {
    return this.alive && this.aiEnabled;
  }

  aimPoint(out) {
    this.rig.torso.getWorldPosition(out);
    out.y += 0.3 * BOSS.scale;
    return out;
  }

  benZone() {
    return this.hasPillar ? 'pillar' : 'body';
  }

  /** The boss bar: phase 1's core, then phase 3's (phase 2 is all about the pillar). */
  healthFraction() {
    const first = this.phase === 1 ? Math.max(0, this.coreHp) : 0;
    const last = this.phase === 3 ? Math.max(0, this.coreHp) : BOSS.coreHp;
    return (first + last) / (2 * BOSS.coreHp);
  }

  pillarFraction() {
    return this.hasPillar ? Math.max(0, this.pillarHp) / BOSS.pillarHp : null;
  }

  /** Crashes down through the ceiling hatch at `at`, facing `faceYaw`. */
  drop(at, faceYaw) {
    this.active = true;
    this.dead = false;
    this.aiEnabled = false;
    this.state = 'drop';
    this.t = 0;
    this.phase = 1;
    this.coreHp = BOSS.coreHp;
    this._dropPillar();
    this.root.position.set(at.x, 13, at.z);
    this.root.rotation.x = 0;
    this.yaw = faceYaw;
    this.vy = 0;
    this.anim.air = 0.6;
    this.combat.refreshTargets();
  }

  /** Retry from the current phase: back in the middle of the chamber, topped up. */
  resetPhase(at, faceYaw) {
    this.root.position.set(at.x, 0, at.z);
    this.root.rotation.x = 0;
    this.yaw = faceYaw;
    this.coreHp = BOSS.coreHp;
    this.state = 'walk';
    this.stunT = 0;
    this.attackT = 3;
    this._rip = null;
    Object.assign(this.anim, { speed: 0, aim: 0, crouch: 0, air: 0, kneel: 0, lift: 0, roar: 0, reach: 0, pull: 0 });
    this.warnRing.visible = false;
    this.combat.effects.setArcs(null);
    if (this.phase === 2) this.equipPillar(); // still has its shield, at full strength
    else this._dropPillar();
  }

  park() {
    this.active = false;
    this.aiEnabled = false;
    this.state = 'off';
    this._dropPillar();
    this.root.position.set(0, -80, -48);
    this.coreLight.intensity = 0;
    this.warnRing.visible = false;
    this.combat.effects.setArcs(null);
  }

  /** It has the wall pillar in its hands (phase 2 starts). */
  equipPillar() {
    this.hasPillar = true;
    this.phase = 2;
    this.pillarHp = BOSS.pillarHp;
    this.pillarStage = 0;
    this.heldPillar.visible = true;
    this.heldPillar.userData.plates.forEach((p) => (p.visible = true));
    this.heldPillar.userData.beamMat.emissive.setRGB(0, 0, 0);
    this._fitPillarBox(-1.17, 1.17);
    this.anim.pillar = 1;
  }

  _dropPillar() {
    this.hasPillar = false;
    this.heldPillar.visible = false;
    this.anim.pillar = 0;
  }

  /** Size the pillar's hitbox to what's left of it (pillar-local x range, meters). */
  _fitPillarBox(minX, maxX) {
    const s = BOSS.scale;
    this.pillarBox.scale.x = (maxX - minX) / PILLAR_SIZE.width;
    this.pillarBox.position.x = this.heldPillar.position.x - (minX + maxX) / 2 / s; // (the pillar is turned around)
  }

  /** A thrown bottle: 'body' shorts it out, 'pillar' shatters on the shield, null = missed. */
  hitTestBottle(pos) {
    if (!this.alive) return null;
    const p = this.root.position;
    const d2 = (pos.x - p.x) ** 2 + (pos.z - p.z) ** 2;
    if (this.hasPillar) return d2 < 2.4 * 2.4 && pos.y > 0 && pos.y < 6 ? 'pillar' : null;
    return d2 < 1.3 * 1.3 && pos.y > 0 && pos.y < 5 ? 'body' : null;
  }

  stun() {
    if (this.hasPillar || !TITAN_STUNNABLE.has(this.state)) return;
    this.state = 'stunned';
    this.t = 0;
    this.stunT = BOSS.stunTime;
    this.anim.lift = 0;
    this.anim.aim = 0;
    this.warnRing.visible = false;
    playElectricStun(BOSS.stunTime);
    this.combat.effects.setArcs(this._anchors);
    this.combat.effects.flash(this.aimPoint(this._tmp), { size: 4, color: 0x9fe8ff, life: 0.3 });
    if (this.combat.onBossStunned) this.combat.onBossStunned();
  }

  /**
   * Frontal fire sparks off its armor; only the core counts, and only with the
   * shutters open. With the pillar up, the pillar takes the hits (and damage).
   */
  takeHit(zone, damage = RIFLE.damage) {
    if (zone === 'pillar') {
      if (!this.hasPillar || !this.alive) return null; // no shield there: the round carries on
      if (TITAN_BUSY.has(this.state)) return 'pillar';
      this._damagePillar(damage);
      return this.hasPillar ? 'pillar' : 'kill';
    }
    if (!this.alive || TITAN_BUSY.has(this.state)) return 'armor';
    if (zone === 'core' && this.shutterOpen > 0.6 && !this.hasPillar) {
      this.coreHp -= RIFLE.damage;
      this.coreFlash = 0.1;
      if (this.coreHp <= 0) {
        this._phaseDown();
        return 'kill';
      }
      return 'head';
    }
    return 'armor';
  }

  _damagePillar(amount) {
    this.pillarHp -= amount;
    this.pillarFlash = 0.06;
    const frac = this.pillarHp / BOSS.pillarHp;
    const stage = frac <= 0 ? 3 : frac < 0.33 ? 2 : frac < 0.66 ? 1 : 0;
    while (this.pillarStage < stage && this.hasPillar) {
      this.pillarStage++;
      if (this.pillarStage < 3) this._tearPlate(this.pillarStage);
      else this._shatterPillar();
    }
  }

  /** A slab of the wall plating tears off the pillar (it gets narrower). */
  _tearPlate(stage) {
    const index = stage === 1 ? 1 : 0; // right slab first, then the left
    this.heldPillar.userData.plates[index].visible = false;
    this._tmp.set(index ? 0.72 : -0.72, 0.6, -0.2);
    this.heldPillar.localToWorld(this._tmp);
    this._dir.set(Math.sin(this.yaw), 0.4, Math.cos(this.yaw));
    this.combat.effects.chunks(this._tmp, { count: 6, speed: 5, size: 0.5, dir: this._dir });
    this.combat.effects.spark(this._tmp, { count: 22, color: 0xffc070, speed: 5, size: 0.08, life: 0.5 });
    this.combat.shake(0.6);
    playPillarShatter();
    if (stage === 1) this._fitPillarBox(-1.17, 0.31);
    else this._fitPillarBox(-0.31, 0.31);
    if (this.combat.onPillarDamaged) this.combat.onPillarDamaged(stage);
  }

  /** The pillar blows apart in its hands: staggered, then the final phase. */
  _shatterPillar() {
    this.heldPillar.getWorldPosition(this._tmp);
    this._dropPillar();
    this._dir.set(Math.sin(this.yaw), 0.3, Math.cos(this.yaw));
    this.combat.effects.chunks(this._tmp, { count: 12, speed: 7, size: 0.55, dir: this._dir });
    this.combat.effects.spark(this._tmp, { count: 40, color: 0xffc070, speed: 7, size: 0.1, life: 0.6 });
    this.combat.effects.flash(this._tmp, { size: 5, color: 0xffb070, life: 0.3 });
    this.combat.shake(1.3);
    playPillarShatter();
    this.state = 'stagger';
    this.t = 0;
    this.phase = 3;
    this.coreHp = BOSS.coreHp;
    this.warnRing.visible = false;
    this.anim.kneel = 0.55;
    this.anim.aim = 0;
    if (this.combat.onBossPhase) this.combat.onBossPhase(3);
  }

  _phaseDown() {
    this.combat.effects.setArcs(null);
    this.stunT = 0;
    this.t = 0;
    playExplosion();
    this.combat.effects.flash(this.aimPoint(this._tmp), { size: 5, color: 0xffb070, life: 0.35 });
    this.combat.shake(0.9);
    if (this.phase >= 3) {
      this.state = 'dying';
      this.anim.kneel = 1;
      return;
    }
    // Phase 1 done: a roar... then it goes for the wall (chapter2_lab.js runs that cutscene).
    this.state = 'phaseEnd';
    this.anim.kneel = 0;
    this.anim.roar = 1;
    playBossRoar();
    if (this.combat.onBossPhase) this.combat.onBossPhase(2);
  }

  /**
   * Phase 2 cutscene: standing at `stand` facing the wall (`yaw`), it grips the
   * structural pillar, hauls it off the wall (`onTear` fires the moment it comes
   * free), turns around with it and slams it down in front of itself, roaring.
   * Resolves when it's ready to fight again.
   */
  ripPillar(stand, yaw, onTear) {
    this.root.position.set(stand.x, 0, stand.z);
    this.root.rotation.x = 0;
    this.yaw = yaw;
    this.state = 'rip';
    this.t = 0;
    this.stunT = 0;
    this.warnRing.visible = false;
    this.combat.effects.setArcs(null);
    Object.assign(this.anim, { speed: 0, aim: 0, crouch: 0, kneel: 0, lift: 0, roar: 0, reach: 0, pull: 0 });
    return new Promise((resolve) => {
      this._rip = { onTear, resolve, torn: false, screech: false, slammed: false };
    });
  }

  _updateRip(dt) {
    const r = this._rip;
    if (!r) return;
    const t = this.t;
    const a = this.anim;
    const pos = this.root.position;
    a.reach = t < 2.3 ? Math.min(1, t / 0.7) : Math.max(0, 1 - (t - 2.3) / 0.35);
    a.pull = t > 0.9 && t < 2.3 ? Math.min(1, (t - 0.9) / 0.4) * (0.85 + 0.15 * Math.sin(t * 34)) : Math.max(0, a.pull - dt * 3);
    if (t > 0.9 && !r.screech) {
      r.screech = true;
      playMetalTear(1.35);
    }
    if (t > 0.9 && t < 2.3) {
      if (Math.random() < dt * 16) {
        this.rig.elbowL.getWorldPosition(this._tmp);
        this.combat.effects.spark(this._tmp, { count: 5, color: 0xffd08a, speed: 4, size: 0.07, life: 0.35 });
      }
      this.combat.shake(0.25);
    }
    if (t > 2.25 && !r.torn) {
      r.torn = true;
      this.equipPillar();
      this.heldPillar.getWorldPosition(this._tmp);
      this.combat.effects.chunks(this._tmp, { count: 8, speed: 4, size: 0.4 });
      this.combat.effects.spark(this._tmp, { count: 30, color: 0xffc070, speed: 6, size: 0.09, life: 0.6 });
      this.combat.shake(1.3);
      if (r.onTear) r.onTear();
    }
    // Turns around with it...
    if (t > 2.5 && t < 3.8) {
      const pp = this.combat.player.object.position;
      this.yaw = turnToward(this.yaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), 2.8 * dt);
      a.speed = 0.8; // shuffling round
    } else {
      a.speed = 0;
    }
    // ...and slams it down in front of itself with a roar.
    a.roar = t > 3.9 && t < 5.2 ? 1 : 0;
    if (t > 3.9 && !r.slammed) {
      r.slammed = true;
      playBossRoar();
      playStomp();
      this.combat.shake(1.1);
      this.combat.effects.ring(pos, { from: 1, to: 6, life: 0.6 });
    }
    if (t > 5.4) {
      this.state = 'walk';
      this.attackT = 2.2;
      this._rip = null;
      r.resolve();
    }
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const pos = this.root.position;
    const combat = this.combat;
    const ai = !combat.frozen; // a cutscene mid-fight: it holds still
    switch (this.state) {
      case 'drop':
        this.vy -= 16 * dt;
        pos.y += this.vy * dt;
        if (pos.y <= 0) {
          pos.y = 0;
          this.state = 'land';
          this.t = 0;
          this.anim.air = 0;
          this.anim.crouch = 1;
          playLanding(true);
          combat.shake(1.4);
          combat.effects.ring(pos, { from: 1, to: 9, life: 0.9 });
          combat.effects.spark(pos, { count: 30, color: 0xffd08a, speed: 6, size: 0.1, life: 0.6 });
        }
        break;
      case 'land':
        if (this.t > 0.9) {
          this.anim.crouch = 0;
          this.state = 'intro';
          this.t = 0;
          this.anim.roar = 1;
          playBossRoar();
        }
        break;
      case 'intro':
        if (this.t > 1.7) this.anim.roar = 0;
        if (this.t > 2.1 && this.aiEnabled) {
          this.state = 'walk';
          this.attackT = 2.0;
        }
        break;
      case 'walk':
        if (ai) this._walk(dt);
        break;
      case 'volley':
        if (ai) this._volley(dt);
        break;
      case 'sweep':
        if (ai) this._sweep(dt);
        break;
      case 'stomp':
        if (ai) this._stomp(dt);
        break;
      case 'stunned':
        this.stunT -= dt;
        this.anim.kneel = 1;
        this.anim.speed = 0;
        if (Math.random() < dt * 8) {
          const a = this._anchors[Math.floor(Math.random() * this._anchors.length)];
          combat.effects.spark(a, { count: 3, color: 0xbfefff, speed: 3, size: 0.07, life: 0.3 });
        }
        if (this.stunT <= 0) {
          this.state = 'recover';
          this.t = 0;
          this.anim.kneel = 0;
          combat.effects.setArcs(null);
        }
        break;
      case 'recover':
        if (this.t > 0.8) {
          this.state = 'walk';
          this.attackT = 1.2;
        }
        break;
      case 'phaseEnd':
        if (this.t > 1.7) this.anim.roar = 0;
        if (this.t > 2.2) this.state = 'await'; // chapter2_lab.js stages the pillar rip
        break;
      case 'await':
        break;
      case 'rip':
        this._updateRip(dt);
        break;
      case 'stagger': // the pillar just blew apart in its hands
        if (Math.random() < dt * 6) {
          const a = this._anchors[Math.floor(Math.random() * this._anchors.length)];
          combat.effects.spark(a, { count: 4, color: 0xffc070, speed: 3, size: 0.07, life: 0.3 });
        }
        if (this.t > 1.5) this.anim.kneel = 0;
        if (this.t > 1.8 && !this.anim.roar && this.t < 3) {
          this.anim.roar = 1;
          playBossRoar();
        }
        if (this.t > 3.2) {
          this.anim.roar = 0;
          this.state = 'walk';
          this.attackT = 1.5;
        }
        break;
      case 'dying':
        if (Math.random() < dt * 4) {
          const a = this._anchors[Math.floor(Math.random() * this._anchors.length)];
          combat.effects.flash(a, { size: 2.2, color: 0xffb070, life: 0.2 });
          combat.effects.spark(a, { count: 10, color: 0xffc070, speed: 5, size: 0.1, life: 0.5 });
          if (Math.random() < 0.4) playExplosion();
        }
        if (this.t > 1.8) {
          const k = THREE.MathUtils.clamp((this.t - 1.8) / 0.9, 0, 1);
          this.root.rotation.x = 1.3 * k * k; // topples forward onto its face
          if (k >= 1 && !this.dead) {
            this.dead = true;
            playLanding(true);
            combat.shake(1.2);
            combat.effects.ring(pos, { from: 2, to: 10, life: 1 });
            combat.refreshTargets();
            if (combat.onBossDefeated) combat.onBossDefeated();
          }
        }
        break;
      default:
        break;
    }

    // Core shutters slide open only while it's shorted out.
    const open = this.state === 'stunned' ? 1 : 0;
    this.shutterOpen += (open - this.shutterOpen) * Math.min(1, dt * 6);
    this.shutters.forEach((s, i) => {
      s.position.x = (i ? 1 : -1) * (0.066 + 0.15 * this.shutterOpen);
    });
    this.coreFlash = Math.max(0, this.coreFlash - dt);
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (this.state === 'stunned' ? 14 : 4));
    const coreGlow = this.dead ? 0.08 : 0.45 + this.shutterOpen * 0.55 + (this.coreFlash > 0 ? 0.6 : 0);
    this.core.material.color.setRGB(Math.min(1, coreGlow + 0.2 * pulse), coreGlow * 0.15, coreGlow * 0.1);
    const charging = (this.state === 'volley' && this.t < 0.8) || (this.state === 'sweep' && this.t < 0.7);
    this.glow.color.setRGB(this.dead ? 0.1 : 1, charging ? 0.75 : 0.18, 0.12);
    // The pillar glows hotter the more it's been shot up (and flashes with each hit).
    if (this.hasPillar) {
      this.pillarFlash = Math.max(0, this.pillarFlash - dt);
      const heat = Math.max(0, 1 - this.pillarHp / BOSS.pillarHp) ** 2;
      const f = this.pillarFlash > 0 ? 0.22 : 0;
      this.heldPillar.userData.beamMat.emissive.setRGB(heat * 0.55 + f, heat * 0.14 + f * 0.6, f * 0.3);
    }

    if (this.state !== 'walk' && this.state !== 'rip') this.anim.speed = 0;
    animateEldar(this.rig, dt, this.anim);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld(true);
    this.core.getWorldPosition(this.coreLight.position);
    this.coreLight.intensity = this.dead ? 0 : 1.5 + this.shutterOpen * 5 + pulse;
    this._updateAnchors();
  }

  _updateAnchors() {
    for (let i = 0; i < this._joints.length; i++) this._joints[i].getWorldPosition(this._anchors[i]);
  }

  _walk(dt) {
    const combat = this.combat;
    const pos = this.root.position;
    const pp = combat.player.object.position;
    const i = this.phase - 1;
    const dx = pp.x - pos.x;
    const dz = pp.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const desired = Math.atan2(dx, dz);
    this.yaw = turnToward(this.yaw, desired, BOSS.turnRate[i] * dt);
    const off = Math.abs(((desired - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const keep = this.hasPillar ? 6 : 7.5; // with the shield up it presses in closer
    let speed = 0;
    if (dist > keep && off < 0.7) speed = BOSS.walkSpeed[i];
    else if (dist < 4.5) speed = -BOSS.walkSpeed[i] * 0.6;
    if (speed) {
      pos.x += Math.sin(this.yaw) * speed * dt;
      pos.z += Math.cos(this.yaw) * speed * dt;
      combat.pushOut(pos, this.radius);
      pos.x = THREE.MathUtils.clamp(pos.x, BOUNDS.minX, BOUNDS.maxX);
      pos.z = THREE.MathUtils.clamp(pos.z, BOUNDS.minZ, BOUNDS.maxZ);
      // Heavy footfalls.
      const side = Math.sin(this.rig.phase) > 0 ? 1 : -1;
      if (side !== this._stepSide) {
        this._stepSide = side;
        combat.shakeFrom(pos, 0.35);
        if (dist < 16) playLanding(false);
      }
    }
    this.anim.speed = Math.abs(speed);
    this.anim.aim += (0.3 - this.anim.aim) * Math.min(1, dt * 3);
    this.attackT -= dt;
    if (this.attackT <= 0) this._chooseAttack(dist);
  }

  _chooseAttack(dist) {
    const i = this.phase - 1;
    const pos = this.root.position;
    this.t = 0;
    if (dist < BOSS.stompRadius - 0.8) {
      this.state = 'stomp';
      this.warnRing.visible = true;
      this.warnRing.position.set(pos.x, 0.04, pos.z);
    } else if (Math.random() < 0.45) {
      this.state = 'sweep';
      this.shots = BOSS.sweepBolts[i];
      this.shotT = 0;
      this.sweepDir = Math.random() < 0.5 ? -1 : 1;
      playRobotCharge(0.45);
    } else {
      this.state = 'volley';
      this.rows = BOSS.fanRows[i];
      this.shotT = 0;
      playRobotCharge(0.5);
    }
  }

  _endAttack() {
    this.state = 'walk';
    this.attackT = BOSS.attackEvery[this.phase - 1] * rand(0.85, 1.15);
  }

  _trackPlayer(dt) {
    const pp = this.combat.player.object.position;
    const pos = this.root.position;
    this.yaw = turnToward(this.yaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), BOSS.turnRate[this.phase - 1] * dt);
  }

  /** Rows of bolts fanned out across where you're standing; alternate rows fill the gaps. */
  _volley(dt) {
    const combat = this.combat;
    this.anim.speed = 0;
    this.anim.aim += (1 - this.anim.aim) * Math.min(1, dt * 5);
    this._trackPlayer(dt);
    if (this.t < 0.8) return; // charging (the arm cannon glows)
    this.shotT -= dt;
    const i = this.phase - 1;
    if (this.rows > 0 && this.shotT <= 0) {
      const n = BOSS.fanBolts[i];
      const row = BOSS.fanRows[i] - this.rows;
      this.muzzle.getWorldPosition(this._from);
      combat.playerAimPoint(this._from, this._aim, 15);
      this._dir.subVectors(this._aim, this._from);
      for (let k = 0; k < n; k++) {
        const fan = (k - (n - 1) / 2 + (row % 2) * 0.5) * 0.06;
        this._tmp.copy(this._dir).applyAxisAngle(UP, fan).add(this._from);
        combat.fireBolt(this._from, this._tmp, { damage: BOSS.boltDamage, spread: 0.008, speed: 15, size: 1.7, color: 0xff6a2a });
      }
      combat.effects.flash(this._from, { size: 1.3, color: 0xff7040, life: 0.09 });
      playBoltFire(0.55, 1.3);
      this.rows--;
      this.shotT = 0.32;
    }
    if (this.rows === 0 && this.shotT < -0.4) this._endAttack();
  }

  /** A raking stream swept across wherever you are: get behind something. */
  _sweep(dt) {
    const combat = this.combat;
    this.anim.speed = 0;
    this.anim.aim += (1 - this.anim.aim) * Math.min(1, dt * 5);
    this._trackPlayer(dt);
    if (this.t < 0.7) return; // charging
    this.shotT -= dt;
    const i = this.phase - 1;
    const n = BOSS.sweepBolts[i];
    while (this.shots > 0 && this.shotT <= 0) {
      const k = n - this.shots;
      const angle = this.sweepDir * (k / (n - 1) - 0.5) * 1.3;
      this.muzzle.getWorldPosition(this._from);
      combat.playerAimPoint(this._from, this._aim, 17);
      this._tmp.subVectors(this._aim, this._from).applyAxisAngle(UP, angle).add(this._from);
      combat.fireBolt(this._from, this._tmp, { damage: BOSS.sweepDamage, spread: 0.012, speed: 17, size: 1.35, color: 0xff8a3a });
      if (k % 3 === 0) {
        combat.effects.flash(this._from, { size: 0.8, color: 0xff7040, life: 0.06 });
        playBoltFire(0.7, 0.9);
      }
      this.shots--;
      this.shotT += 0.065;
    }
    if (this.shots === 0 && this.shotT < -0.5) this._endAttack();
  }

  _stomp(dt) {
    const combat = this.combat;
    const pos = this.root.position;
    this.anim.speed = 0;
    if (this.t < 1.0) {
      // Winding up: the leg comes up, the warning ring pulses.
      this.anim.lift = Math.min(1, this.t / 0.6);
      this.warnRing.material.opacity = 0.35 + 0.35 * Math.sin(this.t * 18);
      return;
    }
    if (this.warnRing.visible) {
      this.warnRing.visible = false;
      this.anim.lift = 0;
      playStomp();
      combat.shake(1.2);
      combat.effects.ring(pos, { from: 1, to: BOSS.stompRadius, color: 0xff7a5a, life: 0.45 });
      combat.effects.spark(pos, { count: 26, color: 0xffd08a, speed: 6, size: 0.1, life: 0.5 });
      const pp = combat.player.object.position;
      if ((pp.x - pos.x) ** 2 + (pp.z - pos.z) ** 2 < BOSS.stompRadius * BOSS.stompRadius) combat.damagePlayer(BOSS.stompDamage, pos);
    }
    if (this.t > 1.8) this._endAttack();
  }
}

// ---------------------------------------------------------------------------
// Chapter 3's gym: the Mecha's sweeping lasers, floor eruptions and missiles
// ---------------------------------------------------------------------------

function yawDir(yaw, out) {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * A laser swept like a scythe around the Mecha, at one height: HIGH (orange:
 * crouch or slide under it) or LOW (red: only something solid between you and
 * the Mecha stops it). While it charges, a fan on the floor shows the arc it's
 * about to sweep and a flickering guide line shows the height.
 */
class LaserSweeps {
  constructor(scene) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0, 0.5); // grows along +Z from its origin: aim with lookAt, stretch with scale.z
    const make = (color, opacity) => {
      const mesh = new THREE.Mesh(
        box,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    this.core = make(0xfff2e6, 0.95);
    this.glow = make(0xff3a1a, 0.5);
    this.feed = make(0xff5a2a, 0.55);
    this.guide = make(0xff3a1a, 0.35);
    this.fanMat = new THREE.MeshBasicMaterial({ color: 0xff2a14, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.fan = new THREE.Mesh(new THREE.BufferGeometry(), this.fanMat);
    this.fan.rotation.x = -Math.PI / 2;
    this.fan.visible = false;
    this.fan.renderOrder = 2;
    scene.add(this.fan);
    this.sweep = null;
    this._s = new THREE.Vector3();
    this._e = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._m = new THREE.Vector3();
    this._hit = new THREE.Vector3();
  }

  /**
   * pivot: the Mecha's position (live); from/to: yaw angles; height; charge
   * (wind-up seconds); duration (sweep seconds); damage; emitter(out) -> the
   * cannon's muzzle in the world; color.
   */
  begin({ pivot, from, to, height, charge, duration, damage, emitter, color }) {
    this.end();
    this.sweep = { pivot, from, to, height, charge, duration, damage, emitter, t: 0, angle: from, prev: from, hit: false, done: false, sfx: false };
    for (const m of [this.glow, this.feed, this.guide]) m.material.color.set(color);
    this.fanMat.color.set(color);
    this.fan.geometry.dispose();
    this.fan.geometry = new THREE.RingGeometry(2.4, 36, 48, 1, Math.min(from, to) - Math.PI / 2, Math.abs(to - from));
    this.fan.position.set(pivot.x, 0.03, pivot.z);
    this.fan.visible = true;
    return this.sweep;
  }

  end() {
    if (this.sweep) this.sweep.done = true;
    this.sweep = null;
    this.core.visible = this.glow.visible = this.feed.visible = this.guide.visible = this.fan.visible = false;
  }

  _stretch(mesh, from, to, thick) {
    mesh.position.copy(from);
    mesh.lookAt(to);
    mesh.scale.set(thick, thick, Math.max(0.01, from.distanceTo(to)));
    mesh.visible = true;
  }

  update(dt, combat) {
    const s = this.sweep;
    if (!s) return;
    s.t += dt;
    const charging = s.t < s.charge;
    const k = charging ? 0 : Math.min(1, (s.t - s.charge) / s.duration);
    s.prev = s.angle;
    s.angle = s.from + (s.to - s.from) * k;
    // The beam: from just outside the Mecha, straight out at its height, to whatever it hits.
    yawDir(s.angle, this._d);
    this._s.set(s.pivot.x + this._d.x * 2.4, s.height, s.pivot.z + this._d.z * 2.4);
    const len = rayBoxes(this._s, this._d, combat.worldBoxes, 60);
    this._e.copy(this._s).addScaledVector(this._d, len);
    const m = s.emitter(this._m);
    if (charging) {
      this.guide.material.opacity = 0.2 + 0.25 * Math.abs(Math.sin(s.t * 26));
      this._stretch(this.guide, this._s, this._e, 0.04);
      this._stretch(this.feed, m, this._s, 0.04 + 0.1 * (s.t / s.charge));
      this.fanMat.opacity = 0.07 + 0.09 * Math.sin(s.t * 11) ** 2;
      this.core.visible = this.glow.visible = false;
      return;
    }
    if (!s.sfx) {
      s.sfx = true;
      playLaserBeam(s.duration);
      combat.shake(0.35);
    }
    this.guide.visible = false;
    this.fanMat.opacity = 0.05;
    const pulse = 0.85 + 0.15 * Math.sin(s.t * 60);
    this._stretch(this.core, this._s, this._e, 0.07 * pulse);
    this._stretch(this.glow, this._s, this._e, 0.34 * pulse);
    this._stretch(this.feed, m, this._s, 0.16);
    if (Math.random() < dt * 30) combat.effects.spark(this._e, { count: 3, color: 0xffb070, speed: 3, size: 0.08, life: 0.25 });
    // Did it cross you this frame, at a height your body reaches, with nothing solid in between?
    if (!s.hit && !combat.down) {
      const p = combat.player.object.position;
      const dx = p.x - s.pivot.x;
      const dz = p.z - s.pivot.z;
      const d = Math.hypot(dx, dz);
      const pa = Math.atan2(dx, dz);
      const a0 = angleDiff(pa, s.prev);
      const a1 = angleDiff(pa, s.angle);
      const width = Math.atan2(0.45, Math.max(0.5, d));
      const crossed = ((a0 >= 0) !== (a1 >= 0) && Math.abs(a0) < 1.5 && Math.abs(a1) < 1.5) || Math.abs(a1) < width;
      if (crossed && d > 2.2 && d < 2.4 + len + 0.3 && s.height < combat.player.bodyTop) {
        s.hit = true;
        combat.damagePlayer(s.damage, this._e);
        combat.shake(0.8);
        combat.effects.spark(this._hit.set(p.x, s.height, p.z), { count: 12, color: 0xffc080, speed: 4, size: 0.08, life: 0.3 });
      }
    }
    if (k >= 1) this.end();
  }
}

/** Telegraphed floor eruptions: a red ring fills in... then the floor blows up under it. */
class GroundHazards {
  constructor(scene, effects) {
    this.effects = effects;
    const ringGeo = new THREE.RingGeometry(0.9, 1, 40);
    const discGeo = new THREE.CircleGeometry(1, 40);
    this.pool = Array.from({ length: 36 }, () => {
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0xff2a14, transparent: true, opacity: 0.28, depthWrite: false, fog: false }));
      for (const mesh of [ring, disc]) {
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        mesh.renderOrder = 3;
        scene.add(mesh);
      }
      return { ring, disc, active: false, x: 0, z: 0, t: 0, delay: 1, radius: 2, damage: 20, big: false };
    });
    this._next = 0;
    this._p = new THREE.Vector3();
  }

  add(x, z, { radius = 2, delay = 1.1, damage = 22, big = false } = {}) {
    const h = this.pool[this._next];
    this._next = (this._next + 1) % this.pool.length;
    Object.assign(h, { active: true, x, z, t: 0, delay, radius, damage, big });
    h.ring.position.set(x, big ? 0.04 : 0.035, z);
    h.disc.position.set(x, big ? 0.032 : 0.03, z);
    h.ring.scale.setScalar(radius);
    h.disc.scale.setScalar(0.01);
    h.ring.visible = h.disc.visible = true;
    return h;
  }

  update(dt, combat) {
    for (const h of this.pool) {
      if (!h.active) continue;
      h.t += dt;
      const k = Math.min(1, h.t / h.delay);
      h.disc.scale.setScalar(Math.max(0.01, h.radius * k));
      h.ring.material.opacity = 0.5 + 0.45 * Math.sin(h.t * (9 + k * 22)) ** 2;
      if (k >= 1) this._detonate(h, combat);
    }
  }

  _detonate(h, combat) {
    h.active = false;
    h.ring.visible = h.disc.visible = false;
    const p = this._p.set(h.x, 0.3, h.z);
    const fx = this.effects;
    fx.flash(p, { size: h.radius * 1.3, color: 0xffa060, life: 0.18 });
    fx.spark(p, { count: h.big ? 30 : 12, color: 0xd8b890, speed: h.big ? 7 : 5, size: 0.12, life: 0.55, dir: UP });
    fx.chunks(p, { count: h.big ? 6 : 2, speed: 5, size: 0.28, dir: UP });
    fx.ring(p, { from: 0.3, to: h.radius * 1.15, color: 0xffb080, life: 0.4 });
    combat.shakeFrom(p, h.big ? 1.3 : 0.6);
    if (combat.sfx('erupt', 0.05)) playEruption(h.big ? 1.2 : 0.75);
    const pp = combat.player.object.position;
    if ((pp.x - h.x) ** 2 + (pp.z - h.z) ** 2 < (h.radius + 0.2) ** 2) combat.damagePlayer(h.damage, p);
  }

  clear() {
    for (const h of this.pool) {
      h.active = false;
      h.ring.visible = h.disc.visible = false;
    }
  }
}

/**
 * The Mecha's floor grid: the gym floor split into halves (earlier phases) or
 * quarters (later ones). It charges the zones it's about to electrify (a
 * glowing, pulsing warning surface; the safe zone glows green), then floods
 * them with energy for a couple of seconds: heavy damage every moment you're
 * standing in one.
 */
class FloorGrid {
  constructor(scene, effects) {
    this.effects = effects;
    const c = makeCanvas(128);
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 6;
    g.strokeRect(0, 0, 128, 128);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.beginPath();
    g.moveTo(64, 0);
    g.lineTo(64, 128);
    g.moveTo(0, 64);
    g.lineTo(128, 64);
    g.stroke();
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 90);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0.12)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.quads = [0, 1, 2, 3].map(() => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: this.tex, color: 0xff3a1a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      return mesh;
    });
    this.cx = 0;
    this.cz = 0;
    this.active = null;
    this._p = new THREE.Vector3();
  }

  /** Fit the four quarters to the arena (split through its middle). */
  _layout(a) {
    this.cx = (a.minX + a.maxX) / 2;
    this.cz = (a.minZ + a.maxZ) / 2;
    this.bounds = a;
    this.quads.forEach((mesh, q) => {
      const x0 = q & 1 ? this.cx : a.minX;
      const x1 = q & 1 ? a.maxX : this.cx;
      const z0 = q & 2 ? this.cz : a.minZ;
      const z1 = q & 2 ? a.maxZ : this.cz;
      mesh.position.set((x0 + x1) / 2, 0.045, (z0 + z1) / 2);
      mesh.scale.set(x1 - x0, z1 - z0, 1);
    });
    this.tex.repeat.set((a.maxX - a.minX) / 2 / 1.5, (a.maxZ - a.minZ) / 2 / 1.5);
  }

  /** Which quarter (x, z) is in: bit 0 = the +X side, bit 1 = the +Z side. */
  quadrantOf(x, z) {
    return (x > this.cx ? 1 : 0) + (z > this.cz ? 2 : 0);
  }

  begin(combat, zones, { charge = 2.6, live = 2.2, dps = 30 } = {}) {
    this.end();
    if (combat.arena) this._layout(combat.arena);
    this.active = { zones: new Set(zones), charge, live, dps, t: 0, acc: 0, done: false, sfx: false };
    return this.active;
  }

  end() {
    if (this.active) this.active.done = true;
    this.active = null;
    for (const m of this.quads) m.visible = false;
  }

  update(dt, combat) {
    const g = this.active;
    if (!g) return;
    g.t += dt;
    const charging = g.t < g.charge;
    if (!charging && g.t >= g.charge + g.live) {
      this.end();
      return;
    }
    const k = charging ? g.t / g.charge : 1;
    this.quads.forEach((mesh, q) => {
      mesh.visible = true;
      const m = mesh.material;
      if (!g.zones.has(q)) {
        // Safe: a steady green.
        m.color.setHex(0x3aff7a);
        m.opacity = charging ? 0.1 + 0.06 * Math.sin(g.t * 5) : 0.06;
      } else if (charging) {
        // Warning: amber to red, pulsing faster as it fills.
        m.color.setRGB(1, 0.55 * (1 - k) + 0.12, 0.08);
        m.opacity = 0.12 + 0.3 * k * Math.abs(Math.sin(g.t * (5 + 16 * k)));
      } else {
        // Live: crackling blue-white energy.
        m.color.setHex(0xaeeaff);
        m.opacity = 0.45 + Math.random() * 0.35;
      }
    });
    if (charging) return;
    if (!g.sfx) {
      g.sfx = true;
      playElectricStun(g.live);
      combat.shake(0.8);
    }
    // Arcs jumping off the charged floor.
    const a = this.bounds;
    for (const q of g.zones) {
      if (Math.random() > dt * 14) continue;
      const x = q & 1 ? THREE.MathUtils.lerp(this.cx, a.maxX, Math.random()) : THREE.MathUtils.lerp(a.minX, this.cx, Math.random());
      const z = q & 2 ? THREE.MathUtils.lerp(this.cz, a.maxZ, Math.random()) : THREE.MathUtils.lerp(a.minZ, this.cz, Math.random());
      this.effects.spark(this._p.set(x, 0.1, z), { count: 5, color: 0xbfefff, speed: 3, size: 0.08, life: 0.3, dir: UP });
    }
    const p = combat.player.object.position;
    if (!combat.down && g.zones.has(this.quadrantOf(p.x, p.z))) {
      g.acc += g.dps * dt;
      if (g.acc >= 6) {
        combat.damagePlayer(g.acc, this._p.set(p.x, 0.1, p.z));
        g.acc = 0;
      }
    } else {
      g.acc = 0;
    }
  }
}

/** Tracking missiles: boost out of the pods toward you, then arc over and come down on you. You can shoot them down. */
class Missiles {
  constructor(scene, effects) {
    this.effects = effects;
    const body = new THREE.CylinderGeometry(0.09, 0.09, 0.62, 8);
    body.rotateX(Math.PI / 2);
    const finA = new THREE.BoxGeometry(0.34, 0.02, 0.14);
    finA.translate(0, 0, -0.25);
    const finB = finA.clone();
    finB.rotateZ(Math.PI / 2);
    const geo = mergeGeometries([body, finA, finB]);
    const nose = new THREE.ConeGeometry(0.09, 0.2, 8);
    nose.rotateX(Math.PI / 2);
    nose.translate(0, 0, 0.41);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8dde0, metalness: 0.5, roughness: 0.4 });
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xc0291d, metalness: 0.4, roughness: 0.5, emissive: 0x300000 });
    const flameTex = radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,200,120,0.85)'], [1, 'rgba(255,120,40,0)']]);
    this.pool = Array.from({ length: 16 }, () => {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geo, bodyMat), new THREE.Mesh(nose, noseMat));
      const flame = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: flameTex, color: 0xffb060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      flame.position.z = -0.44;
      group.add(flame);
      group.visible = false;
      scene.add(group);
      return { group, flame, active: false, vel: new THREE.Vector3(), dir: new THREE.Vector3(), prev: new THREE.Vector3(), t: 0, life: 0, speed: 10, turn: 1.6, damage: 20, boost: 0.5 };
    });
    this._next = 0;
    this._to = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this.count = 0;
  }

  launch(from, dir, { speed = 10.5, turn = 1.7, damage = 20, boost = 0.55 } = {}) {
    const m = this.pool[this._next];
    this._next = (this._next + 1) % this.pool.length;
    m.active = true;
    m.group.visible = true;
    m.group.position.copy(from);
    m.vel.copy(dir).normalize().multiplyScalar(speed * 0.8);
    Object.assign(m, { t: 0, life: 7, speed, turn, damage, boost, committed: false });
    return m;
  }

  update(dt, combat) {
    const p = combat.player.object.position;
    let count = 0;
    for (const m of this.pool) {
      if (!m.active) continue;
      count++;
      m.t += dt;
      m.life -= dt;
      const pos = m.group.position;
      m.prev.copy(pos);
      const h = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (m.t > m.boost && h < 3.2) m.committed = true; // locked into its dive: a late sidestep makes it miss
      if (m.committed) {
        m.vel.y -= 9 * dt;
      } else if (m.t > m.boost) {
        // Arc in on the floor where you're standing: aim at a point above you that sinks
        // as it closes in, so it curves over and comes down on you (turning at most `turn` rad/s).
        const loft = h > 3 ? Math.min(3.5, h * 0.3) : 0;
        this._to.set(p.x, 0.35 + loft, p.z).sub(pos).normalize();
        m.dir.copy(m.vel).normalize();
        const angle = m.dir.angleTo(this._to);
        if (angle > 1e-4) m.dir.lerp(this._to, Math.min(1, (m.turn * dt) / angle)).normalize();
        m.vel.copy(m.dir).multiplyScalar(m.speed);
      } else {
        m.vel.y -= 4 * dt; // the launch kick bleeding off
      }
      // Never up into the roof: over 9m it's forced to level off and dive.
      if (pos.y > 9 && m.vel.y > 0) m.vel.y = -1;
      pos.addScaledVector(m.vel, dt);
      m.group.lookAt(this._w.copy(pos).add(m.vel));
      m.flame.scale.setScalar(0.45 + Math.random() * 0.3);
      if (Math.random() < 0.6) this.effects.spark(m.prev, { count: 1, color: 0x8c8c8c, speed: 0.4, size: 0.22, life: 0.6, gravity: -1.2 });
      if (Math.hypot(pos.x - p.x, pos.z - p.z) < 0.65 && pos.y > 0.2 && pos.y < p.y + 0.35) {
        this._explode(m, combat, 1);
        continue;
      }
      const step = m.prev.distanceTo(pos);
      if (step > 1e-5) {
        this._w.subVectors(pos, m.prev).divideScalar(step);
        if (rayBoxes(m.prev, this._w, combat.worldBoxes, step) < step) {
          this._explode(m, combat, 0.8);
          continue;
        }
      }
      if (pos.y < 0.15 || m.life <= 0) this._explode(m, combat, 0.8, 2.0);
    }
    this.count = count;
  }

  _explode(m, combat, mult, radius = 2.4) {
    m.active = false;
    m.group.visible = false;
    combat.explode(m.group.position, radius, m.damage * mult);
  }

  /** Your bullet: the nearest missile within `far` along the ray, or null. */
  raycast(origin, dir, far) {
    let best = null;
    let bestT = far;
    for (const m of this.pool) {
      if (!m.active) continue;
      this._w.subVectors(m.group.position, origin);
      const t = this._w.dot(dir);
      if (t < 0 || t > bestT) continue;
      if (this._w.lengthSq() - t * t < 0.5 * 0.5) {
        best = m;
        bestT = t;
      }
    }
    return best ? { missile: best, dist: bestT } : null;
  }

  shootDown(m, combat) {
    m.active = false;
    m.group.visible = false;
    combat.explode(m.group.position, 1.8, 6);
    Achievements.bump('missilesShot');
  }

  clear() {
    for (const m of this.pool) {
      m.active = false;
      m.group.visible = false;
    }
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// The Mecha: Coach Billing's walking tank
// ---------------------------------------------------------------------------

export const MECHA = {
  radius: 2.3,
  walk: [1.5, 1.7, 2.3, 1.9], // m/s, phases 1-4
  turn: [0.95, 1.05, 1.55, 1.25], // rad/s
  attackGap: [1.25, 1.45, 0.8, 1.05], // seconds of walking between attacks
  legHp: [0, 260, 240, 300], // damage to the ankle actuators before it stumbles
  domeHp: [0, 220, 240, 280], // damage into the exposed cockpit to end the phase
  exposeTime: [0, 7.0, 6.2, 5.6], // how long the cockpit stays open after a stumble
  keepDist: 11,
  laserHigh: 1.45, // duck / slide under it
  laserLow: 0.55, // get behind something solid
  laserDamage: 22,
  eruptDamage: 22,
  stompDamage: 34,
  stompRadius: 6.5,
  boltDamage: 8,
  missileDamage: 15,
};
// Phases 1-2 electrify half the floor at a time; phases 3-4 three quarters of it. The red (low) laser sweep: get behind something.
const MECHA_ATTACKS = [
  ['gridHalf', 'laserLow', 'seismic', 'mortar', 'gridHalf', 'laserLow'],
  ['gridHalf', 'laserLow', 'seismic', 'mortar', 'fan', 'gridHalf'],
  ['spread', 'gridQuad', 'laserLow', 'mortar', 'spread', 'gridQuad', 'seismic'],
  ['missiles', 'gridQuad', 'laserLow', 'mortar', 'fan', 'missiles', 'gridQuad'],
];

function hazardStripeTexture() {
  const c = makeCanvas(128, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#e0b020';
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#16181a';
  for (let x = -32; x < 160; x += 32) {
    g.beginPath();
    g.moveTo(x, 32);
    g.lineTo(x + 16, 32);
    g.lineTo(x + 32, 0);
    g.lineTo(x + 16, 0);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}

function decalTexture(text) {
  const c = makeCanvas(256, 72);
  const g = c.getContext('2d');
  g.font = 'bold 56px Arial Black, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#16181a';
  g.fillText(text, 128, 38);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Spidering cracks for the cockpit glass (more of them at higher levels). */
function crackTexture(level) {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(235,250,255,0.95)';
  g.lineWidth = 1.7;
  const hubs = level === 1 ? 3 : 7;
  for (let h = 0; h < hubs; h++) {
    const cx = 30 + Math.random() * 196;
    const cy = 60 + Math.random() * 110;
    const rays = 7 + Math.floor(Math.random() * 5);
    for (let r = 0; r < rays; r++) {
      let x = cx;
      let y = cy;
      const a = (r / rays) * Math.PI * 2 + Math.random() * 0.4;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 5; s++) {
        x += Math.cos(a + (Math.random() - 0.5) * 0.9) * (8 + Math.random() * 16);
        y += Math.sin(a + (Math.random() - 0.5) * 0.9) * (8 + Math.random() * 16);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.beginPath();
    g.arc(cx, cy, 6 + Math.random() * 10, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const MECHA_BUSY = new Set(['off', 'drop', 'land', 'intro', 'phaseBreak', 'dying', 'dead', 'scripted']);

/**
 * Coach Billing's Mecha: ~7.5m of armored, school-gold steel with him inside a
 * glass cockpit dome. Phase 1 it can't be hurt: survive its sweeping lasers,
 * floor eruptions and stomps. From phase 2 its ankle actuators (the glowing
 * orange rings) are the weak point: shoot them until it stumbles to one knee,
 * its dome armor cracks open, and you have a few seconds to shoot the glass.
 * Phase 3 is faster, phase 4 adds tracking missiles (and a shield on its legs
 * while Tank ELDARs are feeding it). Every shot anywhere else sparks off.
 */
class Mecha {
  constructor(combat) {
    this.combat = combat;
    this.root = new THREE.Group();
    this.mesh = this.root; // player collision reads .mesh / .radius
    this.radius = MECHA.radius;
    this.hitboxes = [];
    this.scrapParts = [];
    this._build();
    for (const h of this.hitboxes) h.userData.owner = this;
    this.root.position.set(0, -60, 0);
    combat.scene.add(this.root);

    this.active = false;
    this.aiEnabled = false;
    this.dead = false;
    this.state = 'off';
    this.phase = 1;
    this.t = 0;
    this.legHp = 0;
    this.domeHp = 0;
    this.exposeT = 0;
    this.crackLevel = 0;
    this.attack = null;
    this.attackT = 2;
    this.bag = [];
    this.yaw = 0;
    this.vy = 0;
    this.walkPhase = 0;
    this._stepSide = 0;
    this.legShield = false;
    this.shieldSources = [];
    this._shieldSpark = 0;
    this.flashFeet = 0;
    this.flashDome = 0;
    this.scrap = null;
    this.anim = { speed: 0, kneel: 0, lift: 0, fist: 0, aim: 0, aimPitch: 0, pods: 0, dome: 0, lean: 0, roar: 0 };
    this._from = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._joints = [
      ...this.legs.flatMap((l) => [l.hip, l.knee, l.ankle]),
      ...this.arms.flatMap((a) => [a.shoulder, a.elbow]),
      this.torso,
      this.dome,
    ];
    this._anchors = this._joints.map(() => new THREE.Vector3());
  }

  _build() {
    const M = (this.mats = {
      paint: new THREE.MeshStandardMaterial({ color: 0xc9961c, metalness: 0.55, roughness: 0.42 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x262b31, metalness: 0.7, roughness: 0.45 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x6d767e, metalness: 0.8, roughness: 0.35 }),
      stripe: new THREE.MeshStandardMaterial({ map: hazardStripeTexture(), metalness: 0.4, roughness: 0.5 }),
      plate: new THREE.MeshStandardMaterial({ color: 0x3a4148, metalness: 0.75, roughness: 0.38, side: THREE.DoubleSide }),
      sensor: new THREE.MeshBasicMaterial({ color: 0xff3322 }),
      actuator: new THREE.MeshBasicMaterial({ color: 0xff8a1a }),
      emitter: new THREE.MeshBasicMaterial({ color: 0xff5a3a }),
      glass: new THREE.MeshStandardMaterial({ color: 0xa8e8ff, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.22, depthWrite: false }),
      cracks: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }),
      hidden: this.combat.mats.hidden,
    });
    const add = (geo, mat, parent, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      parent.add(m);
      return m;
    };
    const hit = (w, h, d, parent, zone, x, y, z) => {
      const m = add(new THREE.BoxGeometry(w, h, d), M.hidden, parent, x, y, z);
      m.userData.zone = zone;
      this.hitboxes.push(m);
      return m;
    };
    const body = (this.body = new THREE.Group());
    this.root.add(body);
    this.pelvis = add(new THREE.BoxGeometry(2.3, 0.7, 1.4), M.dark, body, 0, 3.2, 0);

    // Legs (index 0 = anatomical right, -X, like the other rigs).
    this.legs = [-1, 1].map((s) => {
      const hip = new THREE.Group();
      hip.position.set(s * 1.1, 3.2, 0);
      body.add(hip);
      add(new THREE.SphereGeometry(0.42, 12, 10), M.steel, hip);
      const thigh = add(new THREE.BoxGeometry(0.85, 1.5, 0.95), M.paint, hip, 0, -0.75, 0);
      add(new THREE.BoxGeometry(0.9, 0.28, 1.0), M.stripe, hip, 0, -0.35, 0.01);
      const knee = new THREE.Group();
      knee.position.y = -1.45;
      hip.add(knee);
      add(new THREE.SphereGeometry(0.46, 12, 10), M.dark, knee);
      const shin = add(new THREE.BoxGeometry(0.8, 1.35, 0.9), M.paint, knee, 0, -0.62, 0.02);
      add(new THREE.BoxGeometry(0.62, 0.8, 0.14), M.steel, knee, 0, -0.55, 0.5);
      const ankle = new THREE.Group();
      ankle.position.y = -1.3;
      knee.add(ankle);
      // The weak point: a glowing actuator ring, sticking out both sides of its housing.
      const actuator = add(new THREE.CylinderGeometry(0.34, 0.34, 1.02, 16), M.actuator, ankle, 0, 0, 0, 0, 0, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.39, 0.39, 0.62, 16), M.dark, ankle, 0, 0, 0, 0, 0, Math.PI / 2);
      const foot = add(new THREE.BoxGeometry(1.15, 0.4, 1.75), M.dark, ankle, 0, -0.26, 0.28);
      add(new THREE.BoxGeometry(1.18, 0.12, 0.3), M.stripe, ankle, 0, -0.1, 1.08);
      hit(1.45, 1.25, 2.0, ankle, 'mfoot', 0, -0.05, 0.25);
      hit(1.0, 2.3, 1.1, hip, 'marmor', 0, -1.15, 0);
      this.scrapParts.push(thigh, shin, foot, actuator);
      return { hip, knee, ankle };
    });

    const torso = (this.torso = new THREE.Group());
    torso.position.y = 3.45;
    body.add(torso);
    this.hull = add(new THREE.BoxGeometry(3.1, 2.1, 2.3), M.paint, torso, 0, 1.15, 0);
    add(new THREE.BoxGeometry(3.16, 0.34, 2.36), M.stripe, torso, 0, 0.26, 0);
    add(new THREE.BoxGeometry(2.2, 1.2, 0.2), M.dark, torso, 0, 1.05, 1.2);
    add(new THREE.PlaneGeometry(1.5, 0.42), new THREE.MeshStandardMaterial({ map: decalTexture('COACH'), transparent: true, roughness: 0.6 }), torso, 0, 1.2, 1.31);
    this.sensor = add(new THREE.BoxGeometry(1.7, 0.14, 0.1), M.sensor, torso, 0, 1.82, 1.17);
    [-1, 1].forEach((s) => add(new THREE.CylinderGeometry(0.2, 0.25, 1.1, 12), M.dark, torso, s * 0.9, 2.35, -0.95, -0.3));
    hit(3.2, 2.2, 2.4, torso, 'marmor', 0, 1.15, 0);

    // The cockpit: Billing under a glass dome, behind two armor half-shells.
    const dome = (this.dome = new THREE.Group());
    dome.position.set(0, 2.25, 0.3);
    torso.add(dome);
    add(new THREE.CylinderGeometry(1.14, 1.26, 0.3, 24), M.dark, dome, 0, -0.08, 0);
    this.glass = add(new THREE.SphereGeometry(1.05, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), M.glass, dome);
    this.glass.renderOrder = 4;
    this.cracks = add(new THREE.SphereGeometry(1.062, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), M.cracks, dome);
    this.cracks.renderOrder = 5;
    this.cracks.visible = false;
    const pilot = createHumanoid({ ...COACH_BILLING_LOOK, scale: 1 });
    setSeatedPose(pilot);
    pilot.position.set(0, -0.6, -0.1);
    dome.add(pilot);
    this.pilot = pilot;
    [-1, 1].forEach((s) => add(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 6), M.steel, dome, s * 0.3, -0.32, 0.42, 0.55));
    this.plates = [-1, 1].map((s) => {
      const hinge = new THREE.Group();
      dome.add(hinge);
      const half = add(new THREE.SphereGeometry(1.16, 20, 12, s < 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI, 0, Math.PI * 0.57), M.plate, hinge);
      this.scrapParts.push(half);
      return hinge;
    });
    hit(2.3, 1.5, 2.3, dome, 'dome', 0, 0.45, 0);
    this.cockpitLight = new THREE.PointLight(0x9fe8ff, 0, 5, 2);
    this.cockpitLight.position.set(0, 0.35, 0.6);
    dome.add(this.cockpitLight);

    // Arms: index 0 (right, -X) carries the laser cannon, index 1 (left) the fist.
    this.arms = [-1, 1].map((s, i) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 1.95, 1.75, 0);
      torso.add(shoulder);
      add(new THREE.SphereGeometry(0.55, 14, 10), M.dark, shoulder);
      const pauldron = add(new THREE.BoxGeometry(1.0, 0.5, 1.2), M.paint, shoulder, s * 0.15, 0.45, 0);
      const upper = add(new THREE.BoxGeometry(0.7, 1.3, 0.75), M.paint, shoulder, 0, -0.7, 0);
      const elbow = new THREE.Group();
      elbow.position.y = -1.35;
      shoulder.add(elbow);
      add(new THREE.SphereGeometry(0.4, 12, 10), M.dark, elbow);
      let fore;
      if (i === 0) {
        fore = add(new THREE.CylinderGeometry(0.36, 0.42, 1.9, 16), M.dark, elbow, 0, -0.95, 0);
        add(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 16), M.paint, elbow, 0, -0.5, 0);
        this.emitter = add(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 16), M.emitter, elbow, 0, -1.92, 0);
        this.muzzle = new THREE.Object3D();
        this.muzzle.position.set(0, -2.05, 0);
        elbow.add(this.muzzle);
      } else {
        add(new THREE.BoxGeometry(0.75, 1.2, 0.8), M.paint, elbow, 0, -0.6, 0);
        fore = add(new THREE.BoxGeometry(1.05, 0.95, 1.05), M.dark, elbow, 0, -1.55, 0);
        add(new THREE.BoxGeometry(1.08, 0.2, 1.08), M.stripe, elbow, 0, -1.2, 0);
        this.fist = fore;
      }
      hit(0.9, 1.45, 0.9, shoulder, 'marmor', 0, -0.7, 0);
      hit(1.1, 2.1, 1.1, elbow, 'marmor', 0, -1.05, 0);
      this.scrapParts.push(upper, fore, pauldron);
      return { shoulder, elbow };
    });

    // Missile pods on its shoulders (lids swing up; they also lob the mortar shells).
    this.pods = [-1, 1].map((s) => {
      const pod = new THREE.Group();
      pod.position.set(s * 1.25, 2.4, -0.35);
      torso.add(pod);
      const box = add(new THREE.BoxGeometry(0.95, 0.62, 1.1), M.dark, pod);
      for (const [tx, ty] of [[-0.2, 0.12], [0.2, 0.12], [-0.2, -0.14], [0.2, -0.14]]) add(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 10), M.emitter, pod, tx, ty, 0.56, Math.PI / 2);
      const lid = new THREE.Group();
      lid.position.set(0, 0.31, 0.56);
      pod.add(lid);
      add(new THREE.BoxGeometry(0.97, 0.64, 0.06), M.paint, lid, 0, -0.31, 0.02);
      const mouth = new THREE.Object3D();
      mouth.position.set(0, 0, 0.75);
      pod.add(mouth);
      this.scrapParts.push(box);
      return { pod, lid, mouth };
    });

    // A shield bubble around its legs (phase 4, while Tank ELDARs feed it), and the tethers to them.
    this.shieldMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1, 2.35, 3.6, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x59c8ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.shieldMesh.position.y = 1.8;
    this.shieldMesh.visible = false;
    this.root.add(this.shieldMesh);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
    this.tethers = new THREE.LineSegments(
      tg,
      new THREE.LineBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.tethers.frustumCulled = false;
    this.tethers.visible = false;
    this.combat.scene.add(this.tethers);
  }

  get position() {
    return this.root.position;
  }

  get alive() {
    return this.active && !this.dead;
  }

  get engaged() {
    return this.alive && this.aiEnabled;
  }

  get exposed() {
    return this.state === 'stumble' && this.anim.dome > 0.7;
  }

  aimPoint(out) {
    this.torso.getWorldPosition(out);
    out.y += 1.2;
    return out;
  }

  domePoint(out) {
    return this.dome.getWorldPosition(out);
  }

  muzzleWorld(out) {
    return this.muzzle.getWorldPosition(out);
  }

  /** Crash in from `height` (through the roof) at `at`, facing `yaw`. */
  drop(at, yaw, height = 16) {
    this.active = true;
    this.dead = false;
    this.aiEnabled = false;
    this.state = 'drop';
    this.t = 0;
    this.vy = -3;
    this.root.position.set(at.x, height, at.z);
    this.yaw = yaw;
    this.anim.kneel = 0.35;
    this.cockpitLight.intensity = 2.2;
    this.combat.refreshTargets();
  }

  /** Stand (at `at`, facing `yaw`, if given) topped up for phase `phase`, walking. */
  beginPhase(phase, at = null, yaw = null) {
    this.phase = phase;
    this.legHp = MECHA.legHp[phase - 1];
    this.domeHp = MECHA.domeHp[phase - 1];
    if (at) this.root.position.set(at.x, 0, at.z);
    if (yaw !== null) this.yaw = yaw;
    this.active = true;
    this.state = 'walk';
    this.attack = null;
    this.attackT = 2.2;
    this.bag = [];
    Object.assign(this.anim, { kneel: 0, lift: 0, fist: 0, aim: 0, pods: 0, dome: 0, lean: 0, roar: 0 });
    this.combat.endBeams();
    this.setLegShield(false, []);
  }

  /** Stand still and do nothing (cutscenes between phases). */
  hold() {
    if (this.state === 'attack') this.combat.endBeams();
    this.state = 'scripted';
    this.attack = null;
    this.anim.aim = 0;
    this.anim.fist = 0;
    this.anim.lift = 0;
  }

  setLegShield(on, sources = []) {
    this.legShield = on;
    this.shieldSources = sources;
  }

  /** Overheated at the end of phase 1: venting, head down (Ben's cutscene plays). */
  overheat() {
    this.hold();
    this.state = 'phaseBreak';
    this.t = 0;
    this.anim.kneel = 0.35;
    playSteamVent(2.4);
  }

  /** zone: 'mfoot' (the ankle actuators), 'dome' (the cockpit glass), 'marmor' (everything else). */
  takeHit(zone, damage = RIFLE.damage) {
    if (!this.alive) return null;
    if (zone === 'mfoot') {
      if (this.phase < 2 || MECHA_BUSY.has(this.state) || this.state === 'stumble' || this.state === 'recover') return 'armor';
      if (this.legShield) {
        this._shieldSpark = 0.15;
        if (this.combat.onMechaShielded) this.combat.onMechaShielded();
        return 'armor';
      }
      this.legHp -= damage;
      this.flashFeet = 0.08;
      if (this.legHp <= 0) this._stumble();
      return 'hit';
    }
    if (zone === 'dome' && this.exposed) {
      this.domeHp -= damage;
      this.flashDome = 0.08;
      if (this.domeHp <= 0) {
        this._domeBroken();
        return 'kill';
      }
      return 'head';
    }
    if (this.combat.onMechaArmorHit) this.combat.onMechaArmorHit(zone);
    return 'armor';
  }

  /** The boss bar: every phase's cockpit integrity, end to end (full through phase 1). */
  healthFraction() {
    let total = 0;
    let left = 0;
    for (let p = 2; p <= 4; p++) {
      const hp = MECHA.domeHp[p - 1];
      total += hp;
      if (p > this.phase) left += hp;
      else if (p === this.phase) left += Math.max(0, this.domeHp);
    }
    return left / total;
  }

  /** The second bar: the legs' stagger meter, or how long the cockpit stays open. */
  subFraction() {
    if (this.phase < 2 || this.state === 'phaseBreak' || this.state === 'dying' || this.state === 'dead') return null;
    if (this.state === 'stumble') return Math.max(0, this.exposeT) / MECHA.exposeTime[this.phase - 1];
    if (this.state === 'recover') return 0;
    return Math.max(0, this.legHp) / MECHA.legHp[this.phase - 1];
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const ai = this.aiEnabled && !this.combat.frozen;
    const a = this.anim;
    const pos = this.root.position;
    switch (this.state) {
      case 'drop':
        this.vy -= 24 * dt;
        pos.y += this.vy * dt;
        if (pos.y <= 0) {
          pos.y = 0;
          this.state = 'land';
          this.t = 0;
          a.kneel = 1;
          this._landImpact();
        }
        break;
      case 'land':
        if (this.t > 1.1) a.kneel = Math.max(0, a.kneel - dt * 1.1);
        if (this.t > 2.1) {
          this.state = 'intro';
          this.t = 0;
          a.roar = 1;
          playBossRoar();
        }
        break;
      case 'intro':
        if (this.t > 1.9) a.roar = 0;
        if (this.aiEnabled && this.t > 2) this.state = 'walk';
        break;
      case 'walk':
        if (ai) this._walk(dt);
        break;
      case 'attack':
        if (ai) this._updateAttack(dt);
        break;
      case 'stumble':
        if (!this.combat.frozen) this._updateStumble(dt);
        break;
      case 'recover':
        if (!this.combat.frozen) this._updateRecover(dt);
        break;
      case 'phaseBreak':
        if (Math.random() < dt * 3) this._steamPuff();
        break;
      case 'dying':
        this._updateDying(dt);
        break;
      case 'dead':
        this._updateScrap(dt);
        break;
      default:
        break;
    }
    if (this.state !== 'walk') a.speed = Math.max(0, a.speed - dt * 4);
    this._pose(dt);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld(true);
    this._updateGlow(dt);
    this._updateShield(dt);
    for (let i = 0; i < this._joints.length; i++) this._joints[i].getWorldPosition(this._anchors[i]);
  }

  _landImpact() {
    const combat = this.combat;
    const pos = this.root.position;
    playLanding(true);
    playMechStep(1.4);
    playEruption(1.3);
    combat.shake(1.8);
    combat.effects.ring(pos, { from: 1, to: 13, life: 1.0 });
    combat.effects.spark(this._p.copy(pos).setY(0.3), { count: 40, color: 0xd8b890, speed: 8, size: 0.13, life: 0.7 });
    combat.effects.chunks(this._p, { count: 10, speed: 7, size: 0.5, dir: UP });
  }

  _steamPuff() {
    const i = Math.random() < 0.5 ? 0 : 1;
    this.torso.localToWorld(this._p.set(i ? 0.9 : -0.9, 2.95, -1.1));
    this.combat.effects.spark(this._p, { count: 6, color: 0xdfe6ea, speed: 1.2, size: 0.45, life: 1.1, gravity: -2.5 });
  }

  _track(dt, rate = 1) {
    const pp = this.combat.player.object.position;
    const pos = this.root.position;
    this.yaw = turnToward(this.yaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), MECHA.turn[this.phase - 1] * rate * dt);
  }

  /** Radians below horizontal from its cannon shoulder to your chest. */
  _pitchToPlayer() {
    const pp = this.combat.player.object.position;
    const pos = this.root.position;
    const d = Math.max(2, Math.hypot(pp.x - pos.x, pp.z - pos.z) - 1.5);
    return THREE.MathUtils.clamp(Math.atan2(5.2 - (pp.y - 0.45), d), 0.05, 1.2);
  }

  _walk(dt) {
    const combat = this.combat;
    const pos = this.root.position;
    const pp = combat.player.object.position;
    const i = this.phase - 1;
    const dx = pp.x - pos.x;
    const dz = pp.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const desired = Math.atan2(dx, dz);
    this.yaw = turnToward(this.yaw, desired, MECHA.turn[i] * dt);
    const off = Math.abs(angleDiff(desired, this.yaw));
    let speed = 0;
    if (dist > MECHA.keepDist + 2 && off < 0.8) speed = MECHA.walk[i];
    else if (dist < 6.5) speed = -MECHA.walk[i] * 0.55;
    if (speed) {
      pos.x += Math.sin(this.yaw) * speed * dt;
      pos.z += Math.cos(this.yaw) * speed * dt;
      combat.pushOut(pos, this.radius); // (around the bleachers and the equipment)
      combat.clampArena(pos.x, pos.z, pos, 3.2);
    }
    this.anim.speed = Math.abs(speed);
    this.anim.aim = Math.max(0, this.anim.aim - dt * 3);
    this.attackT -= dt;
    if (this.attackT <= 0) this._startAttack(dist);
  }

  _nextAttack(dist) {
    if (dist < MECHA.stompRadius - 0.8) return 'stomp';
    if (!this.bag.length) {
      this.bag = MECHA_ATTACKS[this.phase - 1].slice();
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      if (this.bag[this.bag.length - 1] === this._lastKind) this.bag.unshift(this.bag.pop());
    }
    return this.bag.pop();
  }

  _startAttack(dist) {
    const kind = this._nextAttack(dist);
    this._lastKind = kind;
    this.state = 'attack';
    this.attack = { kind, t: 0, stage: 0, n: 0, shotT: 0, sweep: null, height: 0 };
  }

  _endAttack() {
    this.state = 'walk';
    this.attack = null;
    this.anim.aim = 0;
    this.attackT = MECHA.attackGap[this.phase - 1] * rand(0.85, 1.2) * difficulty.fireMult;
  }

  _updateAttack(dt) {
    const at = this.attack;
    at.t += dt;
    switch (at.kind) {
      case 'laserHigh':
      case 'laserLow':
        this._laser(dt, at);
        break;
      case 'gridHalf':
      case 'gridQuad':
        this._grid(dt, at);
        break;
      case 'seismic':
        this._seismic(dt, at);
        break;
      case 'mortar':
        this._mortar(dt, at);
        break;
      case 'stomp':
        this._stomp(dt, at);
        break;
      case 'fan':
        this._fan(dt, at);
        break;
      case 'spread':
        this._spread(dt, at);
        break;
      case 'missiles':
        this._missiles(dt, at);
        break;
      default:
        this._endAttack();
    }
  }

  /** Sweep a laser around itself (it turns with the beam; the cannon points down at it). */
  _laser(dt, at) {
    const combat = this.combat;
    const a = this.anim;
    if (at.stage === 0) {
      at.stage = 1;
      const high = at.kind === 'laserHigh';
      const pp = combat.player.object.position;
      const pos = this.root.position;
      const pa = Math.atan2(pp.x - pos.x, pp.z - pos.z);
      const dir = Math.random() < 0.5 ? 1 : -1;
      const charge = (this.phase >= 3 ? 0.95 : 1.15) * Math.max(0.8, difficulty.fireMult);
      at.height = high ? MECHA.laserHigh : MECHA.laserLow;
      at.sweep = combat.lasers.begin({
        pivot: pos,
        from: pa - dir * 1.2,
        to: pa + dir * 1.2,
        height: at.height,
        charge,
        duration: this.phase >= 3 ? 1.25 : 1.6,
        damage: MECHA.laserDamage,
        emitter: (out) => this.muzzleWorld(out),
        color: high ? 0xffa21a : 0xff2a14,
      });
      playLaserCharge(charge);
      combat.hud.warn(high ? '▼  DUCK OR SLIDE UNDER IT  ▼' : '▲  GET BEHIND COVER  ▲', charge + 1.2, high ? 'duck' : 'cover');
      if (combat.onMechaAttack) combat.onMechaAttack(at.kind);
    }
    const s = at.sweep;
    this.yaw = dampAngle(this.yaw, s.angle, Math.min(1, dt * 9));
    a.aim = Math.min(1, a.aim + dt * 4);
    a.aimPitch = at.height > 1 ? 0.92 : 1.12;
    if (s.done) this._endAttack();
  }

  /**
   * The floor grid: fist raised, it charges half the gym (phases 1-2: the half
   * you're on) or three of its four quarters (phases 3-4: only one safe quarter,
   * never the one you're in), then slams the fist down and floods them. From
   * phase 3 it keeps shooting at you while you run for it.
   */
  _grid(dt, at) {
    const combat = this.combat;
    const g = combat.grid;
    if (at.stage === 0) {
      at.stage = 1;
      const quad = at.kind === 'gridQuad';
      const pp = combat.player.object.position;
      if (combat.arena) g._layout(combat.arena);
      let zones;
      if (quad) {
        const mine = g.quadrantOf(pp.x, pp.z);
        const others = [0, 1, 2, 3].filter((q) => q !== mine);
        const safe = others[Math.floor(Math.random() * others.length)];
        zones = [0, 1, 2, 3].filter((q) => q !== safe);
      } else {
        zones = pp.x < g.cx ? [0, 2] : [1, 3];
      }
      const charge = (quad ? (this.phase >= 4 ? 2.9 : 3.2) : 2.7) * Math.max(0.85, difficulty.fireMult); // (quarters: +0.5s to find the safe one)
      at.grid = g.begin(combat, zones, { charge, live: quad ? 2.4 : 2.2, dps: quad ? 34 : 30 });
      at.shotT = 0.8;
      playLaserCharge(charge);
      playRobotCharge(0.4);
      combat.hud.warn(
        quad ? '⚡  THE FLOOR IS CHARGING: GET TO THE GREEN QUARTER  ⚡' : '⚡  THIS HALF IS CHARGING: SPRINT TO THE OTHER SIDE  ⚡',
        charge + 0.4,
        'cover',
      );
      if (combat.onMechaAttack) combat.onMechaAttack(at.kind);
    }
    const grid = at.grid;
    this._track(dt, 0.6);
    this.anim.fist = at.t < grid.charge ? Math.min(1, at.t / 0.6) : -1;
    if (!at.slammed && at.t >= grid.charge) {
      at.slammed = true;
      playStomp();
      combat.shake(1.0);
    }
    // Later phases: pot shots while you scramble.
    if (this.phase >= 3) {
      at.shotT -= dt;
      if (at.shotT <= 0) {
        at.shotT = 1.0;
        this.anim.aim = 1;
        this.anim.aimPitch = this._pitchToPlayer();
        this.muzzleWorld(this._from);
        combat.playerAimPoint(this._from, this._aim, 20);
        this._dir.subVectors(this._aim, this._from);
        for (let k = 0; k < 3; k++) {
          this._tmp.copy(this._dir).applyAxisAngle(UP, (k - 1) * 0.14).add(this._from);
          combat.fireBolt(this._from, this._tmp, { damage: 6, spread: 0.01, speed: 20, size: 1.4, color: 0xff3a1a });
        }
        combat.effects.flash(this._from, { size: 1.1, color: 0xff5030, life: 0.07 });
        if (combat.sfx('spread', 0.08)) playBoltFire(0.8, 1.1);
      }
    }
    if (grid.done) {
      this.anim.fist = 0;
      this.anim.aim = 0;
      this._endAttack();
    }
  }

  /** Fist up... and down: lines of eruptions rip across the floor toward you. */
  _seismic(dt, at) {
    const combat = this.combat;
    const pos = this.root.position;
    if (at.stage === 0) {
      at.stage = 1;
      const pp = combat.player.object.position;
      const base = Math.atan2(pp.x - pos.x, pp.z - pos.z);
      const lines = this.phase >= 2 ? [-0.38, 0, 0.38] : [-0.22, 0.22];
      for (const off of lines) {
        const dx = Math.sin(base + off);
        const dz = Math.cos(base + off);
        for (let k = 0; k < 16; k++) {
          const r = 3.3 + k * 1.75;
          const x = pos.x + dx * r;
          const z = pos.z + dz * r;
          if (!combat.inArena(x, z)) break;
          combat.hazards.add(x, z, { radius: 1.35, delay: 1.0 + k * 0.05, damage: MECHA.eruptDamage });
        }
      }
      playRobotCharge(0.4);
      if (combat.onMechaAttack) combat.onMechaAttack('seismic');
    }
    this._track(dt, 0.4);
    this.anim.fist = at.t < 0.85 ? Math.min(1, at.t / 0.55) : -1;
    if (at.t >= 0.85 && at.stage === 1) {
      at.stage = 2;
      playStomp();
      combat.shake(1.1);
      this.fist.getWorldPosition(this._p);
      this._p.y = 0.2;
      combat.effects.ring(this._p, { from: 0.5, to: 5, life: 0.5, color: 0xffc080 });
      combat.effects.chunks(this._p, { count: 6, speed: 5, size: 0.4, dir: UP });
    }
    if (at.t > 1.9) {
      this.anim.fist = 0;
      this._endAttack();
    }
  }

  /** The shoulder pods lob shells: circles fill in around you (and where you're heading). */
  _mortar(dt, at) {
    const combat = this.combat;
    if (at.stage === 0) {
      at.stage = 1;
      const pp = combat.player.object.position;
      const pv = combat._pv;
      const targets = [[pp.x, pp.z], [pp.x + pv.x * 1.1, pp.z + pv.z * 1.1]];
      const extra = this.phase >= 2 ? 4 : 3;
      for (let i = 0; i < extra; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = rand(2.6, 6.5);
        targets.push([pp.x + Math.sin(ang) * r, pp.z + Math.cos(ang) * r]);
      }
      targets.forEach(([x, z], i) => {
        combat.clampArena(x, z, this._c, 1.5);
        combat.hazards.add(this._c.x, this._c.z, { radius: 2.0, delay: 1.25 + i * 0.1, damage: MECHA.eruptDamage });
      });
      for (const p of this.pods) {
        p.mouth.getWorldPosition(this._p);
        combat.effects.flash(this._p, { size: 1.3, color: 0xffa060, life: 0.14 });
        combat.effects.spark(this._p, { count: 8, color: 0xdfe6ea, speed: 2, size: 0.3, life: 0.8, gravity: -2 });
      }
      playTankCannon(0.8);
      combat.shake(0.35);
      if (combat.onMechaAttack) combat.onMechaAttack('mortar');
    }
    this.anim.pods = at.t < 0.8 ? 1 : 0;
    if (at.t > 1.6) this._endAttack();
  }

  /** Too close: a foot comes up and it stomps a shockwave around itself. */
  _stomp(dt, at) {
    const combat = this.combat;
    const pos = this.root.position;
    if (at.stage === 0) {
      at.stage = 1;
      combat.hazards.add(pos.x, pos.z, { radius: MECHA.stompRadius, delay: 1.0, damage: MECHA.stompDamage, big: true });
      playRobotCharge(0.35);
      combat.hud.warn('!  GET CLEAR  !', 1.0, 'danger');
    }
    this.anim.lift = at.t < 1.0 ? Math.min(1, at.t / 0.6) : 0;
    if (at.t >= 1.0 && at.stage === 1) {
      at.stage = 2;
      playStomp();
      playMechStep(1.3);
      combat.shake(1.4);
    }
    if (at.t > 1.7) this._endAttack();
  }

  /** Three rows of plasma bolts fanned across you (alternate rows fill the gaps). */
  _fan(dt, at) {
    const combat = this.combat;
    const a = this.anim;
    this._track(dt, 1.4);
    a.aim = Math.min(1, a.aim + dt * 4);
    a.aimPitch = this._pitchToPlayer();
    if (at.stage === 0) {
      at.stage = 1;
      playRobotCharge(0.5);
    }
    if (at.t < 0.75) return;
    at.shotT -= dt;
    if (at.n < 3 && at.shotT <= 0) {
      this.muzzleWorld(this._from);
      combat.playerAimPoint(this._from, this._aim, 16);
      this._dir.subVectors(this._aim, this._from);
      for (let k = 0; k < 9; k++) {
        const fan = (k - 4 + (at.n % 2) * 0.5) * 0.07;
        this._tmp.copy(this._dir).applyAxisAngle(UP, fan).add(this._from);
        combat.fireBolt(this._from, this._tmp, { damage: MECHA.boltDamage, spread: 0.008, speed: 16, size: 1.8, color: 0xff6a2a });
      }
      combat.effects.flash(this._from, { size: 1.5, color: 0xff7040, life: 0.1 });
      playBoltFire(0.5, 1.3);
      at.n++;
      at.shotT = 0.34;
    }
    if (at.n >= 3 && at.shotT < -0.4) this._endAttack();
  }

  /** Phase 3: rapid-fire laser spreads raked back and forth. */
  _spread(dt, at) {
    const combat = this.combat;
    const a = this.anim;
    this._track(dt, 1.8);
    a.aim = Math.min(1, a.aim + dt * 5);
    a.aimPitch = this._pitchToPlayer();
    if (at.stage === 0) {
      at.stage = 1;
      playRobotCharge(0.7);
      if (combat.onMechaAttack) combat.onMechaAttack('spread');
    }
    if (at.t < 0.45) return;
    at.shotT -= dt;
    if (at.n < 7 && at.shotT <= 0) {
      this.muzzleWorld(this._from);
      combat.playerAimPoint(this._from, this._aim, 22);
      this._dir.subVectors(this._aim, this._from).applyAxisAngle(UP, (at.n - 3) * 0.1);
      for (let k = 0; k < 7; k++) {
        this._tmp.copy(this._dir).applyAxisAngle(UP, (k - 3 + (at.n % 2) * 0.5) * 0.085).add(this._from);
        combat.fireBolt(this._from, this._tmp, { damage: 7, spread: 0.01, speed: 22, size: 1.4, color: 0xff3a1a });
      }
      combat.effects.flash(this._from, { size: 1.2, color: 0xff5030, life: 0.07 });
      if (combat.sfx('spread', 0.08)) playBoltFire(0.8, 1.1);
      at.n++;
      at.shotT = 0.17;
    }
    if (at.n >= 7 && at.shotT < -0.35) this._endAttack();
  }

  /** Phase 4: the pods open and a salvo of tracking missiles comes after you. */
  _missiles(dt, at) {
    const combat = this.combat;
    this._track(dt, 1.0);
    this.anim.pods = at.t < 1.7 ? 1 : 0;
    if (at.stage === 0) {
      at.stage = 1;
      playSteamVent(0.6);
      combat.hud.warn('⚠  MISSILES: GET BEHIND COVER OR SHOOT THEM DOWN  ⚠', 2.4, 'danger');
      if (combat.onMechaAttack) combat.onMechaAttack('missiles');
    }
    if (at.t < 0.55) return;
    at.shotT -= dt;
    if (at.n < 4 && at.shotT <= 0) {
      const pod = this.pods[at.n % 2];
      pod.mouth.getWorldPosition(this._from);
      // Out of the pod forward and up toward you (fanned a little), then the homing curves it over and down.
      const pp = combat.player.object.position;
      this._dir.set(pp.x - this._from.x, 0, pp.z - this._from.z).normalize();
      const side = (at.n - 1.5) * 0.22;
      this._dir.set(this._dir.x - this._dir.z * side, 0.55, this._dir.z + this._dir.x * side);
      combat.missiles.launch(this._from, this._dir, { speed: 11, turn: 2.2, damage: MECHA.missileDamage, boost: rand(0.15, 0.25) });
      combat.effects.flash(this._from, { size: 1, color: 0xffc080, life: 0.1 });
      if (combat.sfx('missile', 0.06)) playMissileLaunch();
      at.n++;
      at.shotT = 0.22;
    }
    if (at.n >= 4 && at.t > 2.0) this._endAttack();
  }

  _stumble() {
    const combat = this.combat;
    this.state = 'stumble';
    this.t = 0;
    this.attack = null;
    this.anim.aim = this.anim.fist = this.anim.lift = this.anim.pods = 0;
    combat.endBeams();
    this.exposeT = MECHA.exposeTime[this.phase - 1];
    this._platesOpened = false;
    playMetalTear(0.9);
    combat.shake(1.1);
    for (const l of this.legs) {
      l.ankle.getWorldPosition(this._p);
      combat.effects.spark(this._p, { count: 26, color: 0xffc070, speed: 5, size: 0.1, life: 0.6 });
    }
    if (combat.onMechaStumble) combat.onMechaStumble();
  }

  _updateStumble(dt) {
    const a = this.anim;
    a.kneel = Math.min(1, a.kneel + dt * 2.2);
    if (this.t > 0.45) {
      if (!this._platesOpened) {
        this._platesOpened = true;
        playSteamVent(0.9);
        this.dome.getWorldPosition(this._p);
        this.combat.effects.spark(this._p, { count: 20, color: 0xffd08a, speed: 4, size: 0.08, life: 0.5 });
      }
      a.dome = Math.min(1, a.dome + dt * 2.4);
    }
    if (Math.random() < dt * 5) {
      this.legs[Math.random() < 0.5 ? 0 : 1].ankle.getWorldPosition(this._p);
      this.combat.effects.spark(this._p, { count: 4, color: 0xffc070, speed: 3, size: 0.07, life: 0.3 });
    }
    if (this.t > 0.6) this.exposeT -= dt;
    if (this.exposeT <= 0) {
      this.state = 'recover';
      this.t = 0;
      playSteamVent(0.7);
      if (this.combat.onMechaRecover) this.combat.onMechaRecover();
    }
  }

  _updateRecover(dt) {
    const a = this.anim;
    a.dome = Math.max(0, a.dome - dt * 2.5);
    if (this.t > 0.3) a.kneel = Math.max(0, a.kneel - dt * 1.3);
    if (this.t > 1.1) {
      this.legHp = MECHA.legHp[this.phase - 1];
      this.state = 'walk';
      this.attackT = 1.2;
    }
  }

  _domeBroken() {
    const combat = this.combat;
    this.state = 'phaseBreak';
    this.t = 0;
    this.crackLevel = Math.min(3, this.crackLevel + 1);
    this._applyCracks();
    this.dome.getWorldPosition(this._p);
    combat.effects.spark(this._p, { count: 40, color: 0xcff4ff, speed: 6, size: 0.1, life: 0.7 });
    combat.effects.flash(this._p, { size: 3, color: 0xcff4ff, life: 0.2 });
    playGlassShatter();
    playBossRoar();
    combat.shake(1.2);
    combat.endBeams();
    if (combat.onMechaPhaseBreak) combat.onMechaPhaseBreak(this.phase);
  }

  _applyCracks() {
    if (this.crackLevel <= 0) {
      this.cracks.visible = false;
      this.glass.visible = true;
      return;
    }
    if (this.crackLevel >= 3) {
      this.cracks.visible = false;
      this.glass.visible = false; // shattered
      return;
    }
    if (this.mats.cracks.map) this.mats.cracks.map.dispose();
    this.mats.cracks.map = crackTexture(this.crackLevel);
    this.mats.cracks.needsUpdate = true;
    this.cracks.visible = true;
  }

  /** Reset the cockpit glass (retries). */
  setCracks(level) {
    this.crackLevel = level;
    this._applyCracks();
  }

  /** End of phase 4: it shakes itself apart, blows up, and the hull crashes down as a wreck. */
  breakDown() {
    this.hold();
    this.state = 'dying';
    this.t = 0;
    this.aiEnabled = false;
    this._boomT = 0;
    this._exploded = false;
    this.setLegShield(false, []);
  }

  _updateDying(dt) {
    const a = this.anim;
    if (!this._exploded) {
      this._boomT -= dt;
      if (this._boomT <= 0) {
        this._boomT = rand(0.14, 0.32);
        const p = this._anchors[Math.floor(Math.random() * this._anchors.length)];
        this.combat.effects.flash(p, { size: 2.4, color: 0xffb070, life: 0.2 });
        this.combat.effects.spark(p, { count: 14, color: 0xffc070, speed: 6, size: 0.1, life: 0.5 });
        if (Math.random() < 0.5) playExplosion();
        this.combat.shake(0.5);
      }
      a.kneel = 0.35 + 0.25 * Math.sin(this.t * 3.2);
      a.lean = Math.sin(this.t * 2.3) * 0.12;
      if (this.t > 2.8) this._explode();
    } else {
      this._updateScrap(dt);
    }
  }

  _explode() {
    const combat = this.combat;
    this._exploded = true;
    this.aimPoint(this._p);
    combat.effects.flash(this._p, { size: 11, color: 0xffb070, life: 0.45 });
    combat.effects.spark(this._p, { count: 60, color: 0xffc070, speed: 10, size: 0.14, life: 0.9 });
    combat.effects.chunks(this._p, { count: 16, speed: 9, size: 0.7 });
    combat.effects.ring(this.root.position, { from: 1, to: 15, life: 1.0, color: 0xffa070 });
    combat.shake(2);
    playMechExplosion();
    // Every limb and plate flies off on its own; the hull slams down where it stood.
    this.root.updateMatrixWorld(true);
    this.scrap = this.scrapParts.map((mesh) => {
      combat.scene.attach(mesh);
      const vel = new THREE.Vector3(rand(-1, 1), rand(0.5, 1.3), rand(-1, 1)).normalize().multiplyScalar(rand(5, 10));
      return { mesh, vel, spin: new THREE.Vector3(rand(-5, 5), rand(-5, 5), rand(-5, 5)), rest: false };
    });
    for (const l of this.legs) l.hip.visible = false;
    for (const arm of this.arms) arm.shoulder.visible = false;
    for (const p of this.pods) p.pod.visible = false;
    this.pelvis.visible = false;
    this.glass.visible = this.cracks.visible = false;
    this.sensor.material = this.mats.dark;
    this.shieldMesh.visible = false;
    this.tethers.visible = false;
    this.cockpitLight.intensity = 0;
    this._fallV = 0;
    this.dead = true;
    this.state = 'dead';
    combat.refreshTargets();
    if (combat.onMechaDestroyed) combat.onMechaDestroyed();
  }

  _updateScrap(dt) {
    // The hull drops onto the floor (tipping forward a little)...
    if (this.body.position.y > -3.25) {
      this._fallV += 16 * dt;
      this.body.position.y = Math.max(-3.25, this.body.position.y - this._fallV * dt);
      if (this.body.position.y <= -3.25) {
        playLanding(true);
        this.combat.shake(1.3);
        this.combat.effects.ring(this.root.position, { from: 1, to: 8, life: 0.7, color: 0xd8b890 });
      }
    }
    this.torso.rotation.x += (0.16 - this.torso.rotation.x) * Math.min(1, dt * 3);
    this.torso.rotation.z += (-0.1 - this.torso.rotation.z) * Math.min(1, dt * 3);
    // ...and the pieces bounce to a stop around it.
    if (!this.scrap) return;
    for (const s of this.scrap) {
      if (s.rest) continue;
      const m = s.mesh;
      s.vel.y -= 16 * dt;
      m.position.addScaledVector(s.vel, dt);
      m.rotation.x += s.spin.x * dt;
      m.rotation.y += s.spin.y * dt;
      m.rotation.z += s.spin.z * dt;
      if (m.position.y < 0.35) {
        m.position.y = 0.35;
        s.vel.y = Math.abs(s.vel.y) > 1.5 ? -s.vel.y * 0.3 : 0;
        s.vel.x *= 0.55;
        s.vel.z *= 0.55;
        s.spin.multiplyScalar(0.45);
        if (s.vel.y === 0 && s.vel.x * s.vel.x + s.vel.z * s.vel.z < 0.2) s.rest = true;
      }
      this.combat.clampArena(m.position.x, m.position.z, m.position, 0.2, true);
    }
  }

  _pose(dt) {
    const a = this.anim;
    const k = Math.min(1, dt * 7);
    const set = (obj, axis, v) => {
      obj.rotation[axis] += (v - obj.rotation[axis]) * k;
    };
    const lerp = THREE.MathUtils.lerp;
    const moving = a.speed > 0.05;
    if (moving) this.walkPhase += dt * (1.3 + a.speed * 0.9);
    const s = moving ? Math.sin(this.walkPhase) : 0;
    const w = moving ? Math.min(1, a.speed / 1.6) : 0;
    const kn = a.kneel;
    const [R, L] = this.legs;
    set(L.hip, 'x', lerp(s * 0.36 * w, 0.3, kn));
    set(L.knee, 'x', lerp(Math.max(0, s) * 0.55 * w + 0.08, 1.15, kn));
    set(R.hip, 'x', lerp(-s * 0.36 * w, -1.3, kn) - 0.9 * a.lift);
    set(R.knee, 'x', lerp(Math.max(0, -s) * 0.55 * w + 0.08, 2.05, kn) + 1.2 * a.lift);
    // Feet stay flat on the floor.
    set(L.ankle, 'x', -(L.hip.rotation.x + L.knee.rotation.x));
    set(R.ankle, 'x', -(R.hip.rotation.x + R.knee.rotation.x));
    if (this.state !== 'dead') {
      const bob = moving ? Math.abs(s) * 0.12 * w : 0;
      this.body.position.y += (-1.35 * kn + bob - this.body.position.y) * k;
      set(this.torso, 'x', 0.3 * kn);
      set(this.torso, 'z', a.lean);
    }
    // The cannon arm: hanging, or straight out and angled down to aim.
    set(this.arms[0].shoulder, 'x', lerp(-0.35 + s * 0.12 * w, -Math.PI / 2 + a.aimPitch, a.aim));
    set(this.arms[0].elbow, 'x', lerp(-0.8, 0, a.aim));
    // The fist arm: up over its head for a slam, then down into the floor.
    const up = Math.max(0, a.fist);
    const down = Math.max(0, -a.fist);
    set(this.arms[1].shoulder, 'x', -0.35 - s * 0.12 * w - 2.4 * up - 0.5 * down);
    set(this.arms[1].elbow, 'x', -0.8 + 0.5 * up + 0.75 * down);
    for (const p of this.pods) set(p.lid, 'x', -1.6 * a.pods);
    this.plates.forEach((hinge, i) => set(hinge, 'z', (i === 0 ? 1 : -1) * 1.35 * a.dome));
    const shaking = a.roar || this.state === 'dying' || this.state === 'phaseBreak';
    this.torso.position.x = shaking ? rand(-0.03, 0.03) : 0;
    // Footfalls: a thud and a shake each time a foot comes down.
    if (moving) {
      const side = s > 0 ? 1 : -1;
      if (side !== this._stepSide) {
        this._stepSide = side;
        const d = this.root.position.distanceTo(this.combat.player.object.position);
        this.combat.shakeFrom(this.root.position, 0.45);
        if (this.combat.sfx('mstep', 0.25)) playMechStep(THREE.MathUtils.clamp(1.25 - d / 30, 0.25, 1));
      }
    }
  }

  _updateGlow(dt) {
    const M = this.mats;
    this.flashFeet = Math.max(0, this.flashFeet - dt);
    this.flashDome = Math.max(0, this.flashDome - dt);
    const down = this.state === 'stumble' || this.state === 'recover' || this.dead;
    if (this.flashFeet > 0) M.actuator.color.setRGB(1, 1, 1);
    else if (this.legShield) M.actuator.color.setRGB(0.35, 0.75, 1);
    else if (down || this.phase < 2 || MECHA_BUSY.has(this.state)) M.actuator.color.setRGB(0.4, 0.18, 0.06);
    else {
      const p = 0.72 + 0.28 * Math.sin(this.t * 6);
      M.actuator.color.setRGB(p, 0.45 * p, 0.06);
    }
    const at = this.attack;
    const charging = at && at.sweep && !at.sweep.done && at.sweep.t < at.sweep.charge;
    const e = charging ? 0.6 + 0.4 * Math.sin(this.t * 30) : at && at.sweep ? 1 : 0.35;
    M.emitter.color.setRGB(e, e * 0.3, e * 0.2);
    const hot = this.state === 'attack' ? 1 : 0.55;
    M.sensor.color.setRGB(hot * (0.8 + 0.2 * Math.sin(this.t * 8)), 0.08, 0.05);
    if (!this.dead) {
      this.cockpitLight.intensity = this.flashDome > 0 ? 6 : this.exposed ? 3.5 : 2.2;
      this.cockpitLight.color.setHex(this.exposed ? 0xffd0a0 : 0x9fe8ff);
    }
  }

  _updateShield(dt) {
    this._shieldSpark = Math.max(0, this._shieldSpark - dt);
    const on = this.legShield && this.alive;
    this.shieldMesh.visible = on;
    if (on) this.shieldMesh.material.opacity = 0.11 + 0.06 * Math.sin(this.t * 5) + (this._shieldSpark > 0 ? 0.25 : 0);
    const srcs = on ? this.shieldSources.filter((u) => u.alive) : [];
    this.tethers.visible = srcs.length > 0;
    if (!srcs.length) return;
    const attr = this.tethers.geometry.attributes.position;
    const pos = this.root.position;
    for (let i = 0; i < 4; i++) {
      const src = srcs[i];
      if (src) {
        src.aimPoint(this._p);
        attr.setXYZ(i * 2, this._p.x, this._p.y + 0.35, this._p.z);
        attr.setXYZ(i * 2 + 1, pos.x, 2.6 + this.body.position.y, pos.z);
      } else {
        attr.setXYZ(i * 2, 0, -100, 0);
        attr.setXYZ(i * 2 + 1, 0, -100, 0);
      }
    }
    attr.needsUpdate = true;
    this.tethers.material.opacity = 0.45 + 0.45 * Math.random();
  }
}

// ---------------------------------------------------------------------------
// Phase 5: bare knuckles (your fists in the viewmodel, and Coach Billing)
// ---------------------------------------------------------------------------

export const BOXING = {
  punchDamage: 8,
  counterMult: 2,
  blockedDamage: 0.5,
  reach: 2.6, // (arm + a step into it)
  punchTime: 0.3,
  contactAt: 0.075,
  punchCooldown: 0.3,
  bossHp: 150,
  want: 1.5, // how close he likes to stand
  attacks: {
    jab: { windup: 0.36, damage: 7, recover: 0.45, color: 0xffe070, reach: 2.25 },
    hook: { windup: 0.58, damage: 11, recover: 0.65, color: 0xffa040, reach: 2.15 },
    haymaker: { windup: 0.95, damage: 22, recover: 1.05, color: 0xff3a2a, reach: 2.5 },
  },
};

/** Your fists: up in a guard ([RMB] holds it up tight), alternating jabs on [LMB]. */
class Fists {
  constructor(combat) {
    this.combat = combat;
    this.group = new THREE.Group();
    this.group.visible = false;
    combat.rifle.scene.add(this.group);
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a679, roughness: 0.8 });
    const wrap = new THREE.MeshStandardMaterial({ color: 0xe9e5da, roughness: 0.9 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.9 });
    this.hands = [-1, 1].map((s) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.09, 0.11), skin));
      const tape = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.075), wrap);
      tape.position.set(0, -0.005, -0.025);
      g.add(tape);
      const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, 0.06), skin);
      thumb.position.set(-s * 0.05, -0.022, -0.01);
      g.add(thumb);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.38), sleeve);
      arm.position.set(s * 0.02, -0.03, 0.23);
      arm.rotation.x = 0.12;
      g.add(arm);
      this.group.add(g);
      return {
        g,
        s,
        t: -1,
        hit: false,
        rest: new THREE.Vector3(s * 0.19, -0.21, -0.42),
        guard: new THREE.Vector3(s * 0.085, -0.065, -0.3),
        strike: new THREE.Vector3(s * 0.035, -0.03, -0.66),
      };
    });
    this.equipped = false;
    this.guarding = false;
    this.guardT = 99; // seconds since the guard went up (the headset duel's parry window reads it)
    this.guardAmt = 0;
    this.fatigue = 0;
    this.next = 0;
    this.cooldown = 0;
    this.raise = 0;
    this.jolt = 0;
    this.bobT = 0;
    this.time = 0;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  equip(on) {
    this.equipped = on;
    this.group.visible = on;
    this.raise = 0;
    this.setGuard(false);
    for (const h of this.hands) h.t = -1;
  }

  setGuard(on) {
    const guard = on && this.equipped;
    if (guard && !this.guarding) this.guardT = 0;
    if (!guard) this.guardT = 99;
    this.guarding = guard;
    this.combat.player.speedMultiplier = guard ? 0.55 : 1;
    this.combat.hud.setGuard(guard);
  }

  punch() {
    if (!this.equipped || this.guarding || this.cooldown > 0 || this.raise < 0.8 || this.combat.player.isStumbling) return;
    // Spamming winds you: every punch adds fatigue, which slows (and weakens) the next ones.
    if (this.fatigue >= 1.6) {
      if (!this._windedShown) {
        this._windedShown = true;
        this.combat.hud.callout('WINDED!', 'block');
      }
      return;
    }
    const h = this.hands[this.next];
    this.next = 1 - this.next;
    h.t = 0;
    h.hit = false;
    this.fatigue += 0.38;
    this.cooldown = BOXING.punchCooldown + this.fatigue * 0.28;
    playPunchWhoosh(rand(0.9, 1.1));
  }

  /** 1 at full strength, down to 0.5 when winded. */
  get power() {
    return 1 - Math.min(0.5, this.fatigue * 0.32);
  }

  /** Taking a hit (or blocking one): both fists get knocked back. */
  jolted(amount) {
    this.jolt = Math.max(this.jolt, amount);
  }

  update(dt) {
    if (!this.equipped) return;
    const combat = this.combat;
    const player = combat.player;
    this.time += dt;
    if (this.guarding) this.guardT += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.fatigue = Math.max(0, this.fatigue - dt * (this.cooldown > 0 ? 0.25 : 0.7));
    if (this.fatigue < 0.8) this._windedShown = false;
    this.raise = Math.min(1, this.raise + dt / 0.35);
    this.guardAmt += ((this.guarding ? 1 : 0) - this.guardAmt) * Math.min(1, dt * 16);
    this.jolt = Math.max(0, this.jolt - dt * 4);
    const stop = combat.hitStop > 0;
    if (player.isMoving) this.bobT += dt * (player.isSprinting ? 12 : 8);
    const bob = player.isMoving ? 1 : 0;
    for (const h of this.hands) {
      let ext = 0;
      if (h.t >= 0) {
        if (!stop) h.t += dt;
        if (h.t >= BOXING.contactAt && !h.hit) {
          h.hit = true;
          combat.onPunchContact(h);
        }
        ext = h.t < BOXING.contactAt ? h.t / BOXING.contactAt : Math.max(0, 1 - (h.t - BOXING.contactAt) / (BOXING.punchTime - BOXING.contactAt));
        ext = 1 - (1 - ext) * (1 - ext);
        if (h.t >= BOXING.punchTime) h.t = -1;
      }
      const base = this._a.lerpVectors(h.rest, h.guard, Math.max(this.guardAmt, 0.35)); // a boxer's hands are always half up
      const p = this._b.lerpVectors(base, h.strike, ext);
      h.g.position.set(
        p.x + Math.sin(this.bobT + (h.s > 0 ? 0 : Math.PI)) * 0.01 * bob,
        p.y - (1 - this.raise) * 0.3 - Math.abs(Math.cos(this.bobT)) * 0.008 * bob + Math.sin(this.time * 2.2) * 0.004 - this.jolt * 0.05,
        p.z + this.jolt * 0.07,
      );
      h.g.rotation.set(0.15 - ext * 0.1 + this.guardAmt * 0.35, h.s * (0.18 - ext * 0.15), h.s * (0.25 + this.guardAmt * 0.5) + this.jolt * 0.3 * h.s);
    }
  }
}

/**
 * Coach Billing, out of the wreck with his fists up. He circles at arm's
 * length with his guard up (punches into it barely register), and throws
 * jabs, hooks, haymakers and combos, each with a clear wind-up: his arm draws
 * back and his fist glows (yellow jab, orange hook, red haymaker with a "!").
 * Block with [RMB] (you still take a little), then punish him while he
 * recovers from a swing: counters hit for double. Land a jab or hook's
 * wind-up and you knock it out of him; land three in a row and he reels.
 */
class Boxer {
  constructor(combat, look = COACH_BILLING_LOOK) {
    this.combat = combat;
    this.mesh = createHumanoid(look);
    this.mesh.visible = false;
    combat.scene.add(this.mesh);
    this.rig = this.mesh.userData.rig;
    this.radius = 0.5;
    this.hitboxes = [];
    this.skin = this.rig.neck.children[0].material;
    const glowTex = radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    this.glows = [this.rig.handR, this.rig.handL].map((hand) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffe070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.visible = false;
      hand.add(sp);
      return sp;
    });
    this.mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: createMarkTexture('!', '#ff4a3a'), transparent: true, depthTest: false, depthWrite: false, fog: false }));
    this.mark.renderOrder = 999;
    this.mark.visible = false;
    combat.scene.add(this.mark);
    this.active = false;
    this.state = 'off';
    this.maxHp = BOXING.bossHp;
    this.hp = this.maxHp;
    this.yaw = 0;
    this.t = 0;
    this.stateT = 0;
    this.kind = null;
    this.combo = [];
    this.windupFor = 0;
    this.recoverFor = 0;
    this.staggerFor = 0;
    this.strikeT = 0;
    this.attackCd = 1;
    this.tauntCd = 4;
    this.guardUp = true;
    this.circleDir = 1;
    this.hitStreak = 0;
    this.blocksInRow = 0;
    this._slip = 0;
    this.feint = false;
    this.sinceHit = 9;
    this.reel = 0;
    this.flashT = 0;
    this.moveSpeed = 0;
    this.bounceT = 0;
  }

  get position() {
    return this.mesh.position;
  }

  get alive() {
    return this.active && this.hp > 0;
  }

  get engaged() {
    return this.alive;
  }

  aimPoint(out) {
    return out.copy(this.mesh.position).setY(1.5);
  }

  spawn(pos, yaw) {
    this.active = true;
    this.mesh.visible = true;
    this.mesh.position.set(pos.x, 0, pos.z);
    this.yaw = yaw;
    this.mesh.rotation.set(0, yaw, 0);
    this.maxHp = Math.round(BOXING.bossHp * (difficulty.hard ? 1.3 : 1));
    this.hp = this.maxHp;
    this.state = 'intro';
    this.stateT = 0;
    this.combo = [];
    this.kind = null;
    this.attackCd = 1.2;
    this.hitStreak = 0;
    this.blocksInRow = 0;
    this._slip = 0;
    this.feint = false;
    if (this.combat.fists) this.combat.fists.fatigue = 0;
    this.reel = 0;
    this.strikeT = 0;
    this.guardUp = true;
    this.combat.refreshTargets();
  }

  /** The fight starts (after his intro). */
  engage() {
    this._toStalk();
  }

  park() {
    this.active = false;
    this.mesh.visible = false;
    this.mark.visible = false;
    for (const g of this.glows) g.visible = false;
    this.combat.refreshTargets();
  }

  _toStalk() {
    this.state = 'stalk';
    this.stateT = 0;
    this.kind = null;
    this.guardUp = true;
    for (const g of this.glows) g.visible = false;
    this.mark.visible = false;
  }

  update(dt) {
    if (!this.active) return;
    const combat = this.combat;
    this.flashT = Math.max(0, this.flashT - dt);
    this.skin.emissive.setHex(this.flashT > 0 ? 0x552218 : 0x000000);
    if (combat.hitStop > 0) return; // frozen for a beat when a punch lands
    this.t += dt;
    this.stateT += dt;
    this.sinceHit += dt;
    if (this.sinceHit > 1.3) {
      this.hitStreak = 0;
      this.blocksInRow = 0;
    }
    this.reel = Math.max(0, this.reel - dt * 4);
    this.strikeT = Math.max(0, this.strikeT - dt);
    this.attackCd -= dt;
    this.tauntCd -= dt;
    const pos = this.mesh.position;
    const pp = combat.player.object.position;
    const dx = pp.x - pos.x;
    const dz = pp.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (this.state !== 'dazed') {
      this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * (this.state === 'windup' ? 5 : 10)));
    }
    this.moveSpeed = 0;
    const frozen = combat.frozen;
    switch (this.state) {
      case 'stalk':
        if (!frozen) this._stalk(dt, dist, dx, dz);
        break;
      case 'windup':
        if (!frozen && this.feint && this.stateT >= this.windupFor * 0.55) {
          // A feint: he pulls the haymaker (hoping you dropped into a guard) and comes straight back in.
          this.feint = false;
          combat.hud.callout('FEINT!', 'block');
          this._toStalk();
          this.attackCd = 0.25;
        } else if (!frozen && this.stateT >= this.windupFor) {
          this._strike(dist, dx, dz);
        }
        break;
      case 'recover':
        if (this.stateT >= this.recoverFor) this._toStalk();
        break;
      case 'stagger':
        if (this.stateT < 0.3 && dist > 0.01) {
          pos.x -= (dx / dist) * 1.2 * dt;
          pos.z -= (dz / dist) * 1.2 * dt;
          combat.pushOut(pos, this.radius);
        }
        if (this.stateT >= this.staggerFor) this._toStalk();
        break;
      case 'taunt':
        if (this.stateT >= 1.3) this._toStalk();
        break;
      case 'block':
        if (!frozen && this.stateT >= this.blockFor) {
          if (dist < 2.6 && !combat.down) {
            this.combo = Math.random() < 0.5 ? ['jab', 'hook'] : ['hook', 'jab', 'jab'];
            this._nextStrike(0.6);
          } else {
            this._toStalk();
          }
        }
        break;
      default:
        break;
    }
    if (this._slip > 0 && dist > 0.01) {
      this._slip -= dt;
      pos.x += (-dz / dist) * this.circleDir * 3 * dt;
      pos.z += (dx / dist) * this.circleDir * 3 * dt;
      combat.pushOut(pos, this.radius);
    }
    combat.clampArena(pos.x, pos.z, pos, 0.8);
    this.mesh.rotation.y = this.yaw;
    // Wind-up tells: the fist glows (and a "!" for the haymaker), brighter as it comes.
    if (this.state === 'windup') {
      const def = BOXING.attacks[this.kind];
      const w = Math.min(1, this.stateT / this.windupFor);
      const g = this.glows[this.kind === 'hook' ? 1 : 0];
      g.visible = true;
      g.material.color.setHex(def.color);
      g.scale.setScalar((this.kind === 'haymaker' ? 0.5 : 0.3) + w * (this.kind === 'haymaker' ? 0.6 : 0.3) + Math.sin(this.t * 30) * 0.04);
      this.mark.visible = this.kind === 'haymaker';
      if (this.mark.visible) {
        this.mark.position.set(pos.x, 2.55 + Math.sin(this.t * 10) * 0.04, pos.z);
        this.mark.scale.setScalar(0.45 + w * 0.2);
      }
    } else {
      this.glows[0].visible = this.glows[1].visible = false;
      this.mark.visible = false;
    }
    this._pose(dt);
  }

  _stalk(dt, dist, dx, dz) {
    const combat = this.combat;
    const pos = this.mesh.position;
    this.guardUp = true;
    if (Math.random() < dt * 0.3) this.circleDir *= -1;
    const d = Math.max(1e-3, dist);
    const ax = dx / d; // toward you
    const az = dz / d;
    const radial = THREE.MathUtils.clamp(dist - BOXING.want, -1, 1);
    let mx = ax * radial + -az * this.circleDir * 0.5;
    let mz = az * radial + ax * this.circleDir * 0.5;
    const ml = Math.hypot(mx, mz);
    if (ml > 1e-3) {
      mx /= ml;
      mz /= ml;
      const speed = dist > 7 ? 5.4 : dist > 3.2 ? 3.6 : 1.9;
      pos.x += mx * speed * dt;
      pos.z += mz * speed * dt;
      combat.pushOut(pos, this.radius);
      this.moveSpeed = speed;
    }
    if (dist < 2.25 && this.attackCd <= 0 && !combat.down && !combat.player.inputLocked) {
      this._startAttack();
    } else if (dist > 6 && this.tauntCd <= 0 && Math.random() < dt * 0.4) {
      this.tauntCd = 7;
      this.state = 'taunt';
      this.stateT = 0;
      this.guardUp = false;
      if (combat.onBoxerTaunt) combat.onBoxerTaunt();
    }
  }

  _startAttack() {
    const frac = this.hp / this.maxHp;
    const r = Math.random();
    let seq;
    if (frac > 0.6) seq = r < 0.45 ? ['jab'] : r < 0.75 ? ['hook'] : r < 0.9 ? ['haymaker'] : ['jab', 'jab', 'hook'];
    else if (frac > 0.3) seq = r < 0.3 ? ['jab'] : r < 0.55 ? ['hook'] : r < 0.8 ? ['haymaker'] : ['jab', 'jab', 'hook'];
    else seq = r < 0.25 ? ['jab', 'hook'] : r < 0.55 ? ['haymaker'] : ['jab', 'jab', 'hook', 'haymaker'];
    this.combo = seq;
    this._nextStrike(1);
  }

  _nextStrike(pace) {
    const kind = this.combo.shift();
    this.kind = kind;
    this.state = 'windup';
    this.stateT = 0;
    this.guardUp = false;
    this.windupFor = BOXING.attacks[kind].windup * pace * Math.max(0.8, difficulty.fireMult);
    this.feint = kind === 'haymaker' && !this.combo.length && Math.random() < 0.3;
    if (kind === 'haymaker') playPunchWhoosh(0.45);
  }

  _strike(dist, dx, dz) {
    const combat = this.combat;
    const def = BOXING.attacks[this.kind];
    const heavy = this.kind === 'haymaker';
    const pos = this.mesh.position;
    this.strikeT = 0.16;
    playPunchWhoosh(heavy ? 0.6 : 0.85);
    // Lunge into it.
    if (dist > 1.1) {
      const step = Math.min(dist - 1.0, heavy ? 0.7 : 0.4);
      pos.x += (dx / dist) * step;
      pos.z += (dz / dist) * step;
      combat.pushOut(pos, this.radius);
    }
    const facing = Math.cos(angleDiff(Math.atan2(dx, dz), this.yaw)) > 0.72;
    let whiffed = false;
    if (dist < def.reach && facing && !combat.down) {
      const b = combat.rifle.basis();
      const fl = Math.hypot(b.fwd.x, b.fwd.z) || 1;
      const lookingAtHim = dist > 1e-3 ? (-(b.fwd.x * dx + b.fwd.z * dz) / (dist * fl)) > 0.45 : true;
      const fists = combat.fists;
      if (fists && fists.guarding && lookingAtHim) {
        combat.damagePlayer(def.damage * (heavy ? 0.25 : 0.15), pos);
        playBlock();
        combat.hud.callout('BLOCKED', 'block');
        fists.jolted(0.6);
        combat.shake(heavy ? 0.6 : 0.3);
        combat.player.shove(dx, dz, heavy ? 3 : 1.8, { stumble: 0.12, dip: 0.02, roll: 0.02, recovery: 0.12 });
        if (heavy) {
          // He put everything into it: off balance, wide open.
          this.combo = [];
          this.state = 'recover';
          this.stateT = 0;
          this.recoverFor = 1.5;
          this.attackCd = rand(0.9, 1.4);
          combat.hud.callout('HE\'S OPEN!', 'counter');
          return;
        }
      } else {
        combat.damagePlayer(def.damage, pos);
        playPunchHit(heavy);
        if (fists) fists.jolted(1);
        combat.shake(heavy ? 1.3 : 0.65);
        combat.player.shove(dx, dz, heavy ? 6 : 3, { stumble: heavy ? 0.55 : 0.25, dip: heavy ? 0.25 : 0.08, roll: heavy ? 0.2 : 0.08, recovery: heavy ? 0.7 : 0.25 });
      }
    } else {
      whiffed = true;
    }
    if (this.combo.length) {
      this._nextStrike(0.7);
      return;
    }
    this.state = 'recover';
    this.stateT = 0;
    this.recoverFor = def.recover + (whiffed ? 0.35 : 0);
    this.attackCd = rand(0.7, 1.4) * difficulty.fireMult;
  }

  /** Your punch landing (or not). Returns 'hit' | 'counter' | 'interrupt' | 'blocked' | 'miss'. */
  receivePunch() {
    const combat = this.combat;
    if (!this.alive || this.state === 'intro' || this.state === 'off') return 'miss';
    const pos = this.mesh.position;
    const cam = combat.camera.position;
    const dx = pos.x - cam.x;
    const dz = pos.z - cam.z;
    const dist = Math.hypot(dx, dz);
    if (dist > BOXING.reach) return 'miss';
    const b = combat.rifle.basis();
    const fl = Math.hypot(b.fwd.x, b.fwd.z) || 1;
    if (dist > 0.4 && (b.fwd.x * dx + b.fwd.z * dz) / (dist * fl) < Math.cos(0.62)) return 'miss';
    let result;
    const power = combat.fists ? combat.fists.power : 1; // (winded punches land softer)
    let dmg = BOXING.punchDamage * power;
    if (this.state === 'block') {
      result = 'blocked';
      dmg = BOXING.blockedDamage;
    } else if (this.state === 'recover' || this.state === 'stagger' || this.state === 'taunt') {
      result = 'counter';
      dmg *= BOXING.counterMult;
    } else if (this.state === 'windup' && this.kind !== 'haymaker') {
      result = 'interrupt';
    } else if (this.state === 'stalk' && this.guardUp) {
      // Sometimes he slips it entirely (a step to the side), otherwise it's into his forearms.
      if (Math.random() < 0.22) {
        this.circleDir *= -1;
        this._slip = 0.25;
        combat.hud.callout('SLIPPED', 'block');
        playPunchWhoosh(0.7);
        return 'miss';
      }
      result = 'blocked';
      dmg = BOXING.blockedDamage;
    } else {
      result = 'hit';
    }
    this.hp = Math.max(0, this.hp - dmg);
    this.flashT = 0.1;
    this.sinceHit = 0;
    if (result === 'blocked') {
      playBlock();
      combat.hud.hit('armor');
      this.blocksInRow++;
      if (this.blocksInRow >= 3) {
        // Keep pounding his guard and he parries: your fists knocked wide, and he fires back.
        this.blocksInRow = 0;
        combat.hud.callout('PARRIED!', 'counter');
        if (combat.fists) {
          combat.fists.jolted(1);
          combat.fists.fatigue = Math.min(1.8, combat.fists.fatigue + 0.6);
        }
        combat.shake(0.35);
        this.combo = ['jab', 'hook'];
        this._nextStrike(0.5);
      } else {
        combat.hud.callout('BLOCKED', 'block');
        if (this.state === 'stalk' && Math.random() < 0.3 && this.attackCd < 0.6) {
          this.combo = ['jab']; // fires one straight back
          this._nextStrike(0.6);
        }
      }
    } else {
      this.blocksInRow = 0;
      playPunchHit(result === 'counter');
      combat.hitStop = result === 'counter' ? 0.09 : 0.055;
      combat.shake(result === 'counter' ? 0.6 : 0.35);
      combat.hud.hit(result === 'hit' ? 'hit' : 'head');
      this.reel = 1;
      this.hitStreak++;
      if (result === 'counter') {
        combat.hud.callout('COUNTER!', 'counter');
        Achievements.bump('counters');
      }
      if (this.hitStreak >= 2) {
        // Two in a row and he shells up behind his guard... then comes back swinging.
        this.hitStreak = 0;
        this.combo = [];
        this._block(result === 'interrupt' ? 0.8 : 1.1);
      } else if (result === 'interrupt') {
        combat.hud.callout('INTERRUPTED!', 'counter');
        this.combo = [];
        this._stagger(0.45);
      }
    }
    if (this.hp <= 0) {
      this.state = 'dazed';
      this.stateT = 0;
      this.combo = [];
      this.glows[0].visible = this.glows[1].visible = false;
      this.mark.visible = false;
      if (combat.onBoxerDefeated) combat.onBoxerDefeated();
    }
    return result;
  }

  /** Guard up tight: everything you throw is blocked until he answers with a quick combination. */
  _block(seconds) {
    this.state = 'block';
    this.stateT = 0;
    this.blockFor = seconds;
    this.guardUp = true;
    for (const g of this.glows) g.visible = false;
    this.mark.visible = false;
  }

  _stagger(seconds) {
    this.state = 'stagger';
    this.stateT = 0;
    this.staggerFor = seconds;
    this.guardUp = false;
    this.attackCd = Math.max(this.attackCd, 0.5);
  }

  _pose(dt) {
    const r = this.rig;
    const k = Math.min(1, dt * 18);
    const set = (j, axis, v) => {
      j.rotation[axis] += (v - j.rotation[axis]) * k;
    };
    let shR = -1.25;
    let elR = -1.9;
    let shL = -1.25;
    let elL = -1.9;
    let shRz = 0.25;
    let shLz = -0.25;
    let lean = 0.12;
    let twist = 0;
    let neck = 0.15;
    let roll = 0;
    if (!this.guardUp) {
      shR = shL = -0.95;
      elR = elL = -1.6;
    }
    if (this.state === 'windup') {
      const w = Math.min(1, this.stateT / this.windupFor);
      if (this.kind === 'jab') {
        shR = -0.95 + 0.25 * w;
        elR = -2.05;
        twist = -0.15 * w;
      } else if (this.kind === 'hook') {
        shL = -1.3;
        shLz = 1.05 * w; // (swung out wide)
        elL = -1.5;
        twist = 0.38 * w;
      } else {
        shR = -0.2 + 1.0 * w; // cocked way back
        shRz = -0.6 * w;
        elR = -1.25;
        twist = -0.6 * w;
        lean = -0.12 * w;
      }
    }
    if (this.strikeT > 0) {
      if (this.kind === 'jab') {
        shR = -1.62;
        elR = -0.08;
        twist = 0.25;
      } else if (this.kind === 'hook') {
        shL = -1.45;
        shLz = -0.6; // (across)
        elL = -1.2;
        twist = -0.5;
      } else {
        shR = -2.15;
        shRz = 0.2;
        elR = -0.25;
        twist = 0.6;
        lean = 0.38;
      }
    }
    if (this.state === 'block') {
      // Shelled up: chin tucked, forearms tight, hunched over.
      shR = shL = -1.4;
      elR = elL = -2.1;
      shRz = 0.35;
      shLz = -0.35;
      lean = 0.3;
      neck = 0.35;
    } else if (this.state === 'stagger') {
      lean = -0.4;
      neck = -0.35;
      shR = shL = -0.5;
      elR = elL = -1.0;
    } else if (this.state === 'taunt') {
      shR = shL = -0.4;
      shRz = -1.1;
      shLz = 1.1;
      elR = elL = -0.4;
      neck = -0.2;
      lean = -0.1;
    } else if (this.state === 'dazed' || this.state === 'intro') {
      const wob = Math.sin(this.t * 3);
      lean = this.state === 'dazed' ? -0.15 + 0.1 * wob : 0.05;
      shR = shL = this.state === 'dazed' ? -0.35 : -0.6;
      elR = elL = this.state === 'dazed' ? -0.5 : -1.2;
      neck = this.state === 'dazed' ? 0.3 + 0.2 * Math.sin(this.t * 2.3) : 0;
      twist = this.state === 'dazed' ? 0.2 * wob : 0;
      roll = this.state === 'dazed' ? 0.14 * Math.sin(this.t * 1.7) : 0;
    }
    neck -= 0.5 * this.reel;
    lean -= 0.2 * this.reel;
    set(r.shoulderR, 'x', shR);
    set(r.shoulderR, 'z', shRz);
    set(r.elbowR, 'x', elR);
    set(r.shoulderL, 'x', shL);
    set(r.shoulderL, 'z', shLz);
    set(r.elbowL, 'x', elL);
    set(r.body, 'x', lean);
    set(r.body, 'y', twist);
    set(r.body, 'z', roll);
    set(r.neck, 'x', neck);
    // A boxer's stance, bouncing on his toes (stepping when he moves).
    this.bounceT += dt * (this.moveSpeed > 0.3 ? 9 : 5);
    const step = Math.sin(this.bounceT) * Math.min(1, this.moveSpeed / 2);
    set(r.hipL, 'x', -0.3 + step * 0.35);
    set(r.kneeL, 'x', 0.35 + Math.max(0, step) * 0.4);
    set(r.hipR, 'x', 0.22 - step * 0.35);
    set(r.kneeR, 'x', 0.4 + Math.max(0, -step) * 0.4);
    r.body.position.y = -0.05 + (this.state === 'dazed' ? 0 : Math.abs(Math.sin(this.bounceT)) * 0.03);
  }
}

// ---------------------------------------------------------------------------
// The secret chapter's finale: Coach Billing Reconstructed
// ---------------------------------------------------------------------------

export const RECON = {
  radius: 0.6,
  ventHp: 240, // each of the three cooling vents on his spine (about 12 rifle hits)
  wallSpeed: 13,
  dashSpeed: 26,
  dashDamage: 30,
  debrisDamage: 24,
  debrisEvery: 0.85,
  debrisThrows: 4,
  debrisFor: 4.6, // how long he stands still hurling rubble (the vents flare open the whole time)
};

// Billing in his gym tracksuit: the raincoat's gone.
export const RECON_LOOK = { shirt: 0x4a5866, pants: 0x2a3038, hair: 0x2b2b2b, skin: 0xc99a6e, scale: 1.25, whistle: true };

let _ventHalo = null;
function ventHaloTexture() {
  if (_ventHalo) return _ventHalo;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,180,1)');
  grad.addColorStop(0.3, 'rgba(255,140,40,0.7)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _ventHalo = new THREE.CanvasTexture(c);
  _ventHalo.colorSpace = THREE.SRGBColorSpace;
  return _ventHalo;
}

/** Distance from point (px, pz) to the segment (ax, az)-(bx, bz), on the floor plane. */
function segDist2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-8 ? THREE.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * Coach Billing Reconstructed: a cybernetic spine grafted on, arching over his head like a crest
 * with three cooling vents on it. He runs the walls, dashes at you down a lane he marks on the
 * floor (get out of it), then stops to hurl rubble while his vents flare open: the only time a
 * bullet hurts the spine. Break all three vents.
 */
class Reconstructed {
  constructor(combat) {
    this.combat = combat;
    this.mesh = createHumanoid(RECON_LOOK);
    this.mesh.rotation.order = 'YXZ';
    this.mesh.visible = false;
    combat.scene.add(this.mesh);
    this.root = this.mesh;
    this.rig = this.mesh.userData.rig;
    this.radius = RECON.radius;
    this.hitboxes = [];
    this.vents = [];
    this.bodyBoxes = [];
    this._buildSpine();
    this._allBoxes = this.hitboxes.slice();
    for (const h of this._allBoxes) h.userData.owner = this;

    // The lane he's about to dash down: a flat red strip on the floor.
    const laneGeo = new THREE.BoxGeometry(1, 0.02, 1);
    laneGeo.translate(0, 0.01, 0.5);
    this.lane = new THREE.Group();
    this.laneMesh = new THREE.Mesh(laneGeo, new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.3, depthWrite: false, fog: false }));
    this.laneMesh.renderOrder = 3;
    this.lane.add(this.laneMesh);
    this.lane.visible = false;
    combat.scene.add(this.lane);

    // Rubble in flight (the ground hazard it lands with does the damage).
    // (A lumpy, faceted boulder: a subdivided icosahedron with its vertices knocked about.)
    const rockGeo = new THREE.IcosahedronGeometry(0.36, 2);
    {
      const pos = rockGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const k = 0.78 + 0.34 * Math.abs(Math.sin(pos.getX(i) * 9.1 + pos.getY(i) * 5.3 + pos.getZ(i) * 7.7));
        pos.setXYZ(i, pos.getX(i) * k * 1.15, pos.getY(i) * k * 0.85, pos.getZ(i) * k);
      }
      rockGeo.computeVertexNormals();
    }
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6a7076, metalness: 0.15, roughness: 0.85, flatShading: true });
    this.chunks = Array.from({ length: 8 }, () => {
      const mesh = new THREE.Mesh(rockGeo, rockMat);
      mesh.visible = false;
      combat.scene.add(mesh);
      return { mesh, active: false, t: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), spin: new THREE.Vector3() };
    });
    this._chunk = 0;
    this.held = new THREE.Mesh(rockGeo, rockMat); // the piece over his head while he winds up
    this.held.position.set(0, 2.75, 0.5);
    this.held.visible = false;
    this.rig.body.add(this.held);

    this.active = false;
    this.dead = false;
    this.aiEnabled = false;
    this.state = 'off'; // off | intro | wall | aim | dash | stick | debris | recover | overload
    this.stateT = 0;
    this.t = 0;
    this.yaw = 0;
    this.lift = 0;
    this.wallTilt = 0;
    this.open = 0; // the vents' shutters, 0 shut .. 1 open
    this.ventsLeft = 3;
    this.dashesLeft = 0;
    this.wallDir = 1;
    this.wallS = 0;
    this.wallFor = 1.6;
    this.aimFor = 0.9;
    this.aimLocked = false;
    this.dashLen = 10;
    this.dashed = 0;
    this.hitDash = false;
    this.stickFor = 0.5;
    this.throws = 0;
    this.nextThrow = 0.8;
    this.throwT = 0;
    this.roll = 0;
    this._wp = { x: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 1 };
    this._wallSide = { nx: 0, nz: 1 };
    this._dir = new THREE.Vector3();
    this.dashDir = new THREE.Vector3(0, 0, 1);
    this._enterFrom = new THREE.Vector3();
    this._sparkT = 0;
  }

  _buildSpine() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x66717a, metalness: 0.85, roughness: 0.32 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d2227, metalness: 0.7, roughness: 0.5 });
    const hidden = this.combat.mats.hidden;
    const box = (w, h, d, parent, zone, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hidden);
      m.position.set(x, y, z);
      m.userData.zone = zone;
      parent.add(m);
      this.hitboxes.push(m);
      return m;
    };
    // (His body just deflects: the vents are the only weak point.)
    box(0.55, 0.7, 0.34, this.rig.body, 'body', 0, 1.13, 0);
    box(0.42, 0.85, 0.3, this.rig.body, 'legs', 0, 0.43, 0);
    box(0.28, 0.3, 0.28, this.rig.neck, 'head', 0, 0.16, 0);

    // Glowing amber eyes and a red core on the chest, so he reads in the dark hall.
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffb13a, fog: false });
    for (const x of [-0.06, 0.06]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.02), eyeMat);
      eye.position.set(x, 0.2, 0.14);
      this.rig.neck.add(eye);
    }
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.02), new THREE.MeshBasicMaterial({ color: 0xff3a2a, fog: false }));
    core.position.set(0, 1.2, 0.14);
    this.rig.body.add(core);

    this.spine = new THREE.Group();
    this.spine.position.set(0, 0.9, -0.16);
    this.rig.body.add(this.spine);
    // Vertebrae up his back and over his head (the crest rides well above it, so the vents stay clear of his head's hitbox): [y, z, tilt].
    const path = [[0.02, 0, 0.1], [0.28, -0.04, 0.2], [0.56, -0.08, 0.12], [0.86, -0.07, -0.1], [1.1, 0.0, -0.5], [1.26, 0.16, -1.0], [1.3, 0.36, -1.4]];
    const segs = path.map(([y, z, tilt], i) => {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.15 - i * 0.004, 0.17, 0.15), steel);
      seg.position.set(0, y, z);
      seg.rotation.x = tilt;
      this.spine.add(seg);
      if (i < path.length - 1) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.2, 8), dark);
        ring.position.set(0, y + 0.1, z + (path[i + 1][1] - z) * 0.5);
        ring.rotation.x = tilt;
        this.spine.add(ring);
      }
      return seg;
    });
    // A cable bundle from the pelvis into the base of the spine.
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6), dark);
    cable.position.set(0.09, -0.08, 0.02);
    this.spine.add(cable);
    // The three cooling vents: a glowing slit under a sliding shutter, on the crest's front face.
    [4, 5, 6].forEach((si, i) => {
      const seg = segs[si];
      const group = new THREE.Group();
      group.position.copy(seg.position);
      group.rotation.x = seg.rotation.x;
      this.spine.add(group);
      const glowMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a });
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.07, 0.14), glowMat);
      glow.position.set(0, 0, 0.085);
      group.add(glow);
      // A big hot halo, so the open vents can't be missed (it only shows while they're flared open).
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: ventHaloTexture(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0, fog: false }));
      halo.scale.set(0.9, 0.9, 1);
      halo.position.set(0, 0, 0.16);
      halo.renderOrder = 6;
      group.add(halo);
      const cover = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.17), dark);
      cover.position.set(0, 0.03, 0.09);
      group.add(cover);
      const hb = box(0.62, 0.55, 0.55, group, `vent${i}`, 0, 0, 0.14); // (generous: they're small and high up)
      this.vents.push({ group, glowMat, cover, hb, halo, hp: 0, max: 0, broken: false, flash: 0 });
    });
    // The tanks' shield around the crest.
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 18, 14),
      new THREE.MeshBasicMaterial({ color: 0x4ad8ff, transparent: true, opacity: 0.24, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.shieldMesh.position.set(0, 1.15, 0.2);
    this.shieldMesh.visible = false;
    this.spine.add(this.shieldMesh);
  }

  /**
   * While any tank ELDAR is alive, the spine is shielded (like the Mecha's legs in the gym). `holdShield`
   * keeps it up between stages, from the moment a vent breaks until that stage's tanks have all landed.
   */
  get shielded() {
    return this.holdShield || this.combat.units.some((u) => u.heavy && !u.dead);
  }

  get position() {
    return this.mesh.position;
  }

  get alive() {
    return this.active && !this.dead;
  }

  get engaged() {
    return this.alive && this.aiEnabled;
  }

  aimPoint(out) {
    return out.copy(this.mesh.position).setY(this.mesh.position.y + 1.7);
  }

  /** Where the crest's vents are (the middle one), for cutscene cameras. */
  crestPoint(out) {
    return this.vents[1].group.getWorldPosition(out);
  }

  /** Stand him up at `pos` facing `yaw`, vents freshly armored. Call engage() when the cutscene's done. */
  spawn(pos, yaw) {
    const maxHp = Math.round(RECON.ventHp * (difficulty.hard ? 1.25 : 1));
    for (const v of this.vents) {
      v.max = v.hp = maxHp;
      v.broken = false;
      v.flash = 0;
      v.cover.visible = true;
      v.glowMat.color.setHex(0xff7a1a);
    }
    this.hitboxes = this._allBoxes.slice();
    this.ventsLeft = 3;
    this.holdShield = true;
    this.active = true;
    this.dead = false;
    this.aiEnabled = false;
    this.mesh.visible = true;
    this.mesh.position.set(pos.x, 0, pos.z);
    this.yaw = yaw;
    this.lift = 0;
    this.wallTilt = 0;
    this.open = 0;
    this.throwT = 0;
    this.lane.visible = false;
    this.state = 'intro';
    this.stateT = 0;
    this.combat.refreshTargets();
  }

  /** Crash in from `height` (through the ceiling) at `at`, facing `yaw`. */
  drop(at, yaw, height = 10) {
    this.spawn(at, yaw);
    this.state = 'drop';
    this.stateT = 0;
    this.lift = height;
    this.vy = -2;
  }

  _land() {
    const pos = this.mesh.position;
    const fx = this.combat.effects;
    this.lift = 0;
    this.state = 'intro';
    this.stateT = 0;
    fx.ring(pos, { from: 0.5, to: 5, color: 0xd8b890, life: 0.6 });
    fx.spark(_v1.set(pos.x, 0.3, pos.z), { count: 26, color: 0xd8c8a8, speed: 5, size: 0.14, life: 0.8, gravity: 4 });
    fx.chunks(_v1, { count: 6, speed: 5, size: 0.3 });
    this.combat.shake(1.1);
    playLanding(true);
    playBossRoar();
  }

  engage() {
    this.aiEnabled = true;
    this._startCycle();
  }

  /**
   * Overloaded and beaten: he hauls himself up and staggers off along `points` (runs even while the
   * combat is frozen for a cutscene). Resolves once he reaches the last one.
   */
  retreat(points, speed = 2.4) {
    this.aiEnabled = false;
    this.lane.visible = false;
    this.held.visible = false;
    this._path = points.map((p) => p.clone());
    this._pathI = 0;
    this._retreatSpeed = speed;
    this._setState('retreat');
    return new Promise((resolve) => {
      this._retreatDone = resolve;
    });
  }

  _updateRetreat(dt) {
    if (this.stateT < 0.9) return; // getting up
    const pos = this.mesh.position;
    const tgt = this._path[this._pathI];
    if (!tgt) return;
    const dx = tgt.x - pos.x;
    const dz = tgt.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.15) {
      if (++this._pathI >= this._path.length && this._retreatDone) {
        const done = this._retreatDone;
        this._retreatDone = null;
        done();
      }
      return;
    }
    const step = Math.min(d, this._retreatSpeed * (0.75 + 0.25 * Math.abs(Math.sin(this.t * 7))) * dt); // (the limp)
    pos.x += (dx / d) * step;
    pos.z += (dz / d) * step;
    if (this._pathI < this._path.length - 1) this.combat.pushOut(pos, this.radius); // (not through the last doorway)
    this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 8));
  }

  park() {
    if (this._retreatDone) {
      const done = this._retreatDone;
      this._retreatDone = null;
      done();
    }
    this.active = false;
    this.aiEnabled = false;
    this.mesh.visible = false;
    this.lane.visible = false;
    this.held.visible = false;
    this.clearProjectiles();
    this.combat.refreshTargets();
  }

  clearProjectiles() {
    for (const c of this.chunks) {
      c.active = false;
      c.mesh.visible = false;
    }
  }

  /** The boss bar: what's left of the three vents. */
  healthFraction() {
    let left = 0;
    let total = 0;
    for (const v of this.vents) {
      total += v.max || 1;
      left += Math.max(0, v.hp);
    }
    return left / total;
  }

  /** zone: 'vent0'..'vent2' (only while they're flared open), anything else just deflects. */
  takeHit(zone, damage = RIFLE.damage) {
    if (!this.alive) return null;
    const m = /^vent(\d)$/.exec(zone);
    if (!m) return 'armor';
    const v = this.vents[+m[1]];
    if (v.broken) return null;
    if (this.open < 0.7 || this.shielded) return 'armor'; // shuttered, or the tanks are feeding the spine a shield
    v.hp -= damage;
    v.flash = 0.08;
    if (v.hp <= 0) {
      this._breakVent(v);
      return 'kill';
    }
    return 'head';
  }

  _breakVent(v) {
    v.broken = true;
    v.hp = 0;
    v.cover.visible = false;
    v.halo.material.opacity = 0;
    v.glowMat.color.setHex(0x0a0a0a);
    this.hitboxes = this.hitboxes.filter((h) => h !== v.hb);
    const p = v.group.getWorldPosition(_v3);
    const fx = this.combat.effects;
    fx.spark(p, { count: 26, color: 0xffa040, speed: 6, size: 0.1, life: 0.6 });
    fx.spark(p, { count: 10, color: 0x9fe8ff, speed: 4, size: 0.07, life: 0.4 });
    fx.flash(p, { size: 1.3, color: 0xffb060, life: 0.16 });
    fx.chunks(p, { count: 3, speed: 4, size: 0.16 });
    this.combat.shakeFrom(p, 0.9);
    playSteamVent(0.8);
    this.ventsLeft--;
    this.combat.refreshTargets();
    if (this.ventsLeft <= 0) this._overload();
    else this.holdShield = true; // the shield snaps straight back up: the next stage's tanks have to die first

  }

  _overload() {
    this.aiEnabled = false;
    this.lane.visible = false;
    this.held.visible = false;
    this.combat.hazards.clear();
    this.clearProjectiles();
    this._setState('overload');
    if (this.combat.onReconDown) this.combat.onReconDown();
  }

  _setState(s) {
    this.state = s;
    this.stateT = 0;
  }

  // ---- The arena's wall path -----------------------------------------------------

  _rect() {
    const a = this.combat.reconArena || this.combat.arena || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    const m = 1.1;
    return { x0: a.minX + m, x1: a.maxX - m, z0: a.minZ + m, z1: a.maxZ - m };
  }

  /** `s` meters along the wall path (a rectangle just inside the arena): position, travel direction and inward normal. */
  _wallAt(s) {
    const r = this._rect();
    const w = r.x1 - r.x0;
    const h = r.z1 - r.z0;
    const perim = 2 * (w + h);
    s = ((s % perim) + perim) % perim;
    const o = this._wp;
    if (s < w) Object.assign(o, { x: r.x0 + s, z: r.z0, tx: 1, tz: 0, nx: 0, nz: 1 });
    else if (s < w + h) Object.assign(o, { x: r.x1, z: r.z0 + (s - w), tx: 0, tz: 1, nx: -1, nz: 0 });
    else if (s < 2 * w + h) Object.assign(o, { x: r.x1 - (s - w - h), z: r.z1, tx: -1, tz: 0, nx: 0, nz: -1 });
    else Object.assign(o, { x: r.x0, z: r.z1 - (s - 2 * w - h), tx: 0, tz: -1, nx: 1, nz: 0 });
    return o;
  }

  _nearestWallS(p) {
    const r = this._rect();
    const w = r.x1 - r.x0;
    const h = r.z1 - r.z0;
    const cx = THREE.MathUtils.clamp(p.x, r.x0, r.x1);
    const cz = THREE.MathUtils.clamp(p.z, r.z0, r.z1);
    const dN = Math.abs(p.z - r.z0);
    const dS = Math.abs(p.z - r.z1);
    const dW = Math.abs(p.x - r.x0);
    const dE = Math.abs(p.x - r.x1);
    const m = Math.min(dN, dS, dW, dE);
    if (m === dN) return cx - r.x0;
    if (m === dE) return w + (cz - r.z0);
    if (m === dS) return w + h + (r.x1 - cx);
    return 2 * w + h + (r.z1 - cz);
  }

  /** How far a dash from `pos` along `dir` can run before the arena's edge (or something solid). */
  _laneLength(pos, dir) {
    const a = this.combat.reconArena || this.combat.arena;
    const m = 0.8;
    let t = 60;
    if (a) {
      if (dir.x > 1e-4) t = Math.min(t, (a.maxX - m - pos.x) / dir.x);
      else if (dir.x < -1e-4) t = Math.min(t, (a.minX + m - pos.x) / dir.x);
      if (dir.z > 1e-4) t = Math.min(t, (a.maxZ - m - pos.z) / dir.z);
      else if (dir.z < -1e-4) t = Math.min(t, (a.minZ + m - pos.z) / dir.z);
    }
    const solid = rayBoxes(_v1.set(pos.x, 1, pos.z), dir, this.combat.worldBoxes, t + 1) - this.radius - 0.3;
    return Math.max(1.5, Math.min(t, solid));
  }

  // ---- The cycle: wall run -> aim -> dash (x2-3) -> debris (vulnerable) ------------

  _startCycle() {
    this.dashesLeft = 3 + (Math.random() < 0.5 ? 1 : 0) + (difficulty.hard ? 1 : 0);
    this._startWall(rand(1.4, 2.0));
  }

  _startWall(seconds) {
    this._enterFrom.copy(this.mesh.position);
    this.wallS = this._nearestWallS(this.mesh.position);
    this.wallDir = Math.random() < 0.5 ? 1 : -1;
    this.wallFor = seconds;
    this._setState('wall');
  }

  _startAim() {
    this._setState('aim');
    this.aimFor = (this.dashesLeft >= 2 ? 0.85 : 0.68) * Math.max(0.85, difficulty.fireMult);
    this.aimLocked = false;
    this.laneMesh.material.color.setHex(0xff2a1a);
    if (this.combat.sfx('reconAim', 0.3)) playRobotCharge(0.6);
  }

  _startDash() {
    this._setState('dash');
    this.dashDir.copy(this._dir);
    this.dashLen = this._laneLength(this.mesh.position, this.dashDir);
    this.dashed = 0;
    this.hitDash = false;
    this.yaw = Math.atan2(this.dashDir.x, this.dashDir.z);
    playPunchWhoosh(0.5);
    if (this.combat.sfx('reconDash', 0.2)) playRobotCharge(0.8);
  }

  _impact() {
    const pos = this.mesh.position;
    const fx = this.combat.effects;
    _v1.set(pos.x, 1.0, pos.z);
    fx.spark(_v1, { count: 16, color: 0xffb060, speed: 6, size: 0.09, life: 0.4 });
    fx.ring(pos, { from: 0.4, to: 2.6, color: 0xd8b890, life: 0.4 });
    this.combat.shakeFrom(pos, 0.7);
    if (this.combat.sfx('reconHit', 0.1)) playStomp();
    this.lane.visible = false;
    this.stickFor = 0.5;
    this._setState('stick');
  }

  _afterStick() {
    this.dashesLeft--;
    if (this.dashesLeft > 0) {
      this._startWall(rand(0.5, 1.0));
    } else {
      this._setState('debris');
      this.throws = 0;
      this.nextThrow = 0.8;
      this.lane.visible = false;
      if (this.combat.sfx('reconVent', 0.5)) playSteamVent(1.2);
      if (this.combat.onReconDebris) this.combat.onReconDebris();
    }
  }

  _throw() {
    const combat = this.combat;
    const pp = combat.player.object.position;
    const pos = this.mesh.position;
    _v1.set(pp.x + combat._pv.x * 0.9, 0, pp.z + combat._pv.z * 0.9);
    combat.clampArena(_v1.x, _v1.z, _v1, 1.2);
    combat.hazards.add(_v1.x, _v1.z, { radius: 1.8, delay: 1.15, damage: RECON.debrisDamage });
    const c = this.chunks[this._chunk];
    this._chunk = (this._chunk + 1) % this.chunks.length;
    c.active = true;
    c.t = 0;
    c.dur = 1.15;
    c.from.set(pos.x + Math.sin(this.yaw) * 0.5, pos.y + 2.5, pos.z + Math.cos(this.yaw) * 0.5);
    c.to.set(_v1.x, 0.25, _v1.z);
    c.spin.set(rand(-6, 6), rand(-6, 6), rand(-6, 6));
    c.mesh.visible = true;
    this.throwT = 0.3;
    playPunchWhoosh(0.45);
  }

  _updateChunks(dt) {
    for (const c of this.chunks) {
      if (!c.active) continue;
      c.t += dt;
      const k = Math.min(1, c.t / c.dur);
      c.mesh.position.lerpVectors(c.from, c.to, k);
      c.mesh.position.y += 4 * 5.5 * k * (1 - k); // the arc
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (k >= 1) {
        c.active = false;
        c.mesh.visible = false;
      }
    }
  }

  // ---- Per frame ------------------------------------------------------------------

  update(dt) {
    if (!this.active) return;
    const combat = this.combat;
    this.t += dt;
    if (combat.hitStop > 0) return;
    this.stateT += dt;
    this.throwT = Math.max(0, this.throwT - dt);
    const wantOpen = this.state === 'debris' && this.stateT > 0.35 && this.stateT < RECON.debrisFor - 0.2 ? 1 : 0;
    this.open += (wantOpen - this.open) * Math.min(1, dt * 7);
    if (this.state !== 'wall') this.wallTilt += (0 - this.wallTilt) * Math.min(1, dt * 12);
    if (this.state === 'drop') {
      // Falling through the ceiling.
      this.vy -= 26 * dt;
      this.lift += this.vy * dt;
      if (this.lift <= 0) this._land();
    } else if (!['wall', 'dash', 'stick', 'aim'].includes(this.state)) {
      this.lift += (0 - this.lift) * Math.min(1, dt * 10);
    }
    if (this.aiEnabled && !combat.frozen) this._think(dt);
    if (this.state === 'retreat') this._updateRetreat(dt);
    if (!combat.frozen) this._updateChunks(dt);
    this.held.visible = this.state === 'debris' && this.throwT <= 0 && this.throws < RECON.debrisThrows && this.open > 0.3;
    // Sparks on the crest while the vents burn.
    if (this.open > 0.5 && Math.random() < dt * 14) {
      const v = this.vents[Math.floor(Math.random() * 3)];
      if (!v.broken) {
        v.group.getWorldPosition(_v3);
        combat.effects.spark(_v3, { count: 1, color: 0xffa040, speed: 1.6, size: 0.06, life: 0.4, gravity: 3 });
      }
    }
    this._updateVents(dt);
    this._pose(dt);
    this.mesh.position.y = this.lift;
    this.mesh.rotation.set(0, this.yaw, this.roll);
    this.mesh.updateMatrixWorld(true);
  }

  _think(dt) {
    const combat = this.combat;
    const pos = this.mesh.position;
    const pp = combat.player.object.position;
    switch (this.state) {
      case 'wall': {
        this.wallS += this.wallDir * RECON.wallSpeed * dt;
        const wp = this._wallAt(this.wallS);
        const k = Math.min(1, this.stateT / 0.3);
        const ease = k * k * (3 - 2 * k);
        pos.x = THREE.MathUtils.lerp(this._enterFrom.x, wp.x + wp.nx * 0.25, ease);
        pos.z = THREE.MathUtils.lerp(this._enterFrom.z, wp.z + wp.nz * 0.25, ease);
        this.lift = ease * 1.25 + Math.sin(k * Math.PI) * 0.6 * (1 - ease);
        this.wallTilt = ease;
        this.yaw = Math.atan2(wp.tx * this.wallDir, wp.tz * this.wallDir);
        this._wallSide.nx = wp.nx;
        this._wallSide.nz = wp.nz;
        if (Math.random() < dt * 24) {
          _v1.set(pos.x, 0.15, pos.z);
          combat.effects.spark(_v1, { count: 1, color: 0xd8b890, speed: 2, size: 0.14, life: 0.4, gravity: 1 });
        }
        if (this.stateT >= this.wallFor) this._startAim();
        break;
      }
      case 'aim': {
        this.lift += (0 - this.lift) * Math.min(1, dt * 12);
        if (!this.aimLocked) {
          this._dir.set(pp.x - pos.x, 0, pp.z - pos.z);
          const d = this._dir.length() || 1;
          this._dir.divideScalar(d);
          if (this.stateT >= this.aimFor - 0.3) {
            this.aimLocked = true; // the lane stops following you: get out of it
            this.laneMesh.material.color.setHex(0xffe0d0);
          }
        }
        this.yaw = dampAngle(this.yaw, Math.atan2(this._dir.x, this._dir.z), 1 - Math.exp(-dt * 14));
        const len = this._laneLength(pos, this._dir);
        this.lane.position.set(pos.x, 0.04, pos.z);
        this.lane.rotation.y = Math.atan2(this._dir.x, this._dir.z);
        this.lane.scale.set(2.0, 1, len);
        this.lane.visible = true;
        this.laneMesh.material.opacity = this.aimLocked ? 0.55 : 0.2 + 0.1 * Math.sin(this.t * 24);
        if (this.stateT >= this.aimFor) this._startDash();
        break;
      }
      case 'dash': {
        const step = RECON.dashSpeed * dt;
        const px = pos.x;
        const pz = pos.z;
        pos.x += this.dashDir.x * step;
        pos.z += this.dashDir.z * step;
        combat.pushOut(pos, this.radius);
        combat.clampArena(pos.x, pos.z, pos, 0.8);
        const moved = Math.hypot(pos.x - px, pos.z - pz);
        this.dashed += moved;
        if (Math.random() < dt * 40) {
          _v1.set(pos.x, 0.2, pos.z);
          combat.effects.spark(_v1, { count: 1, color: 0xffb060, speed: 2.5, size: 0.1, life: 0.3, gravity: 2 });
        }
        if (!this.hitDash && !combat.down && segDist2D(pp.x, pp.z, px, pz, pos.x, pos.z) < 1.15) {
          this.hitDash = true;
          combat.damagePlayer(RECON.dashDamage, pos);
          combat.player.shove(this.dashDir.x, this.dashDir.z, 9, { stumble: 0.6, dip: 0.3, roll: 0.22, recovery: 0.8 });
          combat.shake(1.0);
          playPunchHit(true);
        }
        if (moved < step * 0.5 || this.dashed >= this.dashLen - 0.2 || this.stateT > 1.6) this._impact();
        break;
      }
      case 'stick':
        if (this.stateT >= this.stickFor) this._afterStick();
        break;
      case 'debris': {
        this.yaw = dampAngle(this.yaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), 1 - Math.exp(-dt * 6));
        if (this.throws < RECON.debrisThrows && this.stateT >= this.nextThrow) {
          this._throw();
          this.throws++;
          this.nextThrow += RECON.debrisEvery * Math.max(0.75, difficulty.fireMult);
        }
        if (this.stateT >= RECON.debrisFor) this._setState('recover');
        break;
      }
      case 'recover':
        this.yaw = dampAngle(this.yaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), 1 - Math.exp(-dt * 6));
        if (this.stateT >= 0.7) this._startCycle();
        break;
      default:
        break;
    }
  }

  _updateVents(dt) {
    const shielded = this.ventsLeft > 0 && this.shielded;
    this.shieldMesh.visible = shielded;
    if (shielded && !this._wasShielded && this.active) {
      // It snaps back on: a cyan burst around the crest.
      this._shieldPop = 0.35;
      const p = this.shieldMesh.getWorldPosition(_v3);
      this.combat.effects.spark(p, { count: 18, color: 0x7ae8ff, speed: 3.5, size: 0.08, life: 0.45 });
      this.combat.effects.flash(p, { size: 1.6, color: 0x4ad8ff, life: 0.18 });
    }
    this._wasShielded = shielded;
    this._shieldPop = Math.max(0, (this._shieldPop || 0) - dt);
    if (shielded) this.shieldMesh.scale.setScalar(1 + 0.06 * Math.sin(this.t * 9) + this._shieldPop * 1.4);
    for (const v of this.vents) {
      if (v.broken) continue;
      v.flash = Math.max(0, v.flash - dt);
      const o = this.open;
      v.cover.position.set(0, 0.03 + o * 0.13, 0.09 - o * 0.06);
      const heat = 0.4 + 0.6 * o;
      const f = v.flash > 0 ? 1 : 0;
      v.glowMat.color.setRGB(heat + f, (0.42 + f * 0.5) * heat, 0.1 * heat + f * 0.5);
      v.halo.material.opacity = o > 0.5 ? (0.55 + 0.35 * Math.sin(this.t * 14)) * o : 0;
    }
    this.spine.rotation.x = -0.28 * this.open;
  }

  _pose(dt) {
    const r = this.rig;
    const k = Math.min(1, dt * 14);
    const set = (j, axis, v) => {
      j.rotation[axis] += (v - j.rotation[axis]) * k;
    };
    const t = this.t;
    let hipL = 0.15;
    let hipR = -0.15;
    let kneeL = 0.2;
    let kneeR = 0.3;
    let shR = -0.3;
    let shL = -0.3;
    let elR = -0.4;
    let elL = -0.4;
    let lean = 0.08;
    let neck = 0;
    let drop = 0;
    let roll = 0;
    switch (this.state) {
      case 'wall': {
        const s = Math.sin(t * 20);
        hipL = s * 0.9;
        hipR = -s * 0.9;
        kneeL = Math.max(0, s) * 1.4;
        kneeR = Math.max(0, -s) * 1.4;
        shR = s * 0.9 + 0.4;
        shL = -s * 0.9 + 0.4;
        elR = elL = -1.2;
        lean = 0.4;
        // Feet on the wall, body out into the arena: roll toward it.
        const ws = this._wallSide;
        const dot = ws.nx * Math.cos(this.yaw) - ws.nz * Math.sin(this.yaw); // > 0: the wall's on his right
        roll = (dot > 0 ? -1 : 1) * 1.2 * this.wallTilt;
        break;
      }
      case 'aim':
        hipL = hipR = -0.95;
        kneeL = kneeR = 1.7;
        shR = shL = 0.9;
        elR = elL = -0.4;
        lean = 0.75;
        neck = 0.3;
        drop = 0.5;
        break;
      case 'dash':
        hipL = -0.9;
        hipR = 0.6;
        kneeL = 0.4;
        kneeR = 1.4;
        shR = shL = 1.05;
        elR = elL = -0.2;
        lean = 1.0;
        neck = -0.3;
        break;
      case 'stick':
        lean = 0.3;
        shR = shL = 0.2;
        break;
      case 'debris':
        hipL = -0.25;
        hipR = 0.1;
        kneeL = kneeR = 0.5;
        if (this.throwT > 0) {
          shR = shL = -0.6;
          elR = elL = -0.5;
          lean = 0.55;
          neck = 0.2;
        } else {
          shR = shL = -2.8;
          elR = elL = -0.5;
          lean = -0.28;
          neck = -0.3;
        }
        break;
      case 'drop':
        hipL = -0.7;
        hipR = -0.3;
        kneeL = kneeR = 1.2;
        shR = shL = -2.6;
        elR = elL = -0.4;
        lean = 0.1;
        break;
      case 'overload': {
        hipL = hipR = -1.5;
        kneeL = kneeR = 2.3;
        shR = shL = 0.1;
        elR = elL = -0.2;
        lean = 0.7;
        neck = 0.5;
        drop = 0.62;
        break;
      }
      case 'retreat': {
        if (this.stateT < 0.9) {
          // Still slumped from the overload, hauling himself up.
          hipL = hipR = -1.5;
          kneeL = kneeR = 2.3;
          lean = 0.7;
          neck = 0.5;
          drop = 0.62 * (1 - this.stateT / 0.9);
          break;
        }
        // A hunched, limping stagger, one arm clutched to his side.
        const s = Math.sin(t * 7);
        hipL = s * 0.6;
        hipR = -s * 0.35;
        kneeL = Math.max(0, s) * 0.9 + 0.2;
        kneeR = Math.max(0, -s) * 0.5 + 0.3;
        shR = -0.2 + s * 0.3;
        shL = 0.3;
        elL = -1.6;
        lean = 0.45;
        neck = 0.35;
        drop = 0.08;
        roll = s * 0.08;
        break;
      }
      default: {
        const bob = Math.sin(t * 3) * 0.04;
        lean += bob;
        break;
      }
    }
    set(r.hipL, 'x', hipL);
    set(r.hipR, 'x', hipR);
    set(r.kneeL, 'x', kneeL);
    set(r.kneeR, 'x', kneeR);
    set(r.shoulderR, 'x', shR);
    set(r.shoulderL, 'x', shL);
    set(r.elbowR, 'x', elR);
    set(r.elbowL, 'x', elL);
    set(r.body, 'x', lean);
    set(r.neck, 'x', neck);
    r.body.position.y += (-drop - r.body.position.y) * k;
    this.roll += (roll - this.roll) * Math.min(1, dt * 12);
    if (this.state === 'overload' || this.state === 'retreat') {
      this._sparkT -= dt;
      if (this._sparkT <= 0) {
        this._sparkT = 0.12;
        this.vents[1].group.getWorldPosition(_v3);
        this.combat.effects.spark(_v3, { count: 3, color: 0x9fe8ff, speed: 3, size: 0.07, life: 0.4 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The secret chapter's last stage: the headset duel
// ---------------------------------------------------------------------------

export const DUEL = {
  integrity: 100, // the control headset's
  parryWindow: 0.3, // raise your guard within this long of his punch landing to parry it
  counterDamage: 11, // the first punch after a parry
  followDamage: 4, // the rest of that opening
  finishAt: 22, // at or below this, the next parry-counter is the right hook that ends it
  staggerFor: 2.0,
};

/**
 * Coach Billing without the spine: fists up, an ELDAR control headset clamped over his ears. His
 * punches telegraph like the gym's (yellow jab, orange hook, red haymaker) but blocking isn't
 * enough: raise your guard [RMB] just as a punch lands and it's a PARRY, which staggers him and
 * opens the headset to a counter. Plain hits barely scratch it. Once it's cracked, the next
 * parry-counter is a right hook that shatters it.
 */
class Duelist extends Boxer {
  constructor(combat) {
    super(combat, RECON_LOOK);
    this.integrity = DUEL.integrity;
    this.maxIntegrity = DUEL.integrity;
    this.parryOpen = false;
    this.windowHits = 0;
    this.parries = 0;
    this.parryStreak = 0;
    this._sparkT = 0;
    this._buildHeadset();
  }

  get alive() {
    return this.active && this.integrity > 0;
  }

  /** The bar (0..1): the headset's integrity. */
  healthFraction() {
    return Math.max(0, this.integrity) / this.maxIntegrity;
  }

  _buildHeadset() {
    const shell = new THREE.MeshStandardMaterial({ color: 0x20262c, metalness: 0.7, roughness: 0.35 });
    this.headsetGlow = new THREE.MeshBasicMaterial({ color: 0x3ad8ff });
    const g = new THREE.Group();
    [-1, 1].forEach((s) => {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 14), shell);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(s * 0.155, 0.17, 0);
      g.add(cup);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 16), this.headsetGlow);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(s * 0.195, 0.17, 0);
      g.add(ring);
    });
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.014, 6, 20, Math.PI), shell);
    band.position.set(0, 0.17, 0);
    g.add(band);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.2), shell);
    arm.position.set(0.14, 0.09, 0.13);
    arm.rotation.y = -0.6;
    g.add(arm);
    const mic = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), this.headsetGlow);
    mic.position.set(0.06, 0.08, 0.235);
    g.add(mic);
    this.rig.neck.add(g);
    this.headset = g;
  }

  spawn(pos, yaw) {
    this.maxIntegrity = Math.round(DUEL.integrity * (difficulty.hard ? 1.25 : 1));
    this.integrity = this.maxIntegrity; // (before super: refreshTargets only counts a living boss)
    super.spawn(pos, yaw);
    this.parryOpen = false;
    this.windowHits = 0;
    this.parries = 0;
    this.parryStreak = 0;
    this.headset.visible = true;
    this.headsetGlow.color.setHex(0x3ad8ff);
  }

  _toStalk() {
    super._toStalk();
    this.parryOpen = false;
  }

  _startAttack() {
    const frac = this.integrity / this.maxIntegrity;
    const r = Math.random();
    let seq;
    if (frac > 0.6) seq = r < 0.4 ? ['jab'] : r < 0.7 ? ['hook'] : r < 0.88 ? ['haymaker'] : ['jab', 'hook'];
    else if (frac > 0.3) seq = r < 0.25 ? ['jab'] : r < 0.5 ? ['hook'] : r < 0.75 ? ['haymaker'] : ['jab', 'jab', 'hook'];
    else seq = r < 0.3 ? ['hook', 'jab'] : r < 0.6 ? ['haymaker'] : ['jab', 'hook', 'haymaker'];
    this.combo = seq;
    this._nextStrike(1);
  }

  /** His punch lands (or doesn't): parried, blocked, or a hit. */
  _strike(dist, dx, dz) {
    const combat = this.combat;
    const def = BOXING.attacks[this.kind];
    const heavy = this.kind === 'haymaker';
    const pos = this.mesh.position;
    this.strikeT = 0.16;
    playPunchWhoosh(heavy ? 0.6 : 0.85);
    if (dist > 1.1) {
      const step = Math.min(dist - 1.0, heavy ? 0.7 : 0.4);
      pos.x += (dx / dist) * step;
      pos.z += (dz / dist) * step;
      combat.pushOut(pos, this.radius);
    }
    const facing = Math.cos(angleDiff(Math.atan2(dx, dz), this.yaw)) > 0.72;
    let whiffed = false;
    if (dist < def.reach && facing && !combat.down) {
      const b = combat.rifle.basis();
      const fl = Math.hypot(b.fwd.x, b.fwd.z) || 1;
      const lookingAtHim = dist > 1e-3 ? (-(b.fwd.x * dx + b.fwd.z * dz) / (dist * fl)) > 0.45 : true;
      const fists = combat.fists;
      if (fists && fists.guarding && lookingAtHim) {
        if (fists.guardT <= DUEL.parryWindow) {
          this._parried();
          return;
        }
        // Held up too early: it's only a block, and a haymaker still gets half through.
        this.parryStreak = 0;
        combat.damagePlayer(def.damage * (heavy ? 0.5 : 0.2), pos);
        playBlock();
        combat.hud.callout('BLOCKED', 'block');
        fists.jolted(0.6);
        combat.shake(heavy ? 0.7 : 0.3);
        combat.player.shove(dx, dz, heavy ? 3.4 : 1.8, { stumble: 0.12, dip: 0.02, roll: 0.02, recovery: 0.12 });
      } else {
        this.parryStreak = 0;
        combat.damagePlayer(def.damage, pos);
        playPunchHit(heavy);
        if (fists) fists.jolted(1);
        combat.shake(heavy ? 1.3 : 0.65);
        combat.player.shove(dx, dz, heavy ? 6 : 3, { stumble: heavy ? 0.55 : 0.25, dip: heavy ? 0.25 : 0.08, roll: heavy ? 0.2 : 0.08, recovery: heavy ? 0.7 : 0.25 });
      }
    } else {
      whiffed = true;
    }
    if (this.combo.length) {
      this._nextStrike(0.75);
      return;
    }
    this.state = 'recover';
    this.stateT = 0;
    this.recoverFor = def.recover + (whiffed ? 0.35 : 0);
    this.attackCd = rand(0.7, 1.3) * difficulty.fireMult;
  }

  /** Guard up in the window: his punch is turned aside and he's wide open. */
  _parried() {
    const combat = this.combat;
    const fists = combat.fists;
    this.parries++;
    this.parryStreak++;
    playParry();
    combat.hud.callout(this.integrity <= DUEL.finishAt ? 'PARRY! RIGHT HOOK!' : 'PARRY!', 'counter');
    combat.hitStop = 0.09;
    combat.shake(0.5);
    this.combo = [];
    this.parryOpen = true;
    this.windowHits = 0;
    this.state = 'stagger';
    this.stateT = 0;
    this.staggerFor = DUEL.staggerFor;
    this.guardUp = false;
    for (const g of this.glows) g.visible = false;
    this.mark.visible = false;
    if (fists) {
      fists.jolted(0.3);
      fists.fatigue = 0; // (a parry gives you your wind back)
      fists.cooldown = 0;
      fists.next = 1; // the right hand's up next
    }
    this.rig.neck.getWorldPosition(_v1);
    combat.effects.spark(_v1.set(_v1.x, _v1.y + 0.4, _v1.z), { count: 10, color: 0xbfefff, speed: 4, size: 0.07, life: 0.3 });
    if (this.parryStreak >= 5) Achievements.unlock('parry_master');
    if (combat.onDuelParry) combat.onDuelParry(this.parries, this.parryStreak);
  }

  /** Your punch landing. Returns 'counter' | 'finisher' | 'hit' | 'blocked' | 'miss'. */
  receivePunch() {
    const combat = this.combat;
    if (!this.alive || this.state === 'intro' || this.state === 'off' || this.state === 'dazed') return 'miss';
    const pos = this.mesh.position;
    const cam = combat.camera.position;
    const dx = pos.x - cam.x;
    const dz = pos.z - cam.z;
    const dist = Math.hypot(dx, dz);
    if (dist > BOXING.reach) return 'miss';
    const b = combat.rifle.basis();
    const fl = Math.hypot(b.fwd.x, b.fwd.z) || 1;
    if (dist > 0.4 && (b.fwd.x * dx + b.fwd.z * dz) / (dist * fl) < Math.cos(0.62)) return 'miss';
    const power = combat.fists ? combat.fists.power : 1;
    let result;
    let dmg;
    if (this.state === 'stagger' && this.parryOpen) {
      if (this.windowHits === 0 && this.integrity <= DUEL.finishAt) {
        result = 'finisher';
        dmg = this.integrity;
      } else if (this.windowHits === 0) {
        result = 'counter';
        dmg = DUEL.counterDamage;
      } else {
        result = 'hit';
        dmg = DUEL.followDamage;
      }
      this.windowHits++;
    } else if (this.state === 'recover' || this.state === 'taunt') {
      result = 'hit';
      dmg = 1.5; // the headset's covered: only a parry opens it
    } else {
      result = 'blocked';
      dmg = 0;
    }
    this.flashT = 0.1;
    this.sinceHit = 0;
    if (result === 'blocked') {
      playBlock();
      combat.hud.hit('armor');
      combat.hud.callout('GUARDED', 'block');
      return result;
    }
    if (result !== 'finisher') dmg *= power;
    this.integrity = Math.max(0, this.integrity - dmg);
    playPunchHit(result !== 'hit');
    combat.hitStop = result === 'finisher' ? 0.3 : result === 'counter' ? 0.09 : 0.05;
    combat.shake(result === 'finisher' ? 1.2 : result === 'counter' ? 0.6 : 0.3);
    combat.hud.hit(result === 'hit' ? 'hit' : 'head');
    this.reel = 1;
    if (result === 'counter') {
      combat.hud.callout('COUNTER!', 'counter');
      Achievements.bump('counters');
    } else if (result === 'finisher') {
      combat.hud.callout('RIGHT HOOK!', 'counter');
      Achievements.bump('counters');
    }
    if (this.integrity <= 0) this._defeat();
    return result;
  }

  _defeat() {
    const combat = this.combat;
    this.state = 'dazed';
    this.stateT = 0;
    this.combo = [];
    this.parryOpen = false;
    for (const g of this.glows) g.visible = false;
    this.mark.visible = false;
    this.rig.neck.getWorldPosition(_v1);
    _v1.y += 0.3;
    combat.effects.spark(_v1, { count: 34, color: 0x9fe8ff, speed: 7, size: 0.1, life: 0.7 });
    combat.effects.spark(_v1, { count: 16, color: 0xffb060, speed: 5, size: 0.08, life: 0.5 });
    combat.effects.chunks(_v1, { count: 6, speed: 5, size: 0.14 });
    combat.effects.flash(_v1, { size: 1.6, color: 0xbfefff, life: 0.25 });
    playHeadsetShatter();
    combat.shake(1.2);
    this.headset.visible = false;
    if (combat.onDuelistDefeated) combat.onDuelistDefeated();
  }

  update(dt) {
    super.update(dt);
    if (!this.active || !this.headset.visible) return;
    // The headset's state shows on its glow: cyan, then amber, then red and flickering; sparks when cracked.
    const frac = this.healthFraction();
    const flick = frac < 0.4 && Math.random() < 0.3 ? 0.25 : 1;
    this.headsetGlow.color.setHex(frac > 0.6 ? 0x3ad8ff : frac > 0.3 ? 0xffb13a : 0xff3a2a).multiplyScalar(flick);
    if (frac < 0.7) {
      this._sparkT -= dt;
      if (this._sparkT <= 0) {
        this._sparkT = 0.25 + frac * 0.5;
        this.rig.neck.getWorldPosition(_v1);
        _v1.y += 0.35;
        this.combat.effects.spark(_v1, { count: 2, color: 0x9fe8ff, speed: 2, size: 0.05, life: 0.3, gravity: 3 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Other Ben on the second rifle: keeps firing, rarely hits
// ---------------------------------------------------------------------------

class BenGunner {
  constructor(combat, ben) {
    this.combat = combat;
    this.ben = ben;
    const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7, metalness: 0.15 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x353a3f, roughness: 0.35, metalness: 0.8 });
    this.rifle = createRifleMesh(polymer, metal);
    this.rifle.rotation.x = Math.PI / 2; // muzzle forward, magazine down
    this.rifle.scale.setScalar(0.8);
    this.rifle.position.set(-0.13, 1.3, 0.3);
    this.rifle.visible = false;
    ben.mesh.userData.rig.body.add(this.rifle);
    this.muzzle = this.rifle.userData.muzzle;
    this.armed = false;
    this.firing = false;
    this.timer = 1.5;
    this.shotsLeft = 0;
    this.gap = 0;
    this.target = null;
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
  }

  arm() {
    this.armed = true;
    this.rifle.visible = true;
    this.ben.mesh.userData.rig.aiming = true;
  }

  update(dt) {
    if (!this.armed || !this.firing) return;
    if (!this.target || !this.target.alive || !this.target.engaged) {
      this.target = this.combat.nearestTarget(this.ben.position);
      if (!this.target) return;
    }
    this.ben.faceTowards(this.target.position);
    if (this.shotsLeft > 0) {
      this.gap -= dt;
      if (this.gap <= 0) {
        this._shoot();
        this.shotsLeft--;
        this.gap = 0.12;
      }
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.shotsLeft = BEN_GUN.shots[0] + Math.floor(Math.random() * (BEN_GUN.shots[1] - BEN_GUN.shots[0] + 1));
      this.timer = rand(BEN_GUN.burstGap[0], BEN_GUN.burstGap[1]);
      this.target = null; // re-pick between bursts (the closest threat changes)
    }
  }

  _shoot() {
    const combat = this.combat;
    const t = this.target;
    if (!t || !t.alive) return;
    this.muzzle.getWorldPosition(this._from);
    t.aimPoint(this._to);
    const hit = Math.random() < BEN_GUN.hitChance;
    if (hit) this._to.add(_v1.set(rand(-0.15, 0.15), rand(-0.2, 0.2), rand(-0.15, 0.15)));
    else this._to.add(_v1.set(rand(-1.2, 1.2), rand(-0.6, 1.0), rand(-1.2, 1.2)));
    combat.effects.tracer(this._from, this._to, 0xffe0a0);
    combat.effects.flash(this._from, { size: 0.3, life: 0.05 });
    if (combat.sfx('ben', 0.05)) playGunshot({ distant: true, volume: 0.8 });
    if (!hit) return;
    const result = t.takeHit(t.benZone(), BEN_GUN.damage);
    combat.effects.spark(this._to, {
      count: result === 'armor' ? 5 : 7,
      color: result === 'armor' ? 0xfff0c0 : 0xffb060,
      speed: 3,
      size: 0.05,
      life: 0.25,
    });
  }
}

// ---------------------------------------------------------------------------
// CombatSystem: owns everything above; chapter2_lab.js drives it
// ---------------------------------------------------------------------------

export class CombatSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene - the lab (Chapter 2) or the gym (Chapter 3)
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {import('./player.js').Player} o.player
   * @param {import('./world.js').Character} [o.ben] - the lab's Other Ben (his second rifle)
   * @param {'titan'|'mecha'|null} [o.boss]
   * @param {{[type: string]: number}} [o.pool] - ELDAR rigs to build up front
   * @param {number} [o.bolts] - plasma bolt pool size
   */
  constructor({ scene, camera, player, ben = null, boss = 'titan', pool = { standard: 12, shield: 5 }, bolts = 56 }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.ben = ben;
    this.mats = createEldarMaterials();
    this.effects = new Effects(scene);
    this.bolts = new Bolts(scene, this.effects, bolts);
    this.bottles = new Bottles(scene, this.effects);
    this.hud = new CombatHud();
    this.rifle = new Rifle(this);
    this.benGunner = ben ? new BenGunner(this, ben) : null;
    this.rigs = new RigPool(this);
    this.titan = boss === 'titan' ? new Titan(this) : null;
    // Chapter 3's gym: the Mecha and everything it throws at you, then the fist fight.
    this.lasers = boss === 'mecha' ? new LaserSweeps(scene) : null;
    this.hazards = boss === 'mecha' || boss === 'billing' ? new GroundHazards(scene, this.effects) : null;
    this.grid = boss === 'mecha' ? new FloorGrid(scene, this.effects) : null;
    this.missiles = boss === 'mecha' ? new Missiles(scene, this.effects) : null;
    this.mecha = boss === 'mecha' ? new Mecha(this) : null;
    this.fists = boss === 'mecha' || boss === 'billing' ? new Fists(this) : null;
    this.boxer = boss === 'mecha' ? new Boxer(this) : null;
    // The secret chapter's finale: Billing Reconstructed (wall dashes, spine vents), then the headset duel.
    this.recon = boss === 'billing' ? new Reconstructed(this) : null;
    this.duelist = boss === 'billing' ? new Duelist(this) : null;
    this.stats = { shots: 0 }; // rounds fired (a precision achievement reads it)
    this.extraTargets = [];
    this.customBoss = null; // a boss-bar fraction the story script drives itself (null: the bosses' own)
    this.rushTarget = null; // where scrap ELDARs run: Other Ben's terminal
    this.onRushArrive = null;
    this.onReconDown = null;
    this.onReconDebris = null;
    this.onDuelParry = null;
    this.onDuelistDefeated = null;
    this.arena = null; // { minX, maxX, minZ, maxZ }: where the Mecha, its eruptions and Billing stay
    this.inTransit = (pos) => pos.z > -35.5; // units still coming up the lab's corridor hurry (and don't aim yet)
    this.regen = true;
    this.hitStop = 0;
    this._ex = new THREE.Vector3();
    this.units = [];
    this._alive = 0;
    this.hitboxes = [];
    this.worldBoxes = [];
    this.spots = []; // [{ pos, taken }] firing positions in the chamber
    this.coverSlots = []; // [{ pos, taken }] behind the fallen pillar
    this.coverEnabled = false;
    this.navigate = (from, to) => [to.clone()]; // chapter2_lab.js supplies the real routing
    this.active = false;
    this.frozen = false; // a cutscene mid-fight: units, bolts and the Titan's AI hold still
    this.viewmodelVisible = true;
    this.maxHp = PLAYER_MAX_HP * difficulty.playerHpMult;
    this.hp = this.maxHp;
    this.sinceHurt = 99;
    this.down = false;
    this.holding = null; // 'bottle' during the Titan fight
    this.clock = 0;
    this._sfxT = {};
    this.muzzleLight = new THREE.PointLight(0xffc27a, 0, 10, 2);
    scene.add(this.muzzleLight);
    this._muzzleT = 0;
    this._shakeAmount = 0;
    this._shakeYaw = 0;
    this._shakePitch = 0;
    this._kick = { pitch: 0, yaw: 0, t: KICK_TIME };
    this._beatT = 0; // low-health heartbeat
    this._lowLevel = 0;
    this._recoilDebt = 0;
    this._pv = new THREE.Vector3(); // your velocity (they lead their shots)
    this._pp = new THREE.Vector3();
    this._hasPp = false;
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._m = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    // Hooks for the story script.
    this.onKill = null;
    this.onPlayerDown = null;
    this.onBossPhase = null;
    this.onBossStunned = null;
    this.onBossDefeated = null;
    this.onArmorHit = null;
    this.onBottleBlocked = null;
    this.onPillarDamaged = null;
    this.onBashed = null;

    // Every ELDAR the fight needs at once, built now (behind the loading fade).
    for (const [type, count] of Object.entries(pool)) this.rigs.fill(type, count);

    document.addEventListener('mousedown', (e) => {
      if (this.fists && this.fists.equipped) {
        if (!this._fistsInputOk()) return;
        if (e.button === 0) this.fists.punch();
        else if (e.button === 2) this.fists.setGuard(true);
        return;
      }
      if (!this._inputOk()) return;
      if (e.button === 0) this.rifle.triggerHeld = true;
      else if (e.button === 2) this.throwBottle();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.rifle.triggerHeld = false;
      if (e.button === 2 && this.fists && this.fists.guarding) this.fists.setGuard(false);
    });
    document.addEventListener('contextmenu', (e) => {
      if (this.player.isLocked) e.preventDefault();
    });
    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && !e.repeat && this._inputOk()) this.rifle.reload();
    });
    player.controls.addEventListener('unlock', () => {
      this.rifle.triggerHeld = false;
      if (this.fists && this.fists.guarding) this.fists.setGuard(false);
    });
  }

  _inputOk() {
    return this.active && this.player.isLocked && !this.player.inputLocked && !this.down && this.rifle.equipped;
  }

  _fistsInputOk() {
    return this.active && this.player.isLocked && !this.player.inputLocked && !this.down;
  }

  // ---- The gym's arena bounds -----------------------------------------------------

  inArena(x, z) {
    const a = this.arena;
    return !a || (x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ);
  }

  /** (x, z) pulled `margin` inside the arena, written into `out` (y untouched). */
  clampArena(x, z, out, margin = 0) {
    const a = this.arena;
    out.x = a ? THREE.MathUtils.clamp(x, a.minX + margin, a.maxX - margin) : x;
    out.z = a ? THREE.MathUtils.clamp(z, a.minZ + margin, a.maxZ - margin) : z;
    return out;
  }

  /** A blast (a Tank's shell, a missile): fire, smoke and splash damage with falloff. */
  explode(pos, radius, damage) {
    const p = this._ex.copy(pos);
    this.effects.flash(p, { size: radius * 1.5, color: 0xffa050, life: 0.2 });
    this.effects.spark(p, { count: 22, color: 0xffb060, speed: 6, size: 0.1, life: 0.5 });
    this.effects.spark(p, { count: 6, color: 0x7a7a7a, speed: 1.5, size: 0.35, life: 0.9, gravity: -1.2 });
    this.effects.ring(p, { from: 0.3, to: radius * 1.3, color: 0xffa070, life: 0.45 });
    this.shakeFrom(p, 0.9);
    if (this.sfx('boom', 0.06)) playExplosion();
    if (damage > 0 && !this.down) {
      const pp = this.player.object.position;
      const d = Math.hypot(pp.x - p.x, pp.z - p.z, pp.y - 0.9 - p.y);
      if (d < radius) this.damagePlayer(damage * (1 - 0.55 * (d / radius)), p);
    }
  }

  /** Stop any laser sweep or floor grid mid-attack (stumbles, cutscenes, retries). */
  endBeams() {
    if (this.lasers) this.lasers.end();
    if (this.grid) this.grid.end();
  }

  /** Full health (the end of every gym phase). */
  healFull() {
    this.maxHp = PLAYER_MAX_HP * difficulty.playerHpMult;
    this.hp = this.maxHp;
    this.down = false;
    this.sinceHurt = 99;
    this.hud.setHealth(1);
    this._setLowHealth(0);
  }

  /**
   * One of your fists reaching the end of a punch. A punch that lands has
   * weight: the world holds still for two frames (hitstop) and the view takes a
   * sharp kick toward the fist that threw it; one into his guard just jars you.
   */
  onPunchContact(hand) {
    let result = 'miss';
    if (this.boxer && this.boxer.active) result = this.boxer.receivePunch();
    else if (this.duelist && this.duelist.active) result = this.duelist.receivePunch();
    if (!result || result === 'miss') return;
    const side = hand && hand.s ? hand.s : 1;
    if (result === 'blocked') {
      this.impulse(-0.007, side * 0.005);
      return;
    }
    const big = result === 'counter' || result === 'finisher';
    hitstop.frames = Math.max(hitstop.frames, 2);
    this.impulse(big ? -0.03 : -0.019, side * (big ? 0.022 : 0.014));
  }

  /** A sharp camera impulse (radians): snaps to it, then springs back to where you're aiming. */
  impulse(pitch, yaw) {
    this._kick.pitch = pitch;
    this._kick.yaw = yaw;
    this._kick.t = 0;
  }

  /** The low-health state (0 = fine .. 1 = nearly down): audio ducking, only on a real change. */
  _setLowHealth(level) {
    if (level === this._lowLevel) return;
    this._lowLevel = level;
    setLowHealth(level);
  }

  /** Under 30% health: a heartbeat that quickens the closer you are to going down (the HUD pulses with it). */
  _updateHeartbeat(dt) {
    const frac = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    const danger = !this.down && frac < LOW_HP ? 1 - frac / LOW_HP : 0;
    this._setLowHealth(Math.round((danger > 0 ? 0.55 + 0.45 * danger : 0) * 20) / 20);
    if (danger <= 0) {
      this._beatT = 0;
      return;
    }
    this._beatT -= dt;
    if (this._beatT <= 0) {
      this._beatT = 60 / (72 + 50 * danger); // 72 bpm at 30%, over 120 near the end
      playLowHeartbeat(0.4 + 0.6 * danger);
      this.hud.beat = 1;
    }
  }

  /** Solid geometry for bullets, bolts, sight lines and robot movement (plus floor/ceilings). */
  setWorldColliders(meshes, extraBoxes = []) {
    this.worldBoxes = meshes
      .filter((m) => !m.userData.noShot)
      .map((m) => {
        m.updateWorldMatrix(true, false);
        return new THREE.Box3().setFromObject(m);
      })
      .concat(extraBoxes);
  }

  start() {
    this.active = true;
    this.hud.show(true);
    this.hud.setHealth(this.hp / this.maxHp);
    this.refreshTargets();
  }

  stop() {
    this.active = false;
    this.rifle.triggerHeld = false;
    if (this.fists) this.fists.setGuard(false);
    this.hud.show(false);
    this._setLowHealth(0);
  }

  /** Rate-limit a sound (a dozen units firing at once turns to mush otherwise). */
  sfx(key, gap) {
    const last = this._sfxT[key];
    if (last !== undefined && this.clock - last < gap) return false;
    this._sfxT[key] = this.clock;
    return true;
  }

  /** sfx(), but only within `range` meters of you. */
  sfxNear(pos, key, gap, range) {
    const p = this.player.object.position;
    if ((pos.x - p.x) ** 2 + (pos.z - p.z) ** 2 > range * range) return false;
    return this.sfx(key, gap);
  }

  // ---- Units ------------------------------------------------------------------

  spawnUnit(type, entry, options) {
    const unit = new Eldar(this, type, entry, options);
    this.units.push(unit);
    this._alive++;
    this.refreshTargets();
    return unit;
  }

  get aliveCount() {
    return this._alive;
  }

  /** Hitboxes for your bullets + solid bodies for your movement. */
  refreshTargets() {
    const live = this.units.filter((u) => !u.dead);
    this.hitboxes = live.flatMap((u) => u.hitboxes);
    const solid = this.ben ? [this.ben, ...live] : live.slice();
    for (const boss of [this.titan, this.mecha, this.boxer, this.recon, this.duelist]) {
      if (!boss || !boss.alive) continue;
      if (boss.hitboxes.length) this.hitboxes = this.hitboxes.concat(boss.hitboxes);
      solid.push(boss);
    }
    if (this.extraSolids) solid.push(...this.extraSolids);
    // Other shootable things (the secret chapter's hydraulic pipe): { alive, hitboxes, takeHit(zone, damage) }.
    if (this.extraTargets) for (const t of this.extraTargets) if (t.alive) this.hitboxes = this.hitboxes.concat(t.hitboxes);
    this.player.setCharacters(solid);
  }

  onUnitDown(unit) {
    this._alive = Math.max(0, this._alive - 1);
    this.releasePosition(unit);
    this.refreshTargets();
    if (this.onKill) this.onKill(unit);
  }

  /** Remove every unit, bolt and bottle (checkpoint retries). */
  clearCombatants() {
    for (const u of this.units) this._removeUnit(u);
    this.units = [];
    this._alive = 0;
    this.bolts.clear();
    this.bottles.clear();
    if (this.lasers) this.lasers.end();
    if (this.grid) this.grid.end();
    if (this.hazards) this.hazards.clear();
    if (this.missiles) this.missiles.clear();
    if (this.recon) this.recon.clearProjectiles();
    this.spots.forEach((s) => (s.taken = null));
    this.coverSlots.forEach((s) => (s.taken = null));
    this.holding = null;
    this.hud.setHeld(false);
    this.refreshTargets();
  }

  _removeUnit(u) {
    this.rigs.release(u.built);
  }

  claimPosition(unit, exclude) {
    const pp = this.player.object.position;
    // Units coming in from the corridor take cover behind the fallen pillar when they can.
    // (Never shield units: the pillar would hide their feet, their only weak spot.)
    if (this.coverEnabled && !unit.shielded && unit.root.position.z > -38.5 && (unit.wantsCover || Math.random() < 0.35)) {
      const slot = this.coverSlots.find((s) => !s.taken && s !== exclude);
      if (slot) {
        slot.taken = unit;
        unit.coverSlot = slot;
        unit.spot = null;
        return { pos: slot.pos, cover: true };
      }
    }
    // Somewhere 7-14m from you, not right next to where it just was.
    const from = unit.root.position;
    let best = null;
    let bestScore = Infinity;
    for (const s of this.spots) {
      if (s.taken || s === exclude) continue;
      const d = Math.hypot(s.pos.x - pp.x, s.pos.z - pp.z);
      const hop = Math.hypot(s.pos.x - from.x, s.pos.z - from.z);
      const score = Math.abs(d - 10.5) + Math.random() * 4 + (d < 5.5 ? 25 : 0) + (hop < 2.5 ? 6 : 0) + hop * 0.12;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) best = this.spots[Math.floor(Math.random() * this.spots.length)] || { pos: pp.clone() };
    best.taken = unit;
    unit.spot = best;
    unit.coverSlot = null;
    return { pos: best.pos, cover: false };
  }

  releasePosition(unit) {
    if (unit.spot && unit.spot.taken === unit) unit.spot.taken = null;
    if (unit.coverSlot && unit.coverSlot.taken === unit) unit.coverSlot.taken = null;
    unit.spot = null;
    unit.coverSlot = null;
  }

  /** Ben shoots whichever unit is closest to him, or the Titan when it's alone. */
  nearestTarget(from) {
    let best = null;
    let bestD = Infinity;
    for (const u of this.units) {
      if (!u.engaged || u.position.z > -34) continue; // in the chamber (or nearly)
      const d = u.position.distanceToSquared(from);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    if (best) return best;
    return this.titan && this.titan.engaged ? this.titan : null;
  }

  // ---- Shooting ---------------------------------------------------------------

  /** Your hitscan bullets. Returns 'hit' | 'head' | 'kill' | 'armor' | 'pillar' | null. */
  fireHitscan(origin, dir, muzzle, { damage, shooter }) {
    const o = this._o.copy(origin);
    const d = this._d.copy(dir);
    const m = this._m.copy(muzzle);
    const wall = rayBoxes(o, d, this.worldBoxes, RIFLE.range);
    // An incoming missile in the way gets shot down (unless something's hit first).
    const missile = this.missiles ? this.missiles.raycast(o, d, wall) : null;
    this._raycaster.set(o, d);
    this._raycaster.far = missile ? missile.dist : wall;
    const hits = this._raycaster.intersectObjects(this.hitboxes, false);
    const end = this._end;
    for (const h of hits) {
      const owner = h.object.userData.owner;
      if (!owner || !owner.alive) continue;
      const result = owner.takeHit(h.object.userData.zone, damage);
      if (!result) continue; // (e.g. where the Titan's pillar would be, before it has one)
      end.copy(h.point);
      const back = _v1.copy(d).negate();
      if (result === 'armor') {
        // Deflected: the round skips off along the reflection of the shot.
        const n = h.face ? this._n.copy(h.face.normal).transformDirection(h.object.matrixWorld) : this._n.copy(back);
        const r = this._r.copy(d).addScaledVector(n, -2 * d.dot(n)).normalize();
        this.effects.spark(end, { count: 9, color: 0xfff0c0, speed: 5, size: 0.05, life: 0.22, dir: r });
        this.effects.tracer(end, _v2.copy(end).addScaledVector(r, rand(1.2, 2.4)), 0xfff4d0);
        if (this.onArmorHit) this.onArmorHit(owner);
        if (shooter === 'player' && this.sfx('ricochet', 0.04)) playRicochet();
      } else if (result === 'pillar') {
        this.effects.spark(end, { count: 8, color: 0xffb060, speed: 4, size: 0.06, life: 0.28, dir: back });
        if (Math.random() < 0.2) this.effects.chunks(end, { count: 1, speed: 3, size: 0.12, dir: back });
      } else {
        this.effects.spark(end, { count: result === 'kill' ? 14 : 8, color: 0xffa050, speed: 4, size: 0.06, life: 0.3, dir: back });
        this.effects.spark(end, { count: 4, color: 0x9fe8ff, speed: 2, size: 0.05, life: 0.3 });
      }
      if (shooter === 'player') {
        this.hud.hit(result === 'pillar' ? 'hit' : result);
        if (result !== 'armor') playHitmarker(result);
        if (result === 'kill' && h.object.userData.zone === 'head' && owner.type) Achievements.bump('headKills');
      }
      this.effects.tracer(m, end);
      return result;
    }
    if (missile) {
      end.copy(o).addScaledVector(d, missile.dist);
      this.missiles.shootDown(missile.missile, this);
      this.effects.tracer(m, end);
      if (shooter === 'player') {
        this.hud.hit('hit');
        playHitmarker('hit');
      }
      return 'hit';
    }
    end.copy(o).addScaledVector(d, wall);
    if (wall < RIFLE.range) {
      this.effects.spark(end, { count: 5, color: 0xffd79a, speed: 3, size: 0.045, life: 0.25, dir: _v1.copy(d).negate() });
    }
    this.effects.tracer(m, end);
    return null;
  }

  fireBolt(from, target, { damage = 7, spread = 0.035, speed = BOLT_SPEED, size = 1, color = 0xff3322 } = {}) {
    const dir = _v2.subVectors(target, from).normalize();
    dir.x += rand(-spread, spread);
    dir.y += rand(-spread, spread) * 0.6;
    dir.z += rand(-spread, spread);
    dir.normalize();
    this.bolts.fire(from, dir, { damage, speed, size, color });
  }

  /** Your chest, leading your movement (ELDARs aim here). `speed` = their bolt's speed. */
  playerAimPoint(from, out, speed = BOLT_SPEED) {
    const p = this.player.object.position;
    const flight = Math.hypot(p.x - from.x, p.z - from.z) / speed;
    return out.set(p.x + this._pv.x * flight * LEAD, p.y - (this.player.isCrouching ? 0.25 : 0.4), p.z + this._pv.z * flight * LEAD);
  }

  canSeePlayer(from) {
    const p = this.player.object.position;
    const dir = _v3.subVectors(p, from);
    const dist = dir.length();
    dir.divideScalar(dist);
    return rayBoxes(from, dir, this.worldBoxes, dist) >= dist - 0.2;
  }

  damagePlayer(amount, from) {
    if (this.down || !this.active || sandbox.infiniteAmmo) return; // (Sandbox: infinite health too)
    amount *= difficulty.damageMult;
    this.player.recordDamage(amount); // (flawless runs and achievements)
    this.hp -= amount;
    this.sinceHurt = 0;
    this.hud.damaged(amount);
    this.hud.setHealth(this.hp / this.maxHp);
    playPlayerHurt();
    this.shake(0.3);
    if (this.hp <= 0) {
      this.hp = 0;
      this.down = true;
      this.rifle.triggerHeld = false;
      if (this.onPlayerDown) this.onPlayerDown();
    }
  }

  /** A shield unit's bash landing (or whiffing): 25 damage and you're knocked flat on your back. */
  shieldBash(unit) {
    const p = this.player.object.position;
    const pos = unit.root.position;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const d = Math.hypot(dx, dz);
    const fx = Math.sin(unit.yaw);
    const fz = Math.cos(unit.yaw);
    const facing = d > 1e-3 ? (dx * fx + dz * fz) / d : 1;
    playShieldBash();
    if (d < unit.stats.bashRange + 0.6 && facing > 0.3 && !this.down && this.active) {
      unit.aimPoint(_v1).addScaledVector(_v2.set(fx, 0, fz), 0.45); // the shield's face
      this.effects.spark(_v1, { count: 14, color: 0xfff0c0, speed: 4, size: 0.07, life: 0.3 });
      this.damagePlayer(unit.stats.bashDamage, pos);
      this.player.shove(d > 1e-3 ? dx : fx, d > 1e-3 ? dz : fz, 9, { stumble: 0.9, dip: 0.55, roll: 0.28, recovery: 1.1 });
      this.shake(1.1);
      if (this.onBashed) this.onBashed();
    }
  }

  resetPlayer() {
    this.maxHp = PLAYER_MAX_HP * difficulty.playerHpMult;
    this.hp = this.maxHp;
    this.down = false;
    this.sinceHurt = 99;
    this.hud.setHealth(1);
    this.player.clearStumble();
    this._setLowHealth(0);
  }

  // ---- Water bottles ---------------------------------------------------------

  holdBottle() {
    this.holding = 'bottle';
    this.hud.setHeld(true);
  }

  throwBottle() {
    if (this.holding !== 'bottle') return;
    this.holding = null;
    this.hud.setHeld(false);
    const b = this.rifle.basis();
    const from = _v1.copy(this.camera.position).addScaledVector(b.fwd, 0.45).addScaledVector(b.right, -0.2).addScaledVector(b.up, -0.15);
    const vel = _v2.copy(b.fwd).multiplyScalar(15).addScaledVector(UP, 3.2);
    this.bottles.throw(from, vel);
    playBottleThrow();
  }

  // ---- Feel: muzzle light, recoil, shake -----------------------------------------

  muzzleFlash(pos) {
    this.muzzleLight.position.copy(pos);
    this.muzzleLight.intensity = 6;
    this._muzzleT = 0.05;
  }

  recoil(pitch, yaw) {
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    _euler.x = THREE.MathUtils.clamp(_euler.x + pitch, -1.45, 1.45);
    _euler.y += yaw;
    this.camera.quaternion.setFromEuler(_euler);
    this._recoilDebt += pitch;
  }

  shake(amount) {
    this._shakeAmount = Math.max(this._shakeAmount, amount);
  }

  shakeFrom(pos, amount) {
    const d = pos.distanceTo(this.player.object.position);
    if (d < 25) this.shake(amount * (1 - d / 25));
  }

  _updateFeel(dt) {
    this._muzzleT -= dt;
    if (this._muzzleT <= 0) this.muzzleLight.intensity = 0;
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    // Undo last frame's shake, recover some recoil, apply this frame's shake.
    _euler.x -= this._shakePitch;
    _euler.y -= this._shakeYaw;
    if (!this.rifle.triggerHeld && this._recoilDebt > 0) {
      const back = Math.min(this._recoilDebt, this._recoilDebt * dt * 5 + 0.0002);
      this._recoilDebt -= back;
      _euler.x -= back * 0.65; // most of the kick settles back down
    }
    this._shakeAmount = Math.max(0, this._shakeAmount - dt * 2.2);
    const s = this._shakeAmount * 0.012;
    // A punch's kick rides on the shake offsets (undone next frame like the rest), easing back out.
    const k = this._kick;
    const kick = k.t < KICK_TIME ? (1 - k.t / KICK_TIME) ** 2 : 0;
    k.t += dt;
    this._shakePitch = rand(-s, s) + k.pitch * kick;
    this._shakeYaw = rand(-s, s) + k.yaw * kick;
    _euler.x = THREE.MathUtils.clamp(_euler.x + this._shakePitch, -1.5, 1.5);
    _euler.y += this._shakeYaw;
    this.camera.quaternion.setFromEuler(_euler);
  }

  // ---- Movement helpers for units -----------------------------------------------

  /** Push a circle (x/z) out of any solid box it overlaps. */
  pushOut(pos, radius) {
    for (const b of this.worldBoxes) {
      if (b.max.y < 0.3 || b.min.y > 1.5) continue; // floor / ceiling slabs
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
        // Center inside the box: out along the shallowest side.
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

  /** Keep units out of each other, out of you and out of the Titan (no per-frame allocations). */
  _separate() {
    const units = this.units;
    const pp = this.player.object.position;
    const big = this.titan && this.titan.alive ? this.titan : this.mecha && this.mecha.alive ? this.mecha : null;
    const titan = big ? big.root.position : null;
    for (let i = 0; i < units.length; i++) {
      const ua = units[i];
      if (ua.dead || ua.state === 'enter') continue;
      const a = ua.root.position;
      for (let j = i + 1; j < units.length; j++) {
        const ub = units[j];
        if (ub.dead || ub.state === 'enter') continue;
        const b = ub.root.position;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        const min = 0.8;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (min - d) / 2;
          a.x -= (dx / d) * push;
          a.z -= (dz / d) * push;
          b.x += (dx / d) * push;
          b.z += (dz / d) * push;
        }
      }
      let dx = a.x - pp.x;
      let dz = a.z - pp.z;
      let d2 = dx * dx + dz * dz;
      if (d2 < 1.0 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        a.x += (dx / d) * (1 - d);
        a.z += (dz / d) * (1 - d);
      }
      if (titan) {
        dx = a.x - titan.x;
        dz = a.z - titan.z;
        d2 = dx * dx + dz * dz;
        const min = big.radius + ua.radius;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          a.x += (dx / d) * (min - d);
          a.z += (dz / d) * (min - d);
        }
      }
    }
  }

  // ---- Floating health bars --------------------------------------------------------

  createHealthBar() {
    const bg = new THREE.Sprite(this.mats.barBg);
    bg.scale.set(0.86, 0.1, 1);
    bg.renderOrder = 10;
    bg.visible = false;
    const fill = new THREE.Sprite(this.mats.barFill);
    fill.center.set(0, 0.5);
    fill.renderOrder = 11;
    fill.visible = false;
    this.scene.add(bg, fill);
    return { bg, fill };
  }

  updateHealthBar(bar, unit, frac) {
    const show = !unit.dead;
    bar.bg.visible = bar.fill.visible = show;
    if (!show) return;
    unit.rig.neck.getWorldPosition(_v1);
    _v1.y += 0.55;
    bar.bg.position.copy(_v1);
    const e = this.camera.matrixWorld.elements; // camera right vector
    bar.fill.position.set(_v1.x - e[0] * 0.41, _v1.y - e[1] * 0.41, _v1.z - e[2] * 0.41);
    bar.fill.scale.set(0.82 * Math.max(0.001, frac), 0.07, 1);
  }

  // ---- Per frame -----------------------------------------------------------

  update(dt) {
    this.effects.update(dt);
    if (!this.active) return;
    this.clock += dt;
    const p = this.player.object.position;
    if (this._hasPp) {
      this._pv.subVectors(p, this._pp).divideScalar(Math.max(dt, 1e-4));
      this._pv.y = 0;
      if (this._pv.lengthSq() > 81) this._pv.set(0, 0, 0); // teleports / shoves aren't running
    }
    this._hasPp = true;
    this._pp.copy(p);
    if (this.player.inputLocked) this.rifle.triggerHeld = false;
    if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);

    this.rifle.update(dt);
    if (this.fists) this.fists.update(dt);
    if (!this.frozen) {
      for (const u of this.units) u.update(dt);
      this._separate();
      // (Being shoved apart mustn't leave a scrap unit inside a wall: a crowd at a doorway popped through it.)
      for (const u of this.units) if (u.scrap && u.state === 'rush') this.pushOut(u.root.position, u.radius);
      this.bolts.update(dt, this);
      this.bottles.update(dt, this);
      if (this.benGunner) this.benGunner.update(dt);
      if (this.lasers) this.lasers.update(dt, this);
      if (this.grid) this.grid.update(dt, this);
      if (this.hazards) this.hazards.update(dt, this);
      if (this.missiles) this.missiles.update(dt, this);
    }
    if (this.titan) this.titan.update(dt);
    if (this.mecha) this.mecha.update(dt);
    if (this.boxer) this.boxer.update(dt);
    if (this.recon) this.recon.update(dt);
    if (this.duelist) this.duelist.update(dt);

    for (let i = this.units.length - 1; i >= 0; i--) {
      if (this.units[i].removeMe) {
        this._removeUnit(this.units[i]);
        this.units.splice(i, 1);
      }
    }

    this.sinceHurt += dt;
    if (this.regen && !this.down && this.sinceHurt > REGEN_DELAY && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + REGEN_RATE * dt);
      this.hud.setHealth(this.hp / this.maxHp);
    }
    this._updateHeartbeat(dt);
    this._updateFeel(dt);
    this.hud.update(dt);
    const t = this.titan;
    if (this.customBoss !== null && this.customBoss !== undefined) {
      this.hud.setBoss(this.customBoss, null); // (the secret chapter's override bar)
    } else if (t) {
      const showBoss = t.active && !t.dead;
      this.hud.setBoss(showBoss ? t.healthFraction() : null, showBoss ? t.pillarFraction() : null);
    } else if (this.boxer && this.boxer.active) {
      this.hud.setBoss(this.boxer.hp / this.boxer.maxHp, null);
    } else if (this.duelist && this.duelist.active) {
      this.hud.setBoss(this.duelist.alive && this.showBossBar ? this.duelist.healthFraction() : null, null);
    } else if (this.recon && this.recon.alive) {
      this.hud.setBoss(this.showBossBar ? this.recon.healthFraction() : null, null);
    } else if (this.recon) {
      this.hud.setBoss(null, null);
    } else if (this.mecha) {
      const showBoss = this.mecha.alive && this.showBossBar;
      this.hud.setBoss(showBoss ? this.mecha.healthFraction() : null, showBoss ? this.mecha.subFraction() : null);
    }
  }

  /** Second pass: the rifle (or your fists) over the world (skipped in cutscenes). */
  renderViewmodel(renderer, show) {
    if (show && this.viewmodelVisible) this.rifle.render(renderer);
  }

  resize(aspect) {
    this.rifle.resize(aspect);
  }

  /** Make one of everything visible so renderer.compile() builds their shaders up front. */
  prewarm(on) {
    this.effects.sparks[0].sprite.visible = on;
    this.effects.tracers[0].line.visible = on;
    this.effects.flashes[0].sprite.visible = on;
    this.effects.rings[0].mesh.visible = on;
    this.effects.debris[0].mesh.visible = on;
    this.effects.arcs.visible = on;
    this.bolts.pool[0].group.visible = on;
    this.bottles.pool[0].group.visible = on;
    if (this.titan) {
      this.titan.warnRing.visible = on;
      this.titan.heldPillar.visible = on || this.titan.hasPillar;
    }
    if (this.lasers) {
      for (const m of [this.lasers.core, this.lasers.glow, this.lasers.feed, this.lasers.guide]) {
        m.visible = on;
        if (on) m.scale.set(0.1, 0.1, 1);
      }
      this.lasers.fan.visible = on;
    }
    if (this.hazards) this.hazards.pool[0].ring.visible = this.hazards.pool[0].disc.visible = on;
    if (this.grid) this.grid.quads[0].visible = on;
    if (this.missiles) this.missiles.pool[0].group.visible = on;
    if (this.mecha) {
      this.mecha.shieldMesh.visible = on;
      this.mecha.tethers.visible = on;
      this.mecha.cracks.visible = on || (this.mecha.crackLevel > 0 && this.mecha.crackLevel < 3);
    }
    if (this.boxer) {
      this.boxer.mesh.visible = on || this.boxer.active;
      this.boxer.mark.visible = on;
      for (const g of this.boxer.glows) g.visible = on;
    }
    if (this.fists) this.fists.group.visible = on || this.fists.equipped;
    if (this.recon) {
      this.recon.mesh.visible = on || this.recon.active;
      this.recon.lane.visible = on;
      this.recon.held.visible = on;
      for (const c of this.recon.chunks.slice(0, 1)) c.mesh.visible = on;
    }
    if (this.duelist) {
      this.duelist.mesh.visible = on || this.duelist.active;
      this.duelist.mark.visible = on;
      for (const g of this.duelist.glows) g.visible = on;
    }
    for (const type of ['standard', 'shield', 'tank', 'scrap']) {
      const built = this.rigs.free[type][0];
      if (built) {
        built.root.visible = on;
        built.bar.bg.visible = on;
        built.bar.fill.visible = on;
      }
    }
  }
}

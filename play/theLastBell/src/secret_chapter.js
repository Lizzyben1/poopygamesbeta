import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createHumanoid, Character, OTHER_BEN_LOOK, COACH_BILLING_LOOK, setSeatedPose, standUp } from './world.js';
import { CombatSystem, createRifleMesh, createEldarRig, createEldarMaterials, animateEldar } from './combat.js';
import { createBeamMaterial, createBeamGeometry, createMarkTexture, CH1_VISION } from './stealth.js';
import { NavGrid } from './chapter3_stealth.js';
import { difficulty, isPartTwoUnlocked, grantHallLegend, markPartFlawless } from './difficulty.js';
import { Achievements } from './achievements.js';
import {
  setUnderground,
  setRainExposure,
  playRadioStatic,
  playLightning,
  playArmLunge,
  playCarDoor,
  playEngineRoar,
  playTireScreech,
  playDistantEngine,
  playPA,
  playBeep,
  playPickup,
  playMetalDoorSlam,
  playBlastDoor,
  playIncinerator,
  playPipeBurst,
  playNodeDisable,
  playLaserZap,
  playCloneStep,
  playWhistle,
  playCaughtStinger,
  playRobotCharge,
  playServo,
  playLadderStep,
  playReloadStep,
  playSlide,
  startAlarm,
  stopAlarm,
  startPoliceSiren,
  stopPoliceSiren,
  playSprinklers,
  playHandcuffs,
  playBirds,
  playSting,
  playMechanism,
  playHideCreak,
  playExplosion,
  playDoorSlide,
  playCeilingCrash,
  playHeartbeat,
  playRockClatter,
  playBottleThrow,
} from './audio.js';

/*
 * The Secret Chapter: OVERTIME. Unlocked by beating the game (Part 1); Part 2 ("Sudden Death")
 * unlocks once Chapters 1, 2 and 3 have each been cleared on Hard Mode without dying.
 *
 *   PART 1 · THE VANISHING AT THE TRACK
 *     An emergency radio call, the car parked outside the athletic track in a storm, Other Ben out
 *     at the trunk, and an ELDAR arm hauling him into a blacked-out van. Then the campus in a full
 *     blackout: an emergency flashlight, Rogue Scrappers (fast, erratic, sight + sound), and three
 *     clues (Other Ben's cracked phone at the bleachers, a maintenance keycard, an electrical bypass
 *     fuse) that open the boiler room hatch. Below: Other Ben strapped to a chair inside a cage of
 *     red laser tripmines, the incinerator lighting, the blast door slamming, 00:05... 00:04...
 *     00:03... and a hard cut to black: "To Be Concluded".
 *
 *   PART 2 · SUDDEN DEATH
 *     Shoot the overhead hydraulic pipe: the steam halts the incinerator and unlocks the blast
 *     gate. Disable three laser power nodes in the practice hall while the Coach Clones (animatronics
 *     with flashlights and Billing's footsteps) patrol it. Then Coach Billing Reconstructed:
 *       stage 1  wall-dashes; shoot his spine's cooling vents while he stops to throw rubble
 *       stage 2  body-block the doorway (and shoot) while scrap ELDARs rush Other Ben's terminal
 *       stage 3  the boxing parry duel: time your guard to parry, counter, and break his headset
 *     Sprinklers put out the electrical fire, police secure the campus, and the Bens walk out into
 *     the dawn. Beating it grants the permanent "Hall Legend" badge and the Sandbox toggle.
 *
 * Everything underground (the stairwell, the control gallery, the incinerator hall and the practice
 * hall) is one THREE.Scene; the campus above is Chapter 1's world, in the dark.
 */

// ---- Layout: the grounds (Chapter 1's world; -Z is toward the oak) ---------------------------------
const CAR = { x: -59, z: -72, yaw: 0 }; // parked just outside the west bend of the loop trail (the "track")
const VAN = { x: -65.8, z: -78.5 }; // nose north, sliding door toward the car
const BEN_TRUNK = new THREE.Vector3(-59, 0, -75.2); // where Other Ben stands at the open trunk
const HATCH = { x: 8.5, z: -35.7 }; // the boiler room's bulkhead, against the school's south wall
const BOUNDS = { minX: -68, maxX: 64, minZ: -124, northWest: -12, northEast: -34.4, schoolHalf: 12.4 };
const CLUE_DEFS = [
  { id: 'phone', label: "Other Ben's phone", where: 'by the bleachers', x: -13.2, z: -66.4 },
  { id: 'keycard', label: 'Maintenance keycard', where: 'at the equipment shed', x: -32.9, z: -83.9 },
  { id: 'fuse', label: 'Electrical bypass fuse', where: 'in the utility cabinet', x: 20.5, z: -46.9 },
];
const SCRAPPER_STARTS = [[-8, -58], [8, -92], [30, -62], [44, -96], [46, -48]];
const SCRAPPER = {
  patrol: 3.3,
  burst: 6.2,
  chase: 6.6,
  investigate: 5.2,
  sight: 13,
  halfAngle: THREE.MathUtils.degToRad(56),
  catchRadius: 1.05,
  loseSight: 3.0,
};
const V = CH1_VISION;
// Part 1's blackout, on top of the Scrappers: rocks you can throw ([RMB]) to pull them off with the
// noise, piles of them to restock from, clue pick-ups that make noise of their own, Billing on the
// campus PA (battery backup), and Billing himself, out in the storm, seen only by lightning.
const ROCK = { start: 2, max: 4, pile: 2, speed: 14.5, lift: 3.6, gravity: 9.8, hearRadius: 17, rest: 9 };
const ROCK_PILES = [[-51.5, -69.5], [-22.5, -60.5], [3.5, -86.5], [27.5, -55.5], [-38.5, -92.5]];
const PICKUP_NOISE = 11; // meters: Scrappers this close hear you grab a clue (13 for the cabinet door)
const PA_TAUNTS = [
  'Tick tock, Ben. Your buddy is running out of overtime.',
  'You never could finish a lap without stopping, could you?',
  "My Scrappers don't get tired, Ben. You do.",
  "It's warm down in the boiler room. Warmer every minute.",
  'I can hear you out there. Breathing. Stopping. Hiding. Pathetic.',
  'Lights out, Ben. Somebody has to run this program.',
];
const LIGHTNING_SKY = new THREE.Color(0x4f5f7e); // the whole sky, for the instant of a strike
const BLACKOUT_SKY = new THREE.Color(0x030508);

// ---- Layout: underground (one scene; the player travels north, toward -Z) ----------------------------
const UG = {
  gallery: { minX: -6, maxX: 6, minZ: 14, maxZ: 26, h: 7 },
  hall: { minX: -14, maxX: 14, minZ: -14, maxZ: 14, h: 9 }, // the incinerator hall: Ben's chair, and the boss arena
  sim: { minX: -46, maxX: -20, minZ: -13, maxZ: 13, h: 6 }, // the practice hall: the clones and the three power nodes
  doorHalf: 4, // the blast door's opening (x from -4 to 4) in the wall at z = 14
  doorH: 4.4,
  chair: new THREE.Vector3(0, 0, 4),
  terminal: new THREE.Vector3(13.1, 0, -6.2), // Other Ben's security terminal (the east alcove)
  alcoveDoor: new THREE.Vector3(10.4, 0, -6.2), // its one doorway: the place to stand
  hallDoor: new THREE.Vector3(-14, 0, 0), // west door of the hall -> the corridor to the practice hall
};
const ARENA = { minX: -13.2, maxX: 13.2, minZ: -13.2, maxZ: 13.2 };
const GALLERY_SPAWN = { pos: new THREE.Vector3(0, 0, 22.4), yaw: 0 };
const PURGE_SECONDS = 45; // Part 2: how long you have to get the pipe (before the furnace lights)

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

/** Distance from (px, pz) to the segment (ax, az)-(bx, bz) on the floor plane. */
function segDist2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-8 ? THREE.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

const smooth = (t) => THREE.MathUtils.smoothstep(t, 0, 1);

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function tex(canvas, repeat = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  return t;
}

function grime(g, size, count, alpha = 0.07) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.6})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
}

function concreteTexture(base = '#6f757a') {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  grime(g, 256, 1400);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 2;
  for (let y = 0; y < 256; y += 64) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  for (let i = 0; i < 6; i++) {
    g.fillStyle = 'rgba(40,30,20,0.09)';
    g.fillRect(Math.random() * 256, 0, 6 + Math.random() * 10, 256);
  }
  return tex(c, true);
}

function gratingTexture() {
  const c = makeCanvas(128);
  const g = c.getContext('2d');
  g.fillStyle = '#23272b';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 3;
  for (let i = 0; i <= 128; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 128);
    g.moveTo(0, i);
    g.lineTo(128, i);
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  for (let i = 8; i <= 128; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 128);
    g.stroke();
  }
  grime(g, 128, 500, 0.1);
  return tex(c, true);
}

function hazardTexture() {
  const c = makeCanvas(128, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#d8a21c';
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#15161a';
  for (let x = -32; x < 160; x += 32) {
    g.beginPath();
    g.moveTo(x, 32);
    g.lineTo(x + 16, 32);
    g.lineTo(x + 48, 0);
    g.lineTo(x + 32, 0);
    g.closePath();
    g.fill();
  }
  return tex(c, true);
}

/** A little canvas display (returns { canvas, texture, draw(fn) }). */
function makeScreen(w, h) {
  const canvas = makeCanvas(w, h);
  const texture = tex(canvas);
  const ctx = canvas.getContext('2d');
  return {
    canvas,
    texture,
    draw(fn) {
      fn(ctx, w, h);
      texture.needsUpdate = true;
    },
  };
}

function signTexture(lines, { bg = '#1b1b1f', fg = '#e8d9a0', border = '#e0c34a', w = 512, h = 128 } = {}) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = border;
  g.lineWidth = 6;
  g.strokeRect(4, 4, w - 8, h - 8);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((line, i) => {
    g.font = `bold ${i === 0 ? 40 : 26}px Arial, sans-serif`;
    g.fillText(line, w / 2, (h / (lines.length + 1)) * (i + 1));
  });
  return tex(c);
}

function glowTexture(color = 'rgba(255,255,255,1)') {
  const c = makeCanvas(64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.35)'));
  grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// A static-geometry builder: boxes batched per material, colliders kept
// ---------------------------------------------------------------------------

function makeBuilder(scene, colliders) {
  const batch = new Map();
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  function toBatch(mesh) {
    mesh.updateMatrix();
    let list = batch.get(mesh.material);
    if (!list) batch.set(mesh.material, (list = []));
    list.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));
  }
  /** A box (x, y, z = its center). static: merged into the scene's one mesh per material. */
  function box({ w, h, d, x, y, z, material, collider = true, rotationY = 0, static: isStatic = true, tile = 0 }) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (tile) {
      // Tile the texture every `tile` meters instead of stretching it over the whole face.
      const uv = geo.attributes.uv;
      const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      for (let f = 0; f < 6; f++) {
        for (let i = 0; i < 4; i++) {
          const k = f * 4 + i;
          uv.setXY(k, (uv.getX(k) * faces[f][0]) / tile, (uv.getY(k) * faces[f][1]) / tile);
        }
      }
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    if (material.visible !== false) {
      if (isStatic) toBatch(mesh);
      else scene.add(mesh);
    }
    if (collider) colliders.push(mesh);
    return mesh;
  }
  /** Any geometry, batched (no collider). */
  function shape(geo, material, x, y, z, rx = 0, ry = 0, rz = 0) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    toBatch(mesh);
    return mesh;
  }
  function flush() {
    batch.forEach((list, material) => {
      const merged = new THREE.Mesh(mergeGeometries(list), material);
      merged.matrixAutoUpdate = false;
      scene.add(merged);
      list.forEach((geo) => geo.dispose());
    });
    batch.clear();
    for (const c of colliders) c.updateMatrixWorld(true);
  }
  return { box, shape, flush, hidden };
}

// ---------------------------------------------------------------------------
// The storm: a heavy layer of rain on top of the world's own, following the camera
// ---------------------------------------------------------------------------

class StormRain {
  constructor(scene, camera, count = 2600) {
    this.camera = camera;
    this.count = count;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 6);
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attr);
    this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fb2c8, transparent: true, opacity: 0.34, depthWrite: false, fog: false }));
    this.mesh.frustumCulled = false;
    this.mesh.name = 'storm-rain';
    scene.add(this.mesh);
    const c = camera.position;
    this.drops = Array.from({ length: count }, () => ({ x: c.x + rand(-16, 16), y: rand(0, 16), z: c.z + rand(-16, 16), v: rand(20, 28) }));
  }

  update(dt) {
    const c = this.camera.position;
    const a = this.pos;
    for (let i = 0; i < this.count; i++) {
      const d = this.drops[i];
      d.y -= d.v * dt;
      d.x += 2.4 * dt;
      if (d.y < 0) {
        d.y += 16;
        d.x = c.x + rand(-16, 16);
        d.z = c.z + rand(-16, 16);
      }
      if (d.x - c.x > 16) d.x -= 32;
      else if (d.x - c.x < -16) d.x += 32;
      if (d.z - c.z > 16) d.z -= 32;
      else if (d.z - c.z < -16) d.z += 32;
      const o = i * 6;
      a[o] = d.x;
      a[o + 1] = d.y;
      a[o + 2] = d.z;
      a[o + 3] = d.x + 0.1;
      a[o + 4] = d.y + 0.8;
      a[o + 5] = d.z;
    }
    this.attr.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Props on the grounds
// ---------------------------------------------------------------------------

/** The blacked-out surveillance van: a sliding side door with something red-eyed behind it, and a horn on the roof. */
function buildVan(scene) {
  const van = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.35 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.7, metalness: 0.4 });
  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    van.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(2.1, 1.75, 3.7), body, 0, 1.35, -0.5); // cargo box
  add(new THREE.BoxGeometry(2.0, 1.25, 1.5), body, 0, 1.0, 1.95); // cab
  add(new THREE.BoxGeometry(1.8, 0.5, 0.05), new THREE.MeshStandardMaterial({ color: 0x020304, roughness: 0.1, metalness: 0.8 }), 0, 1.5, 2.72, -0.4); // windshield
  const tire = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
  const wheels = [[-1.02, 1.5], [1.02, 1.5], [-1.02, -1.6], [1.02, -1.6]].map(([x, z]) => {
    const w = add(new THREE.CylinderGeometry(0.44, 0.44, 0.3, 14), tire, x, 0.44, z);
    w.rotation.z = Math.PI / 2;
    return w;
  });
  // The roof speaker: a horn on a mount (Billing's voice comes out of it).
  add(new THREE.BoxGeometry(0.3, 0.12, 0.3), trim, 0, 2.28, 0.4);
  const horn = add(new THREE.CylinderGeometry(0.09, 0.34, 0.5, 14), trim, 0, 2.5, 0.4);
  horn.rotation.x = Math.PI / 2 - 0.25;
  const tail = new THREE.MeshBasicMaterial({ color: 0x2a0808 });
  [-0.7, 0.7].forEach((x) => add(new THREE.BoxGeometry(0.32, 0.14, 0.05), tail, x, 1.05, -2.37));
  // The sliding side door (+X, facing the car): black opening behind it, two red eyes in the dark.
  const opening = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.45), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  opening.position.set(1.06, 1.4, -0.3);
  opening.rotation.y = Math.PI / 2;
  van.add(opening);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false });
  const eyes = [-0.13, 0.13].map((dz) => {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.1), eyeMat);
    eye.position.set(1.075, 1.55, -0.3 + dz); // (just in front of the black opening)
    eye.visible = false;
    van.add(eye);
    return eye;
  });
  const door = new THREE.Group();
  door.position.set(1.08, 0, -0.3);
  van.add(door);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 1.6), body);
  panel.position.set(0, 1.4, 0);
  door.add(panel);
  van.position.set(VAN.x, 0, VAN.z);
  van.name = 'surveillance-van';
  scene.add(van);
  return {
    group: van,
    wheels,
    door,
    setDoor(open) {
      door.position.z = -0.3 - open * 1.8;
      eyes.forEach((e) => (e.visible = open > 0.6));
    },
    setTailLights(on) {
      tail.color.setHex(on ? 0xff2a1a : 0x2a0808);
    },
    /** World position of the door's mouth (the arm's base). */
    mouth(out) {
      return van.localToWorld(out.set(1.1, 1.25, -0.3));
    },
  };
}

/** A robot arm as a chain of joints and links from `from` to `to` (drawn every frame; sags a little). */
class ArmChain {
  constructor(scene, links = 7) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    // (Little metalness: with no environment map, bright metal renders black in the dark.)
    const steel = new THREE.MeshStandardMaterial({ color: 0x8d99a4, metalness: 0.3, roughness: 0.45, emissive: 0x2a0606 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3b444c, metalness: 0.3, roughness: 0.5, emissive: 0x3a0808 });
    const linkGeo = new THREE.CylinderGeometry(0.075, 0.075, 1, 8);
    linkGeo.rotateX(Math.PI / 2); // along +Z
    this.links = Array.from({ length: links }, () => {
      const m = new THREE.Mesh(linkGeo, steel);
      this.group.add(m);
      return m;
    });
    this.joints = Array.from({ length: links + 1 }, () => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), dark);
      this.group.add(m);
      return m;
    });
    // The claw: three fingers.
    this.claw = new THREE.Group();
    this.group.add(this.claw);
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), steel);
      f.position.set(Math.cos((i * Math.PI * 2) / 3) * 0.09, Math.sin((i * Math.PI * 2) / 3) * 0.09, 0.15);
      f.rotation.z = (i * Math.PI * 2) / 3;
      this.claw.add(f);
    }
    this.eye = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.02), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    this.eye.position.set(0, 0.06, 0.04);
    this.claw.add(this.eye);
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  /** Lay the chain from `from` to `to`. `sag` bows it downward in the middle. */
  set(from, to, sag = 0.25) {
    const n = this.links.length;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.joints[i].position.lerpVectors(from, to, t);
      this.joints[i].position.y -= Math.sin(t * Math.PI) * sag;
    }
    for (let i = 0; i < n; i++) {
      const a = this.joints[i].position;
      const b = this.joints[i + 1].position;
      const link = this.links[i];
      link.position.lerpVectors(a, b, 0.5);
      link.lookAt(b);
      link.scale.set(1, 1, Math.max(0.01, a.distanceTo(b)));
    }
    this.claw.position.copy(to);
    this.claw.lookAt(this._a.copy(to).add(this._b.subVectors(to, from)));
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}

/** A lit, glowing pick-up: a hitbox (the [E] target), a glow sprite, and a spinning model. */
function makeClue(scene, def, model, glowColor) {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  scene.add(group);
  group.add(model);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(glowColor), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
  );
  glow.scale.set(1.2, 1.2, 1);
  glow.position.y = model.position.y + 0.15;
  group.add(glow);
  const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.9), new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.position.set(def.x, model.position.y + 0.1, def.z);
  hitbox.userData = { interactable: true, label: `Pick up: ${def.label}`, type: 'sc-clue', id: def.id };
  scene.add(hitbox);
  return { group, glow, hitbox, model, taken: false };
}

function buildPhone() {
  const phone = new THREE.Group();
  phone.add(new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.012, 0.155), new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.5 })));
  const c = makeCanvas(64, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#0d3a48';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#7fe8ff';
  g.font = 'bold 13px Arial';
  g.fillText('BEN', 6, 22);
  g.fillText('no signal', 6, 40);
  g.strokeStyle = 'rgba(255,255,255,0.85)'; // the cracks
  g.lineWidth = 1.5;
  [[0, 20, 64, 80], [30, 0, 44, 128], [10, 128, 64, 60]].forEach(([x0, y0, x1, y1]) => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo((x0 + x1) / 2 + 6, (y0 + y1) / 2 - 8);
    g.lineTo(x1, y1);
    g.stroke();
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.135), new THREE.MeshBasicMaterial({ map: tex(c), fog: false }));
  screen.rotation.x = -Math.PI / 2;
  screen.position.y = 0.0075;
  phone.add(screen);
  phone.rotation.y = 0.6;
  phone.position.y = 0.03;
  return phone;
}

function buildKeycard() {
  const group = new THREE.Group();
  const card = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.012, 0.115), new THREE.MeshStandardMaterial({ color: 0xe8e6da, roughness: 0.5 }));
  group.add(card);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.014, 0.03), new THREE.MeshBasicMaterial({ color: 0x3cff7a }));
  stripe.position.z = -0.03;
  group.add(stripe);
  group.position.y = 0.96;
  group.rotation.y = 0.4;
  return group;
}

function buildFuse() {
  const group = new THREE.Group();
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.16, 10),
    new THREE.MeshStandardMaterial({ color: 0xd8e6ea, transparent: true, opacity: 0.6, roughness: 0.1 }),
  );
  glass.rotation.z = Math.PI / 2;
  group.add(glass);
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.15, 6), new THREE.MeshBasicMaterial({ color: 0xffb13a }));
  wire.rotation.z = Math.PI / 2;
  group.add(wire);
  [-1, 1].forEach((s) => {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.03, 10), new THREE.MeshStandardMaterial({ color: 0xb08a4a, metalness: 0.8, roughness: 0.3 }));
    cap.rotation.z = Math.PI / 2;
    cap.position.x = s * 0.085;
    group.add(cap);
  });
  group.position.y = 1.15;
  return group;
}

// ---------------------------------------------------------------------------
// Rogue Scrappers: rusted ELDAR salvage that never stops moving
// ---------------------------------------------------------------------------

const SCRAP_GLOW_CALM = new THREE.Color(1.0, 0.5, 0.08);
const SCRAP_GLOW_HOT = new THREE.Color(1.0, 0.22, 0.1);

/**
 * Fast, twitchy, erratic. They wander the grounds in sudden bursts (a jerk one way, a sprint the
 * other), stop to sniff and scan, and search wherever they last saw or heard you. Sight is a wide
 * visor cone (much longer if your flashlight is on, short if you're crouched); hearing depends on
 * how you move. Once one has you in its sights it chases at nearly your sprint speed; reaching you
 * ends it.
 */
class Scrapper {
  constructor(chapter, index) {
    this.ch = chapter;
    this.index = index;
    const built = createEldarRig(chapter.eldarMats, { scrap: true, scale: 0.95 });
    this.root = built.root;
    this.rig = built.rig;
    this.glow = built.glow;
    this.mesh = this.root; // (the player collides with .mesh / .radius)
    this.radius = 0.36;
    chapter.scene.add(this.root);
    // The visor's cone (no real light: one per unit would cost every shader a light each).
    this.cone = new THREE.Mesh(chapter.beamGeometry, chapter.scrapBeamMat);
    const len = SCRAPPER.sight / V.beamLength;
    const wide = (Math.tan(SCRAPPER.halfAngle) * SCRAPPER.sight) / (Math.tan(V.beamHalfAngle) * V.beamLength);
    this.cone.scale.set(wide, wide * 0.55, len);
    this.cone.position.set(0, 0.17, 0.1);
    this.cone.rotation.x = 0.16;
    this.cone.frustumCulled = false;
    this.rig.neck.add(this.cone);
    this.mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: chapter.questionTex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    this.mark.renderOrder = 999;
    this.mark.visible = false;
    chapter.scene.add(this.mark);
    this.anim = { speed: 0, aim: 0, crouch: 0, air: 0, kneel: 0, reach: 0, flinch: 0, roar: 0 };
    this.state = 'idle'; // idle | roam | sniff | alert | chase | search | investigate
    this.thinking = false;
    this.yaw = 0;
    this.t = Math.random() * 10;
    this.timer = 0;
    this.burstT = rand(1.5, 4);
    this.burstFor = 0;
    this.sniffT = 0;
    this.scan = 0;
    this.lostT = 0;
    this.sightT = 0;
    this.hasSight = false;
    this.moveSpeed = 0;
    this.path = null;
    this.goal = new THREE.Vector3();
    this.lastSeen = new THREE.Vector3();
    this.markKind = null;
    this.servoT = rand(1, 3);
    this.wobble = Math.random() * 6;
    this._eye = new THREE.Vector3();
  }

  get position() {
    return this.root.position;
  }

  place(x, z, yaw = 0) {
    this.root.position.set(x, 0, z);
    this.yaw = yaw;
    this.state = 'idle';
    this.path = null;
    this.lostT = 0;
    this.timer = 0;
    this.hasSight = false; // (a stale "I can see you" would send it straight back at your respawn)
    this.sightT = 0.3;
    this.markKind = null;
    this.mark.visible = false;
  }

  /** Off on its rounds. */
  wake() {
    this.thinking = true;
    this._pickRoam();
  }

  freeze() {
    this.thinking = false;
    this.state = 'idle';
    this.moveSpeed = 0;
  }

  /** A noise (a thrown rock landing, a clue grabbed, a cabinet door): it whips round and goes to look. */
  hearNoise(pos) {
    if (!this.thinking || this.state === 'chase' || this.state === 'alert') return false;
    this.goal.set(pos.x, 0, pos.z);
    this.path = null;
    this.state = 'investigate';
    this.timer = 0;
    this.burstFor = 0;
    this._faceToward(pos, 1, 30); // (snaps its head round at the sound)
    return true;
  }

  _pickRoam() {
    // Half the time it goes somewhere random; otherwise it drifts toward wherever you are (a search that isn't psychic).
    const pp = this.ch.player.object.position;
    let x;
    let z;
    for (let tries = 0; tries < 12; tries++) {
      if (Math.random() < 0.45) {
        const a = Math.random() * Math.PI * 2;
        const r = rand(10, 26);
        x = pp.x + Math.cos(a) * r;
        z = pp.z + Math.sin(a) * r;
      } else {
        x = this.root.position.x + rand(-22, 22);
        z = this.root.position.z + rand(-22, 22);
      }
      x = THREE.MathUtils.clamp(x, BOUNDS.minX + 2, BOUNDS.maxX - 2);
      z = THREE.MathUtils.clamp(z, BOUNDS.minZ + 2, BOUNDS.northEast - 2.5);
      if (this.ch.nav.isFree(x, z)) break;
    }
    this.goal.set(x, 0, z);
    this.path = null;
    this.state = 'roam';
  }

  _range() {
    const p = this.ch.player;
    let m = 1;
    if (p.flashlightOn) m *= 1.7; // your light is a beacon
    if (p.isCrouching) m *= p.isMoving ? 0.7 : 0.5;
    else if (p.isSprinting) m *= 1.3;
    return SCRAPPER.sight * m * difficulty.sightMult;
  }

  _hearRadius() {
    const p = this.ch.player;
    let r;
    if (!p.isMoving) r = p.isCrouching ? 1 : 2.2;
    else if (p.isCrouching) r = 3.5;
    else if (p.isSprinting) r = 15;
    else r = 8;
    return r * difficulty.sightMult;
  }

  eye() {
    this.rig.neck.getWorldPosition(this._eye);
    this._eye.y += 0.17;
    return this._eye;
  }

  update(dt) {
    this.t += dt;
    const ch = this.ch;
    const pos = this.root.position;
    const pp = ch.player.object.position;
    const dist = Math.hypot(pp.x - pos.x, pp.z - pos.z);
    this.moveSpeed = 0;
    let scanAmp = 0.6;
    const hunting = this.thinking && !ch.cutscene;

    if (hunting) {
      // Senses.
      const canSense = this.state !== 'alert';
      if (canSense && !ch.playerHidden) {
        const facing = this.yaw + this.scan;
        const cosA = dist > 1e-4 ? ((pp.x - pos.x) * Math.sin(facing) + (pp.z - pos.z) * Math.cos(facing)) / dist : 1;
        const range = this._range();
        this.sightT -= dt;
        if (this.sightT <= 0) {
          this.sightT = 0.12;
          this.hasSight = dist < range && cosA > Math.cos(SCRAPPER.halfAngle) && ch.nav.lineClear(pos.x, pos.z, pp.x, pp.z);
        }
        if (this.hasSight && this.state !== 'chase') this._alert();
        else if (this.hasSight) this.lostT = 0;
        if (!this.hasSight && dist < this._hearRadius() && (this.state === 'roam' || this.state === 'sniff') && ch.nav.lineClear(pos.x, pos.z, pp.x, pp.z)) {
          this.goal.set(pp.x, 0, pp.z);
          this.path = null;
          this.state = 'investigate';
          this.timer = 0;
        }
      } else {
        this.hasSight = false;
      }
      if (dist < SCRAPPER.catchRadius && this.state !== 'idle' && !ch.playerHidden) ch._capture(this);
    }

    switch (this.state) {
      case 'roam': {
        this.burstT -= dt;
        if (this.burstT <= 0) {
          // A twitch: a burst of speed, sometimes the other way entirely.
          this.burstFor = rand(0.7, 1.5);
          this.burstT = rand(2, 5);
          if (Math.random() < 0.35) this._pickRoam();
        }
        this.burstFor = Math.max(0, this.burstFor - dt);
        const speed = this.burstFor > 0 ? SCRAPPER.burst : SCRAPPER.patrol;
        if (this._travel(this.goal, speed, dt)) {
          this.state = 'sniff';
          this.sniffT = rand(0.7, 1.6);
        }
        break;
      }
      case 'sniff':
        scanAmp = 1.9; // the head whips side to side
        this.sniffT -= dt;
        if (this.sniffT <= 0) this._pickRoam();
        break;
      case 'investigate':
        if (this._travel(this.goal, SCRAPPER.investigate, dt)) {
          this.state = 'sniff';
          this.sniffT = rand(1.2, 2.2);
        }
        break;
      case 'alert':
        this._faceToward(pp, dt, 14);
        scanAmp = 0;
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'chase';
          this.lostT = 0;
          this.path = null;
        }
        break;
      case 'chase': {
        this.lastSeen.set(pp.x, 0, pp.z);
        this.lostT += this.hasSight ? -this.lostT : dt;
        this.timer -= dt;
        if (this.timer <= 0 || !this.path) {
          this.timer = 0.3;
          this.path = ch.nav.path(pos, pp) || [new THREE.Vector3(pp.x, 0, pp.z)];
        }
        if (this.path.length && this._step(this.path[0], SCRAPPER.chase * difficulty.chaseMult, dt)) this.path.shift();
        scanAmp = 0;
        if (this.lostT > SCRAPPER.loseSight || ch.playerHidden) {
          this.goal.copy(this.lastSeen);
          this.path = null;
          this.state = 'search';
          this.timer = 0;
        }
        break;
      }
      case 'search':
        if (this.timer <= 0 && this._travel(this.goal, SCRAPPER.burst, dt)) {
          this.timer = 2.6; // sweeping around where it lost you
        } else if (this.timer > 0) {
          this.timer -= dt;
          scanAmp = 2.2;
          this.yaw += dt * 3.2;
          if (this.timer <= 0) this._pickRoam();
        }
        break;
      default:
        break;
    }

    // Head, visor, pose.
    this.scan += (Math.sin(this.t * (this.state === 'sniff' ? 5.5 : 1.7) + this.wobble) * scanAmp - this.scan) * Math.min(1, dt * 8);
    const hot = this.state === 'alert' || this.state === 'chase';
    const pulse = hot ? 0.75 + 0.25 * Math.sin(this.t * 22) : 0.85 + 0.15 * Math.sin(this.t * 5);
    this.glow.color.copy(hot ? SCRAP_GLOW_HOT : SCRAP_GLOW_CALM).multiplyScalar(pulse);
    this.anim.speed = this.moveSpeed;
    this.anim.aim += ((hot ? 0.4 : 0) - this.anim.aim) * Math.min(1, dt * 5);
    this.anim.reach += ((this.state === 'chase' ? 0.6 : 0) - this.anim.reach) * Math.min(1, dt * 8);
    animateEldar(this.rig, dt, this.anim);
    this.rig.neck.rotation.y = this.scan;
    this.root.rotation.y = this.yaw;
    this._updateMark(dt);

    this.servoT -= dt;
    if (this.servoT <= 0) {
      this.servoT = rand(0.9, 2);
      if (dist < 14) playServo(1 - dist / 14);
    }
  }

  _alert() {
    this.state = 'alert';
    this.timer = 0.35;
    playRobotCharge(1.4);
    this.ch.onScrapperAlert(this);
  }

  /** Walk to `target` around the cover; true on arrival. */
  _travel(target, speed, dt) {
    if (!this.path) this.path = this.ch.nav.path(this.root.position, target) || [target.clone()];
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

  _step(target, speed, dt) {
    const pos = this.root.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.35) return true;
    const step = Math.min(d, speed * dt);
    // A twitchy sideways shimmy on the way (erratic, never quite a straight line).
    const jitter = this.state === 'chase' ? 0 : Math.sin(this.t * 7 + this.wobble) * 0.35;
    pos.x += (dx / d) * step + (-dz / d) * jitter * dt;
    pos.z += (dz / d) * step + (dx / d) * jitter * dt;
    this.moveSpeed = speed;
    this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), Math.min(1, dt * (this.state === 'chase' ? 12 : 9)));
    this.ch.pushOut(pos, this.radius);
    return false;
  }

  _faceToward(p, dt, rate) {
    const pos = this.root.position;
    this.yaw = dampAngle(this.yaw, Math.atan2(p.x - pos.x, p.z - pos.z), 1 - Math.exp(-dt * rate));
  }

  _updateMark(dt) {
    let kind = null;
    if (this.state === 'chase' || this.state === 'alert') kind = '!';
    else if (this.state === 'investigate' || this.state === 'search') kind = '?';
    if (kind !== this.markKind) {
      this.markKind = kind;
      if (kind) {
        this.mark.material.map = kind === '!' ? this.ch.alertTex : this.ch.questionTex;
        this.mark.material.needsUpdate = true;
      }
    }
    this.mark.visible = kind !== null;
    if (!this.mark.visible) return;
    const p = this.root.position;
    this.mark.scale.set(0.6, 0.6, 1);
    this.mark.position.set(p.x, 2.3 + Math.sin(this.t * 6) * 0.05, p.z);
  }
}

// ---------------------------------------------------------------------------
// Sliding parts (blast door, shutters, pod doors) and lasers
// ---------------------------------------------------------------------------

/** A part that slides along one axis: value 0 (as built) .. 1 (moved by `distance`). */
class Slide {
  constructor(group, axis, distance) {
    this.group = group;
    this.axis = axis;
    this.base = group.position[axis];
    this.distance = distance;
    this.value = 0;
    this.anim = null;
  }

  set(v) {
    if (this.anim) this.anim.resolve();
    this.anim = null;
    this.value = v;
    this._apply();
  }

  /** Slide to `to` over `seconds` (ease: 'in' = accelerating like a drop, 'out', or smooth). Resolves when done. */
  move(to, seconds, ease = 'smooth') {
    if (this.anim) this.anim.resolve();
    return new Promise((resolve) => {
      this.anim = { from: this.value, to, t: 0, seconds: Math.max(0.001, seconds), ease, resolve };
    });
  }

  update(dt) {
    const a = this.anim;
    if (!a) return;
    a.t += dt;
    let k = Math.min(1, a.t / a.seconds);
    k = a.ease === 'in' ? k * k : a.ease === 'out' ? 1 - (1 - k) * (1 - k) : k * k * (3 - 2 * k);
    this.value = a.from + (a.to - a.from) * k;
    this._apply();
    if (a.t >= a.seconds) {
      this.anim = null;
      a.resolve();
    }
  }

  _apply() {
    this.group.position[this.axis] = this.base + this.value * this.distance;
  }
}

/**
 * Red laser beams (single lines, or a curtain of lines): some powered by a node (`group`), some pulsing
 * on and off. Touching a live one zaps you (onZap), then it lets you go for a beat.
 */
class Beams {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.time = 0;
    this.cooldown = 0;
    this.power = {};
    this.onZap = null;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5); // grows along +Z: aim with lookAt, stretch with scale.z
    this.geo = geo;
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xff3a2a, fog: false });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  }

  /** a, b: [x, z] ends; y: the beam's height (or y..y1: a curtain); group: the node that powers it; pulse: { on, off, offset }. */
  add({ a, b, y, y1 = null, group = 'static', pulse = null, thick = 0.03 }) {
    const heights = [];
    if (y1 === null) heights.push(y);
    else for (let h = y; h <= y1 + 1e-6; h += 0.28) heights.push(h);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lines = [];
    for (const h of heights) {
      for (const glowing of [false, true]) {
        const m = new THREE.Mesh(this.geo, glowing ? this.glowMat : this.coreMat);
        m.position.set(a[0], h, a[1]);
        m.lookAt(b[0], h, b[1]);
        if (glowing) m.translateZ(-0.02); // (a touch longer than its core at both ends: their end caps never share a plane)
        m.scale.set(glowing ? thick * 5 : thick, glowing ? thick * 5 : thick, glowing ? len + 0.04 : len);
        m.frustumCulled = false;
        this.scene.add(m);
        lines.push(m);
      }
    }
    const beam = { a, b, y0: y, y1: y1 === null ? y + 0.05 : y1, group, pulse, lines, active: true };
    this.list.push(beam);
    return beam;
  }

  setPower(group, on) {
    this.power[group] = on;
  }

  isPowered(group) {
    return this.power[group] !== false;
  }

  /** Any live beam left in `group`? */
  anyLive(group) {
    return this.list.some((b) => b.group === group) && this.isPowered(group);
  }

  update(dt, player, gameplay) {
    this.time += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    for (const beam of this.list) {
      let active = this.isPowered(beam.group);
      let warn = false;
      if (active && beam.pulse) {
        const cycle = beam.pulse.on + beam.pulse.off;
        const ph = (this.time + (beam.pulse.offset || 0)) % cycle;
        active = ph < beam.pulse.on;
        warn = !active && ph > cycle - 0.3; // flickers just before it comes back
      }
      beam.active = active;
      const show = active || (warn && Math.floor(this.time * 24) % 2 === 0);
      for (const m of beam.lines) if (m.visible !== show) m.visible = show;
      if (!active || !gameplay || this.cooldown > 0) continue;
      const p = player.object.position;
      const d = segDist2D(p.x, p.z, beam.a[0], beam.a[1], beam.b[0], beam.b[1]);
      if (d < 0.38 && player.bodyTop > beam.y0 - 0.02 && beam.y1 + 0.03 > 0.05) {
        this.cooldown = 0.9;
        if (this.onZap) this.onZap(beam);
      }
    }
  }
}

/** A laser power node: a pedestal with a glowing core. Hold [E] on it to shut it down. */
function makeNode(scene, colliders, x, z, index) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  scene.add(group);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1f252b, metalness: 0.7, roughness: 0.45 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x66717a, metalness: 0.85, roughness: 0.35 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.9, 12), dark);
  base.position.y = 0.45;
  group.add(base);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 8, 20), steel);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.95;
  group.add(ring);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x3ad8ff, fog: false });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), coreMat);
  core.position.y = 1.35;
  group.add(core);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture('rgba(90,220,255,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
  );
  glow.scale.set(2.2, 2.2, 1);
  glow.position.y = 1.35;
  group.add(glow);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.18),
    new THREE.MeshBasicMaterial({ map: signTexture([`POWER NODE ${'ABC'[index]}`], { bg: '#0d1a20', fg: '#7fe8ff', border: '#3ad8ff', w: 256, h: 64 }) }),
  );
  label.position.set(0, 0.62, 0.61);
  group.add(label);
  const hitbox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.9, 1.2), new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.position.set(x, 0.95, z);
  hitbox.userData = { interactable: true, label: 'Disable the power node (hold [E])', type: 'sc-node', index };
  scene.add(hitbox);
  const solid = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.9), new THREE.MeshBasicMaterial({ visible: false }));
  solid.position.set(x, 0.5, z);
  solid.updateMatrixWorld(true);
  colliders.push(solid);
  return {
    group,
    hitbox,
    index,
    off: false,
    position: new THREE.Vector3(x, 0, z),
    setOff() {
      this.off = true;
      coreMat.color.setHex(0x2a2f33);
      glow.visible = false;
      hitbox.userData.label = 'Power node (offline)';
    },
    reset() {
      this.off = false;
      coreMat.color.setHex(0x3ad8ff);
      glow.visible = true;
      hitbox.userData.label = 'Disable the power node (hold [E])';
    },
    pulse(t) {
      if (!this.off) glow.scale.setScalar(2.0 + Math.sin(t * 5 + index) * 0.25);
    },
  };
}

// ---------------------------------------------------------------------------
// Node B's lock: a fresh puzzle every playthrough (three kinds of equal difficulty, four random colours)
// ---------------------------------------------------------------------------

const PUZZLE_PALETTE = [
  { name: 'RED', hex: 0xe0413a, css: '#ff5a4f', letter: 'R' },
  { name: 'BLUE', hex: 0x3a7be0, css: '#5a9bff', letter: 'B' },
  { name: 'GREEN', hex: 0x3fc860, css: '#4fe27a', letter: 'G' },
  { name: 'YELLOW', hex: 0xf0c93a, css: '#ffdc4a', letter: 'Y' },
  { name: 'PURPLE', hex: 0xa25be0, css: '#c08cff', letter: 'P' },
  { name: 'ORANGE', hex: 0xf08a3a, css: '#ffa45a', letter: 'O' },
];

const shuffled = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const PERMS4 = (() => {
  const out = [];
  const go = (cur, rest) => {
    if (!rest.length) out.push(cur);
    rest.forEach((v, i) => go([...cur, v], rest.filter((_, k) => k !== i)));
  };
  go([], [0, 1, 2, 3]);
  return out;
})();

/**
 * Roll a puzzle: { kind, colors (palette entry per button 0..3: top-left, top-right, bottom-left, bottom-right),
 * order (button indices to press, in order), draw(g, w, h) paints the Coach's sheet }.
 */
function rollPuzzle() {
  const colors = shuffled(PUZZLE_PALETTE).slice(0, 4);
  const kind = Math.floor(Math.random() * 3);
  const order = shuffled([0, 1, 2, 3]);
  const W = '#f1ecd0';
  const header = (g, w, sub) => {
    g.fillStyle = '#10201a';
    g.fillRect(0, 0, w, 448);
    g.strokeStyle = '#d8d2b0';
    g.lineWidth = 8;
    g.strokeRect(6, 6, w - 12, 436);
    g.textBaseline = 'middle';
    g.fillStyle = W;
    g.font = 'bold 42px "Courier New", monospace';
    g.fillText("COACH'S PLAYBOOK", 36, 52);
    g.font = '24px "Courier New", monospace';
    g.fillStyle = '#cfd3c0';
    g.fillText(sub, 36, 100);
  };
  const line = (g, y, parts, size = 28) => {
    let x = 36;
    g.font = `bold ${size}px "Courier New", monospace`;
    for (const [text, color] of parts) {
      g.fillStyle = color;
      g.fillText(text, x, y);
      x += g.measureText(text).width;
    }
  };
  const nm = (b) => [colors[b].name, colors[b].css];
  const pos = (b) => order.indexOf(b);
  let draw;
  if (kind === 0) {
    // Logic clues about the running order, added until exactly one order fits.
    const pool = [];
    for (let x = 0; x < 4; x++) {
      if (pos(x) !== 0) pool.push({ ok: (o) => o.indexOf(x) !== 0, t: [nm(x), [' never runs first.', W]] });
      if (pos(x) !== 3) pool.push({ ok: (o) => o.indexOf(x) !== 3, t: [nm(x), [' never runs last.', W]] });
      for (let y = 0; y < 4; y++) {
        if (x === y) continue;
        if (pos(x) < pos(y)) pool.push({ ok: (o) => o.indexOf(x) < o.indexOf(y), t: [nm(x), [' runs before ', W], nm(y), ['.', W]] });
        if (pos(y) - pos(x) === 1) pool.push({ ok: (o) => o.indexOf(y) - o.indexOf(x) === 1, t: [nm(x), [' goes directly before ', W], nm(y), ['.', W]] });
      }
    }
    let clues = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      clues = [];
      let left = PERMS4.slice();
      for (const cl of shuffled(pool)) {
        const next = left.filter(cl.ok);
        if (next.length < left.length) {
          clues.push(cl);
          left = next;
        }
        if (left.length === 1) break;
      }
      if (left.length === 1 && clues.length >= 4 && clues.length <= 5) break;
    }
    draw = (g, w) => {
      header(g, w, 'Run all four drills, in ORDER:');
      clues.forEach((cl, i) => line(g, 150 + i * 50, [[`${i + 1}) `, W], ...cl.t], clues.length > 4 ? 25 : 27));
    };
  } else if (kind === 1) {
    // Jersey numbers: the run order is given as sums and products; the roster says who wears what.
    const nums = shuffled([...Array(17).keys()].map((n) => n + 3)).slice(0, 4);
    const expr = (v) => {
      const facs = [];
      for (let a = 2; a <= 9; a++) if (v % a === 0 && v / a >= 2) facs.push(a);
      const r = Math.random();
      if (r < 0.3 && facs.length) {
        const a = facs[Math.floor(Math.random() * facs.length)];
        return `${a} x ${v / a}`;
      }
      if (r < 0.65) {
        const a = 1 + Math.floor(Math.random() * (v - 1));
        return `${a} + ${v - a}`;
      }
      const b = 2 + Math.floor(Math.random() * 12);
      return `${v + b} - ${b}`;
    };
    const exprs = order.map((b) => expr(nums[b]));
    draw = (g, w) => {
      header(g, w, 'The drills run in the order of these jersey sums:');
      line(g, 150, [[order.map((_, i) => exprs[i]).join('   ,   '), W]], 25);
      g.fillStyle = '#cfd3c0';
      g.font = '24px "Courier New", monospace';
      g.fillText('Who wears what:', 36, 214);
      [0, 1, 2, 3].forEach((b) => line(g, 262 + b * 40, [[colors[b].name.padEnd(7, ' '), colors[b].css], [` #${nums[b]}`, W]], 28));
    };
  } else {
    // A route across the 2x2 panel: where to start, and how each step moves.
    const cell = (b) => [Math.floor(b / 2), b % 2]; // row, col (top-left is button 0)
    const steps = [];
    for (let i = 1; i < 4; i++) {
      const [r0, c0] = cell(order[i - 1]);
      const [r1, c1] = cell(order[i]);
      steps.push(r0 === r1 ? 'one ACROSS' : c0 === c1 ? (r1 < r0 ? 'one UP' : 'one DOWN') : 'cut DIAGONALLY');
    }
    draw = (g, w) => {
      header(g, w, 'Run the route on the panel, as you face it:');
      line(g, 160, [['Start on ', W], nm(order[0]), ['.', W]]);
      steps.forEach((s, i) => line(g, 220 + i * 50, [[`Then ${s}.`, W]]));
      g.fillStyle = '#cfd3c0';
      g.font = '22px "Courier New", monospace';
      g.fillText('(Every button is visited exactly once.)', 36, 400);
    };
  }
  return { kind, colors, order, draw };
}
// ---------------------------------------------------------------------------
// Underground: the stairwell, the control gallery, the incinerator hall, the practice hall
// ---------------------------------------------------------------------------

function buildUnderground() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020304);
  scene.fog = new THREE.FogExp2(0x050607, 0.014);
  const colliders = [];
  const updatables = [];
  const B = makeBuilder(scene, colliders);
  const T = 0.4;

  const M = {
    wall: new THREE.MeshStandardMaterial({ map: concreteTexture('#5f666b'), roughness: 0.95 }),
    floor: new THREE.MeshStandardMaterial({ map: gratingTexture(), roughness: 0.65, metalness: 0.35 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0x25292d, roughness: 1 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x7f8990, roughness: 0.4, metalness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.6, metalness: 0.5 }),
    rust: new THREE.MeshStandardMaterial({ color: 0x6b3d24, roughness: 0.85, metalness: 0.4 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x8a5a2c, roughness: 0.5, metalness: 0.6 }),
    boiler: new THREE.MeshStandardMaterial({ color: 0x505a61, roughness: 0.55, metalness: 0.7 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.6, metalness: 0.3 }),
    crate: new THREE.MeshStandardMaterial({ color: 0x6d5a3e, roughness: 0.9 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x7a1f2b, roughness: 0.85 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x8fb6c8, transparent: true, opacity: 0.2, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide }),
    red: new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false }),
    amber: new THREE.MeshBasicMaterial({ color: 0xffa030, fog: false }),
    dim: new THREE.MeshBasicMaterial({ color: 0x1a0505, fog: false }),
  };
  M.simFloor = new THREE.MeshStandardMaterial({ map: (() => {
    // The practice hall: painted running lanes and a big paw.
    const c = makeCanvas(512);
    const g = c.getContext('2d');
    g.fillStyle = '#4b5258';
    g.fillRect(0, 0, 512, 512);
    grime(g, 512, 2600);
    g.strokeStyle = 'rgba(232,200,70,0.7)';
    g.lineWidth = 5;
    for (let i = 1; i < 6; i++) {
      g.beginPath();
      g.moveTo(0, i * 85);
      g.lineTo(512, i * 85);
      g.stroke();
    }
    g.strokeStyle = 'rgba(245,242,230,0.55)';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(256, 256, 60, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(122,31,43,0.6)';
    g.beginPath();
    g.ellipse(256, 262, 26, 22, 0, 0, Math.PI * 2);
    g.fill();
    return tex(c);
  })(), roughness: 0.75, metalness: 0.15 });

  const wall = (x0, x1, z0, z1, y0, y1, material = M.wall) =>
    B.box({ w: x1 - x0, h: y1 - y0, d: z1 - z0, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, material, tile: 3 });
  const plane = (x0, x1, z0, z1, y, material, down = false, tile = 2.5) => {
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (x1 - x0)) / tile, (uv.getY(i) * (z1 - z0)) / tile);
    return B.shape(geo, material, (x0 + x1) / 2, y, (z0 + z1) / 2, down ? Math.PI / 2 : -Math.PI / 2);
  };
  const light = (color, intensity, dist, x, y, z, decay = 1.6) => {
    const l = new THREE.PointLight(color, intensity, dist, decay);
    l.position.set(x, y, z);
    scene.add(l);
    return l;
  };
  const put = (geo, material, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    scene.add(m);
    return m;
  };
  const hidden = B.hidden;

  scene.add(new THREE.AmbientLight(0x35405a, 1.0));
  scene.add(new THREE.HemisphereLight(0x4a5668, 0x14161a, 0.65));

  // ==== The stairwell (south of the gallery): steps down from the hatch =====================
  plane(-1.4, 1.4, 26, 41.6, 0, M.floor);
  plane(-1.4, 1.4, 26, 41.6, 7.6, M.ceiling, true);
  // (The side walls start behind the gallery's south wall, not inside it: their faces used to share
  // its plane at z = 26 and z-fought on either side of the stair door.)
  wall(-1.8, -1.4, 26.4, 41.8, 0, 7.6);
  wall(1.4, 1.8, 26.4, 41.8, 0, 7.6);
  wall(-1.8, 1.8, 41.6, 42, 0, 7.6);
  for (let i = 0; i < 10; i++) {
    const top = 0.3 * (i + 1);
    B.box({ w: 2.8, h: top, d: 1.2, x: 0, y: top / 2, z: 27.6 + i * 1.2 + 0.6, material: M.dark, collider: false });
  }
  B.box({ w: 2.8, h: 3.0, d: 1.8, x: 0, y: 1.5, z: 40.7, material: M.dark, collider: false }); // the landing
  put(new THREE.PlaneGeometry(2.4, 1.6), new THREE.MeshBasicMaterial({ color: 0x1a2634, fog: false }), 0, 7.55, 40.8, Math.PI / 2, 0, 0); // the hatch above: rain-grey sky
  light(0x6f8fb8, 5, 9, 0, 6.5, 40.4, 1.6);
  // The door at the foot of the stairs (it locks behind you).
  const stairDoorGroup = new THREE.Group();
  stairDoorGroup.position.set(0, 0, 26.2);
  scene.add(stairDoorGroup);
  const stairLeaf = new THREE.Mesh(new THREE.BoxGeometry(2.86, 2.92, 0.16), M.steel);
  stairLeaf.position.set(0, 1.45, 0);
  stairDoorGroup.add(stairLeaf);
  const stairDoor = new Slide(stairDoorGroup, 'y', 3.1);
  updatables.push(stairDoor);
  const stairCollider = new THREE.Mesh(new THREE.BoxGeometry(2.9, 2.9, 0.4), hidden);
  stairCollider.position.set(0, 1.45, 26.2);
  stairCollider.updateMatrixWorld(true);
  wall(-1.4, 1.4, 26, 26.4, 2.9, 7.6);

  // ==== The control gallery ==================================================================
  const G = UG.gallery;
  plane(G.minX, G.maxX, G.minZ, G.maxZ, 0, M.floor);
  plane(G.minX, G.maxX, G.minZ, G.maxZ, G.h, M.ceiling, true);
  // (From z = 14: the hall's south wall already fills 13.6..14, and sharing its face there z-fought.)
  wall(G.minX - T, G.minX, 14, 26.4, 0, G.h);
  wall(G.maxX, G.maxX + T, 14, 26.4, 0, G.h);
  wall(G.minX - T, -1.4, 26, 26.4, 0, G.h);
  wall(1.4, G.maxX + T, 26, 26.4, 0, G.h);
  // The blast door: a slab in the doorway that drops out of its housing (its header hides it while it's up).
  const D = UG.doorHalf;
  wall(-14.4, -D, 13.6, 14, 0, UG.hall.h);
  wall(D, 14.4, 13.6, 14, 0, UG.hall.h);
  wall(-D, D, 13.6, 14, UG.doorH, UG.hall.h);
  const blastGroup = new THREE.Group();
  blastGroup.position.set(0, UG.doorH, 13.8); // raised into the header
  scene.add(blastGroup);
  const slab = (w, h, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.3), M.steel); // (thinner than the header it hides in: no coplanar faces)
    m.position.set(0, y, 0);
    m.castShadow = false;
    blastGroup.add(m);
    return m;
  };
  slab(D * 2 + 0.06, 1.2, 0.6);
  slab(D * 2 + 0.06, 2.5, 3.15);
  const band = new THREE.Mesh(new THREE.BoxGeometry(D * 2 + 0.06, 0.28, 0.32), M.hazard);
  band.position.set(0, 0.14, 0);
  blastGroup.add(band);
  const slit = new THREE.Mesh(new THREE.PlaneGeometry(D * 2 - 0.1, 0.7), M.glass);
  slit.position.set(0, 1.55, 0);
  slit.renderOrder = 2;
  blastGroup.add(slit);
  for (let i = -3; i <= 3; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), M.dark);
    bar.position.set(i * 1.1, 1.55, 0.05);
    blastGroup.add(bar);
  }
  const doorScreen = makeScreen(384, 96);
  const doorDisplay = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: doorScreen.texture, fog: false }));
  doorDisplay.position.set(0, 3.5, 0.32); // (well clear of the header's face at z = 14, so it can't sink into the wall)
  doorDisplay.material.polygonOffset = true;
  doorDisplay.material.polygonOffsetFactor = -2;
  doorDisplay.material.polygonOffsetUnits = -2;
  blastGroup.add(doorDisplay);
  const blast = new Slide(blastGroup, 'y', -UG.doorH); // value 0 = raised, 1 = shut
  updatables.push(blast);
  // Raised, the slab lives inside the header wall: hide it (only the wall display stays) so no edge can poke through.
  // The display rides the door down onto the slab, but on the way up it stops on the header, under the gallery
  // ceiling (y = 7): it used to ride all the way up with the door and slide through the ceiling.
  const DISPLAY_PARK_Y = 6.25; // (world height of its center while the door's up: top edge at 6.7)
  updatables.push({
    update: () => {
      const up = blast.value < 0.02;
      for (const ch of blastGroup.children) if (ch !== doorDisplay) ch.visible = !up;
      doorDisplay.position.y = Math.min(3.5, DISPLAY_PARK_Y - blastGroup.position.y);
    },
  });
  const blastCollider = new THREE.Mesh(new THREE.BoxGeometry(D * 2, UG.doorH, 0.5), hidden);
  blastCollider.position.set(0, UG.doorH / 2, 13.8);
  blastCollider.updateMatrixWorld(true);
  const drawTimer = (text, color = '#ff3a2a', title = 'INCINERATION') => {
    doorScreen.draw((g, w, h) => {
      g.fillStyle = '#080204';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = color;
      g.lineWidth = 4;
      g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = color;
      g.textAlign = 'center';
      g.font = 'bold 20px "Courier New", monospace';
      g.fillText(title, w / 2, 26);
      g.font = 'bold 54px "Courier New", monospace';
      g.fillText(text, w / 2, 80);
    });
  };
  drawTimer('--:--', '#5a1a14', 'STANDBY');

  // Gallery dressing: the control desk (west), the gear cage with your rifle (east), alarm light, sign.
  B.box({ w: 1.1, h: 1.0, d: 5.2, x: -5.3, y: 0.5, z: 19.8, material: M.dark });
  [0, 1, 2].forEach((i) => {
    const s = makeScreen(256, 160);
    s.draw((g, w, h) => {
      g.fillStyle = '#06140f';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#3cff7a';
      g.font = 'bold 14px "Courier New", monospace';
      g.fillText(['ELDAR UNIT ROSTER', 'FURNACE LINE 2', 'PLANT PRESSURE'][i], 10, 22);
      g.strokeStyle = '#3cff7a';
      for (let k = 0; k < 6; k++) g.strokeRect(10, 34 + k * 20, 40 + Math.random() * 180, 10);
    });
    // A real monitor: bezel, neck and foot on the desk, the screen set into its face.
    const mz = 17.7 + i * 1.7;
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.76, 1.1), M.dark);
    bezel.position.set(-5.1, 1.5, mz);
    scene.add(bezel);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.16), M.dark);
    neck.position.set(-5.1, 1.1, mz);
    scene.add(neck);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.4), M.dark);
    foot.position.set(-5.1, 1.015, mz);
    scene.add(foot);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.62), new THREE.MeshBasicMaterial({ map: s.texture, fog: false }));
    m.position.set(-5.038, 1.5, mz); // (a clear centimeter proud of the bezel: at 2mm it z-fought from across the room)
    m.rotation.y = Math.PI / 2;
    scene.add(m);
    const keys = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.8), M.steel);
    keys.position.set(-4.9, 1.022, mz); // (its top just above the monitor foot's: level, they z-fought)
    scene.add(keys);
  });
  // The armory (east wall): a barred cage lit by its own lamp, a rack of dead rifles, ammo crates, and the workbench
  // where Other Ben left your rifle on a display cradle.
  const cageX = 5.0;
  const rail = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.5, metalness: 0.6 }); // safety-yellow frame
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2f34, roughness: 0.8, metalness: 0.4 });
  const green = new THREE.MeshStandardMaterial({ color: 0x3d4a2c, roughness: 0.8, metalness: 0.2 });
  // (Sized so no two pieces share a face: the back panel sits between the end frames, the roof frame
  // overhangs them slightly, and the floor rail stops inside them.)
  for (const z of [21.5, 24.5]) B.box({ w: 1.7, h: 2.7, d: 0.1, x: cageX, y: 1.35, z, material: rail, collider: false }); // end posts (frames)
  B.box({ w: 0.1, h: 2.64, d: 2.9, x: cageX + 0.85, y: 1.32, z: 23, material: wallMat, collider: false }); // back
  B.box({ w: 1.84, h: 0.1, d: 3.14, x: cageX, y: 2.7, z: 23, material: rail, collider: false }); // roof frame
  B.box({ w: 0.08, h: 0.1, d: 2.9, x: cageX - 0.85, y: 0.05, z: 23, material: rail, collider: false });
  for (let i = 0; i <= 10; i++) {
    const bz = 21.55 + i * 0.29;
    if (bz > 22.05 && bz < 23.0) continue; // the doorway
    B.box({ w: 0.04, h: 2.6, d: 0.04, x: cageX - 0.85, y: 1.35, z: bz, material: M.steel, collider: false });
  }
  for (const [rz, len] of [[21.75, 0.5], [23.8, 1.4]]) for (const ry of [0.9, 2.0]) B.box({ w: 0.08, h: 0.08, d: len, x: cageX - 0.85, y: ry, z: rz, material: M.steel, collider: false });
  B.box({ w: 0.1, h: 2.7, d: 0.1, x: cageX - 0.85, y: 1.35, z: 22.0, material: rail, collider: false }); // the door posts
  B.box({ w: 0.1, h: 2.7, d: 0.1, x: cageX - 0.85, y: 1.35, z: 23.05, material: rail, collider: false });
  // A rack of old rifles on the back wall, and shelves of ammo.
  B.box({ w: 0.06, h: 0.9, d: 1.76, x: cageX + 0.78, y: 1.75, z: 22.45, material: M.dark, collider: false });
  const rackPoly = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.7, metalness: 0.3 });
  const rackMetal = new THREE.MeshStandardMaterial({ color: 0x4a5057, roughness: 0.4, metalness: 0.7 });
  for (let i = 0; i < 3; i++) {
    const old = createRifleMesh(rackPoly, rackMetal);
    old.rotation.set(0, 0, Math.PI / 2);
    old.scale.setScalar(0.7);
    old.position.set(cageX + 0.7, 1.75, 21.7 + i * 0.62);
    scene.add(old);
  }
  for (const y of [0.35, 0.95]) B.box({ w: 0.4, h: 0.06, d: 0.96, x: cageX + 0.62, y, z: 23.95, material: M.dark, collider: false });
  for (let k = 0; k < 4; k++) B.box({ w: 0.3, h: 0.22, d: 0.42, x: cageX + 0.62, y: 0.5 + (k % 2) * 0.6, z: 23.6 + Math.floor(k / 2) * 0.55, material: green, collider: false });
  // The workbench (solid) with the rifle's cradle, and a stack of crates beside it.
  B.box({ w: 1.15, h: 0.08, d: 2.0, x: cageX + 0.05, y: 0.9, z: 22.5, material: M.steel });
  for (const [dx, dz] of [[-0.5, -0.9], [0.5, -0.9], [-0.5, 0.9], [0.5, 0.9]]) B.box({ w: 0.08, h: 0.86, d: 0.08, x: cageX + 0.05 + dx, y: 0.43, z: 22.5 + dz, material: M.dark, collider: false });
  B.box({ w: 0.9, h: 0.06, d: 1.3, x: cageX + 0.05, y: 0.4, z: 22.5, material: M.dark, collider: false });
  for (const dz of [-0.55, 0.55]) B.box({ w: 0.24, h: 0.1, d: 0.1, x: cageX + 0.05, y: 0.98, z: 22.5 + dz, material: M.dark, collider: false }); // the cradle
  B.box({ w: 0.9, h: 0.5, d: 0.7, x: cageX + 0.3, y: 0.25, z: 24.0, material: green });
  B.box({ w: 0.8, h: 0.4, d: 0.6, x: cageX + 0.3, y: 0.7, z: 24.05, material: green, rotationY: 0.12 });
  const armoryLamp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 1.2), new THREE.MeshBasicMaterial({ color: 0xffe0a0, fog: false }));
  armoryLamp.position.set(cageX, 2.55, 22.5);
  scene.add(armoryLamp);
  light(0xffd28a, 12, 9, cageX - 0.3, 2.3, 22.6, 1.8);
  const armorySign = put(new THREE.PlaneGeometry(1.7, 0.42), new THREE.MeshBasicMaterial({ map: signTexture(['ARMORY', 'AUTHORIZED ONLY'], { w: 384, h: 96, bg: '#1a1608', fg: '#ffd76a', border: '#c9a227' }) }), cageX - 0.9, 3.05, 23);
  armorySign.rotation.y = -Math.PI / 2;  const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7, metalness: 0.15 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x353a3f, roughness: 0.35, metalness: 0.8 });
  const rifle = createRifleMesh(polymer, metal);
  rifle.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  rifle.scale.setScalar(1.25);
  rifle.position.set(cageX + 0.05, 1.02, 22.5);
  scene.add(rifle);
  const rifleGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture('rgba(255,210,90,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
  );
  rifleGlow.scale.set(1.6, 1.6, 1);
  rifleGlow.position.set(cageX + 0.05, 1.1, 22.5);
  scene.add(rifleGlow);
  const rifleHitbox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.4), hidden);
  rifleHitbox.position.set(cageX + 0.05, 1.0, 22.6);
  rifleHitbox.userData = { interactable: true, label: 'Take the assault rifle', type: 'sc-rifle' };
  scene.add(rifleHitbox);
  const sign = put(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: signTexture(['BOILER CONTROL', 'AUTHORIZED PERSONNEL ONLY'], { w: 512, h: 128 }) }), 0, 5.2, 25.94);
  sign.rotation.y = Math.PI;
  const alarmLight = light(0xff2a1a, 0, 16, 0, 6.2, 19, 1.6);
  const alarmLamp = put(new THREE.SphereGeometry(0.16, 10, 8), M.dim, 0, 6.6, 19);
  light(0xffc98a, 7, 16, 0, 6.3, 22, 1.7);

  // The overhead hydraulic pipe: the run that feeds the blast door and the furnace. Shoot the joint.
  const pipeY = 5.2;
  const pipeZ = 19;
  B.shape(new THREE.CylinderGeometry(0.34, 0.34, 12.4, 16), M.pipe, 0, pipeY, pipeZ, 0, 0, Math.PI / 2);
  B.shape(new THREE.CylinderGeometry(0.2, 0.2, 12.4, 12), M.pipe, 0, 5.75, pipeZ + 1.3, 0, 0, Math.PI / 2);
  B.shape(new THREE.CylinderGeometry(0.16, 0.16, 3.4, 10), M.pipe, 4.6, 5.9, pipeZ + 0.7, Math.PI / 2, 0, 0);
  const jointGroup = new THREE.Group();
  jointGroup.position.set(0, pipeY, pipeZ);
  scene.add(jointGroup);
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.42, 18), M.steel);
  flange.rotation.z = Math.PI / 2;
  jointGroup.add(flange);
  for (const s of [-0.26, 0.26]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.06, 8, 20), M.dark);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = s;
    jointGroup.add(ring);
  }
  const jointGlow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.05), new THREE.MeshBasicMaterial({ color: 0xffa030, fog: false }));
  jointGlow.position.set(0, -0.05, 0.5);
  jointGroup.add(jointGlow);
  const jointTag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3), new THREE.MeshBasicMaterial({ map: signTexture(['HYD. JOINT', 'SEAL WEAK: 2400 PSI'], { bg: '#241a08', fg: '#ffb13a', border: '#ffb13a', w: 256, h: 96 }) }));
  jointTag.position.set(0, -0.62, 0.42);
  jointGroup.add(jointTag);
  const jointGlowSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture('rgba(255,170,60,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
  );
  jointGlowSprite.scale.set(2.2, 2.2, 1);
  jointGlowSprite.position.set(0, -0.05, 0.6);
  jointGroup.add(jointGlowSprite);
  const jointHitbox = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), hidden);
  jointHitbox.position.set(0, pipeY, pipeZ);
  scene.add(jointHitbox);
  // A shootable target for the combat system (it takes `extraTargets`): three hits' worth of seal.
  const pipe = {
    alive: true,
    hp: 60,
    hitboxes: [jointHitbox],
    onBurst: null,
    takeHit(zone, damage) {
      if (!this.alive) return null;
      this.hp -= damage;
      if (this.hp <= 0) {
        this.alive = false;
        if (this.onBurst) this.onBurst();
        return 'kill';
      }
      return 'hit';
    },
  };
  jointHitbox.userData = { zone: 'joint', owner: pipe };

  // ==== The incinerator hall =====================================================================
  const H = UG.hall;
  // (Out to z = 14 under the blast door, and 10cm under the west and north walls to the pod recesses:
  // the door thresholds used to be holes onto the void. The furnace floor and the corridor floor meet
  // it edge to edge, never overlapping.)
  plane(H.minX - 0.1, H.maxX, H.minZ - 0.1, 14, 0, M.floor);
  plane(H.minX, H.maxX, H.minZ, 13.6, H.h, M.ceiling, true);
  // West wall (a doorway to the practice hall's corridor at z -1.2..1.2), east wall, north wall (the furnace mouth).
  // (with 1.3m openings for the four ELDAR pod doors: two in the west wall at z -9 and 9, two in the north wall at x -6 and 6)
  wall(H.minX - T, H.minX, -14.4, -9.65, 0, H.h);
  wall(H.minX - T, H.minX, -8.35, -1.2, 0, H.h);
  wall(H.minX - T, H.minX, -9.65, -8.35, 2.6, H.h);
  wall(H.minX - T, H.minX, 1.2, 8.35, 0, H.h);
  wall(H.minX - T, H.minX, 9.65, 14, 0, H.h);
  wall(H.minX - T, H.minX, 8.35, 9.65, 2.6, H.h);
  wall(H.minX - T, H.minX, -1.2, 1.2, 3.2, H.h);
  wall(H.maxX, H.maxX + T, -14.4, 14, 0, H.h);
  wall(-14.4, -6.65, H.minZ - T, H.minZ, 0, H.h);
  wall(-5.35, -2.7, H.minZ - T, H.minZ, 0, H.h);
  wall(-6.65, -5.35, H.minZ - T, H.minZ, 2.6, H.h);
  wall(2.7, 5.35, H.minZ - T, H.minZ, 0, H.h);
  wall(6.65, 14.4, H.minZ - T, H.minZ, 0, H.h);
  wall(5.35, 6.65, H.minZ - T, H.minZ, 2.6, H.h);
  wall(-2.7, 2.7, H.minZ - T, H.minZ, 3.5, H.h);
  // The furnace: a chamber behind the north wall, a glowing bed of coals, and a door that slides up into the header.
  wall(-3.2, -2.7, H.minZ - 5, H.minZ - T, 0, 4.2, M.dark);
  wall(2.7, 3.2, H.minZ - 5, H.minZ - T, 0, 4.2, M.dark);
  wall(-3.2, 3.2, H.minZ - 5.4, H.minZ - 5, 0, 4.2, M.dark);
  plane(-2.7, 2.7, H.minZ - 5, H.minZ - 0.1, 0, M.dark); // (right up to the hall's floor: no gap under the door)
  plane(-2.7, 2.7, H.minZ - 5, H.minZ - T, 4.2, M.dark, true);
  const fireMat = new THREE.MeshBasicMaterial({ color: 0x4a1408, fog: false });
  const fire = put(new THREE.PlaneGeometry(5.2, 3.4), fireMat, 0, 1.7, H.minZ - 4.95);
  fire.rotation.y = 0;
  const flames = [-1.6, 0, 1.6].map((x, i) => {
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture('rgba(255,140,40,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
    );
    sp.position.set(x, 1.4, H.minZ - 4.6);
    sp.scale.set(3, 3, 1);
    sp.visible = false;
    scene.add(sp);
    return { sp, phase: i * 2 };
  });
  const furnaceLight = light(0xff7a2a, 0, 28, 0, 2.2, H.minZ - 3, 1.5);
  const furnaceGroup = new THREE.Group();
  furnaceGroup.position.set(0, 0, H.minZ - 0.2);
  scene.add(furnaceGroup);
  const furnaceLeaf = new THREE.Mesh(new THREE.BoxGeometry(5.46, 3.52, 0.3), M.steel);
  furnaceLeaf.position.set(0, 1.75, 0);
  furnaceGroup.add(furnaceLeaf);
  const furnaceBand = new THREE.Mesh(new THREE.BoxGeometry(5.46, 0.3, 0.34), M.hazard);
  furnaceBand.position.set(0, 0.15, 0);
  furnaceGroup.add(furnaceBand);
  const furnaceDoor = new Slide(furnaceGroup, 'y', 3.6);
  updatables.push(furnaceDoor);
  // Nobody goes in the furnace (the boss included): a permanent solid across its mouth, open door or not.
  const furnaceSeal = new THREE.Mesh(new THREE.BoxGeometry(5.6, 4, 1.6), hidden);
  furnaceSeal.position.set(0, 2, H.minZ - 0.5);
  furnaceSeal.updateMatrixWorld(true);
  colliders.push(furnaceSeal);
  put(new THREE.PlaneGeometry(3.4, 0.6), new THREE.MeshBasicMaterial({ map: signTexture(['INCINERATOR 2', 'KEEP CLEAR WHEN LIT'], { w: 512, h: 96, bg: '#2a0d08', fg: '#ff9a6a', border: '#ff5a3a' }) }), 0, 4.5, H.minZ + 0.06);
  // The rails from Ben's chair to the furnace.
  for (const x of [-0.62, 0.62]) B.box({ w: 0.26, h: 0.04, d: 17.4, x, y: 0.02, z: -5.3, material: M.hazard, collider: false });

  // Structural pillars, two boilers, ceiling pipes, a catwalk along the north wall.
  for (const [x, z] of [[-6.5, -6.5], [6.5, -6.5], [-6.5, 8], [6.5, 8]]) B.box({ w: 0.9, h: H.h, d: 0.9, x, y: H.h / 2, z, material: M.wall, tile: 3 });
  // (Boiler tanks bolted flat to the west wall: nothing sticks out into the boss's wall-run path.)
  for (const z of [-4.8, 4.8]) {
    const x = -13.5;
    B.box({ w: 1.0, h: 5, d: 2.6, x, y: 2.5, z, material: M.boiler });
    B.box({ w: 1.1, h: 0.3, d: 2.7, x, y: 0.15, z, material: M.dark, collider: false });
    B.shape(new THREE.CylinderGeometry(0.4, 0.4, 3.5, 10), M.pipe, x, 6.7, z);
    for (const dz of [-0.8, 0, 0.8]) B.box({ w: 0.08, h: 4.4, d: 0.12, x: x + 0.54, y: 2.5, z: z + dz, material: M.dark, collider: false });
  }
  for (const z of [-9, -3, 3, 9]) B.shape(new THREE.CylinderGeometry(0.22, 0.22, 27.4, 10), M.pipe, 0, 8.2, z, 0, 0, Math.PI / 2);
  B.box({ w: 27, h: 0.12, d: 1.4, x: 0, y: 6.2, z: -12.9, material: M.dark, collider: false });
  B.box({ w: 27, h: 0.05, d: 0.05, x: 0, y: 7.2, z: -12.2, material: M.steel, collider: false });

  // Ben's chair (on the furnace rails), and the cage of laser tripmines around it.
  const C = UG.chair;
  B.shape(new THREE.CylinderGeometry(1.5, 1.5, 0.1, 24), M.dark, C.x, 0.05, C.z);
  B.box({ w: 0.6, h: 0.08, d: 0.58, x: C.x, y: 0.44, z: C.z, material: M.steel, collider: false });
  for (const [dx, dz] of [[-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]]) B.box({ w: 0.06, h: 0.42, d: 0.06, x: C.x + dx, y: 0.21, z: C.z + dz, material: M.steel, collider: false });
  B.box({ w: 0.6, h: 0.75, d: 0.07, x: C.x, y: 0.85, z: C.z - 0.27, material: M.steel, collider: false });
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.8 });
  const straps = [
    [new THREE.BoxGeometry(0.62, 0.08, 0.34), C.x, 1.15, C.z - 0.02],
    [new THREE.BoxGeometry(0.1, 0.08, 0.3), C.x - 0.33, 0.82, C.z + 0.08],
    [new THREE.BoxGeometry(0.1, 0.08, 0.3), C.x + 0.33, 0.82, C.z + 0.08],
  ].map(([geo, x, y, z]) => put(geo, strapMat, x, y, z));
  const chairSolid = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 1.0), hidden);
  chairSolid.position.set(C.x, 0.8, C.z);
  chairSolid.updateMatrixWorld(true);
  colliders.push(chairSolid);
  const chairHitbox = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.0, 1.8), hidden);
  chairHitbox.position.set(C.x, 1.0, C.z);
  chairHitbox.userData = { interactable: true, label: "Cut Ben's straps", type: 'sc-chair' };
  scene.add(chairHitbox);
  const beams = new Beams(scene);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1d2227, metalness: 0.7, roughness: 0.45 });
  const posts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = C.x + Math.cos(a) * 2.4;
    const pz = C.z + Math.sin(a) * 2.4;
    posts.push([px, pz]);
    B.shape(new THREE.CylinderGeometry(0.11, 0.13, 1.7, 8), postMat, px, 0.85, pz);
    B.shape(new THREE.CylinderGeometry(0.3, 0.34, 0.22, 12), M.dark, px, 0.11, pz);
    put(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 12), M.red, px, 0.235, pz);
    for (const y of [0.45, 0.95, 1.45]) put(new THREE.SphereGeometry(0.06, 8, 6), M.red, px, y, pz);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.7, 0.34), hidden);
    post.position.set(px, 0.85, pz);
    post.updateMatrixWorld(true);
    colliders.push(post);
  }
  [0.45, 0.95, 1.45].forEach((y, layer) => {
    for (let i = 0; i < 6; i++) beams.add({ a: posts[i], b: posts[(i + 1) % 6], y, group: `cage${layer}` });
  });

  // The security terminal alcove (east wall): one doorway, 1.7m wide: the place to stand.
  // (Thick walls: a unit crowded against them can only be pushed back out the side it came from.)
  const A = { x0: 10.4, x1: H.maxX, z0: -9.2, z1: -3.2 };
  wall(A.x0, A.x1, A.z0 - 0.6, A.z0, 0, 3.2, M.dark);
  wall(A.x0, A.x1, A.z1, A.z1 + 0.6, 0, 3.2, M.dark);
  wall(A.x0, A.x0 + 0.8, A.z0, -7.05, 0, 3.2, M.dark);
  wall(A.x0, A.x0 + 0.8, -5.35, A.z1, 0, 3.2, M.dark);
  plane(A.x0, A.x1, A.z0, A.z1, 3.2, M.ceiling, true);
  wall(A.x0, A.x0 + 0.8, -7.05, -5.35, 2.6, 3.2, M.dark);
  B.box({ w: 0.7, h: 0.9, d: 1.5, x: 13.4, y: 0.45, z: -6.2, material: M.dark });
  const termScreen = makeScreen(384, 240);
  put(new THREE.BoxGeometry(0.1, 0.96, 1.46), M.dark, 13.3, 1.5, -6.2); // the monitor's body, on a neck and foot
  put(new THREE.BoxGeometry(0.08, 0.22, 0.2), M.dark, 13.3, 1.0, -6.2);
  put(new THREE.BoxGeometry(0.4, 0.03, 0.5), M.dark, 13.3, 0.915, -6.2);
  put(new THREE.BoxGeometry(0.3, 0.03, 0.9), M.steel, 13.22, 0.922, -6.2); // keyboard (its top clear of the monitor foot's)
  const termDisplay = put(new THREE.PlaneGeometry(1.3, 0.8), new THREE.MeshBasicMaterial({ map: termScreen.texture, fog: false }), 13.245, 1.5, -6.2);
  termDisplay.rotation.y = -Math.PI / 2;
  const termLight = light(0x5fe8ff, 4, 9, 12.4, 2.4, -6.2, 1.8);
  const drawTerminal = (pct, lines = []) => {
    termScreen.draw((g, w, h) => {
      g.fillStyle = '#04141a';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#5fe8ff';
      g.font = 'bold 20px "Courier New", monospace';
      g.fillText('SECURITY OVERRIDE', 16, 34);
      g.font = '15px "Courier New", monospace';
      lines.forEach((l, i) => g.fillText(l, 16, 62 + i * 22));
      if (pct !== null) {
        g.strokeStyle = '#5fe8ff';
        g.lineWidth = 3;
        g.strokeRect(16, 170, w - 32, 32);
        g.fillRect(20, 174, ((w - 40) * Math.min(100, pct)) / 100, 24);
        g.font = 'bold 20px "Courier New", monospace';
        g.fillText(`${Math.floor(pct)}%`, w / 2 - 20, 226);
      }
    });
  };
  drawTerminal(null, ['> doors: LOCKED x3', '> awaiting operator_']);
  // Security shutters on the walls (Ben's override opens them, one by one: red lamp -> green, the leaf rises).
  // (The two on the north wall used to be turned the wrong way round, leaf buried in the wall behind the frame.)
  const shutters = [[-9.5, H.minZ + 0.06, 0], [9.5, H.minZ + 0.06, 0], [H.maxX - 0.06, 9, -Math.PI / 2]].map(([x, z, ry]) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = ry; // (local +Z faces into the hall)
    scene.add(group);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.6, 0.08), M.dark);
    frame.position.set(0, 1.8, 0);
    group.add(frame);
    const leafGroup = new THREE.Group();
    group.add(leafGroup);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 0.14), M.steel);
    leaf.position.set(0, 1.7, 0.08);
    leafGroup.add(leaf);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.24, 0.24, 0.16), M.hazard); // (proud of the leaf's edges and bottom: flush, they z-fought)
    stripe.position.set(0, 0.23, 0.08);
    leafGroup.add(stripe);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.05), new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
    lamp.position.set(0, 3.75, 0.06);
    group.add(lamp);
    const slide = new Slide(leafGroup, 'y', 3.2);
    updatables.push(slide);
    return { group, lamp, slide };
  });
  const podBlocks = [];
  const podDoors = [
    { x: H.minX + 0.05, z: -9, ry: Math.PI / 2, inside: [H.minX - 1.6, -9], out: [H.minX + 3, -9] },
    { x: H.minX + 0.05, z: 9, ry: Math.PI / 2, inside: [H.minX - 1.6, 9], out: [H.minX + 3, 9] },
    { x: -6, z: H.minZ + 0.05, ry: 0, inside: [-6, H.minZ - 1.6], out: [-6, H.minZ + 3] },
    { x: 6, z: H.minZ + 0.05, ry: 0, inside: [6, H.minZ - 1.6], out: [6, H.minZ + 3] },
  ].map((def) => {
    const group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    group.rotation.y = def.ry;
    scene.add(group);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.36, 2.64, 0.14), M.dark);
    leaf.position.set(0, 1.32, -0.2);
    leaf.userData.podDoor = true;
    group.add(leaf);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.05), M.amber);
    strip.position.set(0, 2.35, -0.11);
    group.add(strip);
    const slide = new Slide(group, 'y', 2.7);
    updatables.push(slide);
    // The player never goes in there (units come out): a solid across each doorway keeps it that way.
    const pb = new THREE.Mesh(new THREE.BoxGeometry(def.ry ? 0.5 : 1.5, 3, def.ry ? 1.5 : 0.5), hidden);
    pb.position.set(def.ry ? def.x - 0.2 : def.x, 1.5, def.ry ? def.z : def.z - 0.2);
    pb.updateMatrixWorld(true);
    podBlocks.push(pb);
    // A recess behind each one (a box seen from inside): the units start in it and walk out through the door.
    const recess = new THREE.Mesh(
      new THREE.BoxGeometry(def.ry ? 2.8 : 1.8, 2.7, def.ry ? 1.8 : 2.8),
      new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 1, side: THREE.BackSide }),
    );
    recess.position.set(def.ry ? def.x - 1.55 : def.x, 1.35, def.ry ? def.z : def.z - 1.55);
    scene.add(recess);
    return { def, slide, leaf };
  });

  // ==== The corridor and the practice hall ======================================================
  const S = UG.sim;
  plane(S.maxX, H.minX - 0.1, -1.2, 1.2, 0, M.floor); // (through the practice hall's doorway to its floor, up to the hall's)
  // (The corridor's ceiling and walls stop at the hall's west wall (x = -14.4), not inside it: running
  // on to -14 they shared its faces in the doorway and z-fought.)
  plane(-19.6, H.minX - T, -1.2, 1.2, 3.2, M.ceiling, true);
  wall(-19.6, H.minX - T, -1.6, -1.2, 0, 3.2);
  wall(-19.6, H.minX - T, 1.2, 1.6, 0, 3.2);
  plane(S.minX, S.maxX, S.minZ, S.maxZ, 0, M.simFloor, false, 26);
  plane(S.minX, S.maxX, S.minZ, S.maxZ, S.h, M.ceiling, true);
  wall(S.minX - T, S.minX, S.minZ - T, S.maxZ + T, 0, S.h);
  wall(S.minX - T, S.maxX + T, S.minZ - T, S.minZ, 0, S.h);
  wall(S.minX - T, S.maxX + T, S.maxZ, S.maxZ + T, 0, S.h);
  wall(S.maxX, S.maxX + T, S.minZ - T, -1.2, 0, S.h);
  wall(S.maxX, S.maxX + T, 1.2, S.maxZ + T, 0, S.h);
  wall(S.maxX, S.maxX + T, -1.2, 1.2, 3.2, S.h);
  // Cover: pillars around node C, crates, tackling dummies.
  for (const [x, z] of [[-31.8, -1.8], [-28.2, -1.8], [-31.8, 1.8], [-28.2, 1.8]]) B.box({ w: 0.8, h: S.h, d: 0.8, x, y: S.h / 2, z, material: M.wall, tile: 3 });
  for (const [x, z, w, d, h] of [[-27.5, -9.6, 1.4, 1.4, 1.2], [-27.5, 9.6, 1.4, 1.4, 1.2], [-35, -10.5, 1.6, 1.0, 1.0], [-35, 10.5, 1.6, 1.0, 1.0], [-40, 0, 1.0, 1.0, 1.0]]) {
    B.box({ w, h, d, x, y: h / 2, z, material: M.crate });
  }
  for (const [x, z] of [[-23, -5.2], [-23, 5.2], [-38.5, -3.6], [-38.5, 3.6]]) {
    B.shape(new THREE.CylinderGeometry(0.36, 0.42, 1.7, 10), M.pad, x, 0.85, z);
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.8), hidden);
    col.position.set(x, 0.85, z);
    col.updateMatrixWorld(true);
    colliders.push(col);
  }
  // Node A (the south-west pen): a pulsing laser gate. Node B (the north-west pen): a locked door and a four-button panel (the answer is on the Coach's play sheet).
  // (The pens' front walls stop at their side walls (x = -41.7) instead of running into them: the
  // overlap shared faces and z-fought.)
  wall(-41.7, -41.5, 8.4, S.maxZ, 0, 3);
  wall(S.minX, -44.9, 8.4, 8.6, 0, 3);
  wall(-43.1, -41.7, 8.4, 8.6, 0, 3);
  wall(-41.7, -41.5, S.minZ, -8.4, 0, 3);
  wall(S.minX, -44.9, -8.6, -8.4, 0, 3);
  wall(-43.1, -41.7, -8.6, -8.4, 0, 3);
  wall(-45.1, -44.9, -8.4, -5.4, 0, 3);
  wall(-43.1, -42.9, -8.4, -5.4, 0, 3);
  beams.add({ a: [-44.9, 8.5], b: [-43.1, 8.5], y: 0.15, y1: 2.4, group: 'sim-gate', pulse: { on: 1.6, off: 1.5, offset: 0 } });
  const nodes = [makeNode(scene, colliders, -43.7, 11.6, 0), makeNode(scene, colliders, -43.7, -11.6, 1), makeNode(scene, colliders, -30, 0, 2)];
  // ---- Node B's lock: four coloured buttons, pressed in an order worked out from the Coach's play sheet. ----
  // (The puzzle, its colours and its sheet are rolled fresh each playthrough: see rollPuzzle / puzzle.configure.)
  const lockLeafGroup = new THREE.Group();
  lockLeafGroup.position.set(-44.0, 1.45, -5.5);
  scene.add(lockLeafGroup);
  const lockLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.86, 2.9, 0.16), M.steel);
  lockLeafGroup.add(lockLeaf);
  const lockStripe = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.24, 0.18), M.hazard);
  lockStripe.position.y = -1.2;
  lockLeafGroup.add(lockStripe);
  const lockDoor = new Slide(lockLeafGroup, 'y', -2.95); // 0 shut .. 1 sunk into the floor
  updatables.push(lockDoor);
  const lockSolid = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.9, 0.5), hidden);
  lockSolid.position.set(-44.0, 1.45, -5.5);
  lockSolid.updateMatrixWorld(true);
  B.box({ w: 0.06, h: 1.0, d: 1.1, x: -42.87, y: 1.4, z: -6.6, material: M.dark, collider: false }); // the panel
  const lampMats = [];
  [-0.36, -0.12, 0.12, 0.36].forEach((dz) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a, fog: false });
    lampMats.push(mat);
    put(new THREE.BoxGeometry(0.05, 0.08, 0.16), mat, -42.83, 2.02, -6.6 + dz);
  });
  const btnMats = [];
  const btnFaces = [];
  const lockButtons = [0, 1, 2, 3].map((i) => {
    // (As you face the panel: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right.)
    const dz = i % 2 === 0 ? 0.24 : -0.24;
    const dy = i < 2 ? 0.24 : -0.24;
    const mat = new THREE.MeshBasicMaterial({ color: 0x888888, fog: false });
    btnMats.push(mat);
    put(new THREE.BoxGeometry(0.06, 0.28, 0.28), mat, -42.83, 1.4 + dy, -6.6 + dz);
    const face = makeScreen(64, 64);
    btnFaces.push(face);
    const letter = put(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({ map: face.texture, transparent: true, fog: false }), -42.785, 1.4 + dy, -6.6 + dz); // (1.5cm proud of the button: at 2mm the letters flickered)
    letter.rotation.y = Math.PI / 2;
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), hidden);
    hitbox.position.set(-42.8, 1.4 + dy, -6.6 + dz);
    hitbox.userData = { interactable: true, label: 'Press', type: 'sc-btn', idx: i };
    scene.add(hitbox);
    return hitbox;
  });
  const panelTag = put(new THREE.PlaneGeometry(0.95, 0.24), new THREE.MeshBasicMaterial({ map: signTexture(['NODE B LOCK', 'ENTER THE DRILL ORDER'], { bg: '#0d1a20', fg: '#7fe8ff', border: '#3ad8ff', w: 384, h: 96 }) }), -42.83, 0.62, -6.6);
  panelTag.rotation.y = Math.PI / 2;
  // The Coach's play sheet (north wall, out where the clones patrol): the clues.
  const sheet = makeScreen(768, 448);
  B.box({ w: 3.3, h: 1.95, d: 0.06, x: -32, y: 2.2, z: 12.95, material: M.dark, collider: false });
  const sheetMesh = put(new THREE.PlaneGeometry(3.15, 1.84), new THREE.MeshBasicMaterial({ map: sheet.texture, fog: false }), -32, 2.2, 12.91);
  sheetMesh.rotation.y = Math.PI;
  light(0xf1ecd0, 5, 8, -32, 3.6, 11.5, 1.8);
  const puzzle = {
    order: [0, 1, 2, 3],
    kind: 0,
    door: lockDoor,
    solid: lockSolid,
    buttons: lockButtons,
    seq: [],
    solved: false,
    lockout: 0,
    setLamps(n, color = 0xffb13a) {
      lampMats.forEach((m, i) => m.color.setHex(i < n ? color : 0x2a2a2a));
    },
    /** Load a rolled puzzle (rollPuzzle): recolour the buttons, redraw the sheet, shut and reset the lock. */
    configure(cfg) {
      this.order = cfg.order;
      this.kind = cfg.kind;
      this.seq.length = 0;
      this.solved = false;
      this.lockout = 0;
      this.setLamps(0);
      lockDoor.set(0);
      cfg.colors.forEach((col, i) => {
        btnMats[i].color.setHex(col.hex);
        lockButtons[i].userData.label = `Press ${col.name}`;
        btnFaces[i].draw((g, w, h) => {
          g.clearRect(0, 0, w, h);
          g.fillStyle = '#101214';
          g.font = 'bold 44px Arial, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(col.letter, w / 2, h / 2 + 3);
        });
      });
      sheet.draw(cfg.draw);
    },
  };
  puzzle.configure(rollPuzzle());
  // Banners, and a sign over the corridor.
  const simSign = put(new THREE.PlaneGeometry(4.5, 0.9), new THREE.MeshBasicMaterial({ map: signTexture(['PRACTICE HALL 3', 'COACH BILLING · SIMULATION LEVEL'], { w: 512, h: 128, bg: '#15181c', fg: '#e8d9a0', border: '#7a1f2b' }) }), S.maxX - 0.02, 4.2, 0);
  simSign.rotation.y = Math.PI / 2;
  light(0xdce6ff, 12, 22, -26, 5.4, 0, 1.6);
  light(0xdce6ff, 12, 22, -38, 5.4, 6, 1.6);
  light(0xdce6ff, 12, 22, -38, 5.4, -6, 1.6);
  const hallLight = light(0xdfe8ff, 34, 40, 0, 7.8, 2, 1.4);
  light(0xbfd0ff, 12, 30, 0, 7.6, -9, 1.5);
  light(0xff8a3a, 6, 14, 0, 3, 10, 1.7);
  // (Made now, dark until the ending: a light added mid-game would rebuild every shader.)
  const fireLight = light(0xff8a3a, 0, 26, 0, 2.4, -10, 1.6);
  const policeLight = light(0xff2a2a, 0, 18, 0, 3, 20, 1.6);

  B.flush();
  // The doors that were built as separate pieces: the hall's colliders are the merged ones plus these.
  const solids = { chair: chairSolid, blast: blastCollider, stairs: stairCollider, lock: lockSolid };
  for (const s of Object.values(solids)) s.updateMatrixWorld(true);

  // Other Ben: strapped into the chair (a Character, so his legs and head move like everyone else's).
  const benMesh = createHumanoid(OTHER_BEN_LOOK);
  benMesh.position.set(C.x, 0, C.z);
  scene.add(benMesh);
  setSeatedPose(benMesh);
  const ben = new Character(benMesh, { radius: 0.32, name: 'Other Ben' });
  updatables.push({ update: (dt) => ben.update(dt) });

  return {
    scene,
    colliders,
    updatables,
    beams,
    nodes,
    ben,
    straps,
    solids,
    podBlocks,
    puzzle,
    lights: { hall: hallLight, furnace: furnaceLight, alarm: alarmLight, term: termLight, fire: fireLight, police: policeLight },
    alarmLamp,
    gallery: { rifle, rifleGlow, rifleHitbox, pipe, jointGroup, jointHitbox, jointGlow: jointGlowSprite, stairDoor, blast, drawTimer },
    hall: { chairHitbox, furnaceDoor, fireMat, furnaceLight, flames, shutters, podDoors, drawTerminal, termLight },
    updatePulse(t) {
      for (const n of nodes) n.pulse(t);
    },
  };
}

// ---------------------------------------------------------------------------
// Coach Clones: animatronics with flashlights and Billing's footsteps
// ---------------------------------------------------------------------------

class CoachClone {
  constructor(chapter, def, index) {
    this.ch = chapter;
    this.index = index;
    this.route = def.route.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.pauseFor = def.pause ?? 1.4;
    this.speed = def.speed ?? 1.7;
    const mesh = createHumanoid({ shirt: 0x22262b, pants: 0x181b1f, skin: 0xb3b7bb, hair: 0x2b2b2b, scale: 1.2, whistle: true });
    mesh.name = 'coach-clone';
    chapter.ug.scene.add(mesh);
    const rig = mesh.userData.rig;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x9ff4ff, fog: false });
    for (const x of [-0.06, 0.06]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.02), eyeMat);
      eye.position.set(x, 0.2, 0.14);
      rig.neck.add(eye);
    }
    this.mesh = mesh;
    this.coach = new Character(mesh, { radius: 0.42, name: 'Coach Clone' });
    // The flashlight: a hand prop and a volumetric-looking cone (no real light: they'd each cost every shader a light).
    const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.24, 8), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.4 }));
    prop.position.y = -0.06;
    rig.handR.add(prop);
    this.prop = prop;
    rig.holdingFlashlight = true;
    this.beam = new THREE.Mesh(chapter.beamGeometry, chapter.cloneBeamMat);
    this.beam.frustumCulled = false;
    chapter.ug.scene.add(this.beam);
    this.wp = 0;
    this.state = 'pause';
    this.timer = 1;
    this.aimYaw = 0;
    this.t = Math.random() * 10;
    this.stepT = 0;
    this.susp = 0;
    this.seen = false;
    this.sightT = 0;
    this._lightPos = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this.reset();
  }

  get position() {
    return this.coach.position;
  }

  /**
   * Back to its rounds: at its first stop, or (after a capture) the stop farthest from `awayFrom`,
   * facing on along its route. Whatever it last saw is forgotten, and `grace` seconds pass before it
   * can start noticing you again (you used to be spotted again the moment you respawned).
   */
  reset(awayFrom = null, grace = 0) {
    let wp = 0;
    if (awayFrom) {
      let best = -1;
      this.route.forEach((w, i) => {
        const d = (w.x - awayFrom.x) ** 2 + (w.z - awayFrom.z) ** 2;
        if (d > best) {
          best = d;
          wp = i;
        }
      });
    }
    const p = this.route[wp];
    const next = this.route[(wp + 1) % this.route.length];
    this.coach.stop();
    this.coach.faceTowards(null);
    this.coach.turnRate = 5;
    this.mesh.position.set(p.x, 0, p.z);
    this.mesh.rotation.y = Math.atan2(next.x - p.x, next.z - p.z);
    this.wp = wp;
    this.state = 'pause';
    this.timer = 1 + this.index * 0.7;
    this.susp = 0;
    this.seen = false;
    this.lit = false;
    this.beamHit = false;
    this.close = false;
    this.prox = 0;
    this.sightT = 0.2;
    this.graceT = grace;
    this.aimYaw = this.mesh.rotation.y;
  }

  /**
   * You've been caught: it stops dead, swings round and pins you with its beam. The one that caught you
   * (`advance`) also closes in a few steps; the rest just stop and stare.
   */
  spot(advance) {
    const pos = this.coach.position;
    const pp = this.ch.player.object.position;
    this.state = 'spotted';
    this.coach.stop();
    this.coach.turnRate = 9;
    this.coach.faceTowards(pp);
    const d = Math.hypot(pp.x - pos.x, pp.z - pos.z);
    if (advance && d > 3.2) {
      const k = Math.min(2.2, d - 2.4) / d;
      this.coach.moveTo(pos.x + (pp.x - pos.x) * k, pos.z + (pp.z - pos.z) * k, 2.6);
    }
  }

  update(dt, active) {
    this.t += dt;
    const ch = this.ch;
    const pos = this.coach.position;
    const pp = ch.player.object.position;
    if (this.state === 'spotted') {
      this.coach.update(dt);
      if (this.coach.speed > 0.4 && (this.stepT -= dt) <= 0) {
        this.stepT = 0.5;
        playCloneStep(THREE.MathUtils.clamp(1 - Math.hypot(pp.x - pos.x, pp.z - pos.z) / 26, 0, 1));
      }
      // The beam locked on you (on your chest), not sweeping.
      this.aimYaw = dampAngle(this.aimYaw, Math.atan2(pp.x - pos.x, pp.z - pos.z), Math.min(1, dt * 9));
      this.prop.getWorldPosition(this._lightPos);
      const reach = Math.max(1, Math.hypot(pp.x - this._lightPos.x, pp.z - this._lightPos.z));
      this.beam.position.copy(this._lightPos);
      this.beam.lookAt(this._lightPos.x + Math.sin(this.aimYaw) * reach, Math.max(0.4, pp.y - 0.6), this._lightPos.z + Math.cos(this.aimYaw) * reach);
      this.seen = false;
      return;
    }
    if (active) {
      if (this.state === 'walk') {
        if (this.coach.mode === 'idle') {
          this.state = 'pause';
          this.timer = this.pauseFor;
        }
      } else {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.wp = (this.wp + 1) % this.route.length;
          const w = this.route[this.wp];
          this.coach.moveTo(w.x, w.z, this.speed);
          this.state = 'walk';
        }
      }
    }
    this.coach.update(dt);
    // Footsteps: Billing's boots (heavy, evenly spaced), louder the closer it is.
    const dist = Math.hypot(pp.x - pos.x, pp.z - pos.z);
    if (this.coach.speed > 0.4) {
      this.stepT -= dt;
      if (this.stepT <= 0) {
        this.stepT = 0.62;
        playCloneStep(THREE.MathUtils.clamp(1 - dist / 26, 0, 1) * 0.9);
      }
    }
    // The beam: the way it faces, sweeping a little.
    const heading = this.mesh.rotation.y;
    const sweep = this.state === 'pause' ? Math.sin(this.t * 1.1) * 0.9 : Math.sin(this.t * 0.9) * 0.35;
    this.aimYaw = dampAngle(this.aimYaw, heading + sweep, Math.min(1, dt * 5));
    this.prop.getWorldPosition(this._lightPos);
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    this.beam.position.copy(this._lightPos);
    this.beam.lookAt(this._lightPos.x + fx * 10, 0.3, this._lightPos.z + fz * 10);
    // Sight: the beam (or anything up close), with nothing in the way.
    this.seen = false;
    if (active && !ch.cutscene) {
      this.sightT -= dt;
      if (this.sightT <= 0) {
        this.sightT = 0.1;
        const dx = pp.x - pos.x;
        const dz = pp.z - pos.z;
        const d = Math.max(1e-3, Math.hypot(dx, dz));
        const cosA = (dx * fx + dz * fz) / d;
        const range = 14 * (ch.player.isCrouching ? 0.7 : 1) * (ch.player.isSprinting ? 1.25 : 1) * difficulty.sightMult;
        const inBeam = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1)) < V.beamHalfAngle * 1.1 && d < range;
        const close = d < 2.4;
        this.beamHit = inBeam || close;
        if (this.beamHit) {
          this._eye.set(pos.x, 2.0, pos.z);
          this.lit = ch.combat.canSeePlayer(this._eye);
          this.close = close;
          this.prox = 1 - Math.min(1, d / Math.max(range, 1));
        } else {
          this.lit = false;
        }
      }
      this.seen = !!this.lit;
      if (this.graceT > 0) {
        this.graceT -= dt;
        this.seen = false; // (you've only just respawned: a moment to get your bearings)
      }
    }
    const rate = (ch.player.isCrouching ? 0.75 : 1.4) * (this.close ? 2 : 1) * (0.7 + (this.prox || 0));
    this.susp = THREE.MathUtils.clamp(this.susp + (this.seen ? rate : -0.45) * dt, 0, 1);
  }
}

// ---------------------------------------------------------------------------
// The boiler room's hatch (a bulkhead against the school's south wall)
// ---------------------------------------------------------------------------

function buildHatch(scene) {
  const group = new THREE.Group();
  group.position.set(HATCH.x, 0, HATCH.z);
  group.name = 'boiler-hatch';
  scene.add(group);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x70757a, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x4d565d, roughness: 0.5, metalness: 0.7 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.34, 1.9), concrete);
  frame.position.set(0, 0.17, 0);
  group.add(frame);
  const pit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 1.4), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  pit.position.set(0, 0.36, 0);
  group.add(pit);
  // Two leaves, hinged on the outer edges, sloping to the south (-Z): they swing up and open.
  const leaves = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 1.15, 0.4, 0);
    group.add(pivot);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.08, 1.4), steel);
    leaf.position.set(-s * 0.575, 0, 0);
    pivot.add(leaf);
    const rib = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.03, 0.06), new THREE.MeshStandardMaterial({ color: 0x2c3237 }));
    rib.position.set(-s * 0.575, 0.05, 0);
    pivot.add(rib);
    return { pivot, s };
  });
  // The keycard reader on a post: dead until the fuse goes in.
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), steel);
  post.position.set(2.0, 0.55, -0.3);
  group.add(post);
  const reader = makeScreen(128, 96);
  const readerMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.25), new THREE.MeshBasicMaterial({ map: reader.texture, fog: false }));
  readerMesh.position.set(2.0, 1.2, -0.37);
  readerMesh.rotation.y = Math.PI;
  group.add(readerMesh);
  const drawReader = (lines, color) => {
    reader.draw((g, w, h) => {
      g.fillStyle = '#050607';
      g.fillRect(0, 0, w, h);
      g.fillStyle = color;
      g.textAlign = 'center';
      g.font = 'bold 15px "Courier New", monospace';
      lines.forEach((l, i) => g.fillText(l, w / 2, 32 + i * 24));
    });
  };
  drawReader(['NO POWER', 'CARD: ---'], '#7a2a24');
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.08), new THREE.MeshBasicMaterial({ color: 0x3a0806, fog: false }));
  lamp.position.set(2.0, 1.5, -0.36);
  group.add(lamp);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), new THREE.MeshBasicMaterial({ map: signTexture(['BOILER ROOM ACCESS', 'AUTHORIZED PERSONNEL ONLY'], { w: 512, h: 128 }) }));
  sign.position.set(0, 2.3, -(HATCH.z + 34.4) + 0.02);
  sign.rotation.y = Math.PI;
  group.add(sign);
  const hitbox = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.1, 1.9), new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.position.set(HATCH.x, 0.55, HATCH.z);
  hitbox.userData = { interactable: true, label: 'Boiler room hatch (locked)', type: 'sc-hatch' };
  scene.add(hitbox);
  const collider = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.5, 1.9), new THREE.MeshBasicMaterial({ visible: false }));
  collider.position.set(HATCH.x, 0.25, HATCH.z);
  collider.updateMatrixWorld(true);
  return {
    group,
    hitbox,
    collider,
    leaves,
    lamp,
    drawReader,
    setOpen(k) {
      leaves.forEach(({ pivot, s }) => (pivot.rotation.z = s * -1.55 * k));
    },
  };
}

/** A police car for the dawn: dark body, white doors, a light bar that flashes red and blue. */
function buildPoliceCar() {
  const car = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.62, 4.3), new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.5, roughness: 0.4 }));
  body.position.y = 0.52;
  car.add(body);
  const door = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.4, 2.0), new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 }));
  door.position.set(0, 0.6, -0.2);
  car.add(door);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.72, 0.56, 2.05),
    new THREE.MeshStandardMaterial({ color: 0x1b2228, metalness: 0.6, roughness: 0.15, transparent: true, opacity: 0.85 }),
  );
  cabin.position.set(0, 1.1, -0.25);
  car.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.3, 14);
  const tire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]].forEach(([x, z]) => {
    const w = new THREE.Mesh(wheelGeo, tire);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.33, z);
    car.add(w);
  });
  const glowTex = glowTexture('rgba(255,255,255,1)');
  const bar = [0xff2a1a, 0x2a5aff].map((color, i) => {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.14, 0.26), new THREE.MeshBasicMaterial({ color: 0x220808 }));
    lamp.position.set(i ? 0.36 : -0.36, 1.45, -0.2);
    car.add(lamp);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    glow.position.copy(lamp.position);
    glow.scale.set(2.4, 2.4, 1);
    car.add(glow);
    return { lamp, glow, color: new THREE.Color(color) };
  });
  return {
    group: car,
    /** The light bar flashing (t = seconds). */
    flash(t) {
      const phase = Math.floor(t * 6) % 2;
      bar.forEach((b, i) => {
        b.lamp.material.color.copy(b.color).multiplyScalar(phase === i ? 1 : 0.12);
        b.glow.material.opacity = phase === i ? 0.9 : 0.05;
      });
    },
  };
}

/** A fullscreen title card over black: lines fade in one by one, hold, then everything fades out. */
async function playCard(wait, lines, { hold = 2.2 } = {}) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:16;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
    'pointer-events:none;font-family:"Courier New",Courier,monospace;text-align:center;color:#d9dee3;';
  const rows = lines.map(([text, css]) => {
    const div = document.createElement('div');
    div.textContent = text;
    div.style.cssText = `${css}opacity:0;transition:opacity 1.1s ease;`;
    el.appendChild(div);
    return div;
  });
  document.body.appendChild(el);
  el.getBoundingClientRect(); // commit opacity 0 so the fades run
  for (const row of rows) {
    row.style.opacity = '1';
    await wait(1.0);
  }
  await wait(hold);
  el.style.transition = 'opacity 1s ease';
  el.style.opacity = '0';
  await wait(1.0);
  el.remove();
}

// ---------------------------------------------------------------------------
// The chapter
// ---------------------------------------------------------------------------

// Car-local seat positions (the car faces local +Z; the driver sits on the left, +X).
const PASSENGER_EYE = new THREE.Vector3(-0.42, 1.1, -0.35);
const DRIVER_SEAT = new THREE.Vector3(0.42, -0.06, -0.45);
// Where you climb out: by the car's rear corner, facing the open trunk. (The opening's outside shot is taken from here.)
const PLAYER_START = { pos: new THREE.Vector3(-55.4, 0, -74.3), yaw: 1.326 };

export class SecretChapter {
  /**
   * @param {object} ctx - renderer, camera, player, world, director, stealth, dialogue, wait, and ui:
   *   { setObjective, hideObjective, showMessage, setPrompt, setNight, setFlashlight, setFlashlightPower, setScene,
   *     setDawn, onSecretEnd(part) }
   */
  constructor({ renderer, camera, player, world, director, stealth, dialogue, wait, ui }) {
    Object.assign(this, { renderer, camera, player, world, director, stealth, dialogue, wait, ui });
    this.part = 0;
    this.phase = 'inactive';
    this.location = 'none'; // grounds | underground
    this.cutscene = false;
    this.time = 0;
    this.token = 0;
    this.scene = null; // the campus (Chapter 1's world)
    this.ug = null; // the underground scene
    this.combat = null;
    this.builtGrounds = false;
    this.assets = false;
    this.scrappers = [];
    this.clues = {};
    this.collected = new Set();
    this.checkpoint = { pos: PLAYER_START.pos.clone(), yaw: PLAYER_START.yaw };
    this.caught = false;
    this._frameWaiters = [];
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._boundaryWalls = [];
    this._propColliders = [];
    this._colliderBoxes = [];
    this._shakeT = 0;
    this._shakeAmp = 0;
    this._boundsT = 0;
    this._hudLabel = '';
    this._hudWidth = -1;
    this._sparkT = 0;
    this.eHeld = false;
    this.hack = null;
    this.kitTaken = false;
    this._firstAlert = false;
    // Part 1's blackout: rocks to throw, the PA, your pulse and the stuttering light, the apparition.
    this.rocks = 0;
    this.rockPool = [];
    this.rockPiles = [];
    this.apparition = null;
    this._paT = 0;
    this._paOrder = [];
    this._beatT = 0;
    this._flickT = 0;
    this._flicker = 1;
    this._lightPower = 14;
    this._skyLevel = 0;
    this._buildHud();
    document.addEventListener('mousedown', (e) => {
      if (e.button === 2 && this.location === 'grounds' && this.phase === 'evade' && !this.cutscene && this.player.isLocked) this._throwRock();
    });
    document.addEventListener('contextmenu', (e) => {
      if (this.player.isLocked) e.preventDefault();
    });
    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyE') this.eHeld = true;
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'KeyE') this.eHeld = false;
    });
    window.addEventListener('blur', () => {
      this.eHeld = false;
    });
  }

  get active() {
    return this.phase !== 'inactive';
  }

  get inCutscene() {
    return this.cutscene;
  }

  get playerHidden() {
    return false;
  }

  // ---- Little helpers -----------------------------------------------------------------

  _buildHud() {
    const hud = document.getElementById('hud');
    const timer = document.createElement('div');
    timer.id = 'sc-timer';
    timer.className = 'hidden';
    hud.appendChild(timer);
    const hack = document.createElement('div');
    hack.id = 'sc-hack';
    hack.className = 'hidden';
    hack.innerHTML = '<div class="sc-hack-text"></div><div class="bar"><div></div></div>';
    hud.appendChild(hack);
    const caught = document.createElement('div');
    caught.id = 'sc-caught';
    caught.innerHTML = '<b>CAUGHT</b><span></span>';
    document.body.appendChild(caught);
    const hint = document.createElement('div');
    hint.id = 'sc-hint';
    hint.className = 'hidden';
    hint.innerHTML = '<b>YOU REMEMBER WHAT BEN SAID...</b><span></span>';
    hud.appendChild(hint);
    const rocks = document.createElement('div');
    rocks.id = 'sc-rocks';
    rocks.className = 'hidden';
    rocks.innerHTML = 'ROCKS <b>0</b> <span>[RMB] THROW</span>';
    hud.appendChild(rocks);
    this.hud = {
      rocks,
      rocksCount: rocks.querySelector('b'),
      hint,
      hintText: hint.querySelector('span'),
      timer,
      hack,
      hackText: hack.querySelector('.sc-hack-text'),
      hackFill: hack.querySelector('.bar div'),
      caught,
      caughtText: caught.querySelector('b'),
      caughtSub: caught.querySelector('span'),
    };
  }

  _nextFrame() {
    return new Promise((resolve) => this._frameWaiters.push(resolve));
  }

  /** Run `fn(k)` (k: 0..1) over `seconds` of game time, frame by frame. */
  async _anim(seconds, fn) {
    let t = 0;
    while (t < seconds) {
      t += await this._nextFrame();
      fn(Math.min(1, t / seconds));
    }
    fn(1);
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

  _shake(seconds, amp = 0.05) {
    this._shakeT = Math.max(this._shakeT, seconds);
    this._shakeAmp = amp;
  }

  /** Hand control back after a cutscene: no letterbox, camera released, movement and look live. */
  _restoreGameplay() {
    const { player, director } = this;
    this.cutscene = false;
    director.releaseCamera(75);
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    player.movementFrozen = false;
    player.clearStumble();
    document.getElementById('hud').classList.remove('hidden');
    document.body.classList.remove('cinematic');
  }

  _showCaught(text, sub) {
    this.hud.caughtText.textContent = text;
    this.hud.caughtSub.textContent = sub;
    this.hud.caught.classList.add('show');
  }

  _boxOf(obj) {
    obj.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(obj);
  }

  /** Keep a walker out of the solid things on the grounds. */
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

  // ---- Start ---------------------------------------------------------------------------

  async start({ part = 1 } = {}) {
    const { director, player, wait } = this;
    this.part = part;
    this.deaths = 0;
    this.phase = 'card';
    this.cutscene = true;
    director.fader.set(1);
    player.setInputLocked(true);
    document.getElementById('hud').classList.remove('hidden');
    this.ui.hideObjective();
    this._ensureAssets();
    if (part === 1) {
      this._prepareGrounds();
      this.renderer.compile(this.scene, this.camera);
      await playCard(wait, [
        ['SECRET CHAPTER', 'font-size:13px;letter-spacing:8px;color:#e0c34a;'],
        ['OVERTIME', 'font-size:42px;letter-spacing:14px;color:#b3413b;'],
        ['PART 1 · THE VANISHING AT THE TRACK', 'font-size:15px;letter-spacing:4px;font-style:italic;'],
        ['11:48 PM', 'font-size:34px;letter-spacing:12px;'],
      ]);
      await this._playOpening();
    } else {
      await playCard(wait, [
        ['SECRET CHAPTER', 'font-size:13px;letter-spacing:8px;color:#e0c34a;'],
        ['OVERTIME', 'font-size:42px;letter-spacing:14px;color:#b3413b;'],
        ['PART 2 · SUDDEN DEATH', 'font-size:15px;letter-spacing:4px;font-style:italic;'],
        ['12:02 AM', 'font-size:34px;letter-spacing:12px;'],
      ]);
      await this._startPart2();
    }
  }

  /** Shared art (textures, beams, the ELDAR materials), built once. */
  _ensureAssets() {
    if (this.assets) return;
    this.assets = true;
    this.questionTex = createMarkTexture('?', '#ffd21f');
    this.alertTex = createMarkTexture('!', '#ff4a3a');
    this.beamGeometry = createBeamGeometry();
    this.scrapBeamMat = createBeamMaterial();
    this.scrapBeamMat.uniforms.uColor.value.set(0xff8a1a);
    this.scrapBeamMat.uniforms.uIntensity.value = 0.16;
    this.cloneBeamMat = createBeamMaterial();
    this.cloneBeamMat.uniforms.uColor.value.set(0xdfe8ff);
    this.cloneBeamMat.uniforms.uIntensity.value = 0.22;
    this.eldarMats = createEldarMaterials();
  }

  // ---- The grounds -----------------------------------------------------------------------

  _prepareGrounds() {
    const { world, stealth, player, camera, ui } = this;
    const scene = (this.scene = world.tree.group.parent);
    this.location = 'grounds';
    ui.setScene(scene);
    setUnderground(false);
    ui.setNight({ fog: 0.03, hemi: 0.05, sun: 0, ambient: 0.02 }); // a full blackout: only the moon behind the storm
    ui.setFlashlightPower(14);
    scene.background.set(0x030508);
    scene.fog.color.set(0x030508);
    world.rain.exposureOverride = null;
    document.getElementById('hud').classList.remove('hidden');

    // Chapter 1's stealth system and cast stand down.
    stealth.stop();
    stealth.guards.forEach((g) => {
      g.takeover();
      g.lightOff();
      g.aimOverride = null;
      g.mark.visible = false;
    });
    const { coach, coachLage, coachTom, ben, runners, students } = world.npcs;
    [...runners, ...students, coach, coachLage, coachTom].forEach((npc) => {
      npc.cancelExit = true;
      npc.stop();
      npc.faceTowards(null);
      npc.mesh.visible = false;
    });
    ben.cancelExit = true;
    ben.stop();
    ben.faceTowards(null);
    const rig = ben.mesh.userData.rig;
    if (rig.seated) standUp(ben.mesh);
    rig.crouch = false;
    ben.mesh.visible = false;
    world.doors.rear.opened = false;
    world.doors.rear.npcHold = 0;

    this._blackout();
    if (!this.builtGrounds) this._buildGrounds();
    const car = world.playersCar;
    car.visible = true;
    car.position.set(CAR.x, 0, CAR.z);
    car.rotation.set(0, CAR.yaw, 0);
    car.updateMatrixWorld(true);
    this._rebuildBoxes();
    this._placeRockPiles();
    this._lightPower = 14;
    player.setColliders([...world.colliders, ...this._boundaryWalls, ...this._propColliders]);
    player.setInteractables([]);
    player.setCharacters([]);
    ui.setFlashlight(false);
    this.director.camMove = null;
    this.director.zoom = null;
    camera.fov = 75;
    camera.updateProjectionMatrix();
    player.crouching = false;
    player.movementFrozen = false;
    player.clearStumble();
    player.setLookTarget(null);
    player.setCameraOverride(true);
    const start = PLAYER_START;
    this.checkpoint = { pos: start.pos.clone(), yaw: start.yaw };
  }

  /** Every light and glowing thing on the campus goes out. (The flashlight rides on the camera, which is skipped.) */
  _blackout() {
    const skip = this.camera;
    const walk = (obj) => {
      if (obj === skip) return;
      if (obj.isPointLight || obj.isSpotLight) obj.intensity = 0;
      if (obj.isMesh && obj.material) {
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          if (m.emissive && m.emissiveIntensity > 0.05 && m.emissive.getHex() !== 0) m.emissiveIntensity = 0.03;
        }
      }
      for (const child of obj.children) walk(child);
    };
    walk(this.scene);
  }

  _buildGrounds() {
    this.builtGrounds = true;
    const { world, scene } = this;
    this.nav = new NavGrid({ minX: -70, maxX: 66, minZ: -126, maxZ: -30, cell: 0.9, inflate: 0.5 });
    this.storm = new StormRain(scene, this.camera);
    // Lightning: a directional flash and an ambient wash, both dark until it strikes.
    this.lightning = {
      dir: new THREE.DirectionalLight(0xcfe0ff, 0),
      fill: new THREE.AmbientLight(0x8aa0c8, 0),
      t: rand(4, 8),
      flash: null,
    };
    this.lightning.dir.position.set(-20, 60, -40);
    scene.add(this.lightning.dir, this.lightning.fill);

    this.van = buildVan(scene);
    this.arm = new ArmChain(scene);
    this.vanCollider = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.3, 6), new THREE.MeshBasicMaterial({ visible: false }));
    this.vanCollider.position.set(VAN.x, 1.15, VAN.z);
    this.vanCollider.updateMatrixWorld(true);
    this._propColliders.push(this.vanCollider);

    // The car's trunk: a lid that swings up, and the emergency kit inside.
    const car = world.playersCar;
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.84, -1.25);
    car.add(lidPivot);
    const lidGeo = new THREE.BoxGeometry(1.7, 0.05, 0.85);
    lidGeo.translate(0, 0, -0.425);
    lidPivot.add(new THREE.Mesh(lidGeo, new THREE.MeshStandardMaterial({ color: 0x232323, metalness: 0.5, roughness: 0.4 })));
    const kit = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.24, 0.36), new THREE.MeshStandardMaterial({ color: 0x2f4a2a, roughness: 0.8 }));
    kit.position.set(0, 0.95, -1.65);
    car.add(kit);
    // The dome light inside the cabin (dark except in the opening, so the light count never changes mid-game).
    this.domeLight = new THREE.PointLight(0xffd9a0, 0, 7, 2);
    this.domeLight.position.set(0, 1.26, 0.05);
    car.add(this.domeLight);
    const trunkHitbox = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.3), new THREE.MeshBasicMaterial({ visible: false }));
    trunkHitbox.position.set(CAR.x, 0.9, CAR.z - 1.7);
    trunkHitbox.userData = { interactable: true, label: 'Take the emergency flashlight', type: 'sc-trunk' };
    scene.add(trunkHitbox);
    // The trunk bulb: the one warm thing on the whole dark lot until the kit is taken.
    this.trunkLight = new THREE.PointLight(0xffe2b0, 0, 6, 2);
    this.trunkLight.position.set(0, 1.05, -1.75);
    car.add(this.trunkLight);
    this.trunk = {
      lidPivot,
      kit,
      hitbox: trunkHitbox,
      setOpen: (k) => {
        lidPivot.rotation.x = 1.2 * k;
        this.trunkLight.intensity = 3.4 * k;
      },
    };
    this.trunk.setOpen(0);

    // The clues.
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: 0x6d5a3e, roughness: 0.9 }));
    crate.position.set(CLUE_DEFS[1].x, 0.45, CLUE_DEFS[1].z);
    crate.rotation.y = 0.3;
    crate.updateMatrixWorld(true);
    scene.add(crate);
    this._propColliders.push(crate);
    const models = { phone: buildPhone(), keycard: buildKeycard(), fuse: buildFuse() };
    const glows = { phone: 'rgba(90,220,255,1)', keycard: 'rgba(90,255,150,1)', fuse: 'rgba(255,190,80,1)' };
    for (const def of CLUE_DEFS) this.clues[def.id] = { def, ...makeClue(scene, def, models[def.id], glows[def.id]) };
    // The fuse hides in a utility cabinet: a little door that swings open.
    const cab = CLUE_DEFS[2];
    const doorPivot = new THREE.Group();
    doorPivot.position.set(cab.x - 0.46, 0, cab.z + 0.42);
    scene.add(doorPivot);
    const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.3, 0.04), new THREE.MeshStandardMaterial({ color: 0x59636c, metalness: 0.6, roughness: 0.5 }));
    doorLeaf.position.set(0.46, 0.75, 0);
    doorPivot.add(doorLeaf);
    this.cabinetDoor = doorPivot;
    this.clues.fuse.model.visible = false; // (it appears when the cabinet opens)
    this.clues.fuse.group.position.set(cab.x, 0, cab.z + 0.6 - 0.9);
    this.clues.fuse.model.position.y = 1.15;
    this.clues.fuse.hitbox.position.set(cab.x, 1.0, cab.z + 0.3);
    this.clues.fuse.hitbox.userData.label = 'Open the utility cabinet';

    this.hatch = buildHatch(scene);
    this._propColliders.push(this.hatch.collider);

    // The edge of the campus: invisible walls, only for you (Chapter 3's: you're not leaving Ben behind).
    const B = BOUNDS;
    const wall = (x0, x1, z0, z1) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 4, z1 - z0));
      mesh.position.set((x0 + x1) / 2, 2, (z0 + z1) / 2);
      mesh.name = 'sc-boundary';
      mesh.updateMatrixWorld(true);
      return mesh;
    };
    this._boundaryWalls = [
      wall(B.minX - 1, B.maxX + 1, B.minZ - 1, B.minZ),
      wall(B.minX - 1, B.minX, B.minZ - 1, B.northWest + 1),
      wall(B.maxX, B.maxX + 1, B.minZ - 1, B.northEast + 1),
      wall(B.minX - 1, -B.schoolHalf + 0.2, B.northWest, B.northWest + 1),
      wall(B.schoolHalf - 0.2, B.maxX + 1, B.northEast, B.northEast + 1),
    ];

    // Rocks: a few in flight (or lying where they landed) at once, pooled. (The piles you restock
    // from go down once the nav grid exists: _placeRockPiles.)
    this._stoneMat = new THREE.MeshStandardMaterial({ color: 0x7d8286, roughness: 0.95 });
    this._rockGeo = new THREE.DodecahedronGeometry(0.07, 0);
    this.rockPool = Array.from({ length: 4 }, () => {
      const mesh = new THREE.Mesh(this._rockGeo, this._stoneMat);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), live: false, rest: 0 };
    });
    // Coach Billing, out in the storm: there for the instant of a lightning strike, then gone.
    const ghost = createHumanoid(COACH_BILLING_LOOK);
    ghost.name = 'sc-apparition';
    ghost.visible = false;
    ghost.position.set(0, -60, 0);
    scene.add(ghost);
    this.apparition = { mesh: ghost, active: false, shown: 0, nextAt: Infinity };

    // The Rogue Scrappers (asleep until you have the flashlight).
    const count = difficulty.hard ? 5 : 4;
    this.scrappers = SCRAPPER_STARTS.slice(0, count).map(([x, z], i) => {
      const s = new Scrapper(this, i);
      s.place(x, z, rand(0, Math.PI * 2));
      return s;
    });
    // Build the shaders now (behind the black card).
    for (const s of this.scrappers) s.mark.visible = true;
  }

  _rebuildBoxes() {
    this._colliderBoxes = [...this.world.colliders, ...this._propColliders]
      .map((o) => this._boxOf(o))
      .filter((b) => b.max.y > 0.3 && b.min.y < 1.5 && b.max.x - b.min.x < 60);
    if (this.nav) this.nav.build(this._colliderBoxes);
  }

  /** The rock piles, each snapped onto open ground (built once, after the nav grid). */
  _placeRockPiles() {
    if (this.rockPiles.length || !this.nav) return;
    const glowTex = glowTexture('rgba(205,215,228,1)');
    for (const [x0, z0] of ROCK_PILES) {
      const cell = this.nav.nearestFree(this.nav.cellOf(x0, z0));
      if (cell < 0) continue;
      const c = this.nav._center(cell, new THREE.Vector3());
      const group = new THREE.Group();
      group.position.set(c.x, 0, c.z);
      group.name = 'sc-rock-pile';
      this.scene.add(group);
      for (let i = 0; i < 7; i++) {
        const s = new THREE.Mesh(this._rockGeo, this._stoneMat);
        s.scale.setScalar(rand(0.9, 1.7));
        s.position.set(rand(-0.24, 0.24), 0.05, rand(-0.24, 0.24));
        s.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
        group.add(s);
      }
      // A faint pale glint, so you can find them in the dark (like the clues, only dimmer).
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.3 }));
      glow.scale.set(0.8, 0.8, 1);
      glow.position.y = 0.18;
      group.add(glow);
      const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), new THREE.MeshBasicMaterial({ visible: false }));
      hitbox.position.set(c.x, 0.35, c.z);
      this.scene.add(hitbox);
      const pile = { group, glow, hitbox, left: ROCK.pile };
      hitbox.userData = { interactable: true, label: 'Pick up rocks', type: 'sc-rocks', pile };
      this.rockPiles.push(pile);
    }
  }

  /** Everything you can [E] on the grounds once you have the light: clues, the hatch, rock piles. */
  _groundTargets() {
    return [...this._clueHitboxes(), this.hatch.hitbox, ...this.rockPiles.filter((p) => p.left > 0).map((p) => p.hitbox)];
  }

  _takeRocks(pile) {
    if (pile.left <= 0) return;
    if (this.rocks >= ROCK.max) {
      this.ui.showMessage(`Your pockets are full (${ROCK.max} rocks).`, 1600);
      return;
    }
    const n = Math.min(pile.left, ROCK.max - this.rocks);
    pile.left -= n;
    this.rocks += n;
    playPickup();
    if (pile.left <= 0) {
      pile.group.visible = false;
      pile.hitbox.userData.interactable = false;
    }
    this.player.setInteractables(this._groundTargets());
    this.player.currentTarget = null;
    this.ui.setPrompt(null);
    this._refreshRocks(true);
    this.ui.showMessage(`+${n} rock${n > 1 ? 's' : ''}. [RMB] throws one: Scrappers go after the noise.`, 2600);
  }

  _refreshRocks(bump = false) {
    const el = this.hud.rocks;
    this.hud.rocksCount.textContent = String(this.rocks);
    el.classList.toggle('empty', this.rocks <= 0);
    if (bump) {
      el.classList.remove('bump');
      void el.offsetWidth; // (restart the little flash)
      el.classList.add('bump');
    }
  }

  /** [RMB]: lob a rock where you're looking. Wherever it lands, it clatters, and they come to look. */
  _throwRock() {
    if (this.rocks <= 0) {
      this.ui.showMessage('No rocks left: grab some from a pile.', 1600);
      return;
    }
    const r = this.rockPool.find((k) => !k.live && k.rest <= 0) || this.rockPool.find((k) => !k.live);
    if (!r) return;
    this.rocks--;
    this._refreshRocks();
    const fwd = _v1.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    r.pos.copy(this.camera.position).addScaledVector(fwd, 0.45);
    r.pos.y -= 0.15;
    r.vel.copy(fwd).multiplyScalar(ROCK.speed);
    r.vel.y += ROCK.lift;
    r.live = true;
    r.rest = 0;
    r.mesh.visible = true;
    r.mesh.position.copy(r.pos);
    playBottleThrow();
  }

  _updateRocks(dt) {
    for (const r of this.rockPool) {
      if (!r.live) {
        if (r.rest > 0) {
          r.rest -= dt;
          if (r.rest <= 0) r.mesh.visible = false;
        }
        continue;
      }
      r.vel.y -= ROCK.gravity * dt;
      _v2.copy(r.pos);
      r.pos.addScaledVector(r.vel, dt);
      r.mesh.rotation.x += dt * 11;
      r.mesh.rotation.z += dt * 7;
      let hit = r.pos.y <= 0.06;
      if (!hit) {
        for (const b of this._colliderBoxes) {
          if (b.containsPoint(r.pos)) {
            hit = true;
            r.pos.copy(_v2); // (off a wall or a prop: it drops where it struck)
            break;
          }
        }
      }
      if (hit) {
        r.live = false;
        r.rest = ROCK.rest;
        r.pos.y = 0.06;
        this._rockLanded(r.pos);
      }
      r.mesh.position.copy(r.pos);
    }
  }

  _rockLanded(pos) {
    const p = this.player.object.position;
    playRockClatter(1.1 - Math.hypot(pos.x - p.x, pos.z - p.z) / 35);
    if (this._noise(pos, ROCK.hearRadius) && !this._rockHeardShown) {
      this._rockHeardShown = true;
      this.ui.showMessage('It heard that! Slip past while it goes to look.', 2400);
    }
  }

  /** A noise at `pos`: every Scrapper within `radius` (not already after you) goes to look. How many did. */
  _noise(pos, radius) {
    let heard = 0;
    for (const s of this.scrappers) {
      if (Math.hypot(s.position.x - pos.x, s.position.z - pos.z) <= radius && s.hearNoise(pos)) heard++;
    }
    return heard;
  }

  /** Billing on the campus PA (it runs off the battery backup): a crackle, then his voice across the field. */
  _taunt(line) {
    if (this.location !== 'grounds' || this.dialogue.active || this.cutscene) return false;
    playPA();
    this.dialogue.say('Coach Billing (campus PA)', line, { hold: 2.8 });
    return true;
  }

  /** Every minute or so, while nobody's chasing you, he gets on the PA. */
  _updatePA(dt) {
    this._paT -= dt;
    if (this._paT > 0) return;
    if (this.dialogue.active || this.scrappers.some((s) => s.state === 'chase' || s.state === 'alert')) {
      this._paT = 3;
      return;
    }
    if (!this._paOrder.length) this._paOrder = PA_TAUNTS.map((_, i) => i).sort(() => Math.random() - 0.5);
    this._taunt(PA_TAUNTS[this._paOrder.pop()]);
    this._paT = rand(55, 80);
  }

  /**
   * Proximity: with a Scrapper close by you hear your own pulse (faster the closer it is), and
   * its servos foul up the emergency light: the beam stutters. A warning, before you see it.
   */
  _updateTension(dt) {
    const p = this.player.object.position;
    let nearest = Infinity;
    for (const s of this.scrappers) {
      if (s.thinking) nearest = Math.min(nearest, Math.hypot(s.position.x - p.x, s.position.z - p.z));
    }
    this._beatT -= dt;
    if (nearest < 11 && this._beatT <= 0) {
      this._beatT = 0.45 + nearest * 0.07;
      playHeartbeat(Math.min(1, 1.15 - nearest / 11));
    }
    const chased = this.scrappers.some((s) => s.state === 'chase' || s.state === 'alert');
    let power = 14;
    if (nearest < 9 && !chased) {
      this._flickT -= dt;
      if (this._flickT <= 0) {
        this._flickT = rand(0.05, 0.16);
        this._flicker = Math.random() < 0.3 + (1 - nearest / 9) * 0.4 ? rand(0.08, 0.5) : 1;
      }
      power *= this._flicker;
    }
    this._setLightPower(power);
  }

  _setLightPower(power) {
    if (power === this._lightPower) return;
    this._lightPower = power;
    this.ui.setFlashlightPower(power);
  }

  /** On a lightning strike: maybe he's out there, 17-25m ahead of you in the open (twice at most). */
  _maybeApparition() {
    const a = this.apparition;
    if (!a || this.phase !== 'evade' || this.cutscene || a.shown >= 2 || this.time < a.nextAt) return;
    if (this.scrappers.some((s) => s.state === 'chase' || s.state === 'alert')) return;
    const p = this.player.object.position;
    const f = _v1.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const heading = Math.atan2(f.x, f.z);
    for (let i = 0; i < 14; i++) {
      const ang = heading + rand(-0.32, 0.32);
      const r = rand(17, 25);
      const x = p.x + Math.sin(ang) * r;
      const z = p.z + Math.cos(ang) * r;
      if (x < BOUNDS.minX + 3 || x > BOUNDS.maxX - 3 || z < BOUNDS.minZ + 3 || z > -40) continue;
      if (!this.nav.isFree(x, z) || !this.nav.lineClear(p.x, p.z, x, z)) continue;
      a.mesh.position.set(x, 0, z);
      a.mesh.rotation.y = Math.atan2(p.x - x, p.z - z);
      a.active = true;
      a.shown++;
      a.nextAt = this.time + rand(80, 120);
      return;
    }
  }

  /** The strike's over, and so is he. Then a whistle, faint, somewhere out in the dark. */
  _apparitionGone() {
    const a = this.apparition;
    a.active = false;
    a.mesh.visible = false;
    a.mesh.position.set(0, -60, 0);
    const first = a.shown === 1;
    this.wait(0.6).then(() => {
      if (this.phase !== 'evade') return;
      playWhistle({ far: true });
      if (first) this.dialogue.say('', 'For a heartbeat someone was standing out there in the rain, watching you. Then only the dark.', { style: 'narration', hold: 2.8 });
      else this._queueTaunt('Did you see me, Ben? Because I see YOU.', 1.4);
    });
  }

  // ---- The opening ---------------------------------------------------------------------------

  async _playOpening() {
    const { director, dialogue, wait, player, world, camera } = this;
    const ben = world.npcs.ben;
    const car = world.playersCar;
    this.phase = 'opening';
    this.cutscene = true;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    player.crouching = false;
    player.eyeHeight = 1.7;

    // Over black: the emergency broadcast.
    director.fader.set(1);
    setRainExposure(0.6);
    playRadioStatic(13);
    await wait(0.7);
    await dialogue.say('Emergency Radio', 'All units, all units. Coach Billing has escaped county transit.', { hold: 2.6 });
    await dialogue.say('Emergency Radio', 'He has hijacked a maintenance vehicle: dark grey van, no plates.', { hold: 2.6 });
    await dialogue.say('Emergency Radio', 'Last seen heading for Hall High School. Do not approach. He is extremely dangerous.', { hold: 3.0 });
    await dialogue.say('Emergency Radio', '...and may be accompanied by robotic units. Repeat: robotic units.', { hold: 2.6 });

    // Fade up: the passenger seat, rain sheeting down the glass. Other Ben's behind the wheel.
    ben.stop();
    ben.mesh.visible = true;
    ben.mesh.position.copy(car.localToWorld(DRIVER_SEAT.clone()));
    ben.mesh.rotation.y = car.rotation.y;
    if (!ben.mesh.userData.rig.seated) setSeatedPose(ben.mesh);
    world.rain.exposureOverride = 0.4;
    this.domeLight.intensity = 2.0;
    const neck = ben.mesh.userData.rig.neck;
    neck.rotation.y = 0;
    this._place(car.localToWorld(PASSENGER_EYE.clone()), car.localToWorld(new THREE.Vector3(-0.42, 1.0, 30)));
    await director.fader.to(0, 1.8);
    await dialogue.say('Other Ben', "That's the third time they've said it. He's OUT, dude.", { hold: 2.2 });
    // You glance across at him, and he turns to you.
    player.setLookTarget(() => ben.headPosition(this._tmp));
    this._anim(0.45, (k) => (neck.rotation.y = -1.0 * smooth(k)));
    await dialogue.say('Other Ben', "Where would he go? Where he lives. This school. This track. This whole miserable field.", { hold: 3.0 });
    await dialogue.say('Other Ben', "Emergency kit's in the trunk: flashlight, batteries. Sit tight.", { hold: 2.4 });

    // He steps out and walks around to the trunk; you climb out too and watch from beside the car.
    playCarDoor();
    await director.fader.to(1, 0.3);
    neck.rotation.y = 0;
    standUp(ben.mesh);
    ben.mesh.position.copy(car.localToWorld(new THREE.Vector3(1.6, 0, -0.45)));
    ben.mesh.rotation.y = -Math.PI / 2;
    this._place(new THREE.Vector3(PLAYER_START.pos.x, 1.7, PLAYER_START.pos.z), () => ben.headPosition(this._tmp));
    world.rain.exposureOverride = null; // (out in the rain now)
    await director.fader.to(0, 0.35);
    ben.walkRoute([{ x: CAR.x + 1.7, z: CAR.z - 3.0 }, { x: CAR.x + 1.7, z: BEN_TRUNK.z }, { x: BEN_TRUNK.x, z: BEN_TRUNK.z }], 1.7);
    await wait(3.4);
    ben.faceTowards(new THREE.Vector3(CAR.x, 0, CAR.z - 2.2));
    playCarDoor();
    await this._anim(0.7, (k) => this.trunk.setOpen(smooth(k)));
    ben.mesh.userData.rig.reach = true;
    await dialogue.say('Other Ben (muttering)', "Flashlight... flashlight... I swear it was right under the...", { hold: 2.4 });

    // A flash of lightning: there's a van out there in the dark, and its door is sliding open.
    this._flash(1.3);
    player.setLookTarget(new THREE.Vector3(-62.5, 1.3, -77));
    await wait(0.7);
    playDoorSlide();
    const mouth = this.van.mouth(new THREE.Vector3());
    await this._anim(0.5, (k) => this.van.setDoor(k));
    await dialogue.say('Other Ben', "...Ben? Is that a... van?", { hold: 1.5 });

    // The arm.
    const target = new THREE.Vector3(BEN_TRUNK.x, 1.15, BEN_TRUNK.z);
    playArmLunge();
    this._flash(1.0);
    const hand = new THREE.Vector3();
    await this._anim(0.22, (k) => {
      hand.lerpVectors(mouth, target, 1 - (1 - k) * (1 - k));
      this.arm.set(mouth, hand, 0.15);
    });
    ben.mesh.userData.rig.reach = false;
    ben.stop();
    dialogue.say('Other Ben', 'WHAT THE— BEN!! BEN—!!', { hold: 1.2 });
    await this._anim(0.85, (k) => {
      const e = k * k;
      hand.lerpVectors(target, mouth, e);
      this.arm.set(mouth, hand, 0.3 * (1 - e));
      ben.mesh.position.set(hand.x, Math.max(0, hand.y - 1.15) * 0.8, hand.z);
      ben.mesh.rotation.y += 0.08;
    });
    ben.mesh.visible = false;
    this.arm.hide();
    await this._anim(0.3, (k) => this.van.setDoor(1 - k));
    playMetalDoorSlam();
    this._shake(0.4, 0.03);

    // The van pulls away; a horn on its roof crackles with Billing's voice.
    this.van.setTailLights(true);
    playEngineRoar(2.6);
    await wait(0.5);
    playTireScreech(1.0);
    playPA();
    const drive = this._anim(5.2, (k) => {
      const e = k * k;
      this.van.group.position.z = VAN.z + e * 70;
      this.van.wheels.forEach((w) => (w.rotation.x -= 0.6));
    });
    await wait(0.8);
    await dialogue.say('Coach Billing (van speaker)', "Report to the boiler room, Ben. Let's see if you can pass my final exam.", { hold: 3.6 });
    await drive;
    this.van.group.visible = false;
    this.van.setTailLights(false);
    const vi = this._propColliders.indexOf(this.vanCollider);
    if (vi !== -1) this._propColliders.splice(vi, 1);
    this._rebuildBoxes();
    player.setColliders([...this.world.colliders, ...this._boundaryWalls, ...this._propColliders]);
    // Silence. The cabin light times out; only the trunk bulb is left burning.
    player.setLookTarget(new THREE.Vector3(BEN_TRUNK.x, 0.85, BEN_TRUNK.z));
    this.domeLight.intensity = 0;
    await dialogue.say('', 'Silence. The rain. The trunk gapes open. He is gone.', { style: 'narration', hold: 2.0 });

    // Your move: alone in the dark.
    player.teleport(PLAYER_START.pos, PLAYER_START.yaw, -0.05);
    this._restoreGameplay();
    this.phase = 'evade0';
    player.setInteractables([this.trunk.hitbox]);
    this.ui.setObjective('Find Other Ben.', [
      { label: 'Take the emergency flashlight from the trunk', done: false },
    ]);
    this.ui.showMessage('Blackout. The whole campus is dark.', 3000);
  }

  /** Lightning: a double flash, and the crack. */
  _flash(strength = 1) {
    if (!this.lightning) return;
    // The bolt always lands somewhere behind you, so whatever you're looking at gets lit head-on.
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.lightning.dir.position.set(-f.x * 30 + rand(-18, 18), 55, -f.z * 30 + rand(-18, 18));
    this.lightning.flash = { t: 0, strength };
    playLightning();
  }

  _updateLightning(dt) {
    const L = this.lightning;
    if (!L) return;
    L.t -= dt;
    if (L.t <= 0 && this.phase !== 'opening') {
      L.t = rand(7, 16);
      this._flash(rand(0.7, 1.2));
      this._maybeApparition();
    }
    let level = 0;
    if (L.flash) {
      const t = (L.flash.t += dt);
      level = t < 0.07 ? 1 : t < 0.13 ? 0.12 : t < 0.27 ? 0.12 + 0.88 * (1 - (t - 0.13) / 0.14) : t < 0.55 ? 0.12 * (1 - (t - 0.27) / 0.28) : 0;
      level *= L.flash.strength;
      if (t > 0.55) L.flash = null;
    }
    L.dir.intensity = level * 3.4;
    L.fill.intensity = level * 0.9;
    // The whole sky flares with it (the fog too): anything standing out there is a shape against it.
    if (level > 0 || this._skyLevel > 0) {
      this._skyLevel = level;
      this.scene.background.copy(BLACKOUT_SKY).lerp(LIGHTNING_SKY, Math.min(1, level));
      this.scene.fog.color.copy(this.scene.background);
    }
    // The apparition is only ever there while the sky's lit.
    const a = this.apparition;
    if (a && a.active) {
      a.mesh.visible = level > 0.08;
      if (!L.flash) this._apparitionGone();
    }
  }

  // ---- The blackout: clues, Rogue Scrappers ------------------------------------------------------

  _takeKit() {
    if (this.kitTaken) return;
    this.kitTaken = true;
    this.trunkLight.intensity = 0; // the bulb dies with the kit: back to full dark
    playPickup();
    this.ui.setFlashlight(true);
    this.trunk.hitbox.userData.label = 'The trunk (empty)';
    this.phase = 'evade';
    // A couple of rocks from the gravel by the car, too.
    this.rocks = ROCK.start;
    this._refreshRocks();
    this.hud.rocks.classList.remove('hidden');
    this.player.setInteractables(this._groundTargets());
    this._paT = 32; // (his first word on the PA)
    if (this.apparition) this.apparition.nextAt = this.time + 40;
    this._refreshObjective();
    this.stealth.meterEl.classList.remove('hidden');
    this.ui.showMessage('Emergency flashlight: [F] toggles it. It shows you the way... and shows THEM you.', 4200);
    this.wait(2.5).then(() => {
      if (this.phase === 'evade') this.scrappers.forEach((s) => s.wake());
    });
    this.wait(4.8).then(() => {
      if (this.phase === 'evade') this.ui.showMessage('You pocket two rocks from the gravel. [RMB] throws one: Scrappers go after the noise.', 3800);
    });
  }

  _clueHitboxes() {
    return Object.values(this.clues).filter((c) => !c.taken).map((c) => c.hitbox);
  }

  _refreshObjective() {
    const c = this.collected;
    this.ui.setObjective('Find Other Ben: search the campus for clues.', [
      ...CLUE_DEFS.map((d) => ({ label: `${d.label} (${d.where})`, done: c.has(d.id) })),
      { label: 'Rogue Scrappers hunt by sight AND sound', tip: true },
      { label: 'Your flashlight lets you see... and lets them see you from twice as far', tip: true },
      { label: '[C] crouch to creep past. Break their line of sight to lose them', tip: true },
      { label: '[RMB] throw a rock to draw them off. The light stutters when one is close', tip: true },
    ]);
  }

  _pickClue(id) {
    const clue = this.clues[id];
    if (!clue || clue.taken) return;
    if (id === 'fuse' && !this.cabinetOpen) {
      // First the cabinet: the door swings open (loudly), and the fuse is right there.
      this.cabinetOpen = true;
      playHideCreak('door');
      this._anim(0.6, (k) => (this.cabinetDoor.rotation.y = -1.9 * smooth(k)));
      clue.model.visible = true;
      clue.hitbox.userData.label = `Pick up: ${clue.def.label}`;
      this.player.currentTarget = null;
      this.ui.setPrompt(null); // (the DOM prompt only clears through this)
      if (this._noise(clue.hitbox.position, PICKUP_NOISE + 2)) this.ui.showMessage('The cabinet door shrieks on its hinges. Something heard that...', 2600);
      return;
    }
    clue.taken = true;
    clue.group.visible = false;
    clue.hitbox.userData.interactable = false;
    this.collected.add(id);
    playPickup();
    this.player.setInteractables(this._groundTargets());
    this.player.currentTarget = null;
    this.ui.setPrompt(null); // (the DOM prompt only clears through this)
    const heard = this._noise(clue.hitbox.position, PICKUP_NOISE) > 0; // (rummaging for it isn't quiet)
    const p = this.player.object.position;
    this.checkpoint = { pos: new THREE.Vector3(p.x, 0, p.z), yaw: this.player.getYaw() };
    this._refreshObjective();
    const lines = {
      phone: ["A cracked screen. One unsent message: \"boiler room. He said BOILER ROOM. keycard's on the shed crate, fuse in the cabinet by the lot. b\"", 'phone'],
      keycard: ['A maintenance keycard: "B. ROOM · LEVEL 1". Billing\'s handwriting on the back: "Nice try."', 'keycard'],
      fuse: ["A heavy bypass fuse. It'll bring the hatch's reader back to life.", 'fuse'],
    };
    const line = lines[id];
    if (line) this.dialogue.say('', line[0], { style: 'narration', hold: 3.4 });
    const warn = heard ? ' Something heard that...' : '';
    if (this.collected.size >= CLUE_DEFS.length) {
      this.ui.showMessage(`That is all three. The boiler room hatch is beside the school.${warn}`, 4200);
      this.hatch.hitbox.userData.label = 'Enter the boiler room';
      this.hatch.drawReader(['CARD OK', 'POWER ON'], '#3cff7a');
      this.hatch.lamp.material.color.setHex(0x3cff7a);
      this._queueTaunt("That's all three. Come down to the boiler room, Ben. Don't keep your friend waiting.", 4.2);
    } else {
      this.ui.showMessage(`Clue ${this.collected.size} of ${CLUE_DEFS.length}: ${clue.def.label}.${warn}`, 2800);
      if (this.collected.size === 1) this._queueTaunt('Found something, Ben? Good. Keep looking. I love watching you look.', 4.2);
    }
  }

  /** A PA line after `delay` seconds, as soon as nobody else is talking (it gives up after a while). */
  _queueTaunt(line, delay = 0, tries = 8) {
    this.wait(delay).then(() => {
      if (this.phase !== 'evade' && this.phase !== 'caught') return;
      if (!this._taunt(line) && tries > 0) this._queueTaunt(line, 1.5, tries - 1);
    });
  }

  _useHatch() {
    if (this.collected.size < CLUE_DEFS.length) {
      const missing = CLUE_DEFS.filter((d) => !this.collected.has(d.id)).map((d) => d.label.toLowerCase());
      this.ui.showMessage(`The reader is dead. Still missing: ${missing.join(', ')}.`, 3200);
      return;
    }
    if (this.scrappers.some((s) => s.state === 'alert' || s.state === 'chase')) {
      this.ui.showMessage("You can't work the hatch with a Scrapper on your tail! Break its line of sight first.", 3000);
      return;
    }
    if (this.phase === 'evade') this._enterBoiler();
  }

  /** A Rogue Scrapper locked onto you. */
  onScrapperAlert() {
    if (!this._firstAlert) {
      this._firstAlert = true;
      this.ui.showMessage('A Rogue Scrapper has spotted you! Break its line of sight!', 3000);
    }
  }

  /** One of them got its hands on you. */
  async _capture(by) {
    if (this.phase !== 'evade' || this.caught) return;
    this.caught = true;
    this.deaths = (this.deaths || 0) + 1;
    this.phase = 'caught';
    this.cutscene = true;
    const { player, director, wait } = this;
    this.scrappers.forEach((s) => s.freeze());
    this._setLightPower(14); // (no stutter frozen into the capture)
    player.setInputLocked(true);
    player.setLookTarget(() => by.eye());
    playWhistle();
    playCaughtStinger();
    await wait(0.9);
    await director.fader.to(1, 0.35);
    this._showCaught('CAUGHT', 'BACK TO THE LAST CHECKPOINT');
    await wait(1.7);
    this._resetToCheckpoint();
    this.hud.caught.classList.remove('show');
    await wait(0.4);
    await director.fader.to(0, 0.6);
    player.setInputLocked(false);
    this.cutscene = false;
    this.phase = 'evade';
    this.caught = false;
    this.scrappers.forEach((s) => s.wake());
    this.ui.showMessage('The Scrappers are back on the hunt. Stay low, stay quiet.', 3000);
    if (this.deaths === 1 || Math.random() < 0.5) this._queueTaunt(this.deaths === 1 ? 'Again. From the top. Just like practice.' : 'Sloppy, Ben. Run it again.', 3.4);
  }

  _resetToCheckpoint() {
    const { player } = this;
    const cp = this.checkpoint;
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.movementFrozen = false;
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(cp.pos, cp.yaw, 0.02);
    // Everyone restarts far from you.
    const far = SCRAPPER_STARTS.map(([x, z]) => ({ x, z, d: Math.hypot(x - cp.pos.x, z - cp.pos.z) })).sort((a, b) => b.d - a.d);
    this.scrappers.forEach((s, i) => {
      const spot = far[i % far.length];
      s.place(spot.x, spot.z, rand(0, Math.PI * 2));
    });
  }

  // ---- The hatch: down to the boiler room ---------------------------------------------------------

  async _enterBoiler() {
    const { player, director, dialogue, wait, camera } = this;
    this.phase = 'descend';
    this.cutscene = true;
    this.scrappers.forEach((s) => s.freeze());
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    this.stealth.meterEl.classList.add('hidden');
    this.hud.rocks.classList.add('hidden');
    this._setLightPower(14);
    if (this.apparition && this.apparition.active) this._apparitionGone();
    player.setInteractables([]);
    player.setInputLocked(true);
    player.setCameraOverride(true);
    player.crouching = false; // (a capture checkpoint leaves you crouched)
    player.eyeHeight = 1.7;
    const front = new THREE.Vector3(HATCH.x, 1.6, HATCH.z - 2.9);
    player.setLookTarget(new THREE.Vector3(HATCH.x, 0.4, HATCH.z));
    await director.moveCamera([front], [Math.max(0.5, camera.position.distanceTo(front) / 3)]);
    playBeep(1400, 0.1, 0.12);
    await wait(0.4);
    playMechanism(1.2);
    await this._anim(1.2, (k) => this.hatch.setOpen(smooth(k)));
    await dialogue.say('', 'The reader chirps. The fuse hums. The hatch grinds open onto a black stairwell.', { style: 'narration', hold: 2.0 });
    await director.fader.to(1, 0.9);
    this._loadUnderground();
    const ug = this.ug;
    ug.gallery.stairDoor.set(1); // open: you're coming down the stairs
    this._place(new THREE.Vector3(0, 4.7, 40.4), new THREE.Vector3(0, 1.5, 12));
    await director.fader.to(0, 0.7);
    playLadderStep(0.9);
    await director.moveCamera([new THREE.Vector3(0, 1.75, 27.8)], [4.4]);
    // The door swings shut behind you.
    player.teleport(new THREE.Vector3(0, 0, 24.4), 0, 0);
    player.setCameraOverride(true);
    this._place(new THREE.Vector3(0, 1.7, 24.4), new THREE.Vector3(0, 1.4, 5));
    ug.gallery.stairDoor.move(0, 0.4, 'in').then(() => {
      playMetalDoorSlam();
      this._shake(0.3, 0.02);
      this._setColliders();
    });
    await wait(0.9);
    await dialogue.say('', 'The boiler room. Somewhere below the gym. Hot, loud, and dark.', { style: 'narration', hold: 2.0 });
    this._restoreGameplay();
    this.location = 'underground';
    this.phase = 'gallery';
    this._setColliders();
    player.setInteractables([]);
    this.ui.setObjective('Find Other Ben.', [{ label: 'Follow the light through the doorway ahead', tip: true }]);
  }

  /** The underground scene, built behind the black. */
  _loadUnderground() {
    if (this.ug) {
      this.location = 'underground';
      this.ui.setScene(this.ug.scene);
      setUnderground(true);
      return;
    }
    this.ug = buildUnderground();
    this.ug.beams.onZap = (beam) => this._onZap(beam);
    this.location = 'underground';
    this.ui.setScene(this.ug.scene);
    setUnderground(true);
    setRainExposure(0);
    this.ui.setFlashlight(true);
    this.ug.gallery.blast.set(0);
    this.ug.hall.furnaceDoor.set(0);
    this.renderer.compile(this.ug.scene, this.camera);
  }

  /** The player's solid things underground (the blast door and the stair door once they're shut). */
  _setColliders() {
    const ug = this.ug;
    if (!ug) return;
    const list = ug.colliders.slice();
    if (ug.gallery.blast.value > 0.5) list.push(ug.solids.blast);
    if (ug.gallery.stairDoor.value < 0.5) list.push(ug.solids.stairs);
    if (ug.puzzle.door.value < 0.5) list.push(ug.solids.lock);
    this.player.setColliders([...list, ...ug.podBlocks]); // (the pod recesses are for units only)
    if (this.combat) this._refreshCombatWorld(list);
  }

  // ---- The cliffhanger ------------------------------------------------------------------------------

  async _playCliffhanger() {
    const { player, director, dialogue, wait } = this;
    const ug = this.ug;
    const ben = ug.ben;
    this.phase = 'cliff';
    this.cutscene = true;
    this.ui.hideObjective();
    player.setInputLocked(true);
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await wait(0.5);
    await dialogue.say('Other Ben', "BEN?! Stop! Don't come any closer! The floor's rigged... it's ALL wired!", { hold: 2.8 });
    playPA();
    await wait(0.5);
    await dialogue.say('Coach Billing (intercom)', 'Welcome to the boiler room, Ben. Final exam day.', { hold: 2.4 });
    await dialogue.say('Coach Billing (intercom)', 'Question one: how fast can you save your friend? INCINERATOR SEQUENCE... INITIATED.', { hold: 3.0 });

    // The furnace door grinds up: fire behind it. Klaxons.
    startAlarm();
    ug.lights.alarm.intensity = 30;
    ug.alarmLamp.material = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
    playIncinerator(3.2);
    ug.hall.furnaceDoor.move(1, 1.6);
    ug.hall.fireMat.color.setHex(0xff5a1a);
    ug.hall.flames.forEach((f) => (f.sp.visible = true));
    ug.hall.furnaceLight.intensity = 34;
    this._shake(0.8, 0.02);
    await wait(1.4);

    // The blast door drops between the two of you.
    playBlastDoor(false);
    await ug.gallery.blast.move(1, 0.42, 'in');
    this._shake(0.7, 0.05);
    this._setColliders();
    await wait(0.35);
    const timer = this.hud.timer;
    player.setInputLocked(false);
    player.movementFrozen = true; // (you can look, but you can't move)
    player.setLookTarget(() => ben.headPosition(this._tmp));
    // The countdown runs on the wall display above the door (it's always in frame here), not on the HUD.
    const digits = ['00:05', '00:04', '00:03'];
    for (let i = 0; i < digits.length; i++) {
      ug.gallery.drawTimer(digits[i]);
      playBeep(880 + i * 180, 0.16, 0.14);
      if (i === 0) dialogue.say('Other Ben', 'BEN! GO! GET OUT OF HERE!!', { hold: 0.9 });
      if (i === 1) dialogue.say('Coach Billing (intercom)', 'No makeups.', { hold: 0.9 });
      await wait(1.0);
    }

    // Hard cut to black.
    director.fader.set(1);
    timer.classList.add('hidden');
    stopAlarm();
    playSting();
    dialogue.finish();
    document.getElementById('hud').classList.add('hidden');
    Achievements.unlock('overtime');
    if (difficulty.hard && !this.deaths) markPartFlawless(1);
    await wait(1.6);
    await this._endCardPart1();
  }

  async _endCardPart1() {
    const { wait } = this;
    const unlocked = isPartTwoUnlocked();
    this.phase = 'p1end';
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:16;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;' +
      'color:#d9dee3;font-family:"Courier New",Courier,monospace;text-align:center;opacity:0;transition:opacity 1.6s ease;';
    el.innerHTML =
      '<div style="font-size:38px;letter-spacing:9px;color:#b3413b;">To Be Concluded...</div>' +
      `<div style="font-size:13px;letter-spacing:2px;color:rgba(217,222,227,0.65);max-width:640px;">${
        unlocked ? '(Part 2 is unlocked: continuing to SUDDEN DEATH...)' : '(Clear Chapters 1-3 on Hard Mode without dying to unlock Part 2)'
      }</div>`;
    document.body.appendChild(el);
    el.getBoundingClientRect();
    el.style.opacity = '1';
    if (unlocked) {
      await wait(4.8);
      el.style.opacity = '0';
      await wait(1.6);
      el.remove();
      this.start({ part: 2 });
      return;
    }
    const button = document.createElement('button');
    button.textContent = 'MAIN MENU';
    button.style.cssText =
      'margin-top:26px;cursor:pointer;font-family:inherit;font-size:13px;letter-spacing:2px;padding:10px 24px;background:transparent;border:1px solid #b3413b;color:#d9dee3;pointer-events:all;';
    button.addEventListener('click', () => this.ui.onSecretEnd(1));
    el.appendChild(button);
    this.ui.onSecretCard(el); // (frees the mouse so the button works)
  }

  // =========================================================================================================
  // PART 2 · SUDDEN DEATH
  // =========================================================================================================

  _bark(speaker, line, id = null, hold = null) {
    if (id) {
      if (this.barks.has(id)) return;
      this.barks.add(id);
    } else if (this.dialogue.active) {
      return;
    }
    this.dialogue.say(speaker, line, { hold: hold ?? Math.max(1.6, line.split(/\s+/).length * 0.3) });
  }

  _tip(id, text, ms = 4200) {
    if (this.barks.has(`tip-${id}`)) return;
    this.barks.add(`tip-${id}`);
    this.ui.showMessage(text, ms);
  }

  /** Part 2 begins (straight after Part 1, or from Chapter Select): the gallery, the blast door shut, the furnace lit. */
  async _startPart2() {
    const { player, director, dialogue } = this;
    this.part = 2;
    this.phase = 'p2';
    this.stage = 'setup';
    this.cutscene = true;
    this.token++;
    this.barks = new Set();
    this.rifleTaken = false;
    this.nodesOff = 0;
    this.hack = null;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    player.crouching = false;
    player.eyeHeight = 1.7;
    player.movementFrozen = false;
    player.clearStumble();
    player.setLookTarget(null);
    document.getElementById('hud').classList.remove('hidden');
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    this.stealth.meterEl.classList.add('hidden');
    this._loadUnderground();
    this.ug.puzzle.configure(rollPuzzle()); // a fresh lock every playthrough
    this.ui.setFlashlight(false); // (the facility has its own light)
    this._setupCombat();
    const ug = this.ug;
    const c = this.combat;
    this.location = 'underground';
    ug.gallery.stairDoor.set(0);
    ug.gallery.blast.set(1);
    ug.hall.furnaceDoor.set(1);
    this._furnace(true);
    ug.lights.alarm.intensity = 14;
    ug.beams.setPower('cage0', true);
    ug.beams.setPower('cage1', true);
    ug.beams.setPower('cage2', true);
    ug.nodes.forEach((n) => n.reset());
    ug.gallery.rifle.visible = ug.gallery.rifleGlow.visible = true;
    ug.gallery.jointGroup.visible = true;
    ug.gallery.pipe.alive = true;
    ug.gallery.pipe.hp = 60;
    c.start();
    c.hud.show(true);
    c.hud.showAmmo(false);
    c.rifle.unequip();
    c.healFull();
    player.teleport(GALLERY_SPAWN.pos, GALLERY_SPAWN.yaw, -0.02);
    this._setColliders();
    this._place(new THREE.Vector3(GALLERY_SPAWN.pos.x, 1.7, GALLERY_SPAWN.pos.z), new THREE.Vector3(0, 1.6, 5));
    ug.gallery.drawTimer('--:--', '#5a1a14', 'STANDBY');
    await director.fader.to(0, 1.4);
    startAlarm();
    playPA();
    await dialogue.say('Coach Billing (intercom)', "Still standing, Ben? The furnace lights in forty-five seconds. Do try to keep up.", { hold: 3.4 });
    await dialogue.say('Other Ben', "Ben! Your rifle's in the gear cage! The hydraulic joint over the gate... SHOOT IT!", { hold: 3.0 });
    this._beginPipeStage();
  }

  /** The combat system for Part 2's rifle, fists, hazards and bosses. Built once. */
  _setupCombat() {
    if (this.combat) return;
    const { player, camera } = this;
    const ug = this.ug;
    const c = (this.combat = new CombatSystem({ scene: ug.scene, camera, player, boss: 'billing', pool: { scrap: 12, shield: 6, tank: 5, standard: 6 }, bolts: 90 }));
    // Firing spots for the tanks and riflemen (the hall's open floor, clear of the pillars, cage and alcove).
    c.spots = [[-9, -9], [-9, -1], [-9, 9], [-3, 11], [3, 11], [9, 9], [9, 1], [-3, -10], [3, -10], [-9, 4]].map(([x, z]) => ({ pos: new THREE.Vector3(x, 0, z), taken: null }));
    c.arena = { ...ARENA };
    c.reconArena = { ...ARENA, maxX: 9.6 }; // (the boss keeps out of the terminal alcove on the east wall)
    c.inTransit = () => false;
    c.regen = true;
    c.showBossBar = false;
    c.extraTargets = [ug.gallery.pipe];
    this.hallNav = new NavGrid({ minX: -50, maxX: 16, minZ: -16, maxZ: 28, cell: 0.6, inflate: 0.45 });
    c.navigate = (from, to) => this.hallNav.path(from, to) || [to.clone()];
    c.onPlayerDown = () => this._playerDown();
    c.onKill = (u) => this._onScrapKill(u);
    c.onRushArrive = (u) => this._onRushArrive(u);
    c.onReconDown = () => this._reconDown();
    c.onReconDebris = () => this._reconDebrisTip();
    c.onDuelParry = (n, streak) => this._onParry(n, streak);
    c.onDuelistDefeated = () => this._duelDone();
    ug.gallery.pipe.onBurst = () => this._pipeBurst();
    player.slideEnabled = true;
    player.onSlide = playSlide;
    this._refreshCombatWorld();
    // Build every shader now (behind the black).
    c.prewarm(true);
    this.renderer.compile(ug.scene, camera);
    this.renderer.compile(c.rifle.scene, c.rifle.camera);
    c.prewarm(false);
    c.hud.showDownload(false);
    c.refreshTargets();
  }

  /** The combat system's copy of the world (bullets, sight lines, the AI's walkable grid). */
  _refreshCombatWorld(list = null) {
    const ug = this.ug;
    const c = this.combat;
    if (!c) return;
    const meshes = (list || ug.colliders).filter((m) => !m.userData.podDoor);
    const slabs = [
      new THREE.Box3(new THREE.Vector3(-80, -1, -80), new THREE.Vector3(80, 0, 80)), // floor
      new THREE.Box3(new THREE.Vector3(-14, 9, -14), new THREE.Vector3(14, 9.4, 13.6)), // the hall's ceiling
      new THREE.Box3(new THREE.Vector3(-46, 6, -13), new THREE.Vector3(-20, 6.4, 13)), // the practice hall's
      new THREE.Box3(new THREE.Vector3(-6, 7, 14), new THREE.Vector3(6, 7.4, 26)), // the gallery's
      new THREE.Box3(new THREE.Vector3(-19.6, 3.2, -1.2), new THREE.Vector3(-14, 3.5, 1.2)), // the corridor's
    ];
    c.setWorldColliders(meshes, slabs);
    const boxes = meshes
      .map((m) => {
        m.updateWorldMatrix(true, false);
        return new THREE.Box3().setFromObject(m);
      })
      .filter((b) => b.max.y > 0.3 && b.min.y < 1.5);
    this.hallNav.build(boxes);
  }

  /** The furnace's glow: on (fire, roar of light) or out. */
  _furnace(on) {
    const h = this.ug.hall;
    h.fireMat.color.setHex(on ? 0xff5a1a : 0x2a0a06);
    h.flames.forEach((f) => (f.sp.visible = on));
    h.furnaceLight.intensity = on ? 34 : 0;
  }

  _beginCutscene() {
    const c = this.combat;
    this.cutscene = true;
    c.frozen = true;
    c.rifle.triggerHeld = false;
    c.bolts.clear();
    c.endBeams();
    this.player.setInputLocked(true);
    this.player.setCameraOverride(true);
    this.hack = null;
    this.hud.hack.classList.add('hidden');
  }

  _endCutscene() {
    this._restoreGameplay();
    this.combat.frozen = false;
  }

  // ---- Stage: the pipe ------------------------------------------------------------------------------

  _beginPipeStage() {
    const { player } = this;
    const ug = this.ug;
    const c = this.combat;
    this.stage = 'pipe';
    this.phase = 'p2pipe';
    this.purge = PURGE_SECONDS * (difficulty.hard ? 0.85 : 1);
    this._purgeShown = -1;
    ug.gallery.pipe.alive = true;
    ug.gallery.pipe.hp = 60;
    c.refreshTargets();
    this.hud.timer.classList.remove('hidden');
    this._restoreGameplay();
    c.frozen = false;
    if (this.rifleTaken) {
      c.rifle.dry = false;
      c.rifle.equip();
      c.hud.showAmmo(true);
      c.hud.setReserve('/ ∞');
      player.setInteractables([]);
    } else {
      player.setInteractables([ug.gallery.rifleHitbox]);
    }
    this._refreshPipeObjective();
  }

  _refreshPipeObjective() {
    this.ui.setObjective('Stop the furnace before it lights!', [
      { label: 'Take your rifle from the gear cage', done: this.rifleTaken },
      { label: 'Shoot the hydraulic joint on the pipe above the blast gate', done: false },
      { label: 'Steam pressure will halt the incinerator and unlock the gate', tip: true },
    ]);
  }

  _takeRifle() {
    if (this.rifleTaken) return;
    const ug = this.ug;
    const c = this.combat;
    this.rifleTaken = true;
    ug.gallery.rifle.visible = false;
    ug.gallery.rifleGlow.visible = false;
    this.player.setInteractables([]);
    this.player.currentTarget = null;
    this.ui.setPrompt(null); // (the DOM prompt only clears through this)
    this.ui.setPrompt(null);
    c.rifle.dry = false;
    c.rifle.equip();
    c.hud.showAmmo(true);
    c.hud.setReserve('/ ∞');
    playReloadStep('rack');
    this._refreshPipeObjective();
    this._bark('Other Ben', 'The joint! The glowing one, over the door! Three hits!', 'pipeHint');
  }

  _updatePipe(dt) {
    this.purge -= dt;
    const s = Math.max(0, Math.ceil(this.purge));
    if (s !== this._purgeShown) {
      this._purgeShown = s;
      const txt = `00:${String(s).padStart(2, '0')}`;
      this.hud.timer.textContent = `FURNACE LIGHTS IN ${txt}`;
      this.ug.gallery.drawTimer(txt);
      if (s <= 10 && s > 0) playBeep(760 + (10 - s) * 60, 0.1, 0.1);
    }
    if (this.purge <= 0) this._purgeFailed();
  }

  /** Time's up: the furnace roars, and you start again. */
  async _purgeFailed() {
    if (this.stage !== 'pipe') return;
    this.stage = 'pipeFailed';
    const token = ++this.token;
    const { director, wait, player } = this;
    const c = this.combat;
    this._beginCutscene();
    this.hud.timer.classList.add('hidden');
    playIncinerator(2.4);
    this._shake(0.9, 0.05);
    this.dialogue.say('Other Ben', "NO— BEN, THE PIPE! THE PIPE!", { hold: 1.2 });
    await wait(1.4);
    await director.fader.to(1, 0.7);
    if (token !== this.token) return;
    this.dialogue.finish();
    this._showCaught('TOO SLOW', 'THE FURNACE LIT. TRY AGAIN.');
    await wait(1.6);
    this.hud.caught.classList.remove('show');
    c.resetPlayer();
    player.teleport(GALLERY_SPAWN.pos, GALLERY_SPAWN.yaw, -0.02);
    this._beginPipeStage();
    await wait(0.4);
    await director.fader.to(0, 0.6);
  }

  /** The joint blows: steam floods the gallery, the incinerator halts, and the blast gate unlocks. */
  async _pipeBurst() {
    if (this.stage !== 'pipe') return;
    this.stage = 'pipeBurst';
    const token = ++this.token;
    const { player, dialogue, wait } = this;
    const ug = this.ug;
    this._beginCutscene();
    this.hud.timer.classList.add('hidden');
    ug.gallery.jointGlow.visible = false;
    playPipeBurst(5);
    this.steam = { t: 6 };
    this._shake(0.6, 0.04);
    ug.gallery.drawTimer('HALTED', '#3cff7a', 'PRESSURE LOSS');
    stopAlarm();
    ug.lights.alarm.intensity = 0;
    ug.hall.furnaceDoor.move(0, 1.6);
    this._furnace(false);
    player.setLookTarget(new THREE.Vector3(0, 5.2, 19));
    await wait(0.8);
    await dialogue.say('Coach Billing (intercom)', "My PIPE?! That's a forty-thousand-dollar pipe!", { hold: 2.4 });
    if (token !== this.token) return;
    await dialogue.say('Other Ben', "It worked! The gate's unlocking! Ben, go WEST: the old practice hall. The lasers around me run off three power nodes in there!", { hold: 4.2 });
    if (token !== this.token) return;
    playBlastDoor(true);
    await ug.gallery.blast.move(0, 2.4);
    this._setColliders();
    this._beginNodesStage();
  }

  // ---- Stage: three power nodes, and the Coach Clones ------------------------------------------------

  _ensureClones() {
    if (this.clones) return;
    const defs = [
      { route: [[-26, -7.5], [-37, -7.5], [-37, 7.5], [-26, 7.5]], pause: 1.2, speed: 1.7 },
      { route: [[-41, -2], [-41, -6.5], [-41, 6.5], [-41, 2]], pause: 1.6, speed: 1.5 },
      { route: [[-23.5, 8], [-33, 8], [-33, -8], [-23.5, -8]], pause: 0.9, speed: 2.0 },
    ];
    this.clones = defs.map((d, i) => new CoachClone(this, d, i));
  }

  /** `respawn`: restarting after going down there (the clones start their rounds away from it). */
  _beginNodesStage(respawn = null) {
    const { player } = this;
    const ug = this.ug;
    const c = this.combat;
    this.stage = 'nodes';
    this.phase = 'p2nodes';
    this._ensureClones();
    this.clones.forEach((cl) => {
      cl.reset(respawn, respawn ? 3 : 0);
      cl.mesh.visible = true;
      cl.beam.visible = true;
    });
    c.rifle.unequip();
    c.hud.showAmmo(false);
    this._restoreGameplay();
    c.frozen = false;
    player.setInteractables(this._nodeTargets());
    this.stealth.meterEl.classList.remove('hidden');
    this._hudLabel = '';
    this._refreshNodesObjective();
    this.ui.showMessage('Rifle holstered: the clones are wired to the gun rack alarm. Sneak.', 3600);
  }

  /** What [E] can hit during the nodes stage: the live nodes, and the lock panel until it's solved. */
  _nodeTargets() {
    const ug = this.ug;
    const list = ug.nodes.filter((n) => !n.off).map((n) => n.hitbox);
    if (!ug.puzzle.solved) list.push(...ug.puzzle.buttons);
    return list;
  }

  /**
   * A press on the Node B lock panel. Nothing tells you whether a press was right: only after the fourth does the
   * panel judge the whole sequence (a wrong one locks it out for a few seconds, so guessing doesn't pay).
   */
  _pressLockButton(idx) {
    const pz = this.ug.puzzle;
    if (pz.solved || this.stage !== 'nodes' || this.cutscene || pz.lockout > 0 || pz.seq.length >= 4) return;
    pz.seq.push(idx);
    pz.setLamps(pz.seq.length);
    playBeep(620, 0.06, 0.1);
    if (pz.seq.length < 4) return;
    const right = pz.seq.every((b, i) => b === pz.order[i]);
    if (right) {
      pz.solved = true;
      pz.setLamps(4, 0x3cff7a);
      this.wait(0.5).then(async () => {
        playBlastDoor(true);
        this.ui.showMessage('Lock accepted: the door to the north-west pen sinks into the floor.', 3200);
        this.player.setInteractables(this._nodeTargets());
        this.ui.setPrompt(null);
        await pz.door.move(1, 1.4);
        this._setColliders();
        this._refreshNodesObjective();
      });
    } else {
      pz.lockout = 4;
      pz.setLamps(4, 0xff3a2a);
      playBeep(170, 0.35, 0.16);
      this.ui.showMessage("ACCESS DENIED: the panel locks for a few seconds, then resets. Re-read the Coach's play sheet.", 3200);
    }
  }

  _updateLockPanel(dt) {
    const pz = this.ug.puzzle;
    if (pz.lockout > 0) {
      pz.lockout -= dt;
      if (pz.lockout <= 0) {
        pz.lockout = 0;
        pz.seq.length = 0;
        pz.setLamps(0);
      }
    }
  }
  _refreshNodesObjective() {
    const ug = this.ug;
    this.ui.setObjective('Cut the power to the laser cage.', [
      ...ug.nodes.map((n) => ({ label: `Power node ${'ABC'[n.index]}: ${['the south-west pen (pulsing gate)', ug.puzzle.solved ? 'the north-west pen (door open)' : 'the north-west pen (locked: solve the panel)', 'the middle of the hall (clone patrol)'][n.index]}`, done: n.off })),
      { label: 'Hold [E] on a node to shut it down', tip: true },
      { label: 'Coach Clones: the beam catches you, their footsteps warn you', tip: true },
      { label: 'Lasers: walk through a pulsing gate when it is off', tip: true },
      { label: 'The lock panel by the north-west pen wants four drills in order', tip: true },
    ]);
  }

  _startHack(index) {
    const node = this.ug.nodes[index];
    if (!node || node.off || this.stage !== 'nodes' || this.hack) return;
    this.hack = { node, t: 0 };
    this.hud.hack.classList.remove('hidden');
    this.hud.hackText.textContent = `DISABLING POWER NODE ${'ABC'[index]}...`;
    this.hud.hackFill.style.width = '0%';
    playBeep(660, 0.08, 0.1);
  }

  _updateHack(dt) {
    const h = this.hack;
    if (!h) return;
    const p = this.player.object.position;
    const d = Math.hypot(p.x - h.node.position.x, p.z - h.node.position.z);
    if (!this.eHeld || d > 3.2 || this.cutscene) {
      this.hack = null;
      this.hud.hack.classList.add('hidden');
      return;
    }
    h.t += dt / 1.8;
    this.hud.hackFill.style.width = `${Math.min(100, h.t * 100)}%`;
    if (Math.random() < dt * 14) {
      _v1.set(h.node.position.x, 1.3, h.node.position.z);
      this.combat.effects.spark(_v1, { count: 2, color: 0x7fe8ff, speed: 2.4, size: 0.06, life: 0.3 });
    }
    if (h.t >= 1) {
      this.hack = null;
      this.hud.hack.classList.add('hidden');
      this._nodeDisabled(h.node);
    }
  }

  _nodeDisabled(node) {
    const ug = this.ug;
    node.setOff();
    ug.beams.setPower(`cage${node.index}`, false);
    playNodeDisable();
    this.nodesOff++;
    this.player.setInteractables(this._nodeTargets());
    this.player.currentTarget = null;
    this.ui.setPrompt(null); // (the DOM prompt only clears through this)
    _v1.set(node.position.x, 1.3, node.position.z);
    this.combat.effects.spark(_v1, { count: 24, color: 0x7fe8ff, speed: 4, size: 0.08, life: 0.6 });
    this._refreshNodesObjective();
    this.ui.showMessage(`Power node ${'ABC'[node.index]} offline (${this.nodesOff}/3).`, 2600);
    if (this.nodesOff >= 3) this._nodesDone();
  }

  /** A laser touched you. */
  _onZap(beam) {
    const c = this.combat;
    if (!c || this.cutscene || this.part !== 2) return;
    const p = this.player.object.position;
    const [ax, az] = beam.a;
    const [bx, bz] = beam.b;
    const dx = bx - ax;
    const dz = bz - az;
    const t = THREE.MathUtils.clamp(((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    playLaserZap();
    c.damagePlayer(24, p);
    this.player.shove(p.x - (ax + dx * t), p.z - (az + dz * t), 6.5, { stumble: 0.45, dip: 0.15, roll: 0.12, recovery: 0.5 });
    c.shake(0.8);
  }

  _updateNodes(dt) {
    this._updateHack(dt);
    this._updateLockPanel(dt);
    let worst = 0;
    let seen = false;
    for (const cl of this.clones) {
      cl.update(dt, !this.cutscene && !this.caughtClone);
      worst = Math.max(worst, cl.susp);
      seen = seen || cl.seen;
      if (cl.susp >= 1 && !this.caughtClone && !this.cutscene) this._caughtByClone(cl);
    }
    this.cloneBeamMat.uniforms.uTime.value = this.time;
    // The stealth meter.
    const meter = this.stealth;
    const label = worst >= 0.95 ? 'CAUGHT!' : seen ? 'IN THE LIGHT!' : worst > 0.05 ? 'SUSPICIOUS ?' : 'HIDDEN';
    if (label !== this._hudLabel) {
      this._hudLabel = label;
      const color = label === 'HIDDEN' ? '#7d8790' : label === 'SUSPICIOUS ?' ? '#e0b43a' : '#e0584f';
      meter.stateEl.textContent = label;
      meter.stateEl.style.color = color;
      meter.iconEl.style.color = color;
    }
    const width = Math.round(worst * 100);
    if (width !== this._hudWidth) {
      this._hudWidth = width;
      meter.fillEl.style.width = `${width}%`;
    }
  }

  async _caughtByClone(clone) {
    if (this.caughtClone) return;
    this.caughtClone = true;
    const { player, director, wait } = this;
    const c = this.combat;
    this._beginCutscene();
    // Every clone stops and turns on you; the one that caught you closes in, beam in your face.
    this.clones.forEach((cl) => cl.spot(cl === clone));
    player.setLookTarget(() => clone.coach.headPosition(this._tmp));
    playWhistle();
    playCaughtStinger();
    await wait(1.4);
    await director.fader.to(1, 0.35);
    this._showCaught('SPOTTED', 'BACK TO THE HALL ENTRANCE');
    await wait(1.6);
    this.hud.caught.classList.remove('show');
    c.resetPlayer();
    // Back in the corridor, crouched, the hall in front of you (its walls keep the clones' beams off
    // you); every clone restarts at the far end of its rounds, facing away, with a few seconds' grace.
    const respawn = new THREE.Vector3(-17.4, 0, 0);
    player.crouching = true;
    player.eyeHeight = 1.0;
    player.teleport(respawn, Math.PI / 2, 0);
    this.clones.forEach((cl) => cl.reset(respawn, 3));
    await wait(0.4);
    await director.fader.to(0, 0.6);
    this._endCutscene();
    this.caughtClone = false;
    this.ui.showMessage('The clones are back on their rounds. Time your run.', 3000);
  }

  _nodesDone() {
    const { player } = this;
    const ug = this.ug;
    this.stage = 'free';
    this.phase = 'p2free';
    this.clones.forEach((cl) => {
      cl.mesh.visible = false;
      cl.beam.visible = false;
    });
    this.stealth.meterEl.classList.add('hidden');
    ug.beams.list.filter((b) => b.group.startsWith('sim')).forEach((b) => b.lines.forEach((l) => (l.visible = false)));
    ug.beams.setPower('sim-gate', false);
    ug.beams.setPower('sim-high', false);
    player.setInteractables([ug.hall.chairHitbox]);
    this.ui.setObjective("Free Ben.", [{ label: 'The cage is down: cut his straps in the incinerator hall', done: false }]);
    this.ui.showMessage('All three nodes are offline. The lasers around Ben have gone dark.', 4000);
    this._bark('Other Ben', "The lasers just died! Ben, get over here and cut me loose!", 'freeHint');
  }

  async _playFreeBen() {
    if (this.stage !== 'free') return;
    this.stage = 'freeing';
    const { player, dialogue, wait } = this;
    const ug = this.ug;
    const ben = ug.ben;
    this._beginCutscene();
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    player.setInteractables([]);
    this.stealth.meterEl.classList.add('hidden');
    player.setLookTarget(() => ben.headPosition(this._tmp));
    playBeep(1800, 0.03, 0.12);
    await wait(0.4);
    playBeep(1500, 0.03, 0.12);
    ug.straps.forEach((s) => (s.visible = false));
    await wait(0.5);
    standUp(ben.mesh);
    await dialogue.say('Other Ben', "Ow. My arms. Okay. OKAY. You're a legend, dude.", { hold: 2.6 });
    await dialogue.say('Other Ben', "That spine on his back runs every ELDAR on campus. He's wired into the whole school.", { hold: 3.2 });
    await dialogue.say('Other Ben', "There's a security terminal in that alcove. Give me time and I can override the doors. Just... stay alive.", { hold: 3.6 });
    ben.moveTo(UG.terminal.x - 0.55, UG.terminal.z, 3.6); // (a step back from the desk)
    await this._playBossIntro();
  }

  // ---- The boss: Coach Billing Reconstructed ---------------------------------------------------------

  async _playBossIntro() {
    const { player, dialogue, wait } = this;
    const c = this.combat;
    this.stage = 'bossIntro';
    playPA();
    await dialogue.say('Coach Billing (intercom)', "Touching. Truly. But class isn't over.", { hold: 2.4 });
    // Up at the ceiling: it caves in.
    player.setLookTarget(new THREE.Vector3(0, 8.5, -2));
    c.shake(0.5);
    playCeilingCrash();
    await wait(0.6);
    this._breakCeiling(0, -2);
    c.effects.chunks(_v1.set(0, 8.6, -2), { count: 12, speed: 4, size: 0.7 });
    c.effects.spark(_v1, { count: 30, color: 0xd8c8a8, speed: 4, size: 0.2, life: 1.2, gravity: 6 });
    c.recon.drop(new THREE.Vector3(0, 0, -2), 0, 11);
    player.setLookTarget(() => c.recon.aimPoint(this._tmp));
    await wait(2.4);
    player.setLookTarget(() => c.recon.crestPoint(this._tmp));
    await dialogue.say('Coach Billing', "Reconstructed. Rebuilt. And FASTER.", { hold: 2.2 });
    this._endCutscene();
    this._beginStage(1);
    c.recon.engage();
  }

  /** The ceiling caves in where the boss drops: a black hole with a broken rim, rebar, and rubble on the floor. (Once.) */
  _breakCeiling(x, z) {
    if (this.ceilingHole) return;
    const scene = this.ug.scene;
    const g = new THREE.Group();
    g.position.set(x, UG.hall.h - 0.02, z);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.2, 24), new THREE.MeshBasicMaterial({ color: 0x030509 }));
    disc.rotation.x = Math.PI / 2; // faces down
    g.add(disc);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x565c61, roughness: 1, flatShading: true });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = 2.1 + Math.random() * 0.4;
      const m = new THREE.Mesh(new THREE.BoxGeometry(rand(0.45, 1.0), rand(0.3, 0.8), rand(0.4, 0.7)), rockMat);
      m.position.set(Math.cos(a) * r, -rand(0.05, 0.4), Math.sin(a) * r);
      m.rotation.set(rand(-0.4, 0.4), a + rand(-0.6, 0.6), rand(-0.4, 0.4));
      g.add(m);
    }
    const bar = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.7, metalness: 0.5 });
    for (let i = 0; i < 6; i++) {
      const a = rand(0, Math.PI * 2);
      const len = rand(0.6, 1.6);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 5), bar);
      m.position.set(Math.cos(a) * 1.9, -len / 2 + 0.1, Math.sin(a) * 1.9);
      m.rotation.set(rand(-0.5, 0.5), 0, rand(-0.5, 0.5));
      g.add(m);
    }
    scene.add(g);
    // The rubble it left on the floor.
    for (let i = 0; i < 9; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(1.2, 3.0);
      const s = rand(0.25, 0.55);
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
      m.position.set(x + Math.cos(a) * r, s * 0.6, z + Math.sin(a) * r);
      m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      scene.add(m);
    }
    this.ceilingHole = g;
  }

  _beginStage(n) {
    const c = this.combat;
    this.stage = `boss${n}`;
    this.phase = 'p2boss';
    this.bossStage = n;
    this.token++;
    c.healFull();
    c.regen = false;
    c.showBossBar = true;
    c.customBoss = null;
    c.hud.show(true);
    c.clearCombatants();
    c.hazards.clear();
    if (n === 1) {
      c.rifle.dry = false;
      c.rifle.equip();
      c.hud.showAmmo(true);
      c.hud.setReserve('/ ∞');
      c.hud.setBossName('COACH BILLING · RECONSTRUCTED', false);
      c.hud.setSubName('');
      this.shotsAtStart = c.stats.shots;
      // Three stages, one vent each. Every stage, a (bigger) wave of Tank ELDARs drops through the hole to feed
      // his spine a shield: they have to die before a vent can be hurt, and breaking it snaps the shield back up.
      this.b1 = { stageN: 0, pendingTanks: 0, tankDelay: 1.2, lastVents: 3, addT: 5, addN: 0 };
      this._reconStage(1);
      this.ui.setObjective('Break the vents on his cybernetic spine!', [
        { label: 'TANK ELDARs are feeding his spine a shield: destroy them first', tip: true },
        { label: 'He dashes down a red lane on the floor: get OUT of it (sprint + [C] slides)', tip: true },
        { label: 'When he stops to throw rubble and the shield is down, SHOOT THE GLOWING VENTS', tip: true },
        { label: 'Each broken vent brings his shield back with MORE tanks: three vents, three rounds', tip: true },
      ]);
    } else if (n === 2) {
      c.rifle.dry = false;
      c.rifle.equip();
      c.hud.showAmmo(true);
      c.hud.setReserve('/ ∞');
      c.hud.setBossName('SECURITY OVERRIDE', false);
      c.hud.setSubName('');
      this.override = 0;
      this.overrideOpened = 0;
      this._terminalShown = -1;
      c.rushTarget = new THREE.Vector3(UG.terminal.x - 0.7, 0, UG.terminal.z);
      this.wave = { t: 0, next: 1.5, spawned: 0, door: 0 };
      this.ui.setObjective("Protect Ben while he overrides the doors!", [
        { label: 'Scrap ELDARs run straight for the terminal alcove', tip: true },
        { label: 'BODY-BLOCK the doorway: stand in it, shoot the ones that mob you', tip: true },
        { label: 'Every one that reaches the terminal costs Ben 10% of his progress', tip: true },
      ]);
    } else {
      c.rifle.unequip();
      c.hud.showAmmo(false);
      c.fists.equip(true);
      c.hud.setBossName('COACH BILLING · CONTROL HEADSET', false);
      c.hud.setSubName('');
      this.ui.setObjective("Break his control headset!", [
        { label: 'Watch his fist: yellow jab, orange hook, RED haymaker', tip: true },
        { label: 'Raise your guard [RMB] just as the punch lands: a PARRY staggers him', tip: true },
        { label: 'Then counter with [LMB]. Holding guard early is only a block', tip: true },
        { label: 'When the headset cracks, the next parry-counter is the right hook that ends it', tip: true },
      ]);
    }
  }

  _reconDebrisTip() {
    if (this.combat.recon.shielded) {
      this._tip('shieldUp', 'The blue shield is up: kill the TANKS first, then the vents can be hurt.', 4200);
      return;
    }
    this._tip('vents', "His spine is venting! SHOOT THE GLOWING VENTS while they're open!", 4200);
    this._bark('Other Ben (terminal)', "The vents! The glowing vents on his spine! Shoot them while he's throwing!", 'ventBark');
  }

  /** All three vents are broken: the spine overloads. */
  async _reconDown() {
    if (this.stage !== 'boss1') return;
    this.stage = 'reconDown';
    const token = ++this.token;
    const { player, dialogue, wait } = this;
    const c = this.combat;
    const recon = c.recon;
    // Vent sniper: all three, inside 40 rounds.
    if (c.stats.shots - this.shotsAtStart <= 40) Achievements.unlock('vent_sniper');
    this._beginCutscene();
    c.healFull();
    player.setLookTarget(() => recon.aimPoint(this._tmp));
    await dialogue.say('Coach Billing', "AGH— my SPINE! It's overheating! Pull... pull the drones in!", { hold: 2.6 });
    if (token !== this.token) return;
    c.hud.setBoss(null, null);
    // He doesn't just vanish: he drags himself up and staggers into the furnace to cool the spine down
    // (he walks back out of it, spine burnt off, for the duel), and the door grinds shut behind him.
    const hall = this.ug.hall;
    hall.furnaceDoor.move(1, 1.2);
    this._furnace(true);
    playIncinerator(1.2);
    const route = [new THREE.Vector3(0, 0, -11.5), new THREE.Vector3(0, 0, -17.2)];
    const far = recon.position.distanceTo(route[0]) + route[0].distanceTo(route[1]);
    const gone = recon.retreat(route, Math.max(2.4, far / 5.5)); // (in about six seconds from anywhere in the hall)
    await dialogue.say('Other Ben (terminal)', "The drones are loose! They're all heading for my terminal! I can override the doors, but I NEED TIME!", { hold: 3.4 });
    if (token !== this.token) return;
    await Promise.race([gone, wait(14)]);
    if (token !== this.token) return;
    hall.furnaceDoor.move(0, 1.0);
    await wait(1.0);
    if (token !== this.token) return;
    recon.park();
    this._furnace(false);
    this._endCutscene();
    this._beginStage(2);
  }

  // ---- Stage 2: body-block the doorway ----------------------------------------------------------------

  _spawnScrap() {
    const c = this.combat;
    const pods = this.ug.hall.podDoors;
    const pod = pods[this.wave.door % pods.length];
    this.wave.door++;
    const def = pod.def;
    // The unit is already standing in its recess behind the shut door (it waits half a second before walking),
    // so the door lifts on it: nothing pops into view.
    const yaw = Math.atan2(def.out[0] - def.inside[0], def.out[1] - def.inside[1]);
    const entry = { kind: 'door', inside: new THREE.Vector3(def.inside[0], 0, def.inside[1]), out: new THREE.Vector3(def.out[0], 0, def.out[1]), yaw };
    const shieldCount = c.units.filter((u) => u.type === 'shield' && !u.dead).length;
    const armored = shieldCount < (difficulty.hard ? 4 : 3) && this.wave.spawned % 3 === 2;
    if (armored) c.spawnUnit('shield', entry, { rush: true });
    else c.spawnUnit('scrap', entry);
    this.wait(0.12).then(() => pod.slide.move(1, 0.4));
    this.wait(2.6).then(() => pod.slide.move(0, 0.5));
    if (this.combat.sfx('podOpen', 0.3)) playDoorSlide();
  }

  _onRushArrive() {
    if (this.stage !== 'boss2') return;
    this.override = Math.max(0, this.override - 10);
    const c = this.combat;
    _v1.set(UG.terminal.x - 0.6, 1.2, UG.terminal.z);
    c.effects.spark(_v1, { count: 20, color: 0xffb060, speed: 4, size: 0.09, life: 0.5 });
    c.effects.flash(_v1, { size: 1.2, color: 0xffa050, life: 0.15 });
    c.shakeFrom(_v1, 0.5);
    playExplosion();
    c.hud.callout('TERMINAL HIT  -10%', 'block');
    this._bark('Other Ben (terminal)', "It got through! Keep them OFF me!", 'leak1');
  }

  _onScrapKill(unit) {
    if (unit.selfDestruct) return;
    Achievements.bump('scrapKills');
  }

  /** Stage 1's reinforcements: tank pairs (each broken vent brings more) and a steady drip of riflemen and shield bearers. */
  _dropUnit(type) {
    const c = this.combat;
    const at = new THREE.Vector3(rand(-1.6, 1.6), 0, -2 + rand(-1.6, 1.6)); // down through the hole in the ceiling
    return c.spawnUnit(type, { kind: 'drop', at, height: UG.hall.h - 0.6 });
  }

  /**
   * Stage 1 round `n` (1..3, one per vent): his shield is held up until this round's tanks have all dropped in.
   * Each round brings more tanks, and a bigger, faster drip of riflemen and shield bearers (more again on Hard).
   */
  _reconStage(n) {
    const c = this.combat;
    const b = this.b1;
    b.stageN = n;
    b.pendingTanks = (difficulty.hard ? [3, 4, 5] : [2, 3, 4])[n - 1];
    b.addCap = (difficulty.hard ? [3, 4, 6] : [2, 3, 4])[n - 1];
    b.addGap = [1, 0.8, 0.65][n - 1];
    c.recon.holdShield = true;
    c.hud.setSubName(`SPINE VENTS · ROUND ${n} / 3`);
    if (n > 1) {
      b.tankDelay = 2.4;
      b.addT = Math.min(b.addT, 2.5);
      c.hud.callout(`SHIELD RESTORED · ROUND ${n}`, 'block');
      this._bark('Other Ben (terminal)', n === 3 ? "His shield's back AGAIN! Even more tanks! Last vent, you've got this!" : "His shield's back up! More tanks coming through the roof! Shoot them first!", `tanks${n}`);
    }
  }

  _updateStage1(dt) {
    const c = this.combat;
    const b = this.b1;
    const r = c.recon;
    if (!b || c.frozen || !r || !r.alive || !r.aiEnabled) return;
    if (r.ventsLeft < b.lastVents) {
      b.lastVents = r.ventsLeft;
      if (r.ventsLeft > 0) this._reconStage(4 - r.ventsLeft);
    }
    if (b.pendingTanks > 0) {
      b.tankDelay -= dt;
      if (b.tankDelay <= 0) {
        this._dropUnit('tank');
        b.pendingTanks--;
        b.tankDelay = 1.1;
        if (!this.barks.has('tankIntro')) {
          this.barks.add('tankIntro');
          this._bark('Other Ben (terminal)', "Those big ones are feeding his spine a shield! Take the tanks out!", 'tankIntroLine');
        }
      }
    }
    // Once the whole round of tanks is down here, they alone hold the shield up.
    if (b.pendingTanks <= 0 && r.holdShield) r.holdShield = false;
    b.addT -= dt;
    const adds = c.units.reduce((k, u) => k + (!u.dead && !u.heavy ? 1 : 0), 0);
    if (b.addT <= 0 && adds < b.addCap) {
      b.addT = rand(6.5, 9) * b.addGap * Math.max(0.75, difficulty.fireMult);
      this._dropUnit(b.addN++ % 3 === 2 ? 'shield' : 'standard');
    }
  }

  _updateStage2(dt) {
    const c = this.combat;
    const w = this.wave;
    if (!w || c.frozen) return;
    w.t += dt;
    // Ben works: about a minute and a quarter of uninterrupted work (a little longer on Hard).
    this.override = Math.min(100, this.override + dt * (100 / (difficulty.hard ? 80 : 65)));
    const cap = difficulty.hard ? 10 : 8;
    if (w.t >= w.next && c.aliveCount < cap) {
      w.next = w.t + rand(1.5, 2.5) * Math.max(0.75, difficulty.fireMult);
      this._spawnScrap();
      w.spawned++;
    }
    // The shutters open at a third, two thirds and done.
    const opened = this.override >= 100 ? 3 : Math.floor(this.override / 33.4);
    while (this.overrideOpened < opened) {
      const sh = this.ug.hall.shutters[this.overrideOpened++];
      sh.lamp.material.color.setHex(0x3cff7a);
      sh.slide.move(1, 1.8);
      playMechanism(1.4);
      this.ui.showMessage(`Security door ${this.overrideOpened} of 3 overridden.`, 2400);
    }
    const shown = Math.floor(this.override);
    if (shown !== this._terminalShown) {
      this._terminalShown = shown;
      this.ug.hall.drawTerminal(this.override, [`> doors open: ${this.overrideOpened} / 3`, '> hostile units inbound', '> override in progress_']);
    }
    c.customBoss = this.override / 100;
    if (this.override >= 100) this._stage2Done();
  }

  async _stage2Done() {
    if (this.stage !== 'boss2') return;
    this.stage = 'stage2Done';
    const token = ++this.token;
    const { player, dialogue, wait } = this;
    const c = this.combat;
    this._beginCutscene();
    c.customBoss = null;
    c.hud.setBoss(null, null);
    for (const u of c.units) if (!u.dead) u._die();
    c.rushTarget = null;
    c.healFull();
    // Watch Ben through the alcove doorway from out in the hall (from where you stand, the alcove wall is in the way).
    this._place(new THREE.Vector3(8.4, 1.6, UG.terminal.z), () => this.ug.ben.headPosition(this._tmp));
    this.ug.hall.drawTerminal(100, ['> ALL DOORS OPEN', '> police notified', '> override complete']);
    await dialogue.say('Other Ben (terminal)', "DONE! Every door's open! I called the cops on the school line: they're on their way!", { hold: 3.4 });
    if (token !== this.token) return;
    this.ug.hall.furnaceDoor.move(1, 1.5);
    this._furnace(true);
    playIncinerator(2);
    await wait(1.2);
    await this._playDuelIntro(token);
  }

  // ---- Stage 3: the headset duel -----------------------------------------------------------------------

  async _playDuelIntro(token) {
    const { player, dialogue, wait } = this;
    const c = this.combat;
    const duel = c.duelist;
    // He walks out of the furnace's glow, spine burnt off, headset still clamped on.
    duel.spawn(new THREE.Vector3(0, 0, -11), 0);
    duel.mesh.visible = true;
    // Cut to you, squared up to him in the open (clear of the structural pillars, which used to fill
    // half the frame from the terminal alcove, and of the rubble under the hole). You fight from here.
    this._place(new THREE.Vector3(1.2, 1.7, -5.8), () => duel.aimPoint(this._tmp).setY(1.6));
    await dialogue.say('Coach Billing', "Enough with the robots. Enough with the WIRES.", { hold: 2.6 });
    if (token !== this.token) return;
    await dialogue.say('Coach Billing', "The headset is all I need. One old-fashioned lesson: fists.", { hold: 2.8 });
    if (token !== this.token) return;
    this.ug.hall.furnaceDoor.move(0, 1.2);
    this._furnace(false);
    await wait(0.4);
    this._endCutscene();
    this._beginStage(3);
    duel.engage();
  }

  _onParry(count, streak) {
    if (count === 1) this._tip('parry1', 'PARRIED! He is wide open: counter with [LMB]!', 3200);
    if (streak === 3) this.ui.showMessage('Three parries in a row!', 1600);
  }

  async _duelDone() {
    if (this.stage !== 'boss3') return;
    this.stage = 'duelDone';
    const token = ++this.token;
    const c = this.combat;
    c.fists.setGuard(false);
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    c.hud.setBoss(null, null);
    await this.wait(0.5);
    if (token !== this.token) return;
    await this._playResolution(token);
  }

  // ---- The resolution: fire, sprinklers, police, dawn ---------------------------------------------------

  async _playResolution(token) {
    const { player, dialogue, wait, director } = this;
    const c = this.combat;
    const ug = this.ug;
    this._beginCutscene();
    c.fists.equip(false);
    c.hud.show(false);
    const duel = c.duelist;
    // Pull the camera back to take in the room: Billing on his knees, the headset in pieces.
    const pp = player.object.position;
    const dp = duel.mesh.position;
    const away = _v1.set(pp.x - dp.x, 0, pp.z - dp.z);
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
    away.normalize();
    const cam = new THREE.Vector3(THREE.MathUtils.clamp(pp.x + away.x * 3.6, -12, 9.4), 2.0, THREE.MathUtils.clamp(pp.z + away.z * 3.6, -12, 12.6));
    player.setLookTarget(() => this._tmp.copy(duel.mesh.position).setY(1.1));
    await director.moveCamera([cam], [1.3]);
    await dialogue.say('Coach Billing', "No... the signal... I can't... hear them...", { hold: 2.4 });
    if (token !== this.token) return;
    // Without the headset the ELDARs everywhere go dead. Billing folds.
    for (const u of c.units) if (!u.dead) u._die();
    duel.state = 'dazed';
    const ben = ug.ben;
    ben.moveTo(UG.terminal.x - 3.2, UG.terminal.z, 3.2); // (Ben comes out of the alcove)
    // The electrical fire: sparks arcing off the wrecked wall panels, flames along the north wall.
    startAlarm();
    ug.lights.alarm.intensity = 20;
    const fires = [-10, -5, 5, 10].map((x, i) => {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture('rgba(255,150,50,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
      );
      sp.position.set(x, 1.4, -12.5 + (i % 2) * 0.8);
      sp.scale.set(3.4, 3.4, 1);
      ug.scene.add(sp);
      return sp;
    });
    const fireLight = ug.lights.fire;
    fireLight.intensity = 22;
    this.fires = { list: fires, light: fireLight, level: 1 };
    this._shake(0.5, 0.03);
    await dialogue.say('Other Ben', "The panels are arcing! The whole north wall's on fire! We have to—", { hold: 2.6 });
    if (token !== this.token) return;
    // The sprinklers come on.
    playSprinklers(9);
    this._startSprinklers();
    await wait(1.0);
    await this._anim(4.5, (k) => {
      this.fires.level = 1 - k;
      fires.forEach((f) => f.scale.setScalar(3.4 * (1 - k) + 0.01));
      fireLight.intensity = 22 * (1 - k);
    });
    fires.forEach((f) => (f.visible = false));
    fireLight.intensity = 0;
    stopAlarm();
    ug.lights.alarm.intensity = 0;
    await dialogue.say('Other Ben', "...The sprinklers got it. Dude. We're soaked.", { hold: 2.4 });
    if (token !== this.token) return;
    // Sirens, and the police.
    startPoliceSiren(0.05);
    await dialogue.say('', 'Sirens. Blue and red light spills down the stairwell and through the open blast door.', { style: 'narration', hold: 2.6 });
    if (token !== this.token) return;
    this.officers = this.officers || [0, 1, 2].map(() => {
      const m = createHumanoid({ shirt: 0x1c2a44, pants: 0x161c26, skin: 0xc68e62, hair: 0x2a1d14, cap: true, capColor: 0x0e131b, scale: 1.08 });
      ug.scene.add(m);
      return new Character(m, { radius: 0.35, name: 'Officer' });
    });
    const policeLight = ug.lights.police;
    policeLight.intensity = 24;
    this.policeLight = policeLight;
    // (They come in the way you did: the stair door, down the gallery, through the blast door: never through a wall.)
    ug.gallery.stairDoor.move(1, 0.8);
    this.officers.forEach((o, i) => {
      o.mesh.position.set(-0.6 + i * 0.6, 0, 26.7);
      o.mesh.visible = true;
      o.walkRoute([{ x: -0.9 + i * 0.9, z: 21 }, { x: -0.9 + i * 0.9, z: 16 }, { x: -3.6 + i * 3.6, z: 10 }], 4.4);
    });
    player.setLookTarget(new THREE.Vector3(0, 1.6, 14));
    await wait(3.4);
    if (token !== this.token) return;
    await dialogue.say('Officer', "Hands where we can see them! ...Is that Coach Billing?", { hold: 2.6 });
    await dialogue.say('Officer', "He's been running from us since eleven. Cuffs. NOW.", { hold: 2.4 });
    playHandcuffs();
    await wait(0.6);
    await dialogue.say('Other Ben', "He broke out of county transit and hijacked a van. The robots are a long story.", { hold: 3.2 });
    await dialogue.say('Officer', "You two are lucky. Come on, let's get you out of here.", { hold: 2.4 });
    await this._playDawn(token);
  }

  /** Sprinkler streaks from the ceiling over the incinerator hall. */
  _startSprinklers() {
    const ug = this.ug;
    const N = 700;
    const pos = new Float32Array(N * 6);
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbfd8ea, transparent: true, opacity: 0.4, depthWrite: false, fog: false }));
    mesh.frustumCulled = false;
    ug.scene.add(mesh);
    const drops = Array.from({ length: N }, () => ({ x: rand(-13, 13), y: rand(0, 8.6), z: rand(-13, 13), v: rand(9, 13) }));
    this.sprinklers = { mesh, attr, pos, drops, N, t: 14 };
  }

  _updateSprinklers(dt) {
    const s = this.sprinklers;
    if (!s) return;
    s.t -= dt;
    for (let i = 0; i < s.N; i++) {
      const d = s.drops[i];
      d.y -= d.v * dt;
      if (d.y < 0) d.y += 8.6;
      const o = i * 6;
      s.pos[o] = d.x;
      s.pos[o + 1] = d.y;
      s.pos[o + 2] = d.z;
      s.pos[o + 3] = d.x;
      s.pos[o + 4] = d.y + 0.5;
      s.pos[o + 5] = d.z;
    }
    s.attr.needsUpdate = true;
    if (s.t <= 0) {
      s.mesh.visible = false;
      this.sprinklers = null;
    }
  }

  /** Back up on the campus at dawn: the police cars, the two of you walking out into the light. */
  async _playDawn(token) {
    const { director, dialogue } = this;
    await director.fader.to(1, 1.0);
    if (token !== this.token) return;
    stopPoliceSiren();
    setRainExposure(0);
    setUnderground(false);
    this.combat.stop();
    this._prepareDawn();
    const ben = this.world.npcs.ben;
    ben.mesh.position.set(HATCH.x - 0.3, 0, HATCH.z - 2.6);
    ben.mesh.rotation.y = Math.PI;
    ben.mesh.visible = true;
    const cars = this.policeCars;
    // The camera: on the grass just south of the hatch, looking back at the school in the first light.
    this.location = 'dawn';
    this._place(new THREE.Vector3(HATCH.x + 4.5, 1.7, HATCH.z - 10), new THREE.Vector3(HATCH.x - 1, 3.2, HATCH.z + 2));
    await director.fader.to(0, 1.8);
    playBirds();
    await director.moveCamera([new THREE.Vector3(HATCH.x + 2.5, 1.7, HATCH.z - 7.5)], [7]);
    await dialogue.say('', 'Dawn breaks over Hall High School.', { style: 'narration', hold: 2.6 });
    ben.moveTo(HATCH.x + 1.6, HATCH.z - 8.5, 1.5);
    // Billing, cuffed, is walked to the nearer police car.
    const pc = cars[0].group.position;
    this.dawnBilling.moveTo(pc.x + 1.9, pc.z + 0.3, 1.3);
    this.dawnCast[1].moveTo(pc.x + 1.9, pc.z + 1.6, 1.3);
    await dialogue.say('Other Ben', "Six hours until first period. Coach is in custody. No practice, no problem.", { hold: 3.2 });
    await dialogue.say('Other Ben', "...We are so getting detention.", { hold: 2.2 });
    await director.fader.to(1, 1.6);
    if (token !== this.token) return;
    await this._finish();
  }

  /** The campus, at dawn: warm low light, no storm, police cars on the lawn. */
  _prepareDawn() {
    const { world, ui } = this;
    const scene = (this.scene = world.tree.group.parent);
    ui.setScene(scene);
    const { coach, coachLage, coachTom, runners, students } = world.npcs;
    [...runners, ...students, coach, coachLage, coachTom].forEach((npc) => {
      npc.stop();
      npc.mesh.visible = false;
    });
    this._blackout();
    ui.setDawn();
    world.rain.exposureOverride = 0;
    if (this.lightning) {
      this.lightning.dir.intensity = 0;
      this.lightning.fill.intensity = 0;
    }
    const car = world.playersCar;
    car.visible = true;
    car.position.set(HATCH.x + 12, 0, HATCH.z - 16);
    car.rotation.set(0, 0.5, 0);
    if (!this.policeCars) {
      this.policeCars = [[HATCH.x - 6.5, HATCH.z - 7.5, 0.9], [HATCH.x + 7.5, HATCH.z - 8.5, -0.8]].map(([x, z, ry]) => {
        const pc = buildPoliceCar();
        pc.group.position.set(x, 0, z);
        pc.group.rotation.y = ry;
        scene.add(pc.group);
        return pc;
      });
      // The sun, just clearing the roof.
      const sun = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glowTexture('rgba(255,236,190,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
      );
      sun.position.set(30, 34, 70);
      sun.scale.set(110, 110, 1);
      scene.add(sun);
    }
    if (!this.hatch) this.hatch = buildHatch(scene); // (Part 2 straight from the menu never built the campus)
    this.hatch.setOpen(1);
    this.player.setColliders([]);
    ui.setFlashlight(false);
    if (!this.dawnCast) {
      // Officers by the cars, and Billing in an orange jumpsuit, cuffed, being walked over to one.
      const mk = (look, x, z, ry) => {
        const m = createHumanoid(look);
        m.position.set(x, 0, z);
        m.rotation.y = ry;
        scene.add(m);
        return new Character(m, { radius: 0.35, name: 'Officer' });
      };
      const cop = { shirt: 0x1c2a44, pants: 0x161c26, skin: 0xc68e62, hair: 0x2a1d14, cap: true, capColor: 0x0e131b, scale: 1.08 };
      this.dawnBilling = mk({ ...COACH_BILLING_LOOK, shirt: 0xe8742a, pants: 0xe8742a, raincoat: false, hood: false, whistle: false }, HATCH.x - 0.8, HATCH.z - 3.4, 0);
      this.dawnCast = [
        this.dawnBilling,
        mk(cop, HATCH.x - 2.0, HATCH.z - 3.4, 0),
        mk(cop, HATCH.x + 5.6, HATCH.z - 7.6, -2.0),
        mk(cop, HATCH.x + 9.2, HATCH.z - 6.2, -2.4),
      ];
    }
  }

  async _finish() {
    const { wait } = this;
    this.phase = 'p2end';
    stopPoliceSiren();
    grantHallLegend();
    Achievements.unlock('hall_legend');
    if (difficulty.hard && !this.deaths) markPartFlawless(2);
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:16;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;' +
      'color:#d9dee3;font-family:"Courier New",Courier,monospace;text-align:center;opacity:0;transition:opacity 1.6s ease;';
    el.innerHTML =
      '<div style="font-size:13px;letter-spacing:8px;color:#e0c34a;">SECRET CHAPTER</div>' +
      '<div style="font-size:38px;letter-spacing:12px;color:#b3413b;">OVERTIME COMPLETE</div>' +
      '<div style="margin-top:8px;padding:8px 22px;font-size:18px;letter-spacing:8px;color:#ffd700;border:1px solid rgba(255,215,0,0.7);text-shadow:0 0 14px rgba(255,215,0,0.7);">&#9733; HALL LEGEND &#9733;</div>' +
      '<div style="font-size:13px;letter-spacing:3px;color:rgba(217,222,227,0.7);max-width:620px;">Permanent badge earned. SANDBOX (Infinite Ammo) is now available on the main menu.</div>';
    document.body.appendChild(el);
    el.getBoundingClientRect();
    el.style.opacity = '1';
    await wait(3.0);
    const button = document.createElement('button');
    button.textContent = 'MAIN MENU';
    button.style.cssText =
      'margin-top:22px;cursor:pointer;font-family:inherit;font-size:13px;letter-spacing:2px;padding:10px 24px;background:transparent;border:1px solid #b3413b;color:#d9dee3;pointer-events:all;';
    button.addEventListener('click', () => this.ui.onSecretEnd(2));
    el.appendChild(button);
    document.getElementById('hud').classList.add('hidden');
    this.ui.onSecretComplete(el);
  }

  // ---- Going down: this stage starts over -----------------------------------------------------------------

  async _playerDown() {
    this.deaths = (this.deaths || 0) + 1;
    if (this._retrying || this.part !== 2) return;
    this._retrying = true;
    const token = ++this.token;
    const { player, director, wait } = this;
    const c = this.combat;
    const stage = this.stage;
    this.cutscene = true;
    player.setInputLocked(true);
    player.crouching = false;
    c.frozen = true;
    if (c.fists) c.fists.setGuard(false);
    this.hack = null;
    this.hud.hack.classList.add('hidden');
    await director.fader.to(1, 0.7);
    c.clearCombatants();
    c.effects.clear();
    c.resetPlayer();
    let restart = null;
    if (stage === 'nodes') {
      // (Same safe spot as a capture: in the corridor, the clones at the far ends of their rounds.)
      const respawn = new THREE.Vector3(-17.4, 0, 0);
      player.teleport(respawn, Math.PI / 2, 0);
      this.clones.forEach((cl) => cl.reset(respawn, 3));
      restart = () => this._beginNodesStage(respawn);
    } else if (stage === 'boss1') {
      c.recon.spawn(new THREE.Vector3(0, 0, -6), 0);
      player.teleport(new THREE.Vector3(0, 0, 9), 0, 0);
      restart = () => {
        this._beginStage(1);
        c.recon.engage();
      };
    } else if (stage === 'boss2') {
      player.teleport(new THREE.Vector3(6, 0, -6.2), -Math.PI / 2, 0);
      restart = () => this._beginStage(2);
    } else if (stage === 'boss3') {
      c.duelist.spawn(new THREE.Vector3(0, 0, -4), 0);
      player.teleport(new THREE.Vector3(0, 0, 4), 0, 0);
      restart = () => {
        this._beginStage(3);
        c.duelist.engage();
      };
    } else {
      player.teleport(GALLERY_SPAWN.pos, GALLERY_SPAWN.yaw, 0);
      restart = () => this._beginPipeStage();
    }
    await wait(0.6);
    if (token !== this.token) {
      this._retrying = false;
      return;
    }
    restart();
    this.token = token;
    c.frozen = false;
    await director.fader.to(0, 0.6);
    this._restoreGameplay();
    c.frozen = false;
    this._retrying = false;
    this.ui.showMessage('You went down! This stage starts over.', 3000);
  }

  // ---- Per frame (Part 2) ---------------------------------------------------------------------------------

  _updateUndergroundPart2(dt) {
    if (this.part !== 2 || !this.combat) return;
    const c = this.combat;
    c.update(dt);
    // Steam from the burst joint.
    if (this.steam && this.steam.t > 0) {
      this.steam.t -= dt;
      const j = this.ug.gallery.jointGroup.position;
      for (let i = 0; i < 2; i++) {
        _v1.set(j.x + rand(-0.3, 0.3), j.y - 0.2, j.z + rand(-0.3, 0.3));
        c.effects.spark(_v1, { count: 1, color: 0xdfe6ea, speed: 2.8, size: 0.55, life: 1.5, gravity: -0.5, dir: _v2.set(0, -1, 0.4) });
      }
    }
    this._updateSprinklers(dt);
    this._updateHint(dt);
    if (this.policeLight) this.policeLight.color.setHex(Math.floor(this.time * 5) % 2 ? 0xff2a2a : 0x2a5aff);
    if (this.officers) this.officers.forEach((o) => o.update(dt));
    switch (this.stage) {
      case 'pipe':
        this._updatePipe(dt);
        break;
      case 'nodes':
        this._updateNodes(dt);
        break;
      case 'boss1':
        this._updateStage1(dt);
        break;
      case 'boss2':
        this._updateStage2(dt);
        break;
      default:
        break;
    }
  }

  /**
   * Stuck for a long time? A quiet, static reminder of something Ben said (never the answer itself).
   * The clock restarts whenever anything progresses.
   */
  _updateHint(dt) {
    const c = this.combat;
    const hint = this.hud.hint;
    const lines = {
      pipe: ['"That hydraulic line over the gallery feeds the blast door and the furnace. Something up there looks weak."', 55],
      nodes: ['"Three power nodes in the old practice hall. Everything in the cage runs off them. Coach keeps his playbook up on the wall in there."', 80],
      free: ['"Get over here and cut me loose. The lasers are dead."', 40],
      boss1: ['"The big tanks are wired into his spine. Bring them down and it has to vent when he stops to throw."', 100],
      boss3: ['"Watch his fists. Guard right as one lands, then hit back."', 90],
    };
    const entry = lines[this.stage];
    const sig = `${this.stage}|${this.nodesOff}|${this.ug.puzzle.seq.length}|${c && c.recon ? c.recon.ventsLeft : ''}|${c && c.duelist ? Math.floor((c.duelist.hp || 0) / 10) : ''}`;
    if (sig !== this._hintSig || !entry || this.cutscene) {
      if (sig !== this._hintSig) this._hintT = 0;
      this._hintSig = sig;
      if (this._hintOn) {
        this._hintOn = false;
        hint.classList.add('hidden');
      }
      return;
    }
    this._hintT = (this._hintT || 0) + dt;
    if (!this._hintOn && this._hintT >= entry[1]) {
      this._hintOn = true;
      this.hud.hintText.textContent = entry[0];
      hint.classList.remove('hidden');
    }
  }

  /** The dawn scene: the world's own cast and the police cars' lights. */
  _updateDawn(dt) {
    for (const u of this.world.updatables) u.update(dt);
    if (this.policeCars) this.policeCars.forEach((p, i) => p.flash(this.time + i * 0.08));
    if (this.dawnCast) this.dawnCast.forEach((m) => m.update(dt));
  }

  /** [E] targets in Part 2. */
  handleInteractPart2(target) {
    const d = target.userData;
    if (d.type === 'sc-rifle') this._takeRifle();
    else if (d.type === 'sc-node') this._startHack(d.index);
    else if (d.type === 'sc-btn') this._pressLockButton(d.idx);
    else if (d.type === 'sc-chair' && this.stage === 'free') this._playFreeBen();
  }

  markerTargetPart2() {
    if (this.cutscene || this.part !== 2) return null;
    const ug = this.ug;
    switch (this.stage) {
      case 'pipe':
        if (!this.rifleTaken) return { key: 'sc-rifle', position: this._tmp2.set(5.15, 2.0, 23), scale: 0.7 };
        return { key: 'sc-joint', position: this._tmp2.set(0, 6.5, 19), scale: 0.9 };
      case 'nodes': {
        const p = this.player.object.position;
        let best = null;
        let bestD = Infinity;
        for (const n of ug.nodes) {
          if (n.off) continue;
          const d = Math.hypot(n.position.x - p.x, n.position.z - p.z);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
        return best ? { key: `sc-node-${best.index}`, position: this._tmp2.set(best.position.x, 2.9, best.position.z), scale: 0.8 } : null;
      }
      case 'free':
        return { key: 'sc-chair', position: this._tmp2.set(UG.chair.x, 2.6, UG.chair.z), scale: 0.8 };
      default:
        return null;
    }
  }

  // ---- Per frame -------------------------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    if (this._frameWaiters.length) {
      const waiters = this._frameWaiters;
      this._frameWaiters = [];
      for (const resolve of waiters) resolve(dt);
    }
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      const a = this._shakeAmp * Math.min(1, this._shakeT * 3);
      this.camera.position.x += rand(-a, a);
      this.camera.position.y += rand(-a, a);
    }
    if (this.location === 'grounds') this._updateGrounds(dt);
    else if (this.location === 'underground') this._updateUnderground(dt);
    else if (this.location === 'dawn') this._updateDawn(dt);
  }

  _updateGrounds(dt) {
    for (const u of this.world.updatables) u.update(dt); // rain, the doors, the (hidden) cast
    this.storm.update(dt);
    this._updateLightning(dt);
    this.scrapBeamMat.uniforms.uTime.value = this.time;
    const hunting = this.phase === 'evade';
    for (const s of this.scrappers) s.update(dt);
    for (const c of Object.values(this.clues)) {
      if (c.taken) continue;
      c.glow.material.opacity = 0.7 + Math.sin(this.time * 3 + c.def.x) * 0.3;
      c.model.rotation.y += dt * 1.2;
    }
    this._updateRocks(dt);
    if (hunting) {
      this._updateBounds(dt);
      this._updateHud();
      this._updateTension(dt); // your pulse, the stuttering light
      this._updatePA(dt); // Billing on the campus PA
      // A Scrapper right up against you while you're pinned in a corner still counts: it grabs at a touch.
    }
    this.player.setCharacters(this.scrappers.filter((s) => s.thinking));
  }

  /** Walking into the edge of the campus: a warning (you're not leaving Ben behind). */
  _updateBounds(dt) {
    this._boundsT = Math.max(0, this._boundsT - dt);
    if (this._boundsT > 0) return;
    const { x, z } = this.player.object.position;
    const B = BOUNDS;
    const north = x < -B.schoolHalf ? B.northWest : x > B.schoolHalf ? B.northEast : Infinity;
    if (x < B.minX + 0.7 || x > B.maxX - 0.7 || z < B.minZ + 0.7 || z > north - 0.7) {
      this._boundsT = 3;
      this.ui.showMessage("[WARNING] You can't abandon Ben!", 1800);
    }
  }

  _updateHud() {
    const meter = this.stealth;
    let fill = 0;
    let label = 'HIDDEN';
    let color = '#7d8790';
    const st = (name) => this.scrappers.some((s) => s.state === name);
    if (st('chase') || st('alert')) {
      label = 'SPOTTED!';
      color = '#e0584f';
      fill = 1;
    } else if (st('search') || st('investigate')) {
      label = 'SEARCHING ?';
      color = '#e0903a';
      fill = 0.6;
    } else if (this.player.flashlightOn) {
      label = 'LIGHT ON: VISIBLE';
      color = '#e0b43a';
      fill = 0.25;
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
  }

  _updateUnderground(dt) {
    const ug = this.ug;
    for (const u of ug.updatables) u.update(dt);
    ug.updatePulse(this.time);
    ug.beams.update(dt, this.player, this.phase !== 'gallery' && !this.cutscene && this.beamsLive !== false);
    // The furnace's flicker and the alarm strobe.
    const f = ug.hall;
    if (f.furnaceLight.intensity > 1) {
      f.furnaceLight.intensity = 32 + Math.sin(this.time * 9) * 5 + Math.random() * 4;
      f.flames.forEach((fl) => fl.sp.scale.setScalar(3 + Math.sin(this.time * 6 + fl.phase) * 0.5 + Math.random() * 0.3));
    }
    if (ug.lights.alarm.intensity > 1) ug.lights.alarm.intensity = 14 + Math.sin(this.time * 8) * 14;
    if (this.phase === 'gallery') {
      const p = this.player.object.position;
      if (p.z < 18.6) this._playCliffhanger();
    }
    this._updateUndergroundPart2?.(dt);
  }

  // ---- Hooks main.js calls ----------------------------------------------------------------------------

  handleInteract(target) {
    const d = target.userData;
    switch (d.type) {
      case 'sc-trunk':
        if (this.phase === 'evade0') this._takeKit();
        break;
      case 'sc-clue':
        if (this.phase === 'evade') this._pickClue(d.id);
        break;
      case 'sc-rocks':
        if (this.phase === 'evade') this._takeRocks(d.pile);
        break;
      case 'sc-hatch':
        this._useHatch();
        break;
      default:
        if (this.handleInteractPart2) this.handleInteractPart2(target);
        break;
    }
  }

  /** [E] with nothing targeted (nothing to do here). */
  onUse() {
    return false;
  }

  /** Where main.js should put the bobbing objective marker (or null). */
  markerTarget() {
    if (this.cutscene) return null;
    if (this.location === 'grounds') {
      if (this.phase === 'evade0') return { key: 'sc-trunk', position: this._tmp2.set(CAR.x, 2.3, CAR.z - 2.2), scale: 0.8 };
      if (this.phase === 'evade') {
        if (this.collected.size >= CLUE_DEFS.length) return { key: 'sc-hatch', position: this._tmp2.set(HATCH.x, 2.9, HATCH.z), scale: 1.1 };
        const p = this.player.object.position;
        let best = null;
        let bestD = Infinity;
        for (const d of CLUE_DEFS) {
          if (this.collected.has(d.id)) continue;
          const dist = Math.hypot(d.x - p.x, d.z - p.z);
          if (dist < bestD) {
            bestD = dist;
            best = d;
          }
        }
        if (best) return { key: `sc-clue-${best.id}`, position: this._tmp2.set(best.x, 2.4, best.z), scale: 0.9 };
      }
      return null;
    }
    if (this.phase === 'gallery') return { key: 'sc-blast', position: this._tmp2.set(0, 3.4, 14.4), scale: 0.9 };
    return this.markerTargetPart2 ? this.markerTargetPart2() : null;
  }
}


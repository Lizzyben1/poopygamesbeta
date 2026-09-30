import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { playMetalDoorSlam, playDeadbolt, playDoorBurst, playLockerDoor } from './audio.js';

/*
 * Chapter 3 — the boys' locker room, inside the west wing. Loaded (as its own
 * scene) once you slip in through the side door and the grounds are unloaded.
 * You cross it west to east, to the gym's double doors, while Coach Billing
 * walks his rounds with a flashlight.
 *
 *   x = -20 ........... the exterior door you came in by, in a little alcove
 *   x = -12 .. 4 ....... the changing hall: five double-sided locker banks (N-S),
 *                        benches in the aisles, walkways along the north and south walls
 *   x = 8 .............. the sinks (a tiled half-wall with mirrors)
 *   NE (x 13..22) ...... Coach Billing's office (glass windows onto the room)
 *   SE (x 10..22) ...... the shower corridor: stalls down the south wall, wet tile
 *   x = 22, z = 0 ...... the double doors to the gym (the way on)
 *
 * The tall lockers with the lighter doors are the ones you can hide in ([E]):
 * you watch through the vent louvers.
 */
export const LOCKER_ROOM = { minX: -20, maxX: 22, minZ: -12, maxZ: 12, height: 3.4 };
const R = LOCKER_ROOM;
const HALL_WEST = -16.5; // the main room's west wall (the alcove pokes out past it)
const ALCOVE = { minZ: -3.5, maxZ: 3.5 };
const ENTRY = { z: 0, half: 0.6, height: 2.25 };
const GYM_DOOR = { z: 0, half: 1.5, height: 2.5 };
const HALL_DOOR = { x: -4, half: 0.65, height: 2.25 }; // to the school hallway (north wall): chained
const BANK_XS = [-12, -8, -4, 0, 4];
const BANK = { minZ: -6.5, maxZ: 6.5, depth: 0.9, height: 2.15 };
const SINKS = { x: 8, minZ: -4.5, maxZ: 4.5, height: 2.4 };
const OFFICE = { minX: 13, minZ: 5, doorX: 14.6, doorHalf: 0.55 };
const SHOWERS = { minX: 10, wallZ: -5.5, stallZ: -9.8, wallEndX: 19 };

// Hideable lockers: [x, z, yaw, freestanding] — yaw = the way the door faces
// (0 = +Z); freestanding ones get a cabinet of their own behind the door (the
// rest are set into a bank or a row of wall lockers).
const HIDE_LOCKERS = [
  [-18.6, 3.0, Math.PI, true], // the alcove
  [-12.45, -4.2, -Math.PI / 2], [-12.45, 3.4, -Math.PI / 2], [-11.55, 0.6, Math.PI / 2], // bank 1
  [-8.45, -2.2, -Math.PI / 2], [-7.55, 4.2, Math.PI / 2], [-7.55, -5.1, Math.PI / 2], // bank 2
  [-4.45, 1.2, -Math.PI / 2], [-3.55, -4.4, Math.PI / 2], // bank 3
  [-0.45, 4.6, -Math.PI / 2], [0.45, -1.4, Math.PI / 2], // bank 4
  [3.55, -3.4, -Math.PI / 2], [4.45, 2.6, Math.PI / 2], [4.45, -5.2, Math.PI / 2], // bank 5
  [-13.2, 11.5, Math.PI], [-9.4, 11.5, Math.PI], [1.2, 11.5, Math.PI], [5.6, 11.5, Math.PI], // north wall
  [-14.2, -11.5, 0], [-8.6, -11.5, 0], [-1.2, -11.5, 0], [4.2, -11.5, 0], // south wall
  [12.6, -4.88, 0, true], // against the shower wall
  [21.5, 4.3, -Math.PI / 2, true], // by the gym doors
];

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function texture(canvas, repeat = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  return t;
}

function speckle(g, w, h, count, alpha) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.6})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}

/** Blue-grey floor tiles (one tile of texture = 1m). */
function createFloorTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.fillStyle = '#56626b';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 64) {
    for (let x = 0; x < 256; x += 64) {
      g.fillStyle = (x + y) % 128 ? '#5d6a73' : '#515c64';
      g.fillRect(x + 2, y + 2, 60, 60);
    }
  }
  speckle(g, 256, 256, 1400, 0.07);
  return texture(c);
}

/** Painted cinderblock (one tile = 1.6m x 1.6m). */
function createBlockTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.fillStyle = '#b9c2b4';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(70,80,70,0.45)';
  g.lineWidth = 3;
  for (let row = 0; row < 8; row++) {
    const y = row * 32;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
    for (let x = row % 2 ? 32 : 0; x < 256; x += 64) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + 32);
      g.stroke();
    }
  }
  g.fillStyle = 'rgba(29,63,115,0.85)'; // a painted stripe at waist height
  g.fillRect(0, 150, 256, 18);
  speckle(g, 256, 256, 1600, 0.06);
  return texture(c);
}

/** One locker door (vents, handle, number plate); tiled along each bank. */
function createLockerTexture() {
  const c = makeCanvas(128, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#2d4f7a';
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#1b304c';
  g.lineWidth = 4;
  g.strokeRect(3, 3, 122, 250);
  g.fillStyle = '#1b304c';
  for (let i = 0; i < 6; i++) g.fillRect(34, 20 + i * 9, 60, 4);
  for (let i = 0; i < 6; i++) g.fillRect(34, 196 + i * 8, 60, 3);
  g.fillStyle = '#b8c0c6';
  g.fillRect(96, 110, 10, 34);
  g.fillStyle = '#d9dee3';
  g.fillRect(44, 82, 40, 16);
  speckle(g, 128, 256, 600, 0.08);
  return texture(c);
}

/** A full-height gear locker you can climb into: lighter, with big vent louvers at eye level. */
function createHideDoorTexture() {
  const c = makeCanvas(128, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#5a87b5';
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#2c4a6c';
  g.lineWidth = 5;
  g.strokeRect(3, 3, 122, 250);
  g.fillStyle = '#1a2a3c';
  for (let i = 0; i < 9; i++) g.fillRect(20, 30 + i * 8, 88, 4); // the louvers you look out through
  for (let i = 0; i < 5; i++) g.fillRect(28, 206 + i * 8, 72, 3);
  g.fillStyle = '#c9d0d6';
  g.fillRect(100, 118, 10, 36);
  g.fillStyle = '#e0c34a'; // a strip of yellow tape: "this one's empty"
  g.fillRect(40, 108, 48, 12);
  speckle(g, 128, 256, 700, 0.09);
  return texture(c, false);
}

/** Small white shower tiles. */
function createShowerTileTexture() {
  const c = makeCanvas(128);
  const g = c.getContext('2d');
  g.fillStyle = '#9aa3a6';
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) {
    for (let x = 0; x < 128; x += 16) {
      g.fillStyle = Math.random() < 0.08 ? '#c9cfc9' : '#dfe4e2';
      g.fillRect(x + 1, y + 1, 14, 14);
    }
  }
  speckle(g, 128, 128, 500, 0.08);
  return texture(c);
}

function createSignTexture(text, { bg = '#1b3f73', fg = '#dfe6ee', w = 256, h = 64, size = 28 } = {}) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = fg;
  g.lineWidth = 3;
  g.strokeRect(4, 4, w - 8, h - 8);
  g.fillStyle = fg;
  g.font = `bold ${size}px Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2);
  return texture(c, false);
}

/** The office whiteboard: X's and O's, arrows, and the plan. */
function createPlaysTexture() {
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#eef0ec';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#2a3a8a';
  g.fillStyle = '#2a3a8a';
  g.lineWidth = 4;
  g.font = 'bold 30px "Comic Sans MS", cursive';
  for (let i = 0; i < 5; i++) g.fillText('X', 60 + i * 70, 80 + (i % 2) * 30);
  g.strokeStyle = '#b3261e';
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.arc(90 + i * 80, 170, 14, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(60, 110);
  g.quadraticCurveTo(200, 30, 380, 120);
  g.stroke();
  g.fillStyle = '#b3261e';
  g.font = 'bold 34px "Comic Sans MS", cursive';
  g.fillText('MECHA = GAME DAY', 130, 232);
  return texture(c, false);
}

/** A strip of wet night seen through the doorway (the grounds themselves are unloaded by now). */
function createNightTexture() {
  const c = makeCanvas(128, 256);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#0b1018');
  sky.addColorStop(0.7, '#141b24');
  sky.addColorStop(1, '#1d1a16');
  g.fillStyle = sky;
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = 'rgba(170,190,210,0.18)';
  g.lineWidth = 1;
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * 128;
    const y = Math.random() * 256;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 2, y + 14 + Math.random() * 10);
    g.stroke();
  }
  return texture(c, false);
}

/** Trophies and team photos behind glass. */
function createTrophyTexture() {
  const c = makeCanvas(256, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#2a211a';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 6; i++) {
    const x = 18 + i * 40;
    g.fillStyle = i % 2 ? '#c9a13a' : '#b0b8bf';
    g.fillRect(x + 8, 60, 16, 30);
    g.beginPath();
    g.arc(x + 16, 52, 12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#4a3a2a';
    g.fillRect(x + 4, 90, 24, 8);
  }
  g.fillStyle = '#d9dee3';
  g.font = 'bold 14px Arial';
  g.fillText('XC STATE CHAMPS', 64, 20);
  return texture(c, false);
}

/** Tile a box's UVs every `tile` meters. */
function tileBox(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * faces[f][0]) / tile, (uv.getY(k) * faces[f][1]) / tile);
    }
  }
  return geo;
}

// ---------------------------------------------------------------------------
// The locker room
// ---------------------------------------------------------------------------

export function buildLockerRoom() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050607);
  scene.fog = new THREE.FogExp2(0x0a0c0e, 0.04);
  const colliders = [];
  const occluders = [];
  const interactables = [];
  const updatables = [];

  const mats = {
    floor: new THREE.MeshStandardMaterial({ map: createFloorTexture(), roughness: 0.55, metalness: 0.05 }),
    wall: new THREE.MeshStandardMaterial({ map: createBlockTexture(), roughness: 0.9 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0x8e948f, roughness: 1 }),
    locker: new THREE.MeshStandardMaterial({ map: createLockerTexture(), roughness: 0.45, metalness: 0.35 }),
    lockerTrim: new THREE.MeshStandardMaterial({ color: 0x1d2f45, roughness: 0.5, metalness: 0.3 }),
    bench: new THREE.MeshStandardMaterial({ color: 0x9a6b3e, roughness: 0.6 }),
    benchLeg: new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.5, metalness: 0.5 }),
    tile: new THREE.MeshStandardMaterial({ map: createShowerTileTexture(), roughness: 0.25, metalness: 0.05 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x9ea6ab, roughness: 0.3, metalness: 0.8 }),
    door: new THREE.MeshStandardMaterial({ color: 0x5d6b73, roughness: 0.5, metalness: 0.35 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x3f4448, roughness: 0.6 }),
    fixture: new THREE.MeshStandardMaterial({ color: 0xe8f0ff, emissive: 0xdfe9ff, emissiveIntensity: 0.8 }),
    fixtureOff: new THREE.MeshStandardMaterial({ color: 0x6d7378, emissive: 0x1a1d20, emissiveIntensity: 1 }),
    mirror: new THREE.MeshStandardMaterial({ color: 0x8fa0a8, roughness: 0.05, metalness: 0.95 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x5f7580, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.35, depthWrite: false }),
    desk: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.7 }),
    cabinet: new THREE.MeshStandardMaterial({ color: 0x6e7479, roughness: 0.5, metalness: 0.4 }),
    cart: new THREE.MeshStandardMaterial({ color: 0x7d8a93, roughness: 0.6, metalness: 0.5 }),
    towels: new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 1 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6a4e34, roughness: 0.75 }),
    exit: new THREE.MeshBasicMaterial({ map: createSignTexture('EXIT', { bg: '#3a0605', fg: '#ff4a3a', w: 128, h: 48, size: 30 }) }),
    gymGlow: new THREE.MeshBasicMaterial({ color: 0x9fb4c8 }),
    alarm: new THREE.MeshBasicMaterial({ color: 0x3a0806 }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
  const hideDoorTex = createHideDoorTexture();

  // Static geometry merged per material at the end (a handful of draw calls).
  const batch = new Map();
  const toBatch = (mesh) => {
    mesh.updateMatrix();
    let list = batch.get(mesh.material);
    if (!list) batch.set(mesh.material, (list = []));
    list.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));
  };
  function box({ w, h, d, x, y, z, material, collider = true, occluder = false, tile = 0, rotationY = 0, static: isStatic = true }) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (tile) tileBox(geo, w, h, d, tile);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    if (material.visible !== false) {
      if (isStatic) toBatch(mesh);
      else scene.add(mesh);
    }
    if (collider) colliders.push(mesh);
    if (occluder) occluders.push(mesh);
    return mesh;
  }
  // A solid, sight-blocking wall piece from (x0, z0) to (x1, z1).
  const wallAt = (x0, x1, z0, z1, { h = R.height, y = h / 2, material = mats.wall, tile = 1.6, collider = true, occluder = true } = {}) =>
    box({ w: Math.max(0.05, x1 - x0), h, d: Math.max(0.05, z1 - z0), x: (x0 + x1) / 2, y, z: (z0 + z1) / 2, material, tile, collider, occluder });
  const T = 0.3;

  // ---- Shell --------------------------------------------------------------------
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  const floorGeo = new THREE.PlaneGeometry(W, D);
  floorGeo.attributes.uv.array.forEach((v, i, a) => {
    a[i] = v * (i % 2 ? D : W) * 0.5;
  });
  const floor = new THREE.Mesh(floorGeo, mats.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((R.minX + R.maxX) / 2, 0, 0);
  toBatch(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mats.ceiling);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set((R.minX + R.maxX) / 2, R.height, 0);
  toBatch(ceiling);

  // North wall (the chained hallway door at x = HALL_DOOR.x) and south wall.
  wallAt(HALL_WEST - T, HALL_DOOR.x - HALL_DOOR.half, R.maxZ, R.maxZ + T);
  wallAt(HALL_DOOR.x + HALL_DOOR.half, R.maxX + T, R.maxZ, R.maxZ + T);
  wallAt(HALL_DOOR.x - HALL_DOOR.half, HALL_DOOR.x + HALL_DOOR.half, R.maxZ, R.maxZ + T, { h: R.height - HALL_DOOR.height, y: (R.height + HALL_DOOR.height) / 2, collider: false });
  wallAt(HALL_WEST - T, R.maxX + T, R.minZ - T, R.minZ);
  // West: the main wall, with the alcove poking out to the exterior door.
  wallAt(HALL_WEST - T, HALL_WEST, R.minZ, ALCOVE.minZ);
  wallAt(HALL_WEST - T, HALL_WEST, ALCOVE.maxZ, R.maxZ);
  wallAt(R.minX, HALL_WEST, ALCOVE.minZ - T, ALCOVE.minZ);
  wallAt(R.minX, HALL_WEST, ALCOVE.maxZ, ALCOVE.maxZ + T);
  wallAt(R.minX - T, R.minX, ALCOVE.minZ, ENTRY.z - ENTRY.half);
  wallAt(R.minX - T, R.minX, ENTRY.z + ENTRY.half, ALCOVE.maxZ);
  wallAt(R.minX - T, R.minX, ENTRY.z - ENTRY.half, ENTRY.z + ENTRY.half, { h: R.height - ENTRY.height, y: (R.height + ENTRY.height) / 2, collider: false });
  // East: the gym's double doors in the middle.
  wallAt(R.maxX, R.maxX + T, R.minZ, GYM_DOOR.z - GYM_DOOR.half);
  wallAt(R.maxX, R.maxX + T, GYM_DOOR.z + GYM_DOOR.half, R.maxZ);
  wallAt(R.maxX, R.maxX + T, GYM_DOOR.z - GYM_DOOR.half, GYM_DOOR.z + GYM_DOOR.half, { h: R.height - GYM_DOOR.height, y: (R.height + GYM_DOOR.height) / 2, collider: false });
  // (The alcove's floor/ceiling are covered by the main planes; its dead corners are solid blocks.)

  // ---- The changing hall: five double-sided banks, benches between ---------------------
  const bankLen = BANK.maxZ - BANK.minZ;
  const bankZ = (BANK.minZ + BANK.maxZ) / 2;
  BANK_XS.forEach((x) => {
    const geo = new THREE.BoxGeometry(BANK.depth, BANK.height, bankLen);
    const uv = geo.attributes.uv;
    for (let f = 0; f < 2; f++) {
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i;
        uv.setXY(k, uv.getX(k) * (bankLen / 0.5), uv.getY(k));
      }
    }
    const mesh = new THREE.Mesh(geo, [mats.locker, mats.locker, mats.lockerTrim, mats.lockerTrim, mats.lockerTrim, mats.lockerTrim]);
    mesh.position.set(x, BANK.height / 2, bankZ);
    scene.add(mesh);
    colliders.push(mesh);
    occluders.push(mesh);
    box({ w: BANK.depth + 0.1, h: 0.08, d: bankLen + 0.1, x, y: BANK.height + 0.04, z: bankZ, material: mats.lockerTrim, collider: false });
  });
  // Benches down the middle of each aisle (the ends stay open to walk around).
  for (let i = 0; i < BANK_XS.length - 1; i++) {
    const x = (BANK_XS[i] + BANK_XS[i + 1]) / 2;
    const len = 5.2;
    box({ w: 0.42, h: 0.06, d: len, x, y: 0.45, z: 0, material: mats.bench, collider: false });
    [-1, 1].forEach((s) => box({ w: 0.08, h: 0.42, d: 0.08, x, y: 0.21, z: s * (len / 2 - 0.4), material: mats.benchLeg, collider: false }));
    colliders.push(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.48, len), mats.hidden).translateX(x).translateY(0.24));
  }
  // Wall lockers along the north and south walls (with a bench in front of the south ones).
  const wallLockers = (x0, x1, z, faceIndex) => {
    const len = x1 - x0;
    const geo = new THREE.BoxGeometry(len, BANK.height, 0.5);
    const uv = geo.attributes.uv;
    for (let i = 0; i < 4; i++) {
      const k = faceIndex * 4 + i;
      uv.setXY(k, uv.getX(k) * (len / 0.5), uv.getY(k));
    }
    const faces = [mats.lockerTrim, mats.lockerTrim, mats.lockerTrim, mats.lockerTrim, mats.lockerTrim, mats.lockerTrim];
    faces[faceIndex] = mats.locker;
    const mesh = new THREE.Mesh(geo, faces);
    mesh.position.set((x0 + x1) / 2, BANK.height / 2, z);
    scene.add(mesh);
    colliders.push(mesh);
    occluders.push(mesh);
  };
  wallLockers(HALL_WEST + 0.3, -8, R.maxZ - 0.25, 5); // (face 5 = -Z, into the room)
  wallLockers(-3, 7, R.maxZ - 0.25, 5);
  wallLockers(HALL_WEST + 0.3, 7, R.minZ + 0.25, 4); // (face 4 = +Z)
  [-11.2, -4.6, 1.6].forEach((x) => {
    box({ w: 3.2, h: 0.06, d: 0.42, x, y: 0.45, z: R.minZ + 1.4, material: mats.bench, collider: false });
    [-1, 1].forEach((s) => box({ w: 0.08, h: 0.42, d: 0.08, x: x + s * 1.2, y: 0.21, z: R.minZ + 1.4, material: mats.benchLeg, collider: false }));
    colliders.push(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.48, 0.42), mats.hidden).translateX(x).translateY(0.24).translateZ(R.minZ + 1.4));
  });
  // A trophy case on the north wall, between the lockers (by the chained hallway door).
  box({ w: 1.6, h: 1.1, d: 0.4, x: -6.5, y: 1.25, z: R.maxZ - 0.22, material: mats.wood });
  const trophies = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.8), new THREE.MeshStandardMaterial({ map: createTrophyTexture(), roughness: 0.5 }));
  trophies.position.set(-6.5, 1.28, R.maxZ - 0.43);
  trophies.rotation.y = Math.PI;
  scene.add(trophies);

  // ---- The sinks: a tiled half-wall with basins and mirrors on the hall side -----------
  box({ w: 0.3, h: SINKS.height, d: SINKS.maxZ - SINKS.minZ, x: SINKS.x, y: SINKS.height / 2, z: 0, material: mats.tile, tile: 1, occluder: true });
  for (let z = SINKS.minZ + 1.1; z < SINKS.maxZ - 0.6; z += 1.6) {
    box({ w: 0.5, h: 0.18, d: 0.6, x: SINKS.x - 0.4, y: 0.85, z, material: mats.tile });
    box({ w: 0.04, h: 0.7, d: 0.55, x: SINKS.x - 0.17, y: 1.6, z, material: mats.mirror, collider: false });
    box({ w: 0.12, h: 0.04, d: 0.04, x: SINKS.x - 0.28, y: 1.02, z, material: mats.steel, collider: false });
  }

  // ---- Coach's office (NE): glass onto the room, a desk, the plays board ---------------
  {
    const oz = OFFICE.minZ;
    // South wall: door gap, then a long window.
    wallAt(OFFICE.minX, OFFICE.doorX - OFFICE.doorHalf, oz - 0.08, oz + 0.08);
    wallAt(OFFICE.doorX + OFFICE.doorHalf, 16, oz - 0.08, oz + 0.08);
    wallAt(16, R.maxX, oz - 0.08, oz + 0.08, { h: 1.0, y: 0.5 });
    wallAt(16, R.maxX, oz - 0.08, oz + 0.08, { h: 0.9, y: R.height - 0.45, collider: false });
    wallAt(OFFICE.doorX - OFFICE.doorHalf, OFFICE.doorX + OFFICE.doorHalf, oz - 0.08, oz + 0.08, { h: R.height - 2.25, y: (R.height + 2.25) / 2, collider: false });
    const southPane = box({ w: R.maxX - 16, h: 1.5, d: 0.03, x: (16 + R.maxX) / 2, y: 1.75, z: oz, material: mats.glass, static: false });
    southPane.renderOrder = 2;
    // West wall: a window onto the north walkway.
    wallAt(OFFICE.minX - 0.08, OFFICE.minX + 0.08, oz, 6.5);
    wallAt(OFFICE.minX - 0.08, OFFICE.minX + 0.08, 10.5, R.maxZ);
    wallAt(OFFICE.minX - 0.08, OFFICE.minX + 0.08, 6.5, 10.5, { h: 1.0, y: 0.5 });
    wallAt(OFFICE.minX - 0.08, OFFICE.minX + 0.08, 6.5, 10.5, { h: 0.9, y: R.height - 0.45, collider: false });
    const westPane = box({ w: 0.03, h: 1.5, d: 4, x: OFFICE.minX, y: 1.75, z: 8.5, material: mats.glass, static: false });
    westPane.renderOrder = 2;
    box({ w: 1.6, h: 0.76, d: 0.8, x: 18.5, y: 0.38, z: 9.8, material: mats.desk, occluder: true });
    box({ w: 0.55, h: 1.3, d: 0.6, x: 21.4, y: 0.65, z: 6.2, material: mats.cabinet, occluder: true });
    box({ w: 0.6, h: 0.9, d: 0.6, x: 13.6, y: 0.45, z: 11.3, material: mats.cabinet });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshStandardMaterial({ map: createPlaysTexture(), roughness: 0.4 }));
    board.position.set(18.2, 1.7, R.maxZ - 0.02);
    board.rotation.y = Math.PI;
    scene.add(board);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.24), new THREE.MeshStandardMaterial({ map: createSignTexture("COACH'S OFFICE", { size: 24 }), roughness: 0.6 }));
    sign.position.set(OFFICE.doorX, 2.7, oz - 0.1);
    sign.rotation.y = Math.PI;
    scene.add(sign);
  }
  // The office door (Billing comes out through it): hinged on its west jamb, swings out into the room.
  const officePivot = new THREE.Group();
  officePivot.position.set(OFFICE.doorX - OFFICE.doorHalf + 0.02, 0.01, OFFICE.minZ - 0.04);
  scene.add(officePivot);
  const officeLeaf = new THREE.Mesh(new THREE.BoxGeometry(OFFICE.doorHalf * 2 - 0.05, 2.2, 0.06), mats.door);
  officeLeaf.position.set(OFFICE.doorHalf - 0.02, 1.1, 0);
  officePivot.add(officeLeaf);
  const officeWindow = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.07), mats.glass);
  officeWindow.position.set(0.1, 0.45, 0);
  officeLeaf.add(officeWindow);

  // ---- The shower corridor (SE): stalls down the south wall, a tiled wall along its north side ----
  wallAt(SHOWERS.minX, SHOWERS.wallEndX, SHOWERS.wallZ - 0.12, SHOWERS.wallZ + 0.12, { material: mats.tile, tile: 1 });
  for (let x = SHOWERS.minX + 1; x <= R.maxX - 1; x += 2.2) {
    wallAt(x - 0.06, x + 0.06, R.minZ, SHOWERS.stallZ, { h: 2.0, material: mats.tile, tile: 1 });
    box({ w: 0.12, h: 0.06, d: 0.2, x: x + 1.1, y: 2.1, z: R.minZ + 0.12, material: mats.steel, collider: false });
    box({ w: 0.24, h: 0.01, d: 0.24, x: x + 1.1, y: 0.006, z: R.minZ + 1.0, material: mats.benchLeg, collider: false });
  }
  const puddle = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), new THREE.MeshStandardMaterial({ color: 0x1a2328, roughness: 0.02, metalness: 0.6, transparent: true, opacity: 0.55, depthWrite: false }));
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(15.5, 0.008, -8.2);
  scene.add(puddle);
  const showerSign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.22), new THREE.MeshStandardMaterial({ map: createSignTexture('SHOWERS', { size: 24 }), roughness: 0.6 }));
  showerSign.position.set(SHOWERS.minX - 0.01, 2.6, -5.9);
  showerSign.rotation.y = -Math.PI / 2;
  scene.add(showerSign);

  // ---- The approach to the gym doors: laundry carts, a towel shelf --------------------
  [[15.2, -2.2, 0.3], [18.6, 2.6, -0.2], [11.4, 7.8, 0.1]].forEach(([x, z, r]) => {
    box({ w: 1.2, h: 0.95, d: 0.75, x, y: 0.55, z, material: mats.cart, rotationY: r, occluder: true });
    box({ w: 1.1, h: 0.25, d: 0.65, x, y: 1.1, z, material: mats.towels, collider: false, rotationY: r });
  });
  box({ w: 0.5, h: 2.0, d: 2.2, x: 13.4, y: 1.0, z: 1.4, material: mats.wood, occluder: true });
  for (let y = 0.4; y < 2; y += 0.5) box({ w: 0.46, h: 0.22, d: 2.0, x: 13.4, y, z: 1.4, material: mats.towels, collider: false });

  // ---- Doors ---------------------------------------------------------------------
  // The exterior door you came in by: swings inward (+X), with a heavy deadbolt on this side.
  const entryPivot = new THREE.Group();
  entryPivot.position.set(R.minX - 0.04, 0.02, ENTRY.z + ENTRY.half - 0.03);
  scene.add(entryPivot);
  const entryLeaf = new THREE.Mesh(new THREE.BoxGeometry(0.07, ENTRY.height - 0.06, ENTRY.half * 2 - 0.06), mats.door);
  entryLeaf.position.set(0.035, (ENTRY.height - 0.06) / 2, -(ENTRY.half - 0.03));
  entryPivot.add(entryLeaf);
  const pushBar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.8), mats.steel);
  pushBar.position.set(0.07, -0.1, 0);
  entryLeaf.add(pushBar);
  const boltHousing = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.3), mats.steel);
  boltHousing.position.set(0.07, 0.25, -0.35);
  entryLeaf.add(boltHousing);
  const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.32), mats.steel);
  bolt.position.set(0.105, 0.25, -0.35); // (proud of the housing and the frame: no coplanar faces)
  entryLeaf.add(bolt);
  box({ w: 0.12, h: 0.16, d: 0.12, x: R.minX + 0.08, y: 1.35, z: ENTRY.z - ENTRY.half - 0.02, material: mats.steel, collider: false }); // strike plate, proud of the frame
  [-1, 1].forEach((s) => box({ w: 0.14, h: ENTRY.height, d: 0.1, x: R.minX + 0.03, y: ENTRY.height / 2, z: ENTRY.z + s * (ENTRY.half + 0.04), material: mats.frame, collider: false }));
  box({ w: 0.14, h: 0.1, d: ENTRY.half * 2 + 0.2, x: R.minX + 0.03, y: ENTRY.height + 0.05, z: ENTRY.z, material: mats.frame, collider: false });
  colliders.push(entryLeaf);
  const night = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ map: createNightTexture(), fog: false }));
  night.position.set(R.minX - 1.2, 1.4, ENTRY.z);
  night.rotation.y = Math.PI / 2;
  scene.add(night);

  // The chained hallway door (north wall).
  const hallLeaf = box({ w: HALL_DOOR.half * 2 - 0.06, h: HALL_DOOR.height - 0.04, d: 0.07, x: HALL_DOOR.x, y: (HALL_DOOR.height - 0.04) / 2, z: R.maxZ + 0.05, material: mats.door, static: false });
  hallLeaf.userData = { interactable: true, label: 'Door to the hallway', type: 'ch3-hall-door' };
  interactables.push(hallLeaf);
  box({ w: 0.8, h: 0.05, d: 0.05, x: HALL_DOOR.x, y: 1.05, z: R.maxZ - 0.02, material: mats.steel, collider: false }); // the chain

  // The gym's double doors: two leaves hinged at the jambs, swinging out into the gym.
  const gymLeaves = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(R.maxX + 0.04, 0.02, GYM_DOOR.z + s * GYM_DOOR.half);
    scene.add(pivot);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.07, GYM_DOOR.height - 0.06, GYM_DOOR.half - 0.04), mats.door);
    leaf.position.set(0, (GYM_DOOR.height - 0.06) / 2, -s * (GYM_DOOR.half / 2));
    pivot.add(leaf);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, GYM_DOOR.half - 0.3), mats.steel);
    bar.position.set(-0.06, -0.15, 0);
    leaf.add(bar);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.3), mats.gymGlow);
    win.position.set(0, 0.55, 0);
    leaf.add(win);
    colliders.push(leaf);
    occluders.push(leaf);
    leaf.userData = { interactable: true, label: 'Push through into the gym', type: 'ch3-gym-door' };
    interactables.push(leaf);
    return { pivot, leaf, s };
  });
  box({ w: 0.14, h: 0.12, d: GYM_DOOR.half * 2 + 0.3, x: R.maxX - 0.02, y: GYM_DOOR.height + 0.06, z: GYM_DOOR.z, material: mats.frame, collider: false });
  box({ w: 0.02, h: 0.03, d: GYM_DOOR.half * 2 - 0.1, x: R.maxX - 0.05, y: 0.015, z: GYM_DOOR.z, material: mats.gymGlow, collider: false }); // light under the doors
  const gymSign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.3), new THREE.MeshStandardMaterial({ map: createSignTexture('GYMNASIUM', { size: 26 }), roughness: 0.6 }));
  gymSign.position.set(R.maxX - 0.02, GYM_DOOR.height + 0.42, GYM_DOOR.z);
  gymSign.rotation.y = -Math.PI / 2;
  scene.add(gymSign);
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.18), mats.exit);
  exitSign.position.set(R.maxX - 0.02, GYM_DOOR.height + 0.85, GYM_DOOR.z);
  exitSign.rotation.y = -Math.PI / 2;
  scene.add(exitSign);

  // ---- Hideable lockers --------------------------------------------------------------
  const hideSpots = HIDE_LOCKERS.map(([x, z, yaw, freestanding], id) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw; // local +Z = the way the door faces
    scene.add(group);
    const doorMat = new THREE.MeshStandardMaterial({ map: hideDoorTex, roughness: 0.4, metalness: 0.4, emissive: 0x000000 });
    if (freestanding) {
      const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.76, 2.14, 0.5), mats.lockerTrim);
      cabinet.position.set(0, 1.07, -0.25);
      group.add(cabinet);
      group.updateMatrixWorld(true);
      colliders.push(cabinet);
      occluders.push(cabinet);
    }
    // A frame proud of the bank face (an open one: you look out through it), the door on a hinge down its left edge.
    for (const [w, h, fx, fy] of [[0.06, 2.1, -0.33, 1.05], [0.06, 2.1, 0.33, 1.05], [0.72, 0.06, 0, 2.07], [0.72, 0.06, 0, 0.03]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), mats.lockerTrim);
      bar.position.set(fx, fy, 0.005);
      group.add(bar);
    }
    const hinge = new THREE.Group();
    hinge.position.set(-0.31, 0, 0.035);
    group.add(hinge);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.98, 0.03), doorMat);
    leaf.position.set(0.31, 1.04, 0);
    hinge.add(leaf);
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.72, 2.0, 0.3), mats.hidden);
    hitbox.position.set(0, 1.0, 0.12);
    group.add(hitbox);
    group.updateMatrixWorld(true);
    const spot = {
      def: { x, z, yaw },
      kind: 'locker',
      id,
      group,
      hinge,
      leaf,
      doorMat,
      hitbox,
      open: 0,
      target: 0,
      speed: 3,
      openAngle: -1.75,
      crackAngle: 0,
      label: 'Hide in the locker',
      eye: group.localToWorld(new THREE.Vector3(0, 1.58, -0.2)),
      exit: group.localToWorld(new THREE.Vector3(0, 0, 0.75)),
      front: group.localToWorld(new THREE.Vector3(0, 0, 1.05)),
      lookYaw: yaw + Math.PI,
      setAngle: (a) => {
        hinge.rotation.y = a;
      },
    };
    hitbox.userData = { interactable: true, label: spot.label, type: 'ch3-hide', spot };
    interactables.push(hitbox);
    return spot;
  });

  // ---- Lights: cold fluorescents (one flickering, two dead), the office lamp, the exit sign ----
  scene.add(new THREE.AmbientLight(0x1c2328, 0.36));
  scene.add(new THREE.HemisphereLight(0x2c343b, 0x08090a, 0.26));
  // [x, z, intensity]: < 1 = dead tube. Index 2 flickers.
  const fixtureSpots = [[-14.2, 0, 3.6], [-6, -8.8, 4.2], [-2, 1.5, 4.4], [-8, 9.2, 0.4], [2, -9.2, 0.4], [11, 0, 4.2], [16, -8, 2.6], [18.4, -1, 4.0]];
  const fixtures = fixtureSpots.map(([x, z, intensity]) => {
    const dead = intensity < 1;
    const mesh = box({ w: 0.3, h: 0.06, d: 1.3, x, y: R.height - 0.04, z, material: dead ? mats.fixtureOff : mats.fixture, collider: false, static: false });
    let light = null;
    if (!dead) {
      light = new THREE.PointLight(0xdce6ff, intensity, 9.5, 1.7);
      light.position.set(x, R.height - 0.3, z);
      scene.add(light);
    }
    return { mesh, light, base: intensity, x, z, on: !dead };
  });
  const officeLamp = new THREE.PointLight(0xffc27a, 4, 8, 1.6);
  officeLamp.position.set(18.2, 1.3, 9.4);
  scene.add(officeLamp);
  const exitGlow = new THREE.PointLight(0xff3a2a, 1.4, 4, 2);
  exitGlow.position.set(R.maxX - 0.5, GYM_DOOR.height + 0.6, GYM_DOOR.z);
  scene.add(exitGlow);
  // Emergency strobes (dark until the alarm goes off).
  const alarmLights = [[-6, 0], [12, -2]].map(([x, z]) => {
    const light = new THREE.PointLight(0xff2a14, 0, 16, 1.6);
    light.position.set(x, R.height - 0.4, z);
    scene.add(light);
    box({ w: 0.28, h: 0.16, d: 0.28, x, y: R.height - 0.08, z, material: mats.alarm, collider: false, static: false });
    return light;
  });

  // Merge the static pieces.
  batch.forEach((list, material) => {
    const merged = new THREE.Mesh(mergeGeometries(list), material);
    merged.matrixAutoUpdate = false;
    scene.add(merged);
    list.forEach((g) => g.dispose());
  });
  for (const c of colliders) c.updateMatrixWorld(true);

  // ---- Per frame: the flickering tube, the doors, the deadbolt, the alarm ------------
  const flicker = { on: true, timer: 2.5, burst: 0 };
  const entry = { open: 0, target: 0, speed: 1, boltT: 0, boltTarget: 0, resolveDoor: null, resolveBolt: null };
  const office = { open: 0, target: 0, speed: 1.4 };
  const gym = { open: 0, target: 0, speed: 1.6 };
  const alarm = { on: false, t: 0 };
  const hover = { spot: null };
  const api = {
    scene,
    colliders,
    occluders,
    interactables,
    updatables,
    hideSpots,
    fixtures,
    // Just inside the exterior door, facing into the room.
    spawn: { position: new THREE.Vector3(R.minX + 1.1, 0, ENTRY.z), yaw: -Math.PI / 2 },
    doorLook: new THREE.Vector3(R.minX, 1.3, ENTRY.z),
    // (Far enough out that the open door leaf, swung back along the doorway's west side, isn't
    // between him and the entrance cutscene's camera: it used to hide half of him.)
    officeDoorStep: new THREE.Vector3(OFFICE.doorX + 0.15, 0, OFFICE.minZ - 1.6),
    officeInside: new THREE.Vector3(OFFICE.doorX + 0.2, 0, OFFICE.minZ + 1.4),
    entryInside: new THREE.Vector3(R.minX + 0.9, 0, ENTRY.z),
    gymDoorStep: new THREE.Vector3(R.maxX - 1.3, 0, GYM_DOOR.z),
    gymDoorLook: new THREE.Vector3(R.maxX, 1.4, GYM_DOOR.z),
    nav: { minX: R.minX - 0.5, maxX: R.maxX + 0.5, minZ: R.minZ - 0.5, maxZ: R.maxZ + 0.5 },
    markers: { gymDoor: new THREE.Vector3(R.maxX - 0.4, GYM_DOOR.height + 0.6, GYM_DOOR.z) },
    /** Is (x, z) under a working light right now? (Easier to spot there.) */
    litAt(x, z) {
      for (const f of fixtures) {
        if (!f.on || !f.light || f.light.intensity < 1) continue;
        if ((x - f.x) ** 2 + (z - f.z) ** 2 < 3.2 * 3.2) return true;
      }
      return (x - 18.2) ** 2 + (z - 9.4) ** 2 < 3.5 * 3.5; // the office lamp
    },
    /** Wet shower tile: every step echoes. */
    wetAt(x, z) {
      return x > SHOWERS.minX && z < SHOWERS.wallZ;
    },
    /** Glow a hideable locker while it's under your crosshair (null = none). */
    setHover(spot) {
      if (hover.spot === spot) return;
      if (hover.spot) hover.spot.doorMat.emissive.setHex(0x000000);
      hover.spot = spot;
      if (spot) spot.doorMat.emissive.setHex(0x3a3310);
    },
    setAlarm(on) {
      alarm.on = on;
      alarm.t = 0;
      if (!on) alarmLights.forEach((l) => (l.intensity = 0));
      mats.alarm.color.setHex(on ? 0xff2a14 : 0x3a0806);
    },
    entryDoor: {
      /** Snap the door to an open amount (0..1) with no animation. */
      set(openAmount) {
        entry.open = entry.target = openAmount;
        entry.resolveDoor = null;
        entryPivot.rotation.y = -1.4 * (1 - (1 - openAmount) ** 2);
        entryLeaf.updateMatrixWorld(true);
      },
      /** Slam it shut; resolves on impact. */
      slam() {
        entry.target = 0;
        entry.speed = 4.5;
        return new Promise((resolve) => {
          entry.resolveDoor = () => {
            playMetalDoorSlam();
            resolve();
          };
        });
      },
      /** Throw the deadbolt; resolves once it's home. */
      throwBolt() {
        entry.boltTarget = 1;
        playDeadbolt();
        return new Promise((resolve) => {
          entry.resolveBolt = resolve;
        });
      },
      /** Bolted shut again (retries). */
      reset() {
        this.set(0);
        entry.boltT = entry.boltTarget = 1;
        bolt.position.z = -0.35 - 0.24;
      },
      /** The ELDARs outside smash it in: the deadbolt snaps and it flies open. */
      burst() {
        entry.boltT = entry.boltTarget = 0;
        bolt.position.z = -0.35;
        entry.target = 1;
        entry.speed = 7;
        playDoorBurst();
      },
    },
    officeDoor: {
      open() {
        office.target = 1;
        playLockerDoor(true);
      },
      close() {
        office.target = 0;
      },
      set(v) {
        office.open = office.target = v;
        officePivot.rotation.y = 1.5 * v;
      },
    },
    gymDoors: {
      open() {
        gym.target = 1;
        playLockerDoor(true);
      },
      leaves: gymLeaves.map((g) => g.leaf),
    },
  };

  updatables.push({
    update(dt) {
      flicker.timer -= dt;
      if (flicker.timer <= 0) {
        flicker.on = !flicker.on;
        if (!flicker.on) flicker.timer = 0.05 + Math.random() * 0.12;
        else if (flicker.burst > 0) {
          flicker.burst--;
          flicker.timer = 0.06 + Math.random() * 0.1;
        } else {
          flicker.burst = Math.floor(Math.random() * 4);
          flicker.timer = 1.5 + Math.random() * 4;
        }
        const f = fixtures[2];
        f.light.intensity = flicker.on ? f.base : 0.5;
        f.mesh.material = flicker.on ? mats.fixture : mats.fixtureOff;
      }
      // Exterior door swing (0 = shut, 1 = open ~80 degrees inward).
      if (entry.open !== entry.target) {
        const step = dt * entry.speed;
        entry.open = entry.target > entry.open ? Math.min(entry.target, entry.open + step) : Math.max(entry.target, entry.open - step);
        const k = entry.target > 0 ? 1 - (1 - entry.open) ** 2 : entry.open ** 1.6;
        entryPivot.rotation.y = -1.4 * k;
        entryLeaf.updateMatrixWorld(true);
        if (entry.open === entry.target && entry.resolveDoor) {
          const r = entry.resolveDoor;
          entry.resolveDoor = null;
          r();
        }
      }
      if (entry.boltT < entry.boltTarget) {
        entry.boltT = Math.min(entry.boltTarget, entry.boltT + dt / 0.35);
        bolt.position.z = -0.35 - 0.24 * entry.boltT;
        if (entry.boltT >= entry.boltTarget && entry.resolveBolt) {
          const r = entry.resolveBolt;
          entry.resolveBolt = null;
          r();
        }
      }
      if (office.open !== office.target) {
        const step = dt * office.speed;
        office.open = office.target > office.open ? Math.min(office.target, office.open + step) : Math.max(office.target, office.open - step);
        officePivot.rotation.y = 1.5 * (1 - (1 - office.open) ** 2);
      }
      if (gym.open !== gym.target) {
        gym.open = Math.min(gym.target, gym.open + dt * gym.speed);
        const k = 1 - (1 - gym.open) ** 2;
        for (const g of gymLeaves) g.pivot.rotation.y = -g.s * 1.3 * k; // (out into the gym)
      }
      if (alarm.on) {
        alarm.t += dt;
        alarmLights.forEach((l, i) => {
          l.intensity = Math.max(0, Math.sin(alarm.t * 7 + i * Math.PI)) * 9;
        });
      }
    },
  });

  return api;
}

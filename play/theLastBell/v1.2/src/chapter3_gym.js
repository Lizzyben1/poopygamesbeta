import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createHumanoid, Character, OTHER_BEN_LOOK } from './world.js';
import { CombatSystem, createRifleMesh, createEldarRig, createEldarMaterials } from './combat.js';
import { difficulty } from './difficulty.js';
import { Achievements } from './achievements.js';
import {
  setRainExposure,
  playPA,
  playCeilingCrash,
  playMetalDoorSlam,
  playKnock,
  playFloorSkid,
  playReloadStep,
  playSlide,
  playSteamVent,
  playEmptyClick,
  playBossRoar,
  playBodyThud,
} from './audio.js';

/*
 * Chapter 3, the finale: the school gym at 3 AM, half again the size of the
 * lab's chamber. Coach Billing comes through the roof in his Mecha.
 *
 *   Phase 1  survive: no weapons. It electrifies half the floor at a time (run for
 *            the green half), floor eruptions, stomps. Sprint + [C] slides.
 *   Phase 2  Other Ben slides an assault rifle under the chained glass doors.
 *            Shoot its ankle actuators until it stumbles, then the cockpit glass.
 *   Phase 3  faster, rapid laser spreads, the floor grid splits into quarters (one safe),
 *            and ELDARs dropping in through the roof.
 *   Phase 4  Tank ELDARs (they shield its legs while they live) and tracking missiles.
 *   Phase 5  it blows apart; you're out of ammo; Billing climbs out: bare knuckles.
 * You're healed to full at the end of every phase, and going down restarts the
 * phase you're in (the gym doors were the checkpoint: never back to the lockers).
 *
 * Then the ending (cutscene.js): Ben drives the car through the glass doors,
 * the upload in the server room, the arrest, the credits.
 *
 *   x = -18 ... west wall: the doors from the locker room (z = 0)
 *   x =  18 ... east wall: the glass doors out to the lot (z = 0)
 *   z = +-15 .. north / south walls; pulled-out bleachers in front of both
 *   north wall, x = 10: the door to the server room (a short corridor north)
 */
export const GYM = { minX: -18, maxX: 18, minZ: -15, maxZ: 15, height: 12 };
const ENTRY_DOOR = { z: 0, half: 1.5, height: 2.5 };
const GLASS_DOORS = { z: 0, half: 2.2, height: 2.8 };
const SERVER_DOOR = { x: 10, half: 0.62, height: 2.3 };
const HOLE = { x: 0, z: 0, half: 3.2 };
const BLEACHERS = { minX: -11, maxX: 11, front: 7.4, back: 10.4, rows: 5, rowH: 0.6 };
const CORRIDOR = { minX: 9.2, maxX: 10.8, minZ: 15, maxZ: 19 };
const SERVER_ROOM = { minX: 6, maxX: 14, minZ: 19, maxZ: 25, height: 3.2 };
const SURVIVE_TIME = 55;
const SPAWN = { pos: new THREE.Vector3(-15.8, 0, 0), yaw: -Math.PI / 2 };
const CENTER = new THREE.Vector3(1.5, 0, 0);
const CAR_PARK_Y = -40; // Ben's car waits down here, out of sight, until the finale (see buildGym)

// Where you (and the Mecha) restart each phase after going down.
const RETRY = {
  player: [new THREE.Vector3(-14.5, 0, 2.5), -Math.PI / 2],
  mecha: new THREE.Vector3(6, 0, 0),
};

// Cover you can use: [x, z, w, d, h, kind]
const COVER = [
  [-14.2, 4.6, 2.2, 1.4, 1.3, 'mats'],
  [-14.2, -4.8, 2.2, 1.4, 1.3, 'mats'],
  [-7.5, 5.6, 1.6, 0.55, 1.15, 'horse'],
  [-6.5, -5.8, 1.7, 0.85, 1.25, 'vault'],
  [0.2, 6.0, 1.05, 0.7, 1.1, 'cart'],
  [1.5, -6.1, 2.2, 1.4, 1.3, 'mats'],
  [8.2, 5.8, 1.7, 0.85, 1.25, 'vault'],
  [8.5, -5.7, 1.05, 0.7, 1.1, 'cart'],
  [14.4, 4.8, 2.2, 1.4, 1.3, 'mats'],
  [14.6, -4.6, 1.6, 0.55, 1.15, 'horse'],
  [-10.8, 0.4, 1.05, 0.7, 1.1, 'cart'],
];

const rand = (a, b) => a + Math.random() * (b - a);

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

/** The court: maple planks, painted lines, the Wildcats' paw at center court. */
function createCourtTexture() {
  const W = 1152;
  const H = 960; // 36m x 30m: 32 px per meter
  const s = W / 36;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#b98a52';
  g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 7) {
    g.fillStyle = `rgba(${90 + Math.random() * 40},${55 + Math.random() * 25},20,${0.08 + Math.random() * 0.08})`;
    g.fillRect(0, y, W, 7);
    for (let x = Math.random() * 120; x < W; x += 90 + Math.random() * 120) {
      g.fillStyle = 'rgba(60,35,15,0.25)';
      g.fillRect(x, y, 2, 7);
    }
  }
  // Keys (painted) at both ends.
  g.fillStyle = 'rgba(122,31,43,0.75)';
  g.fillRect(0, H / 2 - 2.45 * s, 5.8 * s, 4.9 * s);
  g.fillRect(W - 5.8 * s, H / 2 - 2.45 * s, 5.8 * s, 4.9 * s);
  g.strokeStyle = 'rgba(245,242,230,0.9)';
  g.lineWidth = 4;
  // Court boundary (28m x 15m, centered), center line, circles, arcs.
  const cx = W / 2;
  const cy = H / 2;
  const hw = 14 * s;
  const hh = 7.5 * s;
  g.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
  g.beginPath();
  g.moveTo(cx, cy - hh);
  g.lineTo(cx, cy + hh);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, 1.8 * s, 0, Math.PI * 2);
  g.stroke();
  [-1, 1].forEach((side) => {
    const bx = cx + side * (hw - 1.6 * s);
    g.beginPath();
    g.arc(bx, cy, 6.75 * s, side < 0 ? -Math.PI / 2 : Math.PI / 2, side < 0 ? Math.PI / 2 : Math.PI * 1.5);
    g.stroke();
    g.strokeRect(side < 0 ? cx - hw : cx + hw - 5.8 * s, cy - 2.45 * s, 5.8 * s, 4.9 * s);
    g.beginPath();
    g.arc(cx + side * (hw - 5.8 * s), cy, 1.8 * s, 0, Math.PI * 2);
    g.stroke();
  });
  // Center-court paw.
  g.fillStyle = 'rgba(122,31,43,0.8)';
  g.beginPath();
  g.ellipse(cx, cy + 0.2 * s, 0.7 * s, 0.6 * s, 0, 0, Math.PI * 2);
  g.fill();
  [[-0.75, -0.55], [-0.28, -0.85], [0.28, -0.85], [0.75, -0.55]].forEach(([x, y]) => {
    g.beginPath();
    g.ellipse(cx + x * s, cy + y * s, 0.24 * s, 0.3 * s, 0, 0, Math.PI * 2);
    g.fill();
  });
  return tex(c);
}

function createBlockTexture(stripe = '#7a1f2b') {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.fillStyle = '#c9ccc2';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(70,80,70,0.4)';
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
  g.fillStyle = stripe;
  g.fillRect(0, 196, 256, 30);
  for (let i = 0; i < 1200; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  return tex(c, true);
}

function createBleacherTexture() {
  const c = makeCanvas(256, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#a57a47';
  g.fillRect(0, 0, 256, 64);
  for (let y = 0; y < 64; y += 16) {
    g.fillStyle = 'rgba(60,35,15,0.35)';
    g.fillRect(0, y, 256, 2);
  }
  for (let i = 0; i < 400; i++) {
    g.fillStyle = 'rgba(40,25,10,0.12)';
    g.fillRect(Math.random() * 256, Math.random() * 64, 6, 1);
  }
  return tex(c, true);
}

function createScoreboardTexture() {
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#111316';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#7a1f2b';
  g.lineWidth = 10;
  g.strokeRect(5, 5, 502, 246);
  g.fillStyle = '#d9dee3';
  g.font = 'bold 34px Arial';
  g.textAlign = 'center';
  g.fillText('HOME', 120, 60);
  g.fillText('GUEST', 392, 60);
  g.fillText('HALL HIGH', 256, 232);
  g.fillStyle = '#ff4a3a';
  g.font = 'bold 86px "Courier New", monospace';
  g.fillText('00', 120, 150);
  g.fillText('00', 392, 150);
  g.fillStyle = '#e0c34a';
  g.font = 'bold 40px "Courier New", monospace';
  g.fillText('3:02', 256, 135);
  return tex(c);
}

function createBannerTexture(line1, line2) {
  const c = makeCanvas(256, 512);
  const g = c.getContext('2d');
  g.fillStyle = '#7a1f2b';
  g.fillRect(0, 0, 256, 512);
  g.fillStyle = '#e0c34a';
  g.fillRect(0, 440, 256, 72);
  g.fillStyle = '#f4efe2';
  g.textAlign = 'center';
  g.font = 'bold 42px Arial';
  g.fillText(line1, 128, 150);
  g.font = 'bold 30px Arial';
  g.fillText(line2, 128, 220);
  return tex(c);
}

function createMatTexture() {
  const c = makeCanvas(128);
  const g = c.getContext('2d');
  g.fillStyle = '#284f8a';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < 128; y += 32) g.fillRect(0, y, 128, 3);
  return tex(c, true);
}

function createNightTexture() {
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#070a10');
  sky.addColorStop(0.65, '#10151d');
  sky.addColorStop(1, '#1b1a17');
  g.fillStyle = sky;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(0,0,0,0.6)';
  for (let x = 0; x < 512; x += 40 + Math.random() * 30) {
    const h = 30 + Math.random() * 60;
    g.fillRect(x, 190 - h, 18 + Math.random() * 30, h); // trees / houses on the far side of the road
  }
  return tex(c);
}

/** Server racks: rows of blinking LEDs (the texture scrolls to twinkle). */
function createRackTexture() {
  const c = makeCanvas(128, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#15191e';
  g.fillRect(0, 0, 128, 256);
  for (let y = 6; y < 256; y += 16) {
    g.fillStyle = '#23292f';
    g.fillRect(6, y, 116, 12);
    for (let x = 12; x < 116; x += 10) {
      const r = Math.random();
      g.fillStyle = r < 0.5 ? '#3cff7a' : r < 0.75 ? '#3ab8ff' : r < 0.85 ? '#ffb13a' : '#12301c';
      g.fillRect(x, y + 4, 4, 3);
    }
  }
  return tex(c, true);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** A car: body, glass cabin, wheels, and headlights/taillights (the lights start off). */
function createCar(color, { police = false, headlights = !police } = {}) {
  const car = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.62, 4.3), bodyMat);
  body.position.y = 0.52;
  car.add(body);
  if (police) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.4, 2.0), new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 }));
    door.position.set(0, 0.6, -0.2);
    car.add(door);
  }
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.72, 0.56, 2.05),
    new THREE.MeshStandardMaterial({ color: 0x1b2228, metalness: 0.6, roughness: 0.15, transparent: true, opacity: 0.85 }),
  );
  cabin.position.set(0, 1.1, -0.25);
  car.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.3, 14);
  const tire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const wheels = [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]].map(([x, z]) => {
    const w = new THREE.Mesh(wheelGeo, tire);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.33, z);
    car.add(w);
    return w;
  });
  const headMat = new THREE.MeshBasicMaterial({ color: 0x3a3a30 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0x3a0a08 });
  [-0.65, 0.65].forEach((x) => {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.05), headMat);
    h.position.set(x, 0.62, 2.16);
    car.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.05), tailMat);
    t.position.set(x, 0.62, -2.16);
    car.add(t);
  });
  const beams = (headlights ? [-0.65, 0.65] : []).map((x) => {
    const light = new THREE.SpotLight(0xfff1d8, 0, 40, 0.42, 0.5, 1.2);
    light.position.set(x, 0.65, 2.2);
    const target = new THREE.Object3D();
    target.position.set(x * 2, 0, 16);
    car.add(light, target);
    light.target = target;
    return light;
  });
  // The police cars' rear door (on the car's +X side), hinged at its front edge: Billing goes in here.
  let rearDoor = null;
  if (police) {
    rearDoor = new THREE.Group();
    rearDoor.position.set(1.04, 0, -0.05);
    car.add(rearDoor);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 1.05), new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 }));
    panel.position.set(0, 0.62, -0.55);
    rearDoor.add(panel);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.14), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    handle.position.set(0.04, 0.78, -0.95);
    rearDoor.add(handle);
  }
  let bar = null;
  if (police) {
    bar = [0xff2a1a, 0x2a5aff].map((color, i) => {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.14, 0.26), new THREE.MeshBasicMaterial({ color: 0x220808 }));
      lamp.position.set(i ? 0.36 : -0.36, 1.45, -0.2);
      car.add(lamp);
      return { lamp, color: new THREE.Color(color) };
    });
  }
  return {
    group: car,
    wheels,
    lights: { on: false },
    setLights(on) {
      beams.forEach((b) => (b.intensity = on ? 30 : 0));
      headMat.color.setHex(on ? 0xfff6dc : 0x3a3a30);
      tailMat.color.setHex(on ? 0xff2a1a : 0x3a0a08);
    },
    /** 0 = shut, 1 = swung wide open (police cars only). */
    setDoor(open) {
      if (rearDoor) rearDoor.rotation.y = -1.25 * open;
    },
    /** The police light bar flashing (t = seconds). */
    flash(t) {
      if (!bar) return;
      const phase = Math.floor(t * 6) % 2;
      bar.forEach((b, i) => b.lamp.material.color.copy(b.color).multiplyScalar(phase === i ? 1 : 0.12));
    },
  };
}

// ---------------------------------------------------------------------------
// The gym (+ the server room, and the lot outside the glass doors)
// ---------------------------------------------------------------------------

export function buildGym() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06080b);
  scene.fog = new THREE.FogExp2(0x0a0d12, 0.016);
  const colliders = [];
  const interactables = [];
  const updatables = [];
  const R = GYM;

  const mats = {
    court: new THREE.MeshStandardMaterial({ map: createCourtTexture(), roughness: 0.42, metalness: 0.06 }),
    wall: new THREE.MeshStandardMaterial({ map: createBlockTexture(), roughness: 0.9 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0x3c4146, roughness: 1 }),
    truss: new THREE.MeshStandardMaterial({ color: 0x5b6168, roughness: 0.6, metalness: 0.6 }),
    bleacher: new THREE.MeshStandardMaterial({ map: createBleacherTexture(), roughness: 0.7 }),
    bleacherSide: new THREE.MeshStandardMaterial({ color: 0x5a5f64, roughness: 0.6, metalness: 0.4 }),
    mat: new THREE.MeshStandardMaterial({ map: createMatTexture(), roughness: 0.8 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x6b3a22, roughness: 0.6 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x9a6b3e, roughness: 0.6 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x8f989e, roughness: 0.35, metalness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2f34, roughness: 0.6, metalness: 0.4 }),
    ball: new THREE.MeshStandardMaterial({ color: 0xc8641e, roughness: 0.7 }),
    door: new THREE.MeshStandardMaterial({ color: 0x5d6b73, roughness: 0.5, metalness: 0.35 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2f3438, roughness: 0.5, metalness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fc2d6, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.28, depthWrite: false }),
    asphalt: new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.85 }),
    curb: new THREE.MeshStandardMaterial({ color: 0x6d7075, roughness: 0.9 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc070, emissiveIntensity: 1 }),
    fixture: new THREE.MeshStandardMaterial({ color: 0xe8f0ff, emissive: 0xcfdcff, emissiveIntensity: 0.9 }),
    fixtureOff: new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6 }),
    exit: new THREE.MeshBasicMaterial({ color: 0xff4a3a }),
    rack: new THREE.MeshStandardMaterial({ map: createRackTexture(), emissive: 0xffffff, emissiveMap: null, roughness: 0.5, metalness: 0.5 }),
    serverWall: new THREE.MeshStandardMaterial({ color: 0x8c9296, roughness: 0.85 }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
  mats.rack.emissiveMap = mats.rack.map;
  mats.rack.emissiveIntensity = 0.9;

  const batch = new Map();
  const toBatch = (mesh) => {
    mesh.updateMatrix();
    let list = batch.get(mesh.material);
    if (!list) batch.set(mesh.material, (list = []));
    list.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));
  };
  function box({ w, h, d, x, y, z, material, collider = true, rotationY = 0, static: isStatic = true, tile = 0 }) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (tile) {
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
  const wall = (x0, x1, z0, z1, h = R.height, y = h / 2, opts = {}) =>
    box({ w: x1 - x0, h, d: z1 - z0, x: (x0 + x1) / 2, y, z: (z0 + z1) / 2, material: mats.wall, tile: 2.4, ...opts });
  const T = 0.4;

  // ---- Floor, walls, ceiling ------------------------------------------------------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(R.maxX - R.minX, R.maxZ - R.minZ), mats.court);
  floor.rotation.x = -Math.PI / 2;
  toBatch(floor);
  // West wall: the doors from the locker room.
  wall(R.minX - T, R.minX, R.minZ, ENTRY_DOOR.z - ENTRY_DOOR.half);
  wall(R.minX - T, R.minX, ENTRY_DOOR.z + ENTRY_DOOR.half, R.maxZ);
  wall(R.minX - T, R.minX, -ENTRY_DOOR.half, ENTRY_DOOR.half, R.height - ENTRY_DOOR.height, (R.height + ENTRY_DOOR.height) / 2, { collider: false });
  // East wall: the glass doors (and a glass transom) out to the lot.
  wall(R.maxX, R.maxX + T, R.minZ, GLASS_DOORS.z - GLASS_DOORS.half);
  wall(R.maxX, R.maxX + T, GLASS_DOORS.z + GLASS_DOORS.half, R.maxZ);
  wall(R.maxX, R.maxX + T, -GLASS_DOORS.half, GLASS_DOORS.half, R.height - GLASS_DOORS.height - 0.9, (R.height + GLASS_DOORS.height + 0.9) / 2, { collider: false });
  // North wall: the server room door; south wall solid.
  wall(R.minX - T, SERVER_DOOR.x - SERVER_DOOR.half, R.maxZ, R.maxZ + T);
  wall(SERVER_DOOR.x + SERVER_DOOR.half, R.maxX + T, R.maxZ, R.maxZ + T);
  wall(SERVER_DOOR.x - SERVER_DOOR.half, SERVER_DOOR.x + SERVER_DOOR.half, R.maxZ, R.maxZ + T, R.height - SERVER_DOOR.height, (R.height + SERVER_DOOR.height) / 2, { collider: false });
  wall(R.minX - T, R.maxX + T, R.minZ - T, R.minZ);
  // Ceiling panels around the hole (the patch over the hole goes when the Mecha comes through).
  const ceil = (x0, x1, z0, z1) => box({ w: x1 - x0, h: 0.3, d: z1 - z0, x: (x0 + x1) / 2, y: R.height + 0.15, z: (z0 + z1) / 2, material: mats.ceiling, collider: false });
  ceil(R.minX, R.maxX, HOLE.z + HOLE.half, R.maxZ);
  ceil(R.minX, R.maxX, R.minZ, HOLE.z - HOLE.half);
  ceil(R.minX, HOLE.x - HOLE.half, HOLE.z - HOLE.half, HOLE.z + HOLE.half);
  ceil(HOLE.x + HOLE.half, R.maxX, HOLE.z - HOLE.half, HOLE.z + HOLE.half);
  const patch = box({ w: HOLE.half * 2, h: 0.3, d: HOLE.half * 2, x: HOLE.x, y: R.height + 0.15, z: HOLE.z, material: mats.ceiling, collider: false, static: false });
  // Trusses.
  for (let x = -15; x <= 15; x += 5) {
    if (Math.abs(x - HOLE.x) < HOLE.half + 0.2) {
      // (This one would run straight across the hole the Mecha comes through: it ends at the hole's edges.)
      const zs = [[R.minZ, HOLE.z - HOLE.half], [HOLE.z + HOLE.half, R.maxZ]];
      for (const [z0, z1] of zs) box({ w: 0.3, h: 0.6, d: z1 - z0, x, y: R.height - 0.5, z: (z0 + z1) / 2, material: mats.truss, collider: false });
    } else {
      box({ w: 0.3, h: 0.6, d: R.maxZ - R.minZ, x, y: R.height - 0.5, z: 0, material: mats.truss, collider: false });
    }
  }
  // The hoops (high over the doors at each end).
  [-1, 1].forEach((s) => {
    const x = s * (R.maxX - 0.05);
    box({ w: 1.6, h: 0.1, d: 0.1, x: x - s * 0.8, y: 3.9, z: 0, material: mats.steel, collider: false });
    box({ w: 0.05, h: 1.05, d: 1.8, x: x - s * 1.6, y: 3.6, z: 0, material: mats.glass, collider: false, static: false }).renderOrder = 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.02, 6, 20), new THREE.MeshStandardMaterial({ color: 0xd4501c, metalness: 0.5, roughness: 0.4 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x - s * 1.9, 3.05, 0);
    scene.add(rim);
  });
  // The scoreboard and the banners.
  const board = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.5), new THREE.MeshBasicMaterial({ map: createScoreboardTexture(), fog: false }));
  board.position.set(0, 7.6, R.maxZ - 0.05);
  board.rotation.y = Math.PI;
  scene.add(board);
  [['XC', 'STATE 2024'], ['XC', 'STATE 2025'], ['WILD', 'CATS']].forEach(([a, b], i) => {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.8), new THREE.MeshStandardMaterial({ map: createBannerTexture(a, b), roughness: 0.8, side: THREE.DoubleSide }));
    banner.position.set(-12 + i * 12, 8.2, R.minZ + 0.05);
    scene.add(banner);
  });

  // ---- Pulled-out bleachers (north and south): stepped rows, a gap behind them ------
  const B = BLEACHERS;
  const bleacherBoxes = [];
  [-1, 1].forEach((s) => {
    for (let i = 0; i < B.rows; i++) {
      const depth = (B.back - B.front) / B.rows;
      const z0 = B.front + i * depth;
      const h = (i + 1) * B.rowH;
      const zc = s * (z0 + depth / 2);
      box({ w: B.maxX - B.minX, h, d: depth, x: 0, y: h / 2, z: zc, material: mats.bleacher, collider: false, tile: 2 });
    }
    [B.minX, B.maxX].forEach((x) => box({ w: 0.1, h: B.rows * B.rowH, d: B.back - B.front, x, y: (B.rows * B.rowH) / 2, z: s * (B.front + B.back) / 2, material: mats.bleacherSide, collider: false }));
    // One solid box per bank (you can't climb them; lasers and shots stop at its face).
    const solid = new THREE.Mesh(new THREE.BoxGeometry(B.maxX - B.minX, B.rows * B.rowH, B.back - B.front), mats.hidden);
    solid.position.set(0, (B.rows * B.rowH) / 2, s * (B.front + B.back) / 2);
    colliders.push(solid);
    bleacherBoxes.push(solid);
  });

  // ---- Gym equipment (cover) ------------------------------------------------------
  const cover = [];
  for (const [x, z, w, d, h, kind] of COVER) {
    if (kind === 'mats') {
      for (let i = 0; i < 4; i++) box({ w, h: h / 4 - 0.01, d, x, y: (i + 0.5) * (h / 4), z, material: mats.mat, collider: false, rotationY: i % 2 ? 0.03 : -0.02 });
    } else if (kind === 'horse') {
      box({ w, h: 0.35, d, x, y: h - 0.18, z, material: mats.leather, collider: false });
      [-1, 1].forEach((s) => box({ w: 0.1, h: h - 0.35, d: 0.1, x: x + s * (w / 2 - 0.25), y: (h - 0.35) / 2, z, material: mats.steel, collider: false }));
      box({ w: w - 0.2, h: 0.3, d: d + 0.2, x, y: 0.15, z, material: mats.dark, collider: false });
    } else if (kind === 'vault') {
      for (let i = 0; i < 4; i++) box({ w: w - i * 0.08, h: h / 4 - 0.02, d: d - i * 0.04, x, y: (i + 0.5) * (h / 4), z, material: i === 3 ? mats.leather : mats.wood, collider: false });
    } else {
      box({ w, h: 0.08, d, x, y: 0.2, z, material: mats.steel, collider: false });
      box({ w, h: 0.7, d, x, y: h - 0.35, z, material: mats.dark, collider: false });
      for (let i = 0; i < 6; i++) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), mats.ball);
        ball.position.set(x + (i % 3 - 1) * 0.3, h + 0.05, z + (i < 3 ? -0.14 : 0.14));
        toBatch(ball);
      }
    }
    const solid = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.hidden);
    solid.position.set(x, h / 2, z);
    colliders.push(solid);
    cover.push(solid);
  }

  // ---- Doors ---------------------------------------------------------------------
  // From the locker room (west): swung shut behind you.
  [-1, 1].forEach((s) => {
    box({ w: 0.08, h: ENTRY_DOOR.height - 0.05, d: ENTRY_DOOR.half - 0.04, x: R.minX + 0.05, y: ENTRY_DOOR.height / 2, z: s * (ENTRY_DOOR.half / 2), material: mats.door });
  });
  // The glass doors (east): chained. Two leaves of glass in steel frames; they shatter at the end.
  const glassPanes = [];
  const glassFrames = [];
  [-1, 1].forEach((s) => {
    const z = s * (GLASS_DOORS.half / 2);
    const frameA = box({ w: 0.1, h: GLASS_DOORS.height, d: 0.1, x: R.maxX + 0.1, y: GLASS_DOORS.height / 2, z: s * (GLASS_DOORS.half - 0.05), material: mats.frame, collider: false, static: false });
    const frameB = box({ w: 0.1, h: GLASS_DOORS.height, d: 0.1, x: R.maxX + 0.1, y: GLASS_DOORS.height / 2, z: s * 0.05, material: mats.frame, collider: false, static: false });
    const top = box({ w: 0.12, h: 0.12, d: GLASS_DOORS.half, x: R.maxX + 0.1, y: GLASS_DOORS.height - 0.06, z, material: mats.frame, collider: false, static: false });
    const bottom = box({ w: 0.12, h: 0.14, d: GLASS_DOORS.half, x: R.maxX + 0.1, y: 0.25, z, material: mats.frame, collider: false, static: false });
    const pane = box({ w: 0.03, h: GLASS_DOORS.height - 0.45, d: GLASS_DOORS.half - 0.15, x: R.maxX + 0.1, y: 0.32 + (GLASS_DOORS.height - 0.45) / 2, z, material: mats.glass, collider: false, static: false });
    pane.renderOrder = 3;
    glassPanes.push(pane);
    glassFrames.push(frameA, frameB, top, bottom);
  });
  const chain = box({ w: 0.06, h: 0.05, d: 0.9, x: R.maxX - 0.02, y: 1.05, z: 0, material: mats.steel, collider: false, static: false });
  glassFrames.push(chain);
  // (A gap under the doors: that's how Ben gets the rifle to you.)
  const glassCollider = new THREE.Mesh(new THREE.BoxGeometry(0.3, GLASS_DOORS.height, GLASS_DOORS.half * 2), mats.hidden);
  glassCollider.position.set(R.maxX + 0.1, GLASS_DOORS.height / 2, 0);
  colliders.push(glassCollider);
  // Server room door (north wall): open to the corridor.
  box({ w: SERVER_DOOR.half * 2 + 0.2, h: 0.12, d: 0.2, x: SERVER_DOOR.x, y: SERVER_DOOR.height + 0.06, z: R.maxZ - 0.04, material: mats.frame, collider: false }); // (proud of the wall face)
  const serverSign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.26), new THREE.MeshBasicMaterial({ map: (() => {
    const c = makeCanvas(256, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#1b3f73';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#dfe6ee';
    g.font = 'bold 28px Arial';
    g.textAlign = 'center';
    g.fillText('SERVER ROOM', 128, 42);
    return tex(c);
  })() }));
  serverSign.position.set(SERVER_DOOR.x, SERVER_DOOR.height + 0.4, R.maxZ - 0.02);
  serverSign.rotation.y = Math.PI;
  scene.add(serverSign);
  [[R.minX + 0.05, ENTRY_DOOR.height + 0.35, 0, Math.PI / 2], [R.maxX - 0.05, GLASS_DOORS.height + 0.3, 0, -Math.PI / 2]].forEach(([x, y, z, ry]) => {
    const exit = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18), mats.exit);
    exit.position.set(x, y, z);
    exit.rotation.y = ry;
    scene.add(exit);
  });

  // ---- The server corridor and room -------------------------------------------------
  const C = CORRIDOR;
  const S = SERVER_ROOM;
  const sw = (x0, x1, z0, z1, h = S.height) => box({ w: x1 - x0, h, d: z1 - z0, x: (x0 + x1) / 2, y: h / 2, z: (z0 + z1) / 2, material: mats.serverWall });
  // (Corridor pieces start just inside the gym wall so none of their faces sit flush with it.)
  sw(C.minX - 0.2, C.minX, C.minZ + 0.05, C.maxZ);
  sw(C.maxX, C.maxX + 0.2, C.minZ + 0.05, C.maxZ);
  sw(S.minX - 0.2, C.minX, S.minZ - 0.2, S.minZ);
  sw(C.maxX, S.maxX + 0.2, S.minZ - 0.2, S.minZ);
  sw(S.minX - 0.2, S.minX, S.minZ, S.maxZ);
  sw(S.maxX, S.maxX + 0.2, S.minZ, S.maxZ);
  sw(S.minX - 0.2, S.maxX + 0.2, S.maxZ, S.maxZ + 0.2);
  box({ w: C.maxX - C.minX + 0.36, h: 0.2, d: C.maxZ - C.minZ - 0.05, x: SERVER_DOOR.x, y: S.height + 0.1, z: (C.minZ + 0.05 + C.maxZ) / 2, material: mats.ceiling, collider: false });
  box({ w: S.maxX - S.minX + 0.4, h: 0.2, d: S.maxZ - S.minZ + 0.4, x: (S.minX + S.maxX) / 2, y: S.height + 0.1, z: (S.minZ + S.maxZ) / 2, material: mats.ceiling, collider: false });
  const serverFloor = new THREE.Mesh(new THREE.PlaneGeometry(S.maxX - S.minX + (C.maxX - C.minX), S.maxZ - C.minZ), new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.8 }));
  serverFloor.rotation.x = -Math.PI / 2;
  serverFloor.position.set((S.minX + S.maxX) / 2, 0.012, (C.minZ + S.maxZ) / 2);
  toBatch(serverFloor);
  // Racks along the side walls; the main one (with the port) at the far end.
  const racks = [];
  for (const [x, z, ry] of [[S.minX + 0.45, 20.6, Math.PI / 2], [S.minX + 0.45, 22.2, Math.PI / 2], [S.minX + 0.45, 23.8, Math.PI / 2], [S.maxX - 0.45, 20.6, -Math.PI / 2], [S.maxX - 0.45, 22.2, -Math.PI / 2], [S.maxX - 0.45, 23.8, -Math.PI / 2], [10, S.maxZ - 0.5, Math.PI]]) {
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.1, 0.9), mats.rack);
    rack.position.set(x, 1.05, z);
    rack.rotation.y = ry;
    scene.add(rack);
    colliders.push(rack);
    racks.push(rack);
  }
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.2), mats.dark);
  port.position.set(10, 1.15, S.maxZ - 0.98);
  scene.add(port);
  const portHitbox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.5), mats.hidden);
  portHitbox.position.set(10, 1.15, S.maxZ - 1.05);
  scene.add(portHitbox);
  portHitbox.userData = { interactable: true, label: 'Plug in the USB drive', type: 'gym-usb' };
  const drive = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.1), new THREE.MeshStandardMaterial({ color: 0x1e5fbf, emissive: 0x0a2040 }));
  drive.position.set(10, 1.18, S.maxZ - 1.12);
  drive.visible = false;
  scene.add(drive);
  // The upload monitor on a desk by the main rack.
  const monCanvas = makeCanvas(512, 320);
  const monTex = tex(monCanvas);
  const monitor = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.62), new THREE.MeshBasicMaterial({ map: monTex, fog: false }));
  monitor.position.set(11.6, 1.35, S.maxZ - 1.05);
  monitor.rotation.y = Math.PI;
  scene.add(monitor);
  box({ w: 1.4, h: 0.76, d: 0.7, x: 11.7, y: 0.38, z: S.maxZ - 0.8, material: mats.wood });
  box({ w: 1.1, h: 0.7, d: 0.06, x: 11.6, y: 1.35, z: S.maxZ - 1.0, material: mats.dark, collider: false });
  const drawMonitor = (pct, lines = []) => {
    const g = monCanvas.getContext('2d');
    g.fillStyle = '#04120a';
    g.fillRect(0, 0, 512, 320);
    g.fillStyle = '#3cff7a';
    g.font = 'bold 22px "Courier New", monospace';
    g.fillText('HALL HIGH SCHOOL // NET-ADMIN', 18, 36);
    g.font = '18px "Courier New", monospace';
    lines.forEach((l, i) => g.fillText(l, 18, 76 + i * 26));
    if (pct !== null) {
      g.strokeStyle = '#3cff7a';
      g.lineWidth = 3;
      g.strokeRect(18, 240, 476, 34);
      g.fillRect(22, 244, (468 * Math.min(100, pct)) / 100, 26);
      g.fillStyle = pct >= 100 ? '#e0ffe8' : '#3cff7a';
      g.font = 'bold 22px "Courier New", monospace';
      g.fillText(`${Math.floor(pct)}%`, 230, 300);
    }
    monTex.needsUpdate = true;
  };
  drawMonitor(null, ['> network: 412 devices', '> ELDAR swarm: ONLINE (ATTACK MODE)', '> awaiting input_']);

  // ---- The lot outside the glass doors ------------------------------------------------
  const lot = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), mats.asphalt);
  lot.rotation.x = -Math.PI / 2;
  lot.position.set(R.maxX + 20, -0.01, 0);
  toBatch(lot);
  box({ w: 3, h: 0.14, d: 60, x: R.maxX + 1.9, y: 0.07, z: 0, material: mats.curb, collider: false });
  box({ w: 0.18, h: 6, d: 0.18, x: R.maxX + 9, y: 3, z: -6, material: mats.dark, collider: false });
  box({ w: 0.9, h: 0.14, d: 0.4, x: R.maxX + 9.3, y: 6, z: -6, material: mats.lamp, collider: false });
  const lotLight = new THREE.PointLight(0xffb45a, 14, 24, 1.4);
  lotLight.position.set(R.maxX + 9.3, 5.7, -6);
  scene.add(lotLight);
  const night = new THREE.Mesh(new THREE.PlaneGeometry(80, 30), new THREE.MeshBasicMaterial({ map: createNightTexture(), fog: false }));
  night.position.set(R.maxX + 38, 10, 0);
  night.rotation.y = -Math.PI / 2;
  scene.add(night);

  // ---- Lights: the dark gym at 3 AM ------------------------------------------------
  scene.add(new THREE.AmbientLight(0x2a3240, 0.55));
  scene.add(new THREE.HemisphereLight(0x3c4656, 0x0c0d0f, 0.45));
  // High-bay fixtures (some dead; one swings on its chain after the roof comes in).
  const bays = [[-10, -5, 26], [-10, 5, 0], [10, -5, 22], [10, 5, 24], [-3, 9, 0], [4, -9, 0]].map(([x, z, intensity]) => {
    const mesh = box({ w: 0.9, h: 0.25, d: 0.9, x, y: R.height - 1.2, z, material: intensity ? mats.fixture : mats.fixtureOff, collider: false, static: false });
    let light = null;
    if (intensity) {
      light = new THREE.PointLight(0xdce6ff, intensity, 22, 1.5);
      light.position.set(x, R.height - 1.5, z);
      scene.add(light);
    }
    return { mesh, light, base: intensity };
  });
  const serverLight = new THREE.PointLight(0x7fb8ff, 6, 12, 1.6);
  serverLight.position.set(10, S.height - 0.4, 22);
  scene.add(serverLight);
  // Moonlight down through the hole in the roof (once there is one).
  const moon = new THREE.SpotLight(0x9fb4d8, 0, 30, 0.35, 0.6, 1);
  moon.position.set(HOLE.x, R.height + 6, HOLE.z);
  moon.target.position.set(HOLE.x, 0, HOLE.z);
  scene.add(moon, moon.target);

  // Merge the static pieces.
  batch.forEach((list, material) => {
    const merged = new THREE.Mesh(mergeGeometries(list), material);
    merged.matrixAutoUpdate = false;
    scene.add(merged);
    list.forEach((g) => g.dispose());
  });
  for (const c of colliders) c.updateMatrixWorld(true);

  // ---- Rain: falling through the hole, and outside the glass doors ---------------------
  const rainGeo = new THREE.BufferGeometry();
  const RAIN = 700;
  const rainPos = new Float32Array(RAIN * 6);
  const rainSpots = [];
  for (let i = 0; i < RAIN; i++) {
    const inside = i < 220;
    const x = inside ? HOLE.x + rand(-HOLE.half, HOLE.half) : R.maxX + rand(0.6, 22);
    const z = inside ? HOLE.z + rand(-HOLE.half, HOLE.half) : rand(-16, 16);
    rainSpots.push({ x, z, y: rand(0, inside ? R.height : 10), top: inside ? R.height : 10, speed: rand(13, 18), inside });
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x9fb2c4, transparent: true, opacity: 0.35, depthWrite: false }));
  rain.frustumCulled = false;
  scene.add(rain);
  const rainState = { hole: false };

  // ---- Cast and props for the story ------------------------------------------------
  const benMesh = createHumanoid(OTHER_BEN_LOOK);
  benMesh.visible = false;
  scene.add(benMesh);
  const ben = new Character(benMesh, { radius: 0.32, name: 'Other Ben' });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7, metalness: 0.15 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x353a3f, roughness: 0.35, metalness: 0.8 });
  const floorRifle = createRifleMesh(polymer, metal);
  floorRifle.rotation.set(Math.PI / 2, 0, Math.PI / 2); // lying on its side on the floor
  floorRifle.scale.setScalar(0.85);
  floorRifle.visible = false;
  scene.add(floorRifle);
  const rifleHitbox = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 1.0), mats.hidden);
  rifleHitbox.userData = { interactable: true, label: 'Take the assault rifle', type: 'gym-rifle' };
  scene.add(rifleHitbox);
  // Ben's car: parked out of sight under the floor (lights off) until the finale drives it
  // through the doors. It stays *visible* the whole time so its two headlight SpotLights are
  // counted from the moment the gym loads: shown only for the finale, they changed the scene's
  // light count mid-cutscene and every lit material in view recompiled (a second-long freeze).
  const car = createCar(0x232323);
  car.group.position.set(R.maxX + 16, CAR_PARK_Y, 0);
  car.group.rotation.y = -Math.PI / 2; // facing -X, at the doors
  scene.add(car.group);
  const police = [0, 1].map((i) => {
    const pc = createCar(0x15181c, { police: true });
    pc.group.position.set(R.maxX + 30, 0, i ? 5.5 : -5.5);
    pc.group.rotation.y = -Math.PI / 2;
    pc.group.visible = false;
    scene.add(pc.group);
    return pc;
  });
  const officers = [0, 1].map(() => {
    const m = createHumanoid({ shirt: 0x1c2a44, pants: 0x161c26, skin: 0xc68e62, hair: 0x2a1d14, cap: true, capColor: 0x0e131b, scale: 1.08 });
    m.visible = false;
    scene.add(m);
    return new Character(m, { radius: 0.35, name: 'Officer' });
  });
  const eldarMats = createEldarMaterials();
  const docile = [0, 1, 2].map(() => {
    const built = createEldarRig(eldarMats, {});
    built.root.visible = false;
    scene.add(built.root);
    return { built, anim: { speed: 0, aim: 0, crouch: 0, air: 0, kneel: 0, reach: 0, flinch: 0, roar: 0 } };
  });
  const wreckCollider = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.4, 3.2), mats.hidden);
  wreckCollider.visible = false;

  updatables.push({
    update(dt, time) {
      // Rain streaks.
      const a = rainGeo.attributes.position;
      for (let i = 0; i < RAIN; i++) {
        const r = rainSpots[i];
        if (r.inside && !rainState.hole) {
          a.setXYZ(i * 2, 0, -50, 0);
          a.setXYZ(i * 2 + 1, 0, -50, 0);
          continue;
        }
        r.y -= r.speed * dt;
        if (r.y < 0) r.y += r.top;
        a.setXYZ(i * 2, r.x, r.y, r.z);
        a.setXYZ(i * 2 + 1, r.x + 0.02, r.y + 0.45, r.z);
      }
      a.needsUpdate = true;
      mats.rack.map.offset.y = Math.floor(time * 3) * 0.0625;
      // A fixture swinging on its chain after the crash.
      const swing = bays[4];
      if (rainState.hole) swing.mesh.position.x = -3 + Math.sin(time * 1.3) * 0.5;
    },
  });

  return {
    scene,
    colliders,
    slabs: [
      new THREE.Box3(new THREE.Vector3(-60, -1, -60), new THREE.Vector3(60, 0, 60)), // floor
      new THREE.Box3(new THREE.Vector3(R.minX, R.height, R.minZ), new THREE.Vector3(R.maxX, R.height + 0.4, HOLE.z - HOLE.half)),
      new THREE.Box3(new THREE.Vector3(R.minX, R.height, HOLE.z + HOLE.half), new THREE.Vector3(R.maxX, R.height + 0.4, R.maxZ)),
    ],
    interactables,
    updatables,
    bleacherBoxes,
    cover,
    ben,
    floorRifle,
    rifleHitbox,
    car,
    police,
    officers,
    docile,
    eldarMats,
    wreckCollider,
    glassPanes,
    glassFrames,
    glassCollider,
    drive,
    portHitbox,
    drawMonitor,
    bays,
    spawn: SPAWN,
    center: CENTER,
    hole: new THREE.Vector3(HOLE.x, R.height, HOLE.z),
    glassDoors: new THREE.Vector3(R.maxX, 0, GLASS_DOORS.z),
    serverDoor: new THREE.Vector3(SERVER_DOOR.x, 0, R.maxZ),
    serverRoom: { ...SERVER_ROOM, port: portHitbox.position.clone() },
    corridor: CORRIDOR,
    nav: { minX: R.minX - 0.5, maxX: R.maxX + 0.5, minZ: R.minZ - 0.5, maxZ: R.maxZ + 0.5 },
    /** The roof comes in: the patch goes, moonlight and rain pour through. */
    breakRoof() {
      patch.visible = false;
      rainState.hole = true;
      moon.intensity = 26;
    },
    /** The glass doors blow in (the car). */
    shatterDoors() {
      glassPanes.forEach((p) => (p.visible = false));
      glassFrames.forEach((f) => (f.visible = false));
      const i = colliders.indexOf(glassCollider);
      if (i !== -1) colliders.splice(i, 1);
    },
  };
}

// ---------------------------------------------------------------------------
// The fight
// ---------------------------------------------------------------------------

export class GymFinale {
  /**
   * @param {object} ctx - renderer, camera, player, director, dialogue, wait,
   *   ui (setObjective, hideObjective, showMessage, setPrompt, setScene, setFlashlight,
   *   onGameComplete), and NavGrid (the grounds' walkability grid class).
   */
  constructor({ renderer, camera, player, director, dialogue, wait, ui, NavGrid }) {
    Object.assign(this, { renderer, camera, player, director, dialogue, wait, ui, NavGrid });
    this.gym = null;
    this.combat = null;
    this.phase = 'inactive'; // intro | fight | transition | rifle | ending | done
    this.bossPhase = 0;
    this.cutscene = false;
    this.time = 0;
    this.surviveT = 0;
    this.token = 0;
    this.barks = new Set();
    this.adds = null;
    this.tanksSpawned = 0;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  get mecha() {
    return this.combat.mecha;
  }

  // ---- Setup ------------------------------------------------------------------

  /** Build the gym (behind the black screen) and start the intro. */
  start() {
    const { player, camera, ui } = this;
    this.gym = buildGym();
    const gym = this.gym;
    ui.setScene(gym.scene);
    setRainExposure(0.25);
    ui.setFlashlight(false);
    this.combat = new CombatSystem({ scene: gym.scene, camera, player, boss: 'mecha', pool: { standard: 8, tank: 3 }, bolts: 120 });
    this._setupCombat();
    player.setColliders(gym.colliders);
    player.setInteractables([]);
    player.setCharacters([]);
    player.slideEnabled = true;
    player.onSlide = playSlide;
    // Build every shader now (the gym, the Mecha, lasers, the rifle and fists), and everything that
    // only shows up in the finale: Ben's car (always in the scene, parked under the floor, so its
    // headlights are already part of the light setup), the police cars, the officers, and the
    // docile ELDARs. Their textures go up to the GPU now too.
    this.combat.prewarm(true);
    this.mecha.root.position.set(0, 1, 0);
    this.mecha.active = true;
    const finaleCast = [...gym.police.map((p) => p.group), ...gym.officers.map((o) => o.mesh), ...gym.docile.map((d) => d.built.root)];
    finaleCast.forEach((obj) => (obj.visible = true));
    this.renderer.compile(gym.scene, camera);
    this.renderer.compile(this.combat.rifle.scene, this.combat.rifle.camera);
    for (const obj of [gym.car.group, ...finaleCast]) {
      obj.traverse((o) => {
        for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
          for (const key of Object.keys(m)) if (m[key] && m[key].isTexture) this.renderer.initTexture(m[key]);
        }
      });
    }
    finaleCast.forEach((obj) => (obj.visible = false));
    this.combat.prewarm(false);
    this.mecha.root.position.set(0, -60, 0);
    this.mecha.active = false;
    this.combat.hud.showDownload(false);
    this.combat.hud.setBossName('MECHA BILLING', false);
    this._playIntro();
  }

  _setupCombat() {
    const c = this.combat;
    const gym = this.gym;
    c.arena = { minX: GYM.minX + 0.8, maxX: GYM.maxX - 0.8, minZ: GYM.minZ + 0.8, maxZ: GYM.maxZ - 0.8 };
    c.inTransit = () => false;
    c.regen = false;
    c.showBossBar = true;
    // Firing positions for the ELDARs: a loose grid over the open floor.
    const nav = new this.NavGrid({ ...gym.nav, cell: 0.6, inflate: 0.55 });
    this.nav = nav;
    this._refreshColliders();
    c.spots = [];
    for (let x = -15; x <= 15; x += 3) {
      for (let z = -12.5; z <= 12.5; z += 2.5) {
        if (nav.isFree(x, z)) c.spots.push({ pos: new THREE.Vector3(x, 0, z), taken: null });
      }
    }
    c.navigate = (from, to) => nav.path(from, to) || [to.clone()];
    c.onPlayerDown = () => this._playerDown();
    c.onMechaPhaseBreak = (phase) => this._domeBroken(phase);
    c.onMechaStumble = () => this._bark('Other Ben (outside)', this.barks.has('stumble') ? 'The glass! NOW!' : "It's down! Shoot the cockpit glass!", 'stumble');
    c.onMechaRecover = () => this._hint('recover', 'Other Ben (outside)', "It's back up! Knock its legs out again!");
    c.onMechaShielded = () => this._hint('shielded', 'Other Ben (outside)', "The big ones are shielding its legs! Take them out first!");
    c.onMechaArmorHit = () => {
      if (this.bossPhase >= 2) this._hint('armor', 'Other Ben (outside)', 'Bullets just bounce off! Aim for the glowing ankles!');
    };
    c.onMechaAttack = (kind) => this._attackTip(kind);
    c.onBoxerDefeated = () => this._boxerDown();
    c.onBoxerTaunt = () => this._bark('Coach Billing', ['Come on! Hit me!', "What's the matter? Tired?", 'I did two-a-days in the RAIN!'][Math.floor(Math.random() * 3)]);
    c.onKill = (u) => {
      if (u.heavy && this.bossPhase === 4) this._updateTankShield();
    };
  }

  _refreshColliders() {
    const gym = this.gym;
    this.combat.setWorldColliders(gym.colliders, gym.slabs);
    this.player.setColliders(gym.colliders);
    const boxes = gym.colliders.map((m) => {
      m.updateWorldMatrix(true, false);
      return new THREE.Box3().setFromObject(m);
    }).filter((b) => b.max.y > 0.3 && b.min.y < 1.5);
    this.nav.build(boxes);
  }

  // ---- Little helpers ----------------------------------------------------------

  _bark(speaker, line, id = null) {
    if (id) this.barks.add(id);
    if (this.dialogue.active && !id) return;
    this.dialogue.say(speaker, line, { hold: Math.max(1.5, line.split(/\s+/).length * 0.28) });
  }

  _hint(id, speaker, line) {
    if (this.barks.has(id)) return;
    this.barks.add(id);
    this.dialogue.say(speaker, line, { hold: Math.max(1.8, line.split(/\s+/).length * 0.3) });
  }

  _attackTip(kind) {
    if (this.bossPhase !== 1) return;
    if (kind === 'laserLow') this._tip('laserLow', 'RED laser = knee height: get the bleachers or gym equipment between you and the Mecha!');
    else if (kind === 'gridHalf') this._tip('gridHalf', 'The floor under you is charging! Sprint (+ [C] to slide) to the GREEN half before it goes live.');
    else if (kind === 'seismic' || kind === 'mortar') this._tip('ground', 'Red circles on the floor are about to erupt: get out of them!');
  }

  _tip(id, text) {
    if (this.barks.has(`tip-${id}`)) return;
    this.barks.add(`tip-${id}`);
    this.ui.showMessage(text, 3600);
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

  _beginCutscene() {
    this.cutscene = true;
    this.combat.frozen = true;
    this.combat.rifle.triggerHeld = false;
    this.combat.bolts.clear();
    this.combat.endBeams();
    this.player.setInputLocked(true);
    this.player.setCameraOverride(true);
  }

  _endCutscene() {
    const { player, director } = this;
    director.releaseCamera(75);
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    player.movementFrozen = false;
    this.cutscene = false;
    this.combat.frozen = false;
    document.getElementById('hud').classList.remove('hidden');
    document.body.classList.remove('cinematic');
  }

  // ---- The intro: the roof comes in ----------------------------------------------

  async _playIntro() {
    const { player, director, dialogue, wait, gym } = this;
    const mecha = this.mecha;
    this.phase = 'intro';
    this.cutscene = true;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    player.crouching = false;
    player.eyeHeight = 1.7;
    const eye = SPAWN.pos.clone().setY(1.7);
    this._place(eye, new THREE.Vector3(0, 2.2, 0));
    playMetalDoorSlam();
    await director.fader.to(0, 0.8);
    await dialogue.say('', 'The Hall High School gym. Dark and enormous. Rain drums on the roof, twelve meters up.', { style: 'narration', hold: 1.4 });
    this.ui.showMessage('Checkpoint: the gym.', 2200);
    playPA();
    await wait(0.7);
    await dialogue.say('Coach Billing (PA)', 'Well, well. Ben. Past my coaches. Past my robots. Past ME.', { hold: 1.3 });
    await dialogue.say('Coach Billing (PA)', 'You always did skip the warm-up...', { hold: 1.0 });
    // The roof groans.
    player.setLookTarget(gym.hole.clone().setY(GYM.height));
    this.combat.start();
    this.combat.hud.show(false);
    this.combat.shake(0.4);
    playCeilingCrash();
    await wait(0.5);
    await dialogue.say('Coach Billing (PA)', '...but NOBODY. SKIPS. PRACTICE.', { hold: 0.8 });
    gym.breakRoof();
    this.combat.effects.chunks(this._tmp.set(0, GYM.height - 0.5, 0), { count: 14, speed: 4, size: 0.8 });
    this.combat.effects.spark(this._tmp, { count: 40, color: 0xd8c8a8, speed: 4, size: 0.2, life: 1.2, gravity: 6 });
    mecha.drop(this._tmp.set(CENTER.x, 0, CENTER.z), -Math.PI / 2, GYM.height + 4);
    this.mecha.setCracks(0);
    player.setLookTarget(() => this._tmp2.copy(mecha.root.position).setY(Math.max(2.5, mecha.root.position.y + 5)));
    await wait(2.6); // it falls, lands, rises
    player.setLookTarget(() => mecha.domePoint(this._tmp2));
    await wait(1.6);
    await dialogue.say('Coach Billing', 'Welcome... to GAME DAY.', { hold: 1.2 });
    director.zoomTo(75, 0.3);
    this._beginPhase(1);
    this._endCutscene();
  }

  // ---- Phases ----------------------------------------------------------------------

  _beginPhase(n) {
    const c = this.combat;
    const mecha = this.mecha;
    this.bossPhase = n;
    this.phase = 'fight';
    this.token++;
    this.adds = null;
    c.healFull();
    c.hud.show(true);
    if (n > 1) this.ui.showMessage(n === 5 ? 'PHASE 5 · HP RESTORED' : `PHASE ${n} · HP RESTORED`, 2200);
    if (n <= 4) {
      mecha.beginPhase(n);
      mecha.aiEnabled = true;
    }
    switch (n) {
      case 1:
        this.surviveT = SURVIVE_TIME * (difficulty.hard ? 1.15 : 1);
        c.rifle.unequip();
        c.hud.showAmmo(false);
        c.hud.setBossName('MECHA BILLING · PHASE 1/5', false);
        c.hud.setSubName('');
        this.ui.setObjective('SURVIVE. You have no weapon.', [
          { label: 'The floor glows red where it is about to electrify: run to the GREEN side', tip: true },
          { label: 'Sprint + [C] slides: the fastest way across', tip: true },
          { label: 'RED laser sweep: get something solid between you and it', tip: true },
          { label: 'Red circles on the floor erupt: get out of them', tip: true },
          { label: "Don't get close: it stomps", tip: true },
        ]);
        break;
      case 2:
        c.hud.showAmmo(true);
        c.hud.setBossName('MECHA BILLING · PHASE 2/5', false);
        c.hud.setSubName('LEG ACTUATORS');
        this.ui.setObjective('Bring the Mecha down!', [
          { label: 'Shoot its glowing orange ankles until it stumbles', tip: true },
          { label: 'The cockpit armor cracks open: shoot the glass!', tip: true },
          { label: '[R] reloads. Keep moving', tip: true },
        ]);
        break;
      case 3:
        c.hud.setBossName('MECHA BILLING · PHASE 3/5', false);
        this.adds = { t: 0, every: 5.5 * difficulty.fireMult, cap: 4, kind: 'standard' };
        this.ui.setObjective("It's angry: faster, and ELDARs keep dropping in!", [
          { label: 'Ankles, then the glass', tip: true },
          { label: 'Now it charges 3 quarters of the floor: find the GREEN one', tip: true },
          { label: 'Thin out the ELDARs when you get a moment', tip: true },
        ]);
        break;
      case 4:
        c.hud.setBossName('MECHA BILLING · PHASE 4/5', false);
        this.tanksSpawned = 0;
        this._spawnTank(0);
        this._spawnTank(1);
        this.adds = { t: 0, every: 9 * difficulty.fireMult, cap: 2, kind: 'standard', tankAt: 24 };
        this._updateTankShield();
        this.ui.setObjective('Heavy Tank ELDARs! Crack the dome for good.', [
          { label: "Destroy the Tanks: they shield the Mecha's legs", tip: true },
          { label: 'Their shells explode: stay behind cover', tip: true },
          { label: 'Missiles track you: break line of sight, or shoot them down', tip: true },
          { label: 'Then: ankles, and the glass', tip: true },
        ]);
        break;
      case 5:
        c.hud.setBossName('COACH BILLING · PHASE 5/5', false);
        c.hud.setSubName('');
        c.hud.showAmmo(false);
        this.ui.setObjective('Knock Coach Billing out!', [
          { label: '[LMB] Punch. [RMB] hold to guard', tip: true },
          { label: 'Watch his fist: yellow jab, orange hook, RED haymaker (block it!)', tip: true },
          { label: 'Hit him right after he swings: counters do double', tip: true },
          { label: 'Hit a jab or hook as he winds it up to stop it', tip: true },
        ]);
        break;
      default:
        break;
    }
  }

  /** The Tanks shield the Mecha's legs while any of them is alive. */
  _updateTankShield() {
    const tanks = this.combat.units.filter((u) => u.heavy && !u.dead);
    this.mecha.setLegShield(this.bossPhase === 4 && tanks.length > 0, tanks);
    if (this.bossPhase === 4 && !tanks.length && this.tanksSpawned && !this.barks.has('shieldDown')) {
      this.barks.add('shieldDown');
      this._bark('Other Ben (outside)', "The shield's down! Go for its legs!", 'shieldDownBark');
    }
  }

  _spawnTank(i) {
    this.tanksSpawned++;
    const at = new THREE.Vector3(i % 2 ? 2.4 : -2.2, 0, i % 2 ? -1.8 : 2.0);
    return this.combat.spawnUnit('tank', { kind: 'drop', at, height: GYM.height - 0.5 });
  }

  _spawnStandard() {
    const a = Math.random() * Math.PI * 2;
    const at = new THREE.Vector3(Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2);
    return this.combat.spawnUnit('standard', { kind: 'drop', at, height: GYM.height - 0.5 });
  }

  _updateAdds(dt) {
    const a = this.adds;
    if (!a || this.phase !== 'fight' || this.combat.frozen) return;
    a.t += dt;
    if (a.t >= a.every) {
      const alive = this.combat.units.filter((u) => !u.dead && !u.heavy).length;
      if (alive < a.cap) {
        a.t = 0;
        this._spawnStandard();
      }
    }
    if (a.tankAt && a.t > 0) {
      a.tankClock = (a.tankClock || 0) + dt;
      const tanksAlive = this.combat.units.filter((u) => u.heavy && !u.dead).length;
      if (a.tankClock > a.tankAt && tanksAlive < 2 && this.tanksSpawned < 3) {
        a.tankClock = 0;
        this._spawnTank(this.tanksSpawned);
        this._updateTankShield();
        this._bark('Coach Billing', 'Another HEAVY! Get him!');
      }
    }
  }

  // ---- Phase 1 -> 2: survive; then the rifle under the door --------------------------

  async _survived() {
    const { player, director, dialogue, wait, gym } = this;
    const c = this.combat;
    const mecha = this.mecha;
    this.phase = 'transition';
    c.hud.setTimer(null);
    mecha.overheat();
    c.endBeams();
    c.hazards.clear();
    c.healFull();
    this._beginCutscene();
    player.setLookTarget(() => mecha.domePoint(this._tmp2));
    await dialogue.say('Coach Billing', 'Overheating?! Not NOW, you piece of junk!', { hold: 1.0 });
    // Knocking on the glass doors.
    playKnock();
    await wait(0.5);
    const ben = gym.ben;
    ben.mesh.visible = true;
    ben.stop();
    ben.mesh.position.set(GYM.maxX + 1.2, 0, 0.6);
    ben.faceTowards(new THREE.Vector3(0, 0, 0.6));
    player.setLookTarget(() => ben.headPosition(this._tmp2));
    await wait(0.6);
    playKnock();
    await dialogue.say('Other Ben (outside)', "Dude! The doors are chained! I can't get in!", { hold: 1.2 });
    await dialogue.say('Other Ben (outside)', 'Hang on... HERE!', { hold: 0.7 });
    ben.mesh.userData.rig.crouch = true;
    await wait(0.5);
    // The rifle skids in under the doors and stops a few meters from you.
    const from = new THREE.Vector3(GYM.maxX - 0.2, 0.06, 0.4);
    const p = player.object.position;
    const to = new THREE.Vector3(THREE.MathUtils.clamp(p.x + 2.5, -12, GYM.maxX - 5), 0.06, THREE.MathUtils.clamp(p.z * 0.6, -5.5, 5.5));
    const r = gym.floorRifle;
    r.visible = true;
    r.position.copy(from);
    playFloorSkid(1.1);
    player.setLookTarget(() => this._tmp2.copy(r.position).setY(0.3));
    const dur = 1.1;
    for (let t = 0; t < dur; t += 1 / 60) {
      const k = 1 - (1 - t / dur) ** 2;
      r.position.lerpVectors(from, to, k);
      r.rotation.z = Math.PI / 2 + k * 2.4;
      await wait(1 / 60);
    }
    r.position.copy(to);
    gym.rifleHitbox.position.set(to.x, 0.3, to.z);
    ben.mesh.userData.rig.crouch = false;
    player.setLookTarget(() => ben.headPosition(this._tmp2));
    await dialogue.say('Other Ben (outside)', 'From the lab! Shoot its FEET! Knock it down, then go for the glass!', { hold: 1.4 });
    this.phase = 'rifle';
    player.setInteractables([gym.rifleHitbox]);
    this._endCutscene();
    c.hud.show(true);
    this.ui.setObjective('Grab the assault rifle!');
  }

  _takeRifle() {
    const c = this.combat;
    this.gym.floorRifle.visible = false;
    this.player.setInteractables([]);
    this.player.currentTarget = null;
    this.ui.setPrompt(null);
    c.rifle.dry = false;
    c.rifle.equip();
    c.hud.setReserve('/ ∞');
    playReloadStep('rack');
    this.mecha.setCracks(0);
    this._beginPhase(2); // (it stands back up out of its overheat)
    playBossRoar();
  }

  // ---- The dome cracks: the next phase ---------------------------------------------

  async _domeBroken(phase) {
    const token = ++this.token;
    const { player, dialogue, wait } = this;
    const c = this.combat;
    const mecha = this.mecha;
    this.phase = 'transition';
    this.adds = null;
    c.hazards.clear();
    c.missiles.clear();
    c.healFull();
    if (phase >= 4) {
      await this._mechaDestroyed(token);
      return;
    }
    this._beginCutscene();
    player.setLookTarget(() => mecha.domePoint(this._tmp2));
    await wait(0.6);
    if (phase === 2) {
      await dialogue.say('Coach Billing', 'You CRACKED my glass?! ...ELDARs! Get in here!', { hold: 1.2 });
    } else {
      await dialogue.say('Coach Billing', 'ENOUGH! Send in the HEAVIES!', { hold: 1.0 });
    }
    if (token !== this.token) return;
    playSteamVent(1.2);
    this._endCutscene();
    this._beginPhase(phase + 1);
    if (phase === 3) this._bark('Other Ben (outside)', 'Those big ones are feeding its legs a shield! Take them out!', 'tankIntro');
  }

  /** End of phase 4: it comes apart; you're dry; Billing climbs out of the wreck. */
  async _mechaDestroyed(token) {
    const { player, director, dialogue, wait, gym } = this;
    const c = this.combat;
    const mecha = this.mecha;
    this._beginCutscene();
    Achievements.unlock('game_day');
    for (const u of c.units) if (!u.dead) u._die(); // his ELDARs lose their link and drop
    mecha.breakDown();
    player.setLookTarget(() => mecha.aimPoint(this._tmp2));
    await dialogue.say('Coach Billing', 'No... no, no, NO! Not my Mecha!', { hold: 0.9 });
    await wait(2.4);
    if (token !== this.token) return;
    // The wreck is solid now.
    const w = gym.wreckCollider;
    w.position.set(mecha.root.position.x, 1.2, mecha.root.position.z);
    w.updateMatrixWorld(true);
    if (!gym.colliders.includes(w)) gym.colliders.push(w);
    this._refreshColliders();
    await wait(2.0);
    // You try the rifle on him as he crawls out: click. Click.
    c.rifle.ammo = 0;
    c.rifle.dry = true;
    c.hud.setAmmo(0);
    c.hud.setReserve('/ 0');
    await wait(0.4);
    playEmptyClick();
    await wait(0.25);
    playEmptyClick();
    this.ui.showMessage('Out of ammo!', 1800);
    // Billing hauls himself out of the cockpit and drops down in front of you.
    mecha.pilot.visible = false;
    const boxer = c.boxer;
    const wreck = mecha.root.position;
    const pp = player.object.position;
    const dx = pp.x - wreck.x;
    const dz = pp.z - wreck.z;
    const d = Math.hypot(dx, dz) || 1;
    const out = new THREE.Vector3(wreck.x + (dx / d) * 2.6, 0, wreck.z + (dz / d) * 2.6);
    boxer.spawn(this._tmp.set(wreck.x + (dx / d) * 0.6, 0, wreck.z + (dz / d) * 0.6), Math.atan2(dx, dz));
    boxer.mesh.position.y = 2.1;
    player.setLookTarget(() => boxer.aimPoint(this._tmp2).setY(boxer.mesh.position.y + 1.6));
    await dialogue.say('', 'Coach Billing drags himself out of the smoking cockpit.', { style: 'narration', hold: 1.0 });
    for (let t = 0; t < 0.7; t += 1 / 60) {
      const k = t / 0.7;
      boxer.mesh.position.lerpVectors(this._tmp, out, k);
      boxer.mesh.position.y = 2.1 * (1 - k) + Math.sin(k * Math.PI) * 0.35;
      await wait(1 / 60);
    }
    boxer.mesh.position.copy(out).setY(0);
    playBodyThud();
    c.shake(0.4);
    c.rifle.unequip();
    await dialogue.say('Coach Billing', 'No more toys, Ben. Just you... and me.', { hold: 1.2 });
    c.fists.equip(true);
    await dialogue.say('Coach Billing', "Let's see what you've got.", { hold: 0.8 });
    if (token !== this.token) return;
    boxer.engage();
    this._endCutscene();
    this._beginPhase(5);
  }

  // ---- Phase 5 done: the finale ----------------------------------------------------

  async _boxerDown() {
    this.phase = 'ending';
    this.token++;
    const c = this.combat;
    c.fists.setGuard(false);
    this.ui.hideObjective();
    this.ui.setPrompt(null);
    await this.wait(0.8);
    c.fists.equip(false);
    c.frozen = true; // (still running: Billing reels, the effects play out)
    c.hud.show(false);
    this.cutscene = true;
    await this.director.playGymFinale({
      gym: this.gym,
      combat: c,
      player: this.player,
      dialogue: this.dialogue,
      wait: this.wait,
      ui: this.ui,
      finale: this,
    });
  }

  /** (cutscene.js hands control back for the walk to the server room.) */
  releaseForServerRoom() {
    this.phase = 'toServer';
    this._endCutscene();
    this.combat.frozen = false;
    this.player.setInteractables([this.gym.portHitbox]);
    this.ui.setObjective('Follow Ben to the server room.');
  }

  // ---- Going down: this phase starts over -----------------------------------------------

  async _playerDown() {
    const { player, director } = this;
    const c = this.combat;
    const mecha = this.mecha;
    if (this._retrying) return;
    this._retrying = true;
    Achievements.death(); // (a flawless / single-life run ends here)
    const token = ++this.token;
    const phase = this.bossPhase;
    this.cutscene = true;
    player.setInputLocked(true);
    player.crouching = false;
    c.frozen = true;
    if (c.fists) c.fists.setGuard(false);
    await director.fader.to(1, 0.7);
    c.clearCombatants();
    c.effects.clear();
    c.resetPlayer();
    player.teleport(RETRY.player[0], RETRY.player[1], 0);
    if (phase <= 4) {
      mecha.beginPhase(phase, RETRY.mecha, Math.PI / 2);
      mecha.aiEnabled = true;
      mecha.setCracks(Math.max(0, phase - 2));
      if (phase >= 2) {
        c.rifle.dry = false;
        c.rifle.equip();
      }
    } else {
      const boxer = c.boxer;
      boxer.spawn(this._tmp.set(RETRY.player[0].x + 5, 0, RETRY.player[0].z), -Math.PI / 2);
      boxer.engage();
    }
    this._beginPhase(phase); // (bumps the token: anything still pending from before the fall is void)
    const retryToken = this.token;
    c.frozen = true;
    await this.wait(0.6);
    if (retryToken !== this.token) {
      this._retrying = false;
      return;
    }
    await director.fader.to(0, 0.6);
    player.setInputLocked(false);
    this.cutscene = false;
    c.frozen = false;
    this._retrying = false;
    this.ui.showMessage(`You went down! Phase ${phase} starts over.`, 3000);
  }

  // ---- Per frame -------------------------------------------------------------------

  update(dt) {
    if (!this.gym) return;
    this.time += dt;
    for (const u of this.gym.updatables) u.update(dt, this.time);
    this.gym.ben.update(dt);
    for (const o of this.gym.officers) o.update(dt);
    this.combat.update(dt);
    if (this.director.finaleUpdate) this.director.finaleUpdate(dt);
    if (this.phase === 'fight') {
      this._updateAdds(dt);
      if (this.bossPhase === 1 && !this.cutscene) {
        this.surviveT -= dt;
        const s = Math.max(0, Math.ceil(this.surviveT));
        this.combat.hud.setTimer(`SURVIVE  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
        if (this.surviveT <= 0) this._survived();
      }
    } else if (this.phase === 'rifle') {
      const t = this.player.currentTarget;
      const p = this.player.object.position;
      const r = this.gym.floorRifle.position;
      if (!t && this.gym.floorRifle.visible && Math.hypot(p.x - r.x, p.z - r.z) < 0.9) this._takeRifle(); // (walked right over it)
    }
    if (this.phase === 'toServer' && this.director.onServerRoomUpdate) this.director.onServerRoomUpdate(this);
  }

  handleInteract(target) {
    const type = target.userData.type;
    if (type === 'gym-rifle' && this.phase === 'rifle') this._takeRifle();
    else if (type === 'gym-usb' && this.phase === 'toServer') {
      this.phase = 'upload';
      this.player.setInteractables([]);
      this.ui.setPrompt(null);
      if (this.onPlugIn) this.onPlugIn();
    }
  }

  markerTarget() {
    if (this.cutscene) return null;
    if (this.phase === 'rifle' && this.gym.floorRifle.visible) {
      return { key: 'gym-rifle', position: this._tmp.copy(this.gym.floorRifle.position).setY(1.0), scale: 0.6 };
    }
    if (this.phase === 'toServer') {
      const inside = this.player.object.position.z > GYM.maxZ + 0.5;
      return inside
        ? { key: 'gym-usb', position: this._tmp.copy(this.gym.portHitbox.position).setY(1.9), scale: 0.5 }
        : { key: 'gym-server-door', position: this._tmp.copy(this.gym.serverDoor).setY(2.9), scale: 0.8 };
    }
    return null;
  }
}


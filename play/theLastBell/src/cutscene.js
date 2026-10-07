import * as THREE from 'three';
import { setSeatedPose, createHumanoid, COACH_BILLING_LOOK } from './world.js';
import { animateEldar } from './combat.js';
import {
  playCarDoor,
  playMechanism,
  playSting,
  playCarHorn,
  playEngineRoar,
  playGlassShatter,
  playCarCrash,
  playTireScreech,
  playBodyThud,
  playUsbInsert,
  playBeep,
  playPhoneDial,
  startPoliceSiren,
  stopPoliceSiren,
  playHandcuffs,
  playWahWah,
  startCreditsMusic,
  stopCreditsMusic,
  playServo,
  setRainExposure,
} from './audio.js';

// Car-local seat positions. The car faces local +Z; the driver sits on the left (+X).
const PASSENGER_EYE = new THREE.Vector3(-0.42, 1.1, -0.35);
const PASSENGER_DUCK = new THREE.Vector3(-0.42, 0.86, -0.25); // slumped just below the dashboard line
const DRIVER_SEAT = new THREE.Vector3(0.42, -0.06, -0.45);
const PASSENGER_DOOR = new THREE.Vector3(-1.5, 1.3, -0.35);

// Camera height for the tree meeting: high enough to look over the runners'
// heads (at normal eye height one of them stood right between you and Coach).
const MEETING_EYE_HEIGHT = 2.55;

const smooth = (t) => THREE.MathUtils.smoothstep(t, 0, 1);

function dampAngle(current, target, t) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}

// The end credits (they scroll up the right side, over the jail cell).
const CREDITS = [
  ['title', 'THE LAST BELL'],
  ['sub', 'a story about skipping practice at Hall High School'],
  ['gap'],
  ['head', 'STARRING'],
  ['role', 'Ben', 'You'],
  ['role', 'Other Ben', 'Other Ben'],
  ['role', 'Coach Billing', 'Coach Billing (in custody)'],
  ['role', 'Coach Lage', 'Himself'],
  ['role', 'Coach Tom', 'Himself'],
  ['role', 'Coach Hale', 'Himself'],
  ['role', 'The ELDAR Units', '42 + 1 Titan + 1 Mecha'],
  ['role', 'The Oak Tree', 'Itself'],
  ['role', 'The Rain', 'Every single scene'],
  ['gap'],
  ['head', 'CHAPTERS'],
  ['line', 'I · The Last Bell'],
  ['line', 'II · Below the Oak'],
  ['line', 'III · Lights Out'],
  ['gap'],
  ['head', 'MADE WITH'],
  ['line', 'three.js'],
  ['line', 'the Web Audio API (every sound, synthesized)'],
  ['line', 'Claude Code'],
  ['gap'],
  ['head', 'NO ROBOTS WERE HARMED'],
  ['line', '(several hundred were, actually)'],
  ['gap'],
  ['head', 'SPECIAL THANKS'],
  ['line', 'The XC team (sorry about the warm-up)'],
  ['line', "Hall High School's Wi-Fi"],
  ['line', 'Dispatch, for believing us about the robot suit'],
  ['line', 'Everyone who never skipped a lap'],
  ['gap'],
  ['sub', 'Practice is cancelled tomorrow.'],
  ['sub', '(Coach is busy.)'],
];

function createCreditsDom() {
  const el = document.createElement('div');
  el.id = 'credits';
  const rows = CREDITS.map(([kind, a, b]) => {
    if (kind === 'gap') return '<div class="cr-gap"></div>';
    if (kind === 'role') return `<div class="cr-role"><span>${a}</span><b>${b}</b></div>`;
    return `<div class="cr-${kind}">${a}</div>`;
  }).join('');
  el.innerHTML =
    '<div class="credits-shade"></div>' +
    `<div class="credits-roll"><div class="credits-inner">${rows}</div></div>` +
    '<div class="credits-bubble">Aw, what the heck!</div>' +
    '<div class="credits-end"><div class="ce-title">THE END</div>' +
    '<div class="ce-hard">HARD MODE UNLOCKED</div>' +
    '<div class="ce-sub">Toggle it on the main menu or in Chapter Select.</div>' +
    '<button class="credits-menu">MAIN MENU</button></div>' +
    '<button class="credits-skip">RETURN TO MAIN MENU &middot; HARD MODE UNLOCKED</button>';
  return el;
}

// ---------------------------------------------------------------------------
// Screen fader + chapter end card
// ---------------------------------------------------------------------------

/** Full-screen black fade driven by game time (so it pauses with the game). */
export class Fader {
  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:15;';
    document.body.appendChild(this.el);
    this.opacity = 0;
    this.anim = null;
  }

  to(opacity, seconds) {
    if (this.anim) this.anim.resolve();
    return new Promise((resolve) => {
      this.anim = { from: this.opacity, to: opacity, t: 0, seconds: Math.max(0.001, seconds), resolve };
    });
  }

  set(opacity) {
    if (this.anim) {
      this.anim.resolve();
      this.anim = null;
    }
    this.opacity = opacity;
    this.el.style.opacity = String(opacity);
  }

  update(dt) {
    const a = this.anim;
    if (!a) return;
    a.t += dt;
    const k = Math.min(1, a.t / a.seconds);
    this.opacity = a.from + (a.to - a.from) * k;
    this.el.style.opacity = String(this.opacity);
    if (k >= 1) {
      this.anim = null;
      a.resolve();
    }
  }
}

/**
 * Chapter end card over black. Chapter 1 played on its own from Chapter
 * Select gets a Continue button (normal Play rolls straight on into Chapter 2
 * instead); Chapter 2 just offers the main menu. Returns { remove }.
 */
export function showChapterComplete({ chapter = 1, next = 'NEXT: CHAPTER 2 · BELOW THE OAK', onContinue = null, onMenu }) {
  const card = document.createElement('div');
  card.style.cssText =
    'position:fixed;inset:0;z-index:16;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
    'color:#d9dee3;font-family:"Courier New",Courier,monospace;text-align:center;opacity:0;transition:opacity 2.5s ease;';
  const title = document.createElement('div');
  title.textContent = `CHAPTER ${chapter} COMPLETE`;
  title.style.cssText = 'font-size:34px;letter-spacing:10px;color:#b3413b;';
  const sub = document.createElement('div');
  sub.textContent = next;
  sub.style.cssText = 'font-size:14px;letter-spacing:5px;color:rgba(217,222,227,0.6);';
  const buttons = document.createElement('div');
  buttons.style.cssText = 'margin-top:28px;display:flex;gap:14px;';
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'cursor:pointer;font-family:inherit;font-size:13px;letter-spacing:2px;padding:10px 24px;' +
      'background:transparent;border:1px solid #b3413b;color:#d9dee3;';
    b.addEventListener('click', onClick);
    buttons.appendChild(b);
  };
  if (onContinue) button(`CONTINUE TO CHAPTER ${chapter + 1}`, onContinue);
  button('MAIN MENU', onMenu);
  card.append(title, sub, buttons);
  document.body.appendChild(card);
  card.getBoundingClientRect(); // commit the initial opacity so the transition runs
  card.style.opacity = '1';
  return { remove: () => card.remove() };
}

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

function createPortalTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050101';
  ctx.fillRect(0, 0, 128, 256);
  const rim = ctx.createLinearGradient(0, 0, 128, 0);
  rim.addColorStop(0, 'rgba(255,70,30,0.9)');
  rim.addColorStop(0.18, 'rgba(120,20,10,0.35)');
  rim.addColorStop(0.82, 'rgba(120,20,10,0.35)');
  rim.addColorStop(1, 'rgba(255,70,30,0.9)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, 128, 256);
  const top = ctx.createLinearGradient(0, 0, 0, 256);
  top.addColorStop(0, 'rgba(255,80,40,0.6)');
  top.addColorStop(0.25, 'rgba(0,0,0,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, 128, 256);
  const core = ctx.createRadialGradient(64, 140, 4, 64, 140, 90);
  core.addColorStop(0, 'rgba(0,0,0,1)');
  core.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, 128, 256);
  // Steps leading down, lit red from somewhere below.
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = `rgba(${170 - i * 25},24,12,${0.65 - i * 0.1})`;
    ctx.fillRect(22 + i * 5, 176 + i * 15, 84 - i * 10, 5);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createRainStreakTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 1 + Math.random() * 2.8;
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.6, 'rgba(180,195,210,0.25)');
    g.addColorStop(1, 'rgba(40,50,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(200,215,230,0.2)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 28; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const len = 20 + Math.random() * 60;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + 2, y + len * 0.3, x - 2, y + len * 0.6, x + (Math.random() - 0.5) * 4, y + len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1.2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// The secret door built into the oak's trunk
// ---------------------------------------------------------------------------

/**
 * A curved bark panel sits 3.5cm proud of the trunk over a glowing doorway
 * decal. Opening = the seams glow, then the panel slides around the trunk's
 * circumference like a mechanical hatch. It exists from game start, hidden in
 * plain sight (you can spot the panel's outline if you look closely in Phase 2).
 */
class TreeDoor {
  constructor(tree, angle) {
    const { group, trunk, baseRadius, topRadius, height } = tree;
    const H = 2.15;
    const WIDTH = 0.62; // radians of trunk circumference
    const rAt = (y) => baseRadius + (topRadius - baseRadius) * (y / height);

    this.pivot = new THREE.Group(); // door faces this pivot's local +Z
    this.pivot.rotation.y = angle;
    group.add(this.pivot);

    const portal = new THREE.Mesh(
      new THREE.CylinderGeometry(rAt(H) + 0.012, rAt(0) + 0.012, H, 12, 1, true, -WIDTH / 2, WIDTH),
      new THREE.MeshBasicMaterial({ map: createPortalTexture() }),
    );
    portal.position.y = H / 2;
    this.pivot.add(portal);

    this.panelPivot = new THREE.Group();
    this.pivot.add(this.panelPivot);
    const panel = new THREE.Mesh(
      new THREE.CylinderGeometry(rAt(H) + 0.035, rAt(0) + 0.035, H + 0.04, 12, 1, true, -WIDTH / 2 - 0.03, WIDTH + 0.06),
      trunk.material,
    );
    panel.position.y = H / 2 + 0.01;
    panel.castShadow = true;
    this.panelPivot.add(panel);

    // Seams outlining the doorway: black until the reveal, then glowing red.
    this.seamMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const seamR = rAt(H / 2) + 0.04;
    [-1, 1].forEach((s) => {
      const a = s * (WIDTH / 2 + 0.03);
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.03, H + 0.04, 0.02), this.seamMat);
      seam.position.set(Math.sin(a) * seamR, H / 2 + 0.01, Math.cos(a) * seamR);
      seam.rotation.y = a;
      this.pivot.add(seam);
    });
    const topSeam = new THREE.Mesh(
      new THREE.CylinderGeometry(rAt(H) + 0.04, rAt(H) + 0.04, 0.03, 12, 1, true, -WIDTH / 2 - 0.03, WIDTH + 0.06),
      this.seamMat,
    );
    topSeam.position.y = H + 0.03;
    this.pivot.add(topSeam);

    // Red light that spills out of the doorway once it opens.
    this.light = new THREE.PointLight(0xff3a1a, 0, 10, 1.6);
    this.light.position.set(0, 1.1, rAt(1.1) + 0.6);
    this.pivot.add(this.light);

    this.OPEN_ROT = WIDTH + 0.12;
    this.anim = null;
  }

  open() {
    playMechanism(2.2);
    return new Promise((resolve) => {
      this.anim = { type: 'open', t: 0, resolve };
    });
  }

  close() {
    playMechanism(1.3);
    return new Promise((resolve) => {
      this.anim = { type: 'close', t: 0, resolve };
    });
  }

  update(dt) {
    const a = this.anim;
    if (!a) return;
    a.t += dt;
    let glow;
    let slide;
    if (a.type === 'open') {
      glow = Math.min(1, a.t / 0.8); // seams light up first...
      slide = THREE.MathUtils.smoothstep(a.t, 0.8, 2.2); // ...then the panel slides away
    } else {
      slide = 1 - THREE.MathUtils.smoothstep(a.t, 0, 1.2);
      glow = 1 - THREE.MathUtils.clamp((a.t - 1.2) / 1.0, 0, 1);
    }
    this.panelPivot.rotation.y = slide * this.OPEN_ROT;
    this.light.intensity = slide * 7;
    this.seamMat.color.setRGB(glow, glow * 0.22, glow * 0.1);
    if (a.t >= 2.3) {
      this.anim = null;
      a.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// Passenger-seat interior (only ever seen from inside the tinted cabin)
// ---------------------------------------------------------------------------

function buildCarInterior(car) {
  const g = new THREE.Group();
  car.add(g);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6 });
  const add = (geo, mat, x, y, z, rx = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rx;
    g.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(1.64, 0.2, 0.5), dark, 0, 0.88, 0.62); // dashboard
  add(new THREE.BoxGeometry(1.6, 0.03, 0.34), trim, 0, 0.995, 0.6); // dash top
  // Lower dash / glovebox: without it, ducking below the dash looked straight
  // through the (hollow) car body out onto the field.
  const lower = new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.85 });
  add(new THREE.BoxGeometry(1.64, 0.56, 0.5), lower, 0, 0.5, 0.62);
  add(new THREE.BoxGeometry(0.5, 0.17, 0.01), trim, -0.42, 0.62, 0.366); // glovebox lid
  add(new THREE.TorusGeometry(0.17, 0.022, 8, 20), trim, 0.42, 1.0, 0.4, 0.35); // steering wheel
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), trim, 0.42, 0.95, 0.5, 1.2); // column
  [-1, 1].forEach((s) => add(new THREE.BoxGeometry(0.07, 0.62, 0.07), trim, s * 0.8, 1.08, 0.66, -0.55)); // A-pillars
  add(new THREE.BoxGeometry(1.6, 0.07, 0.14), trim, 0, 1.32, 0.45); // roof header

  const rainTex = createRainStreakTexture();
  const windshield = add(
    new THREE.PlaneGeometry(1.52, 0.66),
    new THREE.MeshBasicMaterial({ map: rainTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    0, 1.08, 0.67, -0.55,
  );
  windshield.renderOrder = 2;

  return {
    update(dt) {
      rainTex.offset.y += dt * 0.05; // drops sliding down the glass
      rainTex.offset.x = Math.sin(performance.now() * 0.0003) * 0.01;
    },
  };
}

// ---------------------------------------------------------------------------
// The very end: a jail cell for the credits (Coach Billing, dancing)
// ---------------------------------------------------------------------------

function buildJailCell() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040507);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x80868c, roughness: 0.95 });
  const block = new THREE.MeshStandardMaterial({ color: 0xaeb4ab, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a5056, roughness: 0.4, metalness: 0.8 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(4.4, 0.1, 3.8), concrete, 0, -0.05, 0);
  add(new THREE.BoxGeometry(4.4, 2.9, 0.2), block, 0, 1.45, -1.9);
  add(new THREE.BoxGeometry(0.2, 2.9, 3.8), block, -2.2, 1.45, 0);
  add(new THREE.BoxGeometry(0.2, 2.9, 3.8), block, 2.2, 1.45, 0);
  add(new THREE.BoxGeometry(4.6, 0.1, 4), concrete, 0, 2.95, 0);
  for (let x = -2.05; x <= 2.06; x += 0.26) add(new THREE.CylinderGeometry(0.024, 0.024, 2.9, 8), steel, x, 1.45, 1.8);
  add(new THREE.BoxGeometry(4.4, 0.08, 0.08), steel, 0, 2.75, 1.8);
  add(new THREE.BoxGeometry(4.4, 0.08, 0.08), steel, 0, 0.12, 1.8);
  // A bunk, a steel toilet, a barred window with the moon in it.
  add(new THREE.BoxGeometry(0.8, 0.45, 1.9), steel, -1.7, 0.225, -0.7);
  add(new THREE.BoxGeometry(0.76, 0.1, 1.84), new THREE.MeshStandardMaterial({ color: 0x5b6b7c, roughness: 1 }), -1.7, 0.5, -0.7);
  add(new THREE.CylinderGeometry(0.2, 0.16, 0.42, 12), steel, 1.65, 0.21, -1.45);
  add(new THREE.BoxGeometry(0.42, 0.4, 0.14), steel, 1.65, 0.55, -1.72);
  add(new THREE.BoxGeometry(0.7, 0.42, 0.05), new THREE.MeshBasicMaterial({ color: 0x3a4a66 }), 0.5, 2.25, -1.79);
  for (let x = 0.22; x <= 0.8; x += 0.14) add(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6), steel, x, 2.25, -1.76);
  // A tally of days scratched into the wall (it's been one).
  const tally = document.createElement('canvas');
  tally.width = 256;
  tally.height = 128;
  const g = tally.getContext('2d');
  g.strokeStyle = 'rgba(40,40,40,0.8)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(40, 20);
  g.lineTo(40, 100);
  g.stroke();
  g.font = 'bold 22px "Comic Sans MS", cursive';
  g.fillStyle = 'rgba(40,40,40,0.8)';
  g.fillText('DAY 1', 70, 70);
  const tallyTex = new THREE.CanvasTexture(tally);
  tallyTex.colorSpace = THREE.SRGBColorSpace;
  add(new THREE.PlaneGeometry(0.8, 0.4), new THREE.MeshStandardMaterial({ map: tallyTex, transparent: true }), -1.2, 1.7, -1.79);
  scene.add(new THREE.AmbientLight(0x404858, 0.9));
  const spot = new THREE.SpotLight(0xfff0d8, 34, 12, 0.5, 0.5, 1.2);
  spot.position.set(0.3, 4.2, 3.6);
  spot.target.position.set(0, 1, 0);
  scene.add(spot, spot.target);
  const moon = new THREE.PointLight(0x9fb4ff, 2.2, 5, 2);
  moon.position.set(0.5, 2.1, -1.4);
  scene.add(moon);
  // Party lights. (It's that kind of jail cell.)
  const disco = [0xff4ab0, 0x3ad8ff].map((c) => {
    const l = new THREE.PointLight(c, 3.2, 6, 1.8);
    scene.add(l);
    return l;
  });
  const billing = createHumanoid({ ...COACH_BILLING_LOOK, shirt: 0xe8742a, pants: 0xe8742a, raincoat: false, hood: false, whistle: false });
  billing.position.set(0, 0, 0.2);
  scene.add(billing);
  const patch = document.createElement('canvas');
  patch.width = 128;
  patch.height = 64;
  const pg = patch.getContext('2d');
  pg.fillStyle = '#f4efe2';
  pg.fillRect(0, 0, 128, 64);
  pg.fillStyle = '#111';
  pg.font = 'bold 30px "Courier New", monospace';
  pg.textAlign = 'center';
  pg.fillText('42-01', 64, 44);
  const patchTex = new THREE.CanvasTexture(patch);
  patchTex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.11), new THREE.MeshBasicMaterial({ map: patchTex }));
  tag.position.set(0.1, 1.24, 0.135);
  billing.userData.rig.body.add(tag);
  return { scene, billing, disco };
}

/** One frame of Billing's routine: 0 the robot, 1 disco point, 2 the sprinkler, 3 raise the roof, 4 "aw, what the heck". */
function poseDance(rig, t, move, dt) {
  const k = Math.min(1, dt * 16);
  const set = (j, axis, v) => {
    j.rotation[axis] += (v - j.rotation[axis]) * k;
  };
  const beat = t * (126 / 60) * Math.PI; // a half-turn of the sine per beat
  const b = Math.sin(beat);
  const b2 = Math.sin(beat * 0.5);
  const bounce = Math.abs(Math.sin(beat));
  let shR = 0;
  let shL = 0;
  let shRz = 0;
  let shLz = 0;
  let elR = -0.2;
  let elL = -0.2;
  let hips = 0;
  let twist = 0;
  let neck = 0;
  switch (move) {
    case 0: // the robot
      shR = b > 0 ? -1.55 : -0.2;
      shL = b > 0 ? -0.2 : -1.55;
      elR = elL = -1.55;
      twist = b > 0 ? 0.25 : -0.25;
      neck = b2 > 0 ? 0.15 : -0.15;
      break;
    case 1: // disco point
      shR = b2 > 0 ? -2.9 : -0.5;
      shRz = b2 > 0 ? -0.5 : 0.6;
      elR = -0.05;
      shL = -0.3;
      elL = -1.3;
      shLz = -0.3;
      hips = 0.14 * b;
      break;
    case 2: // the sprinkler
      shR = -1.55;
      elR = 0;
      shRz = -0.3 + 0.6 * ((beat / Math.PI) % 2) / 2;
      shL = -0.4;
      elL = -2.2;
      shLz = 1.0;
      twist = -0.5 + ((beat / Math.PI) % 2) * 0.5;
      break;
    case 3: // raise the roof
      shR = shL = -2.6 - 0.3 * bounce;
      elR = elL = -0.9 + 0.5 * bounce;
      shRz = -0.3;
      shLz = 0.3;
      neck = -0.2 * bounce;
      hips = 0.08 * b;
      break;
    default: // "aw, what the heck!"
      shR = shL = -0.5;
      shRz = -1.1;
      shLz = 1.1;
      elR = elL = -0.9;
      neck = 0.25 * Math.sin(t * 9);
      break;
  }
  set(rig.shoulderR, 'x', shR);
  set(rig.shoulderL, 'x', shL);
  set(rig.shoulderR, 'z', shRz);
  set(rig.shoulderL, 'z', shLz);
  set(rig.elbowR, 'x', elR);
  set(rig.elbowL, 'x', elL);
  set(rig.body, 'z', hips);
  set(rig.body, 'y', twist);
  set(rig.neck, 'y', move === 4 ? neck : 0);
  set(rig.neck, 'x', move === 4 ? 0.1 : neck);
  const knees = move === 4 ? 0.05 : 0.2 + 0.4 * bounce;
  set(rig.kneeL, 'x', knees);
  set(rig.kneeR, 'x', knees);
  set(rig.hipL, 'x', -knees * 0.5);
  set(rig.hipR, 'x', -knees * 0.5);
  rig.body.position.y = move === 4 ? 0 : -0.07 * bounce;
}

// ---------------------------------------------------------------------------
// Cutscene director: the tree meeting (Phase 2) and the car escape + climax (Phase 4)
// ---------------------------------------------------------------------------

export class CutsceneDirector {
  constructor({ world, camera }) {
    this.world = world;
    this.camera = camera;
    this.fader = new Fader();

    const treePos = world.tree.group.position;
    const car = world.playersCar;
    // The door faces the player's car so the climax plays out through the windshield.
    const angle = Math.atan2(car.position.x - treePos.x, car.position.z - treePos.z);
    this.treeDoor = new TreeDoor(world.tree, angle);
    const dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    this.doorApproach = treePos.clone().addScaledVector(dir, 2.9);
    this.doorway = treePos.clone().addScaledVector(dir, 1.95);
    this.inside = treePos.clone().addScaledVector(dir, 0.5);
    this.doorLook = treePos.clone().addScaledVector(dir, 1.9).setY(1.3);
    // Coach starts back across the field, off the car's sightline so he's seen side-on.
    this.coachStage = treePos.clone().addScaledVector(dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.45), 21);

    this.interior = buildCarInterior(car);
    this.camMove = null;
    this.zoom = null;
    this.descent = null;
    this._benTargetY = null; // Ben's seat height while ducking in the car
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._frameWaiters = [];
    this._finale = null; // Chapter 3's ending: its actors and timers
  }

  update(dt) {
    this.fader.update(dt);
    this.treeDoor.update(dt);
    this.interior.update(dt);

    const m = this.camMove;
    if (m) {
      m.t += dt;
      const dur = m.durations[m.seg];
      this.camera.position.lerpVectors(m.from, m.points[m.seg], smooth(Math.min(1, m.t / dur)));
      if (m.t >= dur) {
        m.from = m.points[m.seg].clone();
        m.seg++;
        m.t = 0;
        if (m.seg >= m.points.length) {
          this.camMove = null;
          m.resolve();
        }
      }
    }

    const z = this.zoom;
    if (z) {
      z.t += dt;
      const k = smooth(Math.min(1, z.t / z.duration));
      this.camera.fov = z.from + (z.to - z.from) * k;
      this.camera.updateProjectionMatrix();
      if (z.t >= z.duration) this.zoom = null;
    }

    if (this._benTargetY !== null) {
      const ben = this.world.npcs.ben.mesh;
      ben.position.y += (this._benTargetY - ben.position.y) * Math.min(1, dt * 12);
    }

    const d = this.descent;
    if (d) {
      // Walking down steps inside the trunk: sink as he moves toward the center.
      const pos = d.coach.position;
      const remaining = Math.hypot(this.inside.x - pos.x, this.inside.z - pos.z);
      pos.y = -1.3 * (1 - Math.min(1, remaining / d.total));
    }
  }

  moveCamera(points, durations) {
    return new Promise((resolve) => {
      this.camMove = { from: this.camera.position.clone(), points, durations, seg: 0, t: 0, resolve };
    });
  }

  zoomTo(fov, duration) {
    this.zoom = { from: this.camera.fov, to: fov, t: 0, duration };
  }

  /**
   * End of a cutscene: drop any camera glide / zoom still running (resolving
   * their promises), snap the lens back to normal and clear the black fade,
   * so nothing from the scene carries over into gameplay.
   */
  releaseCamera(fov = 75) {
    if (this.camMove) {
      const m = this.camMove;
      this.camMove = null;
      m.resolve();
    }
    this.zoom = null;
    this._benTargetY = null;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.fader.set(0);
  }

  /** Both of you slump below the dashboard for `seconds`, then peek back up. */
  async _duck(seconds, wait) {
    const car = this.world.playersCar;
    const ben = this.world.npcs.ben.mesh;
    const seatY = ben.position.y;
    this._benTargetY = seatY - 0.32;
    await this.moveCamera([car.localToWorld(PASSENGER_DUCK.clone())], [0.22]);
    await wait(seconds);
    this._benTargetY = seatY;
    await this.moveCamera([car.localToWorld(PASSENGER_EYE.clone())], [0.45]);
    this._benTargetY = null;
    ben.position.y = seatY;
  }

  async descend(coach) {
    const total = Math.hypot(this.inside.x - coach.position.x, this.inside.z - coach.position.z) || 1;
    this.descent = { coach, total };
    await coach.moveTo(this.inside.x, this.inside.z, 1.2);
    this.descent = null;
    coach.mesh.visible = false;
    coach.mesh.position.y = 0;
  }

  /**
   * Phase 2 huddle at the oak. The camera glides in and rises above head
   * height so no runner blocks the view. Coach announces practice, late Ben
   * sprints in, Coach pulls him aside for a private reprimand, Ben trudges back
   * and mutters to you, then Coach calls the warm-up.
   */
  async playTreeMeeting({ player, dialogue, wait }) {
    const { coach, ben, runners, students } = this.world.npcs;
    const L = this.world.landmarks;
    const head = (c) => () => c.headPosition(this._tmp);
    const group = () => [...runners, ...students.filter((s) => s.atTree)];
    const midpoint = new THREE.Vector3();

    player.setInputLocked(true);
    player.setCameraOverride(true);
    player.setLookTarget(head(coach));
    coach.faceTowards(player.object.position);
    const vantage = new THREE.Vector3(L.joinSpot.x, MEETING_EYE_HEIGHT, L.joinSpot.z);
    const glide = Math.max(0.9, this.camera.position.distanceTo(vantage) / 3.4);
    await this.moveCamera([vantage], [glide]);
    await wait(0.3);
    await dialogue.say('Coach Billing', 'Rain rain go away, we will practice anyway. Practice is ON today!');

    // Late Ben sprints in from the parking lot.
    ben.mesh.position.copy(L.benStart);
    ben.mesh.visible = true;
    coach.faceTowards(ben.position);
    group().forEach((r, i) => {
      if (i % 2 === 0) r.faceTowards(ben.position);
    });
    player.setLookTarget(head(ben));
    await Promise.all([
      ben.moveTo(L.benConfront.x, L.benConfront.z, 6.2),
      dialogue.say('', 'Someone comes sprinting over from the parking lot...', { style: 'narration', hold: 1.2 }),
    ]);
    ben.faceTowards(coach.position);
    player.setLookTarget(head(coach));
    await wait(0.4);
    await dialogue.say('Coach Billing', 'Ben! We missed you.');
    await dialogue.say('Coach Billing', 'A word. Over here. Now.', { hold: 1.0 });

    // Coach pulls Ben aside, out of earshot of the group.
    player.setLookTarget(() => midpoint.addVectors(coach.position, ben.position).multiplyScalar(0.5).setY(1.7));
    group().forEach((r) => r.faceTowards(L.asideCoach));
    await Promise.all([coach.walkRoute([L.asideVia, L.asideCoach], 1.8), ben.walkRoute([L.asideBen], 1.6)]);
    coach.faceTowards(ben.position);
    ben.faceTowards(coach.position);
    coach.mesh.userData.rig.pointing = true;
    await dialogue.say('', "Coach pulls Ben aside. You can't make out the words, but he's jabbing a finger at Ben's chest.", {
      style: 'narration',
      hold: 2.0,
    });
    await dialogue.say('Coach Billing', '...and if it happens again, you are OFF this team. Understood?', { hold: 1.3 });
    coach.mesh.userData.rig.pointing = false;
    ben.mesh.userData.rig.nod = true;
    await dialogue.say('Other Ben', 'Yes, Coach.', { hold: 0.9 });
    ben.mesh.userData.rig.nod = false;

    // Ben trudges back to you; Coach returns to the front of the group.
    const coachBack = coach.walkRoute([L.asideVia, L.coachSpot], 1.8);
    group().forEach((r) => r.faceTowards(coach.position));
    player.setLookTarget(head(ben));
    await ben.moveTo(L.benWhisper.x, L.benWhisper.z, 1.5);
    ben.faceTowards(player.object.position);
    await dialogue.say('Other Ben (muttering)', 'Man, I just got strike 1 and 2 from Coach Billing...', { style: 'whisper' });

    await coachBack;
    coach.faceTowards(player.object.position);
    player.setLookTarget(head(coach));
    await wait(0.4);
    await dialogue.say('Coach Billing', 'Warm-up loop around the outer perimeter trail! Move!');

    // Settle back to eye height and hand control back.
    await this.moveCamera([new THREE.Vector3(vantage.x, player.eyeHeight, vantage.z)], [0.6]);
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.setInputLocked(false);
  }

  /**
   * [E] Get in car -> camera lerps into the passenger seat -> Coach walks to the
   * oak, opens the hidden door in the trunk, descends, it seals -> sting, black,
   * CHAPTER 1 COMPLETE.
   */
  async playEnding({ player, stealth, dialogue, wait }) {
    const { coach, ben } = this.world.npcs;
    const car = this.world.playersCar;
    const billing = stealth.guard('billing');

    player.setInputLocked(true);
    player.setCameraOverride(true);
    stealth.stop(); // detection off; Coach Lage and Coach Tom keep walking their rounds
    billing.takeover();
    playCarDoor();

    // Ben takes the driver's seat (hidden by the tinted cabin until the camera is inside).
    ben.stop();
    ben.mesh.userData.rig.crouch = false;
    ben.mesh.position.copy(car.localToWorld(DRIVER_SEAT.clone()));
    ben.mesh.rotation.y = car.rotation.y;
    if (!ben.mesh.userData.rig.seated) setSeatedPose(ben.mesh);

    // Stage Coach across the field, heading back to the tree with his flashlight.
    coach.stop();
    coach.faceTowards(null);
    coach.mesh.visible = true;
    coach.mesh.position.set(this.coachStage.x, 0, this.coachStage.z);
    billing.lightOn();

    // Smoothly lerp the camera into the passenger seat, looking out the windshield.
    player.setLookTarget(car.localToWorld(new THREE.Vector3(-0.42, 1.0, 30)));
    await this.moveCamera(
      [car.localToWorld(PASSENGER_DOOR.clone()), car.localToWorld(PASSENGER_EYE.clone())],
      [0.8, 1.0],
    );
    playCarDoor();
    this.world.rain.exposureOverride = 0.4; // muffled drumming on the car roof
    await wait(0.5);
    await dialogue.say('Other Ben', "Made it. If Coach finds out we skipped, that's strike three for me.");
    const walk = coach.moveTo(this.doorApproach.x, this.doorApproach.z, 2.1);
    await dialogue.say('Other Ben', 'Wait... is that Coach? Why is he walking back to the tree?');
    player.setLookTarget(() => coach.headPosition(this._tmp));
    this.zoomTo(38, 3);
    await walk;

    // He glances back toward the lot; his flashlight sweeps across the windshield.
    billing.aimOverride = car.position;
    coach.faceTowards(car.position);
    const getDown = dialogue.say('Other Ben (whispering)', "Get down. Don't. Move.", { style: 'whisper', hold: 1.2 });
    await wait(0.3); // "Get down—"
    await this._duck(1.0, wait); // camera drops below the dash for a second, then peeks back up
    await getDown;
    billing.aimOverride = null;
    coach.faceTowards(this.doorway);
    await wait(1.0);

    // The concealed panel in the trunk grinds open.
    player.setLookTarget(this.doorLook);
    await this.treeDoor.open();
    await dialogue.say('Other Ben (whispering)', '...Is that a DOOR? In the TREE?', { style: 'whisper', hold: 1.0 });
    await coach.moveTo(this.doorway.x, this.doorway.z, 1.3);
    await this.descend(coach);
    billing.lightOff();
    await this.treeDoor.close();
    await wait(1.2);

    // Dramatic sting, hard cut to black. (main.js decides what comes next:
    // straight into Chapter 2, or the end card when played from Chapter Select.)
    playSting();
    this.fader.set(1);
    this.world.rain.exposureOverride = 0.2;
    document.getElementById('hud').classList.add('hidden');
    await wait(1.8);
  }

  // =========================================================================
  // Chapter 3's ending: the car through the gym doors, the upload, the arrest,
  // and the credits. (chapter3_gym.js calls playGymFinale once Billing's out
  // on his feet; its update() drives finaleUpdate every frame.)
  // =========================================================================

  /** Resolves on the next frame, with that frame's dt. */
  _nextFrame() {
    return new Promise((resolve) => this._frameWaiters.push(resolve));
  }

  /** Wait (frame by frame) until `cond()` holds, or `maxSeconds` pass. */
  async _until(cond, maxSeconds = 10) {
    let t = 0;
    while (!cond() && t < maxSeconds) t += await this._nextFrame();
  }

  /** Per frame while the gym is loaded. */
  finaleUpdate(dt) {
    if (this._frameWaiters.length) {
      const waiters = this._frameWaiters;
      this._frameWaiters = [];
      for (const resolve of waiters) resolve(dt);
    }
    const f = this._finale;
    if (!f) return;
    f.t += dt;
    if (f.flight) this._updateFlight(dt);
    if (f.police) f.gym.police.forEach((p, i) => p.flash(f.t + i * 0.08));
    if (f.upload) this._updateUpload(dt);
    if (f.actors) this._updateActors(dt);
    if (f.jail) this._updateJail(dt);
  }

  async playGymFinale(ctx) {
    const f = (this._finale = { ...ctx, t: 0, flight: null, police: false, upload: null, actors: null, jail: null, saidPlug: false });
    await this._playCarCrash(f);
    f.finale.releaseForServerRoom();
    await new Promise((resolve) => {
      f.finale.onPlugIn = resolve;
    });
    await this._playUpload(f);
    await this._playArrest(f);
    await this._playCredits(f);
  }

  _lockView(f) {
    f.finale.cutscene = true;
    f.player.setInputLocked(true);
    f.player.setCameraOverride(true);
  }

  /** Billing, reeling... headlights through the glass... the car comes through the doors and flattens him. */
  async _playCarCrash(f) {
    const { gym, combat, player, dialogue, wait } = f;
    const boxer = combat.boxer;
    const car = gym.car;
    const ben = gym.ben;
    this._lockView(f);
    await this.fader.to(1, 0.3);
    // Staging: the Mecha's loose scrap is swept away behind the black; Billing on his feet (just)
    // somewhere the car has a clear run at him (no gym equipment, no wreck in its way); you
    // facing him with the glass doors beyond.
    this._hideScrap(f);
    const { B, lateral } = this._pickCrashLane(f);
    const zB = B.z;
    boxer.active = true;
    boxer.state = 'dazed';
    boxer.mesh.visible = true;
    boxer.mesh.position.copy(B);
    boxer.yaw = -Math.PI / 2;
    this.camera.position.set(B.x - 5.4, 1.7, zB - lateral * 2.6);
    player.setLookTarget(() => boxer.aimPoint(this._tmp).setY(1.75));
    ben.stop();
    ben.mesh.visible = false;
    await this.fader.to(0, 0.35);
    await dialogue.say('Coach Billing', "You... you little... I'm not... done... yet...", { hold: 1.3 });
    // Headlights, beyond the glass.
    car.group.visible = true;
    car.group.position.set(gym.glassDoors.x + 16, 0, 0);
    car.group.rotation.set(0, -Math.PI / 2, 0);
    car.setLights(true);
    playCarHorn();
    player.setLookTarget(() => this._tmp.lerpVectors(boxer.aimPoint(this._tmp2), car.group.position, 0.3).setY(1.5));
    await wait(0.8);
    boxer.yaw = Math.PI / 2; // he turns around into the light
    await dialogue.say('Coach Billing', '...Huh?', { hold: 0.4 });
    playEngineRoar(2.4);
    await this._driveCar(f, B, lateral);
    // Dust settles. Ben gets out.
    await wait(1.0);
    player.setLookTarget(() => this._tmp.copy(f.flight.mesh.position).setY(0.6));
    await wait(0.6);
    playCarDoor();
    car.group.updateMatrixWorld(true);
    const door = car.group.localToWorld(new THREE.Vector3(1.5, 0, 0.3));
    ben.mesh.position.set(door.x, 0, door.z);
    ben.mesh.userData.rig.crouch = false;
    ben.mesh.visible = true;
    const kb = f.flight.mesh.position;
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await ben.moveTo(kb.x + 0.9, kb.z - lateral * 0.7, 4.2);
    ben.faceTowards(kb.clone());
    ben.mesh.userData.rig.crouch = true;
    player.setLookTarget(() => this._tmp.copy(kb).setY(0.7));
    await wait(0.6);
    await dialogue.say('Other Ben', "We have to be quick, he's still breathing lightly!", { hold: 1.6 });
    ben.mesh.userData.rig.crouch = false;
    ben.faceTowards(player.object.position);
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await dialogue.say('Other Ben', "The server room's through that door. Upload the drive, now, while he's out!", { hold: 1.4 });
    // He runs for it (around the end of the bleachers).
    const sd = gym.serverDoor;
    const path = f.finale.nav.path(ben.position, new THREE.Vector3(sd.x, 0, sd.z - 0.8)) || [];
    const route = [...path, { x: sd.x, z: sd.z + 2 }, { x: sd.x - 0.5, z: gym.serverRoom.minZ + 2.4 }];
    ben.walkRoute(route, 4.6).then(() => ben.faceTowards(gym.serverRoom.port));
    await wait(0.5);
    player.setLookTarget(null);
  }

  async _driveCar(f, B, lateral) {
    const { gym, combat } = f;
    const car = gym.car.group;
    const doorX = gym.glassDoors.x;
    const hitAt = B.clone();
    const pts = [new THREE.Vector3(doorX + 1.6, 0, 0), new THREE.Vector3(doorX - 4, 0, B.z * 0.5), hitAt, new THREE.Vector3(B.x - 3.6, 0, B.z)];
    const dir = new THREE.Vector3();
    let seg = 0;
    let speed = 5;
    let hit = false;
    let smashed = false;
    let t = 0;
    while (seg < pts.length && t < 8) {
      const dt = await this._nextFrame();
      t += dt;
      const to = pts[seg];
      dir.subVectors(to, car.position);
      dir.y = 0;
      const d = dir.length();
      speed = hit ? Math.max(1.5, speed - 40 * dt) : Math.min(22, speed + 24 * dt);
      const step = speed * dt;
      if (d > 0.05) car.rotation.y = dampAngle(car.rotation.y, Math.atan2(dir.x, dir.z), Math.min(1, dt * 5));
      if (d <= step) {
        car.position.copy(to);
        seg++;
      } else {
        car.position.addScaledVector(dir.normalize(), step);
      }
      for (const wheel of gym.car.wheels) wheel.rotation.x += (speed * dt) / 0.33;
      if (!smashed && car.position.x < doorX + 2.4) {
        smashed = true;
        gym.shatterDoors();
        playGlassShatter();
        this._tmp.set(doorX, 1.4, 0);
        combat.effects.spark(this._tmp, { count: 70, color: 0xcfe8ff, speed: 8, size: 0.09, life: 1.0, dir: new THREE.Vector3(-1, 0.2, 0) });
        combat.effects.chunks(this._tmp, { count: 6, speed: 6, size: 0.22, dir: new THREE.Vector3(-1, 0.3, 0) });
        combat.shake(1.2);
      }
      if (!hit && car.position.distanceTo(hitAt) < 2.4) {
        hit = true;
        this._launchBilling(f, car.rotation.y, lateral);
        playCarCrash();
        playTireScreech(1.2);
        combat.shake(1.7);
      }
      if (hit && speed <= 0.02) break;
    }
  }

  _launchBilling(f, heading, lateral) {
    const boxer = f.combat.boxer;
    boxer.active = false; // (a rag doll now, not a fighter)
    boxer.glows.forEach((g) => (g.visible = false));
    boxer.mark.visible = false;
    f.combat.refreshTargets();
    const mesh = boxer.mesh;
    mesh.rotation.order = 'YXZ';
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    f.flight = {
      mesh,
      rig: boxer.rig,
      vel: new THREE.Vector3(fx * 6, 5.2, fz * 6 + lateral * 3.8),
      t: 0,
      landed: false,
      posed: false,
    };
  }

  _updateFlight(dt) {
    const fl = this._finale.flight;
    const m = fl.mesh;
    fl.t += dt;
    if (!fl.landed) {
      fl.vel.y -= 16 * dt;
      m.position.addScaledVector(fl.vel, dt);
      m.rotation.x -= 2.5 * dt; // tipping over backward through the air
      if (m.position.y <= 0.14 && fl.t > 0.2) {
        fl.landed = true;
        m.position.y = 0.14;
        m.rotation.x = -Math.PI / 2; // flat on his back
        playBodyThud();
        this._finale.combat.shake(0.6);
      }
    } else if (fl.vel.lengthSq() > 0.01) {
      fl.vel.y = 0;
      fl.vel.multiplyScalar(Math.exp(-dt * 4)); // skidding across the floor
      m.position.addScaledVector(fl.vel, dt);
    }
    if (!fl.posed) this._poseBilling(fl.rig, 'limp');
    if (fl.landed && fl.t > 1.5) fl.posed = true;
  }

  /** Billing's body: 'limp' (out cold), 'carried' (hanging between two ELDARs), 'cuffed'. */
  _poseBilling(r, kind) {
    const lie = kind === 'limp';
    r.body.rotation.set(0, 0, 0);
    r.body.position.y = 0;
    r.shoulderL.rotation.set(kind === 'cuffed' ? 0.45 : -0.3, 0, kind === 'cuffed' ? -0.25 : lie ? 1.3 : 1.25);
    r.shoulderR.rotation.set(kind === 'cuffed' ? 0.45 : -0.3, 0, kind === 'cuffed' ? 0.25 : lie ? -1.3 : -1.25);
    r.elbowL.rotation.x = r.elbowR.rotation.x = kind === 'cuffed' ? -0.4 : -0.2;
    r.hipL.rotation.x = r.hipR.rotation.x = kind === 'carried' ? 0.25 : 0.05;
    r.kneeL.rotation.x = r.kneeR.rotation.x = kind === 'carried' ? 0.5 : 0.1;
    r.neck.rotation.set(kind === 'carried' ? 0.55 : 0, lie ? 0.4 : 0, 0);
  }

  onServerRoomUpdate(finale) {
    const f = this._finale;
    if (!f || f.saidPlug) return;
    if (finale.player.object.position.z > finale.gym.serverRoom.minZ + 0.4) {
      f.saidPlug = true;
      finale.dialogue.say('Other Ben', 'That rack at the end, the one with the port! Plug it in!', { hold: 1.5 });
    }
  }

  /** The drive goes in, the upload crawls, you call the police; every ELDAR goes docile. */
  async _playUpload(f) {
    const { gym, player, dialogue, wait } = f;
    this._lockView(f);
    const port = gym.serverRoom.port;
    const monitor = new THREE.Vector3(11.6, 1.35, gym.serverRoom.maxZ - 1.05);
    const view = new THREE.Vector3(port.x + 0.6, 1.62, port.z - 1.5);
    player.setLookTarget(port.clone().setY(1.2));
    await this.moveCamera([view], [Math.max(0.35, this.camera.position.distanceTo(view) / 3)]);
    gym.drive.visible = true;
    playUsbInsert();
    f.upload = { pct: 0, shown: -1 };
    await dialogue.say('', 'You jam the drive into the port. The monitor floods with green text.', { style: 'narration', hold: 1.1 });
    player.setLookTarget(monitor);
    playPhoneDial();
    await dialogue.say('', 'While it uploads, you dial 911 with shaking hands.', { style: 'narration', hold: 1.3 });
    await wait(1.4);
    await dialogue.say('Dispatcher (phone)', '911, what is your emergency?', { hold: 1.0 });
    await dialogue.say('', 'You tell her everything. The coach. The robots. The tree. The giant robot suit.', { style: 'narration', hold: 1.6 });
    await dialogue.say('Dispatcher (phone)', '...A robot suit. Okay. Units are on their way to Hall High School. Stay where you are.', { hold: 1.8 });
    await dialogue.say('Other Ben', 'Tell them to bring the big handcuffs.', { hold: 1.0 });
    await this._until(() => f.upload.pct >= 100, 30);
    f.upload = null;
    gym.drawMonitor(100, ['> UPLOAD COMPLETE', '> ELDAR swarm: PROTOCOL // DOCILE', '> attack mode: DISABLED', '> have a nice night :)']);
    playBeep(1320, 0.14, 0.12);
    await dialogue.say('Other Ben', 'It worked! Every ELDAR on the network just went DOCILE!', { hold: 1.4 });
    await wait(0.5);
  }

  _updateUpload(dt) {
    const f = this._finale;
    const u = f.upload;
    u.pct = Math.min(100, u.pct + dt * 7.2);
    const shown = Math.floor(u.pct / 2);
    if (shown === u.shown) return;
    u.shown = shown;
    const lines = ['> USB device: ELDAR_OVERRIDE.EXE', '> target: HALL HIGH SCHOOL WI-FI', `> patching units: ${Math.floor(u.pct * 4.3)} / 430`];
    if (u.pct > 55) lines.push('> overriding ATTACK MODE...');
    f.gym.drawMonitor(u.pct, lines);
    if (shown % 5 === 0) playBeep(880 + shown * 4, 0.04, 0.05);
  }

  /** The ELDARs (blue now) carry Billing out to the police, who cuff him. */
  async _playArrest(f) {
    const { gym, player, dialogue, wait } = f;
    const billing = f.flight.mesh;
    const rig = f.flight.rig;
    const ben = gym.ben;
    await this.fader.to(1, 0.6);
    f.flight = null; // (from here on the actors system moves him)
    // Three docile ELDARs walk in from the locker room; the police are pulling up outside.
    const kb = billing.position;
    const side = kb.z >= 0 ? 1 : -1;
    const bots = gym.docile.map((d, i) => {
      const root = d.built.root;
      root.visible = true;
      root.position.set(kb.x - 5.5 - i * 0.6, 0, kb.z + (i - 1) * 1.1);
      d.built.glow.color.setHex(0x3ab8ff); // docile blue
      return { built: d.built, anim: d.anim, target: null, face: null, speed: 1.6, yaw: Math.PI / 2 };
    });
    f.gym.police.forEach((p, i) => {
      p.group.visible = true;
      p.group.position.set(gym.glassDoors.x + 30, 0, i ? 5.5 : -5.5);
      p.setLights(true);
    });
    f.actors = { bots, billing, carry: false, policeT: 0 };
    f.police = true;
    startPoliceSiren(0.045);
    ben.stop();
    ben.mesh.visible = true;
    ben.mesh.position.set(kb.x + 3.2, 0, kb.z - side * 2.4);
    ben.faceTowards(kb.clone());
    this._hideScrap(f);
    this.camera.position.copy(this._clearView(f, kb, 4.6, 1.7));
    player.setLookTarget(() => this._tmp.copy(kb).setY(0.8));
    await this.fader.to(0, 0.6);
    await dialogue.say('', 'Every ELDAR in the school stops dead. Their visors flicker... and turn blue.', { style: 'narration', hold: 1.4 });
    bots[0].target = new THREE.Vector3(kb.x, 0, kb.z - 0.8);
    bots[1].target = new THREE.Vector3(kb.x, 0, kb.z + 0.8);
    bots[2].target = new THREE.Vector3(kb.x + 1.6, 0, kb.z);
    bots.forEach((b) => (b.face = kb.clone()));
    playServo(0.8);
    await this._until(() => bots.every((b) => b.built.root.position.distanceTo(b.target) < 0.1), 7);
    await dialogue.say('Other Ben (whispering)', "Dude. They're... helping?", { style: 'whisper', hold: 0.9 });
    // They lift him up between them.
    bots[0].anim.reach = bots[1].anim.reach = 1;
    bots[0].anim.crouch = bots[1].anim.crouch = 0.5;
    await wait(0.6);
    this._poseBilling(rig, 'carried');
    billing.rotation.set(0.25, Math.PI / 2, 0);
    f.actors.carry = true;
    bots[0].anim.crouch = bots[1].anim.crouch = 0;
    await wait(0.8);
    // Out through the smashed doors.
    const dx = gym.glassDoors.x;
    await this.fader.to(1, 0.4);
    const carryZ = (i) => (i === 0 ? -0.8 : i === 1 ? 0.8 : 0);
    bots.forEach((b, i) => {
      b.built.root.position.set(dx - 3.2 + (i === 2 ? 1.6 : 0), 0, carryZ(i));
      b.yaw = Math.PI / 2;
      b.face = null;
      b.target = new THREE.Vector3(dx + 4.5 + (i === 2 ? 1.6 : 0), 0, carryZ(i));
    });
    ben.stop();
    ben.mesh.position.set(dx - 1.2, 0, -2.2);
    ben.faceTowards(new THREE.Vector3(dx + 5, 0, 0));
    const [o1, o2] = gym.officers;
    o1.mesh.visible = o2.mesh.visible = true;
    o1.mesh.position.set(dx + 7.2, 0, -1.6);
    o2.mesh.position.set(dx + 7.6, 0, 1.4);
    o1.faceTowards(new THREE.Vector3(dx, 0, 0));
    o2.faceTowards(new THREE.Vector3(dx, 0, 0));
    this.camera.position.set(dx - 1.6, 1.7, 1.7);
    player.setLookTarget(() => this._tmp.copy(billing.position).setY(1.4));
    await this.fader.to(0, 0.4);
    await this._until(() => bots[0].built.root.position.distanceTo(bots[0].target) < 0.1, 6);
    // The hand-off: on his feet, into the cuffs.
    f.actors.carry = false;
    billing.rotation.set(0, Math.PI / 2, 0);
    billing.position.y = 0;
    this._poseBilling(rig, 'limp');
    rig.neck.rotation.set(0, 0, 0);
    rig.shoulderL.rotation.set(0, 0, 0.15);
    rig.shoulderR.rotation.set(0, 0, -0.15);
    bots[0].target.set(dx + 3.6, 0, -2.4);
    bots[1].target.set(dx + 3.6, 0, 2.4);
    bots[2].target.set(dx + 7.8, 0, 3.8);
    bots.forEach((b) => {
      b.anim.reach = 0;
      b.face = billing.position.clone();
    });
    await o1.moveTo(billing.position.x + 0.9, billing.position.z - 0.7, 1.6);
    o1.faceTowards(billing.position.clone());
    await dialogue.say('Coach Billing', "Wh-what...? Put me DOWN! I'm your COACH! I BUILT you!", { hold: 1.4 });
    this._poseBilling(rig, 'cuffed');
    playHandcuffs();
    await dialogue.say('Officer', 'Coach Billing? You are under arrest.', { hold: 1.2 });
    await dialogue.say('Coach Billing', 'On what CHARGES?!', { hold: 0.8 });
    o2.faceTowards(this._tmp2.set(dx - 4, 0, 0)); // (a long look at the gym)
    await dialogue.say('Officer', '...Where do we even start.', { hold: 1.2 });
    // Ben gets the last word.
    player.setLookTarget(() => ben.headPosition(this._tmp));
    ben.faceTowards(billing.position.clone());
    await dialogue.say('Other Ben', 'Hey, Coach!', { hold: 0.7 });
    player.setLookTarget(() => this._tmp.copy(billing.position).setY(1.7));
    await dialogue.say('Other Ben', "That's strike three.", { hold: 1.4 });
    await dialogue.say('Coach Billing', 'BEEEEN!!!', { hold: 1.0 });
    // Into the back of the car: the officer walks him out to the rear door (a step behind him, on
    // the side away from the car, so neither ever walks through the other), stops him clear of
    // the arc the door swings through, and shoves him in head first; the door slams and locks.
    // (Car-local: +X out of the door side, +Z toward the car's nose.)
    const pcar = gym.police[0];
    pcar.group.updateMatrixWorld(true);
    const local = (x, z) => pcar.group.localToWorld(new THREE.Vector3(x, 0, z));
    const stand = local(2.4, -0.95); // where he's stopped: outside the open door's reach
    const seat = local(0.35, -0.55);
    const shoveSpot = local(3.05, -0.45); // the officer, behind him (and off the camera's line to him)
    const doorSpot = local(1.75, -0.6); // the officer, a hand on the shut door
    const doorFace = local(0.4, -0.6);
    const view = local(5.2, -2.6);
    const outward = local(1, 0).sub(local(0, 0)); // (the car's +X, in the world)
    this.camera.position.set(view.x, 1.6, view.z);
    player.setLookTarget(() => this._tmp.copy(billing.position).setY(1.2));
    // Under the cut, the officer takes his arm: a step behind, a little to the outside.
    const walkDir = new THREE.Vector3().subVectors(stand, billing.position).setY(0).normalize();
    const escort = new THREE.Vector3();
    const escortPoint = () => escort.copy(billing.position).setY(0).addScaledVector(walkDir, -0.3).addScaledVector(outward, 0.4);
    o1.stop();
    o1.mesh.position.copy(escortPoint()).addScaledVector(walkDir, -0.75);
    o1.mesh.rotation.y = Math.atan2(walkDir.x, walkDir.z);
    o1.faceTowards(null);
    o1.follow(escortPoint, 2.2);
    f.actors.walkBilling = { to: stand, speed: 1.3 };
    await this._until(() => billing.position.distanceTo(stand) < 0.1, 8);
    f.actors.walkBilling = null;
    // The door opens (he's clear of it) and the officer steps round behind him.
    o1.moveTo(shoveSpot.x, shoveSpot.z, 1.2);
    f.actors.door = { v: 0, target: 1 };
    playCarDoor();
    billing.rotation.y = Math.atan2(seat.x - stand.x, seat.z - stand.z);
    await wait(0.7);
    o1.faceTowards(billing.position.clone());
    dialogue.say('Coach Billing', 'Watch the head! WATCH THE HEAD!', { hold: 1.0 });
    o1.mesh.userData.rig.reach = true; // (the shove)
    f.actors.shove = { t: 0, dur: 1.05, from: stand.clone(), to: seat.clone(), rig };
    await wait(1.15);
    o1.mesh.userData.rig.reach = false;
    f.actors.door.target = 0;
    await wait(0.35);
    playCarDoor();
    this._finale.combat.shake(0.2);
    // Locked: he steps up to the door, a hand on it, a double chirp, the lights blink.
    o1.faceTowards(null);
    await Promise.race([o1.moveTo(doorSpot.x, doorSpot.z, 1.4), wait(2)]);
    o1.faceTowards(doorFace);
    await wait(0.25);
    o1.mesh.userData.rig.reach = true;
    await wait(0.25);
    playBeep(1500, 0.05, 0.08);
    pcar.setLights(false);
    await wait(0.12);
    playBeep(1500, 0.05, 0.08);
    pcar.setLights(true);
    await wait(0.25);
    o1.mesh.userData.rig.reach = false;
    await dialogue.say('Officer', "He's secure.", { hold: 0.8 });
    await wait(0.6);
  }

  /** The Mecha's scattered scrap goes (it would block the car and the camera). */
  _hideScrap(f) {
    const mecha = f.combat.mecha;
    const scrap = mecha.scrap;
    if (scrap) for (const s of scrap) s.mesh.visible = false;
    // (Its cockpit light, dark since it blew, moves out onto the scene first: hidden along with the
    // wreck it would drop out of the light count, and every lit shader in the gym would rebuild.)
    const cockpit = mecha.cockpitLight;
    if (cockpit && cockpit.parent !== f.gym.scene) {
      cockpit.intensity = 0;
      f.gym.scene.attach(cockpit);
    }
    // The wreck itself goes too (it filled the screen in the ending shots), along with its collider.
    mecha.root.visible = false;
    f.wreckGone = true;
    const i = f.gym.colliders.indexOf(f.gym.wreckCollider);
    if (i !== -1) {
      f.gym.colliders.splice(i, 1);
      f.finale._refreshColliders();
    }
  }

  /** What's solid on the gym floor for staging: the equipment and bleachers (boxes), and the wreck. */
  _obstacles(f) {
    if (!f.obstacles) {
      const boxOf = (m) => {
        m.updateWorldMatrix(true, false);
        return new THREE.Box3().setFromObject(m);
      };
      f.obstacles = { boxes: [...f.gym.cover, ...f.gym.bleacherBoxes].map(boxOf), wreck: f.combat.mecha.root.position.clone() };
    }
    return f.obstacles;
  }

  _clearAt(f, x, z, pad) {
    const o = this._obstacles(f);
    if (Math.abs(x) > 17.2 - pad || Math.abs(z) > 14.2 - pad) return false;
    if (!f.wreckGone && Math.hypot(x - o.wreck.x, z - o.wreck.z) < 2.4 + pad) return false;
    for (const b of o.boxes) if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) return false;
    return true;
  }

  _clearPath(f, pts, pad) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const n = Math.ceil(a.distanceTo(b) / 0.4);
      for (let k = 0; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const z = a.z + ((b.z - a.z) * k) / n;
        if (x < 17.2 && !this._clearAt(f, x, z, pad)) return false; // (outside the doors is open lot)
      }
    }
    return true;
  }

  /** Somewhere to stand Billing so the car's run at him, its skid, his landing spot and your view are all clear. */
  _pickCrashLane(f) {
    const doorX = f.gym.glassDoors.x;
    for (const bx of [5.5, 3.5, 7.5, 1.5]) {
      for (const zB of [0, 1.5, -1.5, 3, -3, 4.5, -4.5, 5.5, -5.5]) {
        const B = new THREE.Vector3(bx, 0, zB);
        const lateral = zB > 0 ? -1 : 1;
        const path = [new THREE.Vector3(doorX + 1.6, 0, 0), new THREE.Vector3(doorX - 4, 0, zB * 0.5), B, new THREE.Vector3(bx - 3.6, 0, zB)];
        if (!this._clearPath(f, path, 1.3)) continue;
        if (!this._clearAt(f, bx - 3.9, zB + lateral * 2.5, 0.7)) continue; // where he lands
        if (!this._clearAt(f, bx - 5.4, zB - lateral * 2.6, 0.7)) continue; // your camera
        return { B, lateral };
      }
    }
    return { B: new THREE.Vector3(5.5, 0, 0), lateral: 1 };
  }

  /** A camera spot dist from 	arget with nothing between (tries a ring of angles). */
  _clearView(f, target, dist, height) {
    for (let i = 0; i < 16; i++) {
      const a = 0.6 + (i * Math.PI * 2) / 16;
      const x = target.x + Math.cos(a) * dist;
      const z = target.z + Math.sin(a) * dist;
      if (!this._clearAt(f, x, z, 0.6)) continue;
      if (!this._clearPath(f, [new THREE.Vector3(x, 0, z), new THREE.Vector3(target.x + (x - target.x) * 0.25, 0, target.z + (z - target.z) * 0.25)], 0.3)) continue;
      return new THREE.Vector3(x, height, z);
    }
    return new THREE.Vector3(target.x + dist, height, target.z);
  }
  _updateActors(dt) {
    const a = this._finale.actors;
    for (const bot of a.bots) {
      const r = bot.built.root;
      let speed = 0;
      if (bot.target) {
        const dx = bot.target.x - r.position.x;
        const dz = bot.target.z - r.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.05) {
          const step = Math.min(d, bot.speed * dt);
          r.position.x += (dx / d) * step;
          r.position.z += (dz / d) * step;
          speed = bot.speed;
          if (!a.carry) bot.yaw = dampAngle(bot.yaw, Math.atan2(dx, dz), Math.min(1, dt * 8));
        } else if (bot.face) {
          bot.yaw = dampAngle(bot.yaw, Math.atan2(bot.face.x - r.position.x, bot.face.z - r.position.z), Math.min(1, dt * 6));
        }
      }
      bot.anim.speed = speed;
      animateEldar(bot.built.rig, dt, bot.anim);
      r.rotation.y = bot.yaw;
    }
    if (a.carry) {
      const L = a.bots[0].built.root.position;
      const R = a.bots[1].built.root.position;
      a.billing.position.set((L.x + R.x) / 2, 0.24, (L.z + R.z) / 2);
    }
    if (a.walkBilling) {
      const w = a.walkBilling;
      const p = a.billing.position;
      const dx = w.to.x - p.x;
      const dz = w.to.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const step = Math.min(d, w.speed * dt);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
        a.billing.rotation.y = Math.atan2(dx, dz);
      }
    }
    if (a.door) {
      const d = a.door;
      d.v += Math.sign(d.target - d.v) * Math.min(Math.abs(d.target - d.v), dt * (d.target > d.v ? 2.5 : 5));
      this._finale.gym.police[0].setDoor(d.v);
    }
    if (a.shove) {
      // Bent double and pushed into the back seat, then sat down in there.
      const s = a.shove;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const e = k * k * (3 - 2 * k);
      a.billing.position.lerpVectors(s.from, s.to, e);
      a.billing.position.y = -0.22 * e;
      s.rig.body.rotation.x = 0.8 * Math.sin(Math.min(1, k * 1.4) * Math.PI * 0.5) * (1 - Math.max(0, k - 0.75) * 4);
      s.rig.neck.rotation.x = 0.5 * (1 - k);
      if (k >= 1 && !s.seated) {
        s.seated = true;
        s.rig.body.rotation.x = 0;
        setSeatedPose(a.billing);
        a.billing.rotation.y = this._finale.gym.police[0].group.rotation.y; // facing front, in the back seat
      }
    }
    // The police cars pulling up, lights going.
    a.policeT += dt;
    const k = Math.min(1, a.policeT / 3.2);
    const e = 1 - (1 - k) * (1 - k);
    const g = this._finale.gym;
    g.police.forEach((p, i) => p.group.position.set(g.glassDoors.x + 30 - 19 * e + i * 1.2, 0, i ? 5.5 : -5.5));
  }

  /** The credits: Coach Billing in a cell, dancing to an upbeat tune (and complaining about it). */
  async _playCredits(f) {
    const { ui, player } = f;
    await this.fader.to(1, 1.2);
    stopPoliceSiren();
    setRainExposure(0);
    f.police = false;
    f.actors = null;
    const jail = buildJailCell();
    ui.setScene(jail.scene);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    const eye = new THREE.Vector3(0.95, 1.55, 4.8);
    this.camera.position.copy(eye);
    const look = new THREE.Vector3(1.2, 1.15, 0);
    player.setLookTarget(null);
    player.setLook(Math.atan2(-(look.x - eye.x), -(look.z - eye.z)), Math.atan2(look.y - eye.y, Math.hypot(look.x - eye.x, look.z - eye.z)));
    document.getElementById('hud').classList.add('hidden');
    const el = createCreditsDom();
    document.body.appendChild(el);
    f.ui.onGameComplete(el); // you beat it: Hard Mode unlocks now, and the menu button works from here on
    const roll = el.querySelector('.credits-inner');
    // He starts off sulking on his bunk (the music hasn't started yet).
    jail.billing.position.set(-1.62, 0, -0.55);
    jail.billing.rotation.y = Math.PI / 2 - 0.35;
    jail.disco.forEach((l) => (l.intensity = 0));
    f.jail = {
      ...jail,
      t: 0,
      stage: 'grumpy', // grumpy -> listen -> heck -> dance
      move: 0,
      moveT: 0,
      music: false,
      bubble: el.querySelector('.credits-bubble'),
      roll,
      rollY: window.innerHeight * 0.9,
      speed: 46,
    };
    roll.style.transform = `translateY(${f.jail.rollY}px)`;
    await this.fader.to(0, 1.6);
    await this._until(() => f.jail.rollY < -roll.offsetHeight + window.innerHeight * 0.2, 180);
    el.querySelector('.credits-end').classList.add('show');
    return el;
  }

  /**
   * The jail cell: Billing sulks on his bunk, arms folded... the music starts...
   * he tries to ignore it, a foot starts tapping... "Aw, what the heck!" and he's
   * up and dancing for the rest of the credits.
   */
  _updateJail(dt) {
    const j = this._finale.jail;
    j.t += dt;
    const rig = j.billing.userData.rig;
    const bubble = (text) => {
      if (text) {
        j.bubble.textContent = text;
        j.bubble.classList.add('show');
      } else {
        j.bubble.classList.remove('show');
      }
    };
    if (!j.music && j.t > 2.0) {
      j.music = true;
      startCreditsMusic();
    }
    if (j.stage === 'grumpy') {
      this._poseSitting(rig, dt, j.t, false);
      if (j.t > 0.8 && j.t < 1.9) bubble('Hmph.');
      else bubble(null);
      if (j.t > 2.6) j.stage = 'listen';
    } else if (j.stage === 'listen') {
      this._poseSitting(rig, dt, j.t, true);
      if (j.t > 3.6 && j.t < 4.6) bubble('...');
      else bubble(null);
      if (j.t > 6.0) {
        j.stage = 'heck';
        j.heckT = 0;
        rig.seated = false;
        j.from = j.billing.position.clone();
      }
    } else if (j.stage === 'heck') {
      j.heckT += dt;
      const k = Math.min(1, j.heckT / 1.4);
      j.billing.position.lerpVectors(j.from, this._tmp2.set(0, 0, 0.2), k * k * (3 - 2 * k));
      j.billing.rotation.y += (0 - j.billing.rotation.y) * Math.min(1, dt * 4);
      poseDance(rig, j.t, 4, dt);
      bubble('Aw, what the heck!');
      if (j.heckT > 2.2) {
        j.stage = 'dance';
        j.moveT = 0;
        bubble(null);
      }
    } else {
      j.moveT += dt;
      if (j.moveT > 4.3) {
        j.move = (j.move + 1) % 4;
        j.moveT = 0;
      }
      poseDance(rig, j.t, j.move, dt);
      j.billing.rotation.y = Math.sin(j.t * 0.8) * 0.35;
      j.disco.forEach((l, i) => {
        l.intensity = Math.min(3.2, l.intensity + dt * 3);
        l.position.set(Math.cos(j.t * 1.3 + i * Math.PI) * 1.6, 2.4, 0.6 + Math.sin(j.t * 1.3 + i * Math.PI) * 1.1);
      });
    }
    // The speech bubble floats over his head.
    rig.neck.getWorldPosition(this._tmp);
    this._tmp.y += 0.75;
    this._tmp.project(this.camera);
    j.bubble.style.left = `${(this._tmp.x * 0.5 + 0.5) * window.innerWidth}px`;
    j.bubble.style.top = `${(-this._tmp.y * 0.5 + 0.5) * window.innerHeight}px`;
    j.rollY -= dt * j.speed;
    j.roll.style.transform = `translateY(${j.rollY}px)`;
  }

  /** Sitting on the bunk, arms folded (sulking), or with a foot tapping and his head bobbing despite himself. */
  _poseSitting(rig, dt, t, listening) {
    const k = Math.min(1, dt * 10);
    const set = (joint, axis, v) => {
      joint.rotation[axis] += (v - joint.rotation[axis]) * k;
    };
    const beat = Math.abs(Math.sin(t * (126 / 60) * Math.PI));
    set(rig.hipL, 'x', -Math.PI / 2);
    set(rig.hipR, 'x', -Math.PI / 2);
    set(rig.kneeL, 'x', Math.PI / 2);
    set(rig.kneeR, 'x', Math.PI / 2 - (listening ? 0.3 * beat : 0)); // the foot tap
    set(rig.shoulderR, 'x', -1.1);
    set(rig.shoulderL, 'x', -1.1);
    set(rig.shoulderR, 'z', 0.6); // folded across his chest
    set(rig.shoulderL, 'z', -0.6);
    set(rig.elbowR, 'x', -1.85);
    set(rig.elbowL, 'x', -1.85);
    set(rig.body, 'x', listening ? 0.05 : 0.18);
    set(rig.body, 'z', 0);
    set(rig.body, 'y', 0);
    set(rig.neck, 'x', listening ? 0.1 * beat : 0.35); // head down... then bobbing
    set(rig.neck, 'y', listening ? Math.sin(t * 1.7) * 0.4 : 0.15);
    rig.body.position.y += (-0.36 - rig.body.position.y) * k;
  }
  /** Stop the credits music (main.js, leaving for the menu). */
  endCredits() {
    stopCreditsMusic();
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createHumanoid, Character, OTHER_BEN_LOOK, COACH_BILLING_LOOK, standUp } from './world.js';
import { CombatSystem, createRifleMesh, createStructuralPillar, PILLAR_SIZE } from './combat.js';
import { Achievements } from './achievements.js';
import {
  setUnderground,
  setDownloadCharge,
  playLadderStep,
  playBeep,
  playUsbInsert,
  playDownloadStart,
  playMechanism,
  startAlarm,
  stopAlarm,
  playHatchSlam,
  playPillarFall,
  playPodOpen,
  playDoorSlide,
  playReloadStep,
} from './audio.js';

/*
 * Chapter 2 — Below the Oak.
 *
 * 1:30 AM, the same night. Ben and Other Ben come back to the oak, open the
 * hatch Coach Billing disappeared into, and climb down an industrial ladder
 * into an ELDAR biolab. The lab is its own THREE.Scene (Chapter 1's world is
 * no longer rendered or updated once you're underground). Like Chapter 1,
 * -Z is "forward":
 *
 *   Z=  3.5 .. 0.9 ..... ladder shaft (12m tall; the hatch up to the tree is at the top)
 *   Z=  0.9 .. -36 ..... cryo corridor: 12 ELDAR pods along the walls
 *   Z= -36 ............. bulkhead door
 *   Z= -36 .. -62 ...... central chamber: display pillars by the entrance, cover, side
 *                        doors, the Titan's ceiling hatch; console/armory/water at the back
 */

const HALL = { half: 3.2, height: 4.2, nearZ: 0.9, farZ: -36 };
const SHAFT = { half: 1.3, nearZ: 0.9, backZ: 3.5, height: 12 };
// The central chamber (terminal at the back): big enough to flank a Titan.
const ROOM = { half: 12, nearZ: -36, backZ: -62, height: 8 };
const BULKHEAD = { half: 1.6, height: 3.0 };
const SIDE_DOOR = { z: -46, half: 1.1, height: 3.2 }; // maintenance doors in both side walls
const BOSS_HATCH = { x: 0, z: -46.5, half: 2.3 }; // square hatch in the chamber ceiling
// Two ELDAR display pillars flank the entrance inside the chamber; the left one comes down.
const PILLAR = { x: 3.6, z: -38.8, radius: 0.65, height: 5.5 };
// The structural column bolted to the left wall: the Titan tears it off and carries it as a shield.
const WALL_PILLAR = { x: -ROOM.half + 0.25, z: -50.6 };
// Where the Titan stands (facing the wall) so the pillar in its hands lines up with the one on the wall.
const RIP_STAND = new THREE.Vector3(WALL_PILLAR.x + 1.3, 0, WALL_PILLAR.z);
const RIP_CAM = new THREE.Vector3(-8.6, 2.5, -58.4); // south of it: a clear side-on view (the column at x -7.5 blocks the north)
const POD_ZS = [-4, -9, -14, -19, -24, -29];
const POD_X = 2.3;
const RIB_ZS = [-1.5, -6.5, -11.5, -16.5, -21.5, -26.5, -31.5];
const LIGHT_ZS = [-1.5, -11.5, -21.5, -31.5];
const CYAN = 0x00e5ff;

const LADDER_Z = SHAFT.backZ - 0.18; // rungs, 18cm off the shaft's back wall
const CLIMB = { z: 2.72, startY: 10.8, endY: 1.7, step: 0.35, stepTime: 0.3 };
const DESK = { z: ROOM.backZ + 1.1, front: ROOM.backZ + 1.6, width: 3.6 };
const PORT = new THREE.Vector3(0.55, 0.84, DESK.front); // thumb-drive port on the desk's front panel
const BEN_TYPING_SPOT = new THREE.Vector3(0, 0, DESK.front + 0.55);
const TERMINAL_VANTAGE = new THREE.Vector3(1.45, 1.72, DESK.front + 2.7);
const SCREEN_CENTER = new THREE.Vector3(0, 1.62, DESK.z - 0.22);
const TERMINAL_TRIGGER_Z = DESK.front + 10; // walking this far into the chamber starts the scene
const ARMORY_Z = ROOM.backZ + 7.2;
const WATER_Z = ROOM.backZ + 7.5;
const DEFEND_SPOT = new THREE.Vector3(2.4, 0, DESK.front + 4.2); // where retries put you back
const BEN_COVER_SPOT = new THREE.Vector3(-5.0, 0, DESK.front + 4.0); // Ben fights from behind a crate

const MENU_OPTIONS = [
  '[View Unit Roster]',
  '[Run Unit Diagnostics]',
  '[Download Attack Mode: Target -> Coach Billing]',
];

// ---------------------------------------------------------------------------
// Procedural canvas textures
// ---------------------------------------------------------------------------

function makeCanvas(width, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasTexture(canvas, repeat = false) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}

/**
 * A canvas texture that gets redrawn while you watch (the console's screens):
 * no mipmaps, so every re-upload is just the one copy (rebuilding a full mip
 * chain for a 1024px screen several times a second was a big part of the
 * frame drops looking at the console).
 */
function liveTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

/**
 * Flag `owner.seen` whenever `mesh` is actually drawn (the screens only redraw while someone can see
 * them), and note how close the camera is (`owner.near`: the nearest of its displays this frame).
 */
function watchVisibility(mesh, owner) {
  mesh.onBeforeRender = (renderer, scene, camera) => {
    owner.seen = true;
    const e = mesh.matrixWorld.elements;
    const d = Math.hypot(camera.position.x - e[12], camera.position.y - e[13], camera.position.z - e[14]);
    if (!(owner.near <= d)) owner.near = d;
  };
}

/**
 * The fewest seconds between redraws of a live screen `near` meters from the camera. Up close it's
 * the screen's own rate; from down the corridor it's a few pixels across, and redrawing (and
 * re-uploading) it ten times a second only made the frame rate stutter.
 */
function screenGap(near) {
  return near < 14 ? 0 : near < 30 ? 0.5 : 2;
}

function grime(g, size, count, alpha = 0.05) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.5})`;
    g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
}

/** Riveted steel wall panels (one tile = 2.1m square), with a vented kick panel. */
function createPanelTexture() {
  const c = makeCanvas(512);
  const g = c.getContext('2d');
  g.fillStyle = '#20282e';
  g.fillRect(0, 0, 512, 512);
  [[8, 8, 240, 300, false], [264, 8, 240, 300, false], [8, 324, 496, 180, true]].forEach(([x, y, w, h, kick]) => {
    const grad = g.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, kick ? '#262e35' : '#3a4650');
    grad.addColorStop(1, kick ? '#1b2227' : '#2b343c');
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.lineWidth = 3;
    g.strokeRect(x, y, w, h);
    g.strokeStyle = 'rgba(150,200,220,0.13)';
    g.lineWidth = 1;
    g.strokeRect(x + 3, y + 3, w - 6, h - 6);
    g.fillStyle = 'rgba(190,210,220,0.35)';
    [[x + 11, y + 11], [x + w - 11, y + 11], [x + 11, y + h - 11], [x + w - 11, y + h - 11]].forEach(([rx, ry]) => {
      g.beginPath();
      g.arc(rx, ry, 3, 0, Math.PI * 2);
      g.fill();
    });
  });
  g.fillStyle = 'rgba(0,0,0,0.6)';
  for (let i = 0; i < 12; i++) g.fillRect(40 + i * 37, 378, 22, 72);
  grime(g, 512, 1600);
  return canvasTexture(c, true);
}

/** Steel floor grating (one tile = 1.6m). */
function createGrateTexture() {
  const c = makeCanvas(512);
  const g = c.getContext('2d');
  g.fillStyle = '#1f262c';
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = '#0e1215';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 506);
  for (let y = 26; y < 492; y += 22) {
    for (let x = 22; x < 490; x += 58) {
      g.fillStyle = '#07090b';
      g.fillRect(x, y, 44, 10);
      g.fillStyle = 'rgba(150,200,220,0.1)';
      g.fillRect(x, y + 10, 44, 2);
    }
  }
  grime(g, 512, 2200, 0.06);
  return canvasTexture(c, true);
}

function createHazardTexture() {
  const c = makeCanvas(256, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#d8a818';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#131313';
  for (let x = -64; x < 320; x += 48) {
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 24, 64);
    g.lineTo(x + 88, 0);
    g.lineTo(x + 64, 0);
    g.closePath();
    g.fill();
  }
  grime(g, 256, 500, 0.12);
  return canvasTexture(c, true);
}

/** Draw a glowing sign into a region of a canvas: lines = [{ text, size, y, color }], centered. */
function drawSignInto(g, ox, oy, width, height, lines, { bg = '#03141b', border = '#00e5ff' } = {}) {
  g.save();
  g.translate(ox, oy);
  g.beginPath();
  g.rect(0, 0, width, height);
  g.clip();
  g.fillStyle = bg;
  g.fillRect(0, 0, width, height);
  if (border) {
    g.strokeStyle = border;
    g.globalAlpha = 0.7;
    g.lineWidth = Math.max(2, height * 0.04);
    g.strokeRect(g.lineWidth, g.lineWidth, width - g.lineWidth * 2, height - g.lineWidth * 2);
    g.globalAlpha = 1;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const line of lines) {
    g.font = `bold ${line.size}px "Courier New", Courier, monospace`;
    g.fillStyle = line.color || '#00e5ff';
    g.shadowColor = line.color || '#00e5ff';
    g.shadowBlur = line.glow ?? 10;
    g.fillText(line.text, width / 2, line.y);
  }
  g.restore();
}

/** Glowing sign / label: lines = [{ text, size, y, color }], drawn centered. */
function createSignTexture(width, height, lines, options) {
  const c = makeCanvas(width, height);
  drawSignInto(c.getContext('2d'), 0, 0, width, height, lines, options);
  return canvasTexture(c);
}

/** Soft tileable wisps for the mist hugging the floor. */
function createMistTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  for (let i = 0; i < 38; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 22 + Math.random() * 52;
    for (const ox of [-256, 0, 256]) {
      for (const oy of [-256, 0, 256]) {
        const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grad.addColorStop(0, 'rgba(255,255,255,0.2)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  return canvasTexture(c, true);
}

/** The hatch at the top of the shaft, glowing red from the tree's doorway above. */
function createHatchGlowTexture() {
  const c = makeCanvas(128);
  const g = c.getContext('2d');
  g.fillStyle = '#0a0202';
  g.fillRect(0, 0, 128, 128);
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,90,50,1)');
  grad.addColorStop(0.6, 'rgba(150,25,12,0.8)');
  grad.addColorStop(1, 'rgba(40,5,3,0.6)');
  g.fillStyle = grad;
  g.fillRect(8, 8, 112, 112);
  g.strokeStyle = '#1a1a1a';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 120, 120);
  return canvasTexture(c);
}

/** Printed side of the cardboard case of water bottles. */
function createWaterBoxTexture() {
  const c = makeCanvas(256, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#b48c5c';
  g.fillRect(0, 0, 256, 128);
  grime(g, 256, 700, 0.08);
  g.fillStyle = '#1d5fa8';
  g.fillRect(0, 34, 256, 50);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.font = 'bold 30px Arial, sans-serif';
  g.fillText('SPRING WATER', 128, 60);
  g.fillStyle = '#3b2a18';
  g.font = 'bold 16px Arial, sans-serif';
  g.fillText('24 x 500 mL', 128, 104);
  return canvasTexture(c);
}

/** Set a font no bigger than `size` that fits `text` inside `maxWidth` pixels. */
function fitFont(g, text, size, family, maxWidth, weight = '') {
  let s = size;
  do {
    g.font = `${weight} ${s}px ${family}`.trim();
    s -= 1;
  } while (s > 8 && g.measureText(text).width > maxWidth);
}

/** Taped-up note over the water rack, in Coach's handwriting. */
function createCoachNoteTexture() {
  const W = 320;
  const H = 200;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#efeadb';
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(230,220,160,0.7)';
  g.fillRect(W / 2 - 30, 0, 60, 18); // tape
  const hand = '"Segoe Print", "Comic Sans MS", "Marker Felt", cursive';
  // Fonts vary a lot between systems, so every line is measured to fit
  // (the fixed-size headline used to run off both edges).
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#b3261e';
  fitFont(g, 'STAY HYDRATED!', 34, hand, W - 36, 'bold');
  g.fillText('STAY HYDRATED!', W / 2, 78);
  g.fillStyle = '#1d3f8f';
  fitFont(g, 'rain or shine', 24, hand, W - 60);
  g.fillText('rain or shine', W / 2, 124);
  g.fillStyle = '#333333';
  g.textAlign = 'right';
  fitFont(g, '- Coach B.', 22, hand, W / 2);
  g.fillText('- Coach B.', W - 24, 168);
  return canvasTexture(c);
}

/** Steel supply crate: riveted frame, cross braces, a stenciled label. */
function createCrateTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.fillStyle = '#3a434a';
  g.fillRect(0, 0, 256, 256);
  grime(g, 256, 900, 0.08);
  g.strokeStyle = 'rgba(20,26,30,0.55)';
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(16, 16);
  g.lineTo(240, 240);
  g.moveTo(240, 16);
  g.lineTo(16, 240);
  g.stroke();
  g.strokeStyle = '#1c2227';
  g.lineWidth = 14;
  g.strokeRect(7, 7, 242, 242);
  g.strokeStyle = 'rgba(160,190,205,0.25)';
  g.lineWidth = 2;
  g.strokeRect(16, 16, 224, 224);
  g.fillStyle = 'rgba(224,195,74,0.85)';
  g.textAlign = 'center';
  g.font = 'bold 30px "Courier New", Courier, monospace';
  g.fillText('ELDAR', 128, 118);
  g.font = 'bold 18px "Courier New", Courier, monospace';
  g.fillText('PARTS // B2', 128, 148);
  return canvasTexture(c);
}

/** Frosted, shattered glass (the fallen pillar: solid-looking, so its cover reads as cover). */
function createCrackedGlassTexture() {
  const c = makeCanvas(256);
  const g = c.getContext('2d');
  g.fillStyle = '#5d7784';
  g.fillRect(0, 0, 256, 256);
  grime(g, 256, 1200, 0.08);
  g.strokeStyle = 'rgba(220,245,255,0.75)';
  g.lineWidth = 1.5;
  for (let k = 0; k < 4; k++) {
    const cx = Math.random() * 256;
    const cy = Math.random() * 256;
    for (let i = 0; i < 9; i++) {
      let x = cx;
      let y = cy;
      let a = Math.random() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let j = 0; j < 5; j++) {
        a += (Math.random() - 0.5) * 0.8;
        x += Math.cos(a) * (10 + Math.random() * 22);
        y += Math.sin(a) * (10 + Math.random() * 22);
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  return canvasTexture(c, true);
}

/** Where the structural pillar was: bare, scorched wall studs and torn cables. */
function createTornWallTexture() {
  const c = makeCanvas(256, 512);
  const g = c.getContext('2d');
  g.fillStyle = '#0c0f11';
  g.fillRect(0, 0, 256, 512);
  // Scorch fading out toward the edges.
  const scorch = g.createRadialGradient(128, 256, 20, 128, 256, 260);
  scorch.addColorStop(0, 'rgba(60,30,12,0.8)');
  scorch.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = scorch;
  g.fillRect(0, 0, 256, 512);
  // Studs and a sheared bracket.
  g.fillStyle = '#2a3036';
  [60, 196].forEach((x) => g.fillRect(x - 10, 0, 20, 512));
  for (let y = 40; y < 512; y += 110) g.fillRect(40, y, 176, 12);
  // Bolt holes where the pillar tore away.
  g.fillStyle = '#000000';
  for (let y = 30; y < 512; y += 58) {
    [100, 156].forEach((x) => {
      g.beginPath();
      g.arc(x + (Math.random() - 0.5) * 4, y, 5, 0, Math.PI * 2);
      g.fill();
    });
  }
  // Torn cables hanging loose.
  ['#b3261e', '#e0c34a', '#1d5fa8', '#3a9a4a'].forEach((color, i) => {
    g.strokeStyle = color;
    g.lineWidth = 5;
    g.beginPath();
    let x = 80 + i * 30;
    g.moveTo(x, 0);
    for (let y = 0; y < 300 + i * 40; y += 30) {
      x += (Math.random() - 0.5) * 16;
      g.lineTo(x, y);
    }
    g.stroke();
  });
  grime(g, 256, 900, 0.1);
  return canvasTexture(c);
}

function removeFrom(list, item) {
  const i = list.indexOf(item);
  if (i !== -1) list.splice(i, 1);
}

function createLabMaterials() {
  return {
    crate: new THREE.MeshStandardMaterial({ map: createCrateTexture(), metalness: 0.45, roughness: 0.6 }),
    wall: new THREE.MeshStandardMaterial({ map: createPanelTexture(), color: 0xb9c9d4, metalness: 0.5, roughness: 0.5 }),
    floor: new THREE.MeshStandardMaterial({ map: createGrateTexture(), color: 0xb0c0cc, metalness: 0.55, roughness: 0.55 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0x141a1f, metalness: 0.4, roughness: 0.75 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x66737e, metalness: 0.7, roughness: 0.35 }),
    metalDark: new THREE.MeshStandardMaterial({ color: 0x252c32, metalness: 0.6, roughness: 0.45 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x3c4751, metalness: 0.75, roughness: 0.4 }),
    podShell: new THREE.MeshStandardMaterial({ color: 0x3a4550, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }),
    // Self-lit a little so the stripes stay caution-yellow under the cyan light (they read green otherwise).
    hazard: (() => {
      const tex = createHazardTexture();
      return new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.28, roughness: 0.7, metalness: 0.2 });
    })(),
    // A touch of self-light keeps it safety-yellow under the cyan light (it read green).
    ladder: new THREE.MeshStandardMaterial({ color: 0xc9a227, emissive: 0x3d2f06, metalness: 0.45, roughness: 0.5 }),
    cyan: new THREE.MeshBasicMaterial({ color: CYAN }),
    cyanDim: new THREE.MeshBasicMaterial({ color: 0x0b8aa3 }),
    red: new THREE.MeshBasicMaterial({ color: 0xff3a2a }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x191b1d, roughness: 0.75, metalness: 0.1 }),
    gunMetal: new THREE.MeshStandardMaterial({ color: 0x2d3135, roughness: 0.38, metalness: 0.8 }),
    cardboard: new THREE.MeshStandardMaterial({ color: 0xb48c5c, roughness: 0.95 }),
    bottle: new THREE.MeshStandardMaterial({ color: 0xa6dcf2, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.72 }),
    bottleCap: new THREE.MeshStandardMaterial({ color: 0x1e5fbf, roughness: 0.5 }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Glowing cryo fluid: fresnel-thick edges, bubbles streaming up, a slow caustic
// shimmer. Works on an InstancedMesh (one draw call for every pod) and in fog.
const LIQUID_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec2 vUv;
  varying float vHeight;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vHeight = position.y;
    vec4 local = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 world = modelMatrix * local;
    vWorldPos = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * n);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const LIQUID_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uAlert;
  varying vec2 vUv;
  varying float vHeight;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fres = 1.0 - abs(dot(normalize(vNormalW), viewDir));
    vec2 g = vec2(vUv.x * 30.0, vUv.y * 11.0 - uTime * 0.6);
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash(id + floor(vWorldPos.xz * 3.0));
    f.x += sin(uTime * 2.3 + h * 40.0) * 0.16;
    float bubble = step(0.87, h) * smoothstep(0.22, 0.12, length(f * vec2(1.0, 1.5)));
    float wave = 0.5 + 0.5 * sin(vHeight * 5.0 + uTime * 1.3 + sin(vUv.x * 18.85 + uTime * 0.7) * 1.3);
    float glow = (mix(0.42, 1.0, fres) + wave * 0.18 + bubble * 0.9) * mix(1.3, 0.72, vUv.y);
    vec3 color = mix(uColor, vec3(1.0, 0.2, 0.14), uAlert * 0.4) * glow;
    float alpha = clamp(0.34 + fres * 0.42 + bubble * 0.4, 0.0, 0.92);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function createLiquidMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x1bb8ff) }, uAlert: { value: 0 } },
    ]),
    vertexShader: LIQUID_VERTEX,
    fragmentShader: LIQUID_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
}

// Faint additive cone of light under each ceiling fixture (light hanging in the haze).
const SHAFT_VERTEX = /* glsl */ `
  uniform float uHeight;
  varying float vAlong;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  void main() {
    vAlong = 0.5 - position.y / uHeight; // 0 at the fixture, 1 at the floor
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SHAFT_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  varying float vAlong;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float facing = pow(abs(dot(normalize(vNormalW), viewDir)), 1.4);
    float along = clamp(vAlong, 0.0, 1.0);
    float fade = pow(1.0 - along, 1.3) * smoothstep(0.0, 0.08, along);
    float drift = 0.85 + 0.15 * sin(uTime * 0.7 + vWorldPos.y * 2.0 + vWorldPos.z * 0.5);
    gl_FragColor = vec4(uColor, uIntensity * facing * fade * drift);
  }
`;

const LIGHT_SHAFT_HEIGHT = 4.0;

function createLightShaftMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(CYAN) },
      uIntensity: { value: 0.07 },
      uTime: { value: 0 },
      uHeight: { value: LIGHT_SHAFT_HEIGHT },
    },
    vertexShader: SHAFT_VERTEX,
    fragmentShader: SHAFT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers + composite props (placeholder meshes, ready for .glb swaps)
// ---------------------------------------------------------------------------

/** Scale a BoxGeometry's UVs so a repeating texture tiles every `tile` meters on each face. */
function worldUV(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * faces[f][0]) / tile, (uv.getY(k) * faces[f][1]) / tile);
    }
  }
  return geo;
}

function planeUV(geo, w, d, tile) {
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, (uv.getX(k) * w) / tile, (uv.getY(k) * d) / tile);
  return geo;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/** Transform a part (rotate, then translate) and add it to a merge list. */
function put(list, geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  geo.applyMatrix4(_m4.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _one));
  list.push(geo);
  return geo;
}

/**
 * ELDAR prototype: a sleek humanoid robot, feet at y=0, facing +Z, head bowed
 * (dormant). Merged per material so all 12 pods draw with 3 InstancedMeshes.
 */
function buildEldarGeometries() {
  const plates = []; // light armor plating
  const joints = []; // dark servos / frame
  const glow = []; // visor + chest core
  for (const s of [-1, 1]) {
    const x = s * 0.12;
    put(plates, new THREE.BoxGeometry(0.13, 0.07, 0.27), x, 0.035, 0.04); // foot
    put(plates, new THREE.CylinderGeometry(0.07, 0.055, 0.42, 10), x, 0.3, 0); // shin
    put(plates, new THREE.BoxGeometry(0.1, 0.24, 0.05), x, 0.33, 0.06); // shin guard
    put(joints, new THREE.SphereGeometry(0.07, 10, 8), x, 0.53, 0); // knee
    put(plates, new THREE.CylinderGeometry(0.085, 0.07, 0.4, 10), x, 0.74, 0); // thigh
  }
  put(joints, new THREE.BoxGeometry(0.36, 0.13, 0.2), 0, 0.96, 0); // pelvis
  put(joints, new THREE.CylinderGeometry(0.12, 0.14, 0.22, 12), 0, 1.1, 0); // abdomen
  put(plates, new THREE.BoxGeometry(0.42, 0.34, 0.24), 0, 1.37, 0); // chest
  put(plates, new THREE.BoxGeometry(0.3, 0.12, 0.05), 0, 1.47, 0.12, -0.2); // collar plate
  put(glow, new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), 0, 1.36, 0.125, Math.PI / 2); // chest core
  for (const s of [-1, 1]) {
    const x = s * 0.3;
    put(joints, new THREE.SphereGeometry(0.085, 10, 8), s * 0.28, 1.49, 0); // shoulder
    put(plates, new THREE.BoxGeometry(0.14, 0.12, 0.16), x, 1.53, 0); // pauldron
    put(plates, new THREE.CylinderGeometry(0.055, 0.05, 0.3, 10), x, 1.3, 0); // upper arm
    put(joints, new THREE.SphereGeometry(0.05, 8, 6), x, 1.14, 0); // elbow
    put(plates, new THREE.CylinderGeometry(0.05, 0.042, 0.27, 10), x, 0.99, 0.01); // forearm
    put(joints, new THREE.BoxGeometry(0.06, 0.12, 0.09), x, 0.8, 0.015); // hand
  }
  put(joints, new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10), 0, 1.6, 0); // neck
  // Head, bowed forward around the neck joint.
  const bow = new THREE.Matrix4()
    .makeTranslation(0, 1.62, 0)
    .multiply(new THREE.Matrix4().makeRotationX(0.28))
    .multiply(new THREE.Matrix4().makeTranslation(0, -1.62, 0));
  const head = new THREE.CapsuleGeometry(0.1, 0.1, 4, 12).translate(0, 1.77, 0).applyMatrix4(bow);
  const face = new THREE.BoxGeometry(0.17, 0.12, 0.05).translate(0, 1.75, 0.085).applyMatrix4(bow);
  const visor = new THREE.BoxGeometry(0.15, 0.03, 0.02).translate(0, 1.77, 0.113).applyMatrix4(bow);
  plates.push(head);
  joints.push(face);
  glow.push(visor);
  return { plates: mergeGeometries(plates), joints: mergeGeometries(joints), glow: mergeGeometries(glow) };
}

/** Safety-yellow industrial ladder bolted to the shaft's back wall. */
function buildLadderGeometry() {
  const parts = [];
  const railH = SHAFT.height - 0.2;
  for (const s of [-1, 1]) put(parts, new THREE.BoxGeometry(0.05, railH, 0.06), s * 0.25, railH / 2, LADDER_Z);
  for (let y = 0.3; y < SHAFT.height - 0.3; y += 0.3) {
    put(parts, new THREE.CylinderGeometry(0.017, 0.017, 0.5, 8), 0, y, LADDER_Z, 0, 0, Math.PI / 2);
  }
  for (let y = 1; y < SHAFT.height; y += 2.2) {
    for (const s of [-1, 1]) put(parts, new THREE.BoxGeometry(0.04, 0.05, 0.2), s * 0.25, y, LADDER_Z + 0.12);
  }
  return mergeGeometries(parts);
}

/**
 * A flashlight in a character's right hand. The SpotLight lives in the scene
 * (not under the mesh) and is re-aimed every frame: hiding a light's parent
 * drops it from the scene's light list, which forces every shader to recompile.
 */
class HandFlashlight {
  constructor(scene, character) {
    this.character = character;
    const prop = new THREE.Group();
    prop.add(
      new THREE.Mesh(
        new THREE.CylinderGeometry(0.032, 0.042, 0.22, 8),
        new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.4, metalness: 0.5 }),
      ),
    );
    this.lens = new THREE.Mesh(new THREE.CircleGeometry(0.04, 12), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    this.lens.position.y = -0.111;
    this.lens.rotation.x = Math.PI / 2;
    prop.add(this.lens);
    prop.position.y = -0.06;
    prop.visible = false;
    character.mesh.userData.rig.handR.add(prop);
    this.prop = prop;

    this.light = new THREE.SpotLight(0xe4ecff, 0, 20, Math.PI / 8, 0.5, 1.3);
    this.target = new THREE.Object3D();
    this.light.target = this.target;
    scene.add(this.light, this.target);
    this.on = false;
    this.aim = null; // optional Vector3 to point at; otherwise straight ahead, angled down
    this._pos = new THREE.Vector3();
  }

  setOn(on) {
    this.on = on;
    this.prop.visible = on;
    this.lens.material.color.set(on ? 0xfff4dc : 0x333333);
    this.character.mesh.userData.rig.holdingFlashlight = on;
    if (!on) this.light.intensity = 0;
  }

  update() {
    const mesh = this.character.mesh;
    if (!this.on || !mesh.visible) {
      this.light.intensity = 0;
      return;
    }
    this.light.intensity = 7;
    this.prop.getWorldPosition(this._pos);
    this.light.position.copy(this._pos);
    if (this.aim) {
      this.target.position.copy(this.aim);
    } else {
      const yaw = mesh.rotation.y;
      this.target.position.set(this._pos.x + Math.sin(yaw) * 6, 0.3, this._pos.z + Math.cos(yaw) * 6);
    }
    this.target.updateMatrixWorld();
  }
}

// ---------------------------------------------------------------------------
// Live screens (canvas textures redrawn a few times a second)
// ---------------------------------------------------------------------------

const MONO = '"Courier New", Courier, monospace';
const LOG_WORDS = ['WRITE BLOCK', 'VERIFY', 'PATCH MOTOR CTRL', 'SYNC TARGET PROFILE', 'FLASH FIRMWARE', 'MAP FACE ID'];
const hex = (n) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');

/** The master console's main screen, driven step by step by the terminal scene. */
class TerminalScreen {
  constructor() {
    this.canvas = makeCanvas(1024, 640);
    this.g = this.canvas.getContext('2d');
    this.texture = liveTexture(this.canvas);
    this.state = 'locked'; // locked | reading | menu | confirm | download | complete
    this.menuIndex = 0;
    this.progress = 0; // 0..100
    this.time = 0;
    this._redraw = 0;
    this._logTimer = 0;
    this._log = [];
    this.seen = true; // (set by the display mesh when it's drawn: see watchVisibility)
    this.near = 0; // (how close the camera was to it: ditto)
    this._key = '';
    this._dirty = false;
    // The parts of every frame that never change, drawn once: the background with its
    // vignette, and the scanlines (160 thin rects) over the top.
    this._bg = makeCanvas(1024, 640);
    {
      const b = this._bg.getContext('2d');
      b.fillStyle = '#021118';
      b.fillRect(0, 0, 1024, 640);
      const vignette = b.createRadialGradient(512, 320, 80, 512, 320, 640);
      vignette.addColorStop(0, 'rgba(0,229,255,0.08)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
      b.fillStyle = vignette;
      b.fillRect(0, 0, 1024, 640);
    }
    this._scan = makeCanvas(1024, 640);
    {
      const s = this._scan.getContext('2d');
      s.fillStyle = 'rgba(0,0,0,0.22)';
      for (let y = 0; y < 640; y += 4) s.fillRect(0, y, 1024, 2);
    }
    this.draw();
  }

  setState(state) {
    this.state = state;
    this.draw();
  }

  setMenuIndex(index) {
    this.menuIndex = index;
    this.draw();
  }

  update(dt) {
    this.time += dt;
    if (this.state === 'download') {
      this._logTimer += dt;
      if (this._logTimer > 0.18) {
        this._logTimer = 0;
        this._log.push(`> 0x${hex(4)}  ${LOG_WORDS[Math.floor(Math.random() * LOG_WORDS.length)]}  ${hex(8)}`);
        if (this._log.length > 4) this._log.shift();
      }
    }
    this._redraw += dt;
    // Only while it's on screen (a redraw nobody sees still costs the canvas work and
    // the texture upload), and only when something on it has changed: the animated
    // states tick over ten times a second, the others when the cursor blinks or the
    // minute rolls over.
    const near = this.near;
    this.near = Infinity;
    if (!this.seen) {
      this._dirty = true;
      return;
    }
    this.seen = false;
    if (this._redraw < screenGap(near)) return; // (far off: now and then is plenty)
    const animated = this.state === 'reading' || this.state === 'download';
    if (animated) {
      if (this._redraw < 0.1 && !this._dirty) return;
    } else {
      const key = `${this.state}|${this.menuIndex}|${Math.floor(this.time * 2.2) % 2}|${Math.floor(this.time / 60)}`;
      if (key === this._key && !this._dirty) return;
      this._key = key;
    }
    this._redraw = 0;
    this._dirty = false;
    this.draw();
  }

  draw() {
    const g = this.g;
    const W = 1024;
    const H = 640;
    const cyan = '#00e5ff';
    const red = '#ff4a3a';
    const blink = Math.floor(this.time * 2.2) % 2 === 0;
    g.drawImage(this._bg, 0, 0);

    // (No canvas shadowBlur: blurring every glyph on each redraw was the costly part.
    // The big lines get a cheap halo instead: a wide, faint stroke under the fill.)
    const glow = (text, x, y) => {
      g.save();
      g.globalAlpha = 0.22;
      g.lineWidth = 7;
      g.lineJoin = 'round';
      g.strokeStyle = g.fillStyle;
      g.strokeText(text, x, y);
      g.restore();
      g.fillText(text, x, y);
    };
    g.textBaseline = 'middle';
    g.shadowColor = cyan;
    g.shadowBlur = 0;
    g.fillStyle = cyan;
    g.font = `bold 30px ${MONO}`;
    g.textAlign = 'left';
    g.fillText('ELDAR // UNIT CONTROL TERMINAL', 40, 44);
    g.textAlign = 'right';
    g.fillText(`01:${String(41 + Math.floor(this.time / 60)).padStart(2, '0')} AM`, W - 40, 44);
    g.fillRect(40, 72, W - 80, 3);
    g.textAlign = 'center';

    switch (this.state) {
      case 'locked':
        g.font = `bold 66px ${MONO}`;
        g.fillStyle = red;
        g.shadowColor = red;
        glow('SYSTEM LOCKED', W / 2, 235);
        g.shadowColor = cyan;
        g.fillStyle = cyan;
        g.font = `bold 34px ${MONO}`;
        if (blink) g.fillText('INSERT AUTHORIZATION MEDIA', W / 2, 330);
        g.font = `26px ${MONO}`;
        g.fillStyle = 'rgba(0,229,255,0.55)';
        g.fillText('UNITS 01-12  //  CRYOSTASIS  //  DORMANT', W / 2, 530);
        break;
      case 'reading': {
        g.font = `bold 40px ${MONO}`;
        g.fillText('MEDIA DETECTED: E:\\', W / 2, 230);
        g.font = `32px ${MONO}`;
        g.fillText(`READING${'.'.repeat(1 + (Math.floor(this.time * 4) % 3))}`, W / 2, 300);
        g.strokeStyle = cyan;
        g.lineWidth = 3;
        g.strokeRect(262, 370, 500, 26);
        const x = 266 + ((this.time * 380) % 440);
        g.fillRect(x, 374, 52, 18);
        break;
      }
      case 'menu':
      case 'confirm':
        g.textAlign = 'left';
        g.font = `bold 34px ${MONO}`;
        g.fillText('E:\\  PAYLOAD MENU', 70, 140);
        g.font = `bold 30px ${MONO}`;
        MENU_OPTIONS.forEach((label, i) => {
          const y = 240 + i * 82;
          const selected = i === this.menuIndex;
          const inverted = selected && (this.state === 'menu' || blink);
          if (inverted) {
            g.fillStyle = cyan;
            g.fillRect(56, y - 30, W - 112, 60);
            g.fillStyle = '#021118';
          } else {
            g.fillStyle = selected ? cyan : 'rgba(0,229,255,0.7)';
            if (selected) {
              g.strokeStyle = cyan;
              g.lineWidth = 2;
              g.strokeRect(56, y - 30, W - 112, 60);
            }
          }
          g.fillText(label, 76, y);
        });
        g.fillStyle = cyan;
        g.font = `28px ${MONO}`;
        g.fillText(this.state === 'confirm' ? '> EXECUTING...' : `> SELECT OPTION${blink ? '_' : ''}`, 70, 560);
        break;
      case 'download': {
        const p = Math.min(100, this.progress);
        g.font = `bold 44px ${MONO}`;
        glow('DOWNLOADING: ATTACK MODE', W / 2, 150);
        g.font = `bold 36px ${MONO}`;
        g.fillStyle = red;
        g.shadowColor = red;
        g.fillText('TARGET -> COACH BILLING', W / 2, 210);
        g.shadowColor = cyan;
        g.fillStyle = cyan;
        g.strokeStyle = cyan;
        g.lineWidth = 3;
        g.strokeRect(80, 262, W - 160, 64);
        const fillW = ((W - 168) * p) / 100;
        if (fillW > 0) {
          g.save();
          g.beginPath();
          g.rect(84, 266, fillW, 56);
          g.clip();
          g.fillStyle = cyan;
          g.fillRect(84, 266, fillW, 56);
          g.fillStyle = 'rgba(2,17,24,0.35)';
          const offset = (this.time * 60) % 40;
          for (let x = 84 - 40 + offset; x < 84 + fillW + 40; x += 40) {
            g.beginPath();
            g.moveTo(x, 322);
            g.lineTo(x + 18, 322);
            g.lineTo(x + 38, 266);
            g.lineTo(x + 20, 266);
            g.closePath();
            g.fill();
          }
          g.restore();
        }
        g.fillStyle = cyan;
        g.font = `bold 76px ${MONO}`;
        glow(`${Math.floor(p)}%`, W / 2, 400);
        g.font = `24px ${MONO}`;
        if (this.lockdown) {
          g.fillStyle = blink ? red : 'rgba(255,74,58,0.45)';
          g.fillText('!! LOCKDOWN  //  UNITS DEPLOYED  //  DEFEND THE TERMINAL !!', W / 2, 452);
        } else {
          g.fillStyle = 'rgba(0,229,255,0.75)';
          g.fillText(`UNITS UPDATED: ${String(Math.floor((p / 100) * 12)).padStart(2, '0')}/12`, W / 2, 452);
        }
        g.textAlign = 'left';
        g.font = `22px ${MONO}`;
        g.fillStyle = 'rgba(0,229,255,0.45)';
        this._log.forEach((line, i) => g.fillText(line, 80, 500 + i * 30));
        break;
      }
      case 'complete':
        g.font = `bold 54px ${MONO}`;
        glow('DOWNLOAD COMPLETE', W / 2, 200);
        g.fillStyle = red;
        g.shadowColor = red;
        g.font = `bold 44px ${MONO}`;
        glow('ATTACK MODE: ARMED', W / 2, 285);
        g.font = `bold 32px ${MONO}`;
        g.fillText('TARGET -> COACH BILLING', W / 2, 345);
        g.shadowColor = cyan;
        g.fillStyle = cyan;
        g.font = `28px ${MONO}`;
        g.fillText('UNITS UPDATED: 12/12', W / 2, 420);
        if (blink) g.fillText('AWAITING ACTIVATION_', W / 2, 520);
        break;
      default:
        break;
    }

    g.drawImage(this._scan, 0, 0, W, H); // the scanlines, pre-drawn
    this.texture.needsUpdate = true;
  }
}

/** Left monitor: the 12 pods' status. Right monitor: a scrolling core-signal trace. */
class StatusScreens {
  constructor() {
    this.pods = { canvas: makeCanvas(512, 320) };
    this.signal = { canvas: makeCanvas(512, 320) };
    this.pods.texture = liveTexture(this.pods.canvas);
    this.signal.texture = liveTexture(this.signal.canvas);
    this.progress = 0;
    this.time = 0;
    this._redraw = 0;
    this.seen = true; // (either monitor drawn this frame: see watchVisibility)
    this.near = 0;
    this.draw();
  }

  update(dt) {
    this.time += dt;
    this._redraw += dt;
    if (this._redraw >= Math.max(0.125, screenGap(this.near)) && this.seen) {
      this._redraw = 0;
      this.draw();
    }
    this.seen = false;
    this.near = Infinity;
  }

  draw() {
    const cyan = '#00e5ff';
    const red = '#ff4a3a';
    // Pod grid
    let g = this.pods.canvas.getContext('2d');
    g.fillStyle = '#021118';
    g.fillRect(0, 0, 512, 320);
    g.fillStyle = cyan;
    g.font = `bold 22px ${MONO}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText('CRYO STATUS', 20, 22);
    const updated = Math.floor((this.progress / 100) * 12);
    for (let i = 0; i < 12; i++) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 16 + col * 164;
      const y = 48 + row * 66;
      const armed = i < updated;
      g.strokeStyle = armed ? red : 'rgba(0,229,255,0.6)';
      g.lineWidth = 2;
      g.strokeRect(x, y, 152, 56);
      g.fillStyle = armed ? red : cyan;
      g.font = `bold 18px ${MONO}`;
      g.fillText(`ELDAR-${String(i + 1).padStart(2, '0')}`, x + 8, y + 16);
      g.font = `14px ${MONO}`;
      g.fillText(armed ? 'ATTACK MODE' : 'DORMANT', x + 8, y + 38);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3 + i);
      g.fillRect(x + 118, y + 44 - pulse * 30, 22, pulse * 30 + 4);
    }
    this.pods.texture.needsUpdate = true;

    // Core signal trace
    g = this.signal.canvas.getContext('2d');
    g.fillStyle = '#021118';
    g.fillRect(0, 0, 512, 320);
    g.strokeStyle = 'rgba(0,229,255,0.15)';
    g.lineWidth = 1;
    for (let x = 0; x < 512; x += 32) {
      g.beginPath();
      g.moveTo(x, 40);
      g.lineTo(x, 300);
      g.stroke();
    }
    g.fillStyle = cyan;
    g.font = `bold 22px ${MONO}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('CORE SIGNAL', 20, 22);
    const hot = this.progress > 0;
    g.strokeStyle = hot ? red : cyan;
    g.lineWidth = 3;
    g.beginPath();
    for (let x = 0; x <= 512; x += 4) {
      const t = this.time * 2.2 + x * 0.03;
      const amp = hot ? 30 + this.progress * 0.7 : 26;
      const y = 170 + Math.sin(t) * amp * 0.6 + Math.sin(t * 3.7) * amp * 0.25 + (Math.random() - 0.5) * (hot ? 10 : 3);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = hot ? red : cyan;
    g.font = `18px ${MONO}`;
    g.fillText(hot ? 'LOAD: RISING' : 'LOAD: IDLE', 20, 296);
    this.signal.texture.needsUpdate = true;
  }
}

/** Big display on the terminal room's back wall. */
function drawWallDisplay(canvas, alert) {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const color = alert ? '#ff4a3a' : '#00e5ff';
  g.fillStyle = '#020c11';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.strokeRect(10, 10, W - 20, H - 20);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 24;
  g.fillStyle = color;
  g.font = `bold 120px ${MONO}`;
  g.fillText('ELDAR', W / 2, 118);
  g.shadowBlur = 8;
  g.font = `bold 30px ${MONO}`;
  g.fillText(alert ? 'ATTACK MODE DOWNLOAD IN PROGRESS' : 'PROTOTYPE UNIT PROGRAM  //  SUBLEVEL B2', W / 2, 218);
  g.font = `22px ${MONO}`;
  g.fillStyle = alert ? 'rgba(255,74,58,0.7)' : 'rgba(0,229,255,0.6)';
  g.fillText(alert ? 'TARGET -> COACH BILLING' : 'AUTHORIZED PERSONNEL ONLY', W / 2, 262);
  g.shadowBlur = 0;
}

/** Blinking server-rack LEDs (one shared texture, redrawn ~6 times a second). */
class RackLeds {
  constructor() {
    this.canvas = makeCanvas(128, 256);
    this.texture = liveTexture(this.canvas);
    this._timer = 0;
    this.seen = true; // (either rack drawn this frame: see watchVisibility)
    this.near = 0;
    this.draw();
  }

  update(dt) {
    this._timer += dt;
    if (this._timer > Math.max(0.16, screenGap(this.near)) && this.seen) {
      this._timer = 0;
      this.draw();
    }
    this.seen = false;
    this.near = Infinity;
  }

  draw() {
    const g = this.canvas.getContext('2d');
    g.fillStyle = '#0d1114';
    g.fillRect(0, 0, 128, 256);
    for (let row = 0; row < 16; row++) {
      const y = 8 + row * 15;
      g.fillStyle = '#161c21';
      g.fillRect(6, y, 116, 12);
      for (let i = 0; i < 6; i++) {
        const on = Math.random() < 0.55;
        g.fillStyle = on ? (i === 5 && Math.random() < 0.3 ? '#ffb13a' : '#00e5ff') : '#0a2a33';
        g.fillRect(12 + i * 9, y + 4, 5, 4);
      }
      g.fillStyle = '#2a3238';
      g.fillRect(80, y + 3, 36, 6);
    }
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// The lab: its own scene, colliders, interactables and updatables
// ---------------------------------------------------------------------------

export function buildLab() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010507);
  scene.fog = new THREE.FogExp2(0x03121a, 0.03);
  const mats = createLabMaterials();
  const colliders = [];
  const interactables = [];
  const updatables = [];

  // Static geometry is baked into world space and merged per material when the
  // lab is done (flushBatch): a dozen draw calls for the shell, the ribs, the
  // cover and the dressing instead of a couple hundred. Anything that moves,
  // swaps material or animates its UVs passes batch: false. Batched colliders
  // keep their own (unrendered) mesh so their boxes still work.
  const batchLists = new Map(); // material -> [world-space geometry]
  function toBatch(mesh) {
    mesh.updateMatrix();
    let list = batchLists.get(mesh.material);
    if (!list) batchLists.set(mesh.material, (list = []));
    list.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));
  }
  function flushBatch() {
    batchLists.forEach((list, material) => {
      const merged = new THREE.Mesh(mergeGeometries(list), material);
      merged.name = 'lab-static';
      merged.matrixAutoUpdate = false;
      scene.add(merged);
      list.forEach((g) => g.dispose());
    });
    batchLists.clear();
  }

  function addBox({ w, h, d, x, y, z, material, collider = true, tile = 0, rotationY = 0, name = 'lab-box', batch = true }) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (tile) worldUV(geo, w, h, d, tile);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    mesh.name = name;
    if (material.visible === false) {
      // Invisible blocker: a collider only, never drawn.
    } else if (batch) toBatch(mesh);
    else scene.add(mesh);
    if (collider) colliders.push(mesh);
    return mesh;
  }

  function addPlane({ w, d, x, y, z, material, tile = 0, down = false, name = 'lab-plane', batch = true }) {
    const geo = new THREE.PlaneGeometry(w, d);
    if (tile) planeUV(geo, w, d, tile);
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = down ? Math.PI / 2 : -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.name = name;
    if (batch) toBatch(mesh);
    else scene.add(mesh);
    return mesh;
  }

  /** Emissive sign on a wall. `facing` is the direction it faces (radians, 0 = +Z). */
  function addSign(texture, w, h, x, y, z, facing) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture }));
    sign.position.set(x, y, z);
    sign.rotation.y = facing;
    scene.add(sign);
    return sign;
  }

  // ---- Light: cold ambient + cyan fixtures, a red spill down the shaft ----------
  // Every light has a hard distance cutoff and a physical-ish decay, none casts
  // shadows (the lab never renders a shadow pass), and the set never changes
  // mid-fight (a light added or removed would recompile every shader in view).
  scene.add(new THREE.AmbientLight(0x0e2430, 0.9));
  scene.add(new THREE.HemisphereLight(0x1d4a5c, 0x05080a, 0.5));
  const corridorLights = LIGHT_ZS.map((z) => {
    const light = new THREE.PointLight(CYAN, 14, 14, 1.6);
    light.position.set(0, HALL.height - 0.35, z);
    scene.add(light);
    return light;
  });
  // The chamber: three high cyan lights (the console end gets the whitest one).
  const chamberLights = [[-6.5, -44, CYAN, 26], [6.5, -44, CYAN, 26], [0, -55.5, 0x9ff4ff, 24]].map(([x, z, color, intensity]) => {
    const light = new THREE.PointLight(color, intensity, 22, 1.5);
    light.position.set(x, ROOM.height - 0.6, z);
    light.userData.base = intensity;
    scene.add(light);
    return light;
  });
  const shaftMidZ = (SHAFT.nearZ + SHAFT.backZ) / 2;
  const hatchLight = new THREE.PointLight(0xff3a1a, 5, 8, 1.6);
  hatchLight.position.set(0, SHAFT.height - 0.6, shaftMidZ);
  scene.add(hatchLight);

  // ---- Shell ------------------------------------------------------------------
  const T = 0.3; // wall thickness
  const hallLen = HALL.nearZ - HALL.farZ;
  const hallMidZ = (HALL.nearZ + HALL.farZ) / 2;
  const roomLen = ROOM.nearZ - ROOM.backZ;
  const roomMidZ = (ROOM.nearZ + ROOM.backZ) / 2;

  addPlane({ w: HALL.half * 2, d: hallLen, x: 0, y: 0, z: hallMidZ, material: mats.floor, tile: 1.6, name: 'lab-floor' });
  addPlane({ w: SHAFT.half * 2, d: SHAFT.backZ - SHAFT.nearZ, x: 0, y: 0, z: shaftMidZ, material: mats.floor, tile: 1.6 });
  addPlane({ w: ROOM.half * 2, d: roomLen, x: 0, y: 0, z: roomMidZ, material: mats.floor, tile: 1.6 });
  addPlane({ w: HALL.half * 2, d: hallLen, x: 0, y: HALL.height, z: hallMidZ, material: mats.ceiling, down: true });
  // Chamber ceiling in four pieces around the square hatch the Titan drops through.
  {
    const hz0 = BOSS_HATCH.z + BOSS_HATCH.half; // near edge of the hole
    const hz1 = BOSS_HATCH.z - BOSS_HATCH.half; // far edge
    const nearD = ROOM.nearZ - hz0;
    const farD = hz1 - ROOM.backZ;
    const sideW = ROOM.half - BOSS_HATCH.half;
    addPlane({ w: ROOM.half * 2, d: nearD, x: 0, y: ROOM.height, z: ROOM.nearZ - nearD / 2, material: mats.ceiling, down: true });
    addPlane({ w: ROOM.half * 2, d: farD, x: 0, y: ROOM.height, z: hz1 - farD / 2, material: mats.ceiling, down: true });
    [-1, 1].forEach((s) => {
      addPlane({ w: sideW, d: BOSS_HATCH.half * 2, x: s * (BOSS_HATCH.half + sideW / 2), y: ROOM.height, z: BOSS_HATCH.z, material: mats.ceiling, down: true });
    });
  }
  addPlane({ w: SHAFT.half * 2, d: SHAFT.backZ - SHAFT.nearZ, x: 0, y: SHAFT.height, z: shaftMidZ, material: mats.ceiling, down: true });

  // Corridor walls, and the near end wall on either side of the shaft opening.
  [-1, 1].forEach((s) => {
    addBox({ w: T, h: HALL.height, d: hallLen, x: s * (HALL.half + T / 2), y: HALL.height / 2, z: hallMidZ, material: mats.wall, tile: 2.1, name: 'lab-wall' });
    const segW = HALL.half - SHAFT.half;
    addBox({ w: segW, h: HALL.height, d: T, x: s * (SHAFT.half + segW / 2), y: HALL.height / 2, z: HALL.nearZ + T / 2, material: mats.wall, tile: 2.1 });
  });

  // Ladder shaft up to the tree: side walls, back wall (the ladder's), and its
  // front wall above the corridor ceiling. The hatch glows red at the top.
  [-1, 1].forEach((s) => {
    addBox({ w: 0.2, h: SHAFT.height, d: SHAFT.backZ - SHAFT.nearZ, x: s * (SHAFT.half + 0.1), y: SHAFT.height / 2, z: shaftMidZ, material: mats.wall, tile: 2.1 });
  });
  addBox({ w: SHAFT.half * 2 + 0.4, h: SHAFT.height, d: 0.2, x: 0, y: SHAFT.height / 2, z: SHAFT.backZ + 0.1, material: mats.wall, tile: 2.1 });
  addBox({ w: SHAFT.half * 2, h: SHAFT.height - HALL.height, d: 0.2, x: 0, y: (SHAFT.height + HALL.height) / 2, z: HALL.nearZ + 0.1, material: mats.wall, tile: 2.1, collider: false });
  const hatch = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), new THREE.MeshBasicMaterial({ map: createHatchGlowTexture(), fog: false }));
  hatch.rotation.x = Math.PI / 2;
  hatch.position.set(0, SHAFT.height - 0.01, LADDER_Z - 0.45);
  scene.add(hatch);
  const ladder = new THREE.Mesh(buildLadderGeometry(), mats.ladder);
  ladder.name = 'industrial-ladder';
  scene.add(ladder);
  // A caged amber work lamp partway down (emissive only).
  addBox({ w: 0.16, h: 0.22, d: 0.1, x: SHAFT.half - 0.08, y: 6.4, z: shaftMidZ - 0.4, material: new THREE.MeshBasicMaterial({ color: 0xffa040 }), collider: false });

  // ---- Central chamber shell: side walls (a maintenance door in each), back wall, bulkhead ----
  const doorLo = SIDE_DOOR.z - SIDE_DOOR.half;
  const doorHi = SIDE_DOOR.z + SIDE_DOOR.half;
  [-1, 1].forEach((s) => {
    const wx = s * (ROOM.half + T / 2);
    const nearLen = ROOM.nearZ - doorHi;
    const farLen = doorLo - ROOM.backZ;
    addBox({ w: T, h: ROOM.height, d: nearLen, x: wx, y: ROOM.height / 2, z: ROOM.nearZ - nearLen / 2, material: mats.wall, tile: 2.1 });
    addBox({ w: T, h: ROOM.height, d: farLen, x: wx, y: ROOM.height / 2, z: doorLo - farLen / 2, material: mats.wall, tile: 2.1 });
    addBox({ w: T, h: ROOM.height - SIDE_DOOR.height, d: SIDE_DOOR.half * 2, x: wx, y: (ROOM.height + SIDE_DOOR.height) / 2, z: SIDE_DOOR.z, material: mats.wall, tile: 2.1, collider: false });
    const segW = ROOM.half - BULKHEAD.half;
    addBox({ w: segW, h: ROOM.height, d: 0.4, x: s * (BULKHEAD.half + segW / 2), y: ROOM.height / 2, z: ROOM.nearZ, material: mats.wall, tile: 2.1 });
    // Hazard-striped bulkhead posts. They stand 3cm proud of the doorway and
    // run a little deeper than the wall, so none of their faces sit flush with
    // a wall face (the coplanar faces were z-fighting).
    addBox({ w: 0.36, h: BULKHEAD.height - 0.02, d: 0.62, x: s * (BULKHEAD.half + 0.15), y: (BULKHEAD.height - 0.02) / 2, z: ROOM.nearZ, material: mats.hazard, tile: 0.8, name: 'bulkhead-post' });
  });
  addBox({ w: ROOM.half * 2 + T * 2, h: ROOM.height, d: T, x: 0, y: ROOM.height / 2, z: ROOM.backZ - T / 2, material: mats.wall, tile: 2.1 });
  addBox({ w: BULKHEAD.half * 2, h: ROOM.height - BULKHEAD.height, d: 0.4, x: 0, y: (ROOM.height + BULKHEAD.height) / 2, z: ROOM.nearZ, material: mats.wall, tile: 2.1, collider: false });
  // Hazard header: its underside now sits 4cm below the wall header's (they used to share that face).
  addBox({ w: BULKHEAD.half * 2 + 0.66, h: 0.38, d: 0.64, x: 0, y: BULKHEAD.height + 0.15, z: ROOM.nearZ, material: mats.hazard, tile: 0.8, collider: false });
  addPlane({ w: BULKHEAD.half * 2, d: 0.5, x: 0, y: 0.004, z: ROOM.nearZ + 0.6, material: mats.hazard, tile: 0.5 });
  addPlane({ w: BULKHEAD.half * 2, d: 0.5, x: 0, y: 0.004, z: ROOM.nearZ - 0.6, material: mats.hazard, tile: 0.5 });
  addSign(
    createSignTexture(512, 128, [{ text: 'CENTRAL CHAMBER', size: 50, y: 52 }, { text: 'TERMINAL  //  SUBLEVEL B2', size: 24, y: 100, color: '#7fefff' }]),
    1.7, 0.42, 0, 3.72, ROOM.nearZ + 0.21, 0,
  );

  // Maintenance doors: two panels slide apart into the wall; a dark recess behind.
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x0b0f12, roughness: 0.9, side: THREE.BackSide });
  const doors = [-1, 1].map((s) => {
    const wallX = s * ROOM.half; // inner face
    const recess = new THREE.Mesh(new THREE.BoxGeometry(2.4, SIDE_DOOR.height + 0.2, SIDE_DOOR.half * 2 + 0.2), recessMat);
    recess.position.set(wallX + s * (T + 1.2), (SIDE_DOOR.height + 0.2) / 2, SIDE_DOOR.z);
    toBatch(recess);
    addBox({ w: 0.04, h: 0.05, d: SIDE_DOOR.half * 2 - 0.3, x: wallX + s * (T + 2.35), y: SIDE_DOOR.height - 0.3, z: SIDE_DOOR.z, material: mats.red, collider: false });
    [-1, 1].forEach((e) => {
      addBox({ w: 0.12, h: SIDE_DOOR.height, d: 0.2, x: wallX - s * 0.02, y: SIDE_DOOR.height / 2, z: SIDE_DOOR.z + e * (SIDE_DOOR.half + 0.09), material: mats.hazard, tile: 0.6, collider: false });
    });
    addBox({ w: 0.12, h: 0.2, d: SIDE_DOOR.half * 2 + 0.38, x: wallX - s * 0.02, y: SIDE_DOOR.height + 0.09, z: SIDE_DOOR.z, material: mats.hazard, tile: 0.6, collider: false });
    const panels = [-1, 1].map((e) => {
      const panel = addBox({ w: 0.1, h: SIDE_DOOR.height, d: SIDE_DOOR.half, x: wallX + s * 0.13, y: SIDE_DOOR.height / 2, z: SIDE_DOOR.z + (e * SIDE_DOOR.half) / 2, material: mats.metal, collider: false, batch: false });
      panel.userData.closedZ = panel.position.z;
      panel.userData.dir = e;
      return panel;
    });
    // You can't walk into the recess (the units coming out ignore this).
    const blocker = addBox({ w: 0.3, h: SIDE_DOOR.height, d: SIDE_DOOR.half * 2, x: wallX + s * 0.15, y: SIDE_DOOR.height / 2, z: SIDE_DOOR.z, material: mats.hidden });
    blocker.userData.noShot = true;
    return {
      panels,
      open: 0,
      holdT: 0,
      inside: new THREE.Vector3(wallX + s * 1.3, 0, SIDE_DOOR.z),
      out: new THREE.Vector3(wallX - s * 1.7, 0, SIDE_DOOR.z),
      yaw: s < 0 ? Math.PI / 2 : -Math.PI / 2,
      openFor(seconds) {
        if (this.holdT <= 0) playDoorSlide();
        this.holdT = Math.max(this.holdT, seconds);
      },
    };
  });

  // The Titan's hatch in the ceiling: a dark shaft above, two doors that slide apart.
  const bossShaft = new THREE.Mesh(
    new THREE.BoxGeometry(BOSS_HATCH.half * 2, 6, BOSS_HATCH.half * 2),
    new THREE.MeshStandardMaterial({ color: 0x06090b, roughness: 1, side: THREE.BackSide }),
  );
  bossShaft.position.set(BOSS_HATCH.x, ROOM.height + 3, BOSS_HATCH.z);
  scene.add(bossShaft);
  const hatchDoors = [-1, 1].map((s) => {
    // Underside at 7.92m: just below the ceiling, just above the hazard rim (no shared faces).
    const panel = addBox({ w: BOSS_HATCH.half, h: 0.14, d: BOSS_HATCH.half * 2, x: BOSS_HATCH.x + (s * BOSS_HATCH.half) / 2, y: ROOM.height - 0.01, z: BOSS_HATCH.z, material: mats.metalDark, collider: false, batch: false });
    panel.userData.closedX = panel.position.x;
    panel.userData.dir = s;
    return panel;
  });
  [-1, 1].forEach((s) => {
    addBox({ w: BOSS_HATCH.half * 2 + 0.56, h: 0.1, d: 0.25, x: BOSS_HATCH.x, y: ROOM.height - 0.14, z: BOSS_HATCH.z + s * (BOSS_HATCH.half + 0.14), material: mats.hazard, tile: 0.6, collider: false });
    addBox({ w: 0.25, h: 0.1, d: BOSS_HATCH.half * 2 + 0.03, x: BOSS_HATCH.x + s * (BOSS_HATCH.half + 0.14), y: ROOM.height - 0.14, z: BOSS_HATCH.z, material: mats.hazard, tile: 0.6, collider: false });
  });
  const bossHatch = { open: 0, target: 0 };

  // ---- Corridor dressing: ribs, pipes, guide strips, light fixtures + haze ----
  RIB_ZS.forEach((z) => {
    addBox({ w: HALL.half * 2, h: 0.28, d: 0.35, x: 0, y: HALL.height - 0.14, z, material: mats.metalDark, collider: false });
    [-1, 1].forEach((s) => addBox({ w: 0.25, h: HALL.height, d: 0.35, x: s * (HALL.half - 0.1), y: HALL.height / 2, z, material: mats.metalDark }));
  });
  [[-2.5, 3.8, 0.1], [-2.1, 3.9, 0.07], [2.45, 3.85, 0.12]].forEach(([x, y, r]) => {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hallLen, 12), mats.pipe);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(x, y, hallMidZ);
    toBatch(pipe);
  });
  addBox({ w: 0.7, h: 0.05, d: hallLen, x: 1.2, y: 3.98, z: hallMidZ, material: mats.metalDark, collider: false });
  [-1, 1].forEach((s) => {
    addBox({ w: 0.05, h: 0.03, d: hallLen - 0.4, x: s * (HALL.half - 0.05), y: 0.015, z: hallMidZ, material: mats.cyan, collider: false });
    addBox({ w: 0.05, h: 0.03, d: roomLen - 0.6, x: s * (ROOM.half - 0.05), y: 0.015, z: roomMidZ, material: mats.cyan, collider: false });
  });

  const shaftMat = createLightShaftMaterial();
  const lightShaftGeo = new THREE.CylinderGeometry(0.35, 1.7, LIGHT_SHAFT_HEIGHT, 24, 1, true);
  const fixtures = LIGHT_ZS.map((z) => {
    const fixture = addBox({ w: 0.3, h: 0.06, d: 2.4, x: 0, y: HALL.height - 0.31, z, material: mats.cyan, collider: false, batch: false }); // (one of them flickers: own mesh)
    const cone = new THREE.Mesh(lightShaftGeo, shaftMat);
    cone.position.set(0, HALL.height - 0.35 - LIGHT_SHAFT_HEIGHT / 2, z);
    scene.add(cone);
    return fixture;
  });

  addSign(
    createSignTexture(512, 128, [{ text: 'CRYO WING A', size: 50, y: 50 }, { text: 'ELDAR UNITS 01-12', size: 26, y: 100, color: '#7fefff' }]),
    1.5, 0.38, -HALL.half + 0.01, 3.0, -2.6, Math.PI / 2,
  );
  addSign(
    createSignTexture(512, 128, [{ text: 'TERMINAL ROOM  >>>', size: 44, y: 64 }]),
    1.5, 0.38, HALL.half - 0.01, 3.0, -2.6, -Math.PI / 2,
  );

  // Low mist drifting over the floor (two layers scrolling different ways).
  const mistTex = createMistTexture();
  const mist = [[0.12, 0.3, 0.004], [0.4, 0.2, -0.006]].map(([y, opacity, speed]) => {
    const tex = mistTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(3, 12);
    addPlane({
      w: ROOM.half * 2,
      d: HALL.nearZ - ROOM.backZ,
      x: 0,
      y,
      z: (HALL.nearZ + ROOM.backZ) / 2,
      material: new THREE.MeshBasicMaterial({ map: tex, color: 0x8fdcff, transparent: true, opacity, depthWrite: false }),
      name: 'lab-mist',
      batch: false,
    });
    return { tex, speed };
  });

  // ---- Cryo pods: 12 glass-fronted tubes of glowing fluid, an ELDAR unit in each ----
  // Every part is an InstancedMesh (one draw call per part for all 12 pods).
  // Pod-local space: +Z faces the middle of the corridor.
  const pods = [];
  POD_ZS.forEach((z) => {
    [-1, 1].forEach((s) => pods.push({ x: s * POD_X, z, yaw: s < 0 ? Math.PI / 2 : -Math.PI / 2 }));
  });
  const podMatrices = pods.map((p) => new THREE.Matrix4().compose(
    new THREE.Vector3(p.x, 0, p.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.yaw, 0)),
    _one,
  ));
  function instanced(geo, material, matrices, renderOrder = 0) {
    const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = renderOrder;
    scene.add(mesh);
    return mesh;
  }

  const GLASS_H = 2.44;
  const GLASS_Y = 0.42 + GLASS_H / 2;
  instanced(mergeGeometries([
    new THREE.CylinderGeometry(0.72, 0.78, 0.42, 28).translate(0, 0.21, 0), // base
    new THREE.CylinderGeometry(0.78, 0.72, 0.5, 28).translate(0, 3.11, 0), // cap
    new THREE.BoxGeometry(0.09, GLASS_H, 0.12).translate(0.64, GLASS_Y, 0), // seam frames
    new THREE.BoxGeometry(0.09, GLASS_H, 0.12).translate(-0.64, GLASS_Y, 0),
    new THREE.CylinderGeometry(0.06, 0.06, 0.86, 8).translate(0.3, 3.79, -0.25), // hoses into the ceiling
    new THREE.CylinderGeometry(0.06, 0.06, 0.86, 8).translate(-0.3, 3.79, -0.25),
  ]), mats.metal, podMatrices);
  instanced(
    new THREE.CylinderGeometry(0.66, 0.66, GLASS_H, 28, 1, true, Math.PI / 2, Math.PI).translate(0, GLASS_Y, 0),
    mats.podShell,
    podMatrices,
  ); // metal back half
  instanced(mergeGeometries([
    new THREE.CylinderGeometry(0.745, 0.745, 0.05, 28, 1, true).translate(0, 0.37, 0),
    new THREE.CylinderGeometry(0.745, 0.745, 0.05, 28, 1, true).translate(0, 2.9, 0),
  ]), mats.cyan, podMatrices); // glowing rings

  const liquidMat = createLiquidMaterial();
  const podLiquid = instanced(new THREE.CylinderGeometry(0.58, 0.58, 2.38, 28).translate(0, 0.42 + 1.19, 0), liquidMat, podMatrices, 1);
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xcfefff, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.14, depthWrite: false,
  });
  const podGlass = instanced(
    new THREE.CylinderGeometry(0.62, 0.62, GLASS_H, 28, 1, true, -Math.PI / 2, Math.PI).translate(0, GLASS_Y, 0),
    glassMat,
    podMatrices,
    2,
  );
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });
  const podGlints = instanced(mergeGeometries([
    new THREE.CylinderGeometry(0.625, 0.625, 2.2, 3, 1, true, -0.62, 0.13).translate(0, GLASS_Y, 0),
    new THREE.CylinderGeometry(0.625, 0.625, 2.0, 3, 1, true, 0.38, 0.05).translate(0, GLASS_Y + 0.05, 0),
  ]), glintMat, podMatrices, 3); // glass glints

  // The ELDAR units, dormant, standing on each pod's floor (slightly varied).
  const eldar = buildEldarGeometries();
  const robotMatrices = pods.map((p, i) => new THREE.Matrix4().compose(
    new THREE.Vector3(p.x, 0.44, p.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.yaw + Math.sin(i * 2.3) * 0.08, 0)),
    new THREE.Vector3().setScalar(0.98 + (i % 3) * 0.02),
  ));
  const robotGlowMat = new THREE.MeshBasicMaterial({ color: 0x7fefff });
  const robotPlateMat = new THREE.MeshStandardMaterial({ color: 0xc3ccd4, metalness: 0.55, roughness: 0.32, emissive: 0x06303f });
  const robotJointMat = new THREE.MeshStandardMaterial({ color: 0x1c2328, metalness: 0.6, roughness: 0.45, emissive: 0x021018 });
  const podRobots = [
    instanced(eldar.plates, robotPlateMat, robotMatrices),
    instanced(eldar.joints, robotJointMat, robotMatrices),
    instanced(eldar.glow, robotGlowMat, robotMatrices),
  ];

  // Per-pod name plates (all 12 share one atlas texture and merge into one
  // mesh), plus an invisible hitbox (solid + [E] examine).
  const PLATE_H = 80;
  const plateCanvas = makeCanvas(256, PLATE_H * pods.length);
  const plateCtx = plateCanvas.getContext('2d');
  const plateTex = canvasTexture(plateCanvas);
  const plateMat = new THREE.MeshBasicMaterial({ map: plateTex });
  const podUnit = (i) => `ELDAR-${String(i + 1).padStart(2, '0')}`;
  const drawPlate = (i, active) => drawSignInto(
    plateCtx, 0, i * PLATE_H, 256, PLATE_H,
    active
      ? [{ text: podUnit(i), size: 32, y: 30, color: '#ff4a3a' }, { text: 'ACTIVE', size: 18, y: 62, color: '#ff8a7a' }]
      : [{ text: podUnit(i), size: 32, y: 30 }, { text: 'DORMANT', size: 18, y: 62, color: '#7fefff' }],
    active ? { border: '#ff4a3a' } : undefined,
  );
  pods.forEach((p, i) => {
    const unit = podUnit(i);
    drawPlate(i, false);
    const geo = new THREE.PlaneGeometry(0.46, 0.14);
    const uv = geo.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - (i + 1) / pods.length + uv.getY(k) / pods.length); // this pod's row
    const plate = new THREE.Mesh(geo, plateMat);
    plate.position.set(p.x + Math.sin(p.yaw) * 0.752, 0.24, p.z + Math.cos(p.yaw) * 0.752);
    plate.rotation.set(0, p.yaw, 0);
    plate.rotateX(-0.14); // follows the slope of the base
    toBatch(plate);
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(1.5, 3.4, 1.5), mats.hidden);
    hitbox.position.set(p.x, 1.7, p.z);
    hitbox.userData = { interactable: true, label: 'Examine cryo pod', type: 'ch2-pod', unit, pod: i };
    scene.add(hitbox);
    colliders.push(hitbox);
    interactables.push(hitbox);
  });

  // Waking a pod: its glass, fluid and dormant unit vanish (combat spawns a live unit in its place).
  const collapsed = new THREE.Matrix4().makeScale(0, 0, 0);
  const podOpen = pods.map(() => false);
  function openPod(i) {
    const p = pods[i];
    const fresh = !podOpen[i];
    if (fresh) {
      podOpen[i] = true;
      [podGlass, podLiquid, podGlints, ...podRobots].forEach((mesh) => {
        mesh.setMatrixAt(i, collapsed);
        mesh.instanceMatrix.needsUpdate = true;
      });
      drawPlate(i, true);
      plateTex.needsUpdate = true;
    }
    return { pos: new THREE.Vector3(p.x, 0, p.z), yaw: p.yaw, fresh };
  }

  // ---- ELDAR display pillars flanking the entrance -----------------------------------
  // Taller tubes, bigger specimens. The left one topples across the exit halfway
  // through the fight (pillars[0].fall()) and the ELDARs duck behind it.
  const pillarGlassH = PILLAR.height - 0.9;
  const crackedGlassMat = new THREE.MeshStandardMaterial({
    map: createCrackedGlassTexture(), metalness: 0.3, roughness: 0.35, side: THREE.DoubleSide,
  });
  crackedGlassMat.map.repeat.set(3, 2);
  const warmUp = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), crackedGlassMat); // under the floor: compiles its shader up front
  warmUp.position.set(0, -3, -40);
  scene.add(warmUp);
  const pillars = [-1, 1].map((s) => {
    const x = s * PILLAR.x;
    const r = PILLAR.radius;
    const pivot = new THREE.Group(); // tips over its +X edge, toward the doorway
    pivot.position.set(x + r, 0, PILLAR.z);
    scene.add(pivot);
    const body = new THREE.Group();
    body.position.x = -r;
    pivot.add(body);
    const partAt = (geo, mat, y) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = y;
      body.add(mesh);
      return mesh;
    };
    partAt(new THREE.CylinderGeometry(r, r + 0.06, 0.4, 28), mats.metal, 0.2);
    partAt(new THREE.CylinderGeometry(r + 0.06, r, 0.5, 28), mats.metal, 0.4 + pillarGlassH + 0.25);
    partAt(new THREE.CylinderGeometry(r + 0.012, r + 0.012, 0.05, 28, 1, true), mats.cyan, 0.36);
    partAt(new THREE.CylinderGeometry(r + 0.012, r + 0.012, 0.05, 28, 1, true), mats.cyan, 0.44 + pillarGlassH);
    const liquid = partAt(new THREE.CylinderGeometry(r - 0.16, r - 0.16, pillarGlassH - 0.08, 28), liquidMat, 0.38 + pillarGlassH / 2);
    liquid.renderOrder = 1;
    const glass = partAt(new THREE.CylinderGeometry(r - 0.1, r - 0.1, pillarGlassH, 28, 1, true), glassMat, 0.4 + pillarGlassH / 2);
    glass.renderOrder = 2;
    const specimen = new THREE.Group();
    specimen.add(new THREE.Mesh(eldar.plates, robotPlateMat), new THREE.Mesh(eldar.joints, robotJointMat), new THREE.Mesh(eldar.glow, robotGlowMat));
    specimen.scale.setScalar(1.35);
    specimen.position.y = 0.44;
    specimen.rotation.y = Math.PI; // faces into the chamber
    body.add(specimen);
    // Feed hoses to the ceiling stay behind (and spark) if it comes down.
    const hoseEnds = [-0.28, 0.28].map((ox) => {
      addBox({ w: 0.12, h: ROOM.height - PILLAR.height, d: 0.12, x: x + ox, y: (ROOM.height + PILLAR.height) / 2, z: PILLAR.z - 0.2, material: mats.pipe, collider: false });
      return new THREE.Vector3(x + ox, PILLAR.height + 0.05, PILLAR.z - 0.2);
    });
    const upright = new THREE.Mesh(new THREE.BoxGeometry(r * 2, PILLAR.height, r * 2), mats.hidden);
    upright.position.set(x, PILLAR.height / 2, PILLAR.z);
    scene.add(upright);
    colliders.push(upright);
    const puddle = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 32),
      new THREE.MeshBasicMaterial({ color: 0x2ab8ff, transparent: true, opacity: 0, depthWrite: false }),
    );
    puddle.rotation.x = -Math.PI / 2;
    puddle.scale.set(1.6, 0.8, 1);
    puddle.position.set(x + 2.6, 0.012, PILLAR.z + 0.4);
    puddle.visible = false;
    scene.add(puddle);
    return {
      pivot, glass, liquid, upright, puddle, hoseEnds,
      fallen: false,
      fallT: -1,
      settleT: 0,
      resolve: null,
      /** Topples across the doorway; resolves on impact. */
      fall() {
        return new Promise((resolve) => {
          this.fallT = 0;
          this.resolve = resolve;
        });
      },
    };
  });

  function updatePillar(p, dt) {
    if (p.fallT < 0) return;
    if (!p.fallen) {
      p.fallT += dt;
      const k = Math.min(1, p.fallT / 1.15);
      p.pivot.rotation.z = -(Math.PI / 2) * k * k; // accelerates like it's really falling
      if (k >= 1) {
        p.fallen = true;
        // The glass shatters to frosted cracks (opaque, so what's behind it is hidden
        // the way the cover really works) and the fluid pours out across the floor.
        p.glass.material = crackedGlassMat;
        p.glass.renderOrder = 0;
        p.liquid.visible = false;
        p.puddle.visible = true;
        removeFrom(colliders, p.upright);
        scene.remove(p.upright);
        const lying = new THREE.Mesh(new THREE.BoxGeometry(PILLAR.height, PILLAR.radius * 2, PILLAR.radius * 2), mats.hidden);
        lying.position.set(p.pivot.position.x + PILLAR.height / 2, PILLAR.radius, PILLAR.z);
        lying.name = 'fallen-pillar';
        scene.add(lying);
        colliders.push(lying);
        p.resolve();
      }
      return;
    }
    p.settleT += dt;
    p.pivot.rotation.z = -Math.PI / 2 + Math.sin(p.settleT * 20) * 0.03 * Math.max(0, 1 - p.settleT * 2.5); // a little bounce
    p.puddle.material.opacity = Math.min(0.35, p.settleT * 0.6) * Math.max(0.15, 1 - p.settleT / 40);
  }

  // ---- Cover, structure and alarm beacons ----------------------------------------------
  [[-3.2, -48.6, 3.0, 1.15, 0.5], [3.2, -48.6, 3.0, 1.15, 0.5], [-6.8, -41.8, 2.6, 1.1, 0.5]].forEach(([x, z, w, h, d]) => {
    addBox({ w, h, d, x, y: h / 2, z, material: mats.metalDark, name: 'barrier' });
    addBox({ w: w + 0.02, h: 0.12, d: d + 0.02, x, y: h - 0.14, z, material: mats.hazard, tile: 0.5, collider: false });
  });
  [[-8.4, -53.5, 1.3], [8.6, -52.8, 1.3], [6.2, -41.5, 1.2], [BEN_COVER_SPOT.x, BEN_COVER_SPOT.z + 1.45, 1.1]].forEach(([x, z, s]) => {
    addBox({ w: s, h: s, d: s, x, y: s / 2, z, material: mats.crate, name: 'crate' });
  });
  addBox({ w: 1.0, h: 1.0, d: 1.0, x: -8.35, y: 1.8, z: -53.45, material: mats.crate, rotationY: 0.2, name: 'crate' });
  [-7.5, 7.5].forEach((x) => {
    addBox({ w: 0.9, h: ROOM.height, d: 0.9, x, y: ROOM.height / 2, z: -47.5, material: mats.metalDark, name: 'column' });
    addBox({ w: 0.96, h: 0.3, d: 0.96, x, y: 0.15, z: -47.5, material: mats.hazard, tile: 0.5, collider: false });
  });
  [-1, 1].forEach((s) => {
    [-39, -51.5, -56.5, -60.5].forEach((z) => {
      if (s < 0 && z === -51.5) return; // the structural pillar stands there instead
      addBox({ w: 0.3, h: ROOM.height, d: 0.4, x: s * (ROOM.half - 0.15), y: ROOM.height / 2, z, material: mats.metalDark });
    });
    [[-37.5, -44], [-49.5, -60.5]].forEach(([z0, z1]) => {
      addBox({ w: 0.3, h: 0.06, d: z0 - z1, x: s * 6.5, y: ROOM.height - 0.06, z: (z0 + z1) / 2, material: mats.cyan, collider: false });
    });
  });
  // The structural pillar on the left wall. The Titan rips it off in phase 2
  // (tearWallPillar): what's left is torn studs and sparking cables.
  const wallPillar = createStructuralPillar();
  wallPillar.position.set(WALL_PILLAR.x, 0.05 + PILLAR_SIZE.height / 2, WALL_PILLAR.z);
  wallPillar.rotation.y = Math.PI / 2; // plating against the wall, the H-beam facing the room
  const pillarSign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.2),
    new THREE.MeshBasicMaterial({
      map: createSignTexture(256, 100, [{ text: 'LOAD BEARING', size: 30, y: 36, color: '#e0c34a' }, { text: 'DO NOT REMOVE', size: 22, y: 72, color: '#e0c34a' }], { border: '#e0c34a', bg: '#171307' }),
    }),
  );
  pillarSign.position.set(0, -0.6, 0.24); // on the front flange
  wallPillar.add(pillarSign);
  scene.add(wallPillar);
  addBox({ w: 0.47, h: ROOM.height - PILLAR_SIZE.height - 0.05, d: 0.62, x: WALL_PILLAR.x, y: (ROOM.height + PILLAR_SIZE.height + 0.05) / 2, z: WALL_PILLAR.z, material: wallPillar.userData.beamMat, collider: false }); // upper section, stays put
  const tornWall = new THREE.Mesh(
    new THREE.PlaneGeometry(PILLAR_SIZE.width, PILLAR_SIZE.height),
    (() => {
      const tex = createTornWallTexture();
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.3, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18 });
    })(),
  );
  tornWall.position.set(-ROOM.half + 0.012, 0.05 + PILLAR_SIZE.height / 2, WALL_PILLAR.z);
  tornWall.rotation.y = Math.PI / 2;
  tornWall.visible = false;
  scene.add(tornWall);
  const tornWarmUp = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), tornWall.material); // compiles its shader up front
  tornWarmUp.position.set(0, -3, -50);
  scene.add(tornWarmUp);
  const wallPillarBlock = new THREE.Mesh(new THREE.BoxGeometry(0.5, PILLAR_SIZE.height, PILLAR_SIZE.width), mats.hidden);
  wallPillarBlock.position.copy(wallPillar.position);
  colliders.push(wallPillarBlock);
  const tornCables = [0.9, 2.2, 3.4].map((y) => new THREE.Vector3(-ROOM.half + 0.1, y, WALL_PILLAR.z + (Math.random() - 0.5) * 0.8));
  const wallPillarState = { torn: false };
  function tearWallPillar() {
    if (wallPillarState.torn) return false;
    wallPillarState.torn = true;
    wallPillar.visible = false;
    tornWall.visible = true;
    removeFrom(colliders, wallPillarBlock);
    return true;
  }

  const alarmMat = new THREE.MeshBasicMaterial({ color: 0x220606 });
  [[-1, -40], [1, -40], [-1, -55], [1, -55]].forEach(([s, z]) => {
    addBox({ w: 0.2, h: 0.35, d: 0.35, x: s * (ROOM.half - 0.12), y: ROOM.height - 1.2, z, material: alarmMat, collider: false });
  });
  addBox({ w: 0.35, h: 0.2, d: 0.35, x: 0, y: HALL.height - 0.12, z: -34.5, material: alarmMat, collider: false });

  // ---- Terminal room: the master console ----------------------------------------
  addBox({ w: DESK.width, h: 0.9, d: 1.0, x: 0, y: 0.45, z: DESK.z, material: mats.metalDark, name: 'console-desk' });
  addBox({ w: DESK.width + 0.2, h: 0.06, d: 1.1, x: 0, y: 0.93, z: DESK.z, material: mats.metal, collider: false });
  const buttonsCanvas = makeCanvas(512, 64);
  {
    const g = buttonsCanvas.getContext('2d');
    g.fillStyle = '#000000';
    g.fillRect(0, 0, 512, 64);
    const colors = ['#00e5ff', '#0b8aa3', '#ffb13a', '#ff4a3a', '#7fefff'];
    for (let x = 8; x < 500; x += 22) {
      for (let y = 8; y < 56; y += 16) {
        if (Math.random() < 0.7) {
          g.globalAlpha = 0.35 + Math.random() * 0.65;
          g.fillStyle = colors[Math.floor(Math.random() * colors.length)];
          g.fillRect(x, y, 14, 8);
        }
      }
    }
    g.globalAlpha = 1;
  }
  const controlPanel = new THREE.Mesh(
    new THREE.BoxGeometry(3.1, 0.03, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x0f1316, emissive: 0xffffff, emissiveMap: canvasTexture(buttonsCanvas), roughness: 0.5, metalness: 0.3 }),
  );
  controlPanel.position.set(0, 0.99, DESK.z - 0.05);
  controlPanel.rotation.x = 0.22;
  scene.add(controlPanel);
  addBox({ w: 0.62, h: 0.025, d: 0.2, x: 0, y: 0.975, z: DESK.front - 0.14, material: mats.polymer, collider: false }); // keyboard

  const screen = new TerminalScreen();
  const status = new StatusScreens();
  function addMonitor(texture, w, h, x, y, z, rotY, owner) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = rotY;
    scene.add(group);
    group.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.06), mats.metalDark));
    const display = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture }));
    display.position.z = 0.032;
    group.add(display);
    watchVisibility(display, owner); // (its screen only redraws while it's in view)
    const standH = y - h / 2 - 0.96;
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, standH, 0.06), mats.metal);
    stand.position.set(0, -h / 2 - standH / 2, -0.04);
    group.add(stand);
  }
  addMonitor(screen.texture, 1.2, 0.72, SCREEN_CENTER.x, SCREEN_CENTER.y, SCREEN_CENTER.z, 0, screen);
  addMonitor(status.pods.texture, 0.8, 0.5, -1.32, 1.5, DESK.z - 0.1, 0.35, status);
  addMonitor(status.signal.texture, 0.8, 0.5, 1.32, 1.5, DESK.z - 0.1, -0.35, status);
  const terminalHitbox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.95, 0.4), mats.hidden);
  terminalHitbox.position.copy(SCREEN_CENTER);
  terminalHitbox.userData = { interactable: true, label: 'Use the terminal', type: 'ch2-terminal' };
  scene.add(terminalHitbox);
  interactables.push(terminalHitbox);

  // Media port on the desk's front panel, and the thumb drive (taped out of sight under the desk).
  addBox({ w: 0.07, h: 0.04, d: 0.006, x: PORT.x, y: PORT.y, z: PORT.z + 0.003, material: mats.cyan, collider: false });
  addBox({ w: 0.04, h: 0.014, d: 0.01, x: PORT.x, y: PORT.y, z: PORT.z + 0.006, material: new THREE.MeshBasicMaterial({ color: 0x020202 }), collider: false });
  const drive = new THREE.Group();
  drive.add(new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.016, 0.075), new THREE.MeshStandardMaterial({ color: 0xb3241c, roughness: 0.45 })));
  const drivePlug = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.008, 0.024), mats.metal);
  drivePlug.position.z = -0.049;
  const driveLedMat = new THREE.MeshBasicMaterial({ color: 0x3a0d0d });
  const driveLed = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.008), driveLedMat);
  driveLed.position.set(0, 0.009, 0.022);
  drive.add(drivePlug, driveLed);
  drive.visible = false;
  drive.userData = { plugged: false, led: driveLedMat };
  scene.add(drive);

  // Server racks either side of the console, LEDs blinking away.
  const leds = new RackLeds();
  const rackFront = new THREE.MeshStandardMaterial({ map: leds.texture, emissive: 0xffffff, emissiveMap: leds.texture, roughness: 0.6 });
  [-1, 1].forEach((s) => {
    const d = mats.metalDark;
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.4, 0.9), [d, d, d, d, rackFront, d]);
    rack.position.set(s * 3.3, 1.2, ROOM.backZ + 0.5);
    rack.name = 'server-rack';
    scene.add(rack);
    colliders.push(rack);
    watchVisibility(rack, leds);
  });

  // The big ELDAR display on the back wall.
  const wallCanvas = makeCanvas(1024, 300);
  drawWallDisplay(wallCanvas, false);
  const wallTex = canvasTexture(wallCanvas);
  addBox({ w: 5.8, h: 1.86, d: 0.05, x: 0, y: 4.3, z: ROOM.backZ + 0.025, material: mats.metalDark, collider: false });
  const wallDisplay = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 1.64), new THREE.MeshBasicMaterial({ map: wallTex }));
  wallDisplay.position.set(0, 4.3, ROOM.backZ + 0.055);
  scene.add(wallDisplay);

  // ---- Armory rack (left wall): two assault rifles behind a lock bar ----------
  const armory = new THREE.Group();
  armory.position.set(-ROOM.half, 0, ARMORY_Z); // local +X points into the room
  scene.add(armory);
  const armoryPart = (geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    armory.add(mesh);
    return mesh;
  };
  armoryPart(new THREE.BoxGeometry(0.06, 2.0, 1.7), mats.metalDark, 0.03, 1.35, 0); // back panel
  armoryPart(new THREE.BoxGeometry(0.22, 0.07, 1.6), mats.metal, 0.13, 0.92, 0); // butt rest
  armoryPart(new THREE.BoxGeometry(0.22, 0.07, 1.6), mats.metal, 0.13, 2.02, 0); // barrel clamps
  armoryPart(new THREE.BoxGeometry(0.04, 0.04, 1.64), mats.metal, 0.3, 1.45, 0); // lock bar
  armoryPart(new THREE.BoxGeometry(0.07, 0.14, 0.09), mats.metalDark, 0.3, 1.45, 0.86); // padlock box
  const lockLedMat = new THREE.MeshBasicMaterial({ color: 0xff3a2a });
  const lockBar = armoryPart(new THREE.BoxGeometry(0.01, 0.025, 0.025), lockLedMat, 0.34, 1.49, 0.86); // "locked" LED
  lockBar.name = 'armory-led';
  const rifles = [-0.38, 0.38].map((z) => {
    const group = createRifleMesh(mats.polymer, mats.gunMetal);
    group.position.set(0.17, 1.36, z);
    group.scale.setScalar(0.82);
    group.name = 'assault-rifle';
    armory.add(group);
    return group;
  });
  addSign(
    createSignTexture(512, 128, [{ text: 'ARMORY', size: 58, y: 50, color: '#ff4a3a' }, { text: 'AUTHORIZED USE ONLY', size: 24, y: 102, color: '#ff8a7a' }], { border: '#ff4a3a' }),
    0.9, 0.225, -ROOM.half + 0.02, 2.6, ARMORY_Z, Math.PI / 2,
  );
  const armoryHitbox = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.1, 1.75), mats.hidden);
  armoryHitbox.position.set(-ROOM.half + 0.25, 1.35, ARMORY_Z);
  armoryHitbox.userData = { interactable: true, label: 'Examine the rifle rack', type: 'ch2-armory' };
  scene.add(armoryHitbox);
  colliders.push(armoryHitbox);
  interactables.push(armoryHitbox);

  // ---- Wall rack (right wall): a case of water bottles + a note from Coach ----
  const waterRack = new THREE.Group();
  waterRack.position.set(ROOM.half, 0, WATER_Z);
  waterRack.rotation.y = Math.PI; // local +X points into the room
  scene.add(waterRack);
  const rackPart = (geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    waterRack.add(mesh);
    return mesh;
  };
  rackPart(new THREE.BoxGeometry(0.44, 0.04, 1.2), mats.metal, 0.22, 1.25, 0); // shelf
  [-0.5, 0.5].forEach((z) => rackPart(new THREE.BoxGeometry(0.36, 0.18, 0.04), mats.metalDark, 0.18, 1.14, z)); // brackets
  const caseSide = new THREE.MeshStandardMaterial({ map: createWaterBoxTexture(), roughness: 0.95 });
  const caseInside = new THREE.MeshStandardMaterial({ color: 0x3b2c1c, roughness: 1 });
  const c = mats.cardboard;
  rackPart(new THREE.BoxGeometry(0.36, 0.26, 0.64), [caseSide, c, caseInside, c, c, c], 0.21, 1.4, 0);
  // 15 bottles in the case: two instanced meshes (bottles + caps); a taken one collapses to nothing.
  const bottleSlots = [];
  for (let ix = 0; ix < 3; ix++) {
    for (let iz = 0; iz < 5; iz++) bottleSlots.push([0.1 + ix * 0.11, -0.24 + iz * 0.12]);
  }
  const bottleInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.034, 0.034, 0.3, 10), mats.bottle, bottleSlots.length);
  const capInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), mats.bottleCap, bottleSlots.length);
  const bottleTaken = bottleSlots.map(() => false);
  const setBottle = (i, shown) => {
    const [x, z] = bottleSlots[i];
    bottleInst.setMatrixAt(i, shown ? _m4.makeTranslation(x, 1.45, z) : collapsed);
    capInst.setMatrixAt(i, shown ? _m4.makeTranslation(x, 1.615, z) : collapsed);
    bottleInst.instanceMatrix.needsUpdate = true;
    capInst.instanceMatrix.needsUpdate = true;
  };
  bottleSlots.forEach((_, i) => setBottle(i, true));
  waterRack.add(bottleInst, capInst);
  const note = rackPart(new THREE.PlaneGeometry(0.5, 0.31), new THREE.MeshStandardMaterial({ map: createCoachNoteTexture(), roughness: 0.9 }), 0.006, 1.95, 0);
  note.rotation.y = Math.PI / 2;
  // Solid from the start, but only interactable once the Titan shows up (Chapter2 adds it then).
  const waterHitbox = rackPart(new THREE.BoxGeometry(0.5, 0.45, 0.75), mats.hidden, 0.22, 1.45, 0);
  waterHitbox.userData = { interactable: true, label: 'Grab a water bottle', type: 'ch2-water' };
  colliders.push(waterHitbox);

  // ---- Other Ben (the lab's own copy of him) -------------------------------------
  const benMesh = createHumanoid(OTHER_BEN_LOOK);
  benMesh.name = 'other-ben';
  scene.add(benMesh);
  const ben = new Character(benMesh, { radius: 0.32, name: 'Other Ben' });
  const benLight = new HandFlashlight(scene, ben);

  // ---- Coach Billing (only down here for his visit) ----------------------------
  const coachMesh = createHumanoid(COACH_BILLING_LOOK);
  coachMesh.name = 'coach-billing';
  coachMesh.visible = false;
  scene.add(coachMesh);
  const coach = new Character(coachMesh, { radius: 0.42, name: 'Coach Billing' });

  // ---- Lockdown: every light pulses red, the beacons flash --------------------------
  const lockdown = { on: false, t: 0 };
  const cyanColor = new THREE.Color(CYAN);
  const redColor = new THREE.Color(0xff2418);
  const pulseColor = new THREE.Color();
  const baseColors = new Map([...corridorLights, ...chamberLights].map((l) => [l, l.color.clone()]));
  function setLockdown(on) {
    lockdown.on = on;
    if (!on) {
      baseColors.forEach((color, light) => light.color.copy(color));
      mats.cyan.color.copy(cyanColor);
      alarmMat.color.setHex(0x220606);
    }
  }

  // ---- Per-frame: fluid, haze, screens, doors, hatches, a failing fixture ----------
  let time = 0;
  let driveBlink = 0;
  const flicker = { on: true, timer: 3, burst: 0 };
  updatables.push({
    update(dt) {
      time += dt;
      liquidMat.uniforms.uTime.value = time;
      shaftMat.uniforms.uTime.value = time;
      for (const m of mist) {
        m.tex.offset.x += dt * m.speed;
        m.tex.offset.y += dt * m.speed * 0.5;
      }
      screen.update(dt);
      status.update(dt);
      leds.update(dt);
      ben.update(dt);
      benLight.update();
      coach.update(dt);

      for (const d of doors) {
        d.holdT -= dt;
        d.open += ((d.holdT > 0 ? 1 : 0) - d.open) * Math.min(1, dt * 5);
        d.panels.forEach((p) => {
          p.position.z = p.userData.closedZ + p.userData.dir * SIDE_DOOR.half * 0.95 * d.open;
        });
      }
      bossHatch.open += (bossHatch.target - bossHatch.open) * Math.min(1, dt * 2.5);
      hatchDoors.forEach((p) => {
        p.position.x = p.userData.closedX + p.userData.dir * BOSS_HATCH.half * bossHatch.open;
      });
      pillars.forEach((p) => updatePillar(p, dt));

      if (lockdown.on) {
        lockdown.t += dt;
        const a = 0.5 + 0.5 * Math.sin(lockdown.t * 5.2);
        pulseColor.copy(cyanColor).lerp(redColor, 0.55 + 0.45 * a);
        baseColors.forEach((_, light) => light.color.copy(pulseColor));
        mats.cyan.color.copy(cyanColor).lerp(redColor, 0.2 + 0.7 * a);
        alarmMat.color.setRGB(a > 0.5 ? 1 : 0.15, 0.06, 0.04);
      }

      // One tired fixture keeps buzzing out, sometimes in little bursts.
      flicker.timer -= dt;
      if (flicker.timer <= 0) {
        flicker.on = !flicker.on;
        if (!flicker.on) flicker.timer = 0.04 + Math.random() * 0.1;
        else if (flicker.burst > 0) {
          flicker.burst--;
          flicker.timer = 0.05 + Math.random() * 0.1;
        } else {
          flicker.burst = Math.floor(Math.random() * 3);
          flicker.timer = 2.5 + Math.random() * 6;
        }
        corridorLights[2].intensity = flicker.on ? 14 : 1.5;
        fixtures[2].material = flicker.on ? mats.cyan : mats.cyanDim;
      }

      if (drive.userData.plugged) {
        driveBlink += dt;
        driveLedMat.color.set(Math.floor(driveBlink * 6) % 2 ? 0xff2a1a : 0x3a0d0d);
      }
    },
  });

  flushBatch(); // everything static above: merged per material

  const calmGlow = new THREE.Color(0x7fefff);
  const alertGlow = new THREE.Color(0xff3322);
  return {
    scene,
    colliders,
    tearWallPillar,
    tornCables,
    wallPillarState,
    interactables,
    updatables,
    ben,
    benLight,
    screen,
    status,
    drive,
    rifles,
    /** 0..1: the units' visors (and the fluid) shift from cyan to red as the download runs. */
    setAlert(p) {
      robotGlowMat.color.copy(calmGlow).lerp(alertGlow, p);
      liquidMat.uniforms.uAlert.value = p;
    },
    setWallAlert(on) {
      drawWallDisplay(wallCanvas, on);
      wallTex.needsUpdate = true;
    },
    /** Take a bottle out of the case (Coach keeps it stocked: when it's empty, a fresh case appears). */
    takeBottle() {
      let i = bottleTaken.indexOf(false);
      if (i === -1) {
        bottleTaken.fill(false);
        bottleSlots.forEach((_, k) => setBottle(k, true));
        i = 0;
      }
      bottleTaken[i] = true;
      setBottle(i, false);
      return true;
    },
    coach,
    doors,
    pillars,
    openPod,
    podCount: pods.length,
    bossHatch,
    setLockdown,
    /** The tree hatch at the top of the ladder shaft: open (red glow spilling down) or shut. */
    setShaftHatch(open) {
      hatch.material.color.setHex(open ? 0xffffff : 0x0a0a0a);
      hatchLight.intensity = open ? 5 : 0;
    },
    setArmoryUnlocked(on) {
      lockLedMat.color.setHex(on ? 0x3aff6a : 0xff3a2a);
    },
    waterHitbox,
    terminalHitbox,
    armoryHitbox,
    // Where the ELDARs hop off the top of the ladder, and where they land dropping through the ceiling hatch.
    ladderTop: new THREE.Vector3(0, SHAFT.height - 0.9, LADDER_Z - 0.38),
    dropSpots: [
      new THREE.Vector3(BOSS_HATCH.x - 1.1, 0, BOSS_HATCH.z + 0.7),
      new THREE.Vector3(BOSS_HATCH.x + 1.1, 0, BOSS_HATCH.z - 0.5),
      new THREE.Vector3(BOSS_HATCH.x, 0, BOSS_HATCH.z + 1.3),
    ],
    markers: {
      terminalDoor: new THREE.Vector3(0, 3.3, ROOM.nearZ + 0.8),
      armory: new THREE.Vector3(-ROOM.half + 0.45, 2.75, ARMORY_Z),
      water: new THREE.Vector3(ROOM.half - 0.45, 2.3, WATER_Z),
      usb: new THREE.Vector3(PORT.x, 1.35, PORT.z + 0.1),
    },
  };
}

// ---------------------------------------------------------------------------
// Chapter 2 controller: 1:30 AM at the oak -> down the ladder -> the terminal ->
// Coach's visit -> the ELDAR waves -> the Titan -> the drive
// ---------------------------------------------------------------------------

const smooth = (t) => THREE.MathUtils.smoothstep(t, 0, 1);

/*
 * The fight. Every ELDAR taken down pushes the download along: all 42 = 99%,
 * then the Titan drops in. They come out of the cryo pods (0/1 at z=-4 by the
 * shaft ... 10/11 at z=-29 by the chamber), down the ladder, through both side
 * doors and, from wave 3, down through the ceiling hatch. `cap` = most alive at
 * once (the rest wait their turn). `cover: true` units head for the fallen
 * pillar once it's down.
 */
const WAVES = [
  { // 1: pods burst open all down the corridor, then both side doors
    cap: 6,
    spawns: [
      { type: 'standard', from: 'pod', pod: 11, at: 0.5 },
      { type: 'standard', from: 'pod', pod: 10, at: 1.3 },
      { type: 'standard', from: 'pod', pod: 9, at: 2.4 },
      { type: 'standard', from: 'door', door: 1, at: 4.5 },
      { type: 'standard', from: 'door', door: 0, at: 5.5 },
      { type: 'standard', from: 'pod', pod: 8, at: 8 },
      { type: 'standard', from: 'pod', pod: 7, at: 9.5 },
      { type: 'standard', from: 'door', door: 1, at: 12 },
    ],
  },
  { // 2: they come down the ladder (shown in a cutaway), plus the first shield units
    intro: 'ladder',
    cap: 7,
    spawns: [
      { type: 'standard', from: 'ladder', at: 0.2 },
      { type: 'standard', from: 'ladder', at: 1.0 },
      { type: 'standard', from: 'ladder', at: 1.8 },
      { type: 'shield', from: 'door', door: 0, at: 5 },
      { type: 'standard', from: 'pod', pod: 6, at: 6 },
      { type: 'standard', from: 'pod', pod: 5, at: 7 },
      { type: 'shield', from: 'door', door: 1, at: 10 },
      { type: 'standard', from: 'ladder', at: 12 },
      { type: 'standard', from: 'door', door: 0, at: 13 },
      { type: 'standard', from: 'pod', pod: 4, at: 15 },
    ],
  },
  { // 3 (halfway): the display pillar comes down across the exit and they use it; the ceiling hatch opens
    intro: 'pillar',
    cap: 8,
    spawns: [
      { type: 'standard', from: 'ladder', at: 1, cover: true },
      { type: 'standard', from: 'pod', pod: 3, at: 1.8, cover: true },
      { type: 'standard', from: 'ladder', at: 2.8, cover: true },
      { type: 'shield', from: 'door', door: 1, at: 4.5 },
      { type: 'standard', from: 'drop', spot: 0, at: 6 },
      { type: 'standard', from: 'drop', spot: 1, at: 6.6 },
      { type: 'standard', from: 'pod', pod: 2, at: 8, cover: true },
      { type: 'shield', from: 'pod', pod: 1, at: 10 },
      { type: 'standard', from: 'door', door: 0, at: 11 },
      { type: 'standard', from: 'ladder', at: 13, cover: true },
      { type: 'standard', from: 'drop', spot: 2, at: 15 },
    ],
  },
  { // 4: everything at once, from everywhere
    cap: 9,
    spawns: [
      { type: 'shield', from: 'ladder', at: 0.5 },
      { type: 'standard', from: 'pod', pod: 0, at: 1, cover: true },
      { type: 'standard', from: 'drop', spot: 0, at: 2 },
      { type: 'standard', from: 'drop', spot: 1, at: 2.5 },
      { type: 'shield', from: 'door', door: 1, at: 4 },
      { type: 'standard', from: 'door', door: 0, at: 4.5 },
      { type: 'standard', from: 'ladder', at: 6, cover: true },
      { type: 'standard', from: 'ladder', at: 7, cover: true },
      { type: 'shield', from: 'door', door: 0, at: 9 },
      { type: 'standard', from: 'drop', spot: 2, at: 10 },
      { type: 'standard', from: 'door', door: 1, at: 11 },
      { type: 'standard', from: 'pod', pod: 11, at: 12, cover: true },
      { type: 'standard', from: 'ladder', at: 14 },
    ],
  },
];
const TOTAL_UNITS = WAVES.reduce((n, w) => n + w.spawns.length, 0);
// Backup during the Titan's exposed phases (phase 2's pillar phase has a nonstop stream, below).
const BOSS_ADDS = {
  1: [{ type: 'standard', from: 'door', door: 0, at: 12 }, { type: 'standard', from: 'door', door: 1, at: 14 }],
  3: [
    { type: 'shield', from: 'door', door: 1, at: 0.5 },
    { type: 'standard', from: 'door', door: 0, at: 2 },
    { type: 'standard', from: 'ladder', at: 3 },
    { type: 'standard', from: 'drop', spot: 2, at: 8 },
  ],
};
// Phase 2 (the pillar shield): reinforcements keep coming until the pillar breaks.
const REINFORCE = {
  cap: 5,
  every: 2.6,
  rotation: [
    { type: 'standard', from: 'door', door: 0 },
    { type: 'standard', from: 'door', door: 1 },
    { type: 'shield', from: 'ladder' },
    { type: 'standard', from: 'drop', spot: 0 },
    { type: 'standard', from: 'ladder' },
    { type: 'shield', from: 'door', door: 1 },
    { type: 'standard', from: 'drop', spot: 1 },
    { type: 'standard', from: 'door', door: 0 },
  ],
};
const BOSS_SPOT = new THREE.Vector3(BOSS_HATCH.x, 0, BOSS_HATCH.z);

// Firing positions all over the chamber (they keep hopping between them) and
// cover slots behind the fallen pillar.
const COMBAT_SPOTS = [
  [-8.5, -40.5], [-5.5, -40.6], [-2.2, -41.2], [2.2, -41.2], [5.2, -40.4], [9.0, -40.8],
  [-9.5, -44.5], [-4.8, -44.9], [0, -43.3], [4.6, -44.6], [9.5, -44.2], [-10, -49.5], [10, -48.8],
  [-6.2, -43.0], [6.8, -43.4], [-2.6, -46.4], [2.8, -46.2], [-8.6, -46.8], [8.8, -45.6],
  [-10.2, -51.8], [10.3, -51.2], [-6.0, -50.6], [6.0, -50.4], [0, -50.3], [-10.3, -56.8], [10.4, -57.4],
];
const COVER_SLOTS = [-2.2, -0.8, 0.6, 1.9].map((x) => [x, PILLAR.z + 1.45]);

/** Between the bulkhead and the fallen pillar. */
const inPocket = (p) => p.z > PILLAR.z + 0.4 && p.z < ROOM.nearZ && Math.abs(p.x) < 4.4;

/** Waypoints for a unit: out of the shaft, down the corridor, through the bulkhead, around the pillar. */
function labRoute(from, to, cover, pillarDown) {
  const pts = [];
  const around = (side, leaving) => {
    const a = new THREE.Vector3(side * 4.9, 0, ROOM.nearZ - 1.3);
    const b = new THREE.Vector3(side * 5.1, 0, PILLAR.z - 1.8);
    pts.push(...(leaving ? [a, b] : [b, a]));
  };
  if (from.z > ROOM.nearZ + 0.2) {
    if (from.z > HALL.nearZ - 0.3) pts.push(new THREE.Vector3(0, 0, HALL.nearZ - 1.4)); // out of the shaft
    else if (Math.abs(from.x) > 1.2) pts.push(new THREE.Vector3(Math.sign(from.x) * 1.1, 0, from.z - 0.6)); // out from between the pods
    pts.push(new THREE.Vector3(0, 0, ROOM.nearZ + 1.6), new THREE.Vector3(0, 0, ROOM.nearZ - 0.8));
    if (!cover) {
      if (pillarDown) around(to.x < 0 ? -1 : 1, true);
      else pts.push(new THREE.Vector3(THREE.MathUtils.clamp(to.x * 0.3, -2, 2), 0, PILLAR.z - 1.2));
    }
  } else if (pillarDown && inPocket(from) !== inPocket(to)) {
    around((inPocket(from) ? to.x : from.x) < 0 ? -1 : 1, inPocket(from));
  }
  pts.push(to.clone());
  return pts;
}

/** "A few hours later... 1:30 AM" over black. play() resolves as it fades away. */
function createTimeCard() {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:16;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:18px;pointer-events:none;font-family:"Courier New",Courier,monospace;text-align:center;color:#d9dee3;';
  const line = (text, css) => {
    const div = document.createElement('div');
    div.textContent = text;
    div.style.cssText = `${css}opacity:0;transition:opacity 1.2s ease;`;
    el.appendChild(div);
    return div;
  };
  const chapter = line('CHAPTER 2 · BELOW THE OAK', 'font-size:13px;letter-spacing:6px;color:#b3413b;');
  const later = line('A few hours later...', 'font-size:22px;letter-spacing:3px;font-style:italic;');
  const clock = line('1:30 AM', 'font-size:46px;letter-spacing:12px;');
  document.body.appendChild(el);
  return {
    async play(wait) {
      el.getBoundingClientRect(); // commit opacity 0 so the fades run
      chapter.style.opacity = '1';
      await wait(0.9);
      later.style.opacity = '1';
      await wait(1.7);
      clock.style.opacity = '1';
      await wait(2.4);
      el.style.transition = 'opacity 1s ease';
      el.style.opacity = '0';
      await wait(1.0);
      el.remove();
    },
  };
}

export class Chapter2 {
  /**
   * @param {object} ctx
   * @param {THREE.WebGLRenderer} ctx.renderer
   * @param {THREE.PerspectiveCamera} ctx.camera
   * @param {import('./player.js').Player} ctx.player
   * @param {object} ctx.world - Chapter 1's world (the surface scene)
   * @param {import('./cutscene.js').CutsceneDirector} ctx.director - fader, camera moves, the tree door
   * @param {import('./stealth.js').StealthSystem} ctx.stealth
   * @param {object} ctx.dialogue
   * @param {(s: number) => Promise<void>} ctx.wait - game-time wait
   * @param {object} ctx.ui - { setObjective, hideObjective, showMessage, setFlashlight, setNight, setScene, onChapterComplete }
   */
  constructor({ renderer, camera, player, world, director, stealth, dialogue, wait, ui }) {
    Object.assign(this, { renderer, camera, player, world, director, stealth, dialogue, wait, ui });
    this.lab = null;
    this.combat = null;
    this.location = 'none'; // none | surface | lab
    // card | surface | hatch | opening | climb | entering | descending | lab | terminal |
    // coach | armory | waves | boss | usb | ending | complete
    this.phase = 'inactive';
    this.cutscene = false;
    this.download = { progress: 0, target: 0 };
    this.barks = new Set();
    this.climb = null;
    this.insert = null;
    this.climbers = [];
    this.hatchHitbox = null;
    this.surfaceLight = null;
    this.wave = null; // { index, t, spawned, startProgress, kills }
    this.kills = 0;
    this._tmp = new THREE.Vector3();
    this._follow = new THREE.Vector3();
    this._ripLook = new THREE.Vector3();
    this.bossStage = 0; // 1 exposed, 2 pillar shield, 3 exposed again
    this.adds = null;
    this.reinforce = null;
    this._bossHatchCloseT = 0;
    this._tornCables = null;
  }

  get active() {
    return this.phase !== 'inactive';
  }

  // ---- Start: straight after the car getaway, or from Chapter Select --------------

  async start() {
    this.phase = 'card';
    this.cutscene = true;
    this.director.fader.set(1);
    this.player.setInputLocked(true);
    const card = createTimeCard();
    this._prepareSurface();
    if (!this.lab) {
      this.lab = buildLab(); // built behind the black screen
      this.combat = new CombatSystem({ scene: this.lab.scene, camera: this.camera, player: this.player, ben: this.lab.ben });
      this._setupCombat();
    }
    this.renderer.compile(this.worldScene, this.camera);
    await card.play(this.wait);
    await this._playSurface();
  }

  get worldScene() {
    return this.world.tree.group.parent;
  }

  _setupCombat() {
    const c = this.combat;
    c.spots = COMBAT_SPOTS.map(([x, z]) => ({ pos: new THREE.Vector3(x, 0, z), taken: null }));
    c.coverSlots = COVER_SLOTS.map(([x, z]) => ({ pos: new THREE.Vector3(x, 0, z), taken: null }));
    c.navigate = (from, to, cover) => labRoute(from, to, cover, this.lab.pillars[0].fallen);
    c.onKill = () => this._onKill();
    c.onPlayerDown = () => this._playerDown();
    c.onBossPhase = (phase) => this._bossPhase(phase);
    c.onBossStunned = () => this._bossStunned();
    c.onBossDefeated = () => this._bossDefeated();
    c.onArmorHit = (owner) => this._armorHit(owner);
    c.onBottleBlocked = () => this._hint('bottleBlocked', "It's blocking the water with that pillar! Break it first!");
    c.onPillarDamaged = (stage) => this._bark('Other Ben', stage === 1 ? "It's coming apart! Keep shooting!" : 'Almost through! Keep it up!', true);
    c.onBashed = () => this._hint('bashed', "Don't let the shield ones get that close! Back off and shoot their feet!");
    this._slabs = [
      new THREE.Box3(new THREE.Vector3(-40, -1, -70), new THREE.Vector3(40, 0, 10)), // floor
      new THREE.Box3(new THREE.Vector3(-HALL.half, HALL.height, ROOM.nearZ), new THREE.Vector3(HALL.half, HALL.height + 0.5, HALL.nearZ)),
      new THREE.Box3(new THREE.Vector3(-ROOM.half, ROOM.height, ROOM.backZ), new THREE.Vector3(ROOM.half, ROOM.height + 0.5, ROOM.nearZ)),
    ];
    this._refreshColliders();
  }

  /** After anything solid changes (the pillar coming down). */
  _refreshColliders() {
    this.combat.setWorldColliders(this.lab.colliders, this._slabs);
    if (this.location === 'lab') this.player.setColliders(this.lab.colliders);
  }

  /** The grounds at 1:30 AM: empty, dark, still raining. Ben & Ben by the oak. */
  _prepareSurface() {
    const { world, stealth, player, director, camera } = this;
    const { ben, coach, coachLage, coachTom, runners, students } = world.npcs;

    stealth.stop();
    stealth.guards.forEach((g) => {
      g.takeover();
      g.lightOff();
      g.aimOverride = null;
      g.mark.visible = false;
    });
    // Everyone's gone home. (Coach Billing never came back up.)
    [coach, coachLage, coachTom, ...runners, ...students].forEach((npc) => {
      npc.cancelExit = true;
      npc.stop();
      npc.faceTowards(null);
      npc.mesh.visible = false;
    });

    // Undo the car ending's camera (zoomed in, locked in the passenger seat).
    director.camMove = null;
    director.zoom = null;
    director._benTargetY = null;
    camera.fov = 75;
    camera.updateProjectionMatrix();
    world.rain.exposureOverride = null;
    this.ui.setNight();
    document.getElementById('hud').classList.remove('hidden');
    this.ui.hideObjective();

    // Stand a few meters out from the hidden door, facing it.
    const treePos = world.tree.group.position;
    const dir = director.doorway.clone().sub(treePos).setY(0).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const spot = treePos.clone().addScaledVector(dir, 9.5);
    player.crouching = false;
    player.eyeHeight = 1.7;
    player.setCameraOverride(false);
    player.setLookTarget(null);
    player.teleport(spot, yaw, -0.03);
    this.ui.setFlashlight(true);

    ben.stop();
    ben.faceTowards(null);
    const rig = ben.mesh.userData.rig;
    if (rig.seated) standUp(ben.mesh);
    rig.crouch = false;
    const left = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    ben.mesh.position.copy(spot).addScaledVector(left, 1.3).addScaledVector(dir, -0.4).setY(0);
    ben.mesh.rotation.y = Math.atan2(treePos.x - ben.mesh.position.x, treePos.z - ben.mesh.position.z);
    ben.mesh.visible = true;
    if (!this.surfaceLight) this.surfaceLight = new HandFlashlight(this.worldScene, ben);
    this.surfaceLight.setOn(true);

    // [E] target on the trunk's hidden door.
    if (!this.hatchHitbox) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.7), new THREE.MeshBasicMaterial({ visible: false }));
      box.position.copy(director.doorway).setY(1.1);
      box.rotation.y = yaw;
      box.userData = { interactable: true, label: 'Press the knot in the bark', type: 'ch2-hatch' };
      this.worldScene.add(box);
      this.hatchHitbox = box;
      this._hatchMarker = director.doorway.clone().addScaledVector(dir, 0.35).setY(2.75);
    }
    player.setInteractables([]);
    this.location = 'surface';
  }

  async _playSurface() {
    const { director, dialogue, player, ui } = this;
    const ben = this.world.npcs.ben;
    this.phase = 'surface';
    await director.fader.to(0, 2.2);
    await dialogue.say('Other Ben (whispering)', '1:30 AM. The whole school is dead.', { style: 'whisper' });
    await dialogue.say('Other Ben', "Coach's car is still in the lot. He never came back up.");
    this.phase = 'hatch';
    this.cutscene = false;
    player.setInputLocked(false);
    player.setInteractables([this.hatchHitbox]);
    ui.setObjective('Open the hidden door in the oak tree.');
    ben.faceTowards(director.doorway);
    dialogue.say('Other Ben', 'He pressed something on the bark, right by that seam. Try it.');
  }

  async _openHatch() {
    const { director, dialogue, wait, player, ui } = this;
    const ben = this.world.npcs.ben;
    this.phase = 'opening';
    this.cutscene = true;
    dialogue.finish();
    player.setInputLocked(true);
    ui.hideObjective();

    // You step back to one side while it grinds open; Ben comes in on the other
    // (you're usually standing right where he needs to walk).
    const treePos = this.world.tree.group.position;
    const dir = director.doorway.clone().sub(treePos).setY(0).normalize();
    const lateral = new THREE.Vector3(dir.z, 0, -dir.x);
    const side = Math.sign(ben.position.clone().sub(treePos).dot(lateral)) || 1;
    const viewSpot = treePos.clone().addScaledVector(dir, 4.4).addScaledVector(lateral, -side * 0.9);
    const benApproach = treePos.clone().addScaledVector(dir, 2.9).addScaledVector(lateral, side * 0.6);
    player.setLookTarget(director.doorLook);
    player.moveTo(viewSpot, 2.0);
    await director.treeDoor.open();
    await dialogue.say('Other Ben', "No way. It's actually real...");

    // Ben goes down first.
    player.setLookTarget(() => ben.headPosition(this._tmp));
    await ben.moveTo(benApproach.x, benApproach.z, 1.6);
    ben.faceTowards(director.doorway);
    await dialogue.say('Other Ben', "There's a ladder in there. It goes way down. I'll go first.");
    await ben.moveTo(director.doorway.x, director.doorway.z, 1.2);
    const clanks = (async () => {
      for (let i = 0; i < 5; i++) {
        await wait(0.42);
        playLadderStep(0.88 + (i % 2) * 0.1);
      }
    })();
    await director.descend(ben);
    await clanks;

    player.setLookTarget(null);
    player.setInputLocked(false);
    this.cutscene = false;
    this.phase = 'climb';
    this.hatchHitbox.userData.label = 'Climb down the ladder';
    ui.setObjective('Climb down the ladder after Ben.');
  }

  async _climbDown() {
    const { director, player, wait, ui, camera } = this;
    this.phase = 'entering';
    this.cutscene = true;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    ui.hideObjective();
    const eye = director.doorApproach.clone().setY(1.7);
    player.setLookTarget(director.doorLook);
    await director.moveCamera([eye], [Math.max(0.6, camera.position.distanceTo(eye) / 2.5)]);
    player.setLookTarget(director.inside.clone().setY(-1.5)); // peer down into the dark
    await wait(0.5);
    playLadderStep(1);
    await director.fader.to(1, 0.8);
    await this._enterLab();
  }

  // ---- Underground --------------------------------------------------------------

  async _enterLab() {
    const { player, camera, ui, director, dialogue } = this;
    const lab = this.lab;
    this.phase = 'descending';
    this.surfaceLight.setOn(false);
    this.location = 'lab';
    ui.setScene(lab.scene); // camera (+ its flashlight) and the objective marker move into the lab
    player.setColliders(lab.colliders);
    player.setInteractables(lab.interactables);
    player.setCharacters([lab.ben]);
    setUnderground(true);
    ui.setFlashlight(true);

    // Ben's already at the bottom, shining his light down the corridor.
    lab.ben.stop();
    lab.ben.mesh.position.set(0.75, 0, 0.35);
    lab.ben.mesh.rotation.y = Math.PI;
    lab.benLight.setOn(true);

    // Top of the shaft, facing the rungs.
    camera.position.set(0, CLIMB.startY, CLIMB.z);
    player.setLook(Math.PI, 0.1);
    player.setLookTarget(() => this._tmp.set(0, camera.position.y + 0.15, LADDER_Z));
    // Build every shader now (lab, fight effects, the rifle) so nothing hitches mid-fight.
    this.combat.prewarm(true);
    this.renderer.compile(lab.scene, camera);
    this.renderer.compile(this.combat.rifle.scene, this.combat.rifle.camera);
    this.combat.prewarm(false);
    director.fader.to(0, 1.2);
    await this._descendLadder();

    // Step off and turn around: the corridor.
    player.setLookTarget(new THREE.Vector3(0, 1.5, -24));
    await director.moveCamera([new THREE.Vector3(0.1, 1.7, 1.7)], [1.2]);
    await dialogue.say('Other Ben (whispering)', 'Dude... what IS this place?', { style: 'whisper' });
    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    this.cutscene = false;
    this.phase = 'lab';
    lab.ben.follow(() => this._benFollowPoint(), 5.5);
    ui.setObjective('Find out what Coach is hiding down here.');
  }

  _descendLadder() {
    const steps = Math.round((CLIMB.startY - CLIMB.endY) / CLIMB.step);
    return new Promise((resolve) => {
      this.climb = { t: 0, steps, stepIndex: -1, lookedDown: false, lookUntil: 0, resolve };
    });
  }

  /** Rung by rung: a stepped drop with a little sway, a clank per step, one glance down. */
  _updateClimb(dt) {
    const c = this.climb;
    if (!c) return;
    const cam = this.camera.position;
    c.t += dt;
    const k = c.t / CLIMB.stepTime;
    const n = Math.floor(k);
    if (n >= c.steps) {
      cam.set(0, CLIMB.endY, CLIMB.z);
      this.climb = null;
      c.resolve();
      return;
    }
    cam.y = CLIMB.startY - CLIMB.step * (n + smooth(k - n));
    cam.x = Math.sin((c.t * Math.PI) / CLIMB.stepTime) * 0.025;
    if (n !== c.stepIndex) {
      c.stepIndex = n;
      playLadderStep(n % 2 ? 0.94 : 1.06);
    }
    if (!c.lookedDown && n / c.steps > 0.45) {
      c.lookedDown = true;
      c.lookUntil = c.t + 1.4;
      this.player.setLookTarget(new THREE.Vector3(0.4, 0, 0.6)); // Ben's light and the cyan glow below
    }
    if (c.lookUntil && c.t > c.lookUntil) {
      c.lookUntil = 0;
      this.player.setLookTarget(() => this._tmp.set(0, cam.y + 0.15, LADDER_Z));
    }
  }

  /** Other Ben follows at your left shoulder, kept on the walkway between the pods. */
  _benFollowPoint() {
    const yaw = this.player.getYaw();
    const p = this.player.object.position;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const lx = -Math.cos(yaw);
    const lz = Math.sin(yaw);
    const z = Math.min(p.z + lz * 1.1 - fz * 0.9, SHAFT.backZ - 0.6);
    let half = HALL.half - 2.0;
    if (z < ROOM.nearZ - 0.4) half = ROOM.half - 0.8;
    else if (z < ROOM.nearZ + 0.4) half = BULKHEAD.half - 0.5;
    const x = THREE.MathUtils.clamp(p.x + lx * 1.1 - fx * 0.9, -half, half);
    return this._follow.set(x, 0, z);
  }

  _updateLabTriggers() {
    const { x, z } = this.player.object.position;
    const bark = (id, when, speaker, line, options) => {
      if (when && !this.barks.has(id) && !this.dialogue.active) {
        this.barks.add(id);
        this.dialogue.say(speaker, line, options);
      }
    };
    bark('pods', z < -5.5, 'Other Ben', 'Are those... robots? Floating in tanks?');
    bark('eldar', z < -15, 'Other Ben', '"ELDAR." It\'s stamped on every single one of them.');
    bark('room', z < -28, 'Other Ben (whispering)', 'There\'s a huge room up ahead. The lights are on.', { style: 'whisper' });
    bark('chamber', z < ROOM.nearZ - 3, 'Other Ben', 'Whoa. Look at the size of this place.');
    if (z < TERMINAL_TRIGGER_Z && Math.abs(x) < ROOM.half - 0.5) this._playTerminal();
  }

  // ---- The terminal: Ben finds the drive and picks the attack mode --------------

  async _playTerminal() {
    const { player, dialogue, wait, director, ui, camera } = this;
    const lab = this.lab;
    const ben = lab.ben;
    const rig = ben.mesh.userData.rig;
    const screen = lab.screen;
    this.phase = 'terminal';
    this.cutscene = true;
    dialogue.finish();
    player.setInputLocked(true);
    player.setCameraOverride(true);
    ui.hideObjective();

    // Ben heads straight for the console (jogging if you ran ahead of him);
    // you drift over his shoulder.
    if (ben.position.z > ROOM.nearZ + 8) ben.mesh.position.set(-0.6, 0, ROOM.nearZ + 1.5); // way behind: catch up out of view
    player.setLookTarget(() => ben.headPosition(this._tmp));
    const glide = Math.max(1.0, camera.position.distanceTo(TERMINAL_VANTAGE) / 2.2);
    const benDist = Math.hypot(ben.position.x - BEN_TYPING_SPOT.x, ben.position.z - BEN_TYPING_SPOT.z);
    await Promise.all([
      ben.moveTo(BEN_TYPING_SPOT.x, BEN_TYPING_SPOT.z, THREE.MathUtils.clamp(benDist / 3.2, 2.2, 6)),
      director.moveCamera([TERMINAL_VANTAGE.clone()], [glide]),
    ]);
    ben.faceTowards(new THREE.Vector3(0, 0, DESK.z - 1));
    await dialogue.say('Other Ben', 'This must be where Coach runs everything from.');
    player.setLookTarget(SCREEN_CENTER);
    await dialogue.say('Other Ben', '"Insert authorization media"? Great. We don\'t have any...', { hold: 1.4 });

    // He feels around under the desk... and finds a thumb drive taped there.
    lab.benLight.setOn(false);
    rig.crouch = true;
    rig.reach = true;
    player.setLookTarget(new THREE.Vector3(0.1, 0.75, DESK.front));
    await dialogue.say('Other Ben', "Hold on. There's something taped under here...", { hold: 1.0 });
    await wait(0.3);
    const drive = lab.drive;
    rig.handR.add(drive);
    drive.position.set(0, -0.085, 0.02);
    drive.rotation.set(-Math.PI / 2, 0, 0); // plug pointing out past his fingers
    drive.visible = true;
    playBeep(300, 0.04, 0.05); // tape tearing loose
    rig.crouch = false;
    rig.reach = false;
    await wait(0.7);
    player.setLookTarget(() => rig.handR.getWorldPosition(this._tmp));
    director.zoomTo(46, 0.8);
    await dialogue.say('Other Ben', 'A thumb drive.', { hold: 0.9 });

    // Plugs it into the console.
    director.zoomTo(75, 0.8);
    rig.reach = true;
    player.setLookTarget(new THREE.Vector3(PORT.x, 1.0, PORT.z));
    await wait(0.55);
    await this._insertDrive();
    playUsbInsert();
    rig.reach = false;
    screen.setState('reading');
    player.setLookTarget(SCREEN_CENTER);
    await wait(1.6);

    // The payload menu. He scrolls straight to the last option.
    screen.menuIndex = 0;
    screen.setState('menu');
    playBeep(880, 0.06);
    rig.typing = true;
    await wait(0.9);
    for (let i = 1; i < MENU_OPTIONS.length; i++) {
      screen.setMenuIndex(i);
      playBeep(1250, 0.05, 0.07);
      await wait(0.6);
    }
    rig.typing = false;
    director.zoomTo(55, 1.5);
    await dialogue.say('Other Ben', '"Download Attack Mode. Target: Coach Billing."', { hold: 1.4 });
    await wait(0.4);
    await dialogue.say('Other Ben (quietly)', '...Strike three, Coach.', { style: 'whisper', hold: 1.3 });
    rig.typing = true;
    await wait(0.35);
    playBeep(1600, 0.12, 0.12);
    screen.setState('confirm');
    rig.typing = false;
    await wait(1.1);

    // [Download Attack Mode: Target -> Coach Billing] -> 0%
    this._startDownload();
    await wait(1.6);
    director.zoomTo(75, 1.0);
    await this._playCoachScene();
  }

  /** Move the drive from Ben's hand into the port. Resolves once it's seated. */
  _insertDrive() {
    const drive = this.lab.drive;
    this.lab.scene.attach(drive); // keep its world transform while leaving his hand
    return new Promise((resolve) => {
      this.insert = {
        t: 0,
        from: drive.position.clone(),
        fromQ: drive.quaternion.clone(),
        to: new THREE.Vector3(PORT.x, PORT.y, DESK.front + 0.051),
        resolve,
      };
    });
  }

  _updateInsert(dt) {
    const ins = this.insert;
    if (!ins) return;
    const drive = this.lab.drive;
    ins.t += dt;
    const k = smooth(Math.min(1, ins.t / 0.4));
    drive.position.lerpVectors(ins.from, ins.to, k);
    drive.quaternion.slerpQuaternions(ins.fromQ, _q.identity(), k);
    if (ins.t >= 0.4) {
      drive.userData.plugged = true;
      this.insert = null;
      ins.resolve();
    }
  }

  _startDownload() {
    const lab = this.lab;
    lab.screen.progress = 0;
    lab.screen.setState('download');
    lab.setWallAlert(true);
    playDownloadStart();
    this.download = { progress: 0, target: 0, shown: -1 };
  }

  // ---- Camera helpers for the cut-heavy scenes -----------------------------------

  /** Place the camera at `pos` looking at `look` (Vector3 or () => Vector3), then keep tracking it. */
  _place(pos, look) {
    this.camera.position.copy(pos);
    const t = typeof look === 'function' ? look() : look;
    const dx = t.x - pos.x;
    const dy = t.y - pos.y;
    const dz = t.z - pos.z;
    this.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    this.player.setLookTarget(look);
  }

  /** Quick dip to black, cut, back. */
  async _cutTo(pos, look) {
    await this.director.fader.to(1, 0.18);
    this._place(pos, look);
    await this.director.fader.to(0, 0.22);
  }

  /** A character going up/down the ladder in the climbing pose; resolves at the end. */
  _climbLadder(character, fromY, toY, seconds) {
    character.stop();
    character.faceTowards(null);
    character.mesh.userData.rig.climbing = true;
    character.mesh.position.set(0, fromY, LADDER_Z - 0.38);
    character.mesh.rotation.y = 0; // facing the rungs
    return new Promise((resolve) => this.climbers.push({ character, fromY, toY, t: 0, seconds, resolve }));
  }

  _updateClimbers(dt) {
    for (let i = this.climbers.length - 1; i >= 0; i--) {
      const c = this.climbers[i];
      c.t += dt;
      const k = Math.min(1, c.t / c.seconds);
      c.character.mesh.position.y = THREE.MathUtils.lerp(c.fromY, c.toY, k);
      if (k >= 1) {
        c.character.mesh.userData.rig.climbing = false;
        this.climbers.splice(i, 1);
        c.resolve();
      }
    }
  }

  // ---- Coach Billing's visit ---------------------------------------------------------

  async _playCoachScene() {
    const { player, dialogue, wait, ui } = this;
    const lab = this.lab;
    const coach = lab.coach;
    const ben = lab.ben;
    const head = (c) => () => c.headPosition(this._tmp);
    const shaftCam = new THREE.Vector3(0.75, 1.25, 1.2); // down in the shaft, looking up the ladder
    const chamberCam = new THREE.Vector3(1.6, 1.72, DESK.front + 3.2);
    this.phase = 'coach';

    await wait(0.8);
    playMechanism(1.4); // far above: the tree hatch grinding open
    await wait(0.8);
    await dialogue.say('Other Ben (whispering)', '...Did you hear that? The hatch.', { style: 'whisper', hold: 1.2 });

    // The shaft: Coach coming down the ladder.
    coach.mesh.visible = true;
    const climbDown = this._climbLadder(coach, SHAFT.height - 1.6, 0, 4.2);
    await this._cutTo(shaftCam, head(coach));
    await climbDown;
    coach.mesh.rotation.y = Math.PI; // turns to the corridor
    await dialogue.say('Coach Billing', "I know you're down here, boys.", { hold: 1.2 });

    // The chamber: he walks in through the bulkhead.
    coach.mesh.position.set(0, 0, ROOM.nearZ + 1.2);
    coach.mesh.rotation.y = Math.PI;
    ben.faceTowards(coach.position);
    const walkIn = coach.moveTo(0.4, -48.5, 2.0);
    await this._cutTo(chamberCam, head(coach));
    await walkIn;
    coach.faceTowards(chamberCam);
    coach.mesh.userData.rig.pointing = true;
    await dialogue.say('Coach Billing', 'Well, well. The Bens. Skipping practice AND breaking into my lab?');
    await dialogue.say('Coach Billing', "That's strike three, Ben. You're OFF the team.", { hold: 1.4 });
    coach.mesh.userData.rig.pointing = false;
    await dialogue.say('Other Ben', 'What IS all this, Coach?!', { hold: 1.0 });
    // He glances up at the big red display over the console.
    const display = new THREE.Vector3(0, 4.3, ROOM.backZ);
    coach.faceTowards(display);
    player.setLookTarget(display);
    await dialogue.say('Coach Billing', '"Attack Mode"... targeting ME? Cute.', { hold: 1.3 });
    coach.faceTowards(chamberCam);
    player.setLookTarget(head(coach));
    await dialogue.say('Coach Billing', 'You boys have no idea what you just woke up.', { hold: 1.3 });
    const leave = coach.moveTo(0, ROOM.nearZ + 1.2, 3.8);
    await dialogue.say('Coach Billing', 'Enjoy the rest of your very short night.', { hold: 1.0 });
    await leave;

    // The shaft again: back up the ladder, and the hatch slams and bolts.
    const climbUp = this._climbLadder(coach, 0, SHAFT.height - 1.4, 2.8);
    await this._cutTo(shaftCam, head(coach));
    await climbUp;
    coach.mesh.visible = false;
    playHatchSlam();
    lab.setShaftHatch(false);
    await wait(0.6);
    await dialogue.say('Coach Billing (above)', 'Deploy the ELDAR units!', { hold: 1.5 });

    // Lockdown: alarms, red light, every unit in every pod wakes up.
    startAlarm();
    lab.setLockdown(true);
    lab.setAlert(1);
    lab.screen.lockdown = true;
    const armoryView = new THREE.Vector3(-ROOM.half + 0.5, 1.4, ARMORY_Z);
    await this._cutTo(TERMINAL_VANTAGE, armoryView);
    lab.setArmoryUnlocked(true);
    playBeep(520, 0.12, 0.1);
    ben.faceTowards(armoryView);
    await dialogue.say('Other Ben', 'The armory rack just unlocked! Grab a rifle!', { hold: 1.2 });

    player.setLookTarget(null);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    this.cutscene = false;
    this.phase = 'armory';
    lab.armoryHitbox.userData.label = 'Take an assault rifle';
    ui.setObjective('Grab an assault rifle from the armory.');
  }

  /** [E] at the rack: you take one rifle, Ben takes the other and gets behind his crate. */
  async _takeRifle() {
    const { lab, combat, dialogue } = this;
    const ben = lab.ben;
    this.phase = 'arming';
    lab.rifles[0].visible = false;
    lab.armoryHitbox.userData.label = 'Rifle rack (empty)';
    this.player.currentTarget = null; // re-read the prompt label next frame
    combat.rifle.equip();
    combat.start();
    playReloadStep('rack');
    this._refreshDefendObjective();

    lab.benLight.setOn(false);
    await ben.moveTo(-ROOM.half + 1.2, ARMORY_Z + 0.5, 3.4);
    lab.rifles[1].visible = false;
    combat.benGunner.arm();
    playReloadStep('rack');
    const toCover = ben.moveTo(BEN_COVER_SPOT.x, BEN_COVER_SPOT.z, 3.4);
    dialogue.say('Other Ben', 'Here they come! Protect the download!', { hold: 1.3 });
    await toCover;
    ben.faceTowards(new THREE.Vector3(0, 0, ROOM.nearZ));
    combat.benGunner.firing = true;
    this._startWave(0);
  }

  _refreshDefendObjective() {
    this.ui.setObjective('Defend the terminal until the download finishes!', [
      { label: `Download: ${Math.floor(this.download.progress)}%`, done: false },
      { label: 'Headshots hit harder. [R] reloads', tip: true },
      ...(this.seenShield ? [{ label: 'Shield units: shoot their feet', tip: true }] : []),
    ]);
  }

  // ---- The waves ------------------------------------------------------------------

  /** Non-blocking line from Ben (skipped if someone's mid-sentence, unless `force`). */
  _bark(speaker, line, force = false) {
    if (this.dialogue.active && !force) return;
    this.dialogue.say(speaker, line, { hold: Math.max(1.6, line.split(/\s+/).length * 0.28) });
  }

  /** A one-time tip from Ben. */
  _hint(id, line) {
    if (this.barks.has(id)) return;
    this.barks.add(id);
    this._bark('Other Ben', line, true);
  }

  _startWave(index) {
    const def = WAVES[index];
    this.phase = 'waves';
    this.waveToken = (this.waveToken || 0) + 1;
    this.wave = { index, def, t: 0, next: 0, startProgress: this.download.target, startKills: this.kills, introDone: false, clearing: false };
    if (def.intro === 'ladder' && !this._ladderShown) this._playLadderCutaway();
    else if (def.intro === 'pillar' && !this.lab.pillars[0].fallen) this._pillarFall();
    else this.wave.introDone = true;
  }

  _updateWave(dt) {
    const w = this.wave;
    if (!w || this.phase !== 'waves' || !w.introDone) return;
    w.t += dt;
    const spawns = w.def.spawns;
    // On schedule, but never more than `cap` alive at once (the rest wait their turn).
    while (w.next < spawns.length && w.t >= spawns[w.next].at && this.combat.aliveCount < w.def.cap) this._spawn(spawns[w.next++]);
    if (w.next < spawns.length && this.combat.aliveCount >= w.def.cap) w.t = Math.min(w.t, spawns[w.next].at); // the timeline waits
    if (w.next >= spawns.length && !w.clearing && this.combat.aliveCount === 0) {
      w.clearing = true;
      this._waveCleared(this.waveToken);
    }
  }

  async _waveCleared(token) {
    const next = this.wave.index + 1;
    await this.wait(1.4);
    if (token !== this.waveToken) return; // a retry restarted things meanwhile
    const lines = [
      "That's all of them... no wait, more are coming!",
      "Download's almost halfway! Keep them off the terminal!",
      'So close! One more wave!',
    ];
    if (next < WAVES.length) {
      this._bark('Other Ben', lines[next - 1], true);
      await this.wait(2.6);
      if (token !== this.waveToken) return;
      this._startWave(next);
    } else {
      this._startBoss();
    }
  }

  /** Bring one unit in: out of a pod, down the ladder, or through a side door. */
  _spawn(def) {
    const { lab, combat } = this;
    let entry;
    if (def.from === 'pod') {
      const pod = lab.openPod(def.pod);
      entry = { kind: 'pod', pos: pod.pos, yaw: pod.yaw };
      if (pod.fresh) {
        playPodOpen();
        combat.effects.spark(pod.pos.clone().setY(1.5), { count: 24, color: 0xcff4ff, speed: 2.2, size: 0.16, life: 1.0, gravity: -0.6 }); // venting cold
      }
    } else if (def.from === 'ladder') {
      lab.setShaftHatch(true);
      this._hatchCloseT = 3;
      entry = { kind: 'ladder', top: lab.ladderTop.clone() };
    } else if (def.from === 'drop') {
      // The Titan's ceiling hatch grinds open and one drops straight through it.
      if (lab.bossHatch.target < 1) {
        playMechanism(0.8);
        combat.effects.spark(this._tmp.set(BOSS_HATCH.x, ROOM.height - 0.2, BOSS_HATCH.z), { count: 14, color: 0xffd08a, speed: 3, size: 0.07, life: 0.5 });
      }
      lab.bossHatch.target = 1;
      this._bossHatchCloseT = 2.6;
      entry = { kind: 'drop', at: lab.dropSpots[(def.spot || 0) % lab.dropSpots.length] };
    } else {
      const door = lab.doors[def.door];
      door.openFor(3.2);
      entry = { kind: 'door', inside: door.inside.clone(), out: door.out.clone(), yaw: door.yaw };
    }
    const unit = combat.spawnUnit(def.type, entry, { cover: def.cover });
    if (def.type === 'shield' && !this.seenShield) {
      this.seenShield = true;
      this._bark('Other Ben', "That one's got a shield! Shoot its feet!", true);
      if (this.phase === 'waves') this._refreshDefendObjective();
    }
    return unit;
  }

  _onKill() {
    this.kills++;
    if (this.phase === 'waves') {
      // Every unit down pushes the download along; the whole horde gets it to 99%.
      this.download.target = Math.min(99, Math.round((this.kills / TOTAL_UNITS) * 99));
      if (Math.random() < 0.22) this._bark('Other Ben', ['Got one!', 'Nice shot!', 'Keep it up!', 'Another one down!'][Math.floor(Math.random() * 4)]);
    }
  }

  /** Wave 2: a cutaway to the shaft as the first ELDARs drop down the ladder. */
  async _playLadderCutaway() {
    const { player } = this;
    this._ladderShown = true;
    this.cutscene = true;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    const back = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    this._bark('Other Ben', "Something's coming down the ladder!", true);
    await this._cutTo(new THREE.Vector3(1.0, 0.5, 1.1), new THREE.Vector3(0, 7.5, LADDER_Z - 0.3));
    this.wave.introDone = true; // the first two drop right in front of you
    await this.wait(3.4);
    await this.director.fader.to(1, 0.18);
    this.camera.position.copy(back.pos);
    this.camera.quaternion.copy(back.quat);
    player.setLookTarget(null);
    await this.director.fader.to(0, 0.22);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    this.cutscene = false;
  }

  /** Wave 3 (halfway): the left display pillar topples across the exit. */
  async _pillarFall() {
    const { lab, combat } = this;
    const pillar = lab.pillars[0];
    const base = new THREE.Vector3(-PILLAR.x, 0.5, PILLAR.z);
    this._bark('Other Ben', "Look out! That pillar's coming down!", true);
    playPillarFall();
    combat.effects.spark(base, { count: 24, color: 0x9fe8ff, speed: 4, size: 0.08, life: 0.5 });
    combat.effects.flash(base, { size: 2, color: 0x9fe8ff, life: 0.2 });
    await pillar.fall();
    // Impact: glass everywhere, fluid across the floor, the whole room shakes.
    combat.shake(1.3);
    for (let i = 0; i < 6; i++) {
      combat.effects.spark(new THREE.Vector3(-2.6 + i * 0.95, 0.8, PILLAR.z), { count: 10, color: 0xcff4ff, speed: 4, size: 0.08, life: 0.6 });
    }
    combat.effects.ring(new THREE.Vector3(-0.2, 0, PILLAR.z), { from: 1, to: 6, life: 0.8 });
    this._refreshColliders();
    combat.coverEnabled = true;
    this.wave.introDone = true;
    this._pillarSparks = pillar.hoseEnds;
    await this.wait(3.5);
    this._bark('Other Ben', "It's blocking the exit! They'll hide behind it... wait for them to pop up!", true);
  }

  /** You went down: black, then back at the terminal with this wave (or Titan phase) reset. */
  async _playerDown() {
    const { player, combat, director, lab } = this;
    if (this._retrying) return;
    this._retrying = true;
    Achievements.death(); // (a flawless / single-life run ends here)
    this.cutscene = true;
    player.setInputLocked(true);
    player.crouching = false;
    await director.fader.to(1, 0.7);
    this.waveToken = (this.waveToken || 0) + 1;
    combat.clearCombatants();
    combat.effects.clear();
    combat.resetPlayer();
    combat.rifle.equip();
    player.teleport(DEFEND_SPOT, Math.PI, 0); // facing the entrance (+Z)
    lab.ben.stop();
    lab.ben.mesh.position.copy(BEN_COVER_SPOT);
    lab.ben.faceTowards(new THREE.Vector3(0, 0, ROOM.nearZ));
    combat.frozen = false;
    if (this.phase === 'boss') {
      const titan = combat.titan;
      // Went down between phase 1 and its pillar rip: skip ahead to phase 2 (pillar already off the wall).
      if (this.bossStage === 2 && titan.phase === 1) {
        titan.phase = 2;
        if (lab.tearWallPillar()) this._refreshColliders();
      }
      titan.resetPhase(BOSS_SPOT, Math.PI); // facing you at the terminal (no free shots at its back)
      this.bossStage = titan.phase;
      this.adds = BOSS_ADDS[titan.phase] ? { list: BOSS_ADDS[titan.phase], t: 0, next: 0 } : null;
      this.reinforce = titan.phase === 2 ? { t: 0, next: 3, spawned: 0 } : null;
      this._setBossObjective(titan.phase);
    } else if (this.wave) {
      const w = this.wave;
      this.kills = w.startKills;
      this.download.target = w.startProgress;
      this.download.progress = Math.min(this.download.progress, w.startProgress);
      this.wave = { ...w, t: 0, next: 0, introDone: true, clearing: false };
    }
    await this.wait(0.6);
    await director.fader.to(0, 0.6);
    player.setInputLocked(false);
    this.cutscene = false;
    this._retrying = false;
    this.ui.showMessage(this.phase === 'boss' ? 'You went down! Back at the terminal: the Titan is still up.' : 'You went down! This wave starts over.', 3200);
  }

  // ---- The Titan (download stuck at 99%) ----------------------------------------------

  async _startBoss() {
    const { player, combat, lab, dialogue, director } = this;
    const titan = combat.titan;
    this.phase = 'boss';
    this.bossStage = 1;
    this.reinforce = null;
    this._bossHatchCloseT = 0;
    this.download.target = 99;
    this.cutscene = true;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    const back = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };

    // Watch the ceiling hatch grind open, and the Titan drop through it.
    await this._cutTo(new THREE.Vector3(4.2, 1.7, DESK.front + 6.5), new THREE.Vector3(BOSS_HATCH.x, 6.8, BOSS_HATCH.z));
    this._bark('Other Ben', "It's stuck at 99%! Why did it stop?!", true);
    playMechanism(1.8);
    lab.bossHatch.target = 1;
    await this.wait(1.7);
    titan.drop(BOSS_SPOT, Math.PI); // facing the console
    player.setLookTarget(() => titan.aimPoint(this._tmp));
    await this.wait(3.4); // falls, lands, roars
    lab.bossHatch.target = 0;
    await dialogue.say('Other Ben', 'What. Is. THAT?!', { hold: 1.0 });

    await director.fader.to(1, 0.18);
    this.camera.position.copy(back.pos);
    this.camera.quaternion.copy(back.quat);
    player.setLookTarget(null);
    await director.fader.to(0, 0.22);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    this.cutscene = false;
    titan.aiEnabled = true;

    // Only now can you get at Coach's water bottles.
    if (!lab.interactables.includes(lab.waterHitbox)) lab.interactables.push(lab.waterHitbox);
    player.setInteractables(lab.interactables);
    this._setBossObjective(1);
    this.adds = { list: BOSS_ADDS[1], t: 0, next: 0 };
    const token = this.waveToken;
    await this.wait(2.2);
    if (token === this.waveToken && titan.alive) this._bark('Other Ben', "Coach's water bottles! Water shorts them out... throw one at it!", true);
  }

  _setBossObjective(stage) {
    if (stage === 2) {
      this.ui.setObjective("Break the Titan's pillar shield!", [
        { label: 'Pour fire into the pillar until it breaks apart', tip: true },
        { label: 'Water bottles just shatter on it', tip: true },
        { label: 'More ELDARs keep coming: thin them out', tip: true },
      ]);
      return;
    }
    this.ui.setObjective(stage === 3 ? 'Finish off the ELDAR Titan!' : 'Destroy the ELDAR Titan!', [
      { label: 'Grab a water bottle from the wall rack [E]', tip: true },
      { label: 'Throw it at the Titan [Right Click] to short it out', tip: true },
      { label: "While it's down, shoot the red core on its back", tip: true },
      { label: 'Keep moving between cover: its volleys hit hard', tip: true },
    ]);
  }

  _bossStunned() {
    this._stuns = (this._stuns || 0) + 1;
    if (this._stuns <= 2) this._bark('Other Ben', this._stuns === 1 ? "It's shorting out! Get behind it and shoot that core!" : 'Now! The core!', true);
    else if (this.bossStage === 3 && !this.barks.has('finalStun')) this._hint('finalStun', "It's down again! Finish it!");
  }

  _armorHit(owner) {
    if (owner === this.combat.titan) {
      if (!this._armorHint && this.phase === 'boss') {
        this._armorHint = true;
        this._bark('Other Ben', 'Bullets just bounce off its armor!', true);
      }
    } else if (owner.type === 'shield' && !this._shieldHint) {
      this._shieldHint = true;
      this._bark('Other Ben', 'The shield blocks everything! Go for the feet!', true);
    }
  }

  _bossPhase(phase) {
    if (phase === 2) {
      this._playPillarRip();
    } else if (phase === 3) {
      // The pillar just blew apart: it's exposed again.
      this.bossStage = 3;
      this.reinforce = null;
      this._bark('Other Ben', "The pillar's gone! It's wide open: water, then the core!", true);
      this._setBossObjective(3);
      this.adds = { list: BOSS_ADDS[3], t: 0, next: 0 };
    }
  }

  /** Phase 2: the Titan tears the structural pillar off the wall and carries it as a shield. */
  async _playPillarRip() {
    const { player, combat, lab, director, dialogue } = this;
    const titan = combat.titan;
    const token = this.waveToken;
    this.bossStage = 2;
    this.adds = null;
    this._bark('Other Ben', "Did we get it?! ...No. It's still moving!", true);
    await this.wait(1.6); // its roar
    if (token !== this.waveToken || this.phase !== 'boss' || titan.phase !== 1) return;

    this.cutscene = true;
    combat.frozen = true; // units and bolts hold still; only the Titan's scripted part plays
    combat.bolts.clear();
    combat.rifle.triggerHeld = false;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    const back = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    // Cut (it steps up to the wall while the screen is black).
    await director.fader.to(1, 0.18);
    this._place(RIP_CAM, new THREE.Vector3(WALL_PILLAR.x, 3.0, WALL_PILLAR.z));
    player.setLookTarget(() => this._tmp.lerpVectors(titan.aimPoint(this._tmp), this._ripLook.set(WALL_PILLAR.x, 3.0, WALL_PILLAR.z), 0.45));
    const rip = titan.ripPillar(RIP_STAND, -Math.PI / 2, () => {
      if (lab.tearWallPillar()) this._refreshColliders();
      this._tornCables = lab.tornCables;
    });
    await director.fader.to(0, 0.22);
    await this.wait(1.0);
    this._bark('Other Ben', "It's going for the wall...", true);
    await this.wait(1.4);
    player.setLookTarget(() => titan.aimPoint(this._tmp));
    await rip;
    await dialogue.say('Other Ben', 'It ripped a pillar right out of the WALL!', { hold: 0.9 });

    await director.fader.to(1, 0.18);
    this.camera.position.copy(back.pos);
    this.camera.quaternion.copy(back.quat);
    player.setLookTarget(null);
    await director.fader.to(0, 0.22);
    player.setCameraOverride(false);
    player.setInputLocked(false);
    this.cutscene = false;
    combat.frozen = false;
    if (token !== this.waveToken) return;
    this._setBossObjective(2);
    this.reinforce = { t: 0, next: 1.5, spawned: 0 };
    this._bark('Other Ben', "Bullets and water won't get through that thing! Shoot the pillar apart!", true);
  }

  _updateAdds(dt) {
    const a = this.adds;
    if (!a || this.phase !== 'boss' || this.combat.frozen) return;
    a.t += dt;
    while (a.next < a.list.length && a.t >= a.list[a.next].at) this._spawn(a.list[a.next++]);
  }

  /** Phase 2: a steady stream of ELDARs until the pillar breaks. */
  _updateReinforcements(dt) {
    const r = this.reinforce;
    if (!r || this.phase !== 'boss' || this.combat.frozen) return;
    r.t += dt;
    if (r.t < r.next || this.combat.aliveCount >= REINFORCE.cap) return;
    const def = REINFORCE.rotation[r.spawned % REINFORCE.rotation.length];
    r.spawned++;
    r.next = r.t + REINFORCE.every;
    this._spawn(def);
  }

  async _bossDefeated() {
    const { combat, lab, ui } = this;
    this.phase = 'usb';
    Achievements.unlock('strike_three');
    this.adds = null;
    this.reinforce = null;
    combat.benGunner.firing = false;
    for (const u of combat.units) if (!u.dead) u._die(); // every unit shuts down with it
    stopAlarm();
    lab.setLockdown(false);
    lab.screen.lockdown = false;
    this.download.target = 100;
    await this.wait(2.2);
    this._bark('Other Ben', "It's down... and the download just hit 100%!", true);
    lab.terminalHitbox.userData.label = 'Take USB Drive';
    this.player.currentTarget = null; // re-read the prompt label next frame
    ui.setObjective('Take the USB drive from the terminal.');
  }

  // ---- Chapter 2 ending ---------------------------------------------------------------

  async _playEnding() {
    const { player, dialogue, director, wait, lab, combat, ui } = this;
    const ben = lab.ben;
    const rig = ben.mesh.userData.rig;
    this.phase = 'ending';
    this.cutscene = true;
    player.setInputLocked(true);
    player.setCameraOverride(true);
    combat.stop();
    ui.hideObjective();

    // Ben runs over and yanks the drive out of the console. (Cut to the
    // over-the-shoulder view first: you're standing right where he needs to be.)
    rig.aiming = false;
    combat.benGunner.rifle.visible = false;
    await this._cutTo(TERMINAL_VANTAGE.clone(), () => ben.headPosition(this._tmp));
    await ben.moveTo(PORT.x - 0.1, DESK.front + 0.55, 4.8);
    ben.faceTowards(new THREE.Vector3(PORT.x, 0, DESK.z - 1));
    rig.reach = true;
    await wait(0.45);
    const drive = lab.drive;
    drive.userData.plugged = false;
    rig.handR.add(drive);
    drive.position.set(0, -0.085, 0.02);
    drive.rotation.set(-Math.PI / 2, 0, 0);
    playUsbInsert();
    rig.reach = false;
    await dialogue.say('Other Ben', 'Got it!', { hold: 0.7 });

    // Both of you sprint for the ladder (around the fallen pillar, out the bulkhead).
    // (Around the right barrier's end, past the crate, into the pocket, out the door.)
    const route = [
      [3.4, -51.5], [5.3, -50.2], [5.3, -43.2], [4.95, -40.4], [4.9, -37.3], [1.0, -36.8], [0, -34.5], [0, -18], [0, -4],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));
    ben.walkRoute(route, 6.6);
    await director.fader.to(1, 0.18);
    combat.titan.park(); // its wreck would be in the way of the camera
    // You start just behind him and he pulls ahead: looking at him = looking at the way out.
    this._place(new THREE.Vector3(1.6, 1.7, DESK.front + 0.4), () => ben.headPosition(this._tmp));
    await director.fader.to(0, 0.22);
    const cam = [[3.4, -52.2], [5.3, -50.3], [5.3, -43.3], [4.95, -40.3], [4.95, -37.5], [1.2, -36.9], [0.2, -33.8], [0, -21]]
      .map(([x, z]) => new THREE.Vector3(x, 1.7, z));
    let from = this.camera.position.clone();
    const durations = cam.map((p) => {
      const d = p.distanceTo(from) / 6.2;
      from = p;
      return d;
    });
    const run = director.moveCamera(cam, durations);
    await wait(0.8);
    await dialogue.say('Other Ben', 'We need to upload this to the school Wi-Fi to turn the ELDARs against Coach!', { hold: 2.2 });
    await Promise.race([run, wait(3)]);
    await director.fader.to(1, 1.2);
    dialogue.finish();
    this.phase = 'complete';
    ui.onChapterComplete();
  }

  // ---- Hooks main.js calls -------------------------------------------------------

  _updateDownload(dt) {
    const d = this.download;
    if (d.progress < d.target) {
      // Counts up steadily rather than jumping.
      d.progress = Math.min(d.target, d.progress + Math.max(3, (d.target - d.progress) * 2) * dt);
    }
    const lab = this.lab;
    lab.screen.progress = d.progress;
    const pct = Math.floor(d.progress);
    if (pct === d.shown) return;
    d.shown = pct;
    lab.status.progress = d.progress;
    setDownloadCharge(d.progress / 100);
    this.combat.hud.setDownload(d.progress);
    if (this.phase === 'waves') this._refreshDefendObjective();
    if (pct >= 100) lab.screen.setState('complete');
  }

  update(dt) {
    if (this.location === 'surface') {
      for (const u of this.world.updatables) u.update(dt); // rain, NPCs, doors
      if (this.surfaceLight) this.surfaceLight.update();
    } else if (this.location === 'lab') {
      for (const u of this.lab.updatables) u.update(dt);
      this._updateClimb(dt);
      this._updateClimbers(dt);
      this._updateInsert(dt);
      if (this.phase === 'lab') this._updateLabTriggers();
      this.combat.update(dt);
      this._updateWave(dt);
      this._updateAdds(dt);
      this._updateReinforcements(dt);
      if (this.download.shown !== undefined) this._updateDownload(dt);
      if (this._hatchCloseT > 0) {
        this._hatchCloseT -= dt;
        if (this._hatchCloseT <= 0) this.lab.setShaftHatch(false);
      }
      if (this._bossHatchCloseT > 0) {
        this._bossHatchCloseT -= dt;
        if (this._bossHatchCloseT <= 0) this.lab.bossHatch.target = 0;
      }
      // The torn feed hoses over the fallen pillar spit sparks (and so do the cables where the wall pillar was).
      if (this._pillarSparks && Math.random() < dt * 1.5) {
        const end = this._pillarSparks[Math.floor(Math.random() * this._pillarSparks.length)];
        this.combat.effects.spark(end, { count: 5, color: 0x9fe8ff, speed: 2, size: 0.06, life: 0.5 });
      }
      if (this._tornCables && Math.random() < dt * 2.2) {
        const end = this._tornCables[Math.floor(Math.random() * this._tornCables.length)];
        this.combat.effects.spark(end, { count: 6, color: 0xffd08a, speed: 2.5, size: 0.06, life: 0.45 });
      }
    }
  }

  handleInteract(target) {
    const data = target.userData;
    const ui = this.ui;
    switch (data.type) {
      case 'ch2-hatch':
        if (this.phase === 'hatch') this._openHatch();
        else if (this.phase === 'climb') this._climbDown();
        break;
      case 'ch2-pod': {
        const awake = ['coach', 'armory', 'arming', 'waves', 'boss'].includes(this.phase);
        ui.showMessage(`${data.unit}  //  CRYOSTASIS  //  ${awake ? 'ACTIVE' : this.phase === 'usb' ? 'OFFLINE' : 'DORMANT'}`);
        break;
      }
      case 'ch2-armory':
        if (this.phase === 'armory') this._takeRifle();
        else if (['lab', 'terminal', 'coach'].includes(this.phase)) ui.showMessage('Two assault rifles, locked into the rack. The lock light is red.', 2800);
        else ui.showMessage('The rack is empty.');
        break;
      case 'ch2-water':
        if (this.phase !== 'boss') break;
        if (this.combat.holding) {
          ui.showMessage('You already have one. [Right Click] to throw it.');
        } else {
          this.lab.takeBottle();
          this.combat.holdBottle();
          ui.showMessage(
            this.bossStage === 2 ? "Water bottle ready, but it'll just shatter on the pillar. Break the shield first!" : 'Water bottle ready. [Right Click] to throw it!',
            2600,
          );
        }
        break;
      case 'ch2-terminal':
        if (this.phase === 'lab') this._playTerminal();
        else if (this.phase === 'usb') this._playEnding();
        else if (this.download.shown !== undefined) ui.showMessage(`Downloading Attack Mode... ${Math.floor(this.download.progress)}%`);
        break;
      default:
        break;
    }
  }

  /** Where main.js should put the bobbing objective marker (or null). */
  markerTarget() {
    if (this.cutscene) return null;
    switch (this.phase) {
      case 'hatch':
      case 'climb':
        return { key: `ch2-${this.phase}`, position: this._hatchMarker, scale: 0.8 };
      case 'lab':
        return this.player.object.position.z > ROOM.nearZ
          ? { key: 'ch2-terminal', position: this.lab.markers.terminalDoor, scale: 1.0 }
          : null;
      case 'armory':
        return { key: 'ch2-armory', position: this.lab.markers.armory, scale: 0.8 };
      case 'boss':
        // (No water marker while it has the pillar: bottles are useless until that breaks.)
        return this.combat.holding || this.bossStage === 2 ? null : { key: 'ch2-water', position: this.lab.markers.water, scale: 0.7 };
      case 'usb':
        return { key: 'ch2-usb', position: this.lab.markers.usb, scale: 0.5 };
      default:
        return null;
    }
  }
}

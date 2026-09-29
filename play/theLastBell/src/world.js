import * as THREE from 'three';
import { setRainExposure } from './audio.js';

/*
 * World layout (world-space convention: -Z is "forward", the direction the
 * player progresses through the level: classroom -> hallway -> exterior -> tree).
 *
 *   Z=  0 ................. classroom front wall (whiteboard); students face +Z
 *   Z=-12 ................. classroom rear wall / doorway to the hallway
 *   Z=-12..-34 ............ hallway (lockers, wall-mounted water fountain)
 *   Z=-34 ................. school back facade with the rear exit double doors
 *   Z=-34..-120 ........... exterior grounds: dirt trail, perimeter loop, lot, oak tree
 */

// ---------------------------------------------------------------------------
// Procedural canvas textures
// ---------------------------------------------------------------------------

function makeCanvas(width = 256, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Generic speckled/noisy base texture generator used by most surface types below. */
function createNoiseTexture({
  size = 256,
  base = '#888888',
  speckleColors = ['#000000'],
  speckleCount = 900,
  speckleAlpha = 0.08,
  speckleMaxRadius = 2.2,
  gridLine = null, // { color, spacing, lineWidth, alpha }
} = {}) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < speckleCount; i++) {
    ctx.fillStyle = speckleColors[Math.floor(Math.random() * speckleColors.length)];
    ctx.globalAlpha = speckleAlpha * (0.5 + Math.random());
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, Math.random() * speckleMaxRadius + 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (gridLine) {
    ctx.strokeStyle = gridLine.color;
    ctx.lineWidth = gridLine.lineWidth || 1;
    ctx.globalAlpha = gridLine.alpha || 0.35;
    for (let p = 0; p <= size; p += gridLine.spacing) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  return toTexture(canvas);
}

function createTileTexture() {
  return createNoiseTexture({
    base: '#c9c7bd',
    speckleColors: ['#b7b4a8', '#dedcd2'],
    speckleCount: 400,
    speckleAlpha: 0.06,
    gridLine: { color: '#8f8c80', spacing: 32, lineWidth: 2, alpha: 0.4 },
  });
}

function createConcreteTexture() {
  return createNoiseTexture({
    base: '#8b8d8f',
    speckleColors: ['#6f7274', '#a3a5a7', '#5c5e60'],
    speckleCount: 1400,
    speckleAlpha: 0.1,
    speckleMaxRadius: 3,
  });
}

function createWetGroundTexture() {
  return createNoiseTexture({
    base: '#39332c',
    speckleColors: ['#241f1a', '#4a4238', '#20242a'],
    speckleCount: 1800,
    speckleAlpha: 0.16,
    speckleMaxRadius: 4,
  });
}

function createDirtTrailTexture() {
  return createNoiseTexture({
    base: '#6b5842',
    speckleColors: ['#59492f', '#7d6a4f', '#4a3d28'],
    speckleCount: 1000,
    speckleAlpha: 0.14,
    speckleMaxRadius: 3,
  });
}

function createAsphaltTexture() {
  return createNoiseTexture({
    base: '#2c2e31',
    speckleColors: ['#1f2123', '#3a3d40', '#45484b'],
    speckleCount: 2200,
    speckleAlpha: 0.18,
    speckleMaxRadius: 2,
  });
}

/** One full-height locker door (vents, handle, number plate); tiled once per locker. */
function createLockerTexture() {
  const canvas = makeCanvas(128, 256);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3d5a6b';
  ctx.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(Math.random() * 128, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = '#1f2f38';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, 122, 250);
  ctx.fillStyle = '#22333d';
  for (let i = 0; i < 5; i++) ctx.fillRect(34, 20 + i * 10, 60, 4);
  for (let i = 0; i < 4; i++) ctx.fillRect(34, 206 + i * 10, 60, 4);
  ctx.fillStyle = '#9aa7ae';
  ctx.fillRect(98, 112, 9, 34);
  ctx.fillStyle = '#c9ced1';
  ctx.fillRect(48, 84, 32, 12);
  return toTexture(canvas);
}

function createWhiteboardTexture() {
  const canvas = makeCanvas(1024, 340);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f6f5';
  ctx.fillRect(0, 0, 1024, 340);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = 'rgba(120,130,140,0.05)';
    ctx.beginPath();
    ctx.ellipse(Math.random() * 1024, Math.random() * 340, 40 + Math.random() * 80, 10 + Math.random() * 20, Math.random(), 0, Math.PI * 2);
    ctx.fill();
  }
  const hand = '"Segoe Print", "Comic Sans MS", "Marker Felt", cursive';
  ctx.font = `bold 56px ${hand}`;
  ctx.fillStyle = '#b3261e';
  ctx.fillText('XC PRACTICE TODAY @ 3:15', 40, 90);
  ctx.font = `42px ${hand}`;
  ctx.fillStyle = '#1d3f8f';
  ctx.fillText('Meet at the big oak tree - rain or shine!', 40, 170);
  ctx.fillStyle = '#1e5e2c';
  ctx.fillText('Ch. 7 quiz Friday. Study!', 40, 250);
  ctx.font = `32px ${hand}`;
  ctx.fillStyle = '#333333';
  ctx.fillText('- Coach B.', 780, 312);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Thin vertical streak (faint at the top, brighter at the leading end) for rain sprites. */
function createRainDropTexture() {
  const canvas = makeCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 2, 0, 62);
  g.addColorStop(0, 'rgba(210,222,235,0)');
  g.addColorStop(0.75, 'rgba(220,230,240,0.6)');
  g.addColorStop(1, 'rgba(235,242,250,0.95)');
  ctx.fillStyle = g;
  ctx.fillRect(31, 2, 2, 60);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createExitSignTexture() {
  const canvas = makeCanvas(256, 96);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a0605';
  ctx.fillRect(0, 0, 256, 96);
  ctx.font = 'bold 64px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff3b2f';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ff4a3a';
  ctx.fillText('EXIT', 128, 52);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// Shared materials (built once, reused across meshes)
// ---------------------------------------------------------------------------

function createMaterials() {
  const tileTex = createTileTexture();
  tileTex.repeat.set(8, 6);

  const hallwayFloorTex = createTileTexture();
  hallwayFloorTex.repeat.set(3, 14);

  const concreteTex = createConcreteTexture();
  concreteTex.repeat.set(3, 1.5);

  const wetGroundTex = createWetGroundTexture();
  wetGroundTex.repeat.set(24, 24);

  const asphaltTex = createAsphaltTexture();
  asphaltTex.repeat.set(4, 10);

  return {
    classroomFloor: new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.85 }),
    hallwayFloor: new THREE.MeshStandardMaterial({ map: hallwayFloorTex, roughness: 0.85 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xe8e3d6, roughness: 0.95 }),
    exteriorWall: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 1 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x3b3e42, roughness: 1 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0xf1efe6, roughness: 1 }),
    panelLight: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff6d8, emissiveIntensity: 1.4 }),
    lockerSide: new THREE.MeshStandardMaterial({ color: 0x34505f, roughness: 0.6, metalness: 0.2 }),
    desk: new THREE.MeshStandardMaterial({ color: 0xa67c52, roughness: 0.7 }),
    deskLeg: new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.4, roughness: 0.5 }),
    chairSeat: new THREE.MeshStandardMaterial({ color: 0x2f4f86, roughness: 0.6 }),
    whiteboardFrame: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.3 }),
    doorWood: new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.6 }),
    doorFrame: new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.7 }),
    doorMetal: new THREE.MeshStandardMaterial({ color: 0x5d6b73, roughness: 0.5, metalness: 0.3 }),
    glassDark: new THREE.MeshStandardMaterial({ color: 0x1c262c, roughness: 0.15, metalness: 0.3 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xb3b8bc, roughness: 0.35, metalness: 0.5 }),
    metalDark: new THREE.MeshStandardMaterial({ color: 0x5f666b, roughness: 0.4, metalness: 0.4 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc98a, emissiveIntensity: 1.3 }),
    windowGlow: new THREE.MeshStandardMaterial({ color: 0x3a3320, emissive: 0xd9b86a, emissiveIntensity: 0.55 }),
    ground: new THREE.MeshStandardMaterial({ map: wetGroundTex, roughness: 1 }),
    asphalt: new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.9 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xdcd8c8, roughness: 0.8 }),
    treeBark: new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x2d3b24, roughness: 1, flatShading: true }),
    flag: new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0x401800, roughness: 0.7 }),
    flagPost: new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6 }),
    carBody: (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.5, metalness: 0.3 }),
    carGlass: new THREE.MeshStandardMaterial({ color: 0x1a2226, roughness: 0.2, metalness: 0.6 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }),
    dumpster: new THREE.MeshStandardMaterial({ color: 0x2f5233, roughness: 0.8, metalness: 0.2 }),
    dumpsterLid: new THREE.MeshStandardMaterial({ color: 0x223d26, roughness: 0.8 }),
    shedWall: new THREE.MeshStandardMaterial({ color: 0x4a5a4a, roughness: 0.9 }),
    crate: new THREE.MeshStandardMaterial({
      map: createNoiseTexture({ base: '#7a5a3a', speckleColors: ['#5e4329', '#8a6a48'], speckleCount: 500, gridLine: { color: '#3f2c18', spacing: 64, lineWidth: 6, alpha: 0.6 } }),
      roughness: 0.9,
    }),
    bleacher: new THREE.MeshStandardMaterial({ color: 0x8e979c, roughness: 0.5, metalness: 0.2 }),
    container: new THREE.MeshStandardMaterial({ color: 0x7a2e24, roughness: 0.75, metalness: 0.2 }),
    pillar: new THREE.MeshStandardMaterial({ color: 0x9a9c9e, roughness: 0.9 }),
    recycling: new THREE.MeshStandardMaterial({ color: 0x1f5fa8, roughness: 0.6 }),
    recyclingLid: new THREE.MeshStandardMaterial({ color: 0x184a82, roughness: 0.6 }),
    utilityBox: new THREE.MeshStandardMaterial({ color: 0x5b6660, roughness: 0.7, metalness: 0.2 }),
    warningSticker: new THREE.MeshBasicMaterial({ color: 0xe0c34a }),
    rain: new THREE.PointsMaterial({
      map: createRainDropTexture(),
      size: 0.5,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      opacity: 0.45,
      color: 0xa9b8c8,
    }),
    bottle: new THREE.MeshStandardMaterial({ color: 0x3fa6c9, roughness: 0.3, metalness: 0.1 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0xcc4433, roughness: 0.6 }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
}

/** Flat ribbon mesh laid along a closed curve (used for the perimeter loop trail). */
function buildRibbonGeometry(curve, width, y, segments) {
  const pts = curve.getSpacedPoints(segments); // closed curve: last point == first
  const count = pts.length;
  const positions = new Float32Array(count * 6);
  const normals = new Float32Array(count * 6);
  const uvs = new Float32Array(count * 4);
  const indices = [];
  const half = width / 2;
  let dist = 0;

  for (let i = 0; i < count; i++) {
    const p = pts[i];
    if (i > 0) dist += p.distanceTo(pts[i - 1]);
    const prev = pts[i === 0 ? count - 2 : i - 1];
    const next = pts[i === count - 1 ? 1 : i + 1];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const nx = -tz;
    const nz = tx;

    const o = i * 6;
    positions[o] = p.x + nx * half;
    positions[o + 1] = y;
    positions[o + 2] = p.z + nz * half;
    positions[o + 3] = p.x - nx * half;
    positions[o + 4] = y;
    positions[o + 5] = p.z - nz * half;
    normals[o + 1] = 1;
    normals[o + 4] = 1;

    const u = i * 4;
    uvs[u] = 0;
    uvs[u + 1] = dist / 3;
    uvs[u + 2] = 1;
    uvs[u + 3] = dist / 3;

    if (i < count - 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

function removeFromArray(arr, item) {
  const i = arr.indexOf(item);
  if (i !== -1) arr.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Characters: low-poly jointed humanoids (retro silhouettes, ready for .glb swap)
// ---------------------------------------------------------------------------

/** Other Ben's outfit (Chapter 2's lab builds its own copy of him). */
export const OTHER_BEN_LOOK = { shirt: 0x7a1f2b, pants: 0x1c1c22, hair: 0x4a3020, shorts: true, hood: true };

/** Coach Billing's raincoat look (also rebuilt down in the lab for Chapter 2). */
export const COACH_BILLING_LOOK = {
  shirt: 0xd4b62c, pants: 0x23262b, hair: 0x3b3b3b, skin: 0xc99a6e, scale: 1.2, raincoat: true, hood: true, whistle: true,
};

/**
 * Blocky humanoid facing +Z with hip/knee/shoulder pivots so it can walk, run
 * and sit. `root.userData.rig` holds the joints; `headHeight` is in world units.
 */
export function createHumanoid({
  shirt = 0x3355aa,
  pants = 0x2a2a2e,
  skin = 0xd9a679,
  hair = 0x2b1d14,
  shoes = 0x1b1b1f,
  scale = 1,
  shorts = false,
  bareArms = false,
  hood = false,
  raincoat = false,
  whistle = false,
  cap = false,
  capColor = 0x1a1a1a,
} = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const mat = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
  const shirtMat = mat(shirt, raincoat ? 0.35 : 0.85);
  const pantsMat = mat(pants);
  const skinMat = mat(skin, 0.9);
  const hairMat = mat(hair, 0.95);
  const shoeMat = mat(shoes, 0.7);

  const part = (w, h, d, material, parent, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const legs = [-1, 1].map((side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.11, 0.84, 0);
    body.add(hip);
    part(0.17, 0.44, 0.18, pantsMat, hip, 0, -0.21, 0);
    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    part(0.15, 0.4, 0.16, shorts ? skinMat : pantsMat, knee, 0, -0.2, 0);
    part(0.16, 0.08, 0.27, shoeMat, knee, 0, -0.38, 0.045);
    return { hip, knee };
  });

  part(0.46, 0.58, 0.26, shirtMat, body, 0, 1.13, 0);
  if (raincoat) part(0.52, 0.4, 0.31, shirtMat, body, 0, 0.72, 0); // coat skirt over the hips
  if (whistle) {
    part(0.012, 0.2, 0.012, mat(0x1d1d1d), body, 0, 1.3, 0.136);
    const whistleMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.07, 8),
      new THREE.MeshStandardMaterial({ color: 0xc0c4c8, metalness: 0.6, roughness: 0.3 }),
    );
    whistleMesh.rotation.x = Math.PI / 2;
    whistleMesh.position.set(0, 1.19, 0.15);
    body.add(whistleMesh);
  }

  // Arms have an elbow so runners can pump bent arms instead of swinging stiff ones.
  const arms = [-1, 1].map((side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.3, 1.38, 0);
    body.add(shoulder);
    const sleeveMat = bareArms ? skinMat : shirtMat;
    part(0.13, 0.3, 0.14, sleeveMat, shoulder, 0, -0.14, 0); // upper arm
    if (bareArms) part(0.15, 0.14, 0.16, shirtMat, shoulder, 0, -0.04, 0); // short sleeve
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    part(0.12, 0.28, 0.13, sleeveMat, elbow, 0, -0.14, 0); // forearm
    const hand = new THREE.Group();
    hand.position.y = -0.31;
    elbow.add(hand);
    part(0.11, 0.11, 0.11, skinMat, hand);
    return { shoulder, elbow, hand };
  });

  const neck = new THREE.Group();
  neck.position.y = 1.42;
  body.add(neck);
  part(0.26, 0.28, 0.26, skinMat, neck, 0, 0.17, 0);
  part(0.28, 0.07, 0.28, hairMat, neck, 0, 0.32, 0);
  part(0.28, 0.16, 0.06, hairMat, neck, 0, 0.23, -0.12);
  const eyeMat = mat(0x111111, 0.5);
  part(0.045, 0.035, 0.02, eyeMat, neck, -0.06, 0.2, 0.131);
  part(0.045, 0.035, 0.02, eyeMat, neck, 0.06, 0.2, 0.131);
  // Hood box sits just behind the face plane so the face still shows through.
  if (hood) part(0.33, 0.34, 0.3, shirtMat, neck, 0, 0.19, -0.035);
  if (cap) {
    const capMat = mat(capColor, 0.8);
    part(0.3, 0.08, 0.3, capMat, neck, 0, 0.35, 0);
    part(0.26, 0.02, 0.16, capMat, neck, 0, 0.32, 0.2); // brim
  }

  // The humanoid faces +Z, so its anatomical right side is -X (index 0 above).
  root.userData.rig = {
    body,
    neck,
    hipR: legs[0].hip,
    hipL: legs[1].hip,
    kneeR: legs[0].knee,
    kneeL: legs[1].knee,
    shoulderR: arms[0].shoulder,
    shoulderL: arms[1].shoulder,
    elbowR: arms[0].elbow,
    elbowL: arms[1].elbow,
    handR: arms[0].hand,
    handL: arms[1].hand,
    phase: Math.random() * Math.PI * 2,
    seated: false,
    crouch: false, // target pose; blended via crouchAmount
    crouchAmount: 0,
    holdingFlashlight: false, // right arm held forward
    pointing: false, // left arm jabbing forward (a reprimand)
    reach: false, // right arm stretched out (grabbing, plugging something in)
    typing: false, // both hands tapping at a keyboard
    aiming: false, // shouldering a rifle
    climbing: false, // hand over hand on a ladder (the caller moves them vertically)
    nod: false,
    gestureT: 0,
  };
  root.userData.headHeight = 1.6 * scale;
  root.scale.setScalar(scale);
  return root;
}

/** Pose a humanoid sitting on a chair with its forearms resting on the desk ahead. */
export function setSeatedPose(root) {
  const rig = root.userData.rig;
  rig.seated = true;
  rig.body.position.y = -0.36;
  rig.hipL.rotation.x = rig.hipR.rotation.x = -Math.PI / 2;
  rig.kneeL.rotation.x = rig.kneeR.rotation.x = Math.PI / 2;
  rig.shoulderL.rotation.x = rig.shoulderR.rotation.x = -1.05;
  rig.elbowL.rotation.x = rig.elbowR.rotation.x = -0.3;
  root.userData.headHeight -= 0.36 * root.scale.y;
}

/** Get up out of the chair; animateHumanoid eases the joints back to standing. */
export function standUp(root) {
  const rig = root.userData.rig;
  if (!rig.seated) return;
  rig.seated = false;
  root.userData.headHeight += 0.36 * root.scale.y;
}

/**
 * Procedural gait driven by ground speed. Blends a walk into a proper run
 * (faster cadence, big hip swing, high heel kick, bent pumping arms, forward
 * lean and bounce) above ~2.2 m/s. The old cycle only scaled a walk up, so
 * jogging NPCs still looked like they were walking. Also blends a crouch pose.
 */
export function animateHumanoid(root, dt, speed) {
  const rig = root.userData.rig;
  if (!rig || rig.seated) return;

  if (rig.climbing) {
    // Hand over hand, arms reaching up the rungs, knees stepping in turn.
    const k = Math.min(1, dt * 14);
    const set = (joint, value) => {
      joint.rotation.x += (value - joint.rotation.x) * k;
    };
    rig.phase += dt * 6.5;
    const c = Math.sin(rig.phase);
    set(rig.shoulderL, -2.55 + c * 0.35);
    set(rig.elbowL, -0.35 - Math.max(0, c) * 0.5);
    set(rig.shoulderR, -2.55 - c * 0.35);
    set(rig.elbowR, -0.35 - Math.max(0, -c) * 0.5);
    set(rig.hipL, -0.55 - Math.max(0, c) * 0.7);
    set(rig.kneeL, 0.8 + Math.max(0, c) * 0.6);
    set(rig.hipR, -0.55 - Math.max(0, -c) * 0.7);
    set(rig.kneeR, 0.8 + Math.max(0, -c) * 0.6);
    set(rig.neck, -0.25);
    set(rig.body, 0);
    rig.body.position.y += (0 - rig.body.position.y) * k;
    return;
  }

  rig.crouchAmount += ((rig.crouch ? 1 : 0) - rig.crouchAmount) * Math.min(1, dt * 8);
  const cr = rig.crouchAmount;
  const moving = speed > 0.15;
  const run = moving ? THREE.MathUtils.smoothstep(speed, 2.2, 3.6) : 0;
  const lerp = THREE.MathUtils.lerp;

  let s = 0;
  let hipSwing = 0;
  let kneeBend = 0;
  let armSwing = 0;
  let bob = 0;
  if (moving) {
    rig.phase += dt * lerp(4.2 + speed * 1.2, 7.2 + speed * 0.6, run);
    s = Math.sin(rig.phase);
    hipSwing = lerp(0.38, 0.95, run) * (1 - 0.45 * cr);
    kneeBend = lerp(0.45, 1.75, run);
    armSwing = lerp(0.35, 0.85, run);
    bob = Math.abs(s) * lerp(0.025, 0.09, run) * (1 - cr);
  }

  const k = Math.min(1, dt * 25);
  const set = (joint, value) => {
    joint.rotation.x += (value - joint.rotation.x) * k;
  };
  rig.gestureT += dt;
  set(rig.hipL, s * hipSwing - 1.2 * cr);
  set(rig.hipR, -s * hipSwing - 1.2 * cr);
  // Knees bend on the back swing (heel kick when running).
  set(rig.kneeL, Math.max(0, s) * kneeBend + 0.06 + 2.0 * cr);
  set(rig.kneeR, Math.max(0, -s) * kneeBend + 0.06 + 2.0 * cr);
  // Arm gestures, highest priority first.
  const tap = Math.sin(rig.gestureT * 16);
  if (rig.typing) {
    set(rig.shoulderL, -0.62 + Math.max(0, tap) * 0.1);
    set(rig.elbowL, -1.0);
  } else if (rig.aiming) {
    set(rig.shoulderL, -1.2);
    set(rig.elbowL, -0.85); // supporting hand out on the handguard
  } else if (rig.pointing) {
    set(rig.shoulderL, -1.35 + Math.sin(rig.gestureT * 9) * 0.12);
    set(rig.elbowL, -0.15);
  } else {
    set(rig.shoulderL, -s * armSwing - 0.3 * cr);
    set(rig.elbowL, -lerp(0.12, 1.45, run) - 0.4 * cr);
  }
  if (rig.typing) {
    set(rig.shoulderR, -0.62 + Math.max(0, -tap) * 0.1);
    set(rig.elbowR, -1.0);
  } else if (rig.aiming) {
    set(rig.shoulderR, -1.3);
    set(rig.elbowR, -0.45);
  } else if (rig.reach) {
    set(rig.shoulderR, -1.25);
    set(rig.elbowR, -0.12);
  } else if (rig.holdingFlashlight) {
    set(rig.shoulderR, -0.95 + s * 0.08);
    set(rig.elbowR, -0.45);
  } else {
    set(rig.shoulderR, s * armSwing - 0.3 * cr);
    set(rig.elbowR, -lerp(0.12, 1.45, run) - 0.4 * cr);
  }
  set(rig.neck, rig.nod ? Math.max(0, Math.sin(rig.gestureT * 7)) * 0.3 : 0);
  set(rig.body, (moving ? lerp(0.03, 0.22, run) : 0) + 0.3 * cr);
  // Damped so a student standing up from a chair rises instead of popping.
  rig.body.position.y += (bob - 0.33 * cr - rig.body.position.y) * k;
}

function dampAngle(current, target, t) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}

const _pathPoint = new THREE.Vector3();
const _pathTangent = new THREE.Vector3();

/**
 * Minimal NPC controller: scripted moveTo (awaitable), follow-a-target, and
 * jogging along a closed trail curve. Also exposes a collision radius that the
 * Player treats as solid.
 */
export class Character {
  constructor(mesh, { radius = 0.32, name = '' } = {}) {
    this.mesh = mesh;
    this.name = name;
    this.radius = radius;
    this.speed = 0;
    this.maxSpeed = 0;
    this.mode = 'idle'; // 'idle' | 'moveTo' | 'follow' | 'path'
    this.target = new THREE.Vector3();
    this.faceTarget = null;
    this.turnRate = 5; // how quickly they turn toward faceTarget while standing
    this._arrive = null;
    this._followFn = null;
    this._path = null;
    this._route = null;
  }

  get position() {
    return this.mesh.position;
  }

  headPosition(out = new THREE.Vector3()) {
    return out.copy(this.mesh.position).setY(this.mesh.position.y + this.mesh.userData.headHeight);
  }

  /** Walk/run to (x, z); resolves on arrival. */
  moveTo(x, z, speed = 4) {
    this._settle();
    this.mode = 'moveTo';
    this.target.set(x, 0, z);
    this.maxSpeed = speed;
    return new Promise((resolve) => {
      this._arrive = resolve;
    });
  }

  /** Walk a chain of {x, z} waypoints, cornering without stopping; resolves at the last one. */
  walkRoute(points, speed = 1.5) {
    this._settle();
    return new Promise((resolve) => {
      this._route = { points, index: 0, speed, resolve };
      this._nextRouteLeg();
    });
  }

  _nextRouteLeg() {
    const r = this._route;
    if (!r) return;
    if (r.index >= r.points.length) {
      this._route = null;
      this.mode = 'idle';
      r.resolve();
      return;
    }
    const p = r.points[r.index++];
    this.mode = 'moveTo';
    this.target.set(p.x, 0, p.z);
    this.maxSpeed = r.speed;
  }

  follow(getTarget, maxSpeed = 8) {
    this._settle();
    this.mode = 'follow';
    this._followFn = getTarget;
    this.maxSpeed = maxSpeed;
  }

  jogPath(curve, { startU = 0, speed = 3.4, lateral = 0 } = {}) {
    this._settle();
    this.mode = 'path';
    this._path = { curve, length: curve.getLength(), u: ((startU % 1) + 1) % 1, speed, lateral };
    this.maxSpeed = speed * 1.8;
  }

  /** Change jogging pace mid-path (used to keep the pack running with the player). */
  setPathSpeed(speed) {
    if (!this._path) return;
    this._path.speed = speed;
    this.maxSpeed = speed * 1.8;
  }

  /** Current progress (0..1) along the path being jogged, or null. */
  get pathU() {
    return this._path ? this._path.u : null;
  }

  /** Vector3 (live references like another character's position are fine), or null. */
  faceTowards(target) {
    this.faceTarget = target;
  }

  stop() {
    this._settle();
    this.mode = 'idle';
  }

  // Resolve any pending moveTo/walkRoute so an awaiting script can never hang.
  _settle() {
    if (this._arrive) {
      const resolve = this._arrive;
      this._arrive = null;
      resolve();
    }
    if (this._route) {
      const route = this._route;
      this._route = null;
      route.resolve();
    }
  }

  update(dt) {
    const pos = this.mesh.position;
    let desiredSpeed = 0;
    let dirX = 0;
    let dirZ = 0;
    let dist = 0;

    if (this.mode !== 'idle') {
      if (this.mode === 'follow') {
        const t = this._followFn();
        this.target.set(t.x, 0, t.z);
      } else if (this.mode === 'path') {
        const p = this._path;
        p.u = (p.u + (p.speed * dt) / p.length) % 1;
        p.curve.getPointAt(p.u, _pathPoint);
        p.curve.getTangentAt(p.u, _pathTangent);
        this.target.set(_pathPoint.x - _pathTangent.z * p.lateral, 0, _pathPoint.z + _pathTangent.x * p.lateral);
      }

      dirX = this.target.x - pos.x;
      dirZ = this.target.z - pos.z;
      dist = Math.hypot(dirX, dirZ);

      if (this.mode === 'moveTo') {
        const route = this._route;
        const finalLeg = !route || route.index >= route.points.length;
        if (dist < (finalLeg ? 0.06 : 0.4)) {
          if (!finalLeg) {
            this._nextRouteLeg(); // corner onto the next leg without stopping
            dirX = this.target.x - pos.x;
            dirZ = this.target.z - pos.z;
            dist = Math.hypot(dirX, dirZ);
            desiredSpeed = this.maxSpeed;
          } else {
            pos.x = this.target.x;
            pos.z = this.target.z;
            this.mode = 'idle';
            this.speed = 0;
            dist = 0;
            if (route) this._nextRouteLeg(); // resolves the finished route
            else this._settle();
          }
        } else {
          desiredSpeed = finalLeg ? this.maxSpeed * Math.min(1, dist / 0.6 + 0.35) : this.maxSpeed;
        }
      } else if (this.mode === 'follow') {
        desiredSpeed = dist < 0.35 ? 0 : Math.min(this.maxSpeed, (dist - 0.2) * 2.4);
      } else {
        desiredSpeed = THREE.MathUtils.clamp(this._path.speed + (dist - 0.5) * 1.5, 0, this.maxSpeed);
      }
    }

    this.speed += (desiredSpeed - this.speed) * Math.min(1, dt * 6);

    if (this.speed > 0.01 && dist > 1e-4) {
      const step = Math.min(dist, this.speed * dt);
      pos.x += (dirX / dist) * step;
      pos.z += (dirZ / dist) * step;
      this.mesh.rotation.y = dampAngle(this.mesh.rotation.y, Math.atan2(dirX, dirZ), Math.min(1, dt * 10));
    } else if (this.faceTarget) {
      const fx = this.faceTarget.x - pos.x;
      const fz = this.faceTarget.z - pos.z;
      if (fx * fx + fz * fz > 0.01) {
        this.mesh.rotation.y = dampAngle(this.mesh.rotation.y, Math.atan2(fx, fz), Math.min(1, dt * this.turnRate));
      }
    }

    animateHumanoid(this.mesh, dt, this.speed);
  }
}

// ---------------------------------------------------------------------------
// World builder
// ---------------------------------------------------------------------------

export function buildWorld(scene) {
  const mats = createMaterials();

  const colliders = [];
  const occluders = []; // blocks Coach Billing's line of sight in Phase 3
  const interactables = [];
  const updatables = [];
  const events = { onCollidersChanged: null };
  const notifyCollidersChanged = () => {
    if (events.onCollidersChanged) events.onCollidersChanged();
  };

  /** Add a box mesh to the scene; optionally register as collider and/or sight occluder. */
  function addBox({ w, h, d, x, y, z, material, name = 'box', collider = true, occluder = false, castShadow = true, receiveShadow = true, rotationY = 0 }) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    if (rotationY) mesh.rotation.y = rotationY;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.name = name;
    scene.add(mesh);
    if (collider) colliders.push(mesh);
    if (occluder) occluders.push(mesh);
    return mesh;
  }

  function addPlane({ w, d, x, y, z, material, name = 'plane', rotationX = -Math.PI / 2, receiveShadow = true }) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
    mesh.rotation.x = rotationX;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = receiveShadow;
    mesh.name = name;
    scene.add(mesh);
    return mesh;
  }

  // =========================================================================
  // CLASSROOM  (Z: -12 to 0, X: -7 to 7). Whiteboard on the Z=0 wall; the
  // doorway to the hallway is in the Z=-12 wall behind the students.
  // =========================================================================
  const CR = { minX: -7, maxX: 7, minZ: -12, maxZ: 0, height: 3.4, doorGapHalf: 1.2 };
  const crCenterZ = (CR.minZ + CR.maxZ) / 2;

  addPlane({ w: CR.maxX - CR.minX, d: CR.maxZ - CR.minZ, x: 0, y: 0, z: crCenterZ, material: mats.classroomFloor, name: 'classroom-floor' });
  addPlane({ w: CR.maxX - CR.minX, d: CR.maxZ - CR.minZ, x: 0, y: CR.height, z: crCenterZ, material: mats.ceiling, rotationX: Math.PI / 2, name: 'classroom-ceiling' });

  addBox({ w: CR.maxX - CR.minX, h: CR.height, d: 0.3, x: 0, y: CR.height / 2, z: CR.maxZ + 0.15, material: mats.wall, name: 'classroom-wall-front' });
  addBox({ w: 0.3, h: CR.height, d: CR.maxZ - CR.minZ, x: CR.minX - 0.15, y: CR.height / 2, z: crCenterZ, material: mats.wall, name: 'classroom-wall-left' });
  addBox({ w: 0.3, h: CR.height, d: CR.maxZ - CR.minZ, x: CR.maxX + 0.15, y: CR.height / 2, z: crCenterZ, material: mats.wall, name: 'classroom-wall-right' });

  const crRearSegW = (CR.maxX - CR.minX) / 2 - CR.doorGapHalf;
  addBox({ w: crRearSegW, h: CR.height, d: 0.3, x: CR.minX + crRearSegW / 2, y: CR.height / 2, z: CR.minZ - 0.15, material: mats.wall, name: 'classroom-wall-rear-L' });
  addBox({ w: crRearSegW, h: CR.height, d: 0.3, x: CR.maxX - crRearSegW / 2, y: CR.height / 2, z: CR.minZ - 0.15, material: mats.wall, name: 'classroom-wall-rear-R' });
  addBox({ w: CR.doorGapHalf * 2, h: 0.6, d: 0.3, x: 0, y: CR.height - 0.3, z: CR.minZ - 0.15, material: mats.wall, name: 'classroom-wall-rear-header', collider: false });

  // Ceiling fluorescent panels. The center light casts (static) shadows; its
  // shadow camera is clamped to the room so it doesn't render the whole map.
  for (let i = -1; i <= 1; i++) {
    addBox({ w: 1.6, h: 0.05, d: 1.0, x: i * 3.5, y: CR.height - 0.05, z: -6, material: mats.panelLight, name: 'panel-light', collider: false, castShadow: false });
    const light = new THREE.PointLight(0xfff2d0, 12, 14, 2);
    light.position.set(i * 3.5, CR.height - 0.3, -6);
    if (i === 0) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.far = 12;
      light.shadow.bias = -0.002;
    }
    scene.add(light);
  }

  // Whiteboard, marker tray and wall clock on the front wall.
  const whiteboard = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 1.3),
    new THREE.MeshStandardMaterial({ map: createWhiteboardTexture(), roughness: 0.35 }),
  );
  whiteboard.position.set(0, 1.75, CR.maxZ - 0.035);
  whiteboard.rotation.y = Math.PI;
  scene.add(whiteboard);
  addBox({ w: 4.14, h: 1.44, d: 0.03, x: 0, y: 1.75, z: CR.maxZ - 0.015, material: mats.whiteboardFrame, name: 'whiteboard-frame', collider: false });
  addBox({ w: 4.0, h: 0.05, d: 0.1, x: 0, y: 1.06, z: CR.maxZ - 0.06, material: mats.whiteboardFrame, name: 'marker-tray', collider: false });

  const wallClock = new THREE.Group();
  wallClock.position.set(3.3, 2.7, CR.maxZ - 0.02);
  wallClock.rotation.y = Math.PI;
  const clockFace = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.6 }));
  clockFace.position.z = 0.005;
  wallClock.add(clockFace);
  wallClock.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 6, 24), mats.doorFrame));
  // 3:14 — one minute to practice.
  [[0.1, 0.022, (97 * Math.PI) / 180], [0.16, 0.014, (84 * Math.PI) / 180]].forEach(([len, thick, angle]) => {
    const hand = new THREE.Mesh(new THREE.BoxGeometry(thick, len, 0.006), mats.doorFrame);
    hand.position.set(Math.sin(angle) * (len / 2), Math.cos(angle) * (len / 2), 0.012);
    hand.rotation.z = -angle;
    wallClock.add(hand);
  });
  scene.add(wallClock);

  // Desks in a 3x3 grid. Students sit on the -Z side of each desk facing the board.
  const deskPositions = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      deskPositions.push({ x: -4 + col * 4, z: -2 - row * 3.2 });
    }
  }
  const playerDeskIndex = 6; // back row (farthest from the board), left column
  const CHAIR_OFFSET = 0.55;

  function createDeskAndChair(x, z) {
    addBox({ w: 1.1, h: 0.06, d: 0.6, x, y: 0.79, z, material: mats.desk, name: 'desk-top' });
    [[-0.48, -0.24], [0.48, -0.24], [-0.48, 0.24], [0.48, 0.24]].forEach(([ox, oz]) => {
      addBox({ w: 0.05, h: 0.76, d: 0.05, x: x + ox, y: 0.38, z: z + oz, material: mats.deskLeg, name: 'desk-leg', collider: false });
    });
    const cz = z - CHAIR_OFFSET;
    // The seat is the chair's collider (chairs used to be walk-through).
    addBox({ w: 0.44, h: 0.05, d: 0.42, x, y: 0.45, z: cz, material: mats.chairSeat, name: 'chair-seat' });
    addBox({ w: 0.44, h: 0.4, d: 0.04, x, y: 0.72, z: cz - 0.2, material: mats.chairSeat, name: 'chair-back', collider: false });
    [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]].forEach(([ox, oz]) => {
      addBox({ w: 0.03, h: 0.43, d: 0.03, x: x + ox, y: 0.215, z: cz + oz, material: mats.deskLeg, name: 'chair-leg', collider: false });
    });
  }

  const studentLooks = [
    { shirt: 0x3355aa, skin: 0xd9a679, hair: 0x2b1d14 },
    { shirt: 0x8a4b8f, skin: 0x8d5a3b, hair: 0x111111 },
    { shirt: 0x4b8f5c, skin: 0xe8c39e, hair: 0x8a6a3a },
    { shirt: 0xaa6633, skin: 0xb07a52, hair: 0x1a1a1a },
    { shirt: 0x6677aa, skin: 0xe0b48a, hair: 0x5a3a22 },
  ];
  // Classmates are full Characters: at the final bell they get up and file out
  // to practice (see the classroom dismissal choreography further down).
  const students = [];
  deskPositions.forEach((pos, i) => {
    createDeskAndChair(pos.x, pos.z);
    if (i !== playerDeskIndex) {
      const mesh = createHumanoid(studentLooks[i % studentLooks.length]);
      setSeatedPose(mesh);
      mesh.position.set(pos.x, 0, pos.z - CHAIR_OFFSET);
      mesh.name = `student-${i}`;
      scene.add(mesh);
      const student = new Character(mesh, { radius: 0.3, name: `Student ${i}` });
      student.desk = pos;
      students.push(student);
    }
  });
  // Back row (nearest the classroom door) leaves first.
  students.sort((a, b) => a.desk.z - b.desk.z);

  // Pickups on the player's desk: running shoes + water bottle.
  const playerDesk = deskPositions[playerDeskIndex];
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.24, 12), mats.bottle);
  bottle.position.set(playerDesk.x + 0.3, 0.82 + 0.12, playerDesk.z + 0.05);
  bottle.castShadow = true;
  bottle.userData = { interactable: true, label: 'Pick up water bottle', type: 'pickup', id: 'bottle' };
  scene.add(bottle);
  interactables.push(bottle);

  const shoesGroup = new THREE.Group();
  [-0.09, 0.09].forEach((ox) => {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.28), mats.shoe);
    shoe.position.set(ox, 0, 0);
    shoe.castShadow = true;
    shoesGroup.add(shoe);
  });
  // Invisible catch-all hitbox spanning both shoes so a crosshair landing in the
  // gap between them still reaches shoesGroup's userData via the parent walk-up.
  shoesGroup.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.32), mats.hidden));
  shoesGroup.position.set(playerDesk.x - 0.25, 0.82 + 0.04, playerDesk.z);
  shoesGroup.userData = { interactable: true, label: 'Pick up running shoes', type: 'pickup', id: 'shoes' };
  scene.add(shoesGroup);
  interactables.push(shoesGroup);

  // The player starts seated in their chair, facing the desk and whiteboard (+Z).
  const spawn = {
    position: new THREE.Vector3(playerDesk.x, 0, playerDesk.z - 0.72),
    yaw: Math.PI,
    pitch: -0.2,
    seated: true,
  };

  // =========================================================================
  // HALLWAY  (Z: -34 to -12, X: -2.5 to 2.5)
  // =========================================================================
  const HW = { minX: -2.5, maxX: 2.5, minZ: -34, maxZ: -12, height: 3.2 };
  const hwLen = HW.maxZ - HW.minZ;
  const hwCenterZ = (HW.minZ + HW.maxZ) / 2;

  addPlane({ w: HW.maxX - HW.minX, d: hwLen, x: 0, y: 0, z: hwCenterZ, material: mats.hallwayFloor, name: 'hallway-floor' });
  addPlane({ w: HW.maxX - HW.minX, d: hwLen, x: 0, y: HW.height, z: hwCenterZ, material: mats.ceiling, rotationX: Math.PI / 2, name: 'hallway-ceiling' });
  addBox({ w: 0.3, h: HW.height, d: hwLen, x: HW.minX - 0.15, y: HW.height / 2, z: hwCenterZ, material: mats.wall, name: 'hallway-wall-left' });
  addBox({ w: 0.3, h: HW.height, d: hwLen, x: HW.maxX + 0.15, y: HW.height / 2, z: hwCenterZ, material: mats.wall, name: 'hallway-wall-right' });

  // Locker banks, flush against the walls (previously they floated 10cm off the
  // wall). Laid out explicitly so none overlap the doors or the fountain.
  function addLockerBank(side, z0, z1) {
    const len = z1 - z0;
    const tex = createLockerTexture();
    tex.repeat.set(Math.max(1, Math.round(len / 0.46)), 1);
    const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.25 });
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z. Only the hallway-facing side shows doors.
    const s = mats.lockerSide;
    const faces = side < 0 ? [front, s, s, s, s, s] : [s, front, s, s, s, s];
    const bank = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.95, len), faces);
    bank.position.set(side * (HW.maxX - 0.23), 0.975, (z0 + z1) / 2);
    bank.castShadow = true;
    bank.receiveShadow = true;
    bank.name = 'locker-bank';
    scene.add(bank);
    colliders.push(bank);
  }
  addLockerBank(-1, -32.0, -27.8);
  addLockerBank(-1, -20.8, -16.6);
  addLockerBank(1, -31.5, -27.3);
  addLockerBank(1, -24.6, -19.6);
  addLockerBank(1, -16.8, -13.4);

  for (let z = HW.minZ + 4; z < HW.maxZ - 1; z += 6) {
    addBox({ w: 0.9, h: 0.05, d: 1.4, x: 0, y: HW.height - 0.05, z, material: mats.panelLight, name: 'panel-light', collider: false, castShadow: false });
    const light = new THREE.PointLight(0xfff2d0, 9, 10, 2);
    light.position.set(0, HW.height - 0.3, z);
    scene.add(light);
  }

  // Locked classroom doors along the hallway (future Chapter 2 rooms).
  // The left one used to sit half behind the first locker bank.
  [{ z: HW.minZ + 8, side: -1, room: '104' }, { z: HW.minZ + 16, side: 1, room: '103' }].forEach(({ z, side, room }) => {
    const faceX = side * HW.maxX; // inner face of that wall
    addBox({ w: 0.04, h: 2.24, d: 1.16, x: faceX - side * 0.02, y: 1.12, z, material: mats.doorFrame, name: 'locked-door-frame', collider: false });
    const door = addBox({ w: 0.06, h: 2.1, d: 1.0, x: faceX - side * 0.05, y: 1.05, z, material: mats.doorWood, name: 'locked-door', collider: false });
    addBox({ w: 0.07, h: 0.5, d: 0.2, x: faceX - side * 0.06, y: 1.55, z: z - 0.2, material: mats.glassDark, name: 'locked-door-window', collider: false });
    addBox({ w: 0.05, h: 0.04, d: 0.14, x: faceX - side * 0.1, y: 1.0, z: z + 0.36, material: mats.metal, name: 'locked-door-handle', collider: false });
    door.userData = { interactable: true, label: `Room ${room} (locked)`, type: 'locked' };
    interactables.push(door);
  });

  // Wall-mounted water fountain, flush against the left hallway wall between
  // the locker banks (it used to stand on the classroom floor: z = HW.minZ + 24
  // is past the hallway's end at HW.maxZ).
  const fountainZ = HW.minZ + 12;
  const fountainWallX = HW.minX; // inner face of the left wall
  const fountain = new THREE.Group();
  fountain.position.set(fountainWallX, 0, fountainZ);
  scene.add(fountain);
  // Local +X points out of the wall into the hallway.
  const fPart = (w, h, d, x, y, z, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    fountain.add(mesh);
    return mesh;
  };
  fPart(0.03, 0.75, 0.62, 0.015, 0.98, 0, mats.metal); // backplate on the wall
  fPart(0.4, 0.14, 0.54, 0.2, 0.9, 0, mats.metal); // basin (top at ~0.97m)
  fPart(0.3, 0.012, 0.4, 0.22, 0.972, 0, mats.metalDark); // bowl recess
  fPart(0.26, 0.34, 0.4, 0.13, 0.66, 0, mats.metal); // apron under the basin
  fPart(0.02, 0.05, 0.11, 0.405, 0.9, 0, mats.metalDark); // push button
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.06, 8), mats.metalDark);
  spout.position.set(0.1, 1.0, 0.14);
  fountain.add(spout);
  const fountainHitbox = fPart(0.44, 0.62, 0.62, 0.22, 0.75, 0, mats.hidden); // raycast + collision proxy
  fountainHitbox.castShadow = false;
  fountain.userData = { interactable: true, label: 'Fill water bottle', type: 'fountain' };
  interactables.push(fountain);
  colliders.push(fountainHitbox);

  // =========================================================================
  // SCHOOL SHELL + BACK FACADE WITH THE REAR EXIT DOUBLE DOORS
  // =========================================================================
  // The facade is split into left / right / header sections around a real
  // opening. This replaces the old solid 'school-exterior-facade' slab that
  // skinned straight over the doorway and blocked the view outside.
  const doorZ = HW.minZ; // inner face of the facade, flush with the hallway's end
  const FACADE = { halfWidth: 12.4, height: 4.5, depth: 0.4 };
  const facadeZ = doorZ - FACADE.depth / 2;
  const exteriorFaceZ = doorZ - FACADE.depth;
  const OPEN_HALF = 1.3; // half-width of the rough opening
  const OPEN_H = 2.3; // opening height
  const WALL_H = FACADE.height + 0.1; // walls start 10cm below grade so they never float
  const WALL_Y = (FACADE.height - 0.1) / 2;
  const sideW = FACADE.halfWidth - OPEN_HALF;

  [-1, 1].forEach((s) => {
    addBox({ w: sideW, h: WALL_H, d: FACADE.depth, x: s * (OPEN_HALF + sideW / 2), y: WALL_Y, z: facadeZ, material: mats.exteriorWall, name: s < 0 ? 'facade-left' : 'facade-right', occluder: true });
  });
  addBox({ w: OPEN_HALF * 2, h: FACADE.height - OPEN_H, d: FACADE.depth, x: 0, y: OPEN_H + (FACADE.height - OPEN_H) / 2, z: facadeZ, material: mats.exteriorWall, name: 'facade-header', collider: false });

  // Side wings, front wall and roof close the building so it reads as solid
  // from the grounds and the player can't wander behind the interior rooms.
  const shellFrontZ = 2.4;
  const shellDepth = shellFrontZ - exteriorFaceZ;
  const shellCenterZ = (shellFrontZ + exteriorFaceZ) / 2;
  [-1, 1].forEach((s) => {
    addBox({ w: 0.4, h: WALL_H, d: shellDepth, x: s * (FACADE.halfWidth - 0.2), y: WALL_Y, z: shellCenterZ, material: mats.exteriorWall, name: 'school-wing', occluder: true });
  });
  addBox({ w: FACADE.halfWidth * 2, h: WALL_H, d: 0.4, x: 0, y: WALL_Y, z: shellFrontZ - 0.2, material: mats.exteriorWall, name: 'school-front-wall', occluder: true });

  // Covered walkway along the back of the school: pillars are stealth cover.
  [-12, -9, -3, 3, 9, 12].forEach((x) => {
    addBox({ w: 0.45, h: 3.0, d: 0.45, x, y: 1.5, z: exteriorFaceZ - 4.2, material: mats.pillar, name: 'walkway-pillar', occluder: true });
  });
  addBox({ w: FACADE.halfWidth * 2, h: 0.15, d: 4.6, x: 0, y: 3.075, z: exteriorFaceZ - 2.3, material: mats.roof, name: 'walkway-canopy', collider: false, castShadow: false });
  addBox({ w: FACADE.halfWidth * 2 + 0.6, h: 0.35, d: shellDepth + 0.6, x: 0, y: FACADE.height + 0.17, z: shellCenterZ, material: mats.roof, name: 'school-roof', collider: false, castShadow: false });

  // Warm-lit classroom windows along the back facade (exterior face only).
  [-8.6, -5.0, 5.0, 8.6].forEach((x) => {
    addBox({ w: 1.7, h: 1.4, d: 0.06, x, y: 1.85, z: exteriorFaceZ - 0.03, material: mats.doorFrame, name: 'facade-window-frame', collider: false });
    addBox({ w: 1.5, h: 1.2, d: 0.06, x, y: 1.85, z: exteriorFaceZ - 0.05, material: mats.windowGlow, name: 'facade-window', collider: false });
  });

  // Door frame: posts inside the opening edges, a head bar, and a threshold.
  const POST_W = 0.1;
  const CLEAR_HALF = OPEN_HALF - POST_W; // half-width of the clear doorway (1.2)
  [-1, 1].forEach((s) => {
    addBox({ w: POST_W, h: OPEN_H, d: FACADE.depth + 0.04, x: s * (OPEN_HALF - POST_W / 2), y: OPEN_H / 2, z: facadeZ, material: mats.doorFrame, name: 'door-frame-post' });
  });
  addBox({ w: OPEN_HALF * 2, h: 0.1, d: FACADE.depth + 0.04, x: 0, y: OPEN_H - 0.05, z: facadeZ, material: mats.doorFrame, name: 'door-frame-head', collider: false });
  addBox({ w: CLEAR_HALF * 2, h: 0.02, d: FACADE.depth, x: 0, y: 0.01, z: facadeZ, material: mats.metal, name: 'door-threshold', collider: false, castShadow: false });

  // Two leaves, each on a hinge pivot near the exterior face so they swing outward.
  const LEAF_W = CLEAR_HALF - 0.01; // leaves meet at the center with a 2cm gap
  const LEAF_H = OPEN_H - 0.12;
  const hingeZ = exteriorFaceZ + 0.06;
  function createDoorLeaf(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * CLEAR_HALF, 0.02 + LEAF_H / 2, hingeZ);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(LEAF_W, LEAF_H, 0.06), mats.doorMetal);
    // Offset the leaf so the pivot sits on its hinge edge and the leaf spans
    // toward the center. (The old code used the opposite sign, which tucked
    // both leaves inside the wall on either side of the opening.)
    leaf.position.x = -side * (LEAF_W / 2);
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    const pushBar = new THREE.Mesh(new THREE.BoxGeometry(LEAF_W * 0.75, 0.05, 0.04), mats.metal);
    pushBar.position.set(0, -0.12, 0.05); // hallway side
    leaf.add(pushBar);
    const doorWindow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.07), mats.glassDark);
    doorWindow.position.set(0, 0.5, 0);
    leaf.add(doorWindow);
    pivot.add(leaf);
    scene.add(pivot);
    return { pivot, leaf };
  }
  const leftDoor = createDoorLeaf(-1);
  const rightDoor = createDoorLeaf(1);

  // Closed doors are solid: an invisible blocker fills the doorway until they open.
  const doorBlocker = new THREE.Mesh(new THREE.BoxGeometry(CLEAR_HALF * 2, OPEN_H, FACADE.depth), mats.hidden);
  doorBlocker.position.set(0, OPEN_H / 2, facadeZ);
  doorBlocker.name = 'rear-door-blocker';
  scene.add(doorBlocker);
  colliders.push(doorBlocker);

  const OPEN_ANGLE = Math.PI * 0.47; // ~85deg; wider would swing the leaves back into the wall
  const rearDoorState = {
    opened: false, // the player pushed them open: they stay open for good
    isOpen: false, // fully swung open right now
    progress: 0, // 0 = shut, 1 = fully open
    npcHold: 0, // seconds to stay open for NPCs passing through (then the closer swings them shut)
    leaves: [leftDoor.leaf, rightDoor.leaf],
    open() {
      this.opened = true;
    },
    holdOpen(seconds) {
      this.npcHold = Math.max(this.npcHold, seconds);
    },
  };
  updatables.push({
    update(dt) {
      const s = rearDoorState;
      s.npcHold = Math.max(0, s.npcHold - dt);
      const wantOpen = s.opened || s.npcHold > 0;
      const prev = s.progress;
      s.progress = wantOpen ? Math.min(1, s.progress + dt * 1.1) : Math.max(0, s.progress - dt * 0.7);
      if (s.progress !== prev) {
        const eased = 1 - Math.pow(1 - s.progress, 3);
        leftDoor.pivot.rotation.y = eased * OPEN_ANGLE;
        rightDoor.pivot.rotation.y = -eased * OPEN_ANGLE;
      }
      s.isOpen = s.progress >= 1;

      // Solidity follows the doors: shut = the doorway is blocked; fully open =
      // the swung leaves are solid; mid-swing = neither.
      let changed = false;
      const blockerIn = colliders.includes(doorBlocker);
      if (s.progress > 0 && blockerIn) {
        removeFromArray(colliders, doorBlocker);
        changed = true;
      } else if (s.progress === 0 && !blockerIn) {
        colliders.push(doorBlocker);
        changed = true;
      }
      const leavesIn = colliders.includes(leftDoor.leaf);
      if (s.isOpen && !leavesIn) {
        colliders.push(leftDoor.leaf, rightDoor.leaf);
        changed = true;
      } else if (!s.isOpen && leavesIn) {
        removeFromArray(colliders, leftDoor.leaf);
        removeFromArray(colliders, rightDoor.leaf);
        changed = true;
      }
      if (changed) notifyCollidersChanged();
    },
  });
  rearDoorState.leaves.forEach((leaf) => {
    leaf.userData = { interactable: true, label: 'Push open the exit doors', type: 'door', doorState: rearDoorState };
    interactables.push(leaf);
  });

  // Glowing EXIT sign above the doors (inside) and a caged lamp over them (outside).
  addBox({ w: 0.68, h: 0.28, d: 0.04, x: 0, y: 2.72, z: doorZ, material: mats.doorFrame, name: 'exit-sign-housing', collider: false });
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.22), new THREE.MeshBasicMaterial({ map: createExitSignTexture() }));
  exitSign.position.set(0, 2.72, doorZ + 0.03);
  scene.add(exitSign);

  addBox({ w: 0.5, h: 0.14, d: 0.28, x: 0, y: 2.85, z: exteriorFaceZ - 0.14, material: mats.lamp, name: 'door-lamp', collider: false, castShadow: false });
  const doorLamp = new THREE.PointLight(0xffc98a, 5, 11, 1.8);
  doorLamp.position.set(0, 2.6, exteriorFaceZ - 0.8);
  scene.add(doorLamp);

  // =========================================================================
  // WEST WING: the gym + locker rooms (the school's right wing, seen from the
  // oak). A hollow shell; the steel side door on its west face (Chapter 3's
  // way in) has a real opening with a dark vestibule behind it.
  // =========================================================================
  const WING = { minX: -28, maxX: -FACADE.halfWidth, minZ: -39, maxZ: -14, height: 6.2 };
  const LOCKER_DOOR = { z: -30, half: 0.6, height: 2.25 };
  const wingWallMat = new THREE.MeshStandardMaterial({ map: createConcreteTexture(), roughness: 1, color: 0xa4a6a4 });
  /** Tile the concrete every `tile` meters on each face of a box. */
  const tileBox = (geo, w, h, d, tile) => {
    const uv = geo.attributes.uv;
    const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i;
        uv.setXY(k, (uv.getX(k) * faces[f][0]) / tile, (uv.getY(k) * faces[f][1]) / tile);
      }
    }
  };
  const wingWall = (w, h, d, x, y, z, name) => {
    const mesh = addBox({ w, h, d, x, y, z, material: wingWallMat, name, occluder: true, castShadow: false });
    tileBox(mesh.geometry, w, h, d, 3.2);
    return mesh;
  };
  {
    const wingW = WING.maxX - WING.minX;
    const wingD = WING.maxZ - WING.minZ;
    const cx = (WING.minX + WING.maxX) / 2;
    const cz = (WING.minZ + WING.maxZ) / 2;
    const wh = WING.height + 0.1; // (10cm below grade like the main building)
    const wy = (WING.height - 0.1) / 2;
    wingWall(wingW, wh, 0.4, cx, wy, WING.minZ + 0.2, 'wing-south');
    wingWall(wingW, wh, 0.4, cx, wy, WING.maxZ - 0.2, 'wing-north');
    wingWall(0.4, wh, exteriorFaceZ - WING.minZ, WING.maxX - 0.2, wy, (exteriorFaceZ + WING.minZ) / 2, 'wing-east'); // south of the main building
    // West wall, split around the locker room door.
    const westX = WING.minX + 0.2;
    const doorLo = LOCKER_DOOR.z - LOCKER_DOOR.half;
    const doorHi = LOCKER_DOOR.z + LOCKER_DOOR.half;
    const segS = doorLo - (WING.minZ + 0.4);
    const segN = WING.maxZ - 0.4 - doorHi;
    wingWall(0.4, wh, segS, westX, wy, WING.minZ + 0.4 + segS / 2, 'wing-west');
    wingWall(0.4, wh, segN, westX, wy, doorHi + segN / 2, 'wing-west');
    wingWall(0.4, WING.height - LOCKER_DOOR.height, LOCKER_DOOR.half * 2, westX, (WING.height + LOCKER_DOOR.height) / 2, LOCKER_DOOR.z, 'wing-west-header');
    addBox({ w: wingW + 0.6, h: 0.35, d: wingD + 0.6, x: cx, y: WING.height + 0.17, z: cz, material: mats.roof, name: 'wing-roof', collider: false, castShadow: false });
    // High gym windows along the south face (dark at night).
    for (let x = WING.minX + 2.2; x < WING.maxX - 1.5; x += 2.9) {
      addBox({ w: 2.1, h: 0.9, d: 0.06, x, y: 4.9, z: WING.minZ - 0.03, material: mats.windowGlow, name: 'gym-window', collider: false, castShadow: false });
    }
  }
  // GYMNASIUM lettering over the field.
  const gymSign = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 0.8), new THREE.MeshStandardMaterial({ map: (() => {
    const c = makeCanvas(512, 80);
    const g = c.getContext('2d');
    g.fillStyle = '#6d7072';
    g.fillRect(0, 0, 512, 80);
    g.fillStyle = '#1d3a6b';
    g.font = 'bold 54px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('G Y M N A S I U M', 256, 42);
    return toTexture(c);
  })(), roughness: 0.8 }));
  gymSign.position.set((WING.minX + WING.maxX) / 2, 3.4, WING.minZ - 0.02);
  gymSign.rotation.y = Math.PI;
  scene.add(gymSign);

  // The locker room door: steel, in a frame, lit by a caged lamp. It opens
  // inward, so it hangs on the wall's inner face (hinge on the +Z jamb): the
  // leaf swings into the vestibule, away from whoever's coming in from outside,
  // without clipping the jamb.
  const lockerDoorPivot = new THREE.Group();
  lockerDoorPivot.position.set(WING.minX + 0.33, 0.02, LOCKER_DOOR.z + LOCKER_DOOR.half - 0.03);
  scene.add(lockerDoorPivot);
  const lockerLeaf = new THREE.Mesh(new THREE.BoxGeometry(0.07, LOCKER_DOOR.height - 0.06, LOCKER_DOOR.half * 2 - 0.06), mats.doorMetal);
  lockerLeaf.position.set(0.035, (LOCKER_DOOR.height - 0.06) / 2, -(LOCKER_DOOR.half - 0.03));
  lockerLeaf.castShadow = true;
  lockerLeaf.name = 'locker-room-door';
  lockerDoorPivot.add(lockerLeaf);
  const leafSlot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.16), mats.glassDark); // wired-glass slot
  leafSlot.position.set(0, 0.45, 0.2);
  lockerLeaf.add(leafSlot);
  const leafPull = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.26, 0.04), mats.metal);
  leafPull.position.set(-0.05, -0.05, -0.42); // on the latch edge, away from the hinge (which is at the leaf's +Z edge)
  lockerLeaf.add(leafPull);
  [-1, 1].forEach((s) => {
    addBox({ w: 0.12, h: LOCKER_DOOR.height, d: 0.1, x: WING.minX - 0.02, y: LOCKER_DOOR.height / 2, z: LOCKER_DOOR.z + s * (LOCKER_DOOR.half + 0.03), material: mats.doorFrame, name: 'locker-door-frame', collider: false });
  });
  addBox({ w: 0.12, h: 0.1, d: LOCKER_DOOR.half * 2 + 0.16, x: WING.minX - 0.02, y: LOCKER_DOOR.height + 0.05, z: LOCKER_DOOR.z, material: mats.doorFrame, name: 'locker-door-frame', collider: false });
  addBox({ w: 0.9, h: 0.06, d: 1.6, x: WING.minX - 0.45, y: 0.03, z: LOCKER_DOOR.z, material: mats.metalDark, name: 'locker-door-step', collider: false, castShadow: false });
  addBox({ w: 0.2, h: 0.16, d: 0.34, x: WING.minX - 0.1, y: LOCKER_DOOR.height + 0.45, z: LOCKER_DOOR.z, material: mats.lamp, name: 'locker-door-lamp', collider: false, castShadow: false });
  const lockerSign = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.28), new THREE.MeshStandardMaterial({ map: (() => {
    const c = makeCanvas(256, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#1b3f73';
    g.fillRect(0, 0, 256, 64);
    g.strokeStyle = '#dfe6ee';
    g.lineWidth = 4;
    g.strokeRect(4, 4, 248, 56);
    g.fillStyle = '#dfe6ee';
    g.font = 'bold 26px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText("BOYS' LOCKER ROOM", 128, 34);
    return toTexture(c);
  })(), roughness: 0.7 }));
  lockerSign.position.set(WING.minX - 0.01, LOCKER_DOOR.height + 0.85, LOCKER_DOOR.z);
  lockerSign.rotation.y = -Math.PI / 2;
  scene.add(lockerSign);
  // Behind the door: a dark vestibule (so an open door shows a corridor, not the far walls).
  const vestibule = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, LOCKER_DOOR.height + 0.3, LOCKER_DOOR.half * 2 + 0.6),
    new THREE.MeshStandardMaterial({ color: 0x0d1012, roughness: 1, side: THREE.BackSide }),
  );
  vestibule.position.set(WING.minX + 0.4 + 1.2, (LOCKER_DOOR.height + 0.3) / 2, LOCKER_DOOR.z);
  scene.add(vestibule);
  colliders.push(lockerLeaf); // shut (and locked) until Chapter 3

  // =========================================================================
  // EXTERIOR GROUNDS  (Z < doorZ)
  // =========================================================================
  const treeZ = doorZ - 80;
  addPlane({ w: 260, d: 220, x: 20, y: -0.02, z: treeZ, material: mats.ground, name: 'exterior-ground' });

  // Straight dirt trail from the exit doors to the meeting spot under the oak.
  const trailStartZ = exteriorFaceZ;
  const trailEndZ = treeZ + 3;
  const trailLen = trailStartZ - trailEndZ;
  const straightTrailTex = createDirtTrailTexture();
  straightTrailTex.repeat.set(1, trailLen / 3.2);
  addPlane({ w: 3.2, d: trailLen, x: 0, y: -0.005, z: (trailStartZ + trailEndZ) / 2, material: new THREE.MeshStandardMaterial({ map: straightTrailTex, roughness: 0.95 }), name: 'dirt-trail' });

  // Outer perimeter loop trail (the warm-up), starting at the meeting spot and
  // heading west. The Phase 3 "first bend" is the turn north on the west side.
  const loopCurve = new THREE.CatmullRomCurve3(
    [
      [0, -103], [-16, -103.5], [-32, -100], [-46, -91], [-54, -76], [-54, -60], [-44, -48],
      [-26, -43], [-6, -42.5], [14, -43], [32, -46], [48, -54], [57, -68], [58, -86], [50, -99],
      [32, -104], [16, -103.5],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  const loopLength = loopCurve.getLength();
  const LOOP_WIDTH = 2.6;
  const loopMesh = new THREE.Mesh(
    buildRibbonGeometry(loopCurve, LOOP_WIDTH, 0.005, 360),
    new THREE.MeshStandardMaterial({ map: createDirtTrailTexture(), roughness: 0.95 }),
  );
  loopMesh.receiveShadow = true;
  loopMesh.name = 'perimeter-loop-trail';
  scene.add(loopMesh);

  const CHECKPOINT_COUNT = 12;
  const checkpoints = [];
  for (let k = 1; k <= CHECKPOINT_COUNT; k++) {
    checkpoints.push(loopCurve.getPointAt((k / CHECKPOINT_COUNT) % 1));
  }
  const bendRef = new THREE.Vector3(-50, 0, -84);
  let firstBendIndex = 0;
  checkpoints.forEach((p, i) => {
    if (p.distanceToSquared(bendRef) < checkpoints[firstBendIndex].distanceToSquared(bendRef)) firstBendIndex = i;
  });

  // Orange course-marking flags along both trails (two instanced meshes: two draw calls for all of them).
  const flagPostGeo = new THREE.CylinderGeometry(0.025, 0.03, 1.2, 6);
  const flagGeo = new THREE.BoxGeometry(0.01, 0.2, 0.3);
  const flagPosts = [];
  const flagCloths = [];
  const flagDummy = new THREE.Object3D();
  function addTrailFlag(x, z, heading) {
    flagDummy.position.set(x, 0.6, z);
    flagDummy.rotation.set(0, 0, 0);
    flagDummy.updateMatrix();
    flagPosts.push(flagDummy.matrix.clone());
    flagDummy.position.set(x, 1.08, z);
    flagDummy.rotation.set(0, heading, 0);
    flagDummy.translateZ(0.16);
    flagDummy.updateMatrix();
    flagCloths.push(flagDummy.matrix.clone());
  }
  let flagSide = 1;
  for (let d = 6; d < loopLength; d += 14) {
    const u = d / loopLength;
    const p = loopCurve.getPointAt(u);
    const t = loopCurve.getTangentAt(u);
    const off = (LOOP_WIDTH / 2 + 0.45) * flagSide;
    addTrailFlag(p.x - t.z * off, p.z + t.x * off, Math.atan2(t.x, t.z));
    flagSide = -flagSide;
  }
  for (let z = trailStartZ - 8; z > trailEndZ + 6; z -= 12) {
    addTrailFlag(flagSide * 2.1, z, 0);
    flagSide = -flagSide;
  }
  [[flagPostGeo, mats.flagPost, flagPosts], [flagGeo, mats.flag, flagCloths]].forEach(([geo, material, matrices]) => {
    const flags = new THREE.InstancedMesh(geo, material, matrices.length);
    matrices.forEach((m, i) => flags.setMatrixAt(i, m));
    flags.instanceMatrix.needsUpdate = true;
    flags.frustumCulled = false; // (spread over the whole grounds)
    flags.name = 'trail-flags';
    scene.add(flags);
  });

  // Massive focal oak tree.
  const treeGroup = new THREE.Group();
  treeGroup.position.set(0, 0, treeZ);
  scene.add(treeGroup);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.9, 9, 12), mats.treeBark);
  trunk.position.y = 4.5;
  trunk.castShadow = true;
  trunk.name = 'oak-trunk';
  treeGroup.add(trunk);
  // Root angles leave a clear path to the hidden door (which faces the player's car).
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 1.0;
    const rootMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 2.2), mats.treeBark);
    rootMesh.position.set(Math.sin(a) * 1.9, 0.18, Math.cos(a) * 1.9);
    rootMesh.rotation.set(0.22, a, 0, 'YXZ');
    treeGroup.add(rootMesh);
  }
  [[1.7, 8.2, 0, 0, -0.85], [-1.7, 8.0, 0, 0, 0.85], [0, 8.0, 1.6, 0.8, 0]].forEach(([x, y, z, rx, rz]) => {
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.55, 5.5, 8), mats.treeBark);
    branch.position.set(x, y, z);
    branch.rotation.set(rx, 0, rz);
    treeGroup.add(branch);
  });
  [
    [0, 11, 0, 5.0], [3.4, 10, 1.6, 3.8], [-3.6, 10.2, -1.2, 4.0], [2.2, 12.6, -2.6, 3.4],
    [-2.4, 12.2, 2.6, 3.4], [0.4, 13.8, 0.2, 3.0], [0, 9.6, 3.4, 3.2], [0.6, 9.8, -3.6, 3.2],
  ].forEach(([x, y, z, r]) => {
    const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mats.foliage);
    foliage.position.set(x, y, z);
    foliage.castShadow = true;
    treeGroup.add(foliage);
  });
  colliders.push(trunk);
  occluders.push(trunk);

  // Coach Billing + the team waiting under the tree; Other Ben arrives later.
  const coachMesh = createHumanoid(COACH_BILLING_LOOK);
  coachMesh.position.set(0, 0, treeZ + 3.8);
  coachMesh.name = 'coach-billing';
  scene.add(coachMesh);
  const coach = new Character(coachMesh, { radius: 0.42, name: 'Coach Billing' });

  const runnerLooks = [
    { shirt: 0xaa3344, skin: 0xe0b48a, hair: 0x2b1d14 },
    { shirt: 0x3366aa, skin: 0x8d5a3b, hair: 0x111111 },
    { shirt: 0x448855, skin: 0xd9a679, hair: 0x6b4a2b },
    { shirt: 0xcc8833, skin: 0xb07a52, hair: 0x1a1a1a },
    { shirt: 0x6a4c9c, skin: 0xe8c39e, hair: 0x8a6a3a },
  ];
  const runners = [[-3.4, 7.1], [-1.2, 7.8], [1.2, 7.8], [3.4, 7.1], [4.8, 5.4]].map(([x, dz], i) => {
    const mesh = createHumanoid({ ...runnerLooks[i], pants: 0x1c1c22, shorts: true, bareArms: true });
    mesh.position.set(x, 0, treeZ + dz);
    mesh.rotation.y = Math.atan2(coachMesh.position.x - x, coachMesh.position.z - (treeZ + dz));
    mesh.name = `runner-${i}`;
    scene.add(mesh);
    const runner = new Character(mesh, { radius: 0.32, name: `Runner ${i + 1}` });
    runner.faceTowards(coachMesh.position);
    return runner;
  });

  const benStart = new THREE.Vector3(22, 0, -84);
  const benMesh = createHumanoid(OTHER_BEN_LOOK);
  benMesh.position.copy(benStart);
  benMesh.visible = false; // spawned by the tree cutscene
  benMesh.name = 'other-ben';
  scene.add(benMesh);
  const ben = new Character(benMesh, { radius: 0.32, name: 'Other Ben' });

  // Assistant coaches: chatting under the lot light until Phase 3, then they
  // grab flashlights and patrol the parking lot and the east perimeter.
  const lageMesh = createHumanoid({ shirt: 0x1f2f4f, pants: 0x3a3d42, hair: 0x2a2a2a, skin: 0xe0b48a, scale: 1.12, raincoat: true, whistle: true, cap: true });
  lageMesh.position.set(21.3, 0, -69.9);
  lageMesh.name = 'coach-lage';
  scene.add(lageMesh);
  const coachLage = new Character(lageMesh, { radius: 0.4, name: 'Coach Lage' });
  const tomMesh = createHumanoid({ shirt: 0x8c2a22, pants: 0x2b2b30, hair: 0x5a3a22, skin: 0xb07a52, scale: 1.08, raincoat: true, whistle: true, hood: true });
  tomMesh.position.set(22.6, 0, -71.5);
  tomMesh.name = 'coach-tom';
  scene.add(tomMesh);
  const coachTom = new Character(tomMesh, { radius: 0.4, name: 'Coach Tom' });
  coachLage.faceTowards(tomMesh.position);
  coachTom.faceTowards(lageMesh.position);

  const npcList = [coach, coachLage, coachTom, ...runners, ...students, ben];
  updatables.push({
    update(dt) {
      for (const npc of npcList) npc.update(dt);
    },
  });

  // Parking lot: asphalt, painted bays, parked cars, and the player's car apart from the rest.
  addPlane({ w: 14, d: 36, x: 28, y: -0.012, z: -70, material: mats.asphalt, name: 'parking-lot' });
  [-63.25, -68.75, -74.25, -79.75, -85.25].forEach((z) => {
    addPlane({ w: 4.6, d: 0.12, x: 28, y: -0.006, z, material: mats.paint, name: 'parking-line' });
  });
  // Sodium lot light (a pool of light by the cars).
  addBox({ w: 0.18, h: 6.2, d: 0.18, x: 20.6, y: 3.1, z: -72, material: mats.metalDark, name: 'lot-light-pole', occluder: true });
  addBox({ w: 0.9, h: 0.14, d: 0.4, x: 21.0, y: 6.2, z: -72, material: mats.lamp, name: 'lot-light-head', collider: false, castShadow: false });
  const lotLight = new THREE.PointLight(0xffb45a, 16, 20, 1.4);
  lotLight.position.set(21.2, 5.9, -72);
  scene.add(lotLight);

  function createCar(color) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 4.2), mats.carBody(color));
    body.position.y = 0.5;
    body.castShadow = true;
    car.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.0), mats.carGlass);
    cabin.position.set(0, 1.05, -0.2);
    cabin.castShadow = true;
    car.add(cabin);
    const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.3, 12);
    [[-0.95, 0.32, 1.4], [0.95, 0.32, 1.4], [-0.95, 0.32, -1.4], [0.95, 0.32, -1.4]].forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(wheelGeo, mats.tire);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, y, z);
      car.add(wheel);
    });
    return car;
  }
  [[0x8a1f1f, -66], [0x2a3f6b, -71.5], [0x5a5a5a, -77], [0x1f5a3f, -82.5]].forEach(([color, z]) => {
    const car = createCar(color);
    car.position.set(28, 0, z);
    car.rotation.y = Math.PI / 2;
    scene.add(car);
    colliders.push(car); // whole group treated as one collider box
    occluders.push(car);
  });
  // The player's car: parked at the lot's west edge, nose out toward the oak, so
  // the Phase 4 passenger-seat view looks straight at the tree through the windshield.
  const playersCar = createCar(0x232323);
  playersCar.position.set(23.5, 0, -60);
  playersCar.rotation.y = Math.atan2(0 - playersCar.position.x, treeZ - playersCar.position.z);
  playersCar.name = 'players-car';
  // [E] Get in car hitbox; main.js only makes it interactable once Phase 3 starts.
  const playersCarHitbox = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.5, 4.5), mats.hidden);
  playersCarHitbox.position.y = 0.75;
  playersCarHitbox.userData = { interactable: true, label: 'Get in car', type: 'car' };
  playersCar.add(playersCarHitbox);
  scene.add(playersCar);
  colliders.push(playersCar);
  occluders.push(playersCar);

  // Dumpsters against the back of the school, near the exit (stealth cover).
  [-6, 6].forEach((x) => {
    addBox({ w: 1.6, h: 1.3, d: 1.1, x, y: 0.65, z: doorZ - 3, material: mats.dumpster, name: 'dumpster', rotationY: 0.1, occluder: true });
    addBox({ w: 1.66, h: 0.06, d: 1.16, x, y: 1.33, z: doorZ - 3, material: mats.dumpsterLid, name: 'dumpster-lid', collider: false, rotationY: 0.1 });
  });

  // ---- Phase 3 stealth cover across the field ------------------------------
  // Equipment shed on the west field; the retry checkpoint is behind it (west side).
  const shed = { x: -36, z: -84, w: 4, d: 3, h: 2.6 };
  addBox({ w: shed.w, h: shed.h, d: shed.d, x: shed.x, y: shed.h / 2, z: shed.z, material: mats.shedWall, name: 'equipment-shed', occluder: true });
  const shedRoof = addBox({ w: shed.w + 0.5, h: 0.12, d: shed.d + 0.6, x: shed.x, y: shed.h + 0.12, z: shed.z, material: mats.roof, name: 'shed-roof', collider: false });
  shedRoof.rotation.z = 0.08;
  addBox({ w: 0.06, h: 2.0, d: 1.3, x: shed.x + shed.w / 2 + 0.03, y: 1.0, z: shed.z, material: mats.doorWood, name: 'shed-door', collider: false });

  // Stacked equipment crates.
  [[-24.6, 0.6, -72.0, 0.05], [-23.3, 0.6, -72.3, -0.1], [-24.0, 1.8, -72.1, 0.2]].forEach(([x, y, z, r]) => {
    addBox({ w: 1.2, h: 1.2, d: 1.2, x, y, z, material: mats.crate, name: 'equipment-crate', rotationY: r, occluder: true });
  });

  // Aluminum bleachers facing the field (tiers rise to the north, with a back rail).
  [[0.6, -67.2], [1.2, -66.0], [1.8, -64.8]].forEach(([h, z]) => {
    addBox({ w: 9, h, d: 1.2, x: -7, y: h / 2, z, material: mats.bleacher, name: 'bleacher-tier', occluder: true });
  });
  addBox({ w: 9, h: 0.55, d: 0.06, x: -7, y: 2.075, z: -64.23, material: mats.bleacher, name: 'bleacher-back-rail', collider: false, occluder: true });

  // Storage container between the bleachers and the lot.
  addBox({ w: 5, h: 2.6, d: 2.5, x: 6, y: 1.3, z: -70, material: mats.container, name: 'storage-container', occluder: true });

  // ---- Getaway cover around the lot and the school's service area -----------
  // (Placed clear of all three coaches' patrol lines, the loop and the trails.)
  // Extra dumpsters: behind the east wing, and one at the lot's west edge.
  [[15.8, -37.2, 0.05], [17.8, -37.4, -0.04], [17.6, -60.4, 0.1]].forEach(([x, z, r]) => {
    addBox({ w: 1.6, h: 1.3, d: 1.1, x, y: 0.65, z, material: mats.dumpster, name: 'dumpster', rotationY: r, occluder: true });
    addBox({ w: 1.66, h: 0.06, d: 1.16, x, y: 1.33, z, material: mats.dumpsterLid, name: 'dumpster-lid', collider: false, rotationY: r });
  });
  // Blue recycling bins in pairs.
  [[26.2, -52.6], [27.1, -52.7], [17.4, -66.2], [18.2, -66.4], [38.8, -62.0], [38.9, -62.9]].forEach(([x, z], i) => {
    const r = (i % 3) * 0.15;
    addBox({ w: 0.7, h: 1.1, d: 0.7, x, y: 0.55, z, material: mats.recycling, name: 'recycling-bin', rotationY: r, occluder: true });
    addBox({ w: 0.74, h: 0.06, d: 0.74, x, y: 1.13, z, material: mats.recyclingLid, name: 'recycling-lid', collider: false, rotationY: r });
  });
  // School utility boxes: two electrical cabinets and a transformer.
  [[20.5, -47.5, 1.0, 1.4, 0.7], [21.52, -47.5, 1.0, 1.4, 0.7], [9.5, -57.5, 1.6, 1.3, 1.4]].forEach(([x, z, w, h, d]) => {
    addBox({ w, h, d, x, y: h / 2, z, material: mats.utilityBox, name: 'utility-box', occluder: true });
    addBox({ w: 0.22, h: 0.22, d: 0.02, x, y: h * 0.7, z: z + d / 2 + 0.011, material: mats.warningSticker, name: 'utility-sticker', collider: false, castShadow: false });
  });
  // Faculty cars parked around the edges of the lot.
  [[0x6f6a5e, 31.2, -57.8, Math.PI / 2], [0x3b4a57, 32.2, -92.5, 0.1], [0x7d7d7d, 12.5, -88.5, Math.PI / 2 + 0.2]].forEach(([color, x, z, r]) => {
    const car = createCar(color);
    car.position.set(x, 0, z);
    car.rotation.y = r;
    car.name = 'faculty-car';
    scene.add(car);
    colliders.push(car);
    occluders.push(car);
  });

  // ---- Classroom dismissal: at the bell, classmates file out one by one -----
  // Down the aisles, out the classroom door, down the hallway, through the exit
  // doors (the closer swings them shut behind the last kid), then a jog through
  // the rain to the oak where the team meets.
  const studentSpots = [
    [-6.2, -106.2], [6.4, -107.6], [-7.1, -108.7], [7.4, -110.1],
    [-6.0, -111.2], [5.8, -112.5], [-4.0, -113.0], [8.6, -107.0],
  ].map(([x, z]) => ({ x, z: z - (-114) + treeZ }));
  const classroom = { dismissed: false, elapsed: 0, dismiss() { this.dismissed = true; } };

  async function walkToPractice(student, order) {
    standUp(student.mesh);
    const d = student.desk;
    const aisleX = d.x < -1 ? -2 : d.x > 1 ? 2 : order % 2 ? 2 : -2;
    const lane = ((order % 3) - 1) * 0.45; // spread them across the hallway
    const pace = 1.35 + (order % 3) * 0.12;
    await student.walkRoute([
      { x: aisleX, z: d.z - CHAIR_OFFSET },
      { x: aisleX, z: CR.minZ + 1.4 },
      { x: 0, z: CR.minZ + 0.6 },
      { x: lane * 0.5, z: CR.minZ - 1.2 },
      { x: lane, z: -24 },
      { x: lane * 0.4, z: doorZ + 1.4 },
      { x: 0, z: doorZ - 1.2 },
    ], pace);
    if (student.cancelExit) return;
    // Out in the rain: jog to the tree.
    const spot = studentSpots[order % studentSpots.length];
    await student.walkRoute([
      { x: lane * 1.5, z: doorZ - 6 },
      { x: lane * 2, z: treeZ + 16 },
      { x: spot.x > 0 ? 5 : -5, z: treeZ + 12 },
      { x: spot.x, z: spot.z },
    ], 3.8);
    if (student.cancelExit) return;
    student.atTree = true;
    student.faceTowards(coach.position);
  }

  updatables.push({
    update(dt) {
      if (!classroom.dismissed) return;
      classroom.elapsed += dt;
      students.forEach((student, order) => {
        if (!student.leaving && classroom.elapsed >= 0.6 + order * 1.4) {
          student.leaving = true;
          walkToPractice(student, order);
        }
        // Push the exit doors open while passing through them.
        if (student.leaving && !student.outside) {
          const p = student.position;
          if (Math.abs(p.x) < 2.2 && p.z < doorZ + 3.2 && p.z > doorZ - 2) rearDoorState.holdOpen(1.0);
          if (p.z < doorZ - 2) student.outside = true;
        }
      });
    },
  });

  // ---- Rain -----------------------------------------------------------------
  // A box of streak sprites that travels with the camera. Drops over the school
  // (and its walkway canopy) or the player's car are parked out of sight, so it
  // never rains indoors. Also drives the rain audio's indoor/outdoor mix.
  const RAIN = { count: 3200, area: 36, height: 20, windX: 1.4 };
  const rainPos = new Float32Array(RAIN.count * 3);
  const rainOut = new Float32Array(RAIN.count * 3);
  const rainSpeed = new Float32Array(RAIN.count);
  for (let i = 0; i < RAIN.count; i++) {
    rainPos[i * 3] = (Math.random() - 0.5) * RAIN.area;
    rainPos[i * 3 + 1] = Math.random() * RAIN.height;
    rainPos[i * 3 + 2] = (Math.random() - 0.5) * RAIN.area;
    rainSpeed[i] = 13 + Math.random() * 6;
  }
  const rainGeo = new THREE.BufferGeometry();
  const rainAttr = new THREE.BufferAttribute(rainOut, 3);
  rainAttr.setUsage(THREE.DynamicDrawUsage);
  rainGeo.setAttribute('position', rainAttr);
  const rainPoints = new THREE.Points(rainGeo, mats.rain);
  rainPoints.frustumCulled = false; // positions follow the camera every frame
  rainPoints.name = 'rain';
  scene.add(rainPoints);

  const shelter = { minX: -FACADE.halfWidth, maxX: FACADE.halfWidth, minZ: exteriorFaceZ - 4.6, maxZ: shellFrontZ };
  const carShelterR2 = 2.7 * 2.7;
  const rain = {
    camera: null,
    exposureOverride: null, // cutscenes can force the audio mix (e.g. muffled inside the car)
    _lastExposure: -1,
    update(dt) {
      const cam = this.camera;
      if (!cam) return;
      const cx = cam.position.x;
      const cz = cam.position.z;
      const half = RAIN.area / 2;
      const carX = playersCar.position.x;
      const carZ = playersCar.position.z;
      for (let i = 0; i < RAIN.count; i++) {
        const o = i * 3;
        let x = rainPos[o] + RAIN.windX * dt;
        let y = rainPos[o + 1] - rainSpeed[i] * dt;
        let z = rainPos[o + 2];
        if (y < 0) {
          y += RAIN.height;
          x = cx + (Math.random() - 0.5) * RAIN.area;
          z = cz + (Math.random() - 0.5) * RAIN.area;
        }
        if (x - cx > half) x -= RAIN.area;
        else if (x - cx < -half) x += RAIN.area;
        if (z - cz > half) z -= RAIN.area;
        else if (z - cz < -half) z += RAIN.area;
        rainPos[o] = x;
        rainPos[o + 1] = y;
        rainPos[o + 2] = z;
        const sheltered =
          (x > shelter.minX && x < shelter.maxX && z > shelter.minZ && z < shelter.maxZ) ||
          (x - carX) ** 2 + (z - carZ) ** 2 < carShelterR2;
        rainOut[o] = x;
        rainOut[o + 1] = sheltered ? -1000 : y;
        rainOut[o + 2] = z;
      }
      rainAttr.needsUpdate = true;

      // Audio: full storm outside; inside only a muffled roar, louder near the open exit.
      let exposure = this.exposureOverride;
      if (exposure === null) {
        const outside = cz < doorZ - 0.3 || Math.abs(cx) > FACADE.halfWidth || cz > shellFrontZ;
        if (outside) exposure = 1;
        else {
          const d = Math.hypot(cx, cz - doorZ);
          exposure = 0.06 + rearDoorState.progress * Math.max(0, 1 - d / 16) * 0.75;
        }
      }
      if (Math.abs(exposure - this._lastExposure) > 0.01) {
        this._lastExposure = exposure;
        setRainExposure(exposure);
      }
    },
  };
  updatables.push(rain);

  return {
    colliders,
    interactables,
    updatables,
    events,
    spawn,
    pickups: { shoes: shoesGroup, bottle },
    doors: { rear: rearDoorState },
    npcs: { coach, coachLage, coachTom, ben, runners, students, all: npcList },
    classroom,
    rain,
    attachCamera(camera) {
      rain.camera = camera;
    },
    /** Chapter 2 returns at 1:30 AM: the school's windows go dark. */
    setNight() {
      mats.windowGlow.emissiveIntensity = 0.04;
    },
    trail: { loop: loopCurve, loopLength, loopWidth: LOOP_WIDTH, checkpoints, firstBendIndex },
    tree: { group: treeGroup, trunk, baseRadius: 1.9, topRadius: 1.2, height: 9 },
    wing: WING,
    // Chapter 3's way in: the west wing's steel side door (opens inward: pivot.rotation.y -> -1.4).
    lockerRoomDoor: {
      pivot: lockerDoorPivot,
      leaf: lockerLeaf,
      position: new THREE.Vector3(WING.minX, 0, LOCKER_DOOR.z),
      outside: new THREE.Vector3(WING.minX - 1.3, 0, LOCKER_DOOR.z),
      marker: new THREE.Vector3(WING.minX - 0.45, 2.75, LOCKER_DOOR.z),
    },
    playersCar,
    playersCarHitbox,
    stealth: {
      occluders,
      // Phase 3 flashlight patrols. Each coach walks out to route[0] first.
      guards: [
        {
          id: 'billing',
          name: 'Coach Billing',
          character: coach,
          callout: 'HEY! You two! Where do you think you are going?!',
          route: [ // the open field between the school and the oak
            { x: -6, z: -84, pause: 1.5 },
            { x: -20, z: -60, pause: 2.5 },
            { x: -2, z: -50, pause: 2 },
            { x: 16, z: -52, pause: 2.5 },
            { x: 14, z: -80, pause: 1.5 },
          ],
        },
        {
          id: 'lage',
          name: 'Coach Lage',
          character: coachLage,
          callout: 'Freeze! Both of you, back on the trail!',
          route: [ // a ring around the parking lot
            { x: 19.5, z: -54.5, pause: 2 },
            { x: 19.5, z: -87, pause: 1.5 },
            { x: 36.5, z: -87, pause: 2 },
            { x: 36.5, z: -54, pause: 1.5 },
          ],
        },
        {
          id: 'tom',
          name: 'Coach Tom',
          character: coachTom,
          callout: 'Nice try, boys. Back to practice!',
          route: [ // the east perimeter, school corner to the south end
            { x: 14, z: -44, pause: 2 },
            { x: 40, z: -48, pause: 1.5 },
            { x: 46, z: -72, pause: 2 },
            { x: 42, z: -94, pause: 1.5 },
            { x: 46, z: -72, pause: 0.5 },
            { x: 40, z: -48, pause: 0.5 },
          ],
        },
      ],
      // Retry checkpoint: behind (west of) the equipment shed, facing the field.
      checkpoint: { position: new THREE.Vector3(shed.x - shed.w / 2 - 2, 0, shed.z), yaw: -Math.PI / 2 },
    },
    markers: {
      fountain: new THREE.Vector3(fountainWallX + 0.22, 1.55, fountainZ),
      exitDoor: new THREE.Vector3(0, 2.1, doorZ + 0.9),
      tree: new THREE.Vector3(0, 19, treeZ),
      car: new THREE.Vector3(playersCar.position.x, 2.5, playersCar.position.z),
    },
    landmarks: {
      doorZ,
      treeZ,
      treePosition: new THREE.Vector3(0, 0, treeZ),
      meetingCenter: new THREE.Vector3(0, 0, treeZ + 6.5),
      meetingRadius: 10,
      joinSpot: new THREE.Vector3(-2.4, 0, treeZ + 10.7),
      benStart,
      benConfront: new THREE.Vector3(3.2, 0, treeZ + 10),
      benWhisper: new THREE.Vector3(-0.9, 0, treeZ + 11.5),
      coachSpot: new THREE.Vector3(0, 0, treeZ + 3.8),
      // Where Coach pulls Ben aside (east of the huddle, in clear view of the group).
      asideVia: new THREE.Vector3(4.1, 0, treeZ + 6.25), // gap between two runners
      asideCoach: new THREE.Vector3(7.4, 0, treeZ + 9.4),
      asideBen: new THREE.Vector3(8.6, 0, treeZ + 10.3),
      playersCarPosition: playersCar.position.clone(),
    },
  };
}

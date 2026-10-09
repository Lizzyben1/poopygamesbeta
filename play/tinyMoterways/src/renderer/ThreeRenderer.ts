import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COLORS } from '../levels/CityConfigs.ts';
import { DAY_SECONDS, LOT } from '../simulation/CityDirector.ts';
import { CAR_LENGTH, CAR_WIDTH, RING_RADIUS } from '../simulation/RoadGraph.ts';
import type { RoadGraph } from '../simulation/RoadGraph.ts';
import type { CityDirector } from '../simulation/CityDirector.ts';
import type { TrafficEngine } from '../simulation/TrafficEngine.ts';
import type { CityConfig, Destination, House, PathSample, Vec3 } from '../types.ts';

const RAD = Math.PI / 180;
/** The camera looks down from the south with the grid square on screen. */
const VIEW = { pitch: 58 * RAD, yaw: 0 };
const RETURN = 3;        // seconds after the player last moved the camera before it goes back to framing the city
const ROAD_W = 0.5;
const BORDER = 0.06;
const TEX = 32;          // terrain texture pixels per cell
const MAX_CARS = 1024;
const TRAIN = 3.6;       // length of a train, in cells
const MIN_HALF = 3.2;    // closest zoom: half the screen height, in cells

type Ribbons = [positions: number[], colors: number[]];

/** Append a flat strip of the given width following `pts`. */
function ribbon(out: Ribbons, pts: Vec3[], width: number, color: THREE.Color, lift: number) {
  const [pos, col] = out, half = width / 2;
  let ax = 0, az = 0, bx = 0, bz = 0, y = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], before = pts[Math.max(0, i - 1)], after = pts[Math.min(pts.length - 1, i + 1)];
    const dx = after.x - before.x, dz = after.z - before.z, n = Math.hypot(dx, dz) || 1;
    const nx = (-dz / n) * half, nz = (dx / n) * half;
    if (i > 0) {
      pos.push(ax, y, az, p.x + nx, p.y + lift, p.z + nz, bx, y, bz);
      pos.push(bx, y, bz, p.x + nx, p.y + lift, p.z + nz, p.x - nx, p.y + lift, p.z - nz);
      for (let k = 0; k < 6; k++) col.push(color.r, color.g, color.b);
    }
    ax = p.x + nx; az = p.z + nz; bx = p.x - nx; bz = p.z - nz; y = p.y + lift;
  }
}

function disc(out: Ribbons, c: Vec3, radius: number, color: THREE.Color, lift: number) {
  const [pos, col] = out, y = c.y + lift;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2, b = ((i + 1) / 20) * Math.PI * 2;
    pos.push(c.x, y, c.z, c.x + Math.cos(b) * radius, y, c.z + Math.sin(b) * radius, c.x + Math.cos(a) * radius, y, c.z + Math.sin(a) * radius);
    for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b);
  }
}

/** Stable per-cell pseudo-random number in 0..1, so scenery looks the same every frame and every run. */
const hash = (id: number) => {
  const s = Math.sin(id * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

const smooth = (u: number) => {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
};

/** What the pointer is doing, for the renderer to draw. */
export interface Cursor {
  cell: number;        // the cell being pointed at, -1 for none
  span: number;        // cells across: 1, or 3 for a roundabout
  ok: boolean;         // whether the tool could act there
  touch: boolean;      // draw the large ring and crosshair that stay visible around a fingertip
  from: number;        // motorway start cell, -1 if none
  drive: [house: number, facing: number] | null;   // driveway being turned
  gate: number;        // a car-park entrance to point out, -1 for none
}

/**
 * Draws the city with Three.js: an orthographic camera that pans, zooms and follows the city as it
 * grows; a sun that crosses the sky once a day; extruded road ribbons rebuilt whenever the graph
 * changes; instanced cars; and low-poly buildings and scenery.
 */
export class ThreeRenderer {
  /** On-screen size of one cell in CSS pixels, for sizing the HTML pin markers. */
  cellPx = 24;
  /** 0 = shadows off, 1 = light shadows, 2 = full. Lowered on small or slow devices. */
  quality = 2;

  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private graph: RoadGraph;
  private config: CityConfig;
  private dark: boolean;
  private version = -1;

  // camera: `focus` is the ground point at the centre of the screen, `half` half the screen height in cells
  private focus = new THREE.Vector3();
  private half = 12;
  private follow = true;   // frame the whole city; off only for a moment after the player pans or zooms
  private idle = 0;        // seconds since the player last steered the camera or used a tool
  private rail = 0;        // the trains' clock: game time, smoothed so they glide at any frame rate

  private ambient = new THREE.AmbientLight(0xffffff, 1.75);
  private sun = new THREE.DirectionalLight(0xffffff, 1.7);
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private terrain: THREE.CanvasTexture;
  private roads = new THREE.Group();
  private decor = new THREE.Group();
  private cars: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private buildings = new Map<number, THREE.Group>();
  private signals: { bar: THREE.Mesh; node: number; from: number }[] = [];
  private trains: { mesh: THREE.Mesh; x: number; z: number; dx: number; dz: number; from: number; to: number }[] = [];   // from..to: the stretch of the line that is on the map
  private square: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private target = new THREE.Group();   // ring and crosshair shown round a fingertip
  private beam: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private stubHint: THREE.Mesh;
  private ghost = new THREE.Group();    // a roundabout about to be placed
  private ghostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
  private gate: THREE.Mesh;             // marks the one cell a car park is entered from
  private decks = new THREE.Group();    // motorway decks and pillars, which fade when the pointer is behind them
  private spans: { a: number; b: number; pts: Vec3[] }[] = [];
  private deckFade = 1;

  private carColors = COLORS.map(c => new THREE.Color(c));
  private colorMats = COLORS.map(c => new THREE.MeshLambertMaterial({ color: c }));
  private roofMats = COLORS.map(c => new THREE.MeshLambertMaterial({ color: new THREE.Color(c).multiplyScalar(0.8), flatShading: true }));
  private white = new THREE.MeshLambertMaterial({ color: '#FBFAF6' });
  private concrete = new THREE.MeshLambertMaterial({ color: '#B8B3A9' });
  private tunnelMat = new THREE.MeshLambertMaterial({ color: '#2B2D30' });
  private islandMat = new THREE.MeshLambertMaterial({ color: '#B7D9A4' });
  private rockMat = new THREE.MeshLambertMaterial({ flatShading: true });
  private ballastMat = new THREE.MeshLambertMaterial();
  private lotMat = new THREE.MeshLambertMaterial();
  private roadMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private deckMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true });
  private pillarMat = new THREE.MeshLambertMaterial({ color: '#B8B3A9', transparent: true });
  private kerbMat = new THREE.MeshLambertMaterial();
  private goMat = new THREE.MeshBasicMaterial({ color: '#2ECC71' });
  private stopMat = new THREE.MeshBasicMaterial({ color: '#E74C3C' });
  private glass = new THREE.MeshBasicMaterial();   // windows: dull glass by day, lit at night
  private lampMat = new THREE.MeshBasicMaterial({ color: '#FFF3C4' });
  private beamMat: THREE.MeshBasicMaterial;

  private houseGeo = new RoundedBoxGeometry(0.58, 0.4, 0.58, 3, 0.07);
  private roofGeo = new THREE.ConeGeometry(0.45, 0.24, 4);
  private paneGeo = new THREE.BoxGeometry(0.13, 0.11, 0.012);
  private pillarGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 8);
  private pierGeo = new THREE.BoxGeometry(0.5, 0.16, 0.5);
  private portalGeo = new THREE.BoxGeometry(0.66, 0.36, 0.14);
  private islandGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.1, 32);
  private treeGeo = new THREE.IcosahedronGeometry(0.2, 0);
  private barGeo = new THREE.BoxGeometry(ROAD_W, 0.03, 0.07);

  private dummy = new THREE.Object3D();
  private flat = new THREE.Object3D();
  private ray = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private v2 = new THREE.Vector2();
  private v3 = new THREE.Vector3();
  private night = 0;

  constructor(host: HTMLElement, graph: RoadGraph, config: CityConfig, dark: boolean) {
    this.graph = graph;
    this.config = config;
    this.dark = dark;
    const { width: w, height: h } = graph, cx = (w - 1) / 2, cz = (h - 1) / 2;

    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.append(this.renderer.domElement);

    this.sun.target.position.set(cx, 0, cz);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    const span = Math.hypot(w, h) / 2 + 3;
    Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 120 });
    this.scene.add(this.ambient, this.sun, this.sun.target);

    // ground: an endless lit plane, with the terrain painted on a map-sized sheet just above it
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial());
    this.ground.position.set(cx, -0.01, cz);
    const canvas = document.createElement('canvas');
    canvas.width = w * TEX;
    canvas.height = h * TEX;
    this.terrain = new THREE.CanvasTexture(canvas);
    this.terrain.colorSpace = THREE.SRGBColorSpace;
    this.terrain.anisotropy = 4;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: this.terrain, transparent: true }));
    sheet.position.set(cx, 0, cz);
    for (const plane of [this.ground, sheet]) {
      plane.rotation.x = -Math.PI / 2;
      plane.receiveShadow = true;
      this.scene.add(plane);
    }
    this.addScenery();

    this.cars = new THREE.InstancedMesh(new RoundedBoxGeometry(CAR_WIDTH, 0.13, CAR_LENGTH, 2, 0.045), new THREE.MeshLambertMaterial(), MAX_CARS);
    this.cars.castShadow = true;
    // headlights: a bright bar across the nose of each car, and a soft pool of light on the road ahead
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(CAR_WIDTH * 0.8, 0.035, 0.03), this.lampMat, MAX_CARS);
    const glow = document.createElement('canvas');
    glow.width = glow.height = 64;
    const paint = glow.getContext('2d')!, fade = paint.createRadialGradient(32, 60, 2, 32, 34, 34);
    fade.addColorStop(0, 'rgba(255,240,190,0.9)');
    fade.addColorStop(1, 'rgba(255,240,190,0)');
    paint.fillStyle = fade;
    paint.fillRect(0, 0, 64, 64);
    this.beamMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glow), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.beams = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.42, 0.62), this.beamMat, MAX_CARS);
    for (const mesh of [this.cars, this.lamps, this.beams]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
    }
    this.flat.rotation.order = 'YXZ';

    // pointer feedback
    this.square = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.14, depthWrite: false }));
    this.square.rotation.x = -Math.PI / 2;
    const guide = new THREE.MeshBasicMaterial({ color: '#F0A860', transparent: true, opacity: 0.9, depthTest: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.98, 40), guide);
    ring.rotation.x = -Math.PI / 2;
    this.target.add(ring);
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 1.1), guide);
      tick.rotation.set(-Math.PI / 2, 0, (i * Math.PI) / 2);
      tick.position.set(Math.sin((i * Math.PI) / 2) * -1.6, 0, Math.cos((i * Math.PI) / 2) * -1.6);
      this.target.add(tick);
    }
    this.target.renderOrder = 5;
    this.beam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 1), new THREE.MeshBasicMaterial({ color: '#F0A860' }));
    this.stubHint = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 1), new THREE.MeshBasicMaterial({ color: '#F0A860', transparent: true, opacity: 0.85 }));
    // a roundabout shows as itself before it is placed: the ring of road and the island in the middle
    const lane = new THREE.Mesh(new THREE.RingGeometry(RING_RADIUS - ROAD_W / 2 - 0.04, RING_RADIUS + ROAD_W / 2 + 0.04, 48), this.ghostMat);
    const isle = new THREE.Mesh(new THREE.CircleGeometry(0.62, 32), new THREE.MeshBasicMaterial({ color: '#B7D9A4', transparent: true, opacity: 0.75, depthWrite: false }));
    lane.rotation.x = isle.rotation.x = -Math.PI / 2;
    this.ghost.add(lane, isle);
    this.ghost.renderOrder = 4;
    this.gate = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.47, 32), guide);
    this.gate.rotation.x = -Math.PI / 2;
    this.gate.renderOrder = 5;
    this.square.visible = this.target.visible = this.beam.visible = this.stubHint.visible = this.ghost.visible = this.gate.visible = false;

    this.scene.add(this.roads, this.decks, this.decor, this.cars, this.lamps, this.beams, this.square, this.target, this.beam, this.stubHint, this.ghost, this.gate);
    this.setQuality(Math.min(innerWidth, innerHeight) < 600 || (navigator.hardwareConcurrency ?? 8) <= 4 ? 1 : 2);
    this.applyTheme();
    this.focus.set(cx, 0, cz);
    this.half = this.fit(-1, -1, w, h).half;
    this.resize();
  }

  // ---------- camera ----------

  /** Re-fit to the window: call on resize and on rotation. */
  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.aim();
  }

  /** Frame the whole built-up area again at once (after a rotation, say). */
  refit() {
    this.follow = true;
  }

  /** The player is busy at the current zoom (drawing, panning): do not pull the camera away yet. */
  hold() {
    this.idle = 0;
  }

  /** Zoom by `factor` (above 1 zooms out) keeping the ground under the given screen point fixed. */
  zoomBy(factor: number, clientX: number, clientY: number) {
    const before = this.groundAt(clientX, clientY);
    this.half *= factor;
    this.aim();
    const after = this.groundAt(clientX, clientY);
    if (before && after) this.focus.add(new THREE.Vector3(before.x - after.x, 0, before.z - after.z));
    this.follow = false;
    this.idle = 0;
    this.aim();
  }

  /** Pan so the ground that was under the first screen point is now under the second. */
  drag(fromX: number, fromY: number, toX: number, toY: number) {
    const a = this.groundAt(fromX, fromY), b = this.groundAt(toX, toY);
    if (a && b) this.focus.add(new THREE.Vector3(a.x - b.x, 0, a.z - b.z));
    this.follow = false;
    this.idle = 0;
    this.aim();
  }

  /**
   * Ease toward a view of the whole built-up area. Fitting the city is always on: panning or zooming
   * only borrows the camera, and it goes back a few seconds after the player lets go.
   */
  frame(dt: number, city: CityDirector) {
    if (!this.follow && (this.idle += dt) > RETURN) this.follow = true;
    if (!this.follow) return;
    const g = this.graph, { width: w, height: h } = g, reach = city.reach;
    let x0 = (w - 1) / 2 - (reach * w) / 2, x1 = (w - 1) / 2 + (reach * w) / 2, z0 = (h - 1) / 2 - (reach * h) / 2, z1 = (h - 1) / 2 + (reach * h) / 2;
    // everything built so far stays in view too: buildings, and the roads the player has laid
    for (const cell of [...g.nodes.keys(), ...city.dests.flatMap(d => d.cells)]) {
      x0 = Math.min(x0, g.x(cell) - 2); x1 = Math.max(x1, g.x(cell) + 2);
      z0 = Math.min(z0, g.y(cell) - 2); z1 = Math.max(z1, g.y(cell) + 2);
    }
    const want = this.fit(Math.max(-1, x0), Math.max(-1, z0), Math.min(w, x1), Math.min(h, z1)), ease = 1 - Math.exp(-dt * 2.2);
    this.half += (want.half - this.half) * ease;
    this.focus.x += (want.x - this.focus.x) * ease;
    this.focus.z += (want.z - this.focus.z) * ease;
    this.aim();
  }

  /** The grid cell under a screen position, or -1 off the map. Works at any camera angle. */
  pickCell(clientX: number, clientY: number): number {
    const p = this.groundAt(clientX, clientY);
    if (!p) return -1;
    const x = Math.round(p.x), y = Math.round(p.z);
    return this.graph.inBounds(x, y) ? this.graph.cell(x, y) : -1;
  }

  /** The point on the ground under a screen position. */
  groundAt(clientX: number, clientY: number): { x: number; z: number } | null {
    this.ray.setFromCamera(this.v2.set((clientX / innerWidth) * 2 - 1, 1 - (clientY / innerHeight) * 2), this.camera);
    const hit = this.ray.ray.intersectPlane(this.floor, this.v3);
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  /** World position to CSS pixels, for anchoring HTML over the scene. */
  project(x: number, y: number, z: number): { x: number; y: number } {
    this.v3.set(x, y, z).project(this.camera);
    return { x: ((this.v3.x + 1) / 2) * innerWidth, y: ((1 - this.v3.y) / 2) * innerHeight };
  }

  /** Screen axes on the ground for the current view. */
  private basis() {
    const { pitch, yaw } = VIEW;
    return { pitch, yaw, rx: Math.cos(yaw), rz: -Math.sin(yaw), ux: -Math.sin(yaw) * Math.sin(pitch), uz: -Math.cos(yaw) * Math.sin(pitch) };
  }

  /** The zoom and centre that frame a ground rectangle, leaving room for the HUD along the top and bottom. */
  private fit(x0: number, z0: number, x1: number, z1: number) {
    const b = this.basis(), x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    let wide = 0, tall = 0;
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      wide = Math.max(wide, Math.abs((px - x) * b.rx + (pz - z) * b.rz));
      tall = Math.max(tall, Math.abs((px - x) * b.ux + (pz - z) * b.uz));
    }
    const clear = Math.max(0.55, 1 - 170 / innerHeight);   // the share of the height not under HUD panels
    return { x, z, half: Math.max(MIN_HALF, tall / clear + 0.4, (wide + 0.6) / (innerWidth / innerHeight)) };
  }

  /** Point the camera at `focus` from the current view angle, clamped to the map. */
  private aim() {
    const { width: w, height: h } = this.graph, b = this.basis(), aspect = innerWidth / innerHeight;
    this.half = Math.max(MIN_HALF, Math.min(this.fit(-1, -1, w, h).half * 1.05, this.half));
    this.focus.x = Math.max(-0.5, Math.min(w - 0.5, this.focus.x));
    this.focus.z = Math.max(-0.5, Math.min(h - 0.5, this.focus.z));
    this.camera.position.set(Math.sin(b.yaw) * Math.cos(b.pitch), Math.sin(b.pitch), Math.cos(b.yaw) * Math.cos(b.pitch)).multiplyScalar(90).add(this.focus);
    this.camera.lookAt(this.focus);
    Object.assign(this.camera, { left: -this.half * aspect, right: this.half * aspect, top: this.half, bottom: -this.half, near: 1, far: 300 });
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.cellPx = innerHeight / (2 * this.half);
  }

  /** How far, in cells on screen, a screen position is from the raised part of the nearest motorway, and which one that is. */
  private nearDeck(clientX: number, clientY: number): { dist: number; a: number; b: number } {
    const best = { dist: Infinity, a: -1, b: -1 };
    for (const span of this.spans) {
      for (const p of span.pts) {
        const s = this.project(p.x, p.y, p.z), dist = Math.hypot(s.x - clientX, s.y - clientY) / this.cellPx;
        if (dist < best.dist) Object.assign(best, { dist, a: span.a, b: span.b });
      }
    }
    return best;
  }

  /** The motorway whose raised deck is drawn under a screen position, as its two end cells, or null. */
  pickMotorway(clientX: number, clientY: number): [number, number] | null {
    const hit = this.nearDeck(clientX, clientY);
    return hit.dist < 0.4 ? [hit.a, hit.b] : null;
  }

  /**
   * Motorway decks turn see-through while the pointer is at or just behind one, so a flyover never
   * hides the roads and buildings the player is trying to reach. `null` means no pointer.
   */
  reveal(dt: number, pointer: { x: number; y: number } | null) {
    const want = pointer && this.nearDeck(pointer.x, pointer.y).dist < 1.6 ? 0.22 : 1;
    this.deckFade += (want - this.deckFade) * (1 - Math.exp(-dt * 12));
    this.deckMat.opacity = this.pillarMat.opacity = this.deckFade;
    for (const mesh of this.decks.children as THREE.Mesh[]) mesh.castShadow = this.deckFade > 0.6;
  }

  // ---------- public drawing API ----------

  setDark(dark: boolean) {
    this.dark = dark;
    this.applyTheme();
  }

  /** Trade shadow quality and resolution for speed. */
  setQuality(level: number) {
    this.quality = Math.max(0, Math.min(2, level));
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, [1, 1.5, 2][this.quality]));
    this.renderer.shadowMap.enabled = this.quality > 0;
    const size = this.quality > 1 ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.roadMat.needsUpdate = this.deckMat.needsUpdate = this.ground.material.needsUpdate = true;
  }

  setCursor(c: Cursor) {
    const g = this.graph, tint = c.ok ? (this.dark ? '#FFFFFF' : '#000000') : '#E5484D';
    this.square.visible = c.cell >= 0;
    this.target.visible = c.touch && c.cell >= 0;
    this.beam.visible = c.cell >= 0 && c.from >= 0 && c.from !== c.cell;
    this.stubHint.visible = !!c.drive;
    if (c.drive) {
      const [house, facing] = c.drive, dx = g.x(facing) - g.x(house), dz = g.y(facing) - g.y(house);
      this.stubHint.position.set(g.x(house) + dx * 0.375, 0.06, g.y(house) + dz * 0.375);
      this.stubHint.scale.z = Math.hypot(dx, dz) * 0.75;
      this.stubHint.rotation.y = Math.atan2(dx, dz);
    }
    this.gate.visible = c.gate >= 0;
    if (c.gate >= 0) this.gate.position.set(g.x(c.gate), 0.08, g.y(c.gate));
    this.ghost.visible = c.cell >= 0 && c.span === 3;
    if (c.cell < 0) return;
    const x = g.x(c.cell), z = g.y(c.cell);
    this.square.position.set(x, 0.05, z);
    this.square.scale.setScalar(c.span);
    this.square.material.color.set(tint);
    this.square.material.opacity = c.span === 3 ? (c.ok ? 0.06 : 0.22) : c.ok ? 0.14 : 0.3;
    this.ghost.position.set(x, 0.07, z);
    this.ghostMat.color.set(c.ok ? this.theme.road : '#E5484D');
    this.target.position.set(x, 0.07, z);
    if (!this.beam.visible) return;
    const dx = x - g.x(c.from), dz = z - g.y(c.from);
    this.beam.position.set(g.x(c.from) + dx / 2, 0.7, g.y(c.from) + dz / 2);
    this.beam.scale.z = Math.hypot(dx, dz);
    this.beam.rotation.y = Math.atan2(dx, dz);
    this.beam.material.color.set(c.ok ? '#F0A860' : '#E5484D');
  }

  render(city: CityDirector, traffic: TrafficEngine, now: number) {
    const g = this.graph, d = this.dummy, f = this.flat;
    if (this.version !== g.version) this.rebuildRoads(city);
    this.daylight(city.time);

    for (const h of city.houses) if (!this.buildings.has(h.id)) this.addHouse(h, now);
    for (const t of city.dests) if (!this.buildings.has(t.id)) this.addDest(t, now);
    for (const b of this.buildings.values()) {
      // pop in with a little overshoot
      const k = Math.min(1, (now - b.userData.born) / 0.4) - 1;
      b.scale.setScalar(1 + 2.7 * k * k * k + 1.7 * k * k);
    }

    let n = 0, lit = 0;
    const lights = this.night > 0.25;
    d.scale.setScalar(1);
    for (const car of traffic.cars) {
      if (n >= MAX_CARS) break;
      const p = car.pos, under = g.terrain[g.cell(Math.round(p.x), Math.round(p.z))];
      if (under === 'mountain' || under === 'rail') continue;   // out of sight inside a tunnel
      d.position.set(p.x, p.y + 0.1, p.z);
      d.rotation.set(0, p.heading, 0);
      d.updateMatrix();
      this.cars.setMatrixAt(n, d.matrix);
      this.cars.setColorAt(n++, this.carColors[car.color]);
      if (!lights || car.state === 'parked') continue;
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      d.position.set(p.x + fx * (CAR_LENGTH / 2 - 0.01), p.y + 0.1, p.z + fz * (CAR_LENGTH / 2 - 0.01));
      d.updateMatrix();
      this.lamps.setMatrixAt(lit, d.matrix);
      f.position.set(p.x + fx * 0.45, p.y + 0.04, p.z + fz * 0.45);
      f.rotation.set(-Math.PI / 2, p.heading + Math.PI, 0);
      f.updateMatrix();
      this.beams.setMatrixAt(lit++, f.matrix);
    }
    this.cars.count = n;
    this.lamps.count = this.beams.count = lit;
    this.cars.instanceMatrix.needsUpdate = this.lamps.instanceMatrix.needsUpdate = this.beams.instanceMatrix.needsUpdate = true;
    if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;

    for (const s of this.signals) s.bar.material = traffic.isGreen(s.node, s.from) ? this.goMat : this.stopMat;

    // Trains run on the game clock, eased so they glide between simulation steps. Each one slides out
    // from the end of its line and back in at the other, never appearing or vanishing whole.
    const ahead = city.time - this.rail;
    this.rail = Math.abs(ahead) > 0.5 ? city.time : this.rail + ahead * 0.2;
    this.trains.forEach((t, i) => {
      const s = t.from - TRAIN / 2 + ((this.rail * 6 + i * 23) % (t.to - t.from + 45));
      const tail = Math.max(t.from, s - TRAIN / 2), nose = Math.min(t.to, s + TRAIN / 2), mid = (tail + nose) / 2;
      t.mesh.visible = nose - tail > 0.05;
      t.mesh.scale.z = Math.max(0.01, (nose - tail) / TRAIN);
      t.mesh.position.set(t.x + t.dx * mid, 0.42, t.z + t.dz * mid);
    });

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ---------- light ----------

  /**
   * One day is one pass of the sun: it rises in the east, swings across the north of the map and
   * sets in the west with a warm dusk, then a cool moonlit night with windows and headlights lit.
   */
  private daylight(time: number) {
    const p = (time % DAY_SECONDS) / DAY_SECONDS;
    const night = p < 0.6 ? 0 : p < 0.72 ? smooth((p - 0.6) / 0.12) : p < 0.9 ? 1 : 1 - smooth((p - 0.9) / 0.1);
    // dusk is the warm one; dawn is kept faint, because it is also the first thing a new game shows
    const warm = Math.max(0, 1 - Math.abs(p - 0.64) / 0.1, 0.35 * (1 - Math.abs(p - 0.98) / 0.07), 0.35 * (1 - p / 0.05)) * (1 - night * 0.6);
    const day = Math.min(1, p / 0.72), az = (-35 - 110 * day) * RAD, el = (22 + 46 * Math.sin(Math.PI * day)) * RAD;
    const sx = Math.cos(az) * Math.cos(el), sy = Math.sin(el), sz = Math.sin(az) * Math.cos(el);
    // by night the light comes from a high, still moon
    const mx = -0.25, my = 0.9, mz = -0.35, t = this.sun.target.position;
    this.sun.position.set(t.x + (sx + (mx - sx) * night) * 45, (sy + (my - sy) * night) * 45, t.z + (sz + (mz - sz) * night) * 45);
    this.sun.color.set('#FFFFFF').lerp(new THREE.Color('#FFB36B'), warm * 0.8).lerp(new THREE.Color('#C3CFFF'), night);
    this.sun.intensity = (1.7 - 0.5 * warm) * (1 - night) + 0.6 * night;
    const floor = this.dark ? 1.4 : 1.2;   // dark mode is dim already, so its nights fall less far
    this.ambient.color.set('#FFFFFF').lerp(new THREE.Color('#FFD9B8'), warm * 0.5).lerp(new THREE.Color('#C9D1EE'), night);
    this.ambient.intensity = 1.75 + (floor - 1.75) * night;
    this.glass.color.set(this.dark ? '#59636F' : '#A9BACB').lerp(new THREE.Color('#FFE08A'), smooth(night * 1.4));
    this.beamMat.opacity = 0.55 * night;
    this.night = night;
  }

  // ---------- static scenery ----------

  private get theme() {
    const p = this.config.palette;
    return this.dark
      ? { ground: '#23262B', water: '#2F4C5E', bank: '#2D3138', road: '#5E646D', border: '#16181B', drive: '#3D424A', lot: '#3A3F47', kerb: '#6B727C', dot: 'rgba(255,255,255,.08)', rock: '#3C4149', ballast: '#363A41' }
      : { ground: p.ground, water: p.water, bank: p.bank, road: '#3A3D40', border: '#FFFFFF', drive: '#A9ABAD', lot: '#C7C9CC', kerb: '#F3F1EC', dot: 'rgba(80,70,50,.13)', rock: '#D9D3C6', ballast: '#D3CDC0' };
  }

  private applyTheme() {
    const t = this.theme;
    this.scene.background = new THREE.Color(t.ground);
    this.ground.material.color.set(t.ground);
    this.rockMat.color.set(t.rock);
    this.ballastMat.color.set(t.ballast);
    this.lotMat.color.set(t.lot);
    this.kerbMat.color.set(t.kerb);
    this.paintTerrain();
    this.version = -1;   // roads are vertex-colored, so rebuild them in the new palette
  }

  /** Paint water (with its banks) and the grid dots onto the ground texture. */
  private paintTerrain() {
    const g = this.graph, t = this.theme, c = (this.terrain.image as HTMLCanvasElement).getContext('2d')!;
    const mid = (v: number) => (v + 0.5) * TEX;
    c.clearRect(0, 0, g.width * TEX, g.height * TEX);

    // Stroking each water feature's own polyline with round joins covers exactly the points within
    // width/2 of it, which is the rule the grid mask uses, so the smooth shape and the cells agree.
    // The water is drawn a little narrow so roads on the bank stay visibly dry.
    c.lineCap = c.lineJoin = 'round';
    for (const [color, grow, scale] of [[t.bank, 0.5, 1], [t.water, -0.2, this.config.palette.channel]] as const) {
      c.strokeStyle = color;
      for (const f of this.config.features) {
        if (f.terrain !== 'water') continue;
        c.lineWidth = (f.width + grow) * scale * TEX;
        c.beginPath();
        c.moveTo(mid(f.path[0][0]), mid(f.path[0][1]) + 0.01);
        for (const [x, y] of f.path) c.lineTo(mid(x), mid(y));
        c.stroke();
      }
    }

    c.fillStyle = t.dot;
    g.terrain.forEach((kind, id) => {
      if (kind !== 'ground') return;
      c.beginPath();
      c.arc(mid(g.x(id)), mid(g.y(id)), 1.7, 0, Math.PI * 2);
      c.fill();
    });
    this.terrain.needsUpdate = true;
  }

  /** Mountains, railway embankments and their trains: built once, they never change. */
  private addScenery() {
    const g = this.graph, d = this.dummy;
    const cellsOf = (kind: string) => g.terrain.flatMap((t, id) => (t === kind ? [id] : []));
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      mesh.count = count;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
      return mesh;
    };

    const rocks = cellsOf('mountain');
    const peaks = instanced(new THREE.ConeGeometry(0.64, 1, 6), this.rockMat, rocks.length);
    rocks.forEach((id, i) => {
      const height = 0.7 + hash(id) * 0.8;
      d.position.set(g.x(id), height / 2, g.y(id));
      d.rotation.set(0, hash(id + 7) * 3, 0);
      d.scale.set(1, height, 1);
      d.updateMatrix();
      peaks.setMatrixAt(i, d.matrix);
    });

    const track = cellsOf('rail');
    const bed = instanced(new THREE.BoxGeometry(1, 0.24, 1), this.ballastMat, track.length);
    const rails = instanced(new THREE.BoxGeometry(0.05, 0.03, 1), this.tunnelMat, track.length * 2);
    const isRail = (x: number, y: number) => g.inBounds(x, y) && g.terrain[g.cell(x, y)] === 'rail';
    d.scale.setScalar(1);
    track.forEach((id, i) => {
      const x = g.x(id), y = g.y(id), eastWest = isRail(x - 1, y) || isRail(x + 1, y);
      d.rotation.set(0, 0, 0);
      d.position.set(x, 0.12, y);
      d.updateMatrix();
      bed.setMatrixAt(i, d.matrix);
      d.rotation.y = eastWest ? Math.PI / 2 : 0;
      for (const side of [0, 1]) {
        const off = side ? 0.16 : -0.16;
        d.position.set(x + (eastWest ? 0 : off), 0.255, y + (eastWest ? off : 0));
        d.updateMatrix();
        rails.setMatrixAt(i * 2 + side, d.matrix);
      }
    });

    for (const f of this.config.features) {
      if (f.terrain !== 'rail' || f.path.length < 2) continue;
      const [[x, z], [bx, bz]] = f.path, len = Math.hypot(bx - x, bz - z);
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.3, TRAIN, 3, 0.13), this.white);
      mesh.rotation.y = Math.atan2(bx - x, bz - z);
      mesh.castShadow = true;
      this.scene.add(mesh);
      // lines are drawn past the edge of the map; the train only shows over the part that has track
      const dx = (bx - x) / len, dz = (bz - z) / len, on = (d: number) => g.inBounds(Math.round(x + dx * d), Math.round(z + dz * d));
      let from = 0, to = len;
      while (from < to && !on(from)) from += 0.1;
      while (to > from && !on(to)) to -= 0.1;
      this.trains.push({ mesh, x, z, dx, dz, from: from - 0.5, to: to + 0.5 });
    }
  }

  private part(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, turn = 0) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = turn;
    mesh.castShadow = mesh.receiveShadow = mat !== this.glass;
    group.add(mesh);
  }

  private settle(id: number, group: THREE.Group, now: number) {
    group.userData.born = now;
    group.scale.setScalar(0);
    this.buildings.set(id, group);
    this.scene.add(group);
  }

  private addHouse(h: House, now: number) {
    const group = new THREE.Group(), color = h.color;
    this.part(group, this.houseGeo, this.colorMats[color], 0, 0.22, 0);
    this.part(group, this.roofGeo, this.roofMats[color], 0, 0.54, 0, Math.PI / 4);
    for (const side of [-1, 1]) {
      this.part(group, this.paneGeo, this.glass, -0.13, 0.24, side * 0.292);
      this.part(group, this.paneGeo, this.glass, 0.13, 0.24, side * 0.292);
      this.part(group, this.paneGeo, this.glass, side * 0.292, 0.24, 0, Math.PI / 2);
    }
    group.position.set(this.graph.x(h.cell), 0, this.graph.y(h.cell));
    this.settle(h.id, group, now);
  }

  /**
   * A destination: the building along the back, and in front of it a car park with marked bays.
   * Built in its own frame, where +Z runs in from the entrance and -X is along the bays.
   */
  private addDest(d: Destination, now: number) {
    const g = this.graph, group = new THREE.Group(), len = d.lot.length, mid = -(len - 1) / 2;
    const dx = g.x(d.cell) - g.x(d.entry), dz = g.y(d.cell) - g.y(d.entry);
    group.position.set((g.x(d.cell) + g.x(d.entry)) / 2, 0, (g.y(d.cell) + g.y(d.entry)) / 2);
    group.rotation.y = Math.atan2(dx, dz);
    this.part(group, new THREE.BoxGeometry(len - 0.06, 0.04, 0.94), this.lotMat, mid, 0.02, 0.5);
    this.part(group, new RoundedBoxGeometry(len - 0.2, 0.74, 0.78, 3, 0.08), this.colorMats[d.color], mid, 0.39, 1.5);
    this.part(group, new THREE.BoxGeometry(len - 0.56, 0.05, 0.42), this.white, mid, 0.78, 1.5);
    // bay markings: one line between each pair of spaces, evenly spaced along the row
    const line = new THREE.BoxGeometry(0.025, 0.012, 0.46);
    for (let i = 0; i < 3 * (len - 1); i++) this.part(group, line, this.white, -(0.5 + i * LOT.pitch), 0.046, LOT.bay);
    // A raised kerb runs round the car park wherever a road cannot join it, which leaves exactly one
    // gap: the entrance, with an arrow painted in each lane.
    const far = -(len - 1) - 0.47, kerb = (w: number, l: number, x: number, z: number) => this.part(group, new THREE.BoxGeometry(w, 0.09, l), this.kerbMat, x, 0.045, z);
    kerb(0.06, 0.94, 0.47, 0.5);
    kerb(0.06, 0.94, far, 0.5);
    kerb(-0.5 - far, 0.06, (far - 0.5) / 2, 0.03);
    const stroke = new THREE.BoxGeometry(0.035, 0.012, 0.15);
    for (const side of [-1, 1]) {
      // driving on the right: in on the -X side pointing +Z, out on the +X side pointing -Z
      const x = side * 0.135, tip = 0.2 - side * 0.07;
      for (const wing of [-1, 1]) this.part(group, stroke, this.white, x + wing * 0.045, 0.046, tip + side * 0.045, wing * side * 0.7);
    }
    for (let i = 0; i < len * 3; i++) this.part(group, this.paneGeo, this.glass, mid + ((i + 0.5) / (len * 3) - 0.5) * (len - 0.5), 0.46, 1.104);
    this.settle(d.id, group, now);
  }

  // ---------- roads ----------

  /** Regenerate all road geometry and road furniture from the graph. */
  private rebuildRoads(city: CityDirector) {
    const g = this.graph, t = this.theme;
    this.version = g.version;
    for (const mesh of this.roads.children as THREE.Mesh[]) mesh.geometry.dispose();
    for (const mesh of this.decks.children as THREE.Mesh[]) if (mesh.geometry !== this.pillarGeo) mesh.geometry.dispose();
    this.roads.clear();
    this.decks.clear();
    this.decor.clear();
    this.signals.length = 0;
    this.spans.length = 0;

    const flat: Ribbons = [[], []], raised: Ribbons = [[], []], deck: Ribbons = [[], []];   // only raised ribbons cast shadows
    const asphalt = new THREE.Color(t.road), kerb = new THREE.Color(t.border), barrier = new THREE.Color('#F0A860'), pale = new THREE.Color(t.drive);
    const going = new THREE.Color(t.road).lerp(new THREE.Color('#E5484D'), 0.55);   // erased, waiting for its last cars
    const s: PathSample = { x: 0, y: 0, z: 0, heading: 0 };
    const stroke = (pts: Vec3[], edge = kerb, fill = asphalt, width = ROAD_W, onto?: Ribbons) => {
      // push both ends out a touch so neighbouring strokes overlap instead of leaving hairline seams
      for (const [end, inner] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
        const dx = end.x - inner.x, dz = end.z - inner.z, n = Math.hypot(dx, dz) || 1;
        const tip = { x: end.x + (dx / n) * 0.04, y: end.y, z: end.z + (dz / n) * 0.04 };
        if (end === pts[0]) pts.unshift(tip);
        else pts.push(tip);
      }
      const out = onto ?? (pts.some(p => p.y > 0.05) ? raised : flat);
      ribbon(out, pts, width + 2 * BORDER, edge, 0.012);
      ribbon(out, pts, width, fill, 0.024);
    };
    const hub = (at: Vec3, fill: THREE.Color) => {
      const out = at.y > 0.05 ? raised : flat;
      disc(out, at, ROAD_W / 2 + BORDER, kerb, 0.012);
      disc(out, at, ROAD_W / 2, fill, 0.024);
    };
    const prop = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, turn = 0, height = 1) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = turn;
      mesh.scale.y = height;
      mesh.castShadow = true;
      this.decor.add(mesh);
      return mesh;
    };
    const buried = (id: number) => g.terrain[id] === 'mountain' || g.terrain[id] === 'rail';

    for (const node of g.nodes.values()) {
      if (node.building) continue;   // buildings draw their own driveway or car park
      const id = node.id, here: Vec3 = { x: node.x, y: g.nodeY(id), z: node.y };
      const arms = [...node.links].filter(([, link]) => link.kind !== 'ring').map(([n]) => n);
      const roads = arms.filter(n => node.links.get(n)!.kind !== 'drive');
      const fill = (n: number) => (node.links.get(n)!.closing ? going : asphalt);
      const all = arms.length > 0 && arms.every(n => fill(n) === going) ? going : asphalt;
      const arm = (n: number) => stroke([here, { ...g.linePoint(id, n, g.reach(id, n), s) }], kerb, fill(n));

      // a bend is drawn as one smooth curve when it is gentle enough for the road to keep its width
      // round the inside; sharper corners and junctions get straight arms meeting in a round hub
      let curved = false;
      if (roads.length === 2 && node.ring < 0) {
        const [a, b] = roads, ax = g.px(a) - node.x, az = g.pz(a) - node.y, bx = g.px(b) - node.x, bz = g.pz(b) - node.y;
        const half = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz))))) / 2;
        curved = (Math.min(g.reach(id, a), g.reach(id, b)) * Math.sin(half) ** 2) / Math.max(1e-6, Math.cos(half)) > ROAD_W / 2 + BORDER + 0.03;
        if (curved) {
          const pts: Vec3[] = [];
          for (let i = 0; i <= 12; i++) pts.push({ ...g.cornerPoint(a, id, b, i / 12, s) });
          stroke(pts, kerb, fill(a) === going && fill(b) === going ? going : asphalt);
        }
      }
      for (const n of curved ? arms.filter(n => !roads.includes(n)) : arms) arm(n);
      if (arms.length && (!curved || arms.length > 2) && node.ring < 0) hub(here, all);
      if (node.ring >= 0 && arms.length) hub(here, all);
      if (g.terrain[id] === 'water') prop(this.pierGeo, this.concrete, node.x, 0.09, node.y);

      for (const [n, link] of node.links) {
        const kind = link.kind, dx = g.px(n) - node.x, dz = g.pz(n) - node.y, turn = Math.atan2(dx, dz);
        if (node.light && !g.nodes.get(n)!.building) {
          const p = g.linePoint(id, n, 0.36, s);
          this.signals.push({ bar: prop(this.barGeo, this.stopMat, p.x, p.y + 0.045, p.z, turn), node: id, from: n });
        }
        if (n < id || kind === 'ring' || kind === 'drive') continue;   // the rest is once per road
        const len = g.edgeLen(id, n), r = g.reach(id, n);
        if (buried(id) !== buried(n)) prop(this.portalGeo, this.tunnelMat, node.x + dx / 2, 0.18, node.y + dz / 2, turn);
        if (len - 2 * r < 0.01) continue;
        // the straight middle of a long edge: diagonals and motorways
        const pts: Vec3[] = [], steps = Math.ceil((len - 2 * r) / 0.25);
        for (let i = 0; i <= steps; i++) pts.push({ ...g.linePoint(id, n, r + ((len - 2 * r) * i) / steps, s) });
        if (kind !== 'motorway') {
          stroke(pts, kerb, link.closing ? going : asphalt);
          continue;
        }
        // a flyover is its own mesh, so it can fade out of the way; picking uses the part that is off the ground
        stroke(pts, barrier, link.closing ? going : asphalt, ROAD_W, deck);
        this.spans.push({ a: id, b: n, pts: pts.filter(p => p.y > 0.2) });
        // pillars stand only where there is open ground beneath, never on a road or a building
        for (const p of g.pillars(id, n)) {
          const pillar = new THREE.Mesh(this.pillarGeo, this.pillarMat);
          pillar.position.set(p.x, (p.y - 0.06) / 2, p.z);
          pillar.scale.y = p.y - 0.06;
          pillar.castShadow = true;
          this.decks.add(pillar);
        }
      }
    }

    // driveways: a short stub from every house toward the cell it faces, paved once a road is there to meet it
    for (const h of city.houses) {
      const out = g.doors.get(h.cell)!, link = g.nodes.get(h.cell)!.links.get(out);
      const from = { x: g.x(h.cell), y: 0, z: g.y(h.cell) };
      stroke([from, { x: (from.x + g.x(out)) / 2, y: 0, z: (from.z + g.y(out)) / 2 }], kerb, link ? (link.closing ? going : asphalt) : pale, link ? ROAD_W : 0.36);
      // an old driveway that is still waiting for its last car
      for (const [m, old] of g.nodes.get(h.cell)!.links) {
        if (m !== out) stroke([{ ...from }, { x: (from.x + g.px(m)) / 2, y: 0, z: (from.z + g.pz(m)) / 2 }], kerb, old.closing ? going : asphalt);
      }
    }

    // and one from every car park that has no road at its entrance yet, so the way in is plain to see
    for (const d of city.dests) {
      if (g.nodes.get(d.cell)!.links.has(d.entry)) continue;
      const ex = g.x(d.entry), ez = g.y(d.entry), mx = (ex + g.x(d.cell)) / 2, mz = (ez + g.y(d.cell)) / 2;
      stroke([{ x: mx, y: 0, z: mz }, { x: ex + (mx - ex) * 0.2, y: 0, z: ez + (mz - ez) * 0.2 }], kerb, pale, 0.36);
    }

    // a roundabout waiting for its last cars shows as a pale ring where it will be
    for (const centre of g.pending) {
      const pts: Vec3[] = [];
      for (let i = 0; i <= 50; i++) pts.push({ x: g.x(centre) + Math.cos((i / 24) * Math.PI) * RING_RADIUS, y: 0.03, z: g.y(centre) + Math.sin((i / 24) * Math.PI) * RING_RADIUS });
      stroke(pts, kerb, pale, ROAD_W, flat);
      prop(this.islandGeo, this.islandMat, g.x(centre), 0.05, g.y(centre));
    }

    for (const [id, cells] of g.rings) {
      const cx = cells.reduce((sum, c) => sum + g.x(c), 0) / cells.length, cz = cells.reduce((sum, c) => sum + g.y(c), 0) / cells.length;
      const pts: Vec3[] = [], closing = cells.every(c => [...g.nodes.get(c)!.links.values()].every(l => l.closing));
      for (let i = 0; i <= 50; i++) pts.push({ x: cx + Math.cos((i / 24) * Math.PI) * (RING_RADIUS + 0.03), y: 0, z: cz + Math.sin((i / 24) * Math.PI) * (RING_RADIUS + 0.03) });   // laps itself to hide the seam
      stroke(pts, kerb, closing ? going : asphalt, ROAD_W + 0.08);
      prop(this.islandGeo, this.islandMat, cx, 0.05, cz);
      for (let i = 0; i < 3; i++) prop(this.treeGeo, this.islandMat, cx + Math.cos(i * 2.1 + id) * 0.26, 0.24, cz + Math.sin(i * 2.1 + id) * 0.26, i);
    }

    for (const [data, shadow] of [[flat, false], [raised, true], [deck, true]] as const) {
      if (!data[0].length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data[0], 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(data[1], 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, data === deck ? this.deckMat : this.roadMat);
      mesh.receiveShadow = true;
      mesh.castShadow = shadow;
      (data === deck ? this.decks : this.roads).add(mesh);
    }
  }
}

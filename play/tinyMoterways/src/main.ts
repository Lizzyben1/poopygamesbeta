import './style.css';
import { SynthAudio } from './audio/SynthAudio.ts';
import { CITIES } from './levels/CityConfigs.ts';
import { ThreeRenderer } from './renderer/ThreeRenderer.ts';
import type { Cursor } from './renderer/ThreeRenderer.ts';
import { CityDirector, DAY_SECONDS } from './simulation/CityDirector.ts';
import { RoadGraph } from './simulation/RoadGraph.ts';
import { TrafficEngine } from './simulation/TrafficEngine.ts';
import { Overlay } from './ui/Overlay.ts';
import type { CityConfig, GameEvent, Inventory, Tool } from './types.ts';

const STEP = 1 / 60;   // fixed simulation step, so 2x speed is the same simulation run twice as often
const REACH = 0.6;     // how far, in cells, the pointer travels in a direction before the road follows

interface Game {
  config: CityConfig;
  inv: Inventory;
  graph: RoadGraph;
  city: CityDirector;
  traffic: TrafficEngine;
  view: ThreeRenderer;
}

/** One mouse button or one finger acting with a tool, from press to release. */
interface Stroke {
  id: number;                       // the pointer doing it
  tool: Tool;
  erase: boolean;
  touch: boolean;
  start: number;                    // cell where it began
  last: number;                     // cell the stroke has reached
  cell: number;                     // cell under the pointer right now
  ref: { x: number; z: number };    // where on the ground the pointer was when the stroke reached `last`
  house: number;                    // a house whose driveway this stroke is turning, -1 if none
  face: number;                     // the neighbour that driveway would point at, -1 while undecided
  denied: boolean;                  // this stroke has already been told "no" once
}

const app = document.getElementById('app')!;
const audio = new SynthAudio();

let game: Game | null = null;
let phase: 'menu' | 'playing' | 'draft' | 'over' = 'menu';
let speed = 1;
let tool: Tool = 'road';
let dark = false;
let hover = -1;
let aim: { x: number; y: number } | null = null;   // where the mouse, or the finger using a tool, is on screen

// Every pointer on the map is tracked by id, so a finger that lifts can never leave a drag stuck.
const pointers = new Map<number, { x: number; y: number }>();
let stroke: Stroke | null = null;
let pinch: { x: number; y: number; dist: number } | null = null;   // two fingers steering the camera
let pan: { id: number; x: number; y: number } | null = null;        // the middle mouse button doing the same
let lifted = true;   // false from a two-finger gesture until every finger is up, so the last one down cannot draw

const playing = () => phase === 'playing';

const overlay = new Overlay(document.getElementById('ui')!, {
  speed: n => { speed = n; },
  tool: t => { tool = t; },
  mute: () => { audio.toggleMute(); },
  dark: () => {
    dark = !dark;
    document.body.classList.toggle('dark', dark);
    game?.view.setDark(dark);
  },
  start,
  retry: () => start(game!.config),
  menu: () => {
    phase = 'menu';
    overlay.menu(CITIES);
  },
  choose: option => {
    game!.city.choose(option);
    audio.upgrade();
    phase = 'playing';
    save();
  },
  sound: name => {
    audio.unlock();
    audio.play(name);
  },
  level: () => ({ peak: audio.level(), running: audio.running }),
});

/** What is kept in the browser between visits: one game, and the dark-mode choice. */
interface Saved {
  version: 1;
  city: string;
  dark: boolean;
  inv: Inventory;
  graph: ReturnType<RoadGraph['save']>;
  director: ReturnType<CityDirector['save']>;
}

const SAVE = 'tiny-motorways-save';

/** Start a city, or pick one up where a saved game left it. */
function start(config: CityConfig, saved?: Saved) {
  game?.view.dispose();
  const inv = saved ? saved.inv : { ...config.start };
  const graph = new RoadGraph(config, inv);
  const city = new CityDirector(config, graph, inv, onEvent);
  const traffic = new TrafficEngine(graph, city, onEvent);
  if (saved) {
    graph.load(saved.graph);
    city.load(saved.director);
    graph.sweep(() => false);   // no car is on the road, so anything that was waiting for one is settled now
  }
  const view = new ThreeRenderer(app, graph, config, dark);
  game = { config, inv, graph, city, traffic, view };
  phase = 'playing';
  speed = saved ? 0 : 1;        // a game picked up later starts paused, so nothing happens before the player is ready
  tool = 'road';
  stroke = null;
  overlay.begin();
  if (city.draft) {
    phase = 'draft';
    overlay.draft(city.week, city.draft);
  }
  save();
}

/** Write the game to the browser's storage. A finished game is forgotten instead. */
function save() {
  try {
    if (!game || game.city.over) return localStorage.removeItem(SAVE);
    const data: Saved = { version: 1, city: game.config.id, dark, inv: game.inv, graph: game.graph.save(), director: game.city.save() };
    localStorage.setItem(SAVE, JSON.stringify(data));
  } catch {
    // private browsing or a full disk: the game simply is not kept
  }
}

/** Pick up the saved game if there is a usable one. */
function resume(): boolean {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE) ?? 'null') as Saved | null, config = CITIES.find(c => c.id === data?.city);
    if (!data || data.version !== 1 || !config) return false;
    dark = data.dark;
    document.body.classList.toggle('dark', dark);
    start(config, data);
    return true;
  } catch {
    localStorage.removeItem(SAVE);   // a save this version cannot read
    game = null;
    return false;
  }
}

function onEvent(e: GameEvent) {
  if (e.type === 'deliver') audio.chime(e.color);
  else if (e.type === 'spawn') audio.spawn();
  else if (e.type === 'overflow') audio.alert();
  else if (e.type === 'week') {
    phase = 'draft';
    stroke = null;
    overlay.draft(game!.city.week, e.options);
  } else {
    phase = 'over';
    stroke = null;
    save();
    audio.gameOver();
    overlay.gameOver(game!.city.score, game!.city.day, e.dest.color);
  }
}

// ---------- building ----------

function feedback(ok: boolean, stock: keyof Inventory) {
  game!.traffic.settle();
  if (ok) return audio.pop();
  audio.deny();
  if (game!.inv[stock] < 1) overlay.deny(stock);
}

/** Erase what is under the pointer: a motorway if its deck is drawn there, otherwise the roads of the cell. */
function eraseAt(cell: number, x: number, y: number) {
  const { graph, view, traffic } = game!, deck = view.pickMotorway(x, y);
  if (deck ? graph.eraseMotorway(...deck) : cell >= 0 && graph.erase(cell)) audio.erase();
  traffic.settle();   // roads nobody is driving on go at once, even while paused
}

/** Point a house's driveway at a neighbouring cell. Free; it only connects if that cell has a road. */
function turnDriveway(house: number, face: number) {
  const { graph, city, traffic } = game!;
  if (!graph.setDriveway(house, face)) return;
  city.houses.find(h => h.cell === house)!.facing = face;
  traffic.settle();
  audio.pop();
}

/** Take the stroke one cell further. */
function step(s: Stroke, next: number) {
  const g = game!.graph, cur = s.last;
  s.last = next;
  if (cur === s.house && s.face < 0) {
    s.face = next;                    // first cell out of a house: that is where its driveway will point
    return;
  }
  if (next === s.house) {
    s.face = -1;                      // back onto the house: forget it
    return;
  }
  if (s.house >= 0 && cur === s.face) {
    if (Math.max(Math.abs(g.x(next) - g.x(s.house)), Math.abs(g.y(next) - g.y(s.house))) <= 1) {
      s.face = next;                  // sliding round the house: still just choosing where the driveway points
      return;
    }
    turnDriveway(s.house, s.face);    // carried on past the neighbour: the driveway is settled, and road starts here
    s.house = -1;
  }
  if (g.nodes.get(next)?.building === 'house') {
    turnDriveway(next, cur);          // drawing a road up to a house swings its driveway round to meet it
    return;
  }
  if (g.addRoad(cur, next) || corner(cur, next)) return audio.pop();
  if (game!.inv.tiles < 1 && g.isFree(next)) overlay.deny('tiles');
  // one "no" per stroke when the rules refuse a step, so a road never stops short without saying so
  if (!s.denied && !g.solid(next) && !g.solid(cur) && !g.nodes.get(cur)?.links.has(next)) audio.deny();
  s.denied = true;
}

/**
 * A diagonal step the rules refuse (it would clip water, rail or a mountain, or cross another
 * diagonal) is taken as a corner instead: one cell along and one across, over open ground.
 */
function corner(a: number, b: number): boolean {
  const g = game!.graph, ax = g.x(a), ay = g.y(a), bx = g.x(b), by = g.y(b);
  if (ax === bx || ay === by || g.solid(a) || g.solid(b)) return false;
  const joined = (p: number, q: number) => g.nodes.get(p)?.links.get(q)?.closing === false;
  for (const mid of [g.cell(bx, ay), g.cell(ax, by)]) {
    if (g.terrain[mid] !== 'ground' || g.solid(mid)) continue;
    const fresh = !g.nodes.has(mid);
    if (!joined(a, mid) && !g.addRoad(a, mid)) continue;
    if (joined(mid, b) || g.addRoad(mid, b)) return true;
    if (fresh) g.erase(mid);   // half a corner is no use: take it back (the tile is refunded when the stroke settles)
  }
  return false;
}

/**
 * Extend a road stroke toward the pointer. The direction comes from how the pointer has moved since
 * the last cell, snapped to the nearest of the eight directions, so a 45 degree drag gives a clean
 * diagonal, a wobble on a straight drag does not, and a fast drag leaves no gaps.
 */
function extend(s: Stroke, at: { x: number; z: number }) {
  const g = game!.graph;
  for (let guard = 0; guard < 64 && s.last >= 0; guard++) {
    const dx = at.x - s.ref.x, dz = at.z - s.ref.z, turn = (Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * Math.PI) / 4;
    const sx = Math.round(Math.cos(turn)), sz = Math.round(Math.sin(turn)), len = Math.hypot(sx, sz);
    if ((dx * sx + dz * sz) / len < REACH * len) break;
    const x = g.x(s.last) + sx, y = g.y(s.last) + sz;
    if (!g.inBounds(x, y)) break;
    step(s, g.cell(x, y));
    s.ref.x += sx;
    s.ref.z += sz;
  }
  game!.traffic.settle();
}

/** Would the tool do anything at this cell? Drives the red tint of the placement preview. */
function valid(t: Tool, cell: number, from: number): boolean {
  const g = game!.graph, node = g.nodes.get(cell);
  if (cell < 0) return true;
  if (t === 'roundabout') return g.canRoundabout(g.x(cell), g.y(cell));
  if (t === 'motorway') return from < 0 || from === cell ? g.terrain[cell] === 'ground' && !g.solid(cell) && game!.inv.motorways > 0 : g.canMotorway(from, cell);
  if (t === 'light') return !!node && (node.light || (g.isJunction(node) && game!.inv.lights > 0));
  if (t === 'road') return !g.solid(cell) || node?.building === 'house';   // car parks and islands take no road
  return true;
}

/** What the renderer should draw for the pointer: the hovered cell with a mouse, the stroke's target under a finger. */
function cursor(): Cursor {
  const s = stroke, none: Cursor = { cell: -1, span: 1, ok: true, touch: false, from: -1, drive: null, gate: -1 };
  if (!playing() || pinch || pan) return none;
  // pointing the road tool at a car park lights up the one cell a road can join it from
  const at = s ? s.cell : hover, gate = (s ? s.tool : tool) === 'road' && !s?.erase ? game!.city.dests.find(d => d.cells.includes(at))?.entry ?? -1 : -1;
  if (!s) return { ...none, gate, cell: hover, span: tool === 'roundabout' ? 3 : 1, ok: valid(tool, hover, -1) };
  if (s.erase) return { ...none, cell: s.cell, touch: s.touch };
  const turning = s.house >= 0 && s.face >= 0, cell = s.tool === 'road' ? (turning ? s.face : s.last) : s.cell;
  return {
    gate, cell, span: s.tool === 'roundabout' ? 3 : 1, touch: s.touch,
    ok: turning ? game!.graph.canFace(s.house, s.face) : valid(s.tool, cell, s.start),
    from: s.tool === 'motorway' ? s.start : -1,
    drive: turning ? [s.house, s.face] : null,
  };
}

// ---------- pointers: one draws, two (or the middle button, or the wheel) move the camera ----------

function twoFingers() {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
}

app.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    app.setPointerCapture(e.pointerId);
  } catch {
    // synthetic pointers (tests) cannot be captured; real ones always can
  }
  if (!game) return;
  if (e.pointerType === 'mouse' && e.button === 1) {
    e.preventDefault();
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    return;
  }
  if (pointers.size >= 2) {
    // a second finger makes this a camera gesture: whatever the first was drawing stops where it is
    stroke = null;
    lifted = false;
    pinch = twoFingers();
    return;
  }
  if (!lifted || !playing()) return;
  const g = game.graph, cell = game.view.pickCell(e.clientX, e.clientY), at = game.view.groundAt(e.clientX, e.clientY);
  if (!at) return;
  const touch = e.pointerType !== 'mouse', erase = (!touch && e.button === 2) || tool === 'erase';
  if (touch) hover = -1;
  aim = { x: e.clientX, y: e.clientY };
  stroke = {
    id: e.pointerId, tool, erase, touch, start: cell, last: cell, cell, ref: at, face: -1, denied: false,
    house: !erase && tool === 'road' && g.nodes.get(cell)?.building === 'house' ? cell : -1,
  };
  if (erase) eraseAt(cell, e.clientX, e.clientY);
});

app.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!game) return;
  const view = game.view;
  if (pan?.id === e.pointerId) {
    view.drag(pan.x, pan.y, e.clientX, e.clientY);
    pan.x = e.clientX;
    pan.y = e.clientY;
    return;
  }
  if (pinch && pointers.size >= 2) {
    const now = twoFingers();
    view.drag(pinch.x, pinch.y, now.x, now.y);
    view.zoomBy(pinch.dist / Math.max(1, now.dist), now.x, now.y);
    pinch = now;
    return;
  }
  const cell = view.pickCell(e.clientX, e.clientY);
  if (e.pointerType === 'mouse') hover = cell;
  if (e.pointerType === 'mouse' || stroke?.id === e.pointerId) aim = { x: e.clientX, y: e.clientY };
  const s = stroke;
  if (!s || s.id !== e.pointerId || !playing()) return;
  const at = view.groundAt(e.clientX, e.clientY);
  if (s.last < 0 && cell >= 0 && at) {
    s.start = s.last = cell;   // the stroke began off the map and has just come onto it
    s.ref = at;
  }
  if (s.erase) {
    if (cell !== s.cell || view.pickMotorway(e.clientX, e.clientY)) eraseAt(cell, e.clientX, e.clientY);
  } else if (s.tool === 'road' && at) extend(s, at);
  s.cell = cell;
});

/** A pointer has gone. If it was the one drawing, finish what it was doing (or drop it, on a cancel). */
function release(e: PointerEvent, commit: boolean) {
  pointers.delete(e.pointerId);
  if (pan?.id === e.pointerId) pan = null;
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) lifted = true;
  const s = stroke;
  if (!s || s.id !== e.pointerId) return;
  stroke = null;
  if (!commit || !game || !playing() || s.erase) return;
  const g = game.graph, cell = game.view.pickCell(e.clientX, e.clientY);
  if (s.tool === 'road') {
    if (s.house >= 0 && s.face >= 0) turnDriveway(s.house, s.face);   // dragged one cell out of a house and let go
  } else if (cell >= 0) {
    // placing tools act where the pointer is released, so a finger can slide to the right spot first
    if (s.tool === 'motorway') {
      if (s.start >= 0 && s.start !== cell) feedback(g.addMotorway(s.start, cell), 'motorways');
    } else if (s.tool === 'roundabout') feedback(g.addRoundabout(g.x(cell), g.y(cell)), 'roundabouts');
    else if (s.tool === 'light') feedback(g.toggleLight(cell), 'lights');
  }
}

app.addEventListener('pointerup', e => release(e, true));
app.addEventListener('pointercancel', e => release(e, false));
app.addEventListener('pointerleave', e => {
  if (e.pointerType !== 'mouse') return;
  hover = -1;
  aim = null;
});
app.addEventListener('wheel', e => {
  e.preventDefault();
  game?.view.zoomBy(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

// nothing on the page should scroll, zoom, select or pop up a menu while playing
for (const type of ['contextmenu', 'gesturestart', 'dblclick', 'selectstart']) addEventListener(type, e => e.preventDefault());
// browsers only start audio after a gesture, and differ on which kind counts
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) addEventListener(type, () => audio.unlock(), { passive: true });

let portrait = innerHeight > innerWidth;
addEventListener('resize', () => {
  game?.view.resize();
  if (portrait !== innerHeight > innerWidth) game?.view.refit();   // rotated: frame the city afresh
  portrait = innerHeight > innerWidth;
});
addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    speed = speed ? 0 : 1;
  } else if (e.key === '1' || e.key === '2') speed = Number(e.key);
});

// ---------- game loop ----------

let last = performance.now(), backlog = 0, tickIn = 0, raf = 0;
let smoothed = STEP, sluggish = 0;

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!game) return;
  const { config, inv, graph, city, traffic, view } = game;

  if (playing()) {
    for (backlog += dt * speed; backlog >= STEP && playing(); backlog -= STEP) {
      city.update(STEP);
      traffic.update(STEP);
    }
  }

  // a device that cannot hold the frame rate gets a cheaper picture rather than a slower game
  smoothed += (dt - smoothed) * 0.05;
  sluggish = smoothed > 0.024 ? sluggish + dt : 0;
  if (sluggish > 2 && view.quality > 0) {
    view.setQuality(view.quality - 1);
    sluggish = 0;
  }

  // the most overdue destination drives the warning banner, the hum and the timer clicks
  const danger = Math.max(0, ...city.dests.map(d => d.overflow));
  const live = playing() && speed > 0;
  audio.setDanger(live ? danger : 0);
  if (live && danger > 0 && (tickIn -= dt * speed) <= 0) {
    tickIn = 1 - 0.6 * danger;
    audio.tick();
  }

  if (stroke || pinch || pan) view.hold();   // the camera only goes back to framing the city once the player is done
  view.frame(dt, city);
  view.reveal(dt, playing() && (stroke || hover >= 0) ? aim : null);
  view.setCursor(cursor());
  view.render(city, traffic, now / 1000);
  const progress = (city.time % DAY_SECONDS) / DAY_SECONDS;
  overlay.hud({
    city: config.name, day: city.day, dayProgress: progress, night: progress > 0.66 && progress < 0.95,
    score: city.score, inv, tool, speed, danger: danger > 0, muted: audio.muted, dark,
  });
  overlay.markers(city.dests.map(d => {
    // the meter floats over the building half of the footprint
    const body = d.cells.filter(c => !d.lot.includes(c));
    const p = view.project(body.reduce((sum, c) => sum + graph.x(c), 0) / body.length, 0.8, body.reduce((sum, c) => sum + graph.y(c), 0) / body.length);
    return { id: d.id, x: p.x, y: p.y, color: d.color, pins: d.pins, max: d.maxPins, overflow: d.overflow };
  }), view.cellPx);
}

// a hidden tab does no work at all: no simulation, no rendering, no sound
document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(raf);
  audio.setActive(!document.hidden);
  if (document.hidden && phase !== 'menu') save();
  if (document.hidden) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
});

// the game is saved every few seconds and whenever the page is hidden or closed, and picked up again on opening
setInterval(() => { if (phase !== 'menu' && !document.hidden) save(); }, 4000);
addEventListener('pagehide', () => { if (phase !== 'menu') save(); });
if (!resume()) overlay.menu(CITIES);
raf = requestAnimationFrame(frame);

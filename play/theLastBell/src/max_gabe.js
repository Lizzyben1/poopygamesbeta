import * as THREE from 'three';
import { createHumanoid, Character, setSeatedPose, standUp } from './world.js';
import { Achievements } from './achievements.js';

/*
 * Max and Gabe: two optional, slightly hidden classmates (a secret: nothing ever points you at them).
 *
 *   Chapter 1   behind the west dumpster outside the rear doors (until the team meeting), then
 *               crouched behind the bleachers (the warm-up and the escape). Gabe talks; Max tries
 *               to, and Gabe cuts him off every single time.
 *   Chapter 2   asleep at their desks in the dark school. Wake them up and they follow you down the
 *               oak... where the lab's first wave gets them (chapter2_lab.js stages that part).
 *
 * Talking to both of them at both Chapter 1 spots, plus that Chapter 2 scene, is the third secret
 * achievement (remembered in this browser, in any order), and it leaves Gabe's Switch 2 lying there
 * to steal.
 */

export const MG_BADGE = 'plot_armor';

// ---------------------------------------------------------------------------
// Progress (localStorage: 'lastbell.*', so the reset cheat clears it too)
// ---------------------------------------------------------------------------

const KEY = 'lastbell.maxgabe';
let progress = null;

function load() {
  if (progress) return progress;
  try {
    progress = JSON.parse(window.localStorage.getItem(KEY) || '{}') || {};
  } catch {
    progress = {};
  }
  return progress;
}

export const mgProgress = {
  /** 'a1' / 'a2': talked to both at that Chapter 1 spot. 'ch2': saw what happened in the lab. */
  mark(key) {
    const p = load();
    p[key] = 1;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      // (blocked storage: it just won't persist)
    }
    if (p.a1 && p.a2 && p.ch2) Achievements.unlock(MG_BADGE);
  },
  get chapter1Done() {
    const p = load();
    return !!(p.a1 && p.a2);
  },
};

// ---------------------------------------------------------------------------
// The looks
// ---------------------------------------------------------------------------

// Max: rumpled grey hoodie, plaid-red pajama pants, bed head he never fixed.
const MAX_LOOK = { shirt: 0x8d939a, pants: 0x7a2630, skin: 0xf0c9a8, hair: 0xe6cf73, shoes: 0x4a4a52 };
// Gabe: a big kid in a big hoodie. Normal black hair.
const GABE_LOOK = { shirt: 0x2f4a3a, pants: 0x2e3b52, skin: 0xe9bb94, hair: 0x141414, scale: 1.17 };

// Bed head: [x, y, z, tilt x, tilt z, length], each tuft rooted on his head and leaning out.
const MAX_TUFTS = [
  [0.0, 0.35, 0.02, 0.15, 0.05, 0.15],
  [-0.08, 0.35, 0.06, 0.4, 0.6, 0.13],
  [0.09, 0.35, 0.01, -0.15, -0.75, 0.16],
  [0.04, 0.35, -0.08, -0.65, -0.25, 0.13],
  [-0.07, 0.35, -0.07, -0.5, 0.5, 0.15],
  [0.1, 0.34, 0.09, 0.55, -0.95, 0.11],
  [-0.12, 0.33, -0.01, 0.1, 1.05, 0.12],
  [0.01, 0.34, 0.11, 0.95, 0.1, 0.11], // flopping over his forehead
  [0.13, 0.27, -0.04, -0.25, -1.35, 0.1], // out over the ears
  [-0.14, 0.26, 0.03, 0.2, 1.3, 0.09],
  [-0.02, 0.29, -0.15, -1.25, 0.2, 0.12], // the back, sticking straight out
];

export function createMax() {
  const root = createHumanoid(MAX_LOOK);
  const { neck } = root.userData.rig;
  const hair = new THREE.MeshStandardMaterial({ color: MAX_LOOK.hair, roughness: 0.95 });
  for (const [x, y, z, rx, rz, h] of MAX_TUFTS) {
    const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.065, h, 0.065).translate(0, h / 2, 0), hair);
    tuft.position.set(x, y, z);
    tuft.rotation.set(rx, 0, rz);
    neck.add(tuft);
  }
  // Dark bags under his eyes: he barely sleeps.
  const bags = new THREE.MeshStandardMaterial({ color: 0x8a6070, roughness: 0.9 });
  for (const x of [-0.06, 0.06]) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.012), bags);
    bag.position.set(x, 0.17, 0.133);
    neck.add(bag);
  }
  return root;
}

export function createGabe() {
  const root = createHumanoid(GABE_LOOK);
  const bulk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.32), new THREE.MeshStandardMaterial({ color: GABE_LOOK.shirt, roughness: 0.85 }));
  bulk.position.set(0, 1.08, 0.01);
  bulk.castShadow = true;
  root.userData.rig.body.add(bulk);
  return root;
}

/** Gabe's Switch 2: a dark console with a lit screen and blue/red Joy-Cons (screen side up, +Y). */
export function createSwitch2() {
  const g = new THREE.Group();
  const box = (w, h, d, material, x = 0, y = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, 0);
    g.add(m);
    return m;
  };
  box(0.2, 0.014, 0.112, new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.45 }));
  box(0.172, 0.004, 0.094, new THREE.MeshBasicMaterial({ color: 0x8fd0ff }), 0, 0.007);
  box(0.042, 0.018, 0.112, new THREE.MeshStandardMaterial({ color: 0x2a8ff0, roughness: 0.5 }), -0.121);
  box(0.042, 0.018, 0.112, new THREE.MeshStandardMaterial({ color: 0xf0443c, roughness: 0.5 }), 0.121);
  return g;
}

// ---------------------------------------------------------------------------
// Following: a breadcrumb trail of where you walked (so they never cut through a wall)
// ---------------------------------------------------------------------------

export class Trail {
  constructor() {
    this.pts = [];
  }

  /** Start over from these points (oldest first). */
  reset(points) {
    this.pts = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
  }

  record(p) {
    const last = this.pts[this.pts.length - 1];
    if (last && (p.x - last.x) ** 2 + (p.z - last.z) ** 2 < 0.09) return;
    this.pts.push(new THREE.Vector3(p.x, 0, p.z));
    if (this.pts.length > 200) this.pts.shift();
  }

  /**
   * The point `dist` meters back along the trail from `p` (or the oldest point, if it's shorter), `side`
   * meters off to one side of it (so a second follower isn't hidden right behind the first).
   */
  back(p, dist, out, side = 0) {
    let px = p.x;
    let pz = p.z;
    for (let i = this.pts.length - 1; i >= 0; i--) {
      const q = this.pts[i];
      const d = Math.hypot(q.x - px, q.z - pz);
      if (d >= dist && d > 1e-6) {
        const dx = (q.x - px) / d;
        const dz = (q.z - pz) / d;
        return out.set(px + dx * dist - dz * side, 0, pz + dz * dist + dx * side);
      }
      dist -= d;
      px = q.x;
      pz = q.z;
    }
    return out.set(px, 0, pz);
  }
}

// ---------------------------------------------------------------------------
// What they say
// ---------------------------------------------------------------------------

/** A shuffled bag: every line once before any repeats. */
function bag(list) {
  let order = [];
  return () => {
    if (!order.length) {
      order = list.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    return list[order.pop()];
  };
}

// Max knows things (he's up all night), but he never gets past a few words.
const nextMaxStart = bag([
  'Okay, so the boiler room—',
  'I keep seeing this van—',
  'What if the power goes—',
  "There's a hall under the—",
  "Coach's back keeps clicking. Like—",
  'The gym basement has a—',
  'Has anyone counted the sprinklers—',
  "He keeps saying 'final exam'—",
  'I saw three Coaches. Three—',
  'If Coach ever gets arrested—',
  'Never hide in a trunk—',
  'Tiny robots, digging through trash—',
  'Rocks. If they come, throw—',
  "There's this pipe that—",
  "His playbook isn't for running—",
  "Lasers. I'm just saying. Lasers—",
  'Never sit in his chair—',
  "Coach's headset isn't for music—",
  'At 3 AM the gym—',
  'Last night I heard drilling—',
  'The police scanner said—',
  "The school's wiring is haunted—",
  'Did you see his vents—',
  'It always ends in fists—',
  'Okay, hear me out. Robots—',
  "I haven't slept since Tuesday—",
  'The furnace downstairs is always—',
  'If the doors ever lock—',
]);

const nextCutOff = bag([
  'Max. Nobody asked.',
  "And he's off. Ignore him.",
  'Max, go to sleep. Please. For all of us.',
  'We talked about this. Inside thoughts.',
  "He's been awake for, like, forty hours. Don't encourage him.",
  'That was a dream, Max. You finally slept and it was THAT.',
  'Is this from the same forum as the lizard thing?',
  "Translation: he's tired.",
  'He means hi.',
  "Max, blink. You haven't blinked in a minute.",
  'Not this again.',
  'Dude, you had three energy drinks at lunch.',
  'Cool story. Anyway.',
  "Max. Breathe. Then don't talk.",
  'You said the same thing about the lunch lady.',
  "Okay, that's enough internet for you.",
  'Ignore him. He reads the comment sections.',
  'Nope. Not today, Max.',
  "He's buffering. Give him a second. Actually, don't.",
  'Max, your hair is louder than you are right now.',
  'We are NOT doing the theory board again.',
  'Every time. EVERY time.',
  'Max, I will put you in a locker.',
  "Bro, you're doing the eye thing again.",
  'Shh. Grown-ups are talking.',
  "He doesn't mean any of that. He means nap.",
]);

// Max's first try at each spot (then it's the bag).
const MAX_OPENERS = { a1: "I don't trust Coach. He—", a2: 'Coach never sleeps either. He—' };

// Gabe: a few things to get off his chest at each spot (in order, one per talk), then small talk.
const GABE = {
  a1: {
    talks: [
      [
        "Oh. Hey. You didn't see us back here, okay? We're... stretching.",
        'Okay, confession. I bought the Nintendo Switch 2.',
        'I KNOW. I said it was bad. I said it to your face, like, fifty times.',
        "I'm sorry. I was wrong. It's really, really good. Please don't make it a thing.",
      ],
      ["Real talk? I don't trust Coach. Nobody wants practice this bad in a thunderstorm unless they're hiding something."],
      ["Ever touched the boiler room door? It's warm. In the winter. Something's running down there all night."],
    ],
    small: bag([
      'Shh. Final boss.',
      'Go, before Coach starts counting heads.',
      'If he asks, you never saw us.',
      'Still sorry about the Switch thing. Genuinely.',
      "Don't look at me like that. The screen's bigger.",
      "We'll be out there in five minutes. Or never. One of those.",
    ]),
  },
  a2: {
    talks: [
      [
        'Get DOWN. Coach Billing walked right past here like a minute ago.',
        "I'm telling you, I don't trust him. He looks at the team like we're... inventory.",
      ],
      ["Rule one: if the power ever goes out at this school, you don't go looking around. You just leave."],
      [
        "Max swears Coach drives a grey van at night. No plates. Max also swears the gym's haunted, so.",
        "Also, sorry again. About the Switch. I'm a hypocrite. I've made my peace with it.",
      ],
    ],
    small: bag([
      'Shh. He hears everything.',
      'Go run your loop. We were never here.',
      "If Coach finds us, we're stretching. Again.",
      "My socks are so wet they're basically soup.",
      "Don't let him see you looking over here.",
    ]),
  },
  following: {
    talks: [],
    small: bag([
      'Right behind you.',
      'Worst. Sleepover. Ever.',
      "If this is a prank, it's a really committed one.",
      "Lead the way. My leg's still asleep.",
      "I'm not scared. You're scared.",
    ]),
  },
};

// [speaker, line, hold]: a short hold on Max's lines is Gabe cutting in the moment he gets them out.
const WAKE_UP = [
  ['Gabe', '...Mm? Huh? What time is it?'],
  ['Max', "I wasn't asleep, I was just—", 0.35],
  ['Gabe', 'You were snoring, Max. We came in to dodge the rain and just... passed out.'],
  ['', 'You tell them everything. The tree. The hidden door. Coach climbing down into the dark.'],
  ['Gabe', 'I KNEW it. I knew that man was hiding something.'],
  ['Max', 'I literally told you—', 0.35],
  ['Gabe', "Okay. We're coming with you. Lead the way."],
];

/** Lines for Chapter 2 (chapter2_lab.js plays these). */
export const MG_LAB = {
  // Other Ben, the first time he sees them (the only time he ever acknowledges them).
  benAsks: [
    ['Other Ben', 'Wait... who are THEY?'],
    ['Gabe', "Gabe. That's Max. We sit behind you in history."],
    ['Max', "We've met, like, six ti—", 0.35],
    ['Other Ben', 'Cool. Anyway.'],
  ],
  // Right after Other Ben's "Are those... robots?" in the pod corridor.
  robots: [
    ['Max', 'I KNEW there were robots—', 0.35],
    ['Gabe', 'Max. Not. Now.'],
  ],
  armory: [
    ['Gabe', "Wait. Two rifles? There's four of us."],
    ['Max', 'We could take turns wi—', 0.35],
    ['Gabe', "Nope. We'll hide behind Ben. Ben's got this."],
  ],
  peek: ['Max', 'Is it gone? I think—', 0.3],
  grab: ['Gabe', 'MAX! Dude, get dow—', 0.3],
  shrug: ['You', "Oh well. I didn't really like them anyways."],
};

const _head = new THREE.Vector3();

/** Where a character's head actually is (crouched, seated or on a ladder). */
function headOf(character) {
  return character.mesh.userData.rig.neck.localToWorld(_head.set(0, 0.17, 0));
}

/**
 * Max getting cut off: the view swings to whoever's talking and zooms in a touch. In gameplay it takes
 * the controls for the beat and hands them back; inside a cutscene it only aims the camera.
 */
function cutOffShot({ player, director }, busy) {
  const owns = !player.inputLocked && !player.cameraOverride;
  if (owns) player.setInputLocked(true);
  return {
    look(character, fov) {
      player.setLookTarget(() => headOf(character));
      director.zoomTo(fov, 0.3);
    },
    end() {
      director.zoomTo(75, 0.45);
      if (!owns || busy()) return; // (a cutscene has the camera and the controls: they're its to hand back)
      player.setLookTarget(null);
      player.setInputLocked(false);
    },
  };
}

/**
 * Play [speaker, line, hold?] lines in order. Stops early (false) if someone else's line takes over
 * the box or `busy()` says a cutscene started. With `cam` ({ player, director, who: { speaker: character } }),
 * every time Max gets cut off the view goes from him to whoever cut in (`track`: in a cutscene, the view
 * follows every line's speaker).
 */
export async function sayLines(dialogue, lines, busy = () => false, cam = null) {
  let shot = null;
  let finished = true;
  for (let i = 0; i < lines.length; i++) {
    const [speaker, text, hold] = lines[i];
    if (busy()) {
      finished = false;
      break;
    }
    const next = lines[i + 1];
    const cutOff = !!(cam && speaker === 'Max' && hold !== undefined && next && cam.who[next[0]]);
    if (cutOff && !shot) shot = cutOffShot(cam, busy);
    if (shot && cam.who[speaker]) shot.look(cam.who[speaker], cutOff ? 62 : 58); // (on Max, then a harder push-in on whoever cuts in)
    else if (cam && cam.track && cam.who[speaker]) cam.player.setLookTarget(() => headOf(cam.who[speaker])); // (a cutscene: look at whoever's talking)
    const opts = speaker ? {} : { style: 'narration' };
    if (hold !== undefined) opts.hold = hold;
    await dialogue.say(speaker, text, opts);
    if (shot && !cutOff) {
      shot.end(); // (Gabe's had his say: the camera's yours again)
      shot = null;
    }
    if (dialogue.active) {
      finished = false; // (a new line replaced ours)
      break;
    }
  }
  if (shot) shot.end();
  return finished;
}

// ---------------------------------------------------------------------------
// Where they hang out on the grounds
// ---------------------------------------------------------------------------

const EARLY_PHASES = new Set(['intro', 'pack', 'exit', 'toTree']); // before the team meeting: spot a1
// (Crouched over his Switch, Gabe's hands reach ~0.95m out in front of him, and he turns to face you: both
// spots keep a meter clear all the way round him, or the Switch ends up inside the dumpster / the bleachers.)
const SPOTS = {
  // Tucked behind the west dumpster under the walkway roof: the dumpster hides them from the doorway.
  a1: {
    gabe: { x: -7.95, z: -36.95, look: [0, -37], crouch: true },
    max: { x: -7.65, z: -38.2, look: [-5, -35], crouch: false },
  },
  // Crouched behind the bleachers (their tall back faces the school, the field can't see them).
  a2: {
    gabe: { x: -8.3, z: -63.05, look: [-8.3, -50], crouch: true },
    max: { x: -6.75, z: -63.15, look: [-5, -50], crouch: true },
  },
};
// Chapter 2: their desks in the middle row (x), asleep in the seats behind them.
const DESK_ROW_Z = -5.2;
const SEAT_OFFSET = 0.55;
const SEATS = { gabe: 0, max: 4 };

// ---------------------------------------------------------------------------
// The two of them on the surface (Chapter 1's grounds, Chapter 2's school)
// ---------------------------------------------------------------------------

export class MaxGabe {
  /**
   * @param {object} ctx
   * @param {THREE.Scene} ctx.scene - Chapter 1's world scene
   * @param {object} ctx.world - its NPC list doubles as the player's solid characters
   * @param {import('./player.js').Player} ctx.player
   * @param {object} ctx.dialogue
   * @param {import('./cutscene.js').CutsceneDirector} ctx.director - its lens zoom (when Gabe cuts Max off)
   */
  constructor({ scene, world, player, dialogue, director }) {
    Object.assign(this, { scene, world, player, dialogue, director });
    this.busy = () => false; // the chapter running sets this (a cutscene stops their chatter)
    this.max = this._make(createMax(), 'max', 'Max', 0.32);
    this.gabe = this._make(createGabe(), 'gabe', 'Gabe', 0.38);
    this.kids = [this.max, this.gabe];
    this.targets = this.kids.map((k) => k.mesh); // [E] targets
    // How far back along your trail they walk (Max a little off to one side of it: you can see him past Gabe).
    this.max.gap = 2.4;
    this.max.side = 0.7;
    this.gabe.gap = 1.7;
    this.cam = { player, director, who: { Max: this.max, Gabe: this.gabe } }; // (Gabe cutting Max off: the view follows)

    this.handSwitch = createSwitch2();
    this.handSwitch.position.set(0, 1.16, 0.44);
    this.handSwitch.rotation.x = -0.8; // screen tipped up at his face
    this.gabe.rig.body.add(this.handSwitch);
    this.deskSwitch = createSwitch2();
    this.deskSwitch.visible = false;
    scene.add(this.deskSwitch);

    this.mode = 'off'; // off | a1 | a2 | sleeping | waking | following | gone
    this.talking = false;
    this.met = { a1: new Set(), a2: new Set() };
    this.maxTried = {};
    this.gabeTalk = {};
    this.trail = new Trail();
    this.t = 0;
  }

  _make(mesh, who, name, radius) {
    mesh.visible = false;
    mesh.name = who;
    Object.assign(mesh.userData, { interactable: true, type: 'mg', who, name, label: `Talk to ${name}` });
    this.scene.add(mesh);
    const kid = new Character(mesh, { radius, name });
    kid.who = who;
    kid.rig = mesh.userData.rig;
    kid.look = new THREE.Vector3();
    kid.goal = new THREE.Vector3();
    this.world.npcs.all.push(kid); // updated with the world's NPCs, and solid to you
    return kid;
  }

  get following() {
    return this.mode === 'following';
  }

  /** You woke them up in Chapter 2: they're with you (on your heels, or stood aside for a cutscene). */
  get recruited() {
    return this.mode === 'following' || this.mode === 'aside';
  }

  _follow() {
    this.trail.reset([this.max.position, this.gabe.position, this.player.object.position]);
    for (const kid of this.kids) kid.follow(() => this.trail.back(this.player.object.position, kid.gap, kid.goal, kid.side || 0), 8); // (they keep up with a sprint)
    this.mode = 'following';
  }

  /**
   * A cutscene's starting: stop trailing you and stand at these spots, out of its shots (no spots: just
   * stop where they are), facing `face`.
   */
  stepAside(gabeSpot = null, maxSpot = null, face = null) {
    if (this.mode !== 'following') return;
    this.mode = 'aside';
    for (const [kid, spot] of [[this.gabe, gabeSpot], [this.max, maxSpot]]) {
      if (!spot) {
        kid.stop();
        kid.faceTowards(face);
        continue;
      }
      kid.moveTo(spot.x, spot.z, 3.4).then(() => {
        if (this.mode === 'aside') kid.faceTowards(face);
      });
    }
  }

  /** The cutscene's over: back on your heels. */
  resume() {
    if (this.mode === 'aside') this._follow();
  }

  // ---- Chapter 1 ------------------------------------------------------------------

  startChapter1() {
    this._place('a1');
  }

  _place(spot) {
    for (const kid of this.kids) {
      const s = SPOTS[spot][kid.who];
      kid.stop();
      kid.mesh.position.set(s.x, 0, s.z);
      kid.look.set(s.look[0], 0, s.look[1]);
      kid.mesh.rotation.y = Math.atan2(kid.look.x - s.x, kid.look.z - s.z);
      kid.rig.crouch = s.crouch;
      kid.mesh.visible = true;
    }
    this.gabe.rig.typing = true; // thumbs on the Switch
    this.handSwitch.visible = true;
    this.mode = spot;
  }

  // ---- Chapter 2 ------------------------------------------------------------------

  /** 1:30 AM: out cold at their desks, the Switch still glowing on Gabe's. */
  prepareChapter2() {
    for (const kid of this.kids) {
      kid.stop();
      kid.faceTowards(null);
      kid.rig.crouch = false;
      kid.rig.crouchAmount = 0;
      kid.rig.typing = false;
      kid.rig.body.rotation.x = 0;
      if (!kid.rig.seated) setSeatedPose(kid.mesh);
      kid.mesh.position.set(SEATS[kid.who], 0, DESK_ROW_Z - SEAT_OFFSET);
      kid.mesh.rotation.y = 0; // facing the whiteboard
      kid.mesh.userData.label = `Wake up ${kid.mesh.userData.name}`;
      kid.mesh.visible = true;
    }
    this.handSwitch.visible = false;
    this.deskSwitch.position.set(SEATS.gabe + 0.18, 0.83, DESK_ROW_Z + 0.02);
    this.deskSwitch.rotation.y = 0.3;
    this.deskSwitch.visible = true;
    this.mode = 'sleeping';
  }

  /** You climbed down the oak: they follow you into the lab (Chapter 2 builds its own copies there). */
  leaveSurface() {
    this.hide();
    this.mode = 'gone';
  }

  /** Not in this chapter. */
  hide() {
    for (const kid of this.kids) {
      kid.stop();
      kid.mesh.visible = false;
    }
    this.deskSwitch.visible = false;
    this.mode = 'off';
  }

  // ---- [E] --------------------------------------------------------------------------

  async talk(who) {
    if (this.talking) {
      this.dialogue.advance(); // (still looking at them: [E] moves the conversation along)
      return;
    }
    if (this.mode === 'sleeping') {
      this._wake();
      return;
    }
    const spot = this.mode;
    if (spot !== 'a1' && spot !== 'a2' && spot !== 'following') return;
    this.talking = true;
    if (this.met[spot]) {
      this.met[spot].add(who);
      if (this.met[spot].size === 2) mgProgress.mark(spot);
    }
    if (who === 'max') {
      // He gets a few words out. Gabe cuts in.
      const first = !this.maxTried[spot] && MAX_OPENERS[spot];
      this.maxTried[spot] = true;
      await sayLines(this.dialogue, [['Max', first || nextMaxStart(), 0.35], ['Gabe', nextCutOff()]], this.busy, this.cam);
    } else {
      const script = GABE[spot];
      const i = this.gabeTalk[spot] || 0;
      const lines = i < script.talks.length ? script.talks[i] : [script.small()];
      this.gabeTalk[spot] = i + 1;
      await sayLines(this.dialogue, lines.map((line) => ['Gabe', line]), this.busy);
    }
    this.talking = false;
  }

  async _wake() {
    this.talking = true;
    this.mode = 'waking';
    const { gabe, max } = this;
    const pp = this.player.object.position;
    this.deskSwitch.visible = false; // (into his pocket)
    standUp(gabe.mesh);
    gabe.faceTowards(pp);
    const lines = WAKE_UP.slice();
    await sayLines(this.dialogue, lines.slice(0, 1), this.busy, this.cam);
    standUp(max.mesh);
    max.faceTowards(pp);
    await sayLines(this.dialogue, lines.slice(1), this.busy, this.cam);
    // (Even if something cut the conversation short: they're up, and they're coming.)
    for (const kid of this.kids) kid.mesh.userData.label = `Talk to ${kid.mesh.userData.name}`;
    this._follow();
    this.talking = false;
  }

  // ---- Per frame (after the world's NPCs have moved and posed) ------------------------

  update(dt, phase = null) {
    if (this.mode === 'off' || this.mode === 'gone') return;
    this.t += dt;
    const pp = this.player.object.position;
    if (this.mode === 'a1' && phase && !EARLY_PHASES.has(phase)) this._place('a2');
    if (this.mode === 'sleeping') {
      // Heads down on their chests, breathing slow.
      this.gabe.rig.neck.rotation.x = 0.82 + Math.sin(this.t * 1.3) * 0.05;
      this.max.rig.neck.rotation.x = 0.9 + Math.sin(this.t * 1.1 + 2) * 0.05;
      return;
    }
    if (this.mode === 'following') {
      this.trail.record(pp);
      return;
    }
    if (this.mode !== 'a1' && this.mode !== 'a2') return;
    for (const kid of this.kids) {
      const near = kid.position.distanceToSquared(pp) < 36;
      kid.faceTowards(near ? pp : kid.look);
      // Max's head keeps drooping (no sleep); Gabe's is down in his Switch. Both look up to talk.
      kid.rig.neck.rotation.x = this.talking && near ? 0.05 : kid === this.max ? 0.32 + Math.sin(this.t * 0.9) * 0.1 : 0.5;
    }
  }
}

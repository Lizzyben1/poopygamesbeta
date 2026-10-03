import * as THREE from 'three';
import { Player } from './player.js';
import { buildWorld } from './world.js';
import { StealthSystem } from './stealth.js';
import { CutsceneDirector, showChapterComplete } from './cutscene.js';
import { Chapter2 } from './chapter2_lab.js';
import { Chapter3 } from './chapter3_stealth.js';
import { SecretChapter } from './secret_chapter.js';
import { MaxGabe } from './max_gabe.js';
import { Achievements } from './achievements.js';
import { hitstop } from './combat.js';
import { initAudio, setAudioPaused, playBeep, setMasterVolume, setLowHealth } from './audio.js';
import {
  difficulty,
  sandbox,
  isHardUnlocked,
  setHardMode,
  unlockHardMode,
  markGameBeaten,
  markFlawless,
  grantHallLegend,
  resetAllProgress,
  isFlawless,
  isPartFlawless,
  markPartFlawless,
  isPartOneUnlocked,
  isPartTwoUnlocked,
  hasHallLegend,
  isSandboxUnlocked,
  setSandbox,
} from './difficulty.js';

// ---------------------------------------------------------------------------
// Renderer / Scene / Camera
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Only the classroom's center light casts shadows, so its cube shadow map is
// rendered on demand instead of 6 extra scene passes every frame: once at
// load, every frame while classmates are getting up and filing out (see
// updateClassroomShadows), and when a desk pickup is taken.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const SKY_COLOR = 0x555c66;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.FogExp2(SKY_COLOR, 0.006);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);

// ---------------------------------------------------------------------------
// Lighting zones
// ---------------------------------------------------------------------------
// Ambient/hemisphere/directional lights are global in three.js, so the zones are
// a blend of intensities driven by where the player is: warm and bright inside,
// dim overcast outside. (Previously the warm interior ambient lit the whole
// exterior at full strength.)

const interiorAmbient = new THREE.AmbientLight(0xfff1d6, 0);
const interiorFill = new THREE.HemisphereLight(0xfff6e0, 0x554433, 0);
const exteriorHemi = new THREE.HemisphereLight(0x6b7480, 0x2a2a24, 0);
const exteriorSun = new THREE.DirectionalLight(0x9aa4ad, 0);
scene.add(interiorAmbient, interiorFill, exteriorHemi, exteriorSun, exteriorSun.target);

const ZONE_INTERIOR = { ambient: 0.85, fill: 0.4, hemi: 0, sun: 0, fog: 0.006 };
const ZONE_EXTERIOR = { ambient: 0.05, fill: 0, hemi: 0.8, sun: 0.55, fog: 0.013 };
const ZONE_NIGHT = { ambient: 0.03, fill: 0, hemi: 0.3, sun: 0.14, fog: 0.02 }; // Chapter 2, 1:30 AM
const NIGHT_SKY = 0x0b0e14;
let exteriorZone = ZONE_EXTERIOR;
let zoneBlend = 0; // 0 = interior, 1 = exterior

function updateLightingZones(dt, outside) {
  zoneBlend += ((outside ? 1 : 0) - zoneBlend) * Math.min(1, dt * 1.8);
  const mix = (key) => ZONE_INTERIOR[key] + (exteriorZone[key] - ZONE_INTERIOR[key]) * zoneBlend;
  interiorAmbient.intensity = mix('ambient');
  interiorFill.intensity = mix('fill');
  exteriorHemi.intensity = mix('hemi');
  exteriorSun.intensity = mix('sun');
  scene.fog.density = mix('fog');
}
updateLightingZones(0, false);

/**
 * Chapter 2 comes back to the grounds at 1:30 AM: moonlight instead of overcast
 * dusk. Chapter 3 passes overrides (a little more moonlight, thinner fog: you
 * have to read the whole field to sneak across it).
 */
function setNight(overrides = null) {
  exteriorZone = overrides ? { ...ZONE_NIGHT, ...overrides } : ZONE_NIGHT;
  scene.background.set(NIGHT_SKY);
  scene.fog.color.set(NIGHT_SKY);
  exteriorHemi.color.set(0x34445e);
  exteriorHemi.groundColor.set(0x0c0e12);
  exteriorSun.color.set(0x8ea4cc);
  zoneBlend = 1;
  world.setNight();
}

// The scene being rendered: Chapter 1's world, or Chapter 2's lab once you climb down.
let activeScene = scene;

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const objectiveBanner = document.getElementById('objective-banner');
const objectiveText = document.getElementById('objective-text');
const interactPrompt = document.getElementById('interact-prompt');
const interactLabel = document.getElementById('interact-label');
const flashlightIndicator = document.getElementById('flashlight-indicator');
const flashlightState = document.getElementById('flashlight-state');
const messageToast = document.getElementById('message-toast');
const dialogueBox = document.getElementById('dialogue-box');
const dialogueSpeaker = document.getElementById('dialogue-speaker');
const dialogueText = document.getElementById('dialogue-text');
const startOverlay = document.getElementById('start-overlay');
const startPanel = document.getElementById('start-panel');
const menuSubtitle = document.getElementById('menu-subtitle');
const mainMenu = document.getElementById('main-menu');
const chapterMenu = document.getElementById('chapter-menu');
const pauseMenu = document.getElementById('pause-menu');

const dialogueHint = document.createElement('div');
dialogueHint.textContent = '[E] continue';
dialogueHint.style.cssText = 'margin-top:8px;font-size:10px;letter-spacing:2px;opacity:0.45;';
dialogueBox.appendChild(dialogueHint);

const lockError = document.createElement('p');
lockError.style.cssText = 'margin:14px 0 0;font-size:12px;color:#e0c34a;min-height:1em;';
startPanel.appendChild(lockError);

objectiveBanner.classList.add('hidden'); // revealed when the bell rings

let lastObjectiveTitle = '';
function setObjective(title, tasks = []) {
  objectiveBanner.classList.remove('hidden');
  objectiveText.textContent = title;
  if (tasks.length) {
    const list = document.createElement('div');
    list.style.cssText = 'margin-top:8px;font-size:12px;line-height:1.6;';
    for (const task of tasks) {
      const row = document.createElement('div');
      if (task.tip) {
        row.textContent = `› ${task.label}`;
        row.style.opacity = '0.7';
      } else {
        row.textContent = `${task.done ? '☑' : '☐'} ${task.label}`;
      }
      if (task.done) {
        row.style.opacity = '0.45';
        row.style.textDecoration = 'line-through';
      }
      list.appendChild(row);
    }
    objectiveText.appendChild(list);
  }
  if (title !== lastObjectiveTitle) {
    lastObjectiveTitle = title;
    objectiveBanner.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' });
  }
}

function hideObjective() {
  objectiveBanner.classList.add('hidden');
  lastObjectiveTitle = '';
}

function setPrompt(label) {
  if (label) {
    interactLabel.textContent = label;
    interactPrompt.classList.remove('hidden');
  } else {
    interactPrompt.classList.add('hidden');
  }
}

// Two timers: previously only the outer one was cleared, so a message shown
// during the previous toast's 250ms fade-out got hidden immediately.
let toastHideTimer = null;
let toastRemoveTimer = null;
function showMessage(text, duration = 2400) {
  clearTimeout(toastHideTimer);
  clearTimeout(toastRemoveTimer);
  messageToast.textContent = text;
  messageToast.classList.remove('hidden');
  requestAnimationFrame(() => messageToast.classList.add('visible'));
  toastHideTimer = setTimeout(() => {
    messageToast.classList.remove('visible');
    toastRemoveTimer = setTimeout(() => messageToast.classList.add('hidden'), 250);
  }, duration);
}

// ---------------------------------------------------------------------------
// Game-time scheduling + dialogue (both freeze while paused)
// ---------------------------------------------------------------------------

const timers = [];
function wait(seconds) {
  return new Promise((resolve) => timers.push({ remaining: seconds, resolve }));
}
function updateTimers(dt) {
  for (let i = timers.length - 1; i >= 0; i--) {
    timers[i].remaining -= dt;
    if (timers[i].remaining <= 0) {
      const { resolve } = timers[i];
      timers.splice(i, 1);
      resolve();
    }
  }
}

// The whole line is laid out from the first frame, with the not-yet-typed part
// invisible: the box opens at its final size and words never jump to the next
// line mid-type (it used to open empty, then snap to size a frame later).
const dialogueTyped = document.createElement('span');
const dialogueRest = document.createElement('span');
dialogueRest.style.visibility = 'hidden';
function setDialogueText(text, shown) {
  if (!dialogueTyped.isConnected) dialogueText.replaceChildren(dialogueTyped, dialogueRest);
  dialogueTyped.textContent = text.slice(0, shown);
  dialogueRest.textContent = text.slice(shown);
}

/** Typewriter subtitle box. say() resolves when the line is dismissed or times out. */
const dialogue = {
  active: false,
  text: '',
  shown: 0,
  hold: 0,
  heldFor: 0,
  resolve: null,

  say(speaker, text, { style = 'normal', hold } = {}) {
    this.finish();
    this.active = true;
    this.text = text;
    this.shown = 0;
    this.heldFor = 0;
    this.hold = hold ?? Math.max(1.8, text.split(/\s+/).length * 0.3);
    dialogueSpeaker.textContent = speaker;
    dialogueSpeaker.classList.toggle('hidden', !speaker);
    dialogueText.style.fontStyle = style === 'normal' ? 'normal' : 'italic';
    dialogueText.style.opacity = style === 'whisper' ? '0.8' : '1';
    dialogueText.style.fontSize = style === 'whisper' ? '14px' : '';
    setDialogueText(text, 0);
    dialogueBox.classList.remove('hidden');
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  },

  update(dt) {
    if (!this.active) return;
    if (this.shown < this.text.length) {
      this.shown = Math.min(this.text.length, this.shown + dt * 48);
      setDialogueText(this.text, Math.floor(this.shown));
    } else {
      this.heldFor += dt;
      if (this.heldFor >= this.hold) this.finish();
    }
  },

  /** [E]: first press completes the line, second press dismisses it. */
  advance() {
    if (!this.active) return;
    if (this.shown < this.text.length) {
      this.shown = this.text.length;
      setDialogueText(this.text, this.text.length);
    } else {
      this.finish();
    }
  },

  finish() {
    if (!this.active) return;
    this.active = false;
    dialogueBox.classList.add('hidden');
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve) resolve();
  },
};

// ---------------------------------------------------------------------------
// Objective marker: a bobbing, spinning yellow indicator over the active task
// ---------------------------------------------------------------------------

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const marker = {
  mesh: (() => {
    const group = new THREE.Group();
    // fog: false keeps it readable at a distance through the overcast haze.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd21f, fog: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.38, 4), mat);
    cone.rotation.x = Math.PI; // point down at the target
    group.add(cone);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.022, 6, 20), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.3;
    group.add(ring);
    group.visible = false;
    scene.add(group);
    return group;
  })(),
  key: null,
  pop: 0,
  time: 0,

  /** @param {{key: string, position: THREE.Vector3, scale: number} | null} target */
  update(dt, target) {
    this.time += dt;
    if (!target) {
      this.mesh.visible = false;
      this.key = null;
      return;
    }
    if (target.key !== this.key) {
      this.key = target.key; // new target: pop in at its location
      this.pop = 0;
    }
    this.pop = Math.min(1, this.pop + dt / 0.35);
    const scale = target.scale * Math.max(0.001, easeOutBack(this.pop));
    this.mesh.visible = true;
    this.mesh.scale.setScalar(scale);
    this.mesh.position.set(
      target.position.x,
      target.position.y + Math.sin(this.time * 2.6) * 0.09 * target.scale,
      target.position.z,
    );
    this.mesh.rotation.y += dt * 1.8;
  },
};

// ---------------------------------------------------------------------------
// World + Player
// ---------------------------------------------------------------------------

const world = buildWorld(scene);
const L = world.landmarks;
exteriorSun.position.set(-30, 40, L.treeZ + 24);
exteriorSun.target.position.copy(L.treePosition);

const player = new Player(camera, renderer.domElement, {
  colliders: world.colliders,
  interactables: world.interactables,
  characters: world.npcs.all,
  spawnPosition: world.spawn.position,
  spawnYaw: world.spawn.yaw,
  spawnPitch: world.spawn.pitch,
  seated: world.spawn.seated,
  onUse: handleUse,
  onPromptChange: setPrompt,
  onFlashlightToggle: handleFlashlightToggle,
  onLockError: handleLockError,
});
player.onDamage = (amount) => Achievements.damage(amount); // (flawless chapters and the no-damage achievements)
scene.add(player.object);
world.events.onCollidersChanged = () => player.setColliders(world.colliders);

// Coach Billing watches you the whole way out to the tree.
world.npcs.coach.faceTowards(player.object.position);

// Phase 3 stealth + Phase 4 ending systems (the tree's hidden door exists from the start).
const stealth = new StealthSystem({ scene, world, player });
stealth.onCaught = (guard) => runCaughtSequence(guard);
const director = new CutsceneDirector({ world, camera });
world.attachCamera(camera); // rain follows the camera

// Max and Gabe: two optional classmates, slightly hidden on the grounds (and asleep in the school in Chapter 2).
const maxGabe = new MaxGabe({ scene, world, player, dialogue, director });
world.interactables.push(...maxGabe.targets);
maxGabe.busy = () => story.cutscene || chapter2.cutscene;

// Player-mounted flashlight (off by default; toggled with 'F'). getObject() is
// the camera itself in r160, so `scene.add(player.object)` already put it in the graph.
// A soft radial beam: a wide penumbra plus a projected falloff texture (a hot
// core, a dimmer spill ring, feathered to nothing at the rim). Its aim trails
// the view a little (the player slerps the target after the camera).
const flashlight = new THREE.SpotLight(0xdfe8ff, 0, 18, Math.PI / 6, 0.5, 1.5);
flashlight.map = createBeamFalloffTexture();
flashlight.position.set(0, 0, 0);
flashlight.target.position.set(0, 0, -1);
camera.add(flashlight, flashlight.target);
player.attachFlashlight(flashlight);
let flashlightPower = 8; // (the Secret Chapter's blackout hands you a stronger emergency light)

/** The flashlight's beam profile, projected down the cone (white = full strength). */
function createBeamFalloffTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgb(255,255,255)');
  grad.addColorStop(0.3, 'rgb(247,247,247)'); // the hot core
  grad.addColorStop(0.5, 'rgb(204,204,204)');
  grad.addColorStop(0.7, 'rgb(128,128,128)'); // the spill
  grad.addColorStop(0.85, 'rgb(56,56,56)');
  grad.addColorStop(1, 'rgb(0,0,0)'); // feathered out to nothing at the rim
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function handleFlashlightToggle(isOn) {
  flashlight.intensity = isOn ? flashlightPower : 0;
  flashlightIndicator.classList.remove('hidden');
  flashlightState.textContent = isOn ? 'ON' : 'OFF';
  flashlightState.style.color = isOn ? '#e0c34a' : '';
  if (isOn && story.chapter === 3) Achievements.flag('ch3_flashlight'); // (Blind Faith: never switching it on in Chapter 3)
}

/** Chapter 1's grounds at dawn (the Secret Chapter's last scene): warm low sun, clear sky, no more storm. */
function setDawn() {
  exteriorZone = { ambient: 0.34, fill: 0, hemi: 1.1, sun: 1.0, fog: 0.007 };
  scene.background.set(0xeeb98f);
  scene.fog.color.set(0xd9a988);
  exteriorHemi.color.set(0xffe2c4);
  exteriorHemi.groundColor.set(0x4a4034);
  exteriorSun.color.set(0xffc890);
  exteriorSun.position.set(70, 16, -60);
  exteriorSun.target.position.set(0, 0, -50);
  zoneBlend = 1;
  const rain = scene.getObjectByName('rain');
  if (rain) rain.visible = false;
  const storm = scene.getObjectByName('storm-rain');
  if (storm) storm.visible = false;
}

// Chapter 2 (1:30 AM at the oak, then the lab below it) lives in chapter2_lab.js.
const chapter2 = new Chapter2({
  renderer,
  camera,
  player,
  world,
  director,
  stealth,
  dialogue,
  wait,
  mg: maxGabe,
  ui: {
    setObjective,
    hideObjective,
    showMessage,
    setNight,
    setFlashlight(on) {
      player.flashlightOn = on;
      handleFlashlightToggle(on);
    },
    /** Switch the rendered scene; the camera carries the player's flashlight along. */
    setScene(next) {
      activeScene = next;
      next.add(camera);
      next.add(marker.mesh);
    },
    onChapterComplete() {
      Achievements.completeChapter(2);
      if (session === 'play') {
        startChapter3(true); // Play: straight on up to the grounds (its title card says CHAPTER 2 COMPLETE first)
        return;
      }
      // Chapter Select run: end card (continue into Chapter 3, or back to the menu).
      endCard = showChapterComplete({
        chapter: 2,
        next: 'NEXT: CHAPTER 3 · LIGHTS OUT',
        onContinue: () => {
          pendingStart = () => {
            endCard.remove();
            endCard = null;
            startChapter3(false);
          };
          initAudio();
          player.lock();
        },
        onMenu: () => window.location.reload(),
      });
      document.exitPointerLock();
    },
  },
});

// Chapter 3 (the grounds at 2:40 AM, then the locker room) lives in chapter3_stealth.js.
const chapter3 = new Chapter3({
  renderer,
  camera,
  player,
  world,
  director,
  stealth,
  dialogue,
  wait,
  chapter2,
  ui: {
    setObjective,
    hideObjective,
    showMessage,
    setPrompt,
    setNight,
    setFlashlight(on) {
      player.flashlightOn = on;
      handleFlashlightToggle(on);
    },
    setScene(next) {
      activeScene = next;
      next.add(camera);
      next.add(marker.mesh);
    },
    unloadOutdoors,
    disposeScene,
    onPartComplete() {
      showPartCard('CHAPTER 3 · PART 1 COMPLETE', 'PART 2 · THE LOCKER ROOM');
    },
    /** The credits have rolled: Hard Mode is unlocked for good; the end card's button goes to the menu. */
    onGameComplete(creditsEl) {
      unlockHardMode();
      Achievements.completeChapter(3); // (Hard Mode + no deaths = the flawless flag that helps unlock the Secret Chapter's Part 2)
      Achievements.completeGame(); // (game_beaten: the Secret Chapter's Part 1 unlocks)
      refreshHardToggles();
      refreshSecretMenu();
      // (keepRunning: the credits keep rolling with the mouse free to click the button)
      endCard = { remove: () => creditsEl.remove(), keepRunning: true };
      creditsEl.querySelectorAll('.credits-menu, .credits-skip').forEach((button) =>
        button.addEventListener('click', () => {
          director.endCredits();
          window.location.reload(); // back to the title screen, Hard Mode toggle and all
        }),
      );
      document.exitPointerLock();
    },
  },
});

// The Secret Chapter (Overtime): the campus in a blackout, then the boiler room. Unlocked by beating the game.
const secret = new SecretChapter({
  renderer,
  camera,
  player,
  world,
  director,
  stealth,
  dialogue,
  wait,
  ui: {
    setObjective,
    hideObjective,
    showMessage,
    setPrompt,
    setNight,
    setDawn,
    setFlashlight(on) {
      player.flashlightOn = on;
      handleFlashlightToggle(on);
    },
    setFlashlightPower(power) {
      flashlightPower = power;
      if (player.flashlightOn) flashlight.intensity = power;
    },
    setScene(next) {
      activeScene = next;
      next.add(camera);
      next.add(marker.mesh);
    },
    /** A card with a button is up: give the mouse back (the pause menu stays away: the card owns the screen). */
    onSecretCard(cardEl) {
      endCard = { remove: () => cardEl.remove() };
      document.exitPointerLock();
    },
    /** Back to the title screen (Hard Mode toggle, Hall Legend badge and all). */
    onSecretEnd() {
      window.location.reload();
    },
    /** Part 2 cleared: the permanent Hall Legend badge and the Sandbox toggle are yours. */
    onSecretComplete(cardEl) {
      endCard = { remove: () => cardEl.remove() };
      document.exitPointerLock();
    },
  },
});

/** Free everything a scene holds (geometry, materials, textures) and empty it. */
function disposeScene(s) {
  if (!s) return;
  const materials = new Set();
  s.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => materials.add(m));
    if (obj.isLight && obj.shadow && obj.shadow.map) obj.shadow.map.dispose();
  });
  materials.forEach((m) => {
    for (const key of Object.keys(m)) {
      const value = m[key];
      if (value && value.isTexture) value.dispose();
    }
    if (m.uniforms) Object.values(m.uniforms).forEach((u) => u.value && u.value.isTexture && u.value.dispose());
    m.dispose();
  });
  s.clear();
  renderer.renderLists.dispose();
}

/**
 * Inside the locker room: the school grounds, the parking lot and the bunker
 * are never coming back, so free everything they hold (geometry, materials,
 * textures) and stop updating them.
 */
let outdoorsUnloaded = false;
function unloadOutdoors() {
  if (outdoorsUnloaded) return;
  outdoorsUnloaded = true;
  disposeScene(scene);
  if (chapter2.lab) {
    disposeScene(chapter2.lab.scene);
    chapter2.lab = null;
  }
  if (chapter2.combat) {
    chapter2.combat.hud.root.remove();
    chapter2.combat = null;
  }
  renderer.renderLists.dispose();
}

/** A short title over the game (e.g. the end of Chapter 3's first part). */
function showPartCard(title, sub) {
  const card = document.createElement('div');
  card.style.cssText =
    'position:fixed;left:0;right:0;top:34%;z-index:14;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none;' +
    'font-family:"Courier New",Courier,monospace;text-align:center;opacity:0;transition:opacity 1.2s ease;';
  card.innerHTML =
    `<div style="font-size:26px;letter-spacing:9px;color:#b3413b;text-shadow:0 0 12px rgba(0,0,0,0.8);">${title}</div>` +
    `<div style="font-size:12px;letter-spacing:5px;color:rgba(217,222,227,0.7);">${sub}</div>`;
  document.body.appendChild(card);
  card.getBoundingClientRect();
  card.style.opacity = '1';
  wait(5).then(() => {
    card.style.opacity = '0';
    return wait(1.4);
  }).then(() => card.remove());
}

// Cutscenes get letterbox bars (the subtitles ride above the bottom one) and
// no crosshair / gameplay HUD in the way.
// Once the bars have slid away they're taken out of the DOM entirely (put back
// in the same place, first in the body, when the next cutscene starts).
let cinematicShown = false;
const letterboxEl = document.getElementById('letterbox');
const letterboxHome = { parent: letterboxEl.parentNode, next: letterboxEl.nextSibling };
let letterboxRemoveTimer = 0;
function updateCinematic() {
  const on = story.cutscene || chapter2.cutscene || chapter3.inCutscene || secret.inCutscene;
  if (on !== cinematicShown) {
    cinematicShown = on;
    clearTimeout(letterboxRemoveTimer);
    if (on) {
      if (!letterboxEl.isConnected) {
        const next = letterboxHome.next && letterboxHome.next.isConnected ? letterboxHome.next : letterboxHome.parent.firstChild;
        letterboxHome.parent.insertBefore(letterboxEl, next);
        letterboxEl.getBoundingClientRect(); // start from height 0 so the bars still slide in
      }
      document.body.classList.add('cinematic');
    } else {
      document.body.classList.remove('cinematic');
      letterboxRemoveTimer = setTimeout(() => {
        if (!cinematicShown) letterboxEl.remove();
      }, 600); // after the 0.45s slide-out
    }
  }
  return on;
}

// Classmates cast shadows under the classroom's on-demand shadow light. While
// any of them is still inside (and so are you), re-render it every frame so
// the shadows move with them instead of staying frozen at their desks; then
// once more after the last one leaves.
let classroomShadowsLive = false;
function updateClassroomShadows() {
  const live =
    world.classroom.dismissed &&
    player.object.position.z > L.doorZ - 1 &&
    world.npcs.students.some((s) => !s.outside);
  if (live || classroomShadowsLive) renderer.shadowMap.needsUpdate = true;
  classroomShadowsLive = live;
}

// ---------------------------------------------------------------------------
// Chapter 1 story: phases, objectives, interactions, triggers
// ---------------------------------------------------------------------------
// intro -> pack -> exit -> toTree -> meeting (cutscene) -> warmup -> stealth -> ending

const story = {
  chapter: 1,
  phase: 'intro',
  cutscene: false,
  hasShoes: false,
  hasBottle: false,
  bottleFilled: false,
  checkpoint: 0,
  checkpointsPassed: 0,
  passedFirstBend: false,
};

function refreshObjective() {
  switch (story.phase) {
    case 'pack':
      setObjective('Pack your bag & prep for XC practice.', [
        { label: 'Grab your running shoes', done: story.hasShoes },
        { label: 'Grab your water bottle', done: story.hasBottle },
        { label: 'Fill your bottle at the hallway fountain', done: story.bottleFilled },
      ]);
      break;
    case 'exit':
      setObjective('Head out the rear exit doors to XC practice.');
      break;
    case 'toTree':
      setObjective('Meet the XC team under the big oak tree.');
      break;
    case 'meeting':
      setObjective('Listen to Coach Billing.');
      break;
    case 'warmup':
      setObjective('Warm-up: jog the loop around the outer perimeter trail.', [
        { label: `Trail markers passed: ${story.checkpointsPassed}`, done: false },
      ]);
      break;
    case 'stealth':
      setObjective('Sneak past Coach Billing and reach your car in the parking lot.', [
        { label: 'Their flashlight beams catch you', tip: true },
        { label: 'They hear footsteps up close: [C] crouch to stay quiet', tip: true },
        { label: 'Jogging the practice loop blends you in', tip: true },
        { label: 'Keep your flashlight OFF', tip: true },
      ]);
      break;
    case 'ending':
      objectiveBanner.classList.add('hidden');
      break;
    default:
      break;
  }
}

function checkPackingDone() {
  if (story.phase === 'pack' && story.hasShoes && story.hasBottle && story.bottleFilled) {
    story.phase = 'exit';
    if (story.packT <= 30) Achievements.unlock('quick_change'); // shoes, bottle, fountain: all inside 30s of the bell
  }
  refreshObjective();
}

async function startChapter() {
  Achievements.startChapter(1, session);
  maxGabe.startChapter1();
  await wait(0.8);
  world.classroom.dismiss(); // classmates get up and file out to practice
  await dialogue.say('', '*BRRRRIIIIING!* The last period bell rings.', { style: 'narration', hold: 1.6 });
  if (story.phase === 'intro') story.phase = 'pack';
  story.packT = 0; // (achievements: how long packing takes, how long you sit there doing nothing)
  story.seatedT = 0;
  checkPackingDone();
}

function removeInteractable(obj) {
  const i = world.interactables.indexOf(obj);
  if (i !== -1) world.interactables.splice(i, 1);
  player.setInteractables(world.interactables);
}

function handleUse() {
  // With something under the crosshair, [E] uses it even while someone's
  // talking in passing (the line keeps playing). Nothing is targetable during
  // cutscenes, so there [E] advances the dialogue.
  const canInteract = !story.cutscene && !chapter2.cutscene && !chapter3.inCutscene && !secret.inCutscene && !player.inputLocked;
  if (story.chapter === 3 && canInteract && chapter3.onUse()) return; // stepping out of a hiding spot
  if (canInteract && player.currentTarget) {
    handleInteract(player.currentTarget);
  } else if (dialogue.active) {
    dialogue.advance();
  }
}

function handleInteract(target) {
  if (story.chapter === 2) {
    chapter2.handleInteract(target);
    return;
  }
  if (story.chapter === 3) {
    chapter3.handleInteract(target);
    return;
  }
  if (story.chapter === 4) {
    secret.handleInteract(target);
    return;
  }
  const data = target.userData;
  switch (data.type) {
    case 'pickup': {
      if (data.id === 'shoes') {
        story.hasShoes = true;
        showMessage('Grabbed your running shoes.');
      } else if (data.id === 'bottle') {
        story.hasBottle = true;
        showMessage('Grabbed your water bottle.');
      }
      scene.remove(target);
      removeInteractable(target);
      renderer.shadowMap.needsUpdate = true; // the item's shadow on the desk goes with it
      checkPackingDone();
      break;
    }
    case 'fountain': {
      if (!story.hasBottle) {
        showMessage('You need your water bottle first.');
      } else if (story.bottleFilled) {
        showMessage('Your bottle is already full.');
        story.fullTries = (story.fullTries || 0) + 1; // (a secret: you really want that water)
        if (story.fullTries >= 5) Achievements.unlock('overhydrated');
      } else {
        story.bottleFilled = true;
        showMessage('Water bottle filled. Ice cold.');
        checkPackingDone();
      }
      break;
    }
    case 'door': {
      // From outside they always open, so slipping out early behind the
      // classmates can never lock you out of the school.
      const outside = player.object.position.z < L.doorZ;
      if (!outside && (!story.hasShoes || !story.hasBottle)) {
        showMessage("You can't leave without your running shoes and water bottle.");
      } else if (!outside && !story.bottleFilled) {
        showMessage('Fill up your water bottle at the fountain first.');
      } else {
        data.doorState.open();
        data.doorState.leaves.forEach(removeInteractable);
        showMessage(outside ? 'You haul the doors back open.' : 'You shoulder the doors open. Cold, wet air rushes in.');
      }
      break;
    }
    case 'locked': {
      showMessage("Locked. Nobody's in there after last period.");
      break;
    }
    case 'car': {
      if (story.phase === 'stealth') startEnding();
      break;
    }
    case 'mg':
      maxGabe.talk(data.who);
      break;
    default:
      break;
  }
}

// ---- Objective marker targeting -------------------------------------------

const _markerPos = new THREE.Vector3();
function currentMarkerTarget() {
  if (story.chapter === 2) return chapter2.markerTarget();
  if (story.chapter === 3) return chapter3.markerTarget();
  if (story.chapter === 4) return secret.markerTarget();
  if (story.cutscene) return null;
  switch (story.phase) {
    case 'pack': {
      const items = [];
      if (!story.hasShoes) items.push(world.pickups.shoes);
      if (!story.hasBottle) items.push(world.pickups.bottle);
      if (items.length) {
        _markerPos.set(0, 0, 0);
        for (const item of items) _markerPos.add(item.position);
        _markerPos.divideScalar(items.length);
        _markerPos.y += 0.3; // the player starts seated ~0.7m away, so keep it small and low
        return { key: `desk-${items.map((i) => i.userData.id).join('+')}`, position: _markerPos, scale: 0.4 };
      }
      return { key: 'fountain', position: world.markers.fountain, scale: 0.9 };
    }
    case 'exit':
      return { key: 'door', position: world.markers.exitDoor, scale: 1 };
    case 'toTree':
      return { key: 'tree', position: world.markers.tree, scale: 3.4 };
    case 'warmup': {
      const cp = world.trail.checkpoints[story.checkpoint];
      return { key: `checkpoint-${story.checkpoint}`, position: _markerPos.set(cp.x, 2.2, cp.z), scale: 1.5 };
    }
    case 'stealth':
      return { key: 'car', position: world.markers.car, scale: 1.4 };
    default:
      return null;
  }
}

// ---- Tree meeting cutscene -------------------------------------------------

const _lookTmp = new THREE.Vector3();
const headOf = (character) => () => character.headPosition(_lookTmp);

const _benFollow = new THREE.Vector3();
function benFollowPoint() {
  // Jog at the player's left shoulder, slightly behind.
  const yaw = player.getYaw();
  const p = player.object.position;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const lx = -Math.cos(yaw);
  const lz = Math.sin(yaw);
  return _benFollow.set(p.x + lx * 1.2 - fx * 0.7, 0, p.z + lz * 1.2 - fz * 0.7);
}

async function runMeetingCutscene() {
  story.phase = 'meeting';
  story.cutscene = true;
  refreshObjective();
  const { coach, ben } = world.npcs;

  // The choreography (elevated camera, Coach pulling Ben aside) lives in cutscene.js.
  await director.playTreeMeeting({ player, dialogue, wait });

  // The whole team heads out on the loop and Ben tags along.
  story.cutscene = false;
  story.phase = 'warmup';
  story.checkpoint = 0;
  story.checkpointsPassed = 0;
  loopRunners().forEach((r, i) => {
    r.cancelExit = true;
    r.faceTowards(null);
    // Pace is re-tuned every frame by updateRunnerPacing() so the pack runs with you.
    r.jogPath(world.trail.loop, { startU: -0.004 - i * 0.012, speed: RUNNER_PACE, lateral: i % 2 ? 0.6 : -0.6 });
  });
  coach.faceTowards(world.trail.checkpoints[0]);
  ben.faceTowards(null);
  ben.follow(benFollowPoint, 8.2);
  refreshObjective();
}

/** The XC team on the loop: the runners plus any classmates who made it outside. */
function loopRunners() {
  return [...world.npcs.runners, ...world.npcs.students.filter((s) => s.outside)];
}

// ---- Per-frame story checks ------------------------------------------------

function updateStory() {
  const pos = player.object.position;

  // (The doors may already be open: classmates push through them on their way out.)
  if (story.phase === 'exit' && pos.z < L.doorZ - 1) {
    story.phase = 'toTree';
    refreshObjective();
  }
  if ((story.phase === 'pack' || story.phase === 'intro') && pos.z < L.doorZ - 1.5 && !story.warnedEarly) {
    story.warnedEarly = true;
    showMessage("You can't show up to practice without your gear. Head back inside.", 3200);
  }

  if (story.phase === 'toTree') {
    const dx = pos.x - L.meetingCenter.x;
    const dz = pos.z - L.meetingCenter.z;
    if (dx * dx + dz * dz < L.meetingRadius * L.meetingRadius) runMeetingCutscene();
  }

  if (story.phase === 'warmup') {
    const cp = world.trail.checkpoints[story.checkpoint];
    const dx = pos.x - cp.x;
    const dz = pos.z - cp.z;
    if (dx * dx + dz * dz < 5.5 * 5.5) {
      const passed = story.checkpoint;
      story.checkpointsPassed++;
      story.checkpoint = (passed + 1) % world.trail.checkpoints.length;
      refreshObjective();
      if (passed === world.trail.firstBendIndex && !story.passedFirstBend) {
        story.passedFirstBend = true;
        startSkipPlan(); // Phase 3 begins just past the first bend
      }
    }
  }
}

// ---- Runner pacing: keep the pack running just ahead of the player ----------

const RUNNER_PACE = 4.9; // m/s: a real run, faster than the player's 4.2 walk
const loopSamples = world.trail.loop.getSpacedPoints(240);

function playerLoopU() {
  const p = player.object.position;
  let best = Infinity;
  let index = 0;
  for (let i = 0; i < loopSamples.length - 1; i++) {
    const d = (loopSamples[i].x - p.x) ** 2 + (loopSamples[i].z - p.z) ** 2;
    if (d < best) {
      best = d;
      index = i;
    }
  }
  return index / (loopSamples.length - 1);
}

function updateRunnerPacing() {
  if (story.phase !== 'warmup') return;
  const pu = playerLoopU();
  loopRunners().forEach((r, i) => {
    if (r.pathU === null) return;
    let du = r.pathU - pu;
    du -= Math.round(du); // wrap to [-0.5, 0.5]
    const lead = du * world.trail.loopLength; // meters ahead of the player
    const desiredLead = 3 + i * 2.2; // a spread-out pack just in front of you
    // Never below 3.6 m/s: that's where the gait is fully blended into a run.
    r.setPathSpeed(THREE.MathUtils.clamp(RUNNER_PACE + (desiredLead - lead) * 0.18, 3.6, 6.8));
  });
}

// ---- Phase 3: the lazy skip + stealth escape --------------------------------

function enableCarInteraction() {
  if (!world.interactables.includes(world.playersCarHitbox)) {
    world.interactables.push(world.playersCarHitbox);
    player.setInteractables(world.interactables);
  }
}

async function startSkipPlan() {
  story.phase = 'stealth';
  await dialogue.say('Other Ben', "Screw this rain, let's cut back through the school grounds and sneak to the car.");
  refreshObjective();
  showMessage('Checkpoint: behind the equipment shed.');
  enableCarInteraction();
  // The rest of the team keeps running the loop; all three coaches click on flashlights.
  loopRunners().forEach((r, i) => r.setPathSpeed(RUNNER_PACE - 0.3 + (i % 5) * 0.12));
  stealth.start();
}

async function runCaughtSequence(guard) {
  const { ben } = world.npcs;
  Achievements.death(); // (Ghost Runner and the flawless flag are gone)
  story.cutscene = true;
  player.setInputLocked(true);
  player.crouching = false;
  player.setLookTarget(headOf(guard.coach));
  dialogue.say(guard.name, guard.callout, { hold: 1.2 });
  await Promise.race([stealth.tackled(), wait(2.2)]);
  await director.fader.to(1, 0.35);
  dialogue.finish();

  // Retry from behind the shed.
  const cp = world.stealth.checkpoint;
  player.setLookTarget(null);
  player.teleport(cp.position, cp.yaw);
  ben.mesh.position.set(cp.position.x - 0.6, 0, cp.position.z + 1.3);
  ben.follow(benFollowPoint, 8.2);
  stealth.resetForRetry();
  await wait(0.7);
  await director.fader.to(0, 0.6);
  player.setInputLocked(false);
  story.cutscene = false;
  showMessage('Caught! Back behind the shed. Stay low and out of his light.', 3200);
}

// ---- Phase 4: the car escape + climax ---------------------------------------

async function startEnding() {
  story.phase = 'ending';
  story.cutscene = true;
  refreshObjective();
  setPrompt(null);
  clearTimeout(toastHideTimer);
  messageToast.classList.remove('visible');
  messageToast.classList.add('hidden');
  await director.playEnding({ player, stealth, dialogue, wait });
  Achievements.unlock('cut_practice');
  Achievements.completeChapter(1);
  if (session === 'chapter1') {
    // Chapter Select run: end card (continue into Chapter 2, or back to the menu).
    showChapter1EndCard();
    document.exitPointerLock();
  } else {
    startChapter2(); // Play: straight on into Chapter 2 from the black screen
  }
}

// ---- Chapter 2 ----------------------------------------------------------------

function startChapter2() {
  story.chapter = 2;
  story.phase = 'chapter2';
  story.cutscene = false;
  setPrompt(null);
  Achievements.startChapter(2, session);
  chapter2.start();
}

// ---- Chapter 3 ----------------------------------------------------------------

function startChapter3(fromChapter2 = false) {
  maxGabe.hide();
  story.chapter = 3;
  story.phase = 'chapter3';
  story.cutscene = false;
  setLowHealth(0); // (Chapter 2's fight is over: no heartbeat, no ducked mix carried over)
  Achievements.startChapter(3, session);
  chapter2.cutscene = false; // its ending hands straight over; don't let its letterbox linger
  dialogue.finish();
  setPrompt(null);
  chapter3.start({ fromChapter2 });
}

// ---- The Secret Chapter (Overtime) ---------------------------------------------

function startSecret(part) {
  maxGabe.hide();
  story.chapter = 4;
  story.phase = 'secret';
  story.cutscene = false;
  setLowHealth(0);
  setPrompt(null);
  dialogue.finish();
  secret.start({ part });
}

function showChapter1EndCard() {
  endCard = showChapterComplete({
    onContinue: () => {
      pendingStart = () => {
        endCard.remove();
        endCard = null;
        startChapter2();
      };
      initAudio();
      player.lock();
    },
    onMenu: () => window.location.reload(),
  });
}

// ---------------------------------------------------------------------------
// Title screen (Play / Chapter Select) + pause menu -> pointer lock
// ---------------------------------------------------------------------------
// Note: PointerLockControls dispatches 'lock' *before* it sets isLocked = true,
// so these handlers drive state from the event rather than reading isLocked.

let paused = true;
let pauseMenuUp = false; // paused mid-game behind the pause menu (the frozen frame isn't redrawn)
let pauseFrameDrawn = false;
let pendingStart = null; // runs once the pointer locks: starts the chosen chapter
let endCard = null; // a chapter's end card (Chapter Select runs only)
// 'play' runs Chapter 1 -> 2 -> 3 straight through; 'chapter1' / 'chapter2' / 'chapter3' come from Chapter Select
// ('secret1' / 'secret2': the Secret Chapter's parts).
let session = 'play';
const secretMenu = document.getElementById('secret-menu');
const settingsMenu = document.getElementById('settings-menu');
const settingsPanel = document.getElementById('settings-panel');
const quitBtn = document.getElementById('quit-btn');

function showMenu(which) {
  mainMenu.classList.toggle('hidden', which !== 'main');
  chapterMenu.classList.toggle('hidden', which !== 'chapters');
  secretMenu.classList.toggle('hidden', which !== 'secret');
  pauseMenu.classList.toggle('hidden', which !== 'pause');
  settingsMenu.classList.toggle('hidden', which !== 'settings');
  // One settings panel: in the pause menu, or on its own page off the title screen.
  if (which === 'settings') settingsMenu.insertBefore(settingsPanel, settingsMenu.firstChild);
  else if (which === 'pause') pauseMenu.insertBefore(settingsPanel, quitBtn);
}

// ---------------------------------------------------------------------------
// Settings (kept in localStorage): mouse sensitivity, master volume, head bob
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'lastbell.settings';
const settings = { sensitivity: 1, volume: 0.8, headBob: true };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    if (Number.isFinite(saved.sensitivity)) settings.sensitivity = THREE.MathUtils.clamp(saved.sensitivity, 0.2, 3);
    if (Number.isFinite(saved.volume)) settings.volume = THREE.MathUtils.clamp(saved.volume, 0, 1);
    if (typeof saved.headBob === 'boolean') settings.headBob = saved.headBob;
  }
} catch {
  // (private mode / corrupt entry: the defaults stand)
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // (storage unavailable: they just won't persist)
  }
}

const sensSlider = document.getElementById('sens-slider');
const sensValue = document.getElementById('sens-value');
const volSlider = document.getElementById('vol-slider');
const volValue = document.getElementById('vol-value');
const bobToggle = document.getElementById('bob-toggle');
const fullscreenBtn = document.getElementById('fullscreen-btn');

function applySettings() {
  player.setSensitivity(settings.sensitivity);
  player.headBob = settings.headBob;
  setMasterVolume(settings.volume);
  sensSlider.value = String(settings.sensitivity);
  sensValue.textContent = `${settings.sensitivity.toFixed(2)}x`;
  volSlider.value = String(settings.volume);
  volValue.textContent = `${Math.round(settings.volume * 100)}%`;
  bobToggle.textContent = `HEAD BOB: ${settings.headBob ? 'ON' : 'OFF'}`;
  bobToggle.classList.toggle('setting-on', settings.headBob);
}
sensSlider.addEventListener('input', () => {
  settings.sensitivity = THREE.MathUtils.clamp(Number(sensSlider.value) || 1, 0.2, 3);
  applySettings();
  saveSettings();
});
volSlider.addEventListener('input', () => {
  settings.volume = THREE.MathUtils.clamp(Number(volSlider.value), 0, 1);
  applySettings();
  saveSettings();
});
bobToggle.addEventListener('click', () => {
  settings.headBob = !settings.headBob;
  applySettings();
  saveSettings();
});

function refreshFullscreen() {
  const on = !!document.fullscreenElement;
  fullscreenBtn.textContent = `FULLSCREEN: ${on ? 'ON' : 'OFF'}`;
  fullscreenBtn.classList.toggle('setting-on', on);
}
fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {
      lockError.textContent = "Fullscreen isn't available here.";
    });
  }
});
document.addEventListener('fullscreenchange', refreshFullscreen);
applySettings();
refreshFullscreen();
document.getElementById('settings-btn').addEventListener('click', () => showMenu('settings'));
document.getElementById('settings-back').addEventListener('click', () => showMenu('main'));

function handleLockError() {
  lockError.textContent = "Couldn't capture the mouse. Wait a moment and click again.";
}
document.addEventListener('pointerlockerror', handleLockError);

function beginSession(mode, start) {
  session = mode;
  pendingStart = start;
  initAudio(); // user gesture: allowed to start Web Audio here
  player.lock();
}

document.getElementById('play-btn').addEventListener('click', () => beginSession('play', startChapter));
document.getElementById('chapters-btn').addEventListener('click', () => showMenu('chapters'));
document.getElementById('chapters-back').addEventListener('click', () => showMenu('main'));
document.querySelectorAll('.chapter-btn[data-chapter]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.chapter === '3') beginSession('chapter3', () => startChapter3(false));
    else if (button.dataset.chapter === '2') beginSession('chapter2', startChapter2);
    else beginSession('chapter1', startChapter);
  });
});

// The Secret Chapter card: locked until you beat the game; once Part 2 is unlocked too it gets a shimmering
// gold border and asks which part you want.
const secretBtn = document.getElementById('secret-btn');
const secretNote = document.getElementById('secret-note');
const legendBadge = document.getElementById('legend-badge');
function refreshSecretMenu() {
  const one = isPartOneUnlocked();
  const two = isPartTwoUnlocked();
  secretBtn.classList.toggle('locked', !one && !two);
  secretBtn.classList.toggle('gold', two);
  // Any chapter cleared on Hard Mode without dying turns gold.
  document.querySelectorAll('.chapter-btn[data-chapter]').forEach((b) => b.classList.toggle('gold', isFlawless(Number(b.dataset.chapter))));
  document.querySelectorAll('[data-secret]').forEach((b) => b.classList.toggle('gold', isPartFlawless(Number(b.dataset.secret))));
  secretNote.textContent = two ? 'PART 2 UNLOCKED' : one ? 'PART 1 · PART 2 LOCKED' : 'LOCKED · BEAT THE GAME';
  legendBadge.classList.toggle('hidden', !hasHallLegend());
  refreshSandboxToggles();
}
secretBtn.addEventListener('click', () => {
  if (!isPartOneUnlocked() && !isPartTwoUnlocked()) {
    lockError.textContent = 'The Secret Chapter unlocks once you beat the game.';
    return;
  }
  lockError.textContent = '';
  if (isPartTwoUnlocked()) showMenu('secret');
  else beginSession('secret1', () => startSecret(1));
});
document.querySelectorAll('[data-secret]').forEach((button) => {
  button.addEventListener('click', () => {
    const part = Number(button.dataset.secret);
    beginSession(`secret${part}`, () => startSecret(part));
  });
});
document.getElementById('secret-back').addEventListener('click', () => showMenu('chapters'));

// Sandbox (Infinite Ammo): the Hall Legend reward, toggled from the main menu or Chapter Select.
const sandboxToggles = document.querySelectorAll('[data-sandbox-toggle]');
function refreshSandboxToggles() {
  const unlocked = isSandboxUnlocked();
  sandboxToggles.forEach((b) => {
    b.classList.toggle('hidden', !unlocked);
    b.classList.toggle('sandbox-on', sandbox.infiniteAmmo);
    b.textContent = `SANDBOX: INFINITE AMMO + GOD MODE ${sandbox.infiniteAmmo ? 'ON' : 'OFF'}`;
  });
}
sandboxToggles.forEach((b) =>
  b.addEventListener('click', () => {
    setSandbox(!sandbox.infiniteAmmo);
    refreshSandboxToggles();
  }),
);
Achievements.init({ button: document.getElementById('achievements-btn') });
document.getElementById('resume-btn').addEventListener('click', () => {
  initAudio();
  player.lock();
});

// Hard Mode: unlocked by finishing the game; toggled from the main menu or Chapter Select.
const hardToggles = document.querySelectorAll('[data-hard-toggle]');
function refreshHardToggles() {
  const unlocked = isHardUnlocked();
  hardToggles.forEach((b) => {
    b.classList.toggle('hidden', !unlocked);
    b.classList.toggle('hard-on', difficulty.hard);
    b.textContent = `HARD MODE: ${difficulty.hard ? 'ON' : 'OFF'}`;
  });
}
hardToggles.forEach((b) =>
  b.addEventListener('click', () => {
    setHardMode(!difficulty.hard);
    refreshHardToggles();
  }),
);
refreshHardToggles();
refreshSecretMenu();

// A secret: typing "billing" on the title screen (no mistakes) unlocks Hard Mode.
const CHEAT = 'billing';
let cheatTyped = '';
document.addEventListener('keydown', (e) => {
  const onTitle = !startOverlay.classList.contains('hidden') && !mainMenu.classList.contains('hidden') && menuSubtitle.classList.contains('hidden');
  if (!onTitle || e.repeat) {
    cheatTyped = '';
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : '';
  cheatTyped = key === CHEAT[cheatTyped.length] ? cheatTyped + key : key === CHEAT[0] ? key : '';
  if (cheatTyped === CHEAT) {
    cheatTyped = '';
    // Already have everything? Typing it again wipes all progress and reloads to the original state.
    if (isHardUnlocked() && isPartTwoUnlocked() && hasHallLegend() && isPartFlawless(1) && isPartFlawless(2) && Achievements.count >= Achievements.total) {
      resetAllProgress();
      Achievements.resetAll();
      initAudio();
      playBeep(440, 0.1, 0.1);
      lockError.textContent = 'ALL PROGRESS RESET';
      setTimeout(() => window.location.reload(), 600);
      return;
    }
    // Everything: Hard Mode, Secret Chapter parts 1 and 2, Hall Legend + sandbox, every achievement.
    unlockHardMode();
    markGameBeaten();
    [1, 2, 3].forEach(markFlawless);
    [1, 2].forEach(markPartFlawless);
    grantHallLegend();
    Achievements.unlockAll();
    refreshHardToggles();
    refreshSandboxToggles();
    refreshSecretMenu();
    initAudio();
    playBeep(880, 0.08, 0.1);
    setTimeout(() => playBeep(1320, 0.12, 0.1), 110);
    lockError.textContent = 'EVERYTHING UNLOCKED';
  }
});
document.getElementById('quit-btn').addEventListener('click', () => window.location.reload());

player.controls.addEventListener('lock', () => {
  paused = false;
  pauseMenuUp = false;
  setAudioPaused(false);
  lockError.textContent = '';
  startOverlay.classList.add('hidden');
  startOverlay.classList.remove('paused');
  if (pendingStart) {
    const start = pendingStart;
    pendingStart = null;
    start();
  }
});
player.controls.addEventListener('unlock', enterPause);

/**
 * [Esc], a dropped pointer lock, or the window losing focus: the game loop and
 * every sound stop, and the pause menu comes up over the frozen, dimmed frame.
 */
function enterPause() {
  if (endCard && endCard.keepRunning) return; // the credits roll on
  paused = true;
  setAudioPaused(true); // rain, music, everything stops with the game
  if (endCard) return; // the end card owns the screen now
  menuSubtitle.textContent = `PAUSED · ${story.chapter === 4 ? 'SECRET CHAPTER' : `CHAPTER ${story.chapter}`}${difficulty.hard ? ' · HARD MODE' : ''}`;
  menuSubtitle.classList.remove('hidden');
  showMenu('pause');
  startOverlay.classList.add('paused');
  startOverlay.classList.remove('hidden');
  pauseMenuUp = true;
  pauseFrameDrawn = false;
}

// Alt-tab, clicking another window, switching tabs: pause instead of dying off-screen.
function pauseOnFocusLoss() {
  if (paused || (endCard && endCard.keepRunning)) return;
  if (document.pointerLockElement) document.exitPointerLock(); // -> 'unlock' -> enterPause
  else enterPause(); // (the lock's already gone: pause right here)
}
window.addEventListener('blur', pauseOnFocusLoss);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseOnFocusLoss();
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  pauseFrameDrawn = false; // (paused: redraw the frozen frame at the new size)
  if (chapter2.combat) chapter2.combat.resize(camera.aspect);
  if (chapter3.gym && chapter3.gym.combat) chapter3.gym.combat.resize(camera.aspect);
  if (secret.combat) secret.combat.resize(camera.aspect);
});

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

// ---------------------------------------------------------------------------
// Frame pacing: dynamic resolution
// ---------------------------------------------------------------------------
// The heaviest scenes (a dozen ELDARs and a hail of bolts under a dozen lights)
// are fill-rate bound on laptop GPUs. When the frame rate sags for a couple of
// seconds, render at a lower pixel ratio; creep back up once there's headroom
// (but not straight back to a level that was just too slow).
const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);
const MIN_PIXEL_RATIO = Math.min(0.7, MAX_PIXEL_RATIO);
// A ratio that just proved too slow becomes a ceiling for a couple of minutes: creeping straight
// back up to it only dropped the frame rate again (a stutter, and a resize hitch, every ~20s while
// you stood in a heavy view, like the lab's pod corridor looking into the chamber).
const pacing = { ratio: MAX_PIXEL_RATIO, avg: 1 / 60, slow: 0, fast: 0, holdUp: 0, cap: MAX_PIXEL_RATIO, capT: 0 };
function updatePacing(rawDt) {
  if (paused || rawDt <= 0 || rawDt > 0.25) return; // menus, tab switches, loading hitches: not the GPU
  pacing.avg += (rawDt - pacing.avg) * 0.06;
  pacing.holdUp = Math.max(0, pacing.holdUp - rawDt);
  if (pacing.capT > 0) {
    pacing.capT -= rawDt;
    if (pacing.capT <= 0) pacing.cap = MAX_PIXEL_RATIO;
  }
  if (pacing.avg > 1 / 45) {
    pacing.slow += rawDt;
    pacing.fast = 0;
  } else if (pacing.avg < 1 / 57) {
    pacing.fast += rawDt;
    pacing.slow = 0;
  } else {
    pacing.slow = 0;
    pacing.fast = 0;
  }
  let next = pacing.ratio;
  const ceiling = Math.min(MAX_PIXEL_RATIO, pacing.cap);
  if (pacing.slow > 1.5 && pacing.ratio > MIN_PIXEL_RATIO) {
    next = Math.max(MIN_PIXEL_RATIO, pacing.ratio - 0.15);
    pacing.holdUp = 20;
    pacing.cap = pacing.ratio - 0.01; // (this one was too slow: don't come straight back to it)
    pacing.capT = 120;
  } else if (pacing.fast > 6 && pacing.holdUp <= 0 && pacing.ratio + 0.05 < ceiling) {
    next = Math.min(ceiling, pacing.ratio + 0.1);
  }
  if (next !== pacing.ratio) {
    pacing.ratio = next;
    pacing.slow = 0;
    pacing.fast = 0;
    renderer.setPixelRatio(next);
  }
}

function tick(dt) {
  // A landed punch: the whole world holds still for a couple of frames (the view keeps its kick).
  const held = !paused && hitstop.frames > 0;
  if (held) hitstop.frames--;
  if (!paused && !held) {
    updateTimers(dt);
    dialogue.update(dt);
    player.update(dt);
    if (story.chapter === 1) {
      updateRunnerPacing();
      // Other Ben ducks when you do.
      world.npcs.ben.mesh.userData.rig.crouch = story.phase === 'stealth' && player.isCrouching;
      for (const u of world.updatables) u.update(dt);
      maxGabe.update(dt, story.phase);
      stealth.update(dt, {
        flashlightOn: player.flashlightOn,
        sprinting: player.isSprinting,
        crouching: player.isCrouching,
        moving: player.isMoving,
      });
    } else if (story.chapter === 2) {
      chapter2.update(dt); // the surface at night, then the lab once you're underground
    } else if (story.chapter === 4) {
      secret.update(dt); // the blackout campus, then the boiler room
    } else {
      chapter3.update(dt); // the grounds at 2:40 AM, then the locker room
    }
    director.update(dt);
    if (story.chapter === 1) {
      updateStory();
      updateClassroomShadows();
      updateAchievementClocks(dt);
    }
    if (activeScene === scene && !outdoorsUnloaded) {
      // Inside = within the main building's footprint (Chapters 2 and 3 never go in there).
      // Past its side walls (the west wing, the lot) you're outdoors even north of the rear doors.
      const p = player.object.position;
      const outside = story.chapter > 1 || p.z < L.doorZ - 0.3 || Math.abs(p.x) > 12.4;
      updateLightingZones(dt, outside);
    }
    marker.update(dt, currentMarkerTarget());
  }
  const cinematic = updateCinematic();
  // Paused behind the menu, the frozen frame is already on screen: draw it once, not 60 times a second.
  if (paused && pauseMenuUp) {
    if (pauseFrameDrawn) return;
    pauseFrameDrawn = true;
  }
  renderer.render(activeScene, camera);
  // Chapter 2's rifle: its own pass over the world (hidden during cutscenes, gone after Chapter 2).
  if (story.chapter === 2 && chapter2.combat) chapter2.combat.renderViewmodel(renderer, !cinematic && activeScene !== scene);
  // Chapter 3's gym: the rifle (phases 2-4), then your fists.
  else if (story.chapter === 3 && chapter3.gym && chapter3.gym.combat) chapter3.gym.combat.renderViewmodel(renderer, !cinematic);
  // The Secret Chapter's Part 2: the rifle, then your fists.
  else if (story.chapter === 4 && secret.combat) secret.combat.renderViewmodel(renderer, !cinematic);
}

/** Chapter 1's clocks the achievements read: how fast you pack, how long you sit there, how long you blend in. */
function updateAchievementClocks(dt) {
  if (story.phase === 'pack') {
    story.packT = (story.packT || 0) + dt;
    story.seatedT = player.seated ? (story.seatedT || 0) + dt : 0;
    if (story.seatedT >= 60) Achievements.unlock('detention'); // a secret: a whole minute in your seat after the bell
  } else if (story.phase === 'stealth' && stealth.playerSafe) {
    story.safeT = (story.safeT || 0) + dt;
    if (story.safeT >= 15) Achievements.unlock('team_spirit');
  }
}

function animate() {
  requestAnimationFrame(animate);
  const raw = clock.getDelta();
  updatePacing(raw);
  tick(Math.min(raw, 0.1));
}

animate();

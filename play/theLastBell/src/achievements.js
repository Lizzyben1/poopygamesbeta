import { playAchievement } from './audio.js';
import { difficulty, sandbox, markFlawless, markGameBeaten } from './difficulty.js';

/*
 * Achievements: 26 of them, remembered in this browser (localStorage).
 *
 *   Achievements.unlock(id)   new? saves it, slides a glassmorphic toast in at the top right of the
 *                             screen with a chime, holds it 4 seconds, and slides it back out.
 *   Achievements.bump(stat)   a persistent counter ("20 headshot kills"); unlocks at its threshold.
 *   Achievements.startChapter / death / damage / completeChapter / completeGame
 *                             the run tracker: flawless runs, single-life runs, Hard Mode runs. It
 *                             also sets the Hard Mode "flawless" flags that unlock the Secret
 *                             Chapter's Part 2 (hard_flawless_ch1..3).
 *   Achievements.openMenu()   the scrollable gallery on the title screen (Unlocked: X / 26).
 *
 * Every hook lives where the thing actually happens (player.js / combat.js damage, the chapters'
 * capture and death handlers, the props in world.js's chapters, secret_chapter.js): this file only
 * knows the roster and the rules.
 */

const KEY = 'lastbell.achievements';
const KEY_STATS = 'lastbell.stats';
const HOLD_MS = 4000; // the toast stays this long
const SLIDE_MS = 600;

export const GROUPS = [
  { id: 'progress', title: 'CORE PROGRESSION' },
  { id: 'skill', title: 'SKILL & CHALLENGE' },
  { id: 'explore', title: 'EXPLORATION & PLAYSTYLE' },
  { id: 'secret', title: 'SECRET' },
];

export const ACHIEVEMENTS = [
  // ---- Core progression (7) ------------------------------------------------------
  { id: 'cut_practice', group: 'progress', icon: '🚗', title: 'Cut Practice', desc: 'Skip the run, dodge the coaches and reach the car. (Chapter 1)' },
  { id: 'strike_three', group: 'progress', icon: '⚡', title: 'Strike Three', desc: 'Defeat the ELDAR Titan. (Chapter 2)' },
  { id: 'inside_job', group: 'progress', icon: '🚪', title: 'Inside Job', desc: 'Slip into the school through the locker room door. (Chapter 3)' },
  { id: 'game_day', group: 'progress', icon: '🤖', title: 'Game Day', desc: 'Destroy Mecha Billing in the gym. (Chapter 3)' },
  { id: 'practice_cancelled', group: 'progress', icon: '🕺', title: 'Practice Is Cancelled', desc: 'Beat the game and watch the credits.' },
  { id: 'overtime', group: 'progress', icon: '🔥', title: 'Overtime', desc: 'Track Other Ben down to the boiler room. (Secret Chapter, Part 1)' },
  { id: 'hall_legend', group: 'progress', icon: '🏅', title: 'Hall Legend', desc: 'Survive Sudden Death and take down Billing Reconstructed. (Secret Chapter, Part 2)' },

  // ---- Skill & challenge (11) --------------------------------------------------------
  { id: 'ghost_runner', group: 'skill', icon: '👻', title: 'Ghost Runner', desc: 'Beat Chapter 1 without ever getting caught.' },
  { id: 'untouchable', group: 'skill', icon: '🛡️', title: 'Untouchable', desc: 'Beat Chapter 2 without taking a single point of damage.' },
  { id: 'shadow_walker', group: 'skill', icon: '🌑', title: 'Shadow Walker', desc: 'Reach the gym without a coach or ELDAR ever spotting you. (Chapter 3)' },
  { id: 'one_life', group: 'skill', icon: '💯', title: 'One and Done', desc: 'Beat Chapters 1-3 in a single run without dying once.' },
  { id: 'hard_hero', group: 'skill', icon: '💀', title: 'Hard as Nails', desc: 'Beat the entire game on Hard Mode.' },
  { id: 'headhunter', group: 'skill', icon: '🎯', title: 'Headhunter', desc: 'Destroy 20 ELDARs with headshots.' },
  { id: 'skeet_shooter', group: 'skill', icon: '🚀', title: 'Skeet Shooter', desc: "Shoot down 5 of the Mecha's missiles." },
  { id: 'counter_puncher', group: 'skill', icon: '🥊', title: 'Counter Puncher', desc: 'Land 10 counter-punches on Coach Billing.' },
  { id: 'houdini', group: 'skill', icon: '🔓', title: 'Houdini', desc: "Break out of an ELDAR sentry's grip in under 1.5 seconds." },
  { id: 'vent_sniper', group: 'skill', icon: '🔧', title: 'Vent Sniper', desc: "Destroy all three of Billing's spine vents with 40 rounds or fewer. (Secret Chapter)" },
  { id: 'parry_master', group: 'skill', icon: '⚔️', title: 'Parry Master', desc: "Parry five of Billing's punches in a row without being hit. (Secret Chapter)" },

  // ---- Exploration & playstyle (5) -----------------------------------------------------
  { id: 'locker_legend', group: 'explore', icon: '🗄️', title: 'Locker Legend', desc: 'Hide in three different lockers.' },
  { id: 'dumpster_diver', group: 'explore', icon: '🗑️', title: 'Dumpster Diver', desc: 'Hide in both a dumpster and a shed on the school grounds.' },
  { id: 'blind_faith', group: 'explore', icon: '🔦', title: 'Blind Faith', desc: 'Reach the gym without ever switching your flashlight on. (Chapter 3)' },
  { id: 'quick_change', group: 'explore', icon: '👟', title: 'Quick Change', desc: 'Grab your shoes and bottle and fill it at the fountain within 30 seconds of the bell.' },
  { id: 'team_spirit', group: 'explore', icon: '🏃', title: 'Team Spirit', desc: 'Blend in with the team on the practice loop for 15 seconds during the stealth escape. (Chapter 1)' },

  // ---- Secret (3): hidden as ??? until they unlock ------------------------------------
  { id: 'detention', group: 'secret', secret: true, icon: '😴', title: 'Detention', desc: 'Stay in your seat for a full minute after the final bell.' },
  { id: 'overhydrated', group: 'secret', secret: true, icon: '💧', title: 'Overhydrated', desc: 'Try to fill an already full water bottle five times.' },
  { id: 'plot_armor', group: 'secret', secret: true, icon: '🎮', title: 'Plot Armor Sold Separately', desc: 'Talk to Max and Gabe every single time they show up.' },
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Persistent counters -> [threshold, achievement]. */
const STAT_UNLOCKS = {
  headKills: [20, 'headhunter'],
  missilesShot: [5, 'skeet_shooter'],
  counters: [10, 'counter_puncher'],
};

// ---------------------------------------------------------------------------
// Storage (what was written this session wins, so blocked storage still works until reload)
// ---------------------------------------------------------------------------

let memory = null;
let statMemory = null;

function load(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function save(key, data) {
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // (private window / blocked storage: it just won't persist)
  }
}

function unlocked() {
  if (!memory) memory = load(KEY);
  return memory;
}

function stats() {
  if (!statMemory) statMemory = load(KEY_STATS);
  return statMemory;
}

// ---------------------------------------------------------------------------
// The run tracker
// ---------------------------------------------------------------------------

const run = {
  chapter: 0, // the base-game chapter being played (0 = none)
  session: 'play', // 'play' = Chapters 1 -> 3 in one go; 'chapterN' = from Chapter Select
  deaths: 0, // this chapter
  damage: 0, // hit points lost this chapter
  sessionDeaths: 0, // this whole Play run
  flags: {},
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastHost = null;

function ensureToastHost() {
  if (toastHost && toastHost.isConnected) return toastHost;
  toastHost = document.createElement('div');
  toastHost.id = 'ach-toasts';
  document.body.appendChild(toastHost);
  return toastHost;
}

function showToast(def) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'ach-toast';
  el.innerHTML =
    `<div class="ach-toast-icon">${def.icon}</div>` +
    '<div class="ach-toast-text">' +
    '<div class="ach-toast-kicker">ACHIEVEMENT UNLOCKED</div>' +
    `<div class="ach-toast-title">${def.title}</div>` +
    `<div class="ach-toast-desc">${def.desc}</div>` +
    '</div>';
  host.appendChild(el);
  el.getBoundingClientRect(); // commit the off-screen start so the slide-in runs
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show'); // slides back out
    setTimeout(() => el.remove(), SLIDE_MS + 50);
  }, HOLD_MS + SLIDE_MS);
}

// ---------------------------------------------------------------------------
// The gallery (title screen)
// ---------------------------------------------------------------------------

let overlay = null;
let listEl = null;
let countEl = null;
let barEl = null;

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'ach-overlay';
  overlay.className = 'hidden';
  overlay.innerHTML =
    '<div class="ach-panel">' +
    '<button class="ach-close" aria-label="Close">&times;</button>' +
    '<h2>ACHIEVEMENTS</h2>' +
    '<div class="ach-count"></div>' +
    '<div class="ach-bar"><div></div></div>' +
    '<div class="ach-list"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  listEl = overlay.querySelector('.ach-list');
  countEl = overlay.querySelector('.ach-count');
  barEl = overlay.querySelector('.ach-bar div');
  overlay.querySelector('.ach-close').addEventListener('click', () => Achievements.closeMenu());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) Achievements.closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !overlay.classList.contains('hidden')) Achievements.closeMenu();
  });
}

function renderGallery() {
  const got = unlocked();
  const total = ACHIEVEMENTS.length;
  const count = ACHIEVEMENTS.filter((a) => got[a.id]).length;
  countEl.textContent = `Unlocked: ${count} / ${total}`;
  barEl.style.width = `${(count / total) * 100}%`;
  listEl.replaceChildren();
  for (const group of GROUPS) {
    const items = ACHIEVEMENTS.filter((a) => a.group === group.id);
    const head = document.createElement('div');
    head.className = 'ach-group';
    head.textContent = `${group.title}  ${items.filter((a) => got[a.id]).length}/${items.length}`;
    listEl.appendChild(head);
    for (const a of items) {
      const isOn = !!got[a.id];
      const hidden = a.secret && !isOn;
      const card = document.createElement('div');
      card.className = `ach-card${isOn ? ' on' : ''}${hidden ? ' secret' : ''}`;
      card.innerHTML =
        `<div class="ach-card-icon">${hidden ? '❓' : a.icon}</div>` +
        '<div class="ach-card-text">' +
        `<div class="ach-card-title">${hidden ? '???' : a.title}</div>` +
        `<div class="ach-card-desc">${hidden ? 'Secret achievement. Keep playing to discover.' : a.desc}</div>` +
        '</div>' +
        `<div class="ach-card-state">${isOn ? '✔' : '🔒'}</div>`;
      listEl.appendChild(card);
    }
  }
}

// ---------------------------------------------------------------------------
// The public API
// ---------------------------------------------------------------------------

export const Achievements = {
  total: ACHIEVEMENTS.length,
  run,

  /** Build the toast host and the gallery, and wire the title screen's button. */
  init({ button = null } = {}) {
    ensureToastHost();
    if (!overlay) buildOverlay();
    if (button) button.addEventListener('click', () => Achievements.openMenu());
  },

  get count() {
    const got = unlocked();
    return ACHIEVEMENTS.filter((a) => got[a.id]).length;
  },

  has(id) {
    return !!unlocked()[id];
  },

  /** Unlock `id` (once): saved, then a toast + chime. Returns true if it was new. */
  unlock(id) {
    const def = BY_ID.get(id);
    if (!def) {
      console.warn(`Unknown achievement: ${id}`);
      return false;
    }
    const got = unlocked();
    if (got[id]) return false;
    got[id] = Date.now();
    save(KEY, got);
    showToast(def);
    playAchievement();
    if (overlay && !overlay.classList.contains('hidden')) renderGallery();
    return true;
  },

  // ---- Persistent counters -----------------------------------------------------------

  /** Add to a lifetime counter; the achievement tied to it unlocks at its threshold. Returns the new total. */
  bump(stat, n = 1) {
    const s = stats();
    s[stat] = (s[stat] || 0) + n;
    save(KEY_STATS, s);
    const rule = STAT_UNLOCKS[stat];
    if (rule && s[stat] >= rule[0]) Achievements.unlock(rule[1]);
    return s[stat];
  },

  counter(stat) {
    return stats()[stat] || 0;
  },

  // ---- Per-run flags (a chapter's playstyle conditions) -----------------------------------

  flag(name, value = true) {
    run.flags[name] = value;
  },

  flagged(name) {
    return !!run.flags[name];
  },

  /** Count something in this chapter's run (returns the new count). */
  tally(name, n = 1) {
    run.flags[name] = (run.flags[name] || 0) + n;
    return run.flags[name];
  },

  // ---- The run tracker ----------------------------------------------------------------------

  /** A base-game chapter begins (session: 'play' for the straight-through run, or 'chapterN' from Chapter Select). */
  startChapter(chapter, session) {
    run.chapter = chapter;
    run.session = session;
    run.deaths = 0;
    run.damage = 0;
    run.flags = {};
    if (chapter === 1 && session === 'play') run.sessionDeaths = 0;
  },

  /** Caught, or went down: this chapter isn't flawless any more. */
  death() {
    run.deaths++;
    run.sessionDeaths++;
  },

  /** Hit points lost (player.js reports every point of combat damage here). */
  damage(amount) {
    run.damage += amount;
  },

  /**
   * A chapter is done. On Hard Mode with no deaths it earns that chapter's flawless flag (all three
   * unlock the Secret Chapter's Part 2), and the chapter's own flawless achievement is judged here.
   */
  completeChapter(chapter) {
    const flawless = run.deaths === 0;
    if (flawless && difficulty.hard && !sandbox.infiniteAmmo) markFlawless(chapter);
    if (chapter === 1 && flawless) Achievements.unlock('ghost_runner');
    if (chapter === 2 && run.damage === 0) Achievements.unlock('untouchable');
  },

  /** The credits roll: the game is beaten for good (the Secret Chapter's Part 1 unlocks). */
  completeGame() {
    markGameBeaten();
    Achievements.unlock('practice_cancelled');
    if (run.session === 'play' && !sandbox.infiniteAmmo) {
      if (run.sessionDeaths === 0) Achievements.unlock('one_life');
      if (difficulty.hard) Achievements.unlock('hard_hero');
    }
  },

  // ---- The gallery ----------------------------------------------------------------------------

  openMenu() {
    if (!overlay) buildOverlay();
    renderGallery();
    overlay.classList.remove('hidden');
  },

  closeMenu() {
    if (overlay) overlay.classList.add('hidden');
  },

  /** (Cheat) every achievement at once, without the toasts. */
  unlockAll() {
    const now = Date.now();
    const got = unlocked();
    for (const a of ACHIEVEMENTS) if (!got[a.id]) got[a.id] = now;
    save(KEY, got);
    if (overlay) renderGallery();
  },

  /** (Testing) forget everything. */
  resetAll() {
    memory = {};
    statMemory = {};
    save(KEY, memory);
    save(KEY_STATS, statMemory);
    if (overlay) renderGallery();
  },
};

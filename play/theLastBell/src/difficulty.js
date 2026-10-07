/*
 * Difficulty + post-game progress. Beating the game unlocks Hard Mode
 * (remembered in this browser); the toggle on the main menu / chapter select
 * flips these multipliers, which every system reads at the moment it needs
 * them (so the toggle takes effect on the next run without rebuilding anything).
 *
 *   Hard Mode: less max HP, coaches see further and move faster, ELDARs hit
 *   harder and fire more often.
 *
 * The post-game lives here too (it's all the same little bit of persistence):
 *   game_beaten            the credits have rolled once: the Secret Chapter's Part 1 unlocks
 *   hard_flawless_ch1..3   that chapter was cleared on Hard Mode without dying: all three unlock Part 2
 *   hall_legend            Part 2 cleared: the permanent badge...
 *   sandbox_unlocked       ...and the Infinite Ammo / Sandbox toggle
 */

const KEY_UNLOCKED = 'lastbell.hardUnlocked';
const KEY_ON = 'lastbell.hardMode';
const KEY_SANDBOX_ON = 'sandbox_on';

// (What was written this session wins, so a browser that blocks storage still remembers until you reload.)
const mem = new Map();

function read(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  mem.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // (private window / blocked storage: the unlock just won't persist)
  }
}

export const difficulty = {
  hard: false,
  playerHpMult: 1, // max HP
  sightMult: 1, // coach vision ranges (beam, plain sight, close range)
  coachSpeedMult: 1, // coach patrol / investigate / search speeds
  chaseMult: 1, // coach chase speed (kept just under your sprint)
  damageMult: 1, // ELDAR (and Mecha) damage to you
  fireMult: 1, // ELDAR cooldowns / wind-ups (lower = faster)
};

/** Wipe every unlock and save key (the "billing" cheat's reset). Reload afterwards. */
export function resetAllProgress() {
  mem.clear();
  try {
    const drop = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && (k.startsWith('lastbell.') || k.startsWith('hard_flawless_') || ['game_beaten', 'hall_legend', 'sandbox_unlocked', 'sandbox_on'].includes(k))) drop.push(k);
    }
    drop.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // (blocked storage: nothing persisted anyway)
  }
}

export function isHardUnlocked() {
  return read(KEY_UNLOCKED) === '1';
}

export function unlockHardMode() {
  write(KEY_UNLOCKED, '1');
}

export function setHardMode(on) {
  const hard = !!on && isHardUnlocked();
  difficulty.hard = hard;
  difficulty.playerHpMult = hard ? 0.6 : 1;
  difficulty.sightMult = hard ? 1.3 : 1;
  difficulty.coachSpeedMult = hard ? 1.2 : 1;
  difficulty.chaseMult = hard ? 1.07 : 1;
  difficulty.damageMult = hard ? 1.5 : 1;
  difficulty.fireMult = hard ? 0.65 : 1;
  write(KEY_ON, hard ? '1' : '0');
  return hard;
}

setHardMode(read(KEY_ON) === '1');

// ---------------------------------------------------------------------------
// The post-game
// ---------------------------------------------------------------------------

const flag = (key) => read(key) === 'true';

/** The credits have rolled at least once (typing "billing" for Hard Mode does not count). */
export const isGameBeaten = () => flag('game_beaten');
export function markGameBeaten() {
  write('game_beaten', 'true');
}

/** Chapter 1, 2 or 3 cleared on Hard Mode without dying. */
export const isFlawless = (chapter) => flag(`hard_flawless_ch${chapter}`);
export function markFlawless(chapter) {
  write(`hard_flawless_ch${chapter}`, 'true');
}

/** Secret Chapter part 1 / 2 cleared on Hard Mode without dying (their menu cards turn gold). */
export const isPartFlawless = (part) => flag(`hard_flawless_part${part}`);
export function markPartFlawless(part) {
  write(`hard_flawless_part${part}`, 'true');
}

/** Secret Chapter, Part 1 / Part 2 ("Perfectionist": all three flawless flags). */
export const isPartOneUnlocked = () => isGameBeaten();
export const isPartTwoUnlocked = () => isFlawless(1) && isFlawless(2) && isFlawless(3);

/** Part 2 cleared: the permanent "Hall Legend" badge, and the Sandbox toggle with it. */
export const hasHallLegend = () => flag('hall_legend');
export function grantHallLegend() {
  write('hall_legend', 'true');
  write('sandbox_unlocked', 'true');
}
export const isSandboxUnlocked = () => flag('sandbox_unlocked');

/** Sandbox: infinite ammo (the rifle never runs dry, so there's nothing to reload). */
export const sandbox = { infiniteAmmo: false };

export function setSandbox(on) {
  const value = !!on && isSandboxUnlocked();
  sandbox.infiniteAmmo = value;
  write(KEY_SANDBOX_ON, value ? 'true' : 'false');
  return value;
}

setSandbox(read(KEY_SANDBOX_ON) === 'true');

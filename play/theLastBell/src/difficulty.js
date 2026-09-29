/*
 * Difficulty. Beating the game unlocks Hard Mode (remembered in this browser);
 * the toggle on the main menu / chapter select flips these multipliers, which
 * every system reads at the moment it needs them (so the toggle takes effect
 * on the next run without rebuilding anything).
 *
 *   Hard Mode: less max HP, coaches see further and move faster, ELDARs hit
 *   harder and fire more often.
 */

const KEY_UNLOCKED = 'lastbell.hardUnlocked';
const KEY_ON = 'lastbell.hardMode';

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
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

let unlockedThisSession = false;

export function isHardUnlocked() {
  return unlockedThisSession || read(KEY_UNLOCKED) === '1';
}

export function unlockHardMode() {
  unlockedThisSession = true;
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

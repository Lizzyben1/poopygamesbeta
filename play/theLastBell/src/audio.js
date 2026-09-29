// Tiny Web Audio synth for Chapter 1's one-shot sound effects (no asset files needed).

let ctx = null;
let master = null;
let noiseBuffer = null;
let rain = null;
let weather = null; // bus for rain + thunder, muffled once you're underground
let labHum = null;

/** Create/resume the audio context. Call from a user gesture (autoplay policy). */
export function initAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    const level = ctx.createGain();
    level.connect(muffle);
    muffle.connect(master);
    weather = { input: level, muffle };
    startRain();
    scheduleThunder(true);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

/** Pause / resume every sound at once (the pause menu). */
export function setAudioPaused(paused) {
  if (!ctx) return;
  if (paused && ctx.state === 'running') ctx.suspend();
  else if (!paused && ctx.state === 'suspended') ctx.resume();
}

function noise() {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

function envelope(t0, peak, attack, hold, release) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  gain.gain.setValueAtTime(peak, t0 + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
  return gain;
}

// ---------------------------------------------------------------------------
// Ambient rain + thunder
// ---------------------------------------------------------------------------

/** Looping procedural rain: a filtered noise bed with slow gusts plus a bright patter layer. */
function startRain() {
  if (rain || !ctx) return;
  const bed = noise();
  bed.loop = true;
  const high = ctx.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 420;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 900;
  const gust = ctx.createGain(); // modulated by a slow LFO so the storm breathes
  gust.gain.value = 1;
  const gustLfo = ctx.createOscillator();
  gustLfo.frequency.value = 0.11;
  const gustDepth = ctx.createGain();
  gustDepth.gain.value = 0.25;
  gustLfo.connect(gustDepth);
  gustDepth.connect(gust.gain);
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  bed.connect(high);
  high.connect(low);
  low.connect(gust);
  gust.connect(gain);
  gain.connect(weather.input);

  const patter = noise();
  patter.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3200;
  band.Q.value = 0.7;
  const patterGain = ctx.createGain();
  patterGain.gain.value = 0.0001;
  patter.connect(band);
  band.connect(patterGain);
  patterGain.connect(weather.input);

  bed.start();
  patter.start(0, 0.7); // offset so the two layers aren't the same noise
  gustLfo.start();
  rain = { low, gain, patterGain };
  setRainExposure(0.06);
}

/**
 * How exposed the listener is to the storm: 0 = deep inside the school (a faint
 * muffled roar on the roof), 1 = standing out in it.
 */
export function setRainExposure(exposure) {
  if (!rain) return;
  const x = Math.min(1, Math.max(0, exposure));
  const t = ctx.currentTime;
  rain.low.frequency.setTargetAtTime(500 + x * x * 6500, t, 0.25);
  rain.gain.gain.setTargetAtTime(0.03 + x * 0.2, t, 0.25);
  rain.patterGain.gain.setTargetAtTime(0.002 + x * 0.05, t, 0.25);
}

/** A distant thunder roll: low rumbling noise with a few irregular swells. */
export function playThunder() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const near = Math.random(); // 0 = far off, 1 = closer
  const peak = 0.1 + near * 0.2;
  const rumble = noise();
  rumble.loop = true;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.setValueAtTime(140 + near * 260, now);
  low.frequency.exponentialRampToValueAtTime(70, now + 6);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  let t = now + 0.25 + Math.random() * 0.5;
  gain.gain.exponentialRampToValueAtTime(peak, t);
  const rolls = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < rolls; i++) {
    t += 0.35 + Math.random() * 0.9;
    gain.gain.exponentialRampToValueAtTime(peak * (0.25 + Math.random() * 0.75), t);
  }
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  rumble.connect(low);
  low.connect(gain);
  gain.connect(weather.input);
  rumble.start(now);
  rumble.stop(t + 2.4);
}

function scheduleThunder(first = false) {
  const delay = first ? 9000 + Math.random() * 6000 : 18000 + Math.random() * 22000;
  setTimeout(() => {
    playThunder();
    scheduleThunder();
  }, delay);
}

/** Coach's pea whistle: a short "tweet" then a long "TWEEEET". */
export function playWhistle() {
  if (!ctx) return;
  const now = ctx.currentTime;
  [[0, 0.16], [0.24, 0.8]].forEach(([start, dur]) => {
    const t0 = now + start;
    const end = t0 + dur + 0.08;
    const out = envelope(t0, 0.3, 0.02, dur - 0.07, 0.05);
    out.connect(master);

    const tone = ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.value = 2900;
    // The pea rattling inside the whistle = a fast frequency trill.
    const trill = ctx.createOscillator();
    trill.frequency.value = 31;
    const trillDepth = ctx.createGain();
    trillDepth.gain.value = 190;
    trill.connect(trillDepth);
    trillDepth.connect(tone.frequency);
    tone.connect(out);

    const breath = noise();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3200;
    band.Q.value = 3;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.35;
    breath.connect(band);
    band.connect(breathGain);
    breathGain.connect(out);

    tone.start(t0);
    trill.start(t0);
    breath.start(t0);
    tone.stop(end);
    trill.stop(end);
    breath.stop(end);
  });
}

/** Tense low dissonant hit for getting caught. */
export function playCaughtStinger() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = envelope(now, 0.45, 0.03, 0.2, 1.6);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2600, now);
  filter.frequency.exponentialRampToValueAtTime(160, now + 1.7);
  filter.connect(out);
  out.connect(master);
  [55, 58.3, 82.4, 116.5].forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.connect(filter);
    osc.start(now);
    osc.stop(now + 2);
  });
}

/** Car door thunk (open/close). */
export function playCarDoor() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(110, now);
  body.frequency.exponentialRampToValueAtTime(38, now + 0.18);
  const bodyGain = envelope(now, 0.6, 0.005, 0.02, 0.22);
  body.connect(bodyGain);
  bodyGain.connect(master);
  body.start(now);
  body.stop(now + 0.3);

  const slam = noise();
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 700;
  const slamGain = envelope(now, 0.35, 0.003, 0.01, 0.14);
  slam.connect(low);
  low.connect(slamGain);
  slamGain.connect(master);
  slam.start(now);
  slam.stop(now + 0.2);
}

/** Grinding mechanical door: filtered noise sweep over a low hum, ending in a clunk. */
export function playMechanism(duration = 2) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const grind = noise();
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 2.5;
  band.frequency.setValueAtTime(260, now);
  band.frequency.linearRampToValueAtTime(900, now + duration);
  const grindGain = envelope(now, 0.4, 0.15, duration - 0.35, 0.2);
  grind.connect(band);
  band.connect(grindGain);
  grindGain.connect(master);
  grind.start(now);
  grind.stop(now + duration + 0.1);

  const hum = ctx.createOscillator();
  hum.type = 'square';
  hum.frequency.value = 46;
  const humFilter = ctx.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 180;
  const humGain = envelope(now, 0.22, 0.2, duration - 0.4, 0.2);
  hum.connect(humFilter);
  humFilter.connect(humGain);
  humGain.connect(master);
  hum.start(now);
  hum.stop(now + duration + 0.1);

  const clunkAt = now + duration;
  const clunk = ctx.createOscillator();
  clunk.frequency.setValueAtTime(90, clunkAt);
  clunk.frequency.exponentialRampToValueAtTime(30, clunkAt + 0.25);
  const clunkGain = envelope(clunkAt, 0.7, 0.005, 0.03, 0.3);
  clunk.connect(clunkGain);
  clunkGain.connect(master);
  clunk.start(clunkAt);
  clunk.stop(clunkAt + 0.4);
}

/** Dramatic chapter-end sting: a sub boom under a swelling dissonant cluster. */
export function playSting() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const boom = ctx.createOscillator();
  boom.type = 'sine';
  boom.frequency.setValueAtTime(62, now);
  boom.frequency.exponentialRampToValueAtTime(28, now + 2.5);
  const boomGain = envelope(now, 0.9, 0.01, 0.2, 2.6);
  boom.connect(boomGain);
  boomGain.connect(master);
  boom.start(now);
  boom.stop(now + 3);

  const cluster = envelope(now, 0.14, 0.06, 0.9, 2.2);
  cluster.connect(master);
  [440, 466.2, 622.3, 659.3].forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3200, now);
    filter.frequency.exponentialRampToValueAtTime(400, now + 3);
    osc.connect(filter);
    filter.connect(cluster);
    osc.start(now);
    osc.stop(now + 3.3);
  });

  const hit = noise();
  const hitFilter = ctx.createBiquadFilter();
  hitFilter.type = 'lowpass';
  hitFilter.frequency.value = 1200;
  const hitGain = envelope(now, 0.5, 0.005, 0.05, 0.9);
  hit.connect(hitFilter);
  hitFilter.connect(hitGain);
  hitGain.connect(master);
  hit.start(now);
  hit.stop(now + 1.2);
}

// ---------------------------------------------------------------------------
// Chapter 2: the lab under the oak
// ---------------------------------------------------------------------------

/** Transformer drone + air-handler hiss + a slow swell: the lab's machinery. */
function startLabHum() {
  const out = ctx.createGain();
  out.gain.value = 0.0001;
  out.connect(master);
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 190;
  const swell = ctx.createGain(); // breathes slowly so the drone isn't static
  swell.gain.value = 0.8;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.25;
  lfo.connect(lfoDepth);
  lfoDepth.connect(swell.gain);
  low.connect(swell);
  swell.connect(out);
  [[55, 0.09], [55.5, 0.07], [110.4, 0.025]].forEach(([freq, level]) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g);
    g.connect(low);
    osc.start();
  });
  const air = noise();
  air.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 520;
  band.Q.value = 0.6;
  const airGain = ctx.createGain();
  airGain.gain.value = 0.05;
  air.connect(band);
  band.connect(airGain);
  airGain.connect(out);
  air.start(0, 1.3);
  lfo.start();
  // A higher "charging" tone that rises while the attack mode downloads.
  const charge = ctx.createOscillator();
  charge.type = 'triangle';
  charge.frequency.value = 180;
  const chargeGain = ctx.createGain();
  chargeGain.gain.value = 0.0001;
  charge.connect(chargeGain);
  chargeGain.connect(out);
  charge.start();
  labHum = { out, charge, chargeGain };
}

/** Underground: the storm fades to a distant, muffled rumble and the lab hums. */
export function setUnderground(on) {
  if (!ctx) return;
  const t = ctx.currentTime;
  weather.input.gain.setTargetAtTime(on ? 0.22 : 1, t, 0.8);
  weather.muffle.frequency.setTargetAtTime(on ? 260 : 20000, t, 0.8);
  if (on && !labHum) startLabHum();
  if (labHum) labHum.out.gain.setTargetAtTime(on ? 0.55 : 0.0001, t, 1.2);
}

/** 0..1 download progress: the lab's charging tone climbs with it. */
export function setDownloadCharge(progress) {
  if (!labHum) return;
  const t = ctx.currentTime;
  const p = Math.min(1, Math.max(0, progress));
  labHum.charge.frequency.setTargetAtTime(180 + p * 520, t, 0.3);
  labHum.chargeGain.gain.setTargetAtTime(0.008 + p * 0.03, t, 0.3);
}

/** A boot on a steel ladder rung: a short metallic clank. */
export function playLadderStep(pitch = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const ring = ctx.createOscillator();
  ring.type = 'triangle';
  ring.frequency.setValueAtTime(820 * pitch, now);
  ring.frequency.exponentialRampToValueAtTime(610 * pitch, now + 0.25);
  const ringGain = envelope(now, 0.07, 0.002, 0.01, 0.28);
  ring.connect(ringGain);
  ringGain.connect(master);
  ring.start(now);
  ring.stop(now + 0.35);
  const hit = noise();
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400 * pitch;
  band.Q.value = 1.4;
  const hitGain = envelope(now, 0.12, 0.002, 0.005, 0.07);
  hit.connect(band);
  band.connect(hitGain);
  hitGain.connect(master);
  hit.start(now);
  hit.stop(now + 0.1);
}

/** Terminal UI beep. */
export function playBeep(freq = 1200, duration = 0.07, volume = 0.1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3000;
  const gain = envelope(now, volume, 0.004, duration, 0.04);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  osc.start(now);
  osc.stop(now + duration + 0.08);
}

/** Thumb drive clicking into a port, then the "device connected" chirp. */
export function playUsbInsert() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const click = noise();
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3800;
  band.Q.value = 2;
  const clickGain = envelope(now, 0.25, 0.001, 0.004, 0.03);
  click.connect(band);
  band.connect(clickGain);
  clickGain.connect(master);
  click.start(now);
  click.stop(now + 0.05);
  [[660, 0.25], [990, 0.36]].forEach(([freq, at]) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = envelope(now + at, 0.1, 0.005, 0.07, 0.06);
    osc.connect(g);
    g.connect(master);
    osc.start(now + at);
    osc.stop(now + at + 0.16);
  });
}

/** Download begins: a descending warble into a low, ominous swell. */
export function playDownloadStart() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1400, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + 0.9);
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 18;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 60;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(osc.frequency);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2200;
  const gain = envelope(now, 0.07, 0.02, 0.6, 0.4);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  osc.start(now);
  wobble.start(now);
  osc.stop(now + 1.1);
  wobble.stop(now + 1.1);

  const swell = envelope(now + 0.4, 0.22, 1.4, 1.2, 2.4);
  swell.connect(master);
  [41.2, 43.7, 61.7].forEach((freq) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    o.connect(lp);
    lp.connect(swell);
    o.start(now + 0.4);
    o.stop(now + 5.6);
  });
}

// ---------------------------------------------------------------------------
// Chapter 2 combat
// ---------------------------------------------------------------------------

/** One oscillator with a pitch sweep and an envelope. */
function tone(type, f0, f1, t0, duration, peak, { attack = 0.004, filter = 0 } = {}) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + duration);
  const gain = envelope(t0, peak, attack, duration * 0.25, duration * 0.75);
  if (filter) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filter;
    osc.connect(lp);
    lp.connect(gain);
  } else {
    osc.connect(gain);
  }
  gain.connect(master);
  osc.start(t0);
  osc.stop(t0 + attack + duration + 0.05);
}

/** A filtered noise burst. */
function burst(type, freq, q, t0, duration, peak, attack = 0.002) {
  const src = noise();
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = envelope(t0, peak, attack, duration * 0.15, duration * 0.85);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  src.start(t0, Math.random() * Math.max(0, 1.9 - duration - attack)); // stay inside the 2s noise buffer
  src.stop(t0 + attack + duration + 0.05);
  return filter;
}

/** Assault rifle shot: a sharp crack over a low thump. Ben's are quieter/duller. */
export function playGunshot({ volume = 1, distant = false } = {}) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const v = volume * (distant ? 0.45 : 1);
  burst('bandpass', distant ? 1100 : 1900, 0.9, now, 0.09, 0.5 * v);
  burst('lowpass', distant ? 700 : 2600, 0.7, now, 0.2, 0.22 * v);
  tone('sine', 150, 42, now, 0.13, 0.55 * v);
  if (!distant) tone('square', 3200, 1400, now, 0.02, 0.05 * v);
}

/** Reload foley: 'out' (mag drops), 'in' (mag seats), 'rack' (charging handle). */
export function playReloadStep(kind) {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (kind === 'rack') {
    burst('bandpass', 2600, 2.5, now, 0.05, 0.22);
    burst('bandpass', 1800, 2.5, now + 0.09, 0.06, 0.25);
  } else {
    burst('bandpass', kind === 'in' ? 1500 : 900, 3, now, 0.06, 0.25);
    tone('triangle', kind === 'in' ? 520 : 330, 260, now, 0.08, 0.08);
  }
}

export function playEmptyClick() {
  if (!ctx) return;
  burst('bandpass', 3000, 4, ctx.currentTime, 0.03, 0.18);
}

/** Feedback for your hits: 'hit', 'head', 'kill', 'armor' (sparks off a shield/plating) or 'pillar'. */
export function playHitmarker(kind) {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (kind === 'armor') {
    tone('triangle', 2400, 1700, now, 0.12, 0.09);
    burst('highpass', 5000, 1, now, 0.04, 0.08);
  } else if (kind === 'pillar') {
    tone('triangle', 900 + Math.random() * 200, 520, now, 0.1, 0.06);
    burst('bandpass', 1700, 2, now, 0.05, 0.09);
  } else if (kind === 'kill') {
    tone('square', 880, 880, now, 0.05, 0.05, { filter: 2500 });
    tone('square', 1320, 1320, now + 0.05, 0.07, 0.05, { filter: 2500 });
  } else {
    tone('sine', kind === 'head' ? 1900 : 1250, kind === 'head' ? 1700 : 1150, now, 0.05, 0.07);
  }
}

/** ELDAR arm cannon: a short descending plasma "pew". */
export function playBoltFire(pitch = 1, volume = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sawtooth', 1150 * pitch, 260 * pitch, now, 0.14, 0.07 * volume, { filter: 3000 });
  burst('bandpass', 1400 * pitch, 1.2, now, 0.08, 0.06 * volume);
}

export function playBoltImpact() {
  if (!ctx) return;
  burst('highpass', 2500, 0.8, ctx.currentTime, 0.12, 0.08);
}

/** Rising whine: a robot charging its cannon (the tell before it fires). */
export function playRobotCharge(pitch = 1) {
  if (!ctx) return;
  tone('sawtooth', 300 * pitch, 1100 * pitch, ctx.currentTime, 0.42, 0.035, { attack: 0.2, filter: 2200 });
}

/** A unit shutting down: power-down whine into a metal crash. */
export function playRobotDeath() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sawtooth', 520, 45, now, 0.8, 0.09, { filter: 1800 });
  burst('lowpass', 900, 0.7, now + 0.35, 0.5, 0.3);
  burst('bandpass', 2200, 2, now + 0.38, 0.2, 0.12);
}

/** Metal feet hitting the floor; heavy = the Titan. */
export function playLanding(heavy = false) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', heavy ? 70 : 120, heavy ? 22 : 40, now, heavy ? 0.9 : 0.3, heavy ? 1.0 : 0.45);
  burst('lowpass', heavy ? 500 : 1200, 0.7, now, heavy ? 0.9 : 0.25, heavy ? 0.6 : 0.3);
  if (!heavy) burst('bandpass', 2600, 3, now, 0.1, 0.1);
}

/** Cryo pod venting open. */
export function playPodOpen() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('highpass', 1800, 0.5, now, 1.2, 0.18, 0.05);
  tone('square', 90, 60, now, 0.35, 0.08, { filter: 400 });
}

/** Heavy door sliding on its track. */
export function playDoorSlide() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('bandpass', 420, 1.5, now, 0.7, 0.2, 0.08);
  tone('sine', 110, 55, now + 0.6, 0.2, 0.3);
}

let alarm = null;
/** Two-tone lockdown klaxon, on until stopAlarm(). */
export function startAlarm() {
  if (!ctx || alarm) return;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 1.25;
  const depth = ctx.createGain();
  depth.gain.value = 90;
  osc.frequency.value = 610;
  lfo.connect(depth);
  depth.connect(osc.frequency);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  gain.gain.setTargetAtTime(0.035, ctx.currentTime, 0.3);
  osc.connect(lp);
  lp.connect(gain);
  gain.connect(master);
  osc.start();
  lfo.start();
  alarm = { osc, lfo, gain };
}

export function stopAlarm() {
  if (!alarm) return;
  const a = alarm;
  alarm = null;
  a.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
  a.osc.stop(ctx.currentTime + 2);
  a.lfo.stop(ctx.currentTime + 2);
}

/** The tree hatch slamming shut and bolting. */
export function playHatchSlam() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 95, 30, now, 0.7, 0.9);
  burst('lowpass', 700, 0.8, now, 0.5, 0.45);
  burst('bandpass', 2000, 3, now + 0.55, 0.06, 0.25);
  burst('bandpass', 1600, 3, now + 0.72, 0.08, 0.28);
}

/** The display pillar: a metal groan, then the crash. */
export function playPillarFall() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sawtooth', 70, 40, now, 1.1, 0.12, { attack: 0.3, filter: 600 });
  burst('highpass', 3000, 0.7, now + 0.2, 0.3, 0.12); // glass giving way
  tone('sine', 60, 20, now + 1.15, 1.1, 1.0);
  burst('lowpass', 900, 0.6, now + 1.15, 1.0, 0.7);
  burst('highpass', 4000, 0.6, now + 1.15, 0.6, 0.25); // shattering
}

/** The Titan's roar: a distorted low growl with a shuddering tremolo. */
export function playBossRoar() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = envelope(now, 0.4, 0.15, 1.1, 0.8);
  out.connect(master);
  const trem = ctx.createGain();
  trem.gain.value = 0.7;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 13;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.3;
  lfo.connect(lfoDepth);
  lfoDepth.connect(trem.gain);
  trem.connect(out);
  [58, 61, 87].forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq * 1.3, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + 1.8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, now);
    lp.frequency.exponentialRampToValueAtTime(260, now + 2);
    osc.connect(lp);
    lp.connect(trem);
    osc.start(now);
    osc.stop(now + 2.1);
  });
  lfo.start(now);
  lfo.stop(now + 2.1);
  burst('bandpass', 500, 1, now, 1.8, 0.1, 0.2);
}

/** Titan stomp: sub boom + debris. */
export function playStomp() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 55, 20, now, 1.2, 1.0);
  burst('lowpass', 600, 0.7, now, 0.8, 0.6);
  burst('bandpass', 1800, 1.5, now + 0.05, 0.4, 0.12);
}

/** Water shorting out the Titan: crackling electric arcs for `duration` seconds. */
export function playElectricStun(duration = 6) {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('highpass', 3500, 0.7, now, 0.35, 0.35); // the big zap
  tone('square', 2400, 300, now, 0.3, 0.08, { filter: 5000 });
  const src = noise();
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3200;
  band.Q.value = 1.5;
  const gate = ctx.createGain();
  gate.gain.setValueAtTime(0.0001, now);
  // Random crackles: a gate snapping open and shut.
  for (let t = now + 0.3; t < now + duration; t += 0.03 + Math.random() * 0.12) {
    gate.gain.setValueAtTime(Math.random() < 0.5 ? 0.12 + Math.random() * 0.12 : 0.0001, t);
  }
  gate.gain.setValueAtTime(0.0001, now + duration);
  src.connect(band);
  band.connect(gate);
  gate.connect(master);
  src.start(now);
  src.stop(now + duration + 0.1);
}

export function playBottleThrow() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('bandpass', 600, 1.2, now, 0.35, 0.12, 0.08);
  f.frequency.exponentialRampToValueAtTime(1800, now + 0.3);
}

export function playBottleSmash() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('lowpass', 900, 0.8, now, 0.35, 0.3); // splash
  burst('bandpass', 1500, 2, now, 0.12, 0.2); // plastic crunch
  tone('sine', 300, 120, now, 0.2, 0.1);
}

export function playExplosion() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 80, 18, now, 1.6, 1.0);
  burst('lowpass', 1200, 0.6, now, 1.4, 0.8);
  burst('highpass', 2500, 0.6, now, 0.5, 0.2);
}

/** Taking a hit: a dull thump. */
export function playPlayerHurt() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 140, 60, now, 0.18, 0.35);
  burst('lowpass', 500, 0.8, now, 0.15, 0.2);
}

/** A round skipping off armor plating: a bright metallic ping (pitch varies a little). */
export function playRicochet() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const p = 0.85 + Math.random() * 0.3;
  tone('triangle', 3400 * p, 2100 * p, now, 0.18, 0.06);
  tone('sine', 5200 * p, 3900 * p, now, 0.09, 0.035);
  burst('highpass', 5200, 0.8, now, 0.03, 0.06);
}

/** Shield bash: a whoosh into a heavy clang. */
export function playShieldBash() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('bandpass', 380, 1.4, now, 0.18, 0.16, 0.06);
  f.frequency.exponentialRampToValueAtTime(1300, now + 0.16);
  tone('sine', 190, 50, now + 0.14, 0.4, 0.7);
  burst('bandpass', 1300, 1.6, now + 0.14, 0.18, 0.35);
  tone('triangle', 820, 700, now + 0.14, 0.5, 0.06);
}

/** Steel being torn out of a wall: a screech over grinding, `duration` seconds. */
export function playMetalTear(duration = 1.4) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(420, now);
  osc.frequency.linearRampToValueAtTime(760, now + duration * 0.6);
  osc.frequency.linearRampToValueAtTime(300, now + duration);
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 23;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 60;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(osc.frequency);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1400;
  band.Q.value = 2.2;
  const gain = envelope(now, 0.12, 0.15, duration * 0.6, duration * 0.4);
  osc.connect(band);
  band.connect(gain);
  gain.connect(master);
  osc.start(now);
  wobble.start(now);
  osc.stop(now + duration + 0.3);
  wobble.stop(now + duration + 0.3);
  for (let t = 0; t < duration; t += 0.12 + Math.random() * 0.18) {
    burst('bandpass', 500 + Math.random() * 1400, 1.5, now + t, 0.12, 0.18 + Math.random() * 0.15);
  }
  tone('sine', 70, 25, now + duration, 0.9, 0.9); // it comes free
  burst('lowpass', 800, 0.7, now + duration, 0.7, 0.5);
}

/** A bullet thudding into the Titan's steel pillar. */
export function playPillarHit() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('triangle', 900 + Math.random() * 200, 520, now, 0.1, 0.05);
  burst('bandpass', 1700, 2, now, 0.05, 0.08);
}

/** The pillar shield breaking apart: a huge metal crash with debris clattering down. */
export function playPillarShatter() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 90, 20, now, 1.6, 1.0);
  burst('lowpass', 1400, 0.6, now, 1.2, 0.8);
  burst('highpass', 3000, 0.6, now, 0.4, 0.3);
  for (let i = 0; i < 9; i++) {
    const t = now + 0.25 + i * 0.13 + Math.random() * 0.1;
    tone('triangle', 600 + Math.random() * 900, 300, t, 0.2, 0.05 + Math.random() * 0.04);
    burst('bandpass', 900 + Math.random() * 2000, 2.5, t, 0.07, 0.12);
  }
}

// ---------------------------------------------------------------------------
// Chapter 3: the grounds at night (sentries, hiding spots, the locker room door)
// ---------------------------------------------------------------------------

let siren = null;
/** An ELDAR sentry's grab siren: loud, high, mechanical. On until stopSiren(). */
export function startSiren() {
  if (!ctx || siren) return;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(0.09, now + 0.05);
  out.connect(master);
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 3.2;
  const depth = ctx.createGain();
  depth.gain.value = 420;
  lfo.connect(depth);
  const oscs = [1650, 1664].map((f) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    depth.connect(o.frequency);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2100;
    band.Q.value = 0.9;
    o.connect(band);
    band.connect(out);
    o.start(now);
    return o;
  });
  lfo.start(now);
  siren = { out, oscs, lfo };
}

export function stopSiren() {
  if (!siren) return;
  const s = siren;
  siren = null;
  const now = ctx.currentTime;
  s.out.gain.setTargetAtTime(0.0001, now, 0.08);
  s.oscs.forEach((o) => o.stop(now + 0.6));
  s.lfo.stop(now + 0.6);
}

/** Struggling in an ELDAR's grip (one per mash press). */
export function playStruggle(i = 0) {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('bandpass', 700 + (i % 3) * 180, 2.5, now, 0.06, 0.16);
  tone('triangle', 300 + i * 22, 220, now, 0.06, 0.05);
}

/** Wrenching free of the grip. */
export function playBreakFree() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('bandpass', 1200, 1.4, now, 0.2, 0.3);
  tone('sine', 160, 60, now, 0.3, 0.4);
  tone('triangle', 1400, 700, now + 0.05, 0.25, 0.05);
}

/** Dumpster lid / shed door: 'lid' or 'door', opening (in) or closing (out). */
export function playHideCreak(kind = 'lid') {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (kind === 'lid') {
    tone('sawtooth', 190, 150, now, 0.35, 0.03, { attack: 0.08, filter: 900 });
    tone('sine', 120, 50, now + 0.34, 0.25, 0.4);
    burst('lowpass', 700, 0.8, now + 0.34, 0.2, 0.25);
  } else {
    tone('sawtooth', 260, 210, now, 0.5, 0.03, { attack: 0.1, filter: 1200 });
    burst('bandpass', 900, 3, now + 0.48, 0.05, 0.14);
  }
}

/** A coach tearing a hiding spot open. */
export function playYankOpen() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('lowpass', 1100, 0.7, now, 0.25, 0.7);
  tone('sine', 150, 45, now, 0.35, 0.8);
  burst('bandpass', 2200, 2, now + 0.02, 0.12, 0.25);
}

/** Heartbeat thud-thud (hiding with a coach close by). */
export function playHeartbeat(volume = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 62, 40, now, 0.14, 0.45 * volume);
  tone('sine', 58, 38, now + 0.24, 0.12, 0.32 * volume);
}

/** Chains wrapped through the handles and a padlock snapped shut. */
export function playChainLock() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (let i = 0; i < 7; i++) {
    const t = now + i * 0.09 + Math.random() * 0.05;
    burst('bandpass', 2600 + Math.random() * 1600, 4, t, 0.05, 0.08 + Math.random() * 0.05);
  }
  burst('bandpass', 1800, 3, now + 0.85, 0.05, 0.3);
  tone('triangle', 1250, 1100, now + 0.85, 0.12, 0.06);
}

/** A heavy steel door slammed shut. */
export function playMetalDoorSlam() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 110, 32, now, 0.8, 1.0);
  burst('lowpass', 900, 0.7, now, 0.6, 0.6);
  tone('triangle', 640, 560, now, 0.9, 0.05);
  burst('bandpass', 2400, 2, now + 0.02, 0.1, 0.2);
}

/** Throwing a heavy deadbolt: a grinding slide into a solid clunk. */
export function playDeadbolt() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('bandpass', 700, 2, now, 0.3, 0.2, 0.05);
  f.frequency.exponentialRampToValueAtTime(1300, now + 0.28);
  tone('sine', 180, 70, now + 0.3, 0.25, 0.6);
  burst('bandpass', 1600, 3, now + 0.3, 0.07, 0.35);
}

/** Catching your breath: a few ragged breaths, slowing down, over `seconds`. */
export function playBreathing(seconds = 3) {
  if (!ctx) return;
  const now = ctx.currentTime;
  let t = 0;
  let gap = 0.5;
  while (t < seconds) {
    const inhale = burst('bandpass', 1300, 0.9, now + t, 0.32, 0.06, 0.12);
    inhale.frequency.exponentialRampToValueAtTime(1800, now + t + 0.3);
    burst('bandpass', 900, 0.8, now + t + 0.38, 0.4, 0.05, 0.08);
    t += 0.8 + gap;
    gap += 0.18;
  }
}

/** A car starting up far away and pulling off. */
export function playDistantEngine() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(38, now);
  osc.frequency.linearRampToValueAtTime(55, now + 1.2);
  osc.frequency.linearRampToValueAtTime(72, now + 3.5);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 220;
  const gain = envelope(now, 0.05, 0.4, 2.2, 2.4);
  osc.connect(lp);
  lp.connect(gain);
  gain.connect(master);
  osc.start(now);
  osc.stop(now + 5.2);
  burst('bandpass', 400, 2, now, 0.5, 0.05, 0.05); // starter
}

/** An ELDAR sentry's servos whirring as it turns (quiet, close range only). */
export function playServo(volume = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('square', 240, 420, now, 0.22, 0.012 * volume, { attack: 0.05, filter: 1500 });
}

// ---------------------------------------------------------------------------
// Chapter 3, part 2: the locker room, the gym, the ending
// ---------------------------------------------------------------------------

/** A steel locker door: a squeal on the hinge and a tinny clang. */
export function playLockerDoor(open = true) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sawtooth', open ? 520 : 440, open ? 380 : 300, now, 0.28, 0.018, { attack: 0.05, filter: 2200 });
  tone('triangle', 900, 760, now + (open ? 0.22 : 0.02), 0.35, 0.05);
  burst('bandpass', 1900, 3, now + (open ? 0.22 : 0.02), 0.06, 0.14);
}

/** Something heavy slamming into a steel door from outside. */
export function playDoorBang() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 85, 30, now, 0.6, 0.9);
  burst('lowpass', 700, 0.7, now, 0.4, 0.55);
  tone('triangle', 520, 470, now, 0.7, 0.05);
}

/** The deadbolt snapping and the door flying open. */
export function playDoorBurst() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('bandpass', 2600, 3, now, 0.05, 0.3);
  tone('sine', 110, 25, now, 0.9, 1.0);
  burst('lowpass', 1200, 0.6, now, 0.7, 0.6);
  tone('triangle', 700, 520, now + 0.05, 0.9, 0.06);
}

/** A PA system clicking on, with a squeal of feedback. */
export function playPA() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('bandpass', 1400, 2, now, 0.05, 0.12);
  tone('sine', 2600, 3100, now + 0.08, 0.7, 0.025, { attack: 0.2 });
  burst('lowpass', 400, 0.8, now + 0.05, 1.4, 0.03, 0.2);
}

/** The roof coming in: a long, splitting crash with debris raining down. */
export function playCeilingCrash() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('bandpass', 900, 1.2, now, 0.5, 0.3, 0.1); // the first crack
  tone('sine', 70, 18, now + 0.35, 2.2, 1.0);
  burst('lowpass', 1100, 0.5, now + 0.35, 2.0, 0.9);
  burst('highpass', 3200, 0.6, now + 0.4, 0.9, 0.3);
  for (let i = 0; i < 14; i++) {
    const t = now + 0.6 + i * 0.12 + Math.random() * 0.1;
    burst('bandpass', 500 + Math.random() * 2200, 2, t, 0.1, 0.1 + Math.random() * 0.12);
  }
}

/** One of the Mecha's footfalls: a sub thud with a hydraulic hiss. */
export function playMechStep(volume = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 62, 22, now, 0.6, 0.85 * volume);
  burst('lowpass', 480, 0.7, now, 0.35, 0.4 * volume);
  burst('highpass', 3800, 0.7, now + 0.08, 0.3, 0.05 * volume, 0.05);
}

/** Hydraulics / a steam vent: a long hiss. */
export function playSteamVent(duration = 1.4) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('highpass', 2400, 0.6, now, duration, 0.18, 0.06);
  f.frequency.exponentialRampToValueAtTime(900, now + duration);
  tone('sine', 120, 60, now, 0.4, 0.2);
}

/** Laser charging up: a rising whine (duration = the wind-up). */
export function playLaserCharge(duration = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sawtooth', 180, 1600, now, duration, 0.05, { attack: duration * 0.7, filter: 2800 });
  tone('sine', 360, 3200, now, duration, 0.03, { attack: duration * 0.7 });
}

/** The laser itself: a loud crackling buzz for `duration` seconds. */
export function playLaserBeam(duration = 1.5) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = envelope(now, 0.16, 0.03, duration, 0.2);
  out.connect(master);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 96;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 38;
  const depth = ctx.createGain();
  depth.gain.value = 26;
  lfo.connect(depth);
  depth.connect(osc.frequency);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 900;
  band.Q.value = 0.8;
  osc.connect(band);
  band.connect(out);
  osc.start(now);
  lfo.start(now);
  osc.stop(now + duration + 0.3);
  lfo.stop(now + duration + 0.3);
  const hiss = noise();
  hiss.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 4200;
  const hg = ctx.createGain();
  hg.gain.value = 0.35;
  hiss.connect(hp);
  hp.connect(hg);
  hg.connect(out);
  hiss.start(now);
  hiss.stop(now + duration + 0.3);
}

/** A missile leaving its pod: a pop and a rushing whoosh. */
export function playMissileLaunch() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('lowpass', 600, 0.8, now, 0.12, 0.3);
  const f = burst('bandpass', 700, 1, now, 0.9, 0.12, 0.05);
  f.frequency.exponentialRampToValueAtTime(2600, now + 0.8);
}

/** A ground eruption: a short, heavy boom with rock crumbling. */
export function playEruption(volume = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 95, 26, now, 0.7, 0.8 * volume);
  burst('lowpass', 900, 0.6, now, 0.5, 0.5 * volume);
  burst('bandpass', 1700, 1.5, now + 0.05, 0.3, 0.12 * volume);
}

/** A Tank ELDAR's cannon: a deep, chesty boom. */
export function playTankCannon(volume = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 120, 35, now, 0.5, 0.7 * volume);
  burst('lowpass', 1300, 0.7, now, 0.35, 0.45 * volume);
  tone('sawtooth', 420, 90, now, 0.25, 0.06 * volume, { filter: 1500 });
}

/** Sliding feet-first across a gym floor. */
export function playSlide() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('bandpass', 1500, 1.1, now, 0.6, 0.14, 0.02);
  f.frequency.exponentialRampToValueAtTime(600, now + 0.6);
  tone('sine', 1900, 1500, now, 0.12, 0.02); // a sneaker squeak
}

/** Swinging a punch. */
export function playPunchWhoosh(pitch = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('bandpass', 500 * pitch, 1.4, now, 0.16, 0.12, 0.03);
  f.frequency.exponentialRampToValueAtTime(1400 * pitch, now + 0.15);
}

/** A punch landing: a meaty thump and a slap (heavy = a haymaker / counter). */
export function playPunchHit(heavy = false) {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', heavy ? 150 : 190, heavy ? 40 : 60, now, heavy ? 0.28 : 0.18, heavy ? 1.0 : 0.75);
  burst('lowpass', heavy ? 900 : 1300, 0.8, now, heavy ? 0.16 : 0.1, heavy ? 0.7 : 0.5);
  burst('bandpass', 2600, 1.2, now, 0.04, heavy ? 0.4 : 0.3); // the slap
  if (heavy) burst('bandpass', 700, 2, now + 0.02, 0.12, 0.25);
}

/** A punch smacking into raised forearms. */
export function playBlock() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 240, 110, now, 0.12, 0.45);
  burst('bandpass', 1100, 1.5, now, 0.07, 0.3);
}

/** Glass doors exploding into the gym. */
export function playGlassShatter() {
  if (!ctx) return;
  const now = ctx.currentTime;
  burst('highpass', 3000, 0.6, now, 0.5, 0.6);
  burst('bandpass', 5200, 1, now, 0.9, 0.3);
  for (let i = 0; i < 16; i++) {
    const t = now + 0.05 + i * 0.06 + Math.random() * 0.08;
    tone('triangle', 2500 + Math.random() * 3500, 2000, t, 0.12, 0.03 + Math.random() * 0.03);
  }
}

/** A car horn: two long blasts. */
export function playCarHorn() {
  if (!ctx) return;
  const now = ctx.currentTime;
  [[0, 0.35], [0.45, 0.8]].forEach(([at, dur]) => {
    const out = envelope(now + at, 0.12, 0.02, dur, 0.05);
    out.connect(master);
    [392, 494].forEach((freq) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = freq;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      o.connect(lp);
      lp.connect(out);
      o.start(now + at);
      o.stop(now + at + dur + 0.1);
    });
  });
}

/** An engine being floored for `duration` seconds. */
export function playEngineRoar(duration = 2) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = envelope(now, 0.2, 0.2, duration, 0.5);
  out.connect(master);
  [1, 1.5].forEach((mult, i) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(45 * mult, now);
    o.frequency.exponentialRampToValueAtTime(140 * mult, now + duration);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500 + i * 300;
    const g = ctx.createGain();
    g.gain.value = i ? 0.35 : 1;
    o.connect(lp);
    lp.connect(g);
    g.connect(out);
    o.start(now);
    o.stop(now + duration + 0.6);
  });
}

/** The car hitting something solid. */
export function playCarCrash() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 90, 22, now, 1.2, 1.0);
  burst('lowpass', 1500, 0.5, now, 1.0, 0.9);
  burst('bandpass', 2400, 1.2, now, 0.5, 0.3);
  for (let i = 0; i < 8; i++) tone('triangle', 500 + Math.random() * 1200, 300, now + 0.1 + i * 0.09, 0.2, 0.05);
}

/** Tires locking up on a polished floor. */
export function playTireScreech(duration = 1.2) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = envelope(now, 0.07, 0.05, duration, 0.3);
  out.connect(master);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(1500, now);
  o.frequency.linearRampToValueAtTime(1100, now + duration);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 17;
  const d = ctx.createGain();
  d.gain.value = 70;
  lfo.connect(d);
  d.connect(o.frequency);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1600;
  band.Q.value = 3;
  o.connect(band);
  band.connect(out);
  o.start(now);
  lfo.start(now);
  o.stop(now + duration + 0.4);
  lfo.stop(now + duration + 0.4);
}

/** A body hitting the floor. */
export function playBodyThud() {
  if (!ctx) return;
  const now = ctx.currentTime;
  tone('sine', 110, 40, now, 0.3, 0.8);
  burst('lowpass', 600, 0.8, now, 0.2, 0.5);
}

/** The Mecha coming apart: a chain of blasts and screeching metal. */
export function playMechExplosion() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (let i = 0; i < 4; i++) {
    const t = now + i * 0.28;
    tone('sine', 85 - i * 8, 18, t, 1.2, 0.8);
    burst('lowpass', 1400, 0.6, t, 0.9, 0.6);
  }
  burst('highpass', 2800, 0.6, now, 0.8, 0.25);
  playMetalTearAt(now + 0.5, 1.4);
}

function playMetalTearAt(at, duration) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(600, at);
  osc.frequency.linearRampToValueAtTime(240, at + duration);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1300;
  band.Q.value = 2.4;
  const gain = envelope(at, 0.08, 0.1, duration * 0.6, duration * 0.4);
  osc.connect(band);
  band.connect(gain);
  gain.connect(master);
  osc.start(at);
  osc.stop(at + duration + 0.2);
}

/** Knuckles rapping on glass. */
export function playKnock() {
  if (!ctx) return;
  const now = ctx.currentTime;
  [0, 0.16, 0.32].forEach((at) => {
    tone('triangle', 1500, 1100, now + at, 0.08, 0.08);
    burst('bandpass', 2400, 3, now + at, 0.03, 0.12);
  });
}

/** A rifle skidding across a gym floor. */
export function playFloorSkid(duration = 1) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f = burst('bandpass', 1100, 1.4, now, duration, 0.16, 0.02);
  f.frequency.exponentialRampToValueAtTime(500, now + duration);
}

/** Handcuffs ratcheting shut. */
export function playHandcuffs() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (let i = 0; i < 6; i++) burst('bandpass', 3400, 5, now + i * 0.045, 0.02, 0.18);
  tone('triangle', 2100, 1900, now + 0.3, 0.1, 0.06);
}

/** Phone keypad tones, then the ringback. */
export function playPhoneDial() {
  if (!ctx) return;
  const now = ctx.currentTime;
  [[941, 1336], [697, 1209], [697, 1209]].forEach(([a, b], i) => {
    const t = now + i * 0.22;
    [a, b].forEach((f) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = envelope(t, 0.05, 0.005, 0.12, 0.02);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.18);
    });
  });
  [0.9, 3.9].forEach((at) => {
    const t = now + at;
    [440, 480].forEach((f) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = envelope(t, 0.035, 0.02, 1.8, 0.05);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 1.95);
    });
  });
}

let policeSiren = null;
/** Police sirens arriving (a slow wail). On until stopPoliceSiren(). */
export function startPoliceSiren(volume = 0.05) {
  if (!ctx || policeSiren) return;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.setTargetAtTime(volume, now, 1.5);
  out.connect(master);
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 900;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.28;
  const d = ctx.createGain();
  d.gain.value = 320;
  lfo.connect(d);
  d.connect(o.frequency);
  o.connect(out);
  o.start(now);
  lfo.start(now);
  policeSiren = { out, o, lfo };
}

export function stopPoliceSiren() {
  if (!policeSiren) return;
  const s = policeSiren;
  policeSiren = null;
  const now = ctx.currentTime;
  s.out.gain.setTargetAtTime(0.0001, now, 0.6);
  s.o.stop(now + 3);
  s.lfo.stop(now + 3);
}

/** "Aw, what the heck!": a sad trombone wah-wah. */
export function playWahWah() {
  if (!ctx) return;
  const now = ctx.currentTime;
  [[311, 0], [294, 0.3], [277, 0.6], [262, 0.9]].forEach(([f, at], i) => {
    const dur = i === 3 ? 0.9 : 0.26;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, now + at);
    if (i === 3) {
      const vib = ctx.createOscillator();
      vib.frequency.value = 6;
      const vd = ctx.createGain();
      vd.gain.value = 8;
      vib.connect(vd);
      vd.connect(o.frequency);
      vib.start(now + at);
      vib.stop(now + at + dur + 0.1);
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = envelope(now + at, 0.07, 0.04, dur * 0.7, dur * 0.3);
    o.connect(lp);
    lp.connect(g);
    g.connect(master);
    o.start(now + at);
    o.stop(now + at + dur + 0.1);
  });
}

// ---- Credits music: an upbeat little synth tune (C - G - Am - F), sequenced live ----

let music = null;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// 8 bars of 16ths: the lead (MIDI note numbers, 0 = rest).
const LEAD = [
  76, 0, 79, 0, 84, 0, 79, 0, 81, 0, 79, 0, 76, 0, 74, 0,
  74, 0, 79, 0, 83, 0, 79, 0, 74, 0, 0, 0, 71, 0, 74, 0,
  72, 0, 76, 0, 81, 0, 76, 0, 84, 0, 83, 0, 81, 0, 76, 0,
  77, 0, 81, 0, 84, 0, 81, 0, 79, 0, 77, 0, 76, 0, 74, 0,
  79, 0, 0, 79, 81, 0, 79, 0, 76, 0, 0, 0, 72, 0, 76, 0,
  74, 0, 0, 74, 79, 0, 77, 0, 74, 0, 0, 0, 71, 0, 0, 0,
  76, 0, 0, 76, 81, 0, 79, 0, 76, 0, 72, 0, 69, 0, 72, 0,
  77, 0, 81, 0, 79, 0, 77, 0, 76, 0, 74, 0, 72, 0, 0, 0,
];
const CHORDS = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]]; // C, G, Am, F
const BASS = [36, 31, 33, 29];

function musicVoice(type, freq, t, dur, peak, filter = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  if (filter) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filter;
    o.connect(lp);
    lp.connect(g);
  } else {
    o.connect(g);
  }
  g.connect(music.out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function musicNoise(t, dur, peak, type, freq) {
  const src = noise();
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(music.out);
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur + 0.02);
}

function scheduleMusicStep(i, t, step) {
  const s = i % 16;
  const bar = Math.floor(i / 16) % 8;
  const chord = bar % 4;
  // Four on the floor, a clap on 2 and 4, bright offbeat hats.
  if (s % 4 === 0) {
    const k = ctx.createOscillator();
    k.frequency.setValueAtTime(150, t);
    k.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const kg = ctx.createGain();
    kg.gain.setValueAtTime(0.5, t);
    kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    k.connect(kg);
    kg.connect(music.out);
    k.start(t);
    k.stop(t + 0.2);
  }
  if (s === 4 || s === 12) musicNoise(t, 0.14, 0.22, 'bandpass', 1700);
  if (s % 2 === 0) musicNoise(t, 0.035, s % 4 === 2 ? 0.07 : 0.03, 'highpass', 7000);
  // Octave-bouncing bass on the 8ths.
  if (s % 2 === 0) musicVoice('square', midi(BASS[chord] + (s % 4 === 2 ? 12 : 0)), t, step * 1.7, 0.09, 700);
  // Chord stabs on the offbeats.
  if (s % 4 === 2) for (const n of CHORDS[chord]) musicVoice('triangle', midi(n + 12), t, step * 1.3, 0.03);
  const lead = LEAD[(bar * 16 + s) % LEAD.length];
  if (lead) musicVoice('square', midi(lead), t, step * 1.9, 0.035, 2600);
}

export function startCreditsMusic() {
  if (!ctx || music) return;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, ctx.currentTime);
  out.gain.setTargetAtTime(0.55, ctx.currentTime, 0.5);
  out.connect(master);
  const step = 60 / 126 / 4;
  music = { out, step, i: 0, next: ctx.currentTime + 0.15, timer: 0 };
  music.timer = setInterval(() => {
    if (!music) return;
    while (music.next < ctx.currentTime + 0.15) {
      scheduleMusicStep(music.i, music.next, step);
      music.next += step;
      music.i++;
    }
  }, 30);
}

export function stopCreditsMusic() {
  if (!music) return;
  const m = music;
  music = null;
  clearInterval(m.timer);
  m.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.6);
}

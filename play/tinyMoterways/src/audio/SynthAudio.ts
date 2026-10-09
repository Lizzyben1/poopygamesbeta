const SCALE = [0, 2, 4, 7, 9];   // major pentatonic: any overlap of notes stays consonant
const ROOT = 261.63;             // middle C

/** Every sound the game can make, by name. The sound-test panel and the self-check walk this list. */
export const SOUNDS = ['chime', 'pop', 'erase', 'deny', 'tick', 'alert', 'spawn', 'upgrade', 'gameOver', 'hum'] as const;
export type SoundName = (typeof SOUNDS)[number];

/** Every sound in the game, synthesised on the fly with the Web Audio API. No audio files. */
export class SynthAudio {
  muted = false;

  private make: () => AudioContext;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private echo!: DelayNode;
  private hum!: GainNode;
  private meter!: AnalyserNode;
  private scope = new Float32Array(1024);
  private lastChime = 0;

  /** `make` builds the audio context; tests pass a stand-in or an offline context. */
  constructor(make: () => AudioContext = () => new AudioContext()) {
    this.make = make;
  }

  /** Browsers only start audio after a user gesture, so call this from the first tap, click or key. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = this.make());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    // everything passes through the meter on its way out, so the sound test can show a level
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 1024;
    this.master.connect(this.meter).connect(ctx.destination);

    // a feedback delay gives the chimes a soft, spacious tail
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.27;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    this.echo.connect(feedback).connect(this.echo);
    this.echo.connect(this.master);

    // danger hum: a low wobbling drone, silent until a pin timer is running
    const drone = ctx.createOscillator(), wobble = ctx.createOscillator(), depth = ctx.createGain();
    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    drone.type = 'triangle';
    drone.frequency.value = 65;
    wobble.frequency.value = 3;
    depth.gain.value = 6;
    wobble.connect(depth).connect(drone.frequency);
    drone.connect(this.hum).connect(this.master);
    drone.start();
    wobble.start();
  }

  /** Stop producing sound while the page is hidden, and pick up again when it returns. */
  setActive(active: boolean) {
    if (!this.ctx) return;
    if (active) void this.ctx.resume();
    else void this.ctx.suspend();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  /** Play a sound by name: what the sound-test panel's buttons do. */
  play(name: SoundName) {
    if (name === 'chime') this.chime(Math.floor(Math.random() * 5), true);
    else if (name === 'hum') this.swell();
    else this[name]();
  }

  /** Peak level of what is being played right now, 0..1. Zero means silence is reaching the output. */
  level(): number {
    if (!this.ctx) return 0;
    this.meter.getFloatTimeDomainData(this.scope);
    let peak = 0;
    for (const v of this.scope) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  /** Whether the browser has let the audio context start. */
  get running() { return this.ctx?.state === 'running'; }

  /** A car collected a pin: one soft pentatonic note, its register tinted by the car's color. */
  chime(color: number, always = false) {
    const now = performance.now();
    if (!always && now - this.lastChime < 70) return;   // a burst of arrivals shouldn't turn into a buzz
    this.lastChime = now;
    const freq = this.note(5 + color + Math.floor(Math.random() * 4));
    this.tone(freq, 0.9, 'sine', 0.16, 0, true);
    this.tone(freq * 2, 0.45, 'triangle', 0.035, 0, true);
  }

  /** Road placed. */
  pop() { this.tone(540, 0.07, 'sine', 0.2, 0, false, 190); }

  /** Road removed. */
  erase() { this.tone(210, 0.09, 'triangle', 0.13, 0, false, 95); }

  /** An action wasn't allowed. */
  deny() { this.tone(130, 0.12, 'square', 0.05); }

  /** One low click per beat of a running overflow timer. */
  tick() { this.tone(95, 0.045, 'square', 0.07); }

  /** A destination just filled up. */
  alert() {
    this.tone(880, 0.25, 'triangle', 0.13, 0, true);
    this.tone(659.25, 0.45, 'triangle', 0.13, 0.17, true);
  }

  /** A new building appeared. */
  spawn() { this.tone(this.note(3), 0.3, 'sine', 0.06, 0, true); }

  /** Weekly upgrade: a rising arpeggio. */
  upgrade() { [0, 2, 4, 5, 7].forEach((step, i) => this.tone(this.note(step + 5), 0.5, 'triangle', 0.1, i * 0.08, true)); }

  gameOver() { [9, 7, 5, 2, 0].forEach((step, i) => this.tone(this.note(step), 1.1, 'sine', 0.16, i * 0.22, true)); }

  /** 0..1: how close the fullest destination is to ending the game. Drives the hum. */
  setDanger(level: number) {
    if (this.ctx) this.hum.gain.setTargetAtTime(level > 0 ? 0.04 + 0.1 * level : 0, this.ctx.currentTime, 0.2);
  }

  /** A second of the danger hum on its own, for the sound test. */
  private swell() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.hum.gain.cancelScheduledValues(t);
    this.hum.gain.setTargetAtTime(0.16, t, 0.05);
    this.hum.gain.setTargetAtTime(0, t + 1, 0.15);
  }

  private note(step: number) {
    return ROOT * 2 ** (Math.floor(step / 5) + SCALE[step % 5] / 12);
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.2, delay = 0, wet = false, slideTo = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master);
    if (wet) gain.connect(this.echo);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

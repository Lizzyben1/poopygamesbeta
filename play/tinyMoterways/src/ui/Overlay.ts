import { SOUNDS } from '../audio/SynthAudio.ts';
import type { SoundName } from '../audio/SynthAudio.ts';
import { COLORS, UPGRADES } from '../levels/CityConfigs.ts';
import type { CityConfig, Inventory, Tool, UpgradeOption } from '../types.ts';

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS: Record<string, string> = {
  pause: icon('<path d="M9 5v14M15 5v14"/>'),
  play: icon('<path d="M8 5l11 7-11 7z"/>'),
  fast: icon('<path d="M4 6l8 6-8 6zM13 6l8 6-8 6z"/>'),
  gear: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1"/>'),
  sound: icon('<path d="M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 010 6M19 6.5a8 8 0 010 11"/>'),
  soundOff: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 9.5l5 5M22 9.5l-5 5"/>'),
  moon: icon('<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>'),
  wave: icon('<path d="M3 12h2l2-6 4 12 3-9 2 5 2-2h3"/>'),
  home: icon('<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>'),
  car: icon('<path d="M3 16v-3l2-5h14l2 5v3zM3 13h18M6.5 16v2M17.5 16v2"/>'),
  warn: icon('<path d="M12 3l10 18H2zM12 10v5M12 18v.01"/>'),
  road: icon('<path d="M8 3L5 21M16 3l3 18M12 4v3M12 10.5v3M12 17v3"/>'),
  erase: icon('<path d="M20 20H9.5L4 14.5 13.5 5l7 7-8 8M8.5 10l6 6"/>'),
  motorway: icon('<path d="M2 15c5-9 15-9 20 0M7 10.5V20M17 10.5V20"/>'),
  roundabout: icon('<circle cx="12" cy="12" r="5.5"/><path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22"/>'),
  light: icon('<rect x="8" y="2" width="8" height="20" rx="3"/><path d="M12 7v.01M12 12v.01M12 17v.01"/>'),
  bridge: icon('<path d="M2 16h20M4 16V7M20 16V7M4 8c4 7 12 7 16 0M9 12.5V16M15 12.5V16"/>'),
  tunnel: icon('<path d="M2 20h20M4 20v-8a8 8 0 0116 0v8M9 20v-7a3 3 0 016 0v7"/>'),
};

const TOOLS: { tool: Tool; label: string; stock?: keyof Inventory }[] = [
  { tool: 'road', label: 'Road', stock: 'tiles' },
  { tool: 'erase', label: 'Erase' },
  { tool: 'motorway', label: 'Motorway', stock: 'motorways' },
  { tool: 'roundabout', label: 'Roundabout', stock: 'roundabouts' },
  { tool: 'light', label: 'Signal', stock: 'lights' },
];

// spent automatically when a road crosses water or rock, so shown as stock rather than as tools
const SPANS: { kind: 'bridge' | 'tunnel'; stock: keyof Inventory; hint: string }[] = [
  { kind: 'bridge', stock: 'bridges', hint: 'Bridges: one is used each time a road crosses water' },
  { kind: 'tunnel', stock: 'tunnels', hint: 'Tunnels: one is used each time a road crosses mountains or rail' },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const SOUND_LABELS: Record<SoundName, string> = {
  chime: 'Pin collected', pop: 'Road placed', erase: 'Road erased', deny: 'Not allowed', tick: 'Timer tick',
  alert: 'Destination full', spawn: 'New building', upgrade: 'Weekly delivery', gameOver: 'Game over', hum: 'Danger hum',
};

export interface HudState {
  city: string;
  day: number;
  dayProgress: number;   // 0..1 through the current day
  night: boolean;
  score: number;
  inv: Inventory;
  tool: Tool;
  speed: number;
  danger: boolean;
  muted: boolean;
  dark: boolean;
}

/** A destination's pin meter, positioned in screen pixels over the 3D scene. */
export interface Marker {
  id: number;
  x: number;
  y: number;
  color: number;
  pins: number;
  max: number;
  overflow: number;
}

export interface Handlers {
  speed(multiplier: number): void;
  tool(tool: Tool): void;
  mute(): void;
  dark(): void;
  start(city: CityConfig): void;
  choose(option: UpgradeOption): void;
  retry(): void;
  menu(): void;
  sound(name: SoundName): void;
  /** Current output level 0..1 and whether the audio context is running, for the sound test's meter. */
  level(): { peak: number; running: boolean };
}

/** The HTML layer over the canvas: HUD, toolbar, pin meters, settings and the dialogs. */
export class Overlay {
  private root: HTMLElement;
  private on: Handlers;
  private modalEl: HTMLElement;
  private markerRoot: HTMLElement;
  private weekBar: HTMLElement;
  private settings: HTMLElement;
  private markerEls = new Map<number, HTMLElement>();
  private cities: CityConfig[] = [];
  private options: UpgradeOption[] = [];
  private hudKey = '';
  private metering = 0;

  constructor(root: HTMLElement, on: Handlers) {
    this.root = root;
    this.on = on;
    root.innerHTML = `
      <div class="markers"></div>
      <div class="hud panel status">
        <div class="city"></div>
        <div class="clock"><i class="sky"></i><span></span></div>
        <div class="week"><i></i></div>
        <div class="tally">
          <div class="score" title="Trips completed">${ICONS.car}<b></b></div>
          ${SPANS.map(s => `<div class="chip" data-stock="${s.stock}" title="${s.hint}">${ICONS[s.kind]}<b></b></div>`).join('')}
        </div>
      </div>
      <div class="hud panel controls">
        <button data-act="speed:0" title="Pause (Space)" aria-label="Pause">${ICONS.pause}</button>
        <button data-act="speed:1" title="Normal speed (1)" aria-label="Normal speed">${ICONS.play}</button>
        <button data-act="speed:2" title="Fast (2)" aria-label="Fast">${ICONS.fast}</button>
        <span class="sep"></span>
        <button data-act="settings" title="Settings" aria-label="Settings" aria-expanded="false">${ICONS.gear}</button>
      </div>
      <div class="hud panel settings" hidden>
        <button data-act="mute"></button>
        <button data-act="dark"></button>
        <button data-act="sounds">${ICONS.wave}<span>Sound test</span></button>
        <button data-act="menu">${ICONS.home}<span>Change city</span></button>
      </div>
      <div class="hud banner">${ICONS.warn}<span>A destination is overflowing</span></div>
      <div class="hud panel toolbar">
        ${TOOLS.map(t => `
          <button class="tool" data-act="tool:${t.tool}" ${t.stock ? `data-stock="${t.stock}"` : ''} title="${t.label}" aria-label="${t.label}">
            ${ICONS[t.tool]}${t.stock ? '<b></b>' : ''}<span>${t.label}</span>
          </button>`).join('')}
      </div>
      <div class="hud hint">Drag to lay road · drag out of a house to turn its driveway · wheel or two fingers move the camera</div>
      <div class="modal"></div>`;
    this.modalEl = root.querySelector('.modal')!;
    this.markerRoot = root.querySelector('.markers')!;
    this.weekBar = root.querySelector('.week i')!;
    this.settings = root.querySelector('.settings')!;
    root.addEventListener('click', e => this.click(e));
  }

  // ---------- dialogs ----------

  menu(cities: CityConfig[]) {
    this.cities = cities;
    this.root.classList.add('idle');
    this.clearMarkers();
    this.modal(`
      <h1>Tiny Motorways</h1>
      <p class="sub">Draw roads. Keep the city moving.</p>
      <div class="cards">
        ${cities.map((c, i) => `
          <button class="card" data-act="city:${i}">
            <div class="head"><h3>${c.name}</h3><span class="level level-${c.difficulty.toLowerCase()}">${c.difficulty}</span></div>
            <p>${c.tagline}</p>
            <div class="chips">${c.colorUnlockDays.map((_, k) => `<i style="background:${COLORS[k]}"></i>`).join('')}</div>
          </button>`).join('')}
      </div>`);
  }

  /** A game is starting: show the HUD and drop whatever the last game left behind. */
  begin() {
    this.root.classList.remove('idle');
    this.clearMarkers();
    this.closeModal();
  }

  draft(week: number, options: UpgradeOption[]) {
    this.options = options;
    this.modal(`
      <p class="sub">Week ${week} complete</p>
      <h2>Choose this week's delivery</h2>
      <div class="cards">
        ${options.map((o, i) => `
          <button class="card" data-act="choose:${i}">
            <div class="big">${ICONS[o.kind]}</div>
            <h3>${UPGRADES[o.kind].name}</h3>
            <p>${UPGRADES[o.kind].blurb}</p>
            <div class="plus">${ICONS.road}+${o.tiles} road tiles</div>
          </button>`).join('')}
      </div>`);
  }

  gameOver(score: number, day: number, color: number) {
    this.modal(`
      <p class="sub">Gridlock</p>
      <h2>The city ground to a halt</h2>
      <p>A <b style="color:${COLORS[color]}">destination</b> waited too long for its cars.</p>
      <div class="stats">
        <div><b>${score}</b>trips</div>
        <div><b>${day + 1}</b>days</div>
        <div><b>${Math.floor(day / 7) + 1}</b>weeks</div>
      </div>
      <div class="row">
        <button class="btn" data-act="retry">Try again</button>
        <button class="btn quiet" data-act="menu">Change city</button>
      </div>`);
  }

  /** One button per sound, with a live meter of what is actually reaching the output. */
  private soundTest() {
    this.modal(`
      <p class="sub">Sound test</p>
      <h2>Tap a sound to hear it</h2>
      <div class="meter"><i></i></div>
      <p class="status-line"></p>
      <div class="sounds">${SOUNDS.map(n => `<button class="btn quiet" data-act="sound:${n}">${SOUND_LABELS[n]}</button>`).join('')}</div>
      <div class="row"><button class="btn" data-act="close">Done</button></div>`);
    const bar = this.modalEl.querySelector<HTMLElement>('.meter i')!, line = this.modalEl.querySelector<HTMLElement>('.status-line')!;
    let held = 0;
    const tick = () => {
      if (!bar.isConnected) return;
      const { peak, running } = this.on.level();
      held = Math.max(peak, held * 0.92);   // let the needle fall back slowly enough to read
      bar.style.width = `${Math.round(held * 100)}%`;
      line.textContent = !running ? 'Audio has not started yet: tap any sound.' : held > 0.01 ? 'Signal is reaching the output.' : 'Audio is running and silent.';
      this.metering = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.metering);
    tick();
  }

  // ---------- per-frame updates ----------

  hud(s: HudState) {
    this.weekBar.style.width = `${(((s.day % 7) + s.dayProgress) / 7) * 100}%`;
    const key = JSON.stringify(s, (k, v) => (k === 'dayProgress' ? undefined : v));
    if (key === this.hudKey) return;   // the rest only changes a few times a second
    this.hudKey = key;
    const q = (sel: string) => this.root.querySelector<HTMLElement>(sel)!;
    q('.city').textContent = s.city;
    q('.clock span').textContent = `Week ${Math.floor(s.day / 7) + 1} · ${DAYS[s.day % 7]}`;
    q('.sky').innerHTML = ICONS[s.night ? 'moon' : 'sun'];
    q('.score b').textContent = String(s.score);
    q('.banner').classList.toggle('show', s.danger);
    for (const el of this.root.querySelectorAll<HTMLElement>('.hud [data-act]')) {
      const [act, arg] = el.dataset.act!.split(':');
      if (act === 'tool') el.classList.toggle('on', arg === s.tool);
      if (act === 'speed') el.classList.toggle('on', Number(arg) === s.speed);
      // Rewritten only when the label changes: replacing a button's contents between press and release
      // swallows the click, which is what made these toggles miss while the score was ticking up.
      const label = act === 'mute' ? `${ICONS[s.muted ? 'soundOff' : 'sound']}<span>Sound ${s.muted ? 'off' : 'on'}</span>`
        : act === 'dark' ? `${ICONS[s.dark ? 'sun' : 'moon']}<span>${s.dark ? 'Light' : 'Dark'} mode</span>` : '';
      if (label && el.dataset.label !== label) el.innerHTML = el.dataset.label = label;
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-stock]')) {
      const n = s.inv[el.dataset.stock as keyof Inventory];
      el.querySelector('b')!.textContent = String(n);
      el.classList.toggle('empty', n === 0);
    }
  }

  markers(list: Marker[], cellPx: number) {
    this.markerRoot.style.setProperty('--cell', `${cellPx.toFixed(1)}px`);
    for (const m of list) {
      let el = this.markerEls.get(m.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'marker';
        el.style.setProperty('--c', COLORS[m.color]);
        el.innerHTML = '<svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r="17"/><circle class="fill" cx="20" cy="20" r="17" pathLength="100"/></svg><div class="pins"></div>';
        this.markerRoot.append(el);
        this.markerEls.set(m.id, el);
      }
      const state = [m.x.toFixed(1), m.y.toFixed(1), m.pins, Math.round(m.overflow * 200)].join();
      if (el.dataset.state === state) continue;
      el.dataset.state = state;
      el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
      el.classList.toggle('danger', m.overflow > 0);
      el.querySelector<SVGElement>('.fill')!.style.strokeDashoffset = String(100 - m.overflow * 100);
      const shown = Math.min(m.pins, m.max);
      el.querySelector('.pins')!.innerHTML = '<i class="on"></i>'.repeat(shown) + '<i></i>'.repeat(m.max - shown);
    }
  }

  /** Flash a toolbar entry when the player tries to spend something they don't have. */
  deny(stock: keyof Inventory) {
    const el = this.root.querySelector<HTMLElement>(`[data-stock="${stock}"]`)!;
    el.classList.remove('deny');
    void el.offsetWidth;   // restart the animation
    el.classList.add('deny');
  }

  // ---------- internals ----------

  private click(e: Event) {
    const el = (e.target as Element).closest<HTMLElement>('[data-act]');
    const [act, arg] = el?.dataset.act?.split(':') ?? [];
    if (act !== 'settings' && !this.settings.hidden && !(e.target as Element).closest('.settings')) this.toggleSettings(false);
    if (!el) return;
    el.blur();   // otherwise Space (pause) would also re-press the button
    if (act === 'tool') this.on.tool(arg as Tool);
    else if (act === 'speed') this.on.speed(Number(arg));
    else if (act === 'settings') this.toggleSettings(this.settings.hidden);
    else if (act === 'mute') this.on.mute();
    else if (act === 'dark') this.on.dark();
    else if (act === 'sounds') this.soundTest();
    else if (act === 'sound') this.on.sound(arg as SoundName);
    else if (act === 'close') this.closeModal();
    else if (act === 'city') this.on.start(this.cities[Number(arg)]);
    else if (act === 'retry') this.on.retry();
    else if (act === 'menu') this.on.menu();
    else if (act === 'choose') {
      this.closeModal();
      this.on.choose(this.options[Number(arg)]);
    }
    if (['sounds', 'menu'].includes(act)) this.toggleSettings(false);
  }

  private toggleSettings(open: boolean) {
    this.settings.hidden = !open;
    this.root.querySelector('[data-act="settings"]')!.setAttribute('aria-expanded', String(open));
  }

  private modal(html: string) {
    this.modalEl.innerHTML = `<div class="sheet panel" role="dialog" aria-modal="true">${html}</div>`;
    this.modalEl.classList.add('show');
  }

  private closeModal() {
    this.modalEl.classList.remove('show');
    this.modalEl.innerHTML = '';
  }

  private clearMarkers() {
    this.markerEls.clear();
    this.markerRoot.innerHTML = '';
  }
}

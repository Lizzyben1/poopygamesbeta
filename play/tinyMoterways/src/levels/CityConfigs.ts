import type { CityConfig, Inventory, UpgradeKind } from '../types.ts';

export const COLORS = ['#E74C3C', '#3498DB', '#F1C40F', '#2ECC71', '#9B59B6'];

export const UPGRADES: Record<UpgradeKind, { slot: keyof Inventory; name: string; blurb: string }> = {
  motorway: { slot: 'motorways', name: 'Motorway', blurb: 'An elevated flyover, four cells or longer. Crossing water also takes a bridge.' },
  roundabout: { slot: 'roundabouts', name: 'Roundabout', blurb: 'A 3×3 one-way rotary. Roads join from any side and cars give way on entry.' },
  light: { slot: 'lights', name: 'Traffic Light', blurb: 'Signals a busy junction so whole queues cross at once.' },
  bridge: { slot: 'bridges', name: 'Bridge', blurb: 'Carries one straight road across water.' },
  tunnel: { slot: 'tunnels', name: 'Tunnel', blurb: 'Carries one straight road through mountains or under a railway.' },
};

const TOKYO: CityConfig = {
  id: 'tokyo',
  name: 'Tokyo',
  difficulty: 'Normal',
  tagline: 'Tight blocks, colors arriving fast, and railway lines that cut the city apart.',
  width: 34,
  height: 22,
  features: [
    { terrain: 'water', path: [[6, -1], [8, 6], [5, 13], [7, 22]], width: 1.7 },   // Sumida river
    { terrain: 'water', path: [[28, 21], [34, 16]], width: 5 },                    // Tokyo Bay
    { terrain: 'mountain', path: [[30, 1], [32, 3]], width: 2 },
    { terrain: 'rail', path: [[-1, 6], [34, 6]], width: 1 },                       // Shinkansen, east-west
    { terrain: 'rail', path: [[22, 6], [22, 22]], width: 1 },                      // loop line, north-south
    // level crossings: the only free ways through the rail corridors
    { terrain: 'ground', path: [[2, 6]], width: 1 },
    { terrain: 'ground', path: [[13, 6]], width: 1 },
    { terrain: 'ground', path: [[18, 6]], width: 1 },
    { terrain: 'ground', path: [[27, 6]], width: 1 },
    { terrain: 'ground', path: [[22, 11]], width: 1 },
    { terrain: 'ground', path: [[22, 17]], width: 1 },
  ],
  palette: { ground: '#F4F1EA', water: '#A9D6E5', bank: '#E6E1D5', channel: 1 },
  start: { tiles: 34, bridges: 1, tunnels: 1, motorways: 0, roundabouts: 0, lights: 1 },
  weeklyTiles: [22, 26],
  upgradeWeights: { motorway: 1, roundabout: 3, light: 3, bridge: 2, tunnel: 3 },
  colorUnlockDays: [0, 3, 8, 14, 21],
  spawn: { interval: 7.5, houseDist: [3, 7], destSpacing: 3, startArea: 0.4, areaPerDay: 0.02, destEveryDays: 6, housesPerDest: [2, 4] },
  demand: { pinInterval: 6.5, weeklyFactor: 0.92, minInterval: 1.2, maxPins: [6, 7], overflowSeconds: 28 },
};

const LOS_ANGELES: CityConfig = {
  id: 'los-angeles',
  name: 'Los Angeles',
  difficulty: 'Normal',
  tagline: 'Sprawling suburbs split from downtown by wide concrete river channels.',
  width: 44,
  height: 26,
  features: [
    { terrain: 'water', path: [[15, -1], [13, 8], [16, 17], [13, 27]], width: 2.4 },   // LA River
    { terrain: 'water', path: [[30, -1], [32, 9], [29, 18], [31, 27]], width: 2.4 },   // San Gabriel channel
    { terrain: 'mountain', path: [[19, 1], [26, 0]], width: 2.2 },                     // Hollywood Hills
    { terrain: 'mountain', path: [[38, 13], [43, 11]], width: 2 },
  ],
  zones: {
    commercial: [
      { x: 18, y: 6, w: 10, h: 14 },                                                   // downtown, between the channels
      { x: 3, y: 10, w: 4, h: 5 }, { x: 37, y: 4, w: 4, h: 5 },                        // Santa Monica, Pasadena
    ],
    residential: [
      { x: 18, y: 3, w: 10, h: 3 }, { x: 18, y: 20, w: 10, h: 5 },                     // inner neighbourhoods
      { x: 1, y: 2, w: 9, h: 22 }, { x: 35, y: 2, w: 8, h: 22 },                       // suburbs across the water
    ],
  },
  palette: { ground: '#F2ECDD', water: '#9FCBD6', bank: '#CFCAC0', channel: 0.55 },
  start: { tiles: 44, bridges: 2, tunnels: 0, motorways: 1, roundabouts: 0, lights: 0 },
  weeklyTiles: [26, 30],
  upgradeWeights: { motorway: 4, roundabout: 2, light: 2, bridge: 4, tunnel: 1 },
  colorUnlockDays: [0, 5, 11, 18, 27],
  spawn: { interval: 8, houseDist: [5, 16], destSpacing: 3, startArea: 0.45, areaPerDay: 0.02, destEveryDays: 7, housesPerDest: [2, 4.5] },
  demand: { pinInterval: 7.5, weeklyFactor: 0.91, minInterval: 1.5, maxPins: [7, 8], overflowSeconds: 35 },
};

// Harder than the first two: less road each week, demand that climbs faster, fuller car parks that
// overflow sooner, and terrain that cannot be crossed without the one upgrade that is always scarce.
const RIO: CityConfig = {
  id: 'rio',
  name: 'Rio de Janeiro',
  difficulty: 'Hard',
  tagline: 'Neighbourhoods squeezed between granite ridges and the sea. Every tunnel counts.',
  width: 38,
  height: 24,
  features: [
    { terrain: 'water', path: [[-1, 23], [38, 23]], width: 3.4 },                     // the Atlantic
    { terrain: 'water', path: [[37, -1], [33, 7], [36, 14], [38, 20]], width: 5 },    // Guanabara Bay
    { terrain: 'water', path: [[13, 17], [15, 17]], width: 3 },                       // Lagoa
    { terrain: 'mountain', path: [[5, 5], [12, 8], [19, 7], [25, 9]], width: 2.6 },   // Tijuca massif
    { terrain: 'mountain', path: [[19, 7], [20, 13]], width: 2 },                     // the spur down to Corcovado
    { terrain: 'mountain', path: [[24, 16], [29, 18]], width: 2.2 },                  // Sugarloaf
    { terrain: 'mountain', path: [[2, 15], [7, 17]], width: 2.2 },                    // Dois Irmaos
  ],
  palette: { ground: '#F3EEDF', water: '#8FCFD8', bank: '#EADFC2', channel: 1 },
  start: { tiles: 36, bridges: 0, tunnels: 1, motorways: 0, roundabouts: 0, lights: 1 },
  weeklyTiles: [20, 24],
  upgradeWeights: { motorway: 2, roundabout: 2, light: 2, bridge: 1, tunnel: 4 },
  colorUnlockDays: [0, 3, 8, 13, 19],
  spawn: { interval: 7, houseDist: [3, 7], destSpacing: 3, startArea: 0.42, areaPerDay: 0.02, destEveryDays: 6, housesPerDest: [2, 3.8] },
  demand: { pinInterval: 6.2, weeklyFactor: 0.91, minInterval: 1.1, maxPins: [5, 6], overflowSeconds: 26 },
};

const STOCKHOLM: CityConfig = {
  id: 'stockholm',
  name: 'Stockholm',
  difficulty: 'Expert',
  tagline: 'A city of islands. Colors arrive early, bridges late, and there is never enough road.',
  width: 40,
  height: 26,
  features: [
    { terrain: 'water', path: [[-1, 10], [10, 12], [20, 9], [30, 12], [41, 9]], width: 2.4 },   // Malaren to the Baltic
    { terrain: 'water', path: [[20, 9], [18, 17], [22, 27]], width: 2.2 },                      // Arstaviken
    { terrain: 'water', path: [[30, 12], [28, 20], [33, 27]], width: 2.2 },                     // Hammarby
    { terrain: 'water', path: [[13, -1], [11, 5], [10, 12]], width: 2 },                        // Karlberg canal
    { terrain: 'water', path: [[29, -1], [31, 6], [30, 12]], width: 2 },                        // Djurgarden strait
    { terrain: 'ground', path: [[24, 10], [26, 10]], width: 1.6 },                              // Gamla Stan, an island mid-channel
    { terrain: 'mountain', path: [[3, 20], [7, 22]], width: 2 },
    { terrain: 'rail', path: [[36, 13], [36, 27]], width: 1 },
    { terrain: 'ground', path: [[36, 18]], width: 1 },                                          // level crossing
  ],
  palette: { ground: '#EEF0E8', water: '#8DB9D6', bank: '#DDE2D6', channel: 1 },
  start: { tiles: 32, bridges: 2, tunnels: 0, motorways: 0, roundabouts: 0, lights: 0 },
  weeklyTiles: [18, 22],
  upgradeWeights: { motorway: 2, roundabout: 2, light: 2, bridge: 5, tunnel: 1 },
  colorUnlockDays: [0, 3, 6, 10, 15],
  spawn: { interval: 6.5, houseDist: [3, 7], destSpacing: 3, startArea: 0.4, areaPerDay: 0.02, destEveryDays: 6, housesPerDest: [2, 3.6] },
  demand: { pinInterval: 5.5, weeklyFactor: 0.88, minInterval: 1, maxPins: [5, 6], overflowSeconds: 21 },
};

/** Add a city by appending its config here; nothing else needs to change. */
export const CITIES: CityConfig[] = [TOKYO, LOS_ANGELES, RIO, STOCKHOLM];

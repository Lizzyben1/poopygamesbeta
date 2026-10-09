// ---------- Grid & road graph ----------

export type Terrain = 'ground' | 'water' | 'mountain' | 'rail';
/** `drive` links join a building to the road: a house driveway or a car-park entrance. */
export type EdgeKind = 'road' | 'motorway' | 'ring' | 'drive';
export type BuildingKind = 'house' | 'dest';

export interface Vec3 { x: number; y: number; z: number }

/** A point on a driving path plus the direction of travel (rotation about Y). */
export interface PathSample extends Vec3 { heading: number }

/** One edge of the road graph. Both end nodes hold the same object. */
export interface Link {
  kind: EdgeKind;
  /** Erased by the player but still carrying cars; it is removed (and refunded) once empty. */
  closing: boolean;
}

export interface RoadNode {
  id: number;                    // cell index: y * width + x
  x: number;                     // world position; the cell centre except on roundabouts
  y: number;
  links: Map<number, Link>;      // neighbouring node id -> the edge between them
  paid: boolean;                 // consumed a road tile (refunded on erase)
  span: number;                  // id of the bridge/tunnel this cell belongs to, -1 if none
  ring: number;                  // id of the roundabout this cell belongs to, -1 if none
  light: boolean;
  building: BuildingKind | null;
}

/** One bridge or tunnel item: a single straight run of cells along a grid axis. */
export interface Span {
  slot: 'bridges' | 'tunnels';
  axis: number;                  // 0 = east-west, 1 = north-south
}

/**
 * A stretch of one lane, sampled as a polyline with cumulative lengths. Cars with the same `key`
 * are on the same piece and queue nose to tail along it.
 */
export interface Piece {
  key: number;
  kind: 'stub' | 'run' | 'turn' | 'lot';
  /** A turn is the movement from -> node -> to. Runs and stubs lie on the edge from -> to (node = from). */
  from: number;
  node: number;
  to: number;
  length: number;
  limit: number;                 // speed multiplier while on this piece
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  h: Float32Array;               // heading at each sample
  c: Float32Array;               // distance from the start at each sample
}

export interface Inventory {
  tiles: number;
  bridges: number;
  tunnels: number;
  motorways: number;
  roundabouts: number;
  lights: number;
}

export type Tool = 'road' | 'erase' | 'motorway' | 'roundabout' | 'light';

// ---------- Entities ----------

export interface House {
  id: number;
  cell: number;
  color: number;
  cars: number;       // cars currently in the garage (each house owns 2)
  facing: number;     // the neighbouring cell its driveway points at
}

/** One marked space in a destination's car park. */
export interface Bay extends PathSample {
  car: Car | null;    // the car parked in it or on its way to it
}

export interface Destination {
  id: number;
  cell: number;       // the car-park cell just inside the entrance; this is its graph node
  entry: number;      // the road cell outside the entrance
  cells: number[];    // every cell of the footprint
  lot: number[];      // the footprint cells that are car park rather than building
  color: number;
  pins: number;       // waiting demand
  assigned: number;   // pins that already have a car on the way
  maxPins: number;
  overflow: number;   // 0..1 progress of the game-over timer
  pinIn: number;      // seconds until the next pin appears
  bays: Bay[];
  /** The one car driving in to its bay, and the one driving out. Their lanes inside never meet. */
  entering: Car | null;
  leaving: Car | null;
}

export type CarState = 'toDest' | 'parked' | 'toHome';

export interface Car {
  id: number;
  color: number;
  house: House;
  dest: Destination;
  state: CarState;
  route: number[];    // node ids from start building to goal building
  path: Piece[];      // the lane pieces that route is driven along
  offs: number[];     // distance along the path at which each piece starts
  pi: number;         // index of the piece the car is on
  s: number;          // distance along that piece
  d: number;          // distance along the whole path (offs[pi] + s)
  v: number;          // cells per second
  move: number;       // distance planned for the current step
  clear: number;      // route index of the furthest turn this car holds right of way for
  owed: { node: number; until: number }[];   // the holds it has yet to give up, and how far along its path each lasts
  ask: number;        // route index of the turn it is currently asking for, -1 if none
  wait: number;       // seconds spent asking; the longest wait goes first
  lead: Car | null;   // the car directly ahead on its path
  gap: number;        // distance to that car along the path
  timer: number;      // parking countdown
  bay: number;        // index of its car-park space, -1 if none
  pos: PathSample;
}

// ---------- City configuration ----------

/** A stroke of terrain: every cell within width/2 of the polyline. Later features override earlier ones. */
export interface TerrainFeature {
  terrain: Terrain;
  path: [number, number][];
  width: number;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface CityConfig {
  id: string;
  name: string;
  tagline: string;
  /** Shown on the city's card in the menu. */
  difficulty: 'Normal' | 'Hard' | 'Expert';
  width: number;
  height: number;
  features: TerrainFeature[];
  /** Optional zoning: houses only spawn in residential rects, destinations in commercial ones. */
  zones?: { residential: Rect[]; commercial: Rect[] };
  /** `channel` is the painted water width in cells; below 1 leaves a concrete bank showing. */
  palette: { ground: string; water: string; bank: string; channel: number };
  start: Inventory;
  weeklyTiles: [number, number];
  upgradeWeights: Record<UpgradeKind, number>;
  /** Day on which each color (by index) starts appearing. */
  colorUnlockDays: number[];
  spawn: {
    interval: number;                 // seconds between spawn events
    houseDist: [number, number];      // cells between a house and its nearest matching destination
    destSpacing: number;              // minimum gap around a destination
    startArea: number;                // fraction of the map in play on day 0
    areaPerDay: number;
    destEveryDays: number;            // one extra destination allowed per this many days
    housesPerDest: [number, number];  // supply target, opening value and cap
  };
  demand: {
    pinInterval: number;              // seconds between pins in week 1
    weeklyFactor: number;             // interval multiplier per week (< 1 = harder)
    minInterval: number;
    maxPins: [number, number];
    overflowSeconds: number;          // how long a full destination survives
  };
}

// ---------- Upgrades & events ----------

export type UpgradeKind = 'motorway' | 'roundabout' | 'light' | 'bridge' | 'tunnel';

export interface UpgradeOption {
  kind: UpgradeKind;
  tiles: number;      // road tiles bundled with the pick
}

export type GameEvent =
  | { type: 'deliver'; color: number }
  | { type: 'spawn'; kind: BuildingKind }
  | { type: 'overflow' }
  | { type: 'week'; options: UpgradeOption[] }
  | { type: 'gameOver'; dest: Destination };

export type Emit = (event: GameEvent) => void;

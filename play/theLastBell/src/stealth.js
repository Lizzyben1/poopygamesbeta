import * as THREE from 'three';
import { playWhistle, playCaughtStinger } from './audio.js';
import { difficulty } from './difficulty.js';

// ---- Tunables -------------------------------------------------------------
const VISION_HALF_ANGLE = THREE.MathUtils.degToRad(36); // a coach's field of view (half-angle)
const BEAM_HALF_ANGLE = THREE.MathUtils.degToRad(20); // flashlight cone (half-angle)
const BEAM_LENGTH = 16; // the visible flashlight cone
const BEAM_REACH = 18; // caught-in-the-light range (the light pool spills a little past the cone)
const SIGHT_RANGE = BEAM_LENGTH * 3; // out of the light he can still make you out: 3x the flashlight's length
const FLASHLIGHT_RANGE_MULT = 2; // the player's own flashlight makes them 2x easier to spot
const CROUCH_SIGHT_MULT = 0.6; // a crouched shape is harder to pick out of the dark
const BUMP_RADIUS = 1.2; // walked straight into him

// Hearing (off the practice loop): how close you can get before a coach hears you.
const HEAR_STILL = 2.0;
const HEAR_CROUCH_STILL = 1.6;
const HEAR_CROUCH_WALK = 3.5;
const HEAR_WALK = 6.5;
const HEAR_SPRINT = 11;

const DECAY_PER_SEC = 0.35;
const HEARD_HOLD = 2.6; // seconds a coach keeps listening toward a noise
const HEARD_STARTLE = 0.5; // the "huh?" beat before he starts turning
const HEARD_TURN_RATE = 2.2; // slower than normal, so you have a moment to slip away
const SEARCH_TIME = 3.2; // looking around the spot where he saw you
const INVESTIGATE_STOP_SHORT = 2.5; // stop a little before the spot (not inside the cover you hid behind)

const PATROL_SPEED = 1.7;
const TO_ROUTE_SPEED = 2.2;
const INVESTIGATE_SPEED = 2.4;
const CHASE_SPEED = 7.8;
const LIGHT_INTENSITY = 60;
const PRACTICE_MARGIN = 0.7; // meters beyond the loop's edge that still count as "on the loop"

const STANDING_TARGETS = [1.6, 1.0]; // head + chest heights a coach tries to see
const CROUCHED_TARGETS = [0.95, 0.55];

/** Chapter 1's detection numbers (Chapter 3 scales its coaches' vision from these). */
export const CH1_VISION = {
  visionHalfAngle: VISION_HALF_ANGLE,
  beamHalfAngle: BEAM_HALF_ANGLE,
  beamLength: BEAM_LENGTH,
  beamReach: BEAM_REACH,
  sightRange: SIGHT_RANGE,
  flashlightMult: FLASHLIGHT_RANGE_MULT,
  crouchMult: CROUCH_SIGHT_MULT,
  hearing: { still: HEAR_STILL, crouchStill: HEAR_CROUCH_STILL, crouchWalk: HEAR_CROUCH_WALK, walk: HEAR_WALK, sprint: HEAR_SPRINT },
  standingTargets: STANDING_TARGETS,
  crouchedTargets: CROUCHED_TARGETS,
  lightIntensity: LIGHT_INTENSITY,
};

function dampAngle(current, target, t) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ---------------------------------------------------------------------------
// Volumetric-style flashlight beam
// ---------------------------------------------------------------------------
// An open cone with an additive shader instead of a flat solid: brightness
// falls off along the beam, edge-on surfaces (the silhouette) fade out so it
// reads as a glowing volume, and thin rain streaks glint as they fall through it.

const BEAM_VERTEX = /* glsl */ `
  uniform float uLength;
  varying float vAlong;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  void main() {
    vAlong = position.z / uLength;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  varying float vAlong;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float facing = abs(dot(normalize(vNormalW), viewDir));
    float body = pow(facing, 1.5);
    float along = clamp(vAlong, 0.0, 1.0);
    float falloff = pow(1.0 - along, 1.6) * smoothstep(0.0, 0.05, along);

    // Thin, sparse falling streaks: raindrops catching the light.
    vec2 cell = floor(vWorldPos.xz * 40.0);
    float h = hash(cell);
    float fall = fract(vWorldPos.y * 0.9 + uTime * (1.6 + h * 1.4) + h * 17.0);
    float glint = smoothstep(0.0, 0.015, fall) * (1.0 - smoothstep(0.015, 0.09, fall)) * step(0.9, h);
    float shimmer = 0.9 + 0.1 * sin(uTime * 2.3 + along * 9.0);

    float a = uIntensity * falloff * (body * shimmer + glint * 0.6);
    gl_FragColor = vec4(uColor, a);
  }
`;

export function createBeamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xfff1d0) },
      uIntensity: { value: 0.32 },
      uTime: { value: 0 },
      uLength: { value: BEAM_LENGTH },
    },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function createBeamGeometry() {
  const geo = new THREE.ConeGeometry(Math.tan(BEAM_HALF_ANGLE) * BEAM_LENGTH, BEAM_LENGTH, 32, 1, true);
  geo.rotateX(-Math.PI / 2); // apex toward -Z...
  geo.translate(0, 0, BEAM_LENGTH / 2); // ...then apex at the origin, opening along +Z
  return geo;
}

export function createGlareTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,250,235,1)');
  g.addColorStop(0.2, 'rgba(255,240,200,0.55)');
  g.addColorStop(1, 'rgba(255,230,180,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** "?" / "!" billboard shown above an alerted coach's head. */
export function createMarkTexture(char, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 54px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(15,15,15,0.9)';
  ctx.strokeText(char, 32, 35);
  ctx.fillStyle = color;
  ctx.fillText(char, 32, 35);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// One patrolling coach
// ---------------------------------------------------------------------------

class Guard {
  constructor({ system, scene, def }) {
    this.system = system;
    this.id = def.id;
    this.name = def.name;
    this.callout = def.callout;
    this.coach = def.character;
    this.route = def.route;

    this.patrolling = false; // run the patrol state machine (also as ambience in the ending)
    this.detecting = false; // looking/listening for the player
    // off | toRoute | patrol | pause | heard | investigate | search | chase | frozen
    this.state = 'off';
    this.suspicion = 0; // only rises while you're caught in his flashlight beam
    this.visible = false;
    this.litUp = false;
    this.waypoint = 0;
    this.pauseTimer = 0;
    this.stateTimer = 0;
    this.turnDelay = 0;
    this.aimYaw = this.coach.mesh.rotation.y;
    this.aimOverride = null; // Vector3 to point the flashlight at (cutscenes)
    this.lastSeen = new THREE.Vector3();
    this.noiseAt = new THREE.Vector3();
    this.investigateTarget = new THREE.Vector3();
    this._pauseBaseYaw = 0;
    this._sweepTarget = new THREE.Vector3();
    this._lightPos = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
    this._timeOffset = Math.random() * 10;
    this.markKind = null;
    this.markPop = 0;

    this._buildFlashlight(scene);
    this._buildMark(scene);
  }

  _buildFlashlight(scene) {
    const prop = new THREE.Group();
    prop.add(
      new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.045, 0.24, 8),
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.4 }),
      ),
    );
    this.lens = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    this.lens.position.y = -0.121;
    this.lens.rotation.x = Math.PI / 2;
    prop.add(this.lens);
    prop.position.y = -0.06;
    this.coach.mesh.userData.rig.handR.add(prop);
    this.prop = prop;

    this.light = new THREE.SpotLight(0xfff1d0, 0, 34, BEAM_HALF_ANGLE, 0.45, 1.1);
    this.lightTarget = new THREE.Object3D();
    this.light.target = this.lightTarget;
    scene.add(this.light, this.lightTarget);

    this.beam = new THREE.Mesh(this.system.beamGeometry, this.system.beamMaterial);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    // Lens glare: blinding when the flashlight points your way.
    this.glare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.system.glareTexture,
        color: 0xfff4dc,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.glare.visible = false;
    scene.add(this.glare);
  }

  _buildMark(scene) {
    // Drawn on top of everything so you can tell a coach is alerted even from behind cover.
    this.mark = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.system.questionTex, transparent: true, depthTest: false, depthWrite: false, fog: false }),
    );
    this.mark.renderOrder = 999;
    this.mark.visible = false;
    scene.add(this.mark);
  }

  // ---- Control -------------------------------------------------------------

  start() {
    this.patrolling = true;
    this.detecting = true;
    this.suspicion = 0;
    this.waypoint = 0;
    this.state = 'toRoute';
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this.coach.moveTo(this.route[0].x, this.route[0].z, TO_ROUTE_SPEED * difficulty.coachSpeedMult);
    this.aimYaw = this.coach.mesh.rotation.y;
    this.lightOn();
  }

  /** Stop looking for the player (keeps patrolling as scenery). */
  stopDetecting() {
    this.detecting = false;
    this.suspicion = 0;
    this.visible = false;
    this.litUp = false;
    if (['heard', 'investigate', 'search', 'chase', 'frozen'].includes(this.state)) this._resumePatrol();
  }

  /** A cutscene takes direct control of this coach. */
  takeover() {
    this.patrolling = false;
    this.detecting = false;
    this.suspicion = 0;
    this.litUp = false;
    this.state = 'off';
    this.coach.turnRate = 5;
  }

  /** Another coach is chasing the player: stop and stare. */
  freeze() {
    this.state = 'frozen';
    this.coach.stop();
    this.coach.turnRate = 5;
    this.coach.faceTowards(this.system.player.object.position);
  }

  resetTo(index) {
    const wp = this.route[index];
    this.coach.stop();
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this.coach.mesh.position.set(wp.x, 0, wp.z);
    this.waypoint = index;
    this.suspicion = 0;
    this.visible = false;
    this.litUp = false;
    this.patrolling = true;
    this.detecting = true;
    this._enterPause(1.0);
    this.aimYaw = this.coach.mesh.rotation.y;
  }

  lightOn() {
    this.light.intensity = LIGHT_INTENSITY;
    this.beam.visible = true;
    this.glare.visible = true;
    this.lens.material.color.set(0xfff6dc);
    this.coach.mesh.userData.rig.holdingFlashlight = true;
  }

  lightOff() {
    this.light.intensity = 0;
    this.beam.visible = false;
    this.glare.visible = false;
    this.lens.material.color.set(0x333333);
    this.coach.mesh.userData.rig.holdingFlashlight = false;
  }

  // ---- Per-frame -----------------------------------------------------------

  update(dt, input) {
    if (this.patrolling) this._think(dt, input);
    this._updateAim(dt);
    this._updateFlashlight();
    this._updateMark(dt);
  }

  _think(dt, input) {
    const coach = this.coach;
    const cpos = coach.position;
    const ppos = this.system.player.object.position;
    this.litUp = false;

    // ---- Behaviour timers ----------------------------------------------
    switch (this.state) {
      case 'toRoute':
      case 'patrol':
        if (coach.mode === 'idle') this._enterPause(this.route[this.waypoint].pause);
        break;
      case 'pause':
        this.pauseTimer -= dt;
        this._sweep(0.9, 0.9);
        if (this.pauseTimer <= 0) this._advanceWaypoint();
        break;
      case 'heard':
        // "Huh?" ...then he slowly turns toward the sound.
        this.turnDelay -= dt;
        if (this.turnDelay <= 0 && coach.faceTarget !== this.noiseAt) coach.faceTowards(this.noiseAt);
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this._resumePatrol();
        break;
      case 'investigate':
        if (coach.mode === 'idle') this._enterSearch();
        break;
      case 'search':
        this.stateTimer -= dt;
        this._sweep(1.3, 1.4);
        if (this.stateTimer <= 0) this._resumePatrol(); // nothing there: back to his rounds
        break;
      case 'chase': {
        const d = Math.hypot(ppos.x - cpos.x, ppos.z - cpos.z);
        if (d < 1.3) this.system._tackled(this);
        return;
      }
      case 'frozen':
        return;
      default:
        break;
    }

    if (!this.detecting) {
      this.visible = false;
      return;
    }

    const safe = this.system.playerSafe; // jogging the practice loop with the team
    const dist = Math.hypot(ppos.x - cpos.x, ppos.z - cpos.z);
    if (!safe && dist < BUMP_RADIUS) {
      this._beginChase();
      return;
    }

    const sight = this.system.canSee(this, cpos, ppos, input);
    this.visible = sight.visible && !safe;

    // 1) Caught in his flashlight beam: suspicion climbs fast -> whistle + chase.
    if (this.visible && sight.inBeam) {
      this.litUp = true;
      this.lastSeen.set(ppos.x, 0, ppos.z);
      let rate = (0.45 + sight.proximity * 1.9) * 1.8;
      if (input.sprinting) rate *= 1.35;
      if (input.crouching) rate *= 0.55;
      this.suspicion = Math.min(1, this.suspicion + rate * dt);
      if (this.suspicion >= 1) {
        this._beginChase();
        return;
      }
      this._investigate(this.lastSeen); // keep the light on you and close in
      return;
    }
    this.suspicion = Math.max(0, this.suspicion - DECAY_PER_SEC * dt);

    // 2) Seen outside the light (up to 3x the flashlight's length): "?" and go take a look.
    if (this.visible) {
      this.lastSeen.set(ppos.x, 0, ppos.z);
      this._investigate(this.lastSeen);
      return;
    }

    // 3) Heard nearby, unless you're out running with the team: "?" and turn toward you.
    if (!safe && this._hears(dist, input)) {
      this.noiseAt.set(ppos.x, 0, ppos.z);
      if (this.state === 'toRoute' || this.state === 'patrol' || this.state === 'pause') this._enterHeard();
      else if (this.state === 'heard') this.stateTimer = HEARD_HOLD; // still hearing you: keep listening
      else if (this.state === 'search') this._investigate(this.noiseAt);
    }
  }

  _hears(dist, { moving, crouching, sprinting }) {
    let radius;
    if (!moving) radius = crouching ? HEAR_CROUCH_STILL : HEAR_STILL;
    else if (crouching) radius = HEAR_CROUCH_WALK;
    else if (sprinting) radius = HEAR_SPRINT;
    else radius = HEAR_WALK;
    return dist < radius;
  }

  _enterHeard() {
    this.state = 'heard';
    this.stateTimer = HEARD_HOLD;
    this.turnDelay = HEARD_STARTLE;
    this.coach.stop();
    this.coach.faceTowards(null);
    this.coach.turnRate = HEARD_TURN_RATE;
  }

  /** Walk over to take a look (stopping a little short), flashlight aimed at the spot. */
  _investigate(target) {
    const cpos = this.coach.position;
    this.investigateTarget.set(target.x, 0, target.z);
    if (this.state !== 'investigate') {
      this.state = 'investigate';
      this.coach.turnRate = 5;
      this.coach.faceTowards(null);
    }
    const dx = target.x - cpos.x;
    const dz = target.z - cpos.z;
    const d = Math.hypot(dx, dz);
    if (d > INVESTIGATE_STOP_SHORT + 0.3) {
      const k = (d - INVESTIGATE_STOP_SHORT) / d;
      this.coach.moveTo(cpos.x + dx * k, cpos.z + dz * k, INVESTIGATE_SPEED * difficulty.coachSpeedMult);
    } else if (this.coach.mode !== 'idle') {
      this.coach.stop();
    }
  }

  _enterSearch() {
    const cpos = this.coach.position;
    this.state = 'search';
    this.stateTimer = SEARCH_TIME;
    this._pauseBaseYaw = Math.atan2(this.investigateTarget.x - cpos.x, this.investigateTarget.z - cpos.z);
    this._sweepTarget.copy(cpos);
    this.coach.faceTowards(this._sweepTarget);
  }

  _enterPause(seconds) {
    this.state = 'pause';
    this.pauseTimer = seconds;
    this._pauseBaseYaw = this.coach.mesh.rotation.y;
    this._sweepTarget.copy(this.coach.position);
    this.coach.faceTowards(this._sweepTarget);
  }

  /** Swing his body (and light) left and right around _pauseBaseYaw. */
  _sweep(rate, amplitude) {
    const cpos = this.coach.position;
    const yaw = this._pauseBaseYaw + Math.sin(this.system.time * rate + this._timeOffset) * amplitude;
    this._sweepTarget.set(cpos.x + Math.sin(yaw) * 5, 0, cpos.z + Math.cos(yaw) * 5);
  }

  _advanceWaypoint() {
    this.waypoint = (this.waypoint + 1) % this.route.length;
    const wp = this.route[this.waypoint];
    this.coach.faceTowards(null);
    this.coach.moveTo(wp.x, wp.z, PATROL_SPEED * difficulty.coachSpeedMult);
    this.state = 'patrol';
  }

  _resumePatrol() {
    const cpos = this.coach.position;
    let nearest = 0;
    let best = Infinity;
    this.route.forEach((wp, i) => {
      const d = (wp.x - cpos.x) ** 2 + (wp.z - cpos.z) ** 2;
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    this.waypoint = nearest;
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this.coach.moveTo(this.route[nearest].x, this.route[nearest].z, PATROL_SPEED * difficulty.coachSpeedMult);
    this.state = 'patrol';
  }

  _beginChase() {
    this.state = 'chase';
    this.suspicion = 1;
    this.coach.turnRate = 5;
    this.coach.faceTowards(null);
    this.coach.follow(() => this.system.player.object.position, CHASE_SPEED * difficulty.chaseMult);
    this.system._caughtBy(this);
  }

  _updateAim(dt) {
    const cpos = this.coach.position;
    const ry = this.coach.mesh.rotation.y;
    const t = this.system.time + this._timeOffset;
    let desired;
    if (this.aimOverride) {
      desired = Math.atan2(this.aimOverride.x - cpos.x, this.aimOverride.z - cpos.z);
    } else if (this.state === 'investigate') {
      desired = Math.atan2(this.investigateTarget.x - cpos.x, this.investigateTarget.z - cpos.z);
    } else if (this.state === 'chase' || this.state === 'frozen') {
      const p = this.system.player.object.position;
      desired = Math.atan2(p.x - cpos.x, p.z - cpos.z);
    } else if (this.state === 'heard') {
      desired = ry; // the light turns with him, slowly
    } else if (this.state === 'pause' || this.state === 'search') {
      desired = ry + Math.sin(t * 1.3) * 0.35;
    } else {
      desired = ry + Math.sin(t * 0.8) * 0.28;
    }
    this.aimYaw = dampAngle(this.aimYaw, desired, Math.min(1, dt * 6));
  }

  _updateFlashlight() {
    if (!this.beam.visible) return;
    this.prop.getWorldPosition(this._lightPos);
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    this.light.position.copy(this._lightPos);
    this.lightTarget.position.set(this._lightPos.x + fx * 10, 0.2, this._lightPos.z + fz * 10);
    this.lightTarget.updateMatrixWorld();
    this.beam.position.copy(this._lightPos);
    this.beam.lookAt(this.lightTarget.position);

    // Glare grows sharply as the beam swings toward the camera.
    this._toCam.subVectors(this.system.player.object.position, this._lightPos);
    this._toCam.y = 0;
    const len = this._toCam.length() || 1;
    const facing = Math.max(0, (this._toCam.x * fx + this._toCam.z * fz) / len);
    const f6 = facing ** 6;
    this.glare.position.copy(this._lightPos);
    this.glare.material.opacity = 0.12 + 0.88 * f6;
    this.glare.scale.setScalar(0.35 + f6 * 1.3);
  }

  _updateMark(dt) {
    let kind = null;
    if (this.state === 'chase') kind = '!';
    else if (this.litUp || this.state === 'heard' || this.state === 'investigate' || this.state === 'search') kind = '?';
    if (kind !== this.markKind) {
      this.markKind = kind;
      this.markPop = 0;
      if (kind) {
        this.mark.material.map = kind === '!' ? this.system.alertTex : this.system.questionTex;
        this.mark.material.needsUpdate = true;
      }
    }
    this.mark.visible = kind !== null && this.coach.mesh.visible;
    if (!this.mark.visible) return;
    this.markPop = Math.min(1, this.markPop + dt / 0.25);
    const s = 0.55 * Math.max(0.01, easeOutBack(this.markPop));
    const cpos = this.coach.position;
    this.mark.scale.set(s, s, 1);
    this.mark.position.set(cpos.x, this.coach.mesh.userData.headHeight + 0.6 + Math.sin(this.system.time * 4) * 0.05, cpos.z);
  }
}

// ---------------------------------------------------------------------------
// Phase 3 stealth: every coach on patrol + the shared stealth HUD
// ---------------------------------------------------------------------------

/**
 * Each coach:
 * - HEARS you when you're close (unless you're jogging the practice loop with
 *   the team): "?", a startled beat, then he slowly turns toward the noise.
 *   Crouching is quieter, sprinting louder.
 * - SEES you in his vision cone out to 3x his flashlight's length: "?", he
 *   walks over to take a look, searches, then returns to his patrol.
 * - CATCHES you only in his flashlight beam: suspicion fills fast, then he
 *   blows his whistle and charges (onCaught fires so main.js runs the retry).
 * Line of sight is raycast against cover (dumpsters, bins, cars, walls...).
 */
export class StealthSystem {
  constructor({ scene, world, player }) {
    this.world = world;
    this.player = player;
    this.occluders = world.stealth.occluders;
    this.time = 0;
    this.active = false;
    this.playerSafe = false;
    this.onCaught = null;
    this.chaser = null;
    this._tackleResolve = null;

    this.beamMaterial = createBeamMaterial();
    this.beamGeometry = createBeamGeometry();
    this.glareTexture = createGlareTexture();
    this.questionTex = createMarkTexture('?', '#ffd21f');
    this.alertTex = createMarkTexture('!', '#ff4a3a');
    this.guards = world.stealth.guards.map((def) => new Guard({ system: this, scene, def }));

    this._loopSamples = world.trail.loop.getSpacedPoints(360);
    this._safeDist2 = (world.trail.loopWidth / 2 + PRACTICE_MARGIN) ** 2;

    this._ray = new THREE.Raycaster();
    this._eye = new THREE.Vector3();
    this._to = new THREE.Vector3();

    this._buildHud();
  }

  guard(id) {
    return this.guards.find((g) => g.id === id);
  }

  get suspicion() {
    return this.guards.reduce((m, g) => Math.max(m, g.suspicion), 0);
  }

  // ---- HUD -----------------------------------------------------------------

  _buildHud() {
    this.meterEl = document.getElementById('stealth-meter');
    this.fillEl = document.getElementById('stealth-bar-fill');
    this.iconEl = document.getElementById('stealth-icon');
    this.stateEl = document.createElement('div');
    this.stateEl.style.cssText = 'font-size:10px;letter-spacing:2px;min-width:104px;';
    this.meterEl.appendChild(this.stateEl);

    this.warningEl = document.createElement('div');
    this.warningEl.textContent = '[WARNING] Flashlight makes you 2x easier to spot!';
    this.warningEl.style.cssText =
      'position:absolute;top:84px;right:24px;font-size:11px;letter-spacing:1px;color:#e0584f;text-shadow:0 0 6px rgba(224,88,79,0.5);';
    this.warningEl.classList.add('hidden');
    document.getElementById('hud').appendChild(this.warningEl);
    this._hudLabel = '';
    this._hudWidth = -1;
  }

  _updateHud(flashlightOn) {
    let meter = this.suspicion;
    let label = 'HIDDEN';
    let color = '#7d8790';
    if (this.chaser) {
      label = 'SPOTTED!';
      color = '#e0584f';
      meter = 1;
    } else if (this.guards.some((g) => g.litUp)) {
      label = 'IN THE LIGHT!';
      color = '#e0643a';
    } else if (this.guards.some((g) => g.state === 'investigate' || g.state === 'search')) {
      label = 'SEARCHING ?';
      color = '#e0903a';
      meter = Math.max(meter, 0.45);
    } else if (this.guards.some((g) => g.state === 'heard')) {
      label = 'HEARD YOU ?';
      color = '#e0b43a';
      meter = Math.max(meter, 0.25);
    } else if (this.playerSafe) {
      label = 'IN PRACTICE';
      color = '#7fbf7f';
    }
    if (label !== this._hudLabel) {
      this._hudLabel = label;
      this.stateEl.textContent = label;
      this.stateEl.style.color = color;
      this.iconEl.style.color = color;
    }
    const width = Math.round(meter * 100);
    if (width !== this._hudWidth) {
      this._hudWidth = width;
      this.fillEl.style.width = `${width}%`;
    }
    this.warningEl.classList.toggle('hidden', !flashlightOn);
  }

  // ---- Control -------------------------------------------------------------

  /** Phase 3 begins: every coach clicks on a flashlight and heads out on patrol. */
  start() {
    this.active = true;
    this.chaser = null;
    this.guards.forEach((g) => g.start());
    this.meterEl.classList.remove('hidden');
  }

  /** Detection off (e.g. the player reached the car). Coaches keep patrolling as scenery. */
  stop() {
    this.active = false;
    this.chaser = null;
    this._tackleResolve = null;
    this.guards.forEach((g) => g.stopDetecting());
    this.meterEl.classList.add('hidden');
    this.warningEl.classList.add('hidden');
  }

  /** Resolves once the chasing coach has run the player down. */
  tackled() {
    return new Promise((resolve) => {
      this._tackleResolve = resolve;
    });
  }

  /** After a catch: every coach restarts from the waypoint farthest from the retry checkpoint. */
  resetForRetry() {
    const cp = this.world.stealth.checkpoint.position;
    this.chaser = null;
    this._tackleResolve = null;
    this.active = true;
    this.guards.forEach((g) => {
      let far = 0;
      let best = -1;
      g.route.forEach((wp, i) => {
        const d = (wp.x - cp.x) ** 2 + (wp.z - cp.z) ** 2;
        if (d > best) {
          best = d;
          far = i;
        }
      });
      g.resetTo(far);
    });
    this.meterEl.classList.remove('hidden');
  }

  _caughtBy(guard) {
    if (this.chaser) return;
    this.chaser = guard;
    this.guards.forEach((g) => {
      if (g !== guard && g.patrolling) g.freeze();
    });
    playWhistle();
    playCaughtStinger();
    if (this.onCaught) this.onCaught(guard);
  }

  _tackled(guard) {
    if (guard !== this.chaser || !this._tackleResolve) return;
    const resolve = this._tackleResolve;
    this._tackleResolve = null;
    resolve();
  }

  // ---- Detection -----------------------------------------------------------

  /** On the practice loop, moving, and upright = "at practice". */
  _onPracticeLoop() {
    const p = this.player.object.position;
    for (let i = 0; i < this._loopSamples.length; i++) {
      const s = this._loopSamples[i];
      if ((s.x - p.x) ** 2 + (s.z - p.z) ** 2 < this._safeDist2) return true;
    }
    return false;
  }

  /**
   * Vision for one coach: in his flashlight beam out to BEAM_REACH, or anywhere
   * in his field of view out to 3x the flashlight's length, with line of sight.
   */
  canSee(guard, cpos, ppos, { flashlightOn, crouching }) {
    const result = { visible: false, inBeam: false, proximity: 0 };
    const dx = ppos.x - cpos.x;
    const dz = ppos.z - cpos.z;
    const dist = Math.hypot(dx, dz);
    const fx = Math.sin(guard.aimYaw);
    const fz = Math.cos(guard.aimYaw);
    const cosAngle = dist > 1e-4 ? (dx * fx + dz * fz) / dist : 1;
    const angle = Math.acos(THREE.MathUtils.clamp(cosAngle, -1, 1));
    const mult = (flashlightOn ? FLASHLIGHT_RANGE_MULT : 1) * difficulty.sightMult; // (Hard Mode: they see further)
    const beamReach = BEAM_REACH * mult;
    const sightRange = SIGHT_RANGE * mult * (crouching ? CROUCH_SIGHT_MULT : 1);
    const lit = angle < BEAM_HALF_ANGLE && dist < beamReach;
    const inView = angle < VISION_HALF_ANGLE && dist < sightRange;
    if (!lit && !inView) return result;

    // Any clear ray from his eyes to the player's head or chest = seen. Cover
    // (dumpsters, bins, utility boxes, cars, pillars, the shed, walls) blocks it.
    this._eye.set(cpos.x, guard.coach.mesh.userData.headHeight + 0.05, cpos.z);
    const targets = crouching ? CROUCHED_TARGETS : STANDING_TARGETS;
    let clear = false;
    for (const h of targets) {
      this._to.set(ppos.x, h, ppos.z).sub(this._eye);
      const len = this._to.length();
      this._ray.set(this._eye, this._to.divideScalar(len));
      this._ray.far = Math.max(0.01, len - 0.25);
      if (this._ray.intersectObjects(this.occluders, true).length === 0) {
        clear = true;
        break;
      }
    }
    if (!clear) return result;

    result.visible = true;
    result.inBeam = lit;
    result.proximity = 1 - Math.min(1, dist / (lit ? beamReach : sightRange));
    return result;
  }

  // ---- Per-frame -----------------------------------------------------------

  update(dt, input = {}) {
    const full = { flashlightOn: false, sprinting: false, crouching: false, moving: false, ...input };
    this.time += dt;
    this.beamMaterial.uniforms.uTime.value = this.time;
    this.playerSafe = this.active && !this.chaser && full.moving && !full.crouching && this._onPracticeLoop();
    for (const g of this.guards) g.update(dt, full);
    if (this.active) this._updateHud(full.flashlightOn);
  }
}

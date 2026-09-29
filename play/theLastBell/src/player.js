import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ---- Tunables -------------------------------------------------------------
const STAND_EYE_HEIGHT = 1.7;
const SEATED_EYE_HEIGHT = 1.2;
const CROUCH_EYE_HEIGHT = 1.0;
const SLIDE_EYE_HEIGHT = 0.78;
const PLAYER_RADIUS = 0.35;  // horizontal collision radius
const BODY_MIN_Y = 0.05;     // collision column is ground-anchored (no vertical movement in Ch.1)
const BODY_MAX_Y = 1.9;
const WALK_SPEED = 4.2;      // units / second
const SPRINT_SPEED = 7.6;    // units / second
const CROUCH_SPEED = 2.3;    // units / second
const STAND_UP_TIME = 0.3;   // seconds from the desk chair to walking
const INTERACT_RANGE = 2.6;  // meters, forward raycast for [E] prompts
const MOUSE_SENSITIVITY = 1.0;
const MAX_STEP = 0.08;       // meters; movement substep, smaller than the thinnest collider
// Slide (only where slideEnabled: the gym fight): sprint + [C] -> a fast, low
// dash that bleeds off, ending in a crouch.
const SLIDE = { speed: 11.5, endSpeed: 3.2, time: 0.72, cooldown: 0.55 };

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * First-person player controller.
 * Wraps PointerLockControls for mouse-look and adds WASD movement with
 * AABB collision against world colliders plus circle collision against NPCs,
 * a forward interaction raycast for [E] prompts, a flashlight toggle, and
 * cutscene hooks (input lock, scripted camera look-at, scripted glide).
 */
export class Player {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   * @param {Object} options
   * @param {THREE.Object3D[]} [options.colliders] - solid meshes the player can't walk through
   * @param {THREE.Object3D[]} [options.interactables] - meshes that can show an [E] prompt
   * @param {{mesh: THREE.Object3D, radius: number}[]} [options.characters] - solid NPCs
   * @param {THREE.Vector3} [options.spawnPosition] - ground position (eye height is added)
   * @param {number} [options.spawnYaw] - radians
   * @param {number} [options.spawnPitch] - radians
   * @param {boolean} [options.seated] - start sitting; stands up on the first movement input
   * @param {() => void} [options.onUse] - [E] pressed (the caller decides: interact / advance dialogue)
   * @param {(label: string|null) => void} [options.onPromptChange]
   * @param {(isOn: boolean) => void} [options.onFlashlightToggle]
   * @param {(err: unknown) => void} [options.onLockError]
   */
  constructor(camera, domElement, options = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = new PointerLockControls(camera, domElement);
    this.controls.pointerSpeed = MOUSE_SENSITIVITY;
    // Keep pitch just shy of straight up/down so the look direction never degenerates.
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = Math.PI - 0.05;
    // In three r160 getObject() returns the camera itself (kept for backwards compat).
    this.object = this.controls.getObject();

    this.onUse = options.onUse || (() => {});
    this.onPromptChange = options.onPromptChange || (() => {});
    this.onFlashlightToggle = options.onFlashlightToggle || (() => {});
    this.onLockError = options.onLockError || ((err) => console.warn('Pointer lock failed:', err));

    this.seated = !!options.seated;
    this.eyeHeight = this.seated ? SEATED_EYE_HEIGHT : STAND_EYE_HEIGHT;
    const spawn = options.spawnPosition || new THREE.Vector3();
    this.object.position.set(spawn.x, this.eyeHeight, spawn.z);
    this.setLook(options.spawnYaw || 0, options.spawnPitch || 0);

    this.moveState = { forward: false, backward: false, left: false, right: false, sprint: false };
    this.flashlightOn = false;
    this.crouching = false;
    this.currentTarget = null;
    this.inputLocked = false;
    this.cameraOverride = false; // a cutscene drives the camera position directly
    this._lookTarget = null;
    this._scriptedMove = null;
    this._standUpTimer = 0;
    this._moving = false;
    // Knocked around: a decaying shove (collides like walking), a stumble
    // (eye dip + camera roll) and a spell of slowed movement while you recover.
    this.movementFrozen = false; // grabbed: you can look around but not move
    this._push = new THREE.Vector2();
    this._stumble = { t: 0, max: 0, dip: 0, roll: 0 };
    this._rollApplied = 0;
    this._recovery = 0;
    this._recoveryMax = 0;
    this.slideEnabled = false;
    this.speedMultiplier = 1; // e.g. guarding in the fist fight
    this._slide = null; // { t, dirX, dirZ }
    this._slideCooldown = 0;
    this.onSlide = null; // (sound hook)

    this.colliders = [];
    this._colliderBoxes = [];
    this.setColliders(options.colliders || []);
    this.characters = options.characters || [];
    this.interactables = options.interactables || [];

    this.raycaster = new THREE.Raycaster();
    this._rayOrigin = new THREE.Vector3();
    this._rayDirection = new THREE.Vector3();

    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    // Keyup events are lost when the window loses focus (alt-tab), which used to
    // leave movement keys stuck "held" on return.
    this._onBlur = () => this.resetInput();
    this._onUnlock = () => this.resetInput();
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.controls.addEventListener('unlock', this._onUnlock);
  }

  // ---- Setup / state -------------------------------------------------------

  /** Replace the list of solid meshes and rebuild their bounding boxes. */
  setColliders(colliders) {
    this.colliders = colliders;
    this._colliderBoxes = colliders.map((obj) => {
      // Box3.setFromObject only refreshes the object's *own* world matrix (it
      // doesn't walk up to parents), so nested colliders such as the oak trunk
      // inside its tree group, or door leaves on hinge pivots, need their
      // ancestors updated first. Without this the trunk's box landed at the
      // world origin (inside the classroom) and the tree itself wasn't solid.
      obj.updateWorldMatrix(true, false);
      return new THREE.Box3().setFromObject(obj);
    });
  }

  setCharacters(characters) {
    this.characters = characters;
  }

  /** Replace the list of objects the interaction raycast can target. */
  setInteractables(interactables) {
    this.interactables = interactables;
  }

  get isLocked() {
    return this.controls.isLocked;
  }

  get isCrouching() {
    return this.crouching;
  }

  get isSprinting() {
    return this.moveState.sprint && this._moving && !this.crouching;
  }

  get isMoving() {
    return this._moving;
  }

  get isSliding() {
    return !!this._slide;
  }

  /** How high your body reaches right now (lasers at head height pass over a crouch or a slide). */
  get bodyTop() {
    if (this._slide) return 0.95;
    return this.crouching ? 1.15 : 1.85;
  }

  /** Let a cutscene own the camera position (movement and eye height stop updating). */
  setCameraOverride(on) {
    this.cameraOverride = on;
  }

  /** Instantly place the player (checkpoint retries). */
  teleport(position, yaw, pitch = 0) {
    if (this._scriptedMove) {
      this._scriptedMove.resolve();
      this._scriptedMove = null;
    }
    this.resetInput();
    this.seated = false;
    this.clearStumble();
    this._slide = null;
    this.object.position.set(position.x, this.eyeHeight, position.z);
    this.setLook(yaw, pitch);
  }

  /**
   * Get knocked back along (dirX, dirZ) at `speed` m/s (it bleeds off fast and
   * still collides with walls), with a stumble: the view dips `dip` meters and
   * rolls `roll` radians for `stumble` seconds, then movement ramps back up to
   * full speed over `recovery` seconds.
   */
  shove(dirX, dirZ, speed, { stumble = 0.8, dip = 0.4, roll = 0.18, recovery = 1.0 } = {}) {
    const len = Math.hypot(dirX, dirZ) || 1;
    this._push.set((dirX / len) * speed, (dirZ / len) * speed);
    Object.assign(this._stumble, { t: 0, max: stumble, dip, roll: roll * (Math.random() < 0.5 ? -1 : 1) });
    this._recovery = this._recoveryMax = recovery;
  }

  clearStumble() {
    this._push.set(0, 0);
    this._stumble.max = 0;
    this._recovery = this._recoveryMax = 0;
    this._applyRoll(0);
  }

  get isStumbling() {
    return this._stumble.t < this._stumble.max;
  }

  /** Camera roll is set absolutely each frame (nothing else in the game rolls the view). */
  _applyRoll(roll) {
    if (roll === this._rollApplied) return;
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    _euler.z = roll;
    this.camera.quaternion.setFromEuler(_euler);
    this._rollApplied = roll;
  }

  _updateKnockback(dt) {
    if (this._push.lengthSq() > 0.0025) {
      this._attemptMove(this._push.x * dt, this._push.y * dt);
      this._push.multiplyScalar(Math.exp(-dt * 5.5));
    } else {
      this._push.set(0, 0);
    }
    const s = this._stumble;
    let dip = 0;
    let roll = 0;
    if (s.t < s.max) {
      s.t += dt;
      const k = Math.min(1, s.t / s.max);
      // Drops fast, comes back up slowly.
      const curve = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      dip = s.dip * Math.sin((curve * Math.PI) / 2);
      roll = s.roll * Math.sin((curve * Math.PI) / 2);
    }
    this._applyRoll(roll);
    if (this._recovery > 0) this._recovery = Math.max(0, this._recovery - dt);
    return dip;
  }

  /** 0..1 multiplier on walking speed while recovering from a shove. */
  get _recoveryFactor() {
    if (this._recoveryMax <= 0 || this._recovery <= 0) return 1;
    const k = 1 - this._recovery / this._recoveryMax;
    return 0.1 + 0.9 * k * k;
  }

  /**
   * Request pointer lock. PointerLockControls.lock() ignores the Promise that
   * requestPointerLock() returns in modern browsers, so a refused lock (e.g.
   * re-locking within ~1s of pressing Esc, or an embedded frame) surfaced as
   * an "Uncaught (in promise)" console error. Handle it here instead.
   */
  lock() {
    if (this.controls.isLocked) return;
    try {
      const request = this.domElement.requestPointerLock();
      if (request && typeof request.catch === 'function') {
        request.catch((err) => this.onLockError(err));
      }
    } catch (err) {
      this.onLockError(err);
    }
  }

  /**
   * Freeze/unfreeze player control for cutscenes. PointerLockControls (r160)
   * has no `enabled` flag, but its mousemove handler scales by pointerSpeed,
   * so zeroing it stops the mouse fighting the scripted camera while the
   * pointer stays locked (no unlock/relock round-trip mid-scene).
   */
  setInputLocked(locked) {
    this.inputLocked = locked;
    this.controls.pointerSpeed = locked ? 0 : MOUSE_SENSITIVITY;
    this.resetInput();
    if (locked && this.currentTarget) {
      this.currentTarget = null;
      this.onPromptChange(null);
    }
  }

  /** Smoothly aim the camera at a point (Vector3 or () => Vector3); null releases it. */
  setLookTarget(target) {
    this._lookTarget = target;
  }

  /** Glide to a ground position ignoring input and collisions (cutscenes). Resolves on arrival. */
  moveTo(target, speed = 3) {
    if (this._scriptedMove) this._scriptedMove.resolve();
    return new Promise((resolve) => {
      this._scriptedMove = { x: target.x, z: target.z, speed, resolve };
    });
  }

  setLook(yaw, pitch) {
    _euler.set(pitch, yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);
  }

  getYaw() {
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    return _euler.y;
  }

  resetInput() {
    const ms = this.moveState;
    ms.forward = ms.backward = ms.left = ms.right = ms.sprint = false;
  }

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.controls.removeEventListener('unlock', this._onUnlock);
    this.controls.dispose();
  }

  // ---- Input ---------------------------------------------------------------

  _handleKey(e, isDown) {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.moveState.forward = isDown;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.moveState.backward = isDown;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.moveState.left = isDown;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.moveState.right = isDown;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.moveState.sprint = isDown;
        break;
      // Ignore key auto-repeat: holding E used to spam interactions and holding
      // F strobed the flashlight on/off.
      case 'KeyE':
        if (isDown && !e.repeat && this.controls.isLocked) this.onUse();
        break;
      case 'KeyF':
        if (isDown && !e.repeat && this.controls.isLocked) this._toggleFlashlight();
        break;
      // Toggle (not hold): holding C while steering with WASD is awkward, and
      // Ctrl is out because Ctrl+W closes the browser tab.
      case 'KeyC':
        if (isDown && !e.repeat && this.controls.isLocked && !this.inputLocked && !this.seated) {
          if (this.slideEnabled && this.isSprinting && this.moveState.forward && !this._slide && this._slideCooldown <= 0 && !this.movementFrozen) {
            this._startSlide();
          } else if (!this._slide) {
            this.crouching = !this.crouching;
          }
        }
        break;
    }
  }

  _toggleFlashlight() {
    this.flashlightOn = !this.flashlightOn;
    this.onFlashlightToggle(this.flashlightOn);
  }

  /** Drop into a slide along the way you're running. */
  _startSlide() {
    const yaw = this.getYaw();
    const ms = this.moveState;
    const inputX = (ms.right ? 1 : 0) - (ms.left ? 1 : 0);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    let dx = fx + rx * inputX * 0.7;
    let dz = fz + rz * inputX * 0.7;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    this._slide = { t: 0, dirX: dx, dirZ: dz };
    this.crouching = true;
    if (this.onSlide) this.onSlide();
  }

  _updateSlide(dt) {
    const s = this._slide;
    s.t += dt;
    const k = Math.min(1, s.t / SLIDE.time);
    const speed = SLIDE.speed + (SLIDE.endSpeed - SLIDE.speed) * (1 - (1 - k) * (1 - k));
    this._attemptMove(s.dirX * speed * dt, s.dirZ * speed * dt);
    this._moving = true;
    if (k >= 1) {
      this._slide = null;
      this._slideCooldown = SLIDE.cooldown;
    }
  }

  // ---- Collision -----------------------------------------------------------

  _overlapsBox(box, x, z) {
    return (
      x + PLAYER_RADIUS > box.min.x && x - PLAYER_RADIUS < box.max.x &&
      z + PLAYER_RADIUS > box.min.z && z - PLAYER_RADIUS < box.max.z &&
      BODY_MAX_Y > box.min.y && BODY_MIN_Y < box.max.y
    );
  }

  _blocked(fromX, fromZ, toX, toZ) {
    for (let i = 0; i < this._colliderBoxes.length; i++) {
      const box = this._colliderBoxes[i];
      // Only block moves *into* a collider. Colliders the player already
      // overlaps (spawning seated in a chair, a door leaf finishing its swing)
      // can't trap them; they can always move back out.
      if (this._overlapsBox(box, toX, toZ) && !this._overlapsBox(box, fromX, fromZ)) return true;
    }
    for (let i = 0; i < this.characters.length; i++) {
      const c = this.characters[i];
      if (!c.mesh.visible) continue;
      const minDist = PLAYER_RADIUS + c.radius;
      const cx = c.mesh.position.x;
      const cz = c.mesh.position.z;
      const distTo = (toX - cx) ** 2 + (toZ - cz) ** 2;
      if (distTo < minDist * minDist && distTo < (fromX - cx) ** 2 + (fromZ - cz) ** 2) return true;
    }
    return false;
  }

  /**
   * Move by (dx, dz) with wall sliding. Broken into substeps so a large frame
   * (hitch at sprint speed) can't tunnel through a thin collider.
   */
  _attemptMove(dx, dz) {
    const totalDist = Math.hypot(dx, dz);
    if (totalDist === 0) return;
    const steps = Math.max(1, Math.ceil(totalDist / MAX_STEP));
    const stepX = dx / steps;
    const stepZ = dz / steps;
    for (let i = 0; i < steps; i++) this._attemptMoveStep(stepX, stepZ);
  }

  _attemptMoveStep(dx, dz) {
    const pos = this.object.position;
    if (!this._blocked(pos.x, pos.z, pos.x + dx, pos.z + dz)) {
      pos.x += dx;
      pos.z += dz;
      return;
    }
    if (dx !== 0 && !this._blocked(pos.x, pos.z, pos.x + dx, pos.z)) {
      pos.x += dx;
      return;
    }
    if (dz !== 0 && !this._blocked(pos.x, pos.z, pos.x, pos.z + dz)) {
      pos.z += dz;
    }
  }

  // ---- Per-frame -----------------------------------------------------------

  _updateMovement(dt) {
    const ms = this.moveState;
    const inputX = (ms.right ? 1 : 0) - (ms.left ? 1 : 0);
    const inputZ = (ms.forward ? 1 : 0) - (ms.backward ? 1 : 0);
    this._moving = inputX !== 0 || inputZ !== 0;
    if (!this._moving) return;

    if (this.seated) {
      this.seated = false; // first movement input: stand up from the desk
      this._standUpTimer = STAND_UP_TIME;
      return;
    }
    if (this._standUpTimer > 0) {
      this._standUpTimer -= dt; // still getting up
      return;
    }

    const speed = (this.crouching ? CROUCH_SPEED : ms.sprint ? SPRINT_SPEED : WALK_SPEED) * this._recoveryFactor * this.speedMultiplier;
    const len = Math.hypot(inputX, inputZ);
    // Movement axes come from yaw alone, so looking straight down never zeroes them.
    const yaw = this.getYaw();
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const dx = ((rx * inputX + fx * inputZ) / len) * speed * dt;
    const dz = ((rz * inputX + fz * inputZ) / len) * speed * dt;
    this._attemptMove(dx, dz);
  }

  _updateLookTarget(dt) {
    const t = typeof this._lookTarget === 'function' ? this._lookTarget() : this._lookTarget;
    if (!t) return;
    const p = this.object.position; // the camera is top-level, so this is its world position
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const dz = t.z - p.z;
    const desiredYaw = Math.atan2(-dx, -dz);
    const desiredPitch = Math.atan2(dy, Math.hypot(dx, dz));
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    const k = Math.min(1, dt * 4.5);
    this.setLook(_euler.y + shortestAngle(_euler.y, desiredYaw) * k, _euler.x + (desiredPitch - _euler.x) * k);
  }

  _updateInteractionPrompt() {
    let target = null;

    if (!this.inputLocked && this.interactables.length) {
      this.camera.updateMatrixWorld();
      this.camera.getWorldPosition(this._rayOrigin);
      this.camera.getWorldDirection(this._rayDirection);
      this.raycaster.set(this._rayOrigin, this._rayDirection);
      this.raycaster.far = INTERACT_RANGE;

      const hits = this.raycaster.intersectObjects(this.interactables, true);
      if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj && !obj.userData.interactable && obj.parent) obj = obj.parent;
        if (obj && obj.userData.interactable) target = obj;
      }
    }

    if (target !== this.currentTarget) {
      this.currentTarget = target;
      this.onPromptChange(target ? target.userData.label || 'Interact' : null);
    }
  }

  update(dt) {
    const pos = this.object.position;

    if (this.cameraOverride) {
      this._moving = false;
      if (this._lookTarget) this._updateLookTarget(dt);
      this._updateInteractionPrompt();
      return;
    }

    if (this._scriptedMove) {
      const m = this._scriptedMove;
      const dx = m.x - pos.x;
      const dz = m.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = m.speed * dt;
      if (dist <= step) {
        pos.x = m.x;
        pos.z = m.z;
        this._scriptedMove = null;
        m.resolve();
      } else {
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
      }
    } else if (this._slide && !this.inputLocked && !this.movementFrozen) {
      this._updateSlide(dt);
    } else if (!this.inputLocked && !this.movementFrozen && this.controls.isLocked) {
      this._updateMovement(dt);
    } else {
      this._moving = false;
      this._slide = null;
    }
    this._slideCooldown = Math.max(0, this._slideCooldown - dt);
    const dip = this._updateKnockback(dt);

    const targetEye = this.seated ? SEATED_EYE_HEIGHT : this._slide ? SLIDE_EYE_HEIGHT : this.crouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * (this._slide ? 14 : 7));
    pos.y = this.eyeHeight - dip;

    if (this._lookTarget) this._updateLookTarget(dt);

    this._updateInteractionPrompt();
  }
}

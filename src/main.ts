import * as THREE from 'three';
import './style.css';
import { Ship, SHIP, type ShipInput } from './ship';
import { AsteroidField } from './asteroid-field';
import { ChaseCamera } from './chase-camera';
import { Starfield, Dust } from './starfield';
import { Hud } from './hud';
import { Station, STATION_CLEAR_RADIUS } from './station';
import { Raiders } from './enemies';
import { GameAudio } from './audio';
import { POINTS_PER_ORE, POINTS_PER_RAIDER, formatPoints } from './scoring';

const BEST_KEY = 'driftfield.best';
const FIXED_STEP = 1 / 120;
const MAX_HULL = 3;
const HIT_INVULN = 0.9;

// --- renderer & scene -------------------------------------------------------

const canvas = document.getElementById('scene') as HTMLCanvasElement;

/** The driver's own words for a failed context, when it bothers to say. */
let webglFailureDetail = '';
canvas.addEventListener('webglcontextcreationerror', (event) => {
  const detail = (event as WebGLContextEvent).statusMessage;
  if (detail) webglFailureDetail = detail;
});

const renderer = createRenderer(canvas);

/** Surface a fatal startup problem in the UI instead of failing silently. */
function createRenderer(target: HTMLCanvasElement): THREE.WebGLRenderer {
  try {
    const instance = new THREE.WebGLRenderer({
      canvas: target,
      antialias: true,
      powerPreference: 'high-performance',
    });
    instance.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    instance.setSize(window.innerWidth, window.innerHeight);
    instance.toneMapping = THREE.ACESFilmicToneMapping;
    instance.toneMappingExposure = 1.12;
    return instance;
  } catch (error) {
    showBootError(
      webglFailureDetail
        ? `The browser's graphics driver said: ${webglFailureDetail}`
        : 'The browser gave no reason; it simply returned no 3D context.',
      'webgl',
    );
    throw error;
  }
}

type BootFailureKind = 'generic' | 'webgl';

function showBootError(message: string, kind: BootFailureKind = 'generic'): void {
  const box = document.getElementById('boot-error');
  const messageNode = box?.querySelector<HTMLElement>('[data-message]');
  // Drivers can be extremely verbose; keep the visible line readable and the
  // full text in the diagnostics block.
  if (messageNode) messageNode.textContent = message.length > 200 ? `${message.slice(0, 197)}…` : message;
  if (box) box.hidden = false;
  const button = document.getElementById('launch');
  if (button) button.setAttribute('disabled', '');

  if (kind === 'webgl') {
    const title = document.getElementById('boot-title');
    const summary = document.getElementById('boot-summary');
    const detail = document.getElementById('boot-detail');
    if (title) title.textContent = 'This browser cannot draw 3D.';
    if (summary) summary.textContent = 'The game needs WebGL 2, and the browser refused to create a context.';
    if (detail) {
      detail.textContent =
        'In Chrome: Settings → System → turn on "Use graphics acceleration when available", ' +
        'then Relaunch. In Firefox: about:config → set webgl.disabled to false. ' +
        'Then reopen Driftfield.html.';
    }
  }

  // Tell the boot guard not to replace this with its generic message.
  (window as unknown as Record<string, string>).__driftfieldFatal = message;

  // A screenshot of this block is enough to diagnose a machine we cannot see.
  const diag = document.getElementById('boot-diag');
  const report = (window as unknown as { __driftfieldDiag?: (reason: string) => string })
    .__driftfieldDiag;
  if (diag) {
    diag.textContent = report
      ? report(message)
      : `reason      ${message}\nbrowser     ${navigator.userAgent}\npage        ${location.href}`;
    diag.hidden = false;
  }
}

const scene = new THREE.Scene();
// Fog does double duty: depth cues, and hiding rocks that pop in at the edge
// of the streaming radius. Kept thin enough that rocks still read at range.
scene.fog = new THREE.FogExp2(0x060a13, 0.0044);

const hemi = new THREE.HemisphereLight(0x4d6f9e, 0x070b12, 1.4);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xffe9cf, 3.3);
keyLight.position.set(0.55, 0.42, -0.75).multiplyScalar(300);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x6fa8ff, 1.1);
rimLight.position.set(-0.6, -0.25, 0.8).multiplyScalar(240);
scene.add(rimLight);

// Fill from behind-left so rock faces pointing away from the key light keep a
// readable edge instead of dissolving into the background.
const fillLight = new THREE.DirectionalLight(0x93b8ff, 0.55);
fillLight.position.set(-0.8, 0.15, 0.55).multiplyScalar(300);
scene.add(fillLight);

// --- actors -----------------------------------------------------------------

const ship = new Ship();
scene.add(ship.group);

const field = new AsteroidField(20261115, 78, 7);
scene.add(field.group);

const station = new Station();
scene.add(station.group);

const raiders = new Raiders();
scene.add(raiders.group);

const chase = new ChaseCamera(window.innerWidth / window.innerHeight);
const stars = new Starfield();
scene.add(stars.points);

const dust = new Dust();
scene.add(dust.object);

const hud = new Hud();
const audio = new GameAudio();

// --- state ------------------------------------------------------------------

type GameState = 'title' | 'flying' | 'crashed';

let state: GameState = 'title';
let distance = 0;
/** Red ore aboard, not yet banked. Lost if the run ends. */
let cargo = 0;
/** Red ore collected this run, banked or not (death-panel stat). */
let oreCollected = 0;
/** Only banked ore and raider kills turn into points. */
let points = 0;
/** Raiders destroyed this run. */
let kills = 0;
/** Enemy bolts take hull; rocks are still instantly fatal. */
let hull = MAX_HULL;
let hitInvuln = 0;
let best = readBest();
let crashTimer = 0;
let accumulator = 0;
let nearMissCooldown = 0;
/** Edge-trigger for the docking volume so one pass banks once. */
let wasInsideStation = false;
/** Paused when the player releases the mouse; the run must not continue unseen. */
let paused = false;

const keys = new Set<string>();
/** Mouse steering, treated as a decaying impulse so the ship self-centres. */
const steer = { pitch: 0, yaw: 0 };

/** Touch controls: virtual joystick + hold buttons (mobile/coarse pointers). */
const isTouchDevice =
  'ontouchstart' in window ||
  navigator.maxTouchPoints > 0 ||
  window.matchMedia('(pointer: coarse)').matches;

const touchControls = document.getElementById('touch-controls') as HTMLElement | null;
const touchJoystick = document.getElementById('touch-joystick') as HTMLElement | null;
const joyKnob = document.getElementById('joy-knob') as HTMLElement | null;
const touchFireBtn = document.getElementById('touch-fire') as HTMLButtonElement | null;
const touchBoostBtn = document.getElementById('touch-boost') as HTMLButtonElement | null;
const touchThrottleUpBtn = document.getElementById('touch-throttle-up') as HTMLButtonElement | null;
const touchThrottleDownBtn = document.getElementById('touch-throttle-down') as HTMLButtonElement | null;
const touchMuteBtn = document.getElementById('touch-mute') as HTMLButtonElement | null;

const touch = {
  fire: false,
  boost: false,
  throttleUp: false,
  throttleDown: false,
  joyId: null as number | null,
  joyCenterX: 0,
  joyCenterY: 0,
  joyX: 0,
  joyY: 0,
};

const input: ShipInput = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 0,
  boost: false,
};

const raiderEvents = {
  onShipHit: () => {
    if (state !== 'flying' || hitInvuln > 0) return;
    hull -= 1;
    hitInvuln = HIT_INVULN;
    hud.setHull(hull);
    chase.addShake(0.55);
    if (hull <= 0) {
      crash();
      return;
    }
    hud.flash();
    hud.popup(`hull hit · ${hull} left`, 'warn');
    audio.hit();
  },
  onRaiderDown: () => {
    kills += 1;
    points += POINTS_PER_RAIDER;
    hud.setPoints(points);
    hud.popup(`raider down +${formatPoints(POINTS_PER_RAIDER)}`, 'ore');
    audio.raiderDown();
    chase.addShake(0.55);
  },
  onEnemyShot: () => audio.enemyFire(),
  onPlayerShot: () => audio.fire(),
};

// --- input ------------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  // A keydown is a trusted gesture, so this is a valid moment to start audio.
  audio.unlock();

  if (event.code === 'KeyR' && state === 'crashed') {
    restart();
    return;
  }
  if (event.repeat) return;

  if (event.code === 'KeyM') {
    const muted = audio.toggleMute();
    hud.popup(muted ? 'sound off' : 'sound on', muted ? 'warn' : 'ore');
  }

  keys.add(event.code);
  if (
    event.code === 'ArrowUp' ||
    event.code === 'ArrowDown' ||
    event.code === 'ArrowLeft' ||
    event.code === 'ArrowRight' ||
    event.code === 'Space'
  ) {
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
  if (event.code === 'Space') event.preventDefault();
});
window.addEventListener('blur', () => keys.clear());

window.addEventListener('mousemove', (event) => {
  if (state !== 'flying' || paused) return;
  // Ignore emulated mouse moves from touch input.
  if (isTouchDevice && event.movementX === 0 && event.movementY === 0) return;
  // Pointer lock is the preferred mode, but a browser (or an embedding host) can
  // refuse it. `movementX/Y` is populated on plain mousemove too, so steering
  // must not depend on holding the lock: otherwise a refusal silently leaves the
  // player unable to steer at all.
  //
  // Flight-stick pitch: pulling the mouse *down* (movementY > 0) climbs, the way
  // a yoke works. This is the one sign that feels wrong if you expect FPS look.
  steer.pitch = clamp(steer.pitch + event.movementY * 0.005, -1.3, 1.3);
  steer.yaw = clamp(steer.yaw - event.movementX * 0.005, -1.3, 1.3);
});

function setTouchVisible(visible: boolean): void {
  if (!touchControls) return;
  touchControls.classList.toggle('is-hidden', !visible);
}

function syncTouchControlsVisibility(): void {
  if (!isTouchDevice) return;
  // Show controls during play and on crash (so user can see them) but hide on title.
  setTouchVisible(state !== 'title');
}

function setTouchButtonPressed(btn: HTMLButtonElement | null, pressed: boolean): void {
  if (!btn) return;
  btn.classList.toggle('is-pressed', pressed);
}

function resetTouchState(): void {
  touch.fire = false;
  touch.boost = false;
  touch.throttleUp = false;
  touch.throttleDown = false;
  touch.joyId = null;
  touch.joyX = 0;
  touch.joyY = 0;
  if (joyKnob) joyKnob.style.transform = 'translate(0px, 0px)';
  touchJoystick?.classList.remove('is-active');
  setTouchButtonPressed(touchFireBtn, false);
  setTouchButtonPressed(touchBoostBtn, false);
  setTouchButtonPressed(touchThrottleUpBtn, false);
  setTouchButtonPressed(touchThrottleDownBtn, false);
}

function bindHoldButton(
  btn: HTMLButtonElement | null,
  set: (v: boolean) => void,
): void {
  if (!btn) return;
  const down = (event: PointerEvent) => {
    event.preventDefault();
    audio.unlock();
    try {
      btn.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic or inactive pointers can throw; hold state still works.
    }
    set(true);
    setTouchButtonPressed(btn, true);
  };
  const up = (event?: PointerEvent) => {
    if (event) event.preventDefault();
    set(false);
    setTouchButtonPressed(btn, false);
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', (e) => {
    if (e.buttons === 0) up(e);
  });
}

bindHoldButton(touchFireBtn, (v) => (touch.fire = v));
bindHoldButton(touchBoostBtn, (v) => (touch.boost = v));
bindHoldButton(touchThrottleUpBtn, (v) => (touch.throttleUp = v));
bindHoldButton(touchThrottleDownBtn, (v) => (touch.throttleDown = v));

touchMuteBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  audio.unlock();
  const muted = audio.toggleMute();
  hud.popup(muted ? 'sound off' : 'sound on', muted ? 'warn' : 'ore');
});

if (touchJoystick && joyKnob) {
  const radius = 44;
  touchJoystick.addEventListener('pointerdown', (event) => {
    if (state !== 'flying' || paused) return;
    event.preventDefault();
    audio.unlock();
    touch.joyId = event.pointerId;
    const rect = touchJoystick.getBoundingClientRect();
    touch.joyCenterX = rect.left + rect.width / 2;
    touch.joyCenterY = rect.top + rect.height / 2;
    touchJoystick.classList.add('is-active');
    try {
      touchJoystick.setPointerCapture?.(event.pointerId);
    } catch {
      // Safe to continue without capture.
    }
    updateJoy(event.clientX, event.clientY);
  });

  const updateJoy = (clientX: number, clientY: number) => {
    const dx = clientX - touch.joyCenterX;
    const dy = clientY - touch.joyCenterY;
    const dist = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(dist, radius);
    const nx = (dx / dist) * clamped;
    const ny = (dy / dist) * clamped;
    joyKnob.style.transform = `translate(${nx}px, ${ny}px)`;
    // Store normalized deflection; applied continuously while held.
    touch.joyX = nx / radius;
    touch.joyY = ny / radius;
  };

  touchJoystick.addEventListener('pointermove', (event) => {
    if (touch.joyId !== event.pointerId) return;
    event.preventDefault();
    updateJoy(event.clientX, event.clientY);
  });

  const endJoy = (event: PointerEvent) => {
    if (touch.joyId !== event.pointerId) return;
    event.preventDefault();
    touch.joyId = null;
    touch.joyX = 0;
    touch.joyY = 0;
    joyKnob.style.transform = 'translate(0px, 0px)';
    touchJoystick.classList.remove('is-active');
  };
  touchJoystick.addEventListener('pointerup', endJoy);
  touchJoystick.addEventListener('pointercancel', endJoy);
}

if (isTouchDevice) {
  setTouchVisible(false);
}

canvas.addEventListener('click', () => {
  if (state !== 'flying') return;
  // A click always resumes: pointer lock is a nicety, not a requirement, so a
  // browser that refuses it must not be able to wedge the game in a pause.
  if (paused) {
    paused = false;
    hud.setPaused(false);
    lastFrame = performance.now();
  }
  if (!isTouchDevice && document.pointerLockElement !== canvas) requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  if (state !== 'flying') return;

  if (document.pointerLockElement === canvas) {
    paused = false;
    return;
  }

  paused = true;
  hud.setPaused(true);
  steer.pitch = 0;
  steer.yaw = 0;
  keys.clear();
  lastFrame = performance.now();
});

/** Say so when mouse look is refused, so "the controls do nothing" is legible. */
function notePointerLockUnavailable(): void {
  if (state !== 'flying' || paused) return;
  if (isTouchDevice) return;
  hud.setHint('mouse look is blocked here · arrow keys steer');
}

document.addEventListener('pointerlockerror', notePointerLockUnavailable);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'flying') {
    paused = true;
    hud.setPaused(true);
    keys.clear();
  }
});

window.addEventListener('resize', () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  chase.resize(width, height);
});

document.getElementById('launch')?.addEventListener('click', () => {
  audio.unlock();
  startRun();
});
document.getElementById('relaunch')?.addEventListener('click', () => restart());

// --- run lifecycle ----------------------------------------------------------

function startRun(): void {
  state = 'flying';
  paused = false;
  accumulator = 0;
  crashTimer = 0;
  distance = 0;
  cargo = 0;
  oreCollected = 0;
  points = 0;
  kills = 0;
  hull = MAX_HULL;
  hitInvuln = 0;
  wasInsideStation = false;
  steer.pitch = 0;
  steer.yaw = 0;
  // A focused Launch/Relaunch button can be "clicked" by Space on keyup, which
  // would silently restart the run and wipe progress.
  (document.activeElement as HTMLElement | null)?.blur?.();
  resetTouchState();
  raiders.reset();
  station.placeAhead(ship.position, ship.forward, 620);
  field.clearSphere(station.position, STATION_CLEAR_RADIUS);
  chase.snap(ship);
  hud.showFlying();
  hud.setCargo(0);
  hud.setPoints(0);
  hud.setHull(hull);
  syncTouchControlsVisibility();
  if (isTouchDevice) {
    hud.setHint('touch: left stick steers · buttons fire/throttle/boost');
  } else {
    requestPointerLock();
  }

  // Some browsers reject the lock without firing `pointerlockerror`. If the
  // game is running unlocked, the mouse still steers, but the player deserves
  // to know mouse look is off.
  window.setTimeout(() => {
    if (!isTouchDevice && state === 'flying' && !paused && document.pointerLockElement !== canvas) {
      notePointerLockUnavailable();
    }
  }, 700);
}

function restart(): void {
  ship.reset();
  field.scatter(ship.position, ship.forward);
  startRun();
}

function crash(): void {
  state = 'crashed';
  crashTimer = 0;
  nearMissCooldown = 0;
  ship.halt();
  raiders.stop();
  resetTouchState();
  syncTouchControlsVisibility();
  audio.crash();
  chase.addShake(1.7);
  hud.flash();

  if (distance > best) {
    best = distance;
    try {
      localStorage.setItem(BEST_KEY, String(Math.round(best)));
    } catch {
      // Private-mode browsers can refuse storage; best simply won't persist.
    }
  }
}

// --- simulation -------------------------------------------------------------

function fixedStep(dt: number): void {
  // Arrows follow the stick too: pulling back (ArrowDown) climbs.
  const keyPitch = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
  const keyYaw = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
  const joyPitch = touch.joyId !== null ? touch.joyY : 0;
  const joyYaw = touch.joyId !== null ? -touch.joyX : 0;
  const touchThrottle = (touch.throttleUp ? 1 : 0) - (touch.throttleDown ? 1 : 0);

  input.pitch = clamp(steer.pitch + keyPitch + joyPitch, -1, 1);
  input.yaw = clamp(steer.yaw + keyYaw + joyYaw, -1, 1);
  input.roll = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
  input.throttle = clamp(
    (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + touchThrottle,
    -1,
    1,
  );
  input.boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.boost;

  // Let mouse steering bleed off so releasing settles the nose. The touch
  // joystick is applied as direct input below (like holding arrow keys).
  if (touch.joyId !== null) {
    steer.pitch = 0;
    steer.yaw = 0;
  }
  const decay = Math.exp(-8 * dt);
  steer.pitch *= decay;
  steer.yaw *= decay;
  hitInvuln = Math.max(0, hitInvuln - dt);

  ship.update(dt, input);

  const result = field.query(ship.previousColliders, ship.colliders);
  if (result.hit) {
    crash();
    return;
  }

  // Red ore is cargo now: collected here, only worth points once docked.
  if (result.target) {
    cargo += 1;
    oreCollected += 1;
    audio.ore();
    hud.setCargo(cargo);
    hud.popup(`ore +1 · ${cargo} aboard`, 'ore');
    field.recycleTarget(result.target, ship.position, ship.forward);
    chase.addShake(0.18);
  }

  raiders.update(dt, ship, keys.has('Space') || touch.fire, raiderEvents);
  if (state !== 'flying') return;

  const insideStation = station.contains(ship.position);
  if (insideStation && !wasInsideStation) {
    if (cargo > 0) {
      const banked = cargo * POINTS_PER_ORE;
      points += banked;
      hud.popup(`+${formatPoints(banked)} banked`, 'dock');
      hud.setCargo(0);
      hud.setPoints(points);
      audio.docked();
      station.triggerPulse();
      chase.addShake(0.32);
      cargo = 0;

      // Move the ring further down the lane: banking is the loop, not a stop.
      station.placeAhead(ship.position, ship.forward, 700);
      field.clearSphere(station.position, STATION_CLEAR_RADIUS);
    } else {
      hud.popup('station · no ore aboard', 'warn');
      station.triggerPulse();
    }
  }
  wasInsideStation = insideStation;

  nearMissCooldown = Math.max(0, nearMissCooldown - dt);
  if (result.nearMiss > 0.2 && nearMissCooldown === 0) {
    hud.nearMiss(result.nearMiss);
    audio.nearMiss();
    chase.addShake(0.08 + result.nearMiss * 0.24);
    nearMissCooldown = 1.1;
  }

  distance += ship.speed * dt;
  field.update(dt, ship.position, ship.forward);
  // The field streams rocks in around the ship, so the station lane has to be
  // swept every step, not just once when the ring is placed.
  field.clearSphere(station.position, STATION_CLEAR_RADIUS);
}

// --- frame loop -------------------------------------------------------------

let lastFrame = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);

  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (state === 'flying' && !paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 12) {
      fixedStep(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps++;
      if (state !== 'flying') break;
    }
    if (accumulator > FIXED_STEP * 12) accumulator = 0;
  } else if (state !== 'flying') {
    // Keep the field alive behind the title/death screens.
    field.update(dt, ship.position, ship.forward);
  }

  if (state === 'crashed') {
    crashTimer += dt;
    if (crashTimer > 0.45 && !hud.crashedPanelVisible) {
      hud.showCrashed(distance, best, oreCollected, points, cargo);
      syncTouchControlsVisibility();
    }
  }

  station.animate(dt);
  syncTouchControlsVisibility();

  const speed01 = clamp01(
    (ship.speed - SHIP.brakeSpeed) / (SHIP.boostSpeed - SHIP.brakeSpeed),
  );

  chase.update(dt, ship, speed01);
  stars.update(chase.camera.position);
  dust.update(dt, ship.position, ship.forward, state === 'flying' ? ship.speed : 0);

  const showStation = state === 'flying' && !paused;
  hud.setStats(ship.speed, distance, best, cargo, points, hull);
  hud.setThreat(showStation ? raiders.nearest(ship.position) : Infinity);
  hud.setStation(station.position, chase.camera, showStation);
  renderer.render(scene, chase.camera);
}

// --- helpers ----------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * `requestPointerLock` returns a promise in current browsers and throws in
 * unusual embedding situations; neither should break the game loop.
 */
function requestPointerLock(): void {
  try {
    const result = canvas.requestPointerLock() as unknown;
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // Pointer lock is a nicety: keyboard steering still works without it.
  }
}

function readBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

// Give the title screen the same landmark the run will start with.
station.placeAhead(ship.position, ship.forward, 620);
field.clearSphere(station.position, STATION_CLEAR_RADIUS);
chase.snap(ship);

// Dev-only inspection hook: lets tooling verify what is actually on screen
// (ship position, camera state, run state) without guessing from pixels.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__driftfield = {
    ship,
    field,
    chase,
    steer,
    station,
    raiders,
    audio,
    getState: () => ({
      state,
      paused,
      distance,
      best,
      cargo,
      oreCollected,
      points,
      kills,
      hull,
      raidersAlive: raiders.activeCount,
      stationDistance: station.distanceTo(ship.position),
    }),
  };
}

// Signal the inline boot guard in index.html that the module actually loaded.
(window as unknown as Record<string, unknown>).__driftfieldReady = true;
const bootBox = document.getElementById('boot-error');
if (bootBox) bootBox.hidden = true;
// The guard disables Launch if the boot takes longer than its timeout; the game
// is alive by this line, so hand the button back rather than stranding it.
document.getElementById('launch')?.removeAttribute('disabled');
const bootDiag = document.getElementById('boot-diag');
if (bootDiag) {
  bootDiag.hidden = true;
  bootDiag.textContent = '';
}

requestAnimationFrame(frame);

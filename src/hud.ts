import * as THREE from 'three';
import { SHIP } from './ship';
import { formatPoints } from './scoring';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD is missing #${id}`);
  return node as T;
}

const CONTROLS_HINT =
  'mouse steer (down climbs) · W/S throttle · space fire · shift burn';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function splitDistance(meters: number): [string, string] {
  if (meters >= 1000) return [(meters / 1000).toFixed(2), 'km'];
  return [String(Math.round(meters)), 'm'];
}

export type PopupTone = 'ore' | 'dock' | 'warn';

/** Thin wrapper over the DOM overlay so the game loop never touches markup. */
export class Hud {
  private readonly root = el('hud');
  private readonly titlePanel = el('panel');
  private readonly gameOverPanel = el('gameover');

  private readonly speedEl = el('hud-speed');
  private readonly distEl = el('hud-dist');
  private readonly distUnitEl = el('hud-dist-unit');
  private readonly bestEl = el('hud-best');
  private readonly bestUnitEl = el('hud-best-unit');
  private readonly cargoEl = el('hud-ore');
  private readonly pointsEl = el('hud-points');
  private readonly hullEl = el('hud-hull');
  private readonly popupEl = el('hud-popup');
  private readonly threatEl = el('hud-threat');
  private readonly stationMarkerEl = el('station-marker');
  private readonly stationDistEl = el('station-dist');
  private readonly barEl = el('hud-bar');
  private readonly nearMissEl = el('hud-nearmiss');
  private readonly hintEl = el('hud-hint');
  private readonly flashEl = el('flash');

  private readonly crashDistanceEl = el('go-dist');
  private readonly crashBestEl = el('go-best');
  private readonly crashOreEl = el('go-ore');
  private readonly crashPointsEl = el('go-points');
  private readonly crashLostEl = el('go-lost');

  private readonly cameraSpace = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();

  private lastSpeed = -1;
  private lastDistance = -1;
  private lastBest = -1;
  private lastCargo = -1;
  private lastPoints = -1;
  private lastHull = -1;
  private lastThreat = -1;
  private hintPinned = false;
  private hintTimer = 0;

  setStats(
    speed: number,
    distance: number,
    best: number,
    cargo = 0,
    points = 0,
    hull = 3,
  ): void {
    if (speed !== this.lastSpeed) {
      this.lastSpeed = speed;
      this.speedEl.textContent = String(Math.round(speed));
      this.barEl.style.width = `${clamp01(speed / SHIP.boostSpeed) * 100}%`;
    }

    if (distance !== this.lastDistance) {
      this.lastDistance = distance;
      const [value, unit] = splitDistance(distance);
      this.distEl.textContent = value;
      this.distUnitEl.textContent = unit;
    }

    if (best !== this.lastBest) {
      this.lastBest = best;
      const [value, unit] = splitDistance(best);
      this.bestEl.textContent = value;
      this.bestUnitEl.textContent = unit;
    }

    if (cargo !== this.lastCargo) this.setCargo(cargo);
    if (points !== this.lastPoints) this.setPoints(points);
    if (hull !== this.lastHull) this.setHull(hull);
  }

  setHull(hull: number): void {
    this.lastHull = hull;
    this.hullEl.textContent = String(hull);
    this.hullEl.classList.toggle('is-warn', hull === 2);
    this.hullEl.classList.toggle('is-critical', hull <= 1);
  }

  setCargo(count: number): void {
    this.lastCargo = count;
    this.cargoEl.textContent = String(count);
    this.cargoEl.classList.toggle('is-loaded', count > 0);
  }

  setPoints(points: number): void {
    this.lastPoints = points;
    this.pointsEl.textContent = formatPoints(points);
  }

  /** Centre-screen message: pickups, docking totals, raider kills, sound state. */
  popup(text: string, tone: PopupTone = 'ore'): void {
    this.popupEl.textContent = text;
    this.popupEl.classList.remove('is-ore', 'is-dock', 'is-warn');
    this.popupEl.classList.add(`is-${tone}`);
    restartAnimation(this.popupEl, 'is-firing');
  }

  /** Distance to the closest raider, or Infinity to hide the warning. */
  setThreat(distance: number): void {
    if (!Number.isFinite(distance) || distance > 340) {
      if (this.lastThreat !== -1) {
        this.lastThreat = -1;
        this.threatEl.classList.remove('is-visible');
      }
      return;
    }

    const rounded = Math.round(distance);
    if (rounded === this.lastThreat) return;
    this.lastThreat = rounded;
    this.threatEl.textContent = `raider ${rounded} m`;
    this.threatEl.classList.add('is-visible');
  }

  /**
   * Place the station marker at the station's screen position, clamped to the
   * screen edge when it is off-camera or behind the ship.
   */
  setStation(
    position: THREE.Vector3 | null,
    camera: THREE.PerspectiveCamera,
    visible: boolean,
  ): void {
    if (!position || !visible) {
      this.stationMarkerEl.classList.add('is-hidden');
      return;
    }

    this.stationMarkerEl.classList.remove('is-hidden');
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.cameraSpace.copy(position).applyMatrix4(camera.matrixWorldInverse);
    const behind = this.cameraSpace.z > -0.5;

    let x: number;
    let y: number;
    if (behind) {
      // Project the camera-space direction onto the edge behind you.
      const angle = Math.atan2(this.cameraSpace.y, this.cameraSpace.x);
      x = width / 2 + Math.cos(angle) * width;
      y = height / 2 - Math.sin(angle) * height;
    } else {
      this.projected.copy(position).project(camera);
      x = (this.projected.x * 0.5 + 0.5) * width;
      y = (-this.projected.y * 0.5 + 0.5) * height;
    }

    const marginX = 104;
    const marginY = 92;
    x = Math.min(Math.max(x, marginX), width - marginX);
    y = Math.min(Math.max(y, marginY), height - marginY);

    this.stationMarkerEl.style.left = `${x}px`;
    this.stationMarkerEl.style.top = `${y}px`;

    const distance = Math.round(position.distanceTo(camera.position));
    this.stationDistEl.textContent = String(distance);
  }

  nearMiss(intensity: number): void {
    this.nearMissEl.style.opacity = String(0.45 + intensity * 0.55);
    restartAnimation(this.nearMissEl, 'is-firing');
  }

  flash(): void {
    restartAnimation(this.flashEl, 'is-firing');
  }

  /** Enter the play state: HUD up, panels down, controls hint shown briefly. */
  showFlying(): void {
    this.titlePanel.classList.add('is-hidden');
    this.gameOverPanel.classList.add('is-hidden');
    this.root.classList.remove('is-hidden');
    this.lastSpeed = -1;
    this.lastDistance = -1;
    this.lastCargo = -1;
    this.lastPoints = -1;
    this.lastHull = -1;
    this.lastThreat = -2;

    this.hintEl.textContent = CONTROLS_HINT;
    this.hintEl.classList.add('is-visible');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      if (!this.hintPinned) this.hintEl.classList.remove('is-visible');
    }, 8000);
  }

  showCrashed(
    distance: number,
    best: number,
    ore: number,
    points: number,
    cargoLost: number,
  ): void {
    this.crashDistanceEl.textContent = splitDistance(distance).join(' ');
    this.crashBestEl.textContent = splitDistance(best).join(' ');
    this.crashOreEl.textContent = String(ore);
    this.crashPointsEl.textContent = formatPoints(points);

    if (cargoLost > 0) {
      this.crashLostEl.hidden = false;
      this.crashLostEl.textContent = `${cargoLost} ore lost in the field.`;
    } else {
      this.crashLostEl.hidden = true;
    }

    this.gameOverPanel.classList.remove('is-hidden');
    this.hintEl.classList.remove('is-visible');
  }

  /** True once the death panel is on screen (used to delay showing it). */
  get crashedPanelVisible(): boolean {
    return !this.gameOverPanel.classList.contains('is-hidden');
  }

  /**
   * Losing the mouse (Esc, tab switch) pauses the run — otherwise the ship
   * keeps flying and crashes while the player is looking away.
   */
  setPaused(paused: boolean): void {
    this.hintPinned = paused;
    window.clearTimeout(this.hintTimer);

    if (paused) {
      this.hintEl.textContent = 'paused · click to resume';
      this.hintEl.classList.add('is-visible');
    } else {
      this.hintEl.textContent = CONTROLS_HINT;
      this.hintEl.classList.remove('is-visible');
    }
  }

  /** Pin a one-off message in the hint slot (e.g. pointer lock unavailable). */
  setHint(text: string): void {
    this.hintPinned = true;
    window.clearTimeout(this.hintTimer);
    this.hintEl.textContent = text;
    this.hintEl.classList.add('is-visible');
  }
}

/** Re-trigger a CSS animation by removing the class, forcing layout, re-adding. */
function restartAnimation(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

import * as THREE from 'three';
import type { Ship } from './ship';

/**
 * Spring-follow chase camera.
 *
 * The camera never snaps to the ship: it lags position, lags aim, partially
 * inherits the ship's bank, widens with speed, and shakes on near misses. All
 * of that is feel, not correctness — tune the constants, not the structure.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  readonly baseFov = 78;

  private readonly desiredPosition = new THREE.Vector3();
  private readonly smoothPosition = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly smoothLook = new THREE.Vector3();
  private readonly upTarget = new THREE.Vector3();
  private readonly shakeOffset = new THREE.Vector3();

  /** Distance behind and above the ship, in ship-local space (+Z is aft). */
  private readonly offset = new THREE.Vector3(0, 2.55, 9.4);
  /** Aim point well ahead of the nose so the ship sits low in frame. */
  private readonly lookOffset = new THREE.Vector3(0, 1.15, -18);

  private shake = 0;
  private shakeSeed = Math.random() * 1000;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.35, 4000);
    this.camera.up.set(0, 1, 0);
  }

  /** Place the camera exactly where it belongs (start of run, no easing). */
  snap(ship: Ship): void {
    this.desiredPosition.copy(this.offset).applyQuaternion(ship.quaternion).add(ship.position);
    this.smoothPosition.copy(this.desiredPosition);

    this.lookTarget.copy(this.lookOffset).applyQuaternion(ship.quaternion).add(ship.position);
    this.smoothLook.copy(this.lookTarget);

    this.camera.position.copy(this.smoothPosition);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.smoothLook);
    this.shake = 0;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.8, this.shake + amount);
  }

  /**
   * @param speed01 0..1, where the ship sits between coasting and full burn.
   */
  update(dt: number, ship: Ship, speed01: number): void {
    this.desiredPosition.copy(this.offset).applyQuaternion(ship.quaternion).add(ship.position);
    this.smoothPosition.lerp(this.desiredPosition, 1 - Math.exp(-6.5 * dt));

    this.lookTarget.copy(this.lookOffset).applyQuaternion(ship.quaternion).add(ship.position);
    this.smoothLook.lerp(this.lookTarget, 1 - Math.exp(-9 * dt));

    // Inherit roughly half the ship's bank: enough to feel the roll, not enough
    // to make the horizon spin.
    this.upTarget.set(0, 1, 0).lerp(ship.up, 0.66).normalize();
    this.camera.up.lerp(this.upTarget, 1 - Math.exp(-5 * dt)).normalize();

    this.camera.position.copy(this.smoothPosition);

    this.shake *= Math.exp(-5.5 * dt);
    if (this.shake > 0.002) {
      this.shakeSeed += dt * 37;
      const s = this.shake;
      this.shakeOffset.set(
        noise(this.shakeSeed) * s * 0.5,
        noise(this.shakeSeed + 31.7) * s * 0.5,
        noise(this.shakeSeed + 71.3) * s * 0.25,
      );
      this.camera.position.add(this.shakeOffset);
    }

    this.camera.lookAt(this.smoothLook);

    const targetFov = this.baseFov + speed01 * 15;
    if (Math.abs(targetFov - this.camera.fov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-2.6 * dt));
      this.camera.updateProjectionMatrix();
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

/** Cheap smooth 1D wobble in [-1, 1]. */
function noise(t: number): number {
  return (
    Math.sin(t) * 0.5 +
    Math.sin(t * 2.31 + 1.7) * 0.3 +
    Math.sin(t * 4.77 + 4.2) * 0.2
  );
}

import * as THREE from 'three';
import { makeRng } from './noise';

/** Fixed backdrop of distant stars. Re-centred on the camera every frame. */
export class Starfield {
  readonly points: THREE.Points;

  constructor(count = 1500) {
    const rng = makeRng(90210);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      // Random point on a large shell.
      const theta = rng() * Math.PI * 2;
      const cosPhi = rng() * 2 - 1;
      const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const radius = 1900 + rng() * 900;

      positions[i * 3] = Math.cos(theta) * sinPhi * radius;
      positions[i * 3 + 1] = cosPhi * radius;
      positions[i * 3 + 2] = Math.sin(theta) * sinPhi * radius;

      // Stars are cold blue-white with the odd warmer one.
      const hue = rng() < 0.12 ? 0.08 : 0.6;
      color.setHSL(hue, rng() * 0.25, 0.62 + rng() * 0.3);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 2.1,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  update(cameraPosition: THREE.Vector3): void {
    this.points.position.copy(cameraPosition);
  }
}

/**
 * Nearby dust rendered as short streaks aligned with the ship's velocity.
 *
 * This is the main speed cue: without moving references, 150 m/s looks exactly
 * like 15 m/s. The motes live in a box around the ship and wrap through it as
 * the ship moves, so the field never runs out.
 */
export class Dust {
  readonly object: THREE.LineSegments;

  private readonly positions: Float32Array;
  /** Head position of each mote, in box-local space. */
  private readonly heads: Float32Array;
  private readonly velocity = new THREE.Vector3(0, 0, -1);

  private static readonly COUNT = 560;
  private static readonly HALF = 72;

  constructor() {
    const count = Dust.COUNT;
    this.heads = new Float32Array(count * 3);
    this.positions = new Float32Array(count * 6);

    const rng = makeRng(4242);
    const half = Dust.HALF;
    for (let i = 0; i < count; i++) {
      this.heads[i * 3] = (rng() * 2 - 1) * half;
      this.heads[i * 3 + 1] = (rng() * 2 - 1) * half;
      this.heads[i * 3 + 2] = (rng() * 2 - 1) * half;
    }

    const geometry = new THREE.BufferGeometry();
    const positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);

    const material = new THREE.LineBasicMaterial({
      color: 0x9fc4ff,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    this.object = new THREE.LineSegments(geometry, material);
    this.object.frustumCulled = false;
    this.writeStreaks(0, 54);
  }

  /**
   * @param velocityDir unit vector the ship is travelling along
   * @param speed       world units per second
   */
  update(dt: number, shipPosition: THREE.Vector3, velocityDir: THREE.Vector3, speed: number): void {
    this.velocity.copy(velocityDir);
    this.object.position.copy(shipPosition);

    // Move motes against the ship's travel, then wrap them back into the box.
    const travel = speed * dt;
    const shiftX = -velocityDir.x * travel;
    const shiftY = -velocityDir.y * travel;
    const shiftZ = -velocityDir.z * travel;
    const size = Dust.HALF * 2;
    const half = Dust.HALF;
    const heads = this.heads;

    for (let i = 0; i < heads.length; i += 3) {
      let x = heads[i]! + shiftX;
      let y = heads[i + 1]! + shiftY;
      let z = heads[i + 2]! + shiftZ;

      if (x > half) x -= size;
      else if (x < -half) x += size;
      if (y > half) y -= size;
      else if (y < -half) y += size;
      if (z > half) z -= size;
      else if (z < -half) z += size;

      heads[i] = x;
      heads[i + 1] = y;
      heads[i + 2] = z;
    }

    this.writeStreaks(speed, 0);
  }

  private writeStreaks(speed: number, fallbackSpeed: number): void {
    const effective = speed > 0.01 ? speed : fallbackSpeed;
    const length = Math.min(11, Math.max(1.2, effective * 0.055));
    const dir = this.velocity;
    const heads = this.heads;
    const out = this.positions;

    for (let i = 0, o = 0; i < heads.length; i += 3, o += 6) {
      const x = heads[i]!;
      const y = heads[i + 1]!;
      const z = heads[i + 2]!;

      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;

      out[o + 3] = x - dir.x * length;
      out[o + 4] = y - dir.y * length;
      out[o + 5] = z - dir.z * length;
    }

    (this.object.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

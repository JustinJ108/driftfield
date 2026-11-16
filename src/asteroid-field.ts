import * as THREE from 'three';
import { fbm3, makeRng } from './noise';
import { SHIP } from './ship';

/**
 * A streaming asteroid field.
 *
 * Rocks live inside a ball that follows the ship. Anything that drifts outside
 * the ball is teleported to the far side, so the field is effectively infinite
 * and works no matter which way the player turns.
 *
 * Rendering is one InstancedMesh per base rock shape — 8 draw calls for
 * hundreds of rocks. Collision is a broad distance reject plus a swept
 * sphere-vs-segment test against a 3-sphere ship proxy.
 */

const SHAPE_COUNT = 8;
const FIELD_RADIUS = 235;
/** Outer edge of the initial scatter. */
const SPAWN_RADIUS = FIELD_RADIUS * 0.86;
/** Where recycled rocks re-enter, just inside the fog horizon. */
const RECYCLE_RADIUS = FIELD_RADIUS * 0.87;
const MIN_SPAWN_DISTANCE = 70;
/** Red bonus rocks: harmless to touch, worth points. */
const TARGET_COUNT = 12;
const TARGET_MIN_RADIUS = 2.6;
const TARGET_MAX_RADIUS = 4.8;
/** Clear tube straight ahead of the ship at the start of a run. */
const START_CORRIDOR_LENGTH = 175;
const START_CORRIDOR_RADIUS = 26;
/** Halo shell drawn around a bonus rock, as a multiple of its radius. */
const HALO_SCALE = 1.55;

const FIELD_FORWARD = new THREE.Vector3(0, 0, -1);

interface Rock {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Local angular velocity, radians/sec. */
  spin: THREE.Vector3;
  /** Bounding-sphere radius in world units. */
  radius: number;
  /** Uniform scale applied to the unit-radius base geometry. */
  scale: number;
  shape: number;
  slot: number;
  /** Rock = lethal. Target = red bonus, safe to hit. */
  kind: 'rock' | 'target';
}

export interface CollisionResult {
  hit: Rock | null;
  /** A bonus rock was touched this step; it should be scored and recycled. */
  target: Rock | null;
  /** 0..1, how close the nearest non-hit pass was. */
  nearMiss: number;
}

export class AsteroidField {
  readonly group = new THREE.Group();

  private readonly rocks: Rock[] = [];
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly targetMeshes: THREE.InstancedMesh[] = [];
  private readonly haloMeshes: THREE.InstancedMesh[] = [];
  private readonly boundingRadii: number[] = [];
  private readonly rng: () => number;

  private readonly dummy = new THREE.Object3D();
  private readonly haloDummy = new THREE.Object3D();
  private readonly spinQuat = new THREE.Quaternion();
  private readonly segment = new THREE.Line3();
  private readonly closest = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly corridor = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly push = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  constructor(seed = 1337, count = 250, targetCount = TARGET_COUNT) {
    this.rng = makeRng(seed);
    this.buildShapes(
      Math.ceil(count / SHAPE_COUNT),
      Math.max(1, Math.ceil(targetCount / SHAPE_COUNT)),
    );

    for (let i = 0; i < count; i++) {
      this.rocks.push(this.createRock(i % SHAPE_COUNT, Math.floor(i / SHAPE_COUNT), 'rock'));
    }
    for (let i = 0; i < targetCount; i++) {
      this.rocks.push(
        this.createRock(i % SHAPE_COUNT, Math.floor(i / SHAPE_COUNT), 'target'),
      );
    }

    for (const mesh of [...this.meshes, ...this.targetMeshes, ...this.haloMeshes]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    }

    this.scatter(new THREE.Vector3());
  }

  /** Re-scatter the whole field around a new position (used on restart). */
  scatter(center: THREE.Vector3, forward: THREE.Vector3 = FIELD_FORWARD): void {
    for (const rock of this.rocks) {
      this.place(rock, center, null, MIN_SPAWN_DISTANCE, SPAWN_RADIUS);
    }
    this.clearStartCorridor(center, forward);
    this.seedTargetAhead(center, forward);
    this.writeMatrices();
  }

  /**
   * Advance spin, then recycle rocks that fell out of the ball.
   * `dt` should come from the fixed physics step.
   */
  update(dt: number, shipPosition: THREE.Vector3, shipForward: THREE.Vector3): void {
    const radiusSq = FIELD_RADIUS * FIELD_RADIUS;

    for (const rock of this.rocks) {
      if (rock.position.distanceToSquared(shipPosition) > radiusSq) {
        // Recycle out at the fog horizon, biased into the forward hemisphere.
        // Respawning anywhere in the ball (as the initial scatter does) would
        // teleport rocks into view, which reads as a rendering glitch.
        this.place(rock, shipPosition, shipForward, RECYCLE_RADIUS - 18, RECYCLE_RADIUS);
        continue;
      }

      const spinSpeed = rock.spin.length();
      if (spinSpeed > 0) {
        this.spinQuat.setFromAxisAngle(
          this.tmpAxis.copy(rock.spin).divideScalar(spinSpeed),
          spinSpeed * dt,
        );
        rock.quaternion.multiply(this.spinQuat).normalize();
      }
    }

    this.writeMatrices();
  }

  private readonly tmpAxis = new THREE.Vector3();

  /**
   * Swept collision test.
   *
   * `previous` and `current` are the ship's sphere centres before and after the
   * step. Testing the segment between them (instead of just the current point)
   * is what stops the ship tunnelling through a rock at 150 m/s.
   */
  query(previous: THREE.Vector3[], current: THREE.Vector3[]): CollisionResult {
    let hit: Rock | null = null;
    let target: Rock | null = null;
    let nearMiss = 0;

    for (const rock of this.rocks) {
      if (rock.position.distanceToSquared(current[1]!) > (rock.radius + 60) ** 2) continue;

      for (let i = 0; i < current.length; i++) {
        this.segment.set(previous[i]!, current[i]!);
        this.segment.closestPointToPoint(rock.position, true, this.closest);
        const distance = this.closest.distanceTo(rock.position);
        // 0.9 keeps the hitbox just inside the visible silhouette, so grazes
        // read as grazes instead of unfair deaths.
        const contact = rock.radius * 0.9 + SHIP.colliderRadius;

        if (distance < contact) {
          if (rock.kind === 'target') {
            target ??= rock;
          } else {
            hit ??= rock;
          }
        } else if (rock.kind === 'rock' && distance < contact + 3.5) {
          nearMiss = Math.max(nearMiss, 1 - (distance - contact) / 3.5);
        }
      }

      if (hit && target) break;
    }

    return { hit, target, nearMiss };
  }

  /**
   * Push every rock out of a sphere. Used to keep the station approach clean:
   * the field streams new rocks in as the ship flies, so clearing once at
   * placement would be undone within seconds.
   */
  clearSphere(center: THREE.Vector3, radius: number): void {
    for (const rock of this.rocks) {
      this.push.copy(rock.position).sub(center);
      const distance = this.push.length();
      const room = radius + rock.radius + 3;
      if (distance >= room) continue;

      if (distance < 0.001) {
        this.push.set(1, 0, 0);
      } else {
        this.push.divideScalar(distance);
      }
      rock.position.copy(center).addScaledVector(this.push, room);
    }

    this.writeMatrices();
  }

  /** Move a scored bonus rock far away so it cannot be hit twice. */
  recycleTarget(rock: Rock, center: THREE.Vector3, forward: THREE.Vector3): void {
    this.place(rock, center, forward, 120, RECYCLE_RADIUS);
    rock.spin.set(
      (this.rng() - 0.5) * 0.5,
      (this.rng() - 0.5) * 0.5,
      (this.rng() - 0.5) * 0.5,
    );
    this.writeMatrices();
  }

  // --- generation -----------------------------------------------------------

  private buildShapes(rockCapacity: number, targetCapacity: number): void {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.08,
      flatShading: true,
      // A whisper of self-illumination so shadowed faces don't read as holes.
      emissive: 0x0a1524,
      emissiveIntensity: 0.6,
    });
    const targetMaterial = new THREE.MeshStandardMaterial({
      // Deep red base + red self-glow reads as red rather than orange under
      // ACES tone mapping (a hotter emissive desaturates toward white).
      color: 0x6b0705,
      emissive: 0xe0150a,
      emissiveIntensity: 1.15,
      roughness: 0.5,
      metalness: 0.12,
      flatShading: true,
    });
    // Additive back-faces read as a soft rim of light around the core.
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4526,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });

    for (let s = 0; s < SHAPE_COUNT; s++) {
      const geometry = this.makeRockGeometry(s);
      geometry.computeVertexNormals();

      // Measure the deformed hull so instance scale maps to a known radius.
      const position = geometry.getAttribute('position');
      let maxRadius = 0;
      for (let i = 0; i < position.count; i++) {
        const r = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
        if (r > maxRadius) maxRadius = r;
      }
      this.boundingRadii[s] = maxRadius;

      // Capacity is fixed up front so per-instance colour writes are in range.
      this.meshes[s] = new THREE.InstancedMesh(geometry, material, rockCapacity);
      this.targetMeshes[s] = new THREE.InstancedMesh(geometry, targetMaterial, targetCapacity);
      this.haloMeshes[s] = new THREE.InstancedMesh(geometry, haloMaterial, targetCapacity);
    }
  }

  private makeRockGeometry(shape: number): THREE.BufferGeometry {
    // Detail 1 = 80 faces: chunky, readable, cheap. Detail 2 looks better but
    // quadruples the vertex count across ~820 instances.
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;

    const offsetX = this.rng() * 100;
    const offsetY = this.rng() * 100;
    const offsetZ = this.rng() * 100;
    const seed = shape * 977;

    // Per-shape squash gives the silhouettes variety without more noise.
    const squashX = 0.82 + this.rng() * 0.45;
    const squashY = 0.74 + this.rng() * 0.42;
    const squashZ = 0.84 + this.rng() * 0.42;

    const v = new THREE.Vector3();
    const dir = new THREE.Vector3();

    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).normalize();
      dir.copy(v);

      // Two noise octaves: broad lumps, then surface detail. Keyed on direction
      // so duplicated seam vertices always agree.
      const broad = fbm3(
        dir.x * 1.7 + offsetX,
        dir.y * 1.7 + offsetY,
        dir.z * 1.7 + offsetZ,
        2,
        seed,
      );
      const detail = fbm3(
        dir.x * 4.6 + offsetY,
        dir.y * 4.6 + offsetZ,
        dir.z * 4.6 + offsetX,
        2,
        seed + 17,
      );

      let radius = 1 + (broad - 0.5) * 0.62 + (detail - 0.5) * 0.16;
      // A few flat-ish faces where the noise dips, so rocks aren't all blobs.
      if (broad < 0.42) radius *= 0.94;
      radius = Math.max(0.55, radius);

      v.multiplyScalar(radius);
      v.x *= squashX;
      v.y *= squashY;
      v.z *= squashZ;

      position.setXYZ(i, v.x, v.y, v.z);
    }

    position.needsUpdate = true;
    return geometry;
  }

  private createRock(shape: number, slot: number, kind: 'rock' | 'target'): Rock {
    const isTarget = kind === 'target';
    // Targets are deliberately small: a bonus you have to aim at, not a wall.
    const radius = isTarget
      ? TARGET_MIN_RADIUS + this.rng() * (TARGET_MAX_RADIUS - TARGET_MIN_RADIUS)
      : this.rockRadius();

    if (!isTarget) {
      // Rock tint: cold greys with a little mineral variation. Lifted enough
      // that silhouettes separate from the background at distance.
      const warmth = (this.rng() - 0.5) * 0.12;
      const shade = 0.3 + this.rng() * 0.26;
      const color = new THREE.Color().setHSL(0.58 + warmth, 0.1 + this.rng() * 0.08, shade);
      this.meshes[shape]!.setColorAt(slot, color);
    }

    // Targets tumble faster so they catch the eye.
    const spinScale = isTarget ? 0.55 : 0.34;

    return {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          this.rng() * Math.PI * 2,
          this.rng() * Math.PI * 2,
          this.rng() * Math.PI * 2,
        ),
      ),
      spin: new THREE.Vector3(
        (this.rng() - 0.5) * spinScale,
        (this.rng() - 0.5) * spinScale,
        (this.rng() - 0.5) * spinScale,
      ),
      radius,
      scale: radius / this.boundingRadii[shape]!,
      shape,
      slot,
      kind,
    };
  }

  private rockRadius(): number {
    // Mixed sizes beat a uniform scatter: a few big readable blockers with
    // gates between them read better than a fog of pebbles, and a handful of
    // large rocks is fairer than hundreds of invisible small ones.
    const roll = this.rng();
    if (roll < 0.28) return 2.4 + this.rng() * 2.8; // debris
    if (roll < 0.8) return 5.5 + this.rng() * 6.5; // mid-field
    return 13 + this.rng() * 12; // blockers
  }

  /**
   * Drop a rock somewhere in the shell around `center`.
   *
   * `forward` biases placement into the hemisphere the player is flying toward.
   * Recycled rocks use it so the replacement happens where the player is
   * already looking into fog, rather than appearing in view.
   */
  private place(
    rock: Rock,
    center: THREE.Vector3,
    forward: THREE.Vector3 | null,
    minDistance: number,
    maxDistance: number,
  ): void {
    // Random direction on the sphere, squashed vertically so the field reads
    // as a flattish belt rather than an evenly stuffed ball.
    const theta = this.rng() * Math.PI * 2;
    const cosPhi = this.rng() * 2 - 1;
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    this.dir.set(sinPhi * Math.cos(theta), cosPhi * 0.62, sinPhi * Math.sin(theta)).normalize();

    if (forward) {
      this.dir.lerp(forward, 0.55);
      if (this.dir.lengthSq() < 1e-6) this.dir.copy(forward);
      this.dir.normalize();
    }

    const distance = minDistance + this.rng() * (maxDistance - minDistance);
    rock.position.copy(center).addScaledVector(this.dir, distance);

    rock.quaternion.setFromEuler(
      new THREE.Euler(
        this.rng() * Math.PI * 2,
        this.rng() * Math.PI * 2,
        this.rng() * Math.PI * 2,
      ),
    );
  }

  /**
   * Push every lethal rock out of a straight tube ahead of the start position.
   *
   * The initial scatter is uniform, so without this a run can begin with a
   * blocker a second away — that reads as the game killing you for launching.
   */
  private clearStartCorridor(center: THREE.Vector3, forward: THREE.Vector3): void {
    for (const rock of this.rocks) {
      if (rock.kind !== 'rock') continue;

      this.corridor.copy(rock.position).sub(center);
      const ahead = this.corridor.dot(forward);
      if (ahead <= 0 || ahead > START_CORRIDOR_LENGTH) continue;

      // Perpendicular distance from the corridor axis.
      this.corridor.addScaledVector(forward, -ahead);
      const sideways = this.corridor.length();
      const room = START_CORRIDOR_RADIUS + rock.radius;
      if (sideways >= room) continue;

      // A rock exactly on the axis needs an arbitrary perpendicular.
      if (sideways < 0.001) {
        this.corridor.crossVectors(forward, this.worldUp);
        if (this.corridor.lengthSq() < 1e-6) this.corridor.set(1, 0, 0);
        this.corridor.normalize();
      } else {
        this.corridor.divideScalar(sideways);
      }

      // Always shove it further out, never across to the opposite side.
      rock.position.addScaledVector(this.corridor, room - sideways + 4);
    }
  }

  /** Put one bonus rock in view at the start so the red is discoverable. */
  private seedTargetAhead(center: THREE.Vector3, forward: THREE.Vector3): void {
    const target = this.rocks.find((rock) => rock.kind === 'target');
    if (!target) return;

    this.side.crossVectors(forward, this.worldUp);
    if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
    this.side.normalize();

    for (let attempt = 0; attempt < 3; attempt++) {
      target.position
        .copy(center)
        .addScaledVector(forward, 118 + attempt * 40)
        .addScaledVector(this.side, 18)
        .addScaledVector(this.worldUp, 5);

      const blocked = this.rocks.some(
        (rock) =>
          rock.kind === 'rock' &&
          rock.position.distanceTo(target.position) < rock.radius + target.radius + 6,
      );
      if (!blocked) return;
    }
  }

  private writeMatrices(): void {
    for (const rock of this.rocks) {
      if (rock.kind === 'rock') {
        const mesh = this.meshes[rock.shape]!;
        this.dummy.position.copy(rock.position);
        this.dummy.quaternion.copy(rock.quaternion);
        this.dummy.scale.setScalar(rock.scale);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(rock.slot, this.dummy.matrix);
        continue;
      }

      const core = this.targetMeshes[rock.shape]!;
      this.dummy.position.copy(rock.position);
      this.dummy.quaternion.copy(rock.quaternion);
      this.dummy.scale.setScalar(rock.scale);
      this.dummy.updateMatrix();
      core.setMatrixAt(rock.slot, this.dummy.matrix);

      const halo = this.haloMeshes[rock.shape]!;
      this.haloDummy.position.copy(rock.position);
      this.haloDummy.quaternion.copy(rock.quaternion);
      this.haloDummy.scale.setScalar(rock.scale * HALO_SCALE);
      this.haloDummy.updateMatrix();
      halo.setMatrixAt(rock.slot, this.haloDummy.matrix);
    }

    for (const mesh of [...this.meshes, ...this.targetMeshes, ...this.haloMeshes]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

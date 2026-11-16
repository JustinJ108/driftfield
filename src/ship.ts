import * as THREE from 'three';

/**
 * Flight model tuning. Everything here is meant to be fiddled with — the
 * numbers below are the difference between "spaceship" and "ice cube".
 */
export const SHIP = {
  /** Hands-off forward speed. The ship is always moving; this is a runner. */
  cruiseSpeed: 54,
  /** W held. */
  fullThrottleSpeed: 92,
  /** S held. */
  brakeSpeed: 15,
  /** Shift held. */
  boostSpeed: 152,

  accel: 58,
  decel: 34,
  boostAccel: 105,

  /** Peak rotation rates, radians/sec. */
  pitchRate: 1.85,
  yawRate: 1.45,
  rollRate: 2.5,
  /** Bank angle (radians) a full yaw input rolls toward, like a coordinated turn. */
  maxBank: 0.9,
  /** How hard the ship chases that bank angle (and wings-level when yaw is 0). */
  bankResponse: 2.1,
  /** How fast angular velocity chases the stick. Lower = heavier, floatier. */
  angularResponse: 6.5,

  /** W/S move the held throttle setting at this many speed units per second. */
  throttleRate: 46,

  /** Collision proxy: a short chain of spheres down the hull. */
  colliderRadius: 1.0,
  colliderOffsets: [-1.7, 0, 1.6],
} as const;

export interface ShipInput {
  /** -1..1, positive pitches the nose up. */
  pitch: number;
  /** -1..1, positive yaws left. */
  yaw: number;
  /** -1..1, positive rolls right wing down. */
  roll: number;
  /** -1..1, positive opens the throttle. */
  throttle: number;
  boost: boolean;
}

export const EMPTY_INPUT: ShipInput = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 0,
  boost: false,
};

const FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

export class Ship {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly angularVelocity = new THREE.Vector3();

  /** Position of each collision sphere this frame. */
  readonly colliders: THREE.Vector3[] = [];
  /** Same, last physics step — used for swept tests at speed. */
  readonly previousColliders: THREE.Vector3[] = [];

  speed: number = SHIP.cruiseSpeed;
  /** Held throttle target: W/S move it, releasing leaves it where it is. */
  throttleSetting: number = SHIP.cruiseSpeed;

  private readonly engineGlow: THREE.Mesh;
  private readonly targetAngular = new THREE.Vector3();
  private readonly deltaQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private readonly right = new THREE.Vector3();
  private readonly bankUp = new THREE.Vector3();

  constructor() {
    this.buildMesh();
    this.engineGlow = this.group.getObjectByName('engine-glow') as THREE.Mesh;

    for (let i = 0; i < SHIP.colliderOffsets.length; i++) {
      this.colliders.push(new THREE.Vector3());
      this.previousColliders.push(new THREE.Vector3());
    }
    this.reset();
  }

  reset(): void {
    this.position.set(0, 0, 0);
    this.quaternion.identity();
    this.angularVelocity.set(0, 0, 0);
    this.speed = SHIP.cruiseSpeed;
    this.throttleSetting = SHIP.cruiseSpeed;
    this.syncTransform();
    this.updateColliders();
    this.previousColliders.forEach((v, i) => v.copy(this.colliders[i]!));
  }

  update(dt: number, input: ShipInput): void {
    this.previousColliders.forEach((v, i) => v.copy(this.colliders[i]!));

    // --- rotation -----------------------------------------------------------
    // Angular velocity chases the input instead of snapping to it. This single
    // lerp is most of why the ship feels like it has mass.
    //
    // Yaw also commands a bank: full left yaw rolls toward `maxBank` of left
    // bank, full right yaw the mirror. With no yaw (or manual roll) the wings
    // ease back to level, so turns lean and then settle instead of leaving the
    // ship permanently knife-edge.
    const bank = this.bankAngle();
    const bankCommand = input.yaw * SHIP.maxBank;
    const bankRoll =
      input.roll === 0 ? (bankCommand - bank) * SHIP.bankResponse : 0;

    this.targetAngular.set(
      input.pitch * SHIP.pitchRate,
      input.yaw * SHIP.yawRate,
      input.roll * SHIP.rollRate + bankRoll,
    );
    const response = 1 - Math.exp(-SHIP.angularResponse * dt);
    this.angularVelocity.lerp(this.targetAngular, response);

    this.tmpEuler.set(
      this.angularVelocity.x * dt,
      this.angularVelocity.y * dt,
      this.angularVelocity.z * dt,
      'XYZ',
    );
    this.deltaQuat.setFromEuler(this.tmpEuler);
    // Local-frame multiply: rotate about the ship's own axes.
    this.quaternion.multiply(this.deltaQuat).normalize();

    // --- translation --------------------------------------------------------
    // W/S set the throttle and the setting stays put: letting go of S must not
    // spring the ship back to cruise speed.
    this.throttleSetting = clampSpeed(
      this.throttleSetting + input.throttle * SHIP.throttleRate * dt,
      SHIP.brakeSpeed,
      SHIP.fullThrottleSpeed,
    );
    const targetSpeed = input.boost ? SHIP.boostSpeed : this.throttleSetting;
    const rate =
      targetSpeed > this.speed
        ? input.boost
          ? SHIP.boostAccel
          : SHIP.accel
        : SHIP.decel;
    this.speed = moveTowards(this.speed, targetSpeed, rate * dt);

    this.forward.copy(FORWARD).applyQuaternion(this.quaternion);
    this.up.copy(LOCAL_UP).applyQuaternion(this.quaternion);
    this.position.addScaledVector(this.forward, this.speed * dt);

    this.syncTransform();
    this.updateColliders();

    // Burn glow scales with how hard the engine is working.
    const burn = (this.speed - SHIP.cruiseSpeed) / (SHIP.boostSpeed - SHIP.cruiseSpeed);
    const glowScale = 1 + Math.max(0, burn) * 1.6;
    this.engineGlow.scale.set(glowScale, glowScale, 0.6 + glowScale * 1.1);
  }

  /** Freeze the ship where it is (crash state). */
  halt(): void {
    this.speed = 0;
    this.angularVelocity.set(0, 0, 0);
  }

  /**
   * Roll angle in radians, positive = right wing raised (a left bank).
   * Derived from the ship's own axes so it survives any attitude.
   */
  private bankAngle(): number {
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.bankUp.set(0, 1, 0).applyQuaternion(this.quaternion);
    // Near-vertical or inverted: "bank" has no stable meaning, so don't fight it.
    if (this.bankUp.y < 0.25) return 0;
    return Math.atan2(this.right.y, this.bankUp.y);
  }

  private syncTransform(): void {
    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quaternion);
  }

  private updateColliders(): void {
    for (let i = 0; i < SHIP.colliderOffsets.length; i++) {
      // Local -Z is forward, so a negative local offset sits ahead of centre.
      const ahead = -SHIP.colliderOffsets[i]!;
      this.colliders[i]!.copy(this.position).addScaledVector(this.forward, ahead);
    }
  }

  private buildMesh(): void {
    const hull = new THREE.MeshStandardMaterial({
      color: 0xd8e2ee,
      roughness: 0.42,
      metalness: 0.55,
      flatShading: true,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x1b2432,
      roughness: 0.55,
      metalness: 0.4,
      flatShading: true,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0a1a24,
      roughness: 0.1,
      metalness: 0.9,
      emissive: 0x0b3446,
      emissiveIntensity: 1.4,
    });
    const burn = new THREE.MeshBasicMaterial({
      color: 0x8fe9ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.46, 3.4, 6), hull);
    fuselage.rotation.x = -Math.PI / 2;
    fuselage.position.z = -0.15;
    this.group.add(fuselage);

    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), glass);
    canopy.scale.set(1, 0.7, 1.5);
    canopy.position.set(0, 0.22, -0.55);
    this.group.add(canopy);

    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.09, 0.78), hull);
      wing.position.set(side * 0.95, -0.02, 0.34);
      wing.rotation.y = side * 0.34;
      wing.rotation.z = side * -0.06;
      this.group.add(wing);

      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.0, 8), dark);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * 0.46, 0.02, 1.02);
      this.group.add(pod);

      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.5), hull);
      fin.position.set(side * 0.22, 0.28, 1.0);
      this.group.add(fin);
    }

    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), burn);
    glow.name = 'engine-glow';
    // Clear of the fuselage tip (z = 1.55) and the pods (z = 1.52), otherwise
    // the ship's brightest element is buried inside its own hull.
    glow.position.z = 1.78;
    glow.scale.set(1.15, 1.15, 1.7);
    this.group.add(glow);

    // Local cyan key light so the aft of the hull isn't a black silhouette
    // against a dark field.
    const engineLight = new THREE.PointLight(0x6fe4ff, 14, 22, 2);
    engineLight.position.set(0, 0.1, 1.5);
    this.group.add(engineLight);

    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 1.5), dark);
    belly.position.set(0, -0.22, 0.15);
    this.group.add(belly);
  }
}

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

function clampSpeed(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

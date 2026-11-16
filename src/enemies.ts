import * as THREE from 'three';
import { SHIP, type Ship } from './ship';

/**
 * Raiders: the only thing in the field that shoots back.
 *
 * Design constraints that keep them fair:
 * - at most one alive at once, with long gaps so combat is occasional
 * - they close to a stand-off distance instead of ramming
 * - a visible charge glow telegraphs every shot
 * - bolts are slow enough to dodge at cruise speed
 * - one solid hit from the player brings a raider down
 */

const MAX_RAIDERS = 1;
const RAIDER_HEALTH = 1;
const RAIDER_SPEED = 62;
const RAIDER_FIRE_RANGE = 240;
const RAIDER_COOLDOWN_MIN = 5.0;
const RAIDER_COOLDOWN_MAX = 7.2;
const RAIDER_CHARGE_TIME = 0.7;
const RAIDER_HIT_RADIUS = 5.6;
const RAIDER_DESPAWN_DISTANCE = 520;

const BOLT_SPEED = 88;
const BOLT_LIFE = 3.6;
const BOLT_HIT_RADIUS = 0.9;

const PLAYER_BOLT_SPEED = 240;
const PLAYER_BOLT_LIFE = 1.5;
const PLAYER_COOLDOWN = 0.15;

const SPAWN_GRACE_DISTANCE = 900;
const SPAWN_GAP_MIN = 22;
const SPAWN_GAP_MAX = 38;

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export interface RaiderEvents {
  /** An enemy bolt reached the ship. */
  onShipHit(): void;
  /** A raider was destroyed; position is a copy. */
  onRaiderDown(position: THREE.Vector3): void;
  onEnemyShot(): void;
  onPlayerShot(): void;
}

interface Raider {
  group: THREE.Group;
  hull: THREE.MeshStandardMaterial;
  charge: THREE.Mesh;
  chargeMaterial: THREE.MeshBasicMaterial;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  health: number;
  alive: boolean;
  cooldown: number;
  chargeTimer: number;
  hitFlash: number;
  phase: number;
}

interface Bolt {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  previous: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  alive: boolean;
  enemy: boolean;
}

interface Explosion {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  max: number;
}

export class Raiders {
  readonly group = new THREE.Group();

  private readonly raiders: Raider[] = [];
  private readonly enemyBolts: Bolt[] = [];
  private readonly playerBolts: Bolt[] = [];
  private readonly explosions: Explosion[] = [];

  private readonly segment = new THREE.Line3();
  private readonly closest = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  private travel = 0;
  private spawnTimer = 5;
  private fireTimer = 0;

  constructor() {
    for (let i = 0; i < MAX_RAIDERS; i++) {
      this.raiders.push(this.buildRaider());
    }

    const enemyMaterial = new THREE.MeshBasicMaterial({
      color: 0xff5a2a,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const playerMaterial = new THREE.MeshBasicMaterial({
      color: 0x9ff5ff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const boltGeometry = new THREE.SphereGeometry(0.45, 6, 5);
    for (let i = 0; i < 40; i++) {
      this.enemyBolts.push(this.buildBolt(boltGeometry, enemyMaterial, true));
    }
    for (let i = 0; i < 16; i++) {
      this.playerBolts.push(this.buildBolt(boltGeometry, playerMaterial, false));
    }

    const blastGeometry = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < 5; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xff9a52,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(blastGeometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.explosions.push({ mesh, material, life: 0, max: 1 });
    }

    this.group.traverse((object) => {
      object.frustumCulled = false;
    });
  }

  reset(): void {
    this.travel = 0;
    this.spawnTimer = 5.5;
    this.fireTimer = 0;
    for (const raider of this.raiders) {
      raider.alive = false;
      raider.group.visible = false;
    }
    for (const bolt of [...this.enemyBolts, ...this.playerBolts]) this.hideBolt(bolt);
    for (const explosion of this.explosions) {
      explosion.life = 0;
      explosion.mesh.visible = false;
    }
  }

  /** Hide live bolts (used on death so they don't hang in the air). */
  stop(): void {
    for (const bolt of [...this.enemyBolts, ...this.playerBolts]) this.hideBolt(bolt);
    for (const raider of this.raiders) {
      raider.chargeTimer = 0;
      raider.chargeMaterial.opacity = 0;
    }
  }

  /** Distance to the closest living raider, or Infinity. */
  nearest(shipPosition: THREE.Vector3): number {
    let best = Infinity;
    for (const raider of this.raiders) {
      if (!raider.alive) continue;
      best = Math.min(best, raider.position.distanceTo(shipPosition));
    }
    return best;
  }

  /** Number of raiders destroyed this run (for the death panel). */
  get activeCount(): number {
    return this.raiders.reduce((n, raider) => n + (raider.alive ? 1 : 0), 0);
  }

  update(dt: number, ship: Ship, firing: boolean, events: RaiderEvents): void {
    this.travel += ship.speed * dt;

    this.spawnTimer -= dt;
    if (
      this.travel > SPAWN_GRACE_DISTANCE &&
      this.spawnTimer <= 0 &&
      this.raiders.some((raider) => !raider.alive)
    ) {
      this.spawn(ship);
      this.spawnTimer = SPAWN_GAP_MIN + Math.random() * (SPAWN_GAP_MAX - SPAWN_GAP_MIN);
    }

    for (const raider of this.raiders) {
      if (raider.alive) this.updateRaider(dt, raider, ship, events);
    }

    if (firing) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this.firePlayer(ship, events);
        this.fireTimer = PLAYER_COOLDOWN;
      }
    } else {
      this.fireTimer = Math.min(0, this.fireTimer);
    }

    for (const bolt of this.enemyBolts) this.stepBolt(dt, bolt, ship, events);
    for (const bolt of this.playerBolts) this.stepBolt(dt, bolt, ship, events);
    this.updateExplosions(dt);
  }

  // --- raiders --------------------------------------------------------------

  private spawn(ship: Ship): void {
    const raider = this.raiders.find((candidate) => !candidate.alive);
    if (!raider) return;

    this.right.crossVectors(ship.forward, UP);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.right, ship.forward).normalize();

    const ahead = 250 + Math.random() * 130;
    raider.position
      .copy(ship.position)
      .addScaledVector(ship.forward, ahead)
      .addScaledVector(this.right, (Math.random() * 2 - 1) * 80)
      .addScaledVector(this.up, (Math.random() * 2 - 1) * 26);

    raider.velocity.set(0, 0, 0);
    raider.health = RAIDER_HEALTH;
    raider.alive = true;
    raider.cooldown = 1.2;
    raider.chargeTimer = 0;
    raider.hitFlash = 0;
    raider.phase = Math.random() * Math.PI * 2;
    raider.group.visible = true;
    raider.group.position.copy(raider.position);
    raider.group.lookAt(ship.position);
  }

  private updateRaider(dt: number, raider: Raider, ship: Ship, events: RaiderEvents): void {
    raider.phase += dt * 0.5;

    this.right.crossVectors(ship.forward, UP);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.right, ship.forward).normalize();

    // Stand off ahead of the ship and slide side to side. Close enough to shoot,
    // far enough that the player has time to line up.
    this.tmpA
      .copy(ship.position)
      .addScaledVector(ship.forward, 72)
      .addScaledVector(this.right, Math.sin(raider.phase) * 54)
      .addScaledVector(this.up, Math.cos(raider.phase) * 20 + 12);

    this.tmpB.copy(this.tmpA).sub(raider.position);
    const toDesired = this.tmpB.length();
    if (toDesired > 0.01) this.tmpB.multiplyScalar(Math.min(RAIDER_SPEED, toDesired * 1.7) / toDesired);
    raider.velocity.lerp(this.tmpB, 1 - Math.exp(-1.5 * dt));
    raider.position.addScaledVector(raider.velocity, dt);
    raider.group.position.copy(raider.position);
    raider.group.lookAt(ship.position);

    // Hit flare fades out.
    raider.hitFlash = Math.max(0, raider.hitFlash - dt * 6);
    raider.hull.emissiveIntensity = 0.7 + raider.hitFlash * 7;

    if (raider.position.distanceTo(ship.position) > RAIDER_DESPAWN_DISTANCE) {
      raider.alive = false;
      raider.group.visible = false;
      return;
    }

    this.tmpC.copy(ship.position).sub(raider.position);
    const distance = this.tmpC.length();
    raider.group.getWorldDirection(this.tmpD);
    const facing = this.tmpD.dot(this.tmpC.normalize());
    const canFire = distance < RAIDER_FIRE_RANGE && distance > 22 && facing > 0.55;

    raider.cooldown = Math.max(0, raider.cooldown - dt);

    if (!canFire) {
      raider.chargeTimer = 0;
      raider.chargeMaterial.opacity = 0;
      return;
    }

    raider.chargeTimer += dt;
    const charge = Math.min(1, raider.chargeTimer / RAIDER_CHARGE_TIME);
    raider.chargeMaterial.opacity = 0.15 + charge * 0.8;
    raider.charge.scale.setScalar(0.5 + charge * 1.35);

    if (charge >= 1 && raider.cooldown === 0) {
      this.fireEnemyBolt(raider, ship, events);
      raider.cooldown =
        RAIDER_COOLDOWN_MIN + Math.random() * (RAIDER_COOLDOWN_MAX - RAIDER_COOLDOWN_MIN);
      raider.chargeTimer = 0;
      raider.chargeMaterial.opacity = 0;
    }
  }

  private fireEnemyBolt(raider: Raider, ship: Ship, events: RaiderEvents): void {
    const bolt = this.enemyBolts.find((candidate) => !candidate.alive);
    if (!bolt) return;

    // Aim slightly ahead of the ship. Enough to matter, not enough to be unfair.
    this.tmpA
      .copy(ship.position)
      .addScaledVector(ship.forward, ship.speed * 0.22)
      .sub(raider.position)
      .normalize();

    bolt.position.copy(raider.position).addScaledVector(this.tmpA, 2.8);
    bolt.previous.copy(bolt.position);
    bolt.velocity.copy(this.tmpA).multiplyScalar(BOLT_SPEED);
    bolt.life = BOLT_LIFE;
    bolt.alive = true;
    bolt.mesh.visible = true;
    bolt.mesh.position.copy(bolt.position);
    bolt.mesh.quaternion.setFromUnitVectors(Z_AXIS, this.tmpA);
    events.onEnemyShot();
  }

  // --- player weapon --------------------------------------------------------

  private firePlayer(ship: Ship, events: RaiderEvents): void {
    this.right.set(1, 0, 0).applyQuaternion(ship.quaternion);

    for (const side of [-1, 1]) {
      const bolt = this.playerBolts.find((candidate) => !candidate.alive);
      if (!bolt) break;

      bolt.position
        .copy(ship.position)
        .addScaledVector(this.right, side * 0.95)
        .addScaledVector(ship.forward, 1.4);
      bolt.previous.copy(bolt.position);
      bolt.velocity.copy(ship.forward).multiplyScalar(PLAYER_BOLT_SPEED + ship.speed);
      bolt.life = PLAYER_BOLT_LIFE;
      bolt.alive = true;
      bolt.mesh.visible = true;
      bolt.mesh.position.copy(bolt.position);
      bolt.mesh.quaternion.setFromUnitVectors(Z_AXIS, ship.forward);
    }

    events.onPlayerShot();
  }

  // --- bolts ----------------------------------------------------------------

  private stepBolt(dt: number, bolt: Bolt, ship: Ship, events: RaiderEvents): void {
    if (!bolt.alive) return;

    bolt.previous.copy(bolt.position);
    bolt.position.addScaledVector(bolt.velocity, dt);
    bolt.life -= dt;
    bolt.mesh.position.copy(bolt.position);

    if (bolt.life <= 0) {
      this.hideBolt(bolt);
      return;
    }

    if (bolt.enemy) {
      if (this.boltHitsShip(bolt, ship)) {
        this.hideBolt(bolt);
        events.onShipHit();
      }
      return;
    }

    for (const raider of this.raiders) {
      if (!raider.alive) continue;
      this.segment.set(bolt.previous, bolt.position);
      this.segment.closestPointToPoint(raider.position, true, this.closest);
      if (this.closest.distanceTo(raider.position) < RAIDER_HIT_RADIUS) {
        this.hideBolt(bolt);
        this.damageRaider(raider, events);
        return;
      }
    }
  }

  /** Swept test against the ship's 3-sphere collider chain. */
  private boltHitsShip(bolt: Bolt, ship: Ship): boolean {
    for (let i = 0; i < ship.colliders.length; i++) {
      this.segment.set(ship.previousColliders[i]!, ship.colliders[i]!);
      this.segment.closestPointToPoint(bolt.position, true, this.closest);
      if (this.closest.distanceTo(bolt.position) < BOLT_HIT_RADIUS + SHIP.colliderRadius) {
        return true;
      }
    }
    return false;
  }

  private damageRaider(raider: Raider, events: RaiderEvents): void {
    raider.health -= 1;
    raider.hitFlash = 1;

    if (raider.health > 0) return;

    raider.alive = false;
    raider.group.visible = false;
    raider.chargeMaterial.opacity = 0;
    this.explode(raider.position);
    events.onRaiderDown(raider.position.clone());
  }

  // --- effects --------------------------------------------------------------

  private explode(position: THREE.Vector3): void {
    const blast = this.explosions.find((explosion) => explosion.life <= 0);
    if (!blast) return;

    blast.max = 0.55;
    blast.life = blast.max;
    blast.mesh.position.copy(position);
    blast.mesh.scale.setScalar(2.5);
    blast.mesh.visible = true;
    blast.material.opacity = 0.9;
  }

  private updateExplosions(dt: number): void {
    for (const blast of this.explosions) {
      if (blast.life <= 0) continue;
      blast.life -= dt;
      const t = 1 - blast.life / blast.max;
      blast.mesh.scale.setScalar(2.5 + t * 13);
      blast.material.opacity = Math.max(0, 0.9 * (1 - t));
      if (blast.life <= 0) blast.mesh.visible = false;
    }
  }

  // --- construction ---------------------------------------------------------

  private buildRaider(): Raider {
    const group = new THREE.Group();

    const hull = new THREE.MeshStandardMaterial({
      color: 0x6d2530,
      roughness: 0.5,
      metalness: 0.55,
      flatShading: true,
      emissive: 0x3a0509,
      emissiveIntensity: 0.7,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x140f16,
      roughness: 0.55,
      metalness: 0.5,
      flatShading: true,
    });
    const glow = new THREE.MeshBasicMaterial({
      color: 0xff4a24,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const chargeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    // The raider model faces +Z so `group.lookAt(ship)` aims the nose at the player.
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(1.9, 0), hull);
    body.scale.set(1, 0.6, 1.6);
    group.add(body);

    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 1.0), hull);
      wing.position.set(side * 1.75, 0, -0.35);
      wing.rotation.z = side * 0.24;
      wing.rotation.y = -side * 0.4;
      group.add(wing);

      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 1.3, 6), dark);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * 0.85, 0, -1.1);
      group.add(pod);
    }

    const engine = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), glow);
    engine.scale.set(0.8, 0.8, 1.8);
    engine.position.z = -1.9;
    group.add(engine);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.4, 5), dark);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 1.5;
    group.add(nose);

    const charge = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), chargeMaterial);
    charge.position.z = 2.2;
    group.add(charge);

    group.visible = false;
    this.group.add(group);

    return {
      group,
      hull,
      charge,
      chargeMaterial,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      health: RAIDER_HEALTH,
      alive: false,
      cooldown: 0,
      chargeTimer: 0,
      hitFlash: 0,
      phase: 0,
    };
  }

  private buildBolt(
    geometry: THREE.SphereGeometry,
    material: THREE.MeshBasicMaterial,
    enemy: boolean,
  ): Bolt {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(0.55, 0.55, 2.8);
    mesh.visible = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);

    return {
      mesh,
      position: new THREE.Vector3(),
      previous: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      life: 0,
      alive: false,
      enemy,
    };
  }

  private hideBolt(bolt: Bolt): void {
    bolt.alive = false;
    bolt.life = 0;
    bolt.mesh.visible = false;
  }
}

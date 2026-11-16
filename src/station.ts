import * as THREE from 'three';

/**
 * A docking ring. It is the only place ore becomes points, so it has to be
 * readable from a long way off: big ring, bright rim, blinking beacons, and a
 * local light. The HUD marker does the rest.
 *
 * Docking is deliberately forgiving — flying anywhere inside the ring's radius
 * counts, not just dead centre through the hole.
 */

export const STATION_RING_RADIUS = 24;
const DOCK_RADIUS = STATION_RING_RADIUS;
/** Keep the ring's structure clear of rocks so the approach is clean. */
export const STATION_CLEAR_RADIUS = 46;

const UP = new THREE.Vector3(0, 1, 0);

export class Station {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly dockRadius = DOCK_RADIUS;

  private readonly wheel = new THREE.Group();
  private readonly beaconMeshes: THREE.Mesh[] = [];
  private readonly beaconMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly glowLight: THREE.PointLight;
  private time = 0;
  private pulse = 0;

  constructor() {
    const hull = new THREE.MeshStandardMaterial({
      color: 0xc3d2e2,
      roughness: 0.5,
      metalness: 0.7,
      flatShading: true,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x121d29,
      roughness: 0.45,
      metalness: 0.6,
      emissive: 0x0b2f3d,
      emissiveIntensity: 0.9,
      flatShading: true,
    });
    const rimGlow = new THREE.MeshBasicMaterial({
      color: 0x8ff4ff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.wheel.rotation.z = 0.2;
    this.group.add(this.wheel);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(STATION_RING_RADIUS, 1.5, 8, 56),
      hull,
    );
    this.wheel.add(ring);

    // A dark inner lip reads as depth against the bright rim.
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(STATION_RING_RADIUS - 3.2, 0.55, 6, 44),
      dark,
    );
    this.wheel.add(lip);

    // Thin glowing line just inside the ring: the "land here" cue.
    const guide = new THREE.Mesh(
      new THREE.TorusGeometry(STATION_RING_RADIUS - 1.4, 0.16, 4, 56),
      rimGlow,
    );
    this.wheel.add(guide);

    // Modules clamped around the rim.
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const size = i % 3 === 0 ? 6.2 : 3.6;
      const module = new THREE.Mesh(
        new THREE.BoxGeometry(size, 4.6, 3.4),
        i % 2 === 0 ? hull : dark,
      );
      module.position.set(
        Math.cos(angle) * (STATION_RING_RADIUS + 1.4),
        Math.sin(angle) * (STATION_RING_RADIUS + 1.4),
        0,
      );
      module.rotation.z = angle;
      this.wheel.add(module);
    }

    // Antenna mast and dish, so the silhouette is not just a donut.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.35, 9, 6), dark);
    mast.position.set(0, STATION_RING_RADIUS + 6.4, 0);
    this.wheel.add(mast);
    const dish = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.6, 8), hull);
    dish.position.set(0, STATION_RING_RADIUS + 11.4, 0);
    dish.rotation.x = Math.PI;
    this.wheel.add(dish);

    // Blinking beacons on the cardinal points.
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const material = new THREE.MeshBasicMaterial({
        color: 0xa8fbff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6), material);
      beacon.position.set(
        Math.cos(angle) * (STATION_RING_RADIUS + 4.4),
        Math.sin(angle) * (STATION_RING_RADIUS + 4.4),
        0,
      );
      this.wheel.add(beacon);
      this.beaconMeshes.push(beacon);
      this.beaconMaterials.push(material);
    }

    this.glowLight = new THREE.PointLight(0x6fd8ff, 180, 300, 2);
    this.group.add(this.glowLight);

    this.group.traverse((object) => {
      object.frustumCulled = false;
    });
  }

  /** Put the station ahead of the ship, slightly off-axis so it must be steered to. */
  placeAhead(from: THREE.Vector3, forward: THREE.Vector3, distance = 620): void {
    const right = new THREE.Vector3().crossVectors(forward, UP);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const lateral = (Math.random() * 2 - 1) * 62;
    const vertical = (Math.random() * 2 - 1) * 24;

    this.position
      .copy(from)
      .addScaledVector(forward, distance * (0.92 + Math.random() * 0.24))
      .addScaledVector(right, lateral)
      .addScaledVector(up, vertical);

    this.group.position.copy(this.position);
    // Hole axis along the flight direction so the ring presents itself as a gate.
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward);
    this.pulse = 0;
  }

  /** Spin, blink, pulse. Cheap enough to call every frame. */
  animate(dt: number): void {
    this.time += dt;
    this.wheel.rotation.z += dt * 0.085;
    this.pulse = Math.max(0, this.pulse - dt * 1.1);

    for (let i = 0; i < this.beaconMaterials.length; i++) {
      const blink = 0.25 + 0.75 * Math.max(0, Math.sin(this.time * 2.1 - i * 0.9));
      this.beaconMaterials[i]!.opacity = blink;
      this.beaconMeshes[i]!.scale.setScalar(0.8 + blink * 0.5 + this.pulse * 1.6);
    }

    this.glowLight.intensity = 180 * (1 + this.pulse * 1.8);
  }

  /** True while the ship is inside the docking volume. */
  contains(shipPosition: THREE.Vector3): boolean {
    return this.position.distanceToSquared(shipPosition) < DOCK_RADIUS * DOCK_RADIUS;
  }

  /** Screen-space hint distance shown on the HUD. */
  distanceTo(shipPosition: THREE.Vector3): number {
    return this.position.distanceTo(shipPosition);
  }

  triggerPulse(): void {
    this.pulse = 1;
  }
}

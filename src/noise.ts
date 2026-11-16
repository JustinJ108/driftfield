/**
 * Small deterministic helpers: a 32-bit PRNG and 3D value noise.
 *
 * The asteroid geometry is deformed by sampling noise as a function of a
 * vertex's *direction*, not its index. Icosahedron geometry is non-indexed
 * (vertices are duplicated per face), so anything keyed to vertex index would
 * tear the mesh apart. Direction-keyed noise keeps seams welded for free.
 */

/** mulberry32 — tiny, fast, good enough for scattering rocks. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(i: number, j: number, k: number, seed: number): number {
  let h =
    Math.imul(i, 374761393) ^
    Math.imul(j, 668265263) ^
    Math.imul(k, 1274126177) ^
    Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Trilinear value noise in [0, 1]. */
export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);

  const c000 = hash(xi, yi, zi, seed);
  const c100 = hash(xi + 1, yi, zi, seed);
  const c010 = hash(xi, yi + 1, zi, seed);
  const c110 = hash(xi + 1, yi + 1, zi, seed);
  const c001 = hash(xi, yi, zi + 1, seed);
  const c101 = hash(xi + 1, yi, zi + 1, seed);
  const c011 = hash(xi, yi + 1, zi + 1, seed);
  const c111 = hash(xi + 1, yi + 1, zi + 1, seed);

  const x00 = lerp(c000, c100, u);
  const x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u);
  const x11 = lerp(c011, c111, u);

  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

/** Fractal sum of value noise, normalised to [0, 1]. */
export function fbm3(x: number, y: number, z: number, octaves = 3, seed = 0): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;

  for (let o = 0; o < octaves; o++) {
    sum += amplitude * valueNoise3(x * frequency, y * frequency, z * frequency, seed + o * 1013);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }

  return sum / norm;
}

/** Points are separate from distance: distance is survival, points are doing things. */
export const POINTS_PER_ORE = 500;
export const POINTS_PER_RAIDER = 1000;

export function formatPoints(points: number): string {
  return Math.round(points).toLocaleString('en-US');
}

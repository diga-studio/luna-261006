import type { Vec3 } from "./types.js";
import { dot, length, scale as vecScale } from "./math.js";

/** A support point of the Minkowski difference A - B, with source points. */
export interface SupportPoint {
  /** a - b in world coordinates. */
  w: Vec3;
  /** Support point on A (world). */
  a: Vec3;
  /** Support point on B (world). */
  b: Vec3;
}

/** Support function for the Minkowski difference of two posed convex sets. */
export type MinkowskiSupport = (dir: Vec3) => SupportPoint;

export interface GjkResult {
  /** True when the two bodies intersect (origin inside Minkowski difference). */
  intersecting: boolean;
  /** Closest point of the 1..4 vertex simplex to the origin. */
  closest: Vec3;
  /** Barycentric weights aligned with `simplex`. */
  weights: number[];
  /** Terminal simplex (reduced to the closest feature). */
  simplex: SupportPoint[];
}

interface ClosestResult {
  closest: Vec3;
  /** Barycentric weights aligned with `indices`. */
  weights: number[];
  /** Indices (into the input) of the vertices forming the closest feature. */
  indices: number[];
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-13) return null;
    if (pivot !== col) {
      const t = m[pivot]!;
      m[pivot] = m[col]!;
      m[col] = t;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / m[i]![i]!);
}

/**
 * Closest point to the origin on the convex hull of `pts` (1..4 points),
 * by enumerating the point subsets and keeping the best feature whose
 * barycentric coordinates are all strictly positive.
 */
function closestPointOnSimplex(pts: Vec3[]): ClosestResult {
  const n = pts.length;
  let best: ClosestResult | null = null;
  let bestNorm = Infinity;
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) idx.push(i);
    }
    let weights: number[];
    if (idx.length === 1) {
      weights = [1];
    } else {
      // KKT system for min |sum w_i p_i|^2 subject to sum w_i = 1.
      const k = idx.length;
      const a: number[][] = [];
      const b: number[] = [];
      for (let r = 0; r < k; r++) {
        const row: number[] = [];
        for (let c = 0; c < k; c++) row.push(dot(pts[idx[r]!]!, pts[idx[c]!]!));
        row.push(1);
        a.push(row);
        b.push(0);
      }
      a.push(new Array<number>(k).fill(1).concat([0]));
      b.push(1);
      const sol = solveLinear(a, b);
      if (sol === null) continue;
      weights = sol.slice(0, k);
      if (weights.some((w) => w <= 1e-12)) continue;
    }
    const closest: Vec3 = [0, 0, 0];
    for (let j = 0; j < idx.length; j++) {
      const p = pts[idx[j]!]!;
      closest[0] += weights[j]! * p[0];
      closest[1] += weights[j]! * p[1];
      closest[2] += weights[j]! * p[2];
    }
    const norm = dot(closest, closest);
    if (norm < bestNorm) {
      bestNorm = norm;
      best = { closest, weights, indices: idx };
    }
  }
  if (best === null) {
    // Degenerate fallback: keep the single nearest vertex.
    let bi = 0;
    for (let i = 1; i < n; i++) {
      if (dot(pts[i]!, pts[i]!) < dot(pts[bi]!, pts[bi]!)) bi = i;
    }
    best = { closest: pts[bi]!, weights: [1], indices: [bi] };
  }
  return best;
}

/**
 * GJK distance query. When separated, returns the closest point of the
 * Minkowski difference to the origin plus barycentric witness data.
 * When intersecting, `intersecting` is true and the terminal simplex can
 * seed EPA.
 */
export function gjkDistance(support: MinkowskiSupport, initialDir: Vec3): GjkResult {
  let simplex: SupportPoint[] = [support(initialDir)];
  let scale = length(simplex[0]!.w);
  let result: GjkResult = {
    intersecting: false,
    closest: simplex[0]!.w,
    weights: [1],
    simplex,
  };

  for (let iter = 0; iter < 128; iter++) {
    const { closest, weights, indices } = closestPointOnSimplex(
      simplex.map((s) => s.w),
    );
    simplex = indices.map((i) => simplex[i]!);
    result = { intersecting: false, closest, weights, simplex };

    const dist = length(closest);
    const tol = 1e-9 * Math.max(1, scale);
    if (dist <= 1e-12 * Math.max(1, scale)) {
      result.intersecting = true;
      return result;
    }

    const dir = vecScale(closest, -1 / dist); // unit, toward the origin
    const sp = support(dir);
    scale = Math.max(scale, length(sp.w));

    // No support point passes the plane at `closest`: converged.
    if (dot(sp.w, dir) - dot(closest, dir) <= tol) return result;
    // Support point already in the simplex: cannot make progress.
    if (
      simplex.some(
        (s) =>
          s.w[0] === sp.w[0] && s.w[1] === sp.w[1] && s.w[2] === sp.w[2],
      )
    ) {
      return result;
    }
    simplex.push(sp);
  }
  return result;
}

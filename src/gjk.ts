import { add, dot, negate, scale, sub, vec3 } from "./vec3.js";
import type { Vec3 } from "./vec3.js";
import { inverseRotateVec, rotateVec } from "./quat.js";
import type { Hull, Pose } from "./types.js";

export interface SupportPoint {
  /** Point on the Minkowski difference A - B (world space). */
  v: Vec3;
  /** Witness on A (world space). */
  a: Vec3;
  /** Witness on B (world space). */
  b: Vec3;
}

export function supportWorld(hull: Hull, pose: Pose, dir: Vec3): Vec3 {
  const local = inverseRotateVec(pose.rotation, dir);
  let best = hull.vertices[0];
  let bestDot = local.x * best.x + local.y * best.y + local.z * best.z;
  for (let i = 1; i < hull.vertices.length; i++) {
    const p = hull.vertices[i];
    const d = local.x * p.x + local.y * p.y + local.z * p.z;
    if (d > bestDot) {
      bestDot = d;
      best = p;
    }
  }
  return add(rotateVec(pose.rotation, best), pose.translation);
}

export function worldVertices(hull: Hull, pose: Pose): Vec3[] {
  return hull.vertices.map((v) => add(rotateVec(pose.rotation, v), pose.translation));
}

export function minkowskiSupport(
  hullA: Hull,
  poseA: Pose,
  hullB: Hull,
  poseB: Pose,
  dir: Vec3,
): SupportPoint {
  const a = supportWorld(hullA, poseA, dir);
  const b = supportWorld(hullB, poseB, negate(dir));
  return { v: sub(a, b), a, b };
}

interface Simplex {
  pts: SupportPoint[];
}

/** Solve a small dense linear system M x = rhs by Gaussian elimination. */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const aug = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    if (Math.abs(aug[pivot][col]) < 1e-14) return null;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = aug[r][col] / aug[col][col];
      for (let c = col; c <= n; c++) aug[r][c] -= f * aug[col][c];
    }
  }
  return aug.map((row, i) => row[n] / aug[i][i]);
}

interface ClosestResult {
  /** Closest point of the simplex to the origin. */
  point: Vec3;
  /** Indices into simplex.pts forming the minimal face. */
  indices: number[];
  /** Barycentric weights aligned with indices. */
  weights: number[];
}

function closestOnSubset(simplex: Simplex, subset: number[]): { point: Vec3; weights: number[] } | null {
  const k = subset.length;
  if (k === 1) {
    return { point: simplex.pts[subset[0]].v, weights: [1] };
  }
  // KKT system: [G 1][lambda; mu] = [0; 1]
  const m: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < k; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      row.push(dot(simplex.pts[subset[i]].v, simplex.pts[subset[j]].v));
    }
    row.push(1);
    m.push(row);
    rhs.push(0);
  }
  m.push(new Array<number>(k).fill(1).concat([0]));
  rhs.push(1);
  const sol = solveLinear(m, rhs);
  if (!sol) return null;
  const weights = sol.slice(0, k);
  const point = vec3(0, 0, 0);
  for (let i = 0; i < k; i++) {
    const p = simplex.pts[subset[i]].v;
    point.x += weights[i] * p.x;
    point.y += weights[i] * p.y;
    point.z += weights[i] * p.z;
  }
  return { point, weights };
}

/** Closest point of conv(simplex) to the origin (Johnson's subalgorithm). */
function closestPoint(simplex: Simplex): ClosestResult {
  const n = simplex.pts.length;
  let best: ClosestResult | null = null;
  let bestNorm = Infinity;
  const total = 1 << n;
  for (let mask = 1; mask < total; mask++) {
    const subset: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(i);
    const cand = closestOnSubset(simplex, subset);
    if (!cand) continue;
    const tol = 1e-9;
    if (cand.weights.some((w) => w < -tol)) continue;
    // p must satisfy dot(x_j, p) >= dot(p, p) for every simplex vertex x_j.
    const pp = dot(cand.point, cand.point);
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (dot(simplex.pts[i].v, cand.point) < pp - 1e-9 * Math.max(1, pp)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const norm = Math.sqrt(pp);
    if (norm < bestNorm - 1e-12) {
      bestNorm = norm;
      // Clamp tiny negative weights to zero and renormalize.
      const weights = cand.weights.map((w) => Math.max(0, w));
      const sum = weights.reduce((s, w) => s + w, 0);
      best = {
        point: cand.point,
        indices: subset,
        weights: weights.map((w) => w / sum),
      };
    }
  }
  if (!best) {
    // Numerical fallback: keep the single nearest vertex.
    let idx = 0;
    let dmin = Infinity;
    for (let i = 0; i < n; i++) {
      const d = dot(simplex.pts[i].v, simplex.pts[i].v);
      if (d < dmin) {
        dmin = d;
        idx = i;
      }
    }
    best = { point: simplex.pts[idx].v, indices: [idx], weights: [1] };
  }
  return best;
}

function witnessPoints(simplex: Simplex, closest: ClosestResult): { pointA: Vec3; pointB: Vec3 } {
  let pointA = vec3(0, 0, 0);
  let pointB = vec3(0, 0, 0);
  for (let i = 0; i < closest.indices.length; i++) {
    const sp = simplex.pts[closest.indices[i]];
    const w = closest.weights[i];
    pointA = add(pointA, scale(sp.a, w));
    pointB = add(pointB, scale(sp.b, w));
  }
  return { pointA, pointB };
}

export interface GjkResult {
  intersecting: boolean;
  distance: number;
  pointA: Vec3;
  pointB: Vec3;
  /** Last search direction (toward the origin); a contact normal candidate. */
  direction: Vec3 | null;
  /** Terminal simplex (contains the origin when intersecting). */
  simplex: SupportPoint[];
}

const GJK_MAX_ITER = 128;
const GJK_TOL = 1e-10;

export function gjkDistance(
  hullA: Hull,
  poseA: Pose,
  hullB: Hull,
  poseB: Pose,
): GjkResult {
  const support = (dir: Vec3) => minkowskiSupport(hullA, poseA, hullB, poseB, dir);

  const centerDir = sub(
    add(poseB.translation, vec3(1e-7, 0, 0)),
    poseA.translation,
  );
  const simplex: Simplex = { pts: [support(centerDir)] };
  let closest = closestPoint(simplex);
  let lastDir: Vec3 | null = null;

  for (let iter = 0; iter < GJK_MAX_ITER; iter++) {
    const p = closest.point;
    const dist = Math.sqrt(dot(p, p));
    if (dist < GJK_TOL) {
      // Origin is on/inside the current simplex, so the bodies touch or
      // penetrate; EPA refines the distinction. The simplex barycentric
      // witnesses are exact contact points when the bodies only touch.
      const witnesses = witnessPoints(simplex, closest);
      return {
        intersecting: true,
        distance: 0,
        pointA: witnesses.pointA,
        pointB: witnesses.pointB,
        direction: lastDir,
        simplex: [...simplex.pts],
      };
    }
    const dir = scale(p, -1 / dist);
    lastDir = dir;
    const w = support(dir);
    // Convergence: support point does not pass the plane perpendicular to dir at p.
    const improvement = dot(w.v, dir) - dot(p, dir);
    if (improvement <= GJK_TOL * Math.max(1, Math.abs(dot(w.v, dir)))) {
      break;
    }
    // Duplicate support point => converged.
    if (simplex.pts.some((q) => dot(sub(q.v, w.v), sub(q.v, w.v)) < 1e-24)) {
      break;
    }
    simplex.pts.push(w);
    closest = closestPoint(simplex);
    // Reduce simplex to the minimal face.
    simplex.pts = closest.indices.map((i) => simplex.pts[i]);
    closest = closestPoint(simplex);
  }

  const p = closest.point;
  const distance = Math.sqrt(dot(p, p));
  const witnesses = witnessPoints(simplex, closest);
  return {
    intersecting: false,
    distance,
    pointA: witnesses.pointA,
    pointB: witnesses.pointB,
    direction: lastDir,
    simplex: [...simplex.pts],
  };
}

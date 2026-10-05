/**
 * Independent geometry helpers used to verify the library's results.
 * These are deliberately re-implemented here (not imported from src/) so
 * the tests provide an independent geometric ground truth.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface TestPose {
  translation: Vec3;
  quaternion: Quat;
}

export const vAdd = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const vSub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const vScale = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const vDot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vCross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vLen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vNorm = (a: Vec3): Vec3 => {
  const l = vLen(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = vNorm(axis);
  const s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

export const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function worldPoint(pose: TestPose, local: Vec3): Vec3 {
  return vAdd(quatRotate(pose.quaternion, local), pose.translation);
}

export function localPoint(pose: TestPose, world: Vec3): Vec3 {
  const inv: Quat = [
    -pose.quaternion[0],
    -pose.quaternion[1],
    -pose.quaternion[2],
    pose.quaternion[3],
  ];
  return quatRotate(inv, vSub(world, pose.translation));
}

/** 8 corners of a box centered at the local origin. */
export function boxCorners(half: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [-half[0], half[0]])
    for (const y of [-half[1], half[1]])
      for (const z of [-half[2], half[2]]) out.push([x, y, z]);
  return out;
}

/** The 12 edges of a box as index pairs into boxCorners(). */
export function boxEdgeIndices(): Array<[number, number]> {
  const c = boxCorners([1, 1, 1]);
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      let diff = 0;
      for (let k = 0; k < 3; k++) if (c[i]![k] !== c[j]![k]) diff++;
      if (diff === 1) edges.push([i, j]);
    }
  }
  return edges;
}

/** Exact distance from a world point to an OBB, with closest point. */
export function pointToBox(
  p: Vec3,
  pose: TestPose,
  half: Vec3,
): { dist: number; closest: Vec3 } {
  const l = localPoint(pose, p);
  const clamped: Vec3 = [
    Math.max(-half[0], Math.min(half[0], l[0])),
    Math.max(-half[1], Math.min(half[1], l[1])),
    Math.max(-half[2], Math.min(half[2], l[2])),
  ];
  const closest = worldPoint(pose, clamped);
  return { dist: vLen(vSub(p, closest)), closest };
}

/** Closest points between two segments (Ericson, Real-Time Collision Detection). */
export function segmentSegment(
  p1: Vec3,
  q1: Vec3,
  p2: Vec3,
  q2: Vec3,
): { dist: number; c1: Vec3; c2: Vec3 } {
  const d1 = vSub(q1, p1);
  const d2 = vSub(q2, p2);
  const r = vSub(p1, p2);
  const a = vDot(d1, d1);
  const e = vDot(d2, d2);
  const f = vDot(d2, r);
  const EPS = 1e-15;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = vDot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = vDot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const c1 = vAdd(p1, vScale(d1, s));
  const c2 = vAdd(p2, vScale(d2, t));
  return { dist: vLen(vSub(c2, c1)), c1, c2 };
}

export interface FeatureDistance {
  dist: number;
  pA: Vec3;
  pB: Vec3;
}

/**
 * Exact distance between two OBBs via feature pairs:
 * vertex-to-box (both directions, exact for boxes) and edge-to-edge.
 * Returns zero distance when the boxes overlap.
 */
export function obbDistance(
  poseA: TestPose,
  halfA: Vec3,
  poseB: TestPose,
  halfB: Vec3,
): FeatureDistance {
  const cornersA = boxCorners(halfA).map((c) => worldPoint(poseA, c));
  const cornersB = boxCorners(halfB).map((c) => worldPoint(poseB, c));
  let best: FeatureDistance = {
    dist: Infinity,
    pA: [0, 0, 0],
    pB: [0, 0, 0],
  };
  const consider = (cand: FeatureDistance): void => {
    if (cand.dist < best.dist) best = cand;
  };
  for (const v of cornersA) {
    const r = pointToBox(v, poseB, halfB);
    consider({ dist: r.dist, pA: v, pB: r.closest });
  }
  for (const v of cornersB) {
    const r = pointToBox(v, poseA, halfA);
    consider({ dist: r.dist, pA: r.closest, pB: v });
  }
  const edges = boxEdgeIndices();
  for (const [i0, i1] of edges) {
    for (const [j0, j1] of edges) {
      const r = segmentSegment(
        cornersA[i0]!,
        cornersA[i1]!,
        cornersB[j0]!,
        cornersB[j1]!,
      );
      consider({ dist: r.dist, pA: r.c1, pB: r.c2 });
    }
  }
  return best;
}

/**
 * SAT over the 15 candidate axes. Returns the maximum separation:
 * > 0 when the boxes are disjoint (a true separating axis exists),
 * <= 0 when they touch or interpenetrate.
 */
export function satSeparation(
  poseA: TestPose,
  halfA: Vec3,
  poseB: TestPose,
  halfB: Vec3,
): number {
  const cornersA = boxCorners(halfA).map((c) => worldPoint(poseA, c));
  const cornersB = boxCorners(halfB).map((c) => worldPoint(poseB, c));
  const axesA: Vec3[] = [
    quatRotate(poseA.quaternion, [1, 0, 0]),
    quatRotate(poseA.quaternion, [0, 1, 0]),
    quatRotate(poseA.quaternion, [0, 0, 1]),
  ];
  const axesB: Vec3[] = [
    quatRotate(poseB.quaternion, [1, 0, 0]),
    quatRotate(poseB.quaternion, [0, 1, 0]),
    quatRotate(poseB.quaternion, [0, 0, 1]),
  ];
  const axes: Vec3[] = [...axesA, ...axesB];
  for (const a of axesA) {
    for (const b of axesB) {
      const c = vCross(a, b);
      if (vLen(c) > 1e-9) axes.push(vNorm(c));
    }
  }
  let maxSep = -Infinity;
  for (const axis of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const p of cornersA) {
      const d = vDot(p, axis);
      minA = Math.min(minA, d);
      maxA = Math.max(maxA, d);
    }
    for (const p of cornersB) {
      const d = vDot(p, axis);
      minB = Math.min(minB, d);
      maxB = Math.max(maxB, d);
    }
    const sep = Math.max(minB - maxA, minA - maxB);
    maxSep = Math.max(maxSep, sep);
  }
  return maxSep;
}

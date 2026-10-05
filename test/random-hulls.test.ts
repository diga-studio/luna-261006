import { describe, test } from "node:test";
import { ok } from "node:assert/strict";
import {
  createHull,
  contact,
  type Hull,
  type Pose,
} from "../src/index.js";
import {
  quatFromAxisAngle,
  vAdd,
  vDot,
  vLen,
  vNorm,
  vScale,
  vSub,
  type Vec3,
} from "./helpers.js";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Random point cloud with duplicates, interior and coplanar extras. */
function randomCloud(rng: () => number): Vec3[] {
  const pts: Vec3[] = [];
  const n = 8 + Math.floor(rng() * 20);
  for (let i = 0; i < n; i++) {
    pts.push([
      (rng() * 2 - 1) * (0.5 + rng() * 2),
      (rng() * 2 - 1) * (0.5 + rng() * 2),
      (rng() * 2 - 1) * (0.5 + rng() * 2),
    ]);
  }
  // Duplicates.
  pts.push([...pts[0]!] as Vec3, [...pts[1]!] as Vec3);
  // Interior points (convex combinations).
  for (let i = 0; i < 3; i++) {
    const a = pts[Math.floor(rng() * n)]!;
    const b = pts[Math.floor(rng() * n)]!;
    const t = rng();
    pts.push([
      a[0] * t + b[0] * (1 - t),
      a[1] * t + b[1] * (1 - t),
      a[2] * t + b[2] * (1 - t),
    ]);
  }
  return pts;
}

function randomPose(rng: () => number, spread: number): Pose {
  const axis = vNorm([rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1] as Vec3);
  return {
    translation: [
      (rng() * 2 - 1) * spread,
      (rng() * 2 - 1) * spread,
      (rng() * 2 - 1) * spread,
    ],
    quaternion: quatFromAxisAngle(axis, (rng() * 2 - 1) * Math.PI),
  };
}

/** max over hull vertices of dot(v, d), in the hull's local frame. */
function supportAlong(hull: Hull, pose: Pose, d: Vec3): number {
  // Transform direction to local: d_local = q^-1 * d.
  const inv = [
    -pose.quaternion[0],
    -pose.quaternion[1],
    -pose.quaternion[2],
    pose.quaternion[3],
  ] as [number, number, number, number];
  const [qx, qy, qz, qw] = inv;
  const rot = (v: Vec3): Vec3 => {
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
      v[0] + qw * tx + (qy * tz - qz * ty),
      v[1] + qw * ty + (qz * tx - qx * tz),
      v[2] + qw * tz + (qx * ty - qy * tx),
    ];
  };
  const dl = rot(d);
  let best = -Infinity;
  for (const v of hull.vertices) {
    // dot(t + R v, d) = dot(t, d) + dot(v, d_local)
    best = Math.max(best, vDot(v, dl));
  }
  return best + vDot(pose.translation, d);
}

/** Check a world point lies on the hull surface via its face planes. */
function checkOnHullSurface(
  p: Vec3,
  hull: Hull,
  pose: Pose,
  eps: number,
  msg: string,
): void {
  // Transform to local frame.
  const inv = [
    -pose.quaternion[0],
    -pose.quaternion[1],
    -pose.quaternion[2],
    pose.quaternion[3],
  ] as [number, number, number, number];
  const [qx, qy, qz, qw] = inv;
  const t = vSub(p, pose.translation);
  const tx = 2 * (qy * t[2] - qz * t[1]);
  const ty = 2 * (qz * t[0] - qx * t[2]);
  const tz = 2 * (qx * t[1] - qy * t[0]);
  const l: Vec3 = [
    t[0] + qw * tx + (qy * tz - qz * ty),
    t[1] + qw * ty + (qz * tx - qx * tz),
    t[2] + qw * tz + (qx * ty - qy * tx),
  ];
  let maxPlane = -Infinity;
  for (const f of hull.faces) {
    const a = hull.vertices[f.vertices[0]]!;
    const d = vDot(vSub(l, a), f.normal);
    maxPlane = Math.max(maxPlane, d);
    ok(d <= eps, `${msg}: point violates a hull plane by ${d}`);
  }
  ok(maxPlane >= -eps, `${msg}: point is not on the surface (depth ${-maxPlane})`);
}

describe("random convex hulls from point clouds", () => {
  test("100 random pairs satisfy support-optimality and surface contract", () => {
    const rng = makeRng(77031);
    for (let iter = 0; iter < 100; iter++) {
      const hullA = createHull(randomCloud(rng));
      const hullB = createHull(randomCloud(rng));
      const poseA = randomPose(rng, 2.0);
      const poseB = randomPose(rng, 2.0);
      const label = `iter ${iter}`;

      const r = contact(hullA, poseA, hullB, poseB);

      // Contract: unit normal and witness delta.
      ok(Math.abs(vLen(r.normal) - 1) < 1e-9, `${label}: unit normal`);
      const delta = vSub(r.pointB, r.pointA);
      const expect = vScale(r.normal, r.distance);
      for (let i = 0; i < 3; i++) {
        ok(
          Math.abs(delta[i]! - expect[i]!) < 1e-8,
          `${label}: pointB - pointA == distance * normal`,
        );
      }

      // Support optimality (necessary and sufficient for convex bodies):
      // pointA is A's support along +normal, pointB is B's along -normal.
      const sa = supportAlong(hullA, poseA, r.normal);
      const sb = supportAlong(hullB, poseB, vScale(r.normal, -1));
      ok(
        Math.abs(vDot(r.pointA, r.normal) - sa) < 1e-7,
        `${label}: pointA is the support of A along normal`,
      );
      ok(
        Math.abs(vDot(r.pointB, r.normal) + sb) < 1e-7,
        `${label}: pointB is the support of B along -normal`,
      );

      // Witnesses lie on the hull surfaces.
      checkOnHullSurface(r.pointA, hullA, poseA, 1e-7, `${label} pointA`);
      checkOnHullSurface(r.pointB, hullB, poseB, 1e-7, `${label} pointB`);

      // Consistency: translating B by -distance * normal yields a
      // configuration the library itself reports as non-penetrating.
      const resolved: Pose = {
        translation: vAdd(poseB.translation, vScale(r.normal, -r.distance)),
        quaternion: poseB.quaternion,
      };
      const r2 = contact(hullA, poseA, hullB, resolved);
      ok(
        r2.distance >= -1e-6,
        `${label}: resolved configuration still penetrates (${r2.distance})`,
      );
    }
  });
});

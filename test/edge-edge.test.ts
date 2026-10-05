import { describe, test } from "node:test";
import { ok } from "node:assert/strict";
import { createHull, contact, type ContactResult, type Pose } from "../src/index.js";
import {
  boxCorners,
  localPoint,
  obbDistance,
  quatFromAxisAngle,
  satSeparation,
  vAdd,
  vLen,
  vNorm,
  vScale,
  vSub,
  type Vec3,
} from "./helpers.js";

const TOL = 1e-7;

function near(a: number, b: number, tol: number, msg: string): void {
  ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);
}

function nearVec(a: Vec3, b: Vec3, tol: number, msg: string): void {
  for (let i = 0; i < 3; i++) {
    ok(
      Math.abs(a[i]! - b[i]!) <= tol,
      `${msg}[${i}]: expected ${b[i]}, got ${a[i]}`,
    );
  }
}

/** Point is inside the box (local frame) and on its boundary. */
function checkOnBoxSurface(
  p: Vec3,
  pose: Pose,
  half: Vec3,
  eps: number,
  msg: string,
): void {
  const l = localPoint(pose, p);
  let onBoundary = false;
  for (let i = 0; i < 3; i++) {
    ok(
      Math.abs(l[i]!) <= half[i]! + eps,
      `${msg}: local coord ${i} = ${l[i]} outside half extent ${half[i]}`,
    );
    if (Math.abs(Math.abs(l[i]!) - half[i]!) <= eps) onBoundary = true;
  }
  ok(onBoundary, `${msg}: point ${l} not on the box surface`);
}

function checkContract(
  r: ContactResult,
  poseA: Pose,
  halfA: Vec3,
  poseB: Pose,
  halfB: Vec3,
  label: string,
): void {
  // Unit normal.
  near(vLen(r.normal), 1, 1e-9, `${label} normal is unit`);
  // pointB - pointA === distance * normal.
  nearVec(
    vSub(r.pointB, r.pointA),
    vScale(r.normal, r.distance),
    1e-9,
    `${label} witness delta`,
  );
  // Witnesses on the respective surfaces.
  checkOnBoxSurface(r.pointA, poseA, halfA, 1e-6, `${label} pointA`);
  checkOnBoxSurface(r.pointB, poseB, halfB, 1e-6, `${label} pointB`);
}

// Two elongated boxes ("rods"): half length 4 along x, thin 0.2 cross-section.
const HALF: Vec3 = [4, 0.2, 0.2];
const hullA = createHull(boxCorners(HALF));
const hullB = createHull(boxCorners(HALF));

// Genuinely 3D skew configuration: both rods arbitrarily rotated.
const poseA: Pose = {
  translation: [-0.3, 0.2, 0.1],
  quaternion: quatFromAxisAngle(vNorm([1, 0.5, 0.25]), 0.35),
};
const rotB = quatFromAxisAngle(vNorm([0.2, 1, -0.4]), -0.5);
const baseTranslationB: Vec3 = [0.5, -0.3, 1.1];
const poseB0: Pose = { translation: baseTranslationB, quaternion: rotB };

// Independent ground truth: exact OBB distance from feature pairs.
const truth = obbDistance(poseA, HALF, poseB0, HALF);
const gapDir = vNorm(vSub(truth.pB, truth.pA)); // from A's witness to B's

// Pose helpers: shift B along the separation direction.
const shiftedPoseB = (amount: number): Pose => ({
  translation: vAdd(baseTranslationB, vScale(gapDir, amount)),
  quaternion: rotB,
});
// B translated to exactly touch A, and 0.05 beyond (penetrating).
const poseBTouch = shiftedPoseB(-truth.dist);
const poseBPen = shiftedPoseB(-truth.dist - 0.05);

describe("edge-edge: two rotated thin rods", () => {
  test("setup is a genuine edge-edge configuration", () => {
    ok(truth.dist > 0.1, "rods are clearly separated");
    // Both independent witnesses lie on long edges: exactly two local
    // coordinates on the boundary (the thin cross-section axes).
    for (const [p, pose] of [
      [truth.pA, poseA],
      [truth.pB, poseB0],
    ] as const) {
      const l = localPoint(pose, p);
      const atBoundary = [0, 1, 2].filter(
        (i) => Math.abs(Math.abs(l[i]!) - HALF[i]!) < 1e-9,
      ).length;
      ok(atBoundary === 2, `witness ${l} lies on a long edge`);
    }
  });

  test("separated: distance and witnesses match independent geometry", () => {
    const r = contact(hullA, poseA, hullB, poseB0);
    near(r.distance, truth.dist, TOL, "distance");
    nearVec(r.normal, gapDir, TOL, "normal");
    nearVec(r.pointA, truth.pA, TOL, "pointA");
    nearVec(r.pointB, truth.pB, TOL, "pointB");
    checkContract(r, poseA, HALF, poseB0, HALF, "separated");
  });

  test("exactly touching: distance ~ 0 with coincident witnesses", () => {
    const r = contact(hullA, poseA, hullB, poseBTouch);
    near(r.distance, 0, 1e-6, "distance");
    near(vLen(vSub(r.pointB, r.pointA)), 0, 1e-6, "witnesses coincide");
    // The contact point is the independent closest point.
    nearVec(r.pointA, truth.pA, 1e-5, "touch point");
    checkContract(r, poseA, HALF, poseBTouch, HALF, "touching");
    // Independent confirmation: SAT reports touching, not interpenetration.
    near(satSeparation(poseA, HALF, poseBTouch, HALF), 0, 1e-9, "SAT");
  });

  test("slight penetration: depth 0.05, resolvable by the reported translation", () => {
    const r = contact(hullA, poseA, hullB, poseBPen);
    near(r.distance, -0.05, 1e-6, "distance");
    // Minimal translation direction stays the edge-edge normal.
    nearVec(r.normal, gapDir, 1e-6, "normal");
    checkContract(r, poseA, HALF, poseBPen, HALF, "penetrating");

    // Moving B by exactly -distance * normal removes the intersection.
    const resolved: Pose = {
      translation: vAdd(poseBPen.translation, vScale(r.normal, -r.distance)),
      quaternion: poseBPen.quaternion,
    };
    near(satSeparation(poseA, HALF, resolved, HALF), 0, 1e-6, "SAT resolved");
    near(obbDistance(poseA, HALF, resolved, HALF).dist, 0, 1e-6, "gap closed");

    // Half of that translation is not enough: still interpenetrating.
    const half: Pose = {
      translation: vAdd(poseBPen.translation, vScale(r.normal, -r.distance * 0.5)),
      quaternion: poseBPen.quaternion,
    };
    ok(
      satSeparation(poseA, HALF, half, HALF) < -1e-3,
      "half translation still intersects",
    );
  });

  test("sweep: separated -> touching -> penetrating stays consistent", () => {
    // March B along the separation direction and compare against the
    // independent feature distance at every step.
    for (const extra of [0.1, 0.02, 0.002, -0.002, -0.02, -0.1]) {
      const poseB = shiftedPoseB(-truth.dist + extra);
      const r = contact(hullA, poseA, hullB, poseB);
      near(r.distance, extra, 1e-6, `sweep(${extra}) distance`);
      nearVec(r.normal, gapDir, 1e-6, `sweep(${extra}) normal`);
      checkContract(r, poseA, HALF, poseB, HALF, `sweep(${extra})`);
    }
  });
});

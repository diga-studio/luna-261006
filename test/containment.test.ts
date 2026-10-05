import { describe, test } from "node:test";
import { ok } from "node:assert/strict";
import { createHull, contact, type Pose } from "../src/index.js";
import {
  boxCorners,
  obbDistance,
  quatFromAxisAngle,
  satSeparation,
  vAdd,
  vScale,
  vSub,
  type Vec3,
} from "./helpers.js";

const IDENTITY: Pose = { translation: [0, 0, 0], quaternion: [0, 0, 0, 1] };

const TOL = 1e-9;

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

// A: cube of side 10 centered at the origin.
const hullA = createHull(boxCorners([5, 5, 5]));
// B: box spanning x in [2,3], y,z in [-0.5,0.5] (unit cube shifted by 2.5).
const halfB: Vec3 = [0.5, 0.5, 0.5];
const hullB = createHull(boxCorners(halfB));
const poseB: Pose = { translation: [2.5, 0, 0], quaternion: [0, 0, 0, 1] };

function checkContainment(poseA: Pose, label: string): void {
  const r = contact(hullA, poseA, hullB, poseB);

  // Exact signed distance: B must move +3 along x for its x range [2,3]
  // to clear A's face at x = 5.
  near(r.distance, -3, 1e-9, `${label} distance`);
  nearVec(r.normal, [1, 0, 0], 1e-9, `${label} normal`);

  // Contract: pointB - pointA === distance * normal.
  const lhs = vSub(r.pointB, r.pointA);
  const rhs = vScale(r.normal, r.distance);
  nearVec(lhs, rhs, 1e-9, `${label} pointB - pointA`);

  // Witness points sit on the surfaces: A's +x face and B's -x face.
  near(r.pointA[0], 5, 1e-9, `${label} pointA on +x face of A`);
  ok(
    Math.abs(r.pointA[1]) <= 0.5 + 1e-9 && Math.abs(r.pointA[2]) <= 0.5 + 1e-9,
    `${label} pointA within B's cross-section`,
  );
  near(r.pointB[0], 2, 1e-9, `${label} pointB on -x face of B`);
  near(r.pointB[1], r.pointA[1], 1e-9, `${label} witness y match`);
  near(r.pointB[2], r.pointA[2], 1e-9, `${label} witness z match`);

  // Translating B by -distance * normal exactly removes the intersection.
  const shift = vScale(r.normal, -r.distance);
  const poseBmoved: Pose = {
    translation: vAdd(poseB.translation, shift),
    quaternion: poseB.quaternion,
  };
  // Independent check: SAT reports touching (separation ~ 0, not < 0) and
  // the feature-based distance is ~ 0.
  const sep = satSeparation(poseA, [5, 5, 5], poseBmoved, halfB);
  near(sep, 0, 1e-9, `${label} SAT separation after translation`);
  const fd = obbDistance(poseA, [5, 5, 5], poseBmoved, halfB);
  near(fd.dist, 0, 1e-9, `${label} feature distance after translation`);
  // The library agrees the moved bodies are exactly in contact.
  const rMoved = contact(hullA, poseA, hullB, poseBmoved);
  near(rMoved.distance, 0, 1e-7, `${label} distance after translation`);

  // Moving B by only 99% of the required translation must NOT separate:
  // the translation length is minimal.
  const poseBshort: Pose = {
    translation: vAdd(poseB.translation, vScale(shift, 0.99)),
    quaternion: poseB.quaternion,
  };
  ok(
    satSeparation(poseA, [5, 5, 5], poseBshort, halfB) < -1e-6,
    `${label} shorter translation still intersects`,
  );
}

describe("containment: small box fully inside unit-cube-10", () => {
  test("identity poses give distance -3 along +x", () => {
    checkContainment(IDENTITY, "identity");
  });

  test("same geometry with A rotated 90° about y (cube symmetry)", () => {
    const poseA: Pose = {
      translation: [0, 0, 0],
      quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
    };
    checkContainment(poseA, "rotated-A");
  });

  test("result is invariant to duplicate/interior/coplanar input points", () => {
    const messyA = createHull([
      ...boxCorners([5, 5, 5]),
      [5, 5, 5], // duplicate
      [0, 0, 0], // interior
      [1, -2, 3], // interior
      [5, 0, 0], // coplanar on a face
      [0, 0, -5], // coplanar on a face
    ]);
    const r = contact(messyA, IDENTITY, hullB, poseB);
    near(r.distance, -3, 1e-9, "messy distance");
    nearVec(r.normal, [1, 0, 0], 1e-9, "messy normal");
  });
});

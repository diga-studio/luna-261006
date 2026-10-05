import { test } from "node:test";
import assert from "node:assert/strict";
import { contact, createHull } from "../src/index.js";
import type { Hull, Pose, Vec3 } from "../src/index.js";
import type { Quat } from "../src/quat.js";

// ---------- independent geometry helpers (test-side) ----------

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.sqrt(dot(a, a));

function quatAxisAngle(axis: Vec3, angle: number): Quat {
  const n = mul(axis, 1 / len(axis));
  const s = Math.sin(angle / 2);
  return { w: Math.cos(angle / 2), x: n.x * s, y: n.y * s, z: n.z * s };
}

function quatMul(p: Quat, q: Quat): Quat {
  return {
    w: p.w * q.w - p.x * q.x - p.y * q.y - p.z * q.z,
    x: p.w * q.x + p.x * q.w + p.y * q.z - p.z * q.y,
    y: p.w * q.y - p.x * q.z + p.y * q.w + p.z * q.x,
    z: p.w * q.z + p.x * q.y - p.y * q.x + p.z * q.w,
  };
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

function boxVertices(hx: number, hy: number, hz: number): Vec3[] {
  const pts: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) pts.push(v3(sx * hx, sy * hy, sz * hz));
  return pts;
}

/** Closest points between segments p1-q1 and p2-q2 (standard reference formula). */
function closestSegmentSegment(
  p1: Vec3,
  q1: Vec3,
  p2: Vec3,
  q2: Vec3,
): { c1: Vec3; c2: Vec3 } {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const c = dot(d1, r);
  const b = dot(d1, d2);
  const denom = a * e - b * b;
  let s = denom > 1e-14 ? (b * f - c * e) / denom : 0;
  s = Math.min(1, Math.max(0, s));
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.min(1, Math.max(0, -c / a));
  } else if (t > 1) {
    t = 1;
    s = Math.min(1, Math.max(0, (b - c) / a));
  }
  return { c1: add(p1, mul(d1, s)), c2: add(p2, mul(d2, t)) };
}

function poseAt(translation: Vec3, rotation?: Quat): Pose {
  return { translation, rotation: rotation ?? { w: 1, x: 0, y: 0, z: 0 } };
}

function checkInvariants(result: { distance: number; normal: Vec3; pointA: Vec3; pointB: Vec3 }, tol = 1e-6): void {
  assert.ok(Math.abs(len(result.normal) - 1) < 1e-9, "normal must be unit length");
  const expect = add(result.pointA, mul(result.normal, result.distance));
  assert.ok(
    len(sub(expect, result.pointB)) < tol,
    `pointB - pointA must equal distance * normal (got err ${len(sub(expect, result.pointB))})`,
  );
}

// ---------- scenario 1: containment MTV ----------

test("contained box: distance -3 along +x, translation exactly separates", () => {
  const hullA = createHull(boxVertices(5, 5, 5));
  const hullB = createHull([
    v3(2, -0.5, -0.5), v3(2, 0.5, -0.5), v3(2, -0.5, 0.5), v3(2, 0.5, 0.5),
    v3(3, -0.5, -0.5), v3(3, 0.5, -0.5), v3(3, -0.5, 0.5), v3(3, 0.5, 0.5),
  ]);
  const poseA = poseAt(v3(0, 0, 0));
  const poseB = poseAt(v3(0, 0, 0));

  const r = contact(hullA, poseA, hullB, poseB);
  checkInvariants(r);
  assert.ok(Math.abs(r.distance - -3) < 1e-6, `distance should be -3, got ${r.distance}`);
  assert.ok(Math.abs(r.normal.x - 1) < 1e-6 && Math.abs(r.normal.y) < 1e-6 && Math.abs(r.normal.z) < 1e-6,
    `normal should be +x, got ${JSON.stringify(r.normal)}`);
  // Witness points sit on the respective surfaces.
  assert.ok(Math.abs(r.pointA.x - 5) < 1e-6, `pointA on A surface x=5, got ${r.pointA.x}`);
  assert.ok(Math.abs(r.pointB.x - 2) < 1e-6, `pointB on B surface x=2, got ${r.pointB.x}`);
  assert.ok(Math.abs(r.pointA.y) <= 0.5 + 1e-9 && Math.abs(r.pointA.z) <= 0.5 + 1e-9);

  // Moving B by -distance * normal must exactly eliminate the intersection.
  const separation = mul(r.normal, -r.distance);
  const movedPoseB = poseAt(add(poseB.translation, separation));
  const after = contact(hullA, poseA, hullB, movedPoseB);
  checkInvariants(after, 1e-5);
  assert.ok(Math.abs(after.distance) < 1e-5, `after MTV translation bodies should touch, got ${after.distance}`);
  // The contact plane is x = 5 for both bodies.
  assert.ok(Math.abs(after.pointA.x - 5) < 1e-4, `touch point on A face x=5, got ${after.pointA.x}`);
  assert.ok(Math.abs(after.pointB.x - 5) < 1e-4, `touch point on moved B face x=5, got ${after.pointB.x}`);

  // Moving slightly less must still intersect.
  const short = contact(hullA, poseA, hullB, poseAt(add(poseB.translation, mul(separation, 0.999))));
  assert.ok(short.distance < 0, "0.999x MTV translation must still intersect");
});

// ---------- scenario 2: skew thin rods, edge-edge ----------

const ROD_HALF = v3(2, 0.1, 0.1); // long thin box

function rodEdgesWorld(pose: Pose): [Vec3, Vec3][] {
  // The four long edges parallel to local x.
  const edges: [Vec3, Vec3][] = [];
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = add(rotate(pose.rotation, v3(-ROD_HALF.x, sy * ROD_HALF.y, sz * ROD_HALF.z)), pose.translation);
      const q = add(rotate(pose.rotation, v3(ROD_HALF.x, sy * ROD_HALF.y, sz * ROD_HALF.z)), pose.translation);
      edges.push([p, q]);
    }
  }
  return edges;
}

/** Independent reference: min distance over the 4x4 long-edge segment pairs. */
function referenceEdgeEdge(poseA: Pose, poseB: Pose): { dist: number; cA: Vec3; cB: Vec3 } {
  let best = { dist: Infinity, cA: v3(0, 0, 0), cB: v3(0, 0, 0) };
  for (const [p1, q1] of rodEdgesWorld(poseA)) {
    for (const [p2, q2] of rodEdgesWorld(poseB)) {
      const { c1, c2 } = closestSegmentSegment(p1, q1, p2, q2);
      const d = len(sub(c2, c1));
      if (d < best.dist) best = { dist: d, cA: c1, cB: c2 };
    }
  }
  return best;
}

test("skew thin rods: separated, touching, slightly penetrating", () => {
  const rod = createHull(boxVertices(ROD_HALF.x, ROD_HALF.y, ROD_HALF.z));
  const rotA = quatMul(quatAxisAngle(v3(0, 1, 0), 0.35), quatAxisAngle(v3(0, 0, 1), 0.2));
  const rotB = quatMul(quatAxisAngle(v3(0, 1, 0), -0.5), quatAxisAngle(v3(1, 0, 0), 0.4));
  const poseA = poseAt(v3(0, 0, 0), rotA);
  const baseB = poseAt(v3(0.3, 1.2, 0.2), rotB);

  // Calibrate the separation direction from the reference geometry, then
  // find the exactly-touching configuration.
  const ref0 = referenceEdgeEdge(poseA, baseB);
  const n = mul(sub(ref0.cB, ref0.cA), 1 / ref0.dist);
  const poseTouch = poseAt(add(baseB.translation, mul(n, -ref0.dist)), rotB);
  const touch = referenceEdgeEdge(poseA, poseTouch);
  assert.ok(touch.dist < 1e-9, 'touch calibration sanity');
  const touchPoint = touch.cA; // == touch.cB at the touching configuration

  for (const gap of [0.05, 0, -0.02]) {
    // Place B at edge-edge gap g along n (negative g = penetration).
    const poseB = poseAt(add(poseTouch.translation, mul(n, gap)), rotB);
    const r = contact(rod, poseA, rod, poseB);
    checkInvariants(r, 1e-5);
    assert.ok(
      Math.abs(r.distance - gap) < 1e-5,
      `gap=${gap}: distance should be ${gap}, got ${r.distance}`,
    );

    // Independent geometric expectations for the witness points.
    let expectA: Vec3;
    let expectB: Vec3;
    if (gap >= 0) {
      const ref = referenceEdgeEdge(poseA, poseB);
      assert.ok(Math.abs(ref.dist - gap) < 1e-9, 'reference gap sanity');
      expectA = ref.cA;
      expectB = ref.cB;
    } else {
      // Slight penetration: the MTV pushes B back along n to the touching
      // configuration, so the witnesses are the touching features.
      expectA = touchPoint;
      expectB = add(touchPoint, mul(n, gap));
    }
    assert.ok(
      len(sub(r.pointA, expectA)) < 1e-4,
      `gap=${gap}: pointA mismatch (err ${len(sub(r.pointA, expectA))})`,
    );
    assert.ok(
      len(sub(r.pointB, expectB)) < 1e-4,
      `gap=${gap}: pointB mismatch (err ${len(sub(r.pointB, expectB))})`,
    );

    if (gap > 0) {
      assert.ok(dot(sub(r.pointB, r.pointA), n) > 0, 'normal points from A to B');
    }
    if (gap < 0) {
      // The MTV translation exactly separates the rods.
      const sep = mul(r.normal, -r.distance);
      const after = contact(rod, poseA, rod, poseAt(add(poseB.translation, sep), rotB));
      assert.ok(Math.abs(after.distance) < 1e-4, `after MTV move should touch, got ${after.distance}`);
      const short = contact(rod, poseA, rod, poseAt(add(poseB.translation, mul(sep, 0.99)), rotB));
      assert.ok(short.distance < 0, '0.99x MTV translation must still intersect');
    }
  }
});

// ---------- supporting sanity tests ----------

test("separated cubes: exact gap, normal and witnesses", () => {
  const cube = createHull(boxVertices(1, 1, 1));
  const r = contact(cube, poseAt(v3(0, 0, 0)), cube, poseAt(v3(4.5, 0, 0)));
  checkInvariants(r);
  assert.ok(Math.abs(r.distance - 2.5) < 1e-9);
  assert.ok(Math.abs(r.normal.x - 1) < 1e-9);
  assert.ok(Math.abs(r.pointA.x - 1) < 1e-9);
  assert.ok(Math.abs(r.pointB.x - 3.5) < 1e-9);
});

test("createHull tolerates duplicates, interior and unordered points", () => {
  const messy: Vec3[] = [];
  const corners = boxVertices(5, 5, 5);
  // Shuffle deterministically, add duplicates and interior points.
  for (let i = corners.length - 1; i >= 0; i--) messy.push(corners[(i * 5 + 3) % 8]);
  messy.push(v3(0, 0, 0), v3(1, -2, 0.5), v3(5, 5, 5), v3(-5, -5, -5), v3(0.1, 0.2, 0.3));
  const hull = createHull(messy);
  const clean = createHull(corners);
  const probe = createHull(boxVertices(0.5, 0.5, 0.5));
  const pose = poseAt(v3(0, 0, 0));
  const far = poseAt(v3(20, 3, -2));
  const r1 = contact(hull, pose, probe, far);
  const r2 = contact(clean, pose, probe, far);
  assert.ok(Math.abs(r1.distance - r2.distance) < 1e-9);
});

test("rotated hull query: cube corner-to-face separation", () => {
  const cube = createHull(boxVertices(1, 1, 1));
  const rot45 = quatAxisAngle(v3(0, 0, 1), Math.PI / 4);
  // A rotated 45 deg about z: its top vertex is at y = sqrt(2).
  const r = contact(cube, poseAt(v3(0, Math.SQRT2, 0), rot45), cube, poseAt(v3(0, -1.5, 0)));
  checkInvariants(r);
  assert.ok(Math.abs(r.distance - 0.5) < 1e-6, `expected 0.5, got ${r.distance}`);
  assert.ok(Math.abs(r.normal.y + 1) < 1e-6, "normal from A (top) to B (below) is -y");
});

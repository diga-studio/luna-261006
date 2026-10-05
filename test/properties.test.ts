import { test } from "node:test";
import assert from "node:assert/strict";
import { contact, createHull } from "../src/index.js";
import type { Pose, Vec3 } from "../src/index.js";
import type { Quat } from "../src/quat.js";

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.sqrt(dot(a, a));

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function quatAxisAngle(axis: Vec3, angle: number): Quat {
  const n = mul(axis, 1 / len(axis));
  const s = Math.sin(angle / 2);
  return { w: Math.cos(angle / 2), x: n.x * s, y: n.y * s, z: n.z * s };
}

function boxVertices(hx: number, hy: number, hz: number): Vec3[] {
  const pts: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) pts.push(v3(sx * hx, sy * hy, sz * hz));
  return pts;
}

function moved(pose: Pose, offset: Vec3): Pose {
  return { translation: add(pose.translation, offset), rotation: pose.rotation };
}

function checkDefiningProperties(
  hullA: ReturnType<typeof createHull>,
  poseA: Pose,
  hullB: ReturnType<typeof createHull>,
  poseB: Pose,
  tag: string,
): void {
  const r = contact(hullA, poseA, hullB, poseB);
  assert.ok(Math.abs(len(r.normal) - 1) < 1e-9, `${tag}: unit normal`);
  const expect = add(r.pointA, mul(r.normal, r.distance));
  assert.ok(len(sub(expect, r.pointB)) < 1e-5, `${tag}: pointB - pointA == distance * normal`);

  // Moving B by -distance * normal must eliminate any intersection.
  const after = contact(hullA, poseA, hullB, moved(poseB, mul(r.normal, -r.distance)));
  assert.ok(after.distance > -1e-4, `${tag}: MTV translation separates (got ${after.distance})`);

  if (r.distance > 1e-4) {
    // Separated: closing 98% of the gap stays separated, 102% intersects.
    const short = contact(hullA, poseA, hullB, moved(poseB, mul(r.normal, -0.98 * r.distance)));
    assert.ok(short.distance > 0, `${tag}: 0.98x closing must stay separated`);
    const over = contact(hullA, poseA, hullB, moved(poseB, mul(r.normal, -1.02 * r.distance)));
    assert.ok(over.distance <= 0, `${tag}: 1.02x closing must intersect`);
  }
  if (r.distance < -1e-4) {
    // Penetrating: 98% of the MTV translation still intersects.
    const short = contact(hullA, poseA, hullB, moved(poseB, mul(r.normal, -0.98 * r.distance)));
    assert.ok(short.distance < 0, `${tag}: 0.98x MTV must still intersect`);
  }
}

test("random hulls and poses satisfy the contact definitions", () => {
  const rnd = lcg(12345);
  for (let iter = 0; iter < 150; iter++) {
    const randomHull = () => {
      const pts: Vec3[] = [];
      const nv = 4 + Math.floor(rnd() * 10);
      for (let i = 0; i < nv; i++) pts.push(v3((rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2));
      pts.push(v3(1.5, 0, 0), v3(-1.5, 0.5, 0), v3(0, 1.5, 0.5), v3(0, 0, 1.5));
      return createHull(pts);
    };
    const hullA = randomHull();
    const hullB = randomHull();
    const poseA: Pose = {
      translation: v3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1),
      rotation: quatAxisAngle(v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), rnd() * 6),
    };
    const poseB: Pose = {
      translation: v3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1),
      rotation: quatAxisAngle(v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), rnd() * 6),
    };
    checkDefiningProperties(hullA, poseA, hullB, poseB, `random iter ${iter}`);
  }
});

test("near-contact boxes around the touching boundary satisfy the definitions", () => {
  const rnd = lcg(999);
  for (let iter = 0; iter < 150; iter++) {
    const hullA = createHull(boxVertices(0.5 + rnd(), 0.3 + rnd() * 0.7, 0.4 + rnd() * 0.6));
    const hullB = createHull(boxVertices(0.4 + rnd() * 0.8, 0.5 + rnd() * 0.5, 0.3 + rnd() * 0.9));
    const rotA = quatAxisAngle(v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), rnd() * 6);
    const rotB = quatAxisAngle(v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), rnd() * 6);
    const dir = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
    const nd = mul(dir, 1 / len(dir));
    const poseA = { translation: v3(0, 0, 0), rotation: rotA };
    // Binary search the touching offset along nd.
    let lo = 0;
    let hi = 8;
    for (let it = 0; it < 50; it++) {
      const mid = (lo + hi) / 2;
      const probe = contact(hullA, poseA, hullB, { translation: mul(nd, mid), rotation: rotB });
      if (probe.distance > 0) hi = mid;
      else lo = mid;
    }
    const gap = (rnd() < 0.5 ? -1 : 1) * rnd() * (rnd() < 0.5 ? 0.05 : 0.3);
    const poseB = { translation: mul(nd, hi + gap), rotation: rotB };
    checkDefiningProperties(hullA, poseA, hullB, poseB, `box iter ${iter} gap ${gap}`);
    const r = contact(hullA, poseA, hullB, poseB);
    if (gap > 1e-3) assert.ok(r.distance > 0, `box iter ${iter}: positive gap must separate`);
    if (gap < -1e-3) assert.ok(r.distance < 0, `box iter ${iter}: negative gap must penetrate`);
  }
});

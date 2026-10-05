import { describe, test } from "node:test";
import { ok } from "node:assert/strict";
import { createHull, contact, type Pose } from "../src/index.js";
import {
  boxCorners,
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

// Deterministic PRNG (LCG) so failures are reproducible.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
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

function randomHalf(rng: () => number): Vec3 {
  return [0.3 + rng() * 1.2, 0.3 + rng() * 1.2, 0.3 + rng() * 1.2];
}

describe("randomized OBB pairs vs independent geometry", () => {
  test("200 random configurations satisfy the contact contract", () => {
    const rng = makeRng(20261005);
    let separatedChecked = 0;
    let penetratingChecked = 0;

    for (let iter = 0; iter < 200; iter++) {
      const halfA = randomHalf(rng);
      const halfB = randomHalf(rng);
      const poseA = randomPose(rng, 2.2);
      const poseB = randomPose(rng, 2.2);
      const hullA = createHull(boxCorners(halfA));
      const hullB = createHull(boxCorners(halfB));

      const r = contact(hullA, poseA, hullB, poseB);
      const label = `iter ${iter}`;
      // Contract: unit normal, witness delta, witnesses on surfaces.
      ok(Math.abs(vLen(r.normal) - 1) < 1e-9, `${label}: unit normal`);
      const delta = vSub(r.pointB, r.pointA);
      const expect = vScale(r.normal, r.distance);
      for (let i = 0; i < 3; i++) {
        ok(
          Math.abs(delta[i]! - expect[i]!) < 1e-8,
          `${label}: pointB - pointA == distance * normal`,
        );
      }
      ok(
        Math.abs(vLen(delta) - Math.abs(r.distance)) < 1e-8,
        `${label}: |pointB - pointA| == |distance|`,
      );

      const sep = satSeparation(poseA, halfA, poseB, halfB);
      if (sep > 1e-6) {
        // Separated: distance must equal the independent feature distance.
        const truth = obbDistance(poseA, halfA, poseB, halfB);
        ok(
          Math.abs(r.distance - truth.dist) < 1e-6,
          `${label}: distance ${r.distance} vs independent ${truth.dist}`,
        );
        ok(r.distance > 0, `${label}: positive distance when separated`);
        separatedChecked++;
      } else {
        // Touching or penetrating: the reported translation must resolve
        // the intersection, and 98% of it must not.
        ok(r.distance <= 1e-9, `${label}: non-positive distance`);
        const resolved: Pose = {
          translation: vAdd(poseB.translation, vScale(r.normal, -r.distance)),
          quaternion: poseB.quaternion,
        };
        ok(
          satSeparation(poseA, halfA, resolved, halfB) > -1e-6,
          `${label}: translation by -distance*normal separates`,
        );
        if (r.distance < -1e-4) {
          const short: Pose = {
            translation: vAdd(
              poseB.translation,
              vScale(r.normal, -r.distance * 0.98),
            ),
            quaternion: poseB.quaternion,
          };
          ok(
            satSeparation(poseA, halfA, short, halfB) < 0,
            `${label}: 98% translation still intersects (minimality)`,
          );
          penetratingChecked++;
        }
      }
    }

    // The random mix actually exercised both branches.
    ok(separatedChecked > 50, `separated cases: ${separatedChecked}`);
    ok(penetratingChecked > 20, `penetrating cases: ${penetratingChecked}`);
  });
});

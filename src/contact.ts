import type { ContactResult, Hull, Pose } from "./types.js";
import { gjkDistance, type MinkowskiSupport } from "./gjk.js";
import { epaPenetration } from "./epa.js";
import { supportIndex } from "./hull.js";
import {
  add,
  length,
  quatConjugate,
  quatRotate,
  scale as vecScale,
  sub,
} from "./math.js";

function worldCentroid(hull: Hull, pose: Pose) {
  const c: [number, number, number] = [0, 0, 0];
  for (const v of hull.vertices) {
    c[0] += v[0];
    c[1] += v[1];
    c[2] += v[2];
  }
  const n = hull.vertices.length;
  const local: [number, number, number] = [c[0] / n, c[1] / n, c[2] / n];
  return add(quatRotate(pose.quaternion, local), pose.translation);
}

/**
 * Signed-distance contact query between two posed convex hulls.
 * See {@link ContactResult} for the exact contract of the returned values.
 *
 * Separated: GJK distance. Penetrating (or exactly touching): EPA on the
 * Minkowski difference, where the boundary point `p` closest to the origin
 * gives the minimal translation `p` applied to B that removes the interior
 * intersection, so distance = -|p| and normal = p / |p|.
 */
export function contact(
  hullA: Hull,
  poseA: Pose,
  hullB: Hull,
  poseB: Pose,
): ContactResult {
  const qAInv = quatConjugate(poseA.quaternion);
  const qBInv = quatConjugate(poseB.quaternion);

  const support: MinkowskiSupport = (dir) => {
    const aLocal =
      hullA.vertices[supportIndex(hullA.vertices, quatRotate(qAInv, dir))]!;
    const a = add(quatRotate(poseA.quaternion, aLocal), poseA.translation);
    const negDir = vecScale(dir, -1);
    const bLocal =
      hullB.vertices[supportIndex(hullB.vertices, quatRotate(qBInv, negDir))]!;
    const b = add(quatRotate(poseB.quaternion, bLocal), poseB.translation);
    return { w: sub(a, b), a, b };
  };

  let initialDir = sub(worldCentroid(hullB, poseB), worldCentroid(hullA, poseA));
  if (length(initialDir) === 0) initialDir = [1, 0, 0];

  const gjk = gjkDistance(support, initialDir);

  if (!gjk.intersecting) {
    const pointA: [number, number, number] = [0, 0, 0];
    const pointB: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < gjk.simplex.length; i++) {
      const w = gjk.weights[i]!;
      const sp = gjk.simplex[i]!;
      for (const c of [0, 1, 2] as const) {
        pointA[c] += w * sp.a[c];
        pointB[c] += w * sp.b[c];
      }
    }
    const delta = sub(pointB, pointA);
    const dist = length(delta);
    const normal = vecScale(delta, 1 / dist);
    return { distance: dist, normal, pointA, pointB };
  }

  const epa = epaPenetration(support, gjk.simplex);
  return {
    distance: -epa.depth,
    normal: epa.normal,
    pointA: epa.pointA,
    pointB: epa.pointB,
  };
}

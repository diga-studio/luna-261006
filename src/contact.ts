import { dot, negate, normalize, scale, sub } from "./vec3.js";
import type { Vec3 } from "./vec3.js";
import { IDENTITY_QUAT } from "./quat.js";
import type { ContactResult, Hull, Pose } from "./types.js";
import { gjkDistance, supportWorld, worldVertices } from "./gjk.js";
import { epaPenetration } from "./epa.js";

const CONTACT_EPS = 1e-9;
const TOUCH_EPS = 1e-7;
const FACE_TOL = 1e-7;

const IDENTITY_POSE: Pose = { translation: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_QUAT };

/** World-space vertices of the hull's support face in direction `dir`. */
function supportFaceVertices(hull: Hull, pose: Pose, dir: Vec3): Vec3[] {
  const peak = dot(supportWorld(hull, pose, dir), dir);
  const tol = FACE_TOL * Math.max(1, Math.abs(peak));
  return worldVertices(hull, pose).filter((v) => dot(v, dir) >= peak - tol);
}

function fallbackNormal(poseA: Pose, poseB: Pose): Vec3 {
  const centers = sub(poseB.translation, poseA.translation);
  return dot(centers, centers) > 0 ? normalize(centers) : { x: 1, y: 0, z: 0 };
}

export function contact(
  hullA: Hull,
  poseA: Pose,
  hullB: Hull,
  poseB: Pose,
): ContactResult {
  const gjk = gjkDistance(hullA, poseA, hullB, poseB);
  if (!gjk.intersecting) {
    // Separated: GJK witnesses are the answer.
    const normal =
      gjk.distance > CONTACT_EPS
        ? scale(sub(gjk.pointB, gjk.pointA), 1 / gjk.distance)
        : (gjk.direction ?? fallbackNormal(poseA, poseB));
    return {
      distance: gjk.distance,
      normal,
      pointA: gjk.pointA,
      pointB: gjk.pointB,
    };
  }

  // Origin is inside the Minkowski difference: touching or penetrating.
  const epa = epaPenetration(hullA, poseA, hullB, poseB, gjk.simplex);
  if (epa.depth <= TOUCH_EPS) {
    // Exactly touching: the GJK simplex lies on the contact face, so its
    // barycentric witnesses are the contact points.
    return {
      distance: -epa.depth,
      normal: gjk.direction ?? epa.normal,
      pointA: gjk.pointA,
      pointB: gjk.pointB,
    };
  }

  // Penetrating: witnesses are the closest pair between the two support
  // faces (the hull faces forming the Minkowski boundary face nearest to
  // the origin).
  const normal = epa.normal;
  const faceA = supportFaceVertices(hullA, poseA, normal);
  const faceB = supportFaceVertices(hullB, poseB, negate(normal));
  const mini = gjkDistance({ vertices: faceA }, IDENTITY_POSE, { vertices: faceB }, IDENTITY_POSE);

  return {
    distance: -epa.depth,
    normal,
    pointA: mini.pointA,
    pointB: mini.pointB,
  };
}

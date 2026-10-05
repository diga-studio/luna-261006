import { cross, dot, sub, vec3 } from "./vec3.js";
import type { Vec3 } from "./vec3.js";
import type { Hull } from "./types.js";

const DEDUP_EPS = 1e-12;

function dedupe(points: readonly Vec3[]): Vec3[] {
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (const p of points) {
    const key = `${Math.round(p.x / DEDUP_EPS)},${Math.round(p.y / DEDUP_EPS)},${Math.round(p.z / DEDUP_EPS)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(vec3(p.x, p.y, p.z));
    }
  }
  return out;
}

function hasVolume(pts: readonly Vec3[]): boolean {
  // Find four non-coplanar points.
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const e = sub(pts[j], pts[i]);
      if (dot(e, e) === 0) continue;
      for (let k = j + 1; k < pts.length; k++) {
        const n = cross(e, sub(pts[k], pts[i]));
        if (dot(n, n) === 0) continue;
        for (let m = k + 1; m < pts.length; m++) {
          if (Math.abs(dot(n, sub(pts[m], pts[i]))) > 1e-9) return true;
        }
      }
    }
  }
  return false;
}

export function createHull(points: readonly Vec3[]): Hull {
  if (!Array.isArray(points) || points.length < 4) {
    throw new Error("createHull requires at least 4 points");
  }
  const vertices = dedupe(points);
  if (vertices.length < 4 || !hasVolume(vertices)) {
    throw new Error("createHull: points do not enclose a 3D volume");
  }
  return { vertices: Object.freeze(vertices.slice()) };
}

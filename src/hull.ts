import type { Hull, Vec3 } from "./types.js";
import { cross, dot, length, scale as vecScale, sub } from "./math.js";

interface WorkFace {
  v: [number, number, number];
  normal: Vec3;
}

/**
 * Build a convex hull from an unordered point cloud given in local
 * coordinates. Duplicate, interior and coplanar non-extreme points are
 * discarded. The input is guaranteed to span a non-degenerate 3D volume.
 *
 * Incremental beneath-beyond construction: starts from a non-degenerate
 * tetrahedron, then absorbs one outside point at a time by removing the
 * faces visible from it and stitching new triangles over the horizon edges.
 */
export function createHull(points: ArrayLike<readonly number[]>): Hull {
  const seen = new Map<string, Vec3>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p === undefined || p.length < 3) {
      throw new Error("each point must have at least 3 components");
    }
    const v: Vec3 = [p[0]!, p[1]!, p[2]!];
    for (const c of v) {
      if (!Number.isFinite(c)) throw new Error("point components must be finite");
    }
    const key = v.join(",");
    if (!seen.has(key)) seen.set(key, v);
  }
  const pts = [...seen.values()];
  if (pts.length < 4) {
    throw new Error("convex hull needs at least 4 distinct points");
  }

  let scale = 1;
  for (const p of pts) {
    for (const c of p) scale = Math.max(scale, Math.abs(c));
  }
  const eps = 1e-9 * scale;

  // --- initial tetrahedron ---
  let i0 = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]![0] > pts[i0]![0]) i0 = i;
  }
  const farthestFromPoint = (from: Vec3): number => {
    let best = -1;
    let bestIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = sub(pts[i]!, from);
      const m = dot(d, d);
      if (m > best) {
        best = m;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  const i1 = farthestFromPoint(pts[i0]!);
  const axis = sub(pts[i1]!, pts[i0]!);
  let i2 = -1;
  let bestArea = -1;
  for (let i = 0; i < pts.length; i++) {
    const c = cross(sub(pts[i]!, pts[i0]!), axis);
    const m = dot(c, c);
    if (m > bestArea) {
      bestArea = m;
      i2 = i;
    }
  }
  const planeNormal = cross(axis, sub(pts[i2]!, pts[i0]!));
  let i3 = -1;
  let bestHeight = -1;
  for (let i = 0; i < pts.length; i++) {
    const m = Math.abs(dot(sub(pts[i]!, pts[i0]!), planeNormal));
    if (m > bestHeight) {
      bestHeight = m;
      i3 = i;
    }
  }
  if (bestHeight <= eps * dot(planeNormal, planeNormal)) {
    throw new Error("points do not span a non-degenerate 3D volume");
  }

  // Centroid of the seed tetrahedron stays strictly inside the growing hull.
  const interior: Vec3 = vecScale(
    [
      pts[i0]![0] + pts[i1]![0] + pts[i2]![0] + pts[i3]![0],
      pts[i0]![1] + pts[i1]![1] + pts[i2]![1] + pts[i3]![1],
      pts[i0]![2] + pts[i1]![2] + pts[i2]![2] + pts[i3]![2],
    ],
    0.25,
  );

  const faces: WorkFace[] = [];
  const pushFace = (a: number, b: number, c: number, normal: Vec3): void => {
    let va = a;
    let vb = b;
    let vc = c;
    let n = normal;
    if (dot(n, sub(pts[va]!, interior)) < 0) {
      const t = vb;
      vb = vc;
      vc = t;
      n = [-n[0], -n[1], -n[2]];
    }
    faces.push({ v: [va, vb, vc], normal: n });
  };
  const faceNormal = (a: number, b: number, c: number): Vec3 | null => {
    const n = cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
    const len = length(n);
    if (len <= 1e-12 * scale * scale) return null;
    return vecScale(n, 1 / len);
  };

  for (const [a, b, c] of [
    [i0, i1, i2],
    [i0, i1, i3],
    [i0, i2, i3],
    [i1, i2, i3],
  ] as const) {
    const n = faceNormal(a, b, c);
    if (n !== null) pushFace(a, b, c, n);
  }

  // --- absorb remaining points ---
  const seed = new Set([i0, i1, i2, i3]);
  for (let pi = 0; pi < pts.length; pi++) {
    if (seed.has(pi)) continue;
    const p = pts[pi]!;

    const visible: number[] = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi]!;
      if (dot(f.normal, sub(p, pts[f.v[0]]!)) > eps) visible.push(fi);
    }
    if (visible.length === 0) continue; // inside or on the hull

    // Horizon = directed edges of visible faces used exactly once.
    const directed: Array<[number, number]> = [];
    for (const fi of visible) {
      const f = faces[fi]!;
      for (let e = 0; e < 3; e++) {
        directed.push([f.v[e]!, f.v[(e + 1) % 3]!]);
      }
    }
    const edgeCount = new Map<string, number>();
    for (const [a, b] of directed) {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
    const horizon = directed.filter(([a, b]) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      return edgeCount.get(k) === 1;
    });

    const removed = new Set(visible);
    const remaining = faces.filter((_, fi) => !removed.has(fi));
    faces.length = 0;
    faces.push(...remaining);
    seed.add(pi);

    for (const [a, b] of horizon) {
      let n = faceNormal(a, b, pi);
      if (n === null) {
        // p is collinear with the horizon edge: the new triangle is
        // coplanar with the surviving neighbour face, so reuse its normal.
        const neighbour = remaining.find(
          (f) => f.v.includes(a) && f.v.includes(b),
        );
        if (neighbour === undefined) continue;
        n = neighbour.normal;
      }
      pushFace(a, b, pi, n);
    }
  }

  // --- compact vertices and remap face indices ---
  const remap = new Map<number, number>();
  const vertices: Vec3[] = [];
  const outFaces = faces.map((f) => {
    const tri: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const old = f.v[k]!;
      let ni = remap.get(old);
      if (ni === undefined) {
        ni = vertices.length;
        vertices.push(pts[old]!);
        remap.set(old, ni);
      }
      tri[k] = ni;
    }
    return { vertices: tri, normal: f.normal };
  });
  return { vertices, faces: outFaces };
}

/** Index of the vertex maximizing dot(vertex, dir). Ties: lowest index. */
export function supportIndex(vertices: readonly Vec3[], dir: Vec3): number {
  let best = 0;
  let bestDot = dot(vertices[0]!, dir);
  for (let i = 1; i < vertices.length; i++) {
    const d = dot(vertices[i]!, dir);
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

import { add, cross, dot, negate, normalize, scale, sub, vec3 } from "./vec3.js";
import type { Vec3 } from "./vec3.js";
import type { Hull, Pose } from "./types.js";
import { minkowskiSupport } from "./gjk.js";
import type { SupportPoint } from "./gjk.js";

export interface EpaResult {
  depth: number;
  normal: Vec3;
}

type SupportFn = (dir: Vec3) => SupportPoint;

const EPS = 1e-9;
const MAX_ITER = 256;
const MAX_VERTS = 1024;

interface Face {
  i0: number;
  i1: number;
  i2: number;
  normal: Vec3;
  dist: number;
}

/**
 * Build a triangular face whose normal points away from `interior`
 * (a point strictly inside the polytope). This keeps windings consistent
 * even when the origin lies exactly on the face plane.
 */
function makeFace(
  verts: SupportPoint[],
  i0: number,
  i1: number,
  i2: number,
  interior: Vec3,
): Face | null {
  const a = verts[i0].v;
  const b = verts[i1].v;
  const c = verts[i2].v;
  let n = cross(sub(b, a), sub(c, a));
  const len = Math.sqrt(dot(n, n));
  if (len < EPS) return null;
  n = scale(n, 1 / len);
  let j1 = i1;
  let j2 = i2;
  if (dot(n, sub(a, interior)) < 0) {
    n = negate(n);
    j1 = i2;
    j2 = i1;
  }
  return { i0, i1: j1, i2: j2, normal: n, dist: dot(n, a) };
}

/** Perpendicular directions to a segment, for simplex expansion. */
function perpendiculars(edge: Vec3): Vec3[] {
  const axes = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  const out: Vec3[] = [];
  for (const a of axes) {
    const d = cross(edge, a);
    if (Math.sqrt(dot(d, d)) > EPS) out.push(normalize(d));
  }
  return out;
}

/**
 * Grow the GJK terminal simplex (which contains the origin) into a
 * tetrahedron enclosing the origin. Returns null when the origin lies on
 * the CSO boundary (touching), i.e. no enclosing tetrahedron exists.
 */
function tetrahedronFromSimplex(support: SupportFn, simplex: SupportPoint[]): SupportPoint[] | null {
  let pts = [...simplex];
  if (pts.length === 1) {
    const p = pts[0].v;
    const n = Math.sqrt(dot(p, p));
    if (n < EPS) return null; // origin on a CSO vertex
    pts.push(support(scale(p, -1 / n)));
  }
  if (pts.length === 2) {
    const edge = sub(pts[1].v, pts[0].v);
    for (const d of perpendiculars(edge)) {
      for (const dir of [d, negate(d)]) {
        const c = support(dir);
        const n = cross(sub(pts[1].v, pts[0].v), sub(c.v, pts[0].v));
        if (Math.sqrt(dot(n, n)) > EPS) {
          pts.push(c);
          break;
        }
      }
      if (pts.length > 2) break;
    }
    if (pts.length < 3) return null;
  }
  if (pts.length === 3) {
    const [a, b, c] = pts.map((p) => p.v);
    let n = cross(sub(b, a), sub(c, a));
    const len = Math.sqrt(dot(n, n));
    if (len < EPS) return null;
    n = scale(n, 1 / len);
    // Origin is (nearly) on the triangle plane; lift it with a support
    // point on either side.
    for (const dir of [n, negate(n)]) {
      const v4 = support(dir);
      const height = dot(sub(v4.v, a), n);
      if (Math.abs(height) > 1e-8) {
        const tet = [...pts, v4];
        if (containsOrigin(tet)) return tet;
      }
    }
    return null;
  }
  if (pts.length === 4 && containsOrigin(pts)) return pts;
  return null;
}

/** Build an initial tetrahedron of the CSO that encloses the origin. */
function initialTetrahedron(support: SupportFn): SupportPoint[] | null {
  const seeds: Vec3[] = [
    vec3(1, 0, 0),
    vec3(0, 1, 0),
    vec3(0, 0, 1),
    vec3(1, 1, 1),
    vec3(-1, 1, 1),
    vec3(1, -1, 1),
  ];
  for (const seed of seeds) {
    const v1 = support(seed);
    const n1 = Math.sqrt(dot(v1.v, v1.v));
    if (n1 < EPS) return [v1, v1, v1, v1]; // origin on CSO vertex; degenerate
    const v2 = support(scale(v1.v, -1 / n1));
    const edge = sub(v2.v, v1.v);
    const edgeLen = Math.sqrt(dot(edge, edge));
    if (edgeLen < EPS) continue;
    // Direction perpendicular to the edge, toward the origin.
    const t = dot(negate(v1.v), edge) / (edgeLen * edgeLen);
    let d3 = sub(negate(v1.v), scale(edge, t));
    if (Math.sqrt(dot(d3, d3)) < EPS) {
      // Origin lies on the line; pick any perpendicular direction.
      const axis = Math.abs(edge.x) < Math.abs(edge.y)
        ? (Math.abs(edge.x) < Math.abs(edge.z) ? vec3(1, 0, 0) : vec3(0, 0, 1))
        : (Math.abs(edge.y) < Math.abs(edge.z) ? vec3(0, 1, 0) : vec3(0, 0, 1));
      d3 = cross(edge, axis);
    }
    const v3 = support(d3);
    let n = cross(sub(v2.v, v1.v), sub(v3.v, v1.v));
    if (Math.sqrt(dot(n, n)) < EPS) continue;
    if (dot(n, negate(v1.v)) < 0) n = negate(n);
    const v4 = support(n);
    const height = dot(sub(v4.v, v1.v), normalize(n));
    if (Math.abs(height) < EPS) continue; // flat; try another seed
    const tet = [v1, v2, v3, v4];
    if (containsOrigin(tet)) return tet;
  }
  return null;
}

function containsOrigin(tet: SupportPoint[]): boolean {
  const [a, b, c, d] = tet.map((p) => p.v);
  const faces: [Vec3, Vec3, Vec3][] = [
    [a, b, c],
    [a, d, b],
    [a, c, d],
    [b, d, c],
  ];
  for (const [p0, p1, p2] of faces) {
    const n = cross(sub(p1, p0), sub(p2, p0));
    const len = Math.sqrt(dot(n, n));
    if (len < EPS) continue;
    const opposite = [a, b, c, d].find((p) => p !== p0 && p !== p1 && p !== p2)!;
    const sideOrigin = dot(n, negate(p0));
    const sideApex = dot(n, sub(opposite, p0));
    if (sideOrigin * sideApex < -EPS) return false;
  }
  return true;
}

function fallbackResult(poseA: Pose, poseB: Pose): EpaResult {
  const dir = sub(poseB.translation, poseA.translation);
  const normal = Math.sqrt(dot(dir, dir)) > EPS ? normalize(dir) : vec3(1, 0, 0);
  return { depth: 0, normal };
}

function faceResult(face: Face): EpaResult {
  return { depth: Math.max(0, face.dist), normal: face.normal };
}

export function epaPenetration(
  hullA: Hull,
  poseA: Pose,
  hullB: Hull,
  poseB: Pose,
  gjkSimplex?: SupportPoint[],
): EpaResult {
  const support: SupportFn = (dir) => minkowskiSupport(hullA, poseA, hullB, poseB, dir);

  let tet: SupportPoint[] | null = null;
  if (gjkSimplex && gjkSimplex.length > 1) {
    tet = tetrahedronFromSimplex(support, gjkSimplex);
  }
  if (!tet) tet = initialTetrahedron(support);
  if (!tet) return fallbackResult(poseA, poseB);

  const verts: SupportPoint[] = [...tet];
  // A point strictly inside the initial tetrahedron stays inside the
  // polytope as it grows; use it to orient every face consistently.
  const interior = scale(
    add(add(tet[0].v, tet[1].v), add(tet[2].v, tet[3].v)),
    0.25,
  );

  let faces: Face[] = [];
  const initFaces: [number, number, number][] = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  for (const [i, j, k] of initFaces) {
    const f = makeFace(verts, i, j, k, interior);
    if (f) faces.push(f);
  }
  if (faces.length < 4) return fallbackResult(poseA, poseB);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let minFace = faces[0];
    for (const f of faces) if (f.dist < minFace.dist) minFace = f;

    const p = support(minFace.normal);
    const newDist = dot(p.v, minFace.normal);
    if (newDist - minFace.dist < Math.max(1e-10, 1e-7 * Math.abs(minFace.dist))) {
      return faceResult(minFace);
    }
    if (verts.length >= MAX_VERTS) {
      return faceResult(minFace);
    }

    // Horizon expansion.
    const pIndex = verts.length;
    verts.push(p);
    const edgeMap = new Map<string, [number, number]>();
    const remaining: Face[] = [];
    for (const f of faces) {
      const visible = dot(f.normal, p.v) - f.dist > 1e-12;
      if (!visible) {
        remaining.push(f);
        continue;
      }
      const edges: [number, number][] = [
        [f.i0, f.i1],
        [f.i1, f.i2],
        [f.i2, f.i0],
      ];
      for (const [e0, e1] of edges) {
        const revKey = `${e1},${e0}`;
        if (edgeMap.has(revKey)) {
          edgeMap.delete(revKey);
        } else {
          edgeMap.set(`${e0},${e1}`, [e0, e1]);
        }
      }
    }
    faces = remaining;
    for (const [e0, e1] of edgeMap.values()) {
      const f = makeFace(verts, e0, e1, pIndex, interior);
      if (f) faces.push(f);
    }
    if (faces.length === 0) return fallbackResult(poseA, poseB);
  }
  return fallbackResult(poseA, poseB);
}

import type { Vec3 } from "./types.js";
import type { MinkowskiSupport, SupportPoint } from "./gjk.js";
import { cross, dot, length, scale as vecScale, sub } from "./math.js";

export interface EpaResult {
  /** Penetration depth (>= 0): minimal translation length to separate. */
  depth: number;
  /**
   * Unit normal n such that translating B by depth * n removes the
   * intersection (equivalently the outward normal of the Minkowski
   * difference boundary point closest to the origin).
   */
  normal: Vec3;
  /** Witness point on the surface of A (world). */
  pointA: Vec3;
  /** Witness point on the surface of B (world). */
  pointB: Vec3;
}

interface EpaFace {
  v: [number, number, number];
  normal: Vec3;
  /** Distance from the origin to the face plane (>= 0 for outward normals). */
  dist: number;
}

function samePoint(a: Vec3, b: Vec3, eps: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= eps &&
    Math.abs(a[1] - b[1]) <= eps &&
    Math.abs(a[2] - b[2]) <= eps
  );
}

/** Grow the seed simplex into a full tetrahedron using extra supports. */
function buildInitialTetrahedron(
  support: MinkowskiSupport,
  seed: SupportPoint[],
  eps: number,
): SupportPoint[] {
  const verts = [...seed];
  if (verts.length === 1) {
    const axes: Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const ax of axes) {
      const sp = support(ax);
      if (!verts.some((v) => samePoint(v.w, sp.w, eps))) {
        verts.push(sp);
        break;
      }
    }
  }
  if (verts.length === 2) {
    const d = sub(verts[1]!.w, verts[0]!.w);
    const dl = length(d);
    const ax: Vec3 =
      Math.abs(d[0]) <= Math.abs(d[1]) && Math.abs(d[0]) <= Math.abs(d[2])
        ? [1, 0, 0]
        : Math.abs(d[1]) <= Math.abs(d[2])
          ? [0, 1, 0]
          : [0, 0, 1];
    const e2 = cross(d, ax);
    const e3 = cross(d, e2);
    for (const dir of [e2, vecScale(e2, -1), e3, vecScale(e3, -1)]) {
      if (length(dir) === 0) continue;
      const sp = support(dir);
      // Accept only points strictly off the seed line.
      const off = cross(sub(sp.w, verts[0]!.w), d);
      if (length(off) > eps * dl) {
        verts.push(sp);
        break;
      }
    }
  }
  if (verts.length === 3) {
    const n = cross(
      sub(verts[1]!.w, verts[0]!.w),
      sub(verts[2]!.w, verts[0]!.w),
    );
    const nl = length(n);
    for (const dir of [n, vecScale(n, -1)]) {
      if (length(dir) === 0) continue;
      const sp = support(dir);
      // Accept only points strictly off the seed plane; when the origin
      // lies on the Minkowski boundary (exactly touching), the outward
      // support stays in the plane and the inward one must be used.
      if (Math.abs(dot(sub(sp.w, verts[0]!.w), n)) > eps * nl) {
        verts.push(sp);
        break;
      }
    }
  }
  if (verts.length !== 4) {
    throw new Error("EPA: failed to build an initial tetrahedron");
  }
  return verts;
}

/**
 * Expanding Polytope Algorithm. Requires the origin to be inside (or on
 * the boundary of) the Minkowski difference. `seed` is the terminal GJK
 * simplex (1..4 support points) used to bootstrap the polytope.
 */
export function epaPenetration(
  support: MinkowskiSupport,
  seed: SupportPoint[],
): EpaResult {
  let scale = 1;
  for (const s of seed) scale = Math.max(scale, length(s.w));
  const verts = buildInitialTetrahedron(support, seed, 1e-9 * scale);
  for (const v of verts) scale = Math.max(scale, length(v.w));
  const tol = 1e-9 * scale;

  // Strictly interior reference point: the seed tetrahedron's centroid
  // stays inside every later (only ever growing) polytope, so it can
  // orient faces outward even when the origin lies exactly on a face.
  const inner: Vec3 = [0, 0, 0];
  for (const v of verts) {
    inner[0] += v.w[0] / 4;
    inner[1] += v.w[1] / 4;
    inner[2] += v.w[2] / 4;
  }

  const faces: EpaFace[] = [];
  const addFace = (a: number, b: number, c: number): void => {
    const wa = verts[a]!.w;
    let n = cross(sub(verts[b]!.w, wa), sub(verts[c]!.w, wa));
    const len = length(n);
    if (len <= 1e-14 * scale * scale) return; // degenerate triangle
    n = vecScale(n, 1 / len);
    let va = a;
    let vb = b;
    let vc = c;
    if (dot(n, sub(wa, inner)) < 0) {
      // Orient the normal away from the polytope interior.
      const t = vb;
      vb = vc;
      vc = t;
      n = [-n[0], -n[1], -n[2]];
    }
    const dist = dot(n, wa);
    faces.push({ v: [va, vb, vc], normal: n, dist });
  };

  addFace(0, 1, 2);
  addFace(0, 1, 3);
  addFace(0, 2, 3);
  addFace(1, 2, 3);

  let best: EpaFace | null = null;
  for (let iter = 0; iter < 256; iter++) {
    best = faces[0]!;
    for (const f of faces) {
      if (f.dist < best.dist) best = f;
    }
    const sp = support(best.normal);
    scale = Math.max(scale, length(sp.w));
    if (dot(sp.w, best.normal) - best.dist <= tol) break; // converged

    const newIdx = verts.length;
    verts.push(sp);

    const visible: number[] = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi]!;
      if (dot(f.normal, sub(sp.w, verts[f.v[0]]!.w)) > 1e-12 * scale) {
        visible.push(fi);
      }
    }
    if (visible.length === 0) break; // numerical dead end; keep best

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
    const surviving = faces.filter((_, fi) => !removed.has(fi));
    faces.length = 0;
    faces.push(...surviving);
    for (const [a, b] of horizon) addFace(a, b, newIdx);
    if (faces.length === 0 || verts.length > 2048) break;
  }

  if (best === null) throw new Error("EPA: empty polytope");

  // Barycentric coordinates of the origin's projection on the best face.
  const [ia, ib, ic] = best.v;
  const p = vecScale(best.normal, best.dist);
  const w0 = verts[ia]!.w;
  const e0 = sub(verts[ib]!.w, w0);
  const e1 = sub(verts[ic]!.w, w0);
  const e2 = sub(p, w0);
  const d00 = dot(e0, e0);
  const d01 = dot(e0, e1);
  const d11 = dot(e1, e1);
  const d20 = dot(e2, e0);
  const d21 = dot(e2, e1);
  const denom = d00 * d11 - d01 * d01;
  let lambda: [number, number, number];
  if (denom <= 1e-20 * scale * scale * scale * scale) {
    lambda = [1, 0, 0];
  } else {
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    lambda = [1 - v - w, v, w];
    // Clamp tiny numerical excursions so witnesses stay inside the bodies.
    for (let i = 0; i < 3; i++) {
      if (lambda[i]! < 0 && lambda[i]! > -1e-9) lambda[i] = 0;
    }
    const sum = lambda[0] + lambda[1] + lambda[2];
    lambda = [lambda[0] / sum, lambda[1] / sum, lambda[2] / sum];
  }

  const pointA: Vec3 = [0, 0, 0];
  const pointB: Vec3 = [0, 0, 0];
  const tri = [ia, ib, ic];
  for (let k = 0; k < 3; k++) {
    const sp = verts[tri[k]!]!;
    for (const c of [0, 1, 2] as const) {
      pointA[c] += lambda[k]! * sp.a[c];
      pointB[c] += lambda[k]! * sp.b[c];
    }
  }

  return {
    depth: Math.max(0, best.dist),
    normal: best.normal,
    pointA,
    pointB,
  };
}

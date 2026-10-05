/** 3D vector as a plain tuple [x, y, z]. */
export type Vec3 = [number, number, number];

/** Unit quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];

/** Rigid pose: translation plus unit quaternion (local -> world). */
export interface Pose {
  translation: Vec3;
  quaternion: Quat;
}

/** A triangular face of the convex hull, referencing vertex indices. */
export interface HullFace {
  /** Vertex indices, wound counter-clockwise when seen from outside. */
  vertices: [number, number, number];
  /** Outward unit normal. */
  normal: Vec3;
}

/**
 * A reusable convex body built by {@link createHull}.
 * Vertices and faces are expressed in the body's local frame.
 */
export interface Hull {
  /** Extreme vertices of the convex hull (interior/duplicate points removed). */
  vertices: Vec3[];
  /** Triangulation of the hull surface with outward normals. */
  faces: HullFace[];
}

/** Result of a {@link contact} query, expressed in world coordinates. */
export interface ContactResult {
  /**
   * Signed distance. Positive when separated (shortest euclidean distance).
   * Negative when penetrating: its absolute value is the minimal translation
   * length applied to B (keeping A fixed) that removes interior intersection.
   */
  distance: number;
  /**
   * Unit normal. When separated it points from pointA toward pointB.
   * Always satisfies pointB - pointA = distance * normal.
   */
  normal: Vec3;
  /** Witness point on the surface of A (world coordinates). */
  pointA: Vec3;
  /** Witness point on the surface of B (world coordinates). */
  pointB: Vec3;
}

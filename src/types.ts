import type { Vec3 } from "./vec3.js";
import type { Quat } from "./quat.js";

export interface Pose {
  translation: Vec3;
  rotation: Quat;
}

export interface Hull {
  /** Unique local-space vertices of the convex hull. */
  readonly vertices: readonly Vec3[];
}

export interface ContactResult {
  distance: number;
  normal: Vec3;
  pointA: Vec3;
  pointB: Vec3;
}

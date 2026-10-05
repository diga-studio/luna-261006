import type { Vec3 } from "./vec3.js";

export type Quat = { w: number; x: number; y: number; z: number };

export const IDENTITY_QUAT: Quat = { w: 1, x: 0, y: 0, z: 0 };

export function conjugate(q: Quat): Quat {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

export function rotateVec(q: Quat, v: Vec3): Vec3 {
  // q * (0, v) * q^-1, expanded and simplified (assumes unit quaternion).
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function inverseRotateVec(q: Quat, v: Vec3): Vec3 {
  return rotateVec(conjugate(q), v);
}

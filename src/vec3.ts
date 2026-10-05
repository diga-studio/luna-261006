export type Vec3 = { x: number; y: number; z: number };

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function lengthSq(a: Vec3): number {
  return dot(a, a);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) {
    throw new Error("cannot normalize zero vector");
  }
  return scale(a, 1 / len);
}

export function negate(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return add(scale(a, 1 - t), scale(b, t));
}

import { analyzeGlb } from "./analyze";
import { NormalizeResult } from "./types";

/** Uniformly scale the model so every axis size fits the target (given in
 *  centimeters), ground the lowest point at y=0 and center xz at the origin.
 *  Returns the outer scene matrix (column-major) and the normalized bounds. */
export function normalizeGlb(
  bytes: Uint8Array,
  targetCm: [number, number, number]
): NormalizeResult {
  const { bounds } = analyzeGlb(bytes);
  const dims: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const target: [number, number, number] = [
    targetCm[0] / 100,
    targetCm[1] / 100,
    targetCm[2] / 100,
  ];
  const scale = Math.min(
    target[0] / dims[0],
    target[1] / dims[1],
    target[2] / dims[2]
  );

  const tx = -scale * (bounds.min[0] + bounds.max[0]) / 2;
  const ty = -scale * bounds.min[1];
  const tz = -scale * (bounds.min[2] + bounds.max[2]) / 2;

  const matrix = [
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    tx, ty, tz, 1,
  ];

  const min: [number, number, number] = [
    scale * bounds.min[0] + tx,
    scale * bounds.min[1] + ty,
    scale * bounds.min[2] + tz,
  ];
  const max: [number, number, number] = [
    scale * bounds.max[0] + tx,
    scale * bounds.max[1] + ty,
    scale * bounds.max[2] + tz,
  ];

  return {
    matrix,
    bounds: { min, max },
    dimensions: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

import { parseGlb } from './glb.js';
import { computeSceneBounds } from './scene.js';
import type { NormalizeResult } from './types.js';

/**
 * 归一化：以三轴均不超过目标尺寸（厘米）的最大统一缩放，
 * 使最终边界最低点位于 y=0、xz 中心位于原点。
 * 返回附加在整个场景外侧的列主序 4×4 矩阵及归一化后的边界。
 */
export function normalizeGlb(
  bytes: Uint8Array,
  targetXCm: number,
  targetYCm: number,
  targetZCm: number,
): NormalizeResult {
  const targets = [targetXCm, targetYCm, targetZCm];
  if (targets.some((t) => !(t > 0))) {
    throw new Error('target dimensions must be positive');
  }
  const { json, bin } = parseGlb(bytes);
  const bounds = computeSceneBounds(json, bin);
  const size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  if (size.some((s) => !(s > 0))) {
    throw new Error('model size must be positive on all axes');
  }

  const scale = Math.min(
    targetXCm / 100 / size[0],
    targetYCm / 100 / size[1],
    targetZCm / 100 / size[2],
  );

  // 先平移使最低点与 xz 中心归零，再统一缩放：M = S * T。
  const tx = -(bounds.min[0] + bounds.max[0]) / 2;
  const ty = -bounds.min[1];
  const tz = -(bounds.min[2] + bounds.max[2]) / 2;

  const matrix = [
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    scale * tx, scale * ty, scale * tz, 1,
  ];

  const normalizedBounds = {
    min: [
      scale * (bounds.min[0] + tx),
      scale * (bounds.min[1] + ty),
      scale * (bounds.min[2] + tz),
    ] as [number, number, number],
    max: [
      scale * (bounds.max[0] + tx),
      scale * (bounds.max[1] + ty),
      scale * (bounds.max[2] + tz),
    ] as [number, number, number],
  };

  return {
    matrix,
    bounds: normalizedBounds,
    size: [
      normalizedBounds.max[0] - normalizedBounds.min[0],
      normalizedBounds.max[1] - normalizedBounds.min[1],
      normalizedBounds.max[2] - normalizedBounds.min[2],
    ],
  };
}

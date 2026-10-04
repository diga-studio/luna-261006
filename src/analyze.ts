import { parseGlb } from './glb.js';
import { computeSceneBounds } from './scene.js';
import type { AnalysisResult } from './types.js';

/** 分析 GLB 字节，返回场景坐标系中的紧致边界与三轴尺寸（米）。 */
export function analyzeGlb(bytes: Uint8Array): AnalysisResult {
  const { json, bin } = parseGlb(bytes);
  const bounds = computeSceneBounds(json, bin);
  return {
    bounds,
    size: [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ],
  };
}

import { readIndices, readPositions } from './accessor.js';
import { fromTrs, identity, multiply, transformPoint, type Mat4 } from './math.js';
import type { Bounds, GltfDocument, GltfNode } from './types.js';

const DEFAULT_TRANSLATION = [0, 0, 0] as const;
const DEFAULT_ROTATION = [0, 0, 0, 1] as const;
const DEFAULT_SCALE = [1, 1, 1] as const;

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix !== undefined) {
    return Float64Array.from(node.matrix);
  }
  return fromTrs(
    node.translation ?? DEFAULT_TRANSLATION,
    node.rotation ?? DEFAULT_ROTATION,
    node.scale ?? DEFAULT_SCALE,
  );
}

/**
 * 遍历默认（未声明时第一个）场景可达节点，累计全部网格实例
 * 经完整变换后的 POSITION 顶点，返回紧致轴对齐边界。
 */
export function computeSceneBounds(json: GltfDocument, bin: Uint8Array): Bounds {
  const scenes = json.scenes ?? [];
  const sceneIndex = json.scene ?? 0;
  const scene = scenes[sceneIndex];
  if (!scene || !scene.nodes || scene.nodes.length === 0) {
    throw new Error('selected scene is empty');
  }
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  const visit = (nodeIndex: number, parentWorld: Mat4): void => {
    const node = nodes[nodeIndex];
    if (!node) {
      throw new Error(`missing node ${nodeIndex}`);
    }
    const world = multiply(parentWorld, localMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (!mesh) {
        throw new Error(`missing mesh ${node.mesh}`);
      }
      for (const primitive of mesh.primitives ?? []) {
        const positionAccessor = primitive.attributes?.POSITION;
        if (positionAccessor === undefined) {
          continue;
        }
        const indices =
          primitive.indices !== undefined
            ? readIndices(json, bin, primitive.indices)
            : null;
        readPositions(json, bin, positionAccessor, indices, (x, y, z) => {
          const [wx, wy, wz] = transformPoint(world, x, y, z);
          if (wx < min[0]) min[0] = wx;
          if (wy < min[1]) min[1] = wy;
          if (wz < min[2]) min[2] = wz;
          if (wx > max[0]) max[0] = wx;
          if (wy > max[1]) max[1] = wy;
          if (wz > max[2]) max[2] = wz;
        });
      }
    }

    for (const child of node.children ?? []) {
      visit(child, world);
    }
  };

  const rootWorld = identity();
  for (const root of scene.nodes) {
    visit(root, rootWorld);
  }

  if (!Number.isFinite(min[0])) {
    throw new Error('scene contains no vertices');
  }
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
  };
}

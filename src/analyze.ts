import { parseGlb } from "./glb";
import { readIndices, readPositions } from "./accessor";
import { composeTRS, identityMat4, mat4FromArray, multiplyMat4, transformPoint } from "./math";
import { AnalysisResult, GltfDocument, Mat4 } from "./types";

function nodeLocalMatrix(node: {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}): Mat4 {
  if (node.matrix !== undefined) {
    return mat4FromArray(node.matrix);
  }
  return composeTRS(
    (node.translation as [number, number, number]) ?? [0, 0, 0],
    (node.rotation as [number, number, number, number]) ?? [0, 0, 0, 1],
    (node.scale as [number, number, number]) ?? [1, 1, 1]
  );
}

interface Accumulator {
  min: [number, number, number];
  max: [number, number, number];
  seen: boolean;
}

function accumulatePrimitive(
  doc: GltfDocument,
  bin: Uint8Array,
  meshIndex: number,
  world: Mat4,
  acc: Accumulator
): void {
  const mesh = doc.meshes[meshIndex];
  for (const primitive of mesh.primitives) {
    const positionIndex = primitive.attributes["POSITION"];
    if (positionIndex === undefined) {
      continue;
    }
    const positions = readPositions(doc, bin, positionIndex);
    const visit = (elementIndex: number): void => {
      const p = positions.get(elementIndex);
      const [x, y, z] = transformPoint(world, p[0], p[1], p[2]);
      if (!acc.seen) {
        acc.min = [x, y, z];
        acc.max = [x, y, z];
        acc.seen = true;
        return;
      }
      if (x < acc.min[0]) acc.min[0] = x;
      if (y < acc.min[1]) acc.min[1] = y;
      if (z < acc.min[2]) acc.min[2] = z;
      if (x > acc.max[0]) acc.max[0] = x;
      if (y > acc.max[1]) acc.max[1] = y;
      if (z > acc.max[2]) acc.max[2] = z;
    };
    if (primitive.indices !== undefined) {
      const indices = readIndices(doc, bin, primitive.indices);
      for (let i = 0; i < indices.count; i++) {
        visit(indices.get(i));
      }
    } else {
      for (let i = 0; i < positions.count; i++) {
        visit(i);
      }
    }
  }
}

function walkNode(
  doc: GltfDocument,
  bin: Uint8Array,
  nodeIndex: number,
  parentWorld: Mat4,
  acc: Accumulator
): void {
  const node = doc.nodes[nodeIndex];
  const world = multiplyMat4(parentWorld, nodeLocalMatrix(node));
  if (node.mesh !== undefined) {
    accumulatePrimitive(doc, bin, node.mesh, world, acc);
  }
  for (const child of node.children ?? []) {
    walkNode(doc, bin, child, world, acc);
  }
}

/** Analyze the default scene of a GLB: tight AABB and axis sizes in meters. */
export function analyzeGlb(bytes: Uint8Array): AnalysisResult {
  const { json: doc, bin } = parseGlb(bytes);
  const sceneIndex = doc.scene ?? 0;
  const scene = doc.scenes[sceneIndex];
  const acc: Accumulator = {
    min: [0, 0, 0],
    max: [0, 0, 0],
    seen: false,
  };
  for (const root of scene.nodes ?? []) {
    walkNode(doc, bin, root, identityMat4(), acc);
  }
  if (!acc.seen) {
    throw new Error("scene contains no geometry");
  }
  return {
    bounds: { min: acc.min, max: acc.max },
    dimensions: [
      acc.max[0] - acc.min[0],
      acc.max[1] - acc.min[1],
      acc.max[2] - acc.min[2],
    ],
  };
}

/** glTF 2.0 JSON 顶层结构（仅保留本库关心的字段）。 */
export interface GltfDocument {
  scene?: number;
  scenes?: GltfScene[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: GltfBuffer[];
}

export interface GltfScene {
  nodes?: number[];
}

export interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GltfMesh {
  primitives?: GltfPrimitive[];
}

export interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: GltfSparse;
}

export interface GltfSparse {
  count: number;
  indices: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
  };
  values: {
    bufferView: number;
    byteOffset?: number;
  };
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfBuffer {
  byteLength: number;
  uri?: string;
}

/** 场景坐标系中的紧致轴对齐边界（米）。 */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** 尺寸分析结果。 */
export interface AnalysisResult {
  bounds: Bounds;
  /** 三轴尺寸（米），顺序为 x、y、z。 */
  size: [number, number, number];
}

/** 归一化结果。 */
export interface NormalizeResult {
  /** 附加在整个场景外侧的 4×4 矩阵，列主序，作用于列向量。 */
  matrix: number[];
  /** 归一化后的边界（米）。 */
  bounds: Bounds;
  /** 归一化后的三轴尺寸（米）。 */
  size: [number, number, number];
}

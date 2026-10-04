/** 4x4 matrix, column-major, applied to column vectors. */
export type Mat4 = Float64Array;

/** Tight axis-aligned bounds in scene coordinates, meters. */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Result of dimension analysis. */
export interface AnalysisResult {
  bounds: Bounds;
  /** Axis sizes in meters: [x, y, z]. */
  dimensions: [number, number, number];
}

/** Result of grounding normalization. */
export interface NormalizeResult {
  /** Column-major 4x4 matrix wrapping the whole scene. */
  matrix: number[];
  bounds: Bounds;
  dimensions: [number, number, number];
}

// ---- Minimal glTF 2.0 JSON typings (only what we consume) ----

export interface GltfAccessorSparseIndices {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
}

export interface GltfAccessorSparseValues {
  bufferView: number;
  byteOffset?: number;
}

export interface GltfAccessorSparse {
  count: number;
  indices: GltfAccessorSparseIndices;
  values: GltfAccessorSparseValues;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: GltfAccessorSparse;
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
}

export interface GltfMesh {
  primitives: GltfPrimitive[];
}

export interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GltfScene {
  nodes?: number[];
}

export interface GltfDocument {
  scene?: number;
  scenes: GltfScene[];
  nodes: GltfNode[];
  meshes: GltfMesh[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
}

export interface ParsedGlb {
  json: GltfDocument;
  bin: Uint8Array;
}

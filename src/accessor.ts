import type { GltfAccessor, GltfDocument } from './types.js';

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

function accessorInfo(json: GltfDocument, accessorIndex: number) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) {
    throw new Error(`missing accessor ${accessorIndex}`);
  }
  const componentSize = COMPONENT_SIZE[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  if (componentSize === undefined || components === undefined) {
    throw new Error(`unsupported accessor ${accessorIndex}`);
  }
  return { accessor, componentSize, components };
}

function bufferViewRange(json: GltfDocument, bin: Uint8Array, bufferViewIndex: number) {
  const bufferView = json.bufferViews?.[bufferViewIndex];
  if (!bufferView || bufferView.buffer !== 0) {
    throw new Error(`unsupported bufferView ${bufferViewIndex}`);
  }
  const start = bufferView.byteOffset ?? 0;
  if (start + bufferView.byteLength > bin.byteLength) {
    throw new Error(`bufferView ${bufferViewIndex} exceeds BIN chunk`);
  }
  return { bufferView, start };
}

/** 稀疏覆盖表：元素下标 -> 覆盖值在稀疏 values 中的序号。 */
function sparseMap(
  json: GltfDocument,
  bin: Uint8Array,
  accessor: GltfAccessor,
): Map<number, number> | null {
  const sparse = accessor.sparse;
  if (!sparse) {
    return null;
  }
  const indexComponentSize = COMPONENT_SIZE[sparse.indices.componentType];
  if (indexComponentSize === undefined) {
    throw new Error('unsupported sparse index componentType');
  }
  const { start: indicesStart } = bufferViewRange(json, bin, sparse.indices.bufferView);
  const indicesOffset = indicesStart + (sparse.indices.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const map = new Map<number, number>();
  for (let i = 0; i < sparse.count; i++) {
    const at = indicesOffset + i * indexComponentSize;
    let elementIndex: number;
    if (indexComponentSize === 1) {
      elementIndex = view.getUint8(at);
    } else if (indexComponentSize === 2) {
      elementIndex = view.getUint16(at, true);
    } else {
      elementIndex = view.getUint32(at, true);
    }
    map.set(elementIndex, i);
  }
  return map;
}

/** 读取无符号整数索引 accessor（8/16/32 位），支持偏移、交错与稀疏覆盖。 */
export function readIndices(
  json: GltfDocument,
  bin: Uint8Array,
  accessorIndex: number,
): Uint32Array {
  const { accessor, componentSize } = accessorInfo(json, accessorIndex);
  if (
    accessor.componentType !== 5121 &&
    accessor.componentType !== 5123 &&
    accessor.componentType !== 5125
  ) {
    throw new Error(`indices accessor ${accessorIndex} must be unsigned integer`);
  }
  const count = accessor.count;
  const out = new Uint32Array(count);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  let base: ((i: number) => number) | null = null;
  if (accessor.bufferView !== undefined) {
    const { bufferView, start } = bufferViewRange(json, bin, accessor.bufferView);
    const elementOffset = start + (accessor.byteOffset ?? 0);
    const stride = bufferView.byteStride ?? componentSize;
    if (componentSize === 1) {
      base = (i) => view.getUint8(elementOffset + i * stride);
    } else if (componentSize === 2) {
      base = (i) => view.getUint16(elementOffset + i * stride, true);
    } else {
      base = (i) => view.getUint32(elementOffset + i * stride, true);
    }
  }

  const sparse = sparseMap(json, bin, accessor);
  let sparseValuesOffset = 0;
  if (sparse) {
    const { start } = bufferViewRange(json, bin, accessor.sparse!.values.bufferView);
    sparseValuesOffset = start + (accessor.sparse!.values.byteOffset ?? 0);
  }

  for (let i = 0; i < count; i++) {
    const override = sparse?.get(i);
    if (override !== undefined) {
      const at = sparseValuesOffset + override * componentSize;
      if (componentSize === 1) {
        out[i] = view.getUint8(at);
      } else if (componentSize === 2) {
        out[i] = view.getUint16(at, true);
      } else {
        out[i] = view.getUint32(at, true);
      }
    } else if (base) {
      out[i] = base(i);
    } else {
      out[i] = 0;
    }
  }
  return out;
}

/**
 * 按索引集合读取 POSITION accessor 的 VEC3 FLOAT 元素。
 * indices 为 null 时读取全部 count 个元素。
 * 支持 bufferView/accessor 字节偏移、交错存储与稀疏覆盖；
 * 没有基础 bufferView 时未覆盖元素为零。
 */
export function readPositions(
  json: GltfDocument,
  bin: Uint8Array,
  accessorIndex: number,
  indices: Uint32Array | null,
  visit: (x: number, y: number, z: number) => void,
): void {
  const { accessor } = accessorInfo(json, accessorIndex);
  if (accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
    throw new Error(`POSITION accessor ${accessorIndex} must be FLOAT VEC3`);
  }
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  let elementOffset = 0;
  let stride = 12;
  let hasBase = false;
  if (accessor.bufferView !== undefined) {
    const { bufferView, start } = bufferViewRange(json, bin, accessor.bufferView);
    elementOffset = start + (accessor.byteOffset ?? 0);
    stride = bufferView.byteStride ?? 12;
    hasBase = true;
  }

  const sparse = sparseMap(json, bin, accessor);
  let sparseValuesOffset = 0;
  if (sparse) {
    const { start } = bufferViewRange(json, bin, accessor.sparse!.values.bufferView);
    sparseValuesOffset = start + (accessor.sparse!.values.byteOffset ?? 0);
  }

  const readElement = (elementIndex: number): void => {
    const override = sparse?.get(elementIndex);
    if (override !== undefined) {
      const at = sparseValuesOffset + override * 12;
      visit(view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true));
    } else if (hasBase) {
      const at = elementOffset + elementIndex * stride;
      visit(view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true));
    } else {
      visit(0, 0, 0);
    }
  };

  if (indices === null) {
    for (let i = 0; i < accessor.count; i++) {
      readElement(i);
    }
  } else {
    for (let i = 0; i < indices.length; i++) {
      readElement(indices[i]);
    }
  }
}

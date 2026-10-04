import { GltfAccessor, GltfDocument } from "./types";

export interface Vec3Reader {
  count: number;
  get(index: number): [number, number, number];
}

export interface ScalarReader {
  count: number;
  get(index: number): number;
}

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case UNSIGNED_BYTE:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case UNSIGNED_SHORT:
      return view.getUint16(offset, true);
    case UNSIGNED_INT:
      return view.getUint32(offset, true);
    case FLOAT:
      return view.getFloat32(offset, true);
    default:
      throw new Error(`unsupported componentType ${componentType}`);
  }
}

function accessorByteOffset(doc: GltfDocument, accessor: GltfAccessor): { base: number; stride: number } | null {
  if (accessor.bufferView === undefined) {
    return null;
  }
  const bv = doc.bufferViews[accessor.bufferView];
  const base = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const componentSize = COMPONENT_SIZE[accessor.componentType];
  const numComponents = accessor.type === "VEC3" ? 3 : accessor.type === "SCALAR" ? 1 : 0;
  if (numComponents === 0) {
    throw new Error(`unsupported accessor type ${accessor.type}`);
  }
  const stride = bv.byteStride ?? componentSize * numComponents;
  return { base, stride };
}

function readSparseIndexMap(
  view: DataView,
  doc: GltfDocument,
  accessor: GltfAccessor,
  componentsPerElement: number
): Map<number, number[]> | null {
  const sparse = accessor.sparse;
  if (sparse === undefined) {
    return null;
  }
  const indicesBv = doc.bufferViews[sparse.indices.bufferView];
  const indicesBase = (indicesBv.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0);
  const valuesBv = doc.bufferViews[sparse.values.bufferView];
  const valuesBase = (valuesBv.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
  const valueComponentSize = COMPONENT_SIZE[accessor.componentType];
  const valueStride = valueComponentSize * componentsPerElement;

  const map = new Map<number, number[]>();
  for (let i = 0; i < sparse.count; i++) {
    const elementIndex = readComponent(
      view,
      indicesBase + i * COMPONENT_SIZE[sparse.indices.componentType],
      sparse.indices.componentType
    );
    const values: number[] = [];
    for (let c = 0; c < componentsPerElement; c++) {
      values.push(
        readComponent(view, valuesBase + i * valueStride + c * valueComponentSize, accessor.componentType)
      );
    }
    map.set(elementIndex, values);
  }
  return map;
}

/** Random-access reader for a POSITION accessor (FLOAT VEC3), honoring
 *  bufferView/accessor byte offsets, interleaved strides and sparse overrides.
 *  Elements not backed by a base bufferView default to zero. */
export function readPositions(doc: GltfDocument, bin: Uint8Array, accessorIndex: number): Vec3Reader {
  const accessor = doc.accessors[accessorIndex];
  if (accessor.componentType !== FLOAT || accessor.type !== "VEC3") {
    throw new Error("POSITION accessor must be FLOAT VEC3");
  }
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const layout = accessorByteOffset(doc, accessor);
  const sparse = readSparseIndexMap(view, doc, accessor, 3);

  return {
    count: accessor.count,
    get(index: number): [number, number, number] {
      const overridden = sparse?.get(index);
      if (overridden !== undefined) {
        return [overridden[0], overridden[1], overridden[2]];
      }
      if (layout === null) {
        return [0, 0, 0];
      }
      const offset = layout.base + index * layout.stride;
      return [
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ];
    },
  };
}

/** Random-access reader for an index accessor (u8/u16/u32 SCALAR). */
export function readIndices(doc: GltfDocument, bin: Uint8Array, accessorIndex: number): ScalarReader {
  const accessor = doc.accessors[accessorIndex];
  if (
    accessor.componentType !== UNSIGNED_BYTE &&
    accessor.componentType !== UNSIGNED_SHORT &&
    accessor.componentType !== UNSIGNED_INT
  ) {
    throw new Error("index accessor must be UNSIGNED_BYTE/SHORT/INT");
  }
  if (accessor.type !== "SCALAR") {
    throw new Error("index accessor must be SCALAR");
  }
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const layout = accessorByteOffset(doc, accessor);
  const sparse = readSparseIndexMap(view, doc, accessor, 1);

  return {
    count: accessor.count,
    get(index: number): number {
      const overridden = sparse?.get(index);
      if (overridden !== undefined) {
        return overridden[0];
      }
      if (layout === null) {
        return 0;
      }
      return readComponent(
        view,
        layout.base + index * layout.stride,
        accessor.componentType
      );
    },
  };
}

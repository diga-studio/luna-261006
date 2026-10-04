/** 测试辅助：从 JSON 文档与 BIN 字节组装 GLB。 */

export function buildGlb(json: object, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = pad4(jsonBytes, 0x20);
  const binPadded = pad4(bin, 0);
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  view.setUint32(binHeader, binPadded.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // 'BIN\0'
  out.set(binPadded, binHeader + 8);
  return out;
}

function pad4(bytes: Uint8Array, padByte: number): Uint8Array {
  const rem = bytes.length % 4;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + 4 - rem);
  out.set(bytes);
  out.fill(padByte, bytes.length);
  return out;
}

/** 累积 BIN 字节的构建器，自动对齐到 4 字节。 */
export class BinBuilder {
  private chunks: Uint8Array[] = [];
  private size = 0;

  get length(): number {
    return this.size;
  }

  align(alignment = 4): void {
    const rem = this.size % alignment;
    if (rem !== 0) {
      this.push(new Uint8Array(alignment - rem));
    }
  }

  addFloat32Array(values: readonly number[] | Float32Array): number {
    this.align(4);
    const offset = this.size;
    const buf = new Uint8Array(values.length * 4);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < values.length; i++) {
      view.setFloat32(i * 4, values[i], true);
    }
    this.push(buf);
    return offset;
  }

  addUint16Array(values: readonly number[]): number {
    this.align(2);
    const offset = this.size;
    const buf = new Uint8Array(values.length * 2);
    const view = new DataView(buf.buffer);
    values.forEach((v, i) => view.setUint16(i * 2, v, true));
    this.push(buf);
    return offset;
  }

  addUint8Array(values: readonly number[]): number {
    const offset = this.size;
    this.push(Uint8Array.from(values));
    return offset;
  }

  addUint32Array(values: readonly number[]): number {
    this.align(4);
    const offset = this.size;
    const buf = new Uint8Array(values.length * 4);
    const view = new DataView(buf.buffer);
    values.forEach((v, i) => view.setUint32(i * 4, v, true));
    this.push(buf);
    return offset;
  }

  addBytes(bytes: Uint8Array): number {
    this.align(4);
    const offset = this.size;
    this.push(bytes);
    return offset;
  }

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** 近邻断言：绝对误差不超过 eps。 */
export function closeTo(actual: number, expected: number, eps = 1e-6): boolean {
  return Math.abs(actual - expected) <= eps;
}

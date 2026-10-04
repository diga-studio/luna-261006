export const OP_CODESEPARATOR = 0xab;

const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

/**
 * Decode instruction boundaries from the start of the script and report
 * whether `offset` is the position of an actual OP_CODESEPARATOR opcode.
 * Payload bytes equal to 0xab inside push-data are not opcodes.
 */
function isCodeSeparatorOpcode(script: Buffer, offset: number): boolean {
  let cursor = 0;
  while (cursor < script.length) {
    const opcode = script[cursor];
    let end: number;
    if (opcode >= 0x01 && opcode <= 0x4b) {
      end = cursor + 1 + opcode;
    } else if (opcode === OP_PUSHDATA1 || opcode === OP_PUSHDATA2 || opcode === OP_PUSHDATA4) {
      const width = opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : 4;
      if (cursor + 1 + width > script.length) {
        throw new Error("malformed script: truncated pushdata length");
      }
      const length =
        width === 1
          ? script.readUInt8(cursor + 1)
          : width === 2
            ? script.readUInt16LE(cursor + 1)
            : script.readUInt32LE(cursor + 1);
      end = cursor + 1 + width + length;
    } else {
      end = cursor + 1;
    }
    if (end > script.length) {
      throw new Error("malformed script: truncated push");
    }
    if (cursor === offset) {
      return opcode === OP_CODESEPARATOR;
    }
    cursor = end;
  }
  return false;
}

/**
 * Return the subscript committed by a signature: everything after the last
 * executed OP_CODESEPARATOR (or the whole script when the offset is null).
 * When `stripRemainingSeparators` is true (legacy mode), OP_CODESEPARATOR
 * opcodes remaining in the subscript are removed; push-data payload bytes
 * equal to 0xab are preserved in every mode. All other bytes are kept as-is.
 */
export function signatureSubscript(
  scriptCode: Buffer,
  lastCodeSeparatorOffset: number | null,
  stripRemainingSeparators: boolean,
): Buffer {
  let start = 0;
  if (lastCodeSeparatorOffset !== null) {
    if (
      !Number.isInteger(lastCodeSeparatorOffset) ||
      lastCodeSeparatorOffset < 0 ||
      !isCodeSeparatorOpcode(scriptCode, lastCodeSeparatorOffset)
    ) {
      throw new Error(
        "lastCodeSeparatorOffset does not point at an OP_CODESEPARATOR",
      );
    }
    start = lastCodeSeparatorOffset + 1;
  }

  const out: Buffer[] = [];
  let cursor = start;
  while (cursor < scriptCode.length) {
    const opcode = scriptCode[cursor];
    if (opcode >= 0x01 && opcode <= 0x4b) {
      const end = cursor + 1 + opcode;
      if (end > scriptCode.length) {
        throw new Error("malformed script: truncated push");
      }
      out.push(Buffer.from(scriptCode.subarray(cursor, end)));
      cursor = end;
      continue;
    }
    if (opcode === OP_PUSHDATA1 || opcode === OP_PUSHDATA2 || opcode === OP_PUSHDATA4) {
      const width = opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : 4;
      if (cursor + 1 + width > scriptCode.length) {
        throw new Error("malformed script: truncated pushdata length");
      }
      const length =
        width === 1
          ? scriptCode.readUInt8(cursor + 1)
          : width === 2
            ? scriptCode.readUInt16LE(cursor + 1)
            : scriptCode.readUInt32LE(cursor + 1);
      const end = cursor + 1 + width + length;
      if (end > scriptCode.length) {
        throw new Error("malformed script: truncated pushdata body");
      }
      out.push(Buffer.from(scriptCode.subarray(cursor, end)));
      cursor = end;
      continue;
    }
    if (opcode === OP_CODESEPARATOR && stripRemainingSeparators) {
      cursor += 1;
      continue;
    }
    out.push(Buffer.from(scriptCode.subarray(cursor, cursor + 1)));
    cursor += 1;
  }
  return Buffer.concat(out);
}

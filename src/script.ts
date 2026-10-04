const OP_CODESEPARATOR = 0xab;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

/** Byte length of the instruction starting at `i`, or throw if truncated. */
function instructionLength(script: Uint8Array, i: number): number {
  const opcode = script[i]!;
  let dataLen = 0;
  let lenBytes = 0;
  if (opcode >= 0x01 && opcode <= 0x4b) {
    dataLen = opcode;
  } else if (opcode === OP_PUSHDATA1) {
    lenBytes = 1;
  } else if (opcode === OP_PUSHDATA2) {
    lenBytes = 2;
  } else if (opcode === OP_PUSHDATA4) {
    lenBytes = 4;
  }
  if (lenBytes > 0) {
    if (i + 1 + lenBytes > script.length) {
      throw new Error("script decode error: truncated pushdata length");
    }
    for (let k = 0; k < lenBytes; k++) {
      dataLen |= script[i + 1 + k]! << (8 * k);
    }
  }
  const total = 1 + lenBytes + dataLen;
  if (i + total > script.length) {
    throw new Error("script decode error: truncated pushdata payload");
  }
  return total;
}

/**
 * Resolve where the committed subscript starts: right after the last
 * executed OP_CODESEPARATOR, or 0 when none was executed. The offset
 * must land exactly on an OP_CODESEPARATOR *instruction*; a 0xab byte
 * inside pushed data is not a separator and is rejected.
 */
function subscriptStart(
  scriptCode: Uint8Array,
  lastCodeSeparatorOffset: number | null
): number {
  if (lastCodeSeparatorOffset === null) {
    return 0;
  }
  if (lastCodeSeparatorOffset < 0 || lastCodeSeparatorOffset >= scriptCode.length) {
    throw new Error("lastCodeSeparatorOffset out of range");
  }
  let i = 0;
  while (i < scriptCode.length) {
    if (i === lastCodeSeparatorOffset) {
      if (scriptCode[i] !== OP_CODESEPARATOR) {
        throw new Error(
          "lastCodeSeparatorOffset does not point at an OP_CODESEPARATOR"
        );
      }
      return i + 1;
    }
    i += instructionLength(scriptCode, i);
  }
  throw new Error(
    "lastCodeSeparatorOffset points inside a pushdata instruction"
  );
}

/**
 * Return the subscript committed by a signature.
 *
 * The committed script starts right after the last executed
 * OP_CODESEPARATOR (or from the beginning when
 * `lastCodeSeparatorOffset` is null). In legacy mode all remaining
 * OP_CODESEPARATOR opcodes are removed; in bip143 mode they are kept.
 * Pushdata payload bytes equal to 0xab are data, not opcodes, and are
 * always preserved. The script must decode cleanly to its end.
 */
export function signatureSubscript(
  scriptCode: Uint8Array,
  lastCodeSeparatorOffset: number | null,
  mode: "legacy" | "bip143"
): Uint8Array {
  const start = subscriptStart(scriptCode, lastCodeSeparatorOffset);

  if (mode === "bip143") {
    // BIP143 commits to the script from the last separator onward,
    // keeping any later OP_CODESEPARATOR opcodes intact. Decode to
    // the end anyway so malformed scripts are rejected consistently.
    let i = start;
    while (i < scriptCode.length) {
      i += instructionLength(scriptCode, i);
    }
    return scriptCode.slice(start);
  }

  // Legacy: additionally strip every remaining OP_CODESEPARATOR opcode,
  // walking instruction by instruction so pushed data is never touched.
  const out: number[] = [];
  let i = start;
  while (i < scriptCode.length) {
    const len = instructionLength(scriptCode, i);
    if (scriptCode[i] !== OP_CODESEPARATOR) {
      for (let k = i; k < i + len; k++) {
        out.push(scriptCode[k]!);
      }
    }
    i += len;
  }
  return Uint8Array.from(out);
}

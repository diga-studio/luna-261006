import type { PdfDict, PdfValue } from "./types.ts";

/**
 * Serialize a parsed or constructed PDF object to source text.
 * Leaf values keep their original raw tokens, so untouched objects
 * round-trip byte-for-byte. Streams are handled by serializeStream.
 */
export function serializeValue(value: PdfValue): string {
  switch (value.kind) {
    case "null":
      return "null";
    case "bool":
      return value.value ? "true" : "false";
    case "num":
    case "name":
    case "str":
      return value.raw;
    case "ref":
      return `${value.obj} ${value.gen} R`;
    case "arr":
      return `[ ${value.items.map(serializeValue).join(" ")} ]`;
    case "dict":
      return serializeDict(value);
    case "stream":
      throw new Error("use serializeStream for stream objects");
  }
}

export function serializeDict(dict: PdfDict): string {
  const parts = dict.entries.map(
    ([key, value]) => `/${escapeName(key)} ${serializeValue(value)}`,
  );
  return `<< ${parts.join(" ")} >>`;
}

/** Re-escape a decoded dict key for serialization. */
function escapeName(key: string): string {
  let out = "";
  for (const ch of key) {
    const code = ch.codePointAt(0)!;
    if (code < 0x21 || code > 0x7e || "#()/<>[]{}%".includes(ch)) {
      out += "#" + code.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

/** Serialize a complete indirect stream object body (dict + data). */
export function serializeStream(dict: PdfDict, data: Uint8Array): Uint8Array {
  const head = serializeDict(dict) + "\nstream\n";
  const headBytes = new Uint8Array(head.length);
  for (let i = 0; i < head.length; i++) headBytes[i] = head.charCodeAt(i);
  const tail = new Uint8Array([0x0a, ...ascii("endstream")]);
  const out = new Uint8Array(headBytes.length + data.length + tail.length);
  out.set(headBytes, 0);
  out.set(data, headBytes.length);
  out.set(tail, headBytes.length + data.length);
  return out;
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

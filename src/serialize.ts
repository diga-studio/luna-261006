import type { PdfDict, PdfValue } from "./types.js";

const encoder = new TextEncoder();

/** Formats a number for PDF output: no exponent, no trailing zeros. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6);
  while (s.endsWith("0")) s = s.slice(0, -1);
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s === "-0") s = "0";
  return s;
}

function isRegularNameChar(code: number): boolean {
  // Printable ASCII except delimiters ()<>[]{}/% and whitespace and '#'
  if (code < 33 || code > 126) return false;
  return ![35, 37, 40, 41, 47, 60, 62, 91, 93, 123, 125].includes(code);
}

function serializeName(value: string): string {
  let out = "/";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code <= 255 && isRegularNameChar(code)) {
      out += ch;
    } else if (code <= 255) {
      out += "#" + code.toString(16).toUpperCase().padStart(2, "0");
    } else {
      for (const b of encoder.encode(ch)) {
        out += "#" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

function serializeString(bytes: Uint8Array): string {
  let out = "(";
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) {
      out += "\\" + String.fromCharCode(b);
    } else if (b >= 32 && b <= 126) {
      out += String.fromCharCode(b);
    } else {
      out += "\\" + b.toString(8).padStart(3, "0");
    }
  }
  return out + ")";
}

/** Serializes a PDF value (without stream data) to bytes. */
export function serializeValue(value: PdfValue): Uint8Array {
  return encoder.encode(serializeToString(value));
}

function serializeToString(value: PdfValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  switch (value.kind) {
    case "name":
      return serializeName(value.value);
    case "string":
      return serializeString(value.bytes);
    case "ref":
      return `${value.obj} ${value.gen} R`;
    case "array":
      return "[ " + value.items.map(serializeToString).join(" ") + " ]";
    case "dict":
      return (
        "<< " +
        value.entries.map(([k, v]) => `${serializeName(k)} ${serializeToString(v)}`).join(" ") +
        " >>"
      );
    case "stream":
      throw new Error("use serializeStream for stream values");
  }
}

/** Serializes a dictionary value. */
export function serializeDict(value: PdfDict): Uint8Array {
  return serializeValue(value);
}

/** Serializes a stream value including its data. */
export function serializeStream(dict: PdfDict, data: Uint8Array): Uint8Array {
  const head = serializeToString(dict);
  const out = new Uint8Array(head.length + 8 + data.length + 10);
  let pos = 0;
  const write = (s: string) => {
    for (let i = 0; i < s.length; i++) out[pos++] = s.charCodeAt(i);
  };
  write(head);
  write("\nstream\n");
  out.set(data, pos);
  pos += data.length;
  write("\nendstream");
  return out.subarray(0, pos);
}

import type { AmountInput } from "./types.ts";

/** Fixed decimal scale: amounts carry at most 4 decimal places. */
export const SCALE = 10000n;

const SCALE_DIGITS = 4;

/** Expands exponential notation (e.g. "1e-7") into plain decimal text. */
function expandExponential(text: string): string {
  const e = text.indexOf("e");
  if (e === -1) return text;
  const mantissa = text.slice(0, e);
  const exp = Number.parseInt(text.slice(e + 1), 10);
  const negative = mantissa.startsWith("-");
  const unsigned = mantissa.replace(/^[+-]/, "");
  const dot = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const intLength = dot === -1 ? digits.length : dot;
  const point = intLength + exp;
  let out: string;
  if (point <= 0) {
    out = "0." + "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    out = digits + "0".repeat(point - digits.length);
  } else {
    out = digits.slice(0, point) + "." + digits.slice(point);
  }
  return negative ? "-" + out : out;
}

/**
 * Parses an amount into exact scaled integer units (1 unit = 1e-4).
 * Accepts JSON numbers and decimal strings; rejects anything that cannot be
 * represented exactly with at most 4 decimal places.
 */
export function parseAmount(input: AmountInput): bigint {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`Invalid amount: ${input}`);
    }
    text = expandExponential(String(input));
  } else {
    text = expandExponential(input.trim());
  }
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`Invalid amount: ${input}`);
  }
  const frac = match[3] ?? "";
  if (frac.length > SCALE_DIGITS) {
    throw new Error(`Amount has more than ${SCALE_DIGITS} decimal places: ${input}`);
  }
  const intPart = match[2] === "" ? "0" : match[2];
  const scaled =
    BigInt(intPart) * SCALE + BigInt((frac + "0000").slice(0, SCALE_DIGITS));
  return match[1] === "-" ? -scaled : scaled;
}

/** Renders scaled units as a plain decimal string, trailing zeros trimmed. */
export function formatAmount(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / SCALE;
  const fracPart = abs % SCALE;
  const sign = negative ? "-" : "";
  if (fracPart === 0n) {
    return sign + intPart.toString();
  }
  const fracText = fracPart.toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${sign}${intPart.toString()}.${fracText}`;
}

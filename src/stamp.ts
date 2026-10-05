import { checkStamp, CheckedStamp } from "./check";
import { emitStamp } from "./emit";
import { StampError } from "./model";
import { parseXml } from "./xml";

/** Public stamp metadata returned by validateStamp. */
export interface StampInfo {
  /** Root width in px. */
  width: number;
  /** Root height in px. */
  height: number;
  /** Logical expanded node count (root and defs excluded). */
  nodes: number;
}

/** Maximum accepted input size in bytes (512 KiB). */
export const MAX_INPUT_BYTES = 512 * 1024;

interface ProcessedStamp {
  checked: CheckedStamp;
  svg: string;
}

/**
 * Shared pipeline so validateStamp and normalizeStamp accept and reject
 * exactly the same inputs. The normalized output is always produced (and
 * size-checked) even for validation, keeping the verdicts consistent.
 */
function processStamp(bytes: Uint8Array): ProcessedStamp {
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new StampError("input exceeds 512KiB");
  }
  const checked = checkStamp(parseXml(bytes));
  const svg = emitStamp(checked);
  return { checked, svg };
}

/**
 * Validate a stamp document and return its root dimensions and logical
 * expanded node count. Throws StampError on any rejection.
 */
export function validateStamp(bytes: Uint8Array): StampInfo {
  const { checked } = processStamp(bytes);
  return { width: checked.width, height: checked.height, nodes: checked.nodes };
}

/**
 * Validate and normalize a stamp document into a standalone SVG string
 * without use/defs/id or reference attributes. Throws StampError on any
 * rejection; accepts exactly the same inputs as validateStamp.
 */
export function normalizeStamp(bytes: Uint8Array): string {
  return processStamp(bytes).svg;
}

export { StampError };

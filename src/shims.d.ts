// Minimal timer declarations so the library builds without @types/node.
declare function setTimeout(
  callback: (...args: never[]) => void,
  ms?: number
): unknown;
declare function clearTimeout(handle: unknown): void;

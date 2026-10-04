/**
 * Advance widths of the standard Helvetica font (AFM), in 1/1000 text
 * units, indexed by ASCII code minus 32 (printable range 32..126).
 */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

/** Width of a printable-ASCII string in Helvetica, in 1/1000 text units. */
export function helveticaWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const w = HELVETICA_WIDTHS[code - 32];
    if (w === undefined) throw new Error(`label contains non-printable-ASCII character: ${code}`);
    width += w;
  }
  return width;
}

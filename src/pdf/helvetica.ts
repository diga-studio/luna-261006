/**
 * Advance widths of the standard 14 Helvetica font (WinAnsiEncoding),
 * in 1/1000 text space units, for printable ASCII (0x20-0x7E).
 * Values are from the Adobe Helvetica AFM metrics.
 */
const WIDTHS: readonly number[] = [
  278, // space
  278, // !
  355, // "
  556, // #
  556, // $
  889, // %
  667, // &
  191, // '
  333, // (
  333, // )
  389, // *
  584, // +
  278, // ,
  333, // -
  278, // .
  278, // /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
  278, // :
  278, // ;
  584, // <
  584, // =
  584, // >
  556, // ?
  1015, // @
  667, // A
  667, // B
  722, // C
  722, // D
  667, // E
  611, // F
  778, // G
  722, // H
  278, // I
  500, // J
  667, // K
  556, // L
  833, // M
  722, // N
  778, // O
  667, // P
  778, // Q
  722, // R
  667, // S
  611, // T
  722, // U
  667, // V
  944, // W
  667, // X
  667, // Y
  611, // Z
  278, // [
  278, // backslash
  278, // ]
  469, // ^
  556, // _
  333, // `
  556, // a
  556, // b
  500, // c
  556, // d
  556, // e
  278, // f
  556, // g
  556, // h
  222, // i
  222, // j
  500, // k
  222, // l
  833, // m
  556, // n
  556, // o
  556, // p
  556, // q
  333, // r
  500, // s
  278, // t
  556, // u
  500, // v
  722, // w
  500, // x
  500, // y
  500, // z
  334, // {
  260, // |
  334, // }
  584, // ~
];

/** Width of one character in 1/1000 em; defaults to 556 for unknown codes. */
export function helveticaCharWidth(code: number): number {
  if (code >= 0x20 && code <= 0x7e) return WIDTHS[code - 0x20]!;
  return 556;
}

/** Width of text in points at the given font size. */
export function helveticaWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += helveticaCharWidth(ch.codePointAt(0)!);
  return (total * fontSize) / 1000;
}

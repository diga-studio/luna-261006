/** A redaction region on one page, in "view coordinates":
 *  origin at the top-left of the rotated, visible page (CropBox),
 *  x to the right, y downward, unit = pt. `page` is a 0-based page index. */
export interface Region {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A 2D point in view coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** One glyph hit: the page and the transformed quad of the glyph's
 *  hit box (corners in view coordinates). */
export interface GlyphHit {
  page: number;
  quad: [Point, Point, Point, Point];
}

/** A 2D affine matrix [a b c d e f] mapping (x,y) -> (a*x+c*y+e, b*x+d*y+f). */
export type Matrix = [number, number, number, number, number, number];

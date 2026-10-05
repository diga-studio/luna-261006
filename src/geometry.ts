/** Axis-aligned rectangle in visible page coordinates (origin top-left, y down). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convex quadrilateral as four [x, y] points in visible page coordinates. */
export type Quad = [number, number][];

type Pt = [number, number];

function clipEdge(poly: Pt[], inside: (p: Pt) => boolean, intersect: (a: Pt, b: Pt) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

function polygonArea(poly: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Area of the intersection between a convex quad and an axis-aligned rect.
 *  Returns exactly 0 when they only touch along an edge or vertex. */
export function quadRectIntersectionArea(quad: Quad, rect: Rect): number {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  let poly = quad.map((p) => [p[0], p[1]] as Pt);
  // clip against the four half-planes of the rect (Sutherland-Hodgman)
  poly = clipEdge(poly, (p) => p[0] >= x0, (a, b) => {
    const t = (x0 - a[0]) / (b[0] - a[0]);
    return [x0, a[1] + t * (b[1] - a[1])];
  });
  poly = clipEdge(poly, (p) => p[0] <= x1, (a, b) => {
    const t = (x1 - a[0]) / (b[0] - a[0]);
    return [x1, a[1] + t * (b[1] - a[1])];
  });
  poly = clipEdge(poly, (p) => p[1] >= y0, (a, b) => {
    const t = (y0 - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), y0];
  });
  poly = clipEdge(poly, (p) => p[1] <= y1, (a, b) => {
    const t = (y1 - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), y1];
  });
  if (poly.length < 3) return 0;
  return polygonArea(poly);
}

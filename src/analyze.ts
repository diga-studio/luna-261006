/** Hit testing: intersect glyph quads with regions (area > 0 => hit). */
import { GlyphInstance } from './walker';
import { Point, Region } from './types';

/** Clip a convex polygon against one half-plane (keeps the inside). */
function clip(poly: Point[], inside: (p: Point) => boolean, intersect: (a: Point, b: Point) => Point): Point[] {
  const out: Point[] = [];
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

function polygonArea(poly: Point[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

const EPS = 1e-9;

export function quadIntersectsRegion(quad: Point[], region: Region): boolean {
  const x0 = region.x;
  const y0 = region.y;
  const x1 = region.x + region.width;
  const y1 = region.y + region.height;
  let poly = quad.map((p) => ({ ...p }));
  // left edge x >= x0
  poly = clip(poly, (p) => p.x >= x0, (a, b) => {
    const t = (x0 - a.x) / (b.x - a.x);
    return { x: x0, y: a.y + t * (b.y - a.y) };
  });
  // right edge x <= x1
  poly = clip(poly, (p) => p.x <= x1, (a, b) => {
    const t = (x1 - a.x) / (b.x - a.x);
    return { x: x1, y: a.y + t * (b.y - a.y) };
  });
  // top edge y >= y0
  poly = clip(poly, (p) => p.y >= y0, (a, b) => {
    const t = (y0 - a.y) / (b.y - a.y);
    return { x: a.x + t * (b.x - a.x), y: y0 };
  });
  // bottom edge y <= y1
  poly = clip(poly, (p) => p.y <= y1, (a, b) => {
    const t = (y1 - a.y) / (b.y - a.y);
    return { x: a.x + t * (b.x - a.x), y: y1 };
  });
  if (poly.length < 3) return false;
  return polygonArea(poly) > EPS;
}

export function findHits(glyphs: GlyphInstance[], regions: Region[]): GlyphInstance[] {
  const byPage = new Map<number, Region[]>();
  for (const r of regions) {
    const list = byPage.get(r.page) ?? [];
    list.push(r);
    byPage.set(r.page, list);
  }
  const hits: GlyphInstance[] = [];
  for (const glyph of glyphs) {
    const pageRegions = byPage.get(glyph.page);
    if (!pageRegions) continue;
    for (const region of pageRegions) {
      if (quadIntersectsRegion(glyph.quad, region)) {
        hits.push(glyph);
        break; // one glyph counts once no matter how many regions cover it
      }
    }
  }
  return hits;
}

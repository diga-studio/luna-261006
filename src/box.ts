import type { Ipv4Interval } from "./cidr";

export interface Box {
  src: Ipv4Interval;
  dst: Ipv4Interval;
  port: Ipv4Interval;
}

function intersectInterval(
  a: Ipv4Interval,
  b: Ipv4Interval
): Ipv4Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start <= end ? { start, end } : null;
}

export function intersectBoxes(a: Box, b: Box): Box | null {
  const src = intersectInterval(a.src, b.src);
  const dst = intersectInterval(a.dst, b.dst);
  const port = intersectInterval(a.port, b.port);
  if (src === null || dst === null || port === null) {
    return null;
  }
  return { src, dst, port };
}

export function subtractBox(a: Box, b: Box): Box[] {
  const inner = intersectBoxes(a, b);
  if (inner === null) {
    return [a];
  }
  const rest: Box[] = [];
  if (inner.src.start > a.src.start) {
    rest.push({
      src: { start: a.src.start, end: inner.src.start - 1 },
      dst: a.dst,
      port: a.port,
    });
  }
  if (inner.src.end < a.src.end) {
    rest.push({
      src: { start: inner.src.end + 1, end: a.src.end },
      dst: a.dst,
      port: a.port,
    });
  }
  if (inner.dst.start > a.dst.start) {
    rest.push({
      src: inner.src,
      dst: { start: a.dst.start, end: inner.dst.start - 1 },
      port: a.port,
    });
  }
  if (inner.dst.end < a.dst.end) {
    rest.push({
      src: inner.src,
      dst: { start: inner.dst.end + 1, end: a.dst.end },
      port: a.port,
    });
  }
  if (inner.port.start > a.port.start) {
    rest.push({
      src: inner.src,
      dst: inner.dst,
      port: { start: a.port.start, end: inner.port.start - 1 },
    });
  }
  if (inner.port.end < a.port.end) {
    rest.push({
      src: inner.src,
      dst: inner.dst,
      port: { start: inner.port.end + 1, end: a.port.end },
    });
  }
  return rest;
}

export function subtractBoxes(a: Box, bs: Box[]): Box[] {
  let remaining: Box[] = [a];
  for (const b of bs) {
    remaining = remaining.flatMap((box) => subtractBox(box, b));
    if (remaining.length === 0) {
      break;
    }
  }
  return remaining;
}

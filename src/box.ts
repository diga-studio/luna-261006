import type { Protocol } from "./types.js";
import type { AddrRange } from "./cidr.js";

/** 五维规则空间中的一个盒子：源地址 × 目的地址 × 协议集合 × 端口区间。 */
export interface Box {
  src: AddrRange;
  dst: AddrRange;
  /** 命中的协议子集（"TCP"/"UDP" 的非空子集）。 */
  protocols: readonly Protocol[];
  portLo: number;
  portHi: number;
}

function intersectRange(a: AddrRange, b: AddrRange): AddrRange | null {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  return lo <= hi ? { lo, hi } : null;
}

/** 两个盒子的交集，不相交返回 null。 */
export function intersectBoxes(a: Box, b: Box): Box | null {
  const src = intersectRange(a.src, b.src);
  const dst = intersectRange(a.dst, b.dst);
  const protocols = a.protocols.filter((p) => b.protocols.includes(p));
  const portLo = Math.max(a.portLo, b.portLo);
  const portHi = Math.min(a.portHi, b.portHi);
  if (!src || !dst || protocols.length === 0 || portLo > portHi) {
    return null;
  }
  return { src, dst, protocols, portLo, portHi };
}

/** box 减去单个 other，返回互不相交的非空盒子列表。 */
function subtractOne(box: Box, other: Box): Box[] {
  const cut = intersectBoxes(box, other);
  if (!cut) {
    return [box];
  }
  const result: Box[] = [];
  // 剩余部分 = box 中沿某一维落在 cut 之外的“板条”，逐维剥离。
  let rest: Box = box;
  if (rest.src.lo < cut.src.lo) {
    result.push({ ...rest, src: { lo: rest.src.lo, hi: cut.src.lo - 1 } });
  }
  if (cut.src.hi < rest.src.hi) {
    result.push({ ...rest, src: { lo: cut.src.hi + 1, hi: rest.src.hi } });
  }
  rest = { ...rest, src: cut.src };
  if (rest.dst.lo < cut.dst.lo) {
    result.push({ ...rest, dst: { lo: rest.dst.lo, hi: cut.dst.lo - 1 } });
  }
  if (cut.dst.hi < rest.dst.hi) {
    result.push({ ...rest, dst: { lo: cut.dst.hi + 1, hi: rest.dst.hi } });
  }
  rest = { ...rest, dst: cut.dst };
  const extraProtocols = rest.protocols.filter(
    (p) => !cut.protocols.includes(p),
  );
  if (extraProtocols.length > 0) {
    result.push({ ...rest, protocols: extraProtocols });
  }
  rest = { ...rest, protocols: cut.protocols };
  if (rest.portLo < cut.portLo) {
    result.push({ ...rest, portHi: cut.portLo - 1 });
  }
  if (cut.portHi < rest.portHi) {
    result.push({ ...rest, portLo: cut.portHi + 1 });
  }
  return result;
}

/** 计算 box 减去 others 的并集后剩余的非空盒子列表（互不相交）。 */
export function subtractBoxes(box: Box, others: readonly Box[]): Box[] {
  let remaining: Box[] = [box];
  for (const other of others) {
    remaining = remaining.flatMap((b) => subtractOne(b, other));
    if (remaining.length === 0) {
      break;
    }
  }
  return remaining;
}

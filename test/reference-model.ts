import { HistoryRecord, Range } from '../src/types';

/**
 * 测试中独立实现的逐单位参考模型：
 * 直接展开每个批次的每一个单位，按定义模拟传播，直到不动点。
 * 只用于小数量随机历史的对照验证。
 */
export function referenceRecall(
  records: HistoryRecord[],
  sourceIds: string[],
): Map<string, Range[]> {
  const qty = new Map<string, number>();
  for (const rec of records) {
    if (rec.kind === 'intake') qty.set(rec.id, rec.qty);
    else if (rec.kind === 'repack')
      qty.set(rec.id, rec.inputs.reduce((a, r) => a + (r.end - r.start), 0));
    else qty.set(rec.id, rec.qty);
  }

  const contaminated = new Map<string, Set<number>>();
  const get = (id: string): Set<number> => {
    let s = contaminated.get(id);
    if (!s) {
      s = new Set();
      contaminated.set(id, s);
    }
    return s;
  };

  for (const id of sourceIds) {
    const q = qty.get(id);
    if (q === undefined) throw new Error(`unknown source: ${id}`);
    const s = get(id);
    for (let u = 0; u < q; u++) s.add(u);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const rec of records) {
      if (rec.kind === 'intake') continue;
      const target = get(rec.id);
      if (rec.kind === 'repack') {
        let offset = 0;
        for (const inp of rec.inputs) {
          const parentSet = contaminated.get(inp.parent);
          if (parentSet) {
            for (let u = inp.start; u < inp.end; u++) {
              if (parentSet.has(u)) {
                const v = offset + (u - inp.start);
                if (!target.has(v)) {
                  target.add(v);
                  changed = true;
                }
              }
            }
          }
          offset += inp.end - inp.start;
        }
      } else {
        let tainted = false;
        for (const inp of rec.inputs) {
          const parentSet = contaminated.get(inp.parent);
          if (!parentSet) continue;
          for (let u = inp.start; u < inp.end; u++) {
            if (parentSet.has(u)) {
              tainted = true;
              break;
            }
          }
          if (tainted) break;
        }
        if (tainted) {
          const q = qty.get(rec.id)!;
          for (let u = 0; u < q; u++) {
            if (!target.has(u)) {
              target.add(u);
              changed = true;
            }
          }
        }
      }
    }
  }

  const result = new Map<string, Range[]>();
  for (const [id, units] of contaminated) {
    if (units.size === 0) {
      if (sourceIds.includes(id)) result.set(id, []);
      continue;
    }
    const sorted = [...units].sort((a, b) => a - b);
    const ranges: Range[] = [];
    let s = sorted[0]!;
    let prev = s;
    for (let i = 1; i < sorted.length; i++) {
      const u = sorted[i]!;
      if (u === prev + 1) {
        prev = u;
      } else {
        ranges.push({ start: s, end: prev + 1 });
        s = u;
        prev = u;
      }
    }
    ranges.push({ start: s, end: prev + 1 });
    result.set(id, ranges);
  }
  return result;
}

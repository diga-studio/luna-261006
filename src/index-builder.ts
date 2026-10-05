import type { HistoryRecord } from './types.js';

/** 父批次被某条记录取用的一段区间引用。 */
export interface UsageRef {
  readonly pStart: number;
  readonly pEnd: number;
  readonly childId: string;
  /** 仅 repack 有效：该段在子批次中的起始位置。 */
  readonly childStart: number;
  /** true 表示混料：重叠即整批受污染。 */
  readonly isMix: boolean;
}

export interface BatchInfo {
  readonly id: string;
  readonly quantity: number;
  /** 拓扑序号：父批次严格小于子批次。 */
  readonly rank: number;
  /** 按 pStart 升序、互不重叠的取用引用。 */
  readonly usages: readonly UsageRef[];
}

/** 可重复查询的召回索引（构建后不可变）。 */
export interface RecallIndex {
  readonly batches: ReadonlyMap<string, BatchInfo>;
}

/**
 * 接收全部历史记录（不要求按依赖顺序），构建可重复查询的索引。
 * 资源消耗只与记录数/引用数相关，与批次实物数量无关。
 */
export function buildIndex(records: readonly HistoryRecord[]): RecallIndex {
  // 拓扑序号：rank = 1 + max(父批次 rank)，原始入库为 0。
  // Kahn 算法按剩余依赖数推进，O(记录数 + 引用数)，无递归。
  const indegree = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  for (const rec of records) {
    if (rec.kind === 'receipt') {
      indegree.set(rec.batchId, 0);
      continue;
    }
    const seen = new Set<string>();
    for (const input of rec.inputs) {
      if (seen.has(input.parentId)) continue;
      seen.add(input.parentId);
      indegree.set(rec.batchId, (indegree.get(rec.batchId) ?? 0) + 1);
      let kids = childrenOf.get(input.parentId);
      if (kids === undefined) {
        kids = [];
        childrenOf.set(input.parentId, kids);
      }
      kids.push(rec.batchId);
    }
  }
  const ranks = new Map<string, number>();
  const queue: string[] = [];
  for (const rec of records) {
    if ((indegree.get(rec.batchId) ?? 0) === 0) {
      ranks.set(rec.batchId, 0);
      queue.push(rec.batchId);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const rank = ranks.get(id)!;
    for (const childId of childrenOf.get(id) ?? []) {
      if (rank + 1 > (ranks.get(childId) ?? 0)) ranks.set(childId, rank + 1);
      const remaining = indegree.get(childId)! - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) queue.push(childId);
    }
  }

  // 汇总每个父批次被取用的区间引用。
  const usageMap = new Map<string, UsageRef[]>();
  const quantities = new Map<string, number>();
  for (const rec of records) {
    if (rec.kind === 'receipt') {
      quantities.set(rec.batchId, rec.quantity);
      continue;
    }
    let childStart = 0;
    for (const input of rec.inputs) {
      const len = input.end - input.start;
      let list = usageMap.get(input.parentId);
      if (list === undefined) {
        list = [];
        usageMap.set(input.parentId, list);
      }
      list.push({
        pStart: input.start,
        pEnd: input.end,
        childId: rec.batchId,
        childStart,
        isMix: rec.kind === 'mix',
      });
      childStart += len;
    }
    if (rec.kind === 'mix') {
      quantities.set(rec.batchId, rec.quantity);
    } else {
      quantities.set(rec.batchId, childStart);
    }
  }

  const batches = new Map<string, BatchInfo>();
  for (const rec of records) {
    const id = rec.batchId;
    const usages = (usageMap.get(id) ?? []).slice().sort(
      (a, b) => a.pStart - b.pStart || a.pEnd - b.pEnd,
    );
    batches.set(id, {
      id,
      quantity: quantities.get(id)!,
      rank: ranks.get(id)!,
      usages,
    });
  }

  return { batches };
}

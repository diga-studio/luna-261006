export const MAX_DEPTH = 12;
export const REVIEW_THRESHOLD_CENTS = 2500_00;

export function ratePercentForLevel(level: number): number {
  if (level === 1) return 5;
  if (level === 2) return 3;
  if (level >= 3 && level <= 5) return 2;
  if (level >= 6 && level <= MAX_DEPTH) return 1;
  return 0;
}

export function computeCommissionCents(
  memberId: string,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  pvOf: ReadonlyMap<string, number>,
): number {
  let cents = 0;
  const stack: Array<{ id: string; depth: number }> = [];
  const direct = childrenOf.get(memberId);
  if (direct) {
    for (const child of direct) stack.push({ id: child, depth: 1 });
  }
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    const rate = ratePercentForLevel(depth);
    if (rate === 0) continue;
    cents += (pvOf.get(id) ?? 0) * rate;
    if (depth < MAX_DEPTH) {
      const next = childrenOf.get(id);
      if (next) {
        for (const child of next) stack.push({ id: child, depth: depth + 1 });
      }
    }
  }
  return cents;
}

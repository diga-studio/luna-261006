export interface FrozenInput {
  sponsors: Map<string, string | null>;
  pv: Map<string, number>;
}

function rateFor(depth: number): number {
  if (depth === 1) return 5;
  if (depth === 2) return 3;
  if (depth <= 5) return 2;
  if (depth <= 12) return 1;
  return 0;
}

export function referenceCommissions(input: FrozenInput): Map<string, number> {
  const cents = new Map<string, number>();
  for (const id of input.sponsors.keys()) cents.set(id, 0);
  for (const [id, pv] of input.pv) {
    let ancestor = input.sponsors.get(id) ?? null;
    let depth = 1;
    while (ancestor !== null && depth <= 12) {
      cents.set(ancestor, (cents.get(ancestor) ?? 0) + pv * rateFor(depth));
      ancestor = input.sponsors.get(ancestor) ?? null;
      depth += 1;
    }
  }
  return cents;
}

export function tempDbPath(name: string): string {
  const dir = `${process.cwd()}/.tmp-test-dbs`;
  return `${dir}/${name}-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
}

import assert from 'node:assert/strict';
import type { Ref, Snapshot } from '../src/index.ts';

export function refKey(ref: Ref): string {
  return `${ref.from}|${ref.to}`;
}

export function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

export function refSetOf(refs: Ref[]): Set<string> {
  return new Set(refs.map(refKey));
}

/** Assert the snapshot is internally consistent: order is a permutation of
 * allIds and every reference's `to` precedes its `from`. */
export function assertValidSnapshot(
  snap: Snapshot,
  allIds: string[],
): void {
  assert.equal(snap.order.length, allIds.length, 'order covers all rules');
  assert.deepEqual(
    [...snap.order].sort(),
    [...allIds].sort(),
    'order is a permutation of all rules',
  );
  const pos = new Map<string, number>();
  snap.order.forEach((id, i) => pos.set(id, i));
  for (const ref of snap.refs) {
    assert.ok(
      pos.get(ref.to)! < pos.get(ref.from)!,
      `order violates ref ${ref.from} depends on ${ref.to}`,
    );
  }
}

/** Assert two snapshots are exactly identical (ref set and order sequence).
 * Used to verify rejection leaves state untouched. */
export function assertSameSnapshot(a: Snapshot, b: Snapshot): void {
  assert.deepEqual(a.order, b.order, 'execution order changed');
  assert.deepEqual(refSetOf(a.refs), refSetOf(b.refs), 'ref set changed');
  assert.equal(a.refs.length, b.refs.length, 'ref count changed');
}

/** Assert the cycle witness is valid for the given candidate ref set:
 * first === last, and every adjacent pair (a, b) is a ref a depends on b
 * in the candidate set. */
export function assertValidWitness(
  cycle: string[],
  candidateRefs: Set<string>,
): void {
  assert.ok(cycle.length >= 2, 'witness has at least 2 entries');
  assert.equal(cycle[0], cycle[cycle.length - 1], 'witness must be closed');
  for (let i = 0; i + 1 < cycle.length; i++) {
    const key = pairKey(cycle[i]!, cycle[i + 1]!);
    assert.ok(
      candidateRefs.has(key),
      `witness edge ${cycle[i]} -> ${cycle[i + 1]} not in candidate graph`,
    );
  }
}

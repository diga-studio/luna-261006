import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CENTS_PER_PV_BY_DEPTH, MAX_DEPTH } from "../src/types";

let counter = 0;

export function tempDbPath(): string {
  counter += 1;
  return join(
    tmpdir(),
    `commission-test-${process.pid}-${Date.now()}-${counter}.sqlite`
  );
}

export function cleanupDb(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-journal`, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

export interface MemberInput {
  id: string;
  sponsor: string | null;
}

/**
 * Independent reference implementation: for every PV holder, walk UP the
 * sponsor chain (at most MAX_DEPTH edges) and credit each ancestor.
 * Returns memberId -> commission cents.
 */
export function referenceCommissions(
  members: MemberInput[],
  pv: ReadonlyMap<string, number>
): Map<string, number> {
  const sponsorOf = new Map<string, string | null>();
  for (const m of members) {
    sponsorOf.set(m.id, m.sponsor);
  }
  const result = new Map<string, number>();
  for (const m of members) {
    result.set(m.id, 0);
  }
  for (const m of members) {
    const pvValue = pv.get(m.id) ?? 0;
    if (pvValue === 0) {
      continue;
    }
    let current = m.sponsor;
    let depth = 1;
    while (current !== null && depth <= MAX_DEPTH && sponsorOf.has(current)) {
      result.set(
        current,
        (result.get(current) ?? 0) + pvValue * CENTS_PER_PV_BY_DEPTH[depth]
      );
      current = sponsorOf.get(current) ?? null;
      depth += 1;
    }
  }
  return result;
}

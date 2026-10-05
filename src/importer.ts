import { levenshtein } from "./levenshtein.js";

export interface ExistingRecord {
  id: number;
  name: string;
}

export type ImportRowResult =
  | { kind: "inserted"; id: number; name: string }
  | { kind: "duplicate"; id: number; name: string; distance: number };

export interface Importer {
  importBatch(names: string[]): ImportRowResult[];
}

/** Maximum edit distance that still counts as a duplicate. */
export const MAX_DISTANCE = 3;

export function createImporter(existing: ExistingRecord[]): Importer {
  const records: ExistingRecord[] = [];
  const seenIds = new Set<number>();
  let maxId = 0;

  for (const record of existing) {
    if (!Number.isInteger(record.id) || record.id <= 0) {
      throw new Error(`id must be a positive integer, got ${record.id}`);
    }
    if (seenIds.has(record.id)) {
      throw new Error(`duplicate id ${record.id}`);
    }
    if (typeof record.name !== "string" || record.name.length === 0) {
      throw new Error("name must be a non-empty string");
    }
    seenIds.add(record.id);
    records.push({ id: record.id, name: record.name });
    if (record.id > maxId) maxId = record.id;
  }

  function findNearest(name: string): { id: number; distance: number } | null {
    let bestId = -1;
    let bestDistance = Infinity;
    for (const record of records) {
      const distance = levenshtein(name, record.name);
      if (distance < bestDistance || (distance === bestDistance && record.id < bestId)) {
        bestDistance = distance;
        bestId = record.id;
      }
    }
    return bestDistance <= MAX_DISTANCE ? { id: bestId, distance: bestDistance } : null;
  }

  return {
    importBatch(names: string[]): ImportRowResult[] {
      const results: ImportRowResult[] = [];
      for (const name of names) {
        const nearest = findNearest(name);
        if (nearest !== null) {
          results.push({ kind: "duplicate", id: nearest.id, name, distance: nearest.distance });
          continue;
        }
        maxId += 1;
        records.push({ id: maxId, name });
        results.push({ kind: "inserted", id: maxId, name });
      }
      return results;
    },
  };
}

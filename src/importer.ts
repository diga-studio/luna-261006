import { levenshteinWithin } from "./levenshtein.js";

export interface ExistingRecord {
  id: number;
  name: string;
}

export interface ImportAdded {
  kind: "added";
  id: number;
  name: string;
}

export interface ImportDuplicate {
  kind: "duplicate";
  name: string;
  matchedId: number;
  distance: number;
}

export type ImportRowResult = ImportAdded | ImportDuplicate;

export interface Importer {
  importBatch(names: string[]): ImportRowResult[];
}

export const MAX_DISTANCE = 3;

export function createImporter(existing: ExistingRecord[]): Importer {
  const records: ExistingRecord[] = [];
  const seenIds = new Set<number>();
  let maxId = 0;
  for (const record of existing) {
    if (!Number.isInteger(record.id) || record.id <= 0) {
      throw new Error(`invalid id: ${record.id}`);
    }
    if (seenIds.has(record.id)) {
      throw new Error(`duplicate id: ${record.id}`);
    }
    seenIds.add(record.id);
    records.push({ id: record.id, name: record.name });
    if (record.id > maxId) {
      maxId = record.id;
    }
  }

  return {
    importBatch(names: string[]): ImportRowResult[] {
      const results: ImportRowResult[] = [];
      for (const name of names) {
        let bestId = -1;
        let bestDistance = MAX_DISTANCE + 1;
        for (const record of records) {
          const distance = levenshteinWithin(name, record.name, MAX_DISTANCE);
          if (distance > MAX_DISTANCE) {
            continue;
          }
          if (distance < bestDistance || (distance === bestDistance && record.id < bestId)) {
            bestDistance = distance;
            bestId = record.id;
          }
        }
        if (bestId >= 0) {
          results.push({ kind: "duplicate", name, matchedId: bestId, distance: bestDistance });
        } else {
          maxId += 1;
          records.push({ id: maxId, name });
          results.push({ kind: "added", id: maxId, name });
        }
      }
      return results;
    },
  };
}

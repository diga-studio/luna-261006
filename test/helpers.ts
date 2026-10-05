import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doc } from '../src/index';

export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fts5-doc-index-'));
  return {
    path: join(dir, 'index.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Reference model: whole-word, case-insensitive match over the given fields. */
export function modelSearch(
  docs: Map<string, Doc>,
  fields: string[],
  term: string
): string[] {
  const hits: string[] = [];
  for (const [id, doc] of docs) {
    for (const f of fields) {
      const value = doc[f];
      if (value === undefined) continue;
      const words = value.toLowerCase().split(/\s+/);
      if (words.indexOf(term) !== -1) {
        hits.push(id);
        break;
      }
    }
  }
  return hits.sort();
}

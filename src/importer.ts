import * as fs from "node:fs";
import * as path from "node:path";
import { CsvParser } from "./csv.js";
import { ImportDb, type TaskRow } from "./db.js";
import type {
  AdvanceResult,
  CaseRecord,
  ImporterOptions,
  InspectResult,
  RowResult,
  TestHooks,
} from "./types.js";

const BATCH_SIZE = 128;
const CHUNK_SIZE = 64 * 1024;

const VALID_CATEGORIES = new Set([
  "harassment",
  "discrimination",
  "safety violation",
  "fraud",
  "retaliation",
  "other",
]);

interface PendingRow {
  recordNo: number;
  ok: boolean;
  externalId: string | null;
  category: string;
  description: string;
  error: string | null;
}

export class HrImporter {
  private store: ImportDb;
  private hooks: TestHooks;

  constructor(dbPath: string, options?: ImporterOptions) {
    this.store = new ImportDb(dbPath);
    this.hooks = options?.hooks ?? {};
  }

  createImport(csvPath: string): number {
    const abs = path.resolve(csvPath);
    const stmt = this.store.db.prepare("INSERT INTO tasks (path) VALUES (?)");
    const info = stmt.run(abs);
    return Number(info.lastInsertRowid);
  }

  advanceImport(id: number): AdvanceResult {
    const task = this.getTask(id);
    if (task.status === "done") {
      return {
        done: true,
        processed: 0,
        totalProcessed: task.processed,
        succeeded: task.succeeded,
        failed: task.failed,
      };
    }

    const want = (task.header_done === 1 ? 0 : 1) + BATCH_SIZE;
    const parser = new CsvParser();
    const rawFields: string[][] = [];
    let consumed = 0;
    let exhausted = false;

    const fd = fs.openSync(task.path, "r");
    try {
      const fileSize = fs.fstatSync(fd).size;
      let pos = task.read_offset;
      let eofSet = false;
      const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
      while (rawFields.length < want) {
        const rec = parser.nextRecord();
        if (rec !== null) {
          rawFields.push(rec.fields);
          consumed += rec.bytesConsumed;
          continue;
        }
        if (pos < fileSize) {
          const n = fs.readSync(fd, chunk, 0, CHUNK_SIZE, pos);
          if (n === 0) {
            parser.setEof();
            eofSet = true;
            continue;
          }
          this.hooks.onRead?.(pos, n);
          parser.feed(chunk.subarray(0, n));
          pos += n;
        } else if (!eofSet) {
          parser.setEof();
          eofSet = true;
        } else {
          exhausted = true;
          break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    let headerDone = task.header_done === 1;
    let idx = 0;
    if (!headerDone && rawFields.length > 0) {
      idx = 1;
      headerDone = true;
    }

    const rows: PendingRow[] = [];
    let recordNo = task.next_record_no;
    for (; idx < rawFields.length; idx++) {
      const fields = rawFields[idx];
      const externalId = fields.length > 0 ? fields[0] : "";
      const category = fields.length > 1 ? fields[1] : "";
      const description = fields.length > 2 ? fields[2] : "";
      let ok = true;
      let error: string | null = null;
      if (externalId === "") {
        ok = false;
        error = "empty external_id";
      } else if (!VALID_CATEGORIES.has(category)) {
        ok = false;
        error = "invalid category";
      }
      rows.push({
        recordNo: recordNo++,
        ok,
        externalId: ok ? externalId : externalId || null,
        category,
        description,
        error,
      });
    }

    const done = exhausted;
    const newOffset = task.read_offset + consumed;
    let succeeded = task.succeeded;
    let failed = task.failed;

    this.store.transaction(() => {
      const upsert = this.store.db.prepare(
        `INSERT INTO cases (external_id, category, description, revision)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (external_id) DO UPDATE SET
           category = excluded.category,
           description = excluded.description,
           revision = cases.revision + 1
         RETURNING revision`,
      );
      const insResult = this.store.db.prepare(
        `INSERT INTO results (task_id, record_no, ok, external_id, revision, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        let revision: number | null = null;
        if (row.ok) {
          const out = upsert.get(row.externalId, row.category, row.description) as
            | { revision: number }
            | undefined;
          revision = out ? Number(out.revision) : null;
          succeeded++;
        } else {
          failed++;
        }
        insResult.run(id, row.recordNo, row.ok ? 1 : 0, row.externalId, revision, row.error);
      }
      this.store.db
        .prepare(
          `UPDATE tasks SET status = ?, read_offset = ?, header_done = ?,
             next_record_no = ?, processed = ?, succeeded = ?, failed = ?
           WHERE id = ?`,
        )
        .run(
          done ? "done" : "running",
          newOffset,
          headerDone ? 1 : 0,
          recordNo,
          task.processed + rows.length,
          succeeded,
          failed,
          id,
        );
      this.hooks.beforeCommit?.();
    });
    this.hooks.afterCommit?.();

    return {
      done,
      processed: rows.length,
      totalProcessed: task.processed + rows.length,
      succeeded,
      failed,
    };
  }

  inspectImport(id: number, after: number, limit: number): InspectResult {
    const task = this.getTask(id);
    const rows = this.store.db
      .prepare(
        `SELECT record_no, ok, external_id, revision, error FROM results
         WHERE task_id = ? AND record_no > ? ORDER BY record_no LIMIT ?`,
      )
      .all(id, after, limit) as Array<{
      record_no: number;
      ok: number;
      external_id: string | null;
      revision: number | null;
      error: string | null;
    }>;
    const results: RowResult[] = rows.map((r) => ({
      recordNo: Number(r.record_no),
      ok: r.ok === 1,
      externalId: r.external_id,
      revision: r.revision === null ? null : Number(r.revision),
      error: r.error,
    }));
    return {
      processed: task.processed,
      succeeded: task.succeeded,
      failed: task.failed,
      rows: results,
    };
  }

  getCase(externalId: string): CaseRecord | null {
    const row = this.store.db
      .prepare("SELECT external_id, category, description, revision FROM cases WHERE external_id = ?")
      .get(externalId) as
      | { external_id: string; category: string; description: string; revision: number }
      | undefined;
    if (!row) return null;
    return {
      externalId: row.external_id,
      category: row.category,
      description: row.description,
      revision: Number(row.revision),
    };
  }

  close(): void {
    this.store.close();
  }

  private getTask(id: number): TaskRow {
    const row = this.store.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    if (!row) throw new Error(`unknown import id: ${id}`);
    return row;
  }
}

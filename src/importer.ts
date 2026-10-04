import * as fs from "node:fs";
import { openStore } from "./store.js";
import { CsvParser } from "./csv.js";
import type {
  AdvanceResult,
  HrCase,
  Importer,
  InspectResult,
  RecordResult,
} from "./types.js";

const BATCH_SIZE = 128;

const VALID_CATEGORIES = new Set([
  "harassment",
  "discrimination",
  "safety violation",
  "fraud",
  "retaliation",
  "other",
]);

interface TaskRow {
  id: number;
  path: string;
  offset: number;
  header_done: number;
  next_record_no: number;
  completed: number;
  succeeded: number;
  failed: number;
  done: number;
}

/** 测试专用暂停点：第 n 次到达时阻塞进程（等待被外部杀死）。 */
function pausePoint(name: string, n: number): void {
  const v = process.env[name];
  if (v !== undefined && Number(v) === n) {
    process.stderr.write(`[pause-point] ${name} ${n}\n`);
    setInterval(() => {}, 1 << 30);
  }
}

export function createImporter(dbPath: string): Importer {
  const db = openStore(dbPath);

  const insertTask = db.prepare("INSERT INTO tasks (path) VALUES (?)");
  const getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const upsertCase = db.prepare(
    `INSERT INTO cases (external_id, category, description, revision)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(external_id) DO UPDATE SET
       category = excluded.category,
       description = excluded.description,
       revision = revision + 1
     RETURNING revision`
  );
  const insertResult = db.prepare(
    `INSERT INTO results (task_id, record_no, ok, external_id, revision, error)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const updateTaskProgress = db.prepare(
    `UPDATE tasks SET offset = ?, next_record_no = ?, completed = ?,
       succeeded = ?, failed = ?, done = ? WHERE id = ?`
  );
  const markHeaderDone = db.prepare(
    "UPDATE tasks SET offset = ?, header_done = 1, done = ? WHERE id = ?"
  );
  const resultsAfter = db.prepare(
    `SELECT record_no, ok, external_id, revision, error FROM results
     WHERE task_id = ? AND record_no > ? ORDER BY record_no LIMIT ?`
  );
  const getCaseStmt = db.prepare(
    "SELECT external_id, category, description, revision FROM cases WHERE external_id = ?"
  );

  function getTask(id: number): TaskRow {
    const row = getTaskStmt.get(id) as TaskRow | undefined;
    if (!row) throw new Error(`import task not found: ${id}`);
    return row;
  }

  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function createImport(path: string): number {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    const info = insertTask.run(path);
    return Number(info.lastInsertRowid);
  }

  function advanceImport(id: number): AdvanceResult {
    let task = getTask(id);
    if (task.done) {
      return {
        processed: 0,
        completed: task.completed,
        succeeded: task.succeeded,
        failed: task.failed,
        done: true,
      };
    }

    const parser = new CsvParser(task.path, task.offset);
    try {
      if (!task.header_done) {
        const header = parser.next();
        const done = header === null ? 1 : 0;
        tx(() => {
          markHeaderDone.run(parser.offset, done, id);
        });
        task = getTask(id);
        if (done) {
          return {
            processed: 0,
            completed: task.completed,
            succeeded: task.succeeded,
            failed: task.failed,
            done: true,
          };
        }
      }

      let processed = 0;
      let recordNo = task.next_record_no;
      let completed = task.completed;
      let succeeded = task.succeeded;
      let failed = task.failed;
      let reachedEof = false;

      while (processed < BATCH_SIZE) {
        const rec = parser.next();
        if (rec === null) {
          reachedEof = true;
          break;
        }
        const externalId = rec.fields[0] ?? "";
        const category = rec.fields[1] ?? "";
        const description = rec.fields[2] ?? "";
        let error: string | null = null;
        if (externalId === "") {
          error = "empty external_id";
        } else if (!VALID_CATEGORIES.has(category)) {
          error = `invalid category: ${category}`;
        }

        pausePoint("HR_IMPORT_PAUSE_BEFORE_COMMIT", processed + 1);

        // 单条记录一个事务：案件变更、逐行结果、进度偏移原子提交。
        const ok = error === null;
        tx(() => {
          let revision: number | null = null;
          if (ok) {
            const row = upsertCase.get(externalId, category, description) as
              | { revision: number }
              | undefined;
            revision = row ? row.revision : null;
          }
          insertResult.run(id, recordNo, ok ? 1 : 0, externalId, revision, error);
          updateTaskProgress.run(
            rec.nextOffset,
            recordNo + 1,
            completed + 1,
            succeeded + (ok ? 1 : 0),
            failed + (ok ? 0 : 1),
            0,
            id
          );
        });

        pausePoint("HR_IMPORT_PAUSE_AFTER_COMMIT", processed + 1);

        processed++;
        recordNo++;
        completed++;
        if (ok) succeeded++;
        else failed++;
      }

      if (reachedEof) {
        tx(() => {
          updateTaskProgress.run(
            parser.offset,
            recordNo,
            completed,
            succeeded,
            failed,
            1,
            id
          );
        });
      }

      pausePoint("HR_IMPORT_PAUSE_BEFORE_RETURN", 1);

      return {
        processed,
        completed,
        succeeded,
        failed,
        done: reachedEof,
      };
    } finally {
      parser.close();
    }
  }

  function inspectImport(id: number, after: number, limit: number): InspectResult {
    const task = getTask(id);
    const rows = resultsAfter.all(id, after, limit) as unknown as Array<{
      record_no: number;
      ok: number;
      external_id: string;
      revision: number | null;
      error: string | null;
    }>;
    const results: RecordResult[] = rows.map((r) => ({
      recordNo: r.record_no,
      ok: r.ok !== 0,
      externalId: r.external_id,
      revision: r.revision,
      error: r.error,
    }));
    return {
      completed: task.completed,
      succeeded: task.succeeded,
      failed: task.failed,
      done: task.done !== 0,
      results,
    };
  }

  function getCase(externalId: string): HrCase | null {
    const row = getCaseStmt.get(externalId) as
      | { external_id: string; category: string; description: string; revision: number }
      | undefined;
    if (!row) return null;
    return {
      externalId: row.external_id,
      category: row.category,
      description: row.description,
      revision: row.revision,
    };
  }

  function close(): void {
    db.close();
  }

  return { createImport, advanceImport, inspectImport, getCase, close };
}

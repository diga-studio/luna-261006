import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HrImporter } from "../src/index.js";
import { generateCsv, runToCompletion, snapshot } from "./helpers.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hr-import-"));
}

function writeCsv(dir: string, content: string): string {
  const p = path.join(dir, "cases.csv");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const TRICKY_OPTS = {
  records: 400,
  multilineEvery: 7,
  badEvery: 11,
  dupEvery: 5,
  quotedEvery: 13,
  bom: true,
  crlf: true,
  trailingNewline: false,
};

test("continuous import of tricky file", () => {
  const dir = tmpdir();
  const csvPath = writeCsv(dir, generateCsv(TRICKY_OPTS));
  const importer = new HrImporter(path.join(dir, "db.sqlite"));
  const id = importer.createImport(csvPath);
  runToCompletion(importer, id);
  const snap = snapshot(importer, id);
  assert.equal(snap.counts.processed, 400);
  assert.equal(
    snap.counts.succeeded + snap.counts.failed,
    snap.counts.processed,
  );
  assert.equal(snap.rows.length, 400);
  for (let i = 0; i < 400; i++) {
    assert.equal(snap.rows[i].recordNo, i + 1);
  }
  importer.close();
});

test("reopen between advances matches continuous import", () => {
  const dir = tmpdir();
  const csvPath = writeCsv(dir, generateCsv(TRICKY_OPTS));

  const refImporter = new HrImporter(path.join(dir, "ref.sqlite"));
  const refId = refImporter.createImport(csvPath);
  runToCompletion(refImporter, refId);
  const ref = snapshot(refImporter, refId);
  refImporter.close();

  const dbPath = path.join(dir, "reopen.sqlite");
  let importer = new HrImporter(dbPath);
  const id = importer.createImport(csvPath);
  importer.close();

  for (let guard = 0; guard < 1000; guard++) {
    importer = new HrImporter(dbPath);
    const r = importer.advanceImport(id);
    importer.close();
    if (r.done) break;
  }

  importer = new HrImporter(dbPath);
  const got = snapshot(importer, id);
  importer.close();
  assert.deepEqual(got, ref);
});

test("completed task advance is a no-op", () => {
  const dir = tmpdir();
  const csvPath = writeCsv(dir, generateCsv({ records: 10 }));
  const importer = new HrImporter(path.join(dir, "db.sqlite"));
  const id = importer.createImport(csvPath);
  runToCompletion(importer, id);
  const before = snapshot(importer, id);
  const r = importer.advanceImport(id);
  assert.equal(r.done, true);
  assert.equal(r.processed, 0);
  const after = snapshot(importer, id);
  assert.deepEqual(after, before);
  importer.close();
});

test("inspectImport paginates by record number", () => {
  const dir = tmpdir();
  const csvPath = writeCsv(dir, generateCsv({ records: 300 }));
  const importer = new HrImporter(path.join(dir, "db.sqlite"));
  const id = importer.createImport(csvPath);
  runToCompletion(importer, id);
  const page1 = importer.inspectImport(id, 0, 100);
  assert.equal(page1.rows.length, 100);
  assert.equal(page1.rows[0].recordNo, 1);
  const page2 = importer.inspectImport(id, 100, 100);
  assert.equal(page2.rows[0].recordNo, 101);
  const page4 = importer.inspectImport(id, 300, 100);
  assert.equal(page4.rows.length, 0);
  importer.close();
});

test("revision increments on identical repeated rows", () => {
  const dir = tmpdir();
  const rows = Array.from(
    { length: 5 },
    () => "EMP-X,other,same description",
  ).join("\n");
  const csvPath = writeCsv(dir, "external_id,category,description\n" + rows);
  const importer = new HrImporter(path.join(dir, "db.sqlite"));
  const id = importer.createImport(csvPath);
  runToCompletion(importer, id);
  const c = importer.getCase("EMP-X");
  assert.equal(c?.revision, 5);
  const info = importer.inspectImport(id, 0, 10);
  assert.deepEqual(
    info.rows.map((r) => r.revision),
    [1, 2, 3, 4, 5],
  );
  importer.close();
});

test("field values are not normalized", () => {
  const dir = tmpdir();
  const csvPath = writeCsv(
    dir,
    'external_id,category,description\n  EMP-9  ,other,"  keep  spaces  "',
  );
  const importer = new HrImporter(path.join(dir, "db.sqlite"));
  const id = importer.createImport(csvPath);
  runToCompletion(importer, id);
  const c = importer.getCase("  EMP-9  ");
  assert.equal(c?.description, "  keep  spaces  ");
  importer.close();
});

test("getCase returns null for unknown id", () => {
  const dir = tmpdir();
  const importer = new HrImporter(path.join(dir, "db.sqlite"));
  assert.equal(importer.getCase("nobody"), null);
  importer.close();
});

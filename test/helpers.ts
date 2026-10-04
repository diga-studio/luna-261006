import { HrImporter } from "../src/index.js";
import type { CaseRecord, RowResult } from "../src/index.js";

export interface Snapshot {
  counts: { processed: number; succeeded: number; failed: number };
  rows: RowResult[];
  cases: CaseRecord[];
}

export function snapshot(importer: HrImporter, taskId: number): Snapshot {
  const info = importer.inspectImport(taskId, 0, Number.MAX_SAFE_INTEGER);
  return {
    counts: {
      processed: info.processed,
      succeeded: info.succeeded,
      failed: info.failed,
    },
    rows: info.rows,
    cases: collectCases(importer, info.rows),
  };
}

function collectCases(importer: HrImporter, rows: RowResult[]): CaseRecord[] {
  const seen = new Set<string>();
  const out: CaseRecord[] = [];
  for (const row of rows) {
    if (row.externalId !== null && !seen.has(row.externalId)) {
      seen.add(row.externalId);
      const c = importer.getCase(row.externalId);
      if (c) out.push(c);
    }
  }
  out.sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
  return out;
}

export function runToCompletion(importer: HrImporter, taskId: number): void {
  for (let guard = 0; guard < 100000; guard++) {
    if (importer.advanceImport(taskId).done) return;
  }
  throw new Error("import did not finish");
}

const CATEGORIES = [
  "harassment",
  "discrimination",
  "safety violation",
  "fraud",
  "retaliation",
  "other",
];

export interface GenOptions {
  records: number;
  multilineEvery?: number;
  badEvery?: number;
  dupEvery?: number;
  quotedEvery?: number;
  bom?: boolean;
  crlf?: boolean;
  trailingNewline?: boolean;
}

export function generateCsv(opts: GenOptions): string {
  const nl = opts.crlf ? "\r\n" : "\n";
  const parts: string[] = [];
  if (opts.bom) parts.push("﻿");
  parts.push("external_id,category,description" + nl);
  for (let i = 1; i <= opts.records; i++) {
    let id = `EMP-${i}`;
    if (opts.dupEvery && i % opts.dupEvery === 0) id = `EMP-${i - 1}`;
    let category = CATEGORIES[i % CATEGORIES.length];
    let desc = `case ${i} 描述`;
    if (opts.badEvery && i % opts.badEvery === 0) {
      if (i % 2 === 0) id = "";
      else category = "not-a-category";
    }
    if (opts.multilineEvery && i % opts.multilineEvery === 0) {
      desc = `multi${nl}line "quoted", field ${i} 汉字`;
    }
    if (opts.quotedEvery && i % opts.quotedEvery === 0) {
      desc = `he said ""hi"" ${i}`;
    }
    const needsQuote = /[",\r\n]/.test(desc);
    const field = needsQuote ? `"${desc.replace(/"/g, '""')}"` : desc;
    parts.push(`${id},${category},${field}` + nl);
  }
  let out = parts.join("");
  if (opts.trailingNewline === false && out.endsWith(nl)) {
    out = out.slice(0, out.length - nl.length);
  }
  return out;
}

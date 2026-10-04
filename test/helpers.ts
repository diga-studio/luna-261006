import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CsvParser } from "../src/csv.js";
import { createImporter } from "../src/index.js";
import type { HrCase, InspectResult, RecordResult } from "../src/index.js";

export const VALID_CATEGORIES = new Set([
  "harassment",
  "discrimination",
  "safety violation",
  "fraud",
  "retaliation",
  "other",
]);

let tmpSeq = 0;
export function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `hrimp-${prefix}-${process.pid}-${tmpSeq++}-`)
  );
  return dir;
}

export interface CsvGenRecord {
  externalId: string;
  category: string;
  description: string;
}

export function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

export function toCsvLine(r: CsvGenRecord, eol: string): string {
  return [r.externalId, r.category, r.description].map(csvEscape).join(",") + eol;
}

/** 组合文件：BOM、多字节字符、跨行字段、转义引号、失败行、重复案件号、无末尾换行。 */
export function writeMixedCsv(dir: string): { csvPath: string; records: CsvGenRecord[] } {
  const records: CsvGenRecord[] = [
    { externalId: "CASE-001", category: "harassment", description: "普通描述" },
    { externalId: "CASE-002", category: "safety violation", description: "跨行\n描述\n第二行" },
    { externalId: "", category: "fraud", description: "空案件号，应失败" },
    { externalId: "CASE-003", category: "not-a-category", description: "非法类别，应失败" },
    { externalId: "CASE-001", category: "fraud", description: "重复案件号，第二次出现" },
    { externalId: "CASE-004", category: "retaliation", description: '引号 ""转义"" 与,逗号' },
    { externalId: "CASE-005", category: "other", description: "多字节 🚀 émoji と CJK 字符" },
    { externalId: "CASE-004", category: "retaliation", description: '引号 ""转义"" 与,逗号' },
    { externalId: "CASE-006", category: "discrimination", description: "CRLF\r\n内嵌换行" },
    { externalId: "CASE-007", category: "other", description: "末尾无换行" },
  ];
  let body = "external_id,category,description\r\n";
  records.forEach((r, i) => {
    const eol = i === records.length - 1 ? "" : i % 2 === 0 ? "\r\n" : "\n";
    body += toCsvLine(r, eol);
  });
  const csvPath = path.join(dir, "mixed.csv");
  fs.writeFileSync(csvPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]));
  return { csvPath, records };
}

/** 确定性生成 n 条记录（含失败行与重复案件号）。 */
export function generateRecords(n: number): CsvGenRecord[] {
  const out: CsvGenRecord[] = [];
  for (let i = 1; i <= n; i++) {
    const externalId = i % 17 === 0 ? "" : `CASE-${(i % 50) + 1}`;
    const cats = [...VALID_CATEGORIES];
    const category = i % 13 === 0 ? "bogus" : cats[i % cats.length]!;
    out.push({
      externalId,
      category,
      description: `desc-${i}-${"x".repeat(i % 40)}`,
    });
  }
  return out;
}

export function writeCsv(dir: string, name: string, records: CsvGenRecord[], trailingNewline = true): string {
  let body = "external_id,category,description\n";
  records.forEach((r, i) => {
    const last = i === records.length - 1;
    body += toCsvLine(r, last && !trailingNewline ? "" : "\n");
  });
  const csvPath = path.join(dir, name);
  fs.writeFileSync(csvPath, body, "utf8");
  return csvPath;
}

/** 用解析器读全文件（跳过表头），返回每条的字段。 */
export function parseAll(csvPath: string): string[][] {
  const parser = new CsvParser(csvPath, 0);
  const out: string[][] = [];
  try {
    parser.next(); // 表头
    let rec;
    while ((rec = parser.next()) !== null) out.push(rec.fields);
  } finally {
    parser.close();
  }
  return out;
}

export interface ReferenceModel {
  cases: Map<string, HrCase>;
  results: RecordResult[];
  succeeded: number;
  failed: number;
}

/** 顺序导入的内存参考模型。 */
export function buildReference(records: CsvGenRecord[]): ReferenceModel {
  const cases = new Map<string, HrCase>();
  const results: RecordResult[] = [];
  let succeeded = 0;
  let failed = 0;
  records.forEach((r, i) => {
    const recordNo = i + 1;
    let error: string | null = null;
    if (r.externalId === "") error = "empty external_id";
    else if (!VALID_CATEGORIES.has(r.category)) error = `invalid category: ${r.category}`;
    let revision: number | null = null;
    if (error === null) {
      const existing = cases.get(r.externalId);
      revision = existing ? existing.revision + 1 : 1;
      cases.set(r.externalId, {
        externalId: r.externalId,
        category: r.category,
        description: r.description,
        revision,
      });
      succeeded++;
    } else {
      failed++;
    }
    results.push({ recordNo, ok: error === null, externalId: r.externalId, revision, error });
  });
  return { cases, results, succeeded, failed };
}

/** 推进直到完成；reopen=true 时每次推进都关闭并重开库。 */
export function drainImport(dbPath: string, id: number, reopen: boolean): void {
  let imp = reopen ? null : createImporter(dbPath);
  for (;;) {
    if (reopen || imp === null) imp = createImporter(dbPath);
    const res = imp.advanceImport(id);
    if (reopen || res.done) imp.close();
    if (res.done) return;
    if (res.processed === 0) throw new Error("advance made no progress but not done");
  }
}

/** 分页拉取全部逐行结果。 */
export function collectResults(dbPath: string, id: number): InspectResult {
  const imp = createImporter(dbPath);
  try {
    const results: RecordResult[] = [];
    let after = 0;
    let summary: InspectResult | null = null;
    for (;;) {
      const page = imp.inspectImport(id, after, 7);
      summary = page;
      results.push(...page.results);
      if (page.results.length === 0) break;
      after = page.results[page.results.length - 1]!.recordNo;
    }
    return { ...summary, results };
  } finally {
    imp.close();
  }
}

export function getAllCases(dbPath: string, externalIds: string[]): Map<string, HrCase | null> {
  const imp = createImporter(dbPath);
  try {
    const m = new Map<string, HrCase | null>();
    for (const id of externalIds) m.set(id, imp.getCase(id));
    return m;
  } finally {
    imp.close();
  }
}

/** 断言数据库状态与参考模型一致。 */
export function assertMatchesReference(
  dbPath: string,
  id: number,
  ref: ReferenceModel,
  assert: { strictEqual(a: unknown, b: unknown, m?: string): void; deepStrictEqual(a: unknown, b: unknown, m?: string): void }
): void {
  const inspect = collectResults(dbPath, id);
  assert.strictEqual(inspect.completed, ref.results.length, "completed");
  assert.strictEqual(inspect.succeeded, ref.succeeded, "succeeded");
  assert.strictEqual(inspect.failed, ref.failed, "failed");
  assert.strictEqual(inspect.succeeded + inspect.failed, inspect.completed, "s+f=c");
  assert.strictEqual(inspect.results.length, ref.results.length, "result count");
  assert.deepStrictEqual(inspect.results, ref.results, "row results");
  const ids = [...ref.cases.keys()];
  const actual = getAllCases(dbPath, ids);
  for (const extId of ids) {
    assert.deepStrictEqual(actual.get(extId), ref.cases.get(extId) ?? null, `case ${extId}`);
  }
}

/** 启动子进程，等到暂停点输出后 SIGKILL。 */
export function runChildUntilKilled(
  dbPath: string,
  taskId: number,
  env: Record<string, string>
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const childPath = path.join(__dirname, "child.js");
    const child = spawn(process.execPath, [childPath, dbPath, String(taskId)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not reach pause point; stderr=${stderr}`));
    }, 30000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!killed && stderr.includes("[pause-point]")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (killed) resolve({ stderr });
      else reject(new Error(`child exited before kill; stderr=${stderr}`));
    });
  });
}

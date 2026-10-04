import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeDEM } from "../src/index";

async function tempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "dem-write-"));
}

async function* toRows(values: number[][]): AsyncGenerator<Float64Array> {
  for (const row of values) yield Float64Array.from(row);
}

test("writeDEM 写出正确的 meta.json 与小端 elevation.bin", async () => {
  const dir = await tempDir();
  await writeDEM(dir, { width: 2, height: 2, x0: 10, y0: 20, step: 0.5 }, toRows([
    [1.5, NaN],
    [3.25, -4],
  ]));
  const meta = JSON.parse(await fs.promises.readFile(path.join(dir, "meta.json"), "utf8"));
  assert.deepStrictEqual(meta, { width: 2, height: 2, x0: 10, y0: 20, step: 0.5 });
  const bin = await fs.promises.readFile(path.join(dir, "elevation.bin"));
  assert.strictEqual(bin.byteLength, 4 * 8);
  assert.strictEqual(bin.readDoubleLE(0), 1.5);
  assert.ok(Number.isNaN(bin.readDoubleLE(8)));
  assert.strictEqual(bin.readDoubleLE(16), 3.25);
  assert.strictEqual(bin.readDoubleLE(24), -4);
});

test("writeDEM 拒绝非法 step", async () => {
  const dir = await tempDir();
  await assert.rejects(
    writeDEM(dir, { width: 1, height: 1, x0: 0, y0: 0, step: 2 }, toRows([[0]])),
    /step/,
  );
});

test("writeDEM 拒绝行长度不符与行数不符", async () => {
  const dir1 = await tempDir();
  await assert.rejects(
    writeDEM(dir1, { width: 2, height: 1, x0: 0, y0: 0, step: 1 }, toRows([[1, 2, 3]])),
    /length/,
  );
  const dir2 = await tempDir();
  await assert.rejects(
    writeDEM(dir2, { width: 1, height: 2, x0: 0, y0: 0, step: 1 }, toRows([[1]])),
    /rows/,
  );
  const dir3 = await tempDir();
  await assert.rejects(
    writeDEM(dir3, { width: 1, height: 1, x0: 0, y0: 0, step: 1 }, toRows([[1], [2]])),
    /rows/,
  );
});

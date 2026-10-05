import assert from "node:assert/strict";
import test from "node:test";
import { compareVariants } from "../src/index.js";

test("版本数量必须为 2 至 4", () => {
  assert.throws(() => compareVariants([{ exposure: 10, converted: 1 }]), RangeError);
  assert.throws(
    () =>
      compareVariants([
        { exposure: 10, converted: 1 },
        { exposure: 10, converted: 1 },
        { exposure: 10, converted: 1 },
        { exposure: 10, converted: 1 },
        { exposure: 10, converted: 1 },
      ]),
    RangeError,
  );
});

test("曝光人数必须为正整数", () => {
  assert.throws(
    () => compareVariants([{ exposure: 0, converted: 0 }, { exposure: 10, converted: 1 }]),
    RangeError,
  );
  assert.throws(
    () => compareVariants([{ exposure: 10.5, converted: 1 }, { exposure: 10, converted: 1 }]),
    RangeError,
  );
});

test("互动人数必须在 [0, 曝光人数] 内", () => {
  assert.throws(
    () => compareVariants([{ exposure: 10, converted: 11 }, { exposure: 10, converted: 1 }]),
    RangeError,
  );
  assert.throws(
    () => compareVariants([{ exposure: 10, converted: -1 }, { exposure: 10, converted: 1 }]),
    RangeError,
  );
});

test("超出支持规模时抛出 RangeError", () => {
  assert.throws(
    () => compareVariants([{ exposure: 50001, converted: 0 }, { exposure: 50000, converted: 0 }]),
    RangeError,
  );
  assert.throws(
    () =>
      compareVariants([
        { exposure: 25000, converted: 1001 },
        { exposure: 25000, converted: 1000 },
      ]),
    RangeError,
  );
});

test("非法显著性水平抛出 RangeError", () => {
  const vs = [
    { exposure: 10, converted: 2 },
    { exposure: 10, converted: 1 },
  ];
  assert.throws(() => compareVariants(vs, { alpha: 0 }), RangeError);
  assert.throws(() => compareVariants(vs, { alpha: 1 }), RangeError);
});

test("同一输入结果可重复（逐位一致）", () => {
  const vs = [
    { exposure: 120, converted: 22 },
    { exposure: 180, converted: 37 },
    { exposure: 270, converted: 51 },
  ];
  const r0 = compareVariants(vs);
  const r1 = compareVariants(vs);
  assert.deepEqual(r1, r0);
});

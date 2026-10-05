import { test } from "node:test";
import assert from "node:assert/strict";
import { previewMetadata, exportSanitized, JpegPrivacyError } from "../src/index.js";
import { minimalJpeg } from "./fixtures.js";

test("smoke: 无元数据的最小 JPEG 导出后逐字节不变", () => {
  const input = minimalJpeg();
  const result = exportSanitized(input);
  assert.deepEqual(result.bytes, input);
  assert.deepEqual(result.preview, { fields: [] });
  assert.deepEqual(previewMetadata(input), { fields: [] });
});

test("smoke: 非 JPEG 输入抛 JpegPrivacyError", () => {
  assert.throws(() => previewMetadata(new Uint8Array([1, 2, 3])), JpegPrivacyError);
  assert.throws(() => exportSanitized(new Uint8Array()), JpegPrivacyError);
});

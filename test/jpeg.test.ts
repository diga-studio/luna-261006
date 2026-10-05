import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJpegStructure } from "../src/jpeg.js";
import { JpegPrivacyError } from "../src/errors.js";
import { bytes, concat, markerOnly, minimalJpeg, segment, jfifSegment, DQT, DHT, SOS, sof } from "./fixtures.js";

test("解析最小基线 JPEG，raw 拼接逐字节还原", () => {
  const input = minimalJpeg([jfifSegment()]);
  const structure = parseJpegStructure(input);
  assert.equal(structure.sofMarker, 0xc0);
  const reassembled = concat(...structure.pieces.map((p) => p.raw));
  assert.deepEqual(reassembled, input);
});

test("扫描数据中的 FF00 填充与重启标记不被误认成边界", () => {
  const scanData = bytes(0xaa, 0xff, 0x00, 0xbb, 0xff, 0xd7, 0xcc, 0xff, 0xff, 0x00, 0xdd);
  const input = minimalJpeg([], scanData);
  const structure = parseJpegStructure(input);
  const scans = structure.pieces.filter((p) => p.kind === "scan");
  assert.equal(scans.length, 1);
  // scan raw = SOS 段 + 熵编码数据
  assert.deepEqual(scans[0]!.raw, concat(SOS, scanData));
  const reassembled = concat(...structure.pieces.map((p) => p.raw));
  assert.deepEqual(reassembled, input);
});

test("标记前的填充 FF 字节保留在段 raw 中", () => {
  const input = concat(
    markerOnly(0xd8),
    DQT,
    sof(0xc0),
    DHT,
    SOS,
    bytes(0x42),
    bytes(0xff, 0xff, 0xff, 0xd9), // EOI 前两个填充 FF
  );
  const structure = parseJpegStructure(input);
  const reassembled = concat(...structure.pieces.map((p) => p.raw));
  assert.deepEqual(reassembled, input);
});

test("首个 EOI 后的尾随数据被排除在结构之外", () => {
  const trailing = bytes(0xde, 0xad, 0xbe, 0xef);
  const input = concat(minimalJpeg(), trailing);
  const structure = parseJpegStructure(input);
  const reassembled = concat(...structure.pieces.map((p) => p.raw));
  assert.deepEqual(reassembled, minimalJpeg());
});

test("渐进式多扫描：扫描之间的 APP 段位置正确", () => {
  const app12 = segment(0xec, bytes(1, 2, 3));
  const input = concat(
    markerOnly(0xd8),
    DQT,
    sof(0xc2),
    DHT,
    SOS,
    bytes(0x01, 0x02),
    app12,
    SOS,
    bytes(0x03, 0xff, 0x00, 0x04),
    markerOnly(0xd9),
  );
  const structure = parseJpegStructure(input);
  assert.equal(structure.sofMarker, 0xc2);
  assert.equal(structure.pieces.filter((p) => p.kind === "scan").length, 2);
  const reassembled = concat(...structure.pieces.map((p) => p.raw));
  assert.deepEqual(reassembled, input);
});

test("非 JPEG 输入失败", () => {
  assert.throws(() => parseJpegStructure(bytes(0x89, 0x50, 0x4e, 0x47)), JpegPrivacyError);
  assert.throws(() => parseJpegStructure(new Uint8Array()), JpegPrivacyError);
});

test("截断的段失败", () => {
  const bad = concat(markerOnly(0xd8), bytes(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46));
  assert.throws(() => parseJpegStructure(bad), JpegPrivacyError);
});

test("扫描数据后缺少 EOI 失败", () => {
  const bad = concat(markerOnly(0xd8), DQT, sof(0xc0), DHT, SOS, bytes(0x11, 0x22));
  assert.throws(() => parseJpegStructure(bad), JpegPrivacyError);
});

test("不支持的 SOF（算术编码/无损/12位）失败", () => {
  const arithmetic = concat(markerOnly(0xd8), DQT, sof(0xc9), DHT, SOS, bytes(0x11), markerOnly(0xd9));
  assert.throws(() => parseJpegStructure(arithmetic), JpegPrivacyError);
  const lossless = concat(markerOnly(0xd8), DQT, sof(0xc3), DHT, SOS, bytes(0x11), markerOnly(0xd9));
  assert.throws(() => parseJpegStructure(lossless), JpegPrivacyError);
  const twelveBit = concat(
    markerOnly(0xd8),
    DQT,
    segment(0xc0, bytes(12, 0, 8, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)),
    DHT,
    SOS,
    bytes(0x11),
    markerOnly(0xd9),
  );
  assert.throws(() => parseJpegStructure(twelveBit), JpegPrivacyError);
});

test("SOS 出现在 SOF 之前失败", () => {
  const bad = concat(markerOnly(0xd8), DQT, SOS, bytes(0x11), markerOnly(0xd9));
  assert.throws(() => parseJpegStructure(bad), JpegPrivacyError);
});

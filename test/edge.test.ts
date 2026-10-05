import { test } from "node:test";
import assert from "node:assert/strict";
import { exportSanitized, previewMetadata } from "../src/index.js";
import { parseJpegStructure } from "../src/jpeg.js";
import {
  adobeSegment, buildTiff, bytes, concat, eAscii, eShort, exifSegment,
  iccSegments, jfifSegment, markerOnly, minimalJpeg, segment, DQT, DHT, SOS, sof,
} from "./fixtures.js";

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

test("JFXX 扩展段与非标准 APP0/APP14 一并删除", () => {
  const jfxx = segment(0xe0, ascii("JFXX\0\x10JFIFTHUMBNAIL"));
  const oddApp0 = segment(0xe0, ascii("NOTJFIFDATA"));
  const longAdobe = segment(0xee, concat(ascii("Adobe"), bytes(0, 100, 0, 0, 0, 0, 1, 0x99, 0x98)));
  const input = minimalJpeg([jfifSegment(), jfxx, oddApp0, adobeSegment(1), longAdobe]);
  const { bytes: out } = exportSanitized(input);
  const app0 = parseJpegStructure(out).pieces.filter(
    (p) => p.kind === "segment" && p.marker === 0xe0,
  );
  assert.equal(app0.length, 1); // 只剩标准 JFIF
  const app14 = parseJpegStructure(out).pieces.filter(
    (p) => p.kind === "segment" && p.marker === 0xee,
  );
  assert.equal(app14.length, 1); // 只剩标准 Adobe
});

test("25 MiB 多扫描多 EXIF 大图：导出正确且幂等", () => {
  // 构造约 25 MiB：8 个扫描块，每块约 3.2 MiB 熵数据（含 FF00 与重启标记）
  const chunk = new Uint8Array(4096);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 0xff;
  // 确保没有裸 0xFF 后跟非 00/D0-D7 的字节
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 0xff) chunk[i] = 0xfe;
  }
  const scanBlock = (seed: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (let k = 0; k < 800; k++) {
      parts.push(chunk, bytes(0xff, 0x00, seed & 0xff, 0xff, 0xd0 + (k % 8)));
    }
    return concat(...parts);
  };
  const exif = exifSegment(buildTiff({
    ifd0: [eAscii(false, 0x010f, "Canon\0"), eShort(false, 0x0112, 1)],
    exifIfd: [eShort(false, 0x8827, 100)],
  }));
  const exif2 = exifSegment(buildTiff({
    ifd0: [eAscii(false, 0x010f, "Canon\0"), eShort(false, 0x0112, 1)],
    exifIfd: [eShort(false, 0x8827, 100)],
  }));
  const scans: Uint8Array[] = [];
  for (let s = 0; s < 8; s++) {
    scans.push(SOS, scanBlock(s));
    if (s === 3) scans.push(exif2); // 扫描间 EXIF
  }
  const input = concat(
    markerOnly(0xd8),
    jfifSegment(),
    exif,
    ...iccSegments([ascii("icc-large-1"), ascii("icc-large-2")]),
    DQT,
    sof(0xc2, 4096, 4096),
    DHT,
    ...scans,
    markerOnly(0xd9),
  );
  assert.ok(input.length > 25 * 1024 * 1024, `输入应超过 25 MiB，实际 ${input.length}`);

  const start = Date.now();
  const { bytes: out, preview } = exportSanitized(input);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10000, `导出耗时 ${elapsed}ms`);
  assert.equal(preview.fields.length, 3);

  // 扫描数据逐字节一致
  const inScans = parseJpegStructure(input).pieces.filter((p) => p.kind === "scan").map((p) => p.raw);
  const outScans = parseJpegStructure(out).pieces.filter((p) => p.kind === "scan").map((p) => p.raw);
  assert.equal(outScans.length, 8);
  assert.deepEqual(outScans, inScans);

  // 幂等
  assert.deepEqual(exportSanitized(out).bytes, out);
  assert.deepEqual(previewMetadata(out), preview);
});

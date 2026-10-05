import { test } from "node:test";
import assert from "node:assert/strict";
import { previewMetadata, exportSanitized, JpegPrivacyError } from "../src/index.js";
import { parseJpegStructure, type JpegPiece } from "../src/jpeg.js";
import {
  adobeSegment, buildTiff, bytes, concat, eAscii, eLong, eRational, eRaw, eShort,
  exifSegment, iccSegments, jfifSegment, markerOnly, minimalJpeg, segment,
  DQT, DHT, SOS, sof,
} from "./fixtures.js";

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** 编码相关片段（扫描数据 + DQT/DHT/SOF/DRI），用于逐字节比对。 */
function codingPieces(pieces: JpegPiece[]): Uint8Array[] {
  const codingMarkers = new Set([0xdb, 0xc4, 0xc0, 0xc2, 0xdd, 0xdc]);
  return pieces
    .filter((p) => p.kind === "scan" || (p.kind === "segment" && codingMarkers.has(p.marker)))
    .map((p) => p.raw);
}

function segmentsOf(bytes_: Uint8Array, marker: number): Uint8Array[] {
  return parseJpegStructure(bytes_)
    .pieces.filter((p): p is Extract<JpegPiece, { kind: "segment" }> => p.kind === "segment")
    .filter((p) => p.marker === marker)
    .map((p) => p.raw);
}

const MAKERNOTE = bytes(0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe);
const THUMBNAIL = bytes(0xff, 0xd8, 0x99, 0x97, 0x96, 0x95, 0xff, 0xd9);
const JFIF_THUMB = bytes(0x71, 0x72, 0x73, 0x74, 0x75, 0x76);
const GPS_LAT = eRational(false, 0x0002, [39, 1], [54, 1], [7777, 3]);
const GPS_LAT_BYTES = bytes(0, 0, 0, 39, 0, 0, 0, 1, 0, 0, 0, 54, 0, 0, 0, 1, 0, 0, 0x1e, 0x61, 0, 0, 0, 3);

function fullFeaturedTiff(littleEndian: boolean): Uint8Array {
  return buildTiff({
    littleEndian,
    ifd0: [
      eAscii(littleEndian, 0x010f, "Canon\0"),
      eAscii(littleEndian, 0x0110, "EOS R5\0"),
      eShort(littleEndian, 0x0112, 6),
      eAscii(littleEndian, 0x0131, "John Doe\0"),
      eAscii(littleEndian, 0x8298, "ACME Corp\0"),
      eAscii(littleEndian, 0x0132, "2024:01:02 03:04:05\0"),
      eAscii(littleEndian, 0x010e, "Private description\0"),
      eAscii(littleEndian, 0xa431, "SN123456789\0"), // 机身序列号
    ],
    gps: [
      GPS_LAT,
      eAscii(littleEndian, 0x0001, "N\0"),
      eRational(littleEndian, 0x0004, [116, 1], [23, 1], [4567, 2]),
    ],
    exifIfd: [
      eRational(littleEndian, 0x829a, [1, 125]),
      eRational(littleEndian, 0x829d, [28, 10]),
      eShort(littleEndian, 0x8827, 400),
      eRational(littleEndian, 0x920a, [50, 1]),
      eRaw(0x927c, 7, MAKERNOTE.length, MAKERNOTE), // MakerNote
      eRaw(0x9286, 7, 8, ascii("COMMENT\0")), // UserComment
      eAscii(littleEndian, 0x9003, "2024:01:02 03:04:05\0"), // DateTimeOriginal
    ],
    ifd1: { entries: [eShort(littleEndian, 0x0103, 6)], thumbnail: THUMBNAIL },
  });
}

const ICC_CHUNK1 = ascii("icc-chunk-one-secret");
const ICC_CHUNK2 = ascii("icc-chunk-two-secret");
const XMP = segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>private</x:xmpmeta>"));
const IPTC = segment(0xed, ascii("Photoshop 3.0\0IPTCDATASECRET"));
const COM = segment(0xfe, ascii("a private comment"));
const APP12 = segment(0xec, ascii("unknown-app-data"));
const TRAILING = ascii("TRAILING-GARBAGE-AFTER-EOI");

function buildFullJpeg(littleEndian: boolean): Uint8Array {
  const scanData = bytes(0x11, 0xff, 0x00, 0x22, 0xff, 0xd3, 0x33, 0x44);
  return concat(
    markerOnly(0xd8),
    jfifSegment({ thumbnail: JFIF_THUMB, xdensity: 300, ydensity: 300 }),
    exifSegment(fullFeaturedTiff(littleEndian)),
    XMP,
    ...iccSegments([ICC_CHUNK1, ICC_CHUNK2]),
    IPTC,
    adobeSegment(1),
    COM,
    APP12,
    DQT,
    sof(0xc0),
    DHT,
    SOS,
    scanData,
    markerOnly(0xd9),
    TRAILING,
  );
}

for (const littleEndian of [false, true]) {
  test(`全功能清理（${littleEndian ? "小端" : "大端"}）：白名单保留、隐私无残留、编码逐字节一致`, () => {
    const input = buildFullJpeg(littleEndian);
    const { bytes: out, preview } = exportSanitized(input);

    // 白名单字段准确保留
    const byName = new Map(preview.fields.map((f) => [f.name, f]));
    assert.equal(preview.fields.length, 7);
    assert.deepEqual(byName.get("Make")?.value, { kind: "ascii", text: "Canon" });
    assert.deepEqual(byName.get("Model")?.value, { kind: "ascii", text: "EOS R5" });
    assert.deepEqual(byName.get("Orientation")?.value, { kind: "uint", values: [6] });
    assert.deepEqual(byName.get("ExposureTime")?.value, { kind: "rational", values: [[1, 125]] });
    assert.deepEqual(byName.get("FNumber")?.value, { kind: "rational", values: [[28, 10]] });
    assert.deepEqual(byName.get("ISOSpeedRatings")?.value, { kind: "uint", values: [400] });
    assert.deepEqual(byName.get("FocalLength")?.value, { kind: "rational", values: [[50, 1]] });

    // 被删除内容在输出中无残留
    for (const needle of [
      ascii("John Doe"), ascii("ACME"), ascii("2024:01:02"), ascii("Private description"),
      ascii("SN123456789"), MAKERNOTE, THUMBNAIL, JFIF_THUMB, GPS_LAT_BYTES,
      ascii("xmpmeta"), ascii("IPTCDATASECRET"), ascii("a private comment"),
      ascii("unknown-app-data"), TRAILING, ascii("COMMENT\0"), ascii("N\0"),
    ]) {
      assert.ok(!contains(out, needle), `输出中不应残留: ${Array.from(needle).map((b) => b.toString(16)).join(",")}`);
    }

    // 编码标记与扫描数据逐字节一致
    assert.deepEqual(codingPieces(parseJpegStructure(out).pieces), codingPieces(parseJpegStructure(input).pieces));

    // EXIF 恰好一段，且不再含 GPS/缩略图目录
    const exifSegments = segmentsOf(out, 0xe1);
    assert.equal(exifSegments.length, 1);

    // JFIF 显示参数保留、缩略图删除
    const jfif = segmentsOf(out, 0xe0);
    assert.equal(jfif.length, 1);
    const jfifPayload = jfif[0]!.subarray(4);
    assert.equal(jfifPayload.length, 14);
    assert.deepEqual(Array.from(jfifPayload.subarray(8, 12)), [1, 44, 1, 44]); // 300,300
    assert.equal(jfifPayload[12], 0);
    assert.equal(jfifPayload[13], 0);

    // ICC 分段内容与顺序不变
    const icc = segmentsOf(out, 0xe2);
    assert.equal(icc.length, 2);
    assert.ok(contains(icc[0]!, ICC_CHUNK1));
    assert.ok(contains(icc[1]!, ICC_CHUNK2));

    // Adobe 保留
    assert.equal(segmentsOf(out, 0xee).length, 1);

    // COM / IPTC / 未知 APP 删除
    assert.equal(segmentsOf(out, 0xfe).length, 0);
    assert.equal(segmentsOf(out, 0xed).length, 0);
    assert.equal(segmentsOf(out, 0xec).length, 0);

    // 预览与导出后重新读取一致
    assert.deepEqual(previewMetadata(input), previewMetadata(out));
    assert.deepEqual(preview, previewMetadata(out));

    // 幂等：再次导出逐字节不变
    assert.deepEqual(exportSanitized(out).bytes, out);
  });
}

test("渐进式多扫描：扫描间元数据清理、扫描数据与 ICC 保留、幂等", () => {
  const scan1 = bytes(0x01, 0xff, 0x00, 0x02, 0xff, 0xd0, 0x03);
  const scan2 = bytes(0x04, 0xff, 0xd1, 0x05);
  const scan3 = bytes(0x06, 0xff, 0x00, 0x07, 0x08);
  const midExif = exifSegment(
    buildTiff({ ifd0: [eAscii(false, 0x0131, "Mid Scan Artist\0"), eShort(false, 0x0112, 1)] }),
  );
  const midApp = segment(0xe5, ascii("mid-scan-private"));
  const input = concat(
    markerOnly(0xd8),
    jfifSegment(),
    ...iccSegments([ICC_CHUNK1, ICC_CHUNK2]),
    DQT,
    sof(0xc2),
    DHT,
    SOS,
    scan1,
    midExif,
    midApp,
    SOS,
    scan2,
    COM,
    SOS,
    scan3,
    markerOnly(0xd9),
  );
  const { bytes: out, preview } = exportSanitized(input);

  // 扫描间元数据被清理，Orientation 保留
  assert.ok(!contains(out, ascii("Mid Scan Artist")));
  assert.ok(!contains(out, ascii("mid-scan-private")));
  assert.deepEqual(byName(preview, "Orientation"), { kind: "uint", values: [1] });

  // 三个扫描块逐字节一致
  const inScans = parseJpegStructure(input).pieces.filter((p) => p.kind === "scan").map((p) => p.raw);
  const outScans = parseJpegStructure(out).pieces.filter((p) => p.kind === "scan").map((p) => p.raw);
  assert.deepEqual(outScans, inScans);

  // ICC 保留
  assert.equal(segmentsOf(out, 0xe2).length, 2);

  // 幂等
  assert.deepEqual(exportSanitized(out).bytes, out);
});

function byName(preview: { fields: Array<{ name: string; value: unknown }> }, name: string): unknown {
  return preview.fields.find((f) => f.name === name)?.value;
}

test("多 EXIF 段：一致字段合并为一份", () => {
  const seg1 = exifSegment(buildTiff({
    ifd0: [eAscii(false, 0x010f, "Canon\0"), eShort(false, 0x0112, 6)],
    exifIfd: [eRational(false, 0x829a, [1, 125])],
  }));
  const seg2 = exifSegment(buildTiff({
    littleEndian: true,
    ifd0: [eAscii(true, 0x010f, "Canon\0"), eShort(true, 0x0112, 6)],
    exifIfd: [eRational(true, 0x829a, [1, 125]), eShort(true, 0x8827, 800)],
  }));
  const input = minimalJpeg([seg1, seg2]);
  const { bytes: out, preview } = exportSanitized(input);
  assert.equal(preview.fields.length, 4);
  assert.equal(segmentsOf(out, 0xe1).length, 1);
  assert.deepEqual(byName(preview, "ISOSpeedRatings"), { kind: "uint", values: [800] });
  assert.deepEqual(exportSanitized(out).bytes, out);
});

test("多 EXIF 段：保留字段冲突则整体失败", () => {
  const seg1 = exifSegment(buildTiff({ ifd0: [eShort(false, 0x0112, 6)] }));
  const seg2 = exifSegment(buildTiff({ ifd0: [eShort(false, 0x0112, 3)] }));
  const input = minimalJpeg([seg1, seg2]);
  assert.throws(() => exportSanitized(input), JpegPrivacyError);
  assert.throws(() => previewMetadata(input), JpegPrivacyError);
});

test("目录或值越界：预览与导出均失败，不产出候选图片", () => {
  // 保留字段值偏移越界
  const badTiff = buildTiff({ ifd0: [eAscii(false, 0x010f, "Canon\0")] });
  new DataView(badTiff.buffer).setUint32(8 + 2 + 8, 0x00fffff0);
  const input1 = minimalJpeg([exifSegment(badTiff)]);
  assert.throws(() => exportSanitized(input1), JpegPrivacyError);
  assert.throws(() => previewMetadata(input1), JpegPrivacyError);

  // ExifIFD 指针越界
  const badTiff2 = buildTiff({ ifd0: [eLong(false, 0x8769, 0x00fffff0)] });
  const input2 = minimalJpeg([exifSegment(badTiff2)]);
  assert.throws(() => exportSanitized(input2), JpegPrivacyError);

  // 段长度越界（结构截断）
  const truncated = concat(markerOnly(0xd8), bytes(0xff, 0xe1, 0xff, 0xff, 0x45, 0x78));
  assert.throws(() => exportSanitized(truncated), JpegPrivacyError);
});

test("无任何白名单字段时 EXIF 段整体消失", () => {
  const tiff = buildTiff({
    ifd0: [eAscii(false, 0x0131, "John Doe\0"), eAscii(false, 0x0132, "2024:01:02 03:04:05\0")],
    gps: [GPS_LAT],
  });
  const input = minimalJpeg([exifSegment(tiff)]);
  const { bytes: out, preview } = exportSanitized(input);
  assert.equal(preview.fields.length, 0);
  assert.equal(segmentsOf(out, 0xe1).length, 0);
  assert.ok(!contains(out, ascii("John Doe")));
  assert.ok(!contains(out, GPS_LAT_BYTES));
  assert.deepEqual(exportSanitized(out).bytes, out);
});

test("无 EXIF 时输出仅删除非保留段，JFIF 无缩略图版本逐字节稳定", () => {
  const input = minimalJpeg([jfifSegment(), COM]);
  const { bytes: out } = exportSanitized(input);
  const expected = minimalJpeg([jfifSegment()]);
  assert.deepEqual(out, expected);
});

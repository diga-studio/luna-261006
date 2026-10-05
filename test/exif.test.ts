import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWhitelistFields, mergeWhitelistFields } from "../src/exif.js";
import { JpegPrivacyError } from "../src/errors.js";
import { buildTiff, eAscii, eShort, eLong, eRational, eRaw, bytes, concat } from "./fixtures.js";

const EXIF_HEADER = bytes(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);

function payloadOf(tiff: Uint8Array): Uint8Array {
  return concat(EXIF_HEADER, tiff);
}

test("大端 TIFF：内联与偏移字段提取", () => {
  const tiff = buildTiff({
    littleEndian: false,
    ifd0: [
      eAscii(false, 0x010f, "Canon\0"),
      eAscii(false, 0x0110, "EOS R5\0"),
      eShort(false, 0x0112, 6),
      eAscii(false, 0x0131, "John Doe\0"), // Artist，删除
    ],
    exifIfd: [
      eRational(false, 0x829a, [1, 125]),
      eRational(false, 0x829d, [28, 10]),
      eShort(false, 0x8827, 400),
      eRational(false, 0x920a, [50, 1]),
      eLong(false, 0x9000, 0x30323230), // ExifVersion 之外字段，删除
    ],
  });
  const fields = extractWhitelistFields(payloadOf(tiff));
  const byName = new Map(fields.map((f) => [f.name, f]));
  assert.equal(byName.get("Make")?.value.kind, "ascii");
  assert.deepEqual(byName.get("Make")?.value, { kind: "ascii", text: "Canon" });
  assert.deepEqual(byName.get("Model")?.value, { kind: "ascii", text: "EOS R5" });
  assert.deepEqual(byName.get("Orientation")?.value, { kind: "uint", values: [6] });
  assert.deepEqual(byName.get("ExposureTime")?.value, { kind: "rational", values: [[1, 125]] });
  assert.deepEqual(byName.get("FNumber")?.value, { kind: "rational", values: [[28, 10]] });
  assert.deepEqual(byName.get("ISOSpeedRatings")?.value, { kind: "uint", values: [400] });
  assert.deepEqual(byName.get("FocalLength")?.value, { kind: "rational", values: [[50, 1]] });
  assert.equal(fields.length, 7);
});

test("小端 TIFF：强制偏移的短值与 GPS/MakerNote/缩略图共存", () => {
  const tiff = buildTiff({
    littleEndian: true,
    ifd0: [
      eAscii(true, 0x010f, "NIKON\0"),
      eShort(true, 0x0112, 1), // Orientation 内联
      eShort(true, 0x8827, 100, 200, 400), // 3 个 SHORT 走偏移
      eRaw(0x927c, 7, 4, bytes(0xde, 0xad, 0xbe, 0xef)), // MakerNote
    ],
    gps: [eRational(true, 0x0002, [39, 1], [54, 1], [23, 1])],
    ifd1: { entries: [], thumbnail: bytes(0xff, 0xd8, 0x99, 0x99) },
  });
  const fields = extractWhitelistFields(payloadOf(tiff));
  assert.equal(fields.length, 3);
  const byName = new Map(fields.map((f) => [f.name, f]));
  assert.deepEqual(byName.get("Make")?.value, { kind: "ascii", text: "NIKON" });
  assert.deepEqual(byName.get("Orientation")?.value, { kind: "uint", values: [1] });
  assert.deepEqual(byName.get("ISOSpeedRatings")?.value, { kind: "uint", values: [100, 200, 400] });
});

test("GPS 指针等被删除区域内容损坏不影响提取（不解析其内部）", () => {
  const tiff = buildTiff({ ifd0: [eLong(false, 0x8825, 0xffffff00), eShort(false, 0x0112, 1)] });
  const fields = extractWhitelistFields(payloadOf(tiff));
  assert.equal(fields.length, 1);
});

test("结构损坏：IFD0 偏移越界 / 值越界 / ExifIFD 指针越界均失败", () => {
  // IFD0 偏移越界
  const bad1 = new Uint8Array(8);
  bad1.set([0x4d, 0x4d, 0x00, 0x2a, 0xff, 0xff, 0xff, 0x00]);
  assert.throws(() => extractWhitelistFields(payloadOf(bad1)), JpegPrivacyError);
  // 保留字段值偏移越界
  const bad2 = buildTiff({ ifd0: [eAscii(false, 0x010f, "Canon\0")] });
  const v = new DataView(bad2.buffer);
  v.setUint32(8 + 2 + 8, 0x00fffff0); // Make 的值偏移改成越界
  assert.throws(() => extractWhitelistFields(payloadOf(bad2)), JpegPrivacyError);
  // ExifIFD 指针越界
  const bad3 = buildTiff({ ifd0: [eLong(false, 0x8769, 0x00fffff0)] });
  assert.throws(() => extractWhitelistFields(payloadOf(bad3)), JpegPrivacyError);
  // 魔数错误
  const bad4 = new Uint8Array(8);
  bad4.set([0x4d, 0x4d, 0x00, 0x2b, 0, 0, 0, 8]);
  assert.throws(() => extractWhitelistFields(payloadOf(bad4)), JpegPrivacyError);
  // 缺少 Exif 头
  assert.throws(() => extractWhitelistFields(bytes(1, 2, 3)), JpegPrivacyError);
});

test("目录条目数越界失败", () => {
  const tiff = new Uint8Array(10);
  const v = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  v.setUint16(8, 500); // 条目数远超文件长度
  assert.throws(() => extractWhitelistFields(payloadOf(tiff)), JpegPrivacyError);
});

test("合并：一致重复保留一份，冲突整体失败", () => {
  const seg1 = extractWhitelistFields(
    payloadOf(buildTiff({ ifd0: [eAscii(false, 0x010f, "Canon\0"), eShort(false, 0x0112, 6)] })),
  );
  const seg2 = extractWhitelistFields(
    payloadOf(buildTiff({ littleEndian: true, ifd0: [eAscii(true, 0x010f, "Canon\0"), eShort(true, 0x0112, 6)] })),
  );
  const merged = mergeWhitelistFields([seg1, seg2]);
  assert.equal(merged.length, 2);

  const seg3 = extractWhitelistFields(
    payloadOf(buildTiff({ ifd0: [eShort(false, 0x0112, 3)] })),
  );
  assert.throws(() => mergeWhitelistFields([seg1, seg3]), JpegPrivacyError);
});

test("合并：有理数按分子分母比较（不同字节序下同值不冲突）", () => {
  const be = extractWhitelistFields(
    payloadOf(buildTiff({ exifIfd: [eRational(false, 0x829a, [1, 125])], ifd0: [] })),
  );
  const le = extractWhitelistFields(
    payloadOf(buildTiff({ littleEndian: true, exifIfd: [eRational(true, 0x829a, [1, 125])], ifd0: [] })),
  );
  assert.equal(mergeWhitelistFields([be, le]).length, 1);
  const different = extractWhitelistFields(
    payloadOf(buildTiff({ exifIfd: [eRational(false, 0x829a, [2, 250])], ifd0: [] })),
  );
  assert.throws(() => mergeWhitelistFields([be, different]), JpegPrivacyError);
});

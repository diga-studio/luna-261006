import { test } from "node:test";
import assert from "node:assert/strict";
import { previewKeptFields, sanitizeJpeg } from "../src/index.ts";
import * as b from "./helpers/jpeg-builder.ts";

const ICC_PART1 = "ICC_PROFILE_PART_ONE_BYTES";
const ICC_PART2 = "ICC_PROFILE_PART_TWO_BYTES";
const COM_BETWEEN_SCANS = "COM_BETWEEN_SCANS_PRIVATE";
const XMP_BETWEEN_SCANS = "<xmp>INTER_SCAN_SECRET</xmp>";

// Entropy-coded data containing stuffed 0xFF 0x00 bytes, restart markers
// 0xFF D0-D7 and 0xFF fill padding before the next marker.
const SCAN1 = new Uint8Array([
  0x01, 0x02, 0xff, 0x00, 0x03, 0xff, 0xd0, 0x04, 0x05, 0xff, 0xd1, 0x06,
]);
const SCAN2 = new Uint8Array([
  0x11, 0xff, 0x00, 0x12, 0xff, 0xd7, 0x13, 0xff, 0xff, 0xff,
]);
const SCAN3 = new Uint8Array([0x21, 0x22, 0xff, 0x00, 0x23, 0xff, 0xff]);

function buildInput(): Uint8Array {
  return b.jpeg(
    b.jfifApp0(),
    b.adobeApp14(1),
    b.iccApp2(1, 2, b.ascii(ICC_PART1)),
    b.dqt(),
    b.sof(0xc2, 32, 24),
    b.dht(),
    b.sos(SCAN1),
    b.com(COM_BETWEEN_SCANS),
    b.xmpApp1(XMP_BETWEEN_SCANS),
    b.iccApp2(2, 2, b.ascii(ICC_PART2)),
    b.sos(SCAN2),
    b.appn(3, b.ascii("APP3_PRIVATE_DATA")),
    b.sos(SCAN3),
  );
}

test("progressive multi-scan: metadata cleaned, scans and ICC preserved", () => {
  const input = buildInput();
  const output = sanitizeJpeg(input);

  const inputSegments = b.walkSegments(input);
  const outputSegments = b.walkSegments(output);

  // Every scan's entropy data survives byte for byte, in order.
  const inputScans = inputSegments.filter((s) => s.marker === 0xda).map((s) => s.scanData!);
  const outputScans = outputSegments.filter((s) => s.marker === 0xda).map((s) => s.scanData!);
  assert.equal(outputScans.length, 3);
  assert.deepEqual(outputScans, inputScans);
  assert.deepEqual(outputScans[0], SCAN1);
  assert.deepEqual(outputScans[1], SCAN2);
  assert.deepEqual(outputScans[2], SCAN3);

  // Coding markers are byte-identical.
  for (const marker of [0xdb, 0xc2, 0xc4]) {
    const before = inputSegments.find((s) => s.marker === marker)!;
    const after = outputSegments.find((s) => s.marker === marker)!;
    assert.deepEqual(after.data, before.data);
  }

  // ICC segments survive in order with identical content and sequence numbers.
  const iccSegments = outputSegments.filter(
    (s) => s.marker === 0xe2 && b.containsBytes(s.data.subarray(0, 12), b.ascii("ICC_PROFILE")),
  );
  assert.equal(iccSegments.length, 2);
  assert.equal(iccSegments[0]!.data[12], 1);
  assert.equal(iccSegments[0]!.data[13], 2);
  assert.deepEqual(iccSegments[0]!.data.subarray(14), b.ascii(ICC_PART1));
  assert.equal(iccSegments[1]!.data[12], 2);
  assert.equal(iccSegments[1]!.data[13], 2);
  assert.deepEqual(iccSegments[1]!.data.subarray(14), b.ascii(ICC_PART2));

  // Adobe color interpretation survives.
  const adobe = outputSegments.find((s) => s.marker === 0xee)!;
  assert.deepEqual(adobe.data, b.adobeApp14(1).subarray(4));

  // Inter-scan metadata is gone, including from the byte stream as a whole.
  assert.ok(!b.containsBytes(output, b.ascii(COM_BETWEEN_SCANS)));
  assert.ok(!b.containsBytes(output, b.ascii(XMP_BETWEEN_SCANS)));
  assert.ok(!b.containsBytes(output, b.ascii("APP3_PRIVATE_DATA")));
  assert.ok(!outputSegments.some((s) => s.marker === 0xfe));
  assert.ok(!outputSegments.some((s) => s.marker === 0xe3));

  // No EXIF in, no EXIF out; preview is empty.
  assert.deepEqual(previewKeptFields(output), []);

  // Re-exporting a sanitized file changes nothing.
  assert.deepEqual(sanitizeJpeg(output), output);
});

test("EXIF segment between scans follows the same rules", () => {
  const v = b.tiffValues("II");
  const tiff = b.buildTiff({
    byteOrder: "II",
    ifd0: [
      { tag: 0x0112, type: 3, count: 1, value: v.short(3) },
      { tag: 0x0132, type: 2, count: 20, value: v.ascii("2024:06:01 00:00:00") },
    ],
    exifIfd: [{ tag: 0x920a, type: 5, count: 1, value: v.rational([85, 1]) }],
  });
  const input = b.jpeg(
    b.dqt(),
    b.sof(0xc2, 16, 16),
    b.dht(),
    b.sos(SCAN1),
    b.exifApp1(tiff),
    b.sos(SCAN2),
  );
  const output = sanitizeJpeg(input);

  const preview = previewKeptFields(output);
  const byName = new Map(preview.map((f) => [f.name, f]));
  assert.deepEqual(byName.get("Orientation")!.value, { kind: "integers", values: [3] });
  assert.deepEqual(byName.get("FocalLength")!.value, {
    kind: "rationals",
    values: [{ numerator: 85, denominator: 1 }],
  });
  assert.ok(!b.containsBytes(output, b.ascii("2024:06:01 00:00:00")));

  const scans = b.walkSegments(output).filter((s) => s.marker === 0xda);
  assert.deepEqual(scans[0]!.scanData, SCAN1);
  assert.deepEqual(scans[1]!.scanData, SCAN2);
  assert.deepEqual(sanitizeJpeg(output), output);
});

test("EXIF segment without any whitelisted field is removed entirely", () => {
  const v = b.tiffValues("MM");
  const tiff = b.buildTiff({
    byteOrder: "MM",
    ifd0: [
      { tag: 0x0132, type: 2, count: 20, value: v.ascii("2024:06:01 00:00:00") },
      { tag: 0x010e, type: 2, count: 9, value: v.ascii("OWNER_XX") },
    ],
    gpsIfd: [{ tag: 0x0001, type: 2, count: 2, value: b.ascii("N\0") }],
  });
  const input = b.jpeg(
    b.exifApp1(tiff),
    b.dqt(),
    b.sof(0xc0, 8, 8),
    b.dht(),
    b.sos(SCAN3),
  );
  const output = sanitizeJpeg(input);
  const segments = b.walkSegments(output);
  assert.ok(!segments.some((s) => s.marker === 0xe1));
  assert.deepEqual(previewKeptFields(output), []);
  assert.ok(!b.containsBytes(output, b.ascii("OWNER_XX")));
  assert.deepEqual(sanitizeJpeg(output), output);
});

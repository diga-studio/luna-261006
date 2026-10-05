import { test } from "node:test";
import assert from "node:assert/strict";
import { JpegPrivacyError, previewKeptFields, sanitizeJpeg } from "../src/index.ts";
import * as b from "./helpers/jpeg-builder.ts";

function minimalJpeg(...meta: Uint8Array[]): Uint8Array {
  return b.jpeg(
    ...meta,
    b.dqt(),
    b.sof(0xc0, 8, 8),
    b.dht(),
    b.sos(new Uint8Array([0x42, 0xff, 0x00, 0x43])),
  );
}

function exifWith(order: "II" | "MM", orientation: number, exposure: [number, number]): Uint8Array {
  const v = b.tiffValues(order);
  return b.buildTiff({
    byteOrder: order,
    ifd0: [
      { tag: 0x010f, type: 2, count: 6, value: v.ascii("Canon") },
      { tag: 0x0112, type: 3, count: 1, value: v.short(orientation) },
    ],
    exifIfd: [
      { tag: 0x829a, type: 5, count: 1, value: v.rational(exposure) },
      { tag: 0x8827, type: 3, count: 1, value: v.short(200) },
    ],
  });
}

test("identical kept fields across EXIF segments merge into one", () => {
  // Same decoded values, different byte orders and encodings.
  const first = b.exifApp1(exifWith("II", 6, [1, 125]));
  const secondTiff = (() => {
    const v = b.tiffValues("MM");
    return b.buildTiff({
      byteOrder: "MM",
      ifd0: [
        { tag: 0x010f, type: 2, count: 6, value: v.ascii("Canon") },
        { tag: 0x0112, type: 3, count: 1, value: v.short(6) },
        { tag: 0x0110, type: 2, count: 6, value: v.ascii("EOS R") },
      ],
      exifIfd: [
        { tag: 0x829a, type: 5, count: 1, value: v.rational([1, 125]) },
        { tag: 0x8827, type: 3, count: 1, value: v.short(200) },
      ],
    });
  })();
  const input = minimalJpeg(first, b.exifApp1(secondTiff));
  const output = sanitizeJpeg(input);

  const segments = b.walkSegments(output);
  const exifCount = segments.filter(
    (s) => s.marker === 0xe1 && b.containsBytes(s.data.subarray(0, 6), b.ascii("Exif")),
  ).length;
  assert.equal(exifCount, 1, "merged into a single EXIF segment");

  const preview = previewKeptFields(output);
  assert.deepEqual(preview, previewKeptFields(input));
  const byName = new Map(preview.map((f) => [f.name, f]));
  assert.deepEqual(byName.get("Orientation")!.value, { kind: "integers", values: [6] });
  assert.deepEqual(byName.get("ExposureTime")!.value, {
    kind: "rationals",
    values: [{ numerator: 1, denominator: 125 }],
  });
  // Field present in only one of the segments is kept.
  assert.deepEqual(byName.get("Model")!.value, { kind: "ascii", text: "EOS R" });

  assert.deepEqual(sanitizeJpeg(output), output);
});

test("conflicting kept fields across EXIF segments fail the whole export", () => {
  const input = minimalJpeg(b.exifApp1(exifWith("II", 6, [1, 125])), b.exifApp1(exifWith("II", 3, [1, 125])));
  assert.throws(() => sanitizeJpeg(input), (error: unknown) => {
    assert.ok(error instanceof JpegPrivacyError);
    assert.equal(error.code, "CONFLICTING_EXIF");
    return true;
  });
  assert.throws(() => previewKeptFields(input), JpegPrivacyError);
});

test("conflicting rational values fail even with equal quotients", () => {
  // 1/2 vs 2/4: same quotient, different numerator/denominator.
  const a = exifWith("MM", 1, [1, 2]);
  const bTiff = exifWith("MM", 1, [2, 4]);
  const input = minimalJpeg(b.exifApp1(a), b.exifApp1(bTiff));
  assert.throws(() => sanitizeJpeg(input), (error: unknown) => {
    assert.ok(error instanceof JpegPrivacyError);
    assert.equal(error.code, "CONFLICTING_EXIF");
    return true;
  });
});

test("conflicting ASCII bytes fail", () => {
  const v = b.tiffValues("II");
  const make = (text: string) =>
    b.buildTiff({
      byteOrder: "II",
      ifd0: [{ tag: 0x010f, type: 2, count: text.length + 1, value: v.ascii(text) }],
    });
  const input = minimalJpeg(b.exifApp1(make("Canon")), b.exifApp1(make("canon")));
  assert.throws(() => sanitizeJpeg(input), JpegPrivacyError);
});

function corrupt(tiff: Uint8Array, offset: number, value: number): Uint8Array {
  const out = tiff.slice();
  out[offset] = value;
  return out;
}

test("structurally damaged EXIF fails instead of producing a candidate", () => {
  const good = exifWith("II", 1, [1, 60]);

  // Bad TIFF magic number.
  const badMagic = corrupt(good, 2, 0xff);
  assert.throws(
    () => sanitizeJpeg(minimalJpeg(b.exifApp1(badMagic))),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_EXIF",
  );

  // IFD0 offset points past the end of the EXIF data.
  const badIfdOffset = good.slice();
  badIfdOffset[4] = 0x7f;
  badIfdOffset[5] = 0xff;
  badIfdOffset[6] = 0xff;
  badIfdOffset[7] = 0xff;
  assert.throws(
    () => sanitizeJpeg(minimalJpeg(b.exifApp1(badIfdOffset))),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_EXIF",
  );

  // Kept field value offset out of bounds (Make is a 6-byte ASCII via offset).
  const v = b.tiffValues("II");
  const outOfBoundsValue = b.buildTiff({
    byteOrder: "II",
    ifd0: [{ tag: 0x010f, type: 2, count: 6, value: v.ascii("Canon") }],
  });
  // Find the Make entry (first entry of IFD0 at offset 8): value offset at 8+2+8.
  const view = new DataView(outOfBoundsValue.buffer);
  view.setUint32(8 + 2 + 8, outOfBoundsValue.length + 100, true);
  assert.throws(
    () => sanitizeJpeg(minimalJpeg(b.exifApp1(outOfBoundsValue))),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_EXIF",
  );

  // IFD entry count extends past the end of the data.
  const hugeCount = good.slice();
  hugeCount[8] = 0xff;
  hugeCount[9] = 0x7f;
  assert.throws(
    () => sanitizeJpeg(minimalJpeg(b.exifApp1(hugeCount))),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_EXIF",
  );

  // ExifIFD pointer references outside the EXIF data.
  const badPointer = good.slice();
  const ifd0Count = badPointer[8]! | (badPointer[9]! << 8);
  for (let i = 0; i < ifd0Count; i += 1) {
    const entryOffset = 8 + 2 + i * 12;
    const tag = badPointer[entryOffset]! | (badPointer[entryOffset + 1]! << 8);
    if (tag === 0x8769) {
      badPointer[entryOffset + 8] = 0xff;
      badPointer[entryOffset + 9] = 0x7f;
    }
  }
  assert.throws(
    () => sanitizeJpeg(minimalJpeg(b.exifApp1(badPointer))),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_EXIF",
  );
});

test("undeterminable JPEG structure fails", () => {
  const good = minimalJpeg();

  // Not a JPEG at all.
  assert.throws(
    () => sanitizeJpeg(b.ascii("not a jpeg file")),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_JPEG",
  );

  // Missing EOI.
  assert.throws(
    () => sanitizeJpeg(good.subarray(0, good.length - 2)),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_JPEG",
  );

  // Truncated inside a segment.
  assert.throws(
    () => sanitizeJpeg(good.subarray(0, 10)),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "INVALID_JPEG",
  );

  // Lossless SOF3 is out of scope.
  const lossless = b.jpeg(
    b.dqt(),
    b.seg(0xc3, b.sof(0xc0, 8, 8).subarray(4)),
    b.dht(),
    b.sos(new Uint8Array([0x42])),
  );
  assert.throws(
    () => sanitizeJpeg(lossless),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "UNSUPPORTED_JPEG",
  );

  // 12-bit precision is out of scope.
  const twelveBit = b.sof(0xc0, 8, 8);
  twelveBit[4] = 12;
  assert.throws(
    () => sanitizeJpeg(b.jpeg(b.dqt(), twelveBit, b.dht(), b.sos(new Uint8Array([0x42])))),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "UNSUPPORTED_JPEG",
  );

  // Unknown structural marker: structure cannot be fully determined.
  const unknown = b.jpeg(
    b.dqt(),
    b.sof(0xc0, 8, 8),
    b.dht(),
    b.seg(0xf0, new Uint8Array([1, 2, 3])),
    b.sos(new Uint8Array([0x42])),
  );
  assert.throws(
    () => sanitizeJpeg(unknown),
    (error: unknown) => error instanceof JpegPrivacyError && error.code === "UNSUPPORTED_JPEG",
  );
});

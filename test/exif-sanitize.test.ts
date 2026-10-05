import { test } from "node:test";
import assert from "node:assert/strict";
import { previewKeptFields, sanitizeJpeg } from "../src/index.ts";
import type { KeptFieldPreview } from "../src/index.ts";
import * as b from "./helpers/jpeg-builder.ts";

const OWNER = "OWNER_NAME_JOHN_PHOTOGRAPHER";
const SERIAL = "SERIAL_NO_9384756";
const DATETIME = "2024:05:01 12:34:56";
const COPYRIGHT = "COPYRIGHT_ACME_STUDIO";
const USER_COMMENT = "USER_COMMENT_PRIVATE_NOTE";
const MAKER_NOTE = "MAKERNOTE_SECRET_PAYLOAD_0123456789";
const THUMBNAIL = "THUMBNAIL_UNCROPPED_CONTENT_BYTES";
const TIFF_GARBAGE = "UNREACHABLE_TIFF_GARBAGE";
const XMP_BODY = "<x:xmpmeta>SECRET_XMP_PACKET</x:xmpmeta>";
const IPTC_BODY = "IPTC_CAPTION_PRIVATE";
const COM_BODY = "COM_PRIVATE_COMMENT";
const JFIF_THUMB = "JFIF_THUMB_PIXS_18";
const JFXX_THUMB = "JFXX_THUMB_PIXELS_X";
const TRAILING = "TRAILING_TRASH_AFTER_EOI";

const SCAN_ENTROPY = new Uint8Array([
  0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44, 0xff, 0xff, 0xff,
]);

function buildExifTiff(order: "II" | "MM"): Uint8Array {
  const v = b.tiffValues(order);
  return b.buildTiff({
    byteOrder: order,
    ifd0: [
      { tag: 0x010f, type: 2, count: 6, value: v.ascii("Canon") },
      { tag: 0x0110, type: 2, count: 13, value: v.ascii("Canon EOS 5D") },
      { tag: 0x0112, type: 3, count: 1, value: v.short(6) },
      { tag: 0x0132, type: 2, count: 20, value: v.ascii(DATETIME) },
      { tag: 0x010e, type: 2, count: OWNER.length + 1, value: v.ascii(OWNER) },
      { tag: 0xa431, type: 2, count: SERIAL.length + 1, value: v.ascii(SERIAL) },
      { tag: 0x8298, type: 2, count: COPYRIGHT.length + 1, value: v.ascii(COPYRIGHT) },
    ],
    exifIfd: [
      { tag: 0x829a, type: 5, count: 1, value: v.rational([1, 125]) },
      { tag: 0x829d, type: 5, count: 1, value: v.rational([28, 10]) },
      { tag: 0x8827, type: 3, count: 1, value: v.short(400) },
      { tag: 0x920a, type: 5, count: 1, value: v.rational([50, 1]) },
      { tag: 0x927c, type: 7, count: MAKER_NOTE.length, value: b.ascii(MAKER_NOTE) },
      {
        tag: 0x9286,
        type: 7,
        count: USER_COMMENT.length + 8,
        value: b.concat(b.ascii("ASCII\0\0\0"), b.ascii(USER_COMMENT)),
      },
      { tag: 0x9000, type: 7, count: 4, value: b.ascii("0232") },
    ],
    gpsIfd: [
      { tag: 0x0000, type: 1, count: 4, value: new Uint8Array([2, 3, 0, 0]) },
      { tag: 0x0001, type: 2, count: 2, value: b.ascii("N\0") },
      { tag: 0x0002, type: 5, count: 3, value: v.rational([31, 1], [12, 1], [30, 1]) },
      { tag: 0x0003, type: 2, count: 2, value: b.ascii("E\0") },
      { tag: 0x0004, type: 5, count: 3, value: v.rational([121, 1], [30, 1], [15, 1]) },
    ],
    ifd1: [{ tag: 0x0103, type: 3, count: 1, value: v.short(6) }],
    thumbnail: b.ascii(THUMBNAIL),
    trailingGarbage: b.ascii(TIFF_GARBAGE),
  });
}

function buildInput(order: "II" | "MM"): Uint8Array {
  return b.jpeg(
    b.jfifApp0({ thumbnail: b.ascii(JFIF_THUMB) }),
    b.jfxxApp0(b.ascii(JFXX_THUMB)),
    b.exifApp1(buildExifTiff(order)),
    b.xmpApp1(XMP_BODY),
    b.appn(13, b.ascii(IPTC_BODY)),
    b.com(COM_BODY),
    b.dqt(),
    b.sof(0xc0, 16, 16),
    b.dht(),
    b.sos(SCAN_ENTROPY),
    b.EOI,
    b.ascii(TRAILING),
  );
}

const EXPECTED_PREVIEW: KeptFieldPreview[] = [
  {
    ifd: "IFD0",
    tag: 0x010f,
    name: "Make",
    type: 2,
    count: 6,
    value: { kind: "ascii", text: "Canon" },
  },
  {
    ifd: "IFD0",
    tag: 0x0110,
    name: "Model",
    type: 2,
    count: 13,
    value: { kind: "ascii", text: "Canon EOS 5D" },
  },
  {
    ifd: "IFD0",
    tag: 0x0112,
    name: "Orientation",
    type: 3,
    count: 1,
    value: { kind: "integers", values: [6] },
  },
  {
    ifd: "ExifIFD",
    tag: 0x829a,
    name: "ExposureTime",
    type: 5,
    count: 1,
    value: { kind: "rationals", values: [{ numerator: 1, denominator: 125 }] },
  },
  {
    ifd: "ExifIFD",
    tag: 0x829d,
    name: "FNumber",
    type: 5,
    count: 1,
    value: { kind: "rationals", values: [{ numerator: 28, denominator: 10 }] },
  },
  {
    ifd: "ExifIFD",
    tag: 0x8827,
    name: "ISOSpeedRatings",
    type: 3,
    count: 1,
    value: { kind: "integers", values: [400] },
  },
  {
    ifd: "ExifIFD",
    tag: 0x920a,
    name: "FocalLength",
    type: 5,
    count: 1,
    value: { kind: "rationals", values: [{ numerator: 50, denominator: 1 }] },
  },
];

for (const order of ["II", "MM"] as const) {
  test(`sanitize keeps whitelist and removes private data (${order})`, () => {
    const input = buildInput(order);
    const output = sanitizeJpeg(input);

    // Whitelist fields survive with exact types, counts and decoded values.
    assert.deepEqual(previewKeptFields(output), EXPECTED_PREVIEW);
    // Preview of the input agrees with what the export actually kept.
    assert.deepEqual(previewKeptFields(input), previewKeptFields(output));

    // Private content is gone from every byte of the output, including old
    // directories, padding and unreachable regions.
    const gpsLat = b.tiffValues(order).rational([31, 1], [12, 1], [30, 1]);
    const gpsLon = b.tiffValues(order).rational([121, 1], [30, 1], [15, 1]);
    for (const needle of [
      b.ascii(OWNER),
      b.ascii(SERIAL),
      b.ascii(DATETIME),
      b.ascii(COPYRIGHT),
      b.ascii(USER_COMMENT),
      b.ascii(MAKER_NOTE),
      b.ascii(THUMBNAIL),
      b.ascii(TIFF_GARBAGE),
      b.ascii(XMP_BODY),
      b.ascii(IPTC_BODY),
      b.ascii(COM_BODY),
      b.ascii(JFIF_THUMB),
      b.ascii(JFXX_THUMB),
      b.ascii(TRAILING),
      gpsLat,
      gpsLon,
    ]) {
      assert.ok(!b.containsBytes(output, needle), `output still contains ${needle}`);
    }

    // Coding markers and scan data are byte-identical to the input.
    const inputSegments = b.walkSegments(input);
    const outputSegments = b.walkSegments(output);
    for (const marker of [0xdb, 0xc0, 0xc4, 0xda]) {
      const before = inputSegments.find((s) => s.marker === marker)!;
      const after = outputSegments.find((s) => s.marker === marker)!;
      assert.ok(after !== undefined, `missing marker 0x${marker.toString(16)}`);
      assert.deepEqual(after.data, before.data);
      if (marker === 0xda) {
        assert.deepEqual(after.scanData, before.scanData);
        assert.deepEqual(after.scanData, SCAN_ENTROPY);
      }
    }

    // JFIF display parameters survive but the thumbnail is removed.
    const jfif = outputSegments.find((s) => s.marker === 0xe0)!;
    assert.equal(jfif.data.length, 14);
    assert.deepEqual(jfif.data.subarray(0, 12), inputSegments[0]!.data.subarray(0, 12));
    assert.equal(jfif.data[12], 0);
    assert.equal(jfif.data[13], 0);

    // Exactly one EXIF segment remains.
    const exifSegments = outputSegments.filter(
      (s) => s.marker === 0xe1 && b.containsBytes(s.data.subarray(0, 6), b.ascii("Exif")),
    );
    assert.equal(exifSegments.length, 1);

    // Re-exporting a sanitized file changes nothing.
    assert.deepEqual(sanitizeJpeg(output), output);
  });
}

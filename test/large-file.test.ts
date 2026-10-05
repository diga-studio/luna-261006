import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeJpeg } from "../src/index.ts";
import * as b from "./helpers/jpeg-builder.ts";

test("handles a 25 MiB multi-scan file with many EXIF segments", () => {
  // ~25 MiB of entropy data across 8 scans, including stuffing and restarts.
  const chunk = new Uint8Array([
    0x10, 0xff, 0x00, 0x20, 0xff, 0xd0, 0x30, 0x40,
  ]);
  const scanSize = Math.ceil((25 * 1024 * 1024) / 8);
  const scan = new Uint8Array(scanSize);
  for (let i = 0; i < scanSize; i += chunk.length) {
    scan.set(chunk.subarray(0, Math.min(chunk.length, scanSize - i)), i);
  }

  const v = b.tiffValues("MM");
  const makeExif = () =>
    b.exifApp1(
      b.buildTiff({
        byteOrder: "MM",
        ifd0: [
          { tag: 0x010f, type: 2, count: 6, value: v.ascii("Canon") },
          { tag: 0x0112, type: 3, count: 1, value: v.short(1) },
        ],
        exifIfd: [{ tag: 0x8827, type: 3, count: 1, value: v.short(100) }],
      }),
    );

  const parts: Uint8Array[] = [b.jfifApp0()];
  for (let i = 0; i < 8; i += 1) {
    parts.push(makeExif());
  }
  parts.push(b.dqt(), b.sof(0xc2, 4096, 4096), b.dht());
  for (let i = 0; i < 8; i += 1) {
    parts.push(b.sos(scan));
    if (i < 7) {
      parts.push(b.com(`INTER_SCAN_COMMENT_${i}`));
    }
  }
  const input = b.jpeg(...parts);
  assert.ok(input.length >= 25 * 1024 * 1024);

  const started = Date.now();
  const output = sanitizeJpeg(input);
  const elapsed = Date.now() - started;

  // All scan data survives byte-identical; comments are gone.
  const inputScans = b.walkSegments(input).filter((s) => s.marker === 0xda);
  const outputScans = b.walkSegments(output).filter((s) => s.marker === 0xda);
  assert.equal(outputScans.length, 8);
  for (let i = 0; i < 8; i += 1) {
    assert.deepEqual(outputScans[i]!.scanData, inputScans[i]!.scanData);
  }
  assert.ok(!b.containsBytes(output, b.ascii("INTER_SCAN_COMMENT_0")));
  assert.deepEqual(sanitizeJpeg(output), output);
  console.log(`    25 MiB sanitize took ${elapsed}ms`);
});

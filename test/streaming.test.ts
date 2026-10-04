import { test } from "node:test";
import assert from "node:assert/strict";
import { Mp3Probe } from "../src/mp3probe";
import { concat, makeId3v1, makeId3v2Header, makeId3v2Footer, vbrFrames } from "./helpers";

const BUFFER_LIMIT = 64 * 1024;

test("128 MiB ID3v2 body streams without buffering it", () => {
  const bodySize = 128 * 1024 * 1024;
  const frames = vbrFrames(2000, 0, 0, 0xff);
  const audio = concat(frames);

  const probe = new Mp3Probe();
  let maxBuffered = 0;
  const check = () => {
    maxBuffered = Math.max(maxBuffered, probe.bufferedBytes);
    assert.ok(
      probe.bufferedBytes <= BUFFER_LIMIT,
      `buffered ${probe.bufferedBytes} bytes`,
    );
  };

  // ID3v2.4 tag with footer, declared up front.
  probe.push(makeId3v2Header(bodySize, 4, true));
  check();

  // Lazily generated body: small chunks of pseudo-sync bytes, never
  // materializing the whole 128 MiB in one array.
  const chunk = new Uint8Array(65536).fill(0xff);
  let remaining = bodySize;
  while (remaining > 0) {
    const n = Math.min(remaining, chunk.length);
    probe.push(chunk.subarray(0, n)); // reused buffer, copied only if retained
    remaining -= n;
    check();
  }
  probe.push(makeId3v2Footer(bodySize, 4));
  check();

  // Valid audio, fed in small irregular pieces.
  let off = 0;
  while (off < audio.length) {
    const n = Math.min(1000, audio.length - off);
    probe.push(audio.subarray(off, off + n));
    off += n;
    check();
  }

  // ID3v1 trailer.
  probe.push(makeId3v1());
  check();

  const result = probe.finish();
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.audioFrames, 2000);
  assert.equal(result.playableSamples, 2000 * 1152);
  assert.equal(result.inRange, true); // ~52.2 s
  assert.ok(maxBuffered <= BUFFER_LIMIT, `peak buffer ${maxBuffered}`);
});

test("peak retained bytes stay tiny regardless of tag size", () => {
  for (const bodySize of [0, 1, 1024, 1024 * 1024]) {
    const probe = new Mp3Probe();
    let peak = 0;
    probe.push(makeId3v2Header(bodySize, 3));
    const chunk = new Uint8Array(4096);
    let remaining = bodySize;
    while (remaining > 0) {
      const n = Math.min(remaining, chunk.length);
      probe.push(chunk.subarray(0, n));
      remaining -= n;
      peak = Math.max(peak, probe.bufferedBytes);
    }
    probe.push(concat(vbrFrames(1200, 0, 0)));
    peak = Math.max(peak, probe.bufferedBytes);
    const result = probe.finish();
    assert.equal(result.audioFrames, 1200);
    assert.ok(peak <= 1024, `bodySize ${bodySize}: peak ${peak}`);
  }
});

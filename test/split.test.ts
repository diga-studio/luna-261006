import { test } from "node:test";
import assert from "node:assert/strict";
import { Mp3Probe, Mp3ProbeResult } from "../src/mp3probe";
import {
  FrameSpec,
  concat,
  frameLength,
  makeId3v1,
  makeId3v2Header,
  makeXingCarrier,
  vbrFrames,
} from "./helpers";

function makeShortSample(): { bytes: Uint8Array; expected: Mp3ProbeResult } {
  // ID3v2.4 tag (with footer) + Xing carrier + 6 VBR frames + ID3v1.
  const id3Body = new Uint8Array(300).fill(0xff); // pseudo-sync bytes inside tag
  const id3Header = makeId3v2Header(id3Body.length, 4, true);
  const id3Footer = makeId3v2Header(id3Body.length, 4, true);
  id3Footer.set([0x33, 0x44, 0x49], 0);

  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 };
  const frames = vbrFrames(6, 0, 0, 0xff); // bodies full of 0xff pseudo-syncs
  const totalBytes =
    frameLength(carrierSpec) + frames.reduce((n, f) => n + f.length, 0);
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: 6,
    declaredBytes: totalBytes,
    withToc: true,
    withQuality: true,
    encoderDelay: 25,
    endPadding: 11,
  });
  const bytes = concat([id3Header, id3Body, id3Footer, carrier, ...frames, makeId3v1(0xff)]);
  return {
    bytes,
    expected: {
      sampleRate: 44100,
      audioFrames: 6,
      playableSamples: 6 * 1152 - 36,
      inRange: false,
    },
  };
}

test("result is identical for every two-chunk split point", () => {
  const { bytes, expected } = makeShortSample();
  for (let split = 0; split <= bytes.length; split++) {
    const probe = new Mp3Probe();
    probe.push(bytes.subarray(0, split));
    probe.push(bytes.subarray(split));
    assert.deepEqual(probe.finish(), expected, `split at ${split}`);
  }
});

test("result is identical for byte-by-byte and random-size chunks", () => {
  const { bytes, expected } = makeShortSample();
  const bytewise = new Mp3Probe();
  for (let i = 0; i < bytes.length; i++) bytewise.push(bytes.subarray(i, i + 1));
  assert.deepEqual(bytewise.finish(), expected);

  const random = new Mp3Probe();
  let off = 0;
  let seed = 42;
  while (off < bytes.length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (seed % 97);
    random.push(bytes.subarray(off, Math.min(off + n, bytes.length)));
    off += n;
  }
  assert.deepEqual(random.finish(), expected);
});

test("short non-Xing sample: every split point, samples counted independently", () => {
  const frames = vbrFrames(5, 1, 3, 0xff); // 48000 Hz mono
  const bytes = concat(frames);
  const expected: Mp3ProbeResult = {
    sampleRate: 48000,
    audioFrames: 5,
    playableSamples: 5 * 1152,
    inRange: false,
  };
  for (let split = 0; split <= bytes.length; split++) {
    const probe = new Mp3Probe();
    probe.push(bytes.subarray(0, split));
    probe.push(bytes.subarray(split));
    assert.deepEqual(probe.finish(), expected, `split at ${split}`);
  }
});

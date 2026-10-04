import { test } from "node:test";
import assert from "node:assert/strict";
import { Mp3Probe, Mp3ProbeError } from "../src/mp3probe";
import {
  FrameSpec,
  concat,
  frameLength,
  makeXingCarrier,
  vbrFrames,
} from "./helpers";

const STEREO = 0;
const MONO = 3;

interface XingSample {
  bytes: Uint8Array;
  audioFrames: number;
  playableSamples: number;
  sampleRate: number;
}

function buildXingSample(opts: {
  audioFrames: number;
  sampleRateIndex?: number;
  channelMode?: number;
  encoderDelay: number;
  endPadding: number;
  declaredFrames?: number;
  declaredBytes?: number;
  fill?: number;
}): XingSample {
  const sampleRateIndex = opts.sampleRateIndex ?? 0;
  const channelMode = opts.channelMode ?? STEREO;
  const frames = vbrFrames(opts.audioFrames, sampleRateIndex, channelMode, opts.fill ?? 0x00);
  const carrierSpec: FrameSpec = {
    bitrateIndex: 9,
    sampleRateIndex,
    padding: 0,
    channelMode,
  };
  const audioBytes = frames.reduce((n, f) => n + f.length, 0);
  const totalBytes = frameLength(carrierSpec) + audioBytes;
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: opts.declaredFrames ?? opts.audioFrames,
    declaredBytes: opts.declaredBytes ?? totalBytes,
    withToc: true,
    withQuality: true,
    encoderDelay: opts.encoderDelay,
    endPadding: opts.endPadding,
  });
  return {
    bytes: concat([carrier, ...frames]),
    audioFrames: opts.audioFrames,
    playableSamples: opts.audioFrames * 1152 - opts.encoderDelay - opts.endPadding,
    sampleRate: [44100, 48000, 32000][sampleRateIndex]!,
  };
}

function probeOnce(bytes: Uint8Array) {
  const probe = new Mp3Probe();
  probe.push(bytes);
  return probe.finish();
}

test("plain CBR stream without Xing", () => {
  const frames = vbrFrames(100, 0, STEREO);
  const result = probeOnce(concat(frames));
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.audioFrames, 100);
  assert.equal(result.playableSamples, 100 * 1152);
  assert.equal(result.inRange, false); // ~2.6 s
});

test("Xing carrier is metadata-only and trims delay/padding", () => {
  const sample = buildXingSample({ audioFrames: 2000, encoderDelay: 576, endPadding: 72 });
  const result = probeOnce(sample.bytes);
  assert.equal(result.audioFrames, 2000);
  assert.equal(result.playableSamples, 2000 * 1152 - 648);
  assert.equal(result.inRange, true); // ~52 s
});

test("empty chunks and caller buffer reuse are safe", () => {
  const sample = buildXingSample({ audioFrames: 50, encoderDelay: 10, endPadding: 5 });
  const probe = new Mp3Probe();
  probe.push(new Uint8Array(0));
  const reusable = new Uint8Array(sample.bytes.length);
  reusable.set(sample.bytes);
  probe.push(reusable);
  reusable.fill(0xaa); // caller reuses the array after push returns
  probe.push(new Uint8Array(0));
  const result = probe.finish();
  assert.equal(result.playableSamples, 50 * 1152 - 15);
});

// 30 s and 600 s boundaries, exact to the sample, at 44100 Hz.
// 30 s = 1323000 samples; 600 s = 26460000 samples.
const boundaryCases: Array<[string, number, number, number, boolean]> = [
  ["30s minus 1 sample", 1149, 577, 72, false], // playable 1322999
  ["30s exactly", 1149, 576, 72, true], // playable 1323000
  ["30s plus 1 sample", 1149, 575, 72, true], // playable 1323001
  ["600s minus 1 sample", 22969, 217, 72, true], // playable 26459999
  ["600s exactly", 22969, 216, 72, true], // playable 26460000
  ["600s plus 1 sample", 22969, 215, 72, false], // playable 26460001
];

for (const [name, frames, delay, padding, expected] of boundaryCases) {
  test(`inRange boundary: ${name}`, () => {
    const sample = buildXingSample({
      audioFrames: frames,
      encoderDelay: delay,
      endPadding: padding,
    });
    assert.equal(sample.playableSamples, frames * 1152 - delay - padding);
    const result = probeOnce(sample.bytes);
    assert.equal(result.playableSamples, sample.playableSamples);
    assert.equal(result.inRange, expected);
  });
}

test("mono Xing stream with Info marker", () => {
  const frames = vbrFrames(1200, 0, MONO);
  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: MONO };
  const totalBytes = frameLength(carrierSpec) + frames.reduce((n, f) => n + f.length, 0);
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Info",
    declaredFrames: 1200,
    declaredBytes: totalBytes,
    encoderDelay: 0,
    endPadding: 0,
  });
  const result = probeOnce(concat([carrier, ...frames]));
  assert.equal(result.audioFrames, 1200);
  assert.equal(result.playableSamples, 1200 * 1152);
  assert.equal(result.inRange, true); // ~31.3 s
});

test("errors carry stable codes", () => {
  const probe = new Mp3Probe();
  assert.throws(
    () => probe.finish(),
    (err: unknown) => err instanceof Mp3ProbeError && err.code === "ERR_NO_AUDIO",
  );
});

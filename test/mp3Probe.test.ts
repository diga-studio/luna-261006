import { test, assert } from './nodeShims';
import { Mp3Probe, Mp3ProbeResult } from '../src/mp3Probe';
import { Mp3ProbeError } from '../src/errors';
import {
  makeFrame, makeXingFrame, makeId3v2Header, makeId3v2Footer,
  makeId3v1, concat, frameLength, FrameOptions,
} from './helpers';

const SR = 44100;

function run(data: Uint8Array, chunkSize = 1 << 16): Mp3ProbeResult {
  const p = new Mp3Probe();
  for (let off = 0; off < data.length; off += chunkSize) {
    p.push(data.subarray(off, Math.min(off + chunkSize, data.length)));
  }
  return p.finish();
}

function runSplit(data: Uint8Array, split: number): Mp3ProbeResult {
  const p = new Mp3Probe();
  p.push(data.subarray(0, split));
  p.push(data.subarray(split));
  return p.finish();
}

// VBR stream: Xing carrier + audio frames with varying bitrate/padding.
function vbrStream(audioFrameCount: number, encoderDelay: number, endPadding: number) {
  const pattern: FrameOptions[] = [
    { bitrateKbps: 128, padding: 0 },
    { bitrateKbps: 192, padding: 1 },
    { bitrateKbps: 96, padding: 0 },
    { bitrateKbps: 320, padding: 1 },
    { bitrateKbps: 64, padding: 0 },
  ];
  const audio: Uint8Array[] = [];
  for (let i = 0; i < audioFrameCount; i++) {
    audio.push(makeFrame(pattern[i % pattern.length]!));
  }
  const audioBytes = audio.reduce((n, f) => n + f.length, 0);
  const carrierBytes = frameLength({ bitrateKbps: 128, padding: 0 });
  const xing = makeXingFrame({
    declaredFrames: audioFrameCount,
    declaredBytes: carrierBytes + audioBytes,
    encoderDelay,
    endPadding,
    includeToc: true,
    includeQuality: true,
  });
  return concat(xing, ...audio);
}

test('VBR stream with LAME trimming: 30s boundary exact', () => {
  const target = 30 * SR; // 1_323_000 samples, in range (closed interval)
  const n = 1149; // 1149 * 1152 = 1_323_648
  const trim = n * 1152 - target; // 648
  const data = vbrStream(n, 576, trim - 576);
  const r = run(data, 777);
  assert.equal(r.sampleRate, SR);
  assert.equal(r.audioFrames, n);
  assert.equal(r.playableSamples, target);
  assert.equal(r.inRange, true);
});

test('one sample below 30s is out of range', () => {
  const target = 30 * SR - 1;
  const n = 1149;
  const trim = n * 1152 - target;
  const r = run(vbrStream(n, 576, trim - 576), 4096);
  assert.equal(r.playableSamples, target);
  assert.equal(r.inRange, false);
});

test('one sample above 30s is in range', () => {
  const target = 30 * SR + 1;
  const n = 1149;
  const trim = n * 1152 - target;
  const r = run(vbrStream(n, 576, trim - 576), 4096);
  assert.equal(r.playableSamples, target);
  assert.equal(r.inRange, true);
});

test('600s boundary exact, plus and minus one sample', () => {
  const target = 600 * SR; // 26_460_000
  const n = Math.ceil(target / 1152) + 1; // 22970 -> 26_461_440
  for (const [delta, expected] of [[-1, true], [0, true], [1, false]] as const) {
    const want = target + delta;
    const trim = n * 1152 - want;
    const r = run(vbrStream(n, 576, trim - 576), 1 << 20);
    assert.equal(r.playableSamples, want);
    assert.equal(r.inRange, expected);
  }
});

test('chunking independence: every split point of a short Xing sample', () => {
  const frames = 10;
  const delay = 576;
  const padding = 1105;
  const data = vbrStream(frames, delay, padding);
  const expected = frames * 1152 - delay - padding;
  const base = run(data);
  assert.equal(base.playableSamples, expected);
  for (let i = 0; i <= data.length; i++) {
    const r = runSplit(data, i);
    assert.deepEqual(r, base, `split at ${i}`);
  }
});

test('chunking independence: every split point without Xing', () => {
  const parts = [makeFrame({ bitrateKbps: 128 }), makeFrame({ bitrateKbps: 256, padding: 1 }), makeFrame({})];
  const data = concat(...parts);
  const expected = 3 * 1152;
  for (let i = 0; i <= data.length; i++) {
    const r = runSplit(data, i);
    assert.equal(r.audioFrames, 3, `split at ${i}`);
    assert.equal(r.playableSamples, expected);
    assert.equal(r.inRange, false);
  }
});

test('tampered Xing frame count fails', () => {
  const n = 5;
  const good = vbrStream(n, 576, 100);
  const xing = makeXingFrame({ declaredFrames: n + 1, encoderDelay: 576, endPadding: 100 });
  const bad = concat(xing, good.subarray(xing.length));
  assert.throws(() => run(bad), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'XING_COUNT_MISMATCH');
});

test('tampered Xing byte count fails', () => {
  const n = 5;
  const good = vbrStream(n, 576, 100);
  const xing = makeXingFrame({ declaredFrames: n, declaredBytes: 12345, encoderDelay: 576, endPadding: 100 });
  const bad = concat(xing, good.subarray(xing.length));
  assert.throws(() => run(bad), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'XING_COUNT_MISMATCH');
});

test('unknown Xing flags fail', () => {
  const xing = makeXingFrame({ declaredFrames: 2, encoderDelay: 0, endPadding: 0 });
  // set an unknown flag bit (bit 4) in the flags field
  const sideInfo = 32;
  const flagsOff = 4 + sideInfo + 4;
  xing[flagsOff + 3]! |= 0x10;
  const data = concat(xing, makeFrame(), makeFrame());
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'XING_INVALID');
});

test('missing LAME extension fails', () => {
  const xing = makeXingFrame({ declaredFrames: 2, encoderDelay: 0, endPadding: 0 });
  const sideInfo = 32;
  const lameOff = 4 + sideInfo + 4 + 4 + 4; // hdr + "Xing" + flags + frames
  xing[lameOff] = 0x58; // corrupt "LAME" -> "XAME"
  const data = concat(xing, makeFrame(), makeFrame());
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'XING_INVALID');
});

test('truncated last frame fails', () => {
  const data = vbrStream(8, 576, 100);
  const cut = data.subarray(0, data.length - 3);
  assert.throws(() => run(cut), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'FRAME_TRUNCATED');
});

test('trailing garbage after last frame fails', () => {
  const data = vbrStream(8, 576, 100);
  const dirty = concat(data, new Uint8Array([0x00, 0x11, 0x22]));
  assert.throws(() => run(dirty), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'FRAME_TRUNCATED');
  const dirty4 = concat(data, new Uint8Array([0x00, 0x11, 0x22, 0x33]));
  assert.throws(() => run(dirty4), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'FRAME_HEADER_INVALID');
});

test('ID3v1 tag with pseudo-sync body is accepted and not counted', () => {
  const frames = 6;
  const data = concat(vbrStream(frames, 576, 100), makeId3v1());
  const r = run(data, 511);
  assert.equal(r.audioFrames, frames);
  assert.equal(r.playableSamples, frames * 1152 - 576 - 100);
});

test('garbage after ID3v1 fails', () => {
  const data = concat(vbrStream(6, 576, 100), makeId3v1(), new Uint8Array([0xff]));
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'UNEXPECTED_DATA_AFTER_ID3V1');
});

test('tag between audio frames fails', () => {
  const data = concat(makeFrame(), makeId3v1(), makeFrame());
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'UNEXPECTED_DATA_AFTER_ID3V1');
});

test('ID3v2.3 tag at start is skipped', () => {
  const body = new Uint8Array(300);
  for (let i = 0; i < body.length; i++) body[i] = i % 2 ? 0xff : 0xfb; // pseudo-sync
  const data = concat(makeId3v2Header(body.length, 3), body, makeFrame(), makeFrame());
  const r = run(data, 37);
  assert.equal(r.audioFrames, 2);
  assert.equal(r.playableSamples, 2 * 1152);
});

test('ID3v2.4 with footer is verified and skipped', () => {
  const body = new Uint8Array(123);
  const data = concat(
    makeId3v2Header(body.length, 4, true), body,
    makeId3v2Footer(body.length, 4),
    makeFrame(), makeFrame(), makeFrame(),
  );
  const r = run(data, 29);
  assert.equal(r.audioFrames, 3);
});

test('ID3v2.4 footer mismatch fails', () => {
  const body = new Uint8Array(50);
  const footer = makeId3v2Footer(body.length, 4);
  footer[9]! ^= 0x01; // different size in footer
  const data = concat(makeId3v2Header(body.length, 4, true), body, footer, makeFrame());
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'ID3V2_FOOTER_MISMATCH');
});

test('non-synchsafe ID3v2 size fails', () => {
  const h = makeId3v2Header(10, 4);
  h[9] = 0x80;
  const data = concat(h, new Uint8Array(10), makeFrame());
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'ID3V2_INVALID');
});

test('inconsistent sample rate across frames fails', () => {
  const data = concat(makeFrame({ sampleRate: 44100 }), makeFrame({ sampleRate: 48000 }));
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'INCONSISTENT_STREAM');
});

test('inconsistent channel count across frames fails', () => {
  const data = concat(makeFrame({ channelMode: 0 }), makeFrame({ channelMode: 3 }));
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'INCONSISTENT_STREAM');
});

test('free bitrate and CRC frames are rejected', () => {
  const free = makeFrame();
  free[2] = 0x00; // bitrate index 0
  assert.throws(() => run(concat(free, makeFrame())), Mp3ProbeError);
  const crc = makeFrame();
  crc[1]! &= 0xfe; // protection bit -> CRC present
  assert.throws(() => run(concat(crc, makeFrame())), Mp3ProbeError);
});

test('empty input and tag-only input fail', () => {
  assert.throws(() => run(new Uint8Array(0)), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'NO_AUDIO_FRAMES');
  const onlyTag = concat(makeId3v2Header(20, 3), new Uint8Array(20));
  assert.throws(() => run(onlyTag), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'NO_AUDIO_FRAMES');
});

test('negative playable samples fail', () => {
  const xing = makeXingFrame({ declaredFrames: 1, encoderDelay: 4095, endPadding: 4095 });
  const data = concat(xing, makeFrame());
  assert.throws(() => run(data), (e: unknown) => e instanceof Mp3ProbeError && e.code === 'NEGATIVE_PLAYABLE');
});

test('caller may reuse the pushed array', () => {
  const frame = makeFrame();
  const data = concat(makeFrame(), makeFrame(), makeFrame());
  const p = new Mp3Probe();
  const scratch = new Uint8Array(64);
  for (let off = 0; off < data.length; off += scratch.length) {
    const n = Math.min(scratch.length, data.length - off);
    scratch.set(data.subarray(off, off + n));
    p.push(scratch.subarray(0, n));
    scratch.fill(0); // caller clobbers the array
  }
  const r = p.finish();
  assert.equal(r.audioFrames, 3);
  assert.equal(r.playableSamples, 3 * 1152);
});

test('128 MiB ID3v2 body streamed lazily with bounded buffer', () => {
  const bodyLen = 128 * 1024 * 1024;
  const audio = [makeFrame({ bitrateKbps: 160 }), makeFrame({ bitrateKbps: 96, padding: 1 })];
  const p = new Mp3Probe();
  p.push(makeId3v2Header(bodyLen, 4, true));
  const chunk = new Uint8Array(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 2 ? 0xff : 0xfb;
  let sent = 0;
  while (sent < bodyLen) {
    const n = Math.min(chunk.length, bodyLen - sent);
    p.push(chunk.subarray(0, n));
    sent += n;
    const retained = (p as unknown as { token: Uint8Array }).token.length;
    assert.ok(retained <= 64 * 1024, `retained ${retained} bytes`);
  }
  p.push(makeId3v2Footer(bodyLen, 4));
  for (const f of audio) p.push(f);
  p.push(makeId3v1());
  const r = p.finish();
  assert.equal(r.sampleRate, SR);
  assert.equal(r.audioFrames, 2);
  assert.equal(r.playableSamples, 2 * 1152);
  assert.equal(r.inRange, false);
});

test('empty chunks are no-ops', () => {
  const p = new Mp3Probe();
  p.push(new Uint8Array(0));
  p.push(makeFrame());
  p.push(new Uint8Array(0));
  p.push(makeFrame());
  const r = p.finish();
  assert.equal(r.audioFrames, 2);
});

test('chunking independence: stream with ID3v2.4+footer and ID3v1', () => {
  const body = new Uint8Array(200);
  for (let i = 0; i < body.length; i++) body[i] = i % 2 ? 0xff : 0xfb;
  const data = concat(
    makeId3v2Header(body.length, 4, true), body, makeId3v2Footer(body.length, 4),
    makeFrame({ bitrateKbps: 112 }), makeFrame({ bitrateKbps: 224, padding: 1 }),
    makeId3v1(),
  );
  const base = run(data);
  assert.equal(base.audioFrames, 2);
  assert.equal(base.playableSamples, 2 * 1152);
  for (let i = 0; i <= data.length; i++) {
    assert.deepEqual(runSplit(data, i), base, `split at ${i}`);
  }
});

test('Info tag variant of the metadata carrier', () => {
  const xing = makeXingFrame({ tag: 'Info', declaredFrames: 3, encoderDelay: 100, endPadding: 200 });
  const data = concat(xing, makeFrame(), makeFrame(), makeFrame());
  const r = run(data, 63);
  assert.equal(r.audioFrames, 3);
  assert.equal(r.playableSamples, 3 * 1152 - 300);
});

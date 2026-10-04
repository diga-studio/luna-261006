import { test } from "node:test";
import assert from "node:assert/strict";
import { Mp3Probe, Mp3ProbeError } from "../src/mp3probe";
import {
  FrameSpec,
  concat,
  frameLength,
  makeFrame,
  makeId3v1,
  makeId3v2Header,
  makeXingCarrier,
  vbrFrames,
} from "./helpers";

function expectCode(code: string, fn: () => unknown) {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof Mp3ProbeError, `expected Mp3ProbeError, got ${err}`);
      assert.equal(err.code, code);
      return true;
    },
  );
}

function xingSample(opts: { declaredFrames?: number; declaredBytes?: number } = {}) {
  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 };
  const frames = vbrFrames(10, 0, 0);
  const totalBytes = frameLength(carrierSpec) + frames.reduce((n, f) => n + f.length, 0);
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: opts.declaredFrames ?? 10,
    declaredBytes: opts.declaredBytes ?? totalBytes,
    encoderDelay: 0,
    endPadding: 0,
  });
  return concat([carrier, ...frames]);
}

test("tampered Xing frame count fails", () => {
  expectCode("ERR_XING_MISMATCH", () => {
    const p = new Mp3Probe();
    p.push(xingSample({ declaredFrames: 11 }));
    p.finish();
  });
  expectCode("ERR_XING_MISMATCH", () => {
    const p = new Mp3Probe();
    p.push(xingSample({ declaredFrames: 9 }));
    p.finish();
  });
});

test("tampered Xing byte count fails", () => {
  const good = xingSample();
  const carrierLen = frameLength({ bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 });
  const total = good.length;
  for (const bad of [total - 1, total + 1]) {
    expectCode("ERR_XING_MISMATCH", () => {
      const p = new Mp3Probe();
      p.push(xingSample({ declaredBytes: bad }));
      p.finish();
    });
  }
  assert.ok(carrierLen > 0);
});

test("truncated last frame fails", () => {
  const bytes = concat(vbrFrames(5, 0, 0));
  for (const cut of [1, 2, 50]) {
    expectCode("ERR_FRAME_TRUNCATED", () => {
      const p = new Mp3Probe();
      p.push(bytes.subarray(0, bytes.length - cut));
      p.finish();
    });
  }
});

test("truncated mid-stream fails even with valid metadata", () => {
  const bytes = xingSample();
  expectCode("ERR_FRAME_TRUNCATED", () => {
    const p = new Mp3Probe();
    p.push(bytes.subarray(0, bytes.length - 3));
    p.finish();
  });
});

test("trailing garbage after frames fails", () => {
  const bytes = concat(vbrFrames(5, 0, 0));
  expectCode("ERR_FRAME_HEADER", () => {
    const p = new Mp3Probe();
    p.push(concat([bytes, new Uint8Array([0x00])]));
    p.finish();
  });
});

test("garbage between frames fails (no resync)", () => {
  const frames = vbrFrames(6, 0, 0);
  const withGarbage = concat([...frames.slice(0, 3), new Uint8Array([0x12, 0x34]), ...frames.slice(3)]);
  expectCode("ERR_FRAME_HEADER", () => {
    const p = new Mp3Probe();
    p.push(withGarbage);
    p.finish();
  });
});

test("bytes after ID3v1 tag fail", () => {
  const bytes = concat([...vbrFrames(5, 0, 0), makeId3v1(), new Uint8Array([0x00])]);
  expectCode("ERR_TRAILING_GARBAGE", () => {
    const p = new Mp3Probe();
    p.push(bytes);
    p.finish();
  });
});

test("ID3v1 tag between frames fails", () => {
  const frames = vbrFrames(6, 0, 0);
  const bytes = concat([...frames.slice(0, 3), makeId3v1(), ...frames.slice(3)]);
  expectCode("ERR_TRAILING_GARBAGE", () => {
    const p = new Mp3Probe();
    p.push(bytes);
    p.finish();
  });
});

test("truncated ID3v1 tag fails", () => {
  const bytes = concat([...vbrFrames(5, 0, 0), makeId3v1().subarray(0, 100)]);
  expectCode("ERR_ID3V1", () => {
    const p = new Mp3Probe();
    p.push(bytes);
    p.finish();
  });
});

test("pseudo-sync bytes inside frame bodies and tags do not create frames", () => {
  const id3Body = new Uint8Array(513).fill(0xff);
  const frames = vbrFrames(7, 0, 0, 0xff);
  const bytes = concat([makeId3v2Header(id3Body.length, 3), id3Body, ...frames, makeId3v1(0xff)]);
  const p = new Mp3Probe();
  p.push(bytes);
  const result = p.finish();
  assert.equal(result.audioFrames, 7);
  assert.equal(result.playableSamples, 7 * 1152);
});

test("CRC-protected frame rejected", () => {
  const frame = makeFrame({ bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 });
  frame[1] = frame[1]! & 0xfe; // protection bit: CRC present
  expectCode("ERR_FRAME_HEADER", () => {
    const p = new Mp3Probe();
    p.push(frame);
    p.finish();
  });
});

test("free-format bitrate rejected", () => {
  const frame = makeFrame({ bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 });
  frame[2] = frame[2]! & 0x0f; // bitrate index 0 = free
  expectCode("ERR_FRAME_HEADER", () => {
    const p = new Mp3Probe();
    p.push(frame);
    p.finish();
  });
});

test("MPEG-2 frame rejected", () => {
  const frame = makeFrame({ bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 });
  frame[1] = 0xe0 | 0x10 | 0x02 | 0x01; // version bits 10 = MPEG-2
  expectCode("ERR_FRAME_HEADER", () => {
    const p = new Mp3Probe();
    p.push(frame);
    p.finish();
  });
});

test("sample rate change mid-stream fails", () => {
  const a = vbrFrames(3, 0, 0);
  const b = vbrFrames(3, 1, 0); // 48000 Hz after 44100 Hz
  expectCode("ERR_INCONSISTENT_FORMAT", () => {
    const p = new Mp3Probe();
    p.push(concat([...a, ...b]));
    p.finish();
  });
});

test("channel count change mid-stream fails", () => {
  const a = vbrFrames(3, 0, 0);
  const b = vbrFrames(3, 0, 3); // stereo then mono
  expectCode("ERR_INCONSISTENT_FORMAT", () => {
    const p = new Mp3Probe();
    p.push(concat([...a, ...b]));
    p.finish();
  });
});

test("invalid ID3v2 headers fail", () => {
  const frames = concat(vbrFrames(3, 0, 0));
  // unsupported version
  const badVersion = makeId3v2Header(10, 3);
  badVersion[3] = 5;
  expectCode("ERR_ID3V2_HEADER", () => {
    const p = new Mp3Probe();
    p.push(concat([badVersion, new Uint8Array(10), frames]));
    p.finish();
  });
  // non-synchsafe size
  const badSize = makeId3v2Header(10, 3);
  badSize[9] = 0x80;
  expectCode("ERR_ID3V2_HEADER", () => {
    const p = new Mp3Probe();
    p.push(concat([badSize, new Uint8Array(10), frames]));
    p.finish();
  });
  // unknown flag bits
  const badFlags = makeId3v2Header(10, 4);
  badFlags[5] = 0x0f;
  expectCode("ERR_ID3V2_HEADER", () => {
    const p = new Mp3Probe();
    p.push(concat([badFlags, new Uint8Array(10), frames]));
    p.finish();
  });
});

test("ID3v2.4 footer mismatch fails", () => {
  const frames = concat(vbrFrames(3, 0, 0));
  const body = new Uint8Array(20);
  const header = makeId3v2Header(body.length, 4, true);
  const footer = makeId3v2Header(body.length, 4, true);
  footer.set([0x33, 0x44, 0x49], 0);
  footer[9] = footer[9]! ^ 0x01; // size no longer matches header
  expectCode("ERR_ID3V2_FOOTER", () => {
    const p = new Mp3Probe();
    p.push(concat([header, body, footer, frames]));
    p.finish();
  });
});

test("missing ID3v2.4 footer fails", () => {
  const frames = concat(vbrFrames(3, 0, 0));
  const body = new Uint8Array(20);
  const header = makeId3v2Header(body.length, 4, true);
  expectCode("ERR_ID3V2_FOOTER", () => {
    const p = new Mp3Probe();
    // first 10 frame bytes take the footer's place and fail the 3DI check
    p.push(concat([header, body, frames]));
    p.finish();
  });
});

test("Xing with unknown flags fails", () => {
  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 };
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: 3,
    declaredBytes: 0,
    encoderDelay: 0,
    endPadding: 0,
  });
  carrier[4 + 32 + 7] = carrier[4 + 32 + 7]! | 0x10; // set an unknown flag bit
  expectCode("ERR_XING", () => {
    const p = new Mp3Probe();
    p.push(concat([carrier, ...vbrFrames(3, 0, 0)]));
    p.finish();
  });
});

test("Xing without LAME extension fails", () => {
  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 };
  const frames = vbrFrames(3, 0, 0);
  const total = frameLength(carrierSpec) + frames.reduce((n, f) => n + f.length, 0);
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: 3,
    declaredBytes: total,
    encoderDelay: 0,
    endPadding: 0,
  });
  const lameOff = 4 + 32 + 8 + 8; // after marker+flags+frames+bytes
  carrier[lameOff] = 0x58; // "XAME" instead of "LAME"
  expectCode("ERR_XING", () => {
    const p = new Mp3Probe();
    p.push(concat([carrier, ...frames]));
    p.finish();
  });
});

test("zero audio frames after Xing carrier fails", () => {
  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 };
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: 0,
    declaredBytes: frameLength(carrierSpec),
    encoderDelay: 0,
    endPadding: 0,
  });
  expectCode("ERR_NO_AUDIO", () => {
    const p = new Mp3Probe();
    p.push(carrier);
    p.finish();
  });
});

test("delay+padding exceeding total samples fails", () => {
  const carrierSpec: FrameSpec = { bitrateIndex: 9, sampleRateIndex: 0, padding: 0, channelMode: 0 };
  const frames = vbrFrames(2, 0, 0); // 2304 samples
  const total = frameLength(carrierSpec) + frames.reduce((n, f) => n + f.length, 0);
  const carrier = makeXingCarrier({
    ...carrierSpec,
    marker: "Xing",
    declaredFrames: 2,
    declaredBytes: total,
    encoderDelay: 4095,
    endPadding: 4095,
  });
  expectCode("ERR_NO_AUDIO", () => {
    const p = new Mp3Probe();
    p.push(concat([carrier, ...frames]));
    p.finish();
  });
});

test("push after finish fails", () => {
  const p = new Mp3Probe();
  p.push(concat(vbrFrames(3, 0, 0)));
  p.finish();
  expectCode("ERR_PUSH_AFTER_FINISH", () => p.push(new Uint8Array([0xff])));
});

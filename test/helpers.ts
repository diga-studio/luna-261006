import { BITRATE_KBPS, SAMPLE_RATES } from "../src/tables";

export interface FrameSpec {
  bitrateIndex: number; // 1..14
  sampleRateIndex: number; // 0..2
  padding: number; // 0|1
  channelMode: number; // 0..3 (3 = mono)
  fill?: number; // body fill byte
}

export function frameLength(spec: FrameSpec): number {
  const kbps = BITRATE_KBPS[spec.bitrateIndex]!;
  const rate = SAMPLE_RATES[spec.sampleRateIndex]!;
  return Math.floor((144000 * kbps) / rate) + spec.padding;
}

export function makeFrame(spec: FrameSpec): Uint8Array {
  const len = frameLength(spec);
  const out = new Uint8Array(len).fill(spec.fill ?? 0x00);
  out[0] = 0xff;
  out[1] = 0xe0 | 0x18 | 0x02 | 0x01; // sync, MPEG-1, Layer III, no CRC
  out[2] = (spec.bitrateIndex << 4) | (spec.sampleRateIndex << 2) | (spec.padding << 1);
  out[3] = spec.channelMode << 6;
  return out;
}

export interface XingSpec extends FrameSpec {
  marker: "Xing" | "Info";
  declaredFrames: number | null;
  declaredBytes: number | null;
  withToc?: boolean;
  withQuality?: boolean;
  encoderDelay: number; // 0..4095
  endPadding: number; // 0..4095
}

export function makeXingCarrier(spec: XingSpec): Uint8Array {
  const frame = makeFrame(spec);
  const xoff = 4 + (spec.channelMode === 3 ? 17 : 32);
  let flags = 0;
  if (spec.declaredFrames !== null) flags |= 1;
  if (spec.declaredBytes !== null) flags |= 2;
  if (spec.withToc) flags |= 4;
  if (spec.withQuality) flags |= 8;
  frame.set([0x58, 0x69, 0x6e, 0x67], xoff); // "Xing"
  if (spec.marker === "Info") frame.set([0x49, 0x6e, 0x66, 0x6f], xoff);
  frame[xoff + 4] = (flags >>> 24) & 0xff;
  frame[xoff + 5] = (flags >>> 16) & 0xff;
  frame[xoff + 6] = (flags >>> 8) & 0xff;
  frame[xoff + 7] = flags & 0xff;
  let cursor = xoff + 8;
  const putU32 = (v: number) => {
    frame[cursor] = (v >>> 24) & 0xff;
    frame[cursor + 1] = (v >>> 16) & 0xff;
    frame[cursor + 2] = (v >>> 8) & 0xff;
    frame[cursor + 3] = v & 0xff;
    cursor += 4;
  };
  if (spec.declaredFrames !== null) putU32(spec.declaredFrames);
  if (spec.declaredBytes !== null) putU32(spec.declaredBytes);
  if (spec.withToc) cursor += 100;
  if (spec.withQuality) cursor += 4;
  frame.set([0x4c, 0x41, 0x4d, 0x45], cursor); // "LAME"
  const lame = cursor;
  frame[lame + 21] = (spec.encoderDelay >> 4) & 0xff;
  frame[lame + 22] = ((spec.encoderDelay & 0x0f) << 4) | ((spec.endPadding >> 8) & 0x0f);
  frame[lame + 23] = spec.endPadding & 0xff;
  return frame;
}

export function makeId3v2Header(bodySize: number, version: 3 | 4, footer = false): Uint8Array {
  const out = new Uint8Array(10);
  out.set([0x49, 0x44, 0x33, version, 0x00], 0);
  out[5] = version === 4 && footer ? 0x10 : 0x00;
  out[6] = (bodySize >>> 21) & 0x7f;
  out[7] = (bodySize >>> 14) & 0x7f;
  out[8] = (bodySize >>> 7) & 0x7f;
  out[9] = bodySize & 0x7f;
  return out;
}

export function makeId3v2Footer(bodySize: number, version: 3 | 4): Uint8Array {
  const out = makeId3v2Header(bodySize, version, true);
  out.set([0x33, 0x44, 0x49], 0); // "3DI"
  return out;
}

export function makeId3v1(fill = 0x00): Uint8Array {
  const out = new Uint8Array(128).fill(fill);
  out.set([0x54, 0x41, 0x47], 0); // "TAG"
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A VBR audio-frame sequence with varying bitrate and padding. */
export function vbrFrames(
  count: number,
  sampleRateIndex: number,
  channelMode: number,
  fill = 0x00,
): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      makeFrame({
        bitrateIndex: 1 + ((i * 7) % 14),
        sampleRateIndex,
        padding: i % 2,
        channelMode,
        fill,
      }),
    );
  }
  return frames;
}

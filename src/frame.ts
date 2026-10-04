import { Mp3ProbeError } from "./errors";
import { BITRATE_KBPS, SAMPLE_RATES, FrameHeader } from "./tables";

/**
 * Parses and validates one MPEG-1 Layer III frame header (no CRC,
 * non-free bitrate) at `buf[off .. off+3]`.
 */
export function parseFrameHeader(buf: Uint8Array, off: number): FrameHeader {
  const b0 = buf[off]!;
  const b1 = buf[off + 1]!;
  const b2 = buf[off + 2]!;
  const b3 = buf[off + 3]!;

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "missing frame sync");
  }
  const version = (b1 >> 3) & 0x03;
  if (version !== 0x03) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "not MPEG-1");
  }
  const layer = (b1 >> 1) & 0x03;
  if (layer !== 0x01) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "not Layer III");
  }
  if ((b1 & 0x01) !== 0x01) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "CRC-protected frames are not supported");
  }
  const bitrateIndex = b2 >> 4;
  if (bitrateIndex === 0 || bitrateIndex === 15) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "invalid bitrate index");
  }
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (sampleRateIndex === 3) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "invalid sample rate index");
  }
  const emphasis = b3 & 0x03;
  if (emphasis === 2) {
    throw new Mp3ProbeError("ERR_FRAME_HEADER", "reserved emphasis");
  }

  const bitrateKbps = BITRATE_KBPS[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[sampleRateIndex]!;
  const padding = (b2 >> 1) & 0x01;
  const channelMode = b3 >> 6;
  const channels = channelMode === 3 ? 1 : 2;
  const frameLength = Math.floor((144000 * bitrateKbps) / sampleRate) + padding;

  return { frameLength, bitrateKbps, sampleRate, padding, channels, channelMode };
}

/** Offset of the Xing/Info marker within a frame, from the frame start. */
export function xingOffset(header: FrameHeader): number {
  return 4 + (header.channels === 1 ? 17 : 32);
}

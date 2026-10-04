import { Mp3ProbeError } from './errors';

export const SAMPLES_PER_FRAME = 1152;

const BITRATE_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const SAMPLE_RATES = [44100, 48000, 32000];

export interface FrameHeader {
  readonly sampleRate: number;
  readonly channelMode: number;
  readonly channels: number;
  readonly frameLength: number;
}

export function parseFrameHeader(b0: number, b1: number, b2: number, b3: number): FrameHeader {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'missing sync word');
  }
  const version = (b1 >> 3) & 0x3;
  if (version !== 0x3) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'not MPEG-1');
  }
  const layer = (b1 >> 1) & 0x3;
  if (layer !== 0x1) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'not Layer III');
  }
  const protection = b1 & 0x1;
  if (protection !== 1) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'CRC-protected frames not supported');
  }
  const bitrateIndex = (b2 >> 4) & 0xf;
  if (bitrateIndex === 0 || bitrateIndex === 15) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'free or invalid bitrate');
  }
  const sampleIndex = (b2 >> 2) & 0x3;
  if (sampleIndex === 3) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'invalid sample rate index');
  }
  const padding = (b2 >> 1) & 0x1;
  const channelMode = (b3 >> 6) & 0x3;
  const emphasis = b3 & 0x3;
  if (emphasis === 2) {
    throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'reserved emphasis');
  }
  const bitrate = BITRATE_KBPS[bitrateIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[sampleIndex]!;
  const frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;
  return {
    sampleRate,
    channelMode,
    channels: channelMode === 3 ? 1 : 2,
    frameLength,
  };
}

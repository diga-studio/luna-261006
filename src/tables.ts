/** MPEG-1 Layer III bitrate table, kbps, indexed by header bitrate field (1..14). */
export const BITRATE_KBPS: readonly number[] = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

/** MPEG-1 sample rates, Hz, indexed by header sample-rate field (0..2). */
export const SAMPLE_RATES: readonly number[] = [44100, 48000, 32000];

/** Samples per MPEG-1 Layer III audio frame. */
export const SAMPLES_PER_FRAME = 1152;

export interface FrameHeader {
  /** Total frame length in bytes, including the 4-byte header. */
  frameLength: number;
  bitrateKbps: number;
  sampleRate: number;
  padding: number;
  /** Number of channels: 1 for mono, 2 otherwise. */
  channels: number;
  /** Channel mode field (0..3). */
  channelMode: number;
}

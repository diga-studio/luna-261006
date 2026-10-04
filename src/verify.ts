import { createHash } from 'node:crypto';
import { VerifyError } from './errors.js';
import { FileReader, MAX_READ_CHUNK } from './reader.js';
import { parseTopLevel, readMoov, payloadStart, payloadEnd } from './boxes.js';
import { parseMoov } from './moovParse.js';
import { buildSamples, type MdatRange, type Sample } from './sampleTable.js';
import { presentationOrder, validateTimeline } from './timeline.js';
import type { TrustedManifest, VerifySuccess } from './types.js';

const ALLOWED_FRAME_RATES = new Set([12, 24, 30]);

/** 校验清单本身合法：帧率、时长、帧数与哈希格式。 */
export function validateManifest(manifest: TrustedManifest): void {
  if (!Number.isInteger(manifest.width) || manifest.width < 1 || manifest.width > 65535) {
    throw new VerifyError('BAD_MANIFEST', `invalid width ${manifest.width}`);
  }
  if (!Number.isInteger(manifest.height) || manifest.height < 1 || manifest.height > 65535) {
    throw new VerifyError('BAD_MANIFEST', `invalid height ${manifest.height}`);
  }
  if (!ALLOWED_FRAME_RATES.has(manifest.frameRate)) {
    throw new VerifyError('BAD_MANIFEST', `invalid frame rate ${manifest.frameRate}`);
  }
  if (
    !Number.isInteger(manifest.durationSeconds) ||
    manifest.durationSeconds < 5 ||
    manifest.durationSeconds > 30 ||
    manifest.durationSeconds % 5 !== 0
  ) {
    throw new VerifyError('BAD_MANIFEST', `invalid duration ${manifest.durationSeconds}`);
  }
  const expectedFrames = manifest.frameRate * manifest.durationSeconds;
  if (manifest.frameSha256.length !== expectedFrames) {
    throw new VerifyError(
      'BAD_MANIFEST',
      `manifest has ${manifest.frameSha256.length} hashes, expected ${expectedFrames}`,
    );
  }
  for (let i = 0; i < manifest.frameSha256.length; i++) {
    if (!/^[0-9a-f]{64}$/.test(manifest.frameSha256[i]!)) {
      throw new VerifyError('BAD_MANIFEST', `manifest hash ${i} is not 64 lowercase hex chars`);
    }
  }
}

/** 流式计算单个样本的 SHA-256（每次最多读 1 MiB）。 */
async function hashSample(reader: FileReader, sample: Sample): Promise<string> {
  const hash = createHash('sha256');
  let offset = sample.offset;
  let remaining = sample.size;
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_READ_CHUNK);
    hash.update(await reader.readAt(offset, step));
    offset += BigInt(step);
    remaining -= step;
  }
  return hash.digest('hex');
}

/** 时长精确相等：value（单位 1/timescale 秒）必须恰等于 seconds 秒。 */
function requireExactDuration(value: bigint, timescale: number, seconds: number, what: string): void {
  if (value !== BigInt(seconds) * BigInt(timescale)) {
    throw new VerifyError(
      'DURATION_MISMATCH',
      `${what} declares ${value}/${timescale}s, expected exactly ${seconds}s`,
    );
  }
}

/** 核验本地 MP4 文件是否符合可信帧清单；失败抛 VerifyError。 */
export async function verifyFile(path: string, manifest: TrustedManifest): Promise<VerifySuccess> {
  validateManifest(manifest);

  const reader = await FileReader.open(path);
  try {
    const top = await parseTopLevel(reader, 0n, reader.size);
    const moovs = top.filter((b) => b.type === 'moov');
    if (moovs.length !== 1) {
      throw new VerifyError('BOX_STRUCTURE', `expected exactly 1 moov, got ${moovs.length}`);
    }
    if (top.some((b) => b.type === 'moof' || b.type === 'mfra')) {
      throw new VerifyError('UNSUPPORTED', 'fragmented MP4 is not supported');
    }
    const mdatRanges: MdatRange[] = top
      .filter((b) => b.type === 'mdat')
      .map((b) => ({ start: payloadStart(b), end: payloadEnd(b) }));
    if (mdatRanges.length === 0) {
      throw new VerifyError('BOX_STRUCTURE', 'no mdat box');
    }

    const moovBuf = await readMoov(reader, moovs[0]!);
    const moov = parseMoov(moovBuf);
    const samples = buildSamples(moovBuf, moov, mdatRanges);

    const expectedFrames = manifest.frameRate * manifest.durationSeconds;
    if (samples.length !== expectedFrames) {
      throw new VerifyError(
        'FRAME_COUNT_MISMATCH',
        `file has ${samples.length} samples, manifest expects ${expectedFrames}`,
      );
    }
    if (moov.width !== manifest.width || moov.height !== manifest.height) {
      throw new VerifyError(
        'GEOMETRY_MISMATCH',
        `avc1 geometry ${moov.width}x${moov.height} != manifest ${manifest.width}x${manifest.height}`,
      );
    }

    requireExactDuration(moov.movieDuration, moov.movieTimescale, manifest.durationSeconds, 'mvhd');
    requireExactDuration(moov.trackDuration, moov.movieTimescale, manifest.durationSeconds, 'tkhd');
    requireExactDuration(moov.mediaDuration, moov.mediaTimescale, manifest.durationSeconds, 'mdhd');
    if (moov.editSegmentDuration !== null) {
      requireExactDuration(moov.editSegmentDuration, moov.movieTimescale, manifest.durationSeconds, 'elst');
    }

    const order = presentationOrder(samples);
    validateTimeline(samples, order, moov.mediaTimescale, manifest.frameRate, moov.editMediaStart);

    for (let rank = 0; rank < order.length; rank++) {
      const digest = await hashSample(reader, samples[order[rank]!]!);
      if (digest !== manifest.frameSha256[rank]) {
        throw new VerifyError('HASH_MISMATCH', `frame ${rank} hash mismatch`);
      }
    }

    return { ok: true, frameCount: samples.length };
  } finally {
    await reader.close();
  }
}

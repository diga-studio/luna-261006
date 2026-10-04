import { VerifyError } from './errors.js';
import type { Sample } from './sampleTable.js';

/** 样本展示时刻（媒体时间尺度单位）。 */
export function presentationTime(sample: Sample): bigint {
  return sample.decodeTime + sample.compositionOffset;
}

/**
 * 按展示时刻升序返回样本索引（解码顺序 → 展示顺序的排列）。
 * 两个样本展示时刻相同则拒绝。
 */
export function presentationOrder(samples: Sample[]): number[] {
  const order = samples.map((_, i) => i);
  order.sort((a, b) => {
    const pa = presentationTime(samples[a]!);
    const pb = presentationTime(samples[b]!);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  for (let k = 1; k < order.length; k++) {
    if (presentationTime(samples[order[k]!]!) === presentationTime(samples[order[k - 1]!]!)) {
      throw new VerifyError('TIMELINE', `duplicate presentation time at rank ${k}`);
    }
  }
  return order;
}

/**
 * 校验展示时间轴：展示时刻减去媒体起点后，第 i 帧必须恰在 i/fps 秒；
 * 且每个样本的解码持续时间必须为 1/fps 秒。全部为整数精确比较。
 */
export function validateTimeline(
  samples: Sample[],
  order: number[],
  mediaTimescale: number,
  frameRate: number,
  editMediaStart: bigint,
): void {
  const ts = BigInt(mediaTimescale);
  const fps = BigInt(frameRate);
  for (let rank = 0; rank < order.length; rank++) {
    const sample = samples[order[rank]!]!;
    const shifted = presentationTime(sample) - editMediaStart;
    if (shifted * fps !== BigInt(rank) * ts) {
      throw new VerifyError(
        'TIMELINE',
        `frame ${rank} presentation time ${shifted} != ${rank}/fps (timescale ${mediaTimescale})`,
      );
    }
    if (sample.decodeDuration * fps !== ts) {
      throw new VerifyError(
        'TIMELINE',
        `frame ${rank} decode duration ${sample.decodeDuration} != 1/fps (timescale ${mediaTimescale})`,
      );
    }
  }
}

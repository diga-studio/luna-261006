import { BANDWIDTH_LIMITS } from "./types.js";
import type {
  BandwidthPreset,
  Direction,
  MediaSection,
  SdpSession,
  VerifyResult,
} from "./types.js";

const OK: VerifyResult = { ok: true };

function fail(reason: string): VerifyResult {
  return { ok: false, reason };
}

function effectiveDirection(session: SdpSession, media: MediaSection): Direction {
  return media.direction ?? session.direction ?? "sendrecv";
}

function canSend(dir: Direction): boolean {
  return dir === "sendrecv" || dir === "sendonly";
}

function canRecv(dir: Direction): boolean {
  return dir === "sendrecv" || dir === "recvonly";
}

function checkSessionBasics(session: SdpSession, label: string): VerifyResult {
  if (session.directionConflict) {
    return fail(`${label}: 会话层方向定义冲突`);
  }
  const seen = new Set<string>();
  for (const media of session.media) {
    if (media.directionConflict) {
      return fail(`${label}: 媒体层方向定义冲突 (mid=${media.mid ?? "?"})`);
    }
    if (media.rtpmapConflict) {
      return fail(`${label}: 同编号载荷映射定义冲突 (mid=${media.mid ?? "?"})`);
    }
    if (media.mid === null || media.mid.length === 0) {
      return fail(`${label}: 媒体缺少 mid`);
    }
    if (seen.has(media.mid)) {
      return fail(`${label}: mid 重复 (${media.mid})`);
    }
    seen.add(media.mid);
  }
  if (session.bundleGroups.length !== 1) {
    return fail(`${label}: 必须恰好有一个 BUNDLE 组`);
  }
  const bundleMids = new Set(session.bundleGroups[0]);
  const activeMids = new Set(
    session.media.filter((m) => !m.rejected).map((m) => m.mid as string),
  );
  if (
    bundleMids.size !== activeMids.size ||
    ![...bundleMids].every((mid) => activeMids.has(mid))
  ) {
    return fail(`${label}: BUNDLE 组成员必须恰为未拒绝媒体的 mid`);
  }
  return OK;
}

function isAllowedCodec(
  kind: "audio" | "video",
  name: string,
  clockRate: number,
  channels: number,
): boolean {
  if (kind === "audio") {
    return name === "opus" && clockRate === 48000 && channels === 2;
  }
  return (
    (name === "vp8" && clockRate === 90000 && channels === 1) ||
    (name === "rtx" && clockRate === 90000 && channels === 1)
  );
}

function parseIntParam(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function checkAcceptedPair(
  offerSession: SdpSession,
  answerSession: SdpSession,
  offerMedia: MediaSection,
  answerMedia: MediaSection,
  preset: BandwidthPreset,
): VerifyResult {
  const offerDir = effectiveDirection(offerSession, offerMedia);
  const answerDir = effectiveDirection(answerSession, answerMedia);
  if (canSend(answerDir) && !canRecv(offerDir)) {
    return fail(`方向不兼容: answer 发送未获 offer 接收许可 (mid=${answerMedia.mid})`);
  }
  if (canRecv(answerDir) && !canSend(offerDir)) {
    return fail(`方向不兼容: answer 接收未获 offer 发送许可 (mid=${answerMedia.mid})`);
  }

  const limit = BANDWIDTH_LIMITS[preset];

  for (const pt of answerMedia.payloadTypes) {
    const answerCodec = answerMedia.codecs.get(pt);
    if (!answerCodec) {
      return fail(`answer 载荷 ${pt} 缺少编码映射 (mid=${answerMedia.mid})`);
    }
    if (!offerMedia.payloadTypes.includes(pt)) {
      return fail(`answer 载荷 ${pt} 不在 offer 对应媒体中 (mid=${answerMedia.mid})`);
    }
    const offerCodec = offerMedia.codecs.get(pt);
    if (
      !offerCodec ||
      offerCodec.name !== answerCodec.name ||
      offerCodec.clockRate !== answerCodec.clockRate ||
      offerCodec.channels !== answerCodec.channels
    ) {
      return fail(`answer 载荷 ${pt} 编码映射与 offer 不一致 (mid=${answerMedia.mid})`);
    }
    if (
      !isAllowedCodec(
        answerMedia.kind,
        answerCodec.name,
        answerCodec.clockRate,
        answerCodec.channels,
      )
    ) {
      return fail(`answer 接受了不允许的编码 ${answerCodec.name} (mid=${answerMedia.mid})`);
    }

    if (answerMedia.kind === "video" && answerCodec.name === "rtx") {
      const answerApt = parseIntParam(answerMedia.fmtpParams.get(pt)?.get("apt"));
      if (answerApt === null) {
        return fail(`RTX 载荷 ${pt} 缺少有效 apt (mid=${answerMedia.mid})`);
      }
      const answerAptCodec = answerMedia.codecs.get(answerApt);
      if (
        !answerMedia.payloadTypes.includes(answerApt) ||
        !answerAptCodec ||
        answerAptCodec.name !== "vp8" ||
        answerAptCodec.clockRate !== 90000
      ) {
        return fail(`RTX apt 未指向 answer 中已接受的 VP8 载荷 (mid=${answerMedia.mid})`);
      }
      const offerApt = parseIntParam(offerMedia.fmtpParams.get(pt)?.get("apt"));
      if (offerApt === null || offerApt !== answerApt) {
        return fail(`两侧 RTX apt 不一致 (mid=${answerMedia.mid})`);
      }
      const offerAptCodec = offerMedia.codecs.get(offerApt);
      if (
        !offerMedia.payloadTypes.includes(offerApt) ||
        !offerAptCodec ||
        offerAptCodec.name !== "vp8" ||
        offerAptCodec.clockRate !== 90000
      ) {
        return fail(`offer 侧 RTX apt 未指向 VP8 载荷 (mid=${answerMedia.mid})`);
      }
    }

    if (answerMedia.kind === "audio" && answerCodec.name === "opus") {
      const answerMax = parseIntParam(
        answerMedia.fmtpParams.get(pt)?.get("maxaveragebitrate"),
      );
      if (answerMax === null) {
        return fail(`已接受 Opus 缺少显式 maxaveragebitrate (mid=${answerMedia.mid})`);
      }
      if (answerMax > limit) {
        return fail(`maxaveragebitrate ${answerMax} 超过预设上限 ${limit}`);
      }
      const offerMax = parseIntParam(
        offerMedia.fmtpParams.get(pt)?.get("maxaveragebitrate"),
      );
      if (offerMax !== null && answerMax > offerMax) {
        return fail(`maxaveragebitrate ${answerMax} 超过 offer 上限 ${offerMax}`);
      }
    }
  }

  return OK;
}

export function verifyNegotiation(
  offer: SdpSession,
  answer: SdpSession,
  preset: BandwidthPreset,
): VerifyResult {
  for (const [session, label] of [
    [offer, "offer"],
    [answer, "answer"],
  ] as const) {
    const basic = checkSessionBasics(session, label);
    if (!basic.ok) return basic;
  }

  if (offer.media.length !== answer.media.length) {
    return fail("answer 媒体数量与 offer 不一致");
  }

  let hasUsableAudio = false;

  for (let i = 0; i < offer.media.length; i++) {
    const offerMedia = offer.media[i];
    const answerMedia = answer.media[i];
    if (answerMedia.kind !== offerMedia.kind) {
      return fail(`第 ${i + 1} 条媒体类型与 offer 不一致`);
    }
    if (answerMedia.mid !== offerMedia.mid) {
      return fail(`第 ${i + 1} 条媒体 mid 与 offer 不一致`);
    }
    if (offerMedia.rejected) {
      if (!answerMedia.rejected) {
        return fail(`offer 已拒绝的媒体不能复活 (mid=${offerMedia.mid})`);
      }
      continue;
    }
    if (answerMedia.rejected) {
      continue;
    }

    if (answerMedia.kind === "video" && preset !== "high") {
      return fail(`带宽预设 ${preset} 下必须拒绝全部视频 (mid=${answerMedia.mid})`);
    }

    const pair = checkAcceptedPair(
      offer,
      answer,
      offerMedia,
      answerMedia,
      preset,
    );
    if (!pair.ok) return pair;

    if (
      answerMedia.kind === "audio" &&
      effectiveDirection(answer, answerMedia) !== "inactive"
    ) {
      hasUsableAudio = true;
    }
  }

  if (!hasUsableAudio) {
    return fail("缺少已接受且方向非 inactive 的音频");
  }

  return OK;
}

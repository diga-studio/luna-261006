import { parseSdp } from "./parser.js";
import type {
  BandwidthPreset,
  Direction,
  MediaSection,
  Sdp,
  VerifyResult,
} from "./types.js";

const PRESET_BITRATE: Record<BandwidthPreset, number> = {
  "ultra-low": 8000,
  standard: 24000,
  high: 64000,
};

const VIDEO_FORBIDDEN_PRESETS: ReadonlySet<BandwidthPreset> = new Set([
  "ultra-low",
  "standard",
]);

const ALLOWED_AUDIO = new Set(["opus/48000/2"]);
const ALLOWED_VIDEO = new Set(["vp8/90000/1", "rtx/90000/1"]);

function codecKey(name: string, clock: number, channels: number): string {
  return `${name.toLowerCase()}/${clock}/${channels}`;
}

function effectiveDirection(section: MediaSection, sdp: Sdp): Direction {
  return section.direction ?? sdp.sessionDirection ?? "sendrecv";
}

function canSend(dir: Direction): boolean {
  return dir === "sendrecv" || dir === "sendonly";
}

function canRecv(dir: Direction): boolean {
  return dir === "sendrecv" || dir === "recvonly";
}

function checkStructure(sdp: Sdp, label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const section of sdp.media) {
    if (section.mid === null || section.mid === "") {
      errors.push(`${label}: ${section.kind} media is missing mid`);
    } else if (seen.has(section.mid)) {
      errors.push(`${label}: duplicate mid "${section.mid}"`);
    } else {
      seen.add(section.mid);
    }
  }
  const activeMids = sdp.media
    .filter((m) => !m.rejected)
    .map((m) => m.mid)
    .sort();
  const bundleMids = [...sdp.bundleMids].sort();
  if (
    bundleMids.length !== activeMids.length ||
    bundleMids.some((mid, i) => mid !== activeMids[i])
  ) {
    errors.push(
      `${label}: BUNDLE group must contain exactly the mids of non-rejected media`,
    );
  }
}

export function verifyNegotiation(
  offerText: string,
  answerText: string,
  preset: BandwidthPreset,
): VerifyResult {
  const errors: string[] = [];
  const offer = parseSdp(offerText);
  const answer = parseSdp(answerText);
  errors.push(...offer.errors.map((e) => `offer: ${e}`));
  errors.push(...answer.errors.map((e) => `answer: ${e}`));

  checkStructure(offer, "offer", errors);
  checkStructure(answer, "answer", errors);

  if (offer.media.length !== answer.media.length) {
    errors.push("answer must have the same number of media sections as offer");
  }

  const pairCount = Math.min(offer.media.length, answer.media.length);
  let usableAudio = 0;

  for (let i = 0; i < pairCount; i++) {
    const om = offer.media[i];
    const am = answer.media[i];
    const tag = `media[${i}] (${om.kind})`;

    if (om.kind !== am.kind) {
      errors.push(`${tag}: answer media kind does not match offer`);
    }
    if (om.mid !== null && am.mid !== null && om.mid !== am.mid) {
      errors.push(`${tag}: answer mid "${am.mid}" does not match offer mid "${om.mid}"`);
    }

    if (om.rejected && !am.rejected) {
      errors.push(`${tag}: answer revives a media rejected in offer`);
      continue;
    }
    if (am.rejected) continue;

    const offerDir = effectiveDirection(om, offer);
    const answerDir = effectiveDirection(am, answer);
    if (canSend(answerDir) && !canRecv(offerDir)) {
      errors.push(`${tag}: answer send not permitted by offer direction`);
    }
    if (canRecv(answerDir) && !canSend(offerDir)) {
      errors.push(`${tag}: answer recv not permitted by offer direction`);
    }

    if (om.kind === "video" && VIDEO_FORBIDDEN_PRESETS.has(preset)) {
      errors.push(`${tag}: video not allowed under preset "${preset}"`);
    }

    for (const pt of am.payloadTypes) {
      if (!om.payloadTypes.includes(pt)) {
        errors.push(`${tag}: answer payload ${pt} not present in offer`);
        continue;
      }
      const aMap = am.rtpMaps.find((r) => r.payloadType === pt);
      const oMap = om.rtpMaps.find((r) => r.payloadType === pt);
      if (!aMap || !oMap) {
        errors.push(`${tag}: missing rtpmap for payload ${pt}`);
        continue;
      }
      if (
        aMap.encodingName.toLowerCase() !== oMap.encodingName.toLowerCase() ||
        aMap.clockRate !== oMap.clockRate ||
        aMap.channels !== oMap.channels
      ) {
        errors.push(`${tag}: payload ${pt} codec parameters differ from offer`);
        continue;
      }
      const key = codecKey(aMap.encodingName, aMap.clockRate, aMap.channels);
      const allowed = om.kind === "audio" ? ALLOWED_AUDIO : ALLOWED_VIDEO;
      if (!allowed.has(key)) {
        errors.push(
          `${tag}: codec ${key} for payload ${pt} is not allowed in answer`,
        );
        continue;
      }

      if (om.kind === "audio") {
        const aParams = am.fmtp.get(pt);
        const raw = aParams?.get("maxaveragebitrate");
        if (raw === undefined) {
          errors.push(
            `${tag}: accepted opus payload ${pt} lacks maxaveragebitrate in answer`,
          );
        } else {
          const value = parseInt(raw, 10);
          if (!Number.isFinite(value) || value > PRESET_BITRATE[preset]) {
            errors.push(
              `${tag}: maxaveragebitrate ${raw} exceeds preset ${PRESET_BITRATE[preset]}`,
            );
          }
          const oRaw = om.fmtp.get(pt)?.get("maxaveragebitrate");
          if (oRaw !== undefined) {
            const oValue = parseInt(oRaw, 10);
            if (Number.isFinite(oValue) && Number.isFinite(value) && value > oValue) {
              errors.push(
                `${tag}: maxaveragebitrate ${value} exceeds offer limit ${oValue}`,
              );
            }
          }
        }
      } else {
        const name = aMap.encodingName.toLowerCase();
        if (name === "rtx") {
          const aApt = am.fmtp.get(pt)?.get("apt");
          const oApt = om.fmtp.get(pt)?.get("apt");
          if (aApt === undefined || oApt === undefined || aApt !== oApt) {
            errors.push(`${tag}: rtx payload ${pt} apt mismatch between sides`);
          } else {
            const aptPt = parseInt(aApt, 10);
            const aTarget = am.rtpMaps.find((r) => r.payloadType === aptPt);
            const oTarget = om.rtpMaps.find((r) => r.payloadType === aptPt);
            const isVp8 = (m?: { encodingName: string; clockRate: number }) =>
              m !== undefined &&
              m.encodingName.toLowerCase() === "vp8" &&
              m.clockRate === 90000;
            if (!isVp8(aTarget) || !isVp8(oTarget)) {
              errors.push(
                `${tag}: rtx apt ${aApt} does not point to a VP8 payload on both sides`,
              );
            } else if (!am.payloadTypes.includes(aptPt)) {
              errors.push(
                `${tag}: rtx apt target payload ${aptPt} is not accepted in answer`,
              );
            }
          }
        }
      }
    }

    if (om.kind === "audio" && answerDir !== "inactive") {
      usableAudio += 1;
    }
  }

  if (usableAudio === 0) {
    errors.push("no accepted non-inactive audio media; call cannot be established");
  }

  return { ok: errors.length === 0, errors };
}

import type {
  CodecMap,
  Direction,
  MediaKind,
  MediaSection,
  SdpSession,
} from "./types.js";

const DIRECTIONS: readonly string[] = [
  "sendrecv",
  "sendonly",
  "recvonly",
  "inactive",
];

function isDirection(value: string): value is Direction {
  return DIRECTIONS.includes(value);
}

function newMediaSection(kind: MediaKind, port: number): MediaSection {
  return {
    kind,
    port,
    mid: null,
    direction: null,
    directionConflict: false,
    rtpmapConflict: false,
    payloadTypes: [],
    codecs: new Map(),
    fmtpParams: new Map(),
    rejected: port === 0,
  };
}

function parseRtpmap(rest: string): { pt: number; codec: CodecMap } | null {
  const sp = rest.indexOf(" ");
  if (sp < 0) return null;
  const pt = Number(rest.slice(0, sp));
  if (!Number.isInteger(pt)) return null;
  const parts = rest.slice(sp + 1).trim().split("/");
  if (parts.length < 2) return null;
  const clockRate = Number(parts[1]);
  if (!Number.isInteger(clockRate)) return null;
  const channels = parts.length >= 3 ? Number(parts[2]) : 1;
  if (!Number.isInteger(channels)) return null;
  return {
    pt,
    codec: {
      payloadType: pt,
      name: parts[0].toLowerCase(),
      clockRate,
      channels,
    },
  };
}

function parseFmtp(rest: string): { pt: number; params: Map<string, string> } | null {
  const sp = rest.indexOf(" ");
  if (sp < 0) return null;
  const pt = Number(rest.slice(0, sp));
  if (!Number.isInteger(pt)) return null;
  const params = new Map<string, string>();
  for (const pair of rest.slice(sp + 1).split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (key.length > 0) params.set(key, value);
  }
  return { pt, params };
}

export function parseSdp(sdp: string): SdpSession {
  const session: SdpSession = {
    direction: null,
    directionConflict: false,
    bundleGroups: [],
    media: [],
  };
  let current: MediaSection | null = null;

  const applyDirection = (value: string, target: MediaSection | SdpSession): void => {
    const dir = value as Direction;
    if (target.direction === null) {
      target.direction = dir;
    } else if (target.direction !== dir) {
      target.directionConflict = true;
    }
  };

  for (const rawLine of sdp.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length < 2 || line[1] !== "=") continue;
    const field = line[0];
    const value = line.slice(2);

    if (field === "m") {
      const tokens = value.split(/\s+/);
      const kind = tokens[0];
      if (kind !== "audio" && kind !== "video") {
        current = null;
        continue;
      }
      const port = Number(tokens[1].split("/")[0]);
      current = newMediaSection(kind, Number.isInteger(port) ? port : 0);
      current.payloadTypes = tokens
        .slice(3)
        .map((t) => Number(t))
        .filter((n) => Number.isInteger(n));
      session.media.push(current);
      continue;
    }

    if (field !== "a") continue;

    if (isDirection(value)) {
      applyDirection(value, current ?? session);
      continue;
    }

    const colon = value.indexOf(":");
    const attrName = (colon < 0 ? value : value.slice(0, colon)).toLowerCase();
    const attrValue = colon < 0 ? "" : value.slice(colon + 1);

    if (attrName === "group") {
      const tokens = attrValue.trim().split(/\s+/);
      if (tokens[0]?.toUpperCase() === "BUNDLE") {
        session.bundleGroups.push(tokens.slice(1));
      }
      continue;
    }

    if (current === null) continue;

    if (attrName === "mid") {
      current.mid = attrValue.trim();
    } else if (attrName === "rtpmap") {
      const parsed = parseRtpmap(attrValue.trim());
      if (parsed) {
        const prev = current.codecs.get(parsed.pt);
        if (
          prev &&
          (prev.name !== parsed.codec.name ||
            prev.clockRate !== parsed.codec.clockRate ||
            prev.channels !== parsed.codec.channels)
        ) {
          current.rtpmapConflict = true;
        } else {
          current.codecs.set(parsed.pt, parsed.codec);
        }
      }
    } else if (attrName === "fmtp") {
      const parsed = parseFmtp(attrValue.trim());
      if (parsed) {
        const prev = current.fmtpParams.get(parsed.pt) ?? new Map<string, string>();
        for (const [k, v] of parsed.params) prev.set(k, v);
        current.fmtpParams.set(parsed.pt, prev);
      }
    }
  }

  return session;
}

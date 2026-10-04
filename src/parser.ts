import type { Direction, MediaKind, MediaSection, RtpMap, Sdp } from "./types.js";

const DIRECTIONS: readonly Direction[] = [
  "sendrecv",
  "sendonly",
  "recvonly",
  "inactive",
];

function parseDirection(value: string): Direction | null {
  return (DIRECTIONS as readonly string[]).includes(value)
    ? (value as Direction)
    : null;
}

export function parseSdp(text: string): Sdp {
  const sdp: Sdp = {
    sessionDirection: null,
    bundleMids: [],
    media: [],
    errors: [],
  };
  let current: MediaSection | null = null;
  const sessionDirs: Direction[] = [];
  const mediaDirs = new Map<MediaSection, Direction[]>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 2 || line[1] !== "=") continue;
    const key = line[0];
    const value = line.slice(2);

    if (key === "m") {
      const parts = value.split(/\s+/);
      const kind = parts[0] as MediaKind;
      const port = parseInt(parts[1].split("/")[0], 10);
      current = {
        kind,
        port,
        protocol: parts[2] ?? "",
        payloadTypes: parts.slice(3).map((f) => parseInt(f, 10)),
        mid: null,
        direction: null,
        rtpMaps: [],
        fmtp: new Map(),
        rejected: port === 0,
      };
      sdp.media.push(current);
      mediaDirs.set(current, []);
      continue;
    }

    if (key !== "a") continue;

    const dir = parseDirection(value);
    if (dir !== null) {
      if (current === null) sessionDirs.push(dir);
      else mediaDirs.get(current)!.push(dir);
      continue;
    }

    const colon = value.indexOf(":");
    const attrName = colon === -1 ? value : value.slice(0, colon);
    const attrValue = colon === -1 ? "" : value.slice(colon + 1);

    if (current === null) {
      if (attrName === "group") {
        const gparts = attrValue.split(/\s+/);
        if (gparts[0] === "BUNDLE") sdp.bundleMids = gparts.slice(1);
      }
      continue;
    }

    if (attrName === "mid") {
      current.mid = attrValue.trim();
    } else if (attrName === "rtpmap") {
      const sp = attrValue.indexOf(" ");
      if (sp === -1) continue;
      const pt = parseInt(attrValue.slice(0, sp), 10);
      const enc = attrValue.slice(sp + 1).split("/");
      const map: RtpMap = {
        payloadType: pt,
        encodingName: enc[0] ?? "",
        clockRate: parseInt(enc[1] ?? "0", 10),
        channels: enc.length > 2 && enc[2] !== "" ? parseInt(enc[2], 10) : 1,
      };
      const prev = current.rtpMaps.find((r) => r.payloadType === pt);
      if (
        prev &&
        (prev.encodingName.toLowerCase() !== map.encodingName.toLowerCase() ||
          prev.clockRate !== map.clockRate ||
          prev.channels !== map.channels)
      ) {
        sdp.errors.push(
          `conflicting rtpmap definitions for payload ${pt} in ${current.kind} media`,
        );
      } else if (!prev) {
        current.rtpMaps.push(map);
      }
    } else if (attrName === "fmtp") {
      const sp = attrValue.indexOf(" ");
      if (sp === -1) continue;
      const pt = parseInt(attrValue.slice(0, sp), 10);
      let params = current.fmtp.get(pt);
      if (!params) {
        params = new Map();
        current.fmtp.set(pt, params);
      }
      for (const pair of attrValue.slice(sp + 1).split(";")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const k = pair.slice(0, eq).trim().toLowerCase();
        const v = pair.slice(eq + 1).trim();
        const existing = params.get(k);
        if (existing !== undefined && existing !== v) {
          sdp.errors.push(
            `conflicting fmtp parameter "${k}" for payload ${pt} in ${current.kind} media`,
          );
        } else {
          params.set(k, v);
        }
      }
    }
  }

  if (new Set(sessionDirs).size > 1) {
    sdp.errors.push("conflicting session-level direction attributes");
  } else if (sessionDirs.length > 0) {
    sdp.sessionDirection = sessionDirs[0];
  }
  for (const section of sdp.media) {
    const dirs = mediaDirs.get(section)!;
    if (new Set(dirs).size > 1) {
      sdp.errors.push(
        `conflicting media-level direction attributes in ${section.kind} media`,
      );
    } else if (dirs.length > 0) {
      section.direction = dirs[0];
    }
  }

  return sdp;
}

export type MediaKind = "audio" | "video";

export type Direction = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export interface RtpMap {
  payloadType: number;
  encodingName: string;
  clockRate: number;
  channels: number;
}

export interface MediaSection {
  kind: MediaKind;
  port: number;
  protocol: string;
  payloadTypes: number[];
  mid: string | null;
  direction: Direction | null;
  rtpMaps: RtpMap[];
  fmtp: Map<number, Map<string, string>>;
  rejected: boolean;
}

export interface Sdp {
  sessionDirection: Direction | null;
  bundleMids: string[];
  media: MediaSection[];
  errors: string[];
}

export type BandwidthPreset = "ultra-low" | "standard" | "high";

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

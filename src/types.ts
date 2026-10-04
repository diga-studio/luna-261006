export type MediaKind = "audio" | "video";

export type Direction = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export interface CodecMap {
  payloadType: number;
  name: string;
  clockRate: number;
  channels: number;
}

export interface MediaSection {
  kind: MediaKind;
  port: number;
  mid: string | null;
  direction: Direction | null;
  directionConflict: boolean;
  rtpmapConflict: boolean;
  payloadTypes: number[];
  codecs: Map<number, CodecMap>;
  fmtpParams: Map<number, Map<string, string>>;
  rejected: boolean;
}

export interface SdpSession {
  direction: Direction | null;
  directionConflict: boolean;
  bundleGroups: string[][];
  media: MediaSection[];
}

export type BandwidthPreset = "ultra-low" | "standard" | "high";

export const BANDWIDTH_LIMITS: Record<BandwidthPreset, number> = {
  "ultra-low": 8000,
  standard: 24000,
  high: 64000,
};

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

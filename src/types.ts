export type Protocol = "TCP" | "UDP";

export type Action = "allow" | "deny";

export interface Rule {
  id: string;
  sourceCidr: string;
  destCidr: string;
  protocol: Protocol;
  portStart: number;
  portEnd: number;
  action: Action;
  priority: number;
}

export interface Packet {
  sourceAddress: string;
  destAddress: string;
  protocol: Protocol;
  destPort: number;
}

export type ReplaceResult =
  | { ok: true }
  | { ok: false; witness: Packet };

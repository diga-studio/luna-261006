export type Protocol = "TCP" | "UDP" | "ICMP";

export type Action = "ALLOW" | "DENY" | "RATE_LIMIT";

export interface PortRange {
  readonly start: number;
  readonly end: number;
}

export interface TimeWindow {
  readonly start: number;
  readonly end: number;
}

export interface Rule {
  readonly priority: number;
  readonly sourceCidr: string;
  readonly destinationCidr: string;
  readonly protocol: Protocol;
  readonly sourcePorts?: PortRange;
  readonly destinationPorts?: PortRange;
  readonly timeWindows: readonly TimeWindow[];
  readonly action: Action;
}

export interface Policy {
  readonly sourceZone: string;
  readonly destinationZone: string;
  readonly rules: readonly Rule[];
}

export interface Packet {
  readonly sourceZone: string;
  readonly destinationZone: string;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly protocol: Protocol;
  readonly sourcePort?: number;
  readonly destinationPort?: number;
  readonly minuteOfWeek: number;
}

export type Decision = "ALLOW" | "DENY" | "RATE_LIMIT";

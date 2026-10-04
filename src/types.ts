export type Protocol = "TCP" | "UDP" | "ICMP";

export type Action = "ALLOW" | "DENY" | "RATE_LIMIT";

export interface PortRange {
  readonly start: number;
  readonly end: number;
}

export interface TimeRange {
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface Cidr {
  readonly address: number;
  readonly prefixLength: number;
}

export interface Rule {
  readonly priority: number;
  readonly sourceCidr: Cidr;
  readonly destinationCidr: Cidr;
  readonly protocol: Protocol;
  readonly sourcePorts?: PortRange;
  readonly destinationPorts?: PortRange;
  readonly timeRanges: readonly TimeRange[];
  readonly action: Action;
}

export interface SegmentPairPolicy {
  readonly sourceSegment: string;
  readonly destinationSegment: string;
  readonly rules: readonly Rule[];
}

export interface Packet {
  readonly sourceSegment: string;
  readonly destinationSegment: string;
  readonly sourceAddress: number;
  readonly destinationAddress: number;
  readonly protocol: Protocol;
  readonly sourcePort?: number;
  readonly destinationPort?: number;
  readonly minuteOfWeek: number;
}

export type Decision = "ALLOW" | "DENY" | "RATE_LIMIT";

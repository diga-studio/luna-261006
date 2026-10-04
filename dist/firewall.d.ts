import type { Decision, Packet, SegmentPairPolicy } from "./types.js";
export declare class Firewall {
    private policies;
    loadPolicies(policies: readonly SegmentPairPolicy[]): void;
    decide(packet: Packet): Decision;
}

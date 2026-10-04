import type { Cidr, Packet, Rule } from "./types.js";
export declare function cidrContains(cidr: Cidr, address: number): boolean;
export declare function ruleMatches(rule: Rule, packet: Packet): boolean;

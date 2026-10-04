export interface ParsedCidr {
  readonly network: number;
  readonly prefixLength: number;
}

export function parseIpv4(address: string): number {
  const parts = address.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${address}`);
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${address}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`invalid IPv4 address: ${address}`);
    }
    value = value * 256 + octet;
  }
  return value;
}

export function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.indexOf("/");
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const address = cidr.slice(0, slash);
  const prefixText = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixText)) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefixLength = Number(prefixText);
  if (prefixLength > 32) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const network = parseIpv4(address);
  if (prefixLength < 32 && network % 2 ** (32 - prefixLength) !== 0) {
    throw new Error(`CIDR is not a canonical network: ${cidr}`);
  }
  return { network, prefixLength };
}

export function cidrContains(cidr: ParsedCidr, address: number): boolean {
  if (cidr.prefixLength === 0) {
    return true;
  }
  const shift = 32 - cidr.prefixLength;
  return Math.floor(address / 2 ** shift) === Math.floor(cidr.network / 2 ** shift);
}

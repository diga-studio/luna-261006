export interface Ipv4Interval {
  start: number;
  end: number;
}

export function parseCidr(cidr: string): Ipv4Interval {
  const parts = cidr.split("/");
  if (parts.length !== 2) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const octets = parts[0].split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`invalid CIDR address: ${cidr}`);
  }
  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR prefix: ${cidr}`);
  }
  const address =
    ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  const size = 2 ** (32 - prefix);
  const start = address - (address % size);
  return { start, end: start + size - 1 };
}

export function ipv4ToString(value: number): string {
  return [
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ].join(".");
}

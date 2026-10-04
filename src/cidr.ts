/** 闭区间 [lo, hi]，uint32 地址值。 */
export interface AddrRange {
  lo: number;
  hi: number;
}

/** 解析点分十进制 IPv4 地址为 uint32。非法输入抛错。 */
export function parseIpv4(text: string): number {
  const parts = text.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${text}`);
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${text}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`invalid IPv4 address: ${text}`);
    }
    value = value * 256 + octet;
  }
  return value;
}

/** 将 uint32 格式化为点分十进制。 */
export function formatIpv4(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`invalid IPv4 value: ${value}`);
  }
  return [
    Math.floor(value / 0x1000000) % 256,
    Math.floor(value / 0x10000) % 256,
    Math.floor(value / 0x100) % 256,
    value % 256,
  ].join(".");
}

/** 解析规范化 IPv4 CIDR（前缀 0-32）为地址闭区间。非法输入抛错。 */
export function parseCidr(text: string): AddrRange {
  const slash = text.indexOf("/");
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${text}`);
  }
  const base = parseIpv4(text.slice(0, slash));
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixText)) {
    throw new Error(`invalid CIDR prefix: ${text}`);
  }
  const prefix = Number(prefixText);
  if (prefix > 32) {
    throw new Error(`invalid CIDR prefix: ${text}`);
  }
  const size = 2 ** (32 - prefix);
  const lo = base - (base % size);
  return { lo, hi: lo + size - 1 };
}

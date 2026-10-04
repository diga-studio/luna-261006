import { domainToASCII } from "node:url";

/**
 * 域名归一化：UTS46 非过渡模式 + STD3 规则（Node 的 domainToASCII
 * 即 WHATWG URL 的 IDNA ToASCII，使用 UTS46 非过渡处理并启用 STD3），
 * 输出 ASCII 小写；允许并忽略一个末尾根点。
 * Unicode 域名与对应 Punycode 等价；非过渡模式下 ß 不折叠为 ss。
 */
export function normalizeDomain(input: string): string {
  let domain = input;
  if (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  const ascii = domainToASCII(domain);
  if (ascii === "") {
    throw new Error(`invalid domain: ${JSON.stringify(input)}`);
  }
  return ascii;
}

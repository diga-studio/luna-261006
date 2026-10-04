/**
 * 域名归一化：UTS46 非过渡模式 + STD3 规则，转 ASCII 小写，
 * 允许并忽略一个末尾根点。ß 与 ss 不等价（非过渡模式）。
 *
 * 借助 WHATWG URL 的主机名解析：其对主机名执行的 IDNA ToASCII
 * 正是 UTS46 非过渡模式且启用 STD3 规则，输出为 ASCII 小写。
 */
export function normalizeDomain(domain: string): string {
  let input = domain.trim();
  if (input.endsWith(".")) {
    input = input.slice(0, -1);
  }
  if (input.length === 0 || input.endsWith(".")) {
    throw new Error(`invalid domain: ${JSON.stringify(domain)}`);
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${input}`).hostname;
  } catch {
    throw new Error(`invalid domain: ${JSON.stringify(domain)}`);
  }
  if (hostname.length === 0 || hostname !== hostname.toLowerCase()) {
    throw new Error(`invalid domain: ${JSON.stringify(domain)}`);
  }
  return hostname;
}

/**
 * 从一行输入（邮箱地址或裸域名）中取出域名部分。
 * 邮箱语法已由上游验证，这里取最后一个 “@” 之后的部分。
 */
export function extractDomain(line: string): string {
  const trimmed = line.trim();
  const at = trimmed.lastIndexOf("@");
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** 规范化结果：可接纳地址的规范化形式，或 null 表示不可接纳。 */
export interface NormalizedAddress {
  /** 去掉片段、主机小写、去掉默认端口后的规范化地址字符串。 */
  canonical: string;
}

/**
 * 按 WHATWG URL 语义解析地址（相对地址以 base 为基准），
 * 仅接纳与种子同源的 HTTP/HTTPS 地址；去掉片段后返回规范化形式。
 * 查询参数顺序保留，不额外解码路径。
 */
export function normalizeAddress(
  raw: string,
  base: string,
  seedOrigin: string,
): NormalizedAddress | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  // WHATWG URL 已统一主机大小写并省略默认端口，协议+主机+端口即同源键。
  const origin = url.protocol + '//' + url.host;
  if (origin !== seedOrigin) {
    return null;
  }
  url.hash = '';
  return { canonical: url.href };
}

/** 计算规范化后 URL 的同源键（协议 + 主机 + 端口）。 */
export function originKeyOf(canonicalUrl: string): string {
  const url = new URL(canonicalUrl);
  return url.protocol + '//' + url.host;
}

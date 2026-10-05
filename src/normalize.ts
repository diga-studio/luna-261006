/**
 * 搜索规范化（固定定义，不得更改）：
 * 先 NFC，再调用 JavaScript 的 toLowerCase，再做 NFC。
 */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFC").toLowerCase().normalize("NFC");
}

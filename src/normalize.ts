/** 搜索规范化：NFC -> toLowerCase -> NFC（顺序固定，不可交换） */
export function normalizeText(text: string): string {
  return text.normalize("NFC").toLowerCase().normalize("NFC");
}

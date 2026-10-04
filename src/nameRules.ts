/** 禁用扩展名（小写，含点） */
export const BANNED_EXTENSIONS: readonly string[] = [
  '.exe', '.dll', '.com', '.scr', '.bat', '.cmd', '.ps1',
];

const BANNED_SET = new Set(BANNED_EXTENSIONS);

function toAsciiLower(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

/**
 * 对成员名称原始字节做禁用扩展名检查。
 * 正斜杠与反斜杠均为分隔符；取最后一个分量，去掉末尾连续 ASCII 空格与点号，
 * 以 ASCII 大小写不敏感方式取最后一个扩展名。命中则返回小写扩展名，否则 null。
 */
export function findBannedExtension(rawName: Buffer): string | null {
  // 取最后一个分量（'/' 与 '\\' 均为分隔符）
  let start = 0;
  for (let i = 0; i < rawName.length; i++) {
    if (rawName[i] === 0x2f || rawName[i] === 0x5c) start = i + 1;
  }
  // 去掉末尾连续的 ASCII 空格与点号
  let end = rawName.length;
  while (end > start && (rawName[end - 1] === 0x20 || rawName[end - 1] === 0x2e)) {
    end--;
  }
  // 最后一个点号起为最后一个扩展名
  let dot = -1;
  for (let i = end - 1; i >= start; i--) {
    if (rawName[i] === 0x2e) {
      dot = i;
      break;
    }
  }
  if (dot < 0 || dot === end - 1) return null;
  let ext = '';
  for (let i = dot; i < end; i++) {
    ext += String.fromCharCode(toAsciiLower(rawName[i]));
  }
  return BANNED_SET.has(ext) ? ext : null;
}

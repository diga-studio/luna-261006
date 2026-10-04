/** 单包输入上限：100 MiB */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/** 全部成员累计实际展开量上限：128 MiB */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
/** 禁用扩展名（ASCII 小写、含前导点） */
export const BANNED_EXTENSIONS: ReadonlyArray<string> = [
  '.exe',
  '.dll',
  '.com',
  '.scr',
  '.bat',
  '.cmd',
  '.ps1',
];

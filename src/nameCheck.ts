import { BANNED_EXTENSIONS } from './constants';

/**
 * 禁用扩展名检查：正斜杠与反斜杠均视为分隔符；取最后一个名称分量，
 * 去掉末尾连续的 ASCII 空格和点号，再以 ASCII 大小写不敏感方式
 * 检查最后一个扩展名。
 */
export function hasBannedExtension(name: string): boolean {
  const segments = name.split(/[\\/]/);
  const last = segments[segments.length - 1];
  const trimmed = last.replace(/[. ]+$/g, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot < 0 || dot === trimmed.length - 1) return false;
  const ext = trimmed.slice(dot).toLowerCase();
  return BANNED_EXTENSIONS.indexOf(ext) >= 0;
}

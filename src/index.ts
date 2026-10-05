import { parseJpegStructure, type JpegStructure } from "./jpeg.js";
import { extractWhitelistFields, mergeWhitelistFields, type ExtractedField } from "./exif.js";
import { assembleSanitized } from "./sanitize.js";
import type { PreviewField, PreviewResult, SanitizeResult } from "./types.js";

export { JpegPrivacyError } from "./errors.js";
export type { ExifValue, PreviewField, PreviewResult, SanitizeResult } from "./types.js";

const EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const IFD0_TAGS: ReadonlySet<number> = new Set([0x010f, 0x0110, 0x0112]);

function isExifApp1(payload: Uint8Array): boolean {
  return payload.length >= 6 && EXIF_MAGIC.every((b, i) => payload[i] === b);
}

/** 解析结构并合并所有 EXIF 段的白名单字段；失败时抛 JpegPrivacyError。 */
function collectFields(structure: JpegStructure): ExtractedField[] {
  const perSegment: ExtractedField[][] = [];
  for (const piece of structure.pieces) {
    if (piece.kind !== "segment" || piece.marker !== 0xe1 || piece.payload === null) continue;
    if (!isExifApp1(piece.payload)) continue;
    perSegment.push(extractWhitelistFields(piece.payload));
  }
  const merged = mergeWhitelistFields(perSegment);
  // 规范排序（IFD0 字段按 tag，再 ExifIFD 字段按 tag），与写出布局一致，
  // 保证预览顺序与导出后重新读取的顺序相同。
  return merged.sort((a, b) => {
    const ga = IFD0_TAGS.has(a.tag) ? 0 : 1;
    const gb = IFD0_TAGS.has(b.tag) ? 0 : 1;
    return ga - gb || a.tag - b.tag;
  });
}

function toPreview(fields: ExtractedField[]): PreviewResult {
  const preview: PreviewField[] = fields.map((f) => ({
    name: f.name,
    tag: f.tag,
    type: f.type,
    count: f.count,
    value: f.value,
  }));
  return { fields: preview };
}

/** 预览净化导出后将保留的字段；结构损坏或字段冲突时抛 JpegPrivacyError。 */
export function previewMetadata(input: Uint8Array): PreviewResult {
  const structure = parseJpegStructure(input);
  return toPreview(collectFields(structure));
}

/**
 * 净化导出：删除 GPS/机主/时间/缩略图等非白名单元数据，
 * 保留相机型号、曝光参数、方向、JFIF 显示参数、ICC 与标准 Adobe 信息。
 * 扫描数据与编码标记逐字节保留。失败时抛错，绝不返回部分结果。
 */
export function exportSanitized(input: Uint8Array): SanitizeResult {
  const structure = parseJpegStructure(input);
  const fields = collectFields(structure);
  const bytes = assembleSanitized(structure, fields);
  // 预览取自对导出结果的重新读取，保证与外部核对一致。
  const preview = previewMetadata(bytes);
  return { bytes, preview };
}

/** 白名单保留字段的解码值。 */
export type ExifValue =
  | { kind: "ascii"; text: string }
  | { kind: "uint"; values: number[] }
  | { kind: "int"; values: number[] }
  | { kind: "rational"; values: Array<[number, number]> }
  | { kind: "float"; values: number[] };

/** 预览返回的单个保留字段。 */
export interface PreviewField {
  /** 白名单字段名，如 "Make"、"Orientation"。 */
  name: string;
  /** EXIF tag id，如 0x010f。 */
  tag: number;
  /** TIFF 类型码（1..12 中实际出现的）。 */
  type: number;
  /** 原始 count。 */
  count: number;
  /** 解码后的值（有理数为 [分子, 分母] 对）。 */
  value: ExifValue;
}

export interface PreviewResult {
  /** 按 EXIF 中出现顺序排列的保留字段（多段去重后）。 */
  fields: PreviewField[];
}

export interface SanitizeResult {
  /** 净化后的完整 JPEG 字节。 */
  bytes: Uint8Array;
  /** 与导出结果重新读取完全一致的保留字段预览。 */
  preview: PreviewResult;
}

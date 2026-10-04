/**
 * Schema 声明配置字段及其域。
 *
 * - boolean 字段：域为 { false, true }
 * - integer 字段：域为闭区间 [min, max] 内的整数
 */
export type FieldSchema =
  | { type: "boolean" }
  | { type: "integer"; min: number; max: number };

/** 字段名 -> 字段域声明 */
export type Schema = Record<string, FieldSchema>;

/**
 * Snapshot 是字段到已知值的部分映射。
 * 未出现的字段为“未知”，可在其域内取任意值（未知 ≠ false）。
 */
export type Snapshot = Record<string, boolean | number>;

/** 完整补全：为所有未知字段赋予域内值，并保留全部已知值。 */
export type Completion = Record<string, boolean | number>;

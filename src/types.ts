/** 一条来源记录快照。标识已由上游规范化，可直接精确比较。 */
export interface SourceRecord {
  sourceId: string;
  recordId: string;
  /** 缺省（undefined/null）表示该记录当前没有 email 标识。 */
  email?: string | null;
  /** 缺省（undefined/null）表示该记录当前没有 external_id 标识。 */
  externalId?: string | null;
  /** 该来源记录当前的完整标签集合（现值，非增量）。 */
  tags?: readonly string[];
  /** 该来源记录当前的累计互动次数（现值，非增量）。 */
  interactions?: number;
}

/** 来源记录键：source_id + record_id 共同唯一标识一条来源记录。 */
export interface RecordKey {
  sourceId: string;
  recordId: string;
}

/** 统一档案：对应当前匹配关系形成的一个连通群。 */
export interface UnifiedProfile {
  /** 档案 ID，在档案存续期间稳定；拆分/合并后可能重新分配。 */
  profileId: string;
  /** 成员来源记录键集合。 */
  members: RecordKey[];
  /** 全部成员标签的并集。 */
  tags: string[];
  /** 全部成员累计互动次数之和，每条记录只贡献一次。 */
  interactions: number;
}

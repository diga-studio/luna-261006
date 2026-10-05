/** 来源记录键：source_id 与 record_id 共同唯一标识一条来源记录。 */
export interface RecordKey {
  sourceId: string;
  recordId: string;
}

/** 上游提交的来源记录快照（完整现值，非增量）。 */
export interface SourceRecord extends RecordKey {
  /** 可缺省；缺省表示该记录当前无 email 标识（撤回原标识）。 */
  email?: string;
  /** 可缺省；缺省表示该记录当前无 external_id 标识。 */
  externalId?: string;
  /** 该来源记录当前的完整标签集合。 */
  tags?: readonly string[];
  /** 该来源记录当前的累计互动次数（现值，重复提交不得累加）。 */
  interactions?: number;
}

/** 统一档案视图。 */
export interface UnifiedProfile {
  /** 档案内部 id（重算后可能变化，仅供区分）。 */
  profileId: number;
  /** 成员记录键集合。 */
  members: ReadonlySet<RecordKey>;
  /** 成员标签并集。 */
  tags: ReadonlySet<string>;
  /** 成员累计互动次数之和（每条记录只贡献一次）。 */
  totalInteractions: number;
}

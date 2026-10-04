/** 一个 BOM 版本：某装配从 startDay 起生效的直接子件列表。 */
export interface BomRevision {
  assemblyId: string;
  startDay: number;
  components: string[];
}

/** publishBatch 成功。 */
export interface PublishOk {
  ok: true;
}

/**
 * publishBatch 因成环被拒绝。
 * day: 实际发生环的整数日；cycle: 该日成立的闭合物料路径（首尾相同）。
 */
export interface PublishRejected {
  ok: false;
  day: number;
  cycle: string[];
}

export type PublishResult = PublishOk | PublishRejected;

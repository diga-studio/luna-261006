/** 一项成果：唯一 ID、所属指标、非负整数预算 P（1 积分 = 0.01 工作量分）、有序不重复作者列表 */
export interface WorkItem {
  id: string;
  metric: string;
  budget: number;
  authors: string[];
}

/** 结算输入：已定版的成果列表 + 每个作者×指标组合的非负整数周期上限 C */
export interface SettleInput {
  items: WorkItem[];
  /** caps[author][metric] = C；未列出的组合视为无上限 */
  caps?: Record<string, Record<string, number>>;
}

/** 一项成果的结算结果：各署名作者获得的整数积分 */
export interface SettledItem {
  id: string;
  allocations: Record<string, number>;
}

export interface SettleResult {
  items: SettledItem[];
}

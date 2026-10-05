/** 流程定义与检查结果的公共类型。 */

export type NodeId = string;
export type SwitchName = string;
export type FieldName = string;

export interface EntryNode {
  id: NodeId;
  kind: 'entry';
  next: NodeId;
}

export interface ConditionNode {
  id: NodeId;
  kind: 'condition';
  /** 检查的开关名，必须出现在 FlowDefinition.switches 中。 */
  switch: SwitchName;
  onTrue: NodeId;
  onFalse: NodeId;
}

export interface ActionNode {
  id: NodeId;
  kind: 'action';
  /** 执行前必须已存在的字段。 */
  requires: FieldName[];
  /** 执行成功后产出的字段。 */
  produces: FieldName[];
  next: NodeId;
}

export interface EndNode {
  id: NodeId;
  kind: 'end';
}

export type FlowNode = EntryNode | ConditionNode | ActionNode | EndNode;

export interface FlowDefinition {
  /** 布尔开关，最多 40 个；执行前一次性给定全部取值。 */
  switches: SwitchName[];
  /** 业务字段，最多 40 个；执行开始时全部不存在。 */
  fields: FieldName[];
  nodes: FlowNode[];
}

/** 一组完整开关输入：与 FlowDefinition.switches 等长、同序。 */
export type SwitchAssignment = boolean[];

/** 一条风险报告：某个动作节点可能首次缺少某个必填字段。 */
export interface RiskReport {
  nodeId: NodeId;
  field: FieldName;
  /** 真实触发该首次失败的完整开关输入。 */
  witness: SwitchAssignment;
}

export interface AnalysisResult {
  /** 按 (nodeId, field) 去重后的全部首次失败组合。 */
  reports: RiskReport[];
}

export interface ReplaySuccess {
  ok: true;
  /** 依次经过的节点。 */
  path: NodeId[];
}

export interface ReplayFailure {
  ok: false;
  path: NodeId[];
  /** 首次失败的动作节点。 */
  failedAt: NodeId;
  /** 失败时全部缺失的必填字段。 */
  missingFields: FieldName[];
}

export type ReplayResult = ReplaySuccess | ReplayFailure;

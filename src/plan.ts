import { MinCostMaxFlow } from "./mincostflow.js";
import { baseScore, loadScore } from "./scoring.js";
import type {
  Assignment,
  BatchPlan,
  Mentor,
  Newcomer,
  PlanInput,
  PlanResult,
} from "./types.js";

const MAX_LOAD = 3;

/**
 * 为一批新人规划导师配对。
 *
 * 建模为最小费用最大流：
 * - 源 -> 新人（容量 1，费用 0）
 * - 新人 -> 候选导师（容量 1，费用 = -2 * 固定部分得分）
 * - 导师 -> 汇（按最终负载拆成单位容量边，费用 = -2 * 负载项边际收益）
 *
 * 所有费用乘以 2 使 7.5 的负载项保持整数。SSP 求解保证先配对人数最多、
 * 再总分最高（字典序），不使用大常数混合目标。
 *
 * 强制指定先从网络中移除（新人不再参与增广，导师容量与历史负载相应扣减），
 * 求解后按导师最终负载统一为强制与自动配对计分。
 */
export function planBatch(input: PlanInput): PlanResult {
  const newcomerById = new Map<string, Newcomer>();
  for (const newcomer of input.newcomers) newcomerById.set(newcomer.id, newcomer);
  const mentorById = new Map<string, Mentor>();
  for (const mentor of input.mentors) mentorById.set(mentor.id, mentor);

  // ---- 校验并预处理强制指定 ----
  const forcedByNewcomer = new Map<string, string>();
  const forcedCountByMentor = new Map<string, number>();
  for (const forced of input.forcedAssignments) {
    const newcomer = newcomerById.get(forced.newcomerId);
    if (newcomer === undefined) {
      return { feasible: false, reason: `forced assignment references unknown newcomer ${forced.newcomerId}` };
    }
    const mentor = mentorById.get(forced.mentorId);
    if (mentor === undefined) {
      return { feasible: false, reason: `forced assignment references unknown mentor ${forced.mentorId}` };
    }
    if (forcedByNewcomer.has(forced.newcomerId)) {
      return { feasible: false, reason: `newcomer ${forced.newcomerId} has conflicting forced assignments` };
    }
    if (!newcomer.candidateMentorIds.has(forced.mentorId)) {
      return {
        feasible: false,
        reason: `forced mentor ${forced.mentorId} is not a candidate of newcomer ${forced.newcomerId}`,
      };
    }
    forcedByNewcomer.set(forced.newcomerId, forced.mentorId);
    forcedCountByMentor.set(forced.mentorId, (forcedCountByMentor.get(forced.mentorId) ?? 0) + 1);
  }
  for (const mentor of input.mentors) {
    const forcedCount = forcedCountByMentor.get(mentor.id) ?? 0;
    if (mentor.activeMenteeCount + forcedCount > MAX_LOAD) {
      return {
        feasible: false,
        reason: `forced assignments exceed capacity of mentor ${mentor.id}`,
      };
    }
  }

  // ---- 建图 ----
  const newcomers = input.newcomers;
  const mentors = input.mentors;
  const n = newcomers.length;
  const m = mentors.length;
  const source = 0;
  const newcomerNode = (i: number): number => 1 + i;
  const mentorNode = (j: number): number => 1 + n + j;
  const sink = 1 + n + m;

  const flow = new MinCostMaxFlow(sink + 1);
  const mentorIndexById = new Map<string, number>();
  mentors.forEach((mentor, j) => mentorIndexById.set(mentor.id, j));

  // 导师 -> 汇：负载项的边际收益边（单位容量）。
  // 负载项作用于本批全部新人（含强制指定），因此第 k 个自动配对的边际收益为
  //   g(k) = (f + k) * L(c + f + k) - (f + k - 1) * L(c + f + k - 1)
  // 其中 c 为历史活跃配对数、f 为强制指定数、L 为负载项得分。
  // 边际收益单调不增（凸），单位容量边的最短路增广即为精确解。
  const scaledLoad = (finalLoad: number): number => 2 * loadScore(finalLoad);
  mentors.forEach((mentor, j) => {
    const history = mentor.activeMenteeCount;
    const forcedCount = forcedCountByMentor.get(mentor.id) ?? 0;
    // batchTotal 名本批新人（含强制指定）时的负载项总得分；0 人时为 0
    const loadTotal = (batchTotal: number): number =>
      batchTotal === 0 ? 0 : batchTotal * scaledLoad(history + batchTotal);
    let previousTotal = loadTotal(forcedCount);
    for (let k = 1; k <= MAX_LOAD - history - forcedCount; k += 1) {
      const currentTotal = loadTotal(forcedCount + k);
      const marginalGain = currentTotal - previousTotal;
      flow.addEdge(mentorNode(j), sink, 1, -marginalGain);
      previousTotal = currentTotal;
    }
  });

  // 源 -> 新人、新人 -> 候选导师（强制指定的新人不再参与增广）
  const pairEdge: Array<{ edgeIndex: number; newcomerIndex: number; mentorIndex: number }> = [];
  newcomers.forEach((newcomer, i) => {
    if (forcedByNewcomer.has(newcomer.id)) return;
    flow.addEdge(source, newcomerNode(i), 1, 0);
    for (const mentorId of newcomer.candidateMentorIds) {
      const mentorIndex = mentorIndexById.get(mentorId);
      if (mentorIndex === undefined) {
        throw new Error(`newcomer ${newcomer.id} has unknown candidate mentor ${mentorId}`);
      }
      const mentor = mentors[mentorIndex]!;
      const edgeIndex = flow.addEdge(
        newcomerNode(i),
        mentorNode(mentorIndex),
        1,
        -2 * baseScore(newcomer, mentor),
      );
      pairEdge.push({ edgeIndex, newcomerIndex: i, mentorIndex });
    }
  });

  // ---- 求解并提取配对 ----
  flow.solve(source, sink);

  const assignments: Assignment[] = [];
  const batchCountByMentor = new Array<number>(m).fill(0);
  for (const { edgeIndex, newcomerIndex, mentorIndex } of pairEdge) {
    if (flow.flowOn(edgeIndex) === 1) {
      assignments.push({
        newcomerId: newcomers[newcomerIndex]!.id,
        mentorId: mentors[mentorIndex]!.id,
      });
      batchCountByMentor[mentorIndex]! += 1;
    }
  }
  for (const [newcomerId, mentorId] of forcedByNewcomer) {
    assignments.push({ newcomerId, mentorId });
    batchCountByMentor[mentorIndexById.get(mentorId)!]! += 1;
  }

  // ---- 按导师最终负载统一计分（强制与自动配对一致处理）----
  const plan = scoreAssignments(input, assignments, batchCountByMentor, mentorIndexById);
  return plan;
}

/** 由配对结果与导师本批配对数计算目标值，供 planBatch 汇总 */
function scoreAssignments(
  input: PlanInput,
  assignments: Assignment[],
  batchCountByMentor: number[],
  mentorIndexById: Map<string, number>,
): BatchPlan {
  const newcomerById = new Map(input.newcomers.map((n) => [n.id, n]));
  const mentorById = new Map(input.mentors.map((m) => [m.id, m]));

  let totalScore = 0;
  for (const assignment of assignments) {
    const newcomer = newcomerById.get(assignment.newcomerId)!;
    const mentor = mentorById.get(assignment.mentorId)!;
    const mentorIndex = mentorIndexById.get(assignment.mentorId)!;
    const finalLoad = mentor.activeMenteeCount + batchCountByMentor[mentorIndex]!;
    totalScore += baseScore(newcomer, mentor) + loadScore(finalLoad);
  }

  const assignedIds = new Set(assignments.map((a) => a.newcomerId));
  const unassignedNewcomerIds = input.newcomers
    .map((n) => n.id)
    .filter((id) => !assignedIds.has(id));

  return {
    feasible: true,
    assignments,
    unassignedNewcomerIds,
    objective: { matchedCount: assignments.length, totalScore },
  };
}

import { baseScore, loadScore } from "./scoring.js";
import type { Assignment, Evaluation, PlanInput } from "./types.js";

const MAX_LOAD = 3;

/**
 * 校验方案合法性，并重新计算配对人数、每名已配对新人的得分与总分。
 * 不相信传入方案附带的任何分数；负载项按导师最终负载（历史 + 本批全部配对）计算。
 */
export function evaluatePlan(
  input: PlanInput,
  assignments: Assignment[],
): Evaluation {
  const newcomerById = new Map(input.newcomers.map((n) => [n.id, n]));
  const mentorById = new Map(input.mentors.map((m) => [m.id, m]));

  const violations: string[] = [];
  const mentorOf = new Map<string, string>();
  const batchCountByMentor = new Map<string, number>();

  assignments.forEach((assignment, index) => {
    const label = `assignment[${index}] (${assignment.newcomerId} -> ${assignment.mentorId})`;
    const newcomer = newcomerById.get(assignment.newcomerId);
    if (newcomer === undefined) {
      violations.push(`${label}: unknown newcomer`);
      return;
    }
    const mentor = mentorById.get(assignment.mentorId);
    if (mentor === undefined) {
      violations.push(`${label}: unknown mentor`);
      return;
    }
    if (mentorOf.has(assignment.newcomerId)) {
      violations.push(`${label}: newcomer already assigned to ${mentorOf.get(assignment.newcomerId)}`);
      return;
    }
    if (!newcomer.candidateMentorIds.has(assignment.mentorId)) {
      violations.push(`${label}: mentor is not in the newcomer's candidate set`);
      return;
    }
    mentorOf.set(assignment.newcomerId, assignment.mentorId);
    batchCountByMentor.set(
      assignment.mentorId,
      (batchCountByMentor.get(assignment.mentorId) ?? 0) + 1,
    );
  });

  // 容量：历史活跃配对数 + 本批配对数 <= 3
  for (const [mentorId, batchCount] of batchCountByMentor) {
    const mentor = mentorById.get(mentorId)!;
    if (mentor.activeMenteeCount + batchCount > MAX_LOAD) {
      violations.push(
        `mentor ${mentorId} final load ${mentor.activeMenteeCount + batchCount} exceeds ${MAX_LOAD}`,
      );
    }
  }

  // 强制指定必须保留
  for (const forced of input.forcedAssignments) {
    if (mentorOf.get(forced.newcomerId) !== forced.mentorId) {
      violations.push(
        `forced assignment ${forced.newcomerId} -> ${forced.mentorId} is not honored`,
      );
    }
  }

  // 重新计分：只统计通过校验的配对
  const scores = new Map<string, number>();
  let totalScore = 0;
  for (const [newcomerId, mentorId] of mentorOf) {
    const newcomer = newcomerById.get(newcomerId)!;
    const mentor = mentorById.get(mentorId)!;
    const finalLoad = mentor.activeMenteeCount + (batchCountByMentor.get(mentorId) ?? 0);
    // 方案已因超负载被判非法时，负载项按 0 计，保证评估本身不抛异常
    const score = baseScore(newcomer, mentor) + (finalLoad <= MAX_LOAD ? loadScore(finalLoad) : 0);
    scores.set(newcomerId, score);
    totalScore += score;
  }

  return {
    valid: violations.length === 0,
    violations,
    matchedCount: mentorOf.size,
    scores,
    totalScore,
  };
}

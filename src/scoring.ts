import type { Mentor, Newcomer } from "./types.js";

const DEPARTMENT_POINTS = 30;
const LOCATION_POINTS = 10;
const INTEREST_POINTS_EACH = 5;
const INTEREST_POINTS_CAP = 25;
const TENURE_POINTS = 20;

/** 除负载项外的固定部分：部门 + 办公地点 + 共同兴趣 + 任职项 */
export function baseScore(newcomer: Newcomer, mentor: Mentor): number {
  let score = 0;
  if (newcomer.department === mentor.department) score += DEPARTMENT_POINTS;
  if (newcomer.location === mentor.location) score += LOCATION_POINTS;
  let shared = 0;
  for (const tag of newcomer.interests) {
    if (mentor.interests.has(tag)) shared += 1;
  }
  score += Math.min(shared * INTEREST_POINTS_EACH, INTEREST_POINTS_CAP);
  // 候选资格已由调用方确认（导师均任职满六个月），任职项固定得分
  score += TENURE_POINTS;
  return score;
}

/** 负载项：最终负载 1/2/3 分别得 15 / 7.5 / 0 */
export function loadScore(finalLoad: number): number {
  switch (finalLoad) {
    case 1:
      return 15;
    case 2:
      return 7.5;
    case 3:
      return 0;
    default:
      throw new Error(`invalid final load: ${finalLoad}`);
  }
}

/** 完整配对得分（含按最终负载计算的负载项） */
export function pairScore(
  newcomer: Newcomer,
  mentor: Mentor,
  finalLoad: number,
): number {
  return baseScore(newcomer, mentor) + loadScore(finalLoad);
}

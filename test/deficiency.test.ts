import { describe, expect, it } from "vitest";
import { plan, verify, type PlanInput } from "../src/index.js";

/**
 * Two tasks each need 2 judges. Only j1..j3 are eligible for either task
 * (capacity 1 each), so together they cannot staff 4 slots. j4 has plenty
 * of capacity but is the creator of both projects, hence never eligible.
 * Total capacity (3 + 5 = 8) is sufficient and each task alone is feasible.
 */
function sharedBottleneckInput(): PlanInput {
  return {
    judges: [
      { id: "j1", baseLoad: 0, capacity: 1 },
      { id: "j2", baseLoad: 0, capacity: 1 },
      { id: "j3", baseLoad: 0, capacity: 1 },
      { id: "j4", baseLoad: 0, capacity: 5 },
    ],
    tasks: [
      {
        id: "A",
        projectId: "pA",
        kind: "normal",
        requiredJudges: 2,
        lockedJudgeIds: [],
        preferredJudgeIds: [],
      },
      {
        id: "B",
        projectId: "pB",
        kind: "normal",
        requiredJudges: 2,
        lockedJudgeIds: [],
        preferredJudgeIds: [],
      },
    ],
    projects: [
      { id: "pA", creatorId: "j4", stakeholderIds: [], rounds: [] },
      { id: "pB", creatorId: "j4", stakeholderIds: [], rounds: [] },
    ],
  };
}

describe("deficiency evidence", () => {
  it("reports a verifiable certificate when shared candidates starve a task group", () => {
    const input = sharedBottleneckInput();
    const result = plan(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.deficiency.taskIds.sort()).toEqual(["A", "B"]);
    expect(result.deficiency.demand).toBe(4);
    expect(result.deficiency.supply).toBe(3);
    expect(result.deficiency.demand).toBeGreaterThan(
      result.deficiency.supply,
    );

    const report = verify(input, result);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("rejects certificates with a shrunken task set", () => {
    const input = sharedBottleneckInput();
    const result = plan(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const tampered = {
      ok: false as const,
      deficiency: {
        ...result.deficiency,
        taskIds: result.deficiency.taskIds.slice(0, 1),
      },
    };
    const report = verify(input, tampered);
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("rejects certificates with altered demand/supply numbers", () => {
    const input = sharedBottleneckInput();
    const result = plan(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    for (const deficiency of [
      { ...result.deficiency, demand: result.deficiency.demand + 1 },
      { ...result.deficiency, supply: result.deficiency.supply - 1 },
    ]) {
      expect(verify(input, { ok: false, deficiency }).valid).toBe(false);
    }
  });

  it("rejects an empty task set", () => {
    const input = sharedBottleneckInput();
    const report = verify(input, {
      ok: false,
      deficiency: { taskIds: [], demand: 0, supply: 0 },
    });
    expect(report.valid).toBe(false);
  });

  it("rejects a fabricated certificate for a feasible instance", () => {
    const input = sharedBottleneckInput();
    // Give j4 eligibility by removing the creator conflict: now feasible.
    input.projects = input.projects.map((p) => ({ ...p, creatorId: "x" }));
    const result = plan(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fabricated = {
      ok: false as const,
      deficiency: { taskIds: ["A", "B"], demand: 4, supply: 3 },
    };
    expect(verify(input, fabricated).valid).toBe(false);
  });

  it("accounts for locked pairs in the certificate arithmetic", () => {
    // Task A locks j1 (1 slot remains); task B needs 2. Only j1,j2 can
    // serve either task, j1 has capacity 2 (1 left after the lock).
    // S = {A, B}: demand = 1 + 2 = 3, supply = min(1, 2) + min(1, 2) = 2.
    const input: PlanInput = {
      judges: [
        { id: "j1", baseLoad: 0, capacity: 2 },
        { id: "j2", baseLoad: 0, capacity: 1 },
        { id: "j3", baseLoad: 0, capacity: 5 },
      ],
      tasks: [
        {
          id: "A",
          projectId: "pA",
          kind: "normal",
          requiredJudges: 2,
          lockedJudgeIds: ["j1"],
          preferredJudgeIds: [],
        },
        {
          id: "B",
          projectId: "pB",
          kind: "normal",
          requiredJudges: 2,
          lockedJudgeIds: [],
          preferredJudgeIds: [],
        },
      ],
      projects: [
        { id: "pA", creatorId: "j3", stakeholderIds: [], rounds: [] },
        { id: "pB", creatorId: "j3", stakeholderIds: [], rounds: [] },
      ],
    };
    const result = plan(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiency.taskIds.sort()).toEqual(["A", "B"]);
    expect(result.deficiency.demand).toBe(3);
    expect(result.deficiency.supply).toBe(2);
    expect(verify(input, result).valid).toBe(true);
  });
});

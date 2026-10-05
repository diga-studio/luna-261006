import { describe, expect, it } from "vitest";
import { plan, verify, type PlanInput } from "../src/index.js";
import { bruteForce } from "./helpers/brute.js";
import { randomSmallInput } from "./helpers/generator.js";

describe("plan vs exhaustive reference", () => {
  it("matches feasibility and both objectives on random small instances", () => {
    let feasibleCount = 0;
    let infeasibleCount = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const input = randomSmallInput(seed);
      const expected = bruteForce(input);
      const result = plan(input);

      expect(result.ok).toBe(expected.feasible);
      const report = verify(input, result);
      expect(report.errors).toEqual([]);
      expect(report.valid).toBe(true);

      if (expected.feasible) {
        feasibleCount++;
        if (!result.ok) throw new Error("unreachable");
        expect(result.objectives.load).toBe(expected.load);
        expect(result.objectives.unmetPreferences).toBe(
          expected.unmetPreferences,
        );
      } else {
        infeasibleCount++;
        if (result.ok) throw new Error("unreachable");
        expect(result.deficiency.taskIds.length).toBeGreaterThan(0);
        expect(result.deficiency.demand).toBeGreaterThan(
          result.deficiency.supply,
        );
      }
    }
    // Sanity: the random suite exercises both outcomes.
    expect(feasibleCount).toBeGreaterThan(0);
    expect(infeasibleCount).toBeGreaterThan(0);
  });
});

describe("targeted cases", () => {
  it("load objective overrides preferences", () => {
    const input: PlanInput = {
      judges: [
        { id: "loaded", baseLoad: 5, capacity: 5 },
        { id: "fresh", baseLoad: 0, capacity: 5 },
      ],
      tasks: [
        {
          id: "t1",
          projectId: "p1",
          kind: "normal",
          requiredJudges: 1,
          lockedJudgeIds: [],
          preferredJudgeIds: ["loaded"],
        },
      ],
      projects: [
        { id: "p1", creatorId: "someone-else", stakeholderIds: [], rounds: [] },
      ],
    };
    const result = plan(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5^2+1^2=26 with the fresh judge beats 6^2+0=36 with the preferred one.
    expect(result.assignments["t1"]).toEqual(["fresh"]);
    expect(result.objectives).toEqual({ load: 26, unmetPreferences: 1 });
    expect(verify(input, result).valid).toBe(true);
  });

  it("locked pairs consume capacity", () => {
    const input: PlanInput = {
      judges: [
        { id: "j1", baseLoad: 0, capacity: 1 },
        { id: "j2", baseLoad: 0, capacity: 1 },
      ],
      tasks: [
        {
          id: "a",
          projectId: "p1",
          kind: "normal",
          requiredJudges: 1,
          lockedJudgeIds: ["j1"],
          preferredJudgeIds: [],
        },
        {
          id: "b",
          projectId: "p2",
          kind: "normal",
          requiredJudges: 1,
          lockedJudgeIds: [],
          preferredJudgeIds: ["j1"],
        },
      ],
      projects: [
        { id: "p1", creatorId: "x", stakeholderIds: [], rounds: [] },
        { id: "p2", creatorId: "y", stakeholderIds: [], rounds: [] },
      ],
    };
    const result = plan(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignments["a"]).toEqual(["j1"]);
    // j1 is full, so b must take j2 even though j1 is preferred.
    expect(result.assignments["b"]).toEqual(["j2"]);
    expect(result.objectives).toEqual({ load: 2, unmetPreferences: 1 });
    expect(verify(input, result).valid).toBe(true);
  });

  it("appeals exclude judges from all historical rounds, not just the last", () => {
    const projects = [
      {
        id: "p1",
        creatorId: "creator",
        stakeholderIds: [],
        rounds: [["j1"], ["j2"]],
      },
    ];
    const judges = [
      { id: "j1", baseLoad: 0, capacity: 5 },
      { id: "j2", baseLoad: 0, capacity: 5 },
      { id: "j3", baseLoad: 0, capacity: 5 },
    ];
    const appeal: PlanInput = {
      judges,
      tasks: [
        {
          id: "t",
          projectId: "p1",
          kind: "appeal",
          requiredJudges: 1,
          lockedJudgeIds: [],
          preferredJudgeIds: [],
        },
      ],
      projects,
    };
    const appealResult = plan(appeal);
    expect(appealResult.ok).toBe(true);
    if (!appealResult.ok) return;
    // j1 judged round 1 only; still excluded from the appeal.
    expect(appealResult.assignments["t"]).toEqual(["j3"]);

    const normal: PlanInput = {
      ...appeal,
      tasks: [{ ...appeal.tasks[0]!, kind: "normal" }],
    };
    const normalResult = plan(normal);
    expect(normalResult.ok).toBe(true);
    if (!normalResult.ok) return;
    // Normal reviews may reuse historical judges; all three are eligible and
    // equally loaded, so any single judge is a valid optimum.
    expect(normalResult.assignments["t"]).toHaveLength(1);
    expect(normalResult.objectives.load).toBe(1);
  });

  it("verify rejects tampered success results", () => {
    const input = randomSmallInput(7);
    const result = plan(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const wrongLoad = {
      ...result,
      objectives: { ...result.objectives, load: result.objectives.load + 1 },
    };
    expect(verify(input, wrongLoad).valid).toBe(false);

    const taskId = input.tasks[0]!.id;
    const shrunk = {
      ...result,
      assignments: {
        ...result.assignments,
        [taskId]: result.assignments[taskId]!.slice(1),
      },
    };
    expect(verify(input, shrunk).valid).toBe(false);
  });
});

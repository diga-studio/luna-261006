import { computeInspection } from "./engine.js";
import { PlanStore } from "./store.js";
import type { Inspection, PlanSeed } from "./types.js";

/** 一个打开的计划句柄。 */
export interface Plan {
  confirm(requestId: string, paidAt: number, amount: number): void;
  advanceTo(now: number): void;
  inspect(): Inspection;
  close(): void;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
}

function validateSeed(seed: PlanSeed): void {
  assertInteger(seed.startAt, "seed.startAt");
  if (!Array.isArray(seed.installments) || seed.installments.length === 0) {
    throw new Error("seed.installments must be a non-empty array");
  }
  let prevDueAt = -Infinity;
  seed.installments.forEach((inst, i) => {
    assertInteger(inst.principal, `installments[${i}].principal`);
    assertInteger(inst.dueAt, `installments[${i}].dueAt`);
    if (inst.principal <= 0) {
      throw new Error(`installments[${i}].principal must be positive`);
    }
    if (inst.dueAt <= seed.startAt) {
      throw new Error(`installments[${i}].dueAt must be later than startAt`);
    }
    if (inst.dueAt < prevDueAt) {
      throw new Error("installments must be sorted by dueAt ascending");
    }
    prevDueAt = inst.dueAt;
  });
}

/**
 * 创建或重开一个计划库文件。
 * 文件已含计划数据时忽略 seed，使用已保存的数据重开。
 */
export function openPlan(path: string, seed?: PlanSeed): Plan {
  const store = new PlanStore(path);
  try {
    if (!store.hasPlan()) {
      if (seed === undefined) {
        throw new Error("seed is required when creating a new plan");
      }
      validateSeed(seed);
      store.initialize(seed);
    }
  } catch (err) {
    store.close();
    throw err;
  }

  return {
    confirm(requestId: string, paidAt: number, amount: number): void {
      if (typeof requestId !== "string" || requestId.length === 0) {
        throw new Error("requestId must be a non-empty string");
      }
      assertInteger(paidAt, "paidAt");
      assertInteger(amount, "amount");
      if (amount <= 0) {
        throw new Error("amount must be positive");
      }
      const startAt = store.getStartAt();
      const now = store.getNow();
      if (paidAt < startAt || paidAt > now) {
        throw new Error(
          `paidAt must be within [startAt=${startAt}, now=${now}], got ${paidAt}`,
        );
      }
      const existing = store.getConfirmation(requestId);
      if (existing !== null) {
        if (existing.paidAt === paidAt && existing.amount === amount) {
          return; // 同 ID 同内容：幂等，不重复入账。
        }
        throw new Error(
          `requestId ${requestId} already recorded with different content`,
        );
      }
      store.insertConfirmation({ requestId, paidAt, amount });
    },

    advanceTo(now: number): void {
      assertInteger(now, "now");
      const current = store.getNow();
      if (now < current) {
        throw new Error(
          `now must be monotonically non-decreasing: current ${current}, got ${now}`,
        );
      }
      store.setNow(now);
    },

    inspect(): Inspection {
      return computeInspection(
        store.getStartAt(),
        store.getInstallments(),
        store.getConfirmations(),
        store.getNow(),
      );
    },

    close(): void {
      store.close();
    },
  };
}

import { PlanStore, type StoredConfirmation } from "./store.js";
import { computeSnapshot } from "./engine.js";
import type { InstallmentSeed, Plan, PlanSeed, PlanSnapshot } from "./types.js";

function assertInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
}

function validateSeed(seed: PlanSeed): void {
  assertInteger(seed.startAt, "seed.startAt");
  if (!Array.isArray(seed.installments)) {
    throw new Error("seed.installments must be an array");
  }
  let prevDueAt = seed.startAt;
  seed.installments.forEach((inst, idx) => {
    assertInteger(inst.dueAt, `seed.installments[${idx}].dueAt`);
    assertInteger(inst.principal, `seed.installments[${idx}].principal`);
    if (inst.principal < 0) {
      throw new Error(`seed.installments[${idx}].principal must be >= 0`);
    }
    if (inst.dueAt <= prevDueAt) {
      throw new Error(
        `seed.installments must have dueAt strictly increasing and later than startAt`,
      );
    }
    prevDueAt = inst.dueAt;
  });
}

/**
 * 创建或重开计划。path 为 SQLite 库文件路径；
 * 首次创建必须提供 seed，重开时忽略 seed，使用已保存的数据。
 */
export function openPlan(path: string, seed?: PlanSeed): Plan {
  if (seed !== undefined) {
    validateSeed(seed);
  }
  const store = new PlanStore(path);
  try {
    const stored = store.loadOrInit(seed);
    const startAt = stored.startAt;
    const installments: InstallmentSeed[] = stored.installments;
    const confirmations: StoredConfirmation[] = stored.confirmations;
    let now = stored.now;

    return {
      confirm(requestId: string, paidAt: number, amount: number): void {
        if (typeof requestId !== "string" || requestId.length === 0) {
          throw new Error("confirm: requestId must be a non-empty string");
        }
        assertInteger(paidAt, "confirm: paidAt");
        assertInteger(amount, "confirm: amount");
        if (amount <= 0) {
          throw new Error("confirm: amount must be positive");
        }
        if (paidAt < startAt || paidAt > now) {
          throw new Error(
            `confirm: paidAt ${paidAt} out of range [startAt=${startAt}, now=${now}]`,
          );
        }
        const exists = confirmations.some((c) => c.requestId === requestId);
        store.addConfirmation(requestId, paidAt, amount);
        if (!exists) {
          confirmations.push({ requestId, paidAt, amount });
        }
      },
      advanceTo(next: number): void {
        assertInteger(next, "advanceTo: now");
        if (next < now) {
          throw new Error(`advanceTo: now must be monotonic (current ${now}, got ${next})`);
        }
        if (next !== now) {
          store.setNow(next);
          now = next;
        }
      },
      inspect(): PlanSnapshot {
        return computeSnapshot(startAt, installments, confirmations, now);
      },
      close(): void {
        store.close();
      },
    };
  } catch (err) {
    store.close();
    throw err;
  }
}

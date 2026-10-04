import type { InstallmentSeed, PlanSnapshot, Allocation } from "./types.js";
import type { StoredConfirmation } from "./store.js";

export const FEE_AMOUNT = 500;
export const FEE_CAP_TOTAL = 1500;
export const GRACE_SECONDS = 259200;

interface EngineEvent {
  time: number;
  /** 0 = 到账，1 = 费用检查；同一时刻先处理到账 */
  kind: 0 | 1;
  /** 到账按 requestId 字典序，费用检查按期次顺序 */
  orderKey: string | number;
  confirmation?: StoredConfirmation;
  installmentIndex?: number;
}

/**
 * 确定性重放：由 (seed, confirmations, now) 计算完整快照。
 * 结果与确认接收顺序、逾期扫描次数无关。
 */
export function computeSnapshot(
  startAt: number,
  installments: InstallmentSeed[],
  confirmations: StoredConfirmation[],
  now: number,
): PlanSnapshot {
  void startAt;
  const events: EngineEvent[] = [];
  for (const c of confirmations) {
    events.push({ time: c.paidAt, kind: 0, orderKey: c.requestId, confirmation: c });
  }
  installments.forEach((inst, idx) => {
    const checkTime = inst.dueAt + GRACE_SECONDS;
    if (checkTime <= now) {
      events.push({ time: checkTime, kind: 1, orderKey: idx, installmentIndex: idx });
    }
  });
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.kind !== b.kind) return a.kind - b.kind;
    if (a.kind === 0) return String(a.orderKey) < String(b.orderKey) ? -1 : 1;
    return Number(a.orderKey) - Number(b.orderKey);
  });

  const principalOutstanding = installments.map((inst) => inst.principal);
  const feeOutstanding = installments.map(() => 0);
  const feeCharged = installments.map(() => false);
  let totalFeesCharged = 0;
  let unallocated = 0;
  const allocations: Allocation[] = [];

  for (const ev of events) {
    if (ev.kind === 1) {
      const idx = ev.installmentIndex as number;
      if (
        !feeCharged[idx] &&
        principalOutstanding[idx] > 0 &&
        totalFeesCharged + FEE_AMOUNT <= FEE_CAP_TOTAL
      ) {
        feeCharged[idx] = true;
        feeOutstanding[idx] += FEE_AMOUNT;
        totalFeesCharged += FEE_AMOUNT;
      }
      continue;
    }
    const c = ev.confirmation as StoredConfirmation;
    let remaining = c.amount;
    let feesPaid = 0;
    let principalPaid = 0;
    for (let i = 0; i < installments.length && remaining > 0; i++) {
      const pay = Math.min(remaining, feeOutstanding[i]);
      feeOutstanding[i] -= pay;
      feesPaid += pay;
      remaining -= pay;
    }
    for (let i = 0; i < installments.length && remaining > 0; i++) {
      const pay = Math.min(remaining, principalOutstanding[i]);
      principalOutstanding[i] -= pay;
      principalPaid += pay;
      remaining -= pay;
    }
    unallocated += remaining;
    allocations.push({
      requestId: c.requestId,
      paidAt: c.paidAt,
      amount: c.amount,
      feesPaid,
      principalPaid,
      unallocated: remaining,
    });
  }

  return {
    now,
    installments: installments.map((inst, idx) => ({
      index: idx,
      dueAt: inst.dueAt,
      principalOutstanding: principalOutstanding[idx],
      feeOutstanding: feeOutstanding[idx],
      feeCharged: feeCharged[idx],
    })),
    unallocated,
    allocations,
    totalFeesCharged,
  };
}

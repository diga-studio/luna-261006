import type {
  Confirmation,
  ConfirmationAllocation,
  Inspection,
  SeedInstallment,
} from "./types.js";

/** 滞纳费在 dueAt 之后多少秒计提。 */
export const FEE_DELAY_SECONDS = 259200;
/** 每期滞纳费（美分）。 */
export const FEE_PER_INSTALLMENT = 500;
/** 每计划滞纳费累计上限（美分）。 */
export const FEE_CAP_PER_PLAN = 1500;

/**
 * 确定性重算：由种子、全部确认与观察时刻推导完整归账状态。
 *
 * 经济时间规则：
 * - 事件按时间推进；同一时刻先处理到账（按 requestId ASCII 字典序），再判断费用。
 * - 费用检查点为 dueAt + FEE_DELAY_SECONDS；检查时本金未清偿则计提，
 *   每期最多一次，全计划累计不超过 FEE_CAP_PER_PLAN（已支付的仍占名额）。
 * - 一笔到账先抵未偿费用、再抵本金，两类内部均按期次从早到晚；
 *   剩余进入未分配余额。
 *
 * 由于每次都从种子与全部确认重算，结果与确认接收顺序、逾期扫描次数无关。
 */
export function computeInspection(
  startAt: number,
  installments: SeedInstallment[],
  confirmations: Confirmation[],
  now: number,
): Inspection {
  const principalRemaining = installments.map((i) => i.principal);
  const feeRemaining = installments.map(() => 0);
  const feeCharged = installments.map(() => false);
  let planFeeTotal = 0;
  let unallocated = 0;

  const sorted = [...confirmations].sort(
    (a, b) => a.paidAt - b.paidAt || (a.requestId < b.requestId ? -1 : 1),
  );
  const allocations: ConfirmationAllocation[] = [];

  // 费用检查事件：仅考虑不超过观察时刻的检查点。
  const feeChecks = installments
    .map((inst, index) => ({ index, at: inst.dueAt + FEE_DELAY_SECONDS }))
    .filter((e) => e.at <= now)
    .sort((a, b) => a.at - b.at || a.index - b.index);

  let confIdx = 0;
  let feeIdx = 0;
  while (confIdx < sorted.length || feeIdx < feeChecks.length) {
    const nextConfAt = confIdx < sorted.length ? sorted[confIdx].paidAt : Infinity;
    const nextFeeAt = feeIdx < feeChecks.length ? feeChecks[feeIdx].at : Infinity;
    if (nextConfAt <= nextFeeAt) {
      // 同一时刻先处理到账。
      const conf = sorted[confIdx++];
      let remaining = conf.amount;
      let toFee = 0;
      let toPrincipal = 0;
      for (let i = 0; i < installments.length && remaining > 0; i++) {
        const pay = Math.min(remaining, feeRemaining[i]);
        feeRemaining[i] -= pay;
        remaining -= pay;
        toFee += pay;
      }
      for (let i = 0; i < installments.length && remaining > 0; i++) {
        const pay = Math.min(remaining, principalRemaining[i]);
        principalRemaining[i] -= pay;
        remaining -= pay;
        toPrincipal += pay;
      }
      unallocated += remaining;
      allocations.push({
        requestId: conf.requestId,
        paidAt: conf.paidAt,
        amount: conf.amount,
        toPrincipal,
        toFee,
        unallocated: remaining,
      });
    } else {
      const check = feeChecks[feeIdx++];
      if (
        !feeCharged[check.index] &&
        principalRemaining[check.index] > 0 &&
        planFeeTotal + FEE_PER_INSTALLMENT <= FEE_CAP_PER_PLAN
      ) {
        feeCharged[check.index] = true;
        feeRemaining[check.index] += FEE_PER_INSTALLMENT;
        planFeeTotal += FEE_PER_INSTALLMENT;
      }
    }
  }

  return {
    startAt,
    now,
    installments: installments.map((inst, index) => ({
      index,
      dueAt: inst.dueAt,
      principalRemaining: principalRemaining[index],
      feeRemaining: feeRemaining[index],
    })),
    unallocated,
    allocations,
  };
}

import type { Snapshot } from "./types.js";

export interface ReplayReport {
  ok: boolean;
  /** 重放得到的各资金桶余额，键为流水中的 source/destination 资金桶名。 */
  balances: Map<string, number>;
  problems: string[];
}

function add(balances: Map<string, number>, bucket: string, delta: number): void {
  balances.set(bucket, (balances.get(bucket) ?? 0) + delta);
}

/**
 * 从初始余额独立重放资金流水，复算当前账目并与 snapshot 对照。
 * 校验：每笔移动非负、来源桶不透支、总额守恒、最终账目与快照一致。
 */
export function replay(snapshot: Snapshot): ReplayReport {
  const problems: string[] = [];
  const balances = new Map<string, number>();

  for (const entry of snapshot.entries) {
    if (!Number.isSafeInteger(entry.amount) || entry.amount < 0) {
      problems.push(`entry#${entry.seq}: 非法金额 ${entry.amount}`);
      continue;
    }
    if (entry.op === "init") {
      add(balances, entry.destination, entry.amount);
      continue;
    }
    const sourceBalance = balances.get(entry.source) ?? 0;
    if (sourceBalance < entry.amount) {
      problems.push(
        `entry#${entry.seq}: 来源 ${entry.source} 余额 ${sourceBalance} 不足以支出 ${entry.amount}`,
      );
    }
    add(balances, entry.source, -entry.amount);
    add(balances, entry.destination, entry.amount);
  }

  let total = 0;
  for (const [bucket, balance] of balances) {
    if (balance < 0) problems.push(`资金桶 ${bucket} 余额为负: ${balance}`);
    total += balance;
  }
  if (total !== snapshot.totalSupply) {
    problems.push(`总额 ${total} 与初始信用总额 ${snapshot.totalSupply} 不一致`);
  }

  for (const account of snapshot.accounts) {
    const available = balances.get(`account:${account.accountId}:available`) ?? 0;
    if (available !== account.available) {
      problems.push(
        `账户 ${account.accountId} 可用余额重放值 ${available} != 快照 ${account.available}`,
      );
    }
    const earnings = balances.get(`account:${account.accountId}:earnings`) ?? 0;
    if (earnings !== account.earnings) {
      problems.push(
        `账户 ${account.accountId} 收益余额重放值 ${earnings} != 快照 ${account.earnings}`,
      );
    }
  }
  for (const milestone of snapshot.milestones) {
    const frozen = balances.get(
      `milestone:${milestone.projectId}:${milestone.milestoneId}`,
    ) ?? 0;
    const expected = milestone.status === "frozen" ? milestone.amount : 0;
    if (frozen !== expected) {
      problems.push(
        `里程碑 ${milestone.projectId}/${milestone.milestoneId} 冻结额重放值 ${frozen} != 应有 ${expected}`,
      );
    }
  }

  return { ok: problems.length === 0, balances, problems };
}

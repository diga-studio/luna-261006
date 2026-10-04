import { DatabaseSync } from "node:sqlite";
import type {
  AccountSnapshot,
  CancelResult,
  LedgerEntry,
  LedgerInit,
  MilestoneId,
  MilestoneSnapshot,
  OpKey,
  OpName,
  ProjectId,
  ProjectSnapshot,
  ReserveResult,
  ResolveResult,
  Result,
  Snapshot,
} from "./types.js";

const BUCKET_EXTERNAL = "external:init";

function accountAvailable(accountId: string): string {
  return `account:${accountId}:available`;
}
function accountEarnings(accountId: string): string {
  return `account:${accountId}:earnings`;
}
function milestoneBucket(projectId: string, milestoneId: string): string {
  return `milestone:${projectId}:${milestoneId}`;
}

function isValidAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

interface KeyRow {
  op: string;
  params: string;
  result: string;
}

/**
 * 里程碑托管账本。只处理信用额度，不涉及真实支付。
 * 持久化使用 SQLite（node:sqlite），默认 ":memory:"，也可传文件路径。
 */
export class Ledger {
  private readonly db: DatabaseSync;
  private readonly totalSupply: number;

  constructor(init: LedgerInit, dbPath: string = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        available INTEGER NOT NULL CHECK (available >= 0),
        earnings INTEGER NOT NULL CHECK (earnings >= 0)
      );
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','cancelled'))
      );
      CREATE TABLE IF NOT EXISTS milestones (
        project_id TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount >= 0),
        status TEXT NOT NULL CHECK (status IN ('frozen','resolved','refunded')),
        award INTEGER,
        PRIMARY KEY (project_id, milestone_id)
      );
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        params TEXT NOT NULL,
        result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        op TEXT NOT NULL,
        source TEXT NOT NULL,
        destination TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount >= 0)
      );
    `);
    this.totalSupply = this.initialize(init);
  }

  private initialize(init: LedgerInit): number {
    // 文件库重开：已有数据时跳过初始化，从 init 流水恢复总额。
    const existing = this.db
      .prepare("SELECT COUNT(*) AS n FROM accounts")
      .get() as { n: number };
    if (existing.n > 0) {
      const row = this.db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM entries WHERE op = 'init'")
        .get() as { total: number };
      return row.total;
    }
    const accountIds = new Set<string>();
    for (const account of init.accounts) {
      if (
        !account.accountId ||
        accountIds.has(account.accountId) ||
        !isValidAmount(account.available)
      ) {
        throw new Error("invalid_init: accounts");
      }
      accountIds.add(account.accountId);
    }
    const projectIds = new Set<string>();
    for (const project of init.projects) {
      if (
        !project.projectId ||
        projectIds.has(project.projectId) ||
        !accountIds.has(project.clientId) ||
        !accountIds.has(project.creatorId)
      ) {
        throw new Error("invalid_init: projects");
      }
      projectIds.add(project.projectId);
    }

    let total = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertAccount = this.db.prepare(
        "INSERT INTO accounts (account_id, available, earnings) VALUES (?, ?, 0)",
      );
      const insertProject = this.db.prepare(
        "INSERT INTO projects (project_id, client_id, creator_id, status) VALUES (?, ?, ?, 'open')",
      );
      const insertEntry = this.db.prepare(
        "INSERT INTO entries (key, op, source, destination, amount) VALUES (?, 'init', ?, ?, ?)",
      );
      for (const account of init.accounts) {
        insertAccount.run(account.accountId, account.available);
        if (account.available > 0) {
          insertEntry.run(
            `init:${account.accountId}`,
            BUCKET_EXTERNAL,
            accountAvailable(account.accountId),
            account.available,
          );
        }
        total += account.available;
      }
      for (const project of init.projects) {
        insertProject.run(project.projectId, project.clientId, project.creatorId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return total;
  }

  /**
   * 幂等键处理：同键同参数返回首次成功的结果；同键不同参数拒绝。
   * 返回 null 表示该键未被占用，调用方应继续执行操作。
   */
  private checkKey<T>(
    key: OpKey,
    op: OpName,
    params: Record<string, unknown>,
  ): Result<T> | null {
    const row = this.db
      .prepare("SELECT op, params, result FROM keys WHERE key = ?")
      .get(key) as KeyRow | undefined;
    if (!row) return null;
    const paramsJson = JSON.stringify(params);
    if (row.op === op && row.params === paramsJson) {
      return { ok: true, value: JSON.parse(row.result) as T };
    }
    return { ok: false, reason: "duplicate_key_conflict" };
  }

  private recordKey(
    key: OpKey,
    op: OpName,
    params: Record<string, unknown>,
    result: unknown,
  ): void {
    this.db
      .prepare("INSERT INTO keys (key, op, params, result) VALUES (?, ?, ?, ?)")
      .run(key, op, JSON.stringify(params), JSON.stringify(result));
  }

  private addEntry(
    key: OpKey,
    op: OpName,
    source: string,
    destination: string,
    amount: number,
  ): void {
    if (amount === 0) return;
    this.db
      .prepare(
        "INSERT INTO entries (key, op, source, destination, amount) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, op, source, destination, amount);
  }

  reserve(
    projectId: ProjectId,
    milestoneId: MilestoneId,
    amount: number,
    key: OpKey,
  ): Result<ReserveResult> {
    const params = { projectId, milestoneId, amount };
    const hit = this.checkKey<ReserveResult>(key, "reserve", params);
    if (hit) return hit;

    if (!isValidAmount(amount) || amount === 0) {
      return { ok: false, reason: "invalid_amount" };
    }
    const project = this.db
      .prepare("SELECT client_id, status FROM projects WHERE project_id = ?")
      .get(projectId) as { client_id: string; status: string } | undefined;
    if (!project) return { ok: false, reason: "unknown_project" };
    if (project.status !== "open") return { ok: false, reason: "project_cancelled" };
    const existing = this.db
      .prepare(
        "SELECT 1 AS x FROM milestones WHERE project_id = ? AND milestone_id = ?",
      )
      .get(projectId, milestoneId);
    if (existing) return { ok: false, reason: "milestone_exists" };
    const account = this.db
      .prepare("SELECT available FROM accounts WHERE account_id = ?")
      .get(project.client_id) as { available: number };
    if (account.available < amount) {
      return { ok: false, reason: "insufficient_funds" };
    }

    const result: ReserveResult = { projectId, milestoneId, amount };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE accounts SET available = available - ? WHERE account_id = ?")
        .run(amount, project.client_id);
      this.db
        .prepare(
          "INSERT INTO milestones (project_id, milestone_id, amount, status, award) VALUES (?, ?, ?, 'frozen', NULL)",
        )
        .run(projectId, milestoneId, amount);
      this.addEntry(
        key,
        "reserve",
        accountAvailable(project.client_id),
        milestoneBucket(projectId, milestoneId),
        amount,
      );
      this.recordKey(key, "reserve", params, result);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, value: result };
  }

  resolve(
    projectId: ProjectId,
    milestoneId: MilestoneId,
    award: number,
    key: OpKey,
  ): Result<ResolveResult> {
    const params = { projectId, milestoneId, award };
    const hit = this.checkKey<ResolveResult>(key, "resolve", params);
    if (hit) return hit;

    if (!isValidAmount(award)) return { ok: false, reason: "invalid_amount" };
    const project = this.db
      .prepare("SELECT client_id, creator_id, status FROM projects WHERE project_id = ?")
      .get(projectId) as
      | { client_id: string; creator_id: string; status: string }
      | undefined;
    if (!project) return { ok: false, reason: "unknown_project" };
    const milestone = this.db
      .prepare(
        "SELECT amount, status FROM milestones WHERE project_id = ? AND milestone_id = ?",
      )
      .get(projectId, milestoneId) as
      | { amount: number; status: string }
      | undefined;
    if (!milestone) return { ok: false, reason: "milestone_not_found" };
    if (milestone.status !== "frozen") {
      return { ok: false, reason: "milestone_already_final" };
    }
    if (project.status !== "open") return { ok: false, reason: "project_cancelled" };
    if (award > milestone.amount) {
      return { ok: false, reason: "award_out_of_range" };
    }

    const refunded = milestone.amount - award;
    const result: ResolveResult = { projectId, milestoneId, award, refunded };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE milestones SET status = 'resolved', award = ? WHERE project_id = ? AND milestone_id = ?",
        )
        .run(award, projectId, milestoneId);
      this.db
        .prepare("UPDATE accounts SET earnings = earnings + ? WHERE account_id = ?")
        .run(award, project.creator_id);
      this.db
        .prepare("UPDATE accounts SET available = available + ? WHERE account_id = ?")
        .run(refunded, project.client_id);
      const bucket = milestoneBucket(projectId, milestoneId);
      this.addEntry(key, "resolve", bucket, accountEarnings(project.creator_id), award);
      this.addEntry(key, "resolve", bucket, accountAvailable(project.client_id), refunded);
      this.recordKey(key, "resolve", params, result);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, value: result };
  }

  cancel(projectId: ProjectId, key: OpKey): Result<CancelResult> {
    const params = { projectId };
    const hit = this.checkKey<CancelResult>(key, "cancel", params);
    if (hit) return hit;

    const project = this.db
      .prepare("SELECT client_id, status FROM projects WHERE project_id = ?")
      .get(projectId) as { client_id: string; status: string } | undefined;
    if (!project) return { ok: false, reason: "unknown_project" };
    if (project.status !== "open") return { ok: false, reason: "project_cancelled" };

    const frozen = this.db
      .prepare(
        "SELECT milestone_id, amount FROM milestones WHERE project_id = ? AND status = 'frozen' ORDER BY milestone_id",
      )
      .all(projectId) as unknown as { milestone_id: string; amount: number }[];

    const refundedTotal = frozen.reduce((sum, row) => sum + row.amount, 0);
    const result: CancelResult = {
      projectId,
      refundedTotal,
      refundedMilestones: frozen.map((row) => row.milestone_id),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE projects SET status = 'cancelled' WHERE project_id = ?")
        .run(projectId);
      const refundMilestone = this.db.prepare(
        "UPDATE milestones SET status = 'refunded' WHERE project_id = ? AND milestone_id = ?",
      );
      for (const row of frozen) {
        refundMilestone.run(projectId, row.milestone_id);
        this.addEntry(
          key,
          "cancel",
          milestoneBucket(projectId, row.milestone_id),
          accountAvailable(project.client_id),
          row.amount,
        );
      }
      this.db
        .prepare("UPDATE accounts SET available = available + ? WHERE account_id = ?")
        .run(refundedTotal, project.client_id);
      this.recordKey(key, "cancel", params, result);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, value: result };
  }

  snapshot(): Snapshot {
    const accounts = this.db
      .prepare("SELECT account_id, available, earnings FROM accounts ORDER BY account_id")
      .all() as unknown as { account_id: string; available: number; earnings: number }[];
    const projects = this.db
      .prepare(
        "SELECT project_id, client_id, creator_id, status FROM projects ORDER BY project_id",
      )
      .all() as unknown as {
      project_id: string;
      client_id: string;
      creator_id: string;
      status: string;
    }[];
    const milestones = this.db
      .prepare(
        "SELECT project_id, milestone_id, amount, status, award FROM milestones ORDER BY project_id, milestone_id",
      )
      .all() as unknown as {
      project_id: string;
      milestone_id: string;
      amount: number;
      status: string;
      award: number | null;
    }[];
    const entries = this.db
      .prepare(
        "SELECT seq, key, op, source, destination, amount FROM entries ORDER BY seq",
      )
      .all() as unknown as {
      seq: number;
      key: string;
      op: string;
      source: string;
      destination: string;
      amount: number;
    }[];

    const accountSnapshots: AccountSnapshot[] = accounts.map((row) => ({
      accountId: row.account_id,
      available: row.available,
      earnings: row.earnings,
    }));
    const projectSnapshots: ProjectSnapshot[] = projects.map((row) => ({
      projectId: row.project_id,
      clientId: row.client_id,
      creatorId: row.creator_id,
      status: row.status as ProjectSnapshot["status"],
    }));
    const milestoneSnapshots: MilestoneSnapshot[] = milestones.map((row) => ({
      projectId: row.project_id,
      milestoneId: row.milestone_id,
      amount: row.amount,
      status: row.status as MilestoneSnapshot["status"],
      award: row.award,
    }));
    const ledgerEntries: LedgerEntry[] = entries.map((row) => ({
      seq: row.seq,
      key: row.key,
      op: row.op as LedgerEntry["op"],
      source: row.source,
      destination: row.destination,
      amount: row.amount,
    }));
    return {
      accounts: accountSnapshots,
      projects: projectSnapshots,
      milestones: milestoneSnapshots,
      entries: ledgerEntries,
      totalSupply: this.totalSupply,
    };
  }

  close(): void {
    this.db.close();
  }
}

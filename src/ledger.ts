import { DatabaseSync } from "node:sqlite";
import type {
  AccountSnapshot,
  CancelResult,
  FlowEntry,
  LedgerInit,
  MilestoneId,
  MilestoneSnapshot,
  OpKey,
  ProjectId,
  ProjectSnapshot,
  ReserveResult,
  ResolveResult,
  Result,
  Snapshot,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  available INTEGER NOT NULL CHECK (available >= 0),
  earnings INTEGER NOT NULL DEFAULT 0 CHECK (earnings >= 0)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES accounts(id),
  creator_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'))
);
CREATE TABLE IF NOT EXISTS milestones (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','refunded')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  award INTEGER,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS ops (
  key TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  params TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flows (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  op TEXT NOT NULL,
  project_id TEXT,
  milestone_id TEXT,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0)
);
`;

/** 流水中的虚拟账户前缀。 */
export const EXTERNAL = "external";
const escrowAccount = (projectId: ProjectId, milestoneId: MilestoneId): string =>
  `escrow:${projectId}:${milestoneId}`;
const earningsAccount = (accountId: string): string => `earnings:${accountId}`;

function assertValidAmount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative safe integer, got ${value}`);
  }
}

/**
 * 里程碑托管账本：只处理信用额度，SQLite 持久化。
 * 初始化时一次性提供账户余额与项目归属，之后不充值、不改归属。
 */
export class Ledger {
  private readonly db: DatabaseSync;

  constructor(init: LedgerInit) {
    this.db = new DatabaseSync(init.path ?? ":memory:");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);

    const accountIds = new Set<string>();
    for (const account of init.accounts) {
      if (accountIds.has(account.id)) {
        throw new Error(`duplicate account id: ${account.id}`);
      }
      accountIds.add(account.id);
      assertValidAmount(account.available, "initial balance");
    }
    const projectIds = new Set<string>();
    for (const project of init.projects) {
      if (projectIds.has(project.id)) {
        throw new Error(`duplicate project id: ${project.id}`);
      }
      projectIds.add(project.id);
      if (!accountIds.has(project.clientId)) {
        throw new Error(`project ${project.id}: unknown client ${project.clientId}`);
      }
      if (!accountIds.has(project.creatorId)) {
        throw new Error(`project ${project.id}: unknown creator ${project.creatorId}`);
      }
    }

    this.db.exec("BEGIN");
    try {
      const insertAccount = this.db.prepare(
        "INSERT INTO accounts (id, available, earnings) VALUES (?, ?, 0)",
      );
      const insertProject = this.db.prepare(
        "INSERT INTO projects (id, client_id, creator_id) VALUES (?, ?, ?)",
      );
      const insertFlow = this.db.prepare(
        `INSERT INTO flows (key, op, project_id, milestone_id, from_account, to_account, amount)
         VALUES (?, 'init', NULL, NULL, ?, ?, ?)`,
      );
      for (const account of init.accounts) {
        insertAccount.run(account.id, account.available);
        if (account.available > 0) {
          insertFlow.run(`init:${account.id}`, EXTERNAL, account.id, account.available);
        }
      }
      for (const project of init.projects) {
        insertProject.run(project.id, project.clientId, project.creatorId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }


  /**
   * 幂等执行：key 已存在时，参数一致返回首次成功的结果，不一致拒绝；
   * 否则在单事务内执行变更并登记 key。失败调用不占用 key。
   */
  private withIdempotency<T>(
    key: OpKey,
    op: string,
    params: unknown,
    fn: () => Result<T>,
  ): Result<T> {
    const paramsJson = JSON.stringify(params);
    const existing = this.db
      .prepare("SELECT op, params, result FROM ops WHERE key = ?")
      .get(key) as { op: string; params: string; result: string } | undefined;
    if (existing !== undefined) {
      if (existing.op === op && existing.params === paramsJson) {
        return { ok: true, value: JSON.parse(existing.result) as T };
      }
      return { ok: false, error: "KEY_CONFLICT" };
    }
    this.db.exec("BEGIN");
    try {
      const result = fn();
      if (!result.ok) {
        this.db.exec("ROLLBACK");
        return result;
      }
      this.db
        .prepare("INSERT INTO ops (key, op, params, result) VALUES (?, ?, ?, ?)")
        .run(key, op, paramsJson, JSON.stringify(result.value));
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private insertFlow(
    key: OpKey,
    op: string,
    projectId: ProjectId,
    milestoneId: MilestoneId | null,
    from: string,
    to: string,
    amount: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO flows (key, op, project_id, milestone_id, from_account, to_account, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, op, projectId, milestoneId, from, to, amount);
  }

  reserve(
    projectId: ProjectId,
    milestoneId: MilestoneId,
    amount: number,
    key: OpKey,
  ): Result<ReserveResult> {
    return this.withIdempotency<ReserveResult>(
      key,
      "reserve",
      { projectId, milestoneId, amount },
      () => {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          return { ok: false, error: "INVALID_AMOUNT" };
        }
        const project = this.db
          .prepare("SELECT client_id, status FROM projects WHERE id = ?")
          .get(projectId) as { client_id: string; status: string } | undefined;
        if (project === undefined) {
          return { ok: false, error: "PROJECT_NOT_FOUND" };
        }
        if (project.status === "cancelled") {
          return { ok: false, error: "PROJECT_CANCELLED" };
        }
        const existing = this.db
          .prepare("SELECT 1 AS x FROM milestones WHERE project_id = ? AND id = ?")
          .get(projectId, milestoneId);
        if (existing !== undefined) {
          return { ok: false, error: "MILESTONE_EXISTS" };
        }
        const client = this.db
          .prepare("SELECT available FROM accounts WHERE id = ?")
          .get(project.client_id) as { available: number };
        if (client.available < amount) {
          return { ok: false, error: "INSUFFICIENT_FUNDS" };
        }
        this.db
          .prepare("UPDATE accounts SET available = available - ? WHERE id = ?")
          .run(amount, project.client_id);
        this.db
          .prepare(
            "INSERT INTO milestones (project_id, id, status, amount) VALUES (?, ?, 'pending', ?)",
          )
          .run(projectId, milestoneId, amount);
        this.insertFlow(
          key,
          "reserve",
          projectId,
          milestoneId,
          project.client_id,
          escrowAccount(projectId, milestoneId),
          amount,
        );
        return { ok: true, value: { projectId, milestoneId, amount } };
      },
    );
  }

  resolve(
    projectId: ProjectId,
    milestoneId: MilestoneId,
    award: number,
    key: OpKey,
  ): Result<ResolveResult> {
    return this.withIdempotency<ResolveResult>(
      key,
      "resolve",
      { projectId, milestoneId, award },
      () => {
        const project = this.db
          .prepare("SELECT client_id, creator_id FROM projects WHERE id = ?")
          .get(projectId) as
          | { client_id: string; creator_id: string }
          | undefined;
        if (project === undefined) {
          return { ok: false, error: "PROJECT_NOT_FOUND" };
        }
        const milestone = this.db
          .prepare(
            "SELECT status, amount FROM milestones WHERE project_id = ? AND id = ?",
          )
          .get(projectId, milestoneId) as
          | { status: string; amount: number }
          | undefined;
        if (milestone === undefined) {
          return { ok: false, error: "MILESTONE_NOT_FOUND" };
        }
        if (milestone.status !== "pending") {
          return { ok: false, error: "MILESTONE_ENDED" };
        }
        if (
          !Number.isSafeInteger(award) ||
          award < 0 ||
          award > milestone.amount
        ) {
          return { ok: false, error: "INVALID_AWARD" };
        }
        const refunded = milestone.amount - award;
        this.db
          .prepare(
            "UPDATE milestones SET status = 'resolved', award = ? WHERE project_id = ? AND id = ?",
          )
          .run(award, projectId, milestoneId);
        const escrow = escrowAccount(projectId, milestoneId);
        if (award > 0) {
          this.db
            .prepare("UPDATE accounts SET earnings = earnings + ? WHERE id = ?")
            .run(award, project.creator_id);
          this.insertFlow(
            key,
            "resolve",
            projectId,
            milestoneId,
            escrow,
            earningsAccount(project.creator_id),
            award,
          );
        }
        if (refunded > 0) {
          this.db
            .prepare("UPDATE accounts SET available = available + ? WHERE id = ?")
            .run(refunded, project.client_id);
          this.insertFlow(
            key,
            "resolve",
            projectId,
            milestoneId,
            escrow,
            project.client_id,
            refunded,
          );
        }
        return { ok: true, value: { projectId, milestoneId, award, refunded } };
      },
    );
  }

  cancel(projectId: ProjectId, key: OpKey): Result<CancelResult> {
    return this.withIdempotency<CancelResult>(
      key,
      "cancel",
      { projectId },
      () => {
        const project = this.db
          .prepare("SELECT client_id, status FROM projects WHERE id = ?")
          .get(projectId) as { client_id: string; status: string } | undefined;
        if (project === undefined) {
          return { ok: false, error: "PROJECT_NOT_FOUND" };
        }
        if (project.status === "cancelled") {
          return { ok: false, error: "ALREADY_CANCELLED" };
        }
        const pending = this.db
          .prepare(
            "SELECT id, amount FROM milestones WHERE project_id = ? AND status = 'pending' ORDER BY id",
          )
          .all(projectId) as unknown as { id: string; amount: number }[];
        this.db
          .prepare("UPDATE projects SET status = 'cancelled' WHERE id = ?")
          .run(projectId);
        this.db
          .prepare(
            "UPDATE milestones SET status = 'refunded' WHERE project_id = ? AND status = 'pending'",
          )
          .run(projectId);
        let refunded = 0;
        for (const milestone of pending) {
          refunded += milestone.amount;
          this.db
            .prepare("UPDATE accounts SET available = available + ? WHERE id = ?")
            .run(milestone.amount, project.client_id);
          this.insertFlow(
            key,
            "cancel",
            projectId,
            milestone.id,
            escrowAccount(projectId, milestone.id),
            project.client_id,
            milestone.amount,
          );
        }
        return {
          ok: true,
          value: {
            projectId,
            refunded,
            refundedMilestones: pending.map((m) => m.id),
          },
        };
      },
    );
  }

  snapshot(): Snapshot {
    const accounts = this.db
      .prepare("SELECT id, available, earnings FROM accounts ORDER BY id")
      .all() as unknown as AccountSnapshot[];
    const projects = (
      this.db
        .prepare("SELECT id, client_id, creator_id, status FROM projects ORDER BY id")
        .all() as unknown as {
        id: string;
        client_id: string;
        creator_id: string;
        status: ProjectSnapshot["status"];
      }[]
    ).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      creatorId: row.creator_id,
      status: row.status,
    }));
    const milestones = (
      this.db
        .prepare(
          "SELECT id, project_id, status, amount, award FROM milestones ORDER BY project_id, id",
        )
        .all() as unknown as {
        id: string;
        project_id: string;
        status: MilestoneSnapshot["status"];
        amount: number;
        award: number | null;
      }[]
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      amount: row.amount,
      award: row.award,
    }));
    const flows = (
      this.db
        .prepare(
          `SELECT seq, key, op, project_id, milestone_id, from_account, to_account, amount
           FROM flows ORDER BY seq`,
        )
        .all() as unknown as {
        seq: number;
        key: string;
        op: FlowEntry["op"];
        project_id: string | null;
        milestone_id: string | null;
        from_account: string;
        to_account: string;
        amount: number;
      }[]
    ).map((row) => ({
      seq: row.seq,
      key: row.key,
      op: row.op,
      projectId: row.project_id,
      milestoneId: row.milestone_id,
      from: row.from_account,
      to: row.to_account,
      amount: row.amount,
    }));
    return { accounts, projects, milestones, flows };
  }

  close(): void {
    this.db.close();
  }
}

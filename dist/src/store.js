import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { formatLocalDate, localToUtcMs } from "./timezone.js";
const OVERDUE_GRACE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  time_zone TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  camper_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_versions (
  order_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER NOT NULL,
  times TEXT NOT NULL,
  PRIMARY KEY (order_id, version_no)
);
CREATE TABLE IF NOT EXISTS doses (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  original_date TEXT NOT NULL,
  original_time TEXT NOT NULL,
  scheduled_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doses_scheduled ON doses(scheduled_utc);
CREATE TABLE IF NOT EXISTS administrations (
  dose_id TEXT PRIMARY KEY,
  administered_utc INTEGER NOT NULL
);
`;
function doseIdOf(orderId, versionNo, date, time) {
    const hash = createHash("sha256")
        .update(`${orderId}|${versionNo}|${date}|${time}`)
        .digest("hex")
        .slice(0, 32);
    return `dose_${hash}`;
}
function enumerateDates(startDate, endDate) {
    const [y, m, d] = startDate.split("-").map(Number);
    const dates = [];
    for (let t = Date.UTC(y, m - 1, d);; t += DAY_MS) {
        const dt = new Date(t);
        const date = formatLocalDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
        if (date >= endDate)
            break;
        dates.push(date);
    }
    return dates;
}
/** WildPine 给药剂次核算库入口，由上层直接调用。 */
export class MedScheduleStore {
    db;
    constructor(dbPath) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(SCHEMA);
    }
    /** 登记营期（幂等）。 */
    registerSession(session) {
        this.db
            .prepare("INSERT OR IGNORE INTO sessions (id, time_zone, start_date, end_date) VALUES (?, ?, ?, ?)")
            .run(session.id, session.timeZone, session.startDate, session.endDate);
    }
    /** 装载已审核药单并展开全部剂次；装载后药单历史不再修改。 */
    loadOrder(order) {
        const existing = this.db
            .prepare("SELECT id FROM orders WHERE id = ?")
            .get(order.id);
        if (existing) {
            throw new Error(`order already loaded: ${order.id}`);
        }
        const session = this.db
            .prepare("SELECT time_zone, start_date, end_date FROM sessions WHERE id = ?")
            .get(order.sessionId);
        if (!session) {
            throw new Error(`unknown session: ${order.sessionId}`);
        }
        for (let i = 0; i < order.versions.length; i++) {
            const v = order.versions[i];
            if (v.validFromUtcMs >= v.validToUtcMs) {
                throw new Error(`version ${i} has empty validity interval`);
            }
            if (i > 0 && v.validFromUtcMs < order.versions[i - 1].validToUtcMs) {
                throw new Error(`version ${i} overlaps previous version`);
            }
        }
        this.db.exec("BEGIN");
        try {
            this.db
                .prepare("INSERT INTO orders (id, session_id, camper_id) VALUES (?, ?, ?)")
                .run(order.id, order.sessionId, order.camperId);
            const insertVersion = this.db.prepare("INSERT INTO order_versions (order_id, version_no, valid_from, valid_to, times) VALUES (?, ?, ?, ?, ?)");
            const insertDose = this.db.prepare("INSERT INTO doses (id, order_id, version_no, original_date, original_time, scheduled_utc) VALUES (?, ?, ?, ?, ?, ?)");
            const dates = enumerateDates(session.start_date, session.end_date);
            order.versions.forEach((version, versionNo) => {
                insertVersion.run(order.id, versionNo, version.validFromUtcMs, version.validToUtcMs, JSON.stringify(version.times));
                for (const date of dates) {
                    for (const time of version.times) {
                        const scheduled = localToUtcMs(session.time_zone, date, time);
                        if (scheduled === null)
                            continue;
                        if (scheduled < version.validFromUtcMs ||
                            scheduled >= version.validToUtcMs) {
                            continue;
                        }
                        insertDose.run(doseIdOf(order.id, versionNo, date, time), order.id, versionNo, date, time, scheduled);
                    }
                }
            });
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }
    /** 针对确定剂次登记实际给药 UTC 时刻；重复登记抛错且不覆盖原记录。 */
    recordAdministration(doseId, administeredUtcMs) {
        const dose = this.db
            .prepare("SELECT id FROM doses WHERE id = ?")
            .get(doseId);
        if (!dose) {
            throw new Error(`unknown dose: ${doseId}`);
        }
        const existing = this.db
            .prepare("SELECT dose_id FROM administrations WHERE dose_id = ?")
            .get(doseId);
        if (existing) {
            throw new Error(`administration already recorded for dose: ${doseId}`);
        }
        this.db
            .prepare("INSERT INTO administrations (dose_id, administered_utc) VALUES (?, ?)")
            .run(doseId, administeredUtcMs);
    }
    /** 按计划 UTC 左闭右开区间查询剂次及观察时刻下的状态。 */
    queryDoses(query) {
        const conditions = ["d.scheduled_utc >= ?", "d.scheduled_utc < ?"];
        const params = [query.fromUtcMs, query.toUtcMs];
        if (query.camperId !== undefined) {
            conditions.push("o.camper_id = ?");
            params.push(query.camperId);
        }
        if (query.orderId !== undefined) {
            conditions.push("d.order_id = ?");
            params.push(query.orderId);
        }
        const rows = this.db
            .prepare(`SELECT d.id, d.order_id, o.camper_id, d.original_date, d.original_time,
                d.scheduled_utc, a.administered_utc
         FROM doses d
         JOIN orders o ON o.id = d.order_id
         LEFT JOIN administrations a ON a.dose_id = d.id
         WHERE ${conditions.join(" AND ")}
         ORDER BY d.scheduled_utc, d.id`)
            .all(...params);
        return rows.map((row) => {
            let status;
            if (row.administered_utc !== null &&
                row.administered_utc <= query.observedAtUtcMs) {
                status = "administered";
            }
            else if (query.observedAtUtcMs >= row.scheduled_utc + OVERDUE_GRACE_MS) {
                status = "overdue";
            }
            else {
                status = "pending";
            }
            return {
                doseId: row.id,
                orderId: row.order_id,
                camperId: row.camper_id,
                originalDate: row.original_date,
                originalTime: row.original_time,
                scheduledUtcMs: row.scheduled_utc,
                status,
                administeredUtcMs: row.administered_utc,
            };
        });
    }
    close() {
        this.db.close();
    }
}

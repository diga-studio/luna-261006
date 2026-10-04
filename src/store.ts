import type { DatabaseSync } from "node:sqlite";
import type { DoseIdentity, ReviewedOrder, UtcInstant } from "./types.js";

export interface StoredOrderVersionRow {
  orderId: string;
  camperId: string;
  timeZone: string;
  sessionStartDate: string;
  sessionEndDate: string;
  versionId: string;
  timeOfDay: string;
  validFromUtc: string;
  validToUtc: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS med_orders (
  order_id TEXT PRIMARY KEY,
  camper_id TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  session_start_date TEXT NOT NULL,
  session_end_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS med_order_versions (
  order_id TEXT NOT NULL REFERENCES med_orders(order_id),
  version_id TEXT NOT NULL,
  valid_from_utc TEXT NOT NULL,
  valid_to_utc TEXT NOT NULL,
  PRIMARY KEY (order_id, version_id)
);
CREATE TABLE IF NOT EXISTS med_order_version_times (
  order_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  time_of_day TEXT NOT NULL,
  PRIMARY KEY (order_id, version_id, time_of_day),
  FOREIGN KEY (order_id, version_id)
    REFERENCES med_order_versions(order_id, version_id)
);
CREATE TABLE IF NOT EXISTS med_administrations (
  order_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  local_time TEXT NOT NULL,
  administered_utc TEXT NOT NULL,
  PRIMARY KEY (order_id, version_id, local_date, local_time)
);
`;

/** Stable string key for a dose identity. */
export function doseKey(dose: DoseIdentity): string {
  return [dose.orderId, dose.versionId, dose.localDate, dose.localTime].join("");
}

/** Owns the SQLite schema and low-level persistence. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** Persist a reviewed order. Throws if the order id already exists. */
  insertOrder(order: ReviewedOrder): void {
    const existing = this.db
      .prepare("SELECT 1 FROM med_orders WHERE order_id = ?")
      .get(order.orderId);
    if (existing) {
      throw new Error(`order already loaded: ${order.orderId}`);
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO med_orders
             (order_id, camper_id, time_zone, session_start_date, session_end_date)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          order.orderId,
          order.camperId,
          order.session.timeZone,
          order.session.startDate,
          order.session.endDate,
        );
      const insertVersion = this.db.prepare(
        `INSERT INTO med_order_versions
           (order_id, version_id, valid_from_utc, valid_to_utc)
         VALUES (?, ?, ?, ?)`,
      );
      const insertTime = this.db.prepare(
        `INSERT INTO med_order_version_times (order_id, version_id, time_of_day)
         VALUES (?, ?, ?)`,
      );
      for (const version of order.versions) {
        insertVersion.run(
          order.orderId,
          version.versionId,
          version.validFromUtc,
          version.validToUtc,
        );
        for (const timeOfDay of version.times) {
          insertTime.run(order.orderId, version.versionId, timeOfDay);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** All stored (order, version, time) rows, for dose expansion. */
  listOrderVersionRows(): StoredOrderVersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT o.order_id        AS orderId,
                o.camper_id       AS camperId,
                o.time_zone       AS timeZone,
                o.session_start_date AS sessionStartDate,
                o.session_end_date   AS sessionEndDate,
                v.version_id      AS versionId,
                t.time_of_day     AS timeOfDay,
                v.valid_from_utc  AS validFromUtc,
                v.valid_to_utc    AS validToUtc
           FROM med_orders o
           JOIN med_order_versions v ON v.order_id = o.order_id
           JOIN med_order_version_times t
             ON t.order_id = v.order_id AND t.version_id = v.version_id
          ORDER BY o.order_id, v.version_id, t.time_of_day`,
      )
      .all() as unknown as StoredOrderVersionRow[];
    return rows;
  }

  /** Record an administration. Throws if the dose already has one. */
  insertAdministration(dose: DoseIdentity, administeredUtc: UtcInstant): void {
    const existing = this.db
      .prepare(
        `SELECT administered_utc FROM med_administrations
          WHERE order_id = ? AND version_id = ? AND local_date = ? AND local_time = ?`,
      )
      .get(dose.orderId, dose.versionId, dose.localDate, dose.localTime) as
      | { administered_utc: string }
      | undefined;
    if (existing) {
      throw new Error(
        `dose already administered at ${existing.administered_utc}: ${doseKey(dose)}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO med_administrations
           (order_id, version_id, local_date, local_time, administered_utc)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        dose.orderId,
        dose.versionId,
        dose.localDate,
        dose.localTime,
        administeredUtc,
      );
  }

  /** Map of dose key -> administered UTC instant. */
  listAdministrations(): Map<string, UtcInstant> {
    const rows = this.db
      .prepare(
        `SELECT order_id AS orderId, version_id AS versionId,
                local_date AS localDate, local_time AS localTime,
                administered_utc AS administeredUtc
           FROM med_administrations`,
      )
      .all() as unknown as Array<DoseIdentity & { administeredUtc: string }>;
    const map = new Map<string, UtcInstant>();
    for (const row of rows) {
      map.set(doseKey(row), row.administeredUtc);
    }
    return map;
  }

  close(): void {
    this.db.close();
  }
}

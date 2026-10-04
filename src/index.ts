import { DatabaseSync } from "node:sqlite";
import { expandDoses, toMs } from "./doses.js";
import { Store, doseKey } from "./store.js";
import { parseLocalDate, parseLocalTime } from "./timezone.js";
import type {
  DoseIdentity,
  ReviewedOrder,
  ScheduledDose,
  UtcInstant,
} from "./types.js";

export * from "./types.js";
export { doseKey } from "./store.js";

export interface WildPineOptions {
  /** Path to the SQLite database file, or ":memory:" (default). */
  filename?: string;
}

const OVERDUE_GRACE_MS = 15 * 60 * 1000;

function validateOrder(order: ReviewedOrder): void {
  parseLocalDate(order.session.startDate);
  parseLocalDate(order.session.endDate);
  // Throws RangeError for an unknown IANA time zone.
  new Intl.DateTimeFormat("en-US", { timeZone: order.session.timeZone });
  const ranges = order.versions
    .map((v) => {
      for (const t of v.times) parseLocalTime(t);
      return { from: toMs(v.validFromUtc), to: toMs(v.validToUtc) };
    })
    .sort((a, b) => a.from - b.from);
  for (const r of ranges) {
    if (!(r.from < r.to)) throw new Error("version validity range is empty");
  }
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i]!.from < ranges[i - 1]!.to) {
      throw new Error("version validity ranges overlap");
    }
  }
}

export class WildPineScheduler {
  private readonly store: Store;

  constructor(options: WildPineOptions = {}) {
    const db = new DatabaseSync(options.filename ?? ":memory:");
    this.store = new Store(db);
  }

  /** Load a reviewed order. Loaded order history is immutable. */
  loadOrder(order: ReviewedOrder): void {
    validateOrder(order);
    this.store.insertOrder(order);
  }

  /**
   * Record the actual administration of one specific dose. A dose can be
   * recorded at most once; a second registration throws and never
   * overwrites the original record.
   */
  recordAdministration(dose: DoseIdentity, administeredUtc: UtcInstant): void {
    toMs(administeredUtc);
    parseLocalDate(dose.localDate);
    parseLocalTime(dose.localTime);
    this.store.insertAdministration(dose, administeredUtc);
  }

  /**
   * List doses whose planned UTC instant falls in [fromUtc, toUtc),
   * with status evaluated at `observedAtUtc`:
   * - administered: recorded administration not later than the observation
   * - overdue: observation reached planned time + 15 minutes (inclusive)
   * - pending: otherwise
   */
  queryDoses(
    fromUtc: UtcInstant,
    toUtc: UtcInstant,
    observedAtUtc: UtcInstant,
  ): ScheduledDose[] {
    const observedMs = toMs(observedAtUtc);
    const doses = expandDoses(this.store.listOrderVersionRows(), fromUtc, toUtc);
    const administrations = this.store.listAdministrations();
    return doses.map((dose) => {
      const administeredUtc = administrations.get(doseKey(dose)) ?? null;
      let status: ScheduledDose["status"];
      if (administeredUtc !== null && toMs(administeredUtc) <= observedMs) {
        status = "administered";
      } else if (observedMs >= toMs(dose.scheduledUtc) + OVERDUE_GRACE_MS) {
        status = "overdue";
      } else {
        status = "pending";
      }
      return { ...dose, administeredUtc, status };
    });
  }

  close(): void {
    this.store.close();
  }
}

import type { StoredOrderVersionRow } from "./store.js";
import { enumerateLocalDates, localToUtc } from "./timezone.js";
import type { DoseIdentity, UtcInstant } from "./types.js";

export interface ExpandedDose extends DoseIdentity {
  camperId: string;
  scheduledUtc: UtcInstant;
}

export function toMs(instant: UtcInstant): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`invalid UTC instant: ${instant}`);
  return ms;
}

interface VersionGroup {
  row: StoredOrderVersionRow;
  times: string[];
}

/**
 * Expand stored order rows into concrete doses for a planned-UTC window
 * [fromUtc, toUtc). Deterministic: independent of the query window, of
 * administration state, and of the host time zone.
 *
 * Per (version, original local date, original local time) there is at most
 * one dose: the original date is checked against the session first, then
 * the local time is resolved to a planned UTC instant, and only then is
 * that instant checked against the version's UTC validity range.
 */
export function expandDoses(
  rows: readonly StoredOrderVersionRow[],
  fromUtc: UtcInstant,
  toUtc: UtcInstant,
): ExpandedDose[] {
  const fromMs = toMs(fromUtc);
  const toMsValue = toMs(toUtc);

  const groups = new Map<string, VersionGroup>();
  for (const row of rows) {
    const key = `${row.orderId}${row.versionId}`;
    let group = groups.get(key);
    if (!group) {
      group = { row, times: [] };
      groups.set(key, group);
    }
    group.times.push(row.timeOfDay);
  }

  const doses: ExpandedDose[] = [];
  for (const { row, times } of groups.values()) {
    const validFromMs = toMs(row.validFromUtc);
    const validToMs = toMs(row.validToUtc);
    const dates = enumerateLocalDates(row.sessionStartDate, row.sessionEndDate);
    for (const localDate of dates) {
      for (const localTime of times) {
        const scheduledUtc = localToUtc(row.timeZone, localDate, localTime);
        if (scheduledUtc === null) continue;
        const scheduledMs = toMs(scheduledUtc);
        if (scheduledMs < validFromMs || scheduledMs >= validToMs) continue;
        if (scheduledMs < fromMs || scheduledMs >= toMsValue) continue;
        doses.push({
          orderId: row.orderId,
          versionId: row.versionId,
          localDate,
          localTime,
          camperId: row.camperId,
          scheduledUtc,
        });
      }
    }
  }
  doses.sort((a, b) => {
    const byTime = toMs(a.scheduledUtc) - toMs(b.scheduledUtc);
    if (byTime !== 0) return byTime;
    return (
      a.orderId.localeCompare(b.orderId) ||
      a.versionId.localeCompare(b.versionId) ||
      a.localDate.localeCompare(b.localDate) ||
      a.localTime.localeCompare(b.localTime)
    );
  });
  return doses;
}

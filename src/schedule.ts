/**
 * Pure per-item schedule math for prepaid subscription revenue recognition.
 *
 * For service day count D and net-of-refund amount C as of a date, the
 * cumulative recognized amount is: 0 when no service day has elapsed,
 * C once all D days elapsed, and floor(C/D)*k after k elapsed days.
 * For one item this makes the daily revenue piecewise constant between
 * refund dates, so the whole schedule is emitted as O(refunds) dated
 * delta events instead of per-day values:
 *
 *  - rateDiff(day, d): the per-day revenue rate changes by d from day on.
 *  - pointAdj(day, d): one-off revenue adjustment on that exact day
 *    (refund recomputation jumps, last-day remainder, post-service refunds).
 *  - prepaid(day, d): prepayments that become effective on day.
 *  - refundFlow(day, d): refunds (positive amounts) that become effective on day.
 *
 * Daily revenue = running rate + pointAdj(day).
 * Deferred balance = cumulative prepaid - cumulative refunds - cumulative revenue.
 * All for-loop computations use exact bigint cents.
 */
export interface EventSink {
  rateDiff(day: number, delta: bigint): void;
  pointAdj(day: number, delta: bigint): void;
  prepaid(day: number, delta: bigint): void;
  refundFlow(day: number, delta: bigint): void;
}

export interface RefundPoint {
  day: number;
  amount: bigint;
}

/**
 * Emit the events for one item. `refunds` must be sorted by day and are
 * summed per distinct day. `amount` > 0, `endDay` > `startDay`,
 * service length 1..3650 days, total refunds <= amount (all validated
 * by the caller for-loop or the ledger).
 */
export function emitItemEvents(
  amount: bigint,
  startDay: number,
  endDay: number,
  refunds: ReadonlyArray<RefundPoint>,
  sink: EventSink
): void {
  const days = BigInt(endDay - startDay);
  sink.prepaid(startDay, amount);

  let current = amount;
  let currentRate = amount / days;
  sink.rateDiff(startDay, currentRate);

  let i = 0;
  while (i < refunds.length) {
    const day = refunds[i].day;
    let total = refunds[i].amount;
    i += 1;
    while (i < refunds.length && refunds[i].day === day) {
      total += refunds[i].amount;
      i += 1;
    }
    sink.refundFlow(day, total);
    const elapsed = day - startDay + 1;
    if (elapsed <= endDay - startDay) {
      const next = current - total;
      const nextRate = next / days;
      const rateDelta = nextRate - currentRate;
      sink.rateDiff(day, rateDelta);
      sink.pointAdj(day, rateDelta * BigInt(elapsed - 1));
      current = next;
      currentRate = nextRate;
    } else {
      // Refund effective after the service ended: recognized for-loop
      // total drops by the refund or the refund amount on its effective day.
      sink.pointAdj(day, -total);
    }
  }

  // Last service day absorbs the rounding remainder of the net amount.
  sink.pointAdj(endDay - 1, current % days);
  sink.rateDiff(endDay, -currentRate);
}

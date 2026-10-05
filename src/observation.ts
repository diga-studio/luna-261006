import { BehaviorRecord, INTERVAL_MS, PointState } from "./types";

/** 单学生单行为的观察记录集合（内存态，不持久化） */
export class ObservationTimeline {
  private readonly totalLengthMs: number;
  private readonly records = new Map<string, BehaviorRecord>();

  constructor(totalLengthMs: number) {
    if (
      !Number.isInteger(totalLengthMs) ||
      totalLengthMs <= 0 ||
      totalLengthMs % INTERVAL_MS !== 0
    ) {
      throw new RangeError(
        `totalLengthMs 必须是 ${INTERVAL_MS} 的正整数倍，收到 ${totalLengthMs}`,
      );
    }
    this.totalLengthMs = totalLengthMs;
  }

  /** 时间轴包含的区间数量 */
  get intervalCount(): number {
    return this.totalLengthMs / INTERVAL_MS;
  }

  /** 提交记录；同 id 再次提交即完整替换 */
  submit(record: BehaviorRecord): void {
    const { id, startMs, endMs } = record;
    if (!id) {
      throw new TypeError("记录 id 不能为空");
    }
    if (
      !Number.isInteger(startMs) ||
      !Number.isInteger(endMs) ||
      startMs < 0 ||
      endMs > this.totalLengthMs ||
      startMs >= endMs
    ) {
      throw new RangeError(
        `非法时间范围 [${startMs}, ${endMs})，时间轴长度 ${this.totalLengthMs}`,
      );
    }
    this.records.set(id, { ...record });
  }

  /** 撤销指定 id 的记录；不存在则忽略 */
  revoke(id: string): void {
    this.records.delete(id);
  }

  /** 查询某时刻的判定状态 */
  stateAt(timeMs: number): PointState {
    let hasOccurred = false;
    let hasNotOccurred = false;
    for (const record of this.records.values()) {
      if (record.startMs <= timeMs && timeMs < record.endMs) {
        if (record.verdict === "occurred") {
          hasOccurred = true;
        } else {
          hasNotOccurred = true;
        }
        if (hasOccurred && hasNotOccurred) {
          return "unknown";
        }
      }
    }
    if (hasOccurred) {
      return "occurred";
    }
    if (hasNotOccurred) {
      return "notOccurred";
    }
    return "unknown";
  }
}

import { describe, expect, it } from "vitest";
import { BoardScheduler, type CandidateSegment } from "../src/index.js";

const MIN = 60_000;
const utcMinutes = (iso: string): number => Date.parse(iso) / MIN;
const fmt = (m: number): string => new Date(m * MIN).toISOString().slice(0, 16);
const segFmt = (segs: CandidateSegment[]): string[] =>
  segs.map((s) => `${fmt(s.startUtcMinutes)}..${fmt(s.endUtcMinutes)}`);

// 2025-01-05 周日 … 2025-01-11 周六，全部使用 UTC 时区。
function singleDirector(): BoardScheduler {
  const scheduler = new BoardScheduler();
  scheduler.setDirectors([{ id: "a", timeZone: "UTC" }]);
  return scheduler;
}

describe("周窗口语义", () => {
  it("跨日窗口：结束早于开始表示次日", () => {
    const scheduler = singleDirector();
    // 周一 23:00 - 次日 01:00，即 2025-01-06 23:00Z - 2025-01-07 01:00Z。
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 1, startMinuteOfDay: 23 * 60, endMinuteOfDay: 60 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-01-06T00:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-08T00:00:00Z"),
      durationMinutes: 60,
    });
    expect(segFmt(result)).toEqual(["2025-01-06T23:00..2025-01-07T00:00"]);
  });

  it("跨周窗口：周六 23:00 跨到周日 01:00", () => {
    const scheduler = singleDirector();
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 6, startMinuteOfDay: 23 * 60, endMinuteOfDay: 60 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-01-11T00:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-12T12:00:00Z"),
      durationMinutes: 30,
    });
    expect(segFmt(result)).toEqual(["2025-01-11T23:00..2025-01-12T00:30"]);
  });

  it("窗口按周重复：同一查询覆盖多周时每周都出现", () => {
    const scheduler = singleDirector();
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 2, startMinuteOfDay: 9 * 60, endMinuteOfDay: 10 * 60 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-01-05T00:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-26T00:00:00Z"),
      durationMinutes: 60,
    });
    expect(segFmt(result)).toEqual([
      "2025-01-07T09:00..2025-01-07T09:00",
      "2025-01-14T09:00..2025-01-14T09:00",
      "2025-01-21T09:00..2025-01-21T09:00",
    ]);
  });

  it("相邻合格分钟即使可出席名单不同也合并为一段", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([
      { id: "A", timeZone: "UTC" },
      { id: "B", timeZone: "UTC" },
    ]);
    // A: 09:00-10:00，B: 09:30-10:30。法定 1 人（50% of 2 = 1）。
    scheduler.setWeeklyAvailability("A", [
      { dayOfWeek: 1, startMinuteOfDay: 9 * 60, endMinuteOfDay: 10 * 60 },
    ]);
    scheduler.setWeeklyAvailability("B", [
      { dayOfWeek: 1, startMinuteOfDay: 9 * 60 + 30, endMinuteOfDay: 10 * 60 + 30 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["A", "B"],
      quorumPercent: 50,
      rangeStartUtcMinutes: utcMinutes("2025-01-06T08:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-06T12:00:00Z"),
      durationMinutes: 30,
    });
    // 09:00-09:29 只有 A，09:30 两人都在，09:31-10:00 只有 B；
    // 相邻分钟出席名单不同仍合并为一段。
    expect(segFmt(result)).toEqual(["2025-01-06T09:00..2025-01-06T10:00"]);
  });
});

describe("搜索范围边界", () => {
  it("会议必须完整落在范围内：起点不早于 rangeStart，结束不晚于 rangeEnd", () => {
    const scheduler = singleDirector();
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 1, startMinuteOfDay: 8 * 60, endMinuteOfDay: 12 * 60 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-01-06T09:15:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-06T10:45:00Z"),
      durationMinutes: 60,
    });
    expect(segFmt(result)).toEqual(["2025-01-06T09:15..2025-01-06T09:45"]);
  });

  it("会议时长等于搜索跨度时只能从头开始", () => {
    const scheduler = singleDirector();
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 1, startMinuteOfDay: 0, endMinuteOfDay: 23 * 60 + 59 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-01-06T09:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-06T10:00:00Z"),
      durationMinutes: 60,
    });
    expect(segFmt(result)).toEqual(["2025-01-06T09:00..2025-01-06T09:00"]);
  });

  it("会议时长超过搜索跨度时无候选", () => {
    const scheduler = singleDirector();
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 1, startMinuteOfDay: 0, endMinuteOfDay: 23 * 60 + 59 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-01-06T09:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-06T10:00:00Z"),
      durationMinutes: 61,
    });
    expect(result).toEqual([]);
  });
});

describe("输入校验", () => {
  it("非法参数抛错", () => {
    const scheduler = singleDirector();
    const base = {
      invitedIds: ["a"],
      rangeStartUtcMinutes: utcMinutes("2025-01-06T09:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-01-06T10:00:00Z"),
      durationMinutes: 30,
    };
    expect(() =>
      scheduler.findCandidates({ ...base, durationMinutes: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.findCandidates({ ...base, durationMinutes: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.findCandidates({
        ...base,
        rangeEndUtcMinutes: base.rangeStartUtcMinutes,
      }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.findCandidates({ ...base, quorumPercent: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      scheduler.findCandidates({ ...base, invitedIds: ["ghost"] }),
    ).toThrow(/不在在任名册/);
  });

  it("非法窗口与未知董事抛错", () => {
    const scheduler = singleDirector();
    expect(() =>
      scheduler.setWeeklyAvailability("a", [
        { dayOfWeek: 1, startMinuteOfDay: 60, endMinuteOfDay: 60 },
      ]),
    ).toThrow(/起止/);
    expect(() =>
      scheduler.setWeeklyAvailability("a", [
        { dayOfWeek: 7, startMinuteOfDay: 0, endMinuteOfDay: 60 },
      ]),
    ).toThrow(RangeError);
    expect(() => scheduler.setWeeklyAvailability("ghost", [])).toThrow(
      /不在在任名册/,
    );
    expect(() =>
      scheduler.setDirectors([{ id: "a", timeZone: "Not/AZone" }]),
    ).toThrow();
    expect(() =>
      scheduler.setDirectors([
        { id: "a", timeZone: "UTC" },
        { id: "a", timeZone: "UTC" },
      ]),
    ).toThrow(/重复/);
  });

  it("替换名册后，被移除董事的可用时间不再生效", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([{ id: "a", timeZone: "UTC" }]);
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 1, startMinuteOfDay: 9 * 60, endMinuteOfDay: 10 * 60 },
    ]);
    scheduler.setDirectors([{ id: "b", timeZone: "UTC" }]);
    expect(() => scheduler.setWeeklyAvailability("a", [])).toThrow(
      /不在在任名册/,
    );
  });
});

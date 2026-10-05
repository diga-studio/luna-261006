import { describe, expect, it } from "vitest";
import { BoardScheduler, type CandidateSegment } from "../src/index.js";

const MIN = 60_000;
const utcMinutes = (iso: string): number => Date.parse(iso) / MIN;
const fmt = (m: number): string => new Date(m * MIN).toISOString().slice(0, 16);
const segFmt = (segs: CandidateSegment[]): string[] =>
  segs.map((s) => `${fmt(s.startUtcMinutes)}..${fmt(s.endUtcMinutes)}`);

describe("DST 验收场景", () => {
  it("America/New_York 秋拨：周日 01:30-02:30，45 分钟会议只能 06:30-06:45 开始", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([{ id: "a", timeZone: "America/New_York" }]);
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 0, startMinuteOfDay: 90, endMinuteOfDay: 150 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2024-11-03T00:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2024-11-04T00:00:00Z"),
      durationMinutes: 45,
    });
    // 01:30-02:00 EDT（UTC 05:30-06:00）放不下 45 分钟；
    // 回拨后 01:30-02:30 EST（UTC 06:30-07:30）可从 06:30 排到 06:45。
    expect(segFmt(result)).toEqual(["2024-11-03T06:30..2024-11-03T06:45"]);
  });

  it("America/New_York 春拨：整个窗口落入不存在的本地时间，无候选", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([{ id: "a", timeZone: "America/New_York" }]);
    // 2024-03-10 02:00-03:00 本地时间不存在（02:00 直接跳到 03:00）。
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 0, startMinuteOfDay: 120, endMinuteOfDay: 180 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2024-03-10T00:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2024-03-11T00:00:00Z"),
      durationMinutes: 30,
    });
    expect(result).toEqual([]);
  });

  it("Australia/Lord_Howe 半小时春拨：01:30-03:30 的窗口在 UTC 上连续", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([{ id: "a", timeZone: "Australia/Lord_Howe" }]);
    // 2024-10-06（周日）02:00 -> 02:30，偏移 +10:30 -> +11:00。
    // 本地 01:30-02:00 => UTC 15:00-15:30；02:00-02:30 不存在；
    // 本地 02:30-03:30 => UTC 15:30-16:30。UTC 上 15:00-16:30 连续可用。
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 0, startMinuteOfDay: 90, endMinuteOfDay: 210 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2024-10-05T12:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2024-10-06T12:00:00Z"),
      durationMinutes: 90,
    });
    expect(segFmt(result)).toEqual(["2024-10-05T15:00..2024-10-05T15:00"]);
  });

  it("Australia/Lord_Howe 半小时回拨：重复墙钟两段都可用", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([{ id: "a", timeZone: "Australia/Lord_Howe" }]);
    // 2025-04-06（周日）02:00 -> 01:30，偏移 +11:00 -> +10:30。
    // 本地 01:30-02:00 出现两次：UTC 14:30-15:00（+11）与 15:00-15:30（+10:30）。
    scheduler.setWeeklyAvailability("a", [
      { dayOfWeek: 0, startMinuteOfDay: 90, endMinuteOfDay: 120 },
    ]);
    const result = scheduler.findCandidates({
      invitedIds: ["a"],
      quorumPercent: 100,
      rangeStartUtcMinutes: utcMinutes("2025-04-05T12:00:00Z"),
      rangeEndUtcMinutes: utcMinutes("2025-04-06T12:00:00Z"),
      durationMinutes: 60,
    });
    // 两段 30 分钟拼接成 14:30-15:30 连续一小时，60 分钟会议只能 14:30 开始。
    expect(segFmt(result)).toEqual(["2025-04-05T14:30..2025-04-05T14:30"]);
  });
});

import { describe, expect, it } from "vitest";
import { BoardScheduler, type CandidateSegment } from "../src/index.js";

const MIN = 60_000;
const utcMinutes = (iso: string): number => Date.parse(iso) / MIN;
const fmt = (m: number): string => new Date(m * MIN).toISOString().slice(0, 16);
const segFmt = (segs: CandidateSegment[]): string[] =>
  segs.map((s) => `${fmt(s.startUtcMinutes)}..${fmt(s.endUtcMinutes)}`);

// 2025-01-06 是周一（dayOfWeek = 1），全程使用 UTC 时区排除时区干扰。
const DAY = "2025-01-06";
const w = (start: number, end: number) => ({
  dayOfWeek: 1,
  startMinuteOfDay: start,
  endMinuteOfDay: end,
});

function setup(): BoardScheduler {
  const scheduler = new BoardScheduler();
  scheduler.setDirectors([
    { id: "A", timeZone: "UTC" },
    { id: "B", timeZone: "UTC" },
    { id: "C", timeZone: "UTC" },
  ]);
  return scheduler;
}

function query(scheduler: BoardScheduler): CandidateSegment[] {
  return scheduler.findCandidates({
    invitedIds: ["A", "B", "C"],
    quorumPercent: 60, // 3 人 * 60% 向上取整 = 2
    rangeStartUtcMinutes: utcMinutes(`${DAY}T08:00:00Z`),
    rangeEndUtcMinutes: utcMinutes(`${DAY}T12:00:00Z`),
    durationMinutes: 60,
  });
}

describe("法定人数：轮换出席不算整场达标", () => {
  it("B 只有前半场、C 只有后半场时无候选", () => {
    const scheduler = setup();
    scheduler.setWeeklyAvailability("A", [w(9 * 60, 10 * 60)]);
    scheduler.setWeeklyAvailability("B", [w(9 * 60, 9 * 60 + 30)]);
    scheduler.setWeeklyAvailability("C", [w(9 * 60 + 30, 10 * 60)]);
    expect(query(scheduler)).toEqual([]);
  });

  it("B 增加相接的后半场窗口后 09:00 成为候选", () => {
    const scheduler = setup();
    scheduler.setWeeklyAvailability("A", [w(9 * 60, 10 * 60)]);
    scheduler.setWeeklyAvailability("B", [
      w(9 * 60, 9 * 60 + 30),
      w(9 * 60 + 30, 10 * 60),
    ]);
    scheduler.setWeeklyAvailability("C", [w(9 * 60 + 30, 10 * 60)]);
    // A 与 B 整场可用，达到 2 人法定人数。
    expect(segFmt(query(scheduler))).toEqual([
      `${DAY}T09:00..${DAY}T09:00`,
    ]);
  });

  it("未受邀董事不计入出席，但仍计入分母", () => {
    const scheduler = setup();
    scheduler.setWeeklyAvailability("A", [w(9 * 60, 10 * 60)]);
    scheduler.setWeeklyAvailability("B", [w(9 * 60, 10 * 60)]);
    scheduler.setWeeklyAvailability("C", [w(9 * 60, 10 * 60)]);
    // 只邀 A、B：分母仍是 3，需要 2 人，A、B 整场可用 -> 有候选。
    const result = scheduler.findCandidates({
      invitedIds: ["A", "B"],
      quorumPercent: 60,
      rangeStartUtcMinutes: utcMinutes(`${DAY}T08:00:00Z`),
      rangeEndUtcMinutes: utcMinutes(`${DAY}T12:00:00Z`),
      durationMinutes: 60,
    });
    expect(segFmt(result)).toEqual([`${DAY}T09:00..${DAY}T09:00`]);
    // 只邀 A：达不到 2 人 -> 无候选。
    const solo = scheduler.findCandidates({
      invitedIds: ["A"],
      quorumPercent: 60,
      rangeStartUtcMinutes: utcMinutes(`${DAY}T08:00:00Z`),
      rangeEndUtcMinutes: utcMinutes(`${DAY}T12:00:00Z`),
      durationMinutes: 60,
    });
    expect(solo).toEqual([]);
  });

  it("没有可用时间的在任董事仍计入分母", () => {
    const scheduler = new BoardScheduler();
    scheduler.setDirectors([
      { id: "A", timeZone: "UTC" },
      { id: "B", timeZone: "UTC" },
      { id: "C", timeZone: "UTC" },
      { id: "D", timeZone: "UTC" }, // 无可用时间
      { id: "E", timeZone: "UTC" }, // 无可用时间
    ]);
    scheduler.setWeeklyAvailability("A", [w(9 * 60, 10 * 60)]);
    scheduler.setWeeklyAvailability("B", [w(9 * 60, 10 * 60)]);
    // 5 人 * 60% = 3，只有 A、B 两人可用 -> 无候选。
    const result = scheduler.findCandidates({
      invitedIds: ["A", "B"],
      quorumPercent: 60,
      rangeStartUtcMinutes: utcMinutes(`${DAY}T08:00:00Z`),
      rangeEndUtcMinutes: utcMinutes(`${DAY}T12:00:00Z`),
      durationMinutes: 60,
    });
    expect(result).toEqual([]);
  });

  it("默认法定比例为 60%", () => {
    const scheduler = setup();
    scheduler.setWeeklyAvailability("A", [w(9 * 60, 10 * 60)]);
    scheduler.setWeeklyAvailability("B", [w(9 * 60, 10 * 60)]);
    const result = scheduler.findCandidates({
      invitedIds: ["A", "B"],
      rangeStartUtcMinutes: utcMinutes(`${DAY}T08:00:00Z`),
      rangeEndUtcMinutes: utcMinutes(`${DAY}T12:00:00Z`),
      durationMinutes: 60,
    });
    expect(segFmt(result)).toEqual([`${DAY}T09:00..${DAY}T09:00`]);
  });
});

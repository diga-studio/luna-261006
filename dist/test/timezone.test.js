import test from "node:test";
import assert from "node:assert/strict";
import { localDateExists, localToUtcMs } from "../src/timezone.js";
const Z = (iso) => Date.parse(iso);
test("时钟前跳：不存在的时刻按实际偏移变化量平移", () => {
    // 2025-03-09 America/New_York 02:00 -> 03:00，缺口 1 小时
    assert.equal(localToUtcMs("America/New_York", "2025-03-09", "02:30"), Z("2025-03-09T07:30:00Z"));
    assert.equal(localToUtcMs("America/New_York", "2025-03-09", "03:30"), Z("2025-03-09T07:30:00Z"));
});
test("时钟回拨：重复时刻取较早的 UTC", () => {
    // 2025-11-02 America/New_York 01:30 出现两次：05:30Z(EDT) 与 06:30Z(EST)
    assert.equal(localToUtcMs("America/New_York", "2025-11-02", "01:30"), Z("2025-11-02T05:30:00Z"));
});
test("30 分钟跳变：Lord Howe 02:00 -> 02:30", () => {
    // 2025-10-05 Australia/Lord_Howe 缺口 30 分钟，02:15 平移为 02:45 当地
    assert.equal(localToUtcMs("Australia/Lord_Howe", "2025-10-05", "02:15"), Z("2025-10-04T15:45:00Z"));
});
test("整日跳过：Pacific/Apia 2011-12-30 不存在", () => {
    assert.equal(localToUtcMs("Pacific/Apia", "2011-12-30", "10:00"), null);
    assert.equal(localDateExists("Pacific/Apia", "2011-12-30"), false);
    assert.equal(localDateExists("Pacific/Apia", "2011-12-29"), true);
    assert.equal(localDateExists("Pacific/Apia", "2011-12-31"), true);
});
test("结果不依赖宿主默认时区", () => {
    const before = localToUtcMs("America/New_York", "2025-03-09", "02:30");
    process.env.TZ = "Pacific/Kiritimati";
    const after = localToUtcMs("America/New_York", "2025-03-09", "02:30");
    assert.equal(after, before);
});

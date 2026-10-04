/** 单个装配的版本时间表：days 严格递增，componentsByDay 记录每个起始日的子件列表。 */
export interface VersionTimeline {
  days: number[];
  componentsByDay: Map<number, readonly string[]>;
}

/** 某天生效的版本内容（不含装配标识，由调用方补全）。 */
export interface EffectiveVersion {
  startDay: number;
  components: readonly string[];
}

/** 一条带生命周期的有向边：[startDay, endDay) 内生效，endDay 为 Infinity 表示永久。 */
export interface EdgeInterval {
  from: string;
  to: string;
  startDay: number;
  endDay: number;
}

export function createTimeline(): VersionTimeline {
  return { days: [], componentsByDay: new Map() };
}

/** 二分查找 days 中 <= day 的最大元素下标，不存在返回 -1。 */
function lowerIndex(days: readonly number[], day: number): number {
  let lo = 0;
  let hi = days.length; // 在 [lo, hi) 中查找第一个 > day 的位置
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (days[mid]! <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** 二分查找 days 中 >= day 的最小元素下标（插入位置）。 */
function upperIndex(days: readonly number[], day: number): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (days[mid]! < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 插入一个新版本。调用方保证 (装配, startDay) 组合不重复。 */
export function addVersion(
  timeline: VersionTimeline,
  startDay: number,
  components: readonly string[],
): void {
  const at = upperIndex(timeline.days, startDay);
  timeline.days.splice(at, 0, startDay);
  timeline.componentsByDay.set(startDay, components);
}

/** 移除一个已存在的版本（publishBatch 拒绝时回滚用）。 */
export function removeVersion(timeline: VersionTimeline, startDay: number): void {
  const at = lowerIndex(timeline.days, startDay);
  if (at < 0 || timeline.days[at] !== startDay) return;
  timeline.days.splice(at, 1);
  timeline.componentsByDay.delete(startDay);
}

/** 查询 day 当天生效的版本；没有生效版本返回 null。 */
export function versionAt(timeline: VersionTimeline, day: number): EffectiveVersion | null {
  const at = lowerIndex(timeline.days, day);
  if (at < 0) return null;
  const startDay = timeline.days[at]!;
  const components = timeline.componentsByDay.get(startDay);
  if (components === undefined) return null;
  return { startDay, components };
}

/** 把所有装配的时间表展开成带生命周期的有向边集合。 */
export function buildEdgeIntervals(
  timelines: ReadonlyMap<string, VersionTimeline>,
): EdgeInterval[] {
  const edges: EdgeInterval[] = [];
  for (const [assemblyId, timeline] of timelines) {
    const days = timeline.days;
    for (let i = 0; i < days.length; i++) {
      const startDay = days[i]!;
      const endDay = i + 1 < days.length ? days[i + 1]! : Infinity;
      const components = timeline.componentsByDay.get(startDay)!;
      for (const component of components) {
        edges.push({ from: assemblyId, to: component, startDay, endDay });
      }
    }
  }
  return edges;
}

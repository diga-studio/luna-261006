import { BomRevision, BomVersion, PublishResult } from "./types";
import { IntervalList, intersect, union, isSubset, firstDay } from "./intervals";

interface StoredVersion {
  startDay: number;
  components: string[];
}

interface ActiveEdge {
  to: string;
  days: IntervalList;
}

interface Frame {
  node: string;
  feasible: IntervalList;
  edges: ActiveEdge[];
  edgeIndex: number;
}

export class BomService {
  private readonly versions = new Map<string, StoredVersion[]>();

  publishBatch(revisions: BomRevision[]): PublishResult {
    const inserted: Array<{ assemblyId: string; startDay: number }> = [];
    for (const rev of revisions) {
      this.insertVersion(rev.assemblyId, {
        startDay: rev.startDay,
        components: rev.components.slice(),
      });
      inserted.push({ assemblyId: rev.assemblyId, startDay: rev.startDay });
    }

    const adjacencyCache = new Map<string, ActiveEdge[]>();
    for (const rev of inserted) {
      const list = this.versions.get(rev.assemblyId)!;
      const idx = lowerBound(list, rev.startDay);
      const end = idx + 1 < list.length ? list[idx + 1].startDay : Number.POSITIVE_INFINITY;
      const window: IntervalList = [{ start: rev.startDay, end }];
      for (const component of list[idx].components) {
        const witness = this.findCycleDay(
          rev.assemblyId,
          component,
          window,
          adjacencyCache,
        );
        if (witness) {
          for (const ins of inserted) this.removeVersion(ins.assemblyId, ins.startDay);
          return { ok: false, witness };
        }
      }
    }
    return { ok: true };
  }

  bomAt(assemblyId: string, day: number): BomVersion | null {
    const list = this.versions.get(assemblyId);
    if (!list || list.length === 0) return null;
    const idx = lowerBound(list, day);
    const effective = idx < list.length && list[idx].startDay === day ? idx : idx - 1;
    if (effective < 0) return null;
    const v = list[effective];
    return { assemblyId, startDay: v.startDay, components: v.components.slice() };
  }

  private insertVersion(assemblyId: string, version: StoredVersion): void {
    let list = this.versions.get(assemblyId);
    if (!list) {
      list = [];
      this.versions.set(assemblyId, list);
    }
    const idx = lowerBound(list, version.startDay);
    list.splice(idx, 0, version);
  }

  private removeVersion(assemblyId: string, startDay: number): void {
    const list = this.versions.get(assemblyId)!;
    const idx = lowerBound(list, startDay);
    list.splice(idx, 1);
    if (list.length === 0) this.versions.delete(assemblyId);
  }

  private activeEdgesOf(node: string, cache: Map<string, ActiveEdge[]>): ActiveEdge[] {
    let edges = cache.get(node);
    if (edges) return edges;
    edges = [];
    const list = this.versions.get(node);
    if (list) {
      const byTarget = new Map<string, IntervalList>();
      for (let i = 0; i < list.length; i++) {
        const start = list[i].startDay;
        const end = i + 1 < list.length ? list[i + 1].startDay : Number.POSITIVE_INFINITY;
        for (const to of list[i].components) {
          let days = byTarget.get(to);
          if (!days) {
            days = [];
            byTarget.set(to, days);
          }
          const last = days[days.length - 1];
          if (last && start <= last.end) {
            if (end > last.end) last.end = end;
          } else {
            days.push({ start, end });
          }
        }
      }
      for (const [to, days] of byTarget) edges.push({ to, days });
    }
    cache.set(node, edges);
    return edges;
  }

  /**
   * Looks for a day inside `window` on which `source` reaches `target` through
   * edges that are all effective on that same day. Combined with the new edge
   * target->source (effective on `window`) that day closes a real cycle.
   */
  private findCycleDay(
    target: string,
    source: string,
    window: IntervalList,
    adjacencyCache: Map<string, ActiveEdge[]>,
  ): { day: number; path: string[] } | null {
    if (source === target) {
      return { day: firstDay(window), path: [target, target] };
    }
    const explored = new Map<string, IntervalList>();
    explored.set(source, window);
    const stack: Frame[] = [
      { node: source, feasible: window, edges: this.activeEdgesOf(source, adjacencyCache), edgeIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.edgeIndex >= frame.edges.length) {
        stack.pop();
        continue;
      }
      const edge = frame.edges[frame.edgeIndex++];
      const feasible = intersect(frame.feasible, edge.days);
      if (feasible.length === 0) continue;
      if (edge.to === target) {
        const path = [target, ...stack.map((f) => f.node), target];
        return { day: firstDay(feasible), path };
      }
      const seen = explored.get(edge.to);
      if (seen && isSubset(feasible, seen)) continue;
      explored.set(edge.to, seen ? union(seen, feasible) : feasible);
      stack.push({
        node: edge.to,
        feasible,
        edges: this.activeEdgesOf(edge.to, adjacencyCache),
        edgeIndex: 0,
      });
    }
    return null;
  }
}

/** First index whose startDay is >= day. */
function lowerBound(list: StoredVersion[], day: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].startDay < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

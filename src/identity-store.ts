import type { RecordKey, SourceRecord, UnifiedProfile } from "./types.js";
import { UnionFind } from "./union-find.js";

/** 单批提交的最大记录数。 */
export const MAX_BATCH_SIZE = 5000;

const KEY_SEP = String.fromCharCode(0);

interface StoredRecord {
  sourceId: string;
  recordId: string;
  email?: string;
  externalId?: string;
  tags: readonly string[];
  interactions: number;
}

interface Profile {
  id: number;
  /** 成员记录的内部键（sourceId + KEY_SEP + recordId）。 */
  members: Set<string>;
  /** 标签 -> 支持该标签的成员数，避免误删仍被其他成员支持的标签。 */
  tagCounts: Map<string, number>;
  totalInteractions: number;
}

function keyOf(sourceId: string, recordId: string): string {
  return sourceId + KEY_SEP + recordId;
}

/**
 * 客户身份纠错与档案重组库。
 * 数据保存在进程内存，调用串行执行。
 *
 * 统一档案始终等于当前来源快照下 email / external_id 匹配关系的连通分量：
 * 每次提交只重算受影响档案所在的闭包，撤回或纠错标识后旧档案随之拆分，
 * 旧标识立即退出匹配。
 */
export class IdentityStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly emailIndex = new Map<string, Set<string>>();
  private readonly externalIdIndex = new Map<string, Set<string>>();
  private readonly profileOf = new Map<string, number>();
  private readonly profiles = new Map<number, Profile>();
  private nextProfileId = 1;

  /** 批量提交来源记录快照。已有记录被完整替换；批内顺序不影响结果。 */
  submitBatch(batch: readonly SourceRecord[]): void {
    if (batch.length > MAX_BATCH_SIZE) {
      throw new RangeError(
        `batch size ${batch.length} exceeds limit ${MAX_BATCH_SIZE}`,
      );
    }
    const seen = new Set<string>();
    const connectivityDirty: string[] = [];

    for (const input of batch) {
      const key = keyOf(input.sourceId, input.recordId);
      if (seen.has(key)) {
        throw new Error(
          `duplicate record key in batch: ${input.sourceId}/${input.recordId}`,
        );
      }
      seen.add(key);

      const previous = this.records.get(key);
      const next: StoredRecord = {
        sourceId: input.sourceId,
        recordId: input.recordId,
        email: input.email,
        externalId: input.externalId,
        tags: input.tags ?? [],
        interactions: input.interactions ?? 0,
      };

      const identityChanged =
        previous === undefined ||
        previous.email !== next.email ||
        previous.externalId !== next.externalId;

      if (previous !== undefined) {
        this.removeFromIndex(this.emailIndex, previous.email, key);
        this.removeFromIndex(this.externalIdIndex, previous.externalId, key);
        if (!identityChanged) {
          const profileId = this.profileOf.get(key);
          const profile =
            profileId === undefined ? undefined : this.profiles.get(profileId);
          if (profile) this.applyAggregateDelta(profile, previous, next);
        }
      }
      this.records.set(key, next);
      this.addToIndex(this.emailIndex, next.email, key);
      this.addToIndex(this.externalIdIndex, next.externalId, key);

      if (identityChanged) {
        connectivityDirty.push(key);
      }
    }

    if (connectivityDirty.length > 0) {
      this.recomputeAround(connectivityDirty);
    }
  }

  /** 通过任意来源记录键查询其当前所属统一档案；不存在返回 undefined。 */
  getProfileOf(key: RecordKey): UnifiedProfile | undefined {
    const profileId = this.profileOf.get(keyOf(key.sourceId, key.recordId));
    if (profileId === undefined) return undefined;
    const profile = this.profiles.get(profileId);
    if (!profile) return undefined;
    const members = new Set<RecordKey>();
    for (const memberKey of profile.members) {
      const rec = this.records.get(memberKey)!;
      members.add({ sourceId: rec.sourceId, recordId: rec.recordId });
    }
    return {
      profileId: profile.id,
      members,
      tags: new Set(profile.tagCounts.keys()),
      totalInteractions: profile.totalInteractions,
    };
  }

  /** 当前统一档案数量（主要用于测试与观测）。 */
  get profileCount(): number {
    return this.profiles.size;
  }

  private addToIndex(
    index: Map<string, Set<string>>,
    identity: string | undefined,
    key: string,
  ): void {
    if (identity === undefined) return;
    let bucket = index.get(identity);
    if (!bucket) {
      bucket = new Set();
      index.set(identity, bucket);
    }
    bucket.add(key);
  }

  private removeFromIndex(
    index: Map<string, Set<string>>,
    identity: string | undefined,
    key: string,
  ): void {
    if (identity === undefined) return;
    const bucket = index.get(identity);
    if (!bucket) return;
    bucket.delete(key);
    if (bucket.size === 0) index.delete(identity);
  }

  /** 标识未变时，直接增量修正档案的标签计数与互动总数。 */
  private applyAggregateDelta(
    profile: Profile,
    previous: StoredRecord,
    next: StoredRecord,
  ): void {
    profile.totalInteractions += next.interactions - previous.interactions;
    const prevTags = new Set(previous.tags);
    const nextTags = new Set(next.tags);
    for (const tag of prevTags) {
      if (!nextTags.has(tag)) {
        const count = (profile.tagCounts.get(tag) ?? 1) - 1;
        if (count <= 0) profile.tagCounts.delete(tag);
        else profile.tagCounts.set(tag, count);
      }
    }
    for (const tag of nextTags) {
      if (!prevTags.has(tag)) {
        profile.tagCounts.set(tag, (profile.tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  /**
   * 以脏记录为起点，收集可能受影响的档案闭包（当前标识仍触及的其他档案），
   * 仅在闭包内重算连通分量，其余档案保持不动。
   */
  private recomputeAround(dirtyKeys: readonly string[]): void {
    const candidateKeys = new Set<string>();
    const visitedProfiles = new Set<number>();
    const queue: number[] = [];

    const enqueueKey = (key: string): void => {
      candidateKeys.add(key);
      const pid = this.profileOf.get(key);
      if (pid !== undefined && !visitedProfiles.has(pid)) {
        visitedProfiles.add(pid);
        queue.push(pid);
      }
    };

    // 按标识值去重后整桶展开，避免逐成员重复遍历大桶（O(n²)）。
    const enqueueIdentities = (rec: StoredRecord): void => {
      if (rec.email !== undefined) pendingEmails.add(rec.email);
      if (rec.externalId !== undefined) pendingExternals.add(rec.externalId);
    };
    const pendingEmails = new Set<string>();
    const pendingExternals = new Set<string>();
    const drainIdentities = (): void => {
      for (const email of pendingEmails) {
        for (const key of this.emailIndex.get(email) ?? []) enqueueKey(key);
      }
      pendingEmails.clear();
      for (const externalId of pendingExternals) {
        for (const key of this.externalIdIndex.get(externalId) ?? [])
          enqueueKey(key);
      }
      pendingExternals.clear();
    };

    const expand = (): void => {
      while (queue.length > 0 || pendingEmails.size > 0 || pendingExternals.size > 0) {
        drainIdentities();
        if (queue.length === 0) continue;
        const pid = queue.pop()!;
        const profile = this.profiles.get(pid);
        if (!profile) continue;
        for (const memberKey of profile.members) {
          candidateKeys.add(memberKey);
          const rec = this.records.get(memberKey)!;
          enqueueIdentities(rec);
        }
      }
    };

    for (const key of dirtyKeys) {
      enqueueKey(key);
      enqueueIdentities(this.records.get(key)!);
    }
    expand();

    // 在候选键上按当前标识重算连通分量。
    const uf = new UnionFind();
    for (const key of candidateKeys) {
      const rec = this.records.get(key)!;
      const id = uf.add(key);
      // 桶内所有键互相连通，与任一代表键合并即可，避免 O(n²)。
      // 闭包保证桶内成员都在候选集中。
      if (rec.email !== undefined) {
        const rep = firstOf(this.emailIndex.get(rec.email));
        if (rep !== undefined && rep !== key) uf.union(id, uf.add(rep));
      }
      if (rec.externalId !== undefined) {
        const rep = firstOf(this.externalIdIndex.get(rec.externalId));
        if (rep !== undefined && rep !== key) uf.union(id, uf.add(rep));
      }
    }

    for (const pid of visitedProfiles) {
      this.profiles.delete(pid);
    }

    for (const component of uf.components()) {
      const profile: Profile = {
        id: this.nextProfileId++,
        members: new Set(),
        tagCounts: new Map(),
        totalInteractions: 0,
      };
      for (const i of component) {
        const key = uf.keys[i];
        const rec = this.records.get(key)!;
        profile.members.add(key);
        profile.totalInteractions += rec.interactions;
        for (const tag of new Set(rec.tags)) {
          profile.tagCounts.set(tag, (profile.tagCounts.get(tag) ?? 0) + 1);
        }
        this.profileOf.set(key, profile.id);
      }
      this.profiles.set(profile.id, profile);
    }
  }

}

function firstOf(set: Set<string> | undefined): string | undefined {
  if (set === undefined) return undefined;
  const it = set.values().next();
  return it.done ? undefined : it.value;
}

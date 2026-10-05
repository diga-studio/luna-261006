import type { RecordKey, SourceRecord, UnifiedProfile } from "./types.ts";

/** 单批提交的最大记录数。 */
export const MAX_BATCH_SIZE = 5000;

const KEY_SEP = String.fromCharCode(0);

interface StoredRecord {
  sourceId: string;
  recordId: string;
  email: string | null;
  externalId: string | null;
  /** 去重后的完整标签集合（现值）。 */
  tags: readonly string[];
  /** 累计互动次数（现值）。 */
  interactions: number;
}

interface ProfileImpl {
  id: number;
  members: Set<string>;
  /** 标签 -> 支持它的成员记录数，保证失去一个成员不会误删仍被其他成员支持的标签。 */
  tagCounts: Map<string, number>;
  interactions: number;
}

/** 标识节点：email 与 external_id 属于不同标识域，字符串相同也不构成匹配。 */
interface IdentifierNode {
  isEmail: boolean;
  value: string;
}

function recordKeyOf(sourceId: string, recordId: string): string {
  return sourceId + KEY_SEP + recordId;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

function normalizeRecord(input: SourceRecord): StoredRecord {
  const interactions = input.interactions ?? 0;
  if (!Number.isFinite(interactions) || interactions < 0) {
    throw new RangeError(
      `invalid interactions for ${input.sourceId}/${input.recordId}: ${String(input.interactions)}`,
    );
  }
  return {
    sourceId: input.sourceId,
    recordId: input.recordId,
    email: normalizeIdentifier(input.email),
    externalId: normalizeIdentifier(input.externalId),
    tags: input.tags ? [...new Set(input.tags)] : [],
    interactions,
  };
}

function sameRecord(a: StoredRecord, b: StoredRecord): boolean {
  if (a.email !== b.email || a.externalId !== b.externalId) return false;
  if (a.interactions !== b.interactions || a.tags.length !== b.tags.length) return false;
  return a.tags.every((tag) => b.tags.includes(tag));
}

/**
 * 客户身份纠错与档案重组库的核心存储。
 * 数据保存在进程内存中，调用串行执行。
 */
export class ProfileStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly emailToKeys = new Map<string, Set<string>>();
  private readonly externalToKeys = new Map<string, Set<string>>();
  private readonly keyToProfile = new Map<string, number>();
  private readonly profiles = new Map<number, ProfileImpl>();
  private nextProfileId = 1;

  /**
   * 批量提交来源记录快照。
   * 已有记录被完整替换；缺省标识表示撤回原标识。
   * 同批不得重复出现同一个记录键；批内顺序不影响最终档案。
   */
  submitBatch(inputs: readonly SourceRecord[]): void {
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new RangeError(`batch size ${inputs.length} exceeds limit ${MAX_BATCH_SIZE}`);
    }
    const seen = new Set<string>();
    const normalized: StoredRecord[] = [];
    for (const input of inputs) {
      const key = recordKeyOf(input.sourceId, input.recordId);
      if (seen.has(key)) {
        throw new Error(`duplicate record key in batch: ${input.sourceId}/${input.recordId}`);
      }
      seen.add(key);
      normalized.push(normalizeRecord(input));
    }

    const dirtyKeys = new Set<string>();
    for (const next of normalized) {
      const key = recordKeyOf(next.sourceId, next.recordId);
      const prev = this.records.get(key);
      if (prev !== undefined && sameRecord(prev, next)) continue;
      if (prev !== undefined) {
        // 旧标识组的全部成员都需要重算：桥接标识撤回后，旧档案可能必须拆开。
        if (prev.email !== null) {
          for (const member of this.emailToKeys.get(prev.email) ?? []) dirtyKeys.add(member);
        }
        if (prev.externalId !== null) {
          for (const member of this.externalToKeys.get(prev.externalId) ?? []) dirtyKeys.add(member);
        }
        this.removeFromIndexes(key, prev);
      }
      this.records.set(key, next);
      this.addToIndexes(key, next);
      dirtyKeys.add(key);
    }

    this.recompute(dirtyKeys);
  }

  /**
   * 通过任意来源记录键查询它当前所属的统一档案。
   * 记录不存在时返回 undefined。
   */
  getProfileByRecord(sourceId: string, recordId: string): UnifiedProfile | undefined {
    const profileId = this.keyToProfile.get(recordKeyOf(sourceId, recordId));
    if (profileId === undefined) return undefined;
    const profile = this.profiles.get(profileId);
    if (profile === undefined) return undefined;
    const members: RecordKey[] = [];
    for (const memberKey of profile.members) {
      const record = this.records.get(memberKey);
      if (record !== undefined) {
        members.push({ sourceId: record.sourceId, recordId: record.recordId });
      }
    }
    return {
      profileId: String(profile.id),
      members,
      tags: [...profile.tagCounts.keys()],
      interactions: profile.interactions,
    };
  }

  /** 当前统一档案数量（主要用于测试与观测）。 */
  get profileCount(): number {
    return this.profiles.size;
  }

  /** 当前来源记录数量（主要用于测试与观测）。 */
  get recordCount(): number {
    return this.records.size;
  }

  private addToIndexes(key: string, record: StoredRecord): void {
    if (record.email !== null) {
      let group = this.emailToKeys.get(record.email);
      if (group === undefined) {
        group = new Set();
        this.emailToKeys.set(record.email, group);
      }
      group.add(key);
    }
    if (record.externalId !== null) {
      let group = this.externalToKeys.get(record.externalId);
      if (group === undefined) {
        group = new Set();
        this.externalToKeys.set(record.externalId, group);
      }
      group.add(key);
    }
  }

  private removeFromIndexes(key: string, record: StoredRecord): void {
    if (record.email !== null) {
      const group = this.emailToKeys.get(record.email);
      if (group !== undefined) {
        group.delete(key);
        if (group.size === 0) this.emailToKeys.delete(record.email);
      }
    }
    if (record.externalId !== null) {
      const group = this.externalToKeys.get(record.externalId);
      if (group !== undefined) {
        group.delete(key);
        if (group.size === 0) this.externalToKeys.delete(record.externalId);
      }
    }
  }

  /**
   * 依据当前来源快照，对脏记录所在的连通群整体重算档案。
   * 在“记录 <-> 标识”二部图上遍历，每个标识节点的成员组至多展开一次，
   * 因此共享同一标识的超大档案也能在线性时间内完成重算。
   */
  private recompute(dirtyKeys: ReadonlySet<string>): void {
    if (dirtyKeys.size === 0) return;
    const visitedRecords = new Set<string>();
    const visitedIdentifiers = new Set<string>();
    const touchedProfileIds = new Set<number>();
    const claimedProfileIds = new Set<number>();

    for (const startKey of dirtyKeys) {
      if (visitedRecords.has(startKey)) continue;
      if (!this.records.has(startKey)) continue;

      const componentKeys: string[] = [];
      const recordStack: string[] = [startKey];
      const identifierStack: IdentifierNode[] = [];
      visitedRecords.add(startKey);

      while (recordStack.length > 0 || identifierStack.length > 0) {
        while (recordStack.length > 0) {
          const key = recordStack.pop() as string;
          componentKeys.push(key);
          const record = this.records.get(key) as StoredRecord;
          if (record.email !== null) {
            const nodeId = `e${KEY_SEP}${record.email}`;
            if (!visitedIdentifiers.has(nodeId)) {
              visitedIdentifiers.add(nodeId);
              identifierStack.push({ isEmail: true, value: record.email });
            }
          }
          if (record.externalId !== null) {
            const nodeId = `x${KEY_SEP}${record.externalId}`;
            if (!visitedIdentifiers.has(nodeId)) {
              visitedIdentifiers.add(nodeId);
              identifierStack.push({ isEmail: false, value: record.externalId });
            }
          }
        }
        while (identifierStack.length > 0) {
          const node = identifierStack.pop() as IdentifierNode;
          const index = node.isEmail ? this.emailToKeys : this.externalToKeys;
          const group = index.get(node.value);
          if (group === undefined) continue;
          for (const member of group) {
            if (!visitedRecords.has(member)) {
              visitedRecords.add(member);
              recordStack.push(member);
            }
          }
        }
      }

      let profileId: number | undefined;
      for (const key of componentKeys) {
        const oldId = this.keyToProfile.get(key);
        if (oldId === undefined) continue;
        touchedProfileIds.add(oldId);
        if (profileId === undefined && !claimedProfileIds.has(oldId)) {
          profileId = oldId;
        }
      }
      if (profileId === undefined) {
        profileId = this.nextProfileId;
        this.nextProfileId += 1;
      }
      claimedProfileIds.add(profileId);

      const tagCounts = new Map<string, number>();
      let interactions = 0;
      const members = new Set<string>(componentKeys);
      for (const key of componentKeys) {
        const record = this.records.get(key) as StoredRecord;
        interactions += record.interactions;
        for (const tag of record.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
        this.keyToProfile.set(key, profileId);
      }
      this.profiles.set(profileId, { id: profileId, members, tagCounts, interactions });
    }

    for (const oldId of touchedProfileIds) {
      if (!claimedProfileIds.has(oldId)) this.profiles.delete(oldId);
    }
  }
}

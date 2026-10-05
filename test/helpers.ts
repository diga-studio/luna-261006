import assert from "node:assert/strict";
import type { RecordKey, SourceRecord, UnifiedProfile } from "../src/index.ts";
import { ProfileStore } from "../src/index.ts";

export function keyOf(sourceId: string, recordId: string): string {
  return `${sourceId}|${recordId}`;
}

export function rec(
  sourceId: string,
  recordId: string,
  extra: Partial<SourceRecord> = {},
): SourceRecord {
  return { sourceId, recordId, ...extra };
}

/**
 * 独立重算器：只依据当前来源快照，从零计算应有的统一档案集合。
 * 用于与 ProfileStore 的增量结果对照。
 */
export class Oracle {
  private readonly records = new Map<string, SourceRecord>();

  applyBatch(batch: readonly SourceRecord[]): void {
    for (const record of batch) {
      const normalized: SourceRecord = {
        sourceId: record.sourceId,
        recordId: record.recordId,
        email: record.email ?? null,
        externalId: record.externalId ?? null,
        tags: record.tags ? [...new Set(record.tags)] : [],
        interactions: record.interactions ?? 0,
      };
      this.records.set(keyOf(record.sourceId, record.recordId), normalized);
    }
  }

  /** 返回 记录键 -> 应有档案（成员键集合、标签并集、互动总和）。 */
  computeProfiles(): Map<string, { members: Set<string>; tags: Set<string>; interactions: number }> {
    const parent = new Map<string, string>();
    const find = (key: string): string => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      let cur = key;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur) as string;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      parent.set(find(a), find(b));
    };
    for (const key of this.records.keys()) parent.set(key, key);

    const byEmail = new Map<string, string[]>();
    const byExternal = new Map<string, string[]>();
    for (const [key, record] of this.records) {
      if (record.email) {
        const group = byEmail.get(record.email) ?? [];
        group.push(key);
        byEmail.set(record.email, group);
      }
      if (record.externalId) {
        const group = byExternal.get(record.externalId) ?? [];
        group.push(key);
        byExternal.set(record.externalId, group);
      }
    }
    for (const group of [...byEmail.values(), ...byExternal.values()]) {
      const first = group[0] as string;
      for (const key of group) union(first, key);
    }

    const result = new Map<string, { members: Set<string>; tags: Set<string>; interactions: number }>();
    for (const [key, record] of this.records) {
      const root = find(key);
      let profile = result.get(root);
      if (profile === undefined) {
        profile = { members: new Set(), tags: new Set(), interactions: 0 };
        result.set(root, profile);
      }
      profile.members.add(key);
      for (const tag of record.tags ?? []) profile.tags.add(tag);
      profile.interactions += record.interactions ?? 0;
    }
    return result;
  }
}

/** 断言 store 的当前状态与 oracle 独立重算结果完全一致。 */
export function assertStoreMatchesOracle(store: ProfileStore, oracle: Oracle): void {
  const expected = oracle.computeProfiles();
  assert.equal(store.profileCount, expected.size, "档案数量不一致");

  const seenProfileIds = new Set<string>();
  for (const [key, want] of expected) {
    const [sourceId, recordId] = splitKey(key);
    const got = store.getProfileByRecord(sourceId, recordId);
    assert.ok(got !== undefined, `记录 ${key} 应有所属档案`);
    assert.deepEqual(
      new Set(got.members.map((member) => keyOf(member.sourceId, member.recordId))),
      want.members,
      `记录 ${key} 所属档案的成员集合不一致`,
    );
    assert.deepEqual(new Set(got.tags), want.tags, `记录 ${key} 所属档案的标签并集不一致`);
    assert.equal(got.interactions, want.interactions, `记录 ${key} 所属档案的互动总数不一致`);
    seenProfileIds.add(got.profileId);
  }
  assert.equal(seenProfileIds.size, expected.size, "档案 ID 数量与档案数量不一致");
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf("|");
  return [key.slice(0, index), key.slice(index + 1)];
}

/** 便于断言语义相等的档案形状（与档案 ID 无关）。 */
export function profileShape(profile: UnifiedProfile): {
  members: string[];
  tags: string[];
  interactions: number;
} {
  return {
    members: profile.members
      .map((member: RecordKey) => keyOf(member.sourceId, member.recordId))
      .sort(),
    tags: [...profile.tags].sort(),
    interactions: profile.interactions,
  };
}

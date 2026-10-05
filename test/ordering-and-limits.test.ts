import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import {
  findTopAttackPaths,
  Protocol,
  Topology,
} from "../src/index";

// 全部资产同层（无跨区加分），目标关键程度 1（+10）。
const tieTopology: Topology = {
  assets: [
    { id: 1, purdueLevel: 0, criticality: 1 },
    { id: 2, purdueLevel: 0, criticality: 1 },
    { id: 3, purdueLevel: 0, criticality: 1 },
    { id: 4, purdueLevel: 0, criticality: 1 },
  ],
  connections: [
    { id: 30, from: 1, to: 4, protocol: Protocol.ModbusTcp, bidirectional: false },
    { id: 1, from: 1, to: 2, protocol: Protocol.DNP3, bidirectional: false },
    { id: 2, from: 2, to: 3, protocol: Protocol.OpcUa, bidirectional: false },
    { id: 3, from: 3, to: 4, protocol: Protocol.OpcUa, bidirectional: false },
    { id: 9, from: 1, to: 4, protocol: Protocol.OpcUa, bidirectional: false },
    { id: 10, from: 1, to: 4, protocol: Protocol.OpcUa, bidirectional: false },
  ],
};

test("同分时连接数少者优先，再按连接编号序列数字字典序", () => {
  const paths = findTopAttackPaths(tieTopology, 1, 4);
  deepEqual(
    paths.map((p) => ({ connectionIds: p.connectionIds, score: p.score })),
    [
      { connectionIds: [30], score: 16 },      // 6+10，同分但连接数更少
      { connectionIds: [1, 2, 3], score: 16 }, // 4+1+1+10
      { connectionIds: [9], score: 11 },       // 数字字典序：9 < 10
      { connectionIds: [10], score: 11 },
    ]
  );
});

// 链式拓扑：n1..n14 共 13 条串联连接（层级交替，每条 Modbus 跨区得 14 分）。
// 完整链需 13 条连接，超过上限 12，必须被排除；
// 借助旁路 c99（n2→n4，同层 Modbus 得 6 分）可用恰好 12 条连接到达，应入选。
const chainTopology: Topology = {
  assets: Array.from({ length: 14 }, (_, i) => ({
    id: i + 1,
    purdueLevel: i % 2,
    criticality: 1,
  })),
  connections: [
    ...Array.from({ length: 13 }, (_, i) => ({
      id: i + 1,
      from: i + 1,
      to: i + 2,
      protocol: Protocol.ModbusTcp,
      bidirectional: false,
    })),
    { id: 99, from: 2, to: 4, protocol: Protocol.ModbusTcp, bidirectional: false },
    { id: 100, from: 1, to: 14, protocol: Protocol.OpcUa, bidirectional: false },
  ],
};

test("超过 12 条连接的高分路线被排除，恰好 12 条的路线保留", () => {
  const paths = findTopAttackPaths(chainTopology, 1, 14);
  deepEqual(
    paths.map((p) => ({ connectionIds: p.connectionIds, score: p.score })),
    [
      // 14 + 6 + 10*14 + 10 = 170，恰好 12 条连接
      { connectionIds: [1, 99, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], score: 170 },
      // 直连：1 + 8（跨区）+ 10 = 19
      { connectionIds: [100], score: 19 },
    ]
  );
  // 13 条连接的完整链（14*13+10=192 分）不得出现。
  deepEqual(paths.every((p) => p.connectionIds.length <= 12), true);
});

// 含环拓扑：1→2→3→1，目标 4（关键程度 2，+20），均同层。
const cycleTopology: Topology = {
  assets: [
    { id: 1, purdueLevel: 0, criticality: 1 },
    { id: 2, purdueLevel: 0, criticality: 1 },
    { id: 3, purdueLevel: 0, criticality: 1 },
    { id: 4, purdueLevel: 0, criticality: 2 },
  ],
  connections: [
    { id: 1, from: 1, to: 2, protocol: Protocol.OpcUa, bidirectional: false },
    { id: 2, from: 2, to: 3, protocol: Protocol.OpcUa, bidirectional: false },
    { id: 3, from: 3, to: 1, protocol: Protocol.OpcUa, bidirectional: false },
    { id: 4, from: 2, to: 4, protocol: Protocol.DNP3, bidirectional: false },
    { id: 5, from: 3, to: 4, protocol: Protocol.ModbusTcp, bidirectional: false },
  ],
};

test("循环拓扑中任何资产不得重复出现", () => {
  const paths = findTopAttackPaths(cycleTopology, 1, 4);
  // 若允许重复资产，1→2→3→1→2→4 等绕环路线会无限增多；此处只能有 2 条。
  deepEqual(
    paths.map((p) => ({ connectionIds: p.connectionIds, score: p.score })),
    [
      { connectionIds: [1, 2, 5], score: 28 }, // 1+1+6+20
      { connectionIds: [1, 4], score: 25 },    // 1+4+20
    ]
  );
});

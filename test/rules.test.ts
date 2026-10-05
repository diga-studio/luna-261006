import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyzer } from "../src/index.js";
import type { Topology } from "../src/index.js";

// 同分排序：全部资产 L0，目标 T 关键程度 5（+50）。
// [10]、[11]：S->T 的 Modbus 平行连接，6+50=56，1 跳。
// [12,13,14]、[12,13,15]：OPC-UA+OPC-UA+DNP3，1+1+4+50=56，3 跳。
const tieTopology: Topology = {
  assets: [
    { id: 10, level: 0, criticality: 1 },
    { id: 11, level: 0, criticality: 1 },
    { id: 12, level: 0, criticality: 1 },
    { id: 13, level: 0, criticality: 5 },
  ],
  connections: [
    { id: 10, from: 10, to: 13, protocol: "Modbus TCP", bidirectional: false },
    { id: 11, from: 10, to: 13, protocol: "Modbus TCP", bidirectional: false },
    { id: 12, from: 10, to: 11, protocol: "OPC-UA", bidirectional: false },
    { id: 13, from: 11, to: 12, protocol: "OPC-UA", bidirectional: false },
    { id: 14, from: 12, to: 13, protocol: "DNP3", bidirectional: false },
    { id: 15, from: 12, to: 13, protocol: "DNP3", bidirectional: false },
  ],
};

test("同分时连接数少的优先，再按连接编号序列排序", () => {
  const analyzer = createAnalyzer(tieTopology);
  const paths = analyzer.findTopPaths(10, 13);
  assert.equal(paths.length, 4);
  assert.ok(paths.every((p) => p.score === 56));
  assert.deepEqual(
    paths.map((p) => p.connectionIds),
    [
      [10], // 同分：1 跳优先于 3 跳
      [11], // 同分同跳数：[10] 先于 [11]
      [12, 13, 14], // 同分同跳数：从头比较第一个不同编号 14 < 15
      [12, 13, 15],
    ],
  );
});

// 13 跳长链：1->2->...->14，全部 Modbus（78+100=178 高分），超过 12 跳上限。
// 另有 1->14 的 OPC-UA 直连（1+100=101 低分）。
const chainTopology: Topology = {
  assets: Array.from({ length: 14 }, (_, i) => ({
    id: i + 1,
    level: 0,
    criticality: i + 1 === 14 ? 10 : 1,
  })),
  connections: [
    ...Array.from({ length: 13 }, (_, i) => ({
      id: i + 1,
      from: i + 1,
      to: i + 2,
      protocol: "Modbus TCP" as const,
      bidirectional: false,
    })),
    { id: 100, from: 1, to: 14, protocol: "OPC-UA", bidirectional: false },
  ],
};

test("超过 12 条连接的高分路线被排除", () => {
  const analyzer = createAnalyzer(chainTopology);
  const paths = analyzer.findTopPaths(1, 14);
  // 13 跳的 178 分长链被排除，只剩 101 分直连
  assert.deepEqual(
    paths.map((p) => p.connectionIds),
    [[100]],
  );
});

test("恰好 12 条连接的路线允许", () => {
  const analyzer = createAnalyzer(chainTopology);
  const paths = analyzer.findTopPaths(1, 13);
  assert.deepEqual(
    paths.map((p) => p.connectionIds),
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
  );
  assert.equal(paths[0].score, 12 * 6 + 10);
});

// 含环：X->Y->X 可循环，但简单路径约束下不得重复资产。
const cyclicTopology: Topology = {
  assets: [
    { id: 1, level: 0, criticality: 1 },
    { id: 2, level: 0, criticality: 1 },
    { id: 3, level: 0, criticality: 1 },
    { id: 4, level: 0, criticality: 5 },
    { id: 99, level: 0, criticality: 1 },
  ],
  connections: [
    { id: 1, from: 1, to: 2, protocol: "DNP3", bidirectional: false },
    { id: 2, from: 2, to: 3, protocol: "DNP3", bidirectional: false },
    { id: 3, from: 3, to: 2, protocol: "DNP3", bidirectional: false },
    { id: 4, from: 3, to: 4, protocol: "Modbus TCP", bidirectional: false },
    { id: 5, from: 2, to: 4, protocol: "OPC-UA", bidirectional: false },
  ],
};

test("循环不得重复资产，成环连接不被使用", () => {
  const analyzer = createAnalyzer(cyclicTopology);
  const paths = analyzer.findTopPaths(1, 4);
  assert.deepEqual(
    paths.map((p) => p.connectionIds),
    [
      [1, 2, 4], // 64 分
      [1, 5], // 55 分
    ],
  );
  for (const path of paths) {
    assert.ok(!path.connectionIds.includes(3));
    assert.equal(new Set(path.assetIds).size, path.assetIds.length);
  }
});

test("不可达时返回空结果", () => {
  const analyzer = createAnalyzer(cyclicTopology);
  assert.deepEqual(analyzer.findTopPaths(1, 99), []);
  assert.deepEqual(analyzer.findTopPaths(4, 1), []);
});

test("入口与目标相同或资产不存在时返回空结果", () => {
  const analyzer = createAnalyzer(cyclicTopology);
  assert.deepEqual(analyzer.findTopPaths(1, 1), []);
  assert.deepEqual(analyzer.findTopPaths(1, 404), []);
  assert.deepEqual(analyzer.findTopPaths(404, 1), []);
});

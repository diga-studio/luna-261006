import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyzer } from "../src/index.js";
import type { Topology } from "../src/index.js";

// 小型有环多重图：
//   A(1,L4) --10:Modbus--> B(2,L3) --15:OPC-UA--> D(4,L1,crit9)
//   A --13:Modbus--> C(3,L2)  B <-11:DNP3(双向)-> C  C <-12:OPC-UA(双向)-> D
//   C --14:Modbus--> D（与 12 平行的连接）
//   A --16:DNP3--> E(5,L3)  E <-17:OPC-UA(双向)-> B  E --18:Modbus--> C
const topology: Topology = {
  assets: [
    { id: 1, level: 4, criticality: 2 },
    { id: 2, level: 3, criticality: 3 },
    { id: 3, level: 2, criticality: 4 },
    { id: 4, level: 1, criticality: 9 },
    { id: 5, level: 3, criticality: 2 },
  ],
  connections: [
    { id: 10, from: 1, to: 2, protocol: "Modbus TCP", bidirectional: false },
    { id: 11, from: 2, to: 3, protocol: "DNP3", bidirectional: true },
    { id: 12, from: 3, to: 4, protocol: "OPC-UA", bidirectional: true },
    { id: 13, from: 1, to: 3, protocol: "Modbus TCP", bidirectional: false },
    { id: 14, from: 3, to: 4, protocol: "Modbus TCP", bidirectional: false },
    { id: 15, from: 2, to: 4, protocol: "OPC-UA", bidirectional: false },
    { id: 16, from: 1, to: 5, protocol: "DNP3", bidirectional: false },
    { id: 17, from: 5, to: 2, protocol: "OPC-UA", bidirectional: true },
    { id: 18, from: 5, to: 3, protocol: "Modbus TCP", bidirectional: false },
  ],
};

test("小型有环多重图返回精确前十名", () => {
  const analyzer = createAnalyzer(topology);
  const paths = analyzer.findTopPaths(1, 4);

  assert.deepEqual(
    paths.map((p) => p.connectionIds),
    [
      [16, 18, 11, 15], // 137：长路线高风险，压过所有短路线
      [10, 17, 18, 14], // 133：17 号双向连接反向通行 B->E
      [10, 11, 14], // 130
      [16, 18, 14], // 130
      [16, 17, 11, 14], // 129
      [10, 17, 18, 12], // 128
      [10, 11, 12], // 125：同分同跳数，按编号序列排最前
      [13, 11, 15], // 125：11 号双向连接反向通行 C->B
      [16, 18, 12], // 125
      [16, 17, 11, 12], // 124
    ],
  );
  assert.deepEqual(
    paths.map((p) => p.score),
    [137, 133, 130, 130, 129, 128, 125, 125, 125, 124],
  );
});

test("高风险长路线超过低风险短路线", () => {
  const analyzer = createAnalyzer(topology);
  const paths = analyzer.findTopPaths(1, 4);
  const longest = paths[0];
  assert.deepEqual(longest.connectionIds, [16, 18, 11, 15]);
  assert.equal(longest.connectionIds.length, 4);
  // 最短路线 [10,15] 仅 113 分，被挤出前十
  assert.ok(!paths.some((p) => p.connectionIds.join() === "10,15"));
});

test("双向连接可反向通行且连接编号不变", () => {
  const analyzer = createAnalyzer(topology);
  const paths = analyzer.findTopPaths(1, 4);
  // 11 号连接定义为 B->C，路径中反向 C->B 使用，编号仍为 11
  const reverse = paths.find((p) => p.connectionIds.join() === "13,11,15");
  assert.ok(reverse);
  assert.deepEqual(reverse.assetIds, [1, 3, 2, 4]);
});

test("同一对资产的平行连接分别入选、互不合并", () => {
  const analyzer = createAnalyzer(topology);
  const paths = analyzer.findTopPaths(1, 4);
  // 12 号与 14 号都是 C->D，资产序列相同但连接序列不同
  const via12 = paths.find((p) => p.connectionIds.join() === "10,11,12");
  const via14 = paths.find((p) => p.connectionIds.join() === "10,11,14");
  assert.ok(via12 && via14);
  assert.deepEqual(via12.assetIds, via14.assetIds);
  assert.notEqual(via12.score, via14.score);
});

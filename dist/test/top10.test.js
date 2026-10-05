"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_1 = require("../src/index");
// 拓扑：含环（2→3→2）、含平行连接（c1/c7 同为 1→2）、含双向连接（c5、c9）。
// 资产层级：1:L0 2:L1 3:L2 4:L3 5:L4，所有连接均跨区（每条 +8）。
// 目标资产 5 关键程度 8，目标加分 80。
const topology = {
    assets: [
        { id: 1, purdueLevel: 0, criticality: 1 },
        { id: 2, purdueLevel: 1, criticality: 2 },
        { id: 3, purdueLevel: 2, criticality: 4 },
        { id: 4, purdueLevel: 3, criticality: 6 },
        { id: 5, purdueLevel: 4, criticality: 8 },
    ],
    connections: [
        { id: 1, from: 1, to: 2, protocol: index_1.Protocol.ModbusTcp, bidirectional: false },
        { id: 2, from: 2, to: 3, protocol: index_1.Protocol.ModbusTcp, bidirectional: false },
        { id: 3, from: 3, to: 5, protocol: index_1.Protocol.OpcUa, bidirectional: false },
        { id: 4, from: 1, to: 3, protocol: index_1.Protocol.OpcUa, bidirectional: false },
        { id: 5, from: 2, to: 4, protocol: index_1.Protocol.DNP3, bidirectional: true },
        { id: 6, from: 4, to: 5, protocol: index_1.Protocol.ModbusTcp, bidirectional: false },
        { id: 7, from: 1, to: 2, protocol: index_1.Protocol.DNP3, bidirectional: false },
        { id: 8, from: 3, to: 2, protocol: index_1.Protocol.OpcUa, bidirectional: false },
        { id: 9, from: 3, to: 4, protocol: index_1.Protocol.OpcUa, bidirectional: true },
    ],
};
(0, node_test_1.test)("小型有环多重图返回精确前十名", () => {
    const paths = (0, index_1.findTopAttackPaths)(topology, 1, 5);
    (0, strict_1.deepEqual)(paths.map((p) => ({ connectionIds: p.connectionIds, score: p.score })), [
        { connectionIds: [1, 2, 9, 6], score: 131 },
        { connectionIds: [7, 2, 9, 6], score: 129 },
        { connectionIds: [1, 5, 9, 3], score: 124 },
        { connectionIds: [4, 8, 5, 6], score: 124 },
        { connectionIds: [7, 5, 9, 3], score: 122 },
        { connectionIds: [1, 5, 6], score: 120 },
        { connectionIds: [7, 5, 6], score: 118 },
        { connectionIds: [1, 2, 3], score: 117 },
        { connectionIds: [7, 2, 3], score: 115 },
        { connectionIds: [4, 9, 6], score: 112 }, // 9+9+14+80
    ]);
});
(0, node_test_1.test)("高风险长路线排在低风险短路线之前，短路线被挤出前十", () => {
    const paths = (0, index_1.findTopAttackPaths)(topology, 1, 5);
    // [4,3] 是最短路线（2 条连接，98 分），但风险低，未进入前十。
    (0, strict_1.deepEqual)(paths.some((p) => deepEqualSafe(p.connectionIds, [4, 3])), false);
    // 最长的 4 连接高风险路线 [1,2,9,6] 排名第一。
    (0, strict_1.deepEqual)(paths[0].connectionIds, [1, 2, 9, 6]);
});
function deepEqualSafe(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
(0, node_test_1.test)("双向连接反向通行且连接编号不变", () => {
    const paths = (0, index_1.findTopAttackPaths)(topology, 1, 5);
    // [1,5,9,3]：c5 按 2→4 正向、c9 按 4→3 反向通行，编号仍为 5 和 9。
    const p = paths.find((p) => deepEqualSafe(p.connectionIds, [1, 5, 9, 3]));
    (0, strict_1.deepEqual)(p?.score, 124);
});
(0, node_test_1.test)("同一对资产的平行连接形成不同路径并分别入选", () => {
    const paths = (0, index_1.findTopAttackPaths)(topology, 1, 5);
    // c1 与 c7 都是 1→2，资产序列相同但连接序列不同，分别计入。
    (0, strict_1.deepEqual)(paths[0].connectionIds, [1, 2, 9, 6]);
    (0, strict_1.deepEqual)(paths[1].connectionIds, [7, 2, 9, 6]);
});
(0, node_test_1.test)("不可达时返回空结果", () => {
    (0, strict_1.deepEqual)((0, index_1.findTopAttackPaths)(topology, 5, 1), []);
});

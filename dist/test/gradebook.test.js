"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const gradebook_1 = require("../src/gradebook");
const gate_1 = require("./gate");
const reference_1 = require("./reference");
const keyOf = (semester) => ({ courseId: 'CS101', semester });
const oldRule = {
    weights: { homework: 20, midterm: 30, final: 50 },
    strategy: 'max',
    passLine: 60,
};
const newRule = {
    weights: { homework: 30, midterm: 30, final: 40 },
    strategy: 'last',
    passLine: 70,
};
function attempts(h, m, f) {
    return { homework: h, midterm: m, final: f };
}
(0, node_test_1.test)('场景一：部分学生算完后暂停，覆盖已算学生并新增学生，读写不停', async () => {
    const key = keyOf('2026-spring');
    const gate = new gate_1.Gate();
    const reached = new gate_1.Signal();
    const pauseAfter = 5;
    const service = new gradebook_1.GradebookService({
        afterCompute: async (_key, _studentId, _inputVersion, computeCount) => {
            if (computeCount === pauseAfter) {
                reached.fire();
                await gate.wait();
            }
        },
    });
    // 首次建立规则，此时还没有学生成绩。
    (0, strict_1.equal)(await service.publishRule(key, oldRule), 1);
    // 录入 10 名学生，测试侧自维护最新输入。
    const inputs = new Map();
    const put = (studentId, a) => {
        const inputVersion = service.putGrades(key, studentId, a);
        inputs.set(studentId, { inputVersion, attempts: a });
    };
    for (let i = 1; i <= 10; i++) {
        put(`s${i}`, attempts([50 + i], [60 + i], [70 + i]));
    }
    (0, strict_1.deepEqual)(service.readGradebook(key), {
        ruleVersion: 1,
        students: (0, reference_1.referenceGradebook)(oldRule, inputs),
    });
    // 启动纠错：重算到第 5 名学生后暂停。
    const publish = service.publishRule(key, newRule);
    await reached.promise;
    // 暂停期间：覆盖一名已按新规则算完的学生（s3，前 5 个被计算），并新增一名学生。
    put('s3', attempts([100, 40], [100, 40], [100, 40]));
    put('s11', attempts([10], [20], [30]));
    // 暂停期间读取立即完成，且全部行仍使用旧规则，并包含最新写入。
    (0, strict_1.deepEqual)(service.readGradebook(key), {
        ruleVersion: 1,
        students: (0, reference_1.referenceGradebook)(oldRule, inputs),
    });
    // 恢复重算，发布后逐项对照新规则与最新输入。
    gate.release();
    (0, strict_1.equal)(await publish, 2);
    (0, strict_1.deepEqual)(service.readGradebook(key), {
        ruleVersion: 2,
        students: (0, reference_1.referenceGradebook)(newRule, inputs),
    });
});
(0, node_test_1.test)('场景二：已取旧输入未提交时连续覆盖两次，旧结果不得反向覆盖；另一学期不受影响', async () => {
    const keyA = { courseId: 'CS101', semester: '2026-spring' };
    const keyB = { courseId: 'CS101', semester: '2026-autumn' };
    const gate = new gate_1.Gate();
    const reached = new gate_1.Signal();
    let paused = false;
    const service = new gradebook_1.GradebookService({
        afterInputRead: async (key, studentId) => {
            // 学生 x 的重算已取得旧输入、尚未提交结果时暂停（仅第一次）。
            if (!paused && key.semester === keyA.semester && studentId === 'x') {
                paused = true;
                reached.fire();
                await gate.wait();
            }
        },
    });
    (0, strict_1.equal)(await service.publishRule(keyA, oldRule), 1);
    (0, strict_1.equal)(await service.publishRule(keyB, oldRule), 1);
    // v1：max 策略下高分通过；last 策略下（末次 10/10/10）远不及格。
    const v1 = attempts([90, 10], [90, 10], [90, 10]);
    // v2：中间覆盖，last 策略下依然不及格。
    const v2 = attempts([20, 90], [20, 90], [20, 90]);
    // v3：最终覆盖，last 策略下高分通过。
    const v3 = attempts([95], [95], [95]);
    (0, strict_1.equal)(service.putGrades(keyA, 'x', v1), 1);
    (0, strict_1.equal)(service.putGrades(keyB, 'z', attempts([80], [80], [80])), 1);
    const inputsA = new Map();
    const inputsB = new Map();
    inputsA.set('x', { inputVersion: 1, attempts: v1 });
    inputsB.set('z', { inputVersion: 1, attempts: attempts([80], [80], [80]) });
    // 启动 A 的纠错：max -> last。x 的旧输入 v1 被取走后暂停。
    const publish = service.publishRule(keyA, newRule);
    await reached.promise;
    // 暂停期间连续覆盖该生两次；写入与读取均立即完成。
    (0, strict_1.equal)(service.putGrades(keyA, 'x', v2), 2);
    inputsA.set('x', { inputVersion: 2, attempts: v2 });
    (0, strict_1.equal)(service.putGrades(keyA, 'x', v3), 3);
    inputsA.set('x', { inputVersion: 3, attempts: v3 });
    (0, strict_1.deepEqual)(service.readGradebook(keyA), {
        ruleVersion: 1,
        students: (0, reference_1.referenceGradebook)(oldRule, inputsA),
    });
    // 恢复：基于 v1 的旧结果先暂存，但 x 已被标记 dirty，最终以 v3 重算为准。
    gate.release();
    (0, strict_1.equal)(await publish, 2);
    const bookA = service.readGradebook(keyA);
    (0, strict_1.equal)(bookA.ruleVersion, 2);
    // 若基于旧输入 v1 的结果反向覆盖，这里会是 inputVersion=1 且 passed=false。
    (0, strict_1.deepEqual)(bookA.students, (0, reference_1.referenceGradebook)(newRule, inputsA));
    (0, strict_1.equal)(bookA.students['x'].inputVersion, 3);
    (0, strict_1.equal)(bookA.students['x'].passed, true);
    // 另一学期（不同 key）完全不受影响。
    (0, strict_1.deepEqual)(service.readGradebook(keyB), {
        ruleVersion: 1,
        students: (0, reference_1.referenceGradebook)(oldRule, inputsB),
    });
});
(0, node_test_1.test)('场景三：2 万名学生纠错穿插覆盖，全量对照串行参考，未变学生不重算', async () => {
    const key = keyOf('2026-spring');
    const total = 20000;
    const inputs = new Map();
    // 在指定计算次数处同步穿插覆盖（确定性，无 sleep）。
    const overridesAt = new Map([
        [5000, [['st-00010', attempts([11], [22], [33])],
                ['st-19999', attempts([44], [55], [66])]]],
        [10000, [['st-09999', attempts([77], [88], [99])]]],
        [15000, [['st-00000', attempts([100], [90], [80])]]], // 已算完 -> 追加 1 次
    ]);
    const extraComputations = 3;
    const service = new gradebook_1.GradebookService({
        afterCompute: (_key, _studentId, _inputVersion, computeCount) => {
            const overrides = overridesAt.get(computeCount);
            if (!overrides)
                return;
            for (const [studentId, a] of overrides) {
                const inputVersion = service.putGrades(key, studentId, a);
                inputs.set(studentId, { inputVersion, attempts: a });
            }
        },
    });
    (0, strict_1.equal)(await service.publishRule(key, oldRule), 1);
    // 确定性伪随机生成 2 万名学生成绩（LCG）。
    let seed = 42;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % 101;
    };
    const scores = () => {
        const n = 1 + (rand() % 3);
        return Array.from({ length: n }, () => rand());
    };
    for (let i = 0; i < total; i++) {
        const studentId = `st-${String(i).padStart(5, '0')}`;
        const a = attempts(scores(), scores(), scores());
        const inputVersion = service.putGrades(key, studentId, a);
        inputs.set(studentId, { inputVersion, attempts: a });
    }
    (0, strict_1.equal)(await service.publishRule(key, newRule), 2);
    // 完整结果与串行参考计算逐项一致。
    (0, strict_1.deepEqual)(service.readGradebook(key), {
        ruleVersion: 2,
        students: (0, reference_1.referenceGradebook)(newRule, inputs),
    });
    // 实际计算次数 = 2 万 + 3 次追加：未变学生不会因并发写入被反复重算。
    (0, strict_1.equal)(service.recomputeCount, total + extraComputations);
});

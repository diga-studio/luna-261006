export function buildContext(input) {
    const judgeIndexById = new Map();
    input.judges.forEach((judge, index) => {
        if (judgeIndexById.has(judge.id)) {
            throw new Error(`duplicate judge id: ${judge.id}`);
        }
        judgeIndexById.set(judge.id, index);
    });
    const taskIndexById = new Map();
    input.tasks.forEach((task, index) => {
        if (taskIndexById.has(task.id)) {
            throw new Error(`duplicate task id: ${task.id}`);
        }
        taskIndexById.set(task.id, index);
    });
    const projectById = new Map(input.projects.map((p) => [p.id, p]));
    const judgeCount = input.judges.length;
    const taskCount = input.tasks.length;
    const lockedCount = new Array(judgeCount).fill(0);
    const remainingSlots = new Array(taskCount).fill(0);
    const eligible = [];
    const candidate = [];
    const preferred = [];
    const lockedPair = [];
    input.tasks.forEach((task, t) => {
        const project = projectById.get(task.projectId);
        if (!project) {
            throw new Error(`task ${task.id} references unknown project ${task.projectId}`);
        }
        const lockedRow = new Array(judgeCount).fill(false);
        for (const judgeId of task.lockedJudgeIds) {
            const j = judgeIndexById.get(judgeId);
            if (j === undefined) {
                throw new Error(`task ${task.id} locks unknown judge ${judgeId}`);
            }
            if (lockedRow[j]) {
                throw new Error(`task ${task.id} locks judge ${judgeId} twice`);
            }
            lockedRow[j] = true;
            lockedCount[j] += 1;
        }
        lockedPair.push(lockedRow);
        remainingSlots[t] = task.requiredJudges - task.lockedJudgeIds.length;
        const preferredRow = new Array(judgeCount).fill(false);
        for (const judgeId of task.preferredJudgeIds) {
            const j = judgeIndexById.get(judgeId);
            if (j !== undefined) {
                preferredRow[j] = true;
            }
        }
        preferred.push(preferredRow);
        const blocked = new Set([project.creatorId, ...project.stakeholderIds]);
        if (task.kind === "appeal") {
            for (const round of project.rounds) {
                for (const judgeId of round) {
                    blocked.add(judgeId);
                }
            }
        }
        const eligibleRow = new Array(judgeCount);
        const candidateRow = new Array(judgeCount);
        input.judges.forEach((judge, j) => {
            const ok = !blocked.has(judge.id);
            eligibleRow[j] = ok;
            candidateRow[j] = ok && !lockedRow[j];
        });
        eligible.push(eligibleRow);
        candidate.push(candidateRow);
    });
    const remainingCapacity = input.judges.map((judge, j) => judge.capacity - lockedCount[j]);
    return {
        input,
        judgeIndexById,
        taskIndexById,
        lockedCount,
        remainingCapacity,
        remainingSlots,
        eligible,
        candidate,
        preferred,
        lockedPair,
    };
}

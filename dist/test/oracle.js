function evalFilter(node, tags, skills) {
    switch (node.op) {
        case 'tag':
            return tags.has(node.tag);
        case 'skill':
            return skills.has(node.skill);
        case 'and':
            return node.children.every((c) => evalFilter(c, tags, skills));
        case 'or':
            return node.children.some((c) => evalFilter(c, tags, skills));
        case 'not':
            return !evalFilter(node.child, tags, skills);
    }
}
/** Brute-force reference: evaluates every version of every candidate. */
export function oracleSearch(candidates, query) {
    const hits = [];
    for (const candidate of candidates) {
        const tags = new Set(candidate.tags);
        let bestScore = -1;
        let bestVersionId = '';
        let bestMatched = [];
        for (const resume of candidate.resumes) {
            const skills = new Set(resume.skills);
            if (!evalFilter(query.filter, tags, skills))
                continue;
            let score = Math.max(0, 60 - Math.abs(resume.experienceMonths - query.targetExperienceMonths));
            const matched = [];
            for (const item of query.scoring) {
                const hit = item.kind === 'tag' ? tags.has(item.value) : skills.has(item.value);
                if (hit) {
                    score += item.weight;
                    matched.push(item);
                }
            }
            if (score > bestScore ||
                (score === bestScore && (bestVersionId === '' || resume.versionId < bestVersionId))) {
                bestScore = score;
                bestVersionId = resume.versionId;
                bestMatched = matched;
            }
        }
        if (bestVersionId !== '') {
            hits.push({
                candidateId: candidate.id,
                score: bestScore,
                witnessVersionId: bestVersionId,
                matchedScoring: bestMatched,
            });
        }
    }
    hits.sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
    });
    return hits.slice(0, query.k);
}

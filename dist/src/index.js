/**
 * Build a static index. Takes no query; one index serves many different
 * queries with different weights and experience targets.
 */
export function buildIndex(candidates) {
    const candidateIds = [];
    const candidateVersions = [];
    const candidateOfVersion = [];
    const experienceOfVersion = [];
    const versionIds = [];
    const skillPostings = new Map();
    const tagPostings = new Map();
    candidates.forEach((candidate, candidatePos) => {
        candidateIds.push(candidate.id);
        const versions = [];
        for (const resume of candidate.resumes) {
            const docId = versionIds.length;
            versions.push(docId);
            candidateOfVersion.push(candidatePos);
            experienceOfVersion.push(resume.experienceMonths);
            versionIds.push(resume.versionId);
            for (const skill of resume.skills) {
                let list = skillPostings.get(skill);
                if (list === undefined) {
                    list = [];
                    skillPostings.set(skill, list);
                }
                list.push(docId);
            }
        }
        candidateVersions.push(versions);
        for (const tag of candidate.tags) {
            let list = tagPostings.get(tag);
            if (list === undefined) {
                list = [];
                tagPostings.set(tag, list);
            }
            list.push(candidatePos);
        }
    });
    const versionsByExperience = Array.from({ length: versionIds.length }, (_, i) => i);
    versionsByExperience.sort((a, b) => experienceOfVersion[a] - experienceOfVersion[b] || a - b);
    return {
        versionCount: versionIds.length,
        candidateOfVersion: Uint32Array.from(candidateOfVersion),
        experienceOfVersion: Uint32Array.from(experienceOfVersion),
        versionIds,
        candidateIds,
        candidateVersions,
        skillPostings,
        tagPostings,
        versionsByExperience,
    };
}

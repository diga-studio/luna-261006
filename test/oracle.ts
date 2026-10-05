import type {
  CandidateInput,
  FilterNode,
  MatchLeaf,
  Query,
  SearchOutput,
  SearchResultItem,
} from '../src/index.js';

function leafMatches(candidate: CandidateInput, resumeIndex: number, leaf: MatchLeaf): boolean {
  if (leaf.kind === 'tag') {
    return candidate.tags.includes(leaf.value);
  }
  return candidate.resumes[resumeIndex].skills.includes(leaf.value);
}

function filterMatches(candidate: CandidateInput, resumeIndex: number, node: FilterNode): boolean {
  switch (node.op) {
    case 'leaf':
      return leafMatches(candidate, resumeIndex, node.leaf);
    case 'not':
      return !filterMatches(candidate, resumeIndex, node.child);
    case 'and':
      return node.children.every((child) => filterMatches(candidate, resumeIndex, child));
    case 'or':
      return node.children.some((child) => filterMatches(candidate, resumeIndex, child));
  }
}

/** Brute-force reference implementation: scores every version of every
 *  candidate directly from the inputs. */
export function oracleSearch(candidates: readonly CandidateInput[], query: Query): SearchOutput {
  const perCandidate = new Map<string, SearchResultItem>();

  for (const candidate of candidates) {
    for (const resume of candidate.resumes) {
      if (!filterMatches(candidate, candidate.resumes.indexOf(resume), query.filter)) {
        continue;
      }
      const matched = query.scoring
        .filter((s) => leafMatches(candidate, candidate.resumes.indexOf(resume), s.leaf))
        .map((s) => ({ leaf: s.leaf, weight: s.weight }));
      const weightSum = matched.reduce((acc, hit) => acc + hit.weight, 0);
      const bonus = Math.max(0, 60 - Math.abs(resume.experienceMonths - query.experienceTargetMonths));
      const score = weightSum + bonus;
      const existing = perCandidate.get(candidate.id);
      if (
        existing === undefined ||
        score > existing.score ||
        (score === existing.score && resume.id < existing.witnessVersionId)
      ) {
        perCandidate.set(candidate.id, {
          candidateId: candidate.id,
          score,
          witnessVersionId: resume.id,
          matchedScoring: matched,
        });
      }
    }
  }

  const results = [...perCandidate.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0),
  );
  return { results: results.slice(0, Math.max(0, query.k)), scoredVersions: -1 };
}

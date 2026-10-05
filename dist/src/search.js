import { andInto, cloneBitset, createBitset, getBit, notInto, orInto, setBit } from './bitset.js';
/** Maximum possible experience-closeness contribution. */
const EXP_MAX = 60;
/** Upper bound on how many resumes the seeding phase may score. */
const SEED_BUDGET = 1000;
const INF = Number.POSITIVE_INFINITY;
/** First index >= target, galloping from `cursor`. Returns postings.length when exhausted. */
function advanceTo(postings, cursor, target) {
    const n = postings.length;
    let i = cursor;
    if (i >= n || postings[i] >= target)
        return i;
    let step = 1;
    let next = i + step;
    while (next < n && postings[next] < target) {
        i = next;
        step <<= 1;
        next = i + step;
    }
    let lo = i + 1;
    let hi = Math.min(next, n);
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (postings[mid] < target)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
function contains(postings, doc) {
    let lo = 0;
    let hi = postings.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const v = postings[mid];
        if (v < doc)
            lo = mid + 1;
        else if (v > doc)
            hi = mid;
        else
            return true;
    }
    return false;
}
function intersectPostings(a, b) {
    const small = a.length <= b.length ? a : b;
    const large = a.length <= b.length ? b : a;
    const out = [];
    let cursor = 0;
    for (const v of small) {
        cursor = advanceTo(large, cursor, v);
        if (cursor >= large.length)
            break;
        if (large[cursor] === v)
            out.push(v);
    }
    return out;
}
function intersectMany(lists) {
    if (lists.length === 0)
        return [];
    const sorted = [...lists].sort((a, b) => a.length - b.length);
    let acc = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        if (acc.length === 0)
            return acc;
        acc = intersectPostings(acc, sorted[i]);
    }
    return acc;
}
/** Version doc ids matching a leaf; tags expand to all versions of the tagged candidates. */
function leafPostings(index, kind, value) {
    if (kind === 'skill')
        return index.skillPostings.get(value) ?? [];
    const out = [];
    for (const candPos of index.tagPostings.get(value) ?? []) {
        out.push(...index.candidateVersions[candPos]);
    }
    return out;
}
function evalFilterNode(index, node, cache) {
    switch (node.op) {
        case 'tag':
        case 'skill': {
            const value = node.op === 'tag' ? node.tag : node.skill;
            const key = `${node.op}:${value}`;
            let bits = cache.get(key);
            if (bits === undefined) {
                bits = createBitset(index.versionCount);
                for (const doc of leafPostings(index, node.op, value))
                    setBit(bits, doc);
                cache.set(key, bits);
            }
            return cloneBitset(bits);
        }
        case 'and': {
            if (node.children.length === 0) {
                const empty = createBitset(index.versionCount);
                const all = createBitset(index.versionCount);
                notInto(all, empty, index.versionCount);
                return all;
            }
            const acc = evalFilterNode(index, node.children[0], cache);
            for (let i = 1; i < node.children.length; i++) {
                andInto(acc, evalFilterNode(index, node.children[i], cache));
            }
            return acc;
        }
        case 'or': {
            const acc = createBitset(index.versionCount);
            for (const child of node.children) {
                orInto(acc, evalFilterNode(index, child, cache));
            }
            return acc;
        }
        case 'not': {
            const child = evalFilterNode(index, node.child, cache);
            const out = createBitset(index.versionCount);
            notInto(out, child, index.versionCount);
            return out;
        }
    }
}
export function search(index, query, options = {}) {
    const k = query.k;
    if (k <= 0 || index.versionCount === 0) {
        return { hits: [], scoredVersions: 0 };
    }
    const qualify = evalFilterNode(index, query.filter, new Map());
    const terms = query.scoring.map((item) => ({
        item,
        postings: leafPostings(index, item.kind, item.value),
        cursor: 0,
        virtual: false,
    }));
    // Per-call scoring state.
    const memo = new Map();
    const best = new Map();
    let scoredVersions = 0;
    // Min-heap of the current top-k candidate scores (worst at top); used only
    // to derive the pruning threshold. Stale entries are discarded lazily.
    const heap = [];
    const represented = new Set();
    let representedCount = 0;
    const heapWorse = (a, b) => {
        if (a.score !== b.score)
            return a.score < b.score;
        return index.candidateIds[a.candPos] > index.candidateIds[b.candPos];
    };
    const heapPush = (entry) => {
        heap.push(entry);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >>> 1;
            if (heapWorse(heap[i], heap[parent])) {
                const tmp = heap[i];
                heap[i] = heap[parent];
                heap[parent] = tmp;
                i = parent;
            }
            else
                break;
        }
    };
    const heapPop = () => {
        const last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const left = 2 * i + 1;
                const right = left + 1;
                let worst = i;
                if (left < heap.length && heapWorse(heap[left], heap[worst]))
                    worst = left;
                if (right < heap.length && heapWorse(heap[right], heap[worst]))
                    worst = right;
                if (worst === i)
                    break;
                const tmp = heap[i];
                heap[i] = heap[worst];
                heap[worst] = tmp;
                i = worst;
            }
        }
    };
    const isStale = (entry) => best.get(entry.candPos)?.score !== entry.score;
    const cleanTop = () => {
        while (heap.length > 0 && isStale(heap[0]))
            heapPop();
    };
    const threshold = () => {
        if (representedCount < k)
            return -Infinity;
        cleanTop();
        return heap.length > 0 ? heap[0].score : -Infinity;
    };
    /** Record scoring work for one resume version and fold it into candidate bests. */
    const consider = (doc, score, matched) => {
        memo.set(doc, { score, matched });
        scoredVersions++;
        const candPos = index.candidateOfVersion[doc];
        options.onScoreVersion?.({
            candidateId: index.candidateIds[candPos],
            versionId: index.versionIds[doc],
        });
        const cur = best.get(candPos);
        if (cur === undefined || score > cur.score) {
            best.set(candPos, { score, doc });
            heapPush({ score, candPos });
            if (!represented.has(candPos)) {
                represented.add(candPos);
                representedCount++;
            }
            while (representedCount > k) {
                cleanTop();
                if (heap.length === 0)
                    break;
                const top = heap[0];
                heapPop();
                represented.delete(top.candPos);
                representedCount--;
            }
        }
        else if (score === cur.score && index.versionIds[doc] < index.versionIds[cur.doc]) {
            best.set(candPos, { score, doc });
        }
    };
    const evaluateWithTerms = (doc) => {
        let score = 0;
        const matched = [];
        for (const term of terms) {
            if (contains(term.postings, doc)) {
                score += term.item.weight;
                matched.push(term.item);
            }
        }
        score += Math.max(0, EXP_MAX - Math.abs(index.experienceOfVersion[doc] - query.targetExperienceMonths));
        consider(doc, score, matched);
    };
    if (terms.length === 0) {
        // Experience-only ranking: walk versions in non-decreasing distance from
        // the target and stop as soon as the threshold cannot be reached.
        const sorted = index.versionsByExperience;
        const exp = index.experienceOfVersion;
        const target = query.targetExperienceMonths;
        const n = sorted.length;
        let lo = 0;
        let hi = n;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (exp[sorted[mid]] < target)
                lo = mid + 1;
            else
                hi = mid;
        }
        let li = lo - 1;
        let ri = lo;
        while (li >= 0 || ri < n) {
            const dl = li >= 0 ? target - exp[sorted[li]] : INF;
            const dr = ri < n ? exp[sorted[ri]] - target : INF;
            const dist = Math.min(dl, dr);
            const closeness = Math.max(0, EXP_MAX - dist);
            if (representedCount >= k && closeness < threshold())
                break;
            const doc = dl <= dr ? sorted[li--] : sorted[ri++];
            if (!getBit(qualify, doc))
                continue;
            consider(doc, closeness, []);
        }
    }
    else {
        // Seeding: score resumes in the tightest term intersections first so the
        // threshold rises quickly. Intersections are set-level operations.
        const byWeightDesc = [...terms].sort((a, b) => b.item.weight - a.item.weight);
        const seedGroups = [byWeightDesc];
        if (byWeightDesc.length >= 2)
            seedGroups.push(byWeightDesc.slice(0, -1));
        if (byWeightDesc.length >= 3)
            seedGroups.push(byWeightDesc.slice(0, -2));
        let seedingDone = false;
        for (const group of seedGroups) {
            if (seedingDone)
                break;
            const common = intersectMany(group.map((t) => t.postings));
            for (const doc of common) {
                if (memo.size >= SEED_BUDGET) {
                    seedingDone = true;
                    break;
                }
                if (!memo.has(doc) && getBit(qualify, doc))
                    evaluateWithTerms(doc);
            }
        }
        // WAND: exact top-k with per-resume scoring only at pivots. `order` is a
        // separate permutation so `terms` keeps query order for explanations.
        // A virtual zero-weight term matching every version keeps the traversal
        // exact: versions matching no scoring leaf still have an experience score.
        const virtualTerm = {
            item: { kind: 'skill', value: '', weight: 0 },
            postings: [],
            cursor: 0,
            virtual: true,
        };
        const curDoc = (t) => {
            if (t.virtual)
                return t.cursor < index.versionCount ? t.cursor : INF;
            return t.cursor < t.postings.length ? t.postings[t.cursor] : INF;
        };
        const order = [...terms, virtualTerm];
        for (;;) {
            order.sort((a, b) => curDoc(a) - curDoc(b));
            const tau = threshold();
            let cum = EXP_MAX;
            let pivotIdx = -1;
            for (let i = 0; i < order.length; i++) {
                if (curDoc(order[i]) === INF)
                    break;
                cum += order[i].item.weight;
                if (cum >= tau) {
                    pivotIdx = i;
                    break;
                }
            }
            if (pivotIdx === -1)
                break;
            const pivotDoc = curDoc(order[pivotIdx]);
            if (curDoc(order[0]) === pivotDoc) {
                if (!memo.has(pivotDoc) && getBit(qualify, pivotDoc))
                    evaluateWithTerms(pivotDoc);
                for (const t of order)
                    if (curDoc(t) === pivotDoc)
                        t.cursor++;
            }
            else {
                for (const t of order) {
                    if (curDoc(t) < pivotDoc) {
                        t.cursor = t.virtual ? pivotDoc : advanceTo(t.postings, t.cursor, pivotDoc);
                    }
                }
            }
        }
    }
    const hits = [...best.entries()].map(([candPos, b]) => ({
        candidateId: index.candidateIds[candPos],
        score: b.score,
        witnessVersionId: index.versionIds[b.doc],
        matchedScoring: memo.get(b.doc).matched,
    }));
    hits.sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
    });
    return { hits: hits.slice(0, k), scoredVersions };
}

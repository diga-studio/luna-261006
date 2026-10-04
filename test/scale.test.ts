import { test } from "node:test";
import { ok, equal, deepEqual } from "node:assert/strict";
import { BomService } from "../src/bomService";
import { BomRevision } from "../src/types";
import { NaiveBom, verifyWitness, bomAtFromRevisions, makeRng } from "./helpers/naive";

const DAY_COUNT = 20_000;
const CORE_LAYERS = 20;
const CORE_WIDTH = 4;
const CORE_SIZE = CORE_LAYERS * CORE_WIDTH; // M0..M79
const NON_CORE_COUNT = 2_420; // M80..M2499
const ASSEMBLY_COUNT = CORE_SIZE + NON_CORE_COUNT;
const VERSIONS_PER_ASSEMBLY = 20;
const LEAF_BASE = 5_000; // M5000..M8999 are leaves
const LEAF_COUNT = 4_000;
const PLAYGROUND_BASE = 9_000; // M9000..M9059 reserved for randomized batches
const PLAYGROUND_COUNT = 60;

const mid = (n: number) => `M${n}`;

function coreComponents(node: number, versionIdx: number): string[] {
  const layer = Math.floor(node / CORE_WIDTH);
  if (layer >= CORE_LAYERS - 1) return [];
  const pos = node % CORE_WIDTH;
  const nextLayerBase = (layer + 1) * CORE_WIDTH;
  const candidates = [0, 1, 2].map((k) => mid(nextLayerBase + ((pos + k) % CORE_WIDTH)));
  return candidates.slice(0, 1 + (versionIdx % 3));
}

function nonCoreComponents(assemblyIdx: number, versionIdx: number): string[] {
  return [0, 1].map((k) => mid(LEAF_BASE + ((assemblyIdx * 31 + versionIdx * 17 + k * 101) % LEAF_COUNT)));
}

/** Deterministically builds the 50k-version sparse timetable. */
function buildScaleRevisions(): BomRevision[] {
  const revisions: BomRevision[] = [];
  for (let a = 0; a < ASSEMBLY_COUNT; a++) {
    for (let j = 0; j < VERSIONS_PER_ASSEMBLY; j++) {
      let startDay = (a * VERSIONS_PER_ASSEMBLY + j) % DAY_COUNT;
      if (a < 10 && j === VERSIONS_PER_ASSEMBLY - 1) {
        startDay = 2_000_000_000 + a; // a few versions billions of days out
      }
      const components =
        a < CORE_SIZE ? coreComponents(a, j) : nonCoreComponents(a, j);
      revisions.push({ assemblyId: mid(a), startDay, components });
    }
  }
  return revisions;
}

test("scale timetable: 10k materials, 50k versions, 100k entries, 20k start days", () => {
  const revisions = buildScaleRevisions();
  equal(revisions.length, 50_000);
  const entries = revisions.reduce((n, r) => n + r.components.length, 0);
  ok(entries >= 90_000 && entries <= 110_000, `component entries ${entries}`);
  const days = new Set(revisions.map((r) => r.startDay));
  ok(days.size >= DAY_COUNT, `distinct start days ${days.size}`);
  const materials = new Set<string>();
  for (const r of revisions) {
    materials.add(r.assemblyId);
    for (const c of r.components) materials.add(c);
  }
  ok(materials.size <= 10_000, `materials ${materials.size}`);

  // Acyclic by construction: core edges point strictly to the next layer,
  // non-core edges point to leaf materials that never publish versions.
  const service = new BomService();
  const rng = makeRng(42);
  const shuffled = revisions.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const started = Date.now();
  const BATCH = 250;
  for (let i = 0; i < shuffled.length; i += BATCH) {
    const result = service.publishBatch(shuffled.slice(i, i + BATCH));
    ok(result.ok, `scale batch at offset ${i} must be accepted`);
  }
  const elapsed = Date.now() - started;
  ok(elapsed < 60_000, `50k versions published in ${elapsed}ms`);
  console.log(`  scale build: 50,000 versions in ${elapsed}ms`);

  // Spot-check bomAt against a direct lookup over the raw revision list.
  const lookup = bomAtFromRevisions(revisions);
  for (let i = 0; i < 300; i++) {
    const assembly = mid(Math.floor(rng() * ASSEMBLY_COUNT));
    const day = Math.floor(rng() * DAY_COUNT);
    deepEqual(service.bomAt(assembly, day), lookup(assembly, day));
  }
  deepEqual(service.bomAt(mid(0), 2_500_000_000), lookup(mid(0), 2_500_000_000));
});

test("randomized small batches cross-checked against naive reference", () => {
  const seed = buildScaleRevisions();
  const service = new BomService();
  ok(service.publishBatch(seed).ok, "seed timetable must be accepted");
  const naive = new NaiveBom(seed);
  const accepted: BomRevision[] = seed.slice();

  const rng = makeRng(20261006);
  const used = new Set<string>();
  for (const r of seed) used.add(`${r.assemblyId}|${r.startDay}`);
  const randInt = (n: number) => Math.floor(rng() * n);

  const freshDay = (assembly: string, max: number): number | null => {
    for (let tries = 0; tries < 40; tries++) {
      const day = randInt(max);
      if (!used.has(`${assembly}|${day}`)) return day;
    }
    return null;
  };

  const randomRevision = (): BomRevision | null => {
    const onPlayground = rng() < 0.7;
    const assembly = onPlayground
      ? mid(PLAYGROUND_BASE + randInt(PLAYGROUND_COUNT))
      : mid(CORE_SIZE + randInt(NON_CORE_COUNT));
    const day = freshDay(assembly, DAY_COUNT);
    if (day === null) return null;
    const components: string[] = [];
    const count = randInt(4);
    for (let k = 0; k < count; k++) {
      const target =
        onPlayground && rng() < 0.3
          ? mid(PLAYGROUND_BASE + randInt(PLAYGROUND_COUNT))
          : mid(LEAF_BASE + randInt(LEAF_COUNT));
      if (target !== assembly && !components.includes(target)) components.push(target);
    }
    return { assemblyId: assembly, startDay: day, components };
  };

  /** Walks playground edges effective on `day` from `start`; returns the path. */
  const walkDown = (start: string, day: number): string[] => {
    const path = [start];
    let cur = start;
    for (let steps = 0; steps < 30; steps++) {
      const version = naive.bomAt(cur, day);
      const next = (version?.components ?? []).filter((c) => {
        const n = Number(c.slice(1));
        return n >= PLAYGROUND_BASE && n < PLAYGROUND_BASE + PLAYGROUND_COUNT;
      });
      if (next.length === 0) break;
      cur = next[randInt(next.length)];
      path.push(cur);
    }
    return path;
  };

  let rejects = 0;
  let accepts = 0;
  let adversarialAttempts = 0;
  let adversarialRejects = 0;
  const RANDOM_BATCHES = 150;
  const ADVERSARIAL_BATCHES = 60;

  for (let round = 0; round < RANDOM_BATCHES + ADVERSARIAL_BATCHES; round++) {
    const batch: BomRevision[] = [];
    let adversarial = false;
    if (round >= RANDOM_BATCHES) {
      // Adversarial: close a cycle on purpose at a chosen day.
      const source = mid(PLAYGROUND_BASE + randInt(PLAYGROUND_COUNT));
      const day = randInt(DAY_COUNT);
      const path = walkDown(source, day);
      const sink = path[path.length - 1];
      if (sink !== source && !used.has(`${sink}|${day}`)) {
        batch.push({ assemblyId: sink, startDay: day, components: [source] });
        adversarial = true;
      }
      // Plus an unrelated legal revision that must vanish on rejection. It
      // must not touch any assembly on the walk path, or it could rewrite
      // the very edges the cycle relies on at `day`.
      const onPath = new Set(path);
      for (let tries = 0; tries < 10; tries++) {
        const legal = randomRevision();
        if (
          legal &&
          !onPath.has(legal.assemblyId) &&
          !batch.some((b) => b.assemblyId === legal.assemblyId && b.startDay === legal.startDay)
        ) {
          batch.push(legal);
          break;
        }
      }
    } else {
      const size = 1 + randInt(5);
      for (let k = 0; k < size; k++) {
        const rev = randomRevision();
        if (rev && !batch.some((b) => b.assemblyId === rev.assemblyId && b.startDay === rev.startDay)) {
          batch.push(rev);
        }
      }
    }
    if (batch.length === 0) continue;
    if (adversarial) adversarialAttempts++;

    const fast = service.publishBatch(batch);
    const slow = naive.publishBatch(batch);
    equal(fast.ok, slow.ok, `accept/reject mismatch in round ${round}: ${JSON.stringify(batch)}`);

    if (!fast.ok && !slow.ok) {
      rejects++;
      if (adversarial) adversarialRejects++;
      const finalLookup = bomAtFromRevisions(accepted.concat(batch));
      ok(verifyWitness(finalLookup, fast.witness), `fast witness invalid in round ${round}`);
      ok(verifyWitness(finalLookup, slow.witness), `naive witness invalid in round ${round}`);
    } else {
      accepts++;
      for (const rev of batch) {
        used.add(`${rev.assemblyId}|${rev.startDay}`);
        accepted.push(rev);
      }
    }

    // Post-publish queries must agree whether the batch was accepted or not.
    for (let q = 0; q < 8; q++) {
      const assembly =
        rng() < 0.5
          ? mid(PLAYGROUND_BASE + randInt(PLAYGROUND_COUNT))
          : mid(randInt(ASSEMBLY_COUNT));
      const day = randInt(DAY_COUNT + 1000);
      deepEqual(service.bomAt(assembly, day), naive.bomAt(assembly, day), `query mismatch round ${round}`);
    }
  }

  ok(accepts > 0, "expected some accepted batches");
  ok(adversarialAttempts >= 20, `too few adversarial attempts: ${adversarialAttempts}`);
  equal(
    adversarialRejects,
    adversarialAttempts,
    "every deliberately closed cycle must be rejected",
  );
  console.log(
    `  randomized cross-check: ${accepts} accepted, ${rejects} rejected ` +
      `(${adversarialRejects}/${adversarialAttempts} adversarial)`,
  );
});

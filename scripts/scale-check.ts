import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UptimeStore } from '../src/index.js';
import type { ProbeResult } from '../src/index.js';

const SITE_COUNT = 500;
const PROBE_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 95; // 5 days more than retention so cleanup has work to do
const QUERY_COUNT = 20;
const QUERY_BUDGET_MS = 5_000;
const MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

const START = 1_760_000_000_000; // fixed UTC base, deterministic run

function* siteProbes(siteIndex: number): Generator<ProbeResult> {
  const probesPerDay = DAY_MS / PROBE_INTERVAL_MS;
  const total = DAYS * probesPerDay;
  for (let j = 0; j < total; j += 1) {
    // Occasional collection gap -> unknown time.
    if ((j * 7 + siteIndex) % 211 === 0) {
      continue;
    }
    yield {
      siteId: `site-${siteIndex}`,
      finishedAt: START + j * PROBE_INTERVAL_MS,
      // Mostly online with deterministic offline bursts.
      online: (j + siteIndex * 13) % 97 >= 3,
    };
  }
}

function dbSize(dir: string): number {
  let size = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      size += statSync(join(dir, `uptime.db${suffix}`)).size;
    } catch {
      // file may not exist
    }
  }
  return size;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-scale-'));
  const dbPath = join(dir, 'uptime.db');
  try {
    const store = new UptimeStore(dbPath);

    // ---- Import phase (not timed against the budget) ----
    const importStart = performance.now();
    let imported = 0;
    for (let site = 0; site < SITE_COUNT; site += 1) {
      let count = 0;
      for (const probe of siteProbes(site)) {
        count += 1;
      }
      store.recordProbes(siteProbes(site));
      imported += count;
      if ((site + 1) % 50 === 0) {
        const elapsed = (performance.now() - importStart) / 1000;
        console.log(
          `imported ${site + 1}/${SITE_COUNT} sites ` +
            `(${imported} probes, ${elapsed.toFixed(1)}s)`,
        );
      }
    }
    const importSeconds = (performance.now() - importStart) / 1000;
    console.log(
      `import: ${imported} probes in ${importSeconds.toFixed(1)}s ` +
        `(${(imported / importSeconds).toFixed(0)}/s), db size ${mib(dbSize(dir))}`,
    );

    const now = START + DAYS * DAY_MS;
    store.cleanup(now);
    console.log(`cleanup done, db size ${mib(dbSize(dir))}`);

    // ---- Query phase (timed) ----
    const horizon = now - 90 * DAY_MS;
    const firstEnd = horizon + 30 * DAY_MS; // all windows inside retention
    const lastEnd = now - 1;
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    const queryStart = performance.now();
    for (let k = 0; k < QUERY_COUNT; k += 1) {
      const end = Math.floor(
        firstEnd + ((lastEnd - firstEnd) * k) / (QUERY_COUNT - 1),
      );
      const stats = store.getStats(end);
      if (stats.length !== SITE_COUNT) {
        throw new Error(`expected ${SITE_COUNT} sites, got ${stats.length}`);
      }
      for (const site of stats) {
        for (const [win, length] of [
          [site.hours24, DAY_MS],
          [site.days7, 7 * DAY_MS],
          [site.days30, 30 * DAY_MS],
        ] as const) {
          if (win.onlineMs + win.offlineMs + win.unknownMs !== length) {
            throw new Error(`window sum mismatch for ${site.siteId}`);
          }
        }
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const queryMs = performance.now() - queryStart;
    console.log(
      `queries: ${QUERY_COUNT} x ${SITE_COUNT} sites x 3 windows ` +
        `in ${queryMs.toFixed(0)}ms (budget ${QUERY_BUDGET_MS}ms)`,
    );
    console.log(
      `memory: rss before ${mib(rssBefore)}, peak during queries ${mib(peakRss)} ` +
        `(budget ${mib(MEMORY_BUDGET_BYTES)})`,
    );

    // ---- Persistence size stability across repeated cleanups ----
    store.recordProbes(
      (function* (): Generator<ProbeResult> {
        for (let site = 0; site < SITE_COUNT; site += 1) {
          for (let j = 0; j < 5 * (DAY_MS / PROBE_INTERVAL_MS); j += 1) {
            yield {
              siteId: `site-${site}`,
              finishedAt: now + j * PROBE_INTERVAL_MS,
              online: true,
            };
          }
        }
      })(),
    );
    const sizeBeforeSecondCleanup = dbSize(dir);
    store.cleanup(now + 5 * DAY_MS);
    const sizeAfterSecondCleanup = dbSize(dir);
    console.log(
      `size stability: before 2nd cleanup ${mib(sizeBeforeSecondCleanup)}, ` +
        `after ${mib(sizeAfterSecondCleanup)}`,
    );

    store.close();

    const failures: string[] = [];
    if (queryMs > QUERY_BUDGET_MS) {
      failures.push(`query time ${queryMs.toFixed(0)}ms exceeds ${QUERY_BUDGET_MS}ms`);
    }
    if (peakRss > MEMORY_BUDGET_BYTES) {
      failures.push(`peak rss ${mib(peakRss)} exceeds ${mib(MEMORY_BUDGET_BYTES)}`);
    }
    if (sizeAfterSecondCleanup > sizeBeforeSecondCleanup * 1.05) {
      failures.push('database grew after cleaning older history');
    }
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`FAIL: ${failure}`);
      }
      process.exitCode = 1;
    } else {
      console.log('scale check PASSED');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();

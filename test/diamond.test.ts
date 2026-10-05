import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CiScheduler } from '../src/index.ts';
import type { PipelineResult } from '../src/index.ts';
import { failStep, makeTmpDir, markerExists, markerStep, okStep } from './helpers.ts';

test('diamond: failed upstream blocks dependents, independent branch completes', async () => {
  const dir = makeTmpDir();
  const cMarker = join(dir, 'c-ran');
  const dMarker = join(dir, 'd-ran');

  const scheduler = new CiScheduler();
  const handle = scheduler.submitPipeline({
    services: [
      { name: 'A', steps: [okStep('build-a')] },
      { name: 'B', steps: [failStep('build-b')] },
      { name: 'C', steps: [markerStep('build-c', cMarker)] },
      { name: 'D', steps: [markerStep('build-d', dMarker)] },
    ],
    dependencies: { B: ['A'], C: ['A'], D: ['B', 'C'] },
    changedServices: ['A'],
    concurrency: 4,
    pipelineTimeoutMs: 10000,
  });

  const result: PipelineResult = await handle.result();

  assert.equal(result.status, 'failed');
  const svc = new Map(result.snapshot.services.map((s) => [s.name, s]));
  assert.equal(svc.get('A')!.status, 'succeeded');
  assert.equal(svc.get('B')!.status, 'failed');
  assert.equal(svc.get('C')!.status, 'succeeded', 'independent branch must complete');
  assert.equal(svc.get('D')!.status, 'blocked');

  // D's step never started.
  assert.equal(svc.get('D')!.steps[0]!.status, 'skipped');
  assert.equal(markerExists(dMarker), false, 'blocked service must not run');
  // Independent branch really executed.
  assert.equal(markerExists(cMarker), true);

  // B's failing step recorded its exit code; pipeline finished in a terminal state.
  assert.equal(svc.get('B')!.steps[0]!.exitCode, 1);
  assert.equal(result.snapshot.status, 'failed');
  assert.equal(result.snapshot.slotsInUse, 0);
});

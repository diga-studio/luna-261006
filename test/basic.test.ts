import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CiScheduler } from '../src/index.ts';
import { makeTmpDir, markerExists, markerStep, okStep } from './helpers.ts';

test('all-green pipeline succeeds and reports per-step status', async () => {
  const dir = makeTmpDir();
  const scheduler = new CiScheduler();
  const handle = scheduler.submitPipeline({
    services: [
      { name: 'A', steps: [okStep('a1'), markerStep('a2', join(dir, 'a2'))] },
      { name: 'B', steps: [okStep('b1')] },
    ],
    dependencies: { B: ['A'] },
    changedServices: ['A'],
    concurrency: 2,
    pipelineTimeoutMs: 5000,
  });
  const result = await handle.result();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.snapshot.slotsInUse, 0);
  const svc = new Map(result.snapshot.services.map((s) => [s.name, s]));
  assert.equal(svc.get('A')!.steps[0]!.exitCode, 0);
  assert.equal(svc.get('B')!.status, 'succeeded');
  assert.ok(result.finishedAt >= result.startedAt);
});

test('out-of-scope dependencies are not executed; scope is changed + dependents', async () => {
  const dir = makeTmpDir();
  const aMarker = join(dir, 'a-ran');
  const scheduler = new CiScheduler();
  const handle = scheduler.submitPipeline({
    services: [
      { name: 'A', steps: [markerStep('a1', aMarker)] },
      { name: 'B', steps: [okStep('b1')] },
      { name: 'C', steps: [okStep('c1')] },
    ],
    dependencies: { B: ['A'], C: ['B'] },
    changedServices: ['B'],
    concurrency: 2,
    pipelineTimeoutMs: 5000,
  });
  const result = await handle.result();
  assert.equal(result.status, 'succeeded');
  const svc = new Map(result.snapshot.services.map((s) => [s.name, s]));
  assert.equal(svc.get('A')!.status, 'out-of-scope');
  assert.equal(svc.get('A')!.inScope, false);
  assert.equal(markerExists(aMarker), false, 'out-of-scope service must not execute');
  assert.equal(svc.get('B')!.status, 'succeeded');
  assert.equal(svc.get('C')!.status, 'succeeded', 'transitive dependent is in scope');
});

test('spawn failure fails the service and blocks dependents', async () => {
  const scheduler = new CiScheduler();
  const handle = scheduler.submitPipeline({
    services: [
      { name: 'A', steps: [{ name: 'a1', command: 'definitely-not-a-real-command-xyz', timeoutMs: 1000 }] },
      { name: 'B', steps: [okStep('b1')] },
    ],
    dependencies: { B: ['A'] },
    changedServices: ['A'],
    concurrency: 2,
    pipelineTimeoutMs: 5000,
  });
  const result = await handle.result();
  assert.equal(result.status, 'failed');
  const svc = new Map(result.snapshot.services.map((s) => [s.name, s]));
  assert.equal(svc.get('A')!.steps[0]!.status, 'failed');
  assert.equal(svc.get('B')!.status, 'blocked');
  assert.equal(result.snapshot.slotsInUse, 0);
});

test('invalid requests are rejected', async () => {
  const scheduler = new CiScheduler();
  const base = {
    services: [{ name: 'A', steps: [okStep('a1')] }],
    dependencies: {},
    changedServices: ['A'],
    concurrency: 1,
    pipelineTimeoutMs: 1000,
  };
  assert.throws(() => scheduler.submitPipeline({ ...base, changedServices: ['nope'] }));
  assert.throws(() => scheduler.submitPipeline({ ...base, concurrency: 0 }));
  assert.throws(() => scheduler.submitPipeline({ ...base, pipelineTimeoutMs: 0 }));
  assert.throws(() =>
    scheduler.submitPipeline({
      ...base,
      services: [
        { name: 'A', steps: [okStep('a1')] },
        { name: 'B', steps: [okStep('b1')] },
      ],
      dependencies: { A: ['B'], B: ['A'] },
      changedServices: ['A'],
    }),
  );
});

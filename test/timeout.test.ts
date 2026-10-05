import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CiScheduler } from '../src/index.ts';
import type { ProcessRunner, SpawnedProcess } from '../src/index.ts';
import { NodeProcessRunner } from '../src/index.ts';
import {
  delay,
  makeTmpDir,
  markerExists,
  markerStep,
  markerTime,
  okStep,
  sleepStep,
  stubbornStep,
} from './helpers.ts';

class CountingRunner implements ProcessRunner {
  private inner = new NodeProcessRunner();
  spawns = 0;
  exits = 0;
  killSignals: string[] = [];

  get live(): number {
    return this.spawns - this.exits;
  }

  spawn(command: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }): SpawnedProcess {
    this.spawns++;
    const proc = this.inner.spawn(command, args, opts);
    return {
      get pid() {
        return proc.pid;
      },
      onExit: (cb) => proc.onExit((code, signal) => {
        this.exits++;
        cb(code, signal);
      }),
      onStartError: (cb) => proc.onStartError(cb),
      kill: (signal) => {
        this.killSignals.push(signal);
        proc.kill(signal);
      },
    };
  }
}

test('step timeout meets pipeline timeout: no new starts, kill waits for real exit, terminal states immutable', async () => {
  const dir = makeTmpDir();
  const stubbornMarker = join(dir, 'stubborn-exited'); // written by the process itself on exit
  const cStep2Marker = join(dir, 'c-step2-ran');
  const dMarker = join(dir, 'd-ran');

  const runner = new CountingRunner();
  const scheduler = new CiScheduler({ runner });

  const handle = scheduler.submitPipeline({
    services: [
      {
        name: 'A',
        steps: [okStep('a1'), sleepStep('a2', 30_000, 150)],
      },
      { name: 'B', steps: [markerStep('b1', join(dir, 'b-ran'))] },
      {
        name: 'C',
        steps: [stubbornStep('c1', stubbornMarker, 800, 30_000), markerStep('c2', cStep2Marker)],
      },
      { name: 'D', steps: [markerStep('d1', dMarker)] },
    ],
    dependencies: { B: ['A'], D: ['C'] },
    changedServices: ['A', 'C'],
    concurrency: 4,
    pipelineTimeoutMs: 400,
    killGraceMs: 10_000, // no SIGKILL before the stubborn process exits on its own
  });

  let settled = false;
  const resultPromise = handle.result().then((r) => {
    settled = true;
    return r;
  });

  // After the pipeline deadline (400ms) but before the stubborn process
  // actually exits (~800ms): pipeline must NOT report completion.
  await delay(600);
  assert.equal(settled, false, 'must wait for actual process exit after pipeline timeout');
  assert.equal(markerExists(stubbornMarker), false, 'stubborn process should still be running');
  assert.equal(handle.snapshot().slotsInUse > 0, true, 'slot stays held until real exit');

  const result = await resultPromise;

  // Any timeout => pipeline result is timeout.
  assert.equal(result.status, 'timeout');

  const svc = new Map(result.snapshot.services.map((s) => [s.name, s]));
  // Step timeout path: A failed, its dependent B blocked.
  assert.equal(svc.get('A')!.steps[1]!.status, 'timeout');
  assert.equal(svc.get('A')!.status, 'failed');
  assert.equal(svc.get('B')!.status, 'blocked');
  assert.equal(markerExists(join(dir, 'b-ran')), false);

  // Pipeline timeout path: running step cancelled, everything unstarted cancelled.
  assert.equal(svc.get('C')!.steps[0]!.status, 'cancelled');
  assert.equal(svc.get('C')!.steps[1]!.status, 'cancelled');
  assert.equal(svc.get('C')!.status, 'cancelled');
  assert.equal(svc.get('D')!.status, 'cancelled');

  // After the total deadline, unstarted steps never started.
  assert.equal(markerExists(cStep2Marker), false, 'step after deadline must not start');
  assert.equal(markerExists(dMarker), false, 'downstream of cancelled service must not start');

  // Completion was reported only after the stubborn process really exited.
  assert.equal(markerExists(stubbornMarker), true);
  assert.ok(
    result.finishedAt >= markerTime(stubbornMarker),
    'pipeline completion must not precede actual process exit',
  );

  // Late exit (code 0) did not rewrite terminal states.
  assert.equal(svc.get('C')!.steps[0]!.exitCode, null);
  assert.equal(svc.get('C')!.steps[0]!.status, 'cancelled');

  // No leftover build processes; every slot returned exactly once.
  assert.equal(runner.live, 0, 'no leftover build processes');
  assert.equal(runner.spawns, runner.exits);
  assert.equal(result.snapshot.slotsInUse, 0);
  assert.ok(runner.killSignals.includes('SIGTERM'));
  assert.equal(runner.killSignals.includes('SIGKILL'), false, 'no escalation needed before natural exit');

  // Snapshot stays stable after completion.
  await delay(50);
  assert.equal(handle.snapshot().status, 'timeout');
  assert.equal(handle.snapshot().slotsInUse, 0);
});

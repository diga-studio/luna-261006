import assert from "node:assert/strict";
import test from "node:test";
import { LocalDock } from "../src/index";
import { FakeFactory, settle } from "./helpers";

test("overlapping deploys: later one fails first, earlier ready later must not take over", async () => {
  const dock = new LocalDock();

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyReady();
  assert.equal((await dA.result).kind, "active");

  const fB = new FakeFactory();
  const dB = dock.deploy("svc", { v: 2 }, fB.factory);
  const fC = new FakeFactory();
  const dC = dock.deploy("svc", { v: 3 }, fC.factory);

  assert.equal((await dB.result).kind, "superseded");
  await settle();
  assert.equal(fB.last.terminateCalls, 1);

  fC.last.context.notifyFailed(new Error("bad config"));
  assert.equal((await dC.result).kind, "failed");
  await settle();
  assert.equal(fC.last.terminateCalls, 1);

  fB.last.context.notifyReady();
  fB.last.context.notifyReady();
  await settle();

  const status = dock.status("svc");
  assert.equal(status.serving, true);
  assert.equal(status.active?.deploymentId, dA.id);

  const p = dock.submit("svc", "req");
  assert.equal(fA.last.requests.length, 1);
  fA.last.requests[0]!.deferred.resolve("ok");
  assert.equal(await p, "ok");

  assert.equal(fA.last.terminateCalls, 0);
  assert.equal(fB.last.terminateCalls, 1);
  assert.equal(fC.last.terminateCalls, 1);
});

test("stop interleaved with late notifications and a subsequent deploy", async () => {
  const dock = new LocalDock();

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyReady();
  await dA.result;

  const p1 = dock.submit("svc", "r1");

  const fB = new FakeFactory();
  const dB = dock.deploy("svc", { v: 2 }, fB.factory);

  let stopped = false;
  const stopPromise = dock.stop("svc").then(() => {
    stopped = true;
  });

  assert.equal(dock.status("svc").serving, false);
  await assert.rejects(dock.submit("svc", "r2"));
  assert.equal((await dB.result).kind, "stopped");
  await settle();
  assert.equal(fB.last.terminateCalls, 1);

  await settle();
  assert.equal(stopped, false);
  assert.equal(fA.last.terminateCalls, 0);

  const fC = new FakeFactory();
  const dC = dock.deploy("svc", { v: 3 }, fC.factory);
  fC.last.context.notifyReady();
  assert.equal((await dC.result).kind, "active");
  assert.equal(dock.status("svc").active?.deploymentId, dC.id);

  fB.last.context.notifyReady();
  fB.last.context.notifyExited(new Error("late exit"));
  fA.last.context.notifyReady();
  await settle();
  assert.equal(dock.status("svc").active?.deploymentId, dC.id);
  assert.equal(fC.last.terminateCalls, 0);

  fA.last.requests[0]!.deferred.resolve("done-r1");
  assert.equal(await p1, "done-r1");
  await stopPromise;
  assert.equal(stopped, true);
  await settle();
  assert.equal(fA.last.terminateCalls, 1);

  fB.last.context.notifyExited(new Error("later exit"));
  fA.last.context.notifyExited(new Error("later exit"));
  await settle();
  assert.equal(fA.last.terminateCalls, 1);
  assert.equal(fB.last.terminateCalls, 1);
  assert.equal(fC.last.terminateCalls, 0);

  const status = dock.status("svc");
  assert.equal(status.serving, true);
  assert.equal(status.active?.deploymentId, dC.id);

  const p2 = dock.submit("svc", "r3");
  assert.equal(fC.last.requests.length, 1);
  fC.last.requests[0]!.deferred.resolve("ok-r3");
  assert.equal(await p2, "ok-r3");
});

test("hot swap: inflight requests finish on old version, new requests go to new", async () => {
  const dock = new LocalDock();

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyReady();
  await dA.result;

  const p1 = dock.submit("svc", "r1");

  const fB = new FakeFactory();
  const dB = dock.deploy("svc", { v: 2 }, fB.factory);
  fB.last.context.notifyReady();
  assert.equal((await dB.result).kind, "active");

  const p2 = dock.submit("svc", "r2");
  assert.equal(fA.last.requests.length, 1);
  assert.equal(fB.last.requests.length, 1);

  await settle();
  assert.equal(fA.last.terminateCalls, 0);

  fA.last.requests[0]!.deferred.resolve("old");
  assert.equal(await p1, "old");
  await settle();
  assert.equal(fA.last.terminateCalls, 1);

  fB.last.requests[0]!.deferred.resolve("new");
  assert.equal(await p2, "new");

  const status = dock.status("svc");
  assert.equal(status.active?.deploymentId, dB.id);
  assert.equal(status.active?.inflight, 0);
});

test("unexpected exit of active version fails only its requests, no fallback", async () => {
  const dock = new LocalDock();

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyReady();
  await dA.result;

  const p1 = dock.submit("svc", "r1");

  const fB = new FakeFactory();
  const dB = dock.deploy("svc", { v: 2 }, fB.factory);
  fB.last.context.notifyReady();
  await dB.result;

  const p2 = dock.submit("svc", "r2");
  fB.last.context.notifyExited(new Error("crash"));
  fB.last.context.notifyExited(new Error("crash again"));
  await assert.rejects(p2, /crash/);

  const status = dock.status("svc");
  assert.equal(status.serving, false);
  assert.equal(status.active, undefined);
  await assert.rejects(dock.submit("svc", "r3"), /unavailable/);

  fA.last.requests[0]!.deferred.resolve("old");
  assert.equal(await p1, "old");
  await settle();
  assert.equal(fA.last.terminateCalls, 1);
  assert.equal(fB.last.terminateCalls, 0);
});

test("unexpected exit of a draining version does not disturb the active one", async () => {
  const dock = new LocalDock();

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyReady();
  await dA.result;

  const p1 = dock.submit("svc", "r1");

  const fB = new FakeFactory();
  const dB = dock.deploy("svc", { v: 2 }, fB.factory);
  fB.last.context.notifyReady();
  await dB.result;

  fA.last.context.notifyExited(new Error("old crashed"));
  await assert.rejects(p1, /old crashed/);

  const status = dock.status("svc");
  assert.equal(status.serving, true);
  assert.equal(status.active?.deploymentId, dB.id);

  const p2 = dock.submit("svc", "r2");
  fB.last.requests[0]!.deferred.resolve("new");
  assert.equal(await p2, "new");

  await settle();
  assert.equal(fA.last.terminateCalls, 0);
  assert.equal(fB.last.terminateCalls, 0);
});

test("submit without a serving version fails immediately", async () => {
  const dock = new LocalDock();
  await assert.rejects(dock.submit("svc", "r1"), /unavailable/);

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyFailed(new Error("nope"));
  assert.equal((await dA.result).kind, "failed");
  await assert.rejects(dock.submit("svc", "r2"), /unavailable/);
  assert.equal(dock.status("svc").serving, false);
});

test("stop is idempotent and terminates every unit at most once", async () => {
  const dock = new LocalDock();

  const fA = new FakeFactory();
  const dA = dock.deploy("svc", { v: 1 }, fA.factory);
  fA.last.context.notifyReady();
  await dA.result;

  const fB = new FakeFactory();
  const dB = dock.deploy("svc", { v: 2 }, fB.factory);
  fB.last.context.notifyReady();
  await dB.result;

  await settle();
  assert.equal(fA.last.terminateCalls, 1);

  await Promise.all([dock.stop("svc"), dock.stop("svc")]);
  await settle();
  assert.equal(fA.last.terminateCalls, 1);
  assert.equal(fB.last.terminateCalls, 1);
  assert.equal(dock.status("svc").serving, false);
  await assert.rejects(dock.submit("svc", "r1"), /unavailable/);
});

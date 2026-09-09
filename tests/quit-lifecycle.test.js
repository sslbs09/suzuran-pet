"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createQuitLifecycle, runCleanupSteps } = require("../src/quit-lifecycle");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("before-quit blocks until one cleanup finishes, then allows the续退", async () => {
  let done = false;
  let quitting = false;
  let cleanupCalls = 0;
  let preventCalls = 0;
  let quitCalls = 0;
  let finishCleanup;
  const cleanupFinished = new Promise((resolve) => { finishCleanup = resolve; });
  const lifecycle = createQuitLifecycle({
    isCleanupDone: () => done,
    isCleanupStarted: () => lifecycleStarted,
    markCleanupStarted: () => { lifecycleStarted = true; },
    onStart: () => { quitting = true; },
    cleanup: async () => { cleanupCalls += 1; await cleanupFinished; },
    setCleanupDone: () => { done = true; },
    requestQuit: () => { quitCalls += 1; },
  });
  let lifecycleStarted = false;
  const event = { preventDefault: () => { preventCalls += 1; } };

  lifecycle.beforeQuit(event);
  lifecycle.beforeQuit(event);
  assert.equal(preventCalls, 2);
  assert.equal(cleanupCalls, 0);
  assert.equal(quitting, true);
  await nextTurn();
  assert.equal(cleanupCalls, 1);
  finishCleanup();
  await nextTurn();
  await nextTurn();
  assert.equal(done, true);
  assert.equal(quitCalls, 1);

  lifecycle.beforeQuit(event);
  assert.equal(preventCalls, 2);
  assert.equal(quitCalls, 1);
});

test("cleanup steps isolate sync throws and async rejects", async () => {
  const steps = [];
  const errors = [];
  const results = await runCleanupSteps([
    { name: "sync", run: () => { steps.push("sync"); throw new Error("sync failed"); } },
    { name: "async", run: async () => { steps.push("async"); throw new Error("async failed"); } },
    { name: "after", run: () => { steps.push("after"); } },
  ], { onError: (error, name) => errors.push(name + ":" + error.message) });

  assert.deepEqual(steps, ["sync", "async", "after"]);
  assert.deepEqual(errors, ["sync:sync failed", "async:async failed"]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "fulfilled"]);
});

test("a timed-out promise does not prevent later steps or trigger a second quit", async () => {
  let resolveLate;
  let rejectLate;
  let done = false;
  let cleanupCalls = 0;
  let quitCalls = 0;
  let lifecycleStarted = false;
  const latePromise = new Promise((resolve, reject) => {
    resolveLate = resolve;
    rejectLate = reject;
  });
  const lifecycle = createQuitLifecycle({
    isCleanupDone: () => done,
    isCleanupStarted: () => lifecycleStarted,
    markCleanupStarted: () => { lifecycleStarted = true; },
    cleanup: () => {
      cleanupCalls += 1;
      return runCleanupSteps([
        { name: "hung", run: () => latePromise, timeoutMs: 5 },
        { name: "after timeout", run: () => {} },
      ]);
    },
    setCleanupDone: () => { done = true; },
    requestQuit: () => { quitCalls += 1; },
  });
  const event = { preventDefault: () => {} };

  lifecycle.beforeQuit(event);
  lifecycle.beforeQuit(event);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await nextTurn();
  assert.equal(cleanupCalls, 1);
  assert.equal(done, true);
  assert.equal(quitCalls, 1);

  rejectLate(new Error("late failure"));
  resolveLate();
  await nextTurn();
  assert.equal(quitCalls, 1);
});

test("an already-true quitting intent still starts cleanup", async () => {
  let done = false;
  let quitting = true;
  let started = 0;
  let quitCalls = 0;
  let lifecycleStarted = false;
  const lifecycle = createQuitLifecycle({
    isCleanupDone: () => done,
    isCleanupStarted: () => lifecycleStarted,
    markCleanupStarted: () => { lifecycleStarted = true; },
    onStart: () => { quitting = true; started += 1; },
    cleanup: () => Promise.resolve(),
    setCleanupDone: () => { done = true; },
    requestQuit: () => { quitCalls += 1; },
  });

  lifecycle.beforeQuit({ preventDefault: () => {} });
  await nextTurn();
  await nextTurn();
  assert.equal(quitting, true);
  assert.equal(started, 1);
  assert.equal(done, true);
  assert.equal(quitCalls, 1);
});

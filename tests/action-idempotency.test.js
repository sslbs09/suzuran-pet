"use strict";

/*
 * M2 Foundation：action-idempotency.js 运行期有界幂等存储单测。
 * 运行：node --test tests/action-idempotency.test.js
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { createIntentIdempotencyStore, DEFAULT_MAX_ENTRIES } = require("../src/action-idempotency.js");

test("T-I1: unseen intentId classifies as new; recording makes same-fingerprint a duplicate", () => {
  const store = createIntentIdempotencyStore();
  assert.equal(store.classify("i-1", "fp-a"), "new");
  store.record("i-1", "fp-a", { result: "accepted", actionType: "speak" });
  assert.equal(store.classify("i-1", "fp-a"), "duplicate", "same identity + same semantics = replay");
});

test("T-I2: same intentId with a different payload fingerprint is a conflict, never a new action", () => {
  const store = createIntentIdempotencyStore();
  store.record("i-1", "fp-a", { result: "accepted", actionType: "speak" });
  assert.equal(store.classify("i-1", "fp-b"), "conflict");
  const entry = store.lookup("i-1");
  assert.equal(entry.fingerprint, "fp-a", "a conflicting reuse must not overwrite the admitted record");
});

test("T-I3: different intentIds with identical payloads are different Intents (text dedup is NOT intent idempotency)", () => {
  const store = createIntentIdempotencyStore();
  store.record("i-1", "fp-x", { result: "accepted", actionType: "speak" });
  assert.equal(store.classify("i-2", "fp-x"), "new", "a fresh intentId is always a fresh action");
});

test("T-I4: the window is bounded - oldest entries fall out FIFO and the store never grows unbounded", () => {
  const store = createIntentIdempotencyStore({ maxEntries: 3 });
  store.record("a", "fa", { result: "accepted" });
  store.record("b", "fb", { result: "accepted" });
  store.record("c", "fc", { result: "accepted" });
  store.record("d", "fd", { result: "accepted" });
  assert.equal(store.size(), 3, "bounded to maxEntries");
  assert.equal(store.classify("a", "fa"), "new", "the evicted window is an honest limitation, not a fake memory");
  assert.equal(store.classify("d", "fd"), "duplicate");
  assert.equal(typeof DEFAULT_MAX_ENTRIES, "number");
});

test("T-I5: lookup answers admission for interrupt; re-recording the same id refreshes its slot", () => {
  const store = createIntentIdempotencyStore({ maxEntries: 3 });
  assert.equal(store.lookup("ghost"), undefined, "not admitted -> not found");
  store.record("x", "f1", { result: "accepted", actionType: "speak" });
  store.record("x", "f2", { result: "rejected", actionType: "speak" });
  assert.equal(store.size(), 1, "same id re-recorded occupies one slot");
  assert.deepEqual(store.lookup("x"), { fingerprint: "f2", result: "rejected", actionType: "speak" });
  const y = "y";
  store.record("y", "fy", { result: "accepted", actionType: "speak" });
  assert.equal(store.lookup(y).result, "accepted");
});

test("T-I6: reset clears the window (test isolation hook, no persistence anywhere)", () => {
  const store = createIntentIdempotencyStore();
  store.record("i", "f", { result: "accepted" });
  store.reset();
  assert.equal(store.size(), 0);
  assert.equal(store.classify("i", "f"), "new");
});

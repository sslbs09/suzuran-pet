"use strict";

/*
 * M2 Foundation：body-capabilities.js 能力真实声明单测。
 * 运行：node --test tests/body-capabilities.test.js
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PROTOCOL_VERSION,
  BODY_IMPLEMENTATION_ID,
  buildBodyCapabilities,
  findSupportedAction
} = require("../src/body-capabilities.js");

test("T-C1: the descriptor shape is exactly the frozen v1 contract", () => {
  const caps = buildBodyCapabilities();
  assert.deepEqual(Object.keys(caps), ["protocolVersion", "bodyImplementationId", "supportedActions"]);
  assert.equal(caps.protocolVersion, 1);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(caps.supportedActions, [
    { type: "speak", feedbackMode: "ack-only", interruptible: false, idempotency: "supported" }
  ]);
});

test("T-C2: speak truth is honestly ack-only and non-interruptible (no fabricated completion/interrupt)", () => {
  const speak = findSupportedAction(buildBodyCapabilities(), "speak");
  assert.equal(speak.feedbackMode, "ack-only", "dispatch is the strongest fact this body can evidence for speak");
  assert.equal(speak.interruptible, false, "no per-utterance stop channel exists in the main process - declare the truth");
  assert.equal(speak.idempotency, "supported", "intentId-level replay protection is provided by the action store");
});

test("T-C3: bodyImplementationId is a BODY-IMPLEMENTATION identity, never a Character identity", () => {
  assert.equal(typeof BODY_IMPLEMENTATION_ID, "string");
  assert.ok(BODY_IMPLEMENTATION_ID.includes("v"), "versioned implementation identity");
  // Character-instance-shaped ids (uuid-like) or Core instance ids must never appear.
  assert.equal(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(BODY_IMPLEMENTATION_ID), false,
    "not a uuid: Character Instance IDs belong to Core, not to a capability declaration");
  assert.equal(/sussurro-[a-z0-9-]+/i.test(JSON.stringify(buildBodyCapabilities())), false,
    "no Character instance identity anywhere in the descriptor");
  // The descriptor never cites the character package / instance / experience domains.
  for (const banned of ["character", "instance", "experience", "relationship"]) {
    assert.equal(JSON.stringify(buildBodyCapabilities()).toLowerCase().includes(banned), false,
      `capability is body-implementation truth only: no "${banned}"`);
  }
});

test("T-C4: undeclared action types have no capability entry (the honest unsupported basis)", () => {
  const caps = buildBodyCapabilities();
  assert.equal(findSupportedAction(caps, "walk"), undefined);
  assert.equal(findSupportedAction(caps, "controlled-test-action"), undefined,
    "this Sussurro build does not fake fixture actions into its own truth");
  // Deterministic and side-effect free: same call, same value.
  assert.deepEqual(caps, buildBodyCapabilities());
});

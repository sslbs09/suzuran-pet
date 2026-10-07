"use strict";

/*
 * M2 Foundation：action-protocol.js 纯校验/指纹单测（无 HTTP、无 Electron）。
 * 运行：node --test tests/action-protocol.test.js
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const actionProtocol = require("../src/action-protocol.js");

test("T-A1: a well-formed Action Request validates and normalizes to {intentId, actionType, payload}", () => {
  const r = actionProtocol.validateActionRequest({
    protocolVersion: 1,
    intentId: " 11111111-2222-3333-4444-555555555555 ",
    actionType: " speak ",
    payload: { text: "博士" }
  });
  assert.equal(r.ok, true);
  assert.equal(r.intentId, "11111111-2222-3333-4444-555555555555", "identity fields are trimmed");
  assert.equal(r.actionType, "speak");
  assert.deepEqual(r.payload, { text: "博士" }, "payload passes through untouched");
});

test("T-A2: protocolVersion is version 1 only - missing or any other value is refused", () => {
  for (const missing of [undefined, null]) {
    const r = actionProtocol.validateActionRequest({ protocolVersion: missing, intentId: "i", actionType: "speak", payload: {} });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing-protocol-version");
  }
  const absent = actionProtocol.validateActionRequest({ intentId: "i", actionType: "speak", payload: {} });
  assert.equal(absent.reason, "missing-protocol-version");
  for (const bad of [2, "1", 0, 1.5, true]) {
    const r = actionProtocol.validateActionRequest({ protocolVersion: bad, intentId: "i", actionType: "speak", payload: {} });
    assert.equal(r.ok, false, `protocolVersion ${JSON.stringify(bad)} must be refused`);
    assert.equal(r.reason, "unsupported-protocol-version");
  }
});

test("T-A3: intentId/actionType shape rules are enforced honestly", () => {
  for (const bad of ["", "   ", 123, {}, null, undefined]) {
    const r = actionProtocol.validateActionRequest({ protocolVersion: 1, intentId: bad, actionType: "speak", payload: {} });
    assert.equal(r.ok, false, `intentId ${JSON.stringify(bad)} refused`);
    assert.equal(r.reason, "missing-intent-id");
  }
  const tooLong = actionProtocol.validateActionRequest({ protocolVersion: 1, intentId: "x".repeat(129), actionType: "speak", payload: {} });
  assert.equal(tooLong.ok, false);
  for (const bad of ["", 0, [], undefined]) {
    const r = actionProtocol.validateActionRequest({ protocolVersion: 1, intentId: "i", actionType: bad, payload: {} });
    assert.equal(r.ok, false, `actionType ${JSON.stringify(bad)} refused`);
    assert.equal(r.reason, "missing-action-type");
  }
});

test("T-A4: payload must be a plain JSON object (opaque at protocol level)", () => {
  const absent = actionProtocol.validateActionRequest({ protocolVersion: 1, intentId: "i", actionType: "speak" });
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.payload, {}, "an absent payload normalizes to {}");
  for (const bad of [[], "text", 7, null]) {
    const r = actionProtocol.validateActionRequest({ protocolVersion: 1, intentId: "i", actionType: "speak", payload: bad });
    assert.equal(r.ok, false, `payload ${JSON.stringify(bad)} refused`);
    assert.equal(r.reason, "invalid-payload");
  }
});

test("T-A5: fingerprint is stable, key-order-insensitive, and content-sensitive", () => {
  const a = actionProtocol.payloadFingerprint({ text: "x", emotion: "happy", nested: { p: 1, q: [2, 3] } });
  const b = actionProtocol.payloadFingerprint({ nested: { q: [2, 3], p: 1 }, emotion: "happy", text: "x" });
  assert.equal(a, b, "same semantic content -> same fingerprint regardless of key order");
  const c = actionProtocol.payloadFingerprint({ text: "x", emotion: "sad", nested: { p: 1, q: [2, 3] } });
  assert.notEqual(a, c, "different content -> different fingerprint");
  assert.match(a, /^[0-9a-f]{64}$/, "fingerprint is a sha256 hex");
});

test("T-A6: interrupt envelope carries protocolVersion only; malformed refusals are structured, never thrown", () => {
  assert.deepEqual(actionProtocol.validateInterruptRequest({ protocolVersion: 1 }), { ok: true });
  assert.equal(actionProtocol.validateInterruptRequest({}).reason, "missing-protocol-version");
  assert.equal(actionProtocol.validateInterruptRequest({ protocolVersion: 2 }).reason, "unsupported-protocol-version");
  assert.equal(actionProtocol.validateInterruptRequest("nope").ok, false);
  let threw = false;
  try { actionProtocol.validateActionRequest(null); } catch { threw = true; }
  assert.equal(threw, false, "ordinary malformed input must return {ok:false}, never throw");
});

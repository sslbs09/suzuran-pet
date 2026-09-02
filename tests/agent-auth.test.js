"use strict";
const assert = require("assert");
const { hashToken, safeTokenEqual, tokenMatches, sanitizeClients } = require("../src/agent-auth");

const token = "agent-token-123";
const hash = hashToken(token);
assert.match(hash, /^[a-f0-9]{64}$/);
assert.strictEqual(safeTokenEqual(token, token), true);
assert.strictEqual(safeTokenEqual(token, "other-token"), false);
assert.strictEqual(tokenMatches(token, { tokenHash: hash }), true);
assert.strictEqual(tokenMatches("wrong", { tokenHash: hash }), false);
assert.strictEqual(tokenMatches(token, { token }), true);

const clients = sanitizeClients([
  { name: "legacy", token, grantedAt: 10, lastSeen: 20 },
  { name: "hashed", tokenHash: hash, grantedAt: 30, lastSeen: 40 },
  { name: "invalid" },
]);
assert.strictEqual(clients.length, 2);
assert.strictEqual(clients[0].token, undefined);
assert.strictEqual(clients[0].tokenHash, hash);
assert.strictEqual(clients[1].tokenHash, hash);
console.log("agent-auth 全部通过 ✅");

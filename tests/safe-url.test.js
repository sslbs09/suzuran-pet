"use strict";
const assert = require("assert");
const { parseHttpUrl, validateHttpUrl, isPrivateOrReservedIp, isLoopbackHost } = require("../src/safe-url");

assert.strictEqual(parseHttpUrl("https://example.com/v1").protocol, "https:");
assert.throws(() => parseHttpUrl("file:///C:/secret"), /http/);
assert.throws(() => parseHttpUrl("javascript:alert(1)"), /http/);
assert.throws(() => validateHttpUrl("http://127.0.0.1:11434"), /私有|保留/);
assert.strictEqual(validateHttpUrl("http://127.0.0.1:11434", { allowLoopback: true }).hostname, "127.0.0.1");
assert.strictEqual(isLoopbackHost("localhost"), true);
assert.strictEqual(isPrivateOrReservedIp("192.168.1.10"), true);
assert.strictEqual(isPrivateOrReservedIp("8.8.8.8"), false);
console.log("safe-url 全部通过 ✅");

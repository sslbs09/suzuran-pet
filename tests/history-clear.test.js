"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-history-"));
process.env.SUZURAN_TEST_USERDIR = dir;
const history = require("../src/history");
history.append({ mode: "chat", role: "user", content: "should be removed" });
assert.strictEqual(history.load().length, 1);
assert.strictEqual(history.clear(), true);
assert.deepStrictEqual(history.load(), []);
assert.strictEqual(fs.readFileSync(path.join(dir, "history", "history.jsonl"), "utf8"), "");
fs.rmSync(dir, { recursive: true, force: true });
console.log("history clear 全部通过 ✅");

"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../src/storage"), "utf8");
// Execute the complete production module against real, isolated filesystem paths.
// The install template is true in every case; no repository template is changed.
function scenario(shape, marker, expected) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-consent-source-"));
  const appDir = path.join(root, "app"), userDir = path.join(root, "user");
  try {
    fs.mkdirSync(appDir); fs.mkdirSync(userDir);
    fs.writeFileSync(path.join(appDir, "config.json"), JSON.stringify({ agreed: true, firstRun: true }));
    const target = path.join(userDir, "config.json");
    if (shape === "file") fs.writeFileSync(target, JSON.stringify({ agreed: true, firstRun: false, custom: "keep" }));
    if (shape === "directory") fs.mkdirSync(target);
    if (marker) fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}");
    const context = { module: { exports: {} }, __dirname: path.join(appDir, "src"),
      process: { env: { SUZURAN_TEST_USERDIR: userDir } },
      require(name) { if (name === "electron") return {}; if (name === "fs") return fs;
        if (name === "path") return path; throw new Error("unexpected import: " + name); } };
    vm.runInNewContext(source, context, { filename: "src/storage.js" });
    context.module.exports.initializeStorage();
    assert.equal(fs.statSync(target).isFile(), true);
    const result = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(result.agreed, expected);
    if (shape === "file") assert.equal(result.custom, "keep");
    assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, "config.json"), "utf8")).agreed, true);
    assert.equal(fs.existsSync(path.join(userDir, ".storage-migration-v1.json")), true);
    context.module.exports.initializeStorage();
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).agreed, expected, "second initialization preserves outcome");
  } finally {
    const resolved = path.resolve(root), tempPrefix = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(tempPrefix) && path.basename(resolved).startsWith("suzuran-consent-source-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
test("production storage preserves old real accepted file without marker", () => scenario("file", false, true));
test("production storage clears true copied from template into missing config", () => scenario("missing", false, false));
test("production storage clears true after empty-directory self-heal without marker", () => scenario("directory", false, false));
test("production storage clears true after recovery even with existing marker", () => scenario("directory", true, false));

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-config-consent-"));
process.env.SUZURAN_TEST_USERDIR = userDir;
fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}", "utf8");
const config = require("../src/config");

try {
  for (const value of [false, null, "false", "true", 0, 1, {}, []]) {
    fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ agreed: value }), "utf8");
    config.getConfig(true);
    assert.equal(config.buildSettingsView().agreed, false,
      "settings snapshot normalizes invalid consent to false: " + String(value));
  }
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify({ agreed: true }), "utf8");
  config.getConfig(true);
  assert.equal(config.buildSettingsView().agreed, true, "settings snapshot preserves literal true");
} finally {
  fs.rmSync(userDir, { recursive: true, force: true });
}

console.log("config consent snapshot 全部通过 ✅");

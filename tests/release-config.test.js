"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoDir = path.join(__dirname, "..");
const templatePath = path.join(repoDir, "deploy", "config.template.json");
const rootConfigPath = path.join(repoDir, "config.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectStrings(value, currentPath = "", out = []) {
  if (typeof value === "string") {
    out.push({ path: currentPath, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, currentPath + "[" + index + "]", out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, currentPath ? currentPath + "." + key : key, out);
    }
  }
  return out;
}

function isForbiddenAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /[\\/]Users[\\/]/i.test(value)
    || /(?:^|[\\/])\.zcode(?:[\\/]|$)/i.test(value);
}

const template = readJson(templatePath);

// A-D) The release template is parseable, safe by default, and has no runtime path residue.
assert.strictEqual(template.agentApi.enabled, false, "release template disables Agent API");
assert.strictEqual(template.zcodeEnabled, false, "release template keeps ZCode disabled");
assert.strictEqual(template.zcodeCli, "", "release template does not carry a ZCode path");
assert.strictEqual(Object.prototype.hasOwnProperty.call(template, "_configPath"), false, "runtime config path is absent");
assert.strictEqual(Object.prototype.hasOwnProperty.call(template, "_keySource"), false, "runtime key source is absent");

for (const [field, value] of [
  ["chat.apiKey", template.chat && template.chat.apiKey],
  ["ttsCosy.apiKey", template.ttsCosy && template.ttsCosy.apiKey],
  ["agentApi.bearerToken", template.agentApi && template.agentApi.bearerToken]
]) {
  assert.ok(value === undefined || value === "", field + " must be absent or empty");
}

if (template.agentApi && template.agentApi.clients !== undefined) {
  assert.ok(Array.isArray(template.agentApi.clients), "agentApi.clients must remain an array");
  for (const client of template.agentApi.clients) {
    assert.strictEqual(client && client.token, undefined, "client plaintext token is forbidden");
  }
}

const repoRootText = path.resolve(repoDir).replace(/\\/g, "/").toLowerCase();
for (const entry of collectStrings(template)) {
  const normalized = entry.value.replace(/\\/g, "/").toLowerCase();
  assert.strictEqual(isForbiddenAbsolutePath(entry.value), false, "template contains absolute path at " + entry.path);
  assert.strictEqual(normalized.includes(repoRootText), false, "template contains the project workspace at " + entry.path);
}

const rootConfig = readJson(rootConfigPath);
assert.strictEqual(rootConfig.agentApi.enabled, false, "root config keeps Agent API disabled");
assert.strictEqual(rootConfig.zcodeCli, "", "root config keeps ZCode path empty");

// Simulate the manual publish copy in an isolated system-temp directory.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-release-config-"));
try {
  const copiedPath = path.join(tempRoot, "app", "config.json");
  fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
  fs.copyFileSync(templatePath, copiedPath);
  const copied = readJson(copiedPath);
  assert.strictEqual(copied.agentApi.enabled, false, "copied release config disables Agent API");
  assert.strictEqual(copied.zcodeCli, "", "copied release config has no ZCode path");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(copied, "_configPath"), false, "copied config has no runtime path");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(copied, "_keySource"), false, "copied config has no runtime key source");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("release-config 全部通过 ✅");

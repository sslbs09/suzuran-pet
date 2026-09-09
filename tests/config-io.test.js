"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-config-"));
process.env.SUZURAN_TEST_USERDIR = userDir;
fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}", "utf8");

const config = require("../src/config");
const storage = require("../src/storage");
const configPath = config.CONFIG_PATH;
const backupPath = config.CONFIG_SHAPE_BACKUP_PATH;

function writeConfig(value) {
  if (typeof value === "string") fs.writeFileSync(configPath, value, "utf8");
  else fs.writeFileSync(configPath, JSON.stringify(value), "utf8");
}

function removeConfig() {
  if (fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()) fs.rmSync(configPath, { recursive: true });
  else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

function removeBackup() {
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
}

// 16) BOM is accepted as valid JSON.
writeConfig("\ufeff" + JSON.stringify({ pet: { name: "BOMME" } }));
assert.strictEqual(config.getConfig(true).pet.name, "BOMME", "BOM JSON loads normally");

// 17-19) Parse errors are protected; a missing file remains saveable.
const parseErrorBytes = "{\n  \"chat\":\n";
writeConfig(parseErrorBytes);
const warnings = [];
const originalWarn = console.warn;
console.warn = (message) => warnings.push(String(message));
try {
  assert.strictEqual(config.getConfig(true).chat.model, "deepseek-chat", "parse error uses defaults");
  assert.throws(() => config.saveConfig({ pet: { name: "must-not-write" } }), /config file cannot be read/);
} finally {
  console.warn = originalWarn;
}
assert.strictEqual(fs.readFileSync(configPath, "utf8"), parseErrorBytes, "parse error bytes are preserved");
assert.strictEqual(warnings.some((message) => message.includes("config parse error")), true, "parse warning is recorded");
assert.strictEqual(warnings.some((message) => message.includes(parseErrorBytes)), false, "warning does not contain raw config");

removeConfig();
assert.strictEqual(config.getConfig(true).pet.name, "苏苏洛", "missing file uses defaults");
config.saveConfig({ pet: { name: "首次保存" } });
assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).pet.name, "首次保存", "missing file can be saved");

// 20-24) Top-level invalid configs are backed up before the first overwrite.
for (const [name, raw] of [
  ["top-level null", "null"],
  ["top-level empty array", "[]"],
  ["top-level non-empty array", "[\"keep-me\"]"],
  ["top-level primitive", "\"keep-me\""]
]) {
  removeBackup();
  writeConfig(raw);
  const original = fs.readFileSync(configPath);
  config.getConfig(true);
  config.saveConfig({ pet: { name: "顶层非法保存" } });
  assert.strictEqual(fs.existsSync(backupPath), true, name + " creates a recovery backup");
  assert.deepStrictEqual(fs.readFileSync(backupPath), original, name + " backup preserves original bytes");
  assert.strictEqual(fs.readFileSync(configPath).equals(original), false, name + " can write normalized config after backup");
}

// 25) Top-level backup failure prevents both atomicWrite and config replacement.
removeBackup();
const topLevelBackupFailureOriginal = Buffer.from("\"keep-me\"", "utf8");
writeConfig("\"keep-me\"");
config.getConfig(true);
let topLevelBackupAttempts = 0;
let topLevelAtomicWrites = 0;
const topLevelOriginalCopyFileSync = fs.copyFileSync;
const originalAtomicWrite = storage.atomicWrite;
fs.copyFileSync = (source, target) => {
  if (target === backupPath) {
    topLevelBackupAttempts++;
    throw new Error("simulated top-level backup failure");
  }
  return topLevelOriginalCopyFileSync(source, target);
};
storage.atomicWrite = (...args) => {
  topLevelAtomicWrites++;
  return originalAtomicWrite(...args);
};
try {
  assert.throws(() => config.saveConfig({ pet: { name: "不得覆盖" } }), /failed to back up recovered config/);
} finally {
  fs.copyFileSync = topLevelOriginalCopyFileSync;
  storage.atomicWrite = originalAtomicWrite;
}
assert.strictEqual(topLevelBackupAttempts, 1, "top-level backup is attempted once");
assert.strictEqual(topLevelAtomicWrites, 0, "atomicWrite is not reached after top-level backup failure");
assert.deepStrictEqual(fs.readFileSync(configPath), topLevelBackupFailureOriginal, "top-level backup failure preserves original bytes");

// 26) A repaired local shape is backed up before the first overwrite.
removeBackup();
const recoveredOriginal = JSON.stringify({ chat: null, window: { width: 500 }, agentApi: "bad", ttsCosy: [] });
writeConfig(recoveredOriginal);
const recovered = config.getConfig(true);
assert.strictEqual(typeof recovered.chat, "object", "chat is recovered to an object");
assert.strictEqual(recovered.window.width, 500, "valid sibling survives recovery");
assert.strictEqual(typeof recovered.agentApi, "object", "agentApi is recovered to an object");
assert.strictEqual(Array.isArray(recovered.ttsCosy), false, "ttsCosy is recovered to an object");
config.saveConfig({ pet: { name: "形状恢复后保存" } });
assert.strictEqual(fs.readFileSync(backupPath, "utf8"), recoveredOriginal, "original recovered config is backed up");

// 27) Local shape recovery backup failure prevents the atomic config write.
removeBackup();
const backupFailureOriginal = JSON.stringify({ chat: null, pet: { name: "保留原文" } });
writeConfig(backupFailureOriginal);
config.getConfig(true);
const originalCopyFileSync = fs.copyFileSync;
fs.copyFileSync = (source, target) => {
  if (target === backupPath) throw new Error("simulated backup failure");
  return originalCopyFileSync(source, target);
};
try {
  assert.throws(() => config.saveConfig({ pet: { name: "不得覆盖" } }), /failed to back up recovered config/);
} finally {
  fs.copyFileSync = originalCopyFileSync;
}
assert.strictEqual(fs.readFileSync(configPath, "utf8"), backupFailureOriginal, "backup failure preserves config");

// 28) A fixed file becomes writable after a forced reload.
writeConfig("{\n  \"pet\":");
assert.throws(() => config.saveConfig({ pet: { name: "仍保护" } }), /config file cannot be read/);
writeConfig({ pet: { name: "用户已修复" } });
assert.strictEqual(config.getConfig(true).pet.name, "用户已修复", "forced reload clears write protection");
config.saveConfig({ pet: { name: "修复后保存" } });
assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).pet.name, "修复后保存", "save works after repair");

// 29) An invalid object-shaped save patch cannot destroy the live object.
writeConfig({ chat: { model: "custom-model" } });
config.getConfig(true);
config.saveConfig({ chat: null });
const afterInvalidPatch = JSON.parse(fs.readFileSync(configPath, "utf8"));
assert.strictEqual(afterInvalidPatch.chat.model, "custom-model", "chat object survives invalid patch");
assert.strictEqual(afterInvalidPatch.chat.sampling.topP, 0.9, "chat defaults remain complete");

// Read errors are protected in the same way as parse errors.
removeConfig();
fs.mkdirSync(configPath);
assert.strictEqual(config.getConfig(true).chat.model, "deepseek-chat", "read error uses defaults");
assert.throws(() => config.saveConfig({ pet: { name: "不得写入目录" } }), /config file cannot be read/);
removeConfig();
writeConfig({ pet: { name: "目录修复" } });
assert.strictEqual(config.getConfig(true).pet.name, "目录修复", "forced reload clears read protection");

// 30) Existing secret/runtime save semantics remain intact.
writeConfig({
  chat: { apiKey: "runtime-chat-secret", model: "secret-test" },
  ttsCosy: { apiKey: "runtime-cosy-secret" },
  agentApi: { bearerToken: "runtime-agent-secret", clients: [{ name: "client", token: "client-token" }] }
});
config.getConfig(true);
config.saveConfig({ pet: { name: "脱敏保存" } });
const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
assert.strictEqual(saved.chat.apiKey, undefined, "chat secret is still stripped");
assert.strictEqual(saved.ttsCosy.apiKey, undefined, "tts secret is still stripped");
assert.strictEqual(saved.agentApi.bearerToken, undefined, "agent secret is still stripped");
assert.strictEqual(saved.agentApi.clients[0].token, undefined, "client token is still sanitized");
assert.ok(saved.agentApi.clients[0].tokenHash, "client token hash is still retained");

console.log("config I/O 全部通过 ✅");

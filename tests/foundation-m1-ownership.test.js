"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/authority/ownership-registry.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
const postureSource = fs.readFileSync(path.join(__dirname, "../src/state-core/posture-support.js"), "utf8");
const required = ["domain", "canonicalOwner", "writers", "readers", "persistence", "lifetime", "generationGuard", "projectionTargets"];

test("M1 ownership registry covers every production domain with explicit contract fields", () => {
  const domains = new Set(registry.domains.map((entry) => entry.domain));
  for (const domain of ["locomotion", "drag/pause", "posture", "sleep", "chat/busy", "animation", "render mode", "geometry/window", "lifecycle"]) assert.ok(domains.has(domain), domain);
  for (const entry of registry.domains) {
    for (const field of required) assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `${entry.domain}:${field}`);
    assert.ok(entry.writers.length > 0 && entry.readers.length > 0 && entry.projectionTargets.length > 0, entry.domain);
  }
});

test("M1 registry names the production posture and lifecycle wiring", () => {
  const posture = registry.domains.find((entry) => entry.domain === "posture");
  const lifecycle = registry.domains.find((entry) => entry.domain === "lifecycle");
  assert.ok(posture.writers.some((value) => value.includes("setBodyPosture")));
  assert.ok(lifecycle.writers.some((value) => value.includes("body-ready")));
});

test("M1 registry references real production owners and guarded boundaries", () => {
  for (const entry of registry.domains) {
    const ownerFiles = entry.canonicalOwner.split(" + ").map((value) => value.split(":")[0]);
    for (const file of ownerFiles) assert.ok(fs.existsSync(path.join(__dirname, "..", file)), `${entry.domain}:${file}`);
  }
  for (const entry of registry.domains) {
    for (const writer of entry.writers) {
      const [file, ref] = writer.split(":");
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.match(source, new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${entry.domain}:${writer}`);
    }
  }
  assert.match(mainSource, /function isCurrentBodyMutation/);
  assert.match(mainSource, /senderFrame !== win\.webContents\.mainFrame/);
  assert.match(mainSource, /function setBodyPosture/);
  assert.doesNotMatch(mainSource, /observeWalk\(/);
  assert.match(preloadSource, /body-document-sync/);
  assert.match(postureSource, /applyBodyPatch/);
});

test("M1 body-truth IPC listeners use the current sender/frame/body guard", () => {
  const channels = [
    "pet:set-sleeping", "pet:move", "pet:throw", "pet:walking-pause",
    "pet:reload-renderer", "pet:body-ready", "pet:ask", "pet:stop",
    "pet:regenerate", "pet:render-mode-outcome", "pet:render-mode-correction",
    "pet:sit-taskbar"
  ];
  const listenerBlock = (channel) => {
    const start = mainSource.indexOf(`ipcMain.on("${channel}"` ) >= 0
      ? mainSource.indexOf(`ipcMain.on("${channel}"`)
      : mainSource.indexOf(`ipcMain.handle("${channel}"`);
    assert.ok(start >= 0, `listener exists: ${channel}`);
    const end = mainSource.indexOf("\nipcMain.", start + 1);
    return mainSource.slice(start, Math.min(end < 0 ? mainSource.length : end, start + 600));
  };
  for (const channel of channels) {
    assert.match(listenerBlock(channel), /isCurrentBodyMutation\(/, `${channel}: body guard`);
  }
  const catToy = listenerBlock("pet:set-cat-toy");
  assert.match(catToy, /isCurrentBodyMutation\(/, "cat-toy: pet body path remains guarded");
  assert.match(catToy, /isCurrentSettingsMutation\(/, "cat-toy: settings sender/frame exception is explicit");
});

test("M1 native position writes remain confined to injected writers and gate-off fallback", () => {
  assert.equal((mainSource.match(/win\.setPosition\(/g) || []).length, 3, "two injected writers plus explicit gate-off fallback");
  assert.match(mainSource, /writePosition: \(x, y\) => \{ win\.setPosition\(x, y\);/);
  assert.match(mainSource, /writePositionExternal: \(x, y\) => \{ win\.setPosition\(x, y\);/);
  const commitStart = mainSource.indexOf("function commitLegacyPosition");
  const commitEnd = mainSource.indexOf("\nfunction ", commitStart + 1);
  const commit = mainSource.slice(commitStart, commitEnd);
  assert.match(commit, /return v2Commit\.commitLegacy\(/, "canonical commit returns through WindowCommit first");
  assert.match(commit, /win\.setPosition\(Math\.round\(x\), Math\.round\(y\)\)/, "only gate-off fallback writes directly");
});

test("M1 sleep truth has one production field writer", () => {
  assert.equal((mainSource.match(/walk\.sleeping\s*=(?!=)/g) || []).length, 1);
  assert.match(mainSource, /function setSleepTruth\([\s\S]{0,260}walk\.sleeping = value;/);
});

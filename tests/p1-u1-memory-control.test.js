"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChatRequest } = require("../src/request-assembly");
const { createProjectionClient } = require("../src/whitemoon-projection");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("T4/T6 formal cognition uses current Core memory and discards pre-correction conversation context", () => {
  const cognition = { instanceId: "A", packageId: "sussurro", state: {}, relationship: {},
    currentMemory: { revision: 2, entries: [{ id: "correction-1", type: "memory-control", summary: "用户不喜欢咖啡" }] } };
  const result = buildChatRequest({ cognition, text: "我喜欢什么？", history: [
    { role: "user", content: "用户喜欢咖啡", whitemoonMemoryRevision: 0 },
    { role: "assistant", content: "你喜欢咖啡", whitemoonMemoryRevision: 0 },
    { role: "assistant", content: "更正后的聊天", whitemoonMemoryRevision: 2 }
  ] });
  assert.ok(result.messages.some((m) => m.content.includes("用户不喜欢咖啡")));
  assert.ok(result.messages.some((m) => m.content === "更正后的聊天"));
  assert.ok(!JSON.stringify(result.messages).includes("用户喜欢咖啡"));
  assert.ok(!JSON.stringify(result.messages).includes("你喜欢咖啡"));
});

test("memory transport reports failed persistence without success and binds the user-selected instance", async () => {
  const calls = [];
  const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl: "http://127.0.0.1:9", token: "synthetic" }),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: false, status: 500, json: async () => ({ ok: false, status: "MEMORY_CONTROL_FAILED" }) }; } });
  const result = await client.controlMemory({ instanceId: "A", targetExperienceId: "wrong", action: "retract" });
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(calls[0].init.body).instanceId, "A");
  assert.equal(calls[0].init.method, "POST");
});

test("a configured formal mode with an invalid Host address must not pretend legacy mode is enabled", async () => {
  const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl: "" }),
    fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.equal((await client.inspectMemory()).status, "MEMORY_UNAVAILABLE");
});

for (const interruption of ["reload", "stop", "clear"]) {
  test("formal regenerate waiting for memory respects " + interruption + " and releases its existing task", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    const begin = source.indexOf('ipcMain.handle("pet:regenerate",');
    const end = source.indexOf('/** 原生窗口外观同步', begin);
    let callback, resolveProjection;
    let current = true, taskCurrent = true, generation = 0;
    let providerCalls = 0, taskStarts = 0, taskFinishes = 0;
    const rows = [{ role: "user", content: "turn", whitemoonInstance: "A", whitemoonMemoryRevision: 2 },
      { role: "assistant", content: "reply", whitemoonInstance: "A", whitemoonMemoryRevision: 2 }];
    vm.runInNewContext(source.slice(begin, end), {
      ipcMain: { handle: (_name, fn) => { callback = fn; } },
      isCurrentBodyMutation: () => current, win: { isDestroyed: () => false },
      config: { getConfig: () => ({ chat: { apiKey: "synthetic", maxHistoryTurns: 20 }, whitemoonRuntime: { enabled: true } }) },
      formalProjection: { fetchProjection: () => new Promise((r) => { resolveProjection = r; }) },
      history: { recent: () => rows, generation: () => generation, updateLast: (_mode, _role, fn) => { fn(rows[1]); return rows[1]; } },
      conversation: { start: () => { taskStarts++; return { ok: true, id: "task", signal: new AbortController().signal, isCurrent: () => taskCurrent }; },
        finish: () => { taskFinishes++; } },
      chatPauseWalk: () => ({ ok: true }), sendToRenderer: () => {}, logTts: () => {},
      aliveStatus: { noteTurnStarted: () => {}, noteTurnSucceeded: () => {}, noteTurnCancelled: () => {} },
      chatClient: { chat: async () => { providerCalls++; return { text: "reply" }; } },
      buildChatPersona: () => "", petStateNote: () => "", drainAskBuffer: () => {}
    });
    const pending = callback({ sender: {} }, "request", {});
    assert.equal(taskStarts, 1, "the memory await must be owned by the existing regenerate task");
    if (interruption === "reload") current = false;
    if (interruption === "stop") taskCurrent = false;
    if (interruption === "clear") generation++;
    resolveProjection({ state: "ok", projection: { character: { instanceId: "A", currentMemory: { revision: 2, entries: [] } } } });
    assert.equal(await pending, null);
    assert.equal(providerCalls, 0);
    assert.equal(taskFinishes, 1);
  });
}

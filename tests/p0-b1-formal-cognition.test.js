/**
 * p0-b1-formal-cognition.test.js — P0-B1 production-path cognition wiring tests
 * （§24 T1–T6、T8、T9、T14 harness 层 + §27 R8 失败语义）
 *
 * 用 M1 harness 完整求值真实 main.js（Electron 在 require 边界替换），
 * 驱动真实 handleAsk 管线；chat-client 用捕获 stub（序列化层由
 * p0-b1-loopback-e2e.test.js 走真实 serializer）。投影传输用真实
 * whitemoon-projection 模块打本地假 Host HTTP 服务（Host 契约由
 * whitemoon-runtime-host 仓库测试固定）。userData 全程隔离。
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { loadMain, ROOT } = require("./helpers/main-body-harness");

// 隔离 userData（真实 history/memory/bond 模块都写这里；绝不触碰真实实例）
const USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), "p0b1-body-"));
process.env.SUZURAN_TEST_USERDIR = USERDIR;

const history = require("../src/history");
const bond = require("../src/bond");

function makeStubConfig() {
  const cfg = {
    agreed: true, firstRun: false, renderMode: "spine", uiLang: "zh",
    zcodeEnabled: false, keyReady: true, hiddenAtStart: true, greetingOnStart: false,
    rpMode: true,
    pet: { name: "苏苏洛" },
    features: {},
    chat: { maxHistoryTurns: 20, model: "stub-model", apiKey: "", userName: "博士" },
    tts: { enabled: false, fixedOnly: true },
    agentApi: { enabled: false },
    render: {}, softRender: false, window: { x: 0, y: 0, width: 260, height: 200 },
    whitemoonRuntime: { enabled: false, baseUrl: "", ingressToken: "test-ingress-token" }
  };
  return {
    APP_DIR: ROOT, STORAGE: { userDir: USERDIR },
    getConfig: () => cfg,
    saveConfig: (patch) => Object.assign(cfg, patch),
    getPersonaText: () => "我是苏苏洛，用户的恋人与医师桌宠。",
    fillTokens: (s) => String(s).replaceAll("{{petName}}", "苏苏洛").replaceAll("{{userName}}", "博士"),
    initializeSecretStorage: () => ({}),
    getConfigPath: () => "",
    getUserDataDir: () => cfg
  };
}

/** 本地假 Host：可变响应 + 请求记录（客户端层由 projection 测试覆盖，此处给真实 HTTP）。 */
function fakeHost() {
  const requests = [];
  let responder = (res) => { res.writeHead(500); res.end("{}"); };
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    responder(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      requests,
      setResponse(characterBlock, opts = {}) {
        responder = (res) => {
          if (characterBlock === null) {
            res.writeHead(opts.status || 503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, status: opts.statusName || "INSTANCE_UNAVAILABLE", error: "fake" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "OK", surfaceVersion: 1, character: characterBlock, observedAt: "2026-10-09T00:00:00.000Z" }));
        };
      },
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
    }));
  });
}

function makeHarness({ host, captures = [], failWith = null }) {
  const config = makeStubConfig();
  config.getConfig().whitemoonRuntime.baseUrl = host.baseUrl;
  const chatClientStub = {
    chat: async (opts) => {
      captures.push(opts);
      if (failWith) throw failWith(opts);
      return { text: "好的，博士～", emotion: "开心" };
    },
    parseEmotion: (t) => ({ text: t, emotion: "" })
  };
  const main = loadMain({
    requireOverrides: {
      "./src/config": config,
      "./src/chat-client": chatClientStub,
      "./src/router": { route: () => ({ mode: "chat", task: "" }) },
      "./src/quick-commands": { tryQuickCommand: () => null },
      "./src/consent-gate": { isConsentAccepted: () => true, canUseRuntime: () => true, acceptConsent: () => true },
      "./src/whitemoon-projection": require("../src/whitemoon-projection"), // 真实客户端模块
      "./src/history": history,
      "./src/memory": require("../src/memory"),
      "./src/bond": bond,
      "./src/error-facts": require("../src/error-facts")
    }
  });
  // 替换 harness 自带 config stub（同一对象注入 main 的 require 边界）
  return { main, config, captures };
}

const A_CHARACTER = (n = 0) => ({
  instanceId: "sussurro-A", packageId: "sussurro", displayName: "Sussurro", projectionSemanticsVersion: 2,
  createdAt: "x", experienceCount: n,
  state: { sharedMilestones: { exam: { status: "completed", sourceExperienceId: "exp-a" + n } } },
  relationship: { sharedHistory: { meaningfulExperienceCount: n, lastMeaningfulExperienceId: "exp-a" + n } }
});
const B_CHARACTER = () => ({
  instanceId: "sussurro-B", packageId: "sussurro", displayName: "Sussurro", projectionSemanticsVersion: 2,
  createdAt: "y", experienceCount: 1,
  state: { sharedActivities: { observationBooklet: { status: "active", entryCount: 1 } } },
  relationship: { sharedActivities: { observationBooklet: { startedTogetherExperienceId: "exp-b1" } } }
});

function sender() {
  const messages = [];
  return { messages, send: (name, data) => { messages.push({ name, data }); } };
}

test("T1–T3: formal mode provider input carries canonical identity/state/relationship from the Host projection", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(1));
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  config.getConfig().whitemoonRuntime.enabled = true;
  const s = sender();
  await main.context.__m1.call("handleAsk", s, { id: "r1", text: "今天感觉怎么样" });
  assert.equal(captures.length, 1);
  const opts = captures[0];
  assert.ok(opts.cognition, "formal mode must pass the canonical projection into the assembly boundary");
  assert.equal(opts.cognition.instanceId, "sussurro-A");
  assert.deepEqual(opts.cognition.state, A_CHARACTER(1).state);
  assert.deepEqual(opts.cognition.relationship, A_CHARACTER(1).relationship);
  assert.equal(opts.currentInHistory, true, "UI entry pre-writes the user row (§20)");
  assert.equal(host.requests.length, 1);
  assert.equal(host.requests[0].method, "GET");
  const done = s.messages.find((m) => m.name === "pet:done");
  assert.ok(done && done.data.full.includes("好的"), "response flows to the Body chat surface");
});

test("T4: legitimate Core state/relationship change is reflected in the next request without touching Body persona", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(1));
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  config.getConfig().whitemoonRuntime.enabled = true;
  const personaBefore = config.getPersonaText();
  await main.context.__m1.call("handleAsk", sender(), { id: "r1", text: "第一句" });
  // canonical 合法变化：模拟 Host 投影更新（Experience 接受后的新投影）
  host.setResponse(A_CHARACTER(2));
  await main.context.__m1.call("handleAsk", sender(), { id: "r2", text: "第二句" });
  assert.equal(captures.length, 2);
  assert.equal(captures[0].cognition.relationship.sharedHistory.meaningfulExperienceCount, 1);
  assert.equal(captures[1].cognition.relationship.sharedHistory.meaningfulExperienceCount, 2);
  assert.equal(captures[1].cognition.state.sharedMilestones.exam.sourceExperienceId, "exp-a2");
  assert.equal(config.getPersonaText(), personaBefore, "no Body persona edit was required");
  await host.close();
});

test("T5: changing legacy bond does not change canonical Relationship content or precedence", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(3));
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  config.getConfig().whitemoonRuntime.enabled = true;
  await main.context.__m1.call("handleAsk", sender(), { id: "r1", text: "第一句" });
  const before = captures[0].cognition.relationship;
  // 直接改 legacy bond（模拟多次互动累积）——正式路径不得因此改变 canonical 输入
  bond.addExp(50); bond.addExp(50);
  host.setResponse(A_CHARACTER(3)); // Host 投影不变（bond 不是其写路径）
  await main.context.__m1.call("handleAsk", sender(), { id: "r2", text: "第二句" });
  assert.deepEqual(captures[1].cognition.relationship, before);
  assert.deepEqual(captures[1].cognition.state, captures[0].cognition.state);
  // formal persona 不得携带 bond 文本（bond.getText 注入被抑制）
  assert.ok(!String(captures[1].persona).includes("羁绊等级"), "legacy bond text must not enter formal cognition persona");
  await host.close();
});

test("T6: enabled=false keeps the existing Body chat path compatible (no cognition, legacy persona injection intact)", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  // legacy 模式：默认 enabled=false；longTermMemory+rpMode 打开（现状行为）
  config.getConfig().features.longTermMemory = true;
  const s = sender();
  await main.context.__m1.call("handleAsk", s, { id: "r1", text: "普通聊天" });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].cognition, undefined, "legacy path supplies no canonical projection");
  assert.ok(String(captures[0].persona).includes("我是苏苏洛"), "legacy persona intact");
  assert.equal(host.requests.length, 0, "no Host traffic while disabled");
  assert.equal(captures[0].currentInHistory, true, "dedupe flag applies on the legacy UI path too (§20 fix scope)");
  await host.close();
});

test("R8: formal mode + Host failure = explicit error, no chat sent, no pre-writes, no fake formal success", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(null, { status: 503, statusName: "INSTANCE_UNAVAILABLE" });
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  config.getConfig().whitemoonRuntime.enabled = true;
  const rowsBefore = history.load().length;
  const bondBefore = JSON.stringify(bond.getProgress());
  const s = sender();
  await main.context.__m1.call("handleAsk", s, { id: "r1", text: "这句不应该发出去" });
  assert.equal(captures.length, 0, "provider request must not be assembled when the canonical read fails");
  const err = s.messages.find((m) => m.name === "pet:error");
  assert.ok(err, "user must see an explicit failure");
  assert.equal(err.data.code, "FORMAL_PROJECTION_UNAVAILABLE");
  assert.equal(history.load().length, rowsBefore, "failed formal turn must not pre-write user history");
  assert.equal(JSON.stringify(bond.getProgress()), bondBefore);
  // busy 已释放：下一条正常进入
  host.setResponse(A_CHARACTER(1));
  await main.context.__m1.call("handleAsk", sender(), { id: "r2", text: "下一句" });
  assert.equal(captures.length, 1);
  await host.close();
});

test("T9: cross-instance switch never bleeds projections or conversation history", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(4));
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  config.getConfig().whitemoonRuntime.enabled = true;
  await main.context.__m1.call("handleAsk", sender(), { id: "r1", text: "甲话" });
  await main.context.__m1.call("handleAsk", sender(), { id: "r2", text: "乙话" });
  assert.equal(captures[1].history.every((r) => r.whitemoonInstance === "sussurro-A"), true);
  // 切到 Instance B（Host 重新配置指向另一正式实例）
  host.setResponse(B_CHARACTER());
  await main.context.__m1.call("handleAsk", sender(), { id: "r3", text: "丙话" });
  const c = captures[2];
  assert.equal(c.cognition.instanceId, "sussurro-B");
  assert.ok(!JSON.stringify(c.cognition).includes("sussurro-A"));
  assert.ok(!JSON.stringify(c.cognition).includes("exp-a4"));
  // A 实例的会话行不得进入 B 的请求
  assert.equal(c.history.every((r) => r.whitemoonInstance === "sussurro-B"), true);
  assert.ok(!c.history.some((r) => r.content === "甲话"));
  // 旧（未标记）历史也不得进入 formal 请求：本 userdir 的 r1/r2 行都是 A 标记，已排除 ✓
});

test("T8: after a fresh Body process over the same userData + same configured Instance, the same projection and tagged history are re-read (no cache fake)", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(7));
  const captures1 = [];
  const h1 = makeHarness({ host, captures: captures1 });
  h1.config.getConfig().whitemoonRuntime.enabled = true;
  await h1.main.context.__m1.call("handleAsk", sender(), { id: "r1", text: "重启前" });
  await host.close();

  // “重启”= 全新 harness 进程语义 + 新 Host 服务实例（同一投影内容 = 同一持久 Instance）
  const host2 = await fakeHost();
  t.after(() => host2.close());
  host2.setResponse(A_CHARACTER(7));
  const captures2 = [];
  const h2 = makeHarness({ host: host2, captures: captures2 });
  h2.config.getConfig().whitemoonRuntime.enabled = true;
  await h2.main.context.__m1.call("handleAsk", sender(), { id: "r2", text: "重启后" });
  assert.deepEqual(captures2[0].cognition, captures1[0].cognition);
  assert.ok(captures2[0].history.some((r) => r.content === "重启前"), "persisted tagged history continues across restart");
  assert.ok(captures2[0].history.every((r) => r.whitemoonInstance === "sussurro-A"));
  await host2.close();
});

test("T14/T7-ish wiring: legacy persona supplied to formal path is base text only; provider failure yields explicit error, zero Host writes", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(2));
  const captures = [];
  const { main, config } = makeHarness({ host, captures, failWith: () => Object.assign(new Error("API 503"), { name: "Error", code: "HTTP_ERROR" }) });
  const cfg = config.getConfig();
  cfg.whitemoonRuntime.enabled = true;
  cfg.features.longTermMemory = true; // 即便 legacy 记忆全开，formal persona 也只供基础人设
  const s = sender();
  await main.context.__m1.call("handleAsk", s, { id: "r1", text: "provider 会失败的一句" });
  assert.equal(captures.length, 1);
  assert.ok(!String(captures[0].persona).includes("羁绊等级"));
  const err = s.messages.find((m) => m.name === "pet:error");
  assert.ok(err, "provider failure is surfaced");
  assert.notEqual(err.data.code, undefined);
  assert.equal(host.requests.filter((r) => r.method !== "GET").length, 0, "provider failure must never reach any Host/Core write");
  await host.close();
});

test("suppression ledger and diagnostics reach the assembly boundary", async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  host.setResponse(A_CHARACTER(1));
  const captures = [];
  const { main, config } = makeHarness({ host, captures });
  config.getConfig().whitemoonRuntime.enabled = true;
  await main.context.__m1.call("handleAsk", sender(), { id: "r1", text: "看看抑制清单" });
  const opts = captures[0];
  const cats = (opts.suppressions || []).map((x) => x.category).sort().join("|");
  assert.equal(cats, ["EXPLICIT_USER_PREFERENCE", "LEGACY_BOND", "LEGACY_FACT", "LEGACY_SUMMARY", "LEGACY_VECTOR_RECALL"].sort().join("|"));
  assert.equal(typeof opts.assemblySink, "function", "diagnostics sink wired (§16)");
  await host.close();
});

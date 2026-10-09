/**
 * p0-b2-failure-safe-turns.test.js — P0-B2 核心集成：FAILURE-SAFE COGNITION TURN
 * + HONEST HEALTH + CANCEL/LATE-RESULT FENCE + RECOVERY（任务 §11–§22/§25 T1–T18）
 *
 * 全部走真实链路（§27）：M1 harness 完整求值 main.js → 真实 handleAsk 管线 →
 * 真实 whitemoon-projection → 本地可控制假 Host → 真实 request-assembly →
 * 真实 chatOpenAI serializer/parser → loopback provider（§27 失败矩阵）。
 * 数据 delta 以 userData 文件字节哈希为证据（§26），不是「测试通过」口头结论。
 *
 * 隔离：SUZURAN_TEST_USERDIR tmpdir；synthetic 凭据；不触碰真实 userData。
 */
"use strict";
const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const TEST_SECRET = "synthetic-" + crypto.randomBytes(8).toString("hex");
const USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), "p0b2-turns-"));
process.env.SUZURAN_TEST_USERDIR = USERDIR;

const { loadMain, ROOT } = require("./helpers/main-body-harness");
const { createLoopbackProvider } = require("./helpers/loopback-provider");

const FILES = {
  history: path.join(USERDIR, "history", "history.jsonl"),
  memory: path.join(USERDIR, "memory.json"),
  bond: path.join(USERDIR, "bond.json"),
  vector: path.join(USERDIR, "memory-vector.json")
};
function digestFiles() {
  const out = {};
  for (const [k, p] of Object.entries(FILES)) {
    try { out[k] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16); }
    catch { out[k] = "ABSENT"; }
  }
  return out;
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function historyLines() {
  try {
    return fs.readFileSync(FILES.history, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

/* ---------------- loopback provider（§27 全模式） ---------------- */
let INFRA = null;
function fakeHostControlled() {
  const requests = [];
  let mode = "ok";
  const character = (n) => ({
    instanceId: "sussurro-A", packageId: "sussurro", displayName: "Sussurro",
    projectionSemanticsVersion: 2, createdAt: "x", experienceCount: n,
    state: { sharedMilestones: { exam: { status: "completed", sourceExperienceId: "exp-a" + n } } },
    relationship: { sharedHistory: { meaningfulExperienceCount: n, lastMeaningfulExperienceId: "exp-a" + n } }
  });
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (mode === "down") { req.socket && req.socket.destroy(); return; }
    if (mode === "package_mismatch") { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, status: "PACKAGE_MISMATCH", error: "semantics drift" })); return; }
    if (mode === "instance_unavailable") { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, status: "INSTANCE_UNAVAILABLE", error: "missing" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "OK", surfaceVersion: 1, character: character(3), observedAt: "2026-10-09T00:00:00.000Z" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      requests,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      setMode(m) { mode = m; },
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
    }));
  });
}

async function ensureInfra() {
  if (INFRA) return INFRA;
  const provider = await createLoopbackProvider();
  const host = await fakeHostControlled();
  fs.writeFileSync(path.join(USERDIR, "config.json"), JSON.stringify({
    agreed: true, firstRun: false,
    chat: {
      apiType: "openai", baseUrl: provider.baseUrl, model: "loopback-gpt", apiKey: TEST_SECRET,
      temperature: 0.7, maxTokens: 256, maxHistoryTurns: 20, userName: "博士"
    },
    features: { longTermMemory: true, vectorMemory: true }, rpMode: true,
    whitemoonRuntime: { enabled: true, baseUrl: host.baseUrl }
  }, null, 2));
  fs.writeFileSync(path.join(USERDIR, ".storage-migration-v1.json"), "{}");
  INFRA = { provider, host, diags: [], forceSseIdleMs: null };
  return INFRA;
}

function makeStubConfig(formal) {
  const cfg = {
    agreed: true, firstRun: false, renderMode: "spine", uiLang: "zh",
    zcodeEnabled: false, keyReady: true, greetingOnStart: false, rpMode: true,
    pet: { name: "苏苏洛" }, features: { longTermMemory: true, vectorMemory: true },
    chat: { maxHistoryTurns: 20, model: "loopback-gpt", apiKey: TEST_SECRET, userName: "博士" },
    tts: { enabled: false }, agentApi: { enabled: false }, render: {}, softRender: false,
    window: { x: 0, y: 0, width: 260, height: 200 },
    whitemoonRuntime: { enabled: formal !== false, baseUrl: INFRA.host.baseUrl, ingressToken: "synthetic-token" }
  };
  return {
    APP_DIR: ROOT, STORAGE: { userDir: USERDIR },
    getConfig: () => cfg, saveConfig: (patch) => Object.assign(cfg, patch),
    getPersonaText: () => "我是苏苏洛，用户的恋人与医师桌宠。",
    fillTokens: (s) => String(s).replaceAll("{{petName}}", "苏苏洛").replaceAll("{{userName}}", "博士"),
    initializeSecretStorage: () => ({}), getConfigPath: () => "", getUserDataDir: () => cfg
  };
}

/** boot：fresh main（per-case conversation/buffer 隔离）+ window 打开 + body-ready（BODY=READY）。 */
async function boot({ formal = true } = {}) {
  await ensureInfra();
  INFRA.diags.length = 0;
  INFRA.forceSseIdleMs = null;
  INFRA.provider.captured.length = 0;
  INFRA.host.requests.length = 0;
  INFRA.host.setMode("ok");
  INFRA.provider.setMode("success");
  const mainConfig = makeStubConfig(formal);
  const realChat = require("../src/chat-client");
  const chatProxy = {
    chat: (opts) => {
      const providedSink = opts.assemblySink;
      const injected = Object.assign({}, opts, INFRA.forceSseIdleMs ? { sseIdleMs: INFRA.forceSseIdleMs } : {}, {
        assemblySink: (d) => { INFRA.diags.push(d); if (typeof providedSink === "function") providedSink(d); }
      });
      return realChat.chat(injected);
    },
    parseEmotion: realChat.parseEmotion
  };
  const main = loadMain({
    requireOverrides: {
      "./src/config": mainConfig,
      "./src/chat-client": chatProxy,
      "./src/router": { route: () => ({ mode: "chat", task: "" }) },
      "./src/quick-commands": { tryQuickCommand: () => null },
      "./src/consent-gate": { isConsentAccepted: () => true, canUseRuntime: () => true, acceptConsent: () => true },
      "./src/whitemoon-projection": require("../src/whitemoon-projection"),
      "./src/history": require("../src/history"),
      "./src/memory": require("../src/memory"),
      "./src/bond": require("../src/bond"),
      "./src/error-facts": require("../src/error-facts"),
      "./src/vector-memory": require("../src/vector-memory"),
      "./src/turn-commit": require("../src/turn-commit"),
      "./src/alive-status": require("../src/alive-status")
    }
  });
  // open window + current-document identity（cancel 测试的 pet:stop 需要合法 bodyIdentity）
  main.createWindow();
  const identity = main.syncDocument();
  main.outcome(identity, { requestedMode: "spine", committedMode: "spine", ok: true });
  main.ready(identity, { committedMode: "spine", usable: true });
  const wc = main.state.win.webContents;
  const api = {
    main, config: mainConfig, wc, identity,
    event: () => ({ sender: wc, senderFrame: wc.mainFrame }),
    messages: () => wc.__messages.map((m) => ({ name: m.name, data: m.args ? m.args[0] : undefined })),
    clearMessages: () => { wc.__messages.length = 0; },
    ask(text, id) {
      const call = main.context.__m1.call("handleAsk", wc, { id, text });
      return Promise.resolve(call).then(() => this.messages());
    },
    askStart(text, id) { // 不等待完成（cancel 场景）
      return Promise.resolve(main.context.__m1.call("handleAsk", wc, { id, text }));
    },
    stop(requestId) {
      const stopHandler = main.handler("pet:stop");
      stopHandler(this.event(), requestId, identity);
    },
    alive() { return main.handler("pet:get-alive-status")(); },
    provider: INFRA.provider, host: INFRA.host, diags: INFRA.diags
  };
  return api;
}

function findMsg(msgs, name) { return msgs.find((m) => m.name === name); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ T13 状态真相 ============================ */

test("T13/§8: a fully configured provider shows IDLE cognition + UNAVAILABLE formal until REAL observations", async () => {
  const h = await boot({ formal: true });
  // config 有 key、baseUrl、Host 在线（ready 推送过 alive-status）——但从未尝试任何 turn：
  const s = h.alive();
  assert.equal(s.cognition.state, "IDLE", "configured provider ≠ cognition healthy (§8 硬规则)");
  assert.equal(s.cognition.source, "never-observed");
  assert.equal(s.cognition.lastObservedAt, null);
  assert.equal(s.formal.state, "UNAVAILABLE", "Host 进程在/可达 ≠ Formal Character OK——只有本轮实际读到才 OK");
  assert.equal(s.body.state, "READY", "renderer ready 是 lifecycle-event 观察");
  // 且 ready 时已把当前真相推给 renderer（事件驱动，非轮询）
  assert.ok(findMsg(h.messages(), "pet:alive-status"), "initial truth pushed on body-ready");
});

/* ============================ T6 成功提交 ============================ */

test("T6/§12: successful formal turn commits user+assistant TOGETHER with derived effects EXACTLY ONCE", async () => {
  const h = await boot({ formal: true });
  const before = digestFiles();
  const bondBefore = readJsonSafe(FILES.bond) || { exp: 0, interactions: 0 };
  const msgs = await h.ask("我喜欢喝桂花乌龙，记住我的医师身份就好", "ok-1");
  const after = digestFiles();
  const done = findMsg(msgs, "pet:done");
  assert.ok(done, "successful turn surfaces");
  // data delta：history 恰好 +2 行（user+assistant 成对，均 instance-tagged）
  const rows = historyLines();
  const mine = rows.filter((r) => r.mode === "chat");
  const user = mine.filter((r) => r.role === "user" && r.content.includes("桂花乌龙"));
  const assistant = mine.filter((r) => r.role === "assistant" && String(r.content).includes("你好博士"));
  assert.equal(user.length, 1);
  assert.equal(assistant.length, 1);
  assert.equal(user[0].whitemoonInstance, "sussurro-A", "formal rows carry canonical instance tag");
  assert.equal(assistant[0].whitemoonInstance, "sussurro-A");
  // bond：+1 exp 恰好在成功后出现一次（不是两次——没有 pre-write + post-write 双计）
  const bond = readJsonSafe(FILES.bond) || { exp: 0, interactions: 0 };
  assert.equal(bond.interactions, bondBefore.interactions + 1, "bond success increment exactly once");
  // auto facts：提取结果随成功提交（delta 证据=文件变化）
  assert.notEqual(after.memory, before.memory, "auto-derived facts committed with success");
  // formal mode：vector 不写入（P0-B1 §23 语义保持）⇒ 有意不变
  assert.equal(after.vector, before.vector, "INTENTIONALLY UNCHANGED: formal turn never writes vector (P0-B1 §23)");
  // alive 真相推进
  const s = h.alive();
  assert.equal(s.cognition.state, "AVAILABLE");
  assert.equal(s.cognition.source, "observed-success");
  assert.equal(s.formal.state, "OK");
});

/* ============================ T5 空 2xx（强制） ============================ */

test("T5/§17 EMPTY 2xx: honest failure, NO success commit, no fake assistant", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("empty200");
  const before = digestFiles();
  const msgs = await h.ask("这句会得到空成功响应", "empty-1");
  assert.equal(findMsg(msgs, "pet:done"), undefined, "no success path on empty 2xx");
  const err = findMsg(msgs, "pet:error");
  assert.ok(err, "explicit honest failure surfaced");
  assert.equal(err.data.code, "PROVIDER_EMPTY_RESPONSE");
  const after = digestFiles();
  assert.deepEqual(after, before, "failure ⇒ history/memory/bond/vector byte-identical (no success-semantics commit)");
  assert.equal(h.alive().cognition.state, "UNAVAILABLE");
  assert.equal(h.alive().body.state, "READY", "§9：网络错误不等于角色消失");
});

test("T5 variants: non-stream JSON body / malformed SSE / marker-only all fail honestly", async () => {
  for (const mode of ["malformedSSE", "malformedJSON", "markerOnly", "emptyJsonChoices"]) {
    const h = await boot({ formal: true });
    h.provider.setMode(mode);
    const before = digestFiles();
    const msgs = await h.ask("这句是" + mode + "响应", "m-" + mode);
    const err = findMsg(msgs, "pet:error");
    assert.ok(err, mode + " must surface an error");
    assert.ok(!String(err.data.message || "").includes("sk-"), "provider secret material never surfaces");
    assert.equal(findMsg(msgs, "pet:done"), undefined, mode + " never looks like a completed answer");
    assert.deepEqual(digestFiles(), before, mode + " ⇒ zero success-semantics persistence");
  }
});

/* ============================ T1/T2/T4 失败矩阵 ============================ */

test("T1 connection failure / T2 401-429-500 / T4 sse error: honest failure + zero persistence (data-delta evidence)", async () => {
  const cases = [
    { mode: "connectionClose", expectCode: "NETWORK_ERROR" },
    { mode: "401", expectCode: "AUTH_INVALID" },
    { mode: "429", expectCode: "QUOTA_EXCEEDED" },
    { mode: "500", expectCode: "HTTP_ERROR" },
    { mode: "sseErrorFrame", expectCode: "INTERNAL" }
  ];
  for (const c of cases) {
    const h = await boot({ formal: true });
    h.provider.setMode(c.mode);
    const before = digestFiles();
    const msgs = await h.ask("这句会碰到" + c.mode, "f-" + c.mode);
    const err = findMsg(msgs, "pet:error");
    assert.ok(err, c.mode + " surfaced pet:error");
    assert.equal(err.data.code, c.expectCode, c.mode + " → " + c.expectCode);
    assert.deepEqual(digestFiles(), before, c.mode + " ⇒ UNCHANGED history/memory/bond/vector");
    const s = h.alive();
    assert.equal(s.cognition.state, "UNAVAILABLE");
    assert.equal(s.body.state, "READY");
    assert.ok(h.host.requests.every((r) => r.method === "GET"), "failure paths never write Core/Host");
  }
});

test("T3 timeout via real SSE idle deadline (injected small idleMs; production default unchanged)", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("stall");
  INFRA.forceSseIdleMs = 80; // chatProxy 注入——真实 readSSE 路径触发 TIMEOUT 分类
  const before = digestFiles();
  const msgs = await h.ask("这句会卡住不流", "t-1");
  const err = findMsg(msgs, "pet:error");
  assert.ok(err);
  assert.equal(err.data.code, "TIMEOUT");
  assert.deepEqual(digestFiles(), before, "timeout ⇒ zero success commit（§16）");
  assert.equal(h.alive().cognition.state, "UNAVAILABLE");
});

/* ============================ T12 provider 恢复 ============================ */

test("T12: provider recovery needs NO restart — next turn succeeds on the same Body process", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("500");
  await h.ask("失败轮", "r-fail");
  assert.equal(h.alive().cognition.state, "UNAVAILABLE");
  h.provider.setMode("success");
  const before = digestFiles();
  const msgs = await h.ask("恢复后的第一轮", "r-ok");
  assert.ok(findMsg(msgs, "pet:done"), "recovered turn completes");
  assert.notEqual(digestFiles().history, before.history, "recovered success turn persists");
  assert.equal(h.alive().cognition.state, "AVAILABLE");
});

/* ============================ T10/T11/T15 formal 语义 ============================ */

test("T10: formal Host DOWN ⇒ FORMAL_PROJECTION_UNAVAILABLE, ZERO provider call, ZERO turn persistence (fail-closed)", async () => {
  const h = await boot({ formal: true });
  // 先成功一轮建立 AVAILABLE 认知（之后 Host 挂掉不得把认知层伪装成故障）
  await h.ask("第一轮正常", "h-ok");
  assert.equal(h.alive().formal.state, "OK");
  h.host.setMode("down");
  const capturedBefore = h.provider.captured.length;
  const before = digestFiles();
  h.clearMessages(); // 只观察本轮消息（上一轮成功 turn 的 done 不得混入本断言）
  const msgs = await h.ask("Host 挂掉后的一句", "h-down");
  const err = findMsg(msgs, "pet:error");
  assert.equal(err && err.data.code, "FORMAL_PROJECTION_UNAVAILABLE");
  assert.equal(h.provider.captured.length, capturedBefore, "§10 fail-closed: zero provider calls when formal projection fails");
  assert.equal(findMsg(msgs, "pet:done"), undefined, "no fake formal success");
  assert.deepEqual(digestFiles(), before, "zero Body-local persistence mutation on projection failure");
  const s = h.alive();
  assert.equal(s.formal.state, "UNAVAILABLE");
  assert.equal(s.cognition.state, "AVAILABLE", "Host failure ≠ model failure（§6 不互相冒充）");
  assert.equal(s.body.state, "READY");
});

test("T15: PACKAGE_MISMATCH is its own honest formal state (never disguised as OK or plain UNAVAILABLE)", async () => {
  const h = await boot({ formal: true });
  h.host.setMode("package_mismatch");
  const before = digestFiles();
  const msgs = await h.ask("包不匹配的一句", "pm-1");
  const err = findMsg(msgs, "pet:error");
  assert.equal(err && err.data.code, "FORMAL_PROJECTION_UNAVAILABLE");
  assert.equal(h.alive().formal.state, "PACKAGE_MISMATCH");
  assert.deepEqual(digestFiles(), before);
});

test("T11: Host recovers → SAME instance continues formal cognition with no character loss", async () => {
  const h = await boot({ formal: true });
  h.host.setMode("instance_unavailable");
  await h.ask("Host 还没就绪", "rec-1");
  assert.equal(h.alive().formal.state, "UNAVAILABLE");
  h.host.setMode("ok");
  const msgs = await h.ask("Host 恢复了", "rec-2");
  assert.ok(findMsg(msgs, "pet:done"));
  const s = h.alive();
  assert.equal(s.formal.state, "OK");
  assert.equal(s.formal.source, "projection-response");
  const rows = historyLines();
  assert.ok(rows.some((r) => r.whitemoonInstance === "sussurro-A" && r.content === "Host 恢复了"), "same Instance continues after recovery");
});

/* ============================ T7/T8/T9 cancel + late-result fence ============================ */

test("T7: cancel BEFORE provider final ⇒ CANCELLED state, zero success commit, no error toast", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("successSlow", 3000);
  const before = digestFiles();
  const doneP = h.askStart("慢回复，我先取消", "c-1");
  await wait(150); // 已进入 provider 请求
  h.clearMessages();
  h.stop("c-1");
  await doneP;
  const msgs = h.messages();
  assert.ok(findMsg(msgs, "pet:stopped"), "stopped surface fires");
  assert.equal(findMsg(msgs, "pet:error"), undefined, "user cancel stays silent by design");
  assert.equal(findMsg(msgs, "pet:done"), undefined, "no success surface");
  assert.deepEqual(digestFiles(), before, "cancel ⇒ zero persistence（§19 覆盖 history/bond/facts/vector）");
  const s = h.alive();
  assert.equal(s.cognition.state, "CANCELLED");
  assert.equal(s.body.state, "READY", "取消只是本轮停止，Character 仍然在");
});

test("T8: LATE result after cancel is fenced from persistence", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("lateAfterCancel", 400); // headers 秒回、正文在取消之后才到
  const before = digestFiles();
  const doneP = h.askStart("迟到回复测试", "late-1");
  await wait(60);
  h.stop("late-1");
  await doneP;
  await wait(600); // 给迟到 body 充分时间到达（若实现错误提交，此刻会写盘）
  assert.deepEqual(digestFiles(), before, "late result after cancel never reaches history/bond/facts/vector");
  assert.equal(h.alive().cognition.state, "CANCELLED");
});

test("T9: Turn A cancelled, Turn B succeeds — A's late effects never pollute B", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("successSlow", 500);
  const aP = h.askStart("A 轮会被取消", "a-1");
  await wait(50);
  h.stop("a-1");
  await aP;
  h.provider.setMode("success");
  const rowsBefore = historyLines().length;
  const bMsgs = await h.ask("B 轮会成功", "b-1");
  assert.ok(findMsg(bMsgs, "pet:done"), "B completes");
  const rows = historyLines();
  assert.equal(rows.filter((r) => String(r.content).includes("A 轮会被取消")).length, 0, "cancelled A never enters history");
  const tail = rows.slice(rowsBefore);
  assert.deepEqual(tail.map((r) => r.role), ["user", "assistant"], "B committed as a pair, exactly once");
  assert.equal(tail[0].content, "B 轮会成功");
  assert.ok(String(tail[1].content).includes("你好博士"), "no late A assistant contamination");
});

/* ============================ T16 voice + T18 legacy ============================ */

test("T16/§24: voice failure observation keeps text cognition success; VOICE layer alone degrades", async () => {
  const h = await boot({ formal: true });
  await h.ask("成功的一句（语音稍后坏）", "v-1");
  const s0 = h.alive();
  assert.equal(s0.cognition.state, "AVAILABLE");
  // renderer 真实播报结果上报（§30 source=renderer-report）：走真实 IPC listener
  h.main.handler("pet:voice-state")(h.event(), { state: "DEGRADED", detail: "engine-error", bodyIdentity: h.identity });
  const s = h.alive();
  assert.equal(s.voice.state, "DEGRADED");
  assert.equal(s.voice.source, "renderer-report");
  assert.equal(s.cognition.state, "AVAILABLE", "TTS 失败绝不把成功 cognition 回答整体标成失败（§24）");
  assert.equal(s.body.state, "READY", "文字回答保留：Character 仍活着、文本仍在气泡");
});

test("T18: legacy mode (formal disabled) — success commits, failure commits nothing, manual memory still immediate", async () => {
  const h = await boot({ formal: false });
  assert.equal(h.alive().formal.state, "DISABLED", "开关关闭 ⇒ DISABLED（非故障非健康）");
  // legacy 成功：user+assistant 成对提交（无 instance 标签）
  const msgs = await h.ask("legacy 成功一句", "l-1");
  assert.ok(findMsg(msgs, "pet:done"));
  const rows = historyLines().filter((r) => String(r.content).includes("legacy 成功一句"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].whitemoonInstance, undefined, "legacy rows remain untagged（P0-B1 T6 兼容）");
  // legacy 失败：零成功提交
  h.provider.setMode("empty200");
  const before = digestFiles();
  await h.ask("legacy 失败一句", "l-2");
  assert.deepEqual(digestFiles(), before, "legacy failure honest too: no pre-write residue");
  assert.equal(h.host.requests.length, 0, "disabled path still zero Host traffic");
});

test("§15 explicit「记住」is a user-initiated persistent action: survives a failed provider turn", async () => {
  const h = await boot({ formal: true });
  h.provider.setMode("500");
  const before = digestFiles();
  const msgs = await h.ask("记住我的体检安排在周四", "mm-1");
  assert.ok(findMsg(msgs, "pet:error"), "provider turn failed honestly");
  // turn 历史行/bond/vector：失败轮零提交
  assert.equal(digestFiles().history, before.history, "failed turn never enters normal history");
  assert.equal(digestFiles().bond, before.bond, "failed turn never bumps bond");
  assert.equal(digestFiles().vector, before.vector, "failed turn never writes vector");
  // memory.json 是唯一允许变化的文件，且只允许 manual fact（用户显式动作，§15）；
  // auto-extracted facts（规则提取）属于成功侧效应 ⇒ 不得出现
  const mem = readJsonSafe(FILES.memory);
  const facts = (mem && mem.facts) || [];
  assert.ok(facts.some((f) => f.type === "manual" && String(f.text).includes("体检安排在周四")),
    "explicit remember persists immediately even when provider fails");
  assert.ok(!facts.some((f) => String(f.text).includes("博士近期有")), "auto-derived facts NOT committed on failure");
});

/* ============================ 无总 healthy 掩盖 + 无轮询 ============================ */

test("§6/§31: health state is event-driven only — configured keyReady never marks anything AVAILABLE", async () => {
  const h = await boot({ formal: true });
  // stub config 一直 keyReady=true、Host 在线、provider success——但没发生 turn 前：
  const s = h.alive();
  assert.equal(s.cognition.state, "IDLE");
  assert.equal(s.formal.state, "UNAVAILABLE");
  // 没有 per-frame probe：boot 后不产生任何 provider 请求
  assert.equal(h.provider.captured.length, 0, "no health polling against provider");
  assert.equal(h.host.requests.length, 0, "no background Host probing（projection reads are turn-driven）");
});

/* ============================ 清理 ============================ */

after(async () => {
  if (!INFRA) return;
  const { provider, host } = INFRA;
  INFRA = null;
  provider.close(() => {}); host.close(() => {});
});

"use strict";
/* global window */ // playwright evaluate 回调序列化进 renderer 执行；本文件主体是 Node 脚本
/**
 * e2e-p0b1-formal-acceptance.js — P0-B1 实机集成验收 R1–R8（任务 §27）+ §29 性能 smoke
 *
 * 组件真实性：
 *   - 真实 Electron Body（playwright _electron；SUZURAN_TEST_USERDIR 隔离，绝不触碰真实实例）
 *   - 真实 Runtime Host 实现 + 真实 whitemoon-core 持久化（同进程装配：经 host 包作用域
 *     createRequire 注入真实 RuntimeHost/createHostServer/WhiteMoonCore；R5 的 Host 重启 =
 *     完整销毁+重建 Host 对象——Host 本就无进程态连续性，Core 文件是唯一真相（既有语义），
 *     Body 视角面对的仍是真实 HTTP surface）。
 *   - 真实 chat-client 序列化 → 本地 loopback OpenAI-compatible provider（捕获最终请求体）
 *   - 聊天经真实生产桥注入（renderer window.petAPI.ask → preload → IPC pet:ask → handleAsk）
 *
 * R1 formal chat 捕获含 canonical identity/state/relationship
 * R2 Core 合法变化（/experience Experience admission）→ 下次捕获变化
 * R3 legacy bond 改变 → canonical Relationship 输入不变
 * R4 Body 重启 → 同 Instance projection 继续（tagged 历史续用）
 * R5 Host 重启（销毁+重建）→ 同 Instance projection 继续
 * R6 Instance A→B 切换 → 请求不串数据（canonical 与对话历史均隔离）
 * R7 formal disabled → legacy chat 路径仍工作
 * R8 Host unavailable + formal enabled → 明确失败（FORMAL_PROJECTION_UNAVAILABLE），
 *    不发 provider、不写 Core、不 fake formal success
 *
 * 无 shell/子进程命令行：不 fork/spawn/exec；全部为同进程模块装配 + 真实 HTTP。
 * 路径全为模块级字面常量（无 argv/env 流入 fs）。synthetic 凭据，随机生成，绝不入库。
 *
 * 运行：node scripts/e2e-p0b1-formal-acceptance.js   （需 Electron 二进制与 GUI 会话）
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { createRequire } = require("node:module");

const { _electron } = require("playwright");

const BODY_ROOT = path.resolve(__dirname, "..");
const HOST_ROOT = path.resolve(BODY_ROOT, "..", "whitemoon-runtime-host");
const ELECTRON_EXE = path.join(BODY_ROOT, "node_modules", "electron", "dist", "electron.exe");

// 真实 Host/Core 实现注入：createRequire 锚定 host 包作用域（host 的 ESM 源码经
// Node 的 require(esm) 支持加载；'whitemoon-core' 按 host 依赖解析）。
const hostRequire = createRequire(path.join(HOST_ROOT, "package.json"));
const { WhiteMoonCore } = hostRequire("whitemoon-core");
const { RuntimeHost } = hostRequire("./src/host.js");
const { createHostServer } = hostRequire("./src/server.js");

/* ---------- 固定证据根（仓库外 work 目录；无任何外部输入） ---------- */
const OUT = path.resolve("E:", path.sep, "WhiteMoon", "work", "product-mainline-2026-10", "p0-b1-formal-cognition", "realmachine");
if (OUT === BODY_ROOT || OUT.startsWith(BODY_ROOT + path.sep)) throw new Error("证据目录必须在仓库外");

/* ---------- 全部派生路径为模块级常量 ---------- */
const RUNTIME_DIR = path.join(OUT, "runtime");
const HOST_DATA = path.join(RUNTIME_DIR, "core-data");
const USER_DATA = path.join(RUNTIME_DIR, "body-userdata");
const CHROMIUM_UDD = path.join(RUNTIME_DIR, "body-chromium");
const DOC_A = path.join(HOST_DATA, "instances", "sussurro-rm-a.json");
const DOC_B = path.join(HOST_DATA, "instances", "sussurro-rm-b.json");
const BOND_FILE = path.join(USER_DATA, "bond.json");
const BODY_CFG = path.join(USER_DATA, "config.json");
const STORAGE_MARKER = path.join(USER_DATA, ".storage-migration-v1.json");
// 隔离 userdir 缺少安装期 copy-if-missing 的 persona.md（getPersonaText 读不到会返回空，
// formal 排版就没有 LEGACY_PERSONA 块）——显式模拟安装迁移：复制内置默认人设。
const PERSONA_DEFAULT = path.join(BODY_ROOT, "persona.default.md");
const PERSONA_FILE = path.join(USER_DATA, "persona.md");
const R1_FILE = path.join(OUT, "R1-request.json");
const R2_FILE = path.join(OUT, "R2-request.json");
const EVIDENCE_FILE = path.join(OUT, "evidence.json");

// —— 测试专用 synthetic 凭据（随机生成，只活在临时目录与本进程，绝不入库）——
const HOST_TOKEN = "rm-host-" + crypto.randomBytes(16).toString("hex");
const INGRESS_TOKEN = "rm-ingress-" + crypto.randomBytes(16).toString("hex");
const INSTANCE_A = "sussurro-rm-a";
const INSTANCE_B = "sussurro-rm-b";

const evidence = [];
const latency = { chat: [] };
function log(msg) { console.log("[rm] " + msg); }
function fail(msg) {
  console.error("[rm] FAIL: " + msg);
  process.exitCode = 1;
  try { writeEvidence("failed: " + msg); } catch { /* evidence 兜底 */ }
  throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

function httpJson(method, url, { token, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: {
        ...(payload !== null ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(raw); } catch { /* keep null */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("http timeout")); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function waitFor(label, fn, { timeoutMs = 60000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last === true) return true;
    } catch (e) { last = e.message; }
    await sleep(everyMs);
  }
  fail(`${label} 未在 ${timeoutMs}ms 内满足（最后状态: ${JSON.stringify(last)}）`);
}

/* ---------- loopback OpenAI-compatible provider（捕获最终请求体） ---------- */
function startLoopbackProvider() {
  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* noop */ }
      captured.push({ at: Date.now(), url: req.url, auth: req.headers.authorization || "", body: parsed });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "收到，博士。【情绪：开心】" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      captured,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
    }));
  });
}

fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
fs.mkdirSync(HOST_DATA, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(CHROMIUM_UDD, { recursive: true });

/* ---------- 真实 Host 装配（同进程、真实 HTTP surface、真实 Core 持久化） ---------- */
async function startHostLocal(instanceId, port) {
  const host = new RuntimeHost({
    config: {
      dataDir: HOST_DATA,
      instanceId,
      packageId: "sussurro",
      hostToken: HOST_TOKEN,
      ingressToken: INGRESS_TOKEN,
      port,
      body: { baseUrl: "http://127.0.0.1:1", token: "rm-unused", timeoutMs: 2000 },
      opportunityPulse: { enabled: false }
    }
  });
  await host.start(); // 真实启动验证（loadInstance/package/semantics）
  const server = createHostServer({ host, hostToken: HOST_TOKEN, ingressToken: INGRESS_TOKEN });
  const projectionFetches = [];
  server.on("request", (req) => {
    if (req.method === "GET" && (req.url || "").startsWith("/character-projection")) projectionFetches.push(Date.now());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    host,
    baseUrl,
    port: server.address().port,
    projectionFetches,
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => { host.stop().then(resolve, resolve); });
    })
  };
}

/* ---------- 真实 Electron Body ---------- */
async function launchBody({ formal, hostUrl, providerUrl }) {
  const cfg = {
    pet: { name: "苏苏洛" },
    agreed: true, firstRun: false,
    startHidden: true, greetingOnStart: false,
    proactiveChat: false, personify: false, walking: false,
    zcodeEnabled: false,
    tts: { enabled: false }, ttsCloud: { enabled: false }, ttsCosy: { enabled: false },
    ttsGenie: { enabled: false }, ttsGsv: { enabled: false },
    features: {},
    chat: { apiType: "openai", baseUrl: providerUrl, model: "rm-loopback-gpt", apiKey: "", temperature: 0.7, maxTokens: 128, maxHistoryTurns: 8, userName: "博士" },
    agentApi: { enabled: false },
    whitemoonRuntime: { enabled: formal, baseUrl: formal ? hostUrl : "" }
  };
  fs.writeFileSync(BODY_CFG, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(STORAGE_MARKER, "{}");
  fs.copyFileSync(PERSONA_DEFAULT, PERSONA_FILE); // 模拟安装迁移：隔离 userdir 获得默认人设（LEGACY_PERSONA 块在场）
  const appEnv = { ...process.env, SUZURAN_TEST_USERDIR: USER_DATA, WHITEMOON_INGRESS_TOKEN: INGRESS_TOKEN };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.SUZURRO_AGENT_TOKEN;
  const app = await _electron.launch({
    executablePath: ELECTRON_EXE,
    args: ["--user-data-dir=" + CHROMIUM_UDD, BODY_ROOT],
    cwd: BODY_ROOT,
    env: appEnv,
    timeout: 60000
  });
  const petWin = await app.firstWindow();
  await waitFor("petAPI preload bridge", () => petWin.evaluate(() => !!(window.petAPI && typeof window.petAPI.ask === "function")), { timeoutMs: 60000 });
  await petWin.evaluate(() => {
    window.__rm = { dones: [], errors: [] };
    window.petAPI.onDone((p) => window.__rm.dones.push(p));
    window.petAPI.onError((p) => window.__rm.errors.push(p));
    return true;
  });
  return { app, petWin };
}

async function chat(petWin, text, id) {
  const before = await petWin.evaluate(() => ({ d: window.__rm.dones.length, e: window.__rm.errors.length }));
  const t0 = Date.now();
  await petWin.evaluate(({ text, id }) => window.petAPI.ask(text, id), { text, id });
  await waitFor("chat 完成 " + id, () => petWin.evaluate(({ d, e }) => {
    const s = window.__rm;
    return s.dones.length > d || s.errors.length > e;
  }, before), { timeoutMs: 45000 });
  const after = await petWin.evaluate(() => ({
    done: window.__rm.dones[window.__rm.dones.length - 1] || null,
    error: window.__rm.errors[window.__rm.errors.length - 1] || null
  }));
  latency.chat.push(Date.now() - t0);
  return after;
}

function sysTextOf(providerBody) {
  return (providerBody.messages || []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
}
function usersOf(providerBody) {
  return (providerBody.messages || []).filter((m) => m.role === "user").map((m) => m.content);
}
function relBlock(sys) {
  const i = sys.indexOf("CANONICAL_RELATIONSHIP");
  return i < 0 ? "\u0000missing" : sys.slice(i, i + 220);
}

function writeEvidence(note) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(), note,
    instances: { A: INSTANCE_A, B: INSTANCE_B },
    evidence, latencyChatMs: latency.chat
  }, null, 2));
}
function record(name, pass, details) {
  evidence.push({ name, pass, details });
  log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) { writeEvidence("failed"); fail(`${name}: ${JSON.stringify(details).slice(0, 400)}`); }
}

async function main() {
  if (!fs.existsSync(ELECTRON_EXE)) fail("Electron 二进制不存在");

  const provider = await startLoopbackProvider();
  const core = new WhiteMoonCore({ dataDir: HOST_DATA }); // 真实 Core：显式 create-instance 路径
  await core.createInstance({ instanceId: INSTANCE_A, packageId: "sussurro" });
  await core.createInstance({ instanceId: INSTANCE_B, packageId: "sussurro" });
  log("core instances created (A + B)");

  const portA = await freePort();
  const portB = await freePort();
  let hostA = await startHostLocal(INSTANCE_A, portA);
  let hostB = await startHostLocal(INSTANCE_B, portB);
  log(`hosts up: A=${hostA.port} B=${hostB.port} provider=${provider.port}`);

  let body = await launchBody({ formal: true, hostUrl: hostA.baseUrl, providerUrl: provider.baseUrl });
  try {
    /* ===== R1 ===== */
    const n0 = provider.captured.length;
    const r1 = await chat(body.petWin, "R1 实机第一轮", "rm-r1");
    if (r1.error) fail("R1 chat 失败: " + JSON.stringify(r1.error));
    await waitFor("provider 捕获 R1", () => provider.captured.length > n0, { timeoutMs: 15000 });
    fs.writeFileSync(R1_FILE, JSON.stringify(provider.captured[n0], null, 2));
    const sys1 = sysTextOf(provider.captured[n0].body);
    record("R1 formal chat ⇒ canonical identity/state/relationship 进入 provider 请求",
      sys1.includes("CANONICAL_IDENTITY") && sys1.includes(INSTANCE_A) && sys1.includes("CANONICAL_STATE") && sys1.includes("CANONICAL_RELATIONSHIP") && sys1.includes("最高优先"),
      { sysHead: sys1.slice(0, 600) });
    if (!sys1.includes("（当前无正式状态条目）")) fail("R1 fresh instance 应诚实呈现空状态投影");
    if (sys1.indexOf("CANONICAL_IDENTITY") > sys1.indexOf("LEGACY_PERSONA")) fail("R1 canonical 块必须排在旧版人设之前");
    fs.writeFileSync(R1_FILE, JSON.stringify(provider.captured[n0], null, 2));

    /* ===== R2：合法 Experience 改变 State/Relationship → 下次捕获变化 ===== */
    const exp = { id: "rm-exam-001", type: "shared-event", payload: { subject: "exam", status: "completed" } };
    const rec = await httpJson("POST", `${hostA.baseUrl}/experience`, { token: HOST_TOKEN, body: exp });
    if (rec.status !== 200 || !rec.body || rec.body.accepted !== true) fail("R2 Experience 提交失败: " + rec.raw);
    const n1 = provider.captured.length;
    const r2 = await chat(body.petWin, "R2 变化后再聊", "rm-r2");
    if (r2.error) fail("R2 chat 失败: " + JSON.stringify(r2.error));
    await waitFor("provider 捕获 R2", () => provider.captured.length > n1, { timeoutMs: 15000 });
    const sys2 = sysTextOf(provider.captured[n1].body);
    record("R2 合法 Core 变化 ⇒ 下一次 chat 反映新 State/Relationship（未动 Body persona）",
      sys2.includes('"exam"') && sys2.includes("completed") && sys2.includes("rm-exam-001") && sys2.includes("sharedHistory") && !sys2.includes("（当前无正式状态条目）"),
      { stateBlock: sys2.slice(sys2.indexOf("CANONICAL_STATE"), sys2.indexOf("CANONICAL_STATE") + 420) });
    fs.writeFileSync(R2_FILE, JSON.stringify(provider.captured[n1], null, 2));

    /* ===== R3：legacy bond 增长 ⇒ canonical Relationship 不变 ===== */
    const bondBefore = fs.existsSync(BOND_FILE) ? JSON.parse(fs.readFileSync(BOND_FILE, "utf8")) : null;
    const n2 = provider.captured.length;
    await chat(body.petWin, "R3 第三轮", "rm-r3");
    await waitFor("provider 捕获 R3", () => provider.captured.length > n2, { timeoutMs: 15000 });
    const bondAfter = JSON.parse(fs.readFileSync(BOND_FILE, "utf8"));
    if (!(bondAfter.exp > (bondBefore ? bondBefore.exp : 0))) fail("R3 前提：bond 未随聊天增长");
    const sys3 = sysTextOf(provider.captured[n2].body);
    record("R3 legacy bond 增长 ⇒ canonical Relationship 内容不变且 bond 不进 formal prompt",
      sys3.includes("CANONICAL_RELATIONSHIP") && !sys3.includes("羁绊等级") && relBlock(sys3) === relBlock(sys2),
      { bondBeforeExp: bondBefore && bondBefore.exp, bondAfterExp: bondAfter.exp });

    /* ===== R4：Body 重启 → 同 Instance projection + tagged 历史续用 ===== */
    await body.app.close();
    body = await launchBody({ formal: true, hostUrl: hostA.baseUrl, providerUrl: provider.baseUrl });
    const n3 = provider.captured.length;
    const r4 = await chat(body.petWin, "R4 重启后", "rm-r4");
    if (r4.error) fail("R4 chat 失败: " + JSON.stringify(r4.error));
    await waitFor("provider 捕获 R4", () => provider.captured.length > n3, { timeoutMs: 15000 });
    const sys4 = sysTextOf(provider.captured[n3].body);
    const users4 = usersOf(provider.captured[n3].body);
    record("R4 Body 重启 ⇒ 同 Instance projection + instance-tagged 历史续用",
      sys4.includes("CANONICAL_IDENTITY") && sys4.includes(INSTANCE_A) && sys4.includes("rm-exam-001") && users4.includes("R1 实机第一轮") && users4.includes("R2 变化后再聊"),
      { users: users4 });

    /* ===== R5：Host 重启（销毁+重建）→ 同 Instance projection 继续 ===== */
    const fetchesOldA = hostA.projectionFetches.length; // R1–R4 轮在旧 A 服务窗口的 fetch 计数（重启即失，先快照）
    await hostA.stop();
    hostA = await startHostLocal(INSTANCE_A, portA);
    await body.app.close();
    body = await launchBody({ formal: true, hostUrl: hostA.baseUrl, providerUrl: provider.baseUrl });
    const n4 = provider.captured.length;
    await chat(body.petWin, "R5 Host重启后", "rm-r5");
    await waitFor("provider 捕获 R5", () => provider.captured.length > n4, { timeoutMs: 15000 });
    const sys5 = sysTextOf(provider.captured[n4].body);
    record("R5 Host 重启 ⇒ 同 Instance projection 继续（Body 无缓存假象）", sys5.includes(INSTANCE_A) && sys5.includes("rm-exam-001"), {});

    /* ===== R6：Instance A→B 切换 → 不串数据 ===== */
    const expB = { id: "rm-booklet-b01", type: "shared-event", payload: { subject: "observation-booklet", action: "started" } };
    const recB = await httpJson("POST", `${hostB.baseUrl}/experience`, { token: HOST_TOKEN, body: expB });
    if (recB.status !== 200) fail("R6 B Experience 失败: " + recB.raw);
    await body.app.close();
    body = await launchBody({ formal: true, hostUrl: hostB.baseUrl, providerUrl: provider.baseUrl });
    const n5 = provider.captured.length;
    await chat(body.petWin, "R6 实例B专属句", "rm-r6");
    await waitFor("provider 捕获 R6", () => provider.captured.length > n5, { timeoutMs: 15000 });
    const sys6 = sysTextOf(provider.captured[n5].body);
    const users6 = usersOf(provider.captured[n5].body);
    record("R6 Instance A→B 切换 ⇒ canonical 不串 + A 会话行不进 B 请求",
      sys6.includes(INSTANCE_B) && sys6.includes("rm-booklet-b01") && !sys6.includes("rm-exam-001") && !users6.includes("R1 实机第一轮") && !users6.includes("R4 重启后"),
      { users: users6 });

    /* ===== R7：formal disabled → legacy 路径工作 ===== */
    await body.app.close();
    body = await launchBody({ formal: false, hostUrl: hostB.baseUrl, providerUrl: provider.baseUrl });
    const n6 = provider.captured.length;
    const r7 = await chat(body.petWin, "R7 关闭正式模式", "rm-r7");
    if (r7.error) fail("R7 chat 失败: " + JSON.stringify(r7.error));
    await waitFor("provider 捕获 R7", () => provider.captured.length > n6, { timeoutMs: 15000 });
    const sys7 = sysTextOf(provider.captured[n6].body);
    record("R7 formal disabled ⇒ legacy 聊天路径完整工作（无 canonical 块、无 Host 流量）",
      !sys7.includes("CANONICAL_IDENTITY") && sys7.includes("【桌宠行为规则】") && !!r7.done, {});

    /* ===== R8：Host unavailable + formal enabled → 明确失败 ===== */
    const docABefore = fs.readFileSync(DOC_A, "utf8");
    const docBBefore = fs.readFileSync(DOC_B, "utf8");
    await body.app.close();
    await hostB.stop();
    body = await launchBody({ formal: true, hostUrl: hostB.baseUrl, providerUrl: provider.baseUrl });
    const n7 = provider.captured.length;
    const r8 = await chat(body.petWin, "R8 Host 已死", "rm-r8");
    record("R8 Host unavailable + formal enabled ⇒ 明确失败 / 零 provider 请求 / Core 字节不变",
      !!r8.error && r8.error.code === "FORMAL_PROJECTION_UNAVAILABLE" && provider.captured.length === n7 &&
      fs.readFileSync(DOC_A, "utf8") === docABefore && fs.readFileSync(DOC_B, "utf8") === docBBefore,
      { error: r8.error, providerNew: provider.captured.length - n7 });

    /* ===== §29 perf smoke：每个 formal 成功轮恰一次 projection fetch（服务计数逐窗口核对） ===== */
    // 窗口账目：旧 A 服务 = R1..R4 共 4 次；新 A 服务 = R5 共 1 次；B 服务 = R6 共 1 次；
    // R7（disabled）0 次 Host 流量；R8（Host 已停）0 次成功 fetch（失败明确、不重试）。
    const fetchesNewA = hostA.projectionFetches.length;
    const fetchesB = hostB.projectionFetches.length;
    record("§29 projection fetch：formal 成功轮次 == fetch 总数 6（旧A=4/新A=1/B=1；R7 R8 零成功读，无轮询/逐 token 重读）",
      fetchesOldA === 4 && fetchesNewA === 1 && fetchesB === 1,
      { fetchesOldA, fetchesNewA, fetchesB });
    log(`chat latency samples (ms): ${latency.chat.join(", ")}`);
    writeEvidence("complete");
  } finally {
    try { await body.app.close(); } catch { /* noop */ }
    try { await hostA.stop(); } catch { /* noop */ }
    try { await hostB.stop(); } catch { /* noop */ }
    try { await provider.close(); } catch { /* noop */ }
    log("evidence written to " + OUT);
  }
  if (!process.exitCode) log("REAL-MACHINE R1–R8 + perf smoke: ALL PASS");
}

main().catch((e) => { console.error("[rm] ERROR:", (e && e.stack) || e); process.exitCode = 1; });

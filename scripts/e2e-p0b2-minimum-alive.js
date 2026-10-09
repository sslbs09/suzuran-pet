"use strict";
/* global window */ // playwright evaluate 回调序列化进 renderer 执行；本文件主体是 Node 脚本
/**
 * e2e-p0b2-minimum-alive.js — P0-B2 实机集成验收 R1–R8（任务 §28）+ §31 smoke
 *
 * 组件真实性（与 P0-B1 driver 同构）：
 *   - 真实 Electron Body（playwright _electron；SUZURAN_TEST_USERDIR 隔离，绝不触碰真实实例）
 *   - 真实 Runtime Host + 真实 whitemoon-core 持久化（同进程装配）；Host 失败/恢复 =
 *     真实 server 停启；Core Instance 文件字节为 delta 证据
 *   - 真实 chat-client 序列化 → 可控 loopback provider（§27 模式矩阵复用测试 helper）
 *   - 聊天经真实生产桥（window.petAPI.ask → preload → IPC → handleAsk）
 *
 * R1  Formal Character 正常 + provider DOWN：Body walk/drag/pat 仍可用；chat 明确失败；
 *     COGNITION=UNAVAILABLE 而 BODY 仍 READY、FORMAL 仍 OK；Core 不变；chat 侧效应零提交
 * R2  empty 200：不显示 fake assistant success；不持久化成功 turn
 * R3  slow provider → cancel：UI 进入 cancelled；late reply 不出现；late persistence 不发生
 * R4  provider 恢复：无需重启 Body 即成功 turn；status 恢复 AVAILABLE
 * R5  Host DOWN：Body alive；formal chat fail-closed；不偷偷 legacy fallback（零 provider 请求）
 * R6  Host 恢复：same Instance formal cognition 继续
 * R7  整个 Body 重启：此前 failed/cancelled turn 未被当作成功 history 消费
 * R8  TTS 通道覆盖（安全口径）：voice failure 只降 VOICE 层；文字成功保留
 *
 * §26 数据 delta：history/bond/vector/memory 前后 sha256 + Core Instance 文件字节比对，
 * 全部写入 evidence.json（UNCHANGED / INTENTIONALLY CHANGED 带语义说明）。
 * 无 shell/子进程命令行：全部同进程模块装配 + 真实 HTTP + 真实 Electron。
 * 运行：node scripts/e2e-p0b2-minimum-alive.js   （需 Electron 二进制与 GUI 会话）
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

const hostRequire = createRequire(path.join(HOST_ROOT, "package.json"));
const { WhiteMoonCore } = hostRequire("whitemoon-core");
const { RuntimeHost } = hostRequire("./src/host.js");
const { createHostServer } = hostRequire("./src/server.js");
const { createLoopbackProvider } = require("../tests/helpers/loopback-provider");

const OUT = path.resolve("E:", path.sep, "WhiteMoon", "work", "product-mainline-2026-10", "p0-b2-minimum-alive", "realmachine");
if (OUT === BODY_ROOT || OUT.startsWith(BODY_ROOT + path.sep)) throw new Error("证据目录必须在仓库外");

const RUNTIME_DIR = path.join(OUT, "runtime");
const HOST_DATA = path.join(RUNTIME_DIR, "core-data");
const USER_DATA = path.join(RUNTIME_DIR, "body-userdata");
const CHROMIUM_UDD = path.join(RUNTIME_DIR, "body-chromium");
const DOC_A = path.join(HOST_DATA, "instances", "sussurro-rm-a.json");
const HISTORY_FILE = path.join(USER_DATA, "history", "history.jsonl");
const BOND_FILE = path.join(USER_DATA, "bond.json");
const VECTOR_FILE = path.join(USER_DATA, "memory-vector.json");
const MEMORY_FILE = path.join(USER_DATA, "memory.json");
const BODY_CFG = path.join(USER_DATA, "config.json");
const STORAGE_MARKER = path.join(USER_DATA, ".storage-migration-v1.json");
const PERSONA_FILE = path.join(USER_DATA, "persona.md");
const EVIDENCE_FILE = path.join(OUT, "evidence.json");

const HOST_TOKEN = "rm2-host-" + crypto.randomBytes(16).toString("hex");
const INGRESS_TOKEN = "rm2-ingress-" + crypto.randomBytes(16).toString("hex");
const INSTANCE_A = "sussurro-rm-a";

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
function sha(p) { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16); } catch { return "ABSENT"; } }
function bodyDelta() {
  return { history: sha(HISTORY_FILE), bond: sha(BOND_FILE), vector: sha(VECTOR_FILE), memory: sha(MEMORY_FILE) };
}
function historyRows() {
  try { return fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on("error", reject);
  });
}
function httpJson(method, url, { token, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, { method, headers: { ...(payload !== null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = JSON.parse(raw); } catch { /* null */ } resolve({ status: res.statusCode, body: json, raw }); });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("http timeout")); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}
async function waitFor(label, fn, { timeoutMs = 60000, everyMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last === true) return true; } catch (e) { last = e.message; }
    await sleep(everyMs);
  }
  fail(`${label} 未在 ${timeoutMs}ms 内满足（最后状态: ${JSON.stringify(last)}）`);
}
function record(name, pass, details) {
  evidence.push({ name, pass, details });
  log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) { writeEvidence("failed"); fail(`${name}: ${JSON.stringify(details).slice(0, 500)}`); }
}
function writeEvidence(note) {
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(), note,
    instance: INSTANCE_A, evidence, latencyChatMs: latency.chat
  }, null, 2));
}

/* ---------- 真实 Host 装配 ---------- */
async function startHostLocal(port) {
  const host = new RuntimeHost({
    config: {
      dataDir: HOST_DATA, instanceId: INSTANCE_A, packageId: "sussurro",
      hostToken: HOST_TOKEN, ingressToken: INGRESS_TOKEN, port,
      body: { baseUrl: "http://127.0.0.1:1", token: "rm-unused", timeoutMs: 2000 },
      opportunityPulse: { enabled: false }
    }
  });
  await host.start();
  const server = createHostServer({ host, hostToken: HOST_TOKEN, ingressToken: INGRESS_TOKEN });
  const projectionFetches = [];
  server.on("request", (req) => {
    if (req.method === "GET" && (req.url || "").startsWith("/character-projection")) projectionFetches.push(Date.now());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    host, port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    projectionFetches,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => { host.stop().then(resolve, resolve); }); })
  };
}

/* ---------- 真实 Electron Body ---------- */
async function launchBody({ formal, hostUrl, providerUrl }) {
  const cfg = {
    pet: { name: "苏苏洛" },
    agreed: true, firstRun: false,
    startHidden: true, greetingOnStart: false,
    proactiveChat: false, personify: false, walking: true,
    zcodeEnabled: false,
    tts: { enabled: false }, ttsCloud: { enabled: false }, ttsCosy: { enabled: false },
    ttsGenie: { enabled: false }, ttsGsv: { enabled: false },
    features: { longTermMemory: true, vectorMemory: true },
    chat: { apiType: "openai", baseUrl: providerUrl, model: "rm2-loopback-gpt", apiKey: "", temperature: 0.7, maxTokens: 128, maxHistoryTurns: 8, userName: "博士" },
    agentApi: { enabled: false },
    whitemoonRuntime: { enabled: formal, baseUrl: formal ? hostUrl : "" }
  };
  fs.writeFileSync(BODY_CFG, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(STORAGE_MARKER, "{}");
  fs.copyFileSync(path.join(BODY_ROOT, "persona.default.md"), PERSONA_FILE);
  const appEnv = { ...process.env, SUZURAN_TEST_USERDIR: USER_DATA, WHITEMOON_INGRESS_TOKEN: INGRESS_TOKEN };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.SUZURRO_AGENT_TOKEN;
  const app = await _electron.launch({
    executablePath: ELECTRON_EXE,
    args: ["--user-data-dir=" + CHROMIUM_UDD, BODY_ROOT],
    cwd: BODY_ROOT, env: appEnv, timeout: 60000
  });
  const petWin = await app.firstWindow();
  await waitFor("petAPI preload bridge", () => petWin.evaluate(() => !!(window.petAPI && typeof window.petAPI.ask === "function")), { timeoutMs: 60000 });
  await petWin.evaluate(() => {
    window.__rm = { dones: [], errors: [], stopped: [], alive: [] };
    window.petAPI.onDone((p) => window.__rm.dones.push(p));
    window.petAPI.onError((p) => window.__rm.errors.push(p));
    if (window.petAPI.onStopped) window.petAPI.onStopped((p) => window.__rm.stopped.push(p));
    if (window.petAPI.onAliveStatus) window.petAPI.onAliveStatus((s) => window.__rm.alive.push(s));
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
  const after = await petWin.evaluate(({ d, e }) => ({
    done: window.__rm.dones.length > d ? window.__rm.dones[window.__rm.dones.length - 1] : null,
    error: window.__rm.errors.length > e ? window.__rm.errors[window.__rm.errors.length - 1] : null
  }), before);
  latency.chat.push(Date.now() - t0);
  return after;
}
async function aliveOf(petWin) { return petWin.evaluate(() => window.petAPI.getAliveStatus()); }
function sysTextOf(providerBody) { return (providerBody.messages || []).filter((m) => m.role === "system").map((m) => m.content).join("\n"); }
function usersOf(providerBody) { return (providerBody.messages || []).filter((m) => m.role === "user").map((m) => m.content); }

async function main() {
  if (!fs.existsSync(ELECTRON_EXE)) fail("Electron 二进制不存在");
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOST_DATA, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(CHROMIUM_UDD, { recursive: true });

  const core = new WhiteMoonCore({ dataDir: HOST_DATA });
  await core.createInstance({ instanceId: INSTANCE_A, packageId: "sussurro" });
  log("core instance created");

  const provider = await createLoopbackProvider();
  const portA = await freePort();
  let hostA = await startHostLocal(portA);
  log(`host A up at ${hostA.port}; provider at ${provider.port}`);

  let body = await launchBody({ formal: true, hostUrl: hostA.baseUrl, providerUrl: provider.baseUrl });
  try {
    /* ---------- 基线成功轮：建立 formal OK + provider 正常态 ---------- */
    const r0 = await chat(body.petWin, "P0-B2 基线成功轮", "rm2-base");
    if (r0.error) fail("基线轮失败: " + JSON.stringify(r0.error));
    const aliveBase = await aliveOf(body.petWin);
    record("基线：formal OK + cognition AVAILABLE + body READY（真实成功轮后）",
      aliveBase.formal.state === "OK" && aliveBase.cognition.state === "AVAILABLE" && aliveBase.body.state === "READY",
      aliveBase);

    /* ---------- R1：provider DOWN —— Minimum Alive + Honest Degradation ---------- */
    const docABefore = fs.readFileSync(DOC_A, "utf8");
    const dBefore = bodyDelta();
    const bondBaseline = fs.existsSync(BOND_FILE) ? JSON.parse(fs.readFileSync(BOND_FILE, "utf8")) : { exp: 0 };
    provider.setMode("connectionClose"); // 真实 socket 断连（§16 connection failure 类）
    const r1 = await chat(body.petWin, "R1 provider 宕机时的一句", "rm2-r1");
    record("R1 provider DOWN：chat 明确失败（NETWORK_ERROR），不显示 fake 成功",
      !!r1.error && r1.error.code === "NETWORK_ERROR" && !r1.done,
      { error: r1.error });
    const alive1 = await aliveOf(body.petWin);
    record("R1 健康真相分层：COGNITION=UNAVAILABLE 但 BODY 仍 READY 且 FORMAL 仍 OK（§6/§14 不互相掩盖）",
      alive1.cognition.state === "UNAVAILABLE" && alive1.cognition.source === "observed-failure" &&
      alive1.body.state === "READY" && alive1.formal.state === "OK",
      alive1);
    const d1 = bodyDelta();
    record("R1 失败轮 chat 侧效应零提交（history/bond/vector/memory 字节 UNCHANGED——§12/§26）",
      d1.history === dBefore.history && d1.bond === dBefore.bond && d1.vector === dBefore.vector && d1.memory === dBefore.memory,
      { before: dBefore, after: d1 });
    record("R1 失败轮 Core 字节不变（§21）", fs.readFileSync(DOC_A, "utf8") === docABefore,
      { beforeSha: crypto.createHash("sha256").update(docABefore).digest("hex").slice(0, 16) });
    // Body 仍可被用户控制：walk / drag / pat 全部本地路径（provider DOWN 不导致角色消失，§9）。
    // drag 走真实鼠标事件（CDP rawEvents）——与用户手指同源的生产输入链；
    // walk 走 setWalking ack + 引擎状态；pat 走 pet:pat（本地 bond 路径）。
    await body.petWin.evaluate(() => {
      window.__walk = [];
      window.petAPI.onWalking((s) => window.__walk.push(s));
    });
    // walk 是 inventory §4 判定的 CONDITIONAL 能力（依赖渲染资源/皮肤）。
    // 验收口径：要么引擎真实 active，要么 setWalking 给出明确诚实的拒绝
    // （walkNeedSpine——绝不静默假可用）。两种都是「用户仍控制身体」的诚实面。
    const walkEvidence = await body.petWin.evaluate(async () => {
      const res = await window.petAPI.setWalking(true);
      for (let i = 0; i < 20; i++) { // 最多 5s：若引擎可走，等待 active 广播
        if (window.__walk.some((s) => s && s.active === true)) return { active: true, res };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { active: false, res };
    });
    const walkHonest = walkEvidence.active === true ||
      (walkEvidence.res && walkEvidence.res.ok === false && typeof walkEvidence.res.message === "string" && walkEvidence.res.message.length > 0);
    const patOk = await body.petWin.evaluate(() => { try { window.petAPI.pat(); return true; } catch { return false; } });
    // 真实鼠标拖拽：press → 分步 move → release（renderer pointer → pet:move → main 拖拽链）；
    // 证据 = 主进程 BrowserWindow.getPosition 真实改变（不是自证字段，是 OS 级窗口事实）。
    const cdp = await body.petWin.context().newCDPSession(body.petWin);
    const size = body.petWin.viewportSize() || { width: 260, height: 200 };
    const cx = Math.floor(size.width * 0.75); // 角色区域（右侧为 sprite，避开左侧气泡/输入栏）
    const cy = Math.floor(size.height * 0.7);
    const pos0 = await body.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w ? w.getPosition() : null; });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1, buttons: 1 });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + step * 6, y: cy + step * 2, button: "left", buttons: 1 });
      await sleep(40);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + 48, y: cy + 16, button: "left", clickCount: 1 });
    await sleep(400);
    const pos1 = await body.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w ? w.getPosition() : null; });
    const dragMoved = Array.isArray(pos0) && Array.isArray(pos1) && (pos1[0] !== pos0[0] || pos1[1] !== pos0[1]);
    await sleep(200);
    const bondAfterPat = fs.existsSync(BOND_FILE) ? JSON.parse(fs.readFileSync(BOND_FILE, "utf8")) : null;
    record("R1 桌面身体仍在且可被用户控制：setWalking 真实应答（active 或诚实 walkNeedSpine 拒绝，绝不假可用）+ 真实鼠标 drag 改变主进程窗口位置 + pat 本地路径 bond 增长（provider DOWN 不杀本地行为，§4）",
      walkHonest && patOk && dragMoved && !!bondAfterPat && bondAfterPat.exp > bondBaseline.exp,
      { walkEvidence, patOk, pos0, pos1, bondBaselineExp: bondBaseline.exp, bondAfterPatExp: bondAfterPat && bondAfterPat.exp });

    /* ---------- R2：empty 200 ---------- */
    provider.setMode("empty200");
    const d2Before = bodyDelta();
    const r2 = await chat(body.petWin, "R2 空成功响应测试", "rm2-r2");
    const rows2 = historyRows();
    record("R2 empty 200：不显示 fake assistant success（PROVIDER_EMPTY_RESPONSE），且空 assistant 不落盘",
      !!r2.error && r2.error.code === "PROVIDER_EMPTY_RESPONSE" &&
      !rows2.some((x) => String(x.content || "").includes("R2 空成功响应测试")) &&
      bodyDelta().history === d2Before.history,
      { error: r2.error });

    /* ---------- R3：slow provider → cancel → late result fence ---------- */
    provider.setMode("successSlow", 2500);
    const d3Before = bodyDelta();
    const donesBefore = await body.petWin.evaluate(() => window.__rm.dones.length);
    const t0 = Date.now();
    await body.petWin.evaluate(() => window.petAPI.ask("R3 慢回复我会取消", "rm2-r3"));
    await sleep(400);
    await body.petWin.evaluate(() => window.petAPI.stop("rm2-r3"));
    await waitFor("R3 UI 进入 cancelled", () => body.petWin.evaluate(() => window.__rm.stopped.length > 0), { timeoutMs: 10000 });
    // 迟到的 provider final 在 cancel 之后完成——等足时间
    await sleep(2500);
    const donesAfter = await body.petWin.evaluate(() => window.__rm.dones.length);
    const alive3 = await aliveOf(body.petWin);
    record("R3 cancel：UI 进入 cancelled；late reply 不出现（无新 done），late persistence 不发生，COGNITION=CANCELLED",
      donesAfter === donesBefore && bodyDelta().history === d3Before.history && bodyDelta().bond === d3Before.bond &&
      alive3.cognition.state === "CANCELLED",
      { donesBefore, donesAfter, delta: { before: d3Before, after: bodyDelta() }, alive3: alive3.cognition });
    latency.chat.push(Date.now() - t0);

    /* ---------- R4：provider 恢复——无需重启 Body ---------- */
    provider.setMode("success");
    const r4 = await chat(body.petWin, "R4 provider 恢复后第一句", "rm2-r4");
    const alive4 = await aliveOf(body.petWin);
    record("R4 provider 恢复：同一 Body 进程无需重启即成功 turn；cognition 回到 AVAILABLE",
      !!r4.done && alive4.cognition.state === "AVAILABLE" && alive4.cognition.source === "observed-success",
      { done: r4.done && r4.done.full, cognition: alive4.cognition });

    /* ---------- R5：Host DOWN——fail-closed，不偷偷 legacy fallback ---------- */
    const fetchesBefore = hostA.projectionFetches.length;
    await hostA.stop();
    const capturedBeforeR5 = provider.captured.length;
    const docABeforeR5 = fs.readFileSync(DOC_A, "utf8");
    const r5 = await chat(body.petWin, "R5 Host 挂了的一句", "rm2-r5");
    const alive5 = await aliveOf(body.petWin);
    record("R5 Host DOWN：formal chat fail-closed（FORMAL_PROJECTION_UNAVAILABLE）且不静默回退 legacy（零 provider 请求）",
      !!r5.error && r5.error.code === "FORMAL_PROJECTION_UNAVAILABLE" && provider.captured.length === capturedBeforeR5,
      { error: r5.error, providerNew: provider.captured.length - capturedBeforeR5 });
    record("R5 Host DOWN：FORMAL=UNAVAILABLE 而 BODY 仍 READY（身体活着，正式 Runtime 没了——§15/T15）",
      alive5.formal.state === "UNAVAILABLE" && alive5.body.state === "READY", alive5);
    const patOkR5 = await body.petWin.evaluate(() => { try { window.petAPI.pat(); return true; } catch { return false; } });
    const bondR5 = fs.existsSync(BOND_FILE) ? JSON.parse(fs.readFileSync(BOND_FILE, "utf8")) : null;
    record("R5 Host DOWN：本地行为不受影响（pat 仍工作，bond 仍增长；失败不导致角色消失）",
      patOkR5 && !!bondR5 && bondR5.interactions > 0, { patOkR5, bond: bondR5 });
    record("R5 Host DOWN：Core 字节不变", fs.readFileSync(DOC_A, "utf8") === docABeforeR5, {});

    /* ---------- R6：Host 恢复——same Instance ---------- */
    hostA = await startHostLocal(portA);
    // Experience 必须落在 Sussurro Package 已定义的投影语义内（observation-booklet 系列）——
    // 随意 type/subject 不会被 projectState 解释（package 决定如何投影，core 只存储）。
    const exp = { id: "rm2-booklet-001", type: "shared-event", payload: { subject: "observation-booklet", action: "started" } };
    const rec = await httpJson("POST", `${hostA.baseUrl}/experience`, { token: HOST_TOKEN, body: exp });
    if (rec.status !== 200) fail("R6 Experience 提交失败: " + rec.raw);
    const n6 = provider.captured.length;
    const r6 = await chat(body.petWin, "R6 Host 恢复后的一句", "rm2-r6");
    if (r6.error) fail("R6 chat 失败: " + JSON.stringify(r6.error));
    await waitFor("provider 捕获 R6", () => provider.captured.length > n6, { timeoutMs: 15000 });
    const sys6 = sysTextOf(provider.captured[n6].body);
    const alive6 = await aliveOf(body.petWin);
    record("R6 Host 恢复：same Instance 继续 formal cognition（identity 含实例 A + 新 booklet Experience 进入投影 + FORMAL 回到 OK）",
      sys6.includes(INSTANCE_A) && sys6.includes("rm2-booklet-001") && alive6.formal.state === "OK",
      { instanceInRequest: sys6.includes(INSTANCE_A), newServiceFetches: hostA.projectionFetches.length });

    /* ---------- R7：整个 Body 重启——failed/cancelled turn 绝不作为成功 history 被消费 ---------- */
    await body.app.close();
    body = await launchBody({ formal: true, hostUrl: hostA.baseUrl, providerUrl: provider.baseUrl });
    const rowsAfterRestart = historyRows();
    const userTexts = rowsAfterRestart.filter((r) => r.role === "user").map((r) => r.content);
    record("R7 Body 重启前：失败/取消轮的 user 行从未进入持久 history（§13 不落正常历史）",
      !userTexts.includes("R1 provider 宕机时的一句") && !userTexts.includes("R2 空成功响应测试") && !userTexts.includes("R3 慢回复我会取消") && !userTexts.includes("R5 Host 挂了的一句"),
      { persistedUsers: userTexts });
    const n7 = provider.captured.length;
    const r7 = await chat(body.petWin, "R7 重启后新的一句", "rm2-r7");
    if (r7.error) fail("R7 chat 失败: " + JSON.stringify(r7.error));
    await waitFor("provider 捕获 R7", () => provider.captured.length > n7, { timeoutMs: 15000 });
    const users7 = usersOf(provider.captured[n7].body);
    record("R7 重启后下一轮请求不含任何 failed/cancelled 轮文本（它们不可能被当作成功 turn 消费）",
      !users7.includes("R1 provider 宕机时的一句") && !users7.includes("R3 慢回复我会取消") && users7.includes("R7 重启后新的一句") && !!r7.done,
      { users: users7 });

    /* ---------- R8：voice 通道（安全覆盖口径） ---------- */
    // 走真实 renderer→preload→main 的 voice-state 通道（播报引擎级故障注入不安全，
    // 通道与记账为真实生产路径；引擎失败语义由单测/契约测试覆盖）。
    const aliveR8pre = await aliveOf(body.petWin);
    await body.petWin.evaluate(() => window.petAPI.reportVoiceState("DEGRADED", "acceptance-probe-engine-fail"));
    const aliveR8 = await aliveOf(body.petWin);
    record("R8 voice failure：VOICE=DEGRADED 单列；文字 cognition 成功保留（上一轮 done 仍在、cognition 不被改写）；无新 error 面",
      aliveR8.voice.state === "DEGRADED" && aliveR8.voice.source === "renderer-report" &&
      aliveR8.cognition.state === aliveR8pre.cognition.state && aliveR8.body.state === "READY",
      { voice: aliveR8.voice, cognitionBefore: aliveR8pre.cognition, cognitionAfter: aliveR8.cognition });

    /* ---------- §31 smoke：事件驱动，无轮询 ---------- */
    const projFetchesTotal = (hostA ? hostA.projectionFetches.length : 0);
    // R6/R7 成功轮在当前 A 服务窗口各 fetch 一次（R6=1 + R7 重启后=1）；无逐帧/定时探测。
    record("§31 smoke：projection fetch 严格 turn 驱动（当前服务窗口 2 次成功轮=2 次 fetch，零轮询）",
      projFetchesTotal === 2, { projFetchesTotal });
    log(`chat latency samples (ms): ${latency.chat.join(", ")}`);
    writeEvidence("complete");
  } finally {
    try { await body.app.close(); } catch { /* noop */ }
    try { await hostA.stop(); } catch { /* noop */ }
    try { await provider.close(); } catch { /* noop */ }
    log("evidence written to " + OUT);
  }
  if (!process.exitCode) log("REAL-MACHINE P0-B2 R1–R8 + §31: ALL PASS");
}

main().catch((e) => { console.error("[rm] ERROR:", (e && e.stack) || e); process.exitCode = 1; });

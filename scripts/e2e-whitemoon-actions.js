"use strict";
/**
 * e2e-whitemoon-actions.js — M2 真实 Sussurro Process E2E（E1–E9 + T25 + 能力真实）
 *
 * 真实组件全部在场，无 mock：
 *   - 真实 whitemoon-core（临时 dataDir，CLI create-instance）
 *   - 真实 Runtime Host 进程（../whitemoon-runtime-host/src/main.js serve）
 *   - 真实 Sussurro Adapter（Host 生产默认构造，file: 依赖）
 *   - 真实 Electron Body（本仓库，独立测试 userdir，真实 Agent API + 真实 renderer）
 *
 * 证明：
 *   E1 Host 发出真实 speak Intent；E2 Core intentId 真实抵达并被 Body 按原样保管
 *   （按 intentId 的 interrupt 探测 found/not-found）；E3 同步结果诚实 accepted
 *   /ack-only（能力来自真实 Body 的 GET /capabilities，绝非伪造 completed）；
 *   E4 Core 终态符合现行 ack-only 语义；E5 同 intentId 重放 = duplicate 零二次
 *   副作用；E6 同 intentId 换 payload = 409 conflict；E7 不同 intentId 同文本
 *   走合法新动作路径（被文本闸门如实拦截，而不是被 Intent 幂等错杀）；
 *   E8 未声明动作诚实 unsupported；E9 renderer reload 后真实 speak 仍正常；
 *   T25 Host master token 绝不出现在 Body 的任何环境/落盘文件。
 *
 * 运行：node scripts/e2e-whitemoon-actions.js（需要 Electron 二进制与 GUI 会话）
 */

const { fork } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { _electron } = require("playwright");

const BODY_ROOT = path.join(__dirname, "..");
const HOST_ROOT = path.resolve(BODY_ROOT, "..", "whitemoon-runtime-host");
const HOST_MAIN = path.join(HOST_ROOT, "src", "main.js");
const E2E_DIR = path.join(BODY_ROOT, ".whitemoon-actions-e2e");

const HOST_TOKEN = "e2e-host-" + crypto.randomBytes(16).toString("hex");
const AGENT_TOKEN = "e2e-agent-" + crypto.randomBytes(16).toString("hex");

function log(msg) { console.log("[e2e] " + msg); }
function fail(msg) { console.error("[e2e] FAIL: " + msg); process.exitCode = 1; throw new Error(msg); }
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
        try { json = JSON.parse(raw); } catch { /* 保留 null */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("http timeout")); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function waitFor(label, fn, { timeoutMs = 60000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last === true) { log(`ok: ${label}`); return; }
    } catch (e) { last = e.message; }
    await sleep(everyMs);
  }
  fail(`${label} 未在 ${timeoutMs}ms 内满足（最后状态: ${JSON.stringify(last)}）`);
}

async function main() {
  if (!fs.existsSync(path.join(BODY_ROOT, "node_modules", "electron", "dist", "electron.exe"))) {
    fail("Electron 二进制不存在（先 npm install）");
  }
  if (!fs.existsSync(HOST_MAIN)) fail("找不到 Runtime Host: " + HOST_MAIN);

  fs.rmSync(E2E_DIR, { recursive: true, force: true });
  const userData = path.join(E2E_DIR, "body-userdata");
  const chromiumUdd = path.join(E2E_DIR, "body-chromium");
  const hostData = path.join(E2E_DIR, "host-data");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(chromiumUdd, { recursive: true });
  fs.mkdirSync(hostData, { recursive: true });

  const agentPort = await freePort();
  const agentUrl = `http://127.0.0.1:${agentPort}`;

  /* ============ 1. 真实 Runtime Host 进程（pulse 关闭：本轮全部显式触发） ============ */
  const hostConfigPath = path.join(E2E_DIR, "host-config.json");
  fs.writeFileSync(hostConfigPath, JSON.stringify({
    dataDir: hostData,
    instanceId: "sussurro-e2e-actions",
    packageId: "sussurro",
    host: { port: 0 },
    body: { baseUrl: agentUrl, token: AGENT_TOKEN, timeoutMs: 8000 }
  }, null, 2));

  const cliEnv = { ...process.env, WHITEMOON_HOST_TOKEN: HOST_TOKEN };
  delete cliEnv.ELECTRON_RUN_AS_NODE;
  delete cliEnv.SUZURRO_AGENT_TOKEN;

  const created = await new Promise((resolve, reject) => {
    const child = fork(HOST_MAIN, ["create-instance", "--config", hostConfigPath], { silent: true, env: cliEnv });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => code === 0 ? resolve(out.trim().split("\n").pop()) : reject(new Error("create-instance 失败: " + out)));
  });
  log("create-instance: " + created);

  const host = await new Promise((resolve, reject) => {
    const child = fork(HOST_MAIN, ["serve", "--config", hostConfigPath], { silent: true, env: cliEnv });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
      const line = out.split("\n").find((l) => l.startsWith('{"event":"listening"'));
      if (line) resolve({ child, listening: JSON.parse(line), stderr: () => err });
    });
    child.stderr.on("data", (c) => (err += c));
    child.on("exit", (code) => {
      if (!out.includes('"event":"listening"')) reject(new Error(`Host 提前退出 (${code}): ${err}`));
    });
    setTimeout(() => reject(new Error("Host 启动超时")), 20000).unref?.();
  });
  const hostUrl = `http://127.0.0.1:${host.listening.port}`;
  log("host listening: " + hostUrl);

  /* ============ 2. 真实 Electron Body（独立 userdir；与运行中实例互不干扰） ============ */
  const bodyConfig = {
    pet: { name: "苏苏洛" },
    agreed: true,
    firstRun: false,
    startHidden: true,
    greetingOnStart: false,
    proactiveChat: false,
    personify: false,
    walking: false,
    zcodeEnabled: false,
    tts: { enabled: false },
    ttsCloud: { enabled: false },
    ttsCosy: { enabled: false },
    ttsGenie: { enabled: false },
    ttsGsv: { enabled: false },
    agentApi: { enabled: true, port: agentPort, bearerToken: AGENT_TOKEN, statusEnabled: true, clients: [] },
    whitemoonRuntime: { enabled: false, baseUrl: hostUrl }
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(bodyConfig, null, 2));
  fs.writeFileSync(path.join(userData, ".storage-migration-v1.json"), "{}");

  const appEnv = { ...process.env, SUZURAN_TEST_USERDIR: userData };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.SUZURRO_AGENT_TOKEN;
  delete appEnv.WHITEMOON_HOST_TOKEN; // T25: Host master token 绝不随环境进入 Body 进程
  if (Object.keys(appEnv).some((k) => /HOST_TOKEN/i.test(k))) fail("T25: Body 进程环境出现 Host master token 痕迹");

  const app = await _electron.launch({
    executablePath: path.join(BODY_ROOT, "node_modules", "electron", "dist", "electron.exe"),
    args: ["--user-data-dir=" + chromiumUdd, BODY_ROOT],
    cwd: BODY_ROOT,
    env: appEnv,
    timeout: 60000
  });
  log("electron body launched");

  let exitCode = 0;
  try {
    await waitFor("agent api /health", async () => {
      const r = await httpJson("GET", `${agentUrl}/health`, { timeoutMs: 2000 });
      return r.status === 200 && r.body && r.body.ok === true;
    }, { timeoutMs: 60000 });

    const petWin = await app.firstWindow();
    await waitFor("pet bubble dom", async () =>
      await petWin.evaluate(() => !!document.getElementById("bubble-text")));

    /* ---- 能力真实（T1-T4 在真实进程上的对应体）---- */
    const caps = await httpJson("GET", `${agentUrl}/capabilities`, { token: AGENT_TOKEN });
    if (caps.status !== 200) fail("GET /capabilities 应 200，实际 " + caps.status);
    if (caps.body.protocolVersion !== 1) fail("真实 Body 必须声明 protocolVersion 1");
    if (typeof caps.body.bodyImplementationId !== "string" || !caps.body.bodyImplementationId.includes("v")) fail("bodyImplementationId 必须是带版本的实现身份");
    if (caps.body.bodyImplementationId.includes("sussurro-e2e-actions")) fail("能力声明混入了 Character Instance 身份");
    const speakCap = (caps.body.supportedActions || []).find((a) => a.type === "speak");
    if (!speakCap || speakCap.feedbackMode !== "ack-only" || speakCap.interruptible !== false || speakCap.idempotency !== "supported") {
      fail(`真实 speak 能力必须如实为 ack-only / interruptible:false / idempotency:supported，实际 ${JSON.stringify(speakCap)}`);
    }
    log("capability truth: " + JSON.stringify(caps.body));

    /* ---- E1/E2/E3/E4：Core 发起真实 speak，intentId 贯穿，ack-only 诚实闭合 ---- */
    const EXAM = { id: "exp-exam-complete-001", type: "shared-event", payload: { subject: "exam", status: "completed" } };
    const recA = await httpJson("POST", `${hostUrl}/experience`, { token: HOST_TOKEN, body: EXAM });
    if (recA.status !== 200) fail("record exam experience: " + recA.raw);
    const roundA = await httpJson("POST", `${hostUrl}/opportunity`, { token: HOST_TOKEN, body: { type: "idle-opportunity" } });
    const decisionA = roundA.body.decision;
    const executionA = roundA.body.execution;
    if (decisionA.type !== "speak") fail("E1 真实 speak intent，实际 " + decisionA.type);
    if (executionA.status !== "accepted") fail("E3 真实 speak 必须 accepted，实际 " + JSON.stringify(executionA));
    if (executionA.feedbackMode !== "ack-only") fail("E3 ack-only 契约必须来自真实能力，实际 " + executionA.feedbackMode);
    if (executionA.status === "completed") fail("绝不伪造 completed");
    // E2：interrupt 探测证明「Core 的原样 intentId 抵达并被 Body 保管」
    const probeKnown = await httpJson("POST", `${agentUrl}/actions/${encodeURIComponent(decisionA.intentId)}/interrupt`, { token: AGENT_TOKEN, body: { protocolVersion: 1 } });
    if (probeKnown.status !== 200 || probeKnown.body.result !== "not-interruptible") fail("E2 真实 speak 应按 intentId found 且如实 not-interruptible: " + probeKnown.raw);
    const probeGhost = await httpJson("POST", `${agentUrl}/actions/ghost-intent-${crypto.randomUUID()}/interrupt`, { token: AGENT_TOKEN, body: { protocolVersion: 1 } });
    if (probeGhost.body.result !== "not-found") fail("E2 陌生 intentId 必须 not-found: " + probeGhost.raw);
    // 气泡真实可见（renderer 消费 pet:proactive）
    await waitFor("bubble shows exam line", async () => {
      const text = await petWin.evaluate(() => document.getElementById("bubble-text").textContent);
      return typeof text === "string" && text.includes("考试已经结束");
    }, { timeoutMs: 15000 });
    // E4：Core 终态 = 现行 ack-only 语义（以 Core 实现为准：槽位闭合、事实保持 accepted）
    const docA = JSON.parse(fs.readFileSync(path.join(hostData, "instances", "sussurro-e2e-actions.json"), "utf8"));
    if (docA.activeIntent !== undefined) fail("E4 ack-only 必须结束 Core 等待（现行语义），实际 activeIntent 仍在");
    if (docA.lastExecution.outcome !== "accepted") fail("E4 lastExecution 应保持 accepted 不被升级，实际 " + docA.lastExecution.outcome);
    if (docA.lastExecution.feedbackMode !== "ack-only") fail("E4 ack-only 契约必须落在事实里");
    if (docA.lastExecution.intentId !== decisionA.intentId) fail("E4 闭合的必须是同一个 Core intentId");
    log("E1-E4 pass: real speak, intentId verbatim, honest ack-only closure");

    /* ---- E5/E6/E7：intentId 幂等 vs 文本闸门的分界（真实进程） ---- */
    const P1 = { text: "幂等链路验证台词", emotion: "happy", force: true };
    const idem1 = "e2e-idem-" + crypto.randomUUID();
    const first = await httpJson("POST", `${agentUrl}/actions`, { token: AGENT_TOKEN, body: { protocolVersion: 1, intentId: idem1, actionType: "speak", payload: P1 } });
    if (first.body.result !== "accepted" || first.body.dispatched !== true) fail("E5 首次受理应 accepted: " + first.raw);
    await waitFor("bubble shows idempotent line", async () => {
      const text = await petWin.evaluate(() => document.getElementById("bubble-text").textContent);
      return typeof text === "string" && text.includes("幂等链路验证台词");
    }, { timeoutMs: 15000 });
    const replay = await httpJson("POST", `${agentUrl}/actions`, { token: AGENT_TOKEN, body: { protocolVersion: 1, intentId: idem1, actionType: "speak", payload: P1 } });
    if (replay.body.result !== "duplicate" || replay.body.dispatched !== false) fail("E5 同 intentId 同 payload 重放必须 duplicate 零副作用: " + replay.raw);
    const conflict = await httpJson("POST", `${agentUrl}/actions`, { token: AGENT_TOKEN, body: { protocolVersion: 1, intentId: idem1, actionType: "speak", payload: { text: "同标识换内容", emotion: "happy", force: true } } });
    if (conflict.status !== 409 || conflict.body.result !== "conflict") fail("E6 同 intentId 换 payload 必须 409 conflict: " + conflict.raw);
    // E7：不同 intentId、相同文本 —— 不是 duplicate/conflict；真实文本闸门如实拦截重复台词。
    const other = await httpJson("POST", `${agentUrl}/actions`, { token: AGENT_TOKEN, body: { protocolVersion: 1, intentId: "e2e-idem-" + crypto.randomUUID(), actionType: "speak", payload: P1 } });
    if (other.body.result === "duplicate" || other.body.result === "conflict") fail("E7 不同 intentId 被幂等错杀: " + other.raw);
    if (other.body.result !== "rejected" || other.body.reason !== "line-gate-rejected") fail("E7 不同 intentId 相同文本必须走新动作路径（由文本闸门如实去重）: " + other.raw);
    log("E5-E7 pass: replay=duplicate(0 side effect), conflict=409, fresh-id-not-killed-by-idempotency");

    /* ---- E8：未声明动作诚实 unsupported ---- */
    const dance = await httpJson("POST", `${agentUrl}/actions`, { token: AGENT_TOKEN, body: { protocolVersion: 1, intentId: "e2e-dance-" + crypto.randomUUID(), actionType: "dance", payload: {} } });
    if (dance.body.result !== "unsupported") fail("E8 未声明动作必须诚实 unsupported: " + dance.raw);

    /* ---- E9：renderer reload 后真实 speak 仍正常 ---- */
    await petWin.reload();
    await waitFor("pet bubble dom after reload", async () =>
      await petWin.evaluate(() => !!document.getElementById("bubble-text")));
    const entry1 = {
      id: "exp-booklet-entry-001",
      type: "shared-event",
      payload: { subject: "observation-booklet", action: "entry-added", entryKey: "entry-1", noteKind: "change" }
    };
    const recE = await httpJson("POST", `${hostUrl}/experience`, { token: HOST_TOKEN, body: entry1 });
    if (recE.status !== 200) fail("E9 record entry-1: " + recE.raw);
    const roundE = await httpJson("POST", `${hostUrl}/opportunity`, { token: HOST_TOKEN, body: { type: "idle-opportunity" } });
    if (roundE.body.execution.status !== "accepted") fail("E9 reload 后真实 speak 必须仍可 accepted: " + JSON.stringify(roundE.body.execution));
    await waitFor("bubble shows line after reload", async () => {
      const text = await petWin.evaluate(() => document.getElementById("bubble-text").textContent);
      return typeof text === "string" && text.length > 0 && /第1条|第一条|变化/.test(text);
    }, { timeoutMs: 20000 });
    log("E9 pass: post-reload real speak path works through /actions");

    /* ---- T25：Body 全量落盘中绝不允许出现 Host master token ---- */
    const bodyFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(json|md|log|txt|v1\.json)$/i.test(e.name)) bodyFiles.push(p);
      }
    })(userData);
    for (const f of bodyFiles) {
      const content = fs.readFileSync(f, "utf8");
      if (content.includes(HOST_TOKEN)) fail(`Body 落盘文件泄漏 Host master token: ${f}`);
    }
    log("T25 pass: no Host master token anywhere in Body env/disk");

    log("ALL M2 REAL-BODY ACTION E2E ASSERTIONS PASSED (E1-E9, T25, capability truth)");
  } catch (e) {
    exitCode = 1;
    console.error("[e2e] ERROR:", (e && e.stack) || e);
    if (host.stderr && host.stderr()) console.error("[e2e] host stderr:\n" + host.stderr().split("\n").slice(-12).join("\n"));
  } finally {
    try { await app.close(); } catch { /* 忽略 */ }
    await new Promise((resolve) => {
      host.child.on("exit", resolve);
      host.child.stdin.end();
      setTimeout(() => { try { host.child.kill(); } catch { /* 忽略 */ } resolve(); }, 8000).unref?.();
    });
    log("host stopped; artifacts kept for inspection at " + E2E_DIR + " (gitignored)");
  }
  process.exitCode = exitCode;
}

main().catch((e) => { console.error("[e2e] fatal:", e); process.exit(1); });

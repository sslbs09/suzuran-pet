"use strict";
/**
 * e2e-whitemoon-ui.js — Phase 11-E.1 真实用户 E2E（T16/T17/T23/T24 端到端）
 *
 * 真实组件全部在场：
 *   - 真实 Electron Body（本仓库，独立测试 userdir，与正在运行的实例互不干扰）
 *   - 真实 Runtime Host 进程（../whitemoon-runtime-host/src/main.js serve，pulse 开启）
 *   - 真实 whitemoon-core 持久化（临时 dataDir）
 *   - 真实 Adapter（Host 通过 file: 依赖直接 import）
 * 驱动只做两件事：以用户方式操作「记录观察…」窗口（填文本、点记录），
 * 以及用 curl 级 HTTP 断言鉴权与重试语义。全程绝不手工 POST /experience
 * 或 /opportunity 为主流程供料——角色的开口全部来自自动 pulse。
 *
 * 运行：node scripts/e2e-whitemoon-ui.js   （需要 Electron 二进制与 GUI 会话）
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
const E2E_DIR = path.join(BODY_ROOT, ".whitemoon-e2e");

// —— 测试专用凭据：每次运行随机生成，只活在临时目录与本进程里（绝不入库）——
const HOST_TOKEN = "e2e-host-" + crypto.randomBytes(16).toString("hex");
const INGRESS_TOKEN = "e2e-ingress-" + crypto.randomBytes(16).toString("hex");
const AGENT_TOKEN = "e2e-agent-" + crypto.randomBytes(16).toString("hex");

function log(msg) { console.log("[e2e] " + msg); }
function fail(msg) { console.error("[e2e] FAIL: " + msg); process.exitCode = 1; throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模块级：与 host 相关的断言辅助在 main() 之外被调用
let hostUrl = null;

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

async function waitFor(label, fn, { timeoutMs = 60000, everyMs = 300 } = {}) {
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
  const userData = path.join(E2E_DIR, "body-userdata"); // 产品状态目录（SUZURAN_TEST_USERDIR）
  const chromiumUdd = path.join(E2E_DIR, "body-chromium"); // Electron userData/单实例锁命名空间（与真实实例分离）
  const hostData = path.join(E2E_DIR, "host-data");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(chromiumUdd, { recursive: true });
  fs.mkdirSync(hostData, { recursive: true });

  const agentPort = await freePort();

  /* ============ 1. Runtime Host（真实进程，pulse 开启，ephemeral 端口） ============ */
  const hostConfigPath = path.join(E2E_DIR, "host-config.json");
  fs.writeFileSync(hostConfigPath, JSON.stringify({
    dataDir: hostData,
    instanceId: "sussurro-e2e-ui",
    packageId: "sussurro",
    host: { port: 0 },
    opportunityPulse: { enabled: true, intervalMs: 1200 }, // 测试专用节奏
    body: { baseUrl: `http://127.0.0.1:${agentPort}`, token: AGENT_TOKEN, timeoutMs: 8000 }
  }, null, 2));

  const cliEnv = { ...process.env, WHITEMOON_HOST_TOKEN: HOST_TOKEN, WHITEMOON_INGRESS_TOKEN: INGRESS_TOKEN };
  delete cliEnv.ELECTRON_RUN_AS_NODE;
  delete cliEnv.SUZURRO_AGENT_TOKEN; // 环境残留会覆盖 config 的 body.token，导致鉴权断言失真

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
  const hostPort = host.listening.port;
  hostUrl = `http://127.0.0.1:${hostPort}`;
  log(`host listening: ${hostUrl} (instance ${host.listening.instanceId})`);

  /* ============ 2. 真实 Electron Body（独立 userdir；与运行中实例互不干扰） ============ */
  // 产品配置：Agent 接口开在独立端口；WhiteMoon 连接指向刚起来的 Host。
  // ingress token 不落这份 config.json —— 启动时经 WHITEMOON_INGRESS_TOKEN 环境变量
  // 注入（密钥服务缺失时的运行时回退），config.json 里出现 token 会直接判 FAIL。
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
    whitemoonRuntime: { enabled: true, baseUrl: hostUrl }
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(bodyConfig, null, 2));
  fs.writeFileSync(path.join(userData, ".storage-migration-v1.json"), "{}");

  const appEnv = { ...process.env, SUZURAN_TEST_USERDIR: userData, WHITEMOON_INGRESS_TOKEN: INGRESS_TOKEN };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.SUZURRO_AGENT_TOKEN;
  // 产品状态走 SUZURAN_TEST_USERDIR；Electron userData（单实例锁命名空间 + Chromium
  // 缓存）走显式 --user-data-dir——与 perception-protocol 的既有契约同一分工，
  // 也让测试实例与正在运行的真实实例互不干扰。
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
    // 真实 Agent API 就绪（/health 无需认证）
    await waitFor("agent api /health", async () => {
      const r = await httpJson("GET", `http://127.0.0.1:${agentPort}/health`, { timeoutMs: 2000 });
      return r.status === 200 && r.body && r.body.ok === true;
    }, { timeoutMs: 60000 });

    // 真实宠物窗口 + preload 桥
    const petWin = await app.firstWindow();
    await waitFor("petAPI preload bridge", async () => {
      return await petWin.evaluate(() => !!(window.petAPI && typeof window.petAPI.openObservation === "function" && typeof window.petAPI.submitObservation === "function"));
    });

    /* ============ 3. T23：用户经真实 UI 提交第一条观察 ============ */
    await petWin.evaluate(() => window.petAPI.openObservation());
    let obsWin = null;
    await waitFor("记录观察窗口打开", async () => {
      obsWin = app.windows().find((w) => w.url().includes("observation.html")) || null;
      return obsWin !== null;
    });
    log("observation window open (real UI)");

    const NOTE_1 = "今天窗台上的薄荷冒出了新芽，博士给它拍了照";
    const result1 = await submitViaUi(obsWin, NOTE_1);
    if (!/已记录/.test(result1)) fail(`UI 第一条未显示已记录，实际: "${result1}"`);
    log("note 1 accepted by UI: " + result1);

    // Host→Core→Adapter→Body 全自动 pulse 链路：等待真实 Body 被「接受」的 follow-up
    const st1 = await waitForPulseAccepted(1, "第一条观察的自动追问");
    const acceptedRounds1 = st1.rounds;
    // 同一条目不被重复追问
    await waitForPulseIdle(acceptedRounds1 + 1, "同一 entry 不重复（角色自选 idle）");

    // Core 持久化事实：note 只作为 Experience 存在，语义仍是 V2
    const inst1 = await httpJson("GET", `${hostUrl}/instance`);
    if (inst1.body.experienceCount !== 1) fail(`期望 Core 恰有 1 条 Experience，实际 ${inst1.body.experienceCount}`);
    if (inst1.body.projectionSemanticsVersion !== 2) fail("projectionSemanticsVersion 必须保持 2");
    const docPath = path.join(hostData, "instances", "sussurro-e2e-ui.json");
    const doc1 = JSON.parse(fs.readFileSync(docPath, "utf8"));
    const exp1 = doc1.experiences[0];
    if (exp1.payload.note !== NOTE_1) fail("Core Experience 必须原样保存用户笔记");
    if (exp1.type !== "shared-event" || exp1.payload.subject !== "observation-booklet" || exp1.payload.action !== "entry-added") {
      fail("Adapter 映射的形状不符合冻结契约");
    }
    log("Core persisted exactly one shared-event entry with the user's note");

    /* ============ 4. T24：第二条真实 UI 观察 → 下一次自动追问被接受 ============ */
    const NOTE_2 = "傍晚博士把薄荷移到了书桌左边，说有香味";
    const result2 = await submitViaUi(obsWin, NOTE_2);
    if (!/已记录/.test(result2)) fail(`UI 第二条未显示已记录，实际: "${result2}"`);
    log("note 2 accepted by UI: " + result2);
    await waitForPulseAccepted(acceptedRounds1 + 2, "第二条观察的自动追问");
    const inst2 = await httpJson("GET", `${hostUrl}/instance`);
    if (inst2.body.experienceCount !== 2) fail(`期望 2 条 Experience，实际 ${inst2.body.experienceCount}`);
    const st2 = await httpJson("GET", `${hostUrl}/status`);
    await waitForPulseIdle(st2.body.pulse.rounds + 1, "第二条也不重复（角色自选 idle）");

    /* ============ 5. T16 鉴权 E2E：能力严格分离 ============ */
    // ingress token → /integration-input 授权（用独立 actionId，不污染计数断言的实例）
    const actionId = crypto.randomUUID();
    const okIngress = await httpJson("POST", `${hostUrl}/integration-input`, {
      token: INGRESS_TOKEN,
      body: { actionId, type: "record-observation", note: "鉴权 E2E 的探针观察" }
    });
    if (okIngress.status !== 200 || !okIngress.body.ok) fail("ingress token 应能提交 /integration-input: " + okIngress.raw);

    // 同一 ingress token → /experience 与 /opportunity 必须 401
    const denyExp = await httpJson("POST", `${hostUrl}/experience`, {
      token: INGRESS_TOKEN,
      body: { id: "exp-must-be-denied", type: "shared-event", payload: { subject: "x" } }
    });
    if (denyExp.status !== 401) fail("ingress token 不该授权 /experience，实际 " + denyExp.status);
    const denyOpp = await httpJson("POST", `${hostUrl}/opportunity`, {
      token: INGRESS_TOKEN,
      body: { type: "idle-opportunity" }
    });
    if (denyOpp.status !== 401) fail("ingress token 不该授权 /opportunity，实际 " + denyOpp.status);

    // master token → /integration-input 也 401（两能力互斥）
    const denyMaster = await httpJson("POST", `${hostUrl}/integration-input`, {
      token: HOST_TOKEN,
      body: { actionId: crypto.randomUUID(), type: "record-observation", note: "master 不该进来" }
    });
    if (denyMaster.status !== 401) fail("master token 不该授权 /integration-input，实际 " + denyMaster.status);

    // Host master token 不出现在 Body 的任何落盘文件
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
    log("no Body file contains the Host master token");

    /* ============ 6. T17 重试语义（HTTP 级，同 actionId） ============ */
    const countBefore = (await httpJson("GET", `${hostUrl}/instance`)).body.experienceCount;
    // 同一 actionId + 同一 note 再提交 → 幂等成功，计数不变
    const dup = await httpJson("POST", `${hostUrl}/integration-input`, {
      token: INGRESS_TOKEN,
      body: { actionId, type: "record-observation", note: "鉴权 E2E 的探针观察" }
    });
    if (dup.status !== 200 || dup.body.outcome !== "duplicate") fail("同 action 重试应幂等 duplicate: " + dup.raw);
    // 同一 actionId + 不同 note → 冲突，无第二条
    const conflict = await httpJson("POST", `${hostUrl}/integration-input`, {
      token: INGRESS_TOKEN,
      body: { actionId, type: "record-observation", note: "同标识换内容必须冲突" }
    });
    if (conflict.status !== 409 || conflict.body.outcome !== "conflict") fail("同 actionId 不同内容应 409 conflict: " + conflict.raw);
    const docAfter = JSON.parse(fs.readFileSync(docPath, "utf8"));
    const countNow = (await httpJson("GET", `${hostUrl}/instance`)).body.experienceCount;
    if (countNow !== countBefore) fail("冲突复用不得增加 Experience");
    if (docAfter.experiences.some((e) => e.payload.note === "同标识换内容必须冲突")) fail("冲突内容不得进入历史");
    log("retry idempotency + conflict rejection verified against the live host");

    log("ALL E2E ASSERTIONS PASSED");
  } catch (e) {
    exitCode = 1;
    console.error("[e2e] ERROR:", e && e.stack || e);
    if (host.stderr && host.stderr()) console.error("[e2e] host stderr:\n" + host.stderr().split("\n").slice(-12).join("\n"));
  } finally {
    try { await app.close(); } catch { /* 忽略 */ }
    await new Promise((resolve) => {
      host.child.on("exit", resolve);
      host.child.stdin.end();
      setTimeout(() => { try { host.child.kill(); } catch { /* 忽略 */ } resolve(); }, 5000).unref?.();
    });
    log("host stopped; temp dirs kept for inspection at " + E2E_DIR + " (gitignored)");
  }
  process.exitCode = exitCode;
}

/** 经真实 UI（textarea + 记录按钮）提交一条观察，返回界面结果文案 */
async function submitViaUi(win, note) {
  await win.evaluate(() => { document.getElementById("result").textContent = ""; }); // 清掉上一条结果，避免误判
  await win.fill("#note", note);
  await win.click("#submit");
  await waitFor("UI 显示提交结果", async () => {
    const text = await win.textContent("#result");
    return typeof text === "string" && text.trim().length > 0 && !/提交中/.test(text);
  }, { timeoutMs: 30000 });
  return (await win.textContent("#result")).trim();
}

/** 等到 pulse 出现 outcome accepted（rounds 严格超过 minRounds） */
async function waitForPulseAccepted(minRounds, label) {
  let out = null;
  await waitFor(`pulse round ${label}`, async () => {
    const s = await httpJson("GET", `${hostUrl}/status`, { timeoutMs: 3000 });
    out = s.body.pulse;
    return !!(out && out.enabled && out.rounds >= minRounds && out.lastRoundOutcome === "accepted");
  }, { timeoutMs: 90000, everyMs: 250 });
  return out;
}

async function waitForPulseIdle(minRounds, label) {
  let out = null;
  await waitFor(`pulse round ${label}`, async () => {
    const s = await httpJson("GET", `${hostUrl}/status`, { timeoutMs: 3000 });
    out = s.body.pulse;
    return !!(out && out.enabled && out.rounds >= minRounds && out.lastRoundOutcome === "idle");
  }, { timeoutMs: 90000, everyMs: 250 });
  return out;
}

main().catch((e) => { console.error("[e2e] fatal:", e); process.exit(1); });

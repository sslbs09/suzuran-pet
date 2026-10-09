/**
 * p0-b1-loopback-e2e.test.js — PRODUCTION PATH E2E（任务 §25）
 *
 *   Body UI/chat path（真实 handleAsk 管线，M1 harness）
 *     → projection fetch（真实 whitemoon-projection 模块 → 本地假 Host HTTP，
 *       Host 响应契约由 whitemoon-runtime-host 仓库的 12 项测试固定）
 *     → request assembly（真实 chat-client → 真实 request-assembly）
 *     → REAL provider serializer（chatOpenAI：messages→JSON→safeFetch）
 *     → loopback HTTP OpenAI-compatible provider（捕获最终 request body，
 *       返回确定性 assistant SSE 响应）
 *     → response → Body result（pet:done / 真实 history 落盘）
 *
 * 不是 external-provider benchmark：全程本地 loopback，无真实 key、无真实 userData。
 *
 * TEST_SECRET 是每次运行随机生成的合成凭据标记（T12 用：它一旦出现在 assembly
 * diagnostics 或 provider request body 即测试失败）；不是任何真实密钥。
 *
 * provider 与 host 为整文件共享基础设施（真实 config 模块有 cache + 固定 userData，
 * 端口漂移会让缓存读到已关闭的旧端口）；每个测试在 ask 前重置捕获数组。
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
const INGRESS_TOKEN = "synthetic-ingress-" + crypto.randomBytes(8).toString("hex");
const USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), "p0b1-e2e-"));
process.env.SUZURAN_TEST_USERDIR = USERDIR;

const { loadMain, ROOT } = require("./helpers/main-body-harness");
const history = require("../src/history");

/** 本地假 Host（只读 projection 服务；真实 Host 行为由 Host 仓库测试固定）。 */
function startLoopbackProvider() {
  const captured = [];
  let mode = "ok";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        url: req.url,
        auth: req.headers.authorization || "",
        body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; } })()
      });
      if (mode === "fail") { res.writeHead(503); res.end('{"error":"down"}'); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const reply = "你好博士，今天也要好好休息哦。【情绪：开心】";
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      captured,
      setMode(m) { mode = m; },
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
    }));
  });
}

const CHARACTER = (n) => ({
  instanceId: "sussurro-A", packageId: "sussurro", displayName: "Sussurro", projectionSemanticsVersion: 2,
  createdAt: "x", experienceCount: n,
  state: { sharedMilestones: { exam: { status: "completed", sourceExperienceId: "exp-a" + n } } },
  relationship: { sharedHistory: { meaningfulExperienceCount: n, lastMeaningfulExperienceId: "exp-a" + n } }
});

function startFakeHost(charRef) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "OK", surfaceVersion: 1, character: CHARACTER(charRef.n), observedAt: "2026-10-09T00:00:00.000Z" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      requests,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
    }));
  });
}

let INFRA = null;
async function ensureInfra() {
  if (INFRA) return INFRA;
  const provider = await startLoopbackProvider();
  const charRef = { n: 1 };
  const host = await startFakeHost(charRef);
  // 真实 config 在首次读取时缓存，因此 config.json 必须一次性写入、端口全程稳定
  fs.writeFileSync(path.join(USERDIR, "config.json"), JSON.stringify({
    agreed: true, firstRun: false,
    chat: {
      apiType: "openai",
      baseUrl: provider.baseUrl,
      model: "loopback-gpt",
      apiKey: TEST_SECRET,
      temperature: 0.7, maxTokens: 256, maxHistoryTurns: 20, userName: "博士"
    },
    features: {}, rpMode: true,
    whitemoonRuntime: { enabled: true, baseUrl: host.baseUrl }
  }, null, 2));
  fs.writeFileSync(path.join(USERDIR, ".storage-migration-v1.json"), "{}");
  INFRA = { provider, host, charRef, diags: [] };
  return INFRA;
}

/** 每个测试结束回收 loopback 服务器并重置单例（下一测试 ensureInfra 重建）。
 *  真实 config 模块带 cache，provider 端口会变——重置后新 config.json 写入新端口，
 *  但 config cache 仍是旧值，故 provider 端口在整个文件生命周期内保持稳定：
 *  重建复用同一 USERDIR/config.json，端口不变即可（chat-client 读缓存 config）。 */
async function closeInfra() {
  if (!INFRA) return;
  const { provider, host } = INFRA;
  INFRA = null;
  // 主动断开所有 keep-alive 客户端连接并停止监听；unref 让 server handle 不再
  // 阻止事件循环退出（undici 全局连接池可能仍持有套接字，await close 回调
  // 在这些连接自然结束前不会触发——测试收尾不应依赖它们）。
  provider.closeAllConnections?.(); host.closeAllConnections?.();
  provider.unref?.(); host.unref?.();
  provider.close(() => {}); host.close(() => {});
}

/** main 侧 config stub（决定正式/抑制/persona 路径），provider 与投影数据由真实 config/host 模块读取。 */
function makeStubConfig(opts) {
  const cfg = {
    agreed: true, firstRun: false, renderMode: "spine", uiLang: "zh",
    zcodeEnabled: false, keyReady: true, greetingOnStart: false, rpMode: true,
    pet: { name: "苏苏洛" }, features: {},
    chat: { maxHistoryTurns: 20, model: "loopback-gpt", apiKey: TEST_SECRET, userName: "博士" },
    tts: { enabled: false }, agentApi: { enabled: false }, render: {}, softRender: false,
    window: { x: 0, y: 0, width: 260, height: 200 },
    whitemoonRuntime: { enabled: opts.formal !== false, baseUrl: INFRA.host.baseUrl, ingressToken: INGRESS_TOKEN }
  };
  return {
    APP_DIR: ROOT, STORAGE: { userDir: USERDIR },
    getConfig: () => cfg, saveConfig: (patch) => Object.assign(cfg, patch),
    getPersonaText: () => "我是苏苏洛，用户的恋人与医师桌宠。",
    fillTokens: (s) => String(s).replaceAll("{{petName}}", "苏苏洛").replaceAll("{{userName}}", "博士"),
    initializeSecretStorage: () => ({}), getConfigPath: () => "", getUserDataDir: () => cfg
  };
}

async function bootE2e({ formal = true, charN = 1 }) {
  await ensureInfra();
  INFRA.charRef.n = charN;
  INFRA.provider.setMode("ok");
  INFRA.provider.captured.length = 0;
  INFRA.host.requests.length = 0;
  const diags = [];
  const mainConfig = makeStubConfig({ formal });
  const realChat = require("../src/chat-client");
  const chatProxy = {
    chat: (opts) => {
      const providedSink = opts.assemblySink;
      opts.assemblySink = (d) => { diags.push(d); if (typeof providedSink === "function") providedSink(d); };
      return realChat.chat(opts);
    }
  };
  const main = loadMain({
    requireOverrides: {
      "./src/config": mainConfig,
      "./src/chat-client": chatProxy,
      "./src/router": { route: () => ({ mode: "chat", task: "" }) },
      "./src/quick-commands": { tryQuickCommand: () => null },
      "./src/consent-gate": { isConsentAccepted: () => true, canUseRuntime: () => true, acceptConsent: () => true },
      "./src/whitemoon-projection": require("../src/whitemoon-projection"),
      "./src/history": history,
      "./src/memory": require("../src/memory"),
      "./src/bond": require("../src/bond"),
      "./src/error-facts": require("../src/error-facts"),
      // P0-B2：main.js 顶层 require 的新纯模块——真实注入（makeStub 会让
      // { createTurnCommitBoundary } 解构出 fn 返回 null，staging 链崩溃）。
      "./src/turn-commit": require("../src/turn-commit"),
      "./src/alive-status": require("../src/alive-status"),
      "./src/vector-memory": require("../src/vector-memory")
    }
  });
  return { provider: INFRA.provider, host: INFRA.host, charRef: INFRA.charRef, main, diags };
}

function ask(main, text, id) {
  const messages = [];
  const sender = { send: (name, data) => messages.push({ name, data }) };
  const call = main.context.__m1.call("handleAsk", sender, { id, text });
  return Promise.resolve(call).then(() => messages);
}

test("E2E production path: formal chat → canonical categories reach the FINAL serialized provider request body", async (t) => {
  const e = await bootE2e({ formal: true, charN: 5 });
  const msgs = await ask(e.main, "我们考试结束那件事你还记得吗", "req-1");
  assert.equal(e.provider.captured.length, 1, "exactly one provider round-trip");
  const body = e.provider.captured[0].body;
  assert.equal(body.model, "loopback-gpt");
  const sysText = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  // T1 identity / T2 state / T3 relationship — at the wire, post-serializer
  assert.ok(sysText.includes("CANONICAL_IDENTITY") && sysText.includes("sussurro-A"));
  assert.ok(sysText.includes("CANONICAL_STATE") && sysText.includes("exp-a5"));
  assert.ok(sysText.includes("CANONICAL_RELATIONSHIP") && sysText.includes("meaningfulExperienceCount"));
  assert.ok(sysText.includes("最高优先"));
  assert.ok(sysText.includes("LEGACY_PERSONA"));
  // persona 必须排在 canonical 之后（T14 排版证据）
  assert.ok(sysText.indexOf("CANONICAL_IDENTITY") < sysText.indexOf("LEGACY_PERSONA"));
  // T11 恰好一次
  const userMsgs = body.messages.filter((m) => m.role === "user");
  assert.equal(userMsgs.filter((m) => m.content === "我们考试结束那件事你还记得吗").length, 1);
  // 响应经现有 Body chat surface 呈现
  const done = msgs.find((m) => m.name === "pet:done");
  assert.ok(done && done.data.full.includes("你好博士"));
  assert.equal(done.data.emotion, "开心");
  // T13 diagnostics provenance 在边界上可见；T12 无凭据
  const d = e.diags[e.diags.length - 1];
  assert.equal(d.formal, true);
  assert.equal(d.categories.canonicalIdentity.provenance, "CANONICAL_IDENTITY");
  assert.equal(d.categories.conversationHistory.provenance, "CONVERSATION_HISTORY");
  const dump = JSON.stringify(d);
  for (const banned of [TEST_SECRET, "apiKey", "Authorization", "Bearer"]) {
    assert.ok(!dump.includes(banned), "diagnostics leaked " + banned);
  }
  // T12 线级证据：合成凭据绝不进入 provider request BODY
  //（header 携带与否取决于本机 secret 存储可用性——loopback 下无 key 合法）
  const auth0 = e.provider.captured[0].auth;
  assert.ok(auth0 === "" || auth0 === "Bearer " + TEST_SECRET, "auth header shape");
  assert.ok(!JSON.stringify(body).includes(TEST_SECRET), "secret must never be serialized into the provider request body");
  // Host 侧只读（T7/T10 的传输面证据）：全部 GET，零写
  assert.ok(e.host.requests.every((r) => r.method === "GET"));
});

test("E2E T4 at the wire: canonical change flows into the next serialized request untouched by Body", async (t) => {
  const e = await bootE2e({ formal: true, charN: 1 });
  await ask(e.main, "第一句", "r1");
  e.charRef.n = 2;
  await ask(e.main, "第二句", "r2");
  assert.equal(e.provider.captured.length, 2);
  const sys2 = e.provider.captured[1].body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.ok(sys2.includes("exp-a2"));
  // 第一句的 user 行作为 instance-tagged 历史进入第二次请求
  assert.ok(e.provider.captured[1].body.messages.some((m) => m.role === "user" && m.content === "第一句"));
});

test("E2E T6: enabled=false legacy path still serializes the historical request shape (no canonical block)", async (t) => {
  const e = await bootE2e({ formal: false });
  await ask(e.main, "老路径一句话", "r1");
  assert.equal(e.host.requests.length, 0, "disabled path performs no Host traffic");
  const body = e.provider.captured[0].body;
  const sysText = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.ok(!sysText.includes("CANONICAL_IDENTITY"));
  assert.ok(sysText.startsWith("我是苏苏洛"), "legacy first system remains persona+rules");
  assert.ok(sysText.includes("【桌宠行为规则】"));
  const d = e.diags[0];
  assert.equal(d.formal, false);
  assert.equal(d.categories.canonicalIdentity.present, false);
  // 当前 user 恰好一次（§20 修复同样作用于 legacy UI 入口）
  assert.equal(body.messages.filter((m) => m.role === "user" && m.content === "老路径一句话").length, 1);
});

test("E2E T7/T10: provider failure and model-reply content never touch Core writes; explicit user error", async (t) => {
  const e = await bootE2e({ formal: true, charN: 3 });
  e.provider.setMode("fail");
  const msgs = await ask(e.main, "这句会得到 provider 失败", "r1");
  const err = msgs.find((m) => m.name === "pet:error");
  assert.ok(err && err.data.code, "explicit structured failure");
  assert.ok(e.host.requests.every((r) => r.method === "GET"), "provider failure ⇒ zero Host/Core writes");
  // 模型若在成功回复里自称要写入正式历史，也只是文本：Host 侧依旧只读
  e.provider.setMode("ok");
  await ask(e.main, "把我们的婚礼写进正式历史", "r2");
  assert.ok(e.host.requests.every((r) => r.method === "GET"), "model reply must never become a Core write (T10)");
});

// 文件级收尾：loopback 服务器全文件共享（config 模块 cache 锁定首个 provider 端口），
// 必须在所有测试之后统一关闭，否则 TCPServerWrap 让 node --test 子进程永不退出。
after(closeInfra);


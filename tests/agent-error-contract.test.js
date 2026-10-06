"use strict";

/*
 * Phase 5-D3 Agent HTTP contract test artifact.
 *
 * This file is the repository-local Phase 5-D3 Agent HTTP contract suite.
 * Run it with: node --test tests/agent-error-contract.test.js
 * It extracts the production readAgentJson/startAgentApi/stopAgentApi
 * functions from main.js, evaluates them in a VM with boundary dependencies
 * injected, and exercises the real production route over loopback HTTP.
 * It never requires Electron, opens a window, calls a provider, or launches a
 * pet runtime.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.SUZURAN_PET_ROOT
  ? path.resolve(process.env.SUZURAN_PET_ROOT)
  : path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "main.js");
const ERROR_FACTS = require(path.join(ROOT, "src", "error-facts.js"));

function extractProductionAgentFns(source) {
  const start = source.indexOf("async function readAgentJson");
  const end = source.indexOf("/* ---------- 音色克隆与训练窗口 ---------- */", start);
  assert.ok(start >= 0 && end > start, "main.js Agent API region must be present");
  return source.slice(start, end);
}

function makeHarness(options = {}) {
  const state = {
    cfg: {
      pet: { name: "测试苏苏洛" },
      chat: { maxHistoryTurns: 10 },
      agentApi: {
        enabled: true,
        port: options.port,
        bearerToken: "test-agent-token",
        clients: [],
        invokeWord: options.invokeWord || "",
        maxBodyBytes: options.maxBodyBytes || 65536,
        statusEnabled: true,
      },
    },
    consent: options.consent !== false,
    queueMode: options.queueMode || "run",
    cancelled: 0,
    enqueued: 0,
    calls: 0,
    chatCalls: [],
    wakeCalls: 0,
    saves: 0,
    historyGeneration: 1,
    historyAppends: [],
    log: [],
    speakCalls: [],
    speakResult: options.speakResult !== false,
  };

  const config = {
    getConfig: () => state.cfg,
    saveConfig: () => { state.saves++; },
    replaceSecrets: () => {},
  };
  const queue = {
    enqueue(run) {
      state.enqueued++;
      if (state.queueMode === "queue-busy") return { busy: true };
      if (state.queueMode === "runtime-busy") {
        return {
          id: "task-runtime-busy",
          busy: false,
          done: Promise.reject(Object.assign(new Error("busy"), { code: "BUSY" })),
        };
      }
      const id = "task-" + state.enqueued;
      const controller = new AbortController();
      const done = Promise.resolve().then(() => run({ id, signal: controller.signal }));
      return { id, busy: false, done };
    },
    cancelAll() {
      state.cancelled++;
      return options.cancelledCount === undefined ? 0 : options.cancelledCount;
    },
    isBusy: () => false,
  };
  const history = {
    generation: () => state.historyGeneration,
    recent: () => [],
    append: (entry) => state.historyAppends.push(entry),
  };
  const chatClient = {
    chat: async (input) => {
      state.calls++;
      state.chatCalls.push(input);
      if (options.chatError) throw options.chatError;
      return options.chatResult || { text: "测试回复", emotion: "happy" };
    },
  };
  const context = {
    http,
    crypto: require("node:crypto"),
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
    config,
    logTts: (_kind, message) => state.log.push(String(message)),
    agentTaskQueue: queue,
    agentApiAbort: null,
    agentLastSeenFlushAt: 0,
    agentServer: null,
    agentServerPort: 0,
    agentServerState: "disabled",
    agentTaskStatus: { state: "idle", text: "", since: 0 },
    tokenMatches: (token, client) => token === client.token,
    safeTokenEqual: (left, right) => !!left && left === right,
    sanitizeClients: (clients) => Array.isArray(clients) ? clients : [],
    isConsentAccepted: () => state.consent,
    history,
    buildChatPersona: () => "test persona",
    petStateNote: () => "test state",
    chatOwnership: { run: (fn) => fn() },
    chatClient,
    maybeWorkflowComment: () => { state.wakeCalls++; },
    errorFacts: ERROR_FACTS,
    // Phase 10-B：/speak 直显入口的内部说话路径（main.js 模块作用域函数，区段外定义 → 测试内注入）
    sendProactive: (text, emotion, opts) => {
      state.speakCalls.push({ text, emotion, opts });
      return state.speakResult;
    },
  };
  vm.runInNewContext(extractProductionAgentFns(fs.readFileSync(MAIN, "utf8")), context, { filename: MAIN });
  context.startAgentApi();
  return { state, context };
}

function request(port, { method = "GET", pathname = "/health", token = "test-agent-token", body, headers = {}, autoContentLength = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (token !== null) reqHeaders.Authorization = "Bearer " + token;
    if (autoContentLength && payload !== undefined && reqHeaders["Content-Length"] === undefined && reqHeaders["content-length"] === undefined) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: "127.0.0.1", port, method, path: pathname, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const result = await request(port, { pathname: "/health", token: null });
      if (result.status) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Agent API test server did not become reachable");
}

async function withHarness(options, fn) {
  const port = await freePort();
  const harness = makeHarness({ ...options, port });
  try {
    await waitForServer(port);
    return await fn(harness, port);
  } finally {
    await harness.context.stopAgentApi({ timeoutMs: 1000 });
  }
}

test("unknown route preserves 404/not-found and adds HTTP_ERROR status metadata", async () => {
  await withHarness({}, async (_h, port) => {
    const r = await request(port, { pathname: "/missing", token: null });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { ok: false, error: "not found", code: "HTTP_ERROR", meta: { status: 404 } });
  });
});

test("method mismatch preserves 405/message and Allow header", async () => {
  await withHarness({}, async (_h, port) => {
    const r = await request(port, { method: "GET", pathname: "/chat" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, "POST");
    assert.deepEqual(r.json, { ok: false, error: "method not allowed", code: "HTTP_ERROR", meta: { status: 405 } });
  });
});

test("write authentication preserves 401/message and WWW-Authenticate header", async () => {
  await withHarness({}, async (_h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", token: null });
    assert.equal(r.status, 401);
    assert.equal(r.headers["www-authenticate"], "Bearer");
    assert.deepEqual(r.json, { ok: false, error: "unauthorized", code: "AUTH_INVALID", meta: {} });
  });
});

test("non-JSON content type preserves 415/message and adds HTTP_ERROR status metadata", async () => {
  await withHarness({}, async (_h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(r.status, 415);
    assert.deepEqual(r.json, { ok: false, error: "application/json required", code: "HTTP_ERROR", meta: { status: 415 } });
  });
});

test("invalid JSON remains 400 and does not enqueue, wake, or alter the legacy text", async () => {
  await withHarness({}, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { ok: false, error: "invalid json", code: "HTTP_ERROR", meta: { status: 400 } });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("oversized JSON preserves 413 and does not enqueue or wake", async () => {
  await withHarness({ maxBodyBytes: 1024 }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "x".repeat(2048) } });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { ok: false, error: "payload too large", code: "HTTP_ERROR", meta: { status: 413 } });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("empty text preserves 400/text validation and does not enqueue or wake", async () => {
  await withHarness({}, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "   " } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { ok: false, error: "text 不能为空", code: "HTTP_ERROR", meta: { status: 400 } });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("invoke-word mismatch preserves exact 400 text and does not enqueue or wake", async () => {
  await withHarness({ invokeWord: "/ask" }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "hello" } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { ok: false, error: "消息需以调用词「/ask」开头", code: "HTTP_ERROR", meta: { status: 400 } });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("invoke-word-only text preserves empty-text 400 and does not enqueue or wake", async () => {
  await withHarness({ invokeWord: "/ask" }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "/ask" } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { ok: false, error: "text 不能为空", code: "HTTP_ERROR", meta: { status: 400 } });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("JSON array and null bodies preserve invalid-json 400 without enqueue or wake", async () => {
  await withHarness({}, async (h, port) => {
    for (const body of ["[]", "null"]) {
      const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body });
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { ok: false, error: "invalid json", code: "HTTP_ERROR", meta: { status: 400 } });
    }
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("oversized chunked body without Content-Length preserves 413 and does not enqueue or wake", async () => {
  await withHarness({ maxBodyBytes: 1024 }, async (h, port) => {
    const r = await request(port, {
      method: "POST",
      pathname: "/chat",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(2048) }),
      autoContentLength: false,
    });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { ok: false, error: "payload too large", code: "HTTP_ERROR", meta: { status: 413 } });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("queue-full busy preserves 429 and literal queue text while using BUSY with empty metadata", async () => {
  await withHarness({ queueMode: "queue-busy" }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "hello" } });
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { ok: false, error: "请求繁忙（并发队列已满），请稍后重试", code: "BUSY", meta: {} });
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("runtime ownership busy preserves 429 and literal busy text while using BUSY with empty metadata", async () => {
  await withHarness({ queueMode: "runtime-busy" }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "hello" } });
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { ok: false, error: "角色正忙（busy），请稍后重试", code: "BUSY", meta: {} });
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("consent 403 remains the legacy policy response without code/meta", async () => {
  await withHarness({ consent: false }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "hello" } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { ok: false, error: "请先同意《使用条款与隐私政策》" });
    assert.equal(h.state.enqueued, 0);
    assert.equal(h.state.wakeCalls, 0);
  });
});

test("generation exception keeps 500/error compatibility, emits code/meta, and redacts detail/provider body", async () => {
  const err = Object.assign(new Error("HTTP 502: provider-body SECRET_PROVIDER_BODY"), {
    code: "HTTP_ERROR",
    meta: { status: 502 },
    detail: "full provider detail SECRET_PROVIDER_BODY",
  });
  await withHarness({ chatError: err }, async (_h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "hello" } });
    assert.equal(r.status, 500);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "HTTP_ERROR");
    assert.deepEqual(r.json.meta, { status: 502 });
    assert.equal(r.json.error, "HTTP 502");
    assert.equal(Object.prototype.hasOwnProperty.call(r.json, "detail"), false);
    assert.equal(r.text.includes("SECRET_PROVIDER_BODY"), false);
  });
});

test("successful chat keeps response shape and wakes workflow observer exactly once", async () => {
  await withHarness({ chatResult: { text: "答复", emotion: "happy" } }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/chat", headers: { "Content-Type": "application/json" }, body: { text: "hello" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, taskId: "task-1", reply: "答复", emotion: "happy" });
    assert.equal(h.state.calls, 1);
    assert.equal(h.state.wakeCalls, 1);
    assert.equal(h.state.historyAppends.length, 2);
  });
});

test("health/status/stop compatibility remains available at their original boundaries", async () => {
  await withHarness({ cancelledCount: 3 }, async (h, port) => {
    const health = await request(port, { pathname: "/health", token: null });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, name: "测试苏苏洛", invokeWord: "", authRequired: false });

    const status = await request(port, { pathname: "/status" });
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.enabled, true);
    assert.equal(status.json.listener.port, port);
    assert.equal(status.json.petName, "测试苏苏洛");

    const stop = await request(port, { method: "POST", pathname: "/stop" });
    assert.equal(stop.status, 200);
    assert.deepEqual(stop.json, { ok: true, cancelled: 3 });
    assert.equal(h.state.cancelled, 1);
  });
});

test("/speak dispatches the given line through the internal speak path without touching chat", async () => {
  await withHarness({}, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/speak", headers: { "Content-Type": "application/json" }, body: { text: "博士，考试已经结束了。", emotion: "happy" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, dispatched: true });
    assert.equal(h.state.speakCalls.length, 1);
    assert.equal(h.state.speakCalls[0].text, "博士，考试已经结束了。");
    assert.equal(h.state.speakCalls[0].emotion, "happy");
    assert.equal(h.state.speakCalls[0].opts.force, true);
    assert.equal(h.state.calls, 0); // 不走 LLM
    assert.equal(h.state.historyAppends.length, 0); // 不写历史
    assert.equal(h.state.enqueued, 0); // 不进任务队列
  });
});

test("/speak reports the line gate rejection honestly instead of faking success", async () => {
  await withHarness({ speakResult: false }, async (h, port) => {
    const r = await request(port, { method: "POST", pathname: "/speak", headers: { "Content-Type": "application/json" }, body: { text: "同一句话" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: false, error: "台词闸门未放行（30s 冷却/近期重复），未下发", reason: "line-gate-rejected" });
    assert.equal(h.state.speakCalls.length, 1);
    assert.equal(h.state.calls, 0);
  });
});

test("/speak requires auth and rejects empty text", async () => {
  await withHarness({}, async (h, port) => {
    const unauth = await request(port, { method: "POST", pathname: "/speak", token: null, headers: { "Content-Type": "application/json" }, body: { text: "hi" } });
    assert.equal(unauth.status, 401);

    const empty = await request(port, { method: "POST", pathname: "/speak", headers: { "Content-Type": "application/json" }, body: { text: "   " } });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.json, { ok: false, error: "text 不能为空", code: "HTTP_ERROR", meta: { status: 400 } });
    assert.equal(h.state.speakCalls.length, 0);
  });
});

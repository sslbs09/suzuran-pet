"use strict";

/**
 * Phase 5-C2 契约测试：错误来源（safe-url / chat-client / conversation-service / task-queue）
 * 主动产出结构化错误事实。
 *
 * 必覆盖矩阵：401 / 403 / 402 / 429 / 503 / DNS 失败 / timeout / abort / SSRF 拒绝 /
 *             旧 Error 兼容 / payload 无 detail 泄漏
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const root = require("node:path").join(__dirname, "..");
const facts = require(require("node:path").join(root, "src/error-facts.js"));
const safeUrl = require(require("node:path").join(root, "src/safe-url.js"));
const conversation = require(require("node:path").join(root, "src/conversation-service.js"));
const taskQueue = require(require("node:path").join(root, "src/task-queue.js"));
const chatClient = require(require("node:path").join(root, "src/chat-client.js"));

const APPROVED = ["NO_API_KEY", "AUTH_INVALID", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR",
  "SSRF_BLOCKED", "BAD_URL", "HTTP_ERROR", "CANCELLED", "BUSY", "INTERNAL",
  "timeout", "synth", "disabled", "nopath"];

/** 抓取被抛出的错误事实（含 code/meta/detail）。 */
async function caught(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error("expected a throw");
}

/* ---------------- HTTP 状态分类（401/403/402/429/503）—— 走真实 testConnection 链路 ---------------- */

test("testConnection: HTTP status drives the code and the provider body never leaves", async () => {
  const expected = {
    401: "AUTH_INVALID", 403: "AUTH_INVALID", 402: "QUOTA_EXCEEDED",
    429: "QUOTA_EXCEEDED", 503: "HTTP_ERROR", 500: "HTTP_ERROR", 404: "HTTP_ERROR"
  };
  const secretBody = '{"error":{"message":"upstream exploded","key":"sk-live-abcdefgh1234567"}}';
  const origFetch = globalThis.fetch;
  try {
    for (const [status, code] of Object.entries(expected)) {
      globalThis.fetch = async () => ({
        ok: false, status: Number(status), headers: new Map(),
        text: async () => secretBody, json: async () => { throw new Error("no json"); }
      });
      const r = await chatClient.testConnection(
        { apiType: "openai", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-test-abcdefgh123456" },
        { chat: { apiType: "openai", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-test-abcdefgh123456", allowPrivateBaseUrl: false } }
      );
      assert.equal(r.ok, false, `status ${status}`);
      assert.equal(r.code, code, `status ${status}`);
      // 返回值是 IPC 载荷：只允许 {ok, ms, code, meta, message}
      assert.deepEqual(Object.keys(r).sort(), ["code", "message", "meta", "ms", "ok"], `status ${status}`);
      assert.ok(!r.message.includes("upstream exploded"), `status ${status} body leaked into message`);
      assert.ok(!r.message.includes("sk-live"), `status ${status} token leaked into message`);
      if (code === "HTTP_ERROR") {
        assert.deepEqual(r.meta, { status: Number(status) }, "HTTP_ERROR carries status meta");
      } else {
        assert.deepEqual(r.meta, {}, "non-HTTP_ERROR carries no meta");
      }
    }
  } finally { globalThis.fetch = origFetch; }
});

test("testConnection: success path is unchanged", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => "", json: async () => ({}) });
    const r = await chatClient.testConnection(
      { apiType: "openai", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-test-abcdefgh123456" },
      { chat: { apiType: "openai", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-test-abcdefgh123456", allowPrivateBaseUrl: false } }
    );
    assert.equal(r.ok, true);
    assert.match(r.message, /连接成功/);
    assert.equal(r.code, undefined);
  } finally { globalThis.fetch = origFetch; }
});

test("HTTP_ERROR facts round-trip through the Phase 5-A presenter with status", async () => {
  const presenter = require(require("node:path").join(root, "src/error-presenter.js"));
  const e = new facts.ErrorWithCode("HTTP_ERROR", { meta: { status: 503 }, message: "API 503" });
  assert.deepEqual(presenter.toPresentation({ code: e.code, meta: e.meta }), { key: "err.http", params: { status: 503 } });
  const auth = new facts.ErrorWithCode("AUTH_INVALID", { meta: { status: 401 }, message: "API 401" });
  assert.deepEqual(presenter.toPresentation({ code: auth.code, meta: auth.meta }), { key: "err.authInvalid", params: {} });
});

/* ---------------- safe-url：SSRF / DNS / BAD_URL ---------------- */

test("safe-url: SSRF refusal is a coded fact, not plain text", async () => {
  const loop = await caught(() => safeUrl.assertSafeHttpUrl("http://localhost/v1"));
  assert.equal(facts.classifyError(loop), "SSRF_BLOCKED");

  const priv = await caught(() => safeUrl.assertSafeHttpUrl("http://192.168.1.10:8080/v1"));
  assert.equal(facts.classifyError(priv), "SSRF_BLOCKED");
  assert.match(priv.message, /私有或保留 IP/);

  const linkLocal = await caught(() => safeUrl.assertSafeHttpUrl("http://169.254.169.254/latest/meta-data"));
  assert.equal(facts.classifyError(linkLocal), "SSRF_BLOCKED");
});

test("safe-url: malformed URL / bad protocol are BAD_URL", async () => {
  for (const bad of ["not-a-url", "ftp://api.example.com/v1", "file:///c:/x", "http://user:pw@api.example.com/v1"]) {
    const e = await caught(() => safeUrl.assertSafeHttpUrl(bad));
    assert.equal(e.code, "BAD_URL", bad);
  }
});

test("safe-url: DNS failure is NETWORK_ERROR", async () => {
  const e = await caught(() => safeUrl.assertSafeHttpUrl("https://unresolvable.example/v1", {
    lookup: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); }
  }));
  assert.equal(e.code, "NETWORK_ERROR");
  assert.equal(facts.classifyError(e), "NETWORK_ERROR");
  assert.match(e.message, /无法解析服务地址/);
});

test("safe-url: empty DNS answer is NETWORK_ERROR", async () => {
  const e = await caught(() => safeUrl.assertSafeHttpUrl("https://empty.example/v1", { lookup: async () => [] }));
  assert.equal(e.code, "NETWORK_ERROR");
});

/* ---------------- chat-client：SSRF / 凭据绑定 ---------------- */

test("chat-client: SSRF guard still rejects, now as a coded fact", async () => {
  const e = await caught(() => chatClient.validateApiBase("http://10.0.0.5/v1/chat", false));
  assert.equal(e.code, "SSRF_BLOCKED");
  assert.equal(facts.toPayload(e).code, "SSRF_BLOCKED");

  const bad = await caught(() => chatClient.validateApiBase("ftp://api.example.com/v1", false));
  assert.equal(bad.code, "BAD_URL");
});

test("chat-client: missing API key produces NO_API_KEY on both entry points", async () => {
  // testConnection：anthropic 分支显式传空 key → 抛点即 NO_API_KEY
  const r = await chatClient.testConnection(
    { apiType: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "" },
    { chat: { apiType: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "", allowPrivateBaseUrl: false } }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_API_KEY");
  assert.match(r.message, /未填写 API Key/);

  // listModels：同样的守卫，走返回值投影
  const lm = await chatClient.listModels(
    { apiType: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "" },
    { chat: { apiType: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "", allowPrivateBaseUrl: false } }
  );
  assert.equal(lm.ok, false);
  assert.equal(lm.code, "NO_API_KEY");
  assert.match(lm.message, /请先填写 API Key/);
});

test("chat-client: credential-binding violation is SSRF_BLOCKED", async () => {
  const violation = chatClient.storedKeyOriginViolation("https://api.a.example/v1", "https://api.b.example/v1");
  assert.ok(violation);
  const e = new facts.ErrorWithCode("SSRF_BLOCKED", { message: violation });
  assert.equal(facts.toPayload(e).code, "SSRF_BLOCKED");
  // 文案保留（renderer legacy / 日志可读）
  assert.match(facts.toPayload(e).message, /不属于同一来源/);
});

/* ---------------- cancel / abort ---------------- */

test("task-queue: cancel is a coded CANCELLED fact and keeps its legacy text", async () => {
  const q = taskQueue.createTaskQueue(1);
  const first = q.enqueue(async () => "ok");
  await first.done;
  const second = q.enqueue(async () => "never");
  q.cancel(second.id);
  const e = await caught(() => second.done);
  assert.equal(e.code, "CANCELLED");
  assert.equal(facts.classifyError(e), "CANCELLED");
  assert.match(e.message, /请求已取消/); // 历史文案保持
});

test("AbortError still classifies as CANCELLED (no regression)", async () => {
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  assert.equal(facts.classifyError(abort), "CANCELLED");
  assert.equal(conversation.classifyError(abort), "CANCELLED");
});

test("timeout facts classify as TIMEOUT from errno or explicit code", () => {
  assert.equal(facts.classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "TIMEOUT");
  assert.equal(facts.classifyError(new facts.ErrorWithCode("TIMEOUT", { message: "SSE 流空闲超时" })), "TIMEOUT");
});

/* ---------------- SSE 行为保持 ---------------- */

test("readSSE: in-stream error frame keeps sseError semantics and hides provider body", async () => {
  const secretBody = '{"error":{"message":"upstream exploded","token":"sk-live-abcdefgh1234"}}';
  const resp = {
    body: {
      getReader() {
        const chunks = [
          { done: false, value: new TextEncoder().encode(`data: ${secretBody}\n`) }
        ];
        let i = 0;
        return { read: async () => (i < chunks.length ? chunks[i++] : { done: true }) };
      }
    }
  };
  const e = await caught(() => chatClient.readSSE(resp, () => {}, () => ""));
  assert.ok(e.sseError, "sseError flag preserved so the caller re-throws instead of swallowing");
  assert.equal(facts.classifyError(e), "INTERNAL");
  assert.ok(e.detail && e.detail.includes("upstream exploded"), "full body kept in detail for logs");
  const payload = facts.toPayload(e);
  assert.equal(payload.message, "流式响应错误");
  assert.ok(!JSON.stringify(payload).includes("upstream exploded"), "provider body must not reach payload");
  assert.ok(!JSON.stringify(payload).includes("sk-live"), "token must not reach payload");
});

test("readSSE: missing body is INTERNAL", async () => {
  const e = await caught(() => chatClient.readSSE({ body: null }, () => {}, () => ""));
  assert.equal(e.code, "INTERNAL");
});

test("readSSE: normal stream still concatenates content", async () => {
  const resp = {
    body: {
      getReader() {
        const chunks = [
          { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\ndata: [DONE]\n') }
        ];
        let i = 0;
        return { read: async () => (i < chunks.length ? chunks[i++] : { done: true }) };
      }
    }
  };
  const seen = [];
  const full = await chatClient.readSSE(resp, (d) => seen.push(d), (j) => j?.choices?.[0]?.delta?.content);
  assert.equal(full, "你好");
  assert.deepEqual(seen, ["你好"]);
});

/* ---------------- conversation-service 兼容 ---------------- */

test("conversation-service: ERROR_CODES is now the shared 15-code vocabulary", () => {
  assert.deepEqual(Object.keys(conversation.ERROR_CODES).sort(), [...APPROVED].sort());
  assert.equal(conversation.ERROR_CODES.EMPTY, undefined, "EMPTY is not an approved code");
  assert.equal(conversation.ERROR_CODES, facts.ERROR_CODES, "single source of truth");
});

test("conversation-service: legacy classifyError assertions still hold", () => {
  assert.equal(conversation.classifyError(Object.assign(new Error("x"), { name: "AbortError" })), "CANCELLED");
  assert.equal(conversation.classifyError(new Error("HTTP 502: bad")), "HTTP_ERROR");
  assert.equal(conversation.classifyError(new Error("The operation was aborted due to timeout")), "TIMEOUT");
  assert.equal(conversation.classifyError(new Error("boom")), "INTERNAL");
  assert.equal(conversation.classifyError(null), "INTERNAL");
});

test("conversation-service: classifyError now understands coded facts", () => {
  for (const code of APPROVED) {
    assert.equal(conversation.classifyError(new facts.ErrorWithCode(code, { message: "opaque text" })), code);
  }
});

/* ---------------- payload 无 detail 泄漏 ---------------- */

test("no error source leaks detail into a value that reaches IPC", async () => {
  const hostileDetail = '{"secret":"do-not-send"} sk-live-abcdefgh1234567';
  const samples = [
    new facts.ErrorWithCode("HTTP_ERROR", { meta: { status: 500 }, message: "API 500", detail: hostileDetail }),
    new facts.ErrorWithCode("SSRF_BLOCKED", { message: "拒绝向内网/链路本地地址发送请求（SSRF 防护）：10.0.0.5", detail: hostileDetail }),
    new facts.ErrorWithCode("NO_API_KEY", { message: "未配置 API Key", detail: hostileDetail })
  ];
  for (const err of samples) {
    const payload = facts.toPayload(err);
    assert.deepEqual(Object.keys(payload).sort(), ["code", "message", "meta"]);
    const wire = JSON.stringify(payload);
    assert.ok(!wire.includes("do-not-send"), "detail must not cross the boundary");
    assert.ok(!wire.includes("sk-live"), "token must not cross the boundary");
  }
});

test("toPayload is the only cross-boundary shape and stays minimal", () => {
  const payload = facts.toPayload(new facts.ErrorWithCode("INTERNAL", { message: "boom", detail: "secret" }));
  assert.deepEqual(Object.keys(payload), ["code", "meta", "message"]);
});

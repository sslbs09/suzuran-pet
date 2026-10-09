"use strict";

/**
 * Phase 5-C1 契约测试：src/error-facts.js
 *   code normalize / meta whitelist / payload projection / diagnostic projection
 * 以及与 Phase 5-A error-presenter 的词表同集合不变量。
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const root = require("node:path").join(__dirname, "..");
const facts = require(require("node:path").join(root, "src/error-facts.js"));
const presenter = require(require("node:path").join(root, "src/error-presenter.js"));

const APPROVED_CODES = [
  "NO_API_KEY", "AUTH_INVALID", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR",
  "SSRF_BLOCKED", "BAD_URL", "HTTP_ERROR", "CANCELLED", "BUSY", "INTERNAL",
  // P0-B1 §27 R8：formal mode canonical 投影读取失败的明确失败码（第 12 码，
  // 经负责人任务书授权的产品认知集成词汇扩展；GSV 隔离规则不受影响）
  "FORMAL_PROJECTION_UNAVAILABLE"
];
/** Phase 5-G1：GSV 引擎专属小写码不属于通用错误码词表 */
const GSV_ONLY_CODES = ["timeout", "synth", "disabled", "nopath"];

/* ---------- 词表锁定 ---------- */

test("error-facts exposes exactly the 12 approved codes and no others", () => {
  assert.deepEqual(Object.keys(facts.ERROR_CODES).sort(), [...APPROVED_CODES].sort());
  assert.ok(Object.isFrozen(facts.ERROR_CODES));
  for (const code of ["RATE_LIMIT", "PROVIDER_UNAVAILABLE", "INVALID_RESPONSE", "EMPTY"]) {
    assert.equal(facts.ERROR_CODES[code], undefined, `${code} must not exist`);
    assert.equal(facts.normalizeCode(code), "INTERNAL", `${code} must normalize to INTERNAL`);
  }
});

test("Phase 5-G1: GSV lowercase codes are not part of the general error vocabulary", () => {
  for (const code of GSV_ONLY_CODES) {
    assert.equal(facts.ERROR_CODES[code], undefined, `${code} must not be a general error code`);
    assert.equal(facts.normalizeCode(code), "INTERNAL", `${code} must normalize to INTERNAL`);
    const e = new facts.ErrorWithCode(code, { message: "gsv failure" });
    assert.equal(e.code, "INTERNAL", `ErrorWithCode must reject ${code}`);
    assert.deepEqual(facts.toPayload(e).code, "INTERNAL");
  }
});

test("code vocabulary stays in lockstep with the Phase 5-A error-presenter", () => {
  // ERROR_PRESENTATIONS 的键就是 code，值是 err.* 文案键
  const presenterCodes = new Set(Object.keys(presenter.ERROR_PRESENTATIONS));
  assert.deepEqual([...presenterCodes].sort(), [...APPROVED_CODES].sort(),
    "error-facts 与 error-presenter 必须共用同一份 12 码词表");
  // GSV 小写码改由独立命名空间承载，且与通用词表零交集
  const gsvCodes = new Set(Object.keys(presenter.GSV_PRESENTATIONS));
  assert.deepEqual([...gsvCodes].sort(), [...GSV_ONLY_CODES].sort());
  for (const code of gsvCodes) {
    assert.ok(!presenterCodes.has(code), `${code} must not appear in the general vocabulary`);
  }
  // presenter 只多不少（err.unknown / err.httpGeneric 是兜底文案，不是错误码）
  for (const value of Object.values(presenter.ERROR_PRESENTATIONS)) {
    assert.ok(typeof value === "string" && value.startsWith("err."), `${value} is an err.* catalog key`);
  }
});

/* ---------- code normalize ---------- */

test("normalizeCode accepts approved codes and rejects everything else", () => {
  for (const code of APPROVED_CODES) {
    assert.equal(facts.normalizeCode(code), code);
  }
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "EMPTY", "http_error", "", null, undefined, 0, 1, {}, [], Symbol("x")]) {
    assert.equal(facts.normalizeCode(bad), "INTERNAL", String(typeof bad === "symbol" ? "symbol" : bad));
  }
});

test("ErrorWithCode normalizes an out-of-vocabulary code to INTERNAL", () => {
  const e = new facts.ErrorWithCode("TOTALLY_MADE_UP", { message: "boom" });
  assert.equal(e.code, "INTERNAL");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ErrorWithCode");
});

test("ErrorWithCode falls back to the code itself when no message is supplied", () => {
  assert.equal(new facts.ErrorWithCode("NETWORK_ERROR").message, "NETWORK_ERROR");
  assert.equal(new facts.ErrorWithCode("NETWORK_ERROR", { message: "   " }).message, "NETWORK_ERROR");
  assert.equal(new facts.ErrorWithCode("NETWORK_ERROR", {}).message, "NETWORK_ERROR");
});

/* ---------- meta whitelist ---------- */

test("meta whitelist keeps only a valid integer status and only for HTTP_ERROR", () => {
  assert.deepEqual([...facts.META_WHITELIST], ["status"]);

  const http = new facts.ErrorWithCode("HTTP_ERROR", { meta: { status: 503 } });
  assert.deepEqual(http.meta, { status: 503 });
  assert.deepEqual(presenter.toPresentation({ code: http.code, meta: http.meta }), { key: "err.http", params: { status: 503 } });

  // 非 HTTP_ERROR 不携带 status（presenter 也不会插值，避免死数据外泄）
  for (const code of ["AUTH_INVALID", "INTERNAL", "TIMEOUT"]) {
    assert.deepEqual(new facts.ErrorWithCode(code, { meta: { status: 503 } }).meta, {}, code);
  }

  // 越界/类型非法一律丢弃，落到 err.httpGeneric
  for (const status of [undefined, null, "503", 99, 600, 503.5, NaN, {}, { valueOf: () => 503 }]) {
    const e = new facts.ErrorWithCode("HTTP_ERROR", { meta: { status } });
    assert.deepEqual(e.meta, {}, `status ${String(status)}`);
  }
  for (const status of [100, 599]) {
    assert.deepEqual(new facts.ErrorWithCode("HTTP_ERROR", { meta: { status } }).meta, { status });
  }
});

test("meta drops every non-whitelisted key", () => {
  const e = new facts.ErrorWithCode("HTTP_ERROR", {
    meta: { status: 500, token: "sk-live-x", path: "C:\\secret\\key.json", body: "<html>", ip: "203.0.113.9", reason: "boom" }
  });
  assert.deepEqual(Object.keys(e.meta), ["status"]);
  assert.equal(JSON.stringify(e.meta), '{"status":500}');
  assert.ok(Object.isFrozen(e.meta));
});

test("a status-carrying fact stays inside the presenter's placeholder contract in every locale", () => {
  const i18n = require(require("node:path").join(root, "src/i18n.js"));
  for (const lang of ["zh", "en", "ja"]) {
    const withStatus = presenter.toPresentation({ code: "HTTP_ERROR", meta: { status: 502 } });
    assert.equal(i18n.t(lang, withStatus.key, withStatus.params), i18n.t(lang, "err.http", { status: 502 }));
    const without = presenter.toPresentation({ code: "HTTP_ERROR", meta: facts.normalizeMeta("HTTP_ERROR", { status: "502" }) });
    assert.ok(!i18n.t(lang, without.key, without.params).includes("{status}"), `${lang} generic text has no placeholder`);
  }
});

/* ---------- payload projection ---------- */

test("toPayload projects exactly code, meta and message and never detail", () => {
  const hostileDetail = "{\"error\":\"<html>secret</html>\"} token=sk-live-abc123 body C:\\Users\\alice\\secret.json";
  const err = new facts.ErrorWithCode("HTTP_ERROR", { message: "API 502: upstream exploded", meta: { status: 502 }, detail: hostileDetail });
  const payload = facts.toPayload(err);
  assert.deepEqual(Object.keys(payload).sort(), ["code", "message", "meta"]);
  assert.deepEqual(payload, { code: "HTTP_ERROR", meta: { status: 502 }, message: "API 502" });
  for (const fragment of ["secret", "sk-live", "alice", "<html>", "exploded"]) {
    assert.ok(!JSON.stringify(payload).includes(fragment), `${fragment} leaked into payload`);
  }
  assert.equal(payload.detail, undefined);
});

test("toPayload never carries detail even when the source object is hostile", () => {
  const payload = facts.toPayload(Object.assign(new Error("boom"), {
    code: "INTERNAL", meta: { status: 500, token: "sk-live-zzzz" }, detail: "TOP SECRET detail"
  }));
  assert.deepEqual(Object.keys(payload).sort(), ["code", "message", "meta"]);
  assert.ok(!JSON.stringify(payload).includes("TOP SECRET"));
  assert.ok(!JSON.stringify(payload).includes("sk-live"));
  assert.deepEqual(payload.meta, {}, "non-HTTP_ERROR meta is emptied");
});

test("toPayload is total for any thrown value", () => {
  for (const thrown of [null, undefined, 0, "", "plain string", [], {}, NaN]) {
    const payload = facts.toPayload(thrown);
    assert.equal(payload.code, "INTERNAL");
    assert.deepEqual(payload.meta, {});
    assert.equal(typeof payload.message, "string");
  }
});

/* ---------- diagnostic projection ---------- */

test("toDiagnostic keeps detail for logs while payload stays clean", () => {
  const hostileDetail = "{\"error\":\"<html>secret</html>\"}";
  const err = new facts.ErrorWithCode("AUTH_INVALID", { message: "认证失败", detail: hostileDetail });
  const diag = facts.toDiagnostic(err);
  assert.equal(diag.code, "AUTH_INVALID");
  assert.equal(diag.message, "认证失败");
  assert.equal(diag.detail, hostileDetail, "logs keep the full detail");
  assert.equal(diag.name, "ErrorWithCode");
  assert.ok(!JSON.stringify(facts.toPayload(err)).includes("secret"), "payload remains clean");
});

test("toDiagnostic falls back to stack for plain legacy errors", () => {
  const plain = new Error("legacy failure at C:\\x\\y.js");
  const diag = facts.toDiagnostic(plain);
  assert.equal(diag.code, "INTERNAL");
  assert.ok(diag.detail.includes("at "), "stack captured for diagnostics");
  assert.equal(facts.toDiagnostic(null).code, "INTERNAL");
});

/* ---------- classifyError：事实优先，regex 仅兜底 ---------- */

test("classifyError prefers facts over message text", () => {
  assert.equal(facts.classifyError(Object.assign(new Error("x"), { name: "AbortError" })), "CANCELLED");
  assert.equal(facts.classifyError(new facts.ErrorWithCode("SSRF_BLOCKED", { message: "timeout" })), "SSRF_BLOCKED",
    "an explicit code outranks a message that says 'timeout'");
  assert.equal(facts.classifyError(Object.assign(new Error("timeout"), { status: 401 })), "AUTH_INVALID",
    "a status field outranks a message that says 'timeout'");
});

test("classifyError maps Node/undici errno without touching message text", () => {
  for (const errno of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET"]) {
    assert.equal(facts.classifyError(Object.assign(new Error("opaque"), { code: errno })), "NETWORK_ERROR", errno);
  }
  for (const errno of ["ETIMEDOUT", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(facts.classifyError(Object.assign(new Error("opaque"), { code: errno })), "TIMEOUT", errno);
  }
  assert.equal(facts.classifyError(Object.assign(new Error("opaque"), { code: "ERR_CANCELED" })), "CANCELLED");
});

test("classifyError maps HTTP status carried on the exception", () => {
  assert.equal(facts.classifyError(Object.assign(new Error("x"), { status: 401 })), "AUTH_INVALID");
  assert.equal(facts.classifyError(Object.assign(new Error("x"), { statusCode: 429 })), "QUOTA_EXCEEDED");
  assert.equal(facts.classifyError(Object.assign(new Error("x"), { status: 503 })), "HTTP_ERROR");
});

test("classifyError still recognises legacy message-only errors", () => {
  // 这几条是既有 conversation-service.test.js 的断言，兼容路径不得退化
  assert.equal(facts.classifyError(new Error("HTTP 502: bad")), "HTTP_ERROR");
  assert.equal(facts.classifyError(new Error("The operation was aborted due to timeout")), "TIMEOUT");
  assert.equal(facts.classifyError(new Error("boom")), "INTERNAL");
  assert.equal(facts.classifyError(null), "INTERNAL");
  assert.equal(facts.classifyError(Object.assign(new Error("HTTP 401: nope"), { sseError: true })), "AUTH_INVALID");
});

/* ---------- HTTP status → code ---------- */

test("httpStatusToCode classifies without inventing new codes", () => {
  assert.equal(facts.httpStatusToCode(401), "AUTH_INVALID");
  assert.equal(facts.httpStatusToCode(403), "AUTH_INVALID");
  assert.equal(facts.httpStatusToCode(402), "QUOTA_EXCEEDED");
  assert.equal(facts.httpStatusToCode(429), "QUOTA_EXCEEDED");
  assert.equal(facts.httpStatusToCode(503), "HTTP_ERROR");
  assert.equal(facts.httpStatusToCode(500), "HTTP_ERROR");
  assert.equal(facts.httpStatusToCode(404), "HTTP_ERROR");
  assert.equal(facts.httpStatusToCode(600), "INTERNAL");
  assert.equal(facts.httpStatusToCode("503"), "INTERNAL");
  assert.equal(facts.httpStatusToCode(503.5), "INTERNAL");
});

test("codeForHttpStatus only attaches meta for HTTP_ERROR", () => {
  assert.deepEqual(facts.codeForHttpStatus(503), { code: "HTTP_ERROR", meta: { status: 503 } });
  assert.deepEqual(facts.codeForHttpStatus(401), { code: "AUTH_INVALID", meta: {} });
  assert.deepEqual(facts.codeForHttpStatus(429), { code: "QUOTA_EXCEEDED", meta: {} });
  for (const code of Object.values(facts.codeForHttpStatus(401)).slice(0, 1)) {
    assert.ok(APPROVED_CODES.includes(code));
  }
});

/* ---------- redactMessage ---------- */

test("redactMessage strips provider body, URLs, tokens and stacks", () => {
  const cases = [
    ["API 502: {\"error\":{\"message\":\"upstream secret\"}}", ["API 502"]],
    ["HTTP 429: rate limited by provider <html>sk-live-abcdefgh</html>", ["HTTP 429"]],
    ["连接 https://user:pw@api.example.com/v1?key=sk-live-zzz 失败", ["[url]"]],
    ["token sk-proj-AAAABBBBCCCCDDDD rejected", ["[redacted]"]],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef", ["[redacted]"]]
  ];
  for (const [input, mustContain] of cases) {
    const out = facts.redactMessage(input);
    for (const want of mustContain) assert.ok(out.includes(want), `${input} → ${out}`);
    for (const leak of ["secret", "sk-live", "user:pw", "<html>", "provider"]) {
      if (input.includes(leak)) assert.ok(!out.includes(leak), `${leak} survived in ${out}`);
    }
  }
  const withStack = "boom\n    at fetch (C:\\Users\\alice\\app\\chat-client.js:42:7)";
  assert.equal(facts.redactMessage(withStack), "boom");
});

test("redactMessage keeps plain product copy intact", () => {
  // 既有测试依赖这些文案的子串，脱敏不得误伤
  for (const msg of [
    "目的地与已保存的 API 地址不属于同一来源，为防止已保存的密钥外发已阻止；请先保存设置",
    "请求被重定向到不同来源，为保护凭据已中断",
    "拒绝向内网/链路本地地址发送请求（SSRF 防护）",
    "无法解析服务地址",
    "端口返回了空模型列表（可能不支持该接口）"
  ]) {
    assert.equal(facts.redactMessage(msg), msg, msg);
  }
});

test("redactMessage is total for odd inputs", () => {
  assert.equal(facts.redactMessage(null), "");
  assert.equal(facts.redactMessage(undefined), "");
  assert.equal(typeof facts.redactMessage(123), "string");
});

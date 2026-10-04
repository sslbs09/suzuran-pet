"use strict";

/**
 * Phase 5-C3 契约测试：main 进程结果返回链。
 *
 * 覆盖：
 *  - pet:error 保留 id、增加 code/meta、保留旧 message 字段
 *  - detail / provider body 不进入 IPC payload、不进入 renderer
 *  - Agent /chat 响应保留 error 字段（协议兼容）并补 code/meta
 *
 * main.js 依赖 Electron，无法直接 require；沿用本仓既有做法（main-native-i18n.test.js）
 * 对生产源码做静态断言，并配合 toPayload 的行为断言锁住载荷形状。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");
const facts = require("../src/error-facts.js");
const presenter = require("../src/error-presenter.js");

function region(marker, length = 900) {
  const at = mainSource.indexOf(marker);
  assert.notEqual(at, -1, `main.js contains: ${marker}`);
  return mainSource.slice(at, at + length);
}

/** pet:error 有两处发送（条款闸门 + 生成异常），必须按异常处理器精确定位，
 *  否则会误匹配到条款闸门那条无 code 的静态文案。 */
function petErrorHandler() {
  const at = mainSource.indexOf("const fact = errorFacts.toPayload(err);");
  assert.notEqual(at, -1, "main.js projects the pet:error payload");
  const start = mainSource.lastIndexOf("} catch (err) {", at);
  assert.notEqual(start, -1, "the projection lives inside a catch (err) block");
  return mainSource.slice(start, at + 400);
}

/* ---------------- pet:error ---------------- */

test("pet:error keeps id, adds code/meta, and keeps the legacy message field", () => {
  const block = petErrorHandler();
  assert.match(block, /\{\s*id,\s*code:\s*fact\.code,\s*meta:\s*fact\.meta,\s*message:\s*fact\.message\s*\}/,
    "pet:error payload must be { id, code, meta, message }");
  assert.match(block, /sender\.send\("pet:error"/);
  assert.match(block, /errorFacts\.toPayload\(/, "payload comes from the single cross-boundary projection");
});

test("pet:error no longer derives its code from message text", () => {
  const block = petErrorHandler();
  assert.ok(!/classifyError\(/.test(block), "no regex/text classification at the send site");
  assert.ok(!/String\(err\.message/.test(block), "raw err.message is not shipped verbatim");
});

test("pet:error keeps the AbortError guard so an explicit stop stays silent", () => {
  const block = petErrorHandler();
  assert.match(block, /err\.name\s*!==\s*"AbortError"\s*&&\s*isCurrent\(\)/,
    "abort guard preserved verbatim");
});

test("the pet:error payload shape is exactly what the projection emits", () => {
  const payload = facts.toPayload(new facts.ErrorWithCode("HTTP_ERROR", { meta: { status: 503 }, message: "API 503", detail: "leak" }));
  assert.deepEqual(Object.keys(payload).sort(), ["code", "message", "meta"]);
  const wire = { id: "task-1", code: payload.code, meta: payload.meta, message: payload.message };
  assert.deepEqual(Object.keys(wire).sort(), ["code", "id", "message", "meta"]);
  assert.equal(wire.id, "task-1", "id survives");
  assert.equal(wire.code, "HTTP_ERROR");
  assert.deepEqual(wire.meta, { status: 503 });
  assert.ok(!JSON.stringify(wire).includes("leak"), "detail never crosses into the renderer");
});

test("every code pet:error can emit is renderable by the Phase 5-A presenter", () => {
  for (const code of Object.keys(facts.ERROR_CODES)) {
    const wire = { id: "t", code, meta: code === "HTTP_ERROR" ? { status: 500 } : {}, message: "x" };
    const presentation = presenter.toPresentation(wire);
    assert.ok(presentation.key.startsWith("err."), `${code} → ${presentation.key}`);
  }
});

/* ---------------- Agent /chat ---------------- */

test("Agent /chat error response keeps its legacy error field and adds code/meta", () => {
  const agentBlock = region('if (e && e.code === "BUSY")', 600);
  assert.match(agentBlock, /\{\s*ok:\s*false,\s*error:\s*fact\.message,\s*code:\s*fact\.code,\s*meta:\s*fact\.meta\s*\}/,
    "Agent 500 body must stay {ok,error} and gain code/meta");
  assert.match(agentBlock, /errorFacts\.toPayload\(/);
  assert.ok(!/String\(e\.message/.test(agentBlock), "raw e.message is not shipped verbatim");
});

test("Agent /chat busy and queue-full responses keep their literal copy", () => {
  const busy = region('if (e && e.code === "BUSY")', 200);
  assert.match(busy, /429/);
  assert.match(busy, /角色正忙（busy），请稍后重试/);
  assert.match(region('if (enq.busy)', 200), /请求繁忙（并发队列已满），请稍后重试/);
});

test("Agent responses never carry detail or provider body", () => {
  const hostile = '{"error":"<html>upstream secret</html>"} sk-live-abcdefgh1234';
  const err = new facts.ErrorWithCode("HTTP_ERROR", { meta: { status: 500 }, message: "API 500", detail: hostile });
  const fact = facts.toPayload(err);
  const body = { ok: false, error: fact.message, code: fact.code, meta: fact.meta };
  assert.deepEqual(Object.keys(body).sort(), ["code", "error", "meta", "ok"], "no detail key");
  const wire = JSON.stringify(body);
  for (const leak of ["upstream secret", "sk-live", "<html>"]) {
    assert.ok(!wire.includes(leak), `${leak} leaked into the Agent response`);
  }
});

/* ---------------- 全局不变量 ---------------- */

test("main.js routes every error send through the single projection", () => {
  const sites = [...mainSource.matchAll(/send\(\d+,\s*\{\s*ok:\s*false,\s*error:\s*String\(/g)];
  assert.equal(sites.length, 0, `no raw String(e.message) reaches a wire response (found ${sites.length})`);
  assert.match(mainSource, /require\("\.\/src\/error-facts"\)/, "main.js owns the projection import");
});

test("main.js does not re-implement code tables of its own", () => {
  assert.ok(!/const ERROR_CODES\s*=\s*\{/.test(mainSource), "no local error-code table in main.js");
  assert.equal((mainSource.match(/errorFacts\.toPayload\(/g) || []).length, 3,
    "pet:error + Agent 500 (inner + outer) all go through toPayload");
});
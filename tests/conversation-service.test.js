/** conversation-service 单测（node）——单写者/任务ID/取消/错误码（TD-4） */
"use strict";
const { createConversationService, classifyError, ERROR_CODES } = require("../src/conversation-service");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

// 单写者
const svc = createConversationService();
assert("空闲可启动", svc.canStart() === true && svc.isBusy() === false);
const t1 = svc.start({ kind: "chat" });
assert("启动成功", t1.ok === true && !!t1.signal && typeof t1.isCurrent === "function");
assert("busy 时再启动→BUSY", svc.start({ kind: "regenerate" }).code === ERROR_CODES.BUSY);
assert("isCurrent(id) 为真", svc.isCurrent(t1.id) === true);
assert("snapshot 携带 kind/meta", svc.snapshot().kind === "chat" && svc.snapshot().meta === null);
assert("isCurrent(错误 id) 为假", svc.isCurrent("nope") === false);

// 取消
assert("cancel(错误 id)→false", svc.cancel("nope") === false);
assert("cancelCurrent→true", svc.cancelCurrent() === true);
assert("取消后 abort 生效", t1.signal.aborted === true);
assert("取消后 isCurrent 为假", t1.isCurrent() === false);
assert("取消后可再次启动（未 finish 也允许？）——应仍 busy", svc.isBusy() === true);
svc.finish(t1.id);
assert("finish 后空闲", svc.isBusy() === false && svc.snapshot() === null);

// finish 只清当前任务
const t2 = svc.start({ kind: "zcode" });
svc.finish("别的id");
assert("finish(不匹配id) 不清任务", svc.isBusy() === true);
svc.finish(t2.id);
assert("finish(匹配id) 清任务", svc.isBusy() === false);

// start 期间 finish 后可再启动；kind 记录
const t3 = svc.start({ kind: "regenerate", meta: { sender: "opaque" } });
assert("kind=regenerate 记录", svc.snapshot().kind === "regenerate" && svc.snapshot().meta.sender === "opaque");
svc.cancel(t3.id);
svc.finish(t3.id);

// 错误码分类
assert("AbortError→CANCELLED", classifyError(Object.assign(new Error("x"), { name: "AbortError" })) === ERROR_CODES.CANCELLED);
assert("HTTP 502→HTTP_ERROR", classifyError(new Error("HTTP 502: bad")) === ERROR_CODES.HTTP_ERROR);
assert("timeout→TIMEOUT", classifyError(new Error("The operation was aborted due to timeout")) === ERROR_CODES.TIMEOUT);
assert("其他→INTERNAL", classifyError(new Error("boom")) === ERROR_CODES.INTERNAL);
assert("空→INTERNAL", classifyError(null) === ERROR_CODES.INTERNAL);

process.exit(failed ? 1 : 0);

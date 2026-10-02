"use strict";

/**
 * busy-buffer/refire 生命周期回归（2026-10-02 实机 FAIL）：
 * 根因一：handleAskInner finally 用渲染层 payload.id 调 conversation.finish——
 *         与 start() 自分配的服务端 task.id（独立 UUID）永不相等，busy 从会话第一条
 *         消息起永久泄漏；后续所有请求进 busy 分支。
 * 根因二：busy 分支的合并定时器回调在 busy 仍为 true 时直接重入 handleAsk，而
 *         handleAsk 把 chatPauseWalk(true/false) 包在所有路径外层 → walk.active 时
 *         每 300ms 一对 acquire/release + walkBroadcast 翻转（单腿闪烁 / pause 风暴，
 *         chatLease token 无限增长），provider 永不重启（气泡停在 "..."）。
 * 修复：finish(task.id) + BUSY 只 buffer（外层 gate，不 acquire pause）
 *       + 补发由 busy owner 真实释放事件驱动（ask/regenerate finally drain），
 *         定时器回调只调 drain（空闲才 take，恰好一次）。
 * 语义基线：v2.6 message-buffer 既有「单槽 latest-wins」不变。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const { createConversationService } = require("../src/conversation-service");
const { createDebounceBuffer } = require("../src/message-buffer");
const { createPauseAuthority } = require("../src/state-core/pause-authority");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");
const helpers = mainSource.slice(mainSource.indexOf("function bufferAsk"), mainSource.indexOf("async function handleAsk(sender"));
const askFn = mainSource.slice(mainSource.indexOf("async function handleAsk(sender"), mainSource.indexOf("async function handleAskInner"));
const inner = mainSource.slice(mainSource.indexOf("async function handleAskInner"), mainSource.indexOf('ipcMain.handle("pet:ask"'));

/* ---------------- 0. busy 泄漏根因（ownership） ---------------- */

test("BUSY-LEAK-1: finish 必须用 start 分配的服务端 task.id；错误 id 的 finish 会永久泄漏 busy（模块行为证据）", () => {
  const c = createConversationService();
  const t = c.start({ kind: "chat", meta: { sender: {} } });
  assert.equal(t.ok, true);
  c.finish("00000000-0000-4000-8000-000000000000"); // 渲染层 payload.id（与 task.id 不同的 UUID）
  assert.equal(c.isBusy(), true, "旧 ask 路径形状：finish(错误 id) → busy 永久卡死");
  c.finish(t.id);
  assert.equal(c.isBusy(), false, "finish(task.id) 才真正释放单写者");
});

test("BUSY-LEAK-2: ask finally 源码合同——finish(task.id)，旧 finish(id) 形状不得复活", () => {
  assert.match(inner, /conversation\.finish\(task\.id\);/, "ask 路径用服务端 task.id 收口");
  assert.doesNotMatch(inner, /conversation\.finish\(id\);/, "渲染层 payload.id 不得作为 finish 参数");
});

/* ---------------- 1. BUSY-BUFFER-NO-SPIN ---------------- */

test("BUSY-BUFFER-NO-SPIN-1: busy 请求在 handleAsk 外层直接进单槽缓冲——不 acquire chat pause、不进入 provider 路径", () => {
  const gateIdx = askFn.indexOf("conversation.isBusy()");
  const acquireIdx = askFn.indexOf("chatPauseWalk(true)");
  assert.ok(gateIdx !== -1 && gateIdx < acquireIdx, "busy gate 必须先于 pause acquire");
  assert.match(askFn, /if \(conversation\.isBusy\(\)\) \{ bufferAsk\(sender, \{ id: payload && payload\.id, text: payload && payload\.text \}\); return; \}/, "busy 分支只 buffer + return");
});

test("BUSY-BUFFER-NO-SPIN-2: 定时器回调不得直接重入 handleAsk（旧 300ms 自激形状已删除）", () => {
  assert.match(helpers, /pendingAskTimer = setTimeout\(\(\) => \{ pendingAskTimer = null; drainAskBuffer\("coalesce-window"\); \}, ASK_COALESCE_MS\);/, "定时器只调 drain");
  assert.doesNotMatch(helpers, /setTimeout\([^)]*\)[\s\S]{0,120}handleAsk\(/, "timer 回调体内不得出现 handleAsk 直接重入");
  assert.doesNotMatch(inner, /setTimeout\([\s\S]{0,200}handleAsk\(/, "inner 旧自激块整体不得复活");
});

test("BUSY-BUFFER-NO-SPIN-3: drain 语义——busy 未清则原地等待事件，绝不 take/绝不递归", () => {
  assert.match(helpers, /function drainAskBuffer\(reason\) \{[\s\S]{0,80}if \(conversation\.isBusy\(\)\) return;/, "drain 首行 busy 守卫");
});

/* ---------------- 2. BUSY-RELEASE-REFIRE-ONCE ---------------- */

test("BUSY-RELEASE-REFIRE-ONCE: owner 释放后缓冲恰好补发一次；重复 drain 不再触发", () => {
  const c = createConversationService();
  const buf = createDebounceBuffer();
  let refires = 0;
  const drain = () => { // 生产 drainAskBuffer 的同构模拟（busy 守卫 + take 一次 + 计数即补发）
    if (c.isBusy()) return;
    const p = buf.take();
    if (p) refires += 1;
  };
  const t = c.start({ kind: "chat" });
  buf.push({ payload: { text: "第一条" } });
  buf.push({ payload: { text: "第二条" } }); // 单槽 latest-wins
  drain();
  assert.equal(refires, 0, "busy 期间 drain 不补发（无风暴）");
  c.finish(t.id);
  drain();
  assert.equal(refires, 1, "owner 释放后恰好补发一次");
  drain();
  assert.equal(refires, 1, "无缓冲时 drain 空转，绝不重复补发");
});

test("BUSY-RELEASE-REFIRE-ONCE-2: owner 完成事件接线——ask finally 与 regenerate finally 都 drain", () => {
  assert.match(askFn, /drainAskBuffer\("ask-complete"\);/, "ask owner 释放后兑现补发");
  assert.match(mainSource, /finally \{ conversation\.finish\(task\.id\); drainAskBuffer\("regen-complete"\); \}/, "regen owner 释放后同样补发");
});

/* ---------------- 3. PAUSE-OWNERSHIP ---------------- */

test("PAUSE-OWNERSHIP-1: chat pause 只在真实执行路径 acquire，completion 后 release（finally 配对，含异常路径）", () => {
  assert.match(askFn, /chatPauseWalk\(true\);\s*try \{\s*await handleAskInner\(sender, payload\);\s*\} finally \{\s*chatPauseWalk\(false\);/, "acquire→try→finally release 结构完整");
  assert.ok(askFn.indexOf("chatPauseWalk(false)") < askFn.indexOf("drainAskBuffer(\"ask-complete\")"), "先释放 pause 再补发（补发请求自己重新 acquire）");
});

test("PAUSE-OWNERSHIP-2: buffered 阶段不持有 lease——真实模块下 acquire/release 恰好一对且零残留", () => {
  const pause = createPauseAuthority();
  // 模拟一次执行过的请求（buffer 请求不会走到这里，由 1 号合同保证）
  const a = pause.acquire("chat", { leaseId: "chat-1", domain: "main" });
  assert.equal(pause.effectivePaused(), true);
  const r = pause.release("chat", { leaseId: a.leaseId });
  assert.equal(r.ok, true);
  assert.equal(pause.effectivePaused(), false);
  assert.deepEqual(pause.activeSources(), [], "completion 后 lease 零残留");
});

/* ---------------- 4. WALK-INTEGRATION ---------------- */

test("WALK-INTEGRATION: 泄漏修复+事件补发下，一轮 walk+chat 的 pause 边沿恰好 1 acquire / 1 release；竞态路径同样入可 drain 缓冲", () => {
  const pause = createPauseAuthority();
  const c = createConversationService();
  // owner 回合：acquire 一次 → provider（用 start/finish 代表）→ release 一次
  const t = c.start({ kind: "chat" });
  pause.acquire("chat", { leaseId: "chat-1", domain: "main" });
  assert.equal(pause.effectivePaused(), true, "chat active 期间 walking paused");
  c.finish(t.id); // busy 真正释放（finish(task.id) 修复的直接效果）
  assert.equal(c.isBusy(), false, "第二句不再撞 busy，不再进入 refire 循环");
  pause.release("chat", { leaseId: "chat-1" });
  assert.equal(pause.effectivePaused(), false, "provider 完成后 walking 恢复");
  // 竞态路径合同：单写者竞态也 bufferAsk（可获得补发），不再裸 push 进死信箱
  assert.match(inner, /bufferAsk\(sender, \{ id, text \}\);[^\n]*\n\s*logTts\("chat", "生成防抖: 单写者竞态缓冲"\);/);
});

/* ---------------- 5. MULTIPLE-BUFFER（既有语义，不自创） ---------------- */

test("MULTIPLE-BUFFER: v2.6 既有语义 = 单槽 latest-wins；pet:stop 主动丢弃（用户要静默不是补发）", () => {
  const buf = createDebounceBuffer();
  buf.push({ i: 1 }); buf.push({ i: 2 }); buf.push({ i: 3 });
  assert.deepEqual(buf.take(), { i: 3 }, "只留最新一条（覆盖式单槽）");
  assert.equal(buf.take(), null, "take 后清空，不多发");
  buf.push({ i: 4 }); buf.clear();
  assert.equal(buf.has(), false, "stop 丢弃缓冲（既有语义保留）");
  assert.match(mainSource, /askBuffer\.clear\(\);/, "pet:stop 仍显式清缓冲");
});

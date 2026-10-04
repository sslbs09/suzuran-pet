"use strict";

/**
 * chat-ingress-ownership.test.js — P5：外部 chat ingress ownership 闭合回归。
 *
 * 背景：此前 chat 有多条入口（UI pet:ask、HTTP Agent API /chat、未来 MCP/DSH/Codex），
 * 各自决定要不要拿 chat pause lease。结果 /chat 走 chatClient.chat() 直连，
 * 完全绕过 handleAsk 的 chatPauseWalk —— 角色"正在对话"但 locomotion 不冻结、state-core 无感知；
 * 且两条入口并发时，chatLease 单槽会让先释放者 lease-id-mismatch 被拒并清空槽，
 * 后释放者退化为 noop → chat pause **永久泄漏**。
 *
 * 修复：新增 src/chat-ownership.js 作为「角色进入聊天交互」的 ownership 单一权威。
 * /chat 与未来入口经 chatOwnership.run()，与 UI chat 共用 conversation 单写者互斥 +
 * chat pause lease 成对持有；排队期间不触碰 ownership。
 *
 * 本测试**直接消费真实 pauseAuthority / conversationService 模块**，
 * 不 mock「pause 被调用过」——断言的是 lease 的真实可见状态与零残留。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { createPauseAuthority } = require("../src/state-core/pause-authority");
const { createConversationService } = require("../src/conversation-service");
const { createChatOwnership } = require("../src/chat-ownership");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");

/**
 * 生产同构装配：真实 pause authority + 生产同款的 chatLease 单槽语义。
 * chatLease 是单槽（chatLeaseId）：重复 acquire 会顶掉前一个 leaseId，
 * 前一个的 release 因此 lease-id-mismatch —— 这正是本次要防的泄漏面。
 */
function harness(opts = {}) {
  const pause = createPauseAuthority();
  const conversation = createConversationService();
  let chatLeaseId = null;
  let seq = 0;
  const deny = { release: 0 };

  const pauseWalk = (p) => {
    if (p) {
      const l = pause.acquire("chat", { leaseId: "chat-" + (++seq), domain: "main" });
      chatLeaseId = l.leaseId;
      return;
    }
    if (chatLeaseId === null) return;
    const r = pause.release("chat", { leaseId: chatLeaseId });
    if (r.ok) chatLeaseId = null;
    else deny.release += 1;
  };

  const ownership = createChatOwnership({ conversation, pauseWalk, waitMs: opts.waitMs ?? 0, stepMs: 1 });
  return { pause, conversation, ownership, deny, leaseId: () => chatLeaseId };
}

/* ============================ A. UI chat ============================ */

test("A1: UI chat 执行期间 chat pause 真实生效，完成后 lease 归零", async () => {
  const h = harness();
  // UI 路径同构：conversation 单写者 + chatPauseWalk 成对（handleAsk 的形状，见 F1 源码合同）
  const task = h.conversation.start({ kind: "chat" });
  h.pause.acquire("chat", { leaseId: "ui-1", domain: "main" });

  assert.equal(h.pause.effectivePaused(), true, "UI 执行期间 chat pause 生效");
  assert.deepEqual(h.pause.activeSources(), ["chat"]);

  h.pause.release("chat", { leaseId: "ui-1" });
  h.conversation.finish(task.id);

  assert.equal(h.pause.effectivePaused(), false, "完成后 pause 解除");
  assert.deepEqual(h.pause.activeSources(), [], "lease 零残留");
  assert.equal(h.conversation.isBusy(), false, "busy owner 零残留");
});

test("A2: UI 与外部入口共用同一个 conversation 单写者——外部对话期间 UI 走 busy 缓冲", async () => {
  const h = harness();
  const external = h.ownership.run(async () => {
    assert.equal(h.conversation.isBusy(), true, "外部 chat 执行期间单写者被占用");
    return "ok";
  }, { source: "agent-api" });

  // UI 侧此时执行 handleAsk 的 busy 门
  assert.equal(h.conversation.isBusy(), true, "UI 侧看到 busy → 走 bufferAsk，不 acquire pause");
  assert.equal(await external, "ok");
  assert.equal(h.conversation.isBusy(), false, "外部完成后单写者释放，UI 补发可继续");
});

/* ============================ B. HTTP /chat ============================ */

test("B1: /chat 执行期间与 UI chat 完全相同的 ownership——pause 生效 + locomotion 冻结语义", async () => {
  const h = harness();
  let observedDuringExec = null;
  const r = await h.ownership.run(async () => {
    observedDuringExec = {
      paused: h.pause.effectivePaused(),
      sources: h.pause.activeSources().slice(),
      busy: h.conversation.isBusy(),
    };
    return { reply: "hi" };
  }, { source: "agent-api" });

  assert.deepEqual(r, { reply: "hi" });
  assert.equal(observedDuringExec.paused, true, "外部 chat 执行期间 chat pause 生效（此前完全不生效）");
  assert.deepEqual(observedDuringExec.sources, ["chat"], "持有 chat lease");
  assert.equal(observedDuringExec.busy, true, "持有会话单写者");
  assert.equal(h.pause.effectivePaused(), false, "完成后释放");
  assert.deepEqual(h.pause.activeSources(), [], "零残留");
});

test("B2: /chat 与 UI chat 并发时，外部入口被明确拒绝而非无主执行", async () => {
  const h = harness();
  const ui = h.conversation.start({ kind: "chat", meta: { source: "ui" } });
  h.pause.acquire("chat", { leaseId: "ui-1", domain: "main" });

  await assert.rejects(
    () => h.ownership.run(async () => "should-not-run", { source: "agent-api" }),
    (e) => e && e.code === "BUSY",
    "UI 对话期间外部 chat 必须 BUSY，不得无 ownership 执行"
  );

  h.pause.release("chat", { leaseId: "ui-1" });
  h.conversation.finish(ui.id);
  assert.equal(h.pause.effectivePaused(), false, "UI 释放后无残留");
});

/* ============================ C. /chat 失败路径 ============================ */

test("C1: exec 抛错 → lease 与 busy owner 全部释放，零残留", async () => {
  const h = harness();
  await assert.rejects(
    () => h.ownership.run(async () => { throw new Error("provider boom"); }, { source: "agent-api" }),
    /provider boom/
  );
  assert.equal(h.pause.effectivePaused(), false, "异常路径也释放 pause");
  assert.deepEqual(h.pause.activeSources(), [], "lease 零残留");
  assert.equal(h.conversation.isBusy(), false, "busy owner 零残留（不卡死后续请求）");
});

test("C2: exec 被取消（AbortError）→ 同样完整释放", async () => {
  const h = harness();
  const ac = new AbortController();
  const p = h.ownership.run(async () => {
    ac.abort();
    const e = new Error("aborted"); e.name = "AbortError"; throw e;
  }, { source: "agent-api", signal: ac.signal });
  await assert.rejects(() => p, (e) => e && e.name === "AbortError");
  assert.equal(h.pause.effectivePaused(), false);
  assert.deepEqual(h.pause.activeSources(), []);
  assert.equal(h.conversation.isBusy(), false);
});

test("C3: 预先已取消的 signal 不进入执行、不碰 ownership", async () => {
  const h = harness();
  const ac = new AbortController(); ac.abort();
  let ran = false;
  await assert.rejects(
    () => h.ownership.run(async () => { ran = true; }, { source: "agent-api", signal: ac.signal }),
    (e) => e && e.code === "BUSY"
  );
  assert.equal(ran, false, "预取消不得进入执行");
  assert.equal(h.ownership.isHeld(), false);
  assert.equal(h.conversation.isBusy(), false);
});

/* ============================ D. 缓冲 / 排队 ============================ */

test("D1: 被缓冲（排队）的外部请求不持有任何 ownership；真正 refire 时才 acquire", async () => {
  const h = harness();
  // 模拟 agentTaskQueue 串行链：第二个请求先排队，不进入 run()
  const buffer = [];
  const running = h.ownership.run(async () => {
    // 第一个还在跑 → 第二个到达 → 只入缓冲
    buffer.push("second");
    assert.equal(h.pause.activeSources().length, 1, "缓冲期间 chat lease 恰好 1 份（不得因缓冲而多拿）");
    return "first";
  }, { source: "agent-api-1" });

  assert.equal(await running, "first");
  assert.equal(h.pause.activeSources().length, 0, "第一个完成后 lease 归零");

  // refire：缓冲那条此时才真正进入 ownership 路径
  const refired = h.ownership.run(async () => "second", { source: "agent-api-2" });
  assert.equal(await refired, "second");
  assert.equal(h.pause.activeSources().length, 0, "refire 完成后同样归零");
  assert.equal(h.conversation.isBusy(), false, "不得泄漏 busy owner");
  assert.equal(buffer.length, 1);
});

test("D2: 缓冲期间绝不长时间占用 pause（等待者不持有 ownership）", async () => {
  const h = harness({ waitMs: 30 });
  const held = h.ownership.run(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return "a";
  }, { source: "a" });
  // 并发第二个：会短暂等待，但等待期间不 acquire
  const other = h.ownership.run(async () => "b", { source: "b" }).catch((e) => e.code);
  await held;
  const r2 = await other;
  // 单写者先拒（真实语义）：要么 BUSY，要么拿到后正常完成——两种都不残留
  assert.ok(r2 === "BUSY" || r2 === "b");
  assert.deepEqual(h.pause.activeSources(), [], "任何路径都不残留 lease");
  assert.equal(h.conversation.isBusy(), false);
});

/* ============================ E. 重叠 / 陈旧回调 ============================ */

test("E1: 陈旧 token 的 exit 被拒且**不清槽**——真 owner 随后仍能正常释放", () => {
  const h = harness();
  const a = h.ownership.enter("A");
  assert.equal(a.ok, true);
  assert.equal(h.pause.effectivePaused(), true);

  const stale = h.ownership.exit(a.token + 999);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale-release");
  assert.equal(h.ownership.isHeld(), true, "陈旧 exit 不得清掉 ownership 槽");
  assert.equal(h.pause.effectivePaused(), true, "陈旧 exit 不得释放 lease");

  const ok = h.ownership.exit(a.token);
  assert.equal(ok.ok, true);
  assert.equal(h.pause.effectivePaused(), false, "真 owner 释放成功");
  assert.deepEqual(h.pause.activeSources(), []);
});

test("E2: A 完成后 B 接管，A 的迟到 finally 不得释放 B 的 lease（原始泄漏场景）", async () => {
  const h = harness();
  await h.ownership.run(async () => "A", { source: "A" });       // A 完成，lease 归零
  const bPromise = h.ownership.run(async () => {                   // B 接管
    assert.equal(h.pause.effectivePaused(), true, "B 持有 lease");
    return "B";
  }, { source: "B" });

  // A 的重复/迟到 completion 此刻才回来（网络重试、finally 重入、缓冲补发竞态）
  const lateA = h.ownership.exit(1);
  assert.equal(lateA.ok, false, "A 的迟到 release 必须被拒");
  assert.equal(lateA.reason, "stale-release");
  assert.equal(h.ownership.isHeld(), true, "B 的 ownership 未被 A 的迟到回调清掉");
  assert.equal(h.pause.effectivePaused(), true, "B 的 lease 未被 A 的迟到回调释放");

  assert.equal(await bPromise, "B");
  assert.equal(h.pause.effectivePaused(), false, "B 正常收口，lease 归零");
  assert.equal(h.deny.release, 0, "不应出现被拒的 release（闩已挡住重复进入）");
});

test("E3: chatPauseWalk 互斥闩源码合同——重复 enter / 无主 exit 不得改变 lease 槽", () => {
  const body = mainSource.slice(
    mainSource.indexOf("function chatPauseWalk"),
    mainSource.indexOf("async function handleAsk(sender")
  );
  assert.match(body, /if \(chatPauseHeld\) return; chatPauseHeld = true;/, "重复 enter 被闩挡住");
  assert.match(body, /if \(!chatPauseHeld\) return; chatPauseHeld = false;/, "无主 exit 被闩挡住");
  // COMPAT-22 原有合同不得丢
  assert.match(body, /v2StateCore\.chatLease\.(acquire|release)\(\)/);
  assert.match(body, /v2StateCore\.syncPauseProjection\(\)/);
});

/* ============================ F. 接线 + 既有修复未回归 ============================ */

test("F1: UI chat 路径保持 0b1f48e 的 acquire→try→finally→release→drain 结构（逐字）", () => {
  const askFn = mainSource.slice(
    mainSource.indexOf("async function handleAsk(sender"),
    mainSource.indexOf("async function handleAskInner")
  );
  assert.match(askFn, /chatPauseWalk\(true\);\s*try \{\s*await handleAskInner\(sender, payload\);\s*\} finally \{\s*chatPauseWalk\(false\);/,
    "UI chat ownership 结构未被本次改动破坏");
  assert.ok(askFn.indexOf("chatPauseWalk(false)") < askFn.indexOf('drainAskBuffer("ask-complete")'),
    "先释放 pause 再补发");
  assert.match(askFn, /if \(conversation\.isBusy\(\)\) \{ bufferAsk\(sender, \{ id: payload && payload\.id, text: payload && payload\.text \}\); return; \}/,
    "busy 期间只缓冲、不 acquire pause（0b1f48e 语义保持）");
});

test("F2: /chat 不再直连 chatClient.chat——已接入 canonical ownership 路径", () => {
  const chat = mainSource.slice(mainSource.indexOf("const enq = agentTaskQueue.enqueue"));
  assert.match(chat, /chatOwnership\.run\(/, "/chat 必须经 chatOwnership.run");
  assert.match(chat, /chatClient\.chat\(\{/, "provider 调用保留在 ownership 内部");
  const runIdx = chat.indexOf("chatOwnership.run(");
  const providerIdx = chat.indexOf("chatClient.chat({");
  assert.ok(runIdx !== -1 && runIdx < providerIdx, "ownership 包裹 provider：先拿 lease 再执行");
  assert.match(chat, /source: "agent-api"/, "入口来源元数据");
});

test("F3: ownership 被拒时 /chat 返回 429（busy）而非 500", () => {
  const chat = mainSource.slice(mainSource.indexOf("const enq = agentTaskQueue.enqueue"));
  assert.match(chat, /e\.code === "BUSY"/, "BUSY 需单独分流");
  assert.match(chat, /send\(429, \{ ok: false, error: "角色正忙（busy），请稍后重试", code: "BUSY", meta: \{\} \}\)/, "busy → 429，保留旧 error 并补充事实");
});

test("F4: conversation 单写者在 /chat 路径被成对 start/finish（不泄漏 busy owner）", () => {
  const mod = fs.readFileSync(path.join(__dirname, "..", "src", "chat-ownership.js"), "utf8");
  assert.match(mod, /conversation\.start\(\{ kind: "chat"/, "必须参与既有单写者");
  assert.match(mod, /exit\(claim\.token\);[\s\S]{0,80}conversation\.finish\(task\.id\)/,
    "释放顺序不变量：先 exit（放 lease）后 finish（放单写者）——反序会导致下一 owner 被陈旧 release 误清");
});

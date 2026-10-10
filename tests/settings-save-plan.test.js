"use strict";

/**
 * settings-save-plan 纯模块契约测试（node，无 DOM/IPC）。
 * 锁定 P2 产品语义保存模型的数据不变量（Implementation Plan §21）：
 *   A. 每个成员 id 最多属于一个事务
 *   B. Rule A 与事务成员不重叠
 *   C. 旧 doSaveOther/doSaveApi/doSaveVoice 全部键都有新 owner
 *   D. 事务 payload 只含本组字段
 *   E. identity 不进入 AI payload
 *   F. weather 走 set-weather 描述符（不走 save-settings 白名单）
 *   G/H. refAudio/refText、python/serverScript 成对
 *   I. unknown id 不被静默保存
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const SSP = require("../renderer/settings-save-plan");

test("A: 每个成员 id 最多属于一个事务", () => {
  const seen = new Map();
  for (const id of SSP.allTransactionIds()) {
    const tx = SSP.transactionOf(id);
    assert.ok(tx, `${id} 必须归属事务`);
    assert.equal(seen.has(id), false, `${id} 重复出现在 ${seen.get(id)} 与 ${tx}`);
    seen.set(id, tx);
  }
});

test("B: Rule A 与事务成员不重叠", () => {
  const txIds = new Set(SSP.allTransactionIds());
  for (const id of Object.keys(SSP.RULE_A_PATCH)) {
    assert.equal(txIds.has(id), false, `${id} 不能同时是 Rule A 与事务成员`);
    assert.equal(SSP.transactionOf(id), null, `${id} 不得归属事务`);
  }
});

test("C: 旧保存模型全部键都有新 owner（doSaveApi/doSaveVoice/doSaveOther 对账）", () => {
  // 旧 doSaveApi（chat 事务字段 + pet.name/chat.userName 已拆 identity + 采样改 Rule A）
  const legacyOwners = {
    // doSaveApi → tx-ai-provider / tx-identity / Rule A
    "api-type": "tx-ai-provider", "base-url": "tx-ai-provider", "model": "tx-ai-provider", "api-key": "tx-ai-provider",
    "pet-name": "tx-identity", "user-name": "tx-identity",
    "temperature": "rule-a", "max-tokens": "rule-a", "max-history": "rule-a",
    "smp-topp": "rule-a", "smp-minp": "rule-a", "smp-reppen": "rule-a", "smp-presence": "rule-a", "smp-frequency": "rule-a",
    // doSaveVoice → Rule A（既有专用通道或单键 patch）/ tx-engine-deploy / tx-ref-audio
    "tts-enabled": "rule-a-setTts", "tts-rate": "rule-a-setRate", "sys-voice-fallback": "rule-a",
    "greeting-on-start": "rule-a", "tts-plan": "rule-a", "genie-speak-ja": "rule-a-setSpeakJa",
    "genie-python": "tx-engine-deploy", "genie-script": "tx-engine-deploy",
    "genie-ref-audio": "tx-ref-audio", "genie-ref-text": "tx-ref-audio",
    // doSaveOther → Rule A（patch/专用通道）/ tx-identity / tx-agent / P1 已移除
    "hotkey": "rule-a", "start-hidden": "rule-a", "net-proxy": "rule-a", "auto-launch": "rule-a",
    "feat-clipboard": "rule-a-toggleFeature", "feat-sysmon": "rule-a-toggleFeature", "focus-mode": "rule-a-toggleFeature",
    "feat-memory": "rule-a", "feat-emotional": "rule-a", "feat-desktop-icons": "rule-a",
    "agent-enabled": "tx-agent", "agent-port": "tx-agent", "agent-word": "tx-agent",
    "agent-token": "tx-agent", "agent-max-body": "tx-agent", "agent-status-enabled": "tx-agent",
    "render-mode": "rule-a-existing", "walking-opt": "rule-a-setWalking",
    "rig-scale": "rule-a-existing", "rig-mouse": "rule-a-existing", "rig-mouse-global": "rule-a-existing",
    "mouse-track-global": "rule-a-existing", "cat-toy": "rule-a-existing", "file-guard": "rule-a-existing",
    "proactive-chat": "rule-a-existing", "personify": "rule-a-existing", "rp-mode": "rule-a-existing",
    "window-scale(P1 removed)": "removed"
  };
  for (const [id, owner] of Object.entries(legacyOwners)) {
    assert.notEqual(owner, undefined, `${id} 缺少 owner 记录`);
    if (owner === "removed") continue;
    const isTx = SSP.transactionOf(id);
    const isRuleA = !!SSP.RULE_A_PATCH[id];
    const isExistingChannel = owner.startsWith("rule-a-existing") || owner.startsWith("rule-a-set");
    if (owner.startsWith("tx-")) assert.equal(isTx, owner, `${id} → ${owner}`);
    if (owner === "rule-a") assert.equal(isRuleA, true, `${id} 应在 RULE_A_PATCH`);
    if (isExistingChannel) assert.equal(isTx, null, `${id} 走既有专用通道，不入事务`);
  }
  // 语义对账：采样/回复长度/记忆轮数 = Rule A 单键；AI 事务只留连接四件套
  assert.deepEqual(SSP.TRANSACTIONS["tx-ai-provider"].ids, ["api-type", "base-url", "model", "api-key"]);
});

test("D: 事务 payload 只包含本组字段", () => {
  const sentinels = {};
  for (const txId of Object.keys(SSP.TRANSACTIONS)) {
    for (const id of SSP.TRANSACTIONS[txId].ids) sentinels[id] = `V-${id}-V`;
  }
  const get = (id) => (sentinels[id] !== undefined ? sentinels[id] : "");
  for (const [txId, tx] of Object.entries(SSP.TRANSACTIONS)) {
    const payload = tx.build(get, true);
    const flat = JSON.stringify(payload);
    for (const other of Object.keys(SSP.TRANSACTIONS)) {
      if (other === txId) continue;
      for (const otherId of SSP.TRANSACTIONS[other].ids) {
        assert.equal(flat.includes(`V-${otherId}-V`), false, `${txId} payload 泄漏了 ${other} 的字段 ${otherId}`);
      }
    }
  }
});

test("E: identity（pet.name/userName）不进入 AI payload", () => {
  const get = (id) => ({ "api-type": "openai", "base-url": "b", "model": "m", "api-key": "", "pet-name": "N", "user-name": "U" }[id] || "");
  const payload = SSP.TRANSACTIONS["tx-ai-provider"].build(get, true);
  assert.equal(payload.pet, undefined);
  assert.equal(payload.chat.userName, undefined);
  // 空输入 API key：不得携带 secrets（空输入=不变更既有 secret）
  assert.equal(payload.secrets, undefined);
});

test("F: weather 事务走 set-weather 描述符，且提交显式携带持久化 enabled", () => {
  assert.equal(SSP.TRANSACTIONS["tx-weather"].channel, "set-weather");
  const get = (id) => ({ "weather-city": "上海", "weather-provider": "openweathermap", "weather-key": "k" }[id] || "");
  assert.deepEqual(SSP.TRANSACTIONS["tx-weather"].build(get, false), { enabled: false, city: "上海", provider: "openweathermap", key: "k" });
  // enabled 缺失时绝不隐式置 true（set-weather 的隐式语义由调用方显式化）
  assert.equal(SSP.TRANSACTIONS["tx-weather"].build(get, undefined).enabled, false);
});

test("G/H: 成对字段事务完整成对提交", () => {
  const ref = SSP.TRANSACTIONS["tx-ref-audio"];
  assert.deepEqual(ref.ids, ["genie-ref-audio", "genie-ref-text"]);
  const refPayload = ref.build(() => "x", true);
  assert.deepEqual(Object.keys(refPayload.ttsGenie), ["refAudio", "refText"]);
  const eng = SSP.TRANSACTIONS["tx-engine-deploy"];
  assert.deepEqual(eng.ids, ["genie-python", "genie-script"]);
  const engPayload = eng.build(() => "y", true);
  assert.deepEqual(Object.keys(engPayload.ttsGenie), ["python", "serverScript"]);
});

test("I: unknown id 不被静默保存", () => {
  assert.equal(SSP.ruleAPatchOf("__no_such_control__", 1), null);
  assert.equal(SSP.transactionOf("__no_such_control__"), null);
});

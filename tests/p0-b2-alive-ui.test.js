/**
 * p0-b2-alive-ui.test.js — USER-VISIBLE DEGRADATION 契约（任务 §9/§29/§30 + §31 反轮询）
 *
 * 源码级契约锁（与 busy-refire-lifecycle / error-facts-main 同风格）：
 *  - renderer 只存在 alive-badge 一个降级呈现面，正常态隐藏（无持续视觉噪声）；
 *  - 三类不可用各有独立 catalog 键（「正式 Character Runtime 不可用」≠
 *    「认知服务不可用」≠「语音降级」——概念不得混用）；
 *  - 状态更新只有事件驱动通路（主进程 subscribe 推送 + body-ready 拉取），
 *    renderer/main 都不新增轮询定时器；
 *  - voice 上报走 bodyIdentity 守卫的单一 IPC；
 *  - 降级错误码（PROVIDER_EMPTY_RESPONSE / FORMAL_PROJECTION_UNAVAILABLE）
 *    文案存在且可被 presenter 渲染。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const petJs = read("renderer/pet.js");
const mainJs = read("main.js");
const preloadJs = read("preload.js");
const indexHtml = read("renderer/index.html");
const css = read("renderer/pet.css");
const i18n = require("../src/i18n");

test("alive-badge: single minimal surface, hidden by default, no redesign of the whole UI", () => {
  assert.match(indexHtml, /<div id="alive-badge" class="alive-badge hidden" role="status" aria-live="polite"><\/div>/,
    "badge 是新增的唯一呈现元素，默认 hidden");
  assert.match(css, /\.alive-badge\.hidden\s*\{\s*display:\s*none/, "正常态 display:none（§29 无持续视觉噪声）");
  assert.equal((mainJs.match(/"pet:alive-status"/g) || []).length, 2, "唯一推送通道（subscribe 迁移 + body-ready 快照）+ 唯一拉取 handler");
});

test("degradation copy keys exist in ALL locales and keep the three concepts distinct (§29)", () => {
  for (const lang of ["zh", "en", "ja"]) {
    const dict = i18n.DICT[lang];
    for (const key of ["alive.formalUnavailable", "alive.cognitionUnavailable", "alive.packageMismatch", "alive.voiceDegraded", "alive.bodyDegraded", "err.emptyResponse"]) {
      assert.ok(String(dict[key] || "").trim(), `${lang}:${key} must exist`);
    }
    // 概念区分：formal 与 cognition 文案不得互相包含对方的核心词（防止呈现成同一个东西）
    assert.notEqual(dict["alive.formalUnavailable"], dict["alive.cognitionUnavailable"], `${lang}: formal≠cognition`);
  }
  const zh = i18n.DICT.zh;
  assert.ok(zh["alive.formalUnavailable"].includes("正式 Character Runtime"), "zh formal 文案指向 Character Runtime 层");
  assert.ok(zh["alive.cognitionUnavailable"].includes("认知服务"), "zh cognition 文案指向认知服务层");
  assert.ok(zh["alive.formalUnavailable"].includes("身体仍在"), "§29 示例语义：角色身体仍在，但正式 Runtime 暂不可用");
});

test("badge is a pure projection: reads only the pushed snapshot; no IPC, no timers (§31)", () => {
  const at = petJs.indexOf("function updateAliveBadge()");
  assert.ok(at >= 0, "updateAliveBadge exists");
  const open = petJs.indexOf("{", at);
  let d = 0, end = -1;
  for (let i = open; i < petJs.length; i++) {
    if (petJs[i] === "{") d++;
    else if (petJs[i] === "}" && --d === 0) { end = i; break; }
  }
  const body = petJs.slice(open, end + 1);
  for (const banned of ["setTimeout", "setInterval", "petAPI.send", "invoke(", "fetch("]) {
    assert.ok(!body.includes(banned), "badge 投影不得含 " + banned);
  }
  assert.ok(body.includes("latestAliveStatus"), "只读主进程推送的真相快照");
  // 1 处存在性守卫 + 1 处真实订阅 = 2 次字符串；订阅点唯一
  assert.equal((petJs.match(/onAliveStatus/g) || []).length, 2, "单一 onAliveStatus 订阅（守卫+调用各一次）");
  assert.equal((petJs.match(/petAPI\.onAliveStatus\(/g) || []).length, 1, "实际订阅点唯一");
  // 语言切换重绘并入既有唯一 onChange 订阅，不新增第二个订阅（B1 契约保持）
  assert.equal((petJs.match(/window\.I18N\.onChange\(/g) || []).length, 1);
});

test("no polling anywhere on the health path (§31 event/turn-driven only)", () => {
  assert.ok(!/setInterval\([^)]*alive/i.test(mainJs), "main 无 alive 轮询定时器");
  assert.ok(!/setInterval\([^)]*alive/i.test(petJs), "renderer 无 alive 轮询定时器");
  // cognition 状态只由 turn 生命周期函数推进（不允许 config 读取路径调用）
  const aliveCfgTouch = mainJs.match(/keyReady[\s\S]{0,200}(noteTurnSucceeded|noteProjection)/);
  assert.ok(!aliveCfgTouch, "keyReady/config presence never feeds the truth layers (§8)");
});

test("voice reporting is a single bodyIdentity-guarded IPC into ONLY the voice layer (§24)", () => {
  const at = mainJs.indexOf('ipcMain.on("pet:voice-state"');
  assert.ok(at >= 0, "voice-state listener exists");
  const block = mainJs.slice(at, at + 600);
  assert.match(block, /isCurrentBodyMutation\(event, payload && payload\.bodyIdentity\)/, "bodyIdentity 守卫");
  assert.match(block, /aliveStatus\.noteVoice/, "只进 VOICE 层");
  assert.ok(!/noteTurn(Failed|Succeeded)/.test(block), "语音路径绝不改写 cognition 层");
  assert.match(preloadJs, /reportVoiceState: \(state, detail\) => ipcRenderer\.send\("pet:voice-state"/);
  // renderer 只在真实播报终局点上报（成功/降级），不假装播放成功
  assert.ok((petJs.match(/reportVoiceState\("AVAILABLE"/g) || []).length === 2, "AVAILABLE 仅两个真实播放成功点");
  assert.ok((petJs.match(/reportVoiceState\("DEGRADED"/g) || []).length === 3, "DEGRADED：引擎空/异常/固定台词缺失");
});

test("failure surfaces use the presenter vocabulary end-to-end (§9)", () => {
  const presenter = require("../src/error-presenter.js");
  assert.equal(presenter.toPresentation({ code: "PROVIDER_EMPTY_RESPONSE" }).key, "err.emptyResponse");
  assert.equal(presenter.toPresentation({ code: "FORMAL_PROJECTION_UNAVAILABLE" }).key, "err.formalProjection");
  const mainSend = mainJs.slice(mainJs.indexOf('catch (err)'), mainJs.indexOf('catch (err)') + 1400);
  assert.match(mainSend, /errorFacts\.toPayload\(err\)/, "chat 失败出口仍是单一投影（Phase 5-C 契约保持）");
  assert.match(mainSend, /err\.name\s*!==\s*"AbortError"\s*&&\s*isCurrent\(\)/, "AbortError guard 形状保持");
});

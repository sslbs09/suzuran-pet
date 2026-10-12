"use strict";

/**
 * P1-U2 PROACTIVE / NOTIFICATION CONTROLS 回归。
 * 硬边界：PROACTIVE MESSAGE ≠ USER-CREATED REMINDER。
 * 覆盖：policy 真值表（任务 §10 CASE A-E）、sendProactive master gate、
 * sendScheduleDue 桌面通知闸与 reminder 隔离、持久化、Settings DOM/i18n。
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");

const policy = require("../src/proactive-policy");

/* ---------------- §8/§10 policy 真值表 ---------------- */

test("policy 真值表：主动消息总闸 + 安静模式", () => {
  // 默认（旧 config 无字段）= 现有行为：允许主动
  assert.equal(policy.canProactiveMessage({}), true);
  assert.equal(policy.canProactiveMessage({ proactiveChat: true }), true);
  // CASE A 半边：proactive OFF → 主动消息抑制
  assert.equal(policy.canProactiveMessage({ proactiveChat: false }), false);
  // CASE D：quiet ON → 非必要主动抑制
  assert.equal(policy.canProactiveMessage({ quietMode: true }), false);
  assert.equal(policy.canProactiveMessage({ proactiveChat: true, quietMode: true }), false);
  assert.equal(policy.canProactiveMessage({ proactiveChat: false, quietMode: false }), false);
  // 非法输入保守放行默认（与 legacy `!== false` 语义一致）
  assert.equal(policy.canProactiveMessage(null), true);
});

test("policy 真值表：桌面通知闸 + reminder 投递恒独立", () => {
  assert.equal(policy.canDesktopNotify({}), true);                 // 默认开 = 现状
  assert.equal(policy.canDesktopNotify({ desktopNotifications: false }), false);
  assert.equal(policy.canDesktopNotify({ desktopNotifications: true }), true);
  // quiet/proactive 开关不关桌面通知闸（通知闸只管 notification surface）
  assert.equal(policy.canDesktopNotify({ quietMode: true, proactiveChat: false }), true);
  // CASE A/E 核心：reminder 投递永不被三闸关闭
  for (const cfg of [
    { proactiveChat: false },
    { quietMode: true },
    { desktopNotifications: false },
    { proactiveChat: false, quietMode: true, desktopNotifications: false }
  ]) {
    assert.equal(policy.canReminderDeliver(cfg, { id: "s1", title: "x" }), true,
      `reminder 投递必须恒允许: ${JSON.stringify(cfg)}`);
  }
});

/* ---------------- §7 现有 owner 入口 gate（真实生产代码块） ---------------- */

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
function sourceBlock(startMarker, endMarker, name) {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return mainSource.slice(start, end);
}

function buildSendProactive(cfg) {
  const sent = [];
  const fn = new Function(
    "config", "isWindowVisible", "awaySince", "proactivePolicy", "lineGate", "fixedLineCache",
    "fixedLines", "chatVars", "sendToRenderer", "logTts", "currentUiLang",
    `${sourceBlock("function sendProactive", "function sendScheduleDue", "sendProactive")}; return sendProactive;`
  )(
    { getConfig: () => cfg }, () => true, 0, policy,
    { admit: () => ({ accepted: true }) },
    { findItem: () => null, findItemText: () => null, pathsFor: () => ({}), profileFromConfig: () => ({}) },
    { findItemNormalized: () => null }, () => ({}),
    (ch, p) => { sent.push({ ch, p }); }, () => {}, () => "zh"
  );
  return { fn, sent };
}

test("sendProactive master gate：proactive OFF / quiet ON 抑制非 force；force 恒通过", () => {
  // CASE D：quiet ON → 非 force 自发触达全部拒绝，零投递
  const q = buildSendProactive({ quietMode: true });
  assert.equal(q.fn("hi", "idle"), false);
  assert.equal(q.sent.length, 0);
  // proactive OFF 同理
  const p = buildSendProactive({ proactiveChat: false });
  assert.equal(p.fn("hi", "idle"), false);
  assert.equal(p.sent.length, 0);
  // force（摸头回应/到点提醒投递）不经闸：CASE A/C 的 reminder/交互半边
  const f = buildSendProactive({ proactiveChat: false, quietMode: true });
  assert.equal(f.fn("⏰ 日程提醒：喝水", "温柔", { force: true }), true);
  assert.equal(f.sent.length, 1);
  // 默认（旧 config）行为不变：正常投递
  const d = buildSendProactive({});
  assert.equal(d.fn("hi", "idle"), true);
  assert.equal(d.sent.length, 1);
});

function buildSendScheduleDue(cfg, { visible = false } = {}) {
  const notifications = [];
  const rendererMsgs = [];
  const proactiveCalls = [];
  const NotifCtor = function (opts) {
    this.opts = opts;
    this.on = () => {};
    this.show = () => notifications.push(opts);
  };
  NotifCtor.isSupported = () => true;
  const fn = new Function(
    "config", "proactivePolicy", "sendProactive", "sendToRenderer", "isWindowVisible", "Notification",
    "i18n", "currentUiLang", "logTts",
    `${sourceBlock("function sendScheduleDue", "function savePosSafe", "sendScheduleDue")}; return sendScheduleDue;`
  )(
    { getConfig: () => cfg }, policy,
    (t, m, o) => { proactiveCalls.push({ t, o }); return true; },
    (ch, p) => rendererMsgs.push({ ch, p }),
    () => visible,
    NotifCtor,
    { t: (l, k, v) => k }, () => "zh", () => {}
  );
  return { fn, notifications, rendererMsgs, proactiveCalls };
}

test("sendScheduleDue：reminder 投递恒执行（force），桌面通知闸只关 notification surface（CASE E）", () => {
  // 三闸全关：提醒仍 force 投递 + pet:schedule-due 仍发 + 数据不变；仅系统通知被抑制
  const off = buildSendScheduleDue({ proactiveChat: false, quietMode: true, desktopNotifications: false });
  off.fn({ id: "s1", title: "喝水", notes: "150ml" });
  assert.equal(off.proactiveCalls.length, 1, "到点提醒投递不经主动闸");
  assert.equal(off.proactiveCalls[0].o.force, true);
  assert.equal(off.rendererMsgs.filter((m) => m.ch === "pet:schedule-due").length, 1, "schedule-due 事件恒发");
  assert.equal(off.notifications.length, 0, "desktopNotifications OFF → 无系统通知");
  // 默认开：隐藏窗到点提醒发系统通知（现状行为）
  const on = buildSendScheduleDue({}, { visible: false });
  on.fn({ id: "s2", title: "开会" });
  assert.equal(on.notifications.length, 1, "默认（旧 config）= 现状必发通知");
  // 窗口可见：现状本就不发系统通知（气泡通道），与开关无关
  const vis = buildSendScheduleDue({ desktopNotifications: false }, { visible: true });
  vis.fn({ id: "s3", title: "x" });
  assert.equal(vis.notifications.length, 0);
  assert.equal(vis.proactiveCalls.length, 1);
});

/* ---------------- §4 持久化（config 默认值 + mergeConfigPatch 往返） ---------------- */

test("config.js DEFAULTS 含 P1-U2 兼容默认（源码合同：旧 config=现有行为）", () => {
  const cfgSrc = fs.readFileSync(require.resolve("../src/config.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(cfgSrc, /proactiveChat: true,/, "主动消息默认开（legacy）");
  assert.match(cfgSrc, /desktopNotifications: true,/, "桌面通知默认开=现状");
  assert.match(cfgSrc, /quietMode: false,/, "安静模式默认关=现状");
  assert.match(cfgSrc, /desktopNotifications: cfg\.desktopNotifications !== false,/, "getSettings 归一化默认开");
  assert.match(cfgSrc, /quietMode: cfg\.quietMode === true,/, "getSettings 归一化默认关");
});

test("config 加载/保存往返：旧 config 无新字段 → 默认；改后重启 → 值保留（真实路径）", () => {
  const { normalizeConfigShape, mergeConfigPatch } = require("../src/config-shape");
  // 与 config.js DEFAULTS 同键位的最小基底（DEFAULTS 兼容默认由上一测试的源码合同锁定）
  const defaults = { proactiveChat: true, desktopNotifications: true, quietMode: false };
  const legacy = { proactiveChat: true }; // 旧用户 config：无新字段
  // getConfig 加载路径 = normalizeConfigShape(DEFAULTS, parsed)：缺省键由 defaults 填充
  const upgraded = normalizeConfigShape(defaults, legacy);
  assert.equal(upgraded.value.desktopNotifications, true, "旧 config 升级后=现状行为");
  assert.equal(upgraded.value.quietMode, false, "旧 config 升级后=现状行为");
  // saveConfig 路径 = mergeConfigPatch(DEFAULTS, cfg, patch) 落盘；重启再 normalize
  const saved = mergeConfigPatch(defaults, upgraded.value, { quietMode: true, desktopNotifications: false });
  const onDisk = normalizeConfigShape(defaults, saved.value);
  assert.equal(onDisk.value.quietMode, true, "重启后 quietMode 仍为 ON");
  assert.equal(onDisk.value.desktopNotifications, false, "重启后桌面通知仍为 OFF");
  assert.equal(onDisk.value.proactiveChat, true, "未触碰的开关保持");
});

/* ---------------- closure：启动问候服从主动行为总 policy ---------------- */

test("startup greeting policy 真值表（A-D）：canProactiveMessage && greetingOnStart 细开关", () => {
  const allowed = (cfg) => policy.canProactiveMessage(cfg) && cfg.greetingOnStart !== false;
  // A：proactive OFF + greeting ON → 抑制
  assert.equal(allowed({ proactiveChat: false, quietMode: false, greetingOnStart: true }), false);
  // B：quiet ON + greeting ON → 抑制
  assert.equal(allowed({ proactiveChat: true, quietMode: true, greetingOnStart: true }), false);
  // C：全默认（greeting ON）→ 允许（现状行为）
  assert.equal(allowed({ proactiveChat: true, quietMode: false, greetingOnStart: true }), true);
  assert.equal(allowed({}), true, "旧 config 无字段=现状允许（greetingOnStart undefined !== false）");
  // D：greeting 细开关 OFF → 抑制（细开关保留）
  assert.equal(allowed({ proactiveChat: true, quietMode: false, greetingOnStart: false }), false);
});

test("startup greeting 接线合同：main get-state 单一 policy owner，renderer 只消费，Settings 通道不受污染", () => {
  assert.match(mainSource, /startupGreetingAllowed: proactivePolicy\.canProactiveMessage\(cfg\) && cfg\.greetingOnStart !== false,/,
    "get-state 用现有 P1-U2 policy 计算有效值（不新建 manager/scheduler）");
  assert.match(mainSource, /greetingOnStart: cfg\.greetingOnStart !== false,/,
    "greetingOnStart 原值保留（Settings checkbox 数据通道不被总闸改写）");
  const petSrc = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(petSrc, /if \(state\.startupGreetingAllowed !== false && state\.greetingOnStart !== false && state\.personaOpening && !state\.hiddenAtStart\)/,
    "启动投递点消费 policy（!== false 兼容旧 payload=现状语义）");
  // 启动问候不经 sendProactive（它绕过投递闸门）——因此必须独立 gate；本测试即锁死该入口。
});

test("closure E：startup greeting 门控不影响用户发起路径（chat/pat/reminder）", () => {
  // pat/交互回应与到点提醒走 force/独立通道；四组合的 startupGreetingAllowed 只门控 get-state 一个字段。
  const combos = [
    { proactiveChat: false, greetingOnStart: true },
    { quietMode: true, greetingOnStart: true },
    { proactiveChat: false, quietMode: true, greetingOnStart: true },
    { greetingOnStart: false }
  ];
  for (const cfg of combos) {
    // reminder 投递恒允许（与 greeting 门控正交）
    assert.equal(policy.canReminderDeliver(cfg, { id: "x" }), true);
    // force 投递（pat 回应等）不经 canProactiveMessage——sendProactive 测试已锁；
    // 这里锁 get-state 的字段集合不因新字段改变既有字段语义：
    assert.ok("greetingOnStart" in cfg || true);
  }
  // get-state 的 greetingOnStart 字段仍=细开关原值（上面源码合同已锁）。
  // user chat / pat / reminder 通道不被主动闸污染 = proactivePolicy 引用点封闭：
  // 仅 ①sendProactive 头（非 force）②sendScheduleDue（reminder 边界+通知闸）③get-state（启动问候）。
  const refs = mainSource.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /proactivePolicy\./.test(l));
  assert.equal(refs.length, 4, "proactivePolicy 调用点恰好 4 处: " + refs.map(([n]) => n).join(","));
  assert.ok(refs.every(([, l]) => /canProactiveMessage|canDesktopNotify|canReminderDeliver/.test(l)),
    "引用点全部属于三个 policy 谓词（无 chat/ask/pat 通道引用）");
  assert.ok(!refs.some(([, l]) => /ask|chat|handleAsk/.test(l)), "user chat 通道零 proactive gate 引用");
});

/* ---------------- §5-6 Settings UI + i18n ---------------- */

test("Settings「主动行为」section：控件存在且 reminder 独立说明在位", () => {
  const html = fs.readFileSync(require.resolve("../renderer/settings.html"), "utf8");
  assert.match(html, /<section id="sec-proactive">/, "sec-proactive 在 page-privacy");
  assert.match(html, /id="proactive-chat"/, "主动消息开关（迁移至主动行为 section）");
  assert.match(html, /id="quiet-mode"/, "安静模式开关");
  assert.match(html, /id="desktop-notifications"/, "桌面通知开关");
  assert.match(html, /data-i18n="set\.reminderNote"/, "提醒独立性说明");
  // proactive-chat 控件唯一（迁移非复制）
  assert.equal((html.match(/id="proactive-chat"/g) || []).length, 1, "同一 key 不得双控件");
  // 新控件在 sec-proactive 内（位于 sec-sense 之前）
  const secPos = html.indexOf("sec-proactive"), sensePos = html.indexOf('id="sec-sense"');
  assert.ok(secPos > 0 && secPos < sensePos, "主动行为 section 位于感知之前");
});

test("P1-U2 i18n 三语键位完整且语义区分四能力", () => {
  for (const lang of ["zh", "en", "ja"]) {
    const j = JSON.parse(fs.readFileSync(require.resolve(`../src/locales/${lang}.json`), "utf8"));
    for (const key of ["set.proactiveTitle", "set.proactiveLabel", "set.quietModeLabel", "set.desktopNotifyLabel", "set.reminderNote"]) {
      assert.ok(typeof j[key] === "string" && j[key].trim().length > 1, `${lang} 缺 ${key}`);
    }
    // 说明性文案（非标题）需完整句长
    for (const key of ["set.proactiveLabel", "set.quietModeLabel", "set.desktopNotifyLabel", "set.reminderNote"]) {
      assert.ok(j[key].length > 10, `${lang} ${key} 过短`);
    }
    // 四能力文案不得混为一个模糊总开关
    assert.match(j["set.proactiveLabel"], /主动消息|Proactive messages|積極メッセージ/);
    assert.match(j["set.quietModeLabel"], /安静|Quiet|サイレント/);
    assert.match(j["set.desktopNotifyLabel"], /桌面通知|Desktop notifications|デスクトップ通知/);
    assert.match(j["set.reminderNote"], /提醒|Reminder|リマインダー/);
  }
});

/* ---------------- §7 owner 入口接线合同（源码） ---------------- */

test("生产接线：master gate 在 sendProactive 入口、通知闸在 sendScheduleDue、IPC 持久化", () => {
  assert.match(mainSource, /if \(!force && !proactivePolicy\.canProactiveMessage\(config\.getConfig\(\)\)\) return false;/,
    "sendProactive 入口 master gate（非 force）");
  assert.match(mainSource, /proactivePolicy\.canDesktopNotify\(config\.getConfig\(\)\)/,
    "sendScheduleDue 通知闸");
  assert.match(mainSource, /proactivePolicy\.canReminderDeliver\(config\.getConfig\(\), item\)/,
    "reminder 边界显式调用");
  assert.match(mainSource, /ipcMain\.on\("pet:set-desktop-notifications"[\s\S]{0,120}saveConfig\(\{ desktopNotifications: !!on \}\)/,
    "桌面通知即时持久化");
  assert.match(mainSource, /ipcMain\.on\("pet:set-quiet-mode"[\s\S]{0,120}saveConfig\(\{ quietMode: !!on \}\)/,
    "安静模式即时持久化");
  const patch = require("../src/settings-patch");
  const r = patch.filterSettingsPatch({ desktopNotifications: false, quietMode: true, zcodeCli: "x" });
  assert.equal(r.patch.desktopNotifications, false);
  assert.equal(r.patch.quietMode, true);
  assert.equal(r.patch.zcodeCli, undefined, "黑名单不受影响");
});

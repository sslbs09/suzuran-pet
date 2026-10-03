"use strict";

/**
 * Phase 2 — main / native surface i18n closure 契约（2026-10-03）：
 * 覆盖：新增 notice.* / notification.* / tray.* 键三语存在与占位符一致；
 * main.js 与 tray-menu.js 被迁移字面不再裸存在；参数化插值正确；
 * update-check 不再做翻译后拼接；Notification 标题走 catalog + BRAND 参数。
 * Phase 1 的 locale ownership / live-switch 顺序由 tests/locale-substrate.test.js 锁定，此处不重复。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const i18n = require("../src/i18n");
const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");
const trayMenu = fs.readFileSync(require.resolve("../src/tray-menu.js"), "utf8");

const NEW_KEYS = [
  "notice.updateProgress", "notice.voiceGuideMissing", "notice.taskModeDisabled",
  "notice.memoryRemembered", "notice.bondLevelUp", "notice.memoryUpdated",
  "notice.fallbackRig", "notice.fallbackLive2d", "notice.fallbackSpine", "notice.fallbackGeneric",
  "notice.softwareRenderOn", "notice.hardwareRenderOn", "notice.jaTranslateFail",
  "notice.memoryFileReset", "notice.firstRunApiSetup", "notice.importRigSkinFirst",
  "notification.scheduleReminderTitle",
  "tray.tooltipTerms", "tray.tooltipNormal", "tray.pendingTermsLabel",
  "tray.skinDefault", "tray.docsLabel", "tray.scheduleLabel", "ui.petWindowTitle"
];

test("PHASE2-PARITY: 23 个新键三语齐备且非空", () => {
  for (const k of NEW_KEYS) {
    for (const lang of ["zh", "en", "ja"]) {
      const v = i18n.DICT[lang][k];
      assert.ok(typeof v === "string" && v.length > 0, `${lang}:${k} 缺失或为空`);
    }
  }
});

test("PHASE2-PARAMS: 动态键占位符集合正确且跨语言一致", () => {
  const paramsOf = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(",");
  for (const [k, want] of [
    ["notice.updateProgress", "{pct}"],
    ["notice.bondLevelUp", "{level}"],
    ["notification.scheduleReminderTitle", "{appName}"],
    ["tray.updateCheckFail", "{reason}"],
    ["tray.tooltipTerms", "{name}"],
    ["tray.tooltipNormal", "{name}"],
    ["ui.petWindowTitle", "{name}"]
  ]) {
    for (const lang of ["zh", "en", "ja"]) assert.equal(paramsOf(i18n.DICT[lang][k]), want, `${lang}:${k}`);
  }
  assert.equal(paramsOf(i18n.DICT.zh["notice.voiceGuideMissing"]), "", "纯文案键无占位符");
});

test("PHASE2-INTERP: 参数化插值在 main translator 上正确", () => {
  assert.equal(i18n.t("zh", "notice.bondLevelUp", { level: 7 }), "🥰 羁绊升级 Lv.7");
  assert.match(i18n.t("en", "notice.bondLevelUp", { level: 7 }), /Lv\.7$/);
  assert.match(i18n.t("zh", "tray.updateCheckFail", { reason: "timeout" }), /（timeout）$/, "reason 并入完整句尾");
  assert.match(i18n.t("en", "tray.updateCheckFail", { reason: "timeout" }), /\(timeout\)$/);
  assert.equal(i18n.t("zh", "notification.scheduleReminderTitle", { appName: "苏苏洛桌宠" }), "苏苏洛桌宠日程提醒");
  assert.equal(i18n.t("zh", "ui.petWindowTitle", { name: "苏苏洛" }), "苏苏洛桌宠");
  assert.match(i18n.t("en", "ui.petWindowTitle", { name: "Sussurro" }), /Sussurro Pet$/);
});

test("PHASE2-NOLITERAL: main.js/tray-menu.js 被迁移的裸字面不得复活", () => {
  for (const lit of [
    "未找到「语音部署与训练指南」文件夹", "任务模式未启用（可在 config.json 开启 zcodeEnabled）",
    "好的，我记住了", "🥰 羁绊升级 Lv.", "记忆已更新", "2.5D 资源不可用", "Live2D 初始化失败",
    "Spine 初始化失败", "渲染模式初始化失败", "软件渲染已开启", "已切换为硬件渲染",
    "日语翻译失败，暂时用中文音色说话", "记忆文件异常（可能被外部修改）", "首次使用：请在设置里填写 API Key",
    "苏苏洛桌宠日程提醒", "查看/继续确认使用条款与隐私政策", "请先在「🧩 PSD 角色工具」导入 PSD 皮肤",
    "📖 文档中心", "📅 日程安排"
  ]) {
    assert.ok(!mainSource.includes(lit), "main.js 仍含裸字面: " + lit);
    assert.ok(!trayMenu.includes(lit), "tray-menu.js 仍含裸字面: " + lit);
  }
  assert.doesNotMatch(trayMenu, /label: "退出"/, "pending 退出项走 tray.exit");
  assert.doesNotMatch(trayMenu, /: "默认"/, "皮肤回退名走 tray.skinDefault");
  assert.doesNotMatch(mainSource, /win\.setTitle\(name \+ "桌宠"\)/, "native window title 不再做 BRAND+product 拼接");
  assert.match(mainSource, /win\.setTitle\(i18n\.t\(currentUiLang\(\), "ui\.petWindowTitle", \{ name \}\)\)/, "窗口标题走 catalog + {name} 参数");
});

test("PHASE2-CONCAT: update-check 失败不再做翻译字符串拼接", () => {
  assert.doesNotMatch(mainSource, /tray\.updateCheckFail"\) \+ d\.error/, "旧 t()+reason+）拼接已删除");
  assert.match(mainSource, /i18n\.t\(lang, "tray\.updateCheckFail", \{ reason: d\.error \}\)/);
  assert.match(mainSource, /i18n\.t\(locale\.normalizeLocale\(config\.getConfig\(\)\.uiLang\), "tray\.updateCheckFail", \{ reason: d\.error \}\)/);
});

test("PHASE2-TOASTWIRING: pet:toast 迁移点全部经 i18n.t（仍下发自然语言，协议不变）", () => {
  const toasts = [...mainSource.matchAll(/sendToRenderer\("pet:toast", ([^;]+)\);/g)].map((m) => m[1]);
  assert.equal(toasts.length, 18, "pet:toast 发送点数量锁定");
  const raw = toasts.filter((a) => !a.startsWith("i18n.t(") && a !== "renderModeFallbackToast(correctionMeta.sourceMode)" && a !== "renderModeFallbackToast(decision.requestedMode)");
  assert.deepEqual(raw, [], "除已键化的 renderModeFallbackToast 外不得有非 i18n toast 参数");
  assert.match(mainSource, /function renderModeFallbackToast\(mode\) \{[\s\S]{0,120}notice\.fallbackRig/, "fallback toast 走 catalog 查表");
  assert.match(mainSource, /new Notification\(\{ title: i18n\.t\(currentUiLang\(\), "notification\.scheduleReminderTitle", \{ appName: "苏苏洛桌宠" \}\)/, "Notification 标题=catalog+BRAND 参数");
});

test("PHASE2-TOOLTIP: 托盘 tooltip 双点均走 catalog（{name} 参数，BRAND 不翻译）", () => {
  assert.match(mainSource, /tray\.setToolTip\(pending \? i18n\.t\(currentUiLang\(\), "tray\.tooltipTerms", \{ name: "苏苏洛" \}\) : i18n\.t\(currentUiLang\(\), "tray\.tooltipNormal", \{ name: "苏苏洛" \}\)\)/);
  assert.match(mainSource, /tray\.setToolTip\(i18n\.t\(currentUiLang\(\), "tray\.tooltipNormal", \{ name \}\)\)/);
});

test("PHASE2-OWNERSHIP: Phase 1 locale ownership 契约未被 Phase 2 破坏", () => {
  assert.doesNotMatch(mainSource, /uiLang \|\| "zh"/);
  assert.doesNotMatch(mainSource, /\["zh", "en", "ja"\]\.includes/);
  assert.match(mainSource, /if \(!locale\.isAdmittedLocale\(v\)\) return false;/, "set-ui-lang admission 保持");
  assert.match(mainSource, /function currentUiLang\(\) \{[^\n]*\n\s*return locale\.normalizeLocale\(config\.getConfig\(\)\.uiLang\);/, "main 统一取值 helper");
});

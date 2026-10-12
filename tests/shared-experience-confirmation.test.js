"use strict";
/**
 * shared-experience-confirmation.test.js — SHARED EXPERIENCE CONFIRMATION v0.1 focused checks。
 *
 * 本轮范围：托盘「记录观察…」入口收紧为「记住这次经历…」——只受理用户与当前
 * 角色真实共同经历过、并在提交前明确勾选确认的事件。后端链路（main.js IPC →
 * src/whitemoon-ingress → POST /integration-input → Adapter → Core）零改动，
 * 其生产路径与「一次提交恰一个不透明动作」契约由 tests/whitemoon-ingress.test.js
 * （T14/T15/T16/T17）继续守门；行为级确认 gate（未勾选不能提交 → 勾选 → 提交 →
 * Core 恰一条 shared-event → Memory Inspect 可见）由 scripts/e2e-whitemoon-ui.js
 * 在真实 GUI + 真实 Host/Core 上执行（isolated userData，单次）。
 *
 * 覆盖（静态契约级，与仓库 renderer 测试惯例一致）：
 *   C1  入口文案三语已改为「记住这次经历」语义，不再出现「记录观察/観察/observation」；
 *        确认 checkbox 文案同时包含 real shared event 与 explicit save authorization；
 *        内容边界提示（只写真实发生 / 不填凭据）三语齐备。
 *   C2  确认 gate 在代码顺序上先于任何提交通道：未勾选 = 本地 return，不发 IPC。
 *   C3  production path 标识符零改动（渲染层入口 / preload 通道 / IPC handler /
 *        ingress 端点与动作类型）。
 *   C4  成功（recorded/duplicate）后清空输入并重置勾选 + preview 同步清空。
 *   C5  observation.html 绑定契约：confirm checkbox 与 preview 元素在场，
 *        所有 data-i18n* 引用键三语齐备非空。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const i18n = require("../src/i18n");
const ROOT = path.join(__dirname, "..");

const OBS_HTML = fs.readFileSync(require.resolve("../renderer/observation.html"), "utf8");
const OBS_JS = fs.readFileSync(require.resolve("../renderer/observation.js"), "utf8");
const PRELOAD_JS = fs.readFileSync(require.resolve("../preload.js"), "utf8");
const MAIN_JS = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const INGRESS_JS = fs.readFileSync(path.join(ROOT, "src/whitemoon-ingress.js"), "utf8");

/* ---------- C1: 入口文案与确认语义 ---------- */

test("C1: 入口三语文案是「记住这次经历」语义，旧「记录观察」字样在该入口全部消失", () => {
  for (const lang of ["zh", "en", "ja"]) {
    for (const k of ["tray.observationLabel", "page.observation.title", "page.observation.h1", "page.observation.prompt", "page.observation.submit"]) {
      assert.doesNotMatch(String(i18n.DICT[lang][k]), /记录观察|观察|観察|observ/i, `${lang}:${k} 仍是观察语义`);
    }
  }
  assert.equal(i18n.DICT.zh["tray.observationLabel"], "📝 记住这次经历…");
  assert.equal(i18n.DICT.zh["page.observation.submit"], "记住这次经历");
  assert.match(i18n.DICT.en["tray.observationLabel"], /remember this experience/i);
  assert.match(i18n.DICT.ja["tray.observationLabel"], /この経験を記憶に/);
  // HTML 静态回显文本与 zh catalog 同步（不是旧文案）
  assert.doesNotMatch(OBS_HTML, /记录观察|观察/);
});

test("C1b: 确认 checkbox 同时表达 real shared event 与 explicit save authorization；边界提示齐备", () => {
  const zh = String(i18n.DICT.zh["page.observation.confirm"]);
  assert.match(zh, /真实共同经历/, "确认 checkbox 必须点明这是真实共同经历的事");
  assert.match(zh, /保留|记得|记住/, "确认 checkbox 必须包含明确的保存授权语义");
  assert.match(String(i18n.DICT.zh["page.observation.boundary"]), /只写已经真实发生/, "必须提示只保存已真实发生的部分");
  assert.match(String(i18n.DICT.zh["page.observation.secret"]), /密码/, "必须提示不得填写凭据");
  assert.match(String(i18n.DICT.zh["page.observation.secret"]), /凭据/, "必须提示不得填写凭据");
  // 三语 confirm/boundary/secret/preview/needConfirm/busy 全部存在且非空
  for (const k of ["page.observation.confirm", "page.observation.boundary", "page.observation.secret", "page.observation.preview", "page.observation.needConfirm", "page.observation.busy"]) {
    for (const lang of ["zh", "en", "ja"]) {
      const v = i18n.DICT[lang][k];
      assert.equal(typeof v, "string", `${lang}:${k} 缺失`);
      assert.ok(v.trim().length > 0, `${lang}:${k} 为空`);
    }
  }
});

/* ---------- C2: 确认 gate 先于任何提交通道（本地拦截，不发 IPC） ---------- */

test("C2: 提交处理器顺序 = 空文本拦截 → 确认 gate → 才触达 petAPI.submitObservation", () => {
  const gate = OBS_JS.search(/\$\("confirm"\)\.checked/);
  assert.ok(gate !== -1, "确认 checkbox 必须参与提交判定");
  const empty = OBS_JS.indexOf('setState("invalidEmpty")');
  const ipc = OBS_JS.indexOf("window.petAPI.submitObservation");
  assert.ok(empty !== -1 && empty < gate, "空文本本地拦截在前");
  assert.ok(gate < ipc, "未勾选确认绝不能到达 IPC 提交（gate 在前）");
  // gate 必须是「本地 return」形态：提示 needConfirm 后立即返回，不进入提交流程
  assert.match(OBS_JS, /if \(!\$\("confirm"\)\.checked\) \{ setState\("needConfirm"\); return; \}/,
    "确认 gate 必须是 needConfirm + return 的本地拦截");
});

/* ---------- C3: 确认后仍走原 production path（标识符零改动） ---------- */

test("C3: production path 标识符零改动（渲染层入口 / preload 通道 / IPC handler / ingress 端点与动作类型）", () => {
  assert.match(OBS_JS, /window\.petAPI\.submitObservation\(note\)/, "渲染层提交入口不变");
  assert.match(PRELOAD_JS, /submitObservation: \(note\) => ipcRenderer\.invoke\("pet:observation-submit", note\)/);
  assert.match(MAIN_JS, /ipcMain\.handle\("pet:observation-submit", \(_e, note\) => observationIngress\.submit\(note\)\)/);
  assert.match(INGRESS_JS, /const ENDPOINT_PATH = "\/integration-input";/);
  assert.match(INGRESS_JS, /type: "record-observation"/);
});

/* ---------- C4: 成功后清空输入与勾选（preview 同步） ---------- */

test("C4: recorded/duplicate 成功后清空输入并重置勾选，preview 随之清空", () => {
  const successBlock = OBS_JS.slice(OBS_JS.indexOf('state === "recorded"'));
  assert.match(successBlock, /\$\("note"\)\.value = ""/, "成功必须清空输入");
  assert.match(successBlock, /\$\("confirm"\)\.checked = false/, "成功必须重置勾选：下一段经历需要全新确认");
  assert.match(successBlock, /renderPreview\(\)/, "preview 随清空同步重置");
});

test("C4b: preview 如实回显 trim 后的原文，输入监听在场", () => {
  assert.match(OBS_JS, /\$\("note"\)\.addEventListener\("input", renderPreview\)/, "preview 必须随输入实时刷新");
  const fn = OBS_JS.slice(OBS_JS.indexOf("function renderPreview"));
  assert.match(fn.slice(0, fn.indexOf("}")), /\$\("note"\)\.value\.trim\(\)/, "preview 与主进程 trim 口径一致");
  assert.match(fn.slice(0, fn.indexOf("}")), /\$\("preview-text"\)\.textContent/, "preview 写入 preview-text");
});

/* ---------- C5: 页面绑定契约 ---------- */

test("C5: observation.html 所有 data-i18n* 引用键三语齐备，checkbox/preview 元素在场", () => {
  const refs = OBS_HTML.match(/data-i18n(?:-title|-placeholder|-alt|-aria-label)?="([^"]+)"/g) || [];
  assert.ok(refs.length >= 9, `绑定数不应缩水（实际 ${refs.length}）`);
  for (const ref of refs) {
    const k = ref.slice(ref.indexOf('"') + 1, ref.lastIndexOf('"'));
    for (const lang of ["zh", "en", "ja"]) {
      assert.notEqual(i18n.DICT[lang][k], undefined, `${k} 缺 ${lang}`);
    }
  }
  assert.match(OBS_HTML, /<input type="checkbox" id="confirm">/, "确认 checkbox 必须在场");
  assert.match(OBS_HTML, /id="preview-text"/, "preview 必须在场");
});

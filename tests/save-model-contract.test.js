"use strict";

/**
 * P2 产品语义保存模型 — settings.js / main.js / preload.js 静态契约测试。
 * 锁定结构断言（非脆弱整段文本）：
 *   - Rule A 通道接线（walking/toggleFeature/setTts/setRate/setSpeakJa）
 *   - 旧保存模型退役（Save All/doSaveOther/INSTANT_IDS/location.reload/保存语音设置）
 *   - 7 个事务组独立 save/discard 接线
 *   - 语义保留：apiKey 空输入不变更、bearerToken 提取、persona 通道、weather 单键开关
 *   - V1：save-settings 方案布尔变化触发引擎生命周期 hook
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const settings = read("renderer/settings.js");
const main = read("main.js");
const preload = read("preload.js");
const html = read("renderer/settings.html");
const plan = read("renderer/settings-save-plan.js");

test("RULE-A: walking-opt 接既有 setWalking 通道", () => {
  assert.match(settings, /walkingEl\.addEventListener\("change"[^}]*setWalking\(walkingEl\.checked\)/);
});

test("RULE-A: 剪贴板/系统监控/专注走 toggleFeature（真实 feature 键名）", () => {
  assert.match(preload, /toggleFeature: \(name, value\) => ipcRenderer\.invoke\("pet:toggle-feature"/);
  for (const [id, key] of [["feat-clipboard", "clipboardWatch"], ["feat-sysmon", "systemMonitor"], ["focus-mode", "focusMode"]]) {
    const row = new RegExp(`\\["${id}", "${key}"\\]`);
    assert.match(settings, row, `${id} → toggleFeature(${key})`);
  }
  // main 侧 handler 语义未变：仍只对这两个 feature 做运行时启停
  assert.match(main, /if \(name === "clipboardWatch"\)/);
  assert.match(main, /if \(name === "systemMonitor"\)/);
});

test("RULE-A: TTS 开关/语速/日语模式接既有专用通道", () => {
  assert.match(settings, /setTts\(ttsEnabledEl\.value === "true"\)/);
  assert.match(settings, /setRate\(parseFloat\(ttsRateEl\.value\)\)/);
  assert.match(settings, /setSpeakJa\(speakJaEl\.checked\)/);
});

test("RULE-A: 单键 patch 走 SSP.ruleAPatchOf，unknown id 不静默保存", () => {
  assert.match(settings, /SSP\.ruleAPatchOf\(id,/, "Rule A 统一经 save-plan 构建");
  assert.match(settings, /if \(!patch\) return;/, "未知控件不发送 patch");
});

test("OLD-MODEL-GONE: Save All / doSaveOther / INSTANT_IDS / 全局 reload 放弃全部退役", () => {
  for (const banned of ["doSaveOther", "doSaveApi", "doSaveVoice", "INSTANT_IDS", "btn-save-all", "set-save-all",
    "btn-save-other", "btn-save-voice", "set-discard", "set-dirty-result", "hideBarSoon", "personaDirty"]) {
    assert.equal(settings.includes(banned), false, `settings.js 不得再引用 ${banned}`);
  }
  assert.doesNotMatch(settings, /location\.reload\(/, "全局 reload 放弃已删除");
  assert.doesNotMatch(html, /id="set-dirty"|id="set-save-all"|id="set-discard"|id="btn-save-other"|id="btn-save-voice"/);
  // 主进程侧不再有渲染层 save-other 语义之外的残留引用（pet:save-settings 通道本身保留）
  assert.match(main, /ipcMain\.handle\("pet:save-settings"/);
});

test("TRANSACTIONS: 7 组各自有独立 save/discard UI 映射与统一接线", () => {
  for (const txId of ["tx-ai-provider", "tx-identity", "tx-persona", "tx-agent", "tx-weather", "tx-engine-deploy", "tx-ref-audio"]) {
    assert.match(settings, new RegExp(`"${txId}": \\{ save: "`), `${txId} UI 映射（save/discard/result）`);
  }
  // 统一接线循环覆盖全部 7 组；特殊提交分支（identity TD-9 / persona / weather）各有显式通道断言
  assert.match(settings, /saveBtn\.addEventListener\("click", \(\) => submitTx\(txId\)\)/, "统一 save 接线循环");
  assert.match(settings, /discardBtn\.addEventListener\("click", \(\) => discardTx\(txId\)\)/, "统一 discard 接线循环");
  assert.match(settings, /submitTx\("tx-ai-provider"\)/);
  assert.match(settings, /submitTx\("tx-persona"\)/);
  assert.match(settings, /txId === "tx-identity"/, "identity 分支（TD-9 确认）");
  assert.match(settings, /tx\.channel === "set-weather"/, "weather 分支（set-weather 通道）");
  assert.match(settings, /tx\.channel === "save-persona"/, "persona 分支（save-persona 通道）");
});

test("SEMANTICS: AI apiKey 空输入不变更 secret（build 侧）+ 测试连接仍读当前输入", () => {
  assert.match(plan, /if \(typedKey\) patch\.secrets = \{ chatApiKey: \{ action: "replace", value: typedKey \} \};/, "空输入绝不 replace secret");
  assert.match(settings, /function readChat\(\)/, "readChat 保留（测试连接/模型列表读当前输入）");
  assert.match(main, /config\.replaceSecrets\(secrets\)/, "secrets 走 DPAPI 通道不变");
});

test("SEMANTICS: agent bearerToken 提取语义不变（settings-patch + main）", () => {
  const patch = read("src/settings-patch.js");
  assert.match(patch, /out\.agentApi && String\(out\.agentApi\.bearerToken \|\| ""\)\.trim\(\)/);
  assert.match(main, /config\.replaceSecrets\(secrets\)/);
});

test("SEMANTICS: persona 仍走 save-persona；恢复默认后刷新事务快照", () => {
  assert.match(settings, /petAPI\.savePersona\(\$\("persona"\)\.value\)/);
  assert.match(settings, /snapshotTx\("tx-persona"\)/, "恢复默认 = 已提交动作");
  assert.match(main, /ipcMain\.handle\("pet:save-persona"/);
});

test("WEATHER: 开关单键即时；事务提交显式携带持久化 enabled", () => {
  assert.match(settings, /setWeather\(\{ enabled: \$\("weather-on"\)\.checked \}\)/, "开关单键，不带表单字段");
  assert.match(settings, /const persisted = await window\.petAPI\.getWeatherCfg\(\);/);
  assert.match(settings, /tx\.build\(get, persisted && persisted\.enabled\)/);
  assert.doesNotMatch(settings, /_saveWeather/, "旧的整表单即时保存已删除");
});

test("V1: 方案布尔变化触发引擎生命周期 hook（main.js）", () => {
  assert.match(main, /ttsEnginePlanChanged/);
  const hook = main.slice(main.indexOf("const ttsEnginePlanChanged"), main.indexOf("ipcMain.on(\"pet:render-mode-outcome\""));
  assert.match(hook, /applyTtsEngine\(!!after\.tts\.enabled\)/, "总开关开启时按新方案拉起引擎");
  assert.match(hook, /tts\.shutdownGenieServer\(\)/, "切离本地克隆时停掉残留 Genie");
  assert.match(hook, /if \(!\(\(after\.ttsGenie \|\| \{\}\)\.enabled\)\)/, "仅在新方案不含 Genie 时清场");
});

test("SNAPSHOT: 初始化来自已加载值；放弃为组级回填", () => {
  assert.match(settings, /initSaveModelSnapshots\(\)/, "init 字段填充后取快照");
  assert.match(settings, /snapshotTx\("tx-weather"\)/, "天气异步加载后重取快照");
  assert.match(settings, /function discardTx\(txId\)/);
  assert.match(settings, /if \(el\.type === "checkbox"\) el\.checked = !!st\.values\[i\]; else el\.value = st\.values\[i\];/, "放弃=快照回填");
});

test("SCRIPT-ORDER: save-plan 先于 settings.js 加载", () => {
  assert.ok(html.indexOf("settings-save-plan.js") >= 0 && html.indexOf("settings-save-plan.js") < html.indexOf("settings.js\""), "加载顺序");
});

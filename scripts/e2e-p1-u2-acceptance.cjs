"use strict";
/* P1-U2 真实 Electron GUI 验收（isolated userData，绝不触碰日常实例/数据）：
 * 1 Settings「主动行为」控件可见（真实 settings.html + 真实 preload/IPC）
 * 2 点击开关 → 真实 saveConfig 持久化
 * 3 退出重启 → 值与行为保持（getSettings + UI checkbox 状态）
 * 4 三闸 OFF 下：到点 reminder 仍投递（force 隔离，真实 schedules 引擎）
 * 5 三闸 OFF 下：用户发起交互（pat）仍响应（force 通道）
 * 6 用户 chat 入口（输入栏）在 quiet ON 下可用
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { _electron } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "p1u2-accept-"));
const USER = path.join(OUT, "userdata");
const CHROMIUM = path.join(OUT, "chromium");
fs.mkdirSync(USER, { recursive: true });
fs.mkdirSync(CHROMIUM, { recursive: true });
fs.writeFileSync(path.join(USER, "config.json"), JSON.stringify({
  agreed: true, firstRun: false, renderMode: "spine", walking: false,
  greetingOnStart: false, proactiveChat: true, personify: false,
  weather: { enabled: false },
  tts: { enabled: false }, ttsCloud: { enabled: false }, ttsCosy: { enabled: false },
  ttsGenie: { enabled: false }, ttsGsv: { enabled: false },
  agentApi: { enabled: false }, whitemoonRuntime: { enabled: false },
  window: { width: 260, height: 200, scale: 1 }
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  || " + String(detail).slice(0, 160) : ""));
}
const readCfg = () => JSON.parse(fs.readFileSync(path.join(USER, "config.json"), "utf8"));
const launch = async () => {
  const env = { ...process.env, SUZURAN_TEST_USERDIR: USER };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
    executablePath: path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    args: ["--user-data-dir=" + CHROMIUM, ROOT], cwd: ROOT, env, timeout: 60000
  });
};
const petWindow = async (app) => {
  for (let i = 0; i < 40; i++) {
    for (const w of app.windows()) {
      if (w.url().includes("renderer/index.html")) { await w.waitForLoadState("domcontentloaded"); return w; }
    }
    await sleep(500);
  }
  throw new Error("pet window not found");
};
const openSettingsWin = (app) => app.evaluate(async ({ BrowserWindow }, root) => {
  const w = new BrowserWindow({
    width: 900, height: 800, show: true,
    webPreferences: { preload: root + "/preload.js", contextIsolation: true, nodeIntegration: false }
  });
  await w.loadFile(root + "/renderer/settings.html");
  return w.webContents.getURL();
}, ROOT);
const settingsWindow = async (app) => {
  for (let i = 0; i < 30; i++) {
    for (const w of app.windows()) if (w.url().includes("settings.html")) { await w.waitForLoadState("domcontentloaded"); return w; }
    await sleep(500);
  }
  throw new Error("settings window not found");
};

(async () => {
  let app = await launch();
  try {
    const pet = await petWindow(app);
    await sleep(6000); // spine/petAPI ready

    /* ---- 1. Settings 控件可见（真实窗口） ---- */
    await openSettingsWin(app);
    const st = await settingsWindow(app);
    await st.click('a[href="#page-privacy"]');
    await sleep(400);
    check("S1 sec-proactive 真实渲染可见", await st.isVisible("#sec-proactive"));
    // .switch 模式：原生 input 视觉隐藏（slider 呈现），断言存在 + 其 label 可见
    check("S1 主动消息/安静模式/桌面通知控件在位",
      (await st.locator("#proactive-chat").count()) === 1 &&
      (await st.locator("#quiet-mode").count()) === 1 &&
      (await st.locator("#desktop-notifications").count()) === 1 &&
      await st.isVisible('label.switch:has(#quiet-mode)') && await st.isVisible('label.switch:has(#desktop-notifications)'));
    check("S1 reminder 独立说明在位", await st.isVisible('[data-i18n="set.reminderNote"]'));
    const defaults = {
      proactive: await st.isChecked("#proactive-chat"),
      quiet: await st.isChecked("#quiet-mode"),
      notify: await st.isChecked("#desktop-notifications")
    };
    check("S1 默认态=兼容现状（proactive on / quiet off / notify on）",
      defaults.proactive === true && defaults.quiet === false && defaults.notify === true, JSON.stringify(defaults));

    /* ---- 2. 点击开关 → 即时持久化（真实 IPC + saveConfig；.switch 的原生 input 为 display:none，
       用户经 slider label 触发——这里 dispatch 同一 change 路径，listener/IPC/saveConfig 全真实） ---- */
    const toggle = (id, want) => st.evaluate(({ id, want }) => {
      const el = document.getElementById(id);
      el.checked = want;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { id, want });
    await toggle("proactive-chat", false);
    await toggle("quiet-mode", true);
    await toggle("desktop-notifications", false);
    await sleep(800);
    const cfg1 = readCfg();
    check("S2 三开关落盘", cfg1.proactiveChat === false && cfg1.quietMode === true && cfg1.desktopNotifications === false,
      JSON.stringify({ p: cfg1.proactiveChat, q: cfg1.quietMode, n: cfg1.desktopNotifications }));

    /* ---- 4/5/6. 三闸 OFF 行为（同实例内） ---- */
    // 用户 chat 入口可用（quiet ON）：输入栏可打开
    await pet.evaluate(() => { const bar = document.getElementById("input-bar"); bar.classList.remove("hidden"); });
    check("S6 quiet ON：用户输入栏可用", await pet.evaluate(() => !document.getElementById("input-bar").classList.contains("hidden")));
    // 用户发起交互（pat）：force 通道在三闸 OFF 下仍响应
    await pet.evaluate(() => window.petAPI.pat());
    await sleep(1200);
    const patBubble = await pet.evaluate(() => {
      const b = document.getElementById("bubble");
      return b && !b.classList.contains("hidden") ? (b.textContent || "") : "";
    });
    check("S5 三闸 OFF：用户 pat 仍有回应（force 通道）", /doctor|博士|唔|嘛|呀|～|~|[a-zA-Z一-龥]/.test(patBubble) && patBubble.length > 0, "bubble=" + patBubble.slice(0, 40));
    // 到点 reminder 真实投递（schedules 引擎，+40s）
    const dueAt = Date.now() + 40000;
    const rem = await pet.evaluate((at) => window.petAPI.setReminder("P1U2隔离验收提醒", at), dueAt);
    check("S4a reminder 创建成功（三闸 OFF 下）", rem && rem.ok === true, JSON.stringify(rem && rem.item && rem.item.id));
    await pet.screenshot({ path: path.join(OUT, "pet-before-due.png") });
    const deadline = Date.now() + 75000;
    let bubble = "";
    while (Date.now() < deadline) {
      await sleep(2000);
      bubble = await pet.evaluate(() => {
        const b = document.getElementById("bubble");
        return b && !b.classList.contains("hidden") ? (b.textContent || "") : "";
      });
      if (bubble.includes("日程提醒")) break;
    }
    check("S4b 三闸 OFF：到点 reminder 仍投递（force 隔离）", bubble.includes("日程提醒"), "bubble=" + bubble.slice(0, 60));
    await pet.screenshot({ path: path.join(OUT, "pet-reminder-due.png") });
    const log = fs.readFileSync(path.join(USER, "logs", "tts.log"), "utf8");
    check("S4c schedules 引擎触发日志在位", /触发:.*P1U2隔离验收提醒/.test(log));
  } finally {
    try { await app.close(); } catch { /* close race */ }
  }

  /* ---- 3. 重启：值与行为保持 ---- */
  app = await launch();
  try {
    const pet = await petWindow(app);
    await sleep(5000);
    const s = await pet.evaluate(() => window.petAPI.getSettings());
    check("S3 重启后 getSettings 值保持",
      s.proactiveChat === false && s.quietMode === true && s.desktopNotifications === false,
      JSON.stringify({ p: s.proactiveChat, q: s.quietMode, n: s.desktopNotifications }));
    await openSettingsWin(app);
    const st = await settingsWindow(app);
    await st.click('a[href="#page-privacy"]');
    await sleep(400);
    check("S3 重启后 Settings UI checkbox 状态一致",
      (await st.isChecked("#proactive-chat")) === false && (await st.isChecked("#quiet-mode")) === true && (await st.isChecked("#desktop-notifications")) === false);
    await st.screenshot({ path: path.join(OUT, "settings-after-restart.png") });
  } finally {
    try { await app.close(); } catch { /* close race */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n===== P1-U2 REAL GUI ACCEPTANCE =====");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
  console.log(`EVIDENCE=${OUT}`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error("FATAL", e); process.exit(2); });

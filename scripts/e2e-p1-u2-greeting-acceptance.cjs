"use strict";
/* P1-U2 closure：启动问候 × 主动行为总 policy 的真实 Electron 验收（isolated userData）。
 * CASE 1 proactive OFF + greeting ON → 无启动问候
 * CASE 2 quiet ON + greeting ON → 无启动问候
 * CASE 3 proactive ON + quiet OFF + greeting ON → 启动问候存在（现状行为保留；含 restart 一致性）
 * CASE 4 greeting OFF → 无启动问候
 * 观察对象：pet 窗口 #bubble 是否出现 persona 开场白标记。 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { _electron } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const MARKER = "P1U2_OPENING_MARKER";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  || " + String(detail).slice(0, 120) : ""));
}

async function runCase(label, cfgOverrides, { restart = false } = {}) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "p1u2-greet-"));
  const USER = path.join(OUT, "userdata"), CHR = path.join(OUT, "chromium");
  fs.mkdirSync(USER, { recursive: true }); fs.mkdirSync(CHR, { recursive: true });
  fs.writeFileSync(path.join(USER, "config.json"), JSON.stringify({
    agreed: true, firstRun: false, renderMode: "gif", walking: false,
    greetingOnStart: true, proactiveChat: true, quietMode: false,
    // keyReady 前置：本地端点免 Key（greeting 不依赖 API 真实可用）
    chat: { baseUrl: "http://127.0.0.1:9/v1", model: "x", apiType: "openai" },
    tts: { enabled: false }, ttsCloud: { enabled: false }, ttsCosy: { enabled: false },
    ttsGenie: { enabled: false }, ttsGsv: { enabled: false },
    agentApi: { enabled: false }, whitemoonRuntime: { enabled: false },
    window: { width: 260, height: 200, scale: 1 },
    ...cfgOverrides
  }));
  // openingLine 提取规则：「对话启动指令」后以（开头的 > 引文行才收集（main.js:6499）
  fs.writeFileSync(path.join(USER, "persona.md"),
    "# persona\n\n## 对话启动指令\n> （" + MARKER + "）你好博士，今天也要好好照顾自己哦\n");
  const env = { ...process.env, SUZURAN_TEST_USERDIR: USER };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({
    executablePath: path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    args: ["--user-data-dir=" + CHR, ROOT], cwd: ROOT, env, timeout: 60000
  });
  const observe = async (app) => {
    let pet = null;
    for (let i = 0; i < 40 && !pet; i++) {
      for (const w of app.windows()) if (w.url().includes("renderer/index.html")) { pet = w; break; }
      if (!pet) await sleep(500);
    }
    if (!pet) throw new Error(label + ": pet window missing");
    await pet.waitForLoadState("domcontentloaded");
    let bubble = "";
    for (let i = 0; i < 16; i++) { // 12s 观察窗（greeting 在 get-state 后同步投递）
      await sleep(750);
      bubble = await pet.evaluate(() => {
        const b = document.getElementById("bubble");
        return b && !b.classList.contains("hidden") ? (b.textContent || "") : "";
      }).catch(() => "");
      if (bubble.includes(MARKER)) break;
    }
    return bubble;
  };
  let app = await launch();
  let bubble = "";
  try { bubble = await observe(app); } finally { try { await app.close(); } catch { /* race */ } }
  if (restart) {
    await sleep(800);
    app = await launch();
    try { bubble = await observe(app); } finally { try { await app.close(); } catch { /* race */ } }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  return bubble;
}

(async () => {
  const b1 = await runCase("case1", { proactiveChat: false, greetingOnStart: true });
  check("CASE1 proactive OFF + greeting ON → 启动问候被抑制", !b1.includes(MARKER), "bubble=" + b1.slice(0, 50));
  const b2 = await runCase("case2", { quietMode: true, greetingOnStart: true });
  check("CASE2 quiet ON + greeting ON → 启动问候被抑制", !b2.includes(MARKER), "bubble=" + b2.slice(0, 50));
  const b3 = await runCase("case3", { greetingOnStart: true }, { restart: true });
  check("CASE3 全默认 ON（含 restart）→ 启动问候仍存在（现状行为保留）", b3.includes(MARKER), "bubble=" + b3.slice(0, 50));
  const b4 = await runCase("case4", { greetingOnStart: false });
  check("CASE4 greeting 细开关 OFF → 无启动问候", !b4.includes(MARKER), "bubble=" + b4.slice(0, 50));
  const failed = results.filter((r) => !r.ok);
  console.log("\n===== P1-U2 STARTUP GREETING ACCEPTANCE =====");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error("FATAL", e); process.exit(2); });

"use strict";
/* global window, document */
// STAGE B：EXTERNAL AGENT FORMAL COGNITION PARITY — 真实 Electron / preload / IPC / Host / Core /
// 最终 provider 线协议请求。合成隔离数据，绝不触碰日常用户数据；loopback 回复不是 LLM 评估。
// T1 formal Experience 进入 External /chat 请求
// T2 correction 后旧值消失新值进入
// T3 retraction 后新旧都消失
// T4 UI chat 与 External /chat 的 formal 语义 context 一致（State/Relationship/identity/Experience）
// T5 configured Instance A 不泄漏 Instance B
// T6 Host 不可达 ⇒ External /chat honest failure（503，零 provider 请求，无 legacy 降级）
// T7 formal OFF ⇒ External /chat 保持 legacy 路径
// T8 UI chat 无 regression（含 formal 不可达时的既有 pet:error 语义）
// T9 /speak 无 regression（不 cognition 化、零 provider 请求）
// T10 真实重启后 correction 语义仍保持
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const net = require("node:net");
const { createRequire } = require("node:module");
const { _electron } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const hostRequire = createRequire(path.resolve(ROOT, "../whitemoon-runtime-host/package.json"));
const { RuntimeHost } = hostRequire("./src/host.js");
const { createHostServer } = hostRequire("./src/server.js");
const { WhiteMoonCore } = hostRequire("whitemoon-core");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wm-stageb-extchat-"));
const userDir = path.join(temp, "body");
const dataDir = path.join(temp, "core");
const ingressToken = crypto.randomUUID();
const hostToken = crypto.randomUUID();
const OLD = "用户喜欢咖啡〔AGENT错误〕";
const NEW = "用户不喜欢咖啡〔AGENT更正〕";
const B_ONLY = "B实例专属事实〔B-ONLY〕";
const FORMAL_MARK = "【正式 Character 投影";
let app, server, host, provider;
const captured = [];
const AGENT_TOKEN = "e2e-ext-" + crypto.randomBytes(12).toString("hex");
let agentPort = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
function httpJson(method, url, { token, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, timeout: timeoutMs
    }, (res) => {
      const parts = [];
      res.on("data", (p) => parts.push(p));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { parsed = { raw: Buffer.concat(parts).toString("utf8") }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function startHost() {
  host = new RuntimeHost({ config: { dataDir, instanceId: "P1-A", packageId: "sussurro",
    body: { baseUrl: "http://127.0.0.1:1", token: "unused", timeoutMs: 100 }, opportunityPulse: { enabled: false } } });
  await host.start();
  server = createHostServer({ host, hostToken, ingressToken });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function stopHost() {
  server.closeAllConnections(); await new Promise((r) => server.close(r)); await host.stop();
}
async function launch(hostUrl, providerUrl, { formal = true } = {}) {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify({ agreed: true, firstRun: false,
    startHidden: true, greetingOnStart: false, proactiveChat: false, personify: false, walking: false,
    zcodeEnabled: false, tts: { enabled: false }, ttsCloud: { enabled: false }, ttsGsv: { enabled: false },
    features: {}, agentApi: { enabled: true, port: agentPort, bearerToken: AGENT_TOKEN, statusEnabled: false, clients: [] },
    chat: { apiType: "openai", baseUrl: providerUrl, model: "stageb-loopback", apiKey: "synthetic-local-only", maxHistoryTurns: 12 },
    whitemoonRuntime: { enabled: formal, baseUrl: hostUrl } }));
  fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}");
  fs.copyFileSync(path.join(ROOT, "persona.default.md"), path.join(userDir, "persona.md"));
  const env = { ...process.env, SUZURAN_TEST_USERDIR: userDir, WHITEMOON_INGRESS_TOKEN: ingressToken };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: path.join(ROOT, "node_modules/electron/dist/electron.exe"),
    args: ["--user-data-dir=" + path.join(temp, "chromium"), ROOT], cwd: ROOT, env, timeout: 60000 });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => !!window.petAPI);
  await pet.evaluate(() => {
    window.__b = { done: [], errors: [] };
    window.petAPI.onDone((p) => window.__b.done.push(p));
    window.petAPI.onError((p) => window.__b.errors.push(p));
  });
  await app.evaluate(({ Menu }) => {
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => { const menu = build(template); global.__bMenu = menu; return menu; };
  });
  await pet.evaluate(() => window.petAPI.setUiLang("zh"));
  const settingsPromise = app.waitForEvent("window");
  await app.evaluate(() => {
    function find(menu) { for (const item of menu.items) {
      if (/设置|Settings/.test(item.label)) return item;
      if (item.submenu) { const child = find(item.submenu); if (child) return child; }
    } }
    const item = find(global.__bMenu);
    if (!item) throw new Error("Settings menu item unavailable");
    item.click();
  });
  const settings = await settingsPromise;
  await settings.waitForLoadState("domcontentloaded");
  // sec-memory（formal memory-control 面板）位于「对话」页：显式导航后再操作（不依赖默认页）
  await settings.click('a[href="#page-chat"]');
  await settings.waitForFunction(() => {
    const el = document.getElementById("formal-memory-refresh");
    return !!el && el.offsetParent !== null;
  }, null, { timeout: 15000 });
  // agent API 就绪（loopback server 起来）
  const t0 = Date.now();
  for (;;) {
    try { const h = await httpJson("GET", `http://127.0.0.1:${agentPort}/health`, { timeoutMs: 1500 }); if (h.status === 200) break; } catch { /* retry */ }
    if (Date.now() - t0 > 30000) throw new Error("agent api not up");
    await new Promise((r) => setTimeout(r, 400));
  }
  return { pet, settings };
}
async function uiChat(pet, text) {
  const count = await pet.evaluate(() => window.__b.done.length + window.__b.errors.length);
  const index = captured.length;
  await pet.evaluate((value) => window.petAPI.ask(value, "b-" + Date.now()), text);
  await pet.waitForFunction((n) => window.__b.done.length + window.__b.errors.length > n, count, { timeout: 30000 });
  assert.equal(captured.length, index + 1, "UI chat 必须恰好产生一次 provider 请求");
  return captured[index];
}
async function agentChat(text) {
  const index = captured.length;
  const r = await httpJson("POST", `http://127.0.0.1:${agentPort}/chat`, { token: AGENT_TOKEN, body: { text } });
  return { http: r, request: captured.length > index ? captured[index] : null };
}
const wire = (req) => JSON.stringify(req);

async function main() {
  agentPort = await freePort();
  const core = new WhiteMoonCore({ dataDir });
  await core.createInstance({ instanceId: "P1-A", packageId: "sussurro" });
  await core.createInstance({ instanceId: "P1-B", packageId: "sussurro" });
  await core.recordExperience("P1-A", { id: "b-wrong", type: "personal-note", payload: { text: OLD } });
  await core.recordExperience("P1-B", { id: "b-only", type: "personal-note", payload: { text: B_ONLY } });
  provider = http.createServer((req, res) => {
    const parts = []; req.on("data", (p) => parts.push(p)); req.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"收到。【情绪：开心】"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  let hostUrl = await startHost();
  let body = await launch(hostUrl, providerUrl);
  await body.settings.locator("#formal-memory-refresh").waitFor({ timeout: 5000 });

  // ---- T1 + T5：External /chat formal Experience 进入 + B 不泄漏 ----
  const t1 = await agentChat("我喜欢喝什么？");
  assert.equal(t1.http.status, 200);
  assert.equal(t1.http.body.ok, true);
  assert.ok(t1.request && wire(t1.request).includes(FORMAL_MARK), "T1 External /chat 走 formal 版式");
  assert.ok(wire(t1.request).includes(OLD), "T1 有效 Experience 进入最终 provider 请求");
  assert.ok(!wire(t1.request).includes(B_ONLY), "T5 Instance B 事实不得泄漏进 configured Instance A 请求");
  console.log("PASS T1/T5 external /chat formal experience + instance isolation");

  // ---- T2：Settings UI 纠正 → External /chat 新值进、旧值消失 ----
  const row = body.settings.locator('[data-memory-id="b-wrong"]');
  await row.locator('[data-action="correct"]').click();
  await row.locator("textarea").fill(NEW);
  await row.locator('[data-action="save"]').click();
  await body.settings.waitForFunction(() => document.getElementById("formal-memory-status").textContent.includes("已保存"));
  const t2 = await agentChat("我对咖啡的偏好是什么？");
  assert.ok(wire(t2.request).includes(NEW) && !wire(t2.request).includes(OLD), "T2 correction 后 External 请求更新");
  console.log("PASS T2 correction visible to external /chat");

  // ---- T4：UI chat 与 External /chat formal 语义一致 ----
  const t4ui = await uiChat(body.pet, "我对咖啡的偏好是什么？");
  const t4ex = (await agentChat("我对咖啡的偏好是什么？")).request;
  for (const req of [t4ui, t4ex]) {
    assert.ok(wire(req).includes(FORMAL_MARK), "T4 两入口都走 formal 版式");
    assert.ok(wire(req).includes(NEW), "T4 effective Experience 一致");
    assert.ok(!wire(req).includes(OLD), "T4 superseded 一致排除");
    assert.ok(!wire(req).includes(B_ONLY), "T4 instance 隔离一致");
    assert.ok(wire(req).includes("sussurro"), "T4 character identity（packageId）一致进入");
  }
  console.log("PASS T4 UI vs external formal semantic parity (experience/state/relationship/identity via same owner)");

  // ---- T9：/speak 无 regression（不 cognition 化、零 provider 请求） ----
  const speakBefore = captured.length;
  const speak = await httpJson("POST", `http://127.0.0.1:${agentPort}/speak`, { token: AGENT_TOKEN, body: { text: "STAGEB_SPOKE_OK" } });
  assert.equal(speak.status, 200);
  assert.equal(speak.body.ok, true);
  assert.equal(speak.body.dispatched, true);
  assert.equal(captured.length, speakBefore, "T9 /speak 不产生 provider 请求（非 cognition）");
  console.log("PASS T9 /speak isolation preserved");

  // ---- T10：真实重启后 correction 语义仍保持 ----
  await app.close(); app = null;
  await stopHost(); hostUrl = await startHost();
  body = await launch(hostUrl, providerUrl);
  const t10 = await agentChat("重启后我的咖啡偏好？");
  assert.ok(wire(t10.request).includes(NEW) && !wire(t10.request).includes(OLD), "T10 重启后 External 仍见更正");
  console.log("PASS T10 restart keeps correction semantics for external /chat");

  // ---- T3：retract → 新旧都不进入 ----
  const accepted = core.loadInstance("P1-A").experiences[1].id;
  await body.settings.locator("#formal-memory-refresh").click();
  await body.settings.waitForFunction((id) => !!document.querySelector(`[data-memory-id="${id}"] [data-action="retract"]`), accepted);
  await body.settings.locator(`[data-memory-id="${accepted}"] [data-action="retract"]`).click();
  await body.settings.waitForFunction(() => document.getElementById("formal-memory-status").textContent.includes("已保存"));
  const t3 = await agentChat("现在还记得咖啡偏好吗？");
  assert.ok(!wire(t3.request).includes(NEW) && !wire(t3.request).includes(OLD), "T3 retraction 后新旧都不进入 External 请求");
  console.log("PASS T3 retraction removes both from external /chat");

  // ---- T6 + T8：Host 不可达 ⇒ External 503 无降级、UI pet:error 语义保持 ----
  await stopHost();
  const before6 = captured.length;
  const t6 = await agentChat("主机挂了你还记得我吗？");
  assert.equal(t6.http.status, 503);
  assert.equal(t6.http.body.code, "FORMAL_PROJECTION_UNAVAILABLE");
  assert.ok(t6.http.body.meta && t6.http.body.meta.projectionState, "T6 503 携带 projectionState meta");
  assert.equal(captured.length, before6, "T6 formal 不可达 ⇒ 零 provider 请求（绝不 legacy 降级）");
  const t8errCount = await body.pet.evaluate(() => window.__b.errors.length);
  await body.pet.evaluate((v) => window.petAPI.ask(v, "b-t8"), "UI 在 formal 不可达时也应失败");
  await body.pet.waitForFunction((n) => window.__b.errors.length > n, t8errCount, { timeout: 15000 });
  const t8err = (await body.pet.evaluate(() => window.__b.errors[window.__b.errors.length - 1]));
  assert.equal(t8err.code, "FORMAL_PROJECTION_UNAVAILABLE");
  assert.equal(captured.length, before6, "T8 UI 同样零降级（既有 honest failure 语义无 regression）");
  console.log("PASS T6/T8 formal unavailable: external 503 + UI pet:error, no legacy fallback anywhere");

  // ---- T7：formal OFF ⇒ External /chat 保持 legacy 路径 ----
  await app.close(); app = null;
  body = await launch("http://127.0.0.1:1", providerUrl, { formal: false }); // Host 地址无效也无妨：disabled ⇒ 零流量
  const before7 = captured.length;
  const t7 = await agentChat("legacy 模式测试");
  assert.equal(t7.http.status, 200);
  assert.ok(t7.request && before7 + 1 === captured.length, "T7 legacy 模式 provider 正常调用");
  assert.ok(!wire(t7.request).includes(FORMAL_MARK), "T7 legacy 模式不注入 formal 投影");
  assert.ok(wire(t7.request).includes("legacy 模式测试"), "T7 legacy 请求正常携带用户文本");
  console.log("PASS T7 formal OFF keeps legacy external path");
  await app.close(); app = null;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (app) { try { await app.close(); } catch { /* already */ } }
  if (server?.listening) { try { await stopHost(); } catch { /* down */ } }
  if (provider?.listening) { provider.closeAllConnections(); await new Promise((r) => provider.close(r)); }
  console.log("EVIDENCE=" + temp);
});

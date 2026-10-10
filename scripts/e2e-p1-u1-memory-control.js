"use strict";
/* global window, document */
// Real Electron / preload / IPC / Host / Core / final provider wire request.
// Synthetic, isolated data only. The loopback reply is not an LLM evaluation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { _electron } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const hostRequire = createRequire(path.resolve(ROOT, "../whitemoon-runtime-host/package.json"));
const { RuntimeHost } = hostRequire("./src/host.js");
const { createHostServer } = hostRequire("./src/server.js");
const { WhiteMoonCore } = hostRequire("whitemoon-core");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wm-p1-u1-electron-"));
const userDir = path.join(temp, "body");
const dataDir = path.join(temp, "core");
const ingressToken = crypto.randomUUID();
const hostToken = crypto.randomUUID();
const OLD = "用户喜欢咖啡〔P1错误〕";
const NEW = "用户不喜欢咖啡〔P1更正〕";
let app, server, host, provider;
const captured = [];

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
async function launch(hostUrl, providerUrl) {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify({ agreed: true, firstRun: false,
    startHidden: true, greetingOnStart: false, proactiveChat: false, personify: false, walking: false,
    zcodeEnabled: false, tts: { enabled: false }, ttsCloud: { enabled: false }, ttsGsv: { enabled: false },
    features: {}, agentApi: { enabled: false },
    chat: { apiType: "openai", baseUrl: providerUrl, model: "p1-loopback", apiKey: "synthetic-p1-local-only", maxHistoryTurns: 12 },
    whitemoonRuntime: { enabled: true, baseUrl: hostUrl } }));
  fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}");
  fs.copyFileSync(path.join(ROOT, "persona.default.md"), path.join(userDir, "persona.md"));
  const env = { ...process.env, SUZURAN_TEST_USERDIR: userDir, WHITEMOON_INGRESS_TOKEN: ingressToken };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: path.join(ROOT, "node_modules/electron/dist/electron.exe"),
    args: ["--user-data-dir=" + path.join(temp, "chromium"), ROOT], cwd: ROOT, env, timeout: 60000 });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => !!window.petAPI);
  await pet.evaluate(() => {
    window.__p1 = { done: [], errors: [] };
    window.petAPI.onDone((p) => window.__p1.done.push(p));
    window.petAPI.onError((p) => window.__p1.errors.push(p));
  });
  // Activate the real Settings menu item; keep the production window owner.
  await app.evaluate(({ Menu }) => {
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => { const menu = build(template); global.__p1Menu = menu; return menu; };
  });
  await pet.evaluate(() => window.petAPI.setUiLang("zh"));
  const settingsPromise = app.waitForEvent("window");
  await app.evaluate(() => {
    function find(menu) { for (const item of menu.items) {
      if (/设置|Settings/.test(item.label)) return item;
      if (item.submenu) { const child = find(item.submenu); if (child) return child; }
    } }
    const item = find(global.__p1Menu);
    if (!item) throw new Error("Settings menu item unavailable");
    item.click();
  });
  const settings = await settingsPromise;
  await settings.waitForLoadState("domcontentloaded");
  return { pet, settings };
}
async function chat(pet, text) {
  const count = await pet.evaluate(() => window.__p1.done.length + window.__p1.errors.length);
  const index = captured.length;
  await pet.evaluate((value) => window.petAPI.ask(value, "p1-" + Date.now()), text);
  await pet.waitForFunction((n) => window.__p1.done.length + window.__p1.errors.length > n, count, { timeout: 30000 });
  assert.equal(captured.length, index + 1);
  return captured[index];
}
async function main() {
  const core = new WhiteMoonCore({ dataDir });
  await core.createInstance({ instanceId: "P1-A", packageId: "sussurro" });
  await core.createInstance({ instanceId: "P1-B", packageId: "sussurro" });
  await core.recordExperience("P1-A", { id: "p1-wrong", type: "personal-note", payload: { text: OLD } });
  const original = structuredClone(core.loadInstance("P1-A").experiences[0]);
  const bBefore = fs.readFileSync(core.store.instancePath("P1-B"), "utf8");
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
  await body.settings.locator("#formal-memory-refresh").click();
  await body.settings.waitForFunction((text) => document.getElementById("formal-memory-history").textContent.includes(text), OLD);
  assert.equal(await body.settings.locator("#mem-add-btn").isVisible(), false, "formal mode must hide the global legacy memory editor");
  console.log("PASS R1/R2 Settings memory inspect displays current Instance and test content");
  const before = await chat(body.pet, "旧会话：用户喜欢咖啡〔旧会话〕");
  assert.ok(JSON.stringify(before).includes(OLD));
  console.log("PASS T4 final serialized provider request contains the old content before correction");
  const row = body.settings.locator('[data-memory-id="p1-wrong"]');
  await row.locator('[data-action="correct"]').click();
  await row.locator("textarea").fill(NEW);
  await row.locator('[data-action="save"]').click();
  await body.settings.waitForFunction(() => document.getElementById("formal-memory-status").textContent.includes("已保存"));
  assert.ok((await body.settings.locator("#formal-memory-history").innerText()).includes("已被纠正"));
  assert.deepEqual(core.loadInstance("P1-A").experiences[0], original);
  assert.equal(fs.readFileSync(core.store.instancePath("P1-B"), "utf8"), bBefore);
  console.log("PASS R3/R4 UI correction is durable, preserves historical content and isolates B");
  const countBeforeStaleRegenerate = captured.length;
  const staleRegenerate = await body.pet.evaluate(() => window.petAPI.regenerate("p1-stale-regenerate"));
  assert.equal(staleRegenerate, null);
  assert.equal(captured.length, countBeforeStaleRegenerate);
  console.log("PASS corrected memory prevents regenerating a reply from obsolete conversation context");
  const after = await chat(body.pet, "我对咖啡的偏好是什么？");
  assert.ok(JSON.stringify(after).includes(NEW));
  assert.ok(!JSON.stringify(after).includes(OLD));
  assert.ok(!JSON.stringify(after).includes("〔旧会话〕"));
  console.log("PASS R5/R6 final provider wire request uses corrected content and excludes old conversation context");
  const countBeforeRegenerate = captured.length;
  await body.pet.evaluate(() => window.petAPI.regenerate("p1-current-regenerate"));
  assert.equal(captured.length, countBeforeRegenerate + 1);
  assert.ok(JSON.stringify(captured[countBeforeRegenerate]).includes(NEW));
  assert.ok(!JSON.stringify(captured[countBeforeRegenerate]).includes(OLD));
  assert.ok(!JSON.stringify(captured[countBeforeRegenerate]).includes("〔旧会话〕"));
  console.log("PASS eligible formal regenerate uses current memory without obsolete history or legacy recall");
  // A real disk-commit failure travels through Host → IPC → rendered UI.
  const accepted = core.loadInstance("P1-A").experiences[1].id;
  const save = host.core.store.save;
  host.core.store.save = () => { throw new Error("synthetic disk failure"); };
  await body.settings.locator(`[data-memory-id="${accepted}"] [data-action="retract"]`).click();
  await body.settings.waitForFunction(() => document.getElementById("formal-memory-status").textContent.includes("未确认保存"));
  assert.ok((await body.settings.locator(`[data-memory-id="${accepted}"]`).innerText()).includes("当前有效"));
  host.core.store.save = save;
  console.log("PASS T8 failed persistence leaves UI record active and shows failure");
  await body.settings.locator("#formal-memory-section").scrollIntoViewIfNeeded();
  const screenshot = path.join(temp, "memory-inspect.png");
  await body.settings.screenshot({ path: screenshot, fullPage: false });
  console.log("SCREENSHOT " + screenshot);
  await app.close(); app = null;
  await stopHost(); hostUrl = await startHost();
  body = await launch(hostUrl, providerUrl);
  await body.settings.locator("#formal-memory-refresh").click();
  await body.settings.waitForFunction((text) => document.getElementById("formal-memory-history").textContent.includes(text), NEW);
  const restarted = await chat(body.pet, "重启后的偏好是什么？");
  assert.ok(JSON.stringify(restarted).includes(NEW));
  assert.ok(!JSON.stringify(restarted).includes(OLD));
  console.log("PASS R7/R8 real Electron and Host restart preserves correction and provider effect");
  const restored = new WhiteMoonCore({ dataDir: path.join(temp, "restore") });
  await restored.restoreLogicalArchive(await core.exportLogicalArchive("P1-A"));
  assert.deepEqual(await restored.inspectMemory("P1-A"), await core.inspectMemory("P1-A"));
  console.log("PASS T10 P0-O1 archive round-trip preserves correction semantics");
  // Success path for Retract also passes through the actual UI.
  await body.settings.locator(`[data-memory-id="${accepted}"] [data-action="retract"]`).click();
  await body.settings.waitForFunction(() => document.getElementById("formal-memory-status").textContent.includes("已保存"));
  const retracted = await chat(body.pet, "当前还记得咖啡偏好吗？");
  assert.ok(!JSON.stringify(retracted).includes(NEW));
  assert.ok(!JSON.stringify(retracted).includes(OLD));
  console.log("PASS Retract removes the replacement from the next final provider request without reactivating old content");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close();
  if (server?.listening) await stopHost();
  if (provider?.listening) { provider.closeAllConnections(); await new Promise((r) => provider.close(r)); }
});

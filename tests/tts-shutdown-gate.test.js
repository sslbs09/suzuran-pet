"use strict";
/**
 * F5 修复回归测试：shutdown 期间 TTS 引擎（GSV/Genie）不得被自愈/ensure 复活。
 * 真行为测试：stub child_process.spawn/execFile + global fetch（require tts-manager 前注入），
 * 不启动任何 Python、不占 9880/9881、零真实网络。normal 路径含一次真实 ensure 流程（spawn 被捕获）。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

/* ---------- 进程/网络桩（必须在 require tts-manager 之前打桩：它解构缓存 spawn） ---------- */
const cp = require("child_process");
const spawnCalls = [];
const execFileCalls = [];
function fakeChild() {
  const c = new EventEmitter();
  c.unref = () => {};
  c.kill = () => true;
  setImmediate(() => { c.emit("exit", 0); c.emit("close", 0, null); });
  return c;
}
cp.spawn = (...args) => { spawnCalls.push(args); return fakeChild(); };
cp.execFile = (...args) => {
  execFileCalls.push(args);
  const cb = args[args.length - 1];
  if (typeof cb === "function") setImmediate(() => cb(null, "", ""));
  return fakeChild();
};
cp.exec = cp.execFile;
// 隔离真实用户配置（fixedOnly 等开关可能为 true，会短路 ensure 路径）：tts-manager 经模块对象调用，patch 即时生效。
// 注意：ensureGsvServer 忽略入参 g、固定读 config.getConfig().ttsGsv（生产语义），GSV 夹具必须注入 config stub。
const FAKE_PY = process.execPath; // 真实存在的文件（missingEnginePath 通过；永远不被 exec，spawn 已被桩捕获）
const REAL_FILE = __filename;
const gsvFixture = () => ({
  python: FAKE_PY, serverScript: REAL_FILE, sovitsPath: REAL_FILE, gptPath: REAL_FILE,
  refAudio: REAL_FILE, refText: "x", server: "http://127.0.0.1:9880", device: "cpu", startTimeout: 1,
});
const configMod = require("../src/config");
configMod.getConfig = () => ({ tts: {}, ttsGsv: gsvFixture(), ttsGenie: {} });
configMod.saveConfig = () => {};
const gsvCfg = gsvFixture;
const genieCfg = () => ({
  python: FAKE_PY, serverScript: REAL_FILE, refAudio: REAL_FILE, refText: "x",
  server: "http://127.0.0.1:9881", startTimeout: 1,
});
const fetchUrls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchUrls.push(String(url));
  const err = new Error("fetch failed");
  err.cause = { code: "ECONNREFUSED" };
  throw err; // 引擎一律"未运行"：ensure 走拉起分支，loop 走超时/放弃
};

const tts = require("../src/tts-manager");
const { createQuitLifecycle } = require("../src/quit-lifecycle");

const pySpawns = () => spawnCalls.filter((a) => String(a[0]) === String(FAKE_PY)).length;

const mgrSrc = fs.readFileSync(require.resolve("../src/tts-manager.js"), "utf8").replace(/\r\n/g, "\n");
const main = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");

test("T10a fresh module state: shuttingDown defaults false (process restart/dev reload never inherits true)", () => {
  assert.equal(tts.isShuttingDown(), false);
  assert.equal(typeof tts.setShuttingDown, "function");
});

test("T1+T4 normal state: restartGsvEngine still runs full self-heal (kill attempt + engine spawn)", async () => {
  tts.setShuttingDown(false);
  const before = pySpawns();
  const up = await tts.restartGsvEngine(gsvCfg());
  assert.equal(up, false, "假引擎永远不健康 → 等待超时 false（本测试不真起服务）");
  assert.ok(pySpawns() >= before + 1, "非退出态自愈仍拉起引擎（行为不变）");
  assert.ok(execFileCalls.some((a) => String(a[1] || "").includes("Stop-Process") || String(a[0]).includes("powershell")),
    "restart 前置 kill 步骤仍执行（自愈链路完整）");
  const spawnOpts = spawnCalls.filter((a) => String(a[0]) === String(FAKE_PY)).at(-1)[2];
  assert.equal(spawnOpts.detached, true, "detached/unref 形态未变（本轮不改 spawn 方式）");
});

test("T6 flag flips true strictly before any cleanup kill step (quitLifecycle contract)", async () => {
  const order = [];
  let cleanupSawFlag = null;
  let done = false, started = false;
  const lc = createQuitLifecycle({
    isCleanupDone: () => done,
    isCleanupStarted: () => started,
    markCleanupStarted: () => { started = true; },
    onStart: () => { order.push("onStart"); tts.setShuttingDown(true); }, // 与 main.js quitLifecycle 同构
    cleanup: async () => { cleanupSawFlag = tts.isShuttingDown(); order.push("kill-genie"); order.push("kill-gsv"); },
    setCleanupDone: () => { done = true; },
    requestQuit: () => order.push("request-quit"),
  });
  lc.beforeQuit({ preventDefault() {} });
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["onStart", "kill-genie", "kill-gsv", "request-quit"], "kill 步骤前 flag 已为 true");
  assert.equal(cleanupSawFlag, true);
});

test("T2 quitting: restartGsvEngine refuses without even touching kill/spawn", async () => {
  assert.equal(tts.isShuttingDown(), true, "T6 已进入 shutdown 态");
  const p0 = pySpawns(), e0 = execFileCalls.length, s0 = spawnCalls.length;
  assert.equal(await tts.restartGsvEngine(gsvCfg()), false);
  assert.equal(pySpawns(), p0);
  assert.equal(spawnCalls.length, s0, "restart 在 kill 前即被拒：不产生任何子进程动作");
  assert.equal(execFileCalls.length, e0);
});

test("T3 quitting: ensureGsvServer refuses implicit spawn", async () => {
  const s0 = pySpawns();
  assert.equal(await tts.ensureGsvServer(gsvCfg()), false);
  assert.equal(pySpawns(), s0);
});

test("T8 quitting: ensureGenieServer refuses spawn (同类复活路径全覆盖)", async () => {
  const s0 = pySpawns();
  assert.equal(await tts.ensureGenieServer(genieCfg()), false);
  assert.equal(pySpawns(), s0);
});

test("T5+T7 late-arriving failure repeats cannot resurrect (repeated restart attempts, still zero spawn)", async () => {
  const s0 = pySpawns();
  for (let i = 0; i < 3; i += 1) { // 模拟 cleanup kill 后多条在途请求陆续 ECONNREFUSED 触发自愈
    assert.equal(await tts.restartGsvEngine(gsvCfg()), false);
    assert.equal(await tts.ensureGsvServer(gsvCfg()), false);
  }
  assert.equal(pySpawns(), s0);
  // 复活入口源码断言：gsvTtsJa 连接失败分支在调 restartGsvEngine 前有显式退出态断点
  assert.match(mgrSrc, /非连接类错误不走重启[\s\S]{0,200}if \(shuttingDown\) \{ logTts\("gsv", "退出清理中：放弃崩溃自愈/);
  // 晚到的 ensure 等待循环也必须被中断（不复活、不空转到 4 分钟）
  assert.equal((mgrSrc.match(/if \(shuttingDown\) \{ logTts\("(genie|gsv)", "退出清理中：放弃就绪等待"\)/g) || []).length, 2);
});

test("T9 shutdown entry is idempotent (repeated beforeQuit / repeated set)", async () => {
  let onStarts = 0;
  let done = false, started = false;
  const lc = createQuitLifecycle({
    isCleanupDone: () => done, isCleanupStarted: () => started,
    markCleanupStarted: () => { started = true; },
    onStart: () => { onStarts += 1; tts.setShuttingDown(true); },
    cleanup: async () => {}, setCleanupDone: () => { done = true; }, requestQuit: () => {},
  });
  lc.beforeQuit({ preventDefault() {} });
  lc.beforeQuit({ preventDefault() {} }); // 清理进行中的二次 quit
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  lc.beforeQuit({ preventDefault() {} }); // 完成后的放行 quit（不应再有 onStart）
  assert.equal(onStarts, 1);
  tts.setShuttingDown(true);
  assert.equal(tts.isShuttingDown(), true);
});

test("T10b production wiring: exactly one setShuttingDown call site, and it is true-before-kill", () => {
  assert.equal((main.match(/setShuttingDown\(/g) || []).length, 1, "main 唯一置位点（单一状态源，无第二 boolean）");
  assert.match(main, /quitting = true;[\s\S]{0,200}tts\.setShuttingDown\(true\);/, "与 quitting 同点设置（早于 cleanup kill）");
  assert.doesNotMatch(main, /setShuttingDown\(false\)/, "运行期永不复位（进程生命周期内单向；跨进程重启天然 false）");
});

test("housekeeping: kill-family functions stay unblocked; gates are first-statement; scope untouched", () => {
  for (const name of ["killGsvProcesses", "killPortListener", "shutdownGenieServer"]) {
    const i = mgrSrc.indexOf(name + "(");
    const body = mgrSrc.slice(i, mgrSrc.indexOf("\nfunction ", i));
    assert.doesNotMatch(body, /shuttingDown/, `${name} 不得被 flag 阻断（cleanup 依赖它在置 true 之后仍能杀进程）`);
  }
  assert.match(mgrSrc, /async function ensureGenieServer\(q\) \{\n  if \(shuttingDown\)/, "Genie gate 首语句");
  assert.match(mgrSrc, /function ensureGsvServer\(g\) \{\n  if \(shuttingDown\)/, "GSV gate 首语句（含 fixedOnly/applyBundledVoice 之前，零副作用）");
  assert.match(mgrSrc, /async function restartGsvEngine\(g\) \{\n  if \(shuttingDown\)/, "restart gate 首语句（kill 前即拒）");
  // 未顺手扩权：本轮不动 renderer recovery / crash budget / clickability 相关文件
  assert.doesNotMatch(mgrSrc, /CLICK-DIAG|RENDERER-DIAG/);
});

test("cleanup: fetch stub only ever saw loopback test endpoints (no real network attempted)", () => {
  globalThis.fetch = realFetch;
  for (const u of fetchUrls) assert.match(u, /^http:\/\/127\.0\.0\.1:98(80|81)/);
  assert.ok(fetchUrls.length > 0);
});

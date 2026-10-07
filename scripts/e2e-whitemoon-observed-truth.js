"use strict";
/* Globals below are resolved only inside Playwright's remote page callbacks. */
/* global spineObj, activeRenderMode, spineBootstrapPending, isSleeping, activeRenderGeneration, spineApp, setSpineAnim, currentMainRenderModeSeq, window */
/** M3 real Electron Body + production Adapter + real Host process.
 * Oracles are native BrowserWindow reads and actual renderer TrackEntry/frame
 * state. Test data lives in a unique disposable directory, never user state.
 */
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

const BODY_ROOT = path.resolve(__dirname, "..");
const HOST_ROOT = path.resolve(BODY_ROOT, "..", "whitemoon-runtime-host");
const HOST_MAIN = path.join(HOST_ROOT, "src", "main.js");
const HOST_TOKEN = crypto.randomBytes(24).toString("hex");
const BODY_TOKEN = crypto.randomBytes(24).toString("hex");
const INGRESS_TOKEN = crypto.randomBytes(24).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log("[m3-e2e] " + message);
const evidence = [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(label, read, { timeoutMs = 60000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await read();
    if (result) { log(label); return result; }
    await sleep(150);
  }
  throw new Error(label + " timed out");
}
async function json(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    signal: AbortSignal.timeout(5000)
  });
  return { code: response.status, body: await response.json() };
}
async function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = fork(HOST_MAIN, args, { silent: true, env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error("Host CLI exit " + code)));
  });
}
async function launchHost(configPath, env) {
  return new Promise((resolve, reject) => {
    const child = fork(HOST_MAIN, ["serve", "--config", configPath], { silent: true, env });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((item) => item.startsWith('{"event":"listening"'));
      if (line) resolve({ child, url: "http://127.0.0.1:" + JSON.parse(line).port });
    });
    child.on("error", reject);
    child.on("exit", (code) => { if (!output.includes('"event":"listening"')) reject(new Error("Host early exit " + code)); });
    setTimeout(() => reject(new Error("Host launch timeout")), 20000).unref();
  });
}
async function stopHost(host) {
  if (!host || host.child.exitCode !== null) return;
  const exited = new Promise((resolve) => host.child.once("exit", resolve));
  host.child.stdin.end();
  await exited;
}
async function nativeBounds(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((item) => /renderer\/index\.html/.test(item.webContents.getURL().replaceAll("\\", "/")));
    if (!win) throw new Error("native pet window missing");
    return win.getBounds();
  });
}
async function rendererState(page) {
  return page.evaluate(() => {
    const track = spineObj?.state?.getCurrent(0);
    return {
      mode: activeRenderMode, bootstrap: spineBootstrapPending,
      clip: track?.animation?.name ?? null, applied: track?.nextTrackLast ?? -1,
      sleeping: isSleeping, rendererGeneration: activeRenderGeneration,
      canvasShown: !!spineApp?.view && !spineApp.view.classList.contains("hidden")
    };
  });
}

async function main() {
  const productionFiles = [
    path.join(BODY_ROOT, "main.js"), path.join(BODY_ROOT, "preload.js"),
    path.join(BODY_ROOT, "src", "observed-body-truth.js"),
    path.join(BODY_ROOT, "renderer", "pet.js"), path.join(BODY_ROOT, "renderer", "observed-body-sampler.js"),
    path.join(HOST_ROOT, "src", "host.js"), path.join(HOST_ROOT, "src", "server.js"),
    ...["index.js", "body-client.js", "observed-body-truth.js"].map((name) =>
      path.join(BODY_ROOT, "..", "whitemoon-sussurro-desktop-adapter", "src", name))
  ];
  const fingerprint = () => Object.fromEntries(productionFiles.map((file) =>
    [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  const sourceHashes = fingerprint();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whitemoon-m3-process-"));
  const userDir = path.join(tempDir, "body-state");
  const chromiumDir = path.join(tempDir, "chromium");
  const hostDir = path.join(tempDir, "host-data");
  for (const dir of [userDir, chromiumDir, hostDir]) fs.mkdirSync(dir);
  const bodyPort = await freePort();
  const bodyUrl = "http://127.0.0.1:" + bodyPort;
  const configPath = path.join(tempDir, "host-config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: hostDir, instanceId: "m3-process-instance", packageId: "sussurro",
    host: { port: 0 }, body: { baseUrl: bodyUrl, timeoutMs: 3000 }
  }));
  const hostEnv = { ...process.env, WHITEMOON_HOST_TOKEN: HOST_TOKEN,
    WHITEMOON_INGRESS_TOKEN: INGRESS_TOKEN, SUZURRO_AGENT_TOKEN: BODY_TOKEN };
  delete hostEnv.ELECTRON_RUN_AS_NODE;
  const bodyConfig = {
    agreed: true, firstRun: false, renderMode: "spine", spineSkinId: "",
    startHidden: false, greetingOnStart: false, proactiveChat: false,
    personify: false, walking: false, walkTiming: { sitMaxSec: 15, walkMaxSec: 8 },
    zcodeEnabled: false, tts: { enabled: false }, ttsCloud: { enabled: false },
    ttsCosy: { enabled: false }, ttsGenie: { enabled: false }, ttsGsv: { enabled: false },
    agentApi: { enabled: true, port: bodyPort, bearerToken: BODY_TOKEN, clients: [] },
    whitemoonRuntime: { enabled: false }
  };
  // Fresh disposable test credential, never a real account token or committed file.
  fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify(bodyConfig));
  fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}");
  const bodyEnv = { ...process.env, SUZURAN_TEST_USERDIR: userDir };
  for (const key of Object.keys(bodyEnv)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key === "SUZURRO_AGENT_TOKEN" || /WHITEMOON_.*TOKEN/.test(key)) delete bodyEnv[key];
  }
  let host = null;
  let app = null;
  try {
    await cli(["create-instance", "--config", configPath], hostEnv);
    host = await launchHost(configPath, hostEnv);
    const characterPath = path.join(hostDir, "instances", "m3-process-instance.json");
    const characterBefore = fs.readFileSync(characterPath, "utf8");
    const launchBody = () => _electron.launch({
      executablePath: path.join(BODY_ROOT, "node_modules", "electron", "dist", "electron.exe"),
      args: ["--user-data-dir=" + chromiumDir, BODY_ROOT], cwd: BODY_ROOT, env: bodyEnv, timeout: 60000
    });
    app = await launchBody();
    let page = await app.firstWindow();
    await waitFor("real Spine owner is applied and visible", async () => {
      try { const state = await rendererState(page); return state.mode === "spine" && !state.bootstrap && state.canvasShown && state.applied >= 0; }
      catch { return false; }
    });
    const readTruth = async () => {
      const result = await json(host.url + "/observed-state", HOST_TOKEN);
      assert.equal(result.code, 200);
      return result.body;
    };
    const observed = async () => waitFor("current rendered animation observed", async () => {
      const result = await readTruth();
      return result.status === "available" && result.snapshot.animation.status === "observed" ? result.snapshot : false;
    });
    const startup = await observed();
    assert.deepEqual(startup.geometry, await nativeBounds(app));
    assert.equal(startup.animation.clip, (await rendererState(page)).clip);
    assert.equal(startup.posture.visual, "unknown");
    evidence.push({ case: "E1", generation: startup.generation, animation: startup.animation, geometry: startup.geometry });
    assert.equal((await json(bodyUrl + "/observed-state")).code, 401);
    assert.equal((await json(host.url + "/observed-state", INGRESS_TOKEN)).code, 401);
    log("E1 startup, independent native/renderer oracles, authenticated debug boundary PASS");

    const movedNative = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("/renderer/index.html"));
      const before = win.getBounds();
      win.setPosition(before.x + 19, before.y - 13);
      return win.getBounds();
    });
    const moved = await observed();
    assert.deepEqual(moved.geometry, movedNative);
    assert.notDeepEqual(moved.geometry, startup.geometry);
    evidence.push({ case: "E2", native: movedNative, observed: moved.geometry });
    log("E2 real native move reflected in pulled geometry PASS");

    // A selected clip with a stopped natural frame loop is never observed.
    await page.evaluate(() => { spineApp.ticker.stop(); setSpineAnim("Move", true, "m3-test-request-only"); });
    const noFrame = await readTruth();
    assert.equal(noFrame.snapshot.animation.status, "unknown");
    assert.equal(noFrame.snapshot.animation.clip, null);
    await page.evaluate(() => spineApp.ticker.start());
    await observed();
    log("T10 requested TrackEntry without a natural drawn frame stays unknown PASS");

    const beforeWalk = await nativeBounds(app);
    await page.evaluate(() => window.petAPI.setWalking(true));
    const walking = await waitFor("E3 real Move frame AND native displacement", async () => {
      const result = await readTruth();
      if (result.status !== "available") return false;
      const snapshot = result.snapshot;
      if (snapshot.animation.status !== "observed" || snapshot.animation.clip !== "Move") return false;
      const state = await rendererState(page);
      const native = await nativeBounds(app);
      return state.clip === "Move" && state.applied >= 0 && native.x !== beforeWalk.x
        && snapshot.geometry.x !== beforeWalk.x ? { snapshot, native, renderer: state } : false;
    });
    evidence.push({ case: "E3", before: beforeWalk, ...walking });
    await page.evaluate(() => window.petAPI.setWalking(false));

    await page.evaluate(() => window.petAPI.setSleeping(true));
    const sleeping = await waitFor("E4 accepted canonical sleep matches renderer projection", async () => {
      const result = await readTruth();
      const state = await rendererState(page);
      return result.status === "available" && result.snapshot.posture.sleeping === true && state.sleeping === true ? result.snapshot : false;
    });
    await page.evaluate(() => window.petAPI.setSleeping(false));
    const awake = await waitFor("E4 canonical wake matches renderer projection", async () => {
      const result = await readTruth();
      return result.status === "available" && !result.snapshot.posture.sleeping && !(await rendererState(page)).sleeping ? result.snapshot : false;
    });
    evidence.push({ case: "E4", sleeping: sleeping.posture, awake: awake.posture });

    // Genuine pointer input crosses the existing drag threshold; pointerdown
    // alone must not establish the canonical drag session.
    const petRect = await page.locator("#pet").boundingBox();
    assert.ok(petRect);
    const px = petRect.x + petRect.width / 2;
    const py = petRect.y + petRect.height / 2;
    await page.mouse.move(px, py);
    await page.mouse.down();
    const candidate = await readTruth();
    assert.equal(candidate.snapshot.posture.dragging, false);
    await page.mouse.move(px + 25, py + 16, { steps: 3 });
    const dragging = await waitFor("canonical drag admitted after actual pointer displacement", async () => {
      const result = await readTruth();
      return result.status === "available" && result.snapshot.posture.dragging ? result.snapshot : false;
    }, { timeoutMs: 10000 });
    await sleep(180);
    await page.mouse.up();
    await waitFor("canonical drag release clears observed interaction", async () => {
      const result = await readTruth();
      return result.status === "available" && !result.snapshot.posture.dragging;
    }, { timeoutMs: 10000 });
    evidence.push({ case: "drag", candidate: candidate.snapshot.posture, dragging: dragging.posture });

    const beforeReload = await observed();
    await page.reload(); // actual raw navigation, not a fake or self-healing shortcut
    const afterReload = await observed();
    assert.notDeepEqual(afterReload.generation, beforeReload.generation);
    assert.deepEqual(afterReload.geometry, await nativeBounds(app));
    log("E5/E7 raw renderer reload advances generation and establishes new actual frame PASS");

    // Inject a correlated late-A message at the REAL main admission boundary.
    // Current native sender/frame + current requestId removes those other
    // rejection causes: only the stale frozen M1 pair distinguishes A.
    const currentModeSeq = await page.evaluate(() => currentMainRenderModeSeq);
    await app.evaluate(({ BrowserWindow, ipcMain }, { oldSnapshot, modeSeq }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("/renderer/index.html"));
      const wc = win.webContents;
      const original = wc.send;
      wc.__m3OriginalSend = original;
      wc.__m3LateAttempts = 0;
      wc.send = function(channel, ...args) {
        if (channel === "pet:observed-body-request") {
          this.__m3LateAttempts += 1;
          ipcMain.emit("pet:observed-body-truth", { sender: wc, senderFrame: wc.mainFrame }, {
            requestId: args[0], bodyIdentity: oldSnapshot.generation,
            renderModeSeq: modeSeq, committedMode: "spine",
            animation: { ...oldSnapshot.animation, clip: "POISON_FROM_GENERATION_A", sampledAt: Date.now() }
          });
        }
        return original.call(this, channel, ...args);
      };
    }, { oldSnapshot: beforeReload, modeSeq: currentModeSeq });
    const afterLateA = await observed();
    const attempts = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("/renderer/index.html")).webContents;
      wc.send = wc.__m3OriginalSend;
      return wc.__m3LateAttempts;
    });
    assert.ok(attempts > 0);
    assert.deepEqual(afterLateA.generation, afterReload.generation);
    assert.notEqual(afterLateA.animation.clip, "POISON_FROM_GENERATION_A");
    assert.equal(afterLateA.animation.clip, (await rendererState(page)).clip);
    evidence.push({ case: "E5-E7", A: beforeReload.generation, B: afterReload.generation, attempts, afterLateA });
    log("E6 correlated late A cannot overwrite current B PASS");

    const previousGeneration = afterReload.generation;
    await app.close(); app = null;
    const unavailable = await readTruth();
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.snapshot, null);
    app = await launchBody();
    page = await app.firstWindow();
    await waitFor("restarted renderer applied", async () => {
      try { const state = await rendererState(page); return state.mode === "spine" && !state.bootstrap && state.applied >= 0; }
      catch { return false; }
    });
    const restarted = await observed();
    assert.notDeepEqual(restarted.generation, previousGeneration);
    assert.equal(fs.readFileSync(characterPath, "utf8"), characterBefore);
    evidence.push({ case: "restart", previousGeneration, generation: restarted.generation, unavailable, characterUnchanged: true });
    log("restart freshness, unavailable without stale cache, ZERO Character writes PASS");

    assert.deepEqual(fingerprint(), sourceHashes, "production sources must remain frozen throughout real E2E");
    if (process.env.WHITEMOON_M3_EVIDENCE_PATH) {
      fs.writeFileSync(process.env.WHITEMOON_M3_EVIDENCE_PATH, JSON.stringify({ result: "PASS", sourceHashes, evidence }, null, 2));
    }
    log("ALL M3 REAL PROCESS ASSERTIONS PASSED");
  } finally {
    if (app) await app.close().catch(() => {});
    await stopHost(host);
    const resolved = path.resolve(tempDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("whitemoon-m3-process-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error("[m3-e2e] FAIL:", error.message); process.exitCode = 1; });

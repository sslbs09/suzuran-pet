"use strict";

/* Real Electron/native acceptance for Spine walking clickability. */
const fs = require("node:fs");
const path = require("node:path");
const koffi = require("koffi");
const { _electron } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const DEP_ROOT = process.env.AGENT_DEP_ROOT || path.join(ROOT, "node_modules");
const EVIDENCE_PARENT = process.env.AGENT_EVIDENCE_ROOT || path.resolve(ROOT, "..", "chibi-left-edge-flash-residual-evidence");
fs.mkdirSync(EVIDENCE_PARENT, { recursive: true });
const OUT = process.env.AGENT_EVIDENCE_OUT || fs.mkdtempSync(path.join(EVIDENCE_PARENT, "walking-"));
const TRACE = path.join(OUT, "walking-clickability-trace.json");
const REPORT = path.join(OUT, "walking-clickability-report.json");
const PRODUCT_DATA = path.join(OUT, "product-userdata");
const CHROMIUM_DATA = path.join(OUT, "chromium-userdata");
const SKIN = "build_char_298_susuro_winter_4";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

const user32 = koffi.load("user32.dll");
const POINT = koffi.struct("AgentNativePoint", { x: "int32", y: "int32" });
const MOUSEINPUT = koffi.struct("AgentNativeMouseInput", { dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
const INPUT_UNION = koffi.union("AgentNativeInputUnion", { mi: MOUSEINPUT });
const INPUT = koffi.struct("AgentNativeInput", { type: "uint32", u: INPUT_UNION });
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ AgentNativePoint *point)");
const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
const SendInput = user32.func("uint32 __stdcall SendInput(uint32 count, _In_ AgentNativeInput *inputs, int size)");
const WindowFromPoint = user32.func("uintptr_t __stdcall WindowFromPoint(AgentNativePoint point)");
const GetAncestor = user32.func("uintptr_t __stdcall GetAncestor(uintptr_t hWnd, uint32 flags)");
const GetWindowLongPtrW = user32.func("intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int nIndex)");
const INPUT_MOUSE = 0;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const GA_ROOT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;

function cursorPoint() {
  const p = {};
  if (!GetCursorPos(p)) throw new Error("GetCursorPos failed");
  return { x: p.x, y: p.y };
}
function nativeMove(x, y) {
  if (!SetCursorPos(Math.round(x), Math.round(y))) throw new Error("SetCursorPos failed");
}
function nativeClickCurrent() {
  const down = { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN, time: 0, dwExtraInfo: 0 } } };
  const up = { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP, time: 0, dwExtraInfo: 0 } } };
  if (SendInput(2, [down, up], koffi.sizeof(INPUT)) !== 2) throw new Error("SendInput failed");
}
function nativeWindowAt(point, handles) {
  const child = WindowFromPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  const root = child ? GetAncestor(child, GA_ROOT) : 0;
  const pointStyle = child ? GetWindowLongPtrW(child, GWL_EXSTYLE) : 0;
  const rootStyle = root ? GetWindowLongPtrW(root, GWL_EXSTYLE) : 0;
  const pet = handles?.pet || 0, target = handles?.target || 0;
  const petStyle = pet ? GetWindowLongPtrW(pet, GWL_EXSTYLE) : 0, targetStyle = target ? GetWindowLongPtrW(target, GWL_EXSTYLE) : 0;
  return { screen: { x: Math.round(point.x), y: Math.round(point.y) }, child, root, pointStyle, rootStyle, petStyle, targetStyle, pointTransparent: !!(pointStyle & WS_EX_TRANSPARENT), rootTransparent: !!(rootStyle & WS_EX_TRANSPARENT), petTransparent: !!(petStyle & WS_EX_TRANSPARENT), targetTransparent: !!(targetStyle & WS_EX_TRANSPARENT), pet, target, route: root === pet ? "pet" : root === target ? "target" : "other", rootMatchesPet: root === pet, rootMatchesTarget: root === target };
}
function decodeNativeHandle(bytes) { let value = 0; for (let i = 0; i < bytes.length; i += 1) value += Number(bytes[i]) * (256 ** i); return value; }

function copySkin() {
  const source = process.env.AGENT_SKIN_DIR || process.env.EDGE_SKIN_DIR || "C:\\Users\\xsbil\\AppData\\Roaming\\苏苏洛桌宠 2.5 正式版\\assets\\spine\\user\\winter";
  const target = path.join(PRODUCT_DATA, "assets", "spine", "user", "winter");
  fs.mkdirSync(target, { recursive: true });
  const files = [SKIN + ".skel", SKIN + ".png", SKIN + ".atlas"];
  for (const name of files) {
    const from = path.join(source, name);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) throw new Error("missing exact Spine asset: " + from);
    fs.copyFileSync(from, path.join(target, name), fs.constants.COPYFILE_FICLONE);
  }
  return { source, files: files.map((name) => ({ name, bytes: fs.statSync(path.join(target, name)).size })) };
}
function prepareUserData() {
  const assets = copySkin();
  fs.writeFileSync(path.join(PRODUCT_DATA, "config.json"), JSON.stringify({
    pet: { name: "苏苏洛" }, agreed: true, firstRun: false, startHidden: false, greetingOnStart: false,
    proactiveChat: false, personify: false, renderMode: "spine", spineSkinId: "winter/" + SKIN, walking: true,
    walkSpeedMul: 1, zcodeEnabled: false, layer: "desktop", window: { x: 12, y: 320, width: 260, height: 200, scale: 1 },
    chat: { baseUrl: "http://127.0.0.1:11434/v1" }, tts: { enabled: false }, ttsCloud: { enabled: false }, ttsCosy: { enabled: false }, ttsGenie: { enabled: false },
    ttsGsv: { enabled: false }, agentApi: { enabled: false }, whitemoonRuntime: { enabled: false }
  }, null, 2));
  fs.writeFileSync(path.join(PRODUCT_DATA, ".storage-migration-v1.json"), "{}");
  return assets;
}

/* Main hook: observation plus initial lane/episode preparation only. */
const MAIN_HOOK = `
global.__agentNative = global.__agentNative || { events: [], pauseEvents: [], snapshots: [] };
global.__agentNative.snapshot = function () {
  const e = require("electron"), p = typeof win !== "undefined" && win && !win.isDestroyed() ? win : null;
  let b = null, c = null, cursor = null, ignored = null;
  try { b = p ? p.getBounds() : null; c = p ? p.getContentBounds() : null; cursor = e.screen.getCursorScreenPoint(); ignored = p && typeof p.isIgnored === "function" ? p.isIgnored() : null; } catch {}
  let v2 = null, pause = null;
  try { const controller = global.__agentNative.controller; v2 = typeof v2Locomotion !== "undefined" && v2Locomotion ? { phase: controller ? controller.phase() : null, episodeId: controller ? controller.episodeId() : null, stats: v2Locomotion.stats() } : null; } catch {}
  try { pause = typeof v2StateCore !== "undefined" && v2StateCore ? v2StateCore.pause.snapshot() : null; } catch {}
  return { ts: Date.now(), bounds: b, contentBounds: c, cursor, nativeApplied: ignored,
    lastClickable: typeof _lastClickable !== "undefined" ? _lastClickable : null,
    nativeControllerApplied: typeof nativeIgnore !== "undefined" && nativeIgnore ? nativeIgnore.applied : null,
    walk: typeof walk !== "undefined" && walk ? { active: !!walk.active, resting: !!walk.resting, seated: !!walk.seated, paused: !!walk.paused, face: walk.face, dir: walk.dir, x: b && b.x, y: b && b.y, phaseTimer: !!walk.phaseTimer } : null,
    v2, pause, bodyIdentity: typeof currentBodyIdentity === "function" ? currentBodyIdentity() : null };
};
global.__agentNative.prepareEpisode = function (side, moveMs, offset, origin) {
  const p = win, b = p.getBounds(), wa = walkGeo.workAreaOf(screen, b), range = walkGeo.clampWalkX(b.x, wa, b.width, false, charStripInset(b));
  if (!v2Locomotion || !v2CanEnterSlice().ok) return { ok: false, reason: "not-eligible", gate: v2CanEnterSlice(), snapshot: global.__agentNative.snapshot() };
  clearTimeout(walk.phaseTimer); walk.phaseTimer = null;
  const n = Number.isFinite(offset) ? offset : 180;
  const x = origin === "near-left" ? Math.min(range.maxX - 20, range.minX + n) : origin === "near-right" ? Math.max(range.minX + 20, range.maxX - n) : side === "left" ? Math.min(range.maxX - 20, range.minX + n) : Math.max(range.minX + 20, range.maxX - n);
  p.setPosition(Math.round(x), b.y); walk.dir = side === "left" ? -1 : 1; walk.face = walk.dir;
  if (p.moveTop) p.moveTop();
  const result = v2Locomotion.beginEpisode({ dir: walk.dir, moveMs: Number(moveMs) || 60000, attemptSeed: Date.now() % 100000 });
  return { ...result, initial: global.__agentNative.snapshot(), range };
};
global.__agentNative.resetEpisode = function () {
  try { if (v2Locomotion && v2Locomotion.owns()) v2Locomotion.interrupt("agent-reset"); } catch {}
  clearTimeout(walk.phaseTimer); walk.phaseTimer = null;
  return global.__agentNative.snapshot();
};
if (typeof v2StateCore !== "undefined" && v2StateCore && v2StateCore.pause && !v2StateCore.pause.__agentWrapped) {
  const pause = v2StateCore.pause;
  for (const name of ["acquire", "release", "revoke", "revokeByDomain"]) {
    const original = pause[name];
    pause[name] = function (...args) { const result = original.apply(this, args); global.__agentNative.pauseEvents.push({ ts: Date.now(), name, args, result }); return result; };
  }
  pause.__agentWrapped = true;
}
`;
function writeEntry() {
  const entry = path.join(OUT, "native-acceptance-entry.cjs");
  fs.writeFileSync(entry, `const fs=require("node:fs"),Module=require("node:module"),path=require("node:path");const root=${JSON.stringify(ROOT)};require("electron").app.setAppPath(root);global.__agentNative={events:[],pauseEvents:[],snapshots:[]};const runtime=require(path.join(root,"src/runtime-v2"));const originalController=runtime.createLocomotionController;runtime.createLocomotionController=(options)=>{const events=global.__agentNative.events,old=options.hooks&&options.hooks.noteEvent,hooks={...options.hooks,noteEvent(ev){events.push({ts:Date.now(),kind:"v2",event:ev});if(old)old(ev);}};const c=originalController({...options,hooks});global.__agentNative.controller=c;return c;};const name=path.join(root,"main.js"),m=new Module(name,module);m.filename=name;m.paths=Module._nodeModulePaths(root);require.cache[name]=m;m._compile(fs.readFileSync(name,"utf8")+${JSON.stringify(MAIN_HOOK)},name);`);
  return entry;
}

const RENDERER_INIT = `(() => { let stored; const wrap=(value)=>{ if(!value||value.__agentWrapped||typeof value.createClickabilityCore!=="function")return value; const original=value.createClickabilityCore; const wrapped=function(opts){const core=original(opts);window.__agentClickability=core;return core;}; wrapped.__agentWrapped=true; for(const key of Object.keys(value))if(key!=="createClickabilityCore")wrapped[key]=value[key]; value.createClickabilityCore=wrapped; Object.defineProperty(value,"__agentWrapped",{value:true,enumerable:false}); return value; }; Object.defineProperty(window,"PetClickability",{configurable:true,get:()=>stored,set:(value)=>{stored=wrap(value);}}); })();`;

async function mainSnapshot(app) { return app.evaluate(() => global.__agentNative.snapshot()); }
async function mainEvents(app) { return app.evaluate(() => ({ events: global.__agentNative.events.slice(), pauseEvents: global.__agentNative.pauseEvents.slice() })); }
async function mainPrepare(app, side, moveMs, offset, origin) { return app.evaluate((_, params) => global.__agentNative.prepareEpisode(params.side, params.moveMs, params.offset, params.origin), { side, moveMs, offset, origin }); }
async function mainReset(app) { return app.evaluate(() => global.__agentNative.resetEpisode()); }
function findPetWindow(app) { return app.windows().find((p) => /renderer[\\/]index\.html/.test(p.url())) || app.windows()[0]; }
async function targetEvents(app) { return app.evaluate(async ({ BrowserWindow }) => { const t = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("data:text/html")); return t ? t.webContents.executeJavaScript("window.__agentTargetEvents || []") : []; }); }
async function clearTargetEvents(app) { await app.evaluate(async ({ BrowserWindow }) => { const t = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("data:text/html")); if (t) await t.webContents.executeJavaScript("window.__agentTargetEvents=[]"); }); }
async function installMainObservation(app) { await app.evaluate(({ BrowserWindow }) => { const pet = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("renderer/index.html")); if (!pet || pet.__agentNativeWrapped) return; const original = pet.setIgnoreMouseEvents.bind(pet); pet.__agentNativeWrites = []; pet.setIgnoreMouseEvents = (ignore, options) => { pet.__agentNativeWrites.push({ ts: Date.now(), ignore: !!ignore, options: options || null }); return original(ignore, options); }; pet.__agentNativeWrapped = true; }); }
async function nativeWrites(app) { return app.evaluate(({ BrowserWindow }) => { const pet = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("renderer/index.html")); return pet && pet.__agentNativeWrites ? pet.__agentNativeWrites.slice() : []; }); }

async function installRendererObservation(page) {
  await page.evaluate(() => { window.__agentPetEvents = []; window.__agentLastWalking = null; document.addEventListener("mousedown", (event) => { const t = event.target; if (t && t.closest && (t.closest("#pet") || t.closest("#bubble") || t.closest("#input-bar") || t.closest("#info-panel"))) window.__agentPetEvents.push({ type: "mousedown", ts: Date.now(), target: t.id || t.tagName, pet: !!t.closest("#pet") }); }, true); document.addEventListener("click", (event) => { const t = event.target; if (t && t.closest && t.closest("#pet")) window.__agentPetEvents.push({ type: "click", ts: Date.now(), target: t.id || t.tagName, pet: true }); }, true); if (window.petAPI?.onWalking) window.petAPI.onWalking((state) => { window.__agentLastWalking = { ...state, ts: Date.now() }; }); });
}
async function rendererEvents(page) { return page.evaluate(() => ({ events: (window.__agentPetEvents || []).slice(), walk: window.__agentLastWalking || null })); }
async function pageRendererSnapshot(page) { return page.evaluate(() => { const r = document.querySelector("#pet")?.getBoundingClientRect(), app = typeof spineApp !== "undefined" ? spineApp : null, obj = typeof spineObj !== "undefined" ? spineObj : null, c = app?.view?.getBoundingClientRect?.() || document.querySelector("#pet canvas")?.getBoundingClientRect?.(), core = window.__agentClickability, state = obj?.state?.getCurrent(0); return { ts: Date.now(), petRect: r && { x: r.x, y: r.y, width: r.width, height: r.height }, canvasRect: c && { x: c.x, y: c.y, width: c.width, height: c.height }, animation: state?.animation?.name || null, trackTime: state?.trackTime ?? null, scaleX: obj?.scale?.x ?? null, walk: window.__agentLastWalking || null, coreLastMouse: core?.lastMouse || null, coreLastSentClickable: core?.lastSentClickable ?? null, bodyClass: document.body.className }; }); }

async function renderPoint(page, kind) {
  return page.evaluate((kind) => { if (typeof spineApp === "undefined" || !spineApp || typeof spineObj === "undefined" || !spineObj || !spineApp.renderer?.extract) return { ok: false, reason: "spine-renderer-missing", kind }; const W = Math.ceil(spineApp.screen.width), H = Math.ceil(spineApp.screen.height), rt = PIXI.RenderTexture.create({ width: W, height: H }); try { spineApp.renderer.render(spineApp.stage, { renderTexture: rt, clear: true }); const pixels = spineApp.renderer.extract.pixels(rt), canvas = spineApp.view.getBoundingClientRect(), pet = document.querySelector("#pet")?.getBoundingClientRect(), candidates = [], out = { ok: true, kind, ts: Date.now(), stage: { width: W, height: H }, canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height }, pet: pet && { x: pet.x, y: pet.y, width: pet.width, height: pet.height }, alpha: null }; for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const a = pixels[(y * W + x) * 4 + 3], vx = canvas.x + x * canvas.width / W, vy = canvas.y + y * canvas.height / H, e = document.elementFromPoint(vx, vy), ui = e?.closest?.("#bubble,#input-bar,#info-panel"); if (ui) continue; if (kind === "body" && a >= 240 && e?.closest?.("#pet")) candidates.push({ x: vx, y: vy, alpha: a, px: x, py: y, dom: { id: e.id || null, tag: e.tagName, pet: true } }); if (kind === "insidecanvastransparent" && a === 0 && x > 1 && y > 1 && x < W - 2 && y < H - 2 && e?.closest?.("#pet")) candidates.push({ x: vx, y: vy, alpha: a, px: x, py: y, dom: { id: e.id || null, tag: e.tagName, pet: true } }); } candidates.sort((a, b) => kind === "body" ? b.alpha - a.alpha || Math.abs(a.px - W * .55) - Math.abs(b.px - W * .55) : Math.abs(a.px - W * .5) - Math.abs(b.px - W * .5)); out.alpha = candidates[0] || null; return out; } finally { rt.destroy(true); } }, kind);
}
async function renderOuterEdge(page, kind = "outeredge") { return page.evaluate((kind) => { const W = innerWidth, H = innerHeight; for (let y = 4; y < H - 4; y += 4) for (let x = 4; x < W - 4; x += 4) { const e = document.elementFromPoint(x, y), ui = e?.closest?.("#pet,#bubble,#input-bar,#info-panel"); if (e && !ui) return { ok: true, kind, x, y, alpha: 0, dom: { id: e.id || null, tag: e.tagName }, viewport: { width: W, height: H } }; } return { ok: false, kind, reason: "no-ui-free-outer-point" }; }, kind); }
async function currentPoint(page, kind) { return kind === "outeredge" || kind === "behindTARGET" ? renderOuterEdge(page, kind) : renderPoint(page, kind); }
async function actualAlpha(page, client) {
  return page.evaluate(({ x, y }) => {
    if (typeof spineApp === "undefined" || !spineApp || !spineApp.renderer?.extract) return { alpha: null, inCanvas: false, reason: "spine-renderer-missing" };
    const canvas = spineApp.view.getBoundingClientRect();
    if (!(x >= canvas.x && y >= canvas.y && x < canvas.right && y < canvas.bottom)) return { alpha: 0, inCanvas: false, client: { x, y } };
    const W = Math.ceil(spineApp.screen.width), H = Math.ceil(spineApp.screen.height), rt = PIXI.RenderTexture.create({ width: W, height: H });
    try { spineApp.renderer.render(spineApp.stage, { renderTexture: rt, clear: true }); const pixels = spineApp.renderer.extract.pixels(rt); const px = Math.max(0, Math.min(W - 1, Math.floor((x - canvas.x) * W / canvas.width))), py = Math.max(0, Math.min(H - 1, Math.floor((y - canvas.y) * H / canvas.height))); return { alpha: pixels[(py * W + px) * 4 + 3], inCanvas: true, pixel: { x: px, y: py }, client: { x, y } }; } finally { rt.destroy(true); }
  }, client);
}
async function stationaryBodyAnchor(page) {
  return page.evaluate(() => {
    if (typeof spineApp === "undefined" || !spineApp || typeof spineObj === "undefined" || !spineObj || !spineApp.renderer?.extract) return { ok: false, reason: "spine-renderer-missing" };
    const W = Math.ceil(spineApp.screen.width), H = Math.ceil(spineApp.screen.height), rt = PIXI.RenderTexture.create({ width: W, height: H });
    try {
      spineApp.renderer.render(spineApp.stage, { renderTexture: rt, clear: true }); const pixels = spineApp.renderer.extract.pixels(rt), canvas = spineApp.view.getBoundingClientRect();
      let best = null;
      for (let y = 6; y < H - 6; y += 2) {
        let start = null;
        for (let x = 2; x <= W; x += 2) {
          const opaque = x < W && pixels[(y * W + x) * 4 + 3] >= 240, vx = canvas.x + Math.min(x, W - 1) * canvas.width / W, vy = canvas.y + y * canvas.height / H, e = document.elementFromPoint(vx, vy), ui = e?.closest?.("#bubble,#input-bar,#info-panel");
          const usable = opaque && e?.closest?.("#pet") && !ui;
          if (usable && start === null) start = x;
          if ((!usable || x === W) && start !== null) { const end = usable && x === W ? x - 2 : x - 2, width = end - start + 2; if (!best || width > best.width) best = { start, end, width, y }; start = null; }
        }
      }
      if (!best || best.width < 12) return { ok: false, reason: "no-wide-opaque-torso-run", best };
      const x = Math.round((best.start + best.end) / 2), vx = canvas.x + x * canvas.width / W, vy = canvas.y + best.y * canvas.height / H;
      return { ok: true, body: { x: vx, y: vy, alpha: pixels[(best.y * W + x) * 4 + 3], px: x, py: best.y, dom: "#pet" }, fixedLocal: { x: vx, y: vy }, run: best, canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height } };
    } finally { rt.destroy(true); }
  });
}
function contains(bounds, point) { return !!bounds && point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height; }

async function createTarget(app) { return app.evaluate(async ({ BrowserWindow, screen }) => { const pet = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("renderer/index.html")); if (!pet) throw new Error("pet window missing"); const b = pet.getBounds(), wa = screen.getDisplayMatching(b).workArea, target = new BrowserWindow({ show: true, frame: false, transparent: false, resizable: false, skipTaskbar: true, width: wa.width, height: b.height, title: "agent-native-target" }); target.setBounds({ x: wa.x, y: b.y, width: wa.width, height: b.height }); await target.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="margin:0;background:#18a558"><script>window.__agentTargetEvents=[];for(const t of ['mousedown','click'])addEventListener(t,e=>window.__agentTargetEvents.push({type:t,ts:Date.now(),x:e.clientX,y:e.clientY}),true)</script></body>`)); target.setAlwaysOnTop(true, "floating"); pet.setAlwaysOnTop(true, "floating"); if (pet.moveTop) pet.moveTop(); return { target: target.getBounds(), pet: pet.getContentBounds(), workArea: wa }; }); }
async function realignTarget(app) { return app.evaluate(({ BrowserWindow, screen }) => { const pet = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("renderer/index.html")), target = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("data:text/html")); if (!pet || !target) return null; const b = pet.getBounds(), wa = screen.getDisplayMatching(b).workArea; target.setBounds({ x: wa.x, y: b.y, width: wa.width, height: b.height }); target.setAlwaysOnTop(true, "floating"); pet.setAlwaysOnTop(true, "floating"); if (pet.moveTop) pet.moveTop(); return { target: target.getBounds(), pet: pet.getContentBounds(), workArea: wa }; }); }
async function targetBoundsNow(app) { return app.evaluate(({ BrowserWindow }) => { const t = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("data:text/html")); return t ? t.getBounds() : null; }); }
async function nativeWindowHandles(app) { const bytes = await app.evaluate(({ BrowserWindow }) => { const pet = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("renderer/index.html")), target = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("data:text/html")); return { pet: pet ? Array.from(pet.getNativeWindowHandle()) : [], target: target ? Array.from(target.getNativeWindowHandle()) : [] }; }); return { pet: decodeNativeHandle(bytes.pet), target: decodeNativeHandle(bytes.target), bytes }; }
async function ensurePetTop(app) { return app.evaluate(({ BrowserWindow }) => { const pet = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("renderer/index.html")); if (!pet) return false; pet.setAlwaysOnTop(true, "floating"); if (pet.moveTop) pet.moveTop(); if (pet.focus) pet.focus(); return true; }); }

async function hoverFresh(app, page, kind, initial) {
  const started = now(); let point = initial, moves = 0;
  while (now() - started < 360) { if (kind !== "outeredge" && kind !== "behindTARGET") point = await currentPoint(page, kind); if (!point?.ok || (kind !== "outeredge" && kind !== "behindTARGET" && !point.alpha)) break; const m = await mainSnapshot(app); const local = kind === "outeredge" || kind === "behindTARGET" ? { x: point.x, y: point.y } : { x: point.alpha.x, y: point.alpha.y }; nativeMove(m.contentBounds.x + local.x, m.contentBounds.y + local.y); moves += 1; await sleep(48); if (now() - started > 300) break; }
  point = kind === "outeredge" || kind === "behindTARGET" ? point : await currentPoint(page, kind); const m = await mainSnapshot(app), local = kind === "outeredge" || kind === "behindTARGET" ? { x: point.x, y: point.y } : { x: point.alpha.x, y: point.alpha.y }, screenPoint = { x: m.contentBounds.x + local.x, y: m.contentBounds.y + local.y }; nativeMove(screenPoint.x, screenPoint.y); await sleep(75); return { started, durationMs: now() - started, moves, point, local, screenPoint };
}
async function freshness(app, page, hover, kind) { const main = await mainSnapshot(app), renderer = await pageRendererSnapshot(page), cursor = cursorPoint(), expectedClient = hover.local, actualClient = main.contentBounds ? { x: cursor.x - main.contentBounds.x, y: cursor.y - main.contentBounds.y } : { x: NaN, y: NaN }, core = renderer.coreLastMouse, actual = await actualAlpha(page, actualClient), handles = await nativeWindowHandles(app), nativeRoute = nativeWindowAt(cursor, handles), routeExpected = kind === "body" ? "pet" : "target"; const cursorMatch = Math.abs(cursor.x - hover.screenPoint.x) <= 2 && Math.abs(cursor.y - hover.screenPoint.y) <= 2, electronMatch = main.cursor && Math.abs(main.cursor.x - cursor.x) <= 2 && Math.abs(main.cursor.y - cursor.y) <= 2, inside = contains(main.contentBounds, cursor), coreMatch = core && Math.abs(core.x - actualClient.x) <= 6 && Math.abs(core.y - actualClient.y) <= 6, nativeExpected = kind === "body" ? false : true, nativeMatch = main.nativeControllerApplied === nativeExpected && nativeRoute.petTransparent === nativeExpected, alphaMatch = kind === "body" ? actual.alpha >= 32 : actual.alpha === 0, hwndMatch = nativeRoute.route === routeExpected; return { ts: now(), cursor, electronCursor: main.cursor, contentBounds: main.contentBounds, renderer, main, expectedClient, actualClient, actualAlpha: actual, handles, nativeRoute, routeExpected, cursorMatch, electronMatch, insideContent: inside, coreMatch, nativeMatch, alphaMatch, hwndMatch, ok: cursorMatch && electronMatch && inside && coreMatch && nativeMatch && alphaMatch && hwndMatch }; }

async function runClickCase({ app, page, id, kind, expected, prepare, afterReady, targetBounds }) {
  const result = { id, kind, expected, startedAt: new Date().toISOString(), attempts: [], status: "INCONCLUSIVE" };
  for (let attempt = 1; attempt <= 2; attempt += 1) { const a = { attempt, t0: now() }; try { const prepareResult = await prepare(); a.prepareResult = prepareResult || null; a.dismissedInfoBubble = await dismissInfoBubble(page); await sleep(120); if (afterReady) await afterReady(); a.petBroughtTop = await ensurePetTop(app); const initialPoint = await currentPoint(page, kind); const initialMain = await mainSnapshot(app); const initialRenderer = await pageRendererSnapshot(page); const liveTargetBounds = await targetBoundsNow(app); const outsideKind = kind === "outeredge" || kind === "behindTARGET"; if (!initialPoint?.ok || (!outsideKind && !initialPoint.alpha)) throw new Error("point-unavailable:" + JSON.stringify(initialPoint)); const before = { main: await mainEvents(app), pet: await rendererEvents(page), target: await targetEvents(app), writes: await nativeWrites(app) }; const expectedDir = id.includes("reversal-left-after") ? 1 : a.prepareResult?.episodePrep?.initial?.walk?.dir ?? a.prepareResult?.initial?.walk?.dir ?? null, directionPhase = { expectedDir, actualDir: initialMain.walk?.dir ?? null, phase: initialMain.v2?.phase ?? null, ok: id === "idlebody" || (expectedDir !== null && initialMain.walk?.dir === expectedDir && initialMain.v2?.phase === "move") }; a.directionPhase = directionPhase; if (!directionPhase.ok) { a.inconclusive = "direction-phase-mismatch"; result.attempts.push(a); continue; } const local0 = outsideKind ? { x: initialPoint.x, y: initialPoint.y } : { x: initialPoint.alpha.x, y: initialPoint.alpha.y }; const screen0 = { x: initialMain.contentBounds.x + local0.x, y: initialMain.contentBounds.y + local0.y }; a.initial = { point: initialPoint, main: initialMain, renderer: initialRenderer, targetBounds: liveTargetBounds, targetContainsPoint: contains(liveTargetBounds, screen0), screenPoint: screen0 }; a.before = before; const hover = await hoverFresh(app, page, kind, initialPoint); a.hover = hover; a.freshness = await freshness(app, page, hover, kind); if (!a.freshness.ok) { a.inconclusive = "freshness-mismatch"; result.attempts.push(a); continue; } a.directionPhase.final = { actualDir: a.freshness.main.walk?.dir ?? null, phase: a.freshness.main.v2?.phase ?? null, ok: id === "idlebody" || (a.freshness.main.walk?.dir === expectedDir && a.freshness.main.v2?.phase === "move") }; if (!a.directionPhase.final.ok) { a.inconclusive = "final-direction-phase-mismatch"; result.attempts.push(a); continue; } if (id.includes("reversal-left-before") && (a.prepareResult?.episodePrep?.initial?.walk?.face !== -1 || a.freshness.main?.walk?.face !== -1)) { a.inconclusive = "before-reversal-face-already-flipped"; result.attempts.push(a); continue; } nativeClickCurrent(); a.nativeClick = { ts: now(), cursorAfterSendInput: cursorPoint() }; await sleep(850); const after = { main: await mainEvents(app), pet: await rendererEvents(page), target: await targetEvents(app), writes: await nativeWrites(app), finalMain: await mainSnapshot(app), finalRenderer: await pageRendererSnapshot(page) }; const petEvents = after.pet.events.slice(before.pet.events.length), targetEventsDelta = after.target.slice(before.target.length), pauseDelta = after.main.pauseEvents.slice(before.main.pauseEvents.length), v2Delta = after.main.events.slice(before.main.events.length), petMousedown = petEvents.filter((e) => e.type === "mousedown"), targetMousedown = targetEventsDelta.filter((e) => e.type === "mousedown"), targetClicks = targetEventsDelta.filter((e) => e.type === "click"), interactionPause = pauseDelta.some((e) => e.name === "acquire" && e.args?.[0] === "interaction"), episodeClose = v2Delta.find((e) => e.event?.ev === "episode-close"); a.after = { ...after, petEvents, targetEvents: targetEventsDelta, pauseDelta, v2Delta, petMousedown, targetMousedown, targetClicks, interactionPause, episodeClose }; const walkingBody = expected === "body" && id !== "idlebody"; const bodyPass = petMousedown.length === 1 && targetMousedown.length === 0 && interactionPause && (!walkingBody || !!episodeClose), transparentPass = targetMousedown.length === 1 && targetClicks.length === 1 && petMousedown.length === 0; a.passEvidence = { bodyPass, transparentPass, targetClick: targetClicks.length === 1, episodeClose: !!episodeClose }; result.status = expected === "body" ? (bodyPass ? "PASS" : "FAIL") : (transparentPass ? "PASS" : "FAIL"); result.attempts.push(a); break; } catch (error) { a.error = String(error && error.stack || error); result.attempts.push(a); await sleep(120); } }
  if (result.status === "INCONCLUSIVE") result.reason = "external-or-stale-cursor-before-native-click";
  result.endedAt = new Date().toISOString(); console.log(`CASE ${result.status} ${id} attempts=${result.attempts.length}`); return result;
}
async function waitFor(page, predicate, timeoutMs, label) { await page.waitForFunction(predicate, null, { timeout: timeoutMs }).catch((e) => { throw new Error(label + ": " + e.message); }); }
async function waitForMain(app, predicate, timeoutMs, label) { const deadline = now() + timeoutMs; while (now() < deadline) { if (await predicate(await mainSnapshot(app))) return; await sleep(80); } throw new Error(label); }
async function waitForNaturalLeftFlip(app) { const samples = [], deadline = now() + 5000; while (now() < deadline) { const s = await mainSnapshot(app); samples.push(s); if (s.v2?.phase === "move" && s.walk?.dir === 1 && s.walk?.face === 1) return { flippedAt: s.ts, samples }; await sleep(60); } throw new Error("natural-left-reversal-face-flip-not-observed:" + JSON.stringify(samples.slice(-3))); }
async function dismissInfoBubble(page) { return page.evaluate(() => { const button = document.getElementById("btn-close"); if (button && typeof button.click === "function") { button.click(); return true; } return false; }); }
async function resetWalking(app, page) { await mainReset(app).catch(() => {}); await waitForMain(app, (s) => !s.pause?.effectivePaused && !s.walk?.paused && !s.walk?.dragPaused && !s.walk?.chatPaused && !s.walk?.zoomPaused, 5000, "interaction pause/occupancy did not clear before fresh episode"); await page.evaluate(async () => { try { await window.petAPI.setWalking(false); } catch {} }); await sleep(220); await page.evaluate(async () => { try { await window.petAPI.setWalking(true); } catch {} }); await waitFor(page, () => typeof spineObj !== "undefined" && !!spineObj && typeof spineApp !== "undefined" && !!spineApp && !(typeof spineBootstrapPending !== "undefined" && spineBootstrapPending), 30000, "Spine not ready after reset"); await sleep(240); }

async function stationaryTrace(app, page) {
  const trace = { id: "stationary-cursor", startedAt: new Date().toISOString(), fixedScreen: null, phases: [], rows: [], status: "UNKNOWN" };
  const sample = async (phase, fixed) => { const m = await mainSnapshot(app), r = await pageRendererSnapshot(page), osCursor = cursorPoint(), local = m.contentBounds ? { x: osCursor.x - m.contentBounds.x, y: osCursor.y - m.contentBounds.y } : null; const alpha = local ? await actualAlpha(page, local) : { alpha: null, inCanvas: false, reason: "content-bounds-missing" }; const handles = trace.nativeHandles || await nativeWindowHandles(app); trace.nativeHandles = handles; const nativeRoute = nativeWindowAt(osCursor, handles); const row = { ts: now(), phase, fixedScreen: fixed, cursor: osCursor, main: m, renderer: r, actualAlpha: alpha, nativeRoute, bodyPoint: await renderPoint(page, "body") }; trace.rows.push(row); return row; };
  try {
    await resetWalking(app, page);
    let prep = await mainPrepare(app, "left", 60000, 480);
    if (!prep.ok) { trace.status = "INCONCLUSIVE"; trace.reason = "episode-prep-left:" + JSON.stringify(prep); return trace; }
    await waitForMain(app, (s) => s.v2?.phase === "move", 5000, "stationary exit episode did not enter move");
    await realignTarget(app); await ensurePetTop(app);
    const firstFixed = await stationaryBodyAnchor(page), firstMain = await mainSnapshot(app);
    if (!firstFixed?.ok || !firstMain.contentBounds) throw new Error("stationary-fixed-point-unavailable:" + JSON.stringify(firstFixed));
    trace.fixedCandidate = firstFixed; trace.nativeHandles = await nativeWindowHandles(app);
    const fixed = { x: Math.round(firstMain.contentBounds.x + firstFixed.fixedLocal.x), y: Math.round(firstMain.contentBounds.y + firstFixed.fixedLocal.y) }; trace.fixedScreen = fixed;
    nativeMove(fixed.x, fixed.y); await sleep(260); const hoverRow = await sample("left-hover", fixed); trace.hoverEstablished = { nativeControllerApplied: hoverRow.main.nativeControllerApplied, petTransparent: hoverRow.nativeRoute.petTransparent, route: hoverRow.nativeRoute.route, coreLastMouse: hoverRow.renderer.coreLastMouse, alpha: hoverRow.actualAlpha.alpha, ok: hoverRow.main.nativeControllerApplied === false && hoverRow.nativeRoute.petTransparent === false && hoverRow.nativeRoute.route === "pet" && hoverRow.actualAlpha.alpha >= 240 && hoverRow.renderer.coreLastMouse && Math.abs(hoverRow.renderer.coreLastMouse.x - (fixed.x - hoverRow.main.contentBounds.x)) <= 6 };
    const exitDeadline = now() + 3000; while (now() < exitDeadline) { await sample("left-exit", fixed); await sleep(120); }
    await mainReset(app); await resetWalking(app, page);
    prep = await mainPrepare(app, "right", 60000, 380, "near-left");
    if (!prep.ok) { trace.status = "INCONCLUSIVE"; trace.reason = "episode-prep-right:" + JSON.stringify(prep); return trace; }
    await waitForMain(app, (s) => s.v2?.phase === "move" && s.walk?.dir === 1, 5000, "stationary enter episode did not enter move");
    nativeMove(fixed.x, fixed.y);
    const enterDeadline = now() + 10000; while (now() < enterDeadline) { await sample("right-enter", fixed); await sleep(120); }
    trace.transitions = trace.rows.slice(1).map((row, i) => ({ fromAlpha: trace.rows[i].actualAlpha.alpha, toAlpha: row.actualAlpha.alpha, fromNative: trace.rows[i].main.nativeControllerApplied, toNative: row.main.nativeControllerApplied, fromPetTransparent: trace.rows[i].nativeRoute.petTransparent, toPetTransparent: row.nativeRoute.petTransparent, fromRoute: trace.rows[i].nativeRoute.route, toRoute: row.nativeRoute.route, phase: row.phase, ts: row.ts })).filter((x) => x.fromAlpha !== x.toAlpha || x.fromNative !== x.toNative || x.fromPetTransparent !== x.toPetTransparent || x.fromRoute !== x.toRoute);
    const rows = trace.rows, leftRows = rows.filter((row) => row.phase === "left-exit"), rightRows = rows.filter((row) => row.phase === "right-enter"), alphaExit = leftRows.some((row) => Number(row.actualAlpha.alpha) === 0 && leftRows.some((prev) => prev.ts < row.ts && Number(prev.actualAlpha.alpha) >= 240)), alphaEnter = rightRows.some((row) => Number(row.actualAlpha.alpha) >= 32 && rightRows.some((prev) => prev.ts < row.ts && Number(prev.actualAlpha.alpha) === 0)), opaqueEnter = rightRows.some((row, i) => Number(row.actualAlpha.alpha) >= 240 && rightRows.slice(i).some((later) => later.ts - row.ts >= 200 && Number(later.actualAlpha.alpha) >= 240)), nativeChanged = trace.transitions.some((x) => x.fromPetTransparent !== x.toPetTransparent), routeChanged = trace.transitions.some((x) => x.fromRoute !== x.toRoute); trace.crossings = { alphaExit, alphaEnter, opaqueEnter, nativeChanged, routeChanged, opaqueHover: trace.hoverEstablished, status: alphaExit && alphaEnter && opaqueEnter && nativeChanged && routeChanged && trace.hoverEstablished.ok ? "PASS" : "INCONCLUSIVE" }; trace.status = trace.crossings.status; if (trace.status !== "PASS") trace.reason = "stationary-crossing-or-native-response-missing";
  } catch (error) { trace.status = "INCONCLUSIVE"; trace.reason = String(error && error.stack || error); }
  console.log(`CASE ${trace.status} stationary-cursor rows=${trace.rows.length}`); return trace;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true }); console.log("EVIDENCE=" + OUT); const assets = prepareUserData(), entry = writeEntry(), originalCursor = cursorPoint(); let app = null, page = null, targetBounds = null;
  const report = { generatedAt: new Date().toISOString(), repo: ROOT, branchBaseline: "fix/chibi-left-edge-flash-residual-v0.1@8c5e25f", evidence: OUT, assets, matrix: [], stationary: null, fatal: null };
  try {
    const env = { ...process.env, SUZURAN_TEST_USERDIR: PRODUCT_DATA, SUSSURRO_EDGE_DIAG: "0", SUSSURRO_RUNTIME_V2_LOCOMOTION: "1" }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(DEP_ROOT, "electron", "dist", "electron.exe"), args: ["--user-data-dir=" + CHROMIUM_DATA, entry], cwd: ROOT, env, timeout: 60000 }); page = await app.firstWindow(); page.on("pageerror", (e) => console.error("PAGEERROR " + e.message)); page.on("console", (m) => { if (m.type() === "error") console.error("PAGECONSOLE " + m.text()); }); console.log("WINDOWS_BEFORE=" + JSON.stringify(app.windows().map((p) => ({ url: p.url(), title: p.url() })))); await page.addInitScript({ content: RENDERER_INIT }); await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); console.log("PET_URL=" + page.url()); try { await waitFor(page, () => !!window.petAPI && typeof spineObj !== "undefined" && !!spineObj && typeof spineApp !== "undefined" && !!spineApp && !(typeof spineBootstrapPending !== "undefined" && spineBootstrapPending), 60000, "production Spine/petAPI not ready"); } catch (error) { console.error("DEBUG_PAGE=" + JSON.stringify(await page.evaluate(() => ({ petAPI: typeof window.petAPI, spineObj: typeof spineObj, spineApp: typeof spineApp, bootstrap: typeof spineBootstrapPending, body: document.body?.innerText?.slice(0, 300), scripts: Array.from(document.scripts).map((s) => s.src) })))); throw error; } await sleep(1200); await installMainObservation(app); await installRendererObservation(page); targetBounds = (await createTarget(app)).target; console.log("TARGET=" + JSON.stringify(targetBounds));
    const click = async (id, kind, expected, side, offset, origin) => runClickCase({ app, page, id, kind, expected, targetBounds, prepare: async () => { let episodePrep = null; if (id === "idlebody") { await mainReset(app); await page.evaluate(async () => { try { await window.petAPI.setWalking(false); } catch {} }); await waitForMain(app, (s) => !s.pause?.effectivePaused && !s.walk?.active && !s.walk?.paused && !s.walk?.dragPaused && !s.walk?.chatPaused && !s.walk?.zoomPaused, 5000, "idle walking state did not settle"); await waitFor(page, () => typeof spineObj !== "undefined" && !!spineObj && typeof spineApp !== "undefined" && !!spineApp && !(typeof spineBootstrapPending !== "undefined" && spineBootstrapPending), 30000, "Spine not ready for idle"); await waitFor(page, () => { const cur = spineObj?.state?.getCurrent?.(0), expectedIdle = typeof spineAnimForMood === "function" ? spineAnimForMood("idle") : null; return !!cur?.animation && (!expectedIdle || cur.animation.name === expectedIdle); }, 10000, "idle animation did not settle"); await sleep(300); } else { await resetWalking(app, page); if (side) { episodePrep = await mainPrepare(app, side, 60000, offset || 420, origin); if (!episodePrep.ok) throw new Error("episode-prep:" + JSON.stringify(episodePrep)); await waitForMain(app, (s) => s.v2?.phase === "move" && s.walk?.dir === (side === "left" ? -1 : 1), 5000, "episode did not enter requested move"); } else await sleep(250); } const aligned = await realignTarget(app); await clearTargetEvents(app); return { aligned, idle: id === "idlebody", episodePrep }; } });
    report.matrix.push(await click("idlebody", "body", "body", null));
    for (const side of ["left", "right"]) { report.matrix.push(await click(`walking-${side}-body`, "body", "body", side)); report.matrix.push(await click(`walking-${side}-insidecanvastransparent`, "insidecanvastransparent", "transparent", side)); report.matrix.push(await click(`walking-${side}-outeredge`, "outeredge", "transparent", side)); report.matrix.push(await click(`walking-${side}-behindTARGET`, "behindTARGET", "transparent", side)); }
    for (const pointKind of ["body", "insidecanvastransparent"]) {
      const expected = pointKind === "body" ? "body" : "transparent";
      report.matrix.push(await click(`reversal-left-before-${pointKind}`, pointKind, expected, "left", 40));
      report.matrix.push(await runClickCase({ app, page, id: `reversal-left-after-${pointKind}`, kind: pointKind, expected, targetBounds, prepare: async () => { await resetWalking(app, page); const p = await mainPrepare(app, "left", 60000, 80, "near-left"); if (!p.ok) throw new Error("episode-prep:" + JSON.stringify(p)); if (p.initial?.walk?.dir !== -1 || p.initial?.walk?.face !== -1) throw new Error("reversal-after-initial-direction-invalid:" + JSON.stringify(p.initial?.walk)); await waitForMain(app, (s) => s.v2?.phase === "move" && s.walk?.dir === -1 && s.walk?.face === -1, 5000, "reversal after not moving-left"); const flip = await waitForNaturalLeftFlip(app); await realignTarget(app); await clearTargetEvents(app); return { reversal: "natural", initial: p.initial, flip }; } }));
    }
    report.stationary = await stationaryTrace(app, page);
  } catch (error) { report.fatal = String(error && error.stack || error); console.error("FATAL " + report.fatal); }
  finally { try { nativeMove(originalCursor.x, originalCursor.y); } catch {} try { if (app) await app.close(); } catch (error) { report.closeError = String(error && error.stack || error); } fs.writeFileSync(TRACE, JSON.stringify(report, null, 2)); fs.writeFileSync(REPORT, JSON.stringify({ ...report, summary: report.matrix.map((x) => ({ id: x.id, status: x.status, reason: x.reason || null })) }, null, 2)); }
  const counts = report.matrix.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}); const expectedCases = 13, badCases = report.matrix.filter((r) => r.status === "FAIL" || r.status === "INCONCLUSIVE"); const incomplete = report.matrix.length !== expectedCases || badCases.length > 0 || !report.stationary || report.stationary.status !== "PASS"; console.log("REPORT=" + JSON.stringify({ evidence: OUT, counts, stationary: report.stationary?.status || null, fatal: !!report.fatal, incomplete })); if (report.fatal || incomplete) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

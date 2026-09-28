/**
 * SuzuranPet 渲染层逻辑（GIF 表情版）
 * - 心情 → GIF 映射（user/ 目录，可换肤）
 * - 拖拽（手动指针拖拽 + IPC 移动窗口，区分点击）
 * - 气泡打字机、思考动画、输入栏、停止
 * - 闲置 5 分钟自动睡觉，互动唤醒
 */
"use strict";

const petEl = document.getElementById("pet");

/* ---------- 渲染层未捕获错误上报（临时诊断：渲染层启动即挂时能在 tts.log 看到原因） ---------- */
window.addEventListener("error", (e) => {
  try { window.petAPI && window.petAPI.playback("[render-error] " + (e.message || "?") + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno); } catch { /* 忽略 */ }
});
window.addEventListener("unhandledrejection", (e) => {
  try { const r = e.reason; window.petAPI && window.petAPI.playback("[render-reject] " + ((r && r.message) || r || "?")); } catch { /* 忽略 */ }
});
const spriteEl = document.getElementById("sprite");
const bubbleEl = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const thinkingDots = document.getElementById("thinking-dots");
const inputBar = document.getElementById("input-bar");
const inputEl = document.getElementById("input");
const btnSend = document.getElementById("btn-send");
const btnStop = document.getElementById("btn-stop");
const modeChip = document.getElementById("mode-chip");

/* ---------- 情绪 → GIF 映射（动态：来自 config moods，可自定义增删） ---------- */
let MOODS = []; // [{name,label,emotion,custom,exists}]

const SPRITE_BASE = "pet-user://sprites/user/";

/* ---------- Spine 渲染系统（可切换 GIF/Spine；支持桌面行走） ---------- */
let spineApp = null;         // PixiJS Application
let spineObj = null;         // PIXI Spine 对象
let spineTrackRevision = 0;
let pokeFeedbackGen = 0;
let spineRuntimeOwner = null;
let spinePendingOwner = null;
const seatLifecycle = { ticker: null, owner: null, lastSafe: null };
const seatEpisode = { owner: null, active: false, entryScale: 0, previousScale: 0, finalFitDone: false, pendingFit: false };
let skinSwitching = false;   // 换肤中：旧 context 销毁误触发的 lost 不触发整页 reload（v2.5.24）
const RENDER_MODES = ["gif", "spine", "rig", "live2d"];
let requestedRenderMode = "gif";
let activeRenderMode = null;
let activeRenderGeneration = 0;
let renderSwitchGeneration = 0;
let gifGeometryRevision = 0;
let petDocEpoch = 0; // F6：本文档启动时刻的 main renderModeSeq（文档身份）。与 renderGeneration/geometryRevision 是不同概念：跨 reload 单调增、文档生命周期内恒定
let renderSwitchStatus = "idle"; // idle | switching | ready | failed | superseded
let renderRuntimeReady = false;
let renderRuntimeResource = "";
let currentMainRenderModeSeq = null; // main-side identity；renderer generation 不跨 IPC
let currentRenderSwitchPromise = Promise.resolve();
const SPINE_BASE = "spine/sussurro/";
let spinePaths = {           // 默认内置模型；spine/user/ 有用户模型时由主进程探测替换（懒人换模型）
  atlas: SPINE_BASE + "build_char_298_susuro.atlas",
  skel: SPINE_BASE + "build_char_298_susuro.skel"
};
let spineBaseScaleX = 1;     // 初始缩放；朝向翻转时取反
// 桌面行走状态（主进程广播驱动；明日方舟基建语义：Move=走动 Relax=放松 Sit=坐窗顶 Sleep=睡觉 Interact=点击互动）
let walkState = { active: false, resting: true, perched: false, seated: false, face: 1 };
let lastInputAt = 0; // 输入栏最近一次打字时间：自主坐/睡收栏时判断用户是否正在用

/* ---------- PSD 2.5D 角色渲染（v2.2，完全独立于 Spine）
 * rigSkinId 非空时 2.5D 独占显示：Spine 不初始化、不参与，互不干扰。 ---------- */
let rigSkinId = "";
let rigRuntime = null;
let rigCanvas = null;
let rigScale = 1.0; // 2.5D 角色显示大小（设置页滑杆）
let rigMouseFollow = true; // 2.5D 头部/眼睛跟随鼠标（v2.2.1 实验性，设置页开关）
let mouseTrackGlobal = false; // 全局鼠标跟踪（v2.2.1 实验性，需设置页显式许可，默认关）
const RIG_WIN_W = 300, RIG_WIN_H = 460; // rig 模式基础窗口尺寸（rigScale=1）
function applyRigScale(v) {
  rigScale = Math.max(0.3, Math.min(1.5, Number(v) || 1));
  // rig 模式：窗口高度随 rigScale 联动（角色=窗口高 100%，放大不超出画布）
  if (activeRenderMode === "rig" && rigRuntime) {
    window.petAPI.setSize(RIG_WIN_W, Math.round(RIG_WIN_H * rigScale));
  }
}
function rigGenericOpts() {
  const GP = window.GenericParts;
  const base = GP ? { eyeL: GP.get("eyeL"), eyeR: GP.get("eyeR"), mouth: GP.get("mouth") } : {};
  return (base.eyeL || base.mouth) ? { generic: base } : {};
}
/* ---------- Live2D 渲染模式（v2.5.1）：live2d-runtime.js 自治，这里只做显示归属与生命周期 ---------- */
let live2dActive = false;
let live2dSkinId = "";

function isCurrentRenderRequest(context, mode = context && context.mode) {
  return !!context && context.generation === renderSwitchGeneration && requestedRenderMode === mode;
}

function cleanupRigOwner(owner) {
  if (!owner) return;
  try { if (owner.runtime) owner.runtime.destroy(); } catch { /* 忽略 */ }
  if (rigRuntime === owner.runtime) rigRuntime = null;
  if (rigRuntime === null && rigCanvas) {
    rigCanvas.classList.add("hidden");
    rigCanvas.style.visibility = "hidden";
    rigCanvas.style.pointerEvents = "none";
  }
}

/** 加载 2.5D 皮肤；跨模式显示与提交由 switchRenderMode 负责。 */
async function initRig(context) {
  const owner = { context, runtime: null, canvas: null };
  const hasRequestedResource = !!context && Object.prototype.hasOwnProperty.call(context, "resourceId");
  const id = hasRequestedResource ? context.resourceId : rigSkinId;
  if (!id) return { status: "failed", error: new Error("未选择 Rig 皮肤") };
  try {
    window.petAPI.playback && window.petAPI.playback("[rig] 加载 2.5D 皮肤: " + id);
    const res = await fetch("pet-user://rig/user/" + encodeURIComponent(id));
    if (!res.ok) throw new Error("加载 PSD 失败 HTTP " + res.status);
    const buf = await res.arrayBuffer();
    if (!isCurrentRenderRequest(context, "rig")) return { status: "superseded" };
    if (!window.Rigger || !window.RigRuntime) throw new Error("2.5D 运行时未加载");
    const psd = window.agPsd.readPsd(new Uint8Array(buf), { useImageData: true, skipThumbnail: true });
    const rig = window.Rigger.buildRig(psd, rigGenericOpts());
    if (!isCurrentRenderRequest(context, "rig")) return { status: "superseded" };
    owner.canvas = document.getElementById("rig-canvas");
    if (!owner.canvas) throw new Error("Rig canvas 未加载");
    rigCanvas = owner.canvas;
    owner.runtime = window.RigRuntime.init(owner.canvas);
    owner.runtime.applyRig(rig);
    if (!isCurrentRenderRequest(context, "rig")) {
      cleanupRigOwner(owner);
      return { status: "superseded" };
    }
    const follow = window.RigRuntime.detectFollow(rig);
    owner.runtime.setAuto("mouse", rigMouseFollow && follow.level !== "none");
    owner.runtime.setMouseMode(mouseTrackGlobal);
    window.petAPI.playback && window.petAPI.playback("[rig] 跟随能力: " + (follow.level === "full" ? "头+眼" : follow.level === "head-only" ? "仅头部" : "无") + "（" + (follow.reason || "") + "）");
    rigRuntime = owner.runtime;
    rigSkinId = id;
    window.petAPI.playback && window.petAPI.playback("[rig] 2.5D 皮肤就绪: " + rig.layers.length + " 部件");
    return { status: "ready", resource: id };
  } catch (e) {
    window.petAPI.playback && window.petAPI.playback("[rig] 2.5D 皮肤加载失败: " + (e && e.message || e));
    cleanupRigOwner(owner);
    return { status: isCurrentRenderRequest(context, "rig") ? "failed" : "superseded", error: e };
  }
}

function destroyRig() {
  if (rigRuntime) { try { rigRuntime.destroy(); } catch { /* 忽略 */ } rigRuntime = null; }
  if (rigCanvas) {
    rigCanvas.classList.add("hidden");
    rigCanvas.style.visibility = "hidden";
    rigCanvas.style.pointerEvents = "none";
  }
  document.body.classList.remove("rig-mode");
}

async function initLive2d(context) {
  const requestedId = context && context.resourceId;
  const canvas = document.getElementById("live2d-canvas");
  if (!canvas || !window.Live2DRuntime) return { status: "failed", error: new Error("Live2D runtime 未加载") };
  if (!window.Live2DCubismCore) {
    window.petAPI.playback && window.petAPI.playback("[live2d] Live2D Core 缺失，初始化失败");
    return { status: "failed", error: new Error("Live2D Core 缺失") };
  }
  let skins = [];
  try { skins = await window.petAPI.live2dList(); } catch { /* 忽略 */ }
  if (!isCurrentRenderRequest(context, "live2d")) return { status: "superseded" };
  if (!skins || !skins.length) {
    window.petAPI.playback && window.petAPI.playback("[live2d] 未找到模型（内置缺失且 userData/assets/live2d/ 为空）");
    return { status: "failed", error: new Error("未找到 Live2D 模型") };
  }
  const pick = (requestedId && skins.find((s) => s.id === requestedId)) || skins.find((s) => s.id.startsWith("builtin/")) || skins[0];
  try {
    bindCtxLost(canvas, "live2d", context.token);
    const ok = await window.Live2DRuntime.init(canvas, pick.url, context.token);
    if (!ok || !isCurrentRenderRequest(context, "live2d")) {
      destroyLive2d(context.token);
      return { status: "superseded" };
    }
    applyLive2dScale(live2dScaleFactor);
    live2dActive = true;
    window.petAPI.playback && window.petAPI.playback("[live2d] 模型就绪: " + pick.name);
    return { status: "ready", resource: requestedId || "" };
  } catch (e) {
    window.petAPI.playback && window.petAPI.playback("[live2d] 加载失败: " + (e && e.message || e));
    destroyLive2d(context.token);
    return { status: isCurrentRenderRequest(context, "live2d") ? "failed" : "superseded", error: e };
  }
}

function destroyLive2d(ownerToken) {
  let destroyed = true;
  try { if (window.Live2DRuntime) destroyed = window.Live2DRuntime.destroy(ownerToken) !== false; } catch { /* 忽略 */ }
  const canvas = document.getElementById("live2d-canvas");
  if (ownerToken && !destroyed) return;
  live2dActive = false;
  document.body.classList.remove("live2d-mode");
  unbindCtxLost(canvas, ownerToken);
  if (canvas) {
    canvas.classList.add("hidden");
    canvas.style.visibility = "hidden";
    canvas.style.pointerEvents = "none";
  }
}

function applyTheme(theme) { // 规则唯一来源 renderer/theme.js（v2.5.26 收敛）
  window.petTheme.apply(theme);
}

function bindCtxLost(canvas, tag, ownerToken = null) { // 低配核显 WebGL 上下文丢失 → 上报 + 自愈重载
  if (!canvas) return;
  const previous = ctxLostHandlers.get(canvas);
  if (previous) canvas.removeEventListener("webglcontextlost", previous.handler);
  const handler = (e) => {
    e.preventDefault();
    window.petAPI.playback && window.petAPI.playback("[gpu] WebGL 上下文丢失: " + tag);
    // v2.5.24：换肤销毁旧 context 阶段 GPU 释放会误触发 lost（低配核显实测）——
    // 此时新画布随后已重建，整页 reload 反而打断交互（"拿不起来"），换肤中吞掉
    if (skinSwitching) return;
    window.petAPI.reloadRenderer && window.petAPI.reloadRenderer();
  };
  ctxLostHandlers.set(canvas, { handler, ownerToken });
  canvas.addEventListener("webglcontextlost", handler);
}
function unbindCtxLost(canvas, ownerToken = null) {
  if (!canvas) return;
  const record = ctxLostHandlers.get(canvas);
  if (!record || (ownerToken && record.ownerToken !== ownerToken)) return;
  canvas.removeEventListener("webglcontextlost", record.handler);
  ctxLostHandlers.delete(canvas);
}

const ctxLostHandlers = new WeakMap();
let live2dScaleFactor = 1.0;
function applyLive2dScale(v) {
  live2dScaleFactor = Number(v) > 0 ? Number(v) : 1.0;
  try { window.Live2DRuntime && window.Live2DRuntime.setScale(live2dScaleFactor); } catch { /* 忽略 */ }
  if (activeRenderMode === "live2d" && live2dActive) { // 等比窗口：滑条放大时窗口同步变大，模型不裁剪
    window.petAPI.setSize(Math.round(300 * live2dScaleFactor), Math.round(460 * live2dScaleFactor));
  }
}

function setLive2dMood(mood) {
  if (activeRenderMode !== "live2d" || !live2dActive || !window.Live2DRuntime) return;
  try { window.Live2DRuntime.setMood(mood); } catch { /* 忽略 */ }
}
function rigPresetForMood(mood) {
  if (!rigRuntime) return;
  const map = { idle: "neutral", happy: "smile", surprised: "surprise", wave: "wink" };
  if (map[mood]) rigRuntime.preset(map[mood]);
  if (mood === "sleep") { rigRuntime.setParam("eyeOpenL", 0.25); rigRuntime.setParam("eyeOpenR", 0.25); }
}
function spineHas(name) { return !!spineObj && !!spineObj.spineData.animations.find((a) => a.name === name); }

/* ---------- 动画切换（Spine） ---------- */
function setSpineAnim(name, loop, reason = "") {
  if (!spineObj) return;
  const beforeName = spineObj.state.getCurrent(0)?.animation?.name || "";
  const isSit = name === sitAnimName();
  if (isSit) releaseSeatExitY("seat-entry"); // 所有动画入口统一交还 containment；不补写旧 target。
  if (isSit && beforeName !== name) {
    const visibleScale = Math.abs(Number(spineObj.scale?.y));
    seatEpisode.owner = spineObj;
    seatEpisode.active = true;
    seatEpisode.entryScale = Number.isFinite(visibleScale) && visibleScale > 0 ? visibleScale : Math.abs(spineBaseScaleX);
    seatEpisode.previousScale = seatEpisode.entryScale;
    seatEpisode.finalFitDone = false;
    seatEpisode.pendingFit = false;
  } else if (!isSit && beforeName === sitAnimName()) {
    seatEpisode.active = false;
    if ((window.SeatFit ? window.SeatFit.seatReleaseShouldRefit(seatEpisode) : seatEpisode.pendingFit)) {
      seatEpisode.pendingFit = false;
      scheduleFitSpine({}); // A-v2：hold 期间的 pass 只标了 pendingFit，释放时兑现欠账——重新锚定完整窗口补回采样
    } else {
      seatEpisode.pendingFit = false;
    }
  }
  const entry = spineObj.state.setAnimation(0, name, loop);
  spineTrackRevision += 1; // entry 池可能复用同名对象，显式设置也必须使旧 final confirmation 失效。
  // 坐姿的可见脚底要在混合窗口内尽快落位：站→坐的长混合帧会把下半身带出 120px 条带
  // （“坐时掉脚”），而完全零混合（0.14 时期 9-3 的修复）又让站→坐过渡帧整段消失（“坐下生硬”）。
  // 2026-09-04 折中：短混合 0.12s + 早期 fit（80/160/300ms）兜底终态——掉脚窗口压缩到混合
  // 头几帧内并由 160ms fit 校回；掉脚回归判据 = 真机日志 [fit] seat-phase 后 visibleGap 持续 >0。
  if (reason === "seat-phase") {
    try { if (entry) entry.mixDuration = 0.12; } catch { /* 旧版 Spine TrackEntry 无此字段 */ }
  }
}
function addSpineAnim(name, loop) {
  if (!spineObj) return;
  spineObj.state.addAnimation(0, name, loop, 0);
}

/** 播放新动画后测量姿势包围盒并自适应（坐姿/睡姿超出画布任意一边都会被裁掉） */
let spineFitTimers = [];
let spineFitGeneration = 0;
let spineFitStableHits = 0;
let spineFitOwnerGeneration = 0;
let spineFitOwner = null;
/* A-v2.1 pre-visible bootstrap：冷启动/re-entry/reload 的 Spine 在 fit 收敛（autoScale 确立或
 * 判定无需放大/manual 权威已定）之前保持画布不可见——首次可见即最终尺寸，杜绝 0.205→0.275 跳变。
 * 正常路径由 fit pass 事件驱动释放；bounded fallback（8 pass / 5s）只兜异常模型，防永久隐身。 */
let spineBootstrapPending = false;
let spineBootstrapDeferredWalk = null; // A-v2.2：staged（latest-wins 单槽）——bootstrap 期 incoming 只进这里，绝不提交共享 walkState
let spineBootstrapLastRelease = null;  // 最近一次 release 记录（诊断/测试观察点）
let spineBootstrapPassCount = 0;
let spineBootstrapFailSafeTimer = null;
let spineBootstrapOwner = null; // A-v2.3：本 bootstrap 归属的 Spine owner——每一个新 owner（cold-start/GIF→Spine/皮肤重载/reload 后 initSpine）都走同一套 bootstrap，杜绝 re-entry 走旧 gate 假象
let spineBootstrapDone = Promise.resolve(); // A-v2.3：owner bootstrap 首见完成信号；render-mode ready 上报必须 await 它（ready 不再早于 visible）
let spineBootstrapDoneResolve = null;
let spineBootstrapOwnerReset = null; // A24：owner-boundary 记录 {carry, applied, ownerGen}（staged 初值来源与新 owner neutral applied 的证据链）

function scheduleFitSpine(opts = {}) {
  spineFitGeneration += 1;
  spineFitStableHits = 0;
  // spineAutoScaled / spineFitKeepScale 跨动画保持（只在换皮肤 initSpine 时重置）：
  // 每次动画切换都重置会让适配无限累乘放大（迷迭香实测每次相位切换 ×1.59，几次后角色暴涨出画布消失）
  spineFitTimers.forEach(clearTimeout);
  const generation = spineFitGeneration;
  const owner = spineRuntimeOwner;
  const ownerGeneration = owner && owner.context ? owner.context.generation : activeRenderGeneration;
  spineFitOwner = owner;
  spineFitOwnerGeneration = ownerGeneration;
  // 坐姿切换不等待完整混合窗口：先快速贴底，再由后续 fit 做最终校准。
  const timers = opts.seatPhase ? [80, 160, 300, 600, 1200, 2400] : [150, 500, 1000, 1800, 2800, 4200];
  spineFitTimers = timers.map((ms) => setTimeout(() => fitSpinePose(generation, ownerGeneration, owner), ms));
}
let spineXoff = 0;  // 可见主体偏在包围盒一侧时的水平居中修正（占包围盒宽度比例，face=-1 时自动镜像）
let spineManual = false;   // 该皮肤是否手动调过 boostTable（true 则不做像素级自动放大）
let spineAutoScaled = false; // 本次加载是否已做过像素级自动放大（只做一次，防反复放大）
let spineFitKeepScale = false; // 自动适配后跳过宽度守卫（宽包围盒皮肤防被每帧贴合缩回）
let spineFigLeftCss = 0; // 自动适配皮肤：角色可见左缘在窗口内的 CSS 位置（画布加宽后行走对齐用）
/* ===== EDGEDIAG（碰壁折返闪现临时诊断；SUSSURRO_EDGE_DIAG=1 开启，默认关=零输出零行为差；定位后整体删除） ===== */
const EDGE_DIAG = !!(window.petAPI && window.petAPI.edgeDiag);
let lastFaceFlipAt = 0; // 最近一次 spineFaceDir scale.x 翻转时刻（FIT 探针的短窗基准）
let lastSeatExitAt = 0; // EDGEDIAG：seated/perched→false 边沿时刻——FIT 短窗扩展至 seat-exit（Sit→Move 无 face 翻转也可见 recenter 数据）
/* EDGEDIAG correlation 生命周期（诊断专属，不参与任何生产决策）：
 * tagged 广播建立 activeEdge；untagged 广播不清（相位到期/catToy/抓宠暂停等 untagged 源
 * 可在 FACE→首拍FIT 的 150ms 窗口内插播，立即清零会丢归因）；首个 FIT 消费后清除（独占）；
 * 500ms 窄窗超时自清；新 turnId 覆盖旧值。 */
let diagActiveEdge = null; // {turnId, faceTs, expiresAt}
function diagEdgeFaceId() {
  if (!diagActiveEdge || Date.now() > diagActiveEdge.expiresAt) { diagActiveEdge = null; return null; }
  diagActiveEdge.faceTs = Date.now();
  return diagActiveEdge.turnId;
}
function diagEdgeFitId() {
  if (!diagActiveEdge || Date.now() > diagActiveEdge.expiresAt) { diagActiveEdge = null; return null; }
  const id = diagActiveEdge.turnId;
  diagActiveEdge = null; // 首拍 FIT 独占：消费即清（后续 pass/其它源的 FIT 归 null，绝不误挂）
  return id;
}
function sdRawBounds() { // EDGEDIAG-only 读工具：与 fit 同源的 spineObj.getBounds() 世界坐标，绝不触碰 position 归零等有副作用的 fit API
  try {
    const b = spineObj.getBounds();
    return { x: Number(b.x.toFixed(1)), y: Number(b.y.toFixed(1)), w: Number(b.width.toFixed(1)), h: Number(b.height.toFixed(1)), right: Number((b.x + b.width).toFixed(1)), bottom: Number((b.y + b.height).toFixed(1)) };
  } catch { return null; }
}
/* ===== E1：Sit→Move / stand-beat forensic（diagnostics-only，默认无采样/无 timer） ===== */
const SEAT_EXIT_FORENSIC = !!(window.petAPI && window.petAPI.seatExitForensic);
const STANDBEAT_POSE_ENABLED = !!(window.petAPI && window.petAPI.standBeatPose);
const SEAT_EXIT_FORENSIC_WINDOW_MS = 1100;
const SEAT_EXIT_FORENSIC_MAX_RECORDS = 256;
let seatExitForensicOrdinal = 0;
let seatExitForensicSession = null;
function seatExitForensicRound(v, digits = 3) { return Number.isFinite(v) ? Number(v.toFixed(digits)) : null; }
function seatExitForensicNormalizeBoneName(name) { return String(name || "").toLowerCase().replace(/[\s_-]/g, ""); }
function seatExitForensicBones() {
  const bones = Array.isArray(spineObj?.skeleton?.bones) ? spineObj.skeleton.bones : [];
  const names = bones.map((b) => String(b?.data?.name || b?.name || "")).filter(Boolean);
  const exact = {
    hip: ["hip"], chest: ["chest"],
    leftFoot: ["leftfoot", "footl"], rightFoot: ["rightfoot", "footr"]
  };
  const out = { availableNames: names };
  for (const [key, aliases] of Object.entries(exact)) {
    const found = bones.find((b) => aliases.includes(seatExitForensicNormalizeBoneName(b?.data?.name || b?.name)));
    out[key] = found ? { name: String(found?.data?.name || found?.name || ""), worldY: Number.isFinite(found.worldY) ? found.worldY : "UNKNOWN" } : "unavailable";
  }
  return out;
}
function seatExitForensicTrack() {
  try {
    const cur = spineObj?.state?.getCurrent ? spineObj.state.getCurrent(0) : null;
    return {
      current: cur?.animation?.name || null,
      next: cur?.next?.animation?.name || null,
      loop: cur ? !!cur.loop : null,
      trackTime: cur && Number.isFinite(cur.trackTime) ? cur.trackTime : null,
      mixingFrom: cur?.mixingFrom?.animation?.name || null,
      mixTime: cur && Number.isFinite(cur.mixTime) ? cur.mixTime : null,
      mixDuration: cur && Number.isFinite(cur.mixDuration) ? cur.mixDuration : null
    };
  } catch { return { current: null, next: null, loop: null, trackTime: null, mixingFrom: null, mixTime: null, mixDuration: null }; }
}
function seatExitForensicPose() {
  let bbox = null;
  try {
    if (spineObj && typeof spineObj.getBounds === "function") {
      const b = spineObj.getBounds();
      if (b && Number.isFinite(b.y) && Number.isFinite(b.height)) bbox = {
        y: seatExitForensicRound(b.y), height: seatExitForensicRound(b.height),
        bottom: seatExitForensicRound(b.y + b.height),
        bottomRelativeToObject: seatExitForensicRound(b.y + b.height - spineObj.y)
      };
    }
  } catch { /* cheap bbox unavailable is explicit null */ }
  return { bbox, bones: seatExitForensicBones() };
}
function seatExitForensicAsset() {
  let zoom = "UNKNOWN";
  try {
    const vv = window.visualViewport;
    if (vv && Number.isFinite(vv.scale)) zoom = vv.scale;
  } catch { /* UNKNOWN */ }
  return {
    renderMode: activeRenderMode || "UNKNOWN",
    atlasPath: spinePaths?.atlas || "UNKNOWN",
    skelPath: spinePaths?.skel || "UNKNOWN",
    assetIdentity: renderRuntimeResource || "UNKNOWN",
    renderGeneration: activeRenderGeneration || "UNKNOWN",
    ownerGeneration: spineRuntimeOwner?.context?.generation || "UNKNOWN",
    scale: spineObj?.scale ? { x: spineObj.scale.x, y: spineObj.scale.y } : "UNKNOWN",
    keepScale: typeof spineFitKeepScale === "boolean" ? spineFitKeepScale : "UNKNOWN",
    manualScale: typeof spineManual === "boolean" ? spineManual : "UNKNOWN",
    baseScaleX: Number.isFinite(spineBaseScaleX) ? spineBaseScaleX : "UNKNOWN",
    seatSink: "UNKNOWN",
    devicePixelRatio: Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : "UNKNOWN",
    rendererResolution: spineApp?.renderer?.resolution ?? "UNKNOWN",
    zoom,
    poseAtStart: seatExitForensicPose()
  };
}
function seatExitForensicOrderedRecords(s) {
  if (!s || !s.records.length) return [];
  if (s.records.length < SEAT_EXIT_FORENSIC_MAX_RECORDS || s.next === 0) return s.records.slice();
  return s.records.slice(s.next).concat(s.records.slice(0, s.next));
}
function seatExitForensicFlush(reason) {
  const s = seatExitForensicSession;
  if (!SEAT_EXIT_FORENSIC || !s) return;
  seatExitForensicSession = null;
  try {
    window.petAPI.playback("[SEATFORENSIC] " + JSON.stringify({
      sessionId: s.mainSessionId,
      renderSessionId: s.renderSessionId,
      side: "renderer",
      closeReason: reason,
      startedAt: { monoMs: s.startedMonoMs, dateNow: s.startedDateNow },
      endedAt: { monoMs: performance.now(), dateNow: Date.now() },
      maxRecords: SEAT_EXIT_FORENSIC_MAX_RECORDS,
      droppedRecords: s.dropped,
      asset: s.asset,
      records: seatExitForensicOrderedRecords(s)
    }));
  } catch { /* 诊断发射失败忽略 */ }
}
function seatExitForensicPush(record) {
  const s = seatExitForensicSession;
  if (s.records.length < SEAT_EXIT_FORENSIC_MAX_RECORDS) s.records.push(record);
  else { s.records[s.next] = record; s.next = (s.next + 1) % SEAT_EXIT_FORENSIC_MAX_RECORDS; s.dropped += 1; }
}
function seatExitForensicRecord(ev, extra = {}) {
  const s = seatExitForensicSession;
  if (!SEAT_EXIT_FORENSIC || !s) return false;
  const monoMs = performance.now();
  if (monoMs - s.startedMonoMs >= SEAT_EXIT_FORENSIC_WINDOW_MS) { seatExitForensicFlush("window-elapsed"); return false; }
  if (s.owner && (s.owner !== spineObj || (s.ownerGen && s.ownerGen !== activeRenderGeneration))) return false;
  const token = seatExitY;
  const track = seatExitForensicTrack();
  const scale = spineObj?.scale ? { x: spineObj.scale.x, y: spineObj.scale.y } : null;
  const objectY = spineObj && Number.isFinite(spineObj.y) ? spineObj.y : null;
  const targetY = token && token.hasTarget && Number.isFinite(token.targetY) ? token.targetY : null;
  seatExitForensicPush(Object.assign({
    side: "renderer",
    sessionId: s.mainSessionId,
    renderSessionId: s.renderSessionId,
    localSeq: ++s.localSeq,
    frameIndex: s.frameIndex,
    monoMs,
    dateNow: Date.now(),
    ev,
    rendererGeneration: activeRenderGeneration,
    ownerGeneration: s.ownerGen || activeRenderGeneration,
    track,
    walkState: {
      active: !!walkState.active, resting: !!walkState.resting, seated: !!walkState.seated,
      paused: !!walkState.paused, sleeping: !!walkState.sleeping, perched: !!walkState.perched
    },
    seatEpisode: { active: !!seatEpisode.active, owner: seatEpisode.owner === spineObj, pendingFit: !!seatEpisode.pendingFit },
    seatExitY: token ? {
      owns: seatExitYOwnsY(), ownerGeneration: token.ownerGen, sourceName: token.sourceName, targetName: token.targetName,
      targetY, visibleCorrectionY: token.visibleCorrectionY, fastBaseY: token.fastBaseY,
      finalAuthorityValid: !!token.finalAuthorityValid, freeze: !!token.finalAuthorityValid,
      sawFinalReaim: !!token.sawFinalReaim, needsMeasure: !!token.needsMeasure
    } : { owns: false, token: "unavailable" },
    objectY: seatExitForensicRound(objectY),
    scale,
    fit: { generation: spineFitGeneration, ownerGeneration: spineFitOwnerGeneration, keepScale: !!spineFitKeepScale, manualScale: !!spineManual, baseScaleX: spineBaseScaleX },
    pose: seatExitForensicPose(),
    targetY: seatExitForensicRound(targetY),
    visibleCorrectionY: token && Number.isFinite(token.visibleCorrectionY) ? seatExitForensicRound(token.visibleCorrectionY) : null,
    final: token ? !!token.finalAuthorityValid : false,
    freeze: token ? !!token.finalAuthorityValid : false,
    release: null
  }, extra));
  return true;
}
function seatExitForensicReceive(meta, incoming) {
  if (!SEAT_EXIT_FORENSIC || !meta || !meta.sessionId) return;
  const owner = spineRuntimeOwner?.obj || spineObj || null;
  const old = seatExitForensicSession;
  if (old && (old.mainSessionId !== meta.sessionId || (old.owner && owner && old.owner !== owner))) {
    seatExitForensicFlush(old.mainSessionId === meta.sessionId ? "owner-changed" : "new-main-session");
  }
  if (!seatExitForensicSession) {
    seatExitForensicOrdinal += 1;
    seatExitForensicSession = {
      mainSessionId: meta.sessionId,
      renderSessionId: meta.sessionId + "/r" + seatExitForensicOrdinal,
      startedMonoMs: performance.now(), startedDateNow: Date.now(),
      owner, ownerGen: activeRenderGeneration || 0, localSeq: 0, frameIndex: 0,
      records: [], next: 0, dropped: 0, asset: seatExitForensicAsset(),
      standBeatPoseIntentReceived: false, standBeatPoseRequested: null, standBeatPoseApplied: false, standBeatPoseMoveRequested: false
    };
    seatExitForensicRecord("session-start", { mainEventSeq: meta.eventSeq, mainMonoMs: meta.mainMonoMs, mainDateNow: meta.mainDateNow, incomingState: incoming || null });
  }
  seatExitForensicRecord("receive", { mainEventSeq: meta.eventSeq, mainMonoMs: meta.mainMonoMs, mainDateNow: meta.mainDateNow, incomingState: incoming || null });
  if (incoming?.standBeatPoseIntent === "stand" && !seatExitForensicSession.standBeatPoseIntentReceived) {
    seatExitForensicSession.standBeatPoseIntentReceived = true;
    seatExitForensicRecord("stand-beat-pose-intent-receive", { standBeatPoseIntent: "stand" });
  }
}
function seatExitForensicBeforeFrame() {
  if (!SEAT_EXIT_FORENSIC || !seatExitForensicSession || !spineObj) return null;
  if (!seatExitForensicSession.owner) {
    seatExitForensicSession.owner = spineObj;
    seatExitForensicSession.ownerGen = activeRenderGeneration;
  }
  const t = seatExitY;
  return {
    objectY: Number.isFinite(spineObj.y) ? spineObj.y : null,
    fastBaselineY: t && Number.isFinite(t.fastBaseY) ? t.fastBaseY : null,
    residual: t && t.hasTarget && Number.isFinite(t.targetY) ? t.targetY - spineObj.y : null
  };
}
function seatExitForensicAfterFrame(dtSec, before) {
  if (!SEAT_EXIT_FORENSIC || !seatExitForensicSession || !spineObj) return;
  const session = seatExitForensicSession;
  const t = seatExitY;
  session.frameIndex += 1;
  seatExitForensicRecord("frame", {
    dtSec: seatExitForensicRound(dtSec, 5),
    frameIndex: session.frameIndex,
    objectYBefore: seatExitForensicRound(before?.objectY),
    objectYAfter: seatExitForensicRound(spineObj.y),
    fastBaselineYBefore: seatExitForensicRound(before?.fastBaselineY),
    fastBaselineYAfter: seatExitForensicRound(t && t.fastBaseY),
    residualBefore: seatExitForensicRound(before?.residual),
    residualAfter: seatExitForensicRound(t && t.hasTarget && Number.isFinite(t.targetY) ? t.targetY - spineObj.y : null)
  });
  if (session === seatExitForensicSession && session.standBeatPoseRequested && !session.standBeatPoseApplied) {
    const track = seatExitForensicTrack();
    if (track.current === session.standBeatPoseRequested.targetName && track.loop) {
      session.standBeatPoseApplied = true;
      seatExitForensicRecord("stand-beat-pose-applied", {
        standBeatPoseIntent: "stand",
        targetName: session.standBeatPoseRequested.targetName,
        appliedFrame: session.frameIndex
      });
    }
  }
}
function seatExitForensicFitEvent(branch = "invoke") {
  if (SEAT_EXIT_FORENSIC) seatExitForensicRecord("fit", { fitEvent: branch });
}

function reliableStandBeatIdleAnim() {
  const target = spineAnimForMood("idle");
  if (!target || !spineHas(target) || isSitClassAnim(target) || isStaticFallbackAnim(target)) return null;
  return target;
}
function admitStandBeatPoseIntent() {
  if (!STANDBEAT_POSE_ENABLED || !spineObj || activeRenderMode !== "spine") return false;
  const owner = spineRuntimeOwner;
  if (!owner || owner.obj !== spineObj || spinePendingOwner || spineBootstrapPending || activeRenderGeneration <= 0 ||
      owner.context?.generation !== activeRenderGeneration) return false;
  if (!walkState.active || !walkState.resting || walkState.seated || walkState.perched || walkState.iconRest || walkState.paused ||
      walkState.sleeping || busy || dragState || Date.now() < animDemoUntil) return false;
  const cur = spineObj.state?.getCurrent ? spineObj.state.getCurrent(0) : null;
  const sit = sitAnimName();
  if (!cur?.animation || !sit || cur.animation.name !== sit || cur.loop !== true || cur.next) return false;
  if (!seatEpisode.active || seatEpisode.owner !== spineObj) return false;
  const target = reliableStandBeatIdleAnim();
  if (!target) {
    if (SEAT_EXIT_FORENSIC) seatExitForensicRecord("stand-beat-pose-fallback", { standBeatPoseIntent: "stand", reason: "no-reliable-idle" });
    return false;
  }
  if (SEAT_EXIT_FORENSIC && seatExitForensicSession) {
    seatExitForensicSession.standBeatPoseRequested = { targetName: target, fromName: cur.animation.name, owner, ownerGeneration: activeRenderGeneration };
    seatExitForensicRecord("stand-beat-pose-request", { standBeatPoseIntent: "stand", fromName: cur.animation.name, targetName: target });
  }
  setSpineAnim(target, true, "stand-beat-pose");
  scheduleFitSpine({});
  return true;
}
function seatExitForensicNoteMoveRequest() {
  const session = seatExitForensicSession;
  const requested = session && session.standBeatPoseRequested;
  if (!SEAT_EXIT_FORENSIC || !requested || session.standBeatPoseMoveRequested || !walkState.active || walkState.resting ||
      walkState.seated || walkState.perched || walkState.iconRest || walkState.paused || walkState.sleeping || isSleeping) return;
  const cur = spineObj?.state?.getCurrent ? spineObj.state.getCurrent(0) : null;
  const target = spinePhaseAnim();
  if (!cur?.animation || !target || cur.animation.name !== requested.targetName || target === requested.targetName) return;
  session.standBeatPoseMoveRequested = true;
  seatExitForensicRecord("stand-beat-move-request", { fromName: requested.targetName, targetName: target });
}
/* ===== OFFSETDIAG（diagnostics-only，SUSSURRO_EDGE_DIAG 同一 gate）：keepScale 皮肤
 * Sitd→Move / Sitd→Sleep 混合期 visibleBottomOffset(t) 采样器。
 * 唯一符号约定：visibleBottomOffset = visBottom − bboxBottom（两量同帧同位置快照）。
 * 输出字段用 sampledMaxDeviation（离散 9 桶采样的最大偏差），不是连续上界。
 * 关闭态：零采样、零 RenderTexture、零 ticker 额外工作（offsetDiagTick 首行短路）。 ===== */
let offsetDiagSeq = 0;
let offsetDiagTransition = null; // {id, from, to, buckets:Set, offsets:[], sourceSteadyOffset, sourceSteadyFresh, maxCost, sumCost, t0}
let offsetDiagSitSteady = null;  // {offset, ts}：Sitd 稳态节流快照（0% 端点真值来源）
let offsetDiagLastSnapAt = 0;
function offsetDiagSampleVis() { // 与 fit 同一几何提取（step/thr 同参数），但只取底边一行极值
  const t0 = performance.now();
  try {
    const W = Math.ceil(spineApp.screen.width), Hh = Math.ceil(spineApp.screen.height);
    const rt = PIXI.RenderTexture.create({ width: W, height: Hh });
    spineApp.renderer.render(spineObj, { renderTexture: rt, clear: true });
    const px = spineApp.renderer.extract.pixels(rt);
    const pw = rt.width, ph = rt.height, fy = spineApp.screen.height / ph, step = 4, thr = 32;
    let y1 = -1;
    for (let y = 0; y < ph; y += step) { for (let x = 0; x < pw; x += step) { if (px[(y * pw + x) * 4 + 3] > thr) { if (y > y1) y1 = y; break; } } }
    rt.destroy(true);
    return { visBottom: y1 >= 0 ? Number(((y1 + step) * fy).toFixed(2)) : null, costMs: Number((performance.now() - t0).toFixed(3)) };
  } catch { return { visBottom: null, costMs: Number((performance.now() - t0).toFixed(3)) }; }
}
function offsetDiagLine(obj) { try { window.petAPI.playback("[OFFSETDIAG] " + JSON.stringify(obj)); } catch { /* 忽略 */ } }
function offsetDiagClose(reason) {
  const t = offsetDiagTransition;
  if (!t) return;
  offsetDiagTransition = null;
  const offs = t.offsets; // 仅 mixed（0..7 桶）；target steady 单独记录，绝不混入
  const steadyOffset = t.targetSteady && Number.isFinite(t.targetSteady.offset) ? t.targetSteady.offset : null;
  let dev = null;
  if (steadyOffset !== null) {
    const devs = offs.map((o) => Math.abs(o - steadyOffset));
    if (t.sourceSteadyFresh && Number.isFinite(t.sourceSteadyOffset)) devs.push(Math.abs(t.sourceSteadyOffset - steadyOffset));
    dev = devs.length ? Number(Math.max(...devs).toFixed(2)) : 0; // 只在 target steady 已取得后计算；离散采样最大偏差，非连续上界
  }
  const costCount = offs.length + (t.targetSteady ? 1 : 0);
  offsetDiagLine({
    ts: Date.now(), ev: "SUMMARY", transitionId: t.id, from: t.from, to: t.to, closedReason: reason,
    sourceSteadyOffset: t.sourceSteadyFresh ? t.sourceSteadyOffset : null,
    sourceSteadyKind: t.sourceSteadyFresh ? "steadySit" : "firstMixedSample", // 与 bucket0 完全独立（bucket0 是混合首帧样本，永不冒充 source steady）
    targetSteadyRecorded: !!t.targetSteady,
    targetSteadyOffset: steadyOffset, // 未取得 → null（timeout/target-changed/no-current 绝不拿 mixed 末位冒充）
    targetSteadyTs: t.targetSteady ? t.targetSteady.ts : null,
    targetSteadyBBoxBottom: t.targetSteady ? t.targetSteady.bboxBottom : null,
    targetSteadyVisBottom: t.targetSteady ? t.targetSteady.visBottom : null,
    targetSteadySampleCostMs: t.targetSteady ? t.targetSteady.costMs : null,
    sampledMinOffset: offs.length ? Number(Math.min(...offs).toFixed(2)) : null,
    sampledMaxOffset: offs.length ? Number(Math.max(...offs).toFixed(2)) : null,
    sampledMaxDeviationFromTarget: dev,
    maxSampleCostMs: Number(t.maxCost.toFixed(2)),
    avgSampleCostMs: costCount ? Number((t.sumCost / costCount).toFixed(2)) : null,
    sampleCount: offs.length
  });
}
function offsetDiagTick() {
  if (!EDGE_DIAG || !spineObj || !spineApp || !spineFitKeepScale) return; // keepScale 专项；normal 皮肤不在本测量范围
  try {
    const cur = spineObj.state ? spineObj.state.getCurrent(0) : null;
    if (!cur) { offsetDiagClose("no-current"); return; }
    const name = cur.animation ? cur.animation.name : null;
    if (!offsetDiagTransition) {
      const sit = sitAnimName();
      const fromEntry = cur.mixingFrom;
      if (fromEntry && sit && fromEntry.animation && fromEntry.animation.name === sit) {
        const moveTgt = spinePhaseAnim();
        const sleepTgt = spineAnimForMood("sleep");
        if (name && (name === moveTgt || (sleepTgt && name === sleepTgt))) { // 精确门：只此两种目标混合
          offsetDiagTransition = { id: ++offsetDiagSeq, from: sit, to: name, buckets: new Set(), offsets: [], targetSteady: null,
            sourceSteadyFresh: !!(offsetDiagSitSteady && Date.now() - offsetDiagSitSteady.ts <= 2000),
            sourceSteadyOffset: (offsetDiagSitSteady && Date.now() - offsetDiagSitSteady.ts <= 2000) ? offsetDiagSitSteady.offset : null,
            maxCost: 0, sumCost: 0, t0: Date.now() };
        }
        return;
      }
      if (!fromEntry && sit && name === sit && Date.now() - offsetDiagLastSnapAt >= 500) { // Sitd 稳态 0% 快照（节流 500ms）
        offsetDiagLastSnapAt = Date.now();
        const vis = offsetDiagSampleVis();
        if (vis.visBottom != null) { const b = spineObj.getBounds(); offsetDiagSitSteady = { offset: Number((vis.visBottom - (b.y + b.height)).toFixed(2)), ts: Date.now() }; }
      }
      return;
    }
    const t = offsetDiagTransition;
    const dur = Number.isFinite(cur.mixDuration) && cur.mixDuration > 0 ? cur.mixDuration : 0.2;
    const progress = Math.max(0, Math.min(1, Number.isFinite(cur.mixTime) ? cur.mixTime / dur : 1));
    if (cur.mixingFrom) {
      if (name && name !== t.to) { offsetDiagClose("target-changed"); return; }
      if ((cur.mixingFrom.animation || {}).name !== t.from) { offsetDiagClose("source-changed"); return; }
      const bucket = Math.min(7, Math.round(progress / 0.125)); // 混合桶只到 7（≈87.5%+）；96% 也归 7，不产生"100% steady"
      if (!t.buckets.has(bucket)) {
        t.buckets.add(bucket);
        const vis = offsetDiagSampleVis();
        const b = spineObj.getBounds();
        const bboxBottom = Number((b.y + b.height).toFixed(2));
        const offset = vis.visBottom !== null ? Number((vis.visBottom - bboxBottom).toFixed(2)) : null;
        t.maxCost = Math.max(t.maxCost, vis.costMs); t.sumCost += vis.costMs;
        if (offset !== null) t.offsets.push(offset);
        offsetDiagLine({ ts: Date.now(), ev: "SAMPLE", role: "mixed", transitionId: t.id, from: t.from, to: name || t.to,
          progressBucket: bucket, progressPct: bucket * 12.5,
          mixTime: Number.isFinite(cur.mixTime) ? Number(cur.mixTime.toFixed(3)) : null, mixDuration: Number(cur.mixDuration).toFixed ? Number((Number.isFinite(cur.mixDuration) ? cur.mixDuration : dur).toFixed(3)) : dur,
          bboxBottom, visBottom: vis.visBottom, visibleBottomOffset: offset, // 唯一符号：visBottom − bboxBottom
          sampleCostMs: vis.costMs, spineLocalY: Number(spineObj.y.toFixed(2)), keepScale: true,
          generation: spineFitGeneration, ownerGeneration: spineFitOwnerGeneration });
      }
      if (Date.now() - t.t0 > 1500) offsetDiagClose("timeout");
      return;
    }
    // mixingFrom 已清除：target steady 只在"目标动画名未变"的下一拍【重新同帧采样】，绝不复用 mixed 末样本
    if (name && name !== t.to) { offsetDiagClose("target-changed"); return; }
    if (Date.now() - t.t0 > 1500 && !t.targetSteady) { offsetDiagClose("timeout"); return; }
    {
      const vis = offsetDiagSampleVis();
      const b = spineObj.getBounds();
      const bboxBottom = Number((b.y + b.height).toFixed(2));
      const offset = vis.visBottom !== null ? Number((vis.visBottom - bboxBottom).toFixed(2)) : null;
      t.maxCost = Math.max(t.maxCost, vis.costMs); t.sumCost += vis.costMs;
      t.targetSteady = { ts: Date.now(), bboxBottom, visBottom: vis.visBottom, offset, costMs: vis.costMs };
      offsetDiagLine({ ts: Date.now(), ev: "TARGET_STEADY", transitionId: t.id, from: t.from, to: t.to,
        bboxBottom, visBottom: vis.visBottom, visibleBottomOffset: offset, sampleCostMs: vis.costMs,
        spineLocalY: Number(spineObj.y.toFixed(2)), keepScale: true, generation: spineFitGeneration, ownerGeneration: spineFitOwnerGeneration });
    }
    offsetDiagClose("mix-complete");
  } catch { /* 诊断绝不外溢 */ }
}
/* ===== SPEECHDIAG（说话时定身 T3 专项诊断；SUSSURRO_SPEECH_DIAG=1 开启；默认关：无 interval/无日志/零行为差；定位后整体删除） =====
 * 会话模型：refcount 式多 session（proactive/tts/thinking 允许重叠——任一 END 只关自己，最后一个到期才停采样）。
 * 采样窗口 = 生命周期 + 结束后 3s（T3 常现于语音末/刚末）。推进权双心跳：
 *   A=diagTickerCallbackSeq（ticker 回调最顶、任何守卫前）——不涨 ⇒ ticker 本身没在 tick；
 *   B=diagSpineAdvanceSeq（过 owner 守卫、真正执行 spineObj.update 前）——A涨B不涨+ownerMatch=false ⇒ lifecycle owner 错位实锤。 */
const SPEECH_DIAG = !!(window.petAPI && window.petAPI.speechDiag);
let diagTickerCallbackSeq = 0, diagLastTickerCallbackAt = 0;
let diagSpineAdvanceSeq = 0, diagLastSpineAdvanceAt = 0;
let diagThinkingId = 0;
let speechDiagSeq = 0;
const speechDiagSessions = new Map(); // diagId → {reason, startTs, endAt(0=活跃)}
let speechDiagTimer = null;
let speechDiagLastTrackTime = null;
function speechDiagEmit(obj) { try { window.petAPI.playback("[SPEECHDIAG] " + JSON.stringify(obj)); } catch { /* 诊断发射失败忽略 */ } }
function speechDiagLog(ev, diagId, extra) { if (!SPEECH_DIAG) return; try { speechDiagEmit({ ts: Date.now(), ev, diagId, reason: (speechDiagSessions.get(diagId) || {}).reason || extra || null }); } catch { /* 忽略 */ } }
function speechDiagArm() { if (!SPEECH_DIAG || speechDiagTimer) return; speechDiagTimer = setInterval(speechDiagTick, 300); } // 沙箱 setInterval 可为 no-op——tick 由测试 seam 手动驱动
function speechDiagStart(reason) {
  if (!SPEECH_DIAG) return 0;
  const diagId = ++speechDiagSeq;
  speechDiagSessions.set(diagId, { reason, startTs: Date.now(), endAt: 0 });
  speechDiagLog("START", diagId, reason);
  speechDiagArm();
  return diagId;
}
function speechDiagEnd(diagId) {
  if (!SPEECH_DIAG) return;
  const s = speechDiagSessions.get(diagId);
  if (!s || s.endAt) return;
  s.endAt = Date.now() + 3000; // 结束后续采 3s
  speechDiagLog("END", diagId);
}
function speechDiagPruneAndCount() {
  const now = Date.now();
  for (const [id, s] of speechDiagSessions) if (s.endAt && now >= s.endAt) speechDiagSessions.delete(id);
  if (speechDiagSessions.size === 0) { if (speechDiagTimer && typeof clearInterval === "function") clearInterval(speechDiagTimer); speechDiagTimer = null; speechDiagLastTrackTime = null; }
  return speechDiagSessions.size;
}
const sdNum = (v) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(3)) : (v === undefined ? "undef" : null));
function speechDiagTick() {
  try {
    if (speechDiagPruneAndCount() === 0) return;
    const now = Date.now();
    const reasons = []; const ids = [];
    for (const [id, s] of speechDiagSessions) { ids.push(id); reasons.push(s.reason); }
    const cur = spineObj && spineObj.state ? spineObj.state.getCurrent(0) : null;
    const nx = cur ? cur.next : null;
    const mf = cur ? cur.mixingFrom : null;
    const tick = spineApp ? spineApp.ticker : null;
    const prev = speechDiagLastTrackTime;
    const dtt = cur && prev !== null && typeof cur.trackTime === "number" ? cur.trackTime - prev : null;
    speechDiagLastTrackTime = cur && typeof cur.trackTime === "number" ? cur.trackTime : null;
    speechDiagEmit({
      ts: now, ev: "SAMPLE", ids: ids.join(","), reasons: reasons.join(","),
      track: cur ? { name: (cur.animation || {}).name || null, loop: cur.loop, trackTime: sdNum(cur.trackTime), animationStart: sdNum(cur.animationStart), animationEnd: sdNum(cur.animationEnd), trackLast: sdNum(cur.trackLast) } : null,
      next: nx ? { name: (nx.animation || {}).name || null, loop: nx.loop, delay: nx.delay === undefined ? "undef" : sdNum(nx.delay), delayFinite: Number.isFinite(nx.delay) } : null,
      hasNext: !!nx,
      mixingFrom: mf ? { name: (mf.animation || {}).name || null, trackTime: sdNum(mf.trackTime) } : null,
      trackTimeDelta: sdNum(dtt), trackTimeAdvance: dtt === null ? null : dtt > 1e-6,
      autoUpdate: spineObj ? spineObj.autoUpdate : null,
      tickerStarted: tick ? !!tick.started : null, tickerMaxFPS: tick ? tick.maxFPS : null,
      tickerCallbackSeq: diagTickerCallbackSeq, tickerCallbackAgeMs: diagLastTickerCallbackAt ? Math.round(performance.now() - diagLastTickerCallbackAt) : null,
      spineAdvanceSeq: diagSpineAdvanceSeq, spineAdvanceAgeMs: diagLastSpineAdvanceAt ? Math.round(performance.now() - diagLastSpineAdvanceAt) : null,
      ownerMatch: !!(seatLifecycle.owner && seatLifecycle.owner === spineObj),
      stateTimeScale: spineObj && spineObj.state ? spineObj.state.timeScale : null,
      walk: [walkState.active, walkState.resting, walkState.seated, walkState.perched, walkState.paused, walkState.sleeping].map(Boolean).join(""),
      busy: !!busy,
      moodRemainMs: Math.max(0, Date.now() < moodAnimUntil ? moodAnimUntil - Date.now() : 0),
      demoRemainMs: Math.max(0, Date.now() < animDemoUntil ? animDemoUntil - Date.now() : 0),
      vis: document.visibilityState || null
    });
  } catch { /* 诊断绝不外溢影响生产 */ }
}
function settleSpineBootstrapDone() { const r = spineBootstrapDoneResolve; if (r) { spineBootstrapDoneResolve = null; r(); } } // 防任何 waiter 悬挂（release/abandon 双路径必须结算）
function releaseSpineBootstrap(why) { // A-v2.2 严格顺序：停延后 → 取 staged → replay → scale/anim 稳定 → 最后解除隐藏 → visible-release
  if (!spineBootstrapPending) return;
  if (spineBootstrapOwner && spineRuntimeOwner !== spineBootstrapOwner) { return; } // A24-T10：stale 触发器对“当前 owner 的单槽 gate”零可变——pending/owner/done/failsafe/staged 全属新 owner，旧释放只能静默退场
  const bootstrapOwner = spineBootstrapOwner; // A26.1：production owner token 在此捕获（mismatch 检查之后，release/settle 全程同一身份）
  spineBootstrapPending = false; // B. 先停延后：replay 内部的 applyWalkState/setSpineAnim 不再走 staged 分支
  if (spineBootstrapFailSafeTimer) { clearTimeout(spineBootstrapFailSafeTimer); spineBootstrapFailSafeTimer = null; }
  const replay = spineBootstrapDeferredWalk; // C. latest-wins 单份
  spineBootstrapDeferredWalk = null;        // D. 清槽防重复 replay
  const before = spineObj ? { anim: (spineObj.state.getCurrent(0)?.animation || {}).name || null, sy: spineObj.scale.y } : null;
  if (replay) applyWalkState(replay); // E. 此刻才进入真实角色（Sit 快照 entryScale=fitted scale，v2 ratchet/keepScale 保证不回卷）
  settleBootstrapFinalPose(bootstrapOwner); // A26：bootstrap final-state 语义——恢复"应当已处于"的最终业务态（hidden 下消灭 Relax→Sit mix + containment 收敛过程）；owner 走 production token
  const after = spineObj ? { anim: (spineObj.state.getCurrent(0)?.animation || {}).name || null, sy: spineObj.scale.y } : null;
  spineBootstrapLastRelease = { why, hadReplay: !!replay, animBefore: before && before.anim, animAfter: after && after.anim, scaleBefore: before && Number(before.sy.toFixed(5)), scaleAfter: after && Number(after.sy.toFixed(5)), replayBeforeVisible: true };
  if (spineApp && spineApp.view) { // H. 最后才可见
    spineApp.view.classList.remove("hidden");
    spineApp.view.style.display = "";
    spineApp.view.style.visibility = "";
  }
  settleSpineBootstrapDone(); // A-v2.3：首见完成 → 解锁 render-mode ready 上报
}
function settleBootstrapFinalPose(owner) { // A26.1：production owner token 由 release 从 bootstrap 生命周期捕获并显式传入——settle 的行为执行不依赖诊断层状态
  if (!owner || spineRuntimeOwner !== owner) return; // owner-bound：旧 owner 的迟到 settle 不得移动新 owner
  if (!spineObj || !spineApp) return;
  const sit = sitAnimName();
  const cur = spineObj.state ? spineObj.state.getCurrent(0) : null;
  if (!sit || !cur || !cur.animation || cur.animation.name !== sit) return; // T6：非坐姿 final state 不进入 settle，现有 Relax/Move/Sleep 语义不变
  if (!seatEpisode.active || seatEpisode.owner !== spineObj) return;
  try { cur.mixDuration = 0; } catch { /* 旧 runtime 不可写：下方 0 时长求值仍取得 Sit 起点全姿势（runtime: mixDuration==0 ⇒ alpha=1） */ }
  const bx0 = spineObj.x, by0 = spineObj.y;
  let iterations = 0;
  let lastX = bx0, lastY = by0;
  for (; iterations < 4; iterations += 1) { // bounded convergence：≤4 次硬上限，亚像素即停
    try { spineObj.update(0); spineObj.updateTransform(); } catch { break; } // 与 ticker 等价的 pose apply（不推进 animation time）
    try { seatContainmentCommit(); } catch { break; }
    const moved = Math.hypot(spineObj.x - lastX, spineObj.y - lastY);
    lastX = spineObj.x; lastY = spineObj.y;
    if (moved < 0.5) break; // 亚像素停止条件
  }
}
function fitBootstrapCheck(ready) {
  if (!spineBootstrapPending) return;
  if (spineBootstrapOwner && spineRuntimeOwner !== spineBootstrapOwner) return; // A23-T8：非本 bootstrap owner 的 pass 既不推进计数也不释放（防旧窗口残留计时把新 owner 提前放行/污染计数）
  if (ready) { releaseSpineBootstrap("ready"); return; }
  spineBootstrapPassCount += 1;
  if (spineBootstrapPassCount >= 8) releaseSpineBootstrap("pass-fallback"); // ≈两个完整窗口仍未决断：异常模型兜底，宁可见旧尺不永久隐身
}
// 在虚拟定位/缩放下采样。projection transform 不修改对象的 x/y/scale 或 geometry bookkeeping。
function sampleSpineFitAt(W, H, pose) {
  let rt = null;
  try {
    const ax = pose.sx / spineObj.scale.x, ay = pose.sy / spineObj.scale.y;
    const transform = new PIXI.Matrix(ax, 0, 0, ay, pose.x - ax * spineObj.x, pose.y - ay * spineObj.y);
    rt = PIXI.RenderTexture.create({ width: Math.ceil(W), height: Math.ceil(H) });
    spineApp.renderer.render(spineObj, { renderTexture: rt, clear: true, transform });
    const px = spineApp.renderer.extract.pixels(rt);
    const pw = rt.width, ph = rt.height, fx = W / pw, fy = H / ph, step = 4;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < ph; y += step) for (let x = 0; x < pw; x += step) {
      if (px[(y * pw + x) * 4 + 3] > 32) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return x1 >= 0 ? { x0: x0 * fx, x1: (x1 + step) * fx, y0: y0 * fy, y1: (y1 + step) * fy } : null;
  } finally {
    if (rt) rt.destroy(true);
  }
}
function spineFitBoundsAtScale(sx, sy) {
  const b = spineObj.getBounds();
  const ax = sx / spineObj.scale.x, ay = sy / spineObj.scale.y;
  const x0 = (b.x - spineObj.x) * ax, x1 = (b.x + b.width - spineObj.x) * ax;
  const y0 = (b.y - spineObj.y) * ay, y1 = (b.y + b.height - spineObj.y) * ay;
  if (![x0, x1, y0, y1].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return null;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}
// ordinary fit 和 seat-exit 共用同一 would-be placement；只读实际对象。
// keepScale 从固定 bbox 起点重放既有 push/visible-anchor 算法，采样网格不随 limiter 进度漂移。
function measureSpineFitPlacement(keepScale = spineFitKeepScale) {
  const W = spineApp.screen.width, H = spineApp.screen.height;
  const baseline = Math.abs(spineBaseScaleX), flip = walkState.face === -1 ? -1 : 1;
  const b = spineFitBoundsAtScale(baseline * flip, baseline);
  if (!b) return null;
  const k = keepScale ? 1 : Math.min(1, (W * 1.12 - 8) / b.width, (H - 8) / b.height);
  if (!(k > 0)) return null;
  const pose = { x: (W - b.width * k) / 2 - b.x * k, y: H - (b.y + b.height) * k,
    sx: baseline * k * flip, sy: baseline * k, k, vis: null, kind: keepScale ? "keepScale" : "bbox" };
  if (!keepScale) {
    pose.x += spineXoff * b.width * k * flip;
    return pose;
  }
  for (let iter = 0; iter < 10; iter += 1) {
    const s = sampleSpineFitAt(W, H, pose);
    if (!s) break; // 无可见像素：与 ordinary keepScale 同源的 bbox/push 终点。
    const m = 2;
    let moved = false;
    if (s.x0 <= m) { pose.x += (m - s.x0) + 6; moved = true; }
    else if (s.x1 >= W - m) { pose.x -= (s.x1 - (W - m)) + 6; moved = true; }
    if (s.y0 <= m) { pose.y += (m - s.y0) + 6; moved = true; }
    else if (s.y1 >= H - m) { pose.y -= (s.y1 - (H - m)) + 6; moved = true; }
    if (!moved) {
      pose.vis = s;
      pose.x += W / 2 - (s.x0 + s.x1) / 2;
      pose.y += H - s.y1;
      break;
    }
  }
  return pose;
}

function fitSpinePose(generation = spineFitGeneration, ownerGeneration = spineFitOwnerGeneration, owner = spineFitOwner) {
  seatExitForensicFitEvent("invoke");
  /* PROBE 3（EDGEDIAG）：仅打印紧跟一次 FACE 翻转（≤1500ms 短窗）的 fit；bbox 用原始 getBounds（不做 position 归零，零诊断副作用） */
  const diagEventAt = Math.max(lastFaceFlipAt, lastSeatExitAt); // face 翻转或 seat-exit 边沿任一（diagnostics-only 扩窗）
  const diagWin = EDGE_DIAG && diagEventAt > 0 && Date.now() - diagEventAt <= 1500
    ? { at: Date.now(), x: spineObj ? spineObj.x : null, y: spineObj ? spineObj.y : null,
      sx: spineObj ? spineObj.scale.x : null, sy: spineObj ? spineObj.scale.y : null, fig: Number(spineFigLeftCss.toFixed(1)) } : null;
  const emitFitDiag = (branch, extra) => {
    if (!diagWin) return;
    try {
      const c = spineObj && spineObj.state ? spineObj.state.getCurrent(0) : null;
      const bb = spineObj ? spineObj.getBounds() : null;
      window.petAPI.playback("[EDGEDIAG] FIT " + JSON.stringify(Object.assign({
        ts: Date.now(), turnId: diagEdgeFitId(), deltaMsFromFace: Date.now() - diagEventAt, eventKind: lastSeatExitAt > lastFaceFlipAt ? "seatExit" : "face", branch,
        generation, ownerMatch: spineRuntimeOwner === owner,
        xBefore: diagWin.x, yBefore: diagWin.y, scaleXBefore: diagWin.sx, scaleYBefore: diagWin.sy,
        xAfter: spineObj ? Number(spineObj.x.toFixed(2)) : null, yAfter: spineObj ? Number(spineObj.y.toFixed(2)) : null,
        spineLocalXBefore: diagWin.x, spineLocalYBefore: diagWin.y, spineLocalXAfter: spineObj ? Number(spineObj.x.toFixed(2)) : null, spineLocalYAfter: spineObj ? Number(spineObj.y.toFixed(2)) : null, // 容器局部坐标显式别名（窗口坐标仅出现在 main 的 TURN 行）
        recenterDx: spineObj && Number.isFinite(diagWin.x) ? Number((spineObj.x - diagWin.x).toFixed(2)) : null,
        recenterDy: spineObj && Number.isFinite(diagWin.y) ? Number((spineObj.y - diagWin.y).toFixed(2)) : null,
        figLeftCssAtFitStart: diagWin.fig, figLeftCssAtFitEnd: Number(spineFigLeftCss.toFixed(1)), // 可见左缘 CSS 位置：fit 前后的回中直接读数
        scaleXAfter: spineObj ? Number(spineObj.scale.x.toFixed(5)) : null, scaleYAfter: spineObj ? Number(spineObj.scale.y.toFixed(5)) : null,
        bbox: bb ? { x: Number(bb.x.toFixed(1)), y: Number(bb.y.toFixed(1)), w: Number(bb.width.toFixed(1)), h: Number(bb.height.toFixed(1)) } : null,
        visibleCanvasGap, anim: c && c.animation ? c.animation.name : "?",
        trackTime: c && Number.isFinite(c.trackTime) ? Number(c.trackTime.toFixed(3)) : null
      }, extra || {})));
    } catch { /* 诊断发射失败忽略 */ }
  };
  try {
    if (!spineObj || !spineApp || activeRenderMode !== "spine" || spineRuntimeOwner !== owner || generation !== spineFitGeneration || ownerGeneration !== activeRenderGeneration) { fitBootstrapCheck(false); emitFitDiag("abort-guard"); return; }
    if (seatEpisode.active && seatEpisode.owner === spineObj && seatTrackActive()) {
      seatEpisode.pendingFit = true;
      fitBootstrapCheck(false);
      emitFitDiag("hold-seat");
      return;
    }
    let W = spineApp.screen.width, H = spineApp.screen.height;
    const flip = walkState.face === -1 ? -1 : 1;
    const baseline = Math.abs(spineBaseScaleX);
    // active 期不临时清零 actual Y；任何 invalid-bounds/throw 都不能绕过 limiter。
    const seatYActive = seatExitYOwnsY();
    const bboxBounds = () => spineFitBoundsAtScale(spineObj.scale.x, spineObj.scale.y);
    // 像素采样：可见轮廓（在给定定位状态下）
    const sample = () => {
      try {
        const rt = PIXI.RenderTexture.create({ width: Math.ceil(W), height: Math.ceil(H) });
        spineApp.renderer.render(spineObj, { renderTexture: rt, clear: true });
        const px = spineApp.renderer.extract.pixels(rt);
        const pw = rt.width, ph = rt.height, fx = W / pw, fy = H / ph, step = 4, thr = 32;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < ph; y += step) for (let x = 0; x < pw; x += step) {
          if (px[(y * pw + x) * 4 + 3] > thr) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        rt.destroy(true);
        return x1 >= 0 ? { x0: x0 * fx, x1: (x1 + step) * fx, y0: y0 * fy, y1: (y1 + step) * fy } : null;
      } catch { return null; }
    };
    // 包围盒粗定位（居中+贴地），返回当前可见轮廓
    const bboxPosition = () => {
      const b = bboxBounds();
      if (!b) return null;
      spineObj.x = (W - b.width) / 2 - b.x;
      if (!seatYActive) spineObj.y = H - (b.y + b.height);
      spineObj.updateTransform();
      return b;
    };

    // ---- 自动适配过的皮肤：固定缩放 + 可见轮廓定位 ----
    if (spineFitKeepScale) {
      const placement = measureSpineFitPlacement(true);
      if (!placement) { fitBootstrapCheck(false); emitFitDiag("invalid-bbox"); return; }
      spineObj.scale.set(placement.sx, placement.sy);
      spineObj.x = placement.x;
      if (!seatYActive) spineObj.y = placement.y;
      const vis = placement.vis;
      spineFigLeftCss = vis && petEl ? petEl.offsetLeft + vis.x0 * (petEl.clientWidth / Math.max(1, W)) : (petEl ? petEl.offsetLeft : 0);
      if (seatYActive) seatYMeasureTarget("fit-keepScale", placement);
      let keepDiag = null; // FIT keepScale 稳态 offset 读数：只用本拍已算好的 vis，零新增 sample
      if (EDGE_DIAG && vis) {
        try { const pb = spineObj.getBounds(); keepDiag = { visBottom: Number(vis.y1.toFixed(2)), bboxBottomPreAnchor: Number((pb.y + pb.height).toFixed(2)), visibleBottomOffset: Number((vis.y1 - (pb.y + pb.height)).toFixed(2)) }; } catch { /* 忽略 */ }
      }
      emitFitDiag("keepScale", Object.assign({ k: null, base: Number(spineBaseScaleX.toFixed(5)) }, keepDiag || {}));
      fitBootstrapCheck(true); // keepScale 权威基线已写回并定位：可以首见
      reportGroundGap();
      scheduleGeometryReport();
      return;
    }

    // ---- 未适配皮肤：先做适配决策 ----
    // 适配测量必须在“无包围盒守卫”（k=1 基准）下进行：宽包围盒模型被守卫折叠后测量会被污染。
    // 手动 boost 皮肤（boostTable 命中，如迷迭香第三皮肤）不参与自动放大——
    // 宽模型按高度放大后宽度会超画布，曾导致腿/侧边裁剪、行走错位；保持手动缩放 + 高度画布容纳。
    if (!spineAutoScaled && !spineManual) {
      spineObj.scale.set(baseline * flip, baseline);
      bboxPosition();
      const v = sample();
      if (v && ++spineFitStableHits >= 2 && (v.y1 - v.y0) < H * 0.75) {
        const visH = v.y1 - v.y0, visW = v.x1 - v.x0;
        const aspect = visH > 10 ? visW / visH : 1;
        const kkH = H * 0.85 / visH;
        const kkW = W * 0.85 / visW;
        // 宽度受限（宽模型）不再加宽画布——加宽 pet 元素会盖住左侧气泡（聊天框异常）；
        // 按高度目标放大，宽度不足部分维持原样（稳定优先）。
        const kk = Math.min(5, Math.max(1, Math.min(kkH, kkW)));
        if (kk > 1.05) {
          spineBaseScaleX *= kk;
          spineAutoScaled = true;
          spineFitKeepScale = true;
          // A-v2：新权威 baseline 落地即同步活跃的坐姿棘轮快照，
          // 防 seatContainmentCommit（只降不升的 min(previousScale,entryScale) 上限）把放大到位的 scale 拉回旧 baseline。
          if (seatEpisode.active && seatEpisode.owner === spineObj) {
            if (window.SeatFit) window.SeatFit.seatRatchetSync(seatEpisode, spineBaseScaleX);
            else { seatEpisode.entryScale = Math.abs(spineBaseScaleX); seatEpisode.previousScale = seatEpisode.entryScale; }
          }
          try { window.petAPI.playback && window.petAPI.playback(`[spine] 自动适配 vis=${Math.round(visH)}px → ×${kk.toFixed(2)} (aspect=${aspect.toFixed(2)}) dir=${relDirOf()}`); } catch { /* 忽略 */ }
          fitSpinePose(generation, ownerGeneration, owner);
          return;
        }
      }
    }

    // ---- 常规显示（未适配/无需适配）：包围盒守卫缩放 + 定位 + 贴地空隙 ----
    {
      const placement = measureSpineFitPlacement(false);
      if (!placement) { fitBootstrapCheck(false); emitFitDiag("invalid-bbox"); return; }
      // §14 追加 105：宽度约束放宽 12% 余量（高度仍严格）——坐姿/Relax 等姿势包围盒略超宽（实测 125 > 120）
      // 时不会被整体缩小 10%；可见主体居中的模型横向透明区足以容纳，日常站姿（bbox 更窄）完全不受影响。
      const k = placement.k;
      // §14 追加 105 诊断（限频）：守卫发生缩小（k<1）时记录姿势/包围盒，定位"坐下缩小"问题
      if (k < 0.97) {
        const _now = Date.now();
        if (_now - (window.__spineGuardLogAt || 0) > 500) {
          window.__spineGuardLogAt = _now;
          let _anim = "?";
          try { _anim = typeof spinePhaseAnim === "function" ? spinePhaseAnim() : "?"; } catch { /* 忽略 */ }
          try { window.petAPI.playback && window.petAPI.playback(`[spine] guard k=${k.toFixed(3)} base=${baseline.toFixed(3)} anim=${_anim} W=${W} H=${H}`); } catch { /* 忽略 */ }
        }
      }
      spineObj.scale.set(placement.sx, placement.sy);
      spineObj.x = placement.x;
      if (!seatYActive) spineObj.y = placement.y;
      if (seatYActive) seatYMeasureTarget("fit-normal", placement);
      const b2 = spineObj.getBounds();
      // v2.5.22c 诊断（低频）：睡觉时确认贴底值——排查"睡眠悬浮/陷入"（isSleeping 时记录）
      if (isSleeping && Date.now() - (window.__sleepFitLogAt || 0) > 2000) {
        window.__sleepFitLogAt = Date.now();
        try {
          window.petAPI.playback && window.petAPI.playback(`[spine] sleep-fit bbox=${Math.round(b2.width)}x${Math.round(b2.height)} bottomY=${Math.round(b2.y + b2.height)} H=${Math.round(H)} y-offset=${Math.round(H - (b2.y + b2.height))}`);
        } catch { /* 忽略 */ }
      }
      const v2 = sample();
      if (v2) {
        const vy1 = v2.y1;
        const sampledGap = Math.max(0, Math.min(24, Math.round(H - vy1)));
        if (sampledGap <= 12) {
          if (Math.abs(sampledGap - visibleCanvasGapCandidate) <= 3) visibleCanvasGapHits += 1;
          else { visibleCanvasGapCandidate = sampledGap; visibleCanvasGapHits = 1; }
          if (visibleCanvasGapHits >= 2) visibleCanvasGap = visibleCanvasGapCandidate;
        } else { visibleCanvasGapHits = 0; }
      }
      emitFitDiag("normal", { k: Number(k.toFixed(5)), guardShrank: k < 0.999 });
      fitBootstrapCheck(spineManual || (v2 ? ((v2.y1 - v2.y0) >= H * 0.75) : false)); // manual/已够高的皮肤 guard pass 完成即可首见；短轮廓等待 autoScale 决断
    }
  } catch { /* 测量失败不影响渲染 */ }
  reportGroundGap();
  scheduleGeometryReport();
}

function relDirOf() {
  try {
    const segs = decodeURIComponent((spinePaths.skel || "")).split("/");
    const uIdx = segs.lastIndexOf("user");
    return segs.find((p) => /^\d{3,4}_/.test(p)) || (uIdx >= 0 && segs[uIdx + 1] ? segs[uIdx + 1] : "builtin");
  } catch { return "?"; }
}

/** 上报角色脚底到窗口底边的空隙（宠物元素悬浮在输入栏上方导致），
 *  主进程贴地吸附时用它把窗口下探相应距离，让脚真正踩在任务栏/图标上。
 *  GIF 使用 CSS zoom 后的 visual DOM rect；Spine 保留原有布局/画布补偿。 */
let visibleCanvasGap = 0;
let visibleCanvasGapCandidate = 0;
let visibleCanvasGapHits = 0;
let geometryReportTimer = null;
function nextGifGeometryRevision() {
  gifGeometryRevision += 1;
  return gifGeometryRevision;
}
function geometryReportContextCurrent(context) {
  if (!context) return true;
  return activeRenderMode === context.mode &&
    activeRenderGeneration === context.renderGeneration &&
    (context.mode !== "gif" || gifGeometryRevision === context.geometryRevision);
}
function reportGroundGap(context = null) {
  try {
    if (!petEl || !document.documentElement || !geometryReportContextCurrent(context)) return;
    if (activeRenderMode !== "gif" && activeRenderMode !== "spine") return;
    const insetRaw = spineFitKeepScale && spineFigLeftCss > 0
      ? spineFigLeftCss // 自动适配皮肤：角色可见左缘（画布已按宽比加宽，元素左缘 ≠ 角色左缘）
      : Number(petEl.offsetLeft) || 0;
    const inset = Math.max(0, Math.min(document.documentElement.clientWidth || 260, Math.round(insetRaw))); // 左边界补偿：角色条带不可能超出窗口宽，用 clientWidth 作上限（异常上报会把行走左边界扩到屏幕外导致角色“闪现”出屏）
    const gap = activeRenderMode === "gif"
      ? Math.max(0, Math.min(80, Math.round((window.innerHeight - petEl.getBoundingClientRect().bottom) * 100) / 100))
      : Math.max(0, Math.min(80, Math.round(((document.documentElement.clientHeight || 0) - ((Number(petEl.offsetTop) || 0) + (Number(petEl.offsetHeight) || 0)) + visibleCanvasGap))));
    const reportMeta = {
      sourceMode: activeRenderMode,
      renderGeneration: activeRenderGeneration,
      docEpoch: petDocEpoch // F6：main 侧据此跨文档换代（旧纪元晚到包拒收、新纪元首包必收）
    };
    if (activeRenderMode === "gif") reportMeta.geometryRevision = gifGeometryRevision;
    window.petAPI.setGroundGap(gap, reportMeta);
    window.petAPI.setCharInset && window.petAPI.setCharInset(inset);
  } catch { /* 忽略 */ }
}
function scheduleGeometryReport() {
  cancelAnimationFrame(scheduleGeometryReport.raf || 0);
  clearTimeout(geometryReportTimer);
  const context = {
    mode: activeRenderMode,
    renderGeneration: activeRenderGeneration,
    geometryRevision: gifGeometryRevision
  };
  scheduleGeometryReport.raf = requestAnimationFrame(() => {
    if (!geometryReportContextCurrent(context)) return;
    reportGroundGap(context);
    if (context.mode !== "gif") {
      geometryReportTimer = setTimeout(() => reportGroundGap(context), 120);
    }
  });
}

/** 行走朝向：face=-1 时镜像翻转（假设模型原始朝右；若实际相反改此处符号即可）
 *  注意：fitSpinePose 可能已按姿势 containment 缩小 scale（mag < spineBaseScaleX），
 *  翻转必须保持等比——以当前 scale.y 的绝对值为基准，只改符号，否则会左右拉伸。 */
/** EDGEDIAG 主因修复：scale.x 镜像的同帧轻量 recenter。
 *  镜像使骨骼包围盒相对物体原点左右翻转（bbox.x 变、宽不变），fit 首拍（~150ms）前出现
 *  约 2×|bbox 偏心|（实测 17~22px）的视觉跳变。此处只做 normal 分支同款 bbox 水平居中
 *  一步：不重算 k/scale、不动 y/scale、不采样、不发 reportGroundGap、不排 timer、不碰
 *  generation——150/500/1000ms 的 scheduleFitSpine 窗口照旧完成可见主体（vis/spineXoff）
 *  精居中，本函数只消灭第一帧的错位。 */
function mirrorRecentreImmediate() {
  try {
    if (!spineApp || !spineObj) return;
    spineObj.updateTransform(); // scale 已翻转：先同步世界矩阵，再读镜像后的 bbox（raw getBounds，无 fit 副作用）
    const W = spineApp.screen.width;
    const b = spineObj.getBounds();
    if (!(b.width > 0) || !(b.height > 0)) return;
    const nx = spineObj.x + (W - b.width) / 2 - b.x; // 与 fit normal 分支同一 bbox 居中公式（对当前 x 平移不变）
    if (Number.isFinite(nx) && Math.abs(nx - spineObj.x) > 0.01) {
      spineObj.x = nx;
      spineObj.updateTransform();
    }
  } catch { /* 立即 recenter 失败无碍：后续 fit 窗口照旧收敛（原行为） */ }
}
function spineFaceDir(face) {
  if (!spineObj) return;
  const sy = Math.abs(spineObj.scale.y);
  const sx = sy * (face === -1 ? -1 : 1);
  if (spineObj.scale.x !== sx) {
    const oldSign = spineObj.scale.x < 0 ? -1 : 1;
    const diagBoundsBefore = EDGE_DIAG ? sdRawBounds() : null;
    spineObj.scale.x = sx;
    mirrorRecentreImmediate(); // 镜像同帧 bbox 回中（EDGEDIAG TOP 修复；bounds 快照仍记录纯镜像位移供诊断）
    if (EDGE_DIAG) { // PROBE 2：face 确实翻转（scale.x 符号变）才打；记录翻转后、scheduleFitSpine 前的 spine-local x/y（非窗口坐标）
      lastFaceFlipAt = Date.now();
      try {
        const c = spineObj.state ? spineObj.state.getCurrent(0) : null;
        const bb = sdRawBounds();
        window.petAPI.playback("[EDGEDIAG] FACE " + JSON.stringify({
          ts: lastFaceFlipAt, turnId: diagEdgeFaceId(), oldFace: oldSign, newFace: face,
          spineLocalX: Number(spineObj.x.toFixed(2)), spineLocalY: Number(spineObj.y.toFixed(2)),
          x: Number(spineObj.x.toFixed(2)), y: Number(spineObj.y.toFixed(2)), // 兼容别名：spineObj.x/y=容器局部坐标（窗口坐标只在 TURN 行的 windowX/bounds* 出现）
          immediateRecentre: true, // 本行 spineLocalX 已是"镜像+立即 bbox 回中"后的读数；mirrorShiftX（修复前跳变量）=mirrorBoundsAfter.x−mirrorBoundsBefore.x
          scaleXBefore: Number((sy * oldSign).toFixed(5)), scaleXAfter: Number(spineObj.scale.x.toFixed(5)),
          scaleY: Number(sy.toFixed(5)), spineXoff: Number(spineXoff.toFixed(4)),
          keepScale: !!spineFitKeepScale,
          xoffPx: bb ? Number((spineXoff * bb.width).toFixed(2)) : null, // xoff 项镜像偏移量（预测跳变=2×此值+vis 中心偏移，离线计算）
          mirrorBoundsBefore: diagBoundsBefore, mirrorBoundsAfter: bb, // 同空间 raw getBounds 前后快照：mirrorShiftX=After.x-Before.x（纯"只翻转不 recenter"的直接读数——bb 为回中后 bbox，其 x 差仍含立即回中量；诊断对照 FIT recenterDx≈0 即证修复生效）
          anim: c && c.animation ? c.animation.name : "?", trackTime: c && Number.isFinite(c.trackTime) ? Number(c.trackTime.toFixed(3)) : null
        }));
      } catch { /* 诊断发射失败忽略 */ }
    }
    scheduleFitSpine({}); // 翻转后包围盒镜像，主体偏移方向也跟着反，需重新居中
  }
}

/** 当前皮肤的坐下动画名。
 *  优先"坐姿待机循环"（明日方舟皮肤惯例：Sitd=坐定循环，Sit=坐下过渡动作——
 *  循环播过渡动作会反复"正在坐下"，位置姿态都怪异，winter 皮肤悬空坐根因），
 *  其次精确 Sit/sit，最后按名字分类器兜底（Sit01/sit_down 等）。
 *  返回 null = 该皮肤没有可播的坐姿动画——主进程据此不做坐姿下沉。 */
function sitAnimName() {
  const exact = ["Sitd", "sitd", "Sit", "sit"].find((n) => spineHas(n));
  if (exact) return exact;
  const cls = ensureAnimClasses();
  if (cls && cls.sit) {
    const hold = cls.sit.find((n) => /d$/i.test(n)) || cls.sit.find((n) => /idle|loop|hold/i.test(n));
    if (hold) return hold;
    return cls.sit[0] || null;
  }
  return null;
}
/** 皮肤加载/重建后上报是否有坐下动画（主进程 applySeatPosition 依赖此标志） */
function reportHasSit() {
  try { window.petAPI.setHasSit && window.petAPI.setHasSit(!!sitAnimName()); } catch { /* 忽略 */ }
}
/** 当前应播放的移动相位动画：坐/窗顶→Sit，地面放松→待机（Relax），走动→Move。
 *  注意必须认识 seated：抛掷落地后 playSpineInteract/onDropped 用本函数恢复动画，
 *  若只认 perched 会在坐姿下沉窗口上恢复站姿（"脚陷进任务栏，点一下才好"根因）。 */
function spinePhaseAnim() {
  if (!walkState.active) return null;
  if (walkState.seated || walkState.perched) {
    const sn = sitAnimName();
    if (sn) return sn;
  }
  if (walkState.paused) return spineAnimForMood("idle"); // 暂停中（单击互动/拖拽）：站立待机，不挂走路动画
  if (!walkState.resting) {
    if (spineHas("Move")) return "Move";
    const cls = ensureAnimClasses(); // 未知模型：按动画名模式归类出「移动类」
    if (cls && cls.move && cls.move[0]) return cls.move[0];
  }
  return spineAnimForMood("idle");
}

/** talking-slide invariant 谓词：live locomotion=行走引擎主动位移相位（走动中，非休息/坐姿/窗顶/暂停）。
 *  live locomotion 时 Spine track0 归行走相位机所有（spinePhaseAnim 唯一来源），普通 mood
 *  不得把 track0 抢成非 locomotion 动画——否则出现"站立/说话姿势+窗口继续平移"=滑步。 */
function isLiveLocomotion() {
  return walkState.active && !walkState.resting && !walkState.seated && !walkState.perched && !walkState.paused && !walkState.sleeping; // sleeping 计入（真机回归：main walkTick `resting||sleeping` 停位移；漏判会把睡姿锁死在 Move 空走）
}

/** T3 判据①：locomotion 生命周期 = 行走引擎仍持有 track0 生命周期（含临时暂停/原地立定）。
 *  active=true 的一切相位（走动/chat-pause/poke-pause/stop-idle 立定）都算；
 *  引擎停止后（active=false）或坐/窗顶/睡→不属于 locomotion，mood 语义完全照旧。 */
function isLocomotionLifecycle() {
  return walkState.active && !walkState.seated && !walkState.perched && !walkState.sleeping;
}
/** T3 判据②：候选动画是否"静态兜底"——恰好等于 spineData.animations[0] 且其解析后 duration≤0
 *  （bundled sussurro 资产 bytes：animationCount=0x06 后首名 "Default"，len+1 变体 0x08、
 *   单条 type5、frame time 0x00000000 ⇒ duration 0 = setup 静态姿势）。
 *  runtime 未提供 duration（老数据/异常）按"非静态"放行——只挡实证冻结形态，不做名字特判。 */
function isStaticFallbackAnim(name) {
  if (!spineObj || !spineObj.spineData || !name) return false;
  const first = spineObj.spineData.animations && spineObj.spineData.animations[0];
  if (!first || first.name !== name) return false;
  return typeof first.duration === "number" && Number.isFinite(first.duration) ? first.duration <= 0 : false;
}

/* ---------- 动画名自动分类（借鉴 Ark-Pets AnimType）：未知模型也能选对动画 ---------- */
const ANIM_PATTERNS = [
  ["move", /move|walk|run|step/i],
  ["sleep", /sleep|nap/i],
  ["sit", /sit/i],
  ["interact", /interact|click|touch|pat|greet/i],
  ["idle", /idle|relax|stand|breathe|wait/i]
];
let spineClassified = null;
function ensureAnimClasses() {
  if (spineClassified || !spineObj) return spineClassified;
  const out = {};
  for (const a of spineObj.spineData.animations) {
    for (const [cls, re] of ANIM_PATTERNS) {
      if (re.test(a.name)) { (out[cls] = out[cls] || []).push(a.name); break; }
    }
  }
  spineClassified = out;
  return out;
}

// 情绪 → Spine 动画名映射（Spine 模型中的动画名可能不同于 GIF 名）。
// 坐下系动画（Sit/sit/cls.sit）只在行走坐姿/窗顶状态下可用——
// 否则"思考"等情绪会在站立窗口上播坐姿，下半身超出画布被任务栏切掉（"半条腿不见"）
function isSitClassAnim(name) { return /(^|[^a-z])sit/i.test(String(name || "")); }
function spineAnimForMood(mood) {
  const seatedNow = walkState.seated || walkState.perched;
  // 尝试精确匹配
  if (spineObj && spineObj.spineData.animations.find(a => a.name === mood)) return mood;
  // 动画名自动分类兜底（未知模型）：按归类结果直接选
  const cls = ensureAnimClasses();
  if (cls && !spineHas("Relax")) { // 已知模型走下面的映射表；未知模型用分类结果
    if (mood === "idle" && cls.idle && cls.idle[0]) return cls.idle[0];
    if ((mood === "sleep") && cls.sleep && cls.sleep[0]) return cls.sleep[0];
    if ((mood === "wave" || mood === "surprised") && cls.interact && cls.interact[0]) return cls.interact[0];
    if ((mood === "think") && seatedNow && cls.sit && cls.sit[0]) return cls.sit[0];
    if (cls.idle && cls.idle[0]) return cls.idle[0];
  }
  // 常见映射（明日方舟基建模型只有 Relax/Move/Interact，情绪统一回退 Relax）
  const map = {
    idle: ["Relax", "Idle", "idle", "animation", "stand"],
    happy: ["happy", "Happy", "Relax"],
    think: ["think", "Think", "Sit", "Relax"],
    sleep: ["Sleep", "Sleepd", "sleep", "Sit", "Relax"], // Sleepd：明日方舟 d 后缀循环惯例（winter 皮肤无 "Sleep"，缺此候选会兜底 Relax 站姿入睡）
    wave: ["wave", "Wave", "Interact"],
    angry: ["angry", "Angry", "Relax"],
    surprised: ["surprise", "Surprised", "Interact"],
  };
  const candidates = (map[mood] || [mood]).filter((c) => seatedNow || !isSitClassAnim(c));
  for (const c of candidates) {
    if (spineObj && spineObj.spineData.animations.find(a => a.name === c)) return c;
  }
  // 回退到第一个可用动画
  if (spineObj && spineObj.spineData.animations.length > 0) {
    return spineObj.spineData.animations[0].name;
  }
  return null;
}

function seatTrackActive() {
  if (!spineObj || !spineObj.state) return false;
  const cur = spineObj.state.getCurrent(0);
  const sit = sitAnimName();
  return !!sit && !!cur && !!cur.animation && cur.animation.name === sit;
}
function seatContainmentCommit() {
  if (seatExitYOwnsY()) return false; // 最后一道单 writer 守卫；正常 Sit entry 已先 handoff。
  if (!spineObj || !spineApp || !seatTrackActive() || !seatEpisode.active || seatEpisode.owner !== spineObj) return false;
  const W = spineApp.screen.width, H = spineApp.screen.height;
  let b = spineObj.getBounds();
  if (!(Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0)) return false;
  const beforeScale = Math.abs(spineObj.scale.y);
  const maxScale = Math.min(seatEpisode.previousScale || beforeScale, seatEpisode.entryScale || beforeScale);
  let candidateScale = Math.min(beforeScale, maxScale);
  const safeW = Math.max(1, W - 4), safeH = Math.max(1, H - 4);
  const shrink = Math.min(b.width > safeW ? safeW / b.width : 1, b.height > safeH ? safeH / b.height : 1);
  if (shrink < 1) candidateScale *= shrink;
  if (candidateScale > maxScale) candidateScale = maxScale;
  // Ignore sub-pixel/rasterization noise at the edge; correcting a 1px bound
  // fluctuation every frame would visibly oscillate the whole seated pose.
  const edgeTolerance = 2;
  if (candidateScale < beforeScale - 1e-6) {
    const sign = spineObj.scale.x < 0 ? -1 : 1;
    spineObj.scale.set(sign * candidateScale, candidateScale);
    spineObj.updateTransform();
    b = spineObj.getBounds();
  }
  const dx = b.x < -edgeTolerance ? -b.x : b.x + b.width > W + edgeTolerance ? W - (b.x + b.width) : 0;
  const dy = b.y < -edgeTolerance ? -b.y : b.y + b.height > H + edgeTolerance ? H - (b.y + b.height) : 0;
  if (dx || dy) { spineObj.x += dx; spineObj.y += dy; }
  if (candidateScale < beforeScale - 1e-6 || dx || dy) spineObj.updateTransform();
  seatEpisode.previousScale = candidateScale;
  return true;
}
/* ===== Phase 2：seat-exit local-Y ownership（Y 唯一 writer=limiter；fit 只发现/重瞄 target；X 即时照旧） =====
 * 不变量：
 *  1) token active 时，任何 fit/poke/watchdog 路径都不得对 spineObj.y 单帧大步锚定；只有 ticker
 *     的 limiter 按限速步长推进（长帧双保险：dt clamp + 每帧硬帽）。
 *  2) token 绑定 spineObj owner + activeRenderGeneration；owner 重建/mode 切换 hard-drop（场景重建）。
 *  3) 正常释放 = 当前 entry 的 final authority 有效且连续收敛；TTL 只复测，不交出 residual。
 *  4) ARM 只允许真实 Sit source → live Move 或有资源的 Sleep，诊断开关不参与决策。 */
const SEAT_EXIT_Y_SPEED = 150;
const SEAT_EXIT_Y_MAX_DT = 0.05;
const SEAT_EXIT_Y_STEP_CAP = 6;
const SEAT_EXIT_Y_EPS = 0.4;
const SEAT_EXIT_Y_VIS_EPS = 4; // keepScale 的一个采样网格；normal 仍保持 subpixel bbox 容差。仅用于 RT/authority 量化稳定判断。
const SEAT_EXIT_Y_HANDOFF_EPS = 0.25; // 严格交接阈（≈0.25 DIP）：FAST 每帧更新绕开 MEASURE_EPS，但 release 只认这个
const SEAT_EXIT_Y_CONVERGE_FRAMES = 3;
const SEAT_EXIT_Y_TTL_MS = 1200; // watchdog 周期，不是 release permission。
const SEAT_EXIT_Y_RETRY_MS = 150; // ticker 上的失败重试节流，不创建 timer/逐帧 RT。
let seatExitY = null;
const seatExitYOwnsY = () => !!(seatExitY && seatExitY.owner === spineObj && seatExitY.ownerGen === activeRenderGeneration);
function isSeatExitMoveTarget(cur, state) {
  if (!state.active || state.seated || state.perched || state.resting || state.paused || state.sleeping) return false;
  const move = spineHas("Move") ? "Move" : ensureAnimClasses()?.move?.[0];
  return !!move && cur?.animation?.name === move;
}
function isSeatExitSleepTarget(cur) {
  const name = cur?.animation?.name;
  return walkState.sleeping === true && !!name && !!ensureAnimClasses()?.sleep?.includes(name) &&
    name === spineAnimForMood("sleep");
}
function seatYDiag(ev, extra) {
  if (!EDGE_DIAG) return;
  try {
    const t = seatExitY;
    window.petAPI.playback("[SEATYDIAG] " + JSON.stringify(Object.assign({
      ts: Date.now(), ev, ownerGen: activeRenderGeneration,
      sourceAnim: t ? t.sourceName : null, targetAnim: t ? t.targetName : null,
      currentY: spineObj ? Number(spineObj.y.toFixed(2)) : null,
      targetY: t && t.hasTarget && Number.isFinite(t.targetY) ? Number(t.targetY.toFixed(2)) : null,
      deltaY: t && t.hasTarget && spineObj && Number.isFinite(t.targetY) ? Number((t.targetY - spineObj.y).toFixed(2)) : null
    }, extra || {})));
  } catch { /* 诊断忽略 */ }
}
/* FAST per-frame pose target（cheap、零 RenderTexture）：复用 spineFitBoundsAtScale 的只读坐标权威。
 * 以"姿势内底边偏移" poseBottomRel = bboxBottom − y（平移不变）定义锚：anchor = H − poseBottomRel。
 * 与 measureSpineFitPlacement 的 bbox 分支同一坐标体系，不自行猜 worldBounds.bottom−y。 */
function fastPoseTargetY() {
  if (!spineObj || !spineApp) return null;
  const t0 = performance.now();
  try {
    const b = spineFitBoundsAtScale(spineObj.scale.x, spineObj.scale.y); // 原点相对 bbox（spineFitBoundsAtScale 的既有坐标约定）
    if (!b || !(b.height > 0) || !(b.width > 0)) return null;
    const bottomLocal = b.y + b.height; // 平移不变：不含 spineObj.y
    if (!Number.isFinite(bottomLocal)) return null;
    const cost = performance.now() - t0;
    if (seatExitY) { seatExitY.perfMs += cost; seatExitY.perfN += 1; seatExitY.perfMaxMs = Math.max(seatExitY.perfMaxMs, cost); }
    return spineApp.screen.height - bottomLocal;
  } catch { return null; }
}
function releaseSeatExitY(reason) {
  const t = seatExitY;
  if (!t) return;
  if (SEAT_EXIT_FORENSIC) seatExitForensicRecord("release", {
    releaseReason: reason,
    releaseResidual: t.hasTarget && Number.isFinite(t.owner?.y) ? t.targetY - t.owner.y : null,
    finalAuthorityY: Number.isFinite(t.finalAuthorityY) ? t.finalAuthorityY : null
  });
  const y = t.owner?.y;
  seatYDiag("RELEASE", { reason, residual: t.hasTarget && Number.isFinite(y) ? t.targetY - y : null });
  seatYDiag("PERF_SUMMARY", { boundsSamples: t.perfN, boundsAvgMs: t.perfN ? Number((t.perfMs / t.perfN).toFixed(3)) : null, boundsMaxMs: Number(t.perfMaxMs.toFixed(3)) });
  seatExitY = null; // handoff 从不 finish-to-target。
  applyEcoFps("release"); // 释放即按真实业务状态复判 FPS（不硬编码 24/12）
}
function seatYSyncEntry(t, cur) {
  const changed = t.entry !== cur || t.animation !== cur?.animation || t.targetName !== cur?.animation?.name ||
    t.revision !== spineTrackRevision || (cur && cur.trackTime < t.trackTime);
  if (changed) {
    t.entry = cur; t.animation = cur?.animation; t.targetName = cur?.animation?.name || null;
    t.revision = spineTrackRevision; t.prevMixing = !!cur?.mixingFrom;
    t.awaitingPose = cur?.nextTrackLast === -1;
    // 冻结的 final authority 绝不跨到新动画；fast baseline/correction 随姿势体系作废重建
    t.finalAuthorityValid = false; t.finalAuthorityY = null; t.visibleCorrectionY = null; t.fastBaseY = null;
    t.sawFinalReaim = false; t.needsMeasure = true; t.converged = 0;
  }
  t.trackTime = cur?.trackTime;
  return changed;
}
// 成功返回前才确认 final；失败保留旧 target，同时撤销 release permission。
// placement 可复用 fit 已求出的同源 authority，避免同一 pass 重复 RT。
function seatYMeasureTarget(kind, placement = null) {
  if (!seatExitYOwnsY() || !spineApp) return false;
  const t = seatExitY, cur = spineObj.state.getCurrent(0);
  seatYSyncEntry(t, cur);
  t.lastMeasureAt = Date.now();
  try {
    if (!cur || cur.nextTrackLast === -1) throw new Error("unapplied-entry");
    const p = placement || measureSpineFitPlacement();
    if (!p || !Number.isFinite(p.y)) throw new Error("invalid-fit-authority");
    const epsilon = p.kind === "keepScale" ? SEAT_EXIT_Y_VIS_EPS : SEAT_EXIT_Y_EPS;
    const fast = fastPoseTargetY();
    let newTarget = p.y;
    if (p.kind === "keepScale" && fast !== null) {
      const corr = p.y - fast; // visibleCorrectionY：同姿势下 RT authority 与 cheap bbox 快基线的小差
      t.visibleCorrectionY = corr;
      seatYDiag("VIS_CORRECTION", { kind, correction: Number(corr.toFixed(2)) });
      newTarget = fast + corr; // 当前姿势等价 p.y；此后只 fast 动、corr 保留（FAST-6）
    } else if (p.kind === "bbox") {
      t.visibleCorrectionY = 0; // normal：bbox 即 fast 权威，correction 恒 0，无需 RT
    }
    if (!t.hasTarget || Math.abs(t.targetY - newTarget) > epsilon) t.converged = 0;
    t.targetY = newTarget; t.epsilon = epsilon; t.hasTarget = true; t.needsMeasure = false;
    if (t.fastBaseY === null && fast !== null) t.fastBaseY = fast;
    if (!cur.mixingFrom) {
      // mix 已结束：freeze final authority——fast 停止跟踪 pose（Move 循环腿摆/尾巴不得被误补偿，§八）
      const firstFreeze = !t.finalAuthorityValid;
      t.finalAuthorityValid = true; t.finalAuthorityY = newTarget;
      if (firstFreeze) seatYDiag("FINAL_FREEZE", { kind, authority: Number(newTarget.toFixed(2)) });
      if (!t.sawFinalReaim) { t.sawFinalReaim = true; t.converged = 0; seatYDiag("MIX_END_REAIM", { kind }); }
    } else {
      t.finalAuthorityValid = false; t.finalAuthorityY = null; t.sawFinalReaim = false;
    }
    seatYDiag("TARGET", { kind, measurementKind: p.kind });
    return true;
  } catch {
    t.needsMeasure = true; t.sawFinalReaim = false; t.converged = 0;
    seatYDiag("MEASURE_FAIL", { kind });
    return false;
  }
}
function seatExitYTick(dtSec) {
  if (seatExitY && !seatExitYOwnsY()) {
    seatYDiag("HARD_DROP", { reason: "owner-or-generation-changed" });
    releaseSeatExitY("owner-or-generation-changed");
  }
  if (!spineObj || !spineObj.state) return;
  const cur = spineObj.state.getCurrent(0);
  const to = cur?.animation?.name;
  const mixingNow = !!cur?.mixingFrom;
  if (seatExitY && to === sitAnimName()) { releaseSeatExitY("seat-entry"); return; }
  if (!seatExitY) {
    const sit = sitAnimName();
    if (!mixingNow || !sit || cur.mixingFrom.animation?.name !== sit ||
        (!isSeatExitMoveTarget(cur, walkState) && !isSeatExitSleepTarget(cur))) return;
    pokeFeedbackGen += 1; // arm 前已排队的绝对 Y 回调永久失效，release 后也不复活。
    seatExitY = { owner: spineObj, ownerGen: activeRenderGeneration, sourceName: sit, targetY: spineObj.y,
      hasTarget: false, sawFinalReaim: false, converged: 0, watchdogAt: Date.now(), lastDiagAt: 0,
      fastBaseY: null, visibleCorrectionY: null, finalAuthorityValid: false, finalAuthorityY: null,
      fastDiagAt: 0, perfMs: 0, perfN: 0, perfMaxMs: 0 };
    seatYDiag("ARM", {});
    seatYMeasureTarget("arm");
    applyEcoFps("arm"); // ownership 生效即抬 60fps（不等 4s 巡检），提高 fast 补偿的时间采样密度
    return;
  }
  const t = seatExitY, now = Date.now();
  const changed = seatYSyncEntry(t, cur);
  if (changed) seatYMeasureTarget("entry-change");
  else if (t.awaitingPose && cur?.nextTrackLast !== -1) {
    t.awaitingPose = false;
    seatYMeasureTarget("entry-applied");
  }
  else if (t.prevMixing && !mixingNow) seatYMeasureTarget("mix-end");
  else if (t.needsMeasure && now - t.lastMeasureAt >= SEAT_EXIT_Y_RETRY_MS) seatYMeasureTarget("retry");
  t.prevMixing = mixingNow;
  if (now - t.watchdogAt >= SEAT_EXIT_Y_TTL_MS) {
    t.watchdogAt = now;
    seatYDiag("TTL_RESIDUAL", { residual: t.hasTarget ? t.targetY - spineObj.y : null });
    if (now !== t.lastMeasureAt) seatYMeasureTarget("watchdog");
  }
  if (!t.hasTarget) return;
  // FAST：final 未冻结前每帧 cheap bbox；fastDelta 同帧补偿（不经 MEASURE_EPS、不占 residual cap），
  // residual = y − fastBase 不因基线平移被清空（§四）。冻结后 fast 停止——Move 循环动作不再被"补偿"。
  if (!t.finalAuthorityValid) {
    const fastY = fastPoseTargetY();
    if (fastY !== null) {
      if (t.fastBaseY === null) t.fastBaseY = fastY;
      const fastDelta = fastY - t.fastBaseY;
      if (fastDelta !== 0) spineObj.y += fastDelta;
      t.fastBaseY = fastY;
      if (t.visibleCorrectionY !== null) t.targetY = fastY + t.visibleCorrectionY; // composed last-wins
      if (EDGE_DIAG && now - t.fastDiagAt >= 50) { t.fastDiagAt = now;
        seatYDiag("FAST", { fastBaselineY: Number(fastY.toFixed(2)), visibleCorrectionY: t.visibleCorrectionY === null ? null : Number(t.visibleCorrectionY.toFixed(2)), composedTargetY: Number(t.targetY.toFixed(2)), dt: Number((dtSec || 0).toFixed(4)), boundsCostMs: t.perfN ? Number((t.perfMs / t.perfN).toFixed(3)) : null }); }
    }
  }
  const delta = t.targetY - spineObj.y;
  if (Math.abs(delta) <= SEAT_EXIT_Y_HANDOFF_EPS) { // 严格交接：3.55px 级残差绝不允许 release（FAST-8）
    const finalCurrent = cur && !mixingNow && t.entry === cur && t.finalAuthorityValid && t.sawFinalReaim && !t.needsMeasure;
    t.converged = finalCurrent ? t.converged + 1 : 0;
    if (t.converged >= SEAT_EXIT_Y_CONVERGE_FRAMES && now - (t.lastReleaseCheckAt || 0) >= SEAT_EXIT_Y_RETRY_MS) {
      // 交接边沿再做一次 branch-equivalent authority 复测，而非仅相信几帧前的样本
      t.lastReleaseCheckAt = now;
      const ok = seatYMeasureTarget("release-check");
      const within = ok && Number.isFinite(t.finalAuthorityY) && Math.abs(t.finalAuthorityY - spineObj.y) <= SEAT_EXIT_Y_HANDOFF_EPS;
      seatYDiag("HANDOFF_CHECK", { pass: within, authorityY: Number.isFinite(t.finalAuthorityY) ? Number(t.finalAuthorityY.toFixed(2)) : null, handoffEps: SEAT_EXIT_Y_HANDOFF_EPS });
      if (within) { seatYDiag("CONVERGED", {}); releaseSeatExitY("converged"); }
      else t.converged = 0;
    }
    return;
  }
  t.converged = 0;
  const dt = Math.max(0, Math.min(dtSec > 0 ? dtSec : 1 / 60, SEAT_EXIT_Y_MAX_DT));
  const step = Math.min(Math.abs(delta), SEAT_EXIT_Y_SPEED * dt, SEAT_EXIT_Y_STEP_CAP); // residual 只管 correction/终测小差
  if (step > 0.001) {
    spineObj.y += (delta > 0 ? 1 : -1) * step;
    if (EDGE_DIAG && now - t.lastDiagAt >= 100) { t.lastDiagAt = now; seatYDiag("STEP", { stepY: Number(step.toFixed(2)), dt: Number(dt.toFixed(4)), speed: SEAT_EXIT_Y_SPEED }); }
  }
}

function installSeatLifecycle() {
  if (!spineApp || !spineObj || seatLifecycle.ticker) return;
  const owner = spineObj;
  seatLifecycle.owner = owner;
  const ticker = (delta) => {
    if (SPEECH_DIAG) { diagTickerCallbackSeq += 1; diagLastTickerCallbackAt = performance.now(); } // 心跳A：任何守卫之前
    if (owner !== spineObj || seatLifecycle.ticker !== ticker || !spineObj) return;
    try {
      const dt = typeof delta === "number" ? delta / 60 : (Number.isFinite(delta?.deltaMS) ? delta.deltaMS / 1000 : 1 / 60);
      const forensicBefore = seatExitForensicBeforeFrame();
      if (SPEECH_DIAG) { diagSpineAdvanceSeq += 1; diagLastSpineAdvanceAt = performance.now(); } // 心跳B：过守卫、真正推进 spineObj.update 之前
      spineObj.update(dt);
      if (seatExitYOwnsY() && seatTrackActive()) releaseSeatExitY("seat-entry"); // 包括排队动画自动晋升。
      seatContainmentCommit();
      seatExitYTick(dt); // Phase2：Y limiter（update/containment 之后；token 不 active 时纯只读短路）
      seatExitForensicAfterFrame(dt, forensicBefore);
      if (EDGE_DIAG) offsetDiagTick(); // OFFSETDIAG：update 之后采，读的是本帧最终态
    } catch { /* 保持 Pixi 原有渲染链路 */ }
  };
  seatLifecycle.ticker = ticker;
  spineObj.autoUpdate = false;
  spineApp.ticker.add(ticker, spineApp.ticker, PIXI.UPDATE_PRIORITY.HIGH);
}
function uninstallSeatLifecycle() {
  if (seatLifecycle.ticker && spineApp?.ticker) spineApp.ticker.remove(seatLifecycle.ticker, spineApp.ticker);
  seatLifecycle.ticker = null; seatLifecycle.owner = null; seatLifecycle.lastSafe = null;
  seatEpisode.owner = null; seatEpisode.active = false; seatEpisode.entryScale = 0; seatEpisode.previousScale = 0; seatEpisode.finalFitDone = false; seatEpisode.pendingFit = false;
  if (seatExitY) releaseSeatExitY("lifecycle-teardown"); // token 随 owner 终结（内部已含 applyEcoFps 复判）
  applyEcoFps("uninstall"); // 对 spineApp=null 安全（helper 首行守卫）
}

function clearSpineLifecycleTimers() {
  spineFitTimers.forEach(clearTimeout);
  spineFitTimers = [];
  spineFitGeneration += 1;
  spineFitOwnerGeneration = 0;
  spineFitOwner = null;
  cancelAnimationFrame(scheduleGeometryReport.raf || 0);
  scheduleGeometryReport.raf = 0;
  clearTimeout(geometryReportTimer);
  geometryReportTimer = null;
  spineBootstrapDeferredWalk = null; // A-v2.2：owner 拆除即弃 staged（跨 owner 不污染）；re-entry 由 initSpine 重新 arm
  spineBootstrapPending = false;
  spineBootstrapOwner = null;
  if (spineBootstrapFailSafeTimer) { clearTimeout(spineBootstrapFailSafeTimer); spineBootstrapFailSafeTimer = null; }
  settleSpineBootstrapDone(); // A-v2.3：abandon 同样结算 done——旧 handler 的 ready await 绝不悬挂（其 superseded 复查会自行哑火）
}

function destroySpineOwner(owner) {
  if (!owner) return;
  const committed = spineRuntimeOwner === owner || spineApp === owner.app || spineObj === owner.obj;
  const pending = spinePendingOwner === owner;
  if (committed) {
    if (seatExitY?.owner === owner.obj) releaseSeatExitY("owner-destroyed");
    if (SEAT_EXIT_FORENSIC && seatExitForensicSession && (!seatExitForensicSession.owner || seatExitForensicSession.owner === owner.obj)) seatExitForensicFlush("owner-teardown");
    pokeFeedbackGen += 1; // 在移除 ticker / destroy 之前失效 delayed local-Y callbacks。
    clearSpineLifecycleTimers();
    uninstallSeatLifecycle();
    if (spineObj === owner.obj) spineObj = null;
    if (spineApp === owner.app) spineApp = null;
    if (spineRuntimeOwner === owner) spineRuntimeOwner = null;
  }
  if (pending) spinePendingOwner = null;
  try { if (owner.obj) owner.obj.destroy(); } catch { /* 忽略 */ }
  try { if (owner.app && owner.app.ticker) owner.app.ticker.stop(); } catch { /* 忽略 */ }
  unbindCtxLost(owner.view);
  if (owner.view && owner.view.parentNode) owner.view.parentNode.removeChild(owner.view);
  try { if (owner.app) owner.app.destroy(false, { children: true, texture: false, baseTexture: false }); } catch { /* 忽略 */ }
  owner.obj = null;
  owner.app = null;
  owner.view = null;
}

function teardownSpineRuntime() {
  if (spineRuntimeOwner) {
    destroySpineOwner(spineRuntimeOwner);
  }
  if (spinePendingOwner && spinePendingOwner !== spineRuntimeOwner) destroySpineOwner(spinePendingOwner);
  if (spineApp || spineObj) destroySpineOwner({ app: spineApp, obj: spineObj, view: spineApp && spineApp.view });
}

async function initSpine(context) {
  const owner = { context, app: null, obj: null, view: null };
  try {
    if (typeof PIXI === "undefined") {
      const t0 = Date.now();
      while (typeof PIXI === "undefined" && Date.now() - t0 < 8000) {
        await new Promise((r) => setTimeout(r, 100));
        if (!isCurrentRenderRequest(context, "spine")) return { status: "superseded" };
      }
      if (typeof PIXI === "undefined") throw new Error("PIXI 渲染库未就绪");
    }
    if (!isCurrentRenderRequest(context, "spine")) return { status: "superseded" };

    let paths = { ...spinePaths };
    try {
      const res = await window.petAPI.getSpineModels();
      if (!isCurrentRenderRequest(context, "spine")) return { status: "superseded" };
      if (res && Array.isArray(res.list) && res.list.length) {
        const cur = res.list.find((m) => m.id === (res.current || "builtin")) || res.list[0];
        paths = { atlas: cur.atlas, skel: cur.skel };
        window.petAPI.playback && window.petAPI.playback("[spine] initSpine 选中: " + cur.id);
      }
    } catch { /* 探测失败用内置 */ }
    // 查询失败也可能是旧请求在新请求接管后才返回；不能让它继续创建并登记旧 owner。
    if (!isCurrentRenderRequest(context, "spine")) return { status: "superseded" };

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    owner.app = new PIXI.Application({
      width: petEl.clientWidth || 260,
      height: petEl.clientHeight || 200,
      backgroundAlpha: 0,
      autoStart: true,
      antialias: true,
      resolution: dpr,
      autoDensity: true
    });
    owner.view = owner.app.view;
    owner.view.id = "spine-canvas";
    owner.view.classList.add("spine-canvas", "hidden");
    owner.view.style.display = "none";
    owner.view.style.visibility = "hidden";
    owner.view.style.pointerEvents = "none";
    bindCtxLost(owner.view, "spine");
    petEl.insertBefore(owner.view, spriteEl);
    // 从创建 app/view 的这一刻起就登记 pending owner，切走时无需等待资源加载完成。
    if (!isCurrentRenderRequest(context, "spine") || (spinePendingOwner && spinePendingOwner !== owner)) {
      destroySpineOwner(owner);
      return { status: "superseded" };
    }
    spinePendingOwner = owner;

    const atlasRes = await PIXI.Assets.load(paths.atlas);
    if (!isCurrentRenderRequest(context, "spine")) {
      destroySpineOwner(owner);
      return { status: "superseded" };
    }
    try {
      for (const page of (atlasRes && atlasRes.pages) || []) {
        if (page && page.baseTexture) {
          page.baseTexture.autoGenerateMipmaps = true;
          page.baseTexture.mipmap = PIXI.MIPMAP_MODES?.ON ?? 1;
          page.baseTexture.update();
        }
      }
    } catch { /* mipmap 失败不影响渲染 */ }
    const skelRes = await PIXI.Assets.load(paths.skel);
    if (!isCurrentRenderRequest(context, "spine")) {
      destroySpineOwner(owner);
      return { status: "superseded" };
    }
    const SpineCtor = (PIXI.spine && PIXI.spine.Spine) || PIXI.Spine;
    if (!SpineCtor) throw new Error("Spine 构造器未加载");
    const spineData = skelRes && skelRes.spineData ? skelRes.spineData : skelRes;
    owner.obj = new SpineCtor(spineData);
    owner.app.stage.addChild(owner.obj);
    try { owner.obj.state.data.defaultMix = 0.20; } catch { /* 忽略 */ }
    owner.obj.x = owner.app.screen.width / 2;
    owner.obj.y = owner.app.screen.height;
    const mw = owner.obj.width || 0, mh = owner.obj.height || 0;
    const useW = mw > 50 ? mw : 300, useH = mh > 50 ? mh : 400;
    const scale = Math.min(owner.app.screen.width / useW, owner.app.screen.height / useH) * 0.9;
    const boostTable = {
      "4179_monstr_boc_11": 7.5, "254_vodfox": 1.8, "358_lisa": 1.45,
      "2015_dusk": 2.5, "254_vodfox_witch_2": 1.3, "358_lisa_epoque_22": 1.4,
      "358_lisa_wild_3": 2.4, "2015_dusk_nian_7": 5.0, "2015_dusk_nian_12": 1.4,
      "254_vodfox_yun_8": 2.1, "2025_shu": 1.65, "2025_shu_nian_11": 1.6
    };
    const boostOffsetTable = {};
    const SKIN_SCALE_OVERRIDE = { "1035_wisdel": 1.5 };
    let boost = 1, xoff = 0, manualHit = false;
    try {
      const segs = decodeURIComponent((paths.skel || "")).split("/");
      const uIdx = segs.lastIndexOf("user");
      const dirName = segs.find((p) => /^\d{3,4}_/.test(p)) || (uIdx >= 0 && segs[uIdx + 1] ? segs[uIdx + 1] : "");
      boost = boostTable[dirName] || 1;
      xoff = boostOffsetTable[dirName] || 0;
      manualHit = !!boostTable[dirName];
      if (SKIN_SCALE_OVERRIDE[dirName] && SKIN_SCALE_OVERRIDE[dirName] !== 1) {
        boost *= SKIN_SCALE_OVERRIDE[dirName];
        manualHit = true;
      }
    } catch { boost = 1; xoff = 0; }
    owner.obj.scale.set(scale * boost);
    if (!isCurrentRenderRequest(context, "spine")) {
      destroySpineOwner(owner);
      return { status: "superseded" };
    }

    spinePaths = paths;
    spineClassified = null;
    spineApp = owner.app;
    spineObj = owner.obj;
    spineRuntimeOwner = owner;
    if (spinePendingOwner === owner) spinePendingOwner = null;
    owner.committed = true;
    spineXoff = xoff;
    spineManual = manualHit;
    spineAutoScaled = false;
    spineFitKeepScale = false;
    spineBaseScaleX = scale * boost;
    installSeatLifecycle();
    // A24 owner-boundary：上一生命周期 applied 的 walkState（真机 bootstrap-arm 时 walk=…seated:true）
    // 不得成为新 Spine owner 的 effective 状态——业务真相转入 carry（staged 初值，可被更新 incoming 覆盖），
    // 新 owner applied 重置为 neutral（这具新骨架此刻确实只应用了 Relax）。
    // 由此 bootstrap 期所有 walkState 读取者（setSpineMood/reconcile/spinePhaseAnim/fit flip）看到 neutral，
    // 杜绝真机链「re-entry → setMood(idle) 读到 stale seated → seat-guard 播 Sit → 6×seat-hold/hits=0 → failsafe 暴露 0.205」。
    spineBootstrapDeferredWalk = null;
    spineBootstrapOwnerReset = null;
    const bootstrapCarry = Object.assign({}, walkState);
    if (bootstrapCarry.active || bootstrapCarry.seated || bootstrapCarry.perched || bootstrapCarry.paused || bootstrapCarry.sleeping) {
      spineBootstrapDeferredWalk = bootstrapCarry;
      walkState = Object.assign({}, bootstrapCarry, { active: false, resting: true, seated: false, perched: false, paused: false, sleeping: false, face: 1 });
      spineBootstrapOwnerReset = { carry: bootstrapCarry, applied: Object.assign({}, walkState), ownerGen: context.generation };
    }
    const animName = spineAnimForMood("idle");
    if (animName) setSpineAnim(animName, true, "init");
    scheduleFitSpine({}); // A 修复：owner 就绪即无条件布置 fit 收敛窗口——animName 为空时整窗曾被跳过，角色带着 setup-pose 小尺寸一直等到第一次走动/相位事件才纠正
    // A-v2.1：以 idle 稳定姿势做 pre-visible bootstrap——fit 收敛前画布保持 hidden（commit 不解除），
    // 首次可见即最终尺寸；5s 有界兜底防异常模型永久隐身。
    // A-v2.3：arm 唯一绑定在 owner 创建（initSpine）——cold-start / GIF→Spine / 皮肤重载 / renderer 恢复
    // 全部走同一套 bootstrap 生命周期，re-entry 不再复用旧 gate 或被 ready 抢跑。
    spineBootstrapPending = true;
    spineBootstrapOwner = owner;
    // A24：staged 初值已由上方 owner-boundary carry 设置（无 carry 时为 null），arm 不再触碰
    spineBootstrapPassCount = 0;
    settleSpineBootstrapDone(); // 理论上不应有未结算旧 promise（release/abandon 已结算）；防御性兜住，防 waiter 悬挂
    spineBootstrapDone = new Promise((r) => { spineBootstrapDoneResolve = r; });
    if (spineBootstrapFailSafeTimer) clearTimeout(spineBootstrapFailSafeTimer);
    spineBootstrapFailSafeTimer = setTimeout(() => releaseSpineBootstrap("failsafe"), 5000);
    reportHasSit();
    window.petAPI.playback && window.petAPI.playback("[spine] ok boost=" + boost + " scale=" + scale.toFixed(4) + " final=" + (scale * boost).toFixed(4) + " skel=" + paths.skel);
    return { status: "ready", resource: paths.atlas + "|" + paths.skel };
  } catch (e) {
    console.error("[Spine] 初始化失败:", e);
    window.petAPI.playback && window.petAPI.playback("[spine] 初始化失败: " + (e && e.message || e));
    destroySpineOwner(owner);
    return { status: isCurrentRenderRequest(context, "spine") ? "failed" : "superseded", error: e };
  }
}

function resetVisualState() {
  document.body.classList.remove("spine-mode", "rig-mode", "live2d-mode");
  // moodTimer 属于人物状态，不是 GIF visual owner；切换 render mode 不能取消它。
  if (petEl) {
    petEl.classList.add("render-inactive");
    petEl.style.visibility = "hidden";
    petEl.style.pointerEvents = "none";
  }
  if (spriteEl) {
    spriteEl.style.display = "none";
    spriteEl.style.visibility = "hidden";
    spriteEl.style.pointerEvents = "none";
  }
  const spineView = (spineRuntimeOwner && spineRuntimeOwner.view) || (spineApp && spineApp.view) || document.getElementById("spine-canvas");
  if (spineView) {
    spineView.classList.add("hidden");
    spineView.style.display = "none";
    spineView.style.visibility = "hidden";
    spineView.style.pointerEvents = "none";
  }
  if (rigCanvas) {
    rigCanvas.classList.add("hidden");
    rigCanvas.style.display = "";
    rigCanvas.style.visibility = "hidden";
    rigCanvas.style.pointerEvents = "none";
  }
  const liveCanvas = document.getElementById("live2d-canvas");
  if (liveCanvas) {
    liveCanvas.classList.add("hidden");
    liveCanvas.style.display = "";
    liveCanvas.style.visibility = "hidden";
    liveCanvas.style.pointerEvents = "none";
  }
}

function teardownAll() {
  // 只复用 A-3 已有的安全取消语义，不改变拖拽算法。
  if (dragState) finishDrag("render-mode-switch");
  teardownSpineRuntime();
  destroyRig();
  destroyLive2d();
}

function resourceKeyFor(mode, options = {}) {
  if (options.resourceId !== undefined) return String(options.resourceId || "");
  if (mode === "rig") return String(rigSkinId || "");
  if (mode === "live2d") return String(live2dSkinId || "");
  if (mode === "spine") return spinePaths.atlas + "|" + spinePaths.skel;
  return "gif";
}

function commitRenderMode(context, result) {
  const mode = context.mode;
  if (!isCurrentRenderRequest(context, mode) || !result || result.status !== "ready") return false;
  activeRenderMode = mode;
  activeRenderGeneration = context.generation;
  renderRuntimeReady = true;
  renderRuntimeResource = result.resource || resourceKeyFor(mode, context);
  if (mode === "gif") {
    petEl.classList.remove("render-inactive");
    spriteEl.style.display = "";
    spriteEl.style.visibility = "";
    spriteEl.style.pointerEvents = "none";
    petEl.style.display = "";
    petEl.style.visibility = "";
    petEl.style.pointerEvents = "auto";
    window.petAPI.setSize(winSize.width || 260, winSize.height || 200, "render-mode");
    applyBubbleSize();
    if (appearanceCfg) applyAppearance(appearanceCfg);
    scheduleGeometryReport();
    return true;
  }
  if (mode === "spine") {
    petEl.classList.remove("render-inactive");
    document.body.classList.add("spine-mode");
    spriteEl.style.display = "none";
    spriteEl.style.visibility = "hidden";
    petEl.style.display = "";
    petEl.style.visibility = "";
    petEl.style.pointerEvents = "auto";
    window.petAPI.setSize(winSize.width || 260, winSize.height || 200, "render-mode");
    applyBubbleSize();
    if (appearanceCfg) applyAppearance(appearanceCfg);
    if (spineApp && spineApp.view && !spineBootstrapPending) { // A-v2.1：bootstrap pending 时不解除隐藏——释放由 releaseSpineBootstrap 统一执行（fit 收敛事件驱动）
      spineApp.view.classList.remove("hidden");
      spineApp.view.style.display = "";
      spineApp.view.style.visibility = "";
      spineApp.view.style.pointerEvents = "none";
    }
    scheduleFitSpine({}); // A 修复：commit 后（画布恢复可见、窗口尺寸已按 render-mode 重设）重新锚定 fit 收敛窗口；后布置者接管（旧代次计时被 generation 守卫作废）
    return true;
  }
  if (mode === "rig") {
    petEl.classList.add("render-inactive");
    petEl.style.display = "none";
    petEl.style.visibility = "hidden";
    petEl.style.pointerEvents = "none";
    document.body.classList.add("rig-mode");
    bubbleEl.style.width = "";
    bubbleEl.style.height = "";
    if (rigCanvas) {
      rigCanvas.classList.remove("hidden");
      rigCanvas.style.display = "";
      rigCanvas.style.visibility = "";
      rigCanvas.style.pointerEvents = "auto";
    }
    window.petAPI.setSize(RIG_WIN_W, Math.round(RIG_WIN_H * rigScale), "render-mode");
    window.petAPI.walkingEngineStop && window.petAPI.walkingEngineStop();
    return true;
  }
  if (mode === "live2d") {
    petEl.classList.add("render-inactive");
    petEl.style.display = "none";
    petEl.style.visibility = "hidden";
    petEl.style.pointerEvents = "none";
    document.body.classList.add("live2d-mode");
    spriteEl.style.display = "none";
    spriteEl.style.visibility = "hidden";
    const canvas = document.getElementById("live2d-canvas");
    if (canvas) {
      canvas.classList.remove("hidden");
      canvas.style.display = "";
      canvas.style.visibility = "";
      canvas.style.pointerEvents = "auto";
    }
    window.petAPI.setSize(Math.round(300 * live2dScaleFactor), Math.round(460 * live2dScaleFactor), "render-mode");
    window.petAPI.walkingEngineStop && window.petAPI.walkingEngineStop();
    return true;
  }
  return false;
}

async function switchRenderMode(nextMode, options = {}) {
  const mode = RENDER_MODES.includes(nextMode) ? nextMode : "gif";
  if (Number.isSafeInteger(options.mainSeq)) currentMainRenderModeSeq = options.mainSeq;
  const targetResource = resourceKeyFor(mode, options);
  if (!options.force && activeRenderMode === mode && renderRuntimeReady && renderSwitchStatus !== "switching" &&
      renderRuntimeResource === targetResource) {
    return { status: "noop", mode, generation: activeRenderGeneration, resource: renderRuntimeResource,
      requestedMode: mode, committedMode: mode, fallback: false };
  }
  nextGifGeometryRevision();
  requestedRenderMode = mode;
  const generation = ++renderSwitchGeneration;
  const context = {
    mode,
    generation,
    mainSeq: Number.isSafeInteger(options.mainSeq) ? options.mainSeq : null,
    resourceId: options.resourceId !== undefined ? String(options.resourceId || "") : targetResource,
    token: {}
  };
    renderSwitchStatus = "switching";
  const run = (async () => {
    teardownAll();
    if (!isCurrentRenderRequest(context, mode)) return { status: "superseded", mode, generation };
    activeRenderMode = null;
    activeRenderGeneration = 0;
    renderRuntimeReady = false;
    renderRuntimeResource = "";
    resetVisualState();
    if (options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (!isCurrentRenderRequest(context, mode)) return { status: "superseded", mode, generation };
    }
    let result;
    if (mode === "gif") result = { status: "ready", resource: "gif" };
    else if (mode === "spine") result = await initSpine(context);
    else if (mode === "rig") result = await initRig(context);
    else result = await initLive2d(context);
    if (!isCurrentRenderRequest(context, mode)) return { status: "superseded", mode, generation };
    if (!result || result.status !== "ready") {
      teardownAll();
      resetVisualState();
      activeRenderMode = null;
      renderRuntimeReady = false;
      renderRuntimeResource = "";
      renderSwitchStatus = result && result.status === "superseded" ? "superseded" : "failed";
      const error = result && result.error;
      // B-2：只有当前、真正失败的非 GIF request 才能建立一个新的 GIF request。
      // fallback 复用 switchRenderMode，推进正常 renderer generation；GIF 自身不递归 fallback。
      if (renderSwitchStatus === "failed" && mode !== "gif" && isCurrentRenderRequest(context, mode)) {
        const fallback = await switchRenderMode("gif", { mainSeq: context.mainSeq });
        if (fallback.status === "ready" || fallback.status === "noop") {
          return {
            ...fallback,
            requestedMode: mode,
            committedMode: "gif",
            fallback: true,
            error
          };
        }
        return { status: fallback.status, mode, generation, requestedMode: mode, committedMode: null, fallback: true, error };
      }
      return { status: renderSwitchStatus, mode, generation, error, requestedMode: mode, committedMode: null, fallback: false };
    }
    commitRenderMode(context, result);
    renderSwitchStatus = "ready";
    return { status: "ready", mode, generation, resource: renderRuntimeResource,
      requestedMode: mode, committedMode: mode, fallback: false };
  })();
  currentRenderSwitchPromise = run.catch(() => {});
  return run;
}

/** 主进程广播行走状态：切 Move/Relax/Sit 动画并同步朝向 */
let animDemoUntil = 0; // 动作试演期间不被行走相位打断
let moodAnimUntil = 0; // 情绪动画豁免窗口：setSpineMood 播非相位动画（happy/cry/think 等）后短暂时间内，相位对账不抢（onDone 2.6s 会自行回落 idle；过期后对账兜底回收）
let spineTrackProbe = { name: "", time: NaN }; // 看门狗采样：名称正确但 trackTime 停住时也能自愈
let spineTrackStallCount = 0;
// 相位切换诊断（2026-09-03 补）：坐姿分支早有日志，走/停/暂停三支没有——"移动丢走路动画"
// 曾无法从日志定位。同键 10s 节流 + 全局 2s 节流，防连点刷屏。
let _phaseLogAt = 0, _phaseLogKey = "";
function logPhaseSwitch(label, animName) {
  const now = Date.now();
  const key = label + "|" + animName;
  if (key === _phaseLogKey ? now - _phaseLogAt < 10000 : now - _phaseLogAt < 2000) return;
  _phaseLogAt = now; _phaseLogKey = key;
  try { window.petAPI.playback && window.petAPI.playback("[anim] " + label + " anim=" + animName +
    " (active=" + walkState.active + " resting=" + walkState.resting + " seated=" + walkState.seated +
    " perched=" + walkState.perched + " paused=" + walkState.paused + ")"); } catch { /* 忽略 */ }
}
function reconcileSpineAnimation(reason = "reconcile") {
  if (!spineObj || activeRenderMode !== "spine" || isSleeping || Date.now() < animDemoUntil) return false;
  let cur = null;
  try { cur = spineObj.state.getCurrent(0); } catch { return false; }
  const target = spinePhaseAnim() || spineAnimForMood("idle");
  if (!target) return false;
  const currentName = cur && cur.animation ? cur.animation.name : "";
  const decision = window.AnimationWatch ? window.AnimationWatch.trackDecision({
    currentName,
    targetName: target,
    currentLoop: cur && cur.loop,
    previousName: spineTrackProbe.name,
    previousTime: spineTrackProbe.time,
    currentTime: cur && cur.trackTime,
    stallCount: spineTrackStallCount,
    busy,
    sleeping: isSleeping,
    demo: Date.now() < animDemoUntil,
    mood: Date.now() < moodAnimUntil,
    active: walkState.active,
    resting: walkState.resting,
    seated: walkState.seated,
    perched: walkState.perched,
    paused: walkState.paused,
    currentAnimationEnd: cur && cur.animationEnd,
    currentTrackTime: cur && cur.trackTime,
    queuedSuccessor: !!(cur && cur.next)
  }) : (currentName === target ? "ok" : "restart");
  if (decision !== "restart") return false;
  try {
    if (spineApp.ticker && !spineApp.ticker.started) spineApp.ticker.start();
    if (spineObj.state && spineObj.state.timeScale === 0) spineObj.state.timeScale = 1;
  } catch { /* ticker 自愈失败仍重设轨道 */ }
  const seat = walkState.seated || walkState.perched;
  setSpineAnim(target, true, reason);
  scheduleFitSpine(seat ? { seatPhase: true } : {});
  spineTrackProbe = { name: target, time: NaN };
  try { window.petAPI.playback && window.petAPI.playback("[anim] " + reason + ": " + (currentName || "空") + " → " + target +
    " trackTime=" + (cur && Number.isFinite(cur.trackTime) ? cur.trackTime.toFixed(2) : "?") +
    " (busy=" + busy + " seated=" + walkState.seated + " paused=" + walkState.paused + ")"); } catch { /* 忽略 */ }
  return true;
}
function applyWalkState(s) {
  if (SEAT_EXIT_FORENSIC && s && s.seatExitForensic) seatExitForensicReceive(s.seatExitForensic, s);
  const standBeatPoseIntent = STANDBEAT_POSE_ENABLED && s?.standBeatPoseIntent === "stand";
  if (window.SeatFit ? window.SeatFit.bootstrapShouldDeferWalk(spineBootstrapPending) : spineBootstrapPending) {
    // A-v2.2：defer 在状态提交之前——incoming 只 stage（latest-wins 单槽），共享 walkState 保持 neutral，
    // setMood/setSpineMood/reconcile 等独立读取者不会在 bootstrap 期看到未生效的 seated=true。
    spineBootstrapDeferredWalk = Object.assign({}, s || walkState);
    return;
  }
  if (EDGE_DIAG && s && s.edgeDiagTurnId !== undefined) diagActiveEdge = { turnId: s.edgeDiagTurnId, faceTs: 0, expiresAt: Date.now() + 500 }; // correlation 建立/覆盖（纯赋值；untagged 广播不清——见 diagActiveEdge 注释）
  const wasActive = walkState.active;
  const wasSeatedSnap = !!(walkState.seated || walkState.perched);
  const wasSleeping = walkState.sleeping;
  const wasResting = !!(walkState.seated || walkState.perched || walkState.sleeping);
  walkState = s || walkState;
  if (EDGE_DIAG && wasSeatedSnap && !walkState.seated && !walkState.perched && !walkState.sleeping) lastSeatExitAt = Date.now(); // diagnostics-only 时间戳；不改任何控制流
  if (seatExitY && (walkState.seated || walkState.perched)) releaseSeatExitY("seat-reentry"); // handoff：containment/seat-fit 接管；release 绝不 finish-snap
  // 自主坐下/上窗顶/入睡的瞬间收起聊天栏：输入栏悬浮在窗口底部，坐姿正好压在栏上
  // （视觉=坐在自己的输入条上）。单击打开会顺带聚焦输入框且焦点会一直留着，
  // 焦点本身不代表在用，故只认 60s 内的真实打字；有草稿或生成中也不动。
  // 直接收起而非 toggleInputBar，避免走 wake() 把刚睡着的她叫醒。
  const resting = !!(walkState.seated || walkState.perched || walkState.sleeping);
  if (resting && !wasResting && !inputBar.classList.contains("hidden") &&
      Date.now() - lastInputAt > 60000 && !inputEl.value && !busy) {
    inputBar.classList.add("hidden");
    inputEl.blur();
  }
  if (typeof walkState.sleeping === "boolean" && walkState.sleeping !== wasSleeping) {
    isSleeping = walkState.sleeping;
    awake = !isSleeping;
    if (isSleeping) setSpineMood("sleep");
    else setSpineMood("idle");
  }
  // 行走激活瞬间恢复标准窗口：气泡加宽（ensureWindowWidthFor）的大窗口会破坏行走几何（charInset 超上限→出屏“闪现”）。
  // v2.5.10：宽皮肤按其窗口宽度恢复，否则会顶掉 460 宽的宽模型布局。
  if (walkState.active && !wasActive && !(activeRenderMode === "rig" && rigRuntime)) {
    window.petAPI.setSize(winSize.width || 260, winSize.height || 200);
  }
  if (!spineObj || activeRenderMode !== "spine") return;
  if (isSleeping) return;                 // 睡觉中：不被行走动画打断
  spineFaceDir(walkState.face);
  if (Date.now() < animDemoUntil) return; // 演示中，不打断
  if (standBeatPoseIntent) {
    admitStandBeatPoseIntent();
    return; // intent 是一次性、窄范围 admission；拒绝时也不让普通 resting/pause 分支替它强行抢轨
  }
  // 坐下（任务栏上沿/桌面图标顶/窗顶）：Sit 循环，优先级高于行走相位
  if (walkState.seated || walkState.perched) {
    const sit = sitAnimName();
    const target = sit || spinePhaseAnim();
    if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
      setSpineAnim(target, true, "seat-phase");
      try { window.petAPI.playback && window.petAPI.playback("[fit] seat-phase anim=" + target); } catch { /* 忽略 */ }
      scheduleFitSpine({ seatPhase: true });
    }
    return;
  }
  if (!walkState.active) {
    // 行走刚停止 → 恢复正常待机动画（否则会一直保持最后姿势）
    if (wasActive && !busy) {
      const idle = spineAnimForMood("idle");
      if (idle && spineObj.state.getCurrent(0)?.animation?.name !== idle) {
        setSpineAnim(idle, true, "stop-idle");
        logPhaseSwitch("stop-idle", idle);
        scheduleFitSpine({});
      }
    }
    return;
  }
  // v2.5.27 修「光走路不前进」：聊天生成/拖拽会暂停位移（main 不再移动窗口），
  // 但 busy 短路会把画面定格在最后一帧 Move——暂停态必须先切回站姿待机
  if (walkState.paused) {
    const idle = spineAnimForMood("idle");
    if (idle && spineObj.state.getCurrent(0)?.animation?.name !== idle) {
      setSpineAnim(idle, true, "paused-idle");
      logPhaseSwitch("paused-idle", idle);
      scheduleFitSpine({});
    }
    return;
  }
  const target = spinePhaseAnim();
  const cur = spineObj.state.getCurrent(0);
  if (STANDBEAT_POSE_ENABLED) seatExitForensicNoteMoveRequest();
  const decision = window.AnimationWatch ? window.AnimationWatch.trackDecision({
    currentName: cur && cur.animation ? cur.animation.name : "",
    targetName: target,
    currentLoop: cur && cur.loop,
    currentAnimationEnd: cur && cur.animationEnd,
    currentTrackTime: cur && cur.trackTime,
    queuedSuccessor: !!(cur && cur.next),
    active: walkState.active,
    busy,
    mood: Date.now() < moodAnimUntil,
    resting: walkState.resting,
    paused: walkState.paused,
    sleeping: walkState.sleeping,
    seated: walkState.seated,
    perched: walkState.perched
  }) : "restart";
  if (decision === "defer") {
    // defer 的唯一"状态已 live 但轨道被排队 successor 占用"形态：刷新 stale 队尾（见函数注释）。
    // 其余 defer 原因（resting/paused/睡眠等）语义下 successor 名与实时 target 一致或分支提前返回，
    // refresh 内部按名比对自动落空——不产生任何写。
    refreshStaleQueuedSuccessor(cur, target);
    return;
  }
  if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
    setSpineAnim(target, true, "walk-phase");
    logPhaseSwitch("walk-phase", target);
    scheduleFitSpine({});
  }
}

/** 单击互动：播一次 Interact 后接回当前相位动画（还原游戏内点击基建干员的反应） */
let pokeFeedbackAt = 0;
function pokeFeedback() { // 点击反馈（v2.5.1）：缩放脉冲 + 原声切片——不依赖模型动作集，任何模型必有反馈
  const now = Date.now();
  if (now - pokeFeedbackAt < 600) return; // 连点限流
  pokeFeedbackAt = now;
  // Phase2 spec-10（隔离方案 A）：seat-exit local-Y ownership 期间禁用 Y bounce；
  // 延迟 callback 执行时二次校验（gen / owner / token）——arm 之前已排队的旧回调也不得回写绝对旧 Y。
  pokeFeedbackGen += 1;
  const pokeGen = pokeFeedbackGen;
  const pokeOwner = spineObj;
  let bounceBaseY = 0;
  try {
    if (spineObj && !seatExitYOwnsY()) {
      bounceBaseY = spineObj.y;
      spineObj.y = bounceBaseY - 16;
      setTimeout(() => { try { if (pokeGen === pokeFeedbackGen && spineObj === pokeOwner && !seatExitYOwnsY()) pokeOwner.y = bounceBaseY - 6; } catch { /* 忽略 */ } }, 120);
      setTimeout(() => { try { if (pokeGen === pokeFeedbackGen && spineObj === pokeOwner && !seatExitYOwnsY()) pokeOwner.y = bounceBaseY; } catch { /* 忽略 */ } }, 250);
    }
  } catch { /* 忽略 */ }
  // 原声切片（随包苏苏洛游戏语音）：语音开着才出声，随机一条
  try { if (ttsConfig.enabled) playPresetVoice(); } catch { /* 忽略 */ }
}

/* ---------- 摸头/单击的瞬时按压 Q 弹（Spine 模式补齐；GIF 由 pet.css 的 pet-squash keyframes 承担） ----------
 * 为什么需要它（回归考古结论，非猜测）：
 *   1) 按压 Q 弹自 fab69cd（v2.5.22d）引入，CSS 选择器首版就带
 *      `body:not(.spine-mode):not(.rig-mode):not(.live2d-mode)` 门控，但当时全仓库没有任何代码
 *      设置 spine-mode（门控休眠），且 spine 画布是 #pet 子节点（运行时 insertBefore，沿用至今）
 *      → #pet 的 squash transform 直接传导到画布，Q 弹在 spine 模式下事实可见（fab69cd..6083542）；
 *   2) 6083542（render mode 排他生命周期）补上 `body.classList.add("spine-mode")`，休眠门控被
 *      激活 → spine 的按压/释放 Q 弹自该 commit 起静默消失。这才是回归点：摸头 JS 链路代码
 *      本身零改动，变的是 CSS 门控的激活状态；
 *   3) 本应接替的 Spine 侧瞬时反馈 pokeFeedback（2600a04）出生至 HEAD 从未有生产调用点（死
 *      代码），门控激活后无任何实现接盘 → 摸头只剩 Interact 动作 + ❤ 气泡。GIF 全程不受影响；
 *      rig/live2d 的 body class 出生即设置，本来就从未有过 squash。
 * 关键帧镜像 GIF 的 `pet-squash-release`（总时长 0.35s、60% 处过冲 1.06），transform-origin 取
 * 底部中心：scale 等比（不触发 pet.js 200ms 非等比自愈），x/y 按当帧底部中心补偿 → 脚不离地。
 * 守卫（绝不与既有 writer 争写）：
 *   - seat-exit local-Y owner / Sit ratchet（seatContainmentCommit 逐拍写 transform）期间整轮让位；
 *   - 复用 pokeFeedbackGen：换肤·切模式·销毁·seat-exit arm 都已 bump 它，排队回调随之永久失效；
 *   - 乐观并发：每帧先读当前 transform，认到"外部写者"（fit pass 等）就以它的值为新基准继续，
 *     末拍精确还原基准值——动画永远骑在实时姿态上，不会用陈旧绝对值把 fit/seat 拉回去。 */
let patSquashBase = null;   // 本轮基准 transform（外部 writer 接手时刷新；末拍精确还原）
let patSquashShadow = null; // 本轮已写出的 transform（用于识别"有没有被别人改过"）
function headPatSquashBlocked() {
  return seatExitYOwnsY() || !!(seatEpisode.active && seatEpisode.owner === spineObj);
}
function headPatSquash() {
  if (!spineObj || activeRenderMode !== "spine" || headPatSquashBlocked()) return;
  try { // 对齐 GIF 侧 backlog-1 契约（pet.css prefers-reduced-motion 禁用 squash）：JS 替代实现须尊重同一系统设置
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch { /* matchMedia 异常按未要求减少动效处理 */ }
  const gen = ++pokeFeedbackGen; // 新一轮交互使上一轮排队回调永久失效
  const owner = spineObj;
  const read = () => ({ x: owner.x, y: owner.y, sx: owner.scale.x, sy: owner.scale.y });
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.sx === b.sx && a.sy === b.sy;
  const writeBase = (t) => { owner.x = t.x; owner.y = t.y; owner.scale.set(t.sx, t.sy); };
  const keyframe = (k) => {
    if (gen !== pokeFeedbackGen || owner !== spineObj || activeRenderMode !== "spine") return;
    if (headPatSquashBlocked()) return;
    const cur = read();
    // 认到外部写者（fit pass / 行走对齐等）：以它的值为新基准继续，绝不用陈旧绝对值把它拉回去
    if (!same(cur, patSquashShadow) && !same(cur, patSquashBase)) patSquashBase = cur;
    if (k === 1) { // 末拍：精确还原基准，动画自然收尾
      const t = patSquashBase;
      patSquashBase = null;
      patSquashShadow = null;
      if (t) writeBase(t);
      return;
    }
    let b = null;
    try { b = owner.getBounds(); } catch { /* 忽略 */ }
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.width > 0) || !(b.height > 0)) return;
    if (!patSquashBase) patSquashBase = cur;
    const src = patSquashBase;
    const cx = b.x + b.width / 2, bottom = b.y + b.height; // 底部中心 = CSS transform-origin: 50% 100%
    owner.scale.set(src.sx * k, src.sy * k);
    owner.x = cx - (cx - src.x) * k;
    owner.y = bottom - (bottom - src.y) * k;
    patSquashShadow = read();
  };
  // 上一轮被新交互打断：先还原到基准再重新起手，对齐 GIF「移除 class 后重放 keyframes」语义，
  // 否则连点会把压缩量叠乘（0.9 → 0.81 → …，角色逐次变小）。
  if (patSquashShadow && same(read(), patSquashShadow) && patSquashBase) writeBase(patSquashBase);
  patSquashBase = read();
  patSquashShadow = null;
  keyframe(0.9);
  setTimeout(() => keyframe(1.05), 210);
  setTimeout(() => keyframe(1), 350);
}

/** stale queued-successor refresh（talking-slide 根因修复，T2 rework）：
 *  poke/互动用"当时"的 spinePhaseAnim() 快照排队 successor——暂停期排队即冻结为 Relax。
 *  resume 广播到达时 Interact 还在播，trackDecision 依 queuedSuccessor 正确 defer（不打断互动），
 *  但若不处理，Interact 播完后 stale Relax 自动上轨 = "站着滑行"，直到 watchdog ≤2s 对账才收敛。
 *  T2 铁律（打包 pixi-spine 3.8 源码实据）：
 *   - 摘链必须走 AnimationState.disposeNext(cur)（setAnimationWith/clearTrack 内部同款官方例程）：
 *     对 cur.next 链逐个 queue.dispose → drain 时 listener.dispose + trackEntryPool.free 归还对象池，
 *     并置 cur.next=null——业务代码不再裸写 next，杜绝"事件残留/池泄漏"不受控摘链；
 *   - 入队必须 addAnimation(0, target, true, 0) 传满 4 参：runtime 的 i<=0 分支把 delay=0 换算成
 *     绝对晋升时刻 Math.max(dur, r.trackTime) - getMix(r, target)；漏传（undefined）→ 晋升门
 *     trackLast - delay = NaN 恒假 → successor 永不晋升 + queuedSuccessor 恒真把 watchdog 一起
 *     短路到 defer（15:35 真机定身事故的直接成因）。
 *  目标名只来自 spinePhaseAnim() 实时解析（Relax/Sitd/Sleepd 都可能），不硬编码动画名；
 *  目标与 successor 一致（合法 idle 排队）不做无意义替换；多段链不碰；无 disposeNext 的 runtime
 *  降级为手动摘链（排队 entry 在 setCurrent 前从不接线 listener/mixing——打包源码 setCurrent
 *  才做 mixing 配对，queue.start 只在 head 附加路径触发，摘除未晋升 entry 无事件/监听残留）。 */
function refreshStaleQueuedSuccessor(cur, target) {
  if (!spineObj || !spineObj.state || typeof spineObj.state.addAnimation !== "function") return;
  if (!cur || cur.loop !== false || !target) return;   // 只处理"一次性互动+排队恢复"形态（poke-resume）
  const stale = cur.next;
  if (!stale || stale.next) return;                    // 仅单 successor；复杂链交回 watchdog
  if (stale.animation && stale.animation.name === target) return; // 目标=现行 live 相位：无需替换
  let officiallyDropped = false;
  try {
    if (typeof spineObj.state.disposeNext === "function") { spineObj.state.disposeNext(cur); officiallyDropped = true; }
    else cur.next = null;                              // 降级：摘链后 orphan entry 等 GC（无事件接线，见注释）
    spineObj.state.addAnimation(0, target, true, 0);   // Interact 播完直接进最新相位（delay 经 runtime 换算为有限值）
  } catch {
    // 入队失败：仅在 stale 未被官方 dispose（无待归还池事件）时还原旧链，让 watchdog 按旧语义兜底；
    // 已 dispose 的 stale 绝不重新挂链（它即将被 drain 归还对象池）。
    if (!officiallyDropped) cur.next = stale;
  }
}

function playSpineInteract() {
  try { window.petAPI.playback("[ui] interact入口 spineObj=" + !!spineObj + " mode=" + activeRenderMode + " busy=" + busy); } catch { /* 忽略 */ }
  if (!spineObj || activeRenderMode !== "spine" || busy) return;
  // 睡觉中不互动：否则 Interact→排队恢复 spinePhaseAnim()=Move，主进程 sleeping=true 不位移
  // →「Move 动画播放但不移动」冻结（2026-09-05 用户目击，鼠标靠近感应也会触发本函数）
  if (isSleeping || walkState.sleeping) return;
  const inter = ["Interact", "interact"].find((n) => spineHas(n));
  if (!inter) {
    // 模型没有 Interact 动作：播站立/放松类动作作辅助（主反馈是 pokeFeedback 的脉冲+原声）
    const alt = ["idle", "Idle", "relax", "stand"].find((n) => spineHas(n));
    const fallback = alt || spinePhaseAnim();
    if (fallback && spineObj.state.getCurrent(0)?.animation?.name !== fallback) {
      setSpineAnim(fallback, true, "poke-fallback");
    }
    return;
  }
  const next = spinePhaseAnim();
  if (!next) return;
  spineObj.state.clearTrack(0);
  setSpineAnim(inter, false, "poke");
  addSpineAnim(next, true, "poke-resume");
  scheduleFitSpine({});
}

/** 在 Spine 模式下播放对应情绪的动画 */
function setSpineMood(mood) {
  if (!spineObj || activeRenderMode !== "spine") return;
  if (Date.now() < animDemoUntil) return; // 动作试演中，不被情绪切换打断
  // 坐下/窗顶状态：一切情绪以坐姿呈现。
  // 5 动画基建皮肤（Sitd/Sleepd/Move/Relax/Interact）没有坐姿情绪变体，聊天情绪
  // happy/wave 全映射到 Relax/Interact（站姿类）：说话瞬间"坐着突然站起来"，窗口仍沉在
  // 任务栏里 → 脚陷进任务栏/观感悬空，且 busy 期间看门狗不纠（2026-09-05 用户报告）。
  // sleep 例外由主进程处理：set-sleeping(true) 会先起身回地面线，广播到达后走通用路径
  // 播 Sleepd（用户指示：睡觉就是 sleep 动画，不要坐着睡）；广播前瞬态回落 Sitd。
  if (walkState.seated || walkState.perched) {
    const sit = sitAnimName();
    const want = (mood === "idle" || mood === undefined || mood === "sleep") ? null : spineAnimForMood(mood);
    const target = (want && isSitClassAnim(want)) ? want : sit;
    if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
      setSpineAnim(target, true, "seat-guard");
      scheduleFitSpine({ seatPhase: true });
    }
    return;
  }
  // talking-slide 修复（track0 ownership invariant）：live locomotion 时普通 mood 一律不得把
  // track0 从 locomotion 相位动画抢走——"温柔/happy/…"（含 spineAnimForMood 未命中兜底）都保持
  // 行走姿势；mood 字段/dataset/bubble/TTS 照常，苏苏洛可以边走边说（修复不走"暂停移动"路线）。
  // mood==="idle" 时与旧 walk-mood 分支行为一致；非 idle 情绪在走动中不再上轨（旧行为=滑步根因）。
  // 不再需要 !busy 门：聊天期间 main chatPauseWalk 已置 paused，isLiveLocomotion 自然为 false。
  // 2026-09-03 教训保留：相位来源必须用 spinePhaseAnim()（与相位机同源，认识 cls.move 变体），
  // 不硬编码 "Move"。seated/perched 已在上方 seat-guard 早退，此处谓词是全量定义（显式防回归）。
  if (isLiveLocomotion()) {
    const move = spinePhaseAnim();
    if (move && spineObj.state.getCurrent(0)?.animation?.name !== move) {
      spineFaceDir(walkState.face);
      setSpineAnim(move, true, "walk-mood");
      scheduleFitSpine({});
    }
    return;
  }
  const animName = spineAnimForMood(mood === "idle" ? "idle" : mood);
  if (animName && spineObj.state.getCurrent(0)?.animation?.name !== animName) {
    // T3（02:48:23 真机链）：locomotion 生命周期内（含 chat/poke 临时暂停）mood 解析成
    // 静态兜底动画（Default duration=0）时不得写 track0——"站着不动但引擎活着/窗口在走"=说话定身。
    // 只挡 duration≤0 的兜底形态：think→Relax、sleep→Sleepd 等真实映射动画照常上轨（聊天思考不破坏）；
    // 非生命周期（引擎停止/坐/窗顶/睡）完全旧语义（active=false 时 Default 合法）；
    // mood 字段/dataset/bubble/TTS 均已先行提交，暂停结束后 walk-phase/paused-idle 分支照常恢复正确相位。
    if (isLocomotionLifecycle() && isStaticFallbackAnim(animName)) return;
    setSpineAnim(animName, true, "mood:" + mood);
    moodAnimUntil = Date.now() + 6500; // 情绪动画展示窗口：期间相位对账不抢，过期由对账兜底回收
    scheduleFitSpine({});
  }
}

function moodNames() { return MOODS.map((m) => m.name); }
function labelToName(label) {
  const m = MOODS.find((x) => x.label === label);
  return m ? m.name : "";
}
function idleNames() { return MOODS.filter((m) => !m.emotion).map((m) => m.name); }

let busy = false;
let currentMode = "chat";
let forcedMode = "auto";
let zcodeEnabled = false; // 任务模式是否可用（默认关闭）
let agreed = false;       // 是否已同意使用条款；正常桌宠窗口只在主进程确认后创建
let replyBuffer = "";
let revealTimer = null;
let typing = false;
let lastMood = "idle";
let moodTimer = null;      // 心情自动回落定时器
let sleepTimer = null;     // 闲置睡觉定时器
let awake = true;
let isSleeping = false;    // 睡觉状态（同步给行走引擎暂停移动）
let idleIdx = 0;

function setMood(mood, { preserveSleep = false } = {}) {
  // mood = 内部状态名（happy/think/sleep/…或自定义情绪名）；"idle"/未知 → 从待机池轮换
  const names = moodNames();
  const idles = idleNames();
  let pool;
  if (mood === "idle" || !names.includes(mood)) pool = idles;
  else pool = [mood];
  if (!pool.length) return;
  const file = pool.length > 1 ? pool[++idleIdx % pool.length] : pool[0];
  lastMood = mood;

  // 睡觉/醒来同步行走引擎（睡着后不再移动）；程序消息不应隐式唤醒
  if (mood === "sleep") {
    if (!isSleeping) { isSleeping = true; awake = false; window.petAPI.setSleeping(true); armSleepAutoWake(); }
  } else if (!preserveSleep && isSleeping) {
    isSleeping = false;
    awake = true;
    window.petAPI.setSleeping(false);
    disarmSleepAutoWake();
  }

  // PSD 2.5D 角色（v2.2）：情绪 → 表情预设（独立于 Spine）
  if (activeRenderMode === "rig" && rigRuntime) { rigPresetForMood(mood); petEl.dataset.mood = mood; return; }

  // Live2D（v2.5.1）：情绪 → 动作/表情
  if (activeRenderMode === "live2d" && live2dActive) { setLive2dMood(mood); petEl.dataset.mood = mood; return; }

  // Spine 模式：切换 Spine 动画而非 GIF
  if (activeRenderMode === "spine") { setSpineMood(mood); petEl.dataset.mood = mood; return; }

  // 切换过渡期没有视觉 owner；只保留 lastMood，不启动 GIF 的异步提交。
  if (activeRenderMode !== "gif") return;

  // GIF 模式
  const gifUrl = SPRITE_BASE + encodeURI(file) + ".gif?t=" + Date.now();
  if (spriteEl.dataset.src === gifUrl.split("?")[0]) return; // 同一张不重复切换
  // 预载解码后再切（ottopet 借鉴：GIF 预载进正题，避免切换瞬间空白/卡顿）
  showGifWithPreload(gifUrl, mood, file);
}

/** 预载目标 GIF（decode 完成或超时 800ms 兜底）后切换；spine/rig 模式由调用方绕过 */
function showGifWithPreload(gifUrl, mood, file) {
  const ownerGeneration = renderSwitchGeneration;
  const im = new Image();
  let done = false;
  const apply = () => {
    if (done) return;
    if (ownerGeneration !== renderSwitchGeneration || requestedRenderMode !== "gif" ||
        activeRenderMode !== "gif" || activeRenderGeneration !== ownerGeneration) return;
    done = true;
    spriteEl.src = gifUrl;
    spriteEl.dataset.src = gifUrl.split("?")[0];
    petEl.dataset.mood = mood;
    if (mood === "sleep") awake = false;
    scheduleMoodReset(mood);
  };
  im.onload = apply;
  im.onerror = apply;
  im.src = gifUrl;
  setTimeout(apply, 800); // 大 GIF 解码慢：先切不阻塞，后续自然渐显
  // 后台预热下一位待机（让"闲置轮换"下一秒进正题）
  preloadGifNext(file);
}
const gifPreloadCache = new Set();
function preloadGifNext(file) {
  try {
    if (!file) return;
    const idles = idleNames();
    const idx = idles.indexOf(file);
    const next = idx >= 0 && idles[idx + 1] ? idles[idx + 1] : (idles[0] || "");
    if (!next || gifPreloadCache.has(next)) return;
    gifPreloadCache.add(next);
    const im = new Image();
    im.src = SPRITE_BASE + encodeURI(next) + ".gif";
  } catch { /* 预热失败不影响 */ }
}

/** 心情在指定时间后回落到 idle；持续心情（sleep/work 等）不自动回落 */
function scheduleMoodReset(mood) {
  if (moodTimer) clearTimeout(moodTimer);
  moodTimer = setTimeout(() => {
    moodTimer = null;
    // 这是人物状态 timer，不绑定 GIF visual generation；切到其他 mode 后仍需按原语义回落。
    if (!busy && mood !== "sleep" && mood !== "work") setMood("idle");
  }, 3000);
}

function wake() {
  if (isSleeping || !awake) {
    isSleeping = false;
    awake = true;
    window.petAPI.setSleeping(false);
    disarmSleepAutoWake();
    if (!busy) setMood("surprised"); // 被叫醒
  }
  resetSleepTimer();
}
function resetSleepTimer() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { if (!busy) setMood("sleep"); }, 5 * 60 * 1000);
}

/* ---------- 睡眠自动唤醒上限（v2.5.28）：睡满 25 分钟自己醒来散步/说话，闲了再睡 ----------
 *  此前入睡无上限，用户离开电脑后她一睡一下午：相位机冻结、闲话消失、观感"消失"。
 *  放渲染层而非主进程：wake() 自带 IPC+情绪+5min 计时器重启，醒后"闲了再睡"循环完整；
 *  主进程侧做只能清 walk.sleeping，渲染层入睡计时器不会被重启，会变成"醒一次就再也不睡"。 */
const SLEEP_AUTO_WAKE_MS = 25 * 60 * 1000;
let sleepAutoWakeTimer = null;
function armSleepAutoWake() {
  if (sleepAutoWakeTimer) clearTimeout(sleepAutoWakeTimer);
  sleepAutoWakeTimer = setTimeout(() => {
    sleepAutoWakeTimer = null;
    if (isSleeping && !busy) {
      try { window.petAPI.playback && window.petAPI.playback("[anim] 睡眠自动唤醒（25min 上限）"); } catch { /* 忽略 */ }
      wake(); // 主进程 walk 边沿自带 35% 概率 wake 台词；醒后相位机恢复，闲 5 分钟再睡
    } else {
      resetSleepTimer(); // 已被唤醒/忙碌中：重启闲时入睡循环
    }
  }, SLEEP_AUTO_WAKE_MS);
}
function disarmSleepAutoWake() {
  if (sleepAutoWakeTimer) { clearTimeout(sleepAutoWakeTimer); sleepAutoWakeTimer = null; }
}

/* ---------- 气泡 ---------- */
function showBubble() {
  bubbleEl.classList.remove("hidden");
  bubbleEl.classList.remove("error", "task");
  bubbleEl.scrollTop = 0; // 新消息从顶部显示，避免残留滚动位置让可见区落在空白段
}
function setBubbleMode(mode) {
  bubbleEl.classList.toggle("task", mode === "zcode");
}
function hideBubble() {
  bubbleEl.classList.add("hidden");
  stopReveal();
  clickability.refreshFromLastMouse(); // 无效坐标（-1,-1 等）由核心守卫拒绝：尚未观测到光标时不得主动切穿透
}
function stopReveal() {
  if (revealTimer) { clearInterval(revealTimer); revealTimer = null; }
  typing = false;
}

function startReveal(full, offset) {
  stopReveal();
  typing = true;
  // v2.5.22 优化（P2-4）：打字期间用 textContent 增量追加（O(n)），
  // 不再每 14ms 全量 innerHTML 重建（长回复 O(n²) 重解析）。结束后一次性富渲染 RP 格式。
  bubbleText.textContent = full.slice(0, offset);
  revealTimer = setInterval(() => {
    offset = Math.min(full.length, offset + 3);
    bubbleText.textContent = full.slice(0, offset); // 纯文本增量：无标签断裂风险
    if (offset >= full.length) {
      stopReveal();
      bubbleText.innerHTML = renderRpSlice(full, full.length); // 完成后富渲染一次（*动作*/（动作）斜体）
    }
  }, 14);
}

function showThinking() {
  showBubble();
  bubbleText.textContent = "";
  thinkingDots.classList.remove("hidden");
  setMood("think");
}
function hideThinking() {
  thinkingDots.classList.add("hidden");
}

/* ---------- 发送 / 流式回传 ---------- */
// 消息生成防抖（v2.6）：生成/合成中来的消息先缓冲（窗口内只留最后一条），当前回合结束自动补发，避免丢消息/合成堆叠
let pendingSendText = "";
let pendingSendTimer = null;
function maybeFlushPendingSend() {
  if (busy || !pendingSendText) return;
  clearTimeout(pendingSendTimer);
  pendingSendTimer = setTimeout(() => { // 追加 250ms 防抖：结束瞬间的连续输入合并为一条
    const t = pendingSendText;
    pendingSendText = "";
    if (t) sendText(t);
  }, 250);
}
function clearPendingSend() {
  clearTimeout(pendingSendTimer);
  pendingSendTimer = null;
  pendingSendText = "";
}
async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!agreed) {
    toast(I18N.t("pet.termsToast"));
    return;
  }
  if (busy) {
    pendingSendText = text;
    clearTimeout(pendingSendTimer);
    pendingSendTimer = setTimeout(maybeFlushPendingSend, 300);
    inputEl.value = "";
    wake();
    return;
  }
  await sendText(text);
}

async function sendText(text) {
  if (!agreed) {
    toast(I18N.t("pet.termsToast"));
    return;
  }
  // 被打断反应（v2.6）：她正在说话时你开口，先小声应一句再听你的
  if (isSpeakingAudio && ttsConfig.enabled) {
    try { speak("啊……好好好，你先说，我听着呢！", "surprised"); } catch { /* 打断反应失败不影响主流程 */ }
  }
  inputEl.value = "";
  replyBuffer = "";
  wake();
  // 问候语 → 挥手
  if (/^(早安|早上好|下午好|晚上好|你好|嗨|hi|hello|哈喽)/i.test(text)) {
    setMood("wave");
  } else {
    setMood("happy");
  }
  showBubble();
  hideThinking();
  bubbleText.textContent = "…";
  showThinking();
  try {
    await window.petAPI.ask(text);
  } catch (e) {
    showError(String(e));
  }
}

function showError(msg) {
  hideThinking();
  setMood("cry");
  showBubble();
  bubbleEl.classList.add("error");
  bubbleText.textContent = "苏苏洛委屈地撇撇嘴：" + msg;
  busy = false;
  updateControls();
  setTimeout(() => { bubbleEl.classList.remove("error"); }, 6000);
  scheduleBubbleHide(10000); // 错误气泡：等“唔……出错了”播完再隐藏，避免残留
}

function toast(msg) {
  showBubble();
  hideThinking();
  bubbleText.textContent = msg;
  scheduleBubbleHide(4000); // 语音/思考中不提前关掉气泡（防止误关正在显示的聊天回复）
}

/* ---------- TTS 语音 ---------- */
let ttsConfig = { enabled: true, voice: "", rate: 0.95, pitch: 1.1 };
let zhVoice = null;
let ttsCloudOn = true; // 云端语音开关（来自 config，失败自动回退系统语音）
let emotionalVoice = true; // 情绪语音开关（来自 features.emotionalVoice：语速/音调/语气词）
let emotionVoiceCfg = {};  // 情绪音色分档开关（v2.6）：{撒娇:true,…}，缺省=启用；停用档回默认音色/默认语气

function initTts() {
  const pick = () => {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    zhVoice =
      (ttsConfig.voice && voices.find((v) => v.name.toLowerCase().includes(ttsConfig.voice.toLowerCase()))) ||
      voices.find((v) => /xiaoxiao|huihui|yaoyao|kangkang|xiaoyi|yunxi|yunyang/i.test(v.name)) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh")) ||
      voices[0];
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
}

/** 朗读前清洗：去 emoji / 舞台动作括号 / 记号 */
function stripForSpeech(text) {
  return String(text || "")
    .replace(/\*[^*\n]{1,80}\*/g, "")      // 去 *动作*（RP 富渲染斜体，不朗读）
    .replace(/（[^）]*）/g, "")            // 去（舞台动作）
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "") // 去 emoji
    .replace(/[*_`#>【】"'""]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- 情绪语气词注入（原始）：让 TTS 按情绪带着语气朗读，比后处理变调自然 ---------- */
const EMOTION_SPEECH = {
  "开心": "呀！",
  "惊喜": "哇！",
  "生气": "哼！",
  "委屈": "呜…",
  "思考": "嗯…",
  "傲娇": "哼！",
  "撒娇": "嘛～"    // v2.6 撒娇更明显：句尾撒娇语气词
};
function emotionizeText(text, emotion) {
  const tail = EMOTION_SPEECH[emotion];
  if (!tail || !text) return text;
  return String(text).replace(/[。！？…~～\s]+$/, "") + tail;
}

/* 苏苏洛原声预设（游戏语音切片，随包 renderer/sounds/）：引擎不可用时的替代反馈 */
let presetAudio = null;
function playPresetVoice() {
  stopTts();
  try {
    const idx = 1 + Math.floor(Math.random() * 5);
    const names = ["017", "018", "021", "023", "025"];
    presetAudio = new Audio("sounds/preset-" + names[(idx - 1) % names.length] + ".wav");
    isSpeakingAudio = true;
    const done = () => { isSpeakingAudio = false; setTimeout(flushPendingAmbient, 250); }; // 播完补发暂存后台台词（O4 短提示音场景）
    presetAudio.onended = done; presetAudio.onerror = done;
    presetAudio.play().catch(() => { isSpeakingAudio = false; });
  } catch (e) { isSpeakingAudio = false; }
}

function speakSystem(clean, rateOverride, pitchOverride) {
  stopTts();
  // O4（2026-09-06）：系统音兜底可配置——tts=读中文（现状）/ mute=静音 / preset=短提示音
  const mode = ttsConfig.systemVoiceFallback || "tts";
  if (mode === "mute") { // 静音：不发声，仅气泡展示，保持收尾节奏（补发暂存后台台词）
    isSpeakingAudio = false;
    setTimeout(flushPendingAmbient, 250);
    return;
  }
  if (mode === "preset") { // 短提示音：播角色语音切片替代读中文
    playPresetVoice();
    setTimeout(flushPendingAmbient, 250);
    return;
  }
  try {
    const u = new SpeechSynthesisUtterance(clean);
    if (zhVoice) u.voice = zhVoice;
    u.lang = (zhVoice && zhVoice.lang) || "zh-CN";
    u.rate = rateOverride || ttsConfig.rate || 0.95;
    u.pitch = pitchOverride || ttsConfig.pitch || 1.1;
    u.volume = 1;
    isSpeakingAudio = true;
    const finish = () => { isSpeakingAudio = false; setTimeout(flushPendingAmbient, 250); }; // 语音自然结束 → 补发暂存的后台台词
    u.onend = finish; u.onerror = finish;
    speechSynthesis.speak(u);
  } catch (e) { isSpeakingAudio = false; console.error("系统语音失败:", e); }
}

// 气泡隐藏控制：等待语音播放完毕后再隐藏
let isSpeakingAudio = false;
let bubbleHideTimer = null;
// 防重复保险
let lastSpoken = { text: "", ts: 0 };

// 情绪 → 语音参数映射（原始）
const EMOTION_VOICE = {
  "开心": { rate: 1.12, pitch: 1.12 },
  "惊喜": { rate: 1.18, pitch: 1.18 },
  "生气": { rate: 0.88, pitch: 0.82 },
  "委屈": { rate: 0.78, pitch: 0.92 },
  "思考": { rate: 0.92, pitch: 0.96 },
  "睡觉": { rate: 0.62, pitch: 0.80 },
  "傲娇": { rate: 1.06, pitch: 1.08 },
  "撒娇": { rate: 1.10, pitch: 1.12 },   // v2.6 撒娇更明显：比默认更快更甜（配合参考音频）
  "温柔": { rate: 0.94, pitch: 1.02 },   // v2.6 温柔档：略慢、软化
};

function scheduleBubbleHide(delayMs = 5000) {
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  let waits = 0;
  const check = () => {
    if (busy || isSpeakingAudio) {
      // 还在思考/说话：等语音播完或回复结束后再隐藏，防止气泡提前消失
      //（原实现 1s 后只查 busy，长语音时语音未结束气泡就被关了）
      if (++waits > 240) { hideBubble(); return; } // 防死循环：最多再等 4 分钟
      bubbleHideTimer = setTimeout(check, 1000);
    } else {
      hideBubble();
    }
  };
  bubbleHideTimer = setTimeout(check, delayMs);
}

let cloneAudio = null;
let activeAudioFinish = null;
let playbackEpoch = 0;
function stopTts() {
  playbackEpoch += 1;
  try { speechSynthesis.cancel(); } catch { /* 忽略 */ }
  if (cloneAudio) { try { cloneAudio.pause(); cloneAudio.currentTime = 0; } catch { /* 忽略 */ } }
  if (activeAudioFinish) activeAudioFinish();
  cloneAudio = null;
  activeAudioFinish = null;
  // v2.5.5 流式：作废排队中的 part，停止当前 part
  ttsPartEpoch += 1;
  ttsPartQueue = [];
  if (ttsPartAudio) { try { ttsPartAudio.pause(); } catch { /* 忽略 */ } ttsPartAudio = null; }
  ttsPartPlaying = false;
  isSpeakingAudio = false;
}

/* v2.5.5 逐句流式播放：主进程每合成完一句推给渲染层，先到先播（长回复感知提速） */
let ttsPartQueue = [];
let ttsPartPlaying = false;
let ttsPartEpoch = 0;
let ttsPartAudio = null;
let ttsPartPlayedCount = 0; // 累计已播 part 数（speak 用它判断是否跳过整段合并音频）
let speakActive = false;    // speak 进行中才接收流式 part

function playNextTtsPart() {
  if (ttsPartPlaying) return;
  let part = ttsPartQueue.shift();
  while (part && part.epoch !== ttsPartEpoch) part = ttsPartQueue.shift(); // 丢弃已作废 part
  if (!part) return;
  ttsPartPlaying = true;
  try {
    const isWav = part.b64.slice(0, 8) === "UklGRg==";
    const audio = new Audio("data:" + (isWav ? "audio/wav" : "audio/mpeg") + ";base64," + part.b64);
    ttsPartAudio = audio;
    audio.volume = 1;
    audio.playbackRate = Math.max(0.9, Math.min(1.1, ttsConfig.rate || 0.95));
    isSpeakingAudio = true;
    const done = () => {
      if (ttsPartAudio === audio) ttsPartAudio = null;
      ttsPartPlaying = false;
      if (ttsPartQueue.length) {
        // 句子间停顿 200~260ms：流式播放跳过了主进程合并时的静音间隔，这里补上自然断句
        const pauseMs = 200 + Math.round(Math.random() * 60);
        setTimeout(() => { if (ttsPartQueue.length) playNextTtsPart(); }, pauseMs);
      } else {
        isSpeakingAudio = false;
        setTimeout(flushPendingAmbient, 250); // 流式末句播完 → 补发暂存台词
      }
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  } catch { ttsPartPlaying = false; isSpeakingAudio = false; }
}
if (window.petAPI.onTtsPart) {
  window.petAPI.onTtsPart((part) => {
    if (!part || !part.b64 || !speakActive) return; // 非说话时段/已停止：不收
    if (part.session !== undefined && part.session !== speakSession) return; // v2.6 旧会话的 part 让位（消息生成防抖）
    ttsPartPlayedCount += 1;
    ttsPartQueue.push({ b64: part.b64, epoch: ttsPartEpoch });
    playNextTtsPart();
  });
}

const FIXED_ONLY_MISS = "__SUZURAN_FIXED_ONLY_MISS__";
let speakSession = 0;   // 语音会话号：新消息的 speak 让旧消息的合成结果/part 作废（消息生成防抖）
async function speak(text, emotion, lineId, fixedLine = false) {
  if (!ttsConfig.enabled) return;
  const toneOn = !(emotionVoiceCfg[emotion] === false); // 该情绪音色分档是否启用（停用 → 默认音色/默认语气）
  let clean = stripForSpeech(text);
  if (emotionalVoice && toneOn) clean = emotionizeText(clean, emotion); // 情绪语气词注入（仅朗读，气泡仍显示原文）
  if (!clean) return;
  const now = Date.now();
  if (clean === lastSpoken.text && now - lastSpoken.ts < 10000) {
    window.petAPI.playback("重复文本已跳过: " + clean.slice(0, 30));
    return;
  }
  const mySession = ++speakSession;
  stopTts(); // 新消息接管语音：停掉上一条的音频与排队 part，等价于旧会话全部作废
  // 情绪语音参数（关闭/该档停用 → 默认语速/音调）
  const ev = (emotionalVoice && toneOn) ? (EMOTION_VOICE[emotion] || {}) : {};
  const speakRate = (ttsConfig.rate || 0.9) * (ev.rate || 1.0);
  const speakPitch = (ttsConfig.pitch || 1.1) * (ev.pitch || 1.0);
  speakActive = true; // v2.5.5 流式接收窗口
  const sdTts = SPEECH_DIAG ? speechDiagStart("tts") : 0; // SPEECHDIAG：实际语音开始（早退路径不占 session）
  if (SPEECH_DIAG) speechDiagLog("TTS_START", sdTts);
  try {
  // 优先克隆语音链路（Genie / GPT-SoVITS 日语 / Cosy / edge，主进程内部选择）
  if (ttsCloudOn) {
    try {
      const partsBefore = ttsPartPlayedCount;
      const b64 = await window.petAPI.speakClone(clean, { emo: emotion, session: mySession, lineId, fixedLine, fixedText: fixedLine ? text : "" }); // 固定台词优先按 lineId 直查缓存，动态句按文本/情绪回退
      if (mySession !== speakSession) return; // 等待期间来了新消息：本会话结果整体作废
      if (b64 === FIXED_ONLY_MISS && fixedLine) {
        window.petAPI.playback("固定台词离线模式未命中缓存，保持静音，不回退系统音 lineId=" + String(lineId || "-"));
        toast("这句固定台词还没有预加载，离线模式下暂不播放；请在设置里重试失败项。");
        return;
      }

      if (b64 && ttsPartPlayedCount > partsBefore) {
        // 已逐句流式播放：跳过整段合并音频，避免重复
        lastSpoken = { text: clean, ts: Date.now() };
        window.petAPI.playback("流式播放 parts=" + (ttsPartPlayedCount - partsBefore) + "（跳过合并段）");
        return;
      } else if (b64) {
        const isWav = b64.slice(0, 8) === "UklGRg==";
        const audio = new Audio("data:" + (isWav ? "audio/wav" : "audio/mpeg") + ";base64," + b64);
        const epoch = ++playbackEpoch;
        stopTts();
        playbackEpoch = epoch;
        cloneAudio = audio;
        audio.volume = 1;
        audio.playbackRate = Math.max(0.9, Math.min(1.1, speakRate));
        isSpeakingAudio = true;
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (activeAudioFinish === finish) activeAudioFinish = null;
            if (cloneAudio === audio) cloneAudio = null;
            if (epoch === playbackEpoch) { isSpeakingAudio = false; setTimeout(flushPendingAmbient, 250); } // 合并音频播完 → 补发暂存台词
            resolve();
          };
          const timeout = setTimeout(() => { try { audio.pause(); } catch { /* 忽略 */ } finish(); }, 180000);
          activeAudioFinish = finish;
          audio.onended = finish;
          audio.onerror = finish;
          audio.onabort = finish;
          audio.onstalled = () => setTimeout(finish, 5000);
          audio.play().catch(finish);
        });
        if (epoch === playbackEpoch) {
          lastSpoken = { text: clean, ts: Date.now() };
          window.petAPI.playback("云端音频播放完成 len=" + b64.length);
        }
        return;
      }
      window.petAPI.playback("speakClone 返回空");
    } catch (e) {
      if (mySession !== speakSession) return; // 已被新消息取代：不再凑错误语音
      stopTts();
      console.error("云端语音播放失败:", e);
      window.petAPI.playback("播放失败: " + (e && e.message || e));
    }
  }
  if (mySession !== speakSession) return; // 等待/失败期间来了新消息：不回退（不然旧句会用兜底音补读）
  // 引擎全不可用 → 用系统语音读回复内容（旧版行为，符合"念聊天框里的东西"的预期；
  // 不播随机原声预设冒充回复——那是"随机日文台词"误读的来源）
  window.petAPI.playback("语音引擎不可用 → 回退系统语音");
  speakSystem(clean);
  } finally {
    if (SPEECH_DIAG) { speechDiagLog("TTS_END", sdTts); speechDiagEnd(sdTts); }
    if (mySession === speakSession) {
      speakActive = false; // 只由最新会话收口流式接收窗口
      reconcileSpineAnimation("speech-end");
    }
  }
}

/* ---------- 对话框：放大/还原 + 尺寸记忆 ---------- */
const zoomBtn = document.getElementById("btn-zoom");
const btnClose = document.getElementById("btn-close");
if (btnClose) btnClose.addEventListener("click", () => {
  hideBubble(); // 仅收起气泡画面；正在播放的语音不受影响，会继续播完
});
let winSize = { width: 260, height: 200 };
let enlarged = false;

function clampBubbleToWindow() {
  const maxW = Math.max(60, document.documentElement.clientWidth - 10);
  const maxH = Math.max(24, document.documentElement.clientHeight - 46); // 与 CSS max-height(100%-46px) 一致：bottom 34px + 顶部余量
  const curW = parseFloat(bubbleEl.style.width) || 0;
  const curH = parseFloat(bubbleEl.style.height) || 0;
  if (curW > maxW || curH > maxH) {
    bubbleEl.style.width = Math.min(curW, maxW) + "px";
    bubbleEl.style.height = Math.min(curH, maxH) + "px";
  }
}

function applyBubbleSize() {
  try {
    if (activeRenderMode === "rig" && rigRuntime) { // rig 模式：气泡尺寸交给 rig 布局 CSS，不恢复拖拽记忆/固定宽高
      bubbleEl.style.width = "";
      bubbleEl.style.height = "";
      return;
    }
    const w = parseFloat(localStorage.getItem("suzuran.bubbleW"));
    const h = parseFloat(localStorage.getItem("suzuran.bubbleH"));
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 60 && h >= 24) {
      bubbleEl.style.width = Math.min(w, document.documentElement.clientWidth - 10) + "px";
      bubbleEl.style.height = Math.min(h, document.documentElement.clientHeight - 46) + "px";
    } else {
      // 非法/超限值：清掉，恢复自适应
      localStorage.removeItem("suzuran.bubbleW");
      localStorage.removeItem("suzuran.bubbleH");
      bubbleEl.style.width = "";
      bubbleEl.style.height = "";
    }
  } catch { /* 忽略 */ }
}

zoomBtn.addEventListener("click", () => {
  enlarged = !enlarged;
  document.body.classList.toggle("enlarged", enlarged);
  // 放大聊天框暂停行走：窗口尺寸剧变会打乱行走几何（charInset/minX 全变），且放大窗口下拖动后易位置错乱/消失；还原恢复
  window.petAPI.walkingPause && window.petAPI.walkingPause(enlarged, "zoom");
  if (activeRenderMode === "rig" && rigRuntime) {
    // rig 模式：放大按钮只放大气泡，不改变窗口（rig 窗口由大小滑杆 rigScale 控制，避免角色跟着放大）
    zoomBtn.textContent = enlarged ? "⤡" : "⤢";
    if (enlarged) showBubble();
    if (enlarged) { bubbleEl.style.width = ""; bubbleEl.style.height = ""; }
    setTimeout(clampBubbleToWindow, 80);
    return;
  }
  const restoreW = activeRenderMode === "live2d" ? 300 : winSize.width; // live2d 专属窗口：还原回 300×460 而非旧记忆尺寸
  const restoreH = activeRenderMode === "live2d" ? 460 : winSize.height;
  window.petAPI.setSize(enlarged ? 480 : restoreW, enlarged ? 640 : restoreH);
  zoomBtn.textContent = enlarged ? "⤡" : "⤢";
  if (enlarged) showBubble(); // 放大时把气泡亮出来
  // 窗口切换后：清掉记忆的固定尺寸，让气泡按新窗口自动缩放显示（超限由 clamp 收拢）
  if (enlarged) { bubbleEl.style.width = ""; bubbleEl.style.height = ""; }
  setTimeout(clampBubbleToWindow, 80); // 窗口切换后收拢超限气泡
  if (!enlarged && appearanceCfg) setTimeout(() => applyAppearance(appearanceCfg), 120); // 还原时恢复设置的气泡宽度/窗口宽
});

// 用户拖拽气泡右下角调整大小后记住（下次打开保持；超窗尺寸自动截断）
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (bubbleEl.style.width && bubbleEl.style.height) {
      const r = bubbleEl.getBoundingClientRect();
      try {
        localStorage.setItem("suzuran.bubbleW", String(Math.round(Math.min(r.width, document.documentElement.clientWidth - 10))));
        localStorage.setItem("suzuran.bubbleH", String(Math.round(Math.min(r.height, document.documentElement.clientHeight - 46))));
      } catch { /* 忽略 */ }
    }
  }).observe(bubbleEl);
}

/* ---------- 聊天外观（设置页即时下发：字号/字体/气泡宽度，含本地导入字体） ---------- */
let appearanceCfg = null;

function injectFontFace(file) { // 导入的字体文件位于 renderer/fonts/user/，按需注册 @font-face
  const id = "cffont-" + file;
  if (document.getElementById(id)) return;
  const st = document.createElement("style");
  st.id = id;
  st.textContent = `@font-face{font-family:"cf-${file}";src:url("pet-user://fonts/user/${encodeURIComponent(file)}");}`;
  document.head.appendChild(st);
}

/** 气泡需要更宽窗口时自动加宽（宽度=气泡+角色条带余量，按 zoom 换算成窗口 DIP）
 *  行走中保持标准窗口：大窗口会让主进程 charInset（=窗口宽-122）超上限，行走左边界扩出屏幕导致“闪现” */
function ensureWindowWidthFor(bubbleW) {
  if (activeRenderMode === "rig" && rigRuntime) return; // rig 模式：窗口尺寸由 rigScale 控制，气泡宽度调整不放大窗口/角色
  if (walkState.active) return;        // 行走中：保持标准窗口（气泡在窗口内自适应/滚动），避免出屏
  const zoom = parseFloat(document.body.style.zoom) || 1;
  const need = Math.ceil((bubbleW + 140) * zoom);
  window.petAPI.setSize(Math.max(winSize.width, need), winSize.height);
}

function applyAppearance(a) {
  appearanceCfg = a || {};
  const root = document.documentElement.style;
  root.setProperty("--chat-fz", (Number(a.fontSize) > 0 ? Number(a.fontSize) : 11) + "px");
  let ff = "";
  if (a.fontFamily && a.fontFamily.startsWith("custom:")) {
    const f = a.fontFamily.slice(7);
    injectFontFace(f);
    ff = `"cf-${f}"`;
  } else if (a.fontFamily) {
    ff = `"${a.fontFamily}", "Microsoft YaHei"`;
  }
  bubbleEl.style.fontFamily = ff;
  const inputBar = document.getElementById("input-bar");
  if (inputBar) inputBar.style.fontFamily = ff; // 输入框与气泡同字体
  if (Number(a.bubbleWidth) > 0) {              // 固定宽度：高度恢复内容自适应
    // rig 模式气泡宽度由 rig 布局 CSS 控制（设置页固定宽度是给 gif/spine 大窗口用的，300px 窗口会溢出）
    bubbleEl.style.width = (activeRenderMode === "rig" && rigRuntime) ? "" : Number(a.bubbleWidth) + "px";
    bubbleEl.style.height = "";
    if (!enlarged) ensureWindowWidthFor(Number(a.bubbleWidth));
  } else {
    applyBubbleSize();                          // 恢复自适应/拖拽记忆尺寸
  }
}
if (window.petAPI.onAppearanceChanged) window.petAPI.onAppearanceChanged(applyAppearance);

/* 事件绑定 */
window.petAPI.onThinking(({ mode }) => {
  busy = true;
  currentMode = mode;
  setBubbleMode(mode);
  updateControls();
  showThinking();
  replyBuffer = "";
  // 任务模式 → 打字工作表情；聊天 → 思考
  setMood(mode === "zcode" ? "work" : "think");
  if (SPEECH_DIAG) {
    if (diagThinkingId) speechDiagEnd(diagThinkingId); // 理论不重叠；保险先关旧再开新
    diagThinkingId = speechDiagStart("thinking");
    speechDiagLog("THINKING_START", diagThinkingId, mode);
  }
});

window.petAPI.onChunk(({ id, mode, text }) => {
  if (!busy) { busy = true; setBubbleMode(mode); updateControls(); }
  hideThinking();
  replyBuffer += text;
  if (mode !== "zcode") {
    // 情绪标注（【情绪：xx】）不显示在气泡里，到结尾处截掉
    const mi = replyBuffer.indexOf("【情绪");
    if (mi >= 0) replyBuffer = replyBuffer.slice(0, mi);
  }
  if (mode === "zcode") {
    bubbleText.textContent = replyBuffer.slice(-4000);
  } else {
    startReveal(replyBuffer, bubbleText.textContent.length);
  }
});

let swipeState = null; // Swipes：{index,total}（当前回复的多版本状态）
function renderSwipeBar() {
  const bar = document.getElementById("swipe-bar");
  if (!bar) return;
  const pos = document.getElementById("swipe-pos");
  const multi = swipeState && swipeState.total > 1;
  bar.classList.toggle("hidden", !swipeState);
  if (!swipeState) return;
  if (pos) pos.textContent = multi ? (swipeState.index + 1) + "/" + swipeState.total : "";
  const prev = document.getElementById("swipe-prev");
  const next = document.getElementById("swipe-next");
  if (prev) prev.style.visibility = multi && swipeState.index > 0 ? "" : "hidden";
  if (next) next.style.visibility = multi && swipeState.index < swipeState.total - 1 ? "" : "hidden";
}
window.petAPI.onDone(({ mode, full, emotion, swipes, swipeIndex }) => {
  hideThinking();
  busy = false;
  if (SPEECH_DIAG && diagThinkingId) { speechDiagLog("THINKING_END", diagThinkingId, mode); speechDiagEnd(diagThinkingId); diagThinkingId = 0; }
  maybeFlushPendingSend(); // 生成防抖：回合结束，补发等待中的新消息
  const emoLabel = emotion ? String(emotion).trim() : "";
  if (mode === "zcode") {
    const result = (full || replyBuffer).slice(-4000);
    bubbleText.textContent = result;
    speak(result.length > 60 ? result.slice(0, 60) + "…" : result, emoLabel);
  } else {
    replyBuffer = full || replyBuffer;
    stopReveal();
    bubbleText.innerHTML = renderRpSlice(replyBuffer, replyBuffer.length);
    swipeState = (swipes && swipes.length) ? { index: swipeIndex || 0, total: swipes.length } : null;
    renderSwipeBar();
    speak(stripForSpeech(replyBuffer), emoLabel);
  }
  // 模型理解出的情绪 → 对应 GIF（没有匹配就用开心）
  const nm = emotion ? labelToName(String(emotion).trim()) : "";
  setMood(nm || "happy");
  setTimeout(() => { if (!busy) setMood("idle"); }, 2600);
  scheduleBubbleHide(90000); // 回复气泡：等语音播完再隐藏，防止提前消失
  updateControls();
  setTimeout(flushPendingAmbient, 250);
  resetSleepTimer();
});

window.petAPI.onError(({ message }) => {
  showError(message);
  if (SPEECH_DIAG && diagThinkingId) { speechDiagLog("THINKING_END", diagThinkingId, "error"); speechDiagEnd(diagThinkingId); diagThinkingId = 0; } // 错误路径同样收口 thinking session
  maybeFlushPendingSend(); // 防抖：错误后补发等待中的消息（用户想说的还是会被回答）
  speak("唔……出错了。");
  setTimeout(flushPendingAmbient, 250);
});

// v2.6 主动停止：主进程中止路径不再发 done/error，收到 stopped 才复位 busy/语音，丢弃防抖缓冲
if (window.petAPI.onStopped) {
  window.petAPI.onStopped(() => {
    stopTts();
    clearPendingSend(); // 用户要静默：不补发缓冲中的消息
    busy = false;
    if (SPEECH_DIAG && diagThinkingId) { speechDiagLog("THINKING_END", diagThinkingId, "stopped"); speechDiagEnd(diagThinkingId); diagThinkingId = 0; }
    updateControls();
    hideThinking();
    reconcileSpineAnimation("speech-end");
    setTimeout(flushPendingAmbient, 250);
  });
}

window.petAPI.onModeChanged((m) => {
  forcedMode = m;
  updateChip();
});

window.petAPI.onToggleInput(() => toggleInputBar());

/* Agent 任务状态（zcode 模式，借鉴 dsh-dafeiyu 反幻觉原则）：只显示真实任务文本+计时，不编造阶段百分比 */
let agentStatusTimer = null;
if (window.petAPI.onAgentStatus) {
  window.petAPI.onAgentStatus((s) => {
    if (agentStatusTimer) { clearInterval(agentStatusTimer); agentStatusTimer = null; }
    if (s && s.state === "working") {
      const t0 = s.since || Date.now();
      const brief = String(s.text || "任务").slice(0, 20);
      bubbleText.textContent = "🔧 正在执行：" + brief + "…（0 秒）";
      showBubble();
      agentStatusTimer = setInterval(() => {
        const sec = Math.round((Date.now() - t0) / 1000);
        bubbleText.textContent = "🔧 正在执行：" + brief + "…（已 " + sec + " 秒）";
      }, 1000);
    }
    // done：只停表，随后的 pet:done / pet:error 会正常覆盖气泡内容
  });
}

window.petAPI.onToast((msg) => toast(msg));
if (window.petAPI.onNameChanged) {
  window.petAPI.onNameChanged((name) => applyPetName(name));
}

/* ---------- 桌面行走 / 渲染模式切换（主进程 → 渲染层） ---------- */
if (window.petAPI.onWalking) {
  window.petAPI.onWalking((s) => applyWalkState(s));
}
if (window.petAPI.onDropped) {
  if (document.getElementById("swipe-bar")) {
  document.getElementById("swipe-prev").addEventListener("click", () => window.petAPI.swipeMove(-1));
  document.getElementById("swipe-next").addEventListener("click", () => window.petAPI.swipeMove(1));
  document.getElementById("swipe-regen").addEventListener("click", () => {
    if (busy) return;
    showThinking();
    window.petAPI.regenerate();
  });
}
if (window.petAPI.onSwipeChanged) {
  window.petAPI.onSwipeChanged((s) => { // 切换版本：更新气泡（不重复朗读）
    swipeState = s;
    replyBuffer = s.content;
    bubbleText.innerHTML = renderRpSlice(s.content, s.content.length);
    renderSwipeBar();
  });
}
window.petAPI.onDropped(() => {
  if (activeRenderMode === "live2d" && live2dActive) { try { window.Live2DRuntime.poke(); } catch { /* 忽略 */ } return; } // Live2D：放下抖一下
  if (!(activeRenderMode === "rig" && rigRuntime)) playSpineInteract(); // 2.5D 模式不播 Spine 互动
});
}
function renderModeErrorText(error) {
  return error ? String(error && (error.message || error) || error).slice(0, 300) : undefined;
}
async function reportRenderModeOutcome(mainSeq, requestedMode, result, isCurrent) {
  if (!Number.isSafeInteger(mainSeq) || !isCurrent() || !result ||
      (result.status !== "ready" && result.status !== "noop") ||
      !RENDER_MODES.includes(result.committedMode)) return;
  if (result.committedMode === "spine") {
    // A-v2.3 ready 语义：对 Spine 而言，“ready”必须= owner bootstrap 首见完成（TARGET/fitted decision + replay + visible）；
    // 事件驱动 await，不新增计时器（done 必被 release/abandon 结算，failsafe 保证有界）。
    try { await spineBootstrapDone; } catch { /* done 永不 reject；防御 */ }
    if (!isCurrent()) return; // 等首见期间被更新 request 取代：该 ready 已失效，绝不上报旧世代
  }
  try {
    window.petAPI.reportRenderModeOutcome && window.petAPI.reportRenderModeOutcome({
      seq: mainSeq,
      ok: result.fallback !== true && result.committedMode === requestedMode,
      requestedMode,
      committedMode: result.committedMode,
      error: renderModeErrorText(result.error)
    });
  } catch { /* IPC 窗口销毁等瞬时错误忽略 */ }
}
function reportRenderModeCorrection(baseSeq, sourceMode, result, isCurrent) {
  if (!Number.isSafeInteger(baseSeq) || !isCurrent() || !result || result.fallback !== true ||
      result.status !== "ready" || result.requestedMode !== sourceMode || result.committedMode !== "gif") return;
  try {
    window.petAPI.reportRenderModeCorrection && window.petAPI.reportRenderModeCorrection({
      baseSeq,
      sourceMode,
      committedMode: "gif",
      error: renderModeErrorText(result.error)
    });
  } catch { /* IPC 窗口销毁等瞬时错误忽略 */ }
}
function isCurrentInternalRenderResult(baseSeq, result) {
  return Number.isSafeInteger(baseSeq) && currentMainRenderModeSeq === baseSeq &&
    result && renderSwitchGeneration === result.generation && requestedRenderMode === "gif";
}
function isStableFormalRenderMode(mode, mainSeq) {
  return Number.isSafeInteger(mainSeq) && currentMainRenderModeSeq === mainSeq &&
    renderSwitchStatus === "ready" && renderRuntimeReady && activeRenderGeneration > 0 &&
    !!renderRuntimeResource && activeRenderMode === mode && requestedRenderMode === mode;
}
async function reconcileFormalRenderMode(mode, mainSeq) {
  if (!Number.isSafeInteger(mainSeq) || currentMainRenderModeSeq !== mainSeq) return false;
  while (currentMainRenderModeSeq === mainSeq) {
    const ownerPromise = currentRenderSwitchPromise;
    await ownerPromise;
    if (currentMainRenderModeSeq !== mainSeq) return false;
    if (isStableFormalRenderMode(mode, mainSeq)) {
      reportRenderModeOutcome(mainSeq, mode, {
        status: "ready",
        requestedMode: mode,
        committedMode: activeRenderMode,
        fallback: false
      }, () => isStableFormalRenderMode(mode, mainSeq));
      return true;
    }
    if (currentRenderSwitchPromise !== ownerPromise) continue;
    return false;
  }
  return false;
}
if (window.petAPI.onUiEdgeCompact) window.petAPI.onUiEdgeCompact((v) => { const d = v || {}; document.body.classList.toggle("ui-edge-compact", typeof d === "object" ? !!d.value : !!d); });
if (window.petAPI.onRenderModeChanged) {
  window.petAPI.onRenderModeChanged(async (m) => {
    const request = m && typeof m === "object" ? m : { mode: m };
    if (enlarged) { // 切模式还原放大状态：zoom 暂停标志不跨模式残留
      enlarged = false;
      document.body.classList.remove("enlarged");
      zoomBtn.textContent = "⤢";
      window.petAPI.walkingPause && window.petAPI.walkingPause(false, "zoom");
    }
    const mode = RENDER_MODES.includes(request.mode) ? request.mode : "gif";
    const mainSeq = Number.isSafeInteger(request.seq) ? request.seq : null;
    if (mainSeq !== null && currentMainRenderModeSeq !== null && mainSeq < currentMainRenderModeSeq) return;
    // 先登记本次 mode intent；状态读取不能先于 generation，否则快速切换时它会成为无主 await。
    let result = await switchRenderMode(mode, {
      mainSeq,
      resourceId: mode === "rig" ? rigSkinId : mode === "live2d" ? live2dSkinId : undefined
    });
    let requestGeneration = result && result.generation;
    const isCurrentModeRequest = () => {
      const generationCurrent = requestGeneration !== undefined && renderSwitchGeneration === requestGeneration;
      return mainSeq !== null
        ? currentMainRenderModeSeq === mainSeq && generationCurrent
        : generationCurrent && requestedRenderMode === mode;
    };
    // 初次 switch 已被更新的 intent 淘汰时，只等待当前 owner 收敛，不再补读旧状态。
    if (!result) return;
    if (result.status === "superseded") {
      await reconcileFormalRenderMode(mode, mainSeq);
      return;
    }
    if (!isCurrentModeRequest()) {
      await reconcileFormalRenderMode(mode, mainSeq);
      return;
    }
    // fallback 已经完成最终 GIF commit；不能把 GIF 当成原 target 再触发一次资源修正。
    let state = null;
    if (!result.fallback) state = await window.petAPI.getState();
    // getState 期间可能已经发生了新的 mode/resource intent；旧回调不得写回或 force reload。
    if (!isCurrentModeRequest()) {
      await reconcileFormalRenderMode(mode, mainSeq);
      return;
    }
    if (!result.fallback) {
      if (typeof state?.rigSkinId === "string") rigSkinId = state.rigSkinId;
      if (typeof state?.live2dSkinId === "string") live2dSkinId = state.live2dSkinId;
      const latestResource = mode === "rig" ? rigSkinId : mode === "live2d" ? live2dSkinId : undefined;
      if (requestedRenderMode === mode && latestResource && result.resource !== latestResource) {
        if (!isCurrentModeRequest()) return;
        result = await switchRenderMode(mode, { force: true, mainSeq, resourceId: latestResource });
        requestGeneration = result && result.generation;
        if (!result || result.status === "superseded" || !isCurrentModeRequest()) {
          if ((result && result.status === "superseded") || !isCurrentModeRequest()) {
            await reconcileFormalRenderMode(mode, mainSeq);
          }
          return;
        }
      }
    }
    if (isCurrentModeRequest() && (result.status === "ready" || result.status === "noop")) {
      if (activeRenderMode === mode || result.fallback) setMood(lastMood || "idle"); // 切换/回退后恢复当前情绪
      if (!result.fallback && mode === "spine" && state.walkState && activeRenderGeneration === requestGeneration) {
        applyWalkState(state.walkState); // 新 owner ready 后重放最新行走状态，收敛 Sit/Rest/Move
      }
      // 初始 lastMouse 尚未有效，或旧模式此前处于穿透态时，ready 的新 owner 先恢复可点击；
      // 后续 mousemove/兜底判定会继续细化透明区域穿透。
      clickability.petSetClickable(true);
      reportRenderModeOutcome(mainSeq, mode, result, isCurrentModeRequest);
    }
  });
}
if (window.petAPI.onLive2dChanged) {
  window.petAPI.onLive2dChanged(async (id) => { // 同模式换模型：重载
    const baseMainSeq = currentMainRenderModeSeq;
    live2dSkinId = id || "";
    if (activeRenderMode !== "live2d" && requestedRenderMode !== "live2d") return;
    const result = await switchRenderMode("live2d", { force: true, resourceId: live2dSkinId });
    if ((result.status === "ready" || result.status === "noop") && activeRenderMode === "live2d") setMood(lastMood || "idle");
    reportRenderModeCorrection(baseMainSeq, "live2d", result,
      () => isCurrentInternalRenderResult(baseMainSeq, result));
  });
}

/** 换肤：销毁旧模型与画布，重新探测皮肤并完整初始化 */
async function rebuildSpine() {
  if (activeRenderMode !== "spine" && requestedRenderMode !== "spine") {
    return { status: "ignored" };
  }
  const baseMainSeq = currentMainRenderModeSeq;
  skinSwitching = true; // 换肤全程吞掉旧 context 销毁触发的 lost（新画布随后重建，不整页 reload）
  visibleCanvasGap = 0;
  visibleCanvasGapCandidate = 0;
  visibleCanvasGapHits = 0;
  spineTrackProbe = { name: "", time: NaN };
  try {
    // v2.5.24 修复：换肤 WebGL 上下文丢失——旧 context 释放与新 context 创建同帧交替，
    // 低配核显/显存压力下触发 webglcontextlost → 整页 reload（表现为切皮肤后"拿不起来"）。
    // 销毁后让出 200ms 等 GPU 完成旧 context 释放再重建
    // delayMs 属于本次 reload request；如果期间用户选择其他 mode，generation 会使它失效。
    const result = await switchRenderMode("spine", { force: true, delayMs: 200 });
    if (walkState.active) applyWalkState(walkState);
    reportGroundGap();
    return { ...result, baseMainSeq };
  } catch (e) {
    console.error("[Spine] 换肤重建失败:", e);
    return { status: "failed", error: e, baseMainSeq };
  } finally {
    skinSwitching = false;
  }
}
if (window.petAPI.onSpineSkinChanged) {
  window.petAPI.onSpineSkinChanged(async () => {
    if (activeRenderMode !== "spine" && requestedRenderMode !== "spine") return;
    const result = await rebuildSpine();
    if ((result && result.status === "ready") && activeRenderMode === "spine") setMood(lastMood || "idle");
    reportRenderModeCorrection(result && result.baseMainSeq, "spine", result,
      () => isCurrentInternalRenderResult(result && result.baseMainSeq, result));
  });
}
if (window.petAPI.onRigSkinChanged) { // v2.2：2.5D 皮肤切换（独立于 Spine）
  window.petAPI.onRigSkinChanged(async (id) => {
    const baseMainSeq = currentMainRenderModeSeq;
    rigSkinId = id || "";
    const rigRequested = requestedRenderMode === "rig" || activeRenderMode === "rig";
    if (!rigRequested) return;
    if (id) {
      const result = await switchRenderMode("rig", { force: true, resourceId: id });
      if ((result.status === "ready" || result.status === "noop") && activeRenderMode === "rig") setMood(lastMood || "idle");
      reportRenderModeCorrection(baseMainSeq, "rig", result,
        () => isCurrentInternalRenderResult(baseMainSeq, result));
    } else {
      // 无资源时保持现有内部换肤路径；B-2 fallback 后向 main 发独立 correction。
      const result = await switchRenderMode("rig", { force: true, resourceId: "" });
      reportRenderModeCorrection(baseMainSeq, "rig", result,
        () => isCurrentInternalRenderResult(baseMainSeq, result));
    }
  });
}
if (window.petAPI.onRigScaleChanged) { // v2.2：2.5D 角色大小实时调整
  window.petAPI.onRigScaleChanged((v) => applyRigScale(v));
}
if (window.petAPI.onRigMouseFollowChanged) { // v2.2.1：2.5D 头部/眼睛跟随鼠标实时切换
  window.petAPI.onRigMouseFollowChanged((v) => {
    rigMouseFollow = !!v;
    if (activeRenderMode === "rig" && rigRuntime) rigRuntime.setAuto("mouse", rigMouseFollow);
  });
}
if (window.petAPI.onMouseTrackGlobalChanged) { // v2.2.1：全局鼠标跟踪许可实时切换（需设置页显式开启）
  window.petAPI.onMouseTrackGlobalChanged((v) => {
    mouseTrackGlobal = !!v;
    if (activeRenderMode === "rig" && rigRuntime) rigRuntime.setMouseMode(mouseTrackGlobal);
  });
}
if (window.petAPI.onMousePos) { // v2.2.1：主进程轮询的全局鼠标位置 → 换算为相对角色偏移注入
  window.petAPI.onMousePos((p) => {
    if (!rigRuntime || !mouseTrackGlobal) return;
    const b = p.win || {};
    if (!b.width || !b.height) return;
    const mx = (p.x - (b.x + b.width / 2)) / (b.width / 2);
    const my = (p.y - (b.y + b.height / 2)) / (b.height / 2);
    rigRuntime.setExternalMouse(mx, my);
  });
}
if (window.petAPI.onPlayAnim) {
  window.petAPI.onPlayAnim((name) => { // 托盘「动作试演」点播
    if (!spineObj || activeRenderMode !== "spine" || !spineHas(name)) return;
    animDemoUntil = Date.now() + 15000; // 播 15 秒，期间行走相位不抢动画
    setSpineAnim(name, true, "demo");
    scheduleFitSpine({});
  });
}

// 表情被替换/情绪增删后：重建情绪表并刷新当前显示的 GIF
window.petAPI.onSpritesChanged(({ name, moods }) => {
  if (Array.isArray(moods)) MOODS = moods;
  if (spriteEl.src) {
    spriteEl.src = spriteEl.src.split("?")[0] + "?t=" + Date.now();
  }
});

/* ---------- 输入栏 ---------- */
function toggleInputBar() {
  wake();
  clickability.petSetClickable(true);
  inputBar.classList.toggle("hidden");
  clampBubbleToWindow();
  if (!inputBar.classList.contains("hidden")) {
    inputEl.focus();
    setMood("idle");
  }
}

function updateControls() {
  btnStop.classList.toggle("hidden", !busy);
  btnSend.disabled = busy;
}

function updateChip() {
  if (!zcodeEnabled) {
    modeChip.textContent = "💬";
    modeChip.className = "mode-chip";
    modeChip.title = "日常聊天";
    return;
  }
  if (forcedMode === "zcode") {
    modeChip.textContent = "⚡";
    modeChip.className = "mode-chip zcode";
    modeChip.title = "强制任务模式：点此恢复自动";
  } else if (forcedMode === "chat") {
    modeChip.textContent = "💬";
    modeChip.className = "mode-chip";
    modeChip.title = "强制聊天模式：点此恢复自动";
  } else {
    modeChip.textContent = "💬";
    modeChip.className = "mode-chip";
    modeChip.title = "自动路由：/zcode 或 /任务 开头自动执行任务";
  }
}

btnSend.addEventListener("click", send);
btnStop.addEventListener("click", () => { window.petAPI.stop(); });
inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
inputEl.addEventListener("input", () => { lastInputAt = Date.now(); });
modeChip.addEventListener("click", () => {
  if (!zcodeEnabled) { window.petAPI.setMode("auto"); return; } // 任务模式未启用 → 保持自动
  const next = forcedMode === "auto" ? "chat" : forcedMode === "chat" ? "zcode" : "auto";
  window.petAPI.setMode(next);
});
modeChip.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); modeChip.click(); }
});
btnSend.disabled = false;

/* ---------- 语音输入（麦克风录音 → whisper 转写 → 填入输入框） ---------- */
const btnMic = document.getElementById("btn-mic");
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

if (btnMic) {
  btnMic.addEventListener("mousedown", startRecording);
  btnMic.addEventListener("mouseup", stopRecording);
  btnMic.addEventListener("mouseleave", () => { if (isRecording) stopRecording(); });
}

async function startRecording() {
  if (isRecording || busy) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    audioChunks = [];
    isRecording = true;
    btnMic.textContent = "⏺";
    btnMic.classList.add("recording");
    inputEl.placeholder = I18N.t("ui.micRecording");
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    console.error("无法访问麦克风:", e);
    toast("无法访问麦克风，请检查权限设置");
    isRecording = false;
  }
}

async function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  btnMic.textContent = "🎤";
  btnMic.classList.remove("recording");
  inputEl.placeholder = I18N.t("ui.placeholder");

  mediaRecorder.onstop = async () => {
    try {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      if (blob.size < 1000) return; // 太短，忽略

      // 转为 base64 发给主进程（用 FileReader，渲染层无 Buffer）
      const b64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = String(reader.result || "");
          resolve(dataUrl.split(",")[1] || "");
        };
        reader.readAsDataURL(blob);
      });
      if (!b64) return;

      // 通过新的 IPC 通道发送 base64 音频
      const result = await window.petAPI.voiceSttB64(b64, "zh"); // 识别语种=用户语音（中文），与语音音色（日语）无关
      if (result && result.ok && result.text) {
        inputEl.value = result.text;
        inputEl.focus();
        toast(`🎤 识别：${result.text.slice(0, 30)}${result.text.length > 30 ? "…" : ""}`);
      } else {
        toast("语音识别失败，请重试");
      }
    } catch (e) {
      console.error("语音处理失败:", e);
    }
  };
  mediaRecorder.stop();
  if (mediaRecorder.stream) {
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
}

/* ---------- 日程提醒提示音（v2.1）：双音 beep，提醒到点更有存在感 ---------- */
let beepCtx = null;
function playReminderBeep() {
  try {
    if (!beepCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      beepCtx = new AC();
    }
    if (beepCtx.state === "suspended") beepCtx.resume();
    const t0 = beepCtx.currentTime;
    const tone = (freq, start, dur, vol) => {
      const o = beepCtx.createOscillator();
      const g = beepCtx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(vol, t0 + start + 0.02);
      g.gain.setValueAtTime(vol, t0 + start + dur - 0.03);
      g.gain.linearRampToValueAtTime(0, t0 + start + dur);
      o.connect(g).connect(beepCtx.destination);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.05);
    };
    tone(880, 0, 0.18, 0.35);
    tone(1320, 0.22, 0.25, 0.35);
  } catch { /* 忽略 */ }
}
if (window.petAPI && window.petAPI.onScheduleDue) {
  window.petAPI.onScheduleDue(() => playReminderBeep());
}

let pendingAmbient = null;
const PENDING_AMBIENT_TTL_MS = 3 * 60 * 1000; // TD-2：暂存搭话 3 分钟过期——被忙/睡拦截的消息不该几分钟后还补发旧话
function flushPendingAmbient() {
  if (!pendingAmbient || busy || speakActive || isSpeakingAudio) return;
  if (pendingAmbient.createdAt && Date.now() - pendingAmbient.createdAt > PENDING_AMBIENT_TTL_MS) {
    window.petAPI.playback && window.petAPI.playback("[ambient] 丢弃过期暂存搭话（>" + (PENDING_AMBIENT_TTL_MS / 60000) + "分钟）: " + String(pendingAmbient.text || "").slice(0, 40));
    pendingAmbient = null;
    return;
  }
  const next = pendingAmbient;
  pendingAmbient = null;
  showBubble();
  bubbleText.textContent = next.text;
  if (!isSleeping || next.force) setMood(next.emotion || "idle");
  const sdFlush = SPEECH_DIAG ? speechDiagStart("proactive-flush") : 0;
  if (SPEECH_DIAG) speechDiagLog("PROACTIVE", sdFlush);
  const spFlush = speak(next.text, next.emotion, next.lineId, !!next.fixedLine);
  if (SPEECH_DIAG && spFlush && typeof spFlush.then === "function") spFlush.then(() => speechDiagEnd(sdFlush), () => speechDiagEnd(sdFlush));
  scheduleBubbleHide(30000);
}

/* ---------- 主动搭话（主进程发送 → 显示气泡 + 语音） ---------- */
if (window.petAPI && window.petAPI.onProactive) {
  window.petAPI.onProactive(({ text, emotion, force, lineId, fixedLine }) => {
    if (!text) return;
    if (!force && (busy || speakActive || isSpeakingAudio)) {
      pendingAmbient = { text, emotion, force: false, lineId, fixedLine, createdAt: Date.now() };
      return;
    }
    if (!force && isSleeping) {
      pendingAmbient = { text, emotion, force: false, lineId, fixedLine, createdAt: Date.now() };
      return;
    }
    pendingAmbient = null;
    showBubble();
    bubbleText.textContent = text;
    if (!isSleeping || force) setMood(emotion || "idle");
    const sdPro = SPEECH_DIAG ? speechDiagStart("proactive") : 0;
    if (SPEECH_DIAG) speechDiagLog("PROACTIVE", sdPro);
    const spPro = speak(text, emotion, lineId, !!fixedLine);
    if (SPEECH_DIAG && spPro && typeof spPro.then === "function") spPro.then(() => speechDiagEnd(sdPro), () => speechDiagEnd(sdPro));
    scheduleBubbleHide(30000); // 主动消息显示 30s（用户反馈 15s 偏短）
    // v2.5.25b 修复：说话后恢复行走/待机动画——与聊天回复(onDone)同款延迟回 idle。
    // 此前主动搭话说完后情绪动画一直挂着，走路动作不再回来（用户反馈"说话时没走路动作"）
    setTimeout(() => { if (!busy) setMood("idle"); }, 2600);
  });
}

/* ---------- TTS 开关按钮 ---------- */
const btnTts = document.getElementById("btn-tts");
function updateTtsButton() {
  if (!btnTts) return;
  btnTts.textContent = ttsConfig.enabled ? "🔊" : "🔇";
  btnTts.classList.toggle("off", !ttsConfig.enabled);
  btnTts.title = ttsConfig.enabled ? "语音：开（点此关闭）" : "语音：关（点此开启）";
}
if (btnTts) {
  btnTts.addEventListener("click", () => {
    const next = !ttsConfig.enabled;
    ttsConfig.enabled = next;
    updateTtsButton();
    if (!next) stopTts();
    window.petAPI.setTts(next);
  });
}
window.petAPI.onTtsChanged((v) => {
  ttsConfig.enabled = !!v;
  updateTtsButton();
});
window.petAPI.onRateChanged((v) => {
  ttsConfig.rate = v;
});

/* ---------- 信息版（陪伴时间 + 今日日程，v2.1） ---------- */
const infoPanel = document.getElementById("info-panel");
const infoCompanion = document.getElementById("info-companion");
const infoSchedules = document.getElementById("info-schedules");
const infoWeather = document.getElementById("info-weather");
function formatCompanion(firstRunAt) {
  if (!firstRunAt) return "第一天陪伴 ~";
  const days = Math.max(0, Math.floor((Date.now() - firstRunAt) / 86400000));
  const h = Math.floor(((Date.now() - firstRunAt) % 86400000) / 3600000);
  if (days === 0) return "已陪伴 " + Math.max(1, h) + " 小时 💗";
  return "已陪伴 " + days + " 天 " + h + " 小时 💗";
}
async function openInfoPanel() {
  if (!infoPanel) return;
  try {
    const info = await window.petAPI.getInfo();
    if (infoCompanion) infoCompanion.textContent = formatCompanion(info && info.firstRunAt);
    // 天气行（v2.5.26）：开启且有数据时显示
    if (infoWeather) {
      try {
        const w = await window.petAPI.getWeather();
        if (w) { infoWeather.style.display = ""; infoWeather.textContent = `🌤 ${w.desc} ${w.temp}°C · 湿${w.humidity}% · 风${w.wind}km/h`; }
        else infoWeather.style.display = "none";
      } catch { infoWeather.style.display = "none"; }
    }
    if (infoSchedules) {
      const list = (info && info.today) || [];
      infoSchedules.innerHTML = "";
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "info-empty";
        empty.textContent = "今日暂无日程，去「📅 日程安排」添加吧";
        infoSchedules.appendChild(empty);
      } else {
        for (const s of list) {
          const row = document.createElement("div");
          row.className = "info-sched";
          const t = document.createElement("span");
          t.className = "info-sched-time";
          const dd = s.display && s.display.time ? s.display.time : (s.nextAt ? new Date(s.nextAt).toTimeString().slice(0, 5) : "");
          t.textContent = dd;
          row.appendChild(t);
          row.appendChild(document.createTextNode(s.title || "日程"));
          infoSchedules.appendChild(row);
        }
      }
    }
    infoPanel.classList.remove("hidden");
  } catch { /* 忽略 */ }
}
function closeInfoPanel() { if (infoPanel) infoPanel.classList.add("hidden"); }
const btnInfo = document.getElementById("btn-info");
if (btnInfo) btnInfo.addEventListener("click", (e) => {
  e.stopPropagation();
  if (infoPanel && !infoPanel.classList.contains("hidden")) closeInfoPanel();
  else openInfoPanel();
});
document.addEventListener("mousedown", (e) => {
  if (infoPanel && !infoPanel.classList.contains("hidden") && !e.target.closest("#info-panel") && !e.target.closest("#btn-info")) closeInfoPanel();
});

// 信息版可拖动（按住头部「📋 信息版」移动面板位置；内容区滚动不受影响）
(function () {
  if (!infoPanel) return;
  const head = infoPanel.querySelector(".info-head");
  if (!head) return;
  let dragging = null;
  head.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    dragging = { sx: e.clientX, sy: e.clientY, ox: infoPanel.offsetLeft, oy: infoPanel.offsetTop };
    infoPanel.classList.add("info-dragging");
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const nx = Math.max(2, Math.min(window.innerWidth - 40, dragging.ox + e.clientX - dragging.sx));
    const ny = Math.max(2, Math.min(window.innerHeight - 30, dragging.oy + e.clientY - dragging.sy));
    infoPanel.style.left = nx + "px";
    infoPanel.style.top = ny + "px";
    infoPanel.style.right = "auto";
  });
  document.addEventListener("mouseup", () => { dragging = null; infoPanel.classList.remove("info-dragging"); });
})();

// 信息版内容拖拽滚动（按住内容上下拖动滚动日程；头部拖动面板/按钮点击不拦截）
(function () {
  if (!infoPanel) return;
  let ds = null;
  infoPanel.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".info-head") || e.target.closest("button,a")) return;
    ds = { y: e.clientY, top: infoPanel.scrollTop, moved: false };
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!ds) return;
    const dy = e.clientY - ds.y;
    if (Math.abs(dy) > 3) ds.moved = true;
    infoPanel.scrollTop = ds.top - dy;
  });
  document.addEventListener("mouseup", () => { ds = null; });
})();

/* ---------- 鼠标逗宠互动（v2.1）：鼠标在角色附近停留 → 播放互动动画（冷却 8s） ---------- */
let mouseNearAt = 0;
let mouseInteractCooldown = 0;
document.addEventListener("mousemove", (e) => {
  if (activeRenderMode !== "spine" || busy || dragState || !petEl) return;
  const now = Date.now();
  if (now < mouseInteractCooldown) return;
  try {
    const r = petEl.getBoundingClientRect();
    const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    if (d < 130) {
      if (!mouseNearAt) mouseNearAt = now;
      else if (now - mouseNearAt > 1200) {
        mouseNearAt = 0;
        mouseInteractCooldown = now + 8000;
        // 2.5D：微笑回应；Spine：互动动画（各自独立）
        if (activeRenderMode === "rig" && rigRuntime) rigRuntime.preset("smile");
        else playSpineInteract();
      }
    } else mouseNearAt = 0;
  } catch { /* 忽略 */ }
});

// 桌宠大小缩放（CSS zoom 整体缩放，窗口由主进程同步调整）
function applyScale(s) {
  const v = Math.max(0.6, Math.min(2.0, parseFloat(s) || 1.0));
  nextGifGeometryRevision();
  document.body.style.zoom = String(v);
  scheduleGeometryReport();
}
window.petAPI.onScaleChanged((v) => applyScale(v));

/* ---------- 半透明模式（借鉴 Ark-Pets opacity_dim）：角色变淡不挡视线 ---------- */
function applyDim(v) { petEl.style.opacity = v ? "0.75" : ""; }
if (window.petAPI.onSetDim) window.petAPI.onSetDim(applyDim);

/* ---------- 省电降帧（借鉴 Ark-Pets eco_mode）：静止/睡觉时降低渲染帧率 ---------- */
/* 单一判定源（FPS-6：4s 巡检与各生命周期点主动调用共用同一函数，绝不出现两套互相打架的判定）。
 * 优先级：seat-exit Y ownership active → 60（过渡期 fast 补偿需要时间采样密度，正确性组件）
 *        > moving → 60 > sleeping → 12 > 其余 24。release/hard-drop/teardown 后按真实状态立即复判。 */
function applyEcoFps(reason) {
  if (!spineApp || !spineApp.ticker) return null; // owner teardown 后安全（FPS-7）
  const seatOwns = seatExitYOwnsY();
  const moving = busy || !!dragState || (walkState.active && !walkState.resting);
  const target = (seatOwns || moving) ? 60 : (isSleeping ? 12 : 24);
  const before = spineApp.ticker.maxFPS;
  if (before !== target) spineApp.ticker.maxFPS = target;
  if (reason && EDGE_DIAG) seatYDiag("FPS", { reason, beforeFPS: before, afterFPS: target, seatOwnership: !!seatOwns, moving: !!moving, sleeping: !!isSleeping });
  return target;
}
setInterval(() => { applyEcoFps(); }, 4000);

/* ---------- 动画轨道看门狗（每 2s 检查：相位名称 + trackTime + ticker）----------
 * 6s 低频巡检。原版只修「轨道为空」的定格；但还存在「轨道挂着错误循环动画」的滑行态：
 * 聊天情绪/暂停站姿/试演动画占住 track0 后，行走相位不会再来恢复（applyWalkState 是
 * 事件驱动，错过一次广播就错到下个相位）——表现为"角色在移动却没有走路动画"。
 * 升级：轨道为空，或「循环播放中的动画 ≠ 当前相位应有动画」时，都按相位补回。
 * 豁免：busy（聊天表情优先）、睡眠、试演中；一次性动画（loop=false，Interact 等）播完
 * 会自续/变空，不动它。 */
setInterval(() => {
  if (!spineObj || activeRenderMode !== "spine" || isSleeping) return;
  // busy（聊天/生成中）也保底一项窄检查：坐姿/窗顶但轨道挂着站姿类动画 → 立即坐回。
  // 原实现 busy 时整体 return，聊天期间一旦被切到站姿就冻结整个回复时长（2026-09-05 用户报告）。
  if (busy) {
    if (Date.now() < animDemoUntil) return; // 试演中不打断
    try {
      const cur = spineObj.state.getCurrent(0);
      const name = cur && cur.animation ? cur.animation.name : "";
      const sit = sitAnimName();
      if ((walkState.seated || walkState.perched) && name && sit && name !== sit && !isSitClassAnim(name)) {
        setSpineAnim(sit, true, "seat-guard-busy");
        scheduleFitSpine({ seatPhase: true });
        window.petAPI.playback && window.petAPI.playback("[anim] seat-guard-busy: " + name + " → " + sit);
      }
    } catch { /* 忽略 */ }
    return;
  }
  try {
    if (spineApp.ticker && !spineApp.ticker.started) {
      spineApp.ticker.start();
      window.petAPI.playback && window.petAPI.playback("[anim] ticker-recover");
    }
    if (spineObj.state && spineObj.state.timeScale === 0) {
      spineObj.state.timeScale = 1;
      window.petAPI.playback && window.petAPI.playback("[anim] timeScale-recover");
    }
  } catch { /* 状态读取失败交给后续轨道判定 */ }
  if (Date.now() < animDemoUntil) return;
  let cur = null;
  try { cur = spineObj.state.getCurrent(0); } catch { return; }
  // 相位目标：spinePhaseAnim 唯一来源（坐姿/暂停/走路/待机都在里面）；引擎关闭（null）→ 站姿待机。
  // 不再回退 sitAnimName——那会在行走引擎关闭时把站着的角色按成坐姿。
  const target = spinePhaseAnim() || spineAnimForMood("idle");
  if (!target) return;
  const currentName = cur && cur.animation ? cur.animation.name : "";
  const currentTime = cur && Number.isFinite(cur.trackTime) ? cur.trackTime : NaN;
  const progressed = window.AnimationWatch && window.AnimationWatch.trackHasProgress
    ? window.AnimationWatch.trackHasProgress(spineTrackProbe.name, spineTrackProbe.time, currentName, currentTime)
    : currentName !== spineTrackProbe.name || !Number.isFinite(spineTrackProbe.time) || currentTime - spineTrackProbe.time > 0.005;
  if (currentName === spineTrackProbe.name && !progressed) spineTrackStallCount += 1;
  else spineTrackStallCount = 0;
  const decision = window.AnimationWatch ? window.AnimationWatch.trackDecision({
    currentName,
    targetName: target,
    currentLoop: cur && cur.loop,
    previousName: spineTrackProbe.name,
    previousTime: spineTrackProbe.time,
    currentTime,
    stallCount: spineTrackStallCount,
    busy,
    sleeping: isSleeping,
    demo: Date.now() < animDemoUntil,
    mood: Date.now() < moodAnimUntil,
    active: walkState.active,
    resting: walkState.resting,
    seated: walkState.seated,
    perched: walkState.perched,
    paused: walkState.paused,
    currentAnimationEnd: cur && cur.animationEnd,
    currentTrackTime: cur && cur.trackTime,
    queuedSuccessor: !!(cur && cur.next)
  }) : (!cur || !cur.animation || currentName !== target ? "restart" : "ok");
  if (!cur || !cur.animation || decision === "restart") {
    try {
      if (spineApp.ticker && !spineApp.ticker.started) spineApp.ticker.start();
      if (spineObj.state && spineObj.state.timeScale === 0) spineObj.state.timeScale = 1;
    } catch { /* ticker 自愈失败仍重设轨道 */ }
    const seat = walkState.seated || walkState.perched;
    setSpineAnim(target, true, "reconcile");
    scheduleFitSpine(seat ? { seatPhase: true } : {});
    try { window.petAPI.playback && window.petAPI.playback("[anim] 相位对账: " + (currentName || "空") + " → " + target +
      " trackTime=" + (Number.isFinite(currentTime) ? currentTime.toFixed(2) : "?") +
      " reason=" + (currentName === target ? "停帧" : "名称") +
      " (active=" + walkState.active + " resting=" + walkState.resting + " seated=" + walkState.seated +
      " perched=" + walkState.perched + " paused=" + walkState.paused + ")"); } catch { /* 忽略 */ }
  }
  spineTrackProbe = { name: currentName || target, time: currentTime };
}, 2000);

// 条款未同意：提示气泡并保持不可用
window.petAPI.onTermsPending(() => {
  agreed = false;
  showBubble();
  bubbleEl.classList.add("error");
  bubbleText.textContent = "初次使用请先阅读并同意《使用条款与隐私政策》（已弹出窗口），同意后才能开始聊天哦 🩺";
});
window.petAPI.onTermsAgreed(() => {
  agreed = true;
  hideBubble();
});

/* ---------- 拖拽（手动，区分点击） ---------- */
let dragState = null;
let pokeResumeTimer = null; // 戳一戳后的原地站立计时
let dragReleaseTimer = null;
const THROW_SAMPLE_WINDOW_MS = 80;
const THROW_MIN_SPEED = 200;
function addDragSample(state, e) {
  const sample = { t: performance.now(), x: e.screenX, y: e.screenY };
  state.samples.push(sample);
  const cutoff = sample.t - THROW_SAMPLE_WINDOW_MS * 2;
  while (state.samples.length > 1 && state.samples[0].t < cutoff) state.samples.shift();
}
function dragVelocity(state) {
  const last = state.samples[state.samples.length - 1];
  if (!last) return null;
  const first = state.samples.find((sample) => sample.t >= last.t - THROW_SAMPLE_WINDOW_MS) || state.samples[0];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

function releaseDragPointer(state) {
  const target = state && state.target;
  if (!target || typeof target.releasePointerCapture !== "function") return;
  try { target.releasePointerCapture(state.pointerId); } catch { /* capture 可能已被浏览器收回 */ }
}

function clearDragVisuals() {
  petEl.classList.remove("dragging", "pet-squash", "pet-squash-release");
  if (dragReleaseTimer) {
    clearTimeout(dragReleaseTimer);
    dragReleaseTimer = null;
  }
}

function refreshDragClickable() {
  try {
    clickability.refreshFromLastMouse(); // 坐标缺失由核心守卫拒绝：清理路径不得主动切穿透（无效坐标无 native 变更权限）
  } catch { /* 页面销毁时 IPC 可能已不可用 */ }
}

function finishDrag(reason = "cancel") {
  const state = dragState;
  if (!state || !state.active) return false;

  // 先摘掉全局状态，再 releasePointerCapture；release 可能同步触发 lostpointercapture。
  dragState = null;
  state.active = false;
  releaseDragPointer(state);
  clearDragVisuals();
  refreshDragClickable();

  if (reason !== "pointerup") {
    // 异常取消只安全放下当前位置：不 click、不 pat、不 throw、不打开输入栏。
    window.petAPI.walkingPause(false, "drag");
    return true;
  }

  const wasDrag = state.moved;
  // 正常 pointerup 不把释放坐标额外加入 samples，保持原 mouseup 的甩动算法。
  // v2.5.22d Q 弹回弹（GIF 模式）：松手换 release 动画，播完清理
  petEl.classList.add("pet-squash-release");
  dragReleaseTimer = setTimeout(() => {
    petEl.classList.remove("pet-squash-release");
    dragReleaseTimer = null;
  }, 400);
  const velocity = wasDrag ? dragVelocity(state) : null;
  const speed = velocity ? Math.round(Math.hypot(velocity.vx, velocity.vy)) : 0;

  if (!wasDrag) {
    try { window.petAPI.playback("[ui] click 未拖动 count=" + ((patSeq && patSeq.count) || 0)); } catch { /* 忽略 */ }
    headPatSquash(); // 摸头/单击的瞬时 Q 弹：GIF 由上面的 pet-squash-release class 承担，Spine 在此补齐（非 spine 模式为 no-op）
    const now = Date.now();
    if (!patSeq || now - patSeq.at > 2000) patSeq = { at: now, count: 0, barOpenedByFirst: false };
    patSeq.count += 1;
    patSeq.at = now;
    if (patSeq.count >= 2) {
      // 摸头：把第 1 击误开的聊天栏关回去，保持"摸头不开栏"的直觉
      if (patSeq.barOpenedByFirst) {
        if (!inputBar.classList.contains("hidden")) toggleInputBar();
        patSeq.barOpenedByFirst = false;
      }
      wake(); // 被摸会醒：否则主进程 sleeping=true 不位移，摸头互动排队恢复的 Move 变成原地空走
      playSpineInteract();
      if (activeRenderMode === "rig" && rigRuntime) rigRuntime.preset("smile"); // 2.5D：微笑回应
      showPatFeedback();
      window.petAPI.pat && window.petAPI.pat();
    } else {
      toggleInputBar();
      playSpineInteract(); // 单击互动：还原基建里点一下干员的反应动作
      patSeq.barOpenedByFirst = !inputBar.classList.contains("hidden");
    }
    // 戳一戳/摸头时原地站定：等互动动作播完再继续散步
    clearTimeout(pokeResumeTimer);
    pokeResumeTimer = setTimeout(() => { if (!dragState) window.petAPI.walkingPause(false, "interact"); }, 2600); // "interact"=非拖拽恢复：main 只对显式 drag 做落点定格；不得省略（preload 会把 undefined 归一化成 "drag"）
  } else if (velocity && speed > THROW_MIN_SPEED) {
    try {
      window.petAPI.throwPet(velocity.vx, velocity.vy);
      scheduleDizzyFeedback(); // 被抛出去：落地时晕乎/抗议
    } catch {
      // IPC 发送失败时也立即解除 drag pause，不能把恢复交给 watchdog。
      window.petAPI.walkingPause(false, "drag");
    }
  } else {
    window.petAPI.walkingPause(false, "drag");
  }
  return true;
}

function onDragStart(e) {
  if (dragState || e.pointerType !== "mouse" || e.isPrimary !== true || e.button !== 0) return;
  const target = e.currentTarget;
  if (!target || typeof target.setPointerCapture !== "function") return;
  let state = null;
  try {
    target.setPointerCapture(e.pointerId);
    try { window.petAPI.playback("[ui] dragStart btn=" + e.button + " target=" + (e.target.id || e.target.tagName)); } catch { /* 忽略 */ }
    wake();
    clearTimeout(pokeResumeTimer);
    // v2.5.22d Q 弹按压（GIF 模式）：按下压缩，松手回弹（CSS 仅对 GIF 生效，其他模式无此动画）
    petEl.classList.remove("pet-squash", "pet-squash-release");
    petEl.classList.add("pet-squash");
    state = { pointerId: e.pointerId, target, sx: e.screenX, sy: e.screenY, moved: false, active: true, samples: [] };
    dragState = state;
    addDragSample(state, e);
    window.petAPI.walkingPause(true, "drag"); // 拖拽中暂停桌面行走，松手恢复
  } catch {
    if (dragState === state) dragState = null;
    if (state) state.active = false;
    clearDragVisuals();
    releaseDragPointer({ target, pointerId: e.pointerId });
  }
}
const rigCanvasEl = document.getElementById("rig-canvas");
const live2dCanvasEl = document.getElementById("live2d-canvas");
const dragSurfaces = [petEl, rigCanvasEl, live2dCanvasEl].filter(Boolean);
for (const surface of dragSurfaces) {
  surface.addEventListener("pointerdown", onDragStart);
  surface.addEventListener("lostpointercapture", (e) => {
    if (!dragState || e.currentTarget !== dragState.target || e.pointerId !== dragState.pointerId) return;
    finishDrag("lostpointercapture");
  });
}
// 右键宠物 → 隐藏到托盘
petEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.petAPI.hideWindow();
});
window.addEventListener("pointermove", (e) => {
  if (!dragState || !dragState.active) return;
  if (e.pointerId !== dragState.pointerId) return;
  if (!(e.buttons & 1)) {
    finishDrag("buttons");
    return;
  }
  clickability.setLastMouse(e.clientX, e.clientY);
  addDragSample(dragState, e);
  const dx = e.screenX - dragState.sx;
  const dy = e.screenY - dragState.sy;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    dragState.moved = true;
    try { window.petAPI.playback("[ui] 判定为拖动 dx=" + Math.round(dx) + " dy=" + Math.round(dy)); } catch { /* 忽略 */ }
    petEl.classList.add("dragging");
    window.petAPI.moveWindow(dx, dy);
    dragState.sx = e.screenX;
    dragState.sy = e.screenY;
  }
});
window.addEventListener("pointerup", (e) => {
  if (dragState && e.pointerId === dragState.pointerId) {
    clickability.setLastMouse(e.clientX, e.clientY);
    finishDrag("pointerup");
  }
});
window.addEventListener("pointercancel", (e) => {
  if (dragState && e.pointerId === dragState.pointerId) finishDrag("pointercancel");
});
window.addEventListener("blur", () => finishDrag("blur"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") finishDrag("visibilitychange");
});
window.addEventListener("pagehide", () => finishDrag("pagehide"));
/* ---------- 摸头互动（v2.3）：2 秒内快速连点角色 = 摸头 ---------- */
let patSeq = null; // { at, count, barOpenedByFirst } 连击窗口
let patFeedbackTimer = null;
function showPatFeedback() {
  if (!bubbleEl) return;
  if (patFeedbackTimer) clearTimeout(patFeedbackTimer);
  // 连击视觉递进（v2.5.26）：连摸越多心越多，≥5 加 ⁺（与主进程撒娇档音色同步递进）
  const combo = (patSeq && patSeq.count) || 1;
  const hearts = "❤".repeat(Math.max(1, Math.min(combo, 4))) + (combo >= 5 ? "⁺" : "");
  bubbleText.textContent = hearts;
  showBubble();
  patFeedbackTimer = setTimeout(() => {
    if (bubbleText.textContent.startsWith("❤")) hideBubble(); // 主进程台词已覆盖则不动
  }, 2000);
}
/* 被抛出去：约落地时刻给"晕乎/抗议"短反馈（借鉴 dsh-dafeiyu 拖拽反馈；5% 概率，避免频繁晕眩） */
let dizzyTimer = null;
function scheduleDizzyFeedback() {
  if (Math.random() > 0.05) return;
  if (dizzyTimer) clearTimeout(dizzyTimer);
  dizzyTimer = setTimeout(() => {
    dizzyTimer = null;
    if (dragState) return; // 正在拖拽不打断
    petEl.classList.add("pet-dizzy");
    setTimeout(() => petEl.classList.remove("pet-dizzy"), 600);
    if (bubbleEl) {
      bubbleText.textContent = "😵💫";
      showBubble();
      setTimeout(() => { if (bubbleText.textContent === "😵💫") hideBubble(); }, 2000);
    }
  }, 600);
}
document.addEventListener("mousedown", (e) => { // 诊断：确认鼠标事件到达渲染层
  try { window.petAPI.playback("[ui] mousedown target=" + (e.target.id || e.target.className || e.target.tagName)); } catch { /* 忽略 */ }
}, true);

/* ---------- 等比缩放自愈兜底：渲染层所有缩放写入都应是等比的，
   一旦发现 |scale.x| 与 scale.y 失配（非等比拉伸残留），立即恢复均匀缩放。 ---------- */
setInterval(() => {
  try {
    if (!spineObj || activeRenderMode !== "spine") return;
    const sx = Math.abs(spineObj.scale.x), sy = Math.abs(spineObj.scale.y);
    if (!(sx > 1e-6) || !(sy > 1e-6)) return;
    if (Math.abs(sx / sy - 1) <= 0.02) return;
    spineObj.scale.x = (spineObj.scale.x < 0 ? -1 : 1) * sy; // 保持朝向与当前 fit 高度缩放，恢复等比
    scheduleFitSpine({}); // 缩放变了，重新居中/贴底
  } catch { /* 忽略 */ }
}, 200);

/* ---------- 点击穿透：透明区域不挡下层应用 ----------
   只有鼠标在 桌宠/气泡/输入栏 上时才放行鼠标事件，其余穿透给下层应用；
   拖拽中强制放行（否则 mouseup 被穿透吞掉会导致拖拽卡死）。
   判定逻辑本体在 src/clickability.js（Node 可单测），此处只接活环境。 */
const clickability = window.PetClickability.createClickabilityCore({
  elementFromPoint: (x, y) => document.elementFromPoint(x, y),
  setClickable: (v) => window.petAPI.setClickable(v),
  getDragState: () => dragState,
  isPetUI: (el, e) => window.PetClickability.petUiHit(el, e, {
    petEl: () => petEl,
    activeRenderMode: () => activeRenderMode,
    busy: () => busy,
    walkState: () => walkState,
    playback: (msg) => { try { window.petAPI.playback(msg); } catch { /* 忽略 */ } },
  }),
});
document.addEventListener("mousemove", (e) => clickability.onRealMouseMove(e.clientX, e.clientY));
setInterval(() => { // 兜底：小人走动会改变鼠标下方内容但不触发 mousemove（静止盲区），定时重判自愈
  clickability.refreshFromLastMouse(); // 穿透期间 lastMouse 已被 native cursor 恢复刷新为真实位置，兜底重放的就是当前位置；失效值由核心守卫吞掉
}, 500);
if (window.petAPI.onCursorRecovery) { // B-2 自锁断路器：穿透期 forwarded mousemove 不可靠，main 轮询系统光标推送 viewport 坐标，
  window.petAPI.onCursorRecovery((p) => clickability.onNativeCursorPush(p)); // 恢复判定不依赖 renderer 能否收到鼠标事件；不聚焦、不抢鼠标、不动窗口
}

function applyPetName(name) {
  const value = String(name || "苏苏洛").trim() || "苏苏洛";
  document.title = value + "桌宠";
  spriteEl.alt = value;
  inputEl.placeholder = "和" + value + "说点什么…";
}

// 仅供 lifecycle contract tests 注入依赖并调用真实 production switch 生命周期。
// 正常 renderer 不创建该 seam，也不改变运行时路径。
if (window.__renderLifecycleTestMode) {
  window.__renderLifecycle = {
    switchRenderMode,
    teardownAll,
    resetVisualState,
    bootstrapRelease: (why) => releaseSpineBootstrap(why), // 测试专用：模拟有界兜底触发（生产路径仍由事件/计时器驱动）
    poke: () => playSpineInteract(), // 测试专用：摸头/单击互动入口（与 finishDrag !wasDrag 分支同函数）
    headPatSquash: () => headPatSquash(), // 测试专用：摸头/单击瞬时 Q 弹入口（与 finishDrag !wasDrag 分支同函数）
    fitPassForTest: () => fitSpinePose(spineFitGeneration, spineFitOwnerGeneration, spineRuntimeOwner), // 测试专用：以"当前原窗口同一 generation"手动补一拍 fit（FIT-M4 模拟混合自然结束后的原窗口 pass；不 bump、不重排程）
    seatYForTest: { // 测试专用：Phase2 seat-exit Y ownership 驱动/观察（不改变任何生产语义）
      tick: (dt) => seatExitYTick(dt),
      owns: () => seatExitYOwnsY(),
      state: () => (seatExitY ? { sourceName: seatExitY.sourceName, targetName: seatExitY.targetName, hasTarget: seatExitY.hasTarget, targetY: seatExitY.targetY, sawFinalReaim: seatExitY.sawFinalReaim, converged: seatExitY.converged, fastBaseY: seatExitY.fastBaseY, visibleCorrectionY: seatExitY.visibleCorrectionY, finalAuthorityValid: seatExitY.finalAuthorityValid, finalAuthorityY: seatExitY.finalAuthorityY, perfN: seatExitY.perfN } : null),
      measure: (kind) => seatYMeasureTarget(kind),
      fastY: () => fastPoseTargetY(),
      poke: () => pokeFeedback(),
      eco: () => applyEcoFps("seam"),
      set: (k, v) => { if (seatExitY && k in seatExitY) seatExitY[k] = v; }
    },
    offsetDiagTickForTest: () => offsetDiagTick(), // 测试专用：手动驱动 OFFSETDIAG 采样拍（真实环境由 seat ticker 每帧调用）
    speechDiagCtl: SPEECH_DIAG ? { // 测试专用：SPEECHDIAG 生命周期手动驱动（沙箱 setInterval 为 no-op）
      start: (r) => speechDiagStart(r),
      end: (id) => speechDiagEnd(id),
      tick: () => speechDiagTick(),
      expire: (id) => { const s = speechDiagSessions.get(id); if (s) s.endAt = Date.now() - 1; },
      size: () => speechDiagSessions.size,
      hasTimer: () => !!speechDiagTimer,
      hearts: () => ({ cb: diagTickerCallbackSeq, adv: diagSpineAdvanceSeq })
    } : null,
    seatExitForensicCtl: SEAT_EXIT_FORENSIC ? { // 测试专用：验证 bounded flush/owner 隔离，不进入生产路径
      flush: (reason) => seatExitForensicFlush(reason || "test"),
      session: () => seatExitForensicSession ? {
        mainSessionId: seatExitForensicSession.mainSessionId,
        renderSessionId: seatExitForensicSession.renderSessionId,
        ownerGeneration: seatExitForensicSession.ownerGen,
        recordCount: seatExitForensicSession.records.length,
        dropped: seatExitForensicSession.dropped
      } : null
    } : null,
    scheduleMoodReset,
    setMood,
    setMoods: (moods) => { MOODS = Array.isArray(moods) ? moods : []; },
    setResourceIds: ({ rig, live2d } = {}) => {
      if (typeof rig === "string") rigSkinId = rig;
      if (typeof live2d === "string") live2dSkinId = live2d;
    },
    getState: () => ({
      requested: requestedRenderMode,
      active: activeRenderMode,
      status: renderSwitchStatus,
      generation: renderSwitchGeneration,
      runtimeReady: renderRuntimeReady,
      resource: renderRuntimeResource,
      spineApp,
      spineObj,
      spineRuntimeOwner,
      spinePendingOwner,
      rigRuntime,
      live2dActive,
      dragState,
      moodTimer,
      fit: { generation: spineFitGeneration, stableHits: spineFitStableHits, keepScale: spineFitKeepScale, autoScaled: spineAutoScaled, base: spineBaseScaleX },
      seatEpisode,
      bootstrap: { pending: spineBootstrapPending, passes: spineBootstrapPassCount, walkDeferred: !!spineBootstrapDeferredWalk, staged: spineBootstrapDeferredWalk ? Object.assign({}, spineBootstrapDeferredWalk) : null, last: spineBootstrapLastRelease, reset: spineBootstrapOwnerReset },
      walkStateSnapshot: Object.assign({}, walkState)
    })
  };
}

/* ---------- 初始化 ---------- */
if (!window.__renderLifecycleTestMode) (async function init() {
  const state = await window.petAPI.getState();
  if (typeof state.petName === "string") applyPetName(state.petName);
  forcedMode = state.forcedMode || "auto";
  zcodeEnabled = !!state.zcodeEnabled;
  if (typeof state.agreed === "boolean") agreed = state.agreed;
  if (Array.isArray(state.moods) && state.moods.length) MOODS = state.moods;
  if (state.scale) applyScale(state.scale);
  applyDim(!!state.dimMode); // 半透明模式初始状态
  if (state.tts) ttsConfig = { ...ttsConfig, ...state.tts };
  if (state.ttsCloud) ttsCloudOn = !!state.ttsCloud.enabled;
  if (typeof state.emotionalVoice === "boolean") emotionalVoice = state.emotionalVoice;
  if (state.emotionVoice && typeof state.emotionVoice === "object") emotionVoiceCfg = state.emotionVoice; // 情绪音色分档
  if (window.petAPI.onEmotionVoiceChanged) { // 设置页切换即时生效
    window.petAPI.onEmotionVoiceChanged((ev) => { if (ev && typeof ev === "object") emotionVoiceCfg = ev; });
  }
  if (Number(state.rigScale) > 0) applyRigScale(state.rigScale);
  if (typeof state.rigMouseFollow === "boolean") rigMouseFollow = state.rigMouseFollow; // 2.5D 头部/眼睛跟随鼠标
  if (typeof state.mouseTrackGlobal === "boolean") mouseTrackGlobal = state.mouseTrackGlobal; // 全局鼠标跟踪许可
  if (state.winSize) { winSize = { width: Number(state.winSize.width) || 260, height: Number(state.winSize.height) || 200 }; }
  applyBubbleSize();
  reportGroundGap(); // 上报角色脚底与窗口底边空隙，供主进程贴地补偿
  try { const ap = await window.petAPI.getAppearance(); if (ap) applyAppearance(ap); } catch { /* 默认外观 */ }
  updateChip();
  updateTtsButton();
  initTts();

  if (Number(state.live2dScale) > 0) applyLive2dScale(state.live2dScale);
  if (window.petAPI.onLive2dScaleChanged) window.petAPI.onLive2dScaleChanged((v) => applyLive2dScale(v));
  applyTheme(state.theme);
  resetSleepTimer(); // v2.5.21c 修复：睡眠计时提前到条款/key 检查之前——未同意/未配 key 时桌宠也会困（此前被 return 跳过，永远不睡）
  setInterval(() => applyTheme(state.theme), 60000); // auto 模式跨时段自动切换
  if (window.matchMedia) {
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(state.theme)); } catch { /* 旧内核 */ }
  }
  if (window.petAPI.onThemeChanged) window.petAPI.onThemeChanged((th) => { state.theme = th; applyTheme(th); });

  // 启动与 runtime switch 共用 main 分配的正式 seq；rig/live2d id 只作为对应 mode 的资源选择。
  rigSkinId = state.rigSkinId || "";
  live2dSkinId = state.live2dSkinId || "";
  const initialRequest = state.renderModeRequest && typeof state.renderModeRequest === "object"
    ? state.renderModeRequest : { mode: state.renderMode };
  const initialMode = RENDER_MODES.includes(initialRequest.mode) ? initialRequest.mode : "gif";
  const initialMainSeq = Number.isSafeInteger(initialRequest.seq) ? initialRequest.seq : null;
  if (initialMainSeq !== null) currentMainRenderModeSeq = initialMainSeq;
  petDocEpoch = initialMainSeq === null ? 0 : initialMainSeq; // F6：捕获文档纪元（main 在每次换代 reload 前均 bump seq，故新文档 epoch 严格大于旧文档）
  const initialResult = await switchRenderMode(initialMode, {
    mainSeq: initialMainSeq,
    resourceId: initialMode === "rig" ? rigSkinId : initialMode === "live2d" ? live2dSkinId : undefined
  });
  if ((initialResult.status === "ready" || initialResult.status === "noop") && initialMode === "spine" && state.walkState) {
    applyWalkState(state.walkState);
  }
  // v2.5.24 修复：渲染层 reload 自愈（WebGL context lost）后穿透状态不随页面恢复——
  // init 完成立即放行鼠标（角色在窗口内，初始可交互合理），后续 mousemove 再按命中精细重判
  clickability.petSetClickable(initialResult.status === "ready" || initialResult.status === "noop");
  reportRenderModeOutcome(initialMainSeq, initialMode, initialResult,
    () => currentMainRenderModeSeq === initialMainSeq);

  if (!agreed) {
    showBubble();
    bubbleEl.classList.add("error");
    bubbleText.textContent = "初次使用请先阅读并同意《使用条款与隐私政策》（已弹出窗口），同意后才能开始聊天哦 🩺";
    return;
  }

  if (!state.keyReady) {
    showBubble();
    bubbleEl.classList.add("error");
    bubbleText.textContent = "还没有配置 API Key 哦。右键托盘图标 →「⚙️ 设置」，填好 API 后再回来找我吧（" + (state.keySource || "") + "）。";
    return;
  }

  setMood("idle");

  // 开场白（气泡 + 语音；可在设置里关闭「启动问候」；隐藏启动时静默待命不打扰）
  if (state.greetingOnStart !== false && state.personaOpening && !state.hiddenAtStart) {
    showBubble();
    bubbleText.textContent = state.personaOpening;
    speak(state.personaOpening);
    scheduleBubbleHide(30000); // 开场白：语音播完再隐藏，防止长开场白被提前收起
  }
})();

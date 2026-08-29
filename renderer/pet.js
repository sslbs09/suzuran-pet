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
let renderMode = "gif";      // "gif" | "spine"
let renderModeEpoch = 0;       // 异步 Spine 加载的会话号，最后一次模式选择获胜
const SPINE_BASE = "spine/sussurro/";
let spinePaths = {           // 默认内置模型；spine/user/ 有用户模型时由主进程探测替换（懒人换模型）
  atlas: SPINE_BASE + "build_char_298_susuro.atlas",
  skel: SPINE_BASE + "build_char_298_susuro.skel"
};
let spineBaseScaleX = 1;     // 初始缩放；朝向翻转时取反
// 桌面行走状态（主进程广播驱动；明日方舟基建语义：Move=走动 Relax=放松 Sit=坐窗顶 Sleep=睡觉 Interact=点击互动）
let walkState = { active: false, resting: true, perched: false, seated: false, face: 1 };

/* ---------- PSD 2.5D 角色渲染（v2.2，完全独立于 Spine）
 * rigSkinId 非空时 2.5D 独占显示：Spine 不初始化、不参与，互不干扰。 ---------- */
let rigSkinId = "";
let rigRuntime = null;
let rigCanvas = null;
let rigLoading = false;
let rigScale = 1.0; // 2.5D 角色显示大小（设置页滑杆）
let rigMouseFollow = true; // 2.5D 头部/眼睛跟随鼠标（v2.2.1 实验性，设置页开关）
let mouseTrackGlobal = false; // 全局鼠标跟踪（v2.2.1 实验性，需设置页显式许可，默认关）
const RIG_WIN_W = 300, RIG_WIN_H = 460; // rig 模式基础窗口尺寸（rigScale=1）
function applyRigScale(v) {
  rigScale = Math.max(0.3, Math.min(1.5, Number(v) || 1));
  // rig 模式：窗口高度随 rigScale 联动（角色=窗口高 100%，放大不超出画布）
  if (rigSkinId && rigRuntime) {
    window.petAPI.setSize(RIG_WIN_W, Math.round(RIG_WIN_H * rigScale));
  }
}
function rigGenericOpts() {
  const GP = window.GenericParts;
  const base = GP ? { eyeL: GP.get("eyeL"), eyeR: GP.get("eyeR"), mouth: GP.get("mouth") } : {};
  return (base.eyeL || base.mouth) ? { generic: base } : {};
}
/** 加载 2.5D 皮肤并独占显示（独立大画布：全窗口贴底，rig 模式窗口尺寸 + 停走）；返回是否成功 */
async function initRig(id) {
  rigSkinId = id || "";
  if (!rigSkinId) { destroyRig(); return false; }
  if (rigLoading) return false;
  rigLoading = true;
  try {
    window.petAPI.playback && window.petAPI.playback("[rig] 加载 2.5D 皮肤: " + rigSkinId);
    const res = await fetch("pet-user://rig/user/" + encodeURIComponent(rigSkinId));
    if (!res.ok) throw new Error("加载 PSD 失败 HTTP " + res.status);
    const buf = await res.arrayBuffer();
    if (!window.Rigger || !window.RigRuntime) throw new Error("2.5D 运行时未加载");
    const psd = window.agPsd.readPsd(new Uint8Array(buf), { useImageData: true, skipThumbnail: true });
    const rig = window.Rigger.buildRig(psd, rigGenericOpts());
    rigCanvas = document.getElementById("rig-canvas"); // 独立大画布（index.html 静态，全窗口）
    if (!rigCanvas) {
      rigCanvas = document.createElement("canvas");
      rigCanvas.id = "rig-canvas";
      rigCanvas.className = "rig-canvas";
      document.body.appendChild(rigCanvas);
    }
    if (rigRuntime) { try { rigRuntime.destroy(); } catch { /* 忽略 */ } }
    rigRuntime = window.RigRuntime.init(rigCanvas);
    rigRuntime.applyRig(rig);
    // v2.2.1 实验性：跟随能力自适应——换 PSD 自动评估支持级别（头+眼 / 仅头 / 无），眼睛结构缺失时自动降级、不失效
    const follow = window.RigRuntime.detectFollow(rig);
    rigRuntime.setAuto("mouse", rigMouseFollow && follow.level !== "none");
    rigRuntime.setMouseMode(mouseTrackGlobal); // 全局跟踪许可开启时改用外部坐标注入
    window.petAPI.playback && window.petAPI.playback("[rig] 跟随能力: " + (follow.level === "full" ? "头+眼" : follow.level === "head-only" ? "仅头部" : "无") + "（" + (follow.reason || "") + "）");
    applyRigScale(rigScale); // 应用用户设定的大小
    // 独占显示：隐藏 GIF/Spine 条带，2.5D 全窗口独立显示
    document.body.classList.add("rig-mode");
    // 启动时序：applyBubbleSize/applyAppearance 先于本函数执行过，会留下内联宽高；rig 布局接管前先清掉
    bubbleEl.style.width = "";
    bubbleEl.style.height = "";
    rigCanvas.classList.remove("hidden");
    // rig 模式：独立窗口尺寸（角色比例约 496:765，高度随 rigScale 联动）+ 暂停行走
    window.petAPI.setSize(RIG_WIN_W, Math.round(RIG_WIN_H * rigScale));
    // 2.5D 模式停走但保留用户行走意图（不持久化）：切回 Spine 时由主进程 syncWalkingEngine 恢复
    window.petAPI.walkingEngineStop && window.petAPI.walkingEngineStop();
    window.petAPI.playback && window.petAPI.playback("[rig] 2.5D 皮肤就绪: " + rig.layers.length + " 部件");
    return true;
  } catch (e) {
    window.petAPI.playback && window.petAPI.playback("[rig] 2.5D 皮肤加载失败: " + (e && e.message || e));
    destroyRig();
    return false;
  } finally { rigLoading = false; }
}
function destroyRig() {
  if (rigRuntime) { try { rigRuntime.destroy(); } catch { /* 忽略 */ } rigRuntime = null; }
  if (rigCanvas) { rigCanvas.classList.add("hidden"); }
  // 恢复原显示与窗口
  document.body.classList.remove("rig-mode");
  if (spriteEl) spriteEl.style.display = "";
  if (spineApp && spineApp.view) spineApp.view.style.display = "";
  window.petAPI.setSize(winSize.width || 260, winSize.height || 200);
  if (appearanceCfg) applyAppearance(appearanceCfg); // 关闭 rig 后恢复 gif/spine 的气泡宽度设置
}

/* ---------- Live2D 渲染模式（v2.5.1）：live2d-runtime.js 自治，这里只做显示归属与生命周期 ---------- */
let live2dActive = false;

async function initLive2d(preferId) {
  const canvas = document.getElementById("live2d-canvas");
  if (!canvas || !window.Live2DRuntime) return false;
  let skins = [];
  try { skins = await window.petAPI.live2dList(); } catch { /* 忽略 */ }
  if (!skins || !skins.length) {
    window.petAPI.playback && window.petAPI.playback("[live2d] 未找到模型（内置缺失且 userData/assets/live2d/ 为空）");
    return false;
  }
  const pick = (preferId && skins.find((s) => s.id === preferId)) || skins.find((s) => s.id.startsWith("builtin/")) || skins[0];
  try {
    window.petAPI.walkingEngineStop && window.petAPI.walkingEngineStop(); // Live2D 不行走，停引擎（照 rig 一致性）
    const s0 = live2dScaleFactor || 1;
    window.petAPI.setSize(Math.round(300 * s0), Math.round(460 * s0)); // live2d 专属窗口（随滑条等比）
    bindCtxLost(canvas, "live2d");
    await window.Live2DRuntime.init(canvas, pick.url);
    applyLive2dScale(live2dScaleFactor);
    live2dActive = true;
    document.body.classList.add("live2d-mode");
    spriteEl.style.display = "none";
    if (spineApp && spineApp.view) spineApp.view.style.display = "none";
    if (rigRuntime) { rigCanvas.classList.add("hidden"); }
    canvas.classList.remove("hidden");
    window.petAPI.playback && window.petAPI.playback("[live2d] 模型就绪: " + pick.name);
    return true;
  } catch (e) {
    window.petAPI.playback && window.petAPI.playback("[live2d] 加载失败: " + (e && e.message || e));
    return false;
  }
}

function destroyLive2d() {
  if (!live2dActive) return;
  live2dActive = false;
  document.body.classList.remove("live2d-mode");
  window.petAPI.setSize(winSize.width || 260, winSize.height || 200); // 恢复窗口
  try { window.Live2DRuntime.destroy(); } catch { /* 忽略 */ }
  const canvas = document.getElementById("live2d-canvas");
  if (canvas) canvas.classList.add("hidden");
}

function applyTheme(theme) { // 主题：auto=19 点-6 点深色
  let dark;
  if (theme === "dark") dark = true;
  else if (theme === "light") dark = false;
  else if (theme === "system") dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  else dark = new Date().getHours() >= 19 || new Date().getHours() < 6; // auto：19 点-6 点
  document.body.classList.toggle("theme-dark", dark);
}

window.addEventListener("error", (e) => { // 渲染层全局错误上报（诊断基建）
  try { window.petAPI.playback("[jserr] " + ((e && e.message) || "?") + " @ " + String(e && e.filename || "").split("/").pop() + ":" + (e && e.lineno || "?")); } catch { /* 忽略 */ }
});
window.addEventListener("unhandledrejection", (e) => {
  try { window.petAPI.playback("[jsrej] " + ((e && e.reason && (e.reason.message || e.reason)) || "?")); } catch { /* 忽略 */ }
});

function bindCtxLost(canvas, tag) { // 低配核显 WebGL 上下文丢失 → 上报 + 自愈重载
  if (!canvas) return;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    window.petAPI.playback && window.petAPI.playback("[gpu] WebGL 上下文丢失: " + tag);
    window.petAPI.reloadRenderer && window.petAPI.reloadRenderer();
  });
}

let live2dScaleFactor = 1.0;
function applyLive2dScale(v) {
  live2dScaleFactor = Number(v) > 0 ? Number(v) : 1.0;
  try { window.Live2DRuntime && window.Live2DRuntime.setScale(live2dScaleFactor); } catch { /* 忽略 */ }
  if (live2dActive) { // 等比窗口：滑条放大时窗口同步变大，模型不裁剪（照 rig 的窗口随 scale 思路）
    window.petAPI.setSize(Math.round(300 * live2dScaleFactor), Math.round(460 * live2dScaleFactor));
  }
}

function setLive2dMood(mood) {
  if (!live2dActive || !window.Live2DRuntime) return;
  try { window.Live2DRuntime.setMood(mood); } catch { /* 忽略 */ }
}
function rigShow() { if (rigCanvas) rigCanvas.classList.remove("hidden"); }
function rigHide() { if (rigCanvas) rigCanvas.classList.add("hidden"); }
function rigPresetForMood(mood) {
  if (!rigRuntime) return;
  const map = { idle: "neutral", happy: "smile", surprised: "surprise", wave: "wink" };
  if (map[mood]) rigRuntime.preset(map[mood]);
  if (mood === "sleep") { rigRuntime.setParam("eyeOpenL", 0.25); rigRuntime.setParam("eyeOpenR", 0.25); }
}
/** 关闭 2.5D 并切回原渲染（renderMode：spine→初始化 spine，否则 GIF） */
async function rigOffBackToBase() {
  rigSkinId = "";
  destroyRig();
  if (renderMode === "spine") {
    await setRenderMode("spine");
  } else {
    spriteEl.style.display = "";
  }
}
/** 切换 2.5D 皮肤（id 空=关闭） */
async function applyRigSkin(id) {
  const ok = await initRig(id);
  if (!ok && id) {
    // 加载失败：回原模式
    if (renderMode === "spine") { await setRenderMode("spine"); }
    else spriteEl.style.display = "";
  }
}

function spineHas(name) { return !!spineObj && !!spineObj.spineData.animations.find((a) => a.name === name); }

/* ---------- 动画切换（Spine） ---------- */
function setSpineAnim(name, loop) {
  if (!spineObj) return;
  spineObj.state.setAnimation(0, name, loop);
}
function addSpineAnim(name, loop) {
  if (!spineObj) return;
  spineObj.state.addAnimation(0, name, loop, 0);
}

/** 播放新动画后测量姿势包围盒并自适应（坐姿/睡姿超出画布任意一边都会被裁掉） */
let spineFitTimers = [];
let spineFitGeneration = 0;
let spineFitStableHits = 0;
function scheduleFitSpine() {
  spineFitGeneration += 1;
  spineFitStableHits = 0;
  // spineAutoScaled / spineFitKeepScale 跨动画保持（只在换皮肤 initSpine 时重置）：
  // 每次动画切换都重置会让适配无限累乘放大（迷迭香实测每次相位切换 ×1.59，几次后角色暴涨出画布消失）
  spineFitTimers.forEach(clearTimeout);
  const generation = spineFitGeneration;
  spineFitTimers = [150, 500, 1000, 1800, 2800, 4200].map((ms) => setTimeout(() => fitSpinePose(generation), ms));
}
let spineBoost = 1; // >1 表示该模型包围盒远大于可见内容（空白/特效区），fit 校准需跳过缩小保护
let spineXoff = 0;  // 可见主体偏在包围盒一侧时的水平居中修正（占包围盒宽度比例，face=-1 时自动镜像）
let spineManual = false;   // 该皮肤是否手动调过 boostTable（true 则不做像素级自动放大）
let spineAutoScaled = false; // 本次加载是否已做过像素级自动放大（只做一次，防反复放大）
let spineFitKeepScale = false; // 自动适配后跳过宽度守卫（宽包围盒皮肤防被每帧贴合缩回）
let spineFigLeftCss = 0; // 自动适配皮肤：角色可见左缘在窗口内的 CSS 位置（画布加宽后行走对齐用）
function fitSpinePose(generation = spineFitGeneration) {
  try {
    if (!spineObj || !spineApp || renderMode !== "spine" || generation !== spineFitGeneration) return;
    let W = spineApp.screen.width, H = spineApp.screen.height;
    const safe = 4;
    const flip = walkState.face === -1 ? -1 : 1;
    const baseline = Math.abs(spineBaseScaleX);
    const bboxBounds = () => { spineObj.position.set(0, 0); spineObj.updateTransform(); return spineObj.getBounds(); };
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
      if (!(b.width > 0) || !(b.height > 0)) return null;
      spineObj.x += (W - b.width) / 2 - b.x;
      spineObj.y += H - (b.y + b.height);
      spineObj.updateTransform();
      return b;
    };

    // ---- 自动适配过的皮肤：固定缩放 + 可见轮廓定位 ----
    if (spineFitKeepScale) {
      // 迭代平移使可见轮廓整体入画布 → 采样不被裁剪 → 按可见中心/底边精定位（贴地留 5% 边距）
      spineObj.scale.set(baseline * flip, baseline);
      bboxPosition();
      let vis = null;
      for (let iter = 0; iter < 10 && !vis; iter++) {
        const s = sample();
        if (!s) break;
        const m = 2;
        let moved = false;
        if (s.x0 <= m) { spineObj.x += (m - s.x0) + 6; moved = true; }
        else if (s.x1 >= W - m) { spineObj.x -= (s.x1 - (W - m)) + 6; moved = true; }
        if (s.y0 <= m) { spineObj.y += (m - s.y0) + 6; moved = true; }
        else if (s.y1 >= H - m) { spineObj.y -= (s.y1 - (H - m)) + 6; moved = true; }
        if (!moved) vis = s;
        else spineObj.updateTransform();
      }
      if (vis) {
        spineObj.x += W / 2 - (vis.x0 + vis.x1) / 2;
        spineObj.y += H - vis.y1; // 贴画布底边（layoutGap 由主进程统一补偿，不再加边距避免悬浮）
        spineFigLeftCss = petEl ? petEl.offsetLeft + vis.x0 * (petEl.clientWidth / Math.max(1, W)) : 0;
      } else {
        spineFigLeftCss = petEl ? petEl.offsetLeft : 0;
      }
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
          try { window.petAPI.playback && window.petAPI.playback(`[spine] 自动适配 vis=${Math.round(visH)}px → ×${kk.toFixed(2)} (aspect=${aspect.toFixed(2)}) dir=${relDirOf()}`); } catch { /* 忽略 */ }
          fitSpinePose();
          return;
        }
      }
    }

    // ---- 常规显示（未适配/无需适配）：包围盒守卫缩放 + 定位 + 贴地空隙 ----
    {
      spineObj.scale.set(baseline * flip, baseline);
      const b = bboxBounds();
      if (!(b.width > 0) || !(b.height > 0)) { reportGroundGap(); scheduleGeometryReport(); return; }
      // §14 追加 105：宽度约束放宽 12% 余量（高度仍严格）——坐姿/Relax 等姿势包围盒略超宽（实测 125 > 120）
      // 时不会被整体缩小 10%；可见主体居中的模型横向透明区足以容纳，日常站姿（bbox 更窄）完全不受影响。
      const k = Math.min(1, (W * 1.12 - safe * 2) / b.width, (H - safe * 2) / b.height);
      // §14 追加 105 诊断（限频）：守卫发生缩小（k<1）时记录姿势/包围盒，定位"坐下缩小"问题
      if (k < 0.97) {
        const _now = Date.now();
        if (_now - (window.__spineGuardLogAt || 0) > 500) {
          window.__spineGuardLogAt = _now;
          let _anim = "?";
          try { _anim = typeof spinePhaseAnim === "function" ? spinePhaseAnim() : "?"; } catch { /* 忽略 */ }
          try { window.petAPI.playback && window.petAPI.playback(`[spine] guard k=${k.toFixed(3)} base=${baseline.toFixed(3)} anim=${_anim} bbox=${Math.round(b.width)}x${Math.round(b.height)} W=${W} H=${H}`); } catch { /* 忽略 */ }
        }
      }
      spineObj.scale.set(baseline * k * flip, baseline * k);
      spineObj.position.set(0, 0);
      spineObj.updateTransform();
      spineObj.x += (W - spineObj.getBounds().width) / 2 - spineObj.getBounds().x;
      const b2 = spineObj.getBounds();
      if (spineXoff) spineObj.x += spineXoff * b2.width * flip;
      spineObj.y += H - (b2.y + b2.height);
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
 *  主进程贴地吸附时用它把窗口下探相应距离，让脚真正踩在任务栏/图标上 */
/** 使用未缩放布局坐标上报几何，避免 CSS zoom 的视觉矩形与 Electron DIP 混用。 */
let visibleCanvasGap = 0;
let visibleCanvasGapCandidate = 0;
let visibleCanvasGapHits = 0;
let geometryReportTimer = null;
function reportGroundGap() {
  try {
    if (!petEl || !document.documentElement) return;
    const insetRaw = spineFitKeepScale && spineFigLeftCss > 0
      ? spineFigLeftCss // 自动适配皮肤：角色可见左缘（画布已按宽比加宽，元素左缘 ≠ 角色左缘）
      : Number(petEl.offsetLeft) || 0;
    const inset = Math.max(0, Math.min(document.documentElement.clientWidth || 260, Math.round(insetRaw))); // 左边界补偿：角色条带不可能超出窗口宽，用 clientWidth 作上限（异常上报会把行走左边界扩到屏幕外导致角色“闪现”出屏）
    const layoutGap = (document.documentElement.clientHeight || 0) - ((Number(petEl.offsetTop) || 0) + (Number(petEl.offsetHeight) || 0));
    const gap = Math.max(0, Math.min(80, Math.round(layoutGap + visibleCanvasGap)));
    window.petAPI.setGroundGap(gap);
    window.petAPI.setCharInset && window.petAPI.setCharInset(inset);
  } catch { /* 忽略 */ }
}
function scheduleGeometryReport() {
  cancelAnimationFrame(scheduleGeometryReport.raf || 0);
  clearTimeout(geometryReportTimer);
  scheduleGeometryReport.raf = requestAnimationFrame(() => {
    reportGroundGap();
    geometryReportTimer = setTimeout(reportGroundGap, 120);
  });
}

/** 行走朝向：face=-1 时镜像翻转（假设模型原始朝右；若实际相反改此处符号即可）
 *  注意：fitSpinePose 可能已按姿势 containment 缩小 scale（mag < spineBaseScaleX），
 *  翻转必须保持等比——以当前 scale.y 的绝对值为基准，只改符号，否则会左右拉伸。 */
function spineFaceDir(face) {
  if (!spineObj) return;
  const sy = Math.abs(spineObj.scale.y);
  const sx = sy * (face === -1 ? -1 : 1);
  if (spineObj.scale.x !== sx) {
    spineObj.scale.x = sx;
    scheduleFitSpine(); // 翻转后包围盒镜像，主体偏移方向也跟着反，需重新居中
  }
}

/** 当前应播放的移动相位动画：窗顶→Sit，地面放松→待机（Relax），走动→Move */
function spinePhaseAnim() {
  if (!walkState.active) return null;
  if (walkState.perched && spineHas("Sit")) return "Sit";
  if (walkState.paused) return spineAnimForMood("idle"); // 暂停中（单击互动/拖拽）：站立待机，不挂走路动画
  if (!walkState.resting) {
    if (spineHas("Move")) return "Move";
    const cls = ensureAnimClasses(); // 未知模型：按动画名模式归类出「移动类」
    if (cls && cls.move && cls.move[0]) return cls.move[0];
  }
  return spineAnimForMood("idle");
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

// 情绪 → Spine 动画名映射（Spine 模型中的动画名可能不同于 GIF 名）
function spineAnimForMood(mood) {
  // 尝试精确匹配
  if (spineObj && spineObj.spineData.animations.find(a => a.name === mood)) return mood;
  // 动画名自动分类兜底（未知模型）：按归类结果直接选
  const cls = ensureAnimClasses();
  if (cls && !spineHas("Relax")) { // 已知模型走下面的映射表；未知模型用分类结果
    if (mood === "idle" && cls.idle && cls.idle[0]) return cls.idle[0];
    if ((mood === "sleep") && cls.sleep && cls.sleep[0]) return cls.sleep[0];
    if ((mood === "wave" || mood === "surprised") && cls.interact && cls.interact[0]) return cls.interact[0];
    if ((mood === "think") && cls.sit && cls.sit[0]) return cls.sit[0];
    if (cls.idle && cls.idle[0]) return cls.idle[0];
  }
  // 常见映射（明日方舟基建模型只有 Relax/Move/Interact，情绪统一回退 Relax）
  const map = {
    idle: ["Relax", "Idle", "idle", "animation", "stand"],
    happy: ["happy", "Happy", "Relax"],
    think: ["think", "Think", "Sit", "Relax"],
    sleep: ["Sleep", "sleep", "Sit", "Relax"],
    wave: ["wave", "Wave", "Interact"],
    angry: ["angry", "Angry", "Relax"],
    surprised: ["surprise", "Surprised", "Interact"],
  };
  const candidates = map[mood] || [mood];
  for (const c of candidates) {
    if (spineObj && spineObj.spineData.animations.find(a => a.name === c)) return c;
  }
  // 回退到第一个可用动画
  if (spineObj && spineObj.spineData.animations.length > 0) {
    return spineObj.spineData.animations[0].name;
  }
  return null;
}

async function initSpine(epoch = renderModeEpoch) {
  try {
    if (spineApp) return true; // 已初始化
    spineClassified = null;    // 新模型重新做动画名分类

    // 懒人换肤：主进程扫描 spine/user/ 下所有皮肤，返回当前选中的那套
    try {
      const res = await window.petAPI.getSpineModels();
      if (res && Array.isArray(res.list) && res.list.length) {
        const cur = res.list.find((m) => m.id === (res.current || "builtin")) || res.list[0];
        spinePaths = { atlas: cur.atlas, skel: cur.skel };
        window.petAPI.playback && window.petAPI.playback("[spine] initSpine 选中: " + cur.id); // TODO 心跳诊断
        if (cur.id !== "builtin") console.log("[Spine] 使用自定义皮肤:", cur.atlas);
      }
    } catch { /* 探测失败用内置 */ }
    // 创建 PixiJS 应用
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2)); // 高DPI 屏按物理像素渲染，避免整体发糊
    spineApp = new PIXI.Application({
      width: petEl.clientWidth || 260,
      height: petEl.clientHeight || 200,
      backgroundAlpha: 0, // 透明背景
      autoStart: true,
      antialias: true,
      resolution: dpr,
      autoDensity: true // 画布物理分辨率提升但 CSS 尺寸保持不变
    });
    spineApp.view.id = "spine-canvas";
    bindCtxLost(spineApp.view, "spine");
    spineApp.view.classList.add("spine-canvas");

    // 替换 GIF img 为 Spine canvas
    spriteEl.style.display = "none";
    petEl.insertBefore(spineApp.view, spriteEl);

    // 加载 Spine 资源（先图集后骨架；.skel 二进制与 .json 均由 pixi-spine 解析器处理）
    const atlasRes = await PIXI.Assets.load(spinePaths.atlas, (p) => {
      console.log("Spine 图集加载:", Math.round((p || 0) * 100) + "%");
    });
    // 模型会被明显缩小显示：开启 mipmap 减少缩小发虚
    try {
      for (const page of (atlasRes && atlasRes.pages) || []) {
        if (page && page.baseTexture) {
          page.baseTexture.autoGenerateMipmaps = true;
          page.baseTexture.mipmap = PIXI.MIPMAP_MODES?.ON ?? 1;
          page.baseTexture.update();
        }
      }
    } catch { /* mipmap 失败不影响渲染 */ }
    const skelRes = await PIXI.Assets.load(spinePaths.skel, (p) => {
      console.log("Spine 骨架加载:", Math.round((p || 0) * 100) + "%");
    });
    if (epoch !== renderModeEpoch || renderMode !== "spine") {
      if (spineApp) { try { spineApp.destroy(true, { children: true }); } catch { /* 忽略 */ } spineApp = null; }
      spriteEl.style.display = "";
      return false;
    }
    // pixi-spine v4：类挂在 PIXI.spine 命名空间；解析结果含 spineData
    const SpineCtor = (PIXI.spine && PIXI.spine.Spine) || PIXI.Spine;
    const spineData = skelRes && skelRes.spineData ? skelRes.spineData : skelRes;
    spineObj = new SpineCtor(spineData);
    spineApp.stage.addChild(spineObj);
    try { spineObj.state.data.defaultMix = 0.25; } catch { /* 忽略 */ } // 动画切换混合过渡，避免硬切跳变（借鉴 Ark-Pets）

    // 居中并缩放到合适大小
    spineObj.x = spineApp.screen.width / 2;
    spineObj.y = spineApp.screen.height;
    // 测量有效性防护：部分模型未播动画时骨骼收拢，width/height 接近 0，
    // 直接进缩放公式会得到天文数字的倍率爆出画布——此时改用标准基准尺寸
    const mw = spineObj.width || 0, mh = spineObj.height || 0;
    const useW = mw > 50 ? mw : 300, useH = mh > 50 ? mh : 400;
    const scale = Math.min(
      spineApp.screen.width / useW,
      spineApp.screen.height / useH
    ) * 0.9;
    // 部分模型导出尺度/宽高比不同：按目录名加缩放修正（宽度优先约束，防横向出画布）
    const boostTable = {
      "4179_monstr_boc_11": 7.5,
      "254_vodfox": 1.8,
      "358_lisa": 1.45,
      "2015_dusk": 2.5,
      "254_vodfox_witch_2": 1.3,
      "358_lisa_epoque_22": 1.4,
      "358_lisa_wild_3": 2.4,
      "2015_dusk_nian_7": 5.0,
      "2015_dusk_nian_12": 1.4,
      "254_vodfox_yun_8": 2.1,
      "2025_shu": 1.65,
      "2025_shu_nian_11": 1.6
    };
    // 部分模型可见主体偏在包围盒一侧（如持枪姿势）：按目录名给水平居中修正（占包围盒宽度比例）
    const boostOffsetTable = {
    };
    // §14 追加 105：皮肤级显示倍率覆盖（瘦/窄模型手动调大；不动苏苏洛本体与通用逻辑）。
    // 命中即按手动皮肤处理（跳过像素自动适配，走守卫最大化到画布内）。数值待用户验收后微调。
    const SKIN_SCALE_OVERRIDE = {
      "1035_wisdel": 1.5, // 维什戴尔默认装：用户反馈偏小（×1.25 仍小）；1.5≈91px 对齐 sale_14 观感
    };
    let boost = 1, xoff = 0, manualHit = false;
    try {
      const segs = decodeURIComponent((spinePaths.skel || "")).split("/");
      // 定位 spine/user/<目录>/... 中的目录段：数字前缀目录（官方导出名）优先；无数字前缀（summer/winter 等自定义目录）取 user 后一段
      const uIdx = segs.lastIndexOf("user");
      const dirName = segs.find((p) => /^\d{3,4}_/.test(p)) || (uIdx >= 0 && segs[uIdx + 1] ? segs[uIdx + 1] : "");
      boost = boostTable[dirName] || 1;
      xoff = boostOffsetTable[dirName] || 0;
      manualHit = !!boostTable[dirName];
      // §14 追加 105：皮肤级倍率覆盖并入 boost（dirName 在此作用域内可直接用）
      if (SKIN_SCALE_OVERRIDE[dirName] && SKIN_SCALE_OVERRIDE[dirName] !== 1) {
        boost *= SKIN_SCALE_OVERRIDE[dirName];
        manualHit = true;
        try { window.petAPI.playback && window.petAPI.playback(`[spine] override ${dirName} ×${SKIN_SCALE_OVERRIDE[dirName]}`); } catch { /* 忽略 */ }
      }
    } catch { boost = 1; xoff = 0; }
    spineBoost = boost; // fitSpinePose 据此跳过缩小保护
    spineXoff = xoff;   // fitSpinePose 据此水平居中可见主体
    spineManual = manualHit;   // 手动调过的皮肤不做像素级自动放大
    spineAutoScaled = false;   // 每次加载重置自动放大标记
    spineFitKeepScale = false; // 每次加载重置宽度守卫豁免
    spineBaseScaleX = scale * boost;
    spineObj.scale.set(scale * boost);
    // TODO 心跳诊断（临时）：初始化关键数值，定位后移除
    try {
      window.petAPI.playback && window.petAPI.playback(
        `[spine] ok boost=${boost} scale=${scale.toFixed(4)} final=${(scale * boost).toFixed(4)} w=${Math.round(spineObj.width)} h=${Math.round(spineObj.height)} skel=${spinePaths.skel}`
      );
    } catch { /* 忽略 */ }

    // 播放默认动画
    const animName = spineAnimForMood("idle");
    if (animName) {
      setSpineAnim(animName, true, "init");
      scheduleFitSpine();
    }

    console.log("[Spine] 初始化完成, 可用动画:",
      spineObj.spineData.animations.map(a => a.name));
    return true;
  } catch (e) {
    console.error("[Spine] 初始化失败:", e);
    // TODO 诊断埋点（临时）：把真实加载错误写进 tts.log，定位后移除
    try {
      window.petAPI.playback && window.petAPI.playback(
        "[spine] 初始化失败: " + (e && e.message || e) +
        " | atlas=" + (spinePaths && spinePaths.atlas || "?") +
        " skel=" + (spinePaths && spinePaths.skel || "?")
      );
    } catch { /* 忽略 */ }
    // 失败则回退到 GIF 模式
    renderMode = "gif";
    if (spineApp && spineApp.view.parentNode) {
      spineApp.view.style.display = "none";
    }
    spriteEl.style.display = "";
    return false;
  }
}

/** 在 Spine/GIF 模式间切换（3D 由 3d-mode.js 自治，这里只做显示归属） */
async function setRenderMode(mode) {
  if (mode === renderMode && !(mode === "spine" && !spineApp)) return;
  const epoch = ++renderModeEpoch;
  renderMode = mode;

  if (mode !== "live2d") destroyLive2d(); // 离开 Live2D：先销毁再走原逻辑

  if (mode === "spine") {
    const ok = await initSpine(epoch);
    if (epoch !== renderModeEpoch) return;
    if (ok) {
      spriteEl.style.display = "none";
      if (spineApp && spineApp.view) spineApp.view.style.display = "";
    } else {
      renderMode = "gif"; // Spine 初始化失败回退 GIF
    }
  } else {
    // 切回 GIF
    spriteEl.style.display = "";
    if (spineApp && spineApp.view) spineApp.view.style.display = "none";
  }
}

/** 主进程广播行走状态：切 Move/Relax/Sit 动画并同步朝向 */
let animDemoUntil = 0; // 动作试演期间不被行走相位打断
function applyWalkState(s) {
  const wasActive = walkState.active;
  walkState = s || walkState;
  // 行走激活瞬间恢复标准窗口：气泡加宽（ensureWindowWidthFor）的大窗口会破坏行走几何（charInset 超上限→出屏“闪现”）。
  // v2.5.10：宽皮肤按其窗口宽度恢复，否则会顶掉 460 宽的宽模型布局。
  if (walkState.active && !wasActive && !(rigSkinId && rigRuntime)) {
    window.petAPI.setSize(winSize.width || 260, winSize.height || 200);
  }
  if (!spineObj || renderMode !== "spine") return;
  if (isSleeping) return;                 // 睡觉中：不被行走动画打断
  spineFaceDir(walkState.face);
  if (Date.now() < animDemoUntil) return; // 演示中，不打断
  // 坐下（任务栏上沿/桌面图标顶/窗顶）：Sit 循环，优先级高于行走相位
  if (walkState.seated || walkState.perched) {
    const sit = ["Sit", "sit"].find((n) => spineHas(n));
    const target = sit || spinePhaseAnim();
    if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
      setSpineAnim(target, true, "seat-phase");
      scheduleFitSpine();
    }
    return;
  }
  if (!walkState.active) {
    // 行走刚停止 → 恢复正常待机动画（否则会一直保持最后姿势）
    if (wasActive && !busy) {
      const idle = spineAnimForMood("idle");
      if (idle && spineObj.state.getCurrent(0)?.animation?.name !== idle) {
        setSpineAnim(idle, true, "stop-idle");
        scheduleFitSpine();
      }
    }
    return;
  }
  if (busy) return;                       // 聊天表情优先，不打断
  const target = spinePhaseAnim();
  if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
    setSpineAnim(target, true, "walk-phase");
    scheduleFitSpine();
  }
}

/** 单击互动：播一次 Interact 后接回当前相位动画（还原游戏内点击基建干员的反应） */
let pokeFeedbackAt = 0;
function pokeFeedback() { // 点击反馈（v2.5.1）：缩放脉冲 + 原声切片——不依赖模型动作集，任何模型必有反馈
  const now = Date.now();
  if (now - pokeFeedbackAt < 600) return; // 连点限流
  pokeFeedbackAt = now;
  // 跳一下：模型上跳 16px 再落回（250ms，视觉明显的点击反馈）
  try {
    if (spineObj) {
      const baseY = spineObj.y;
      spineObj.y = baseY - 16;
      setTimeout(() => { try { spineObj.y = baseY - 6; } catch { /* 忽略 */ } }, 120);
      setTimeout(() => { try { spineObj.y = baseY; } catch { /* 忽略 */ } }, 250);
    }
  } catch { /* 忽略 */ }
  // 原声切片（随包苏苏洛游戏语音）：语音开着才出声，随机一条
  try { if (ttsConfig.enabled) playPresetVoice(); } catch { /* 忽略 */ }
}

function playSpineInteract() {
  try { window.petAPI.playback("[ui] interact入口 spineObj=" + !!spineObj + " mode=" + renderMode + " busy=" + busy); } catch { /* 忽略 */ }
  if (!spineObj || renderMode !== "spine" || busy) return;
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
  scheduleFitSpine();
}

/** 在 Spine 模式下播放对应情绪的动画 */
function setSpineMood(mood) {
  if (!spineObj || renderMode !== "spine") return;
  if (Date.now() < animDemoUntil) return; // 动作试演中，不被情绪切换打断
  // 坐下状态：待机回落/轮换保持坐姿，不被顶回站姿（聊天情绪仍可短暂覆盖）
  if ((walkState.seated || walkState.perched) && (mood === "idle" || mood === undefined)) {
    const sit = ["Sit", "sit"].find((n) => spineHas(n));
    if (sit && spineObj.state.getCurrent(0)?.animation?.name !== sit) {
      setSpineAnim(sit, true, "sit-guard");
      scheduleFitSpine();
    }
    return;
  }
  // 行走相位中回落待机 → 保持走路动画不中断（非 idle 情绪照常显示）
  if (walkState.active && !walkState.resting && !busy && mood === "idle" && spineHas("Move")) {
    spineFaceDir(walkState.face);
    if (spineObj.state.getCurrent(0)?.animation?.name !== "Move") {
      setSpineAnim("Move", true, "walk-mood");
      scheduleFitSpine();
    }
    return;
  }
  const animName = spineAnimForMood(mood === "idle" ? "idle" : mood);
  if (animName && spineObj.state.getCurrent(0)?.animation?.name !== animName) {
    setSpineAnim(animName, true, "mood:" + mood);
    scheduleFitSpine();
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
let agreed = true;        // 是否已同意使用条款
let replyBuffer = "";
let revealTimer = null;
let typing = false;
let lastMood = "idle";
let moodTimer = null;      // 心情自动回落定时器
let sleepTimer = null;     // 闲置睡觉定时器
let awake = true;
let isSleeping = false;    // 睡觉状态（同步给行走引擎暂停移动）
let idleIdx = 0;

function setMood(mood) {
  // mood = 内部状态名（happy/think/sleep/…或自定义情绪名）；"idle"/未知 → 从待机池轮换
  const names = moodNames();
  const idles = idleNames();
  let pool;
  if (mood === "idle" || !names.includes(mood)) pool = idles;
  else pool = [mood];
  if (!pool.length) return;
  const file = pool.length > 1 ? pool[++idleIdx % pool.length] : pool[0];
  lastMood = mood;

  // 睡觉/醒来同步行走引擎（睡着后不再移动）
  if (mood === "sleep" && !isSleeping) { isSleeping = true; window.petAPI.setSleeping(true); }
  else if (mood !== "sleep" && isSleeping) { isSleeping = false; window.petAPI.setSleeping(false); }

  // PSD 2.5D 角色（v2.2）：情绪 → 表情预设（独立于 Spine）
  if (rigSkinId && rigRuntime) { rigPresetForMood(mood); petEl.dataset.mood = mood; return; }

  // Live2D（v2.5.1）：情绪 → 动作/表情
  if (live2dActive) { setLive2dMood(mood); petEl.dataset.mood = mood; return; }

  // Spine 模式：切换 Spine 动画而非 GIF
  if (renderMode === "spine") { setSpineMood(mood); petEl.dataset.mood = mood; return; }

  // GIF 模式
  const gifUrl = SPRITE_BASE + encodeURI(file) + ".gif?t=" + Date.now();
  if (spriteEl.dataset.src === gifUrl.split("?")[0]) return; // 同一张不重复切换
  // 预载解码后再切（ottopet 借鉴：GIF 预载进正题，避免切换瞬间空白/卡顿）
  showGifWithPreload(gifUrl, mood, file);
}

/** 预载目标 GIF（decode 完成或超时 800ms 兜底）后切换；spine/rig 模式由调用方绕过 */
function showGifWithPreload(gifUrl, mood, file) {
  const im = new Image();
  let done = false;
  const apply = () => {
    if (done) return;
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
    if (!busy && mood !== "sleep" && mood !== "work") setMood("idle");
  }, 3000);
}

function wake() {
  if (!awake) {
    awake = true;
    if (!busy) setMood("surprised"); // 被叫醒
  }
  resetSleepTimer();
}
function resetSleepTimer() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { if (!busy) setMood("sleep"); }, 5 * 60 * 1000);
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
}
function stopReveal() {
  if (revealTimer) { clearInterval(revealTimer); revealTimer = null; }
  typing = false;
}

function startReveal(full, offset) {
  stopReveal();
  typing = true;
  revealTimer = setInterval(() => {
    offset = Math.min(full.length, offset + 3);
    bubbleText.innerHTML = renderRpSlice(full, offset);
    if (offset >= full.length) stopReveal();
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
    presetAudio.onended = () => { isSpeakingAudio = false; };
    presetAudio.onerror = () => { isSpeakingAudio = false; };
    presetAudio.play().catch(() => { isSpeakingAudio = false; });
  } catch (e) { isSpeakingAudio = false; }
}

function speakSystem(clean, rateOverride, pitchOverride) {
  stopTts();
  try {
    const u = new SpeechSynthesisUtterance(clean);
    if (zhVoice) u.voice = zhVoice;
    u.lang = (zhVoice && zhVoice.lang) || "zh-CN";
    u.rate = rateOverride || ttsConfig.rate || 0.95;
    u.pitch = pitchOverride || ttsConfig.pitch || 1.1;
    u.volume = 1;
    isSpeakingAudio = true;
    const finish = () => { isSpeakingAudio = false; };
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

let speakSession = 0;   // 语音会话号：新消息的 speak 让旧消息的合成结果/part 作废（消息生成防抖）
async function speak(text, emotion) {
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
  try {
  // 优先克隆语音链路（Genie / GPT-SoVITS 日语 / Cosy / edge，主进程内部选择）
  if (ttsCloudOn) {
    try {
      const partsBefore = ttsPartPlayedCount;
      const b64 = await window.petAPI.speakClone(clean, { emo: emotion, session: mySession }); // 情绪 → 主进程切参考音频（仅撒娇/傲娇/惊讶命中）；会话号让旧任务让位
      if (mySession !== speakSession) return; // 等待期间来了新消息：本会话结果整体作废
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
            if (epoch === playbackEpoch) isSpeakingAudio = false;
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
  // 引擎全不可用 → 播放苏苏洛原声预设切片（游戏语音，替代难听的系统合成音）
  window.petAPI.playback("语音引擎不可用 → 播放原声预设");
  playPresetVoice();
  } finally {
    if (mySession === speakSession) speakActive = false; // 只由最新会话收口流式接收窗口
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
  const maxH = Math.max(24, document.documentElement.clientHeight - 24);
  const curW = parseFloat(bubbleEl.style.width) || 0;
  const curH = parseFloat(bubbleEl.style.height) || 0;
  if (curW > maxW || curH > maxH) {
    bubbleEl.style.width = Math.min(curW, maxW) + "px";
    bubbleEl.style.height = Math.min(curH, maxH) + "px";
  }
}

function applyBubbleSize() {
  try {
    if (rigSkinId && rigRuntime) { // rig 模式：气泡尺寸交给 rig 布局 CSS，不恢复拖拽记忆/固定宽高
      bubbleEl.style.width = "";
      bubbleEl.style.height = "";
      return;
    }
    const w = parseFloat(localStorage.getItem("suzuran.bubbleW"));
    const h = parseFloat(localStorage.getItem("suzuran.bubbleH"));
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 60 && h >= 24) {
      bubbleEl.style.width = Math.min(w, document.documentElement.clientWidth - 10) + "px";
      bubbleEl.style.height = Math.min(h, document.documentElement.clientHeight - 24) + "px";
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
  if (rigSkinId && rigRuntime) {
    // rig 模式：放大按钮只放大气泡，不改变窗口（rig 窗口由大小滑杆 rigScale 控制，避免角色跟着放大）
    zoomBtn.textContent = enlarged ? "⤡" : "⤢";
    if (enlarged) showBubble();
    if (enlarged) { bubbleEl.style.width = ""; bubbleEl.style.height = ""; }
    setTimeout(clampBubbleToWindow, 80);
    return;
  }
  const restoreW = live2dActive ? 300 : winSize.width; // live2d 专属窗口：还原回 300×460 而非旧记忆尺寸
  const restoreH = live2dActive ? 460 : winSize.height;
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
        localStorage.setItem("suzuran.bubbleH", String(Math.round(Math.min(r.height, document.documentElement.clientHeight - 24))));
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
  if (rigSkinId && rigRuntime) return; // rig 模式：窗口尺寸由 rigScale 控制，气泡宽度调整不放大窗口/角色
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
    bubbleEl.style.width = (rigSkinId && rigRuntime) ? "" : Number(a.bubbleWidth) + "px";
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
  resetSleepTimer();
});

window.petAPI.onError(({ message }) => {
  showError(message);
  maybeFlushPendingSend(); // 防抖：错误后补发等待中的消息（用户想说的还是会被回答）
  speak("唔……出错了。");
});

// v2.6 主动停止：主进程中止路径不再发 done/error，收到 stopped 才复位 busy/语音，丢弃防抖缓冲
if (window.petAPI.onStopped) {
  window.petAPI.onStopped(() => {
    stopTts();
    clearPendingSend(); // 用户要静默：不补发缓冲中的消息
    busy = false;
    updateControls();
    hideThinking();
  });
}

window.petAPI.onModeChanged((m) => {
  forcedMode = m;
  updateChip();
});

window.petAPI.onToggleInput(() => toggleInputBar());

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
  if (live2dActive) { try { window.Live2DRuntime.poke(); } catch { /* 忽略 */ } return; } // Live2D：放下抖一下
  if (!(rigSkinId && rigRuntime)) playSpineInteract(); // 2.5D 模式不播 Spine 互动
});
}
if (window.petAPI.onEdgeLeft) {
  window.petAPI.onEdgeLeft((v) => document.body.classList.toggle("edge-left", !!v)); // 角色贴屏幕左缘：条带切左侧、气泡翻右侧
}
if (window.petAPI.onRenderModeChanged) {
  window.petAPI.onRenderModeChanged(async (m) => {
    if (enlarged) { // 切模式还原放大状态：zoom 暂停标志不跨模式残留
      enlarged = false;
      document.body.classList.remove("enlarged");
      zoomBtn.textContent = "⤢";
      window.petAPI.walkingPause && window.petAPI.walkingPause(false, "zoom");
    }
    if (m === "rig") { // 切到 2.5D：需要皮肤（无则回 gif）
      const ok = await initRig(rigSkinId || (await window.petAPI.getState()).rigSkinId);
      if (!ok) { renderMode = "gif"; spriteEl.style.display = ""; }
    } else if (m === "live2d") { // 切到 Live2D（v2.5.1）
      const ok = await initLive2d((await window.petAPI.getState()).live2dSkinId);
      if (!ok) { renderMode = "gif"; spriteEl.style.display = ""; }
    } else {
      if (rigSkinId) { rigSkinId = ""; destroyRig(); }
      await setRenderMode(m === "spine" ? "spine" : "gif");
    }
    setMood(lastMood || "idle"); // 切换后恢复当前情绪
  });
}
if (window.petAPI.onLive2dChanged) {
  window.petAPI.onLive2dChanged(async (id) => { // 同模式换模型：重载
    if (!live2dActive) return;
    destroyLive2d();
    const ok = await initLive2d(id);
    if (!ok) { renderMode = "gif"; spriteEl.style.display = ""; }
    setMood(lastMood || "idle");
  });
}

/** 换肤：销毁旧模型与画布，重新探测皮肤并完整初始化 */
async function rebuildSpine() {
  try {
    if (spineObj) { try { spineObj.destroy(); } catch { /* 忽略 */ } spineObj = null; }
    if (spineApp) {
      const view = spineApp.view;
      if (view && view.parentNode) view.parentNode.removeChild(view);
      try { spineApp.destroy(false, { children: true, texture: false, baseTexture: false }); } catch { /* 忽略 */ }
      spineApp = null; // 共享纹理缓存保留（Assets 缓存按 URL 复用）
    }
    renderMode = "gif"; // 强制 setRenderMode("spine") 走一遍完整初始化
    spriteEl.style.display = "";
    await setRenderMode("spine");
    if (walkState.active) applyWalkState(walkState);
    reportGroundGap();
  } catch (e) {
    console.error("[Spine] 换肤重建失败:", e);
  }
}
if (window.petAPI.onSpineSkinChanged) {
  window.petAPI.onSpineSkinChanged(() => rebuildSpine().then(() => setMood(lastMood || "idle")));
}
if (window.petAPI.onRigSkinChanged) { // v2.2：2.5D 皮肤切换（独立于 Spine）
  window.petAPI.onRigSkinChanged((id) => {
    if (id) initRig(id).then(() => setMood(lastMood || "idle"));
    else rigOffBackToBase().then(() => setMood(lastMood || "idle"));
  });
}
if (window.petAPI.onRigScaleChanged) { // v2.2：2.5D 角色大小实时调整
  window.petAPI.onRigScaleChanged((v) => applyRigScale(v));
}
if (window.petAPI.onRigMouseFollowChanged) { // v2.2.1：2.5D 头部/眼睛跟随鼠标实时切换
  window.petAPI.onRigMouseFollowChanged((v) => {
    rigMouseFollow = !!v;
    if (rigRuntime) rigRuntime.setAuto("mouse", rigMouseFollow);
  });
}
if (window.petAPI.onMouseTrackGlobalChanged) { // v2.2.1：全局鼠标跟踪许可实时切换（需设置页显式开启）
  window.petAPI.onMouseTrackGlobalChanged((v) => {
    mouseTrackGlobal = !!v;
    if (rigRuntime) rigRuntime.setMouseMode(mouseTrackGlobal);
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
    if (!spineObj || renderMode !== "spine" || !spineHas(name)) return;
    animDemoUntil = Date.now() + 15000; // 播 15 秒，期间行走相位不抢动画
    setSpineAnim(name, true, "demo");
    scheduleFitSpine();
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
  window.petAPI.setClickable(true);
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

/* ---------- 主动搭话（主进程发送 → 显示气泡 + 语音） ---------- */
if (window.petAPI && window.petAPI.onProactive) {
  window.petAPI.onProactive(({ text, emotion }) => {
    if (!text) return;
    showBubble();
    bubbleText.textContent = text;
    setMood(emotion || "idle");
    speak(text, emotion);
    scheduleBubbleHide(30000); // 主动消息显示 30s（用户反馈 15s 偏短）
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
  if (renderMode !== "spine" || busy || dragState || !petEl) return;
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
        if (rigSkinId && rigRuntime) rigRuntime.preset("smile");
        else playSpineInteract();
      }
    } else mouseNearAt = 0;
  } catch { /* 忽略 */ }
});

// 桌宠大小缩放（CSS zoom 整体缩放，窗口由主进程同步调整）
function applyScale(s) {
  const v = Math.max(0.6, Math.min(2.0, parseFloat(s) || 1.0));
  document.body.style.zoom = String(v);
  scheduleGeometryReport();
}
window.petAPI.onScaleChanged((v) => applyScale(v));

/* ---------- 半透明模式（借鉴 Ark-Pets opacity_dim）：角色变淡不挡视线 ---------- */
function applyDim(v) { petEl.style.opacity = v ? "0.75" : ""; }
if (window.petAPI.onSetDim) window.petAPI.onSetDim(applyDim);

/* ---------- 省电降帧（借鉴 Ark-Pets eco_mode）：静止/睡觉时降低渲染帧率 ---------- */
setInterval(() => {
  if (!spineApp) return;
  const moving = busy || !!dragState || (walkState.active && !walkState.resting);
  const target = moving ? 60 : (isSleeping ? 12 : 24);
  if (spineApp.ticker.maxFPS !== target) spineApp.ticker.maxFPS = target;
}, 4000);

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
function onDragStart(e) {
  try { window.petAPI.playback("[ui] dragStart btn=" + e.button + " target=" + (e.target.id || e.target.tagName)); } catch { /* 忽略 */ }
  wake();
  if (e.button !== 0) return;
  clearTimeout(pokeResumeTimer);
  dragState = { sx: e.screenX, sy: e.screenY, moved: false, active: true, samples: [] };
  addDragSample(dragState, e);
  window.petAPI.walkingPause(true); // 拖拽中暂停桌面行走，松手恢复
}
petEl.addEventListener("mousedown", onDragStart);
const rigCanvasEl = document.getElementById("rig-canvas");
if (rigCanvasEl) rigCanvasEl.addEventListener("mousedown", onDragStart); // rig 模式（独立大画布）也可拖动
const live2dCanvasEl = document.getElementById("live2d-canvas");
if (live2dCanvasEl) live2dCanvasEl.addEventListener("mousedown", onDragStart); // live2d 模式（独立大画布）也可拖动
// 右键宠物 → 隐藏到托盘
petEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.petAPI.hideWindow();
});
window.addEventListener("mousemove", (e) => {
  if (!dragState || !dragState.active) return;
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
/* ---------- 摸头互动（v2.3）：2 秒内快速连点角色 = 摸头 ---------- */
let patSeq = null; // { at, count, barOpenedByFirst } 连击窗口
let patFeedbackTimer = null;
function showPatFeedback() {
  if (!bubbleEl) return;
  if (patFeedbackTimer) clearTimeout(patFeedbackTimer);
  bubbleText.textContent = "❤";
  showBubble();
  patFeedbackTimer = setTimeout(() => {
    if (bubbleText.textContent === "❤") hideBubble(); // 主进程台词已覆盖则不动
  }, 2000);
}
document.addEventListener("mousedown", (e) => { // 诊断：确认鼠标事件到达渲染层
  try { window.petAPI.playback("[ui] mousedown target=" + (e.target.id || e.target.className || e.target.tagName)); } catch { /* 忽略 */ }
}, true);
window.addEventListener("mouseup", () => {
  if (!dragState) return;
  const state = dragState;
  const wasDrag = state.moved;
  try { window.petAPI.playback("[ui] mouseup wasDrag=" + wasDrag + " samples=" + state.samples.length); } catch { /* 忽略 */ }
  dragState = null;
  petEl.classList.remove("dragging");
  const velocity = wasDrag ? dragVelocity(state) : null;
  const speed = velocity ? Math.round(Math.hypot(velocity.vx, velocity.vy)) : 0;
  if (!wasDrag) {
    try { window.petAPI.playback("[ui] click 未拖动 count=" + ((patSeq && patSeq.count) || 0)); } catch { /* 忽略 */ }
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
      playSpineInteract();
      if (rigSkinId && rigRuntime) rigRuntime.preset("smile"); // 2.5D：微笑回应
      showPatFeedback();
      window.petAPI.pat && window.petAPI.pat();
    } else {
      toggleInputBar();
      playSpineInteract(); // 单击互动：还原基建里点一下干员的反应动作
      patSeq.barOpenedByFirst = !inputBar.classList.contains("hidden");
    }
    // 戳一戳/摸头时原地站定：等互动动作播完再继续散步
    clearTimeout(pokeResumeTimer);
    pokeResumeTimer = setTimeout(() => { if (!dragState) window.petAPI.walkingPause(false); }, 2600);
  } else {
    if (velocity && speed > THROW_MIN_SPEED) {
      window.petAPI.throwPet(velocity.vx, velocity.vy);
    } else {
      window.petAPI.walkingPause(false);
    }
  }
});

/* ---------- 等比缩放自愈兜底：渲染层所有缩放写入都应是等比的，
   一旦发现 |scale.x| 与 scale.y 失配（非等比拉伸残留），立即恢复均匀缩放。 ---------- */
setInterval(() => {
  try {
    if (!spineObj || renderMode !== "spine") return;
    const sx = Math.abs(spineObj.scale.x), sy = Math.abs(spineObj.scale.y);
    if (!(sx > 1e-6) || !(sy > 1e-6)) return;
    if (Math.abs(sx / sy - 1) <= 0.02) return;
    spineObj.scale.x = (spineObj.scale.x < 0 ? -1 : 1) * sy; // 保持朝向与当前 fit 高度缩放，恢复等比
    scheduleFitSpine(); // 缩放变了，重新居中/贴底
  } catch { /* 忽略 */ }
}, 200);

/* ---------- 点击穿透：透明区域不挡下层应用 ----------
   只有鼠标在 桌宠/气泡/输入栏 上时才放行鼠标事件，其余穿透给下层应用；
   拖拽中强制放行（否则 mouseup 被穿透吞掉会导致拖拽卡死） */
function isPetUI(el, e) {
  const base = !!el && (el.closest("#pet") || el.closest("#bubble") || el.closest("#input-bar") || el.closest("#rig-canvas") || el.closest("#live2d-canvas") || el.closest("#info-panel"));
  if (base) return true;
  // 行走容差圈（v2.5.1）：小人在走动，精确命中太难——鼠标在小人附近 130px 内即可点击/拖拽
  if (e && petEl && renderMode === "spine" && !busy) {
    try {
      const r = petEl.getBoundingClientRect();
      if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < 130) return true;
    } catch { /* 忽略 */ }
  }
  return false;
}
let lastMouse = { x: -1, y: -1 };
function refreshClickable(x, y) { // 穿透判定（mousemove 与定时兜底共用）
  const el = document.elementFromPoint(x, y);
  window.petAPI.setClickable(isPetUI(el, { clientX: x, clientY: y }) || (dragState && dragState.active));
}
document.addEventListener("mousemove", (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  refreshClickable(e.clientX, e.clientY);
});
setInterval(() => { // 兜底：小人走动会改变鼠标下方内容但不触发 mousemove（静止盲区），定时重判自愈
  if (lastMouse.x < 0) return;
  refreshClickable(lastMouse.x, lastMouse.y);
}, 500);

function applyPetName(name) {
  const value = String(name || "苏苏洛").trim() || "苏苏洛";
  document.title = value + "桌宠";
  spriteEl.alt = value;
  inputEl.placeholder = "和" + value + "说点什么…";
}

/* ---------- 初始化 ---------- */
(async function init() {
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
  setInterval(() => applyTheme(state.theme), 60000); // auto 模式跨时段自动切换
  if (window.matchMedia) {
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(state.theme)); } catch { /* 旧内核 */ }
  }
  if (window.petAPI.onThemeChanged) window.petAPI.onThemeChanged((th) => { state.theme = th; applyTheme(th); });

  // Spine 小人模式（支持桌面行走）；加载失败自动回退 GIF
  // PSD 2.5D（v2.2）优先且独占：renderMode=rig 或 rigSkinId 非空时 Spine 不初始化，二者完全独立
  if (state.renderMode === "rig" || state.rigSkinId) {
    await initRig(state.rigSkinId);
  } else if (state.renderMode === "live2d") {
    const ok = await initLive2d(state.live2dSkinId);
    if (!ok) { renderMode = "gif"; spriteEl.style.display = ""; }
  } else if (state.renderMode === "spine") {
    await setRenderMode("spine");
    if (state.walkState) applyWalkState(state.walkState);
  }

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
  resetSleepTimer();

  // 开场白（气泡 + 语音；可在设置里关闭「启动问候」；隐藏启动时静默待命不打扰）
  if (state.greetingOnStart !== false && state.personaOpening && !state.hiddenAtStart) {
    showBubble();
    bubbleText.textContent = state.personaOpening;
    speak(state.personaOpening);
    scheduleBubbleHide(30000); // 开场白：语音播完再隐藏，防止长开场白被提前收起
  }
})();

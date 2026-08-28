"use strict";

/* live2d-runtime.js — Live2D 渲染模式（v2.5.1，自治模块，参照 3D 时代的教训做成单点可回滚）
 * 依赖（index.html 顺序）：pixi.min.js → live2dcubismcore.min.js → pixi-live2d.min.js（UMD, PIXI.live2d）→ 本文件
 * 用法：
 *   const ok = await Live2DRuntime.init(canvasEl, modelUrl);  // 加载模型并贴底显示
 *   Live2DRuntime.destroy();                                  // 切走模式时销毁
 * v1 范围：显示 + 自动 Idle 动作 + 点击动作（库自带）；行走/坐姿联动后续迭代。
 */
(function () {
  let app = null;
  let model = null;
  let active = false;

  function fit() {
    if (!app || !model) return;
    const winW = window.innerWidth || 300;
    const winH = window.innerHeight || 460;
    app.renderer.resize(winW, winH);
    // 等比贴底：目标高度 = 窗口高 88%，水平居中，脚底贴窗口底
    const baseH = model.internalModel && model.internalModel.height ? model.internalModel.height : model.height;
    const baseW = model.internalModel && model.internalModel.width ? model.internalModel.width : model.width;
    if (!baseH || !baseW) return;
    const k = (winH * 0.88) / baseH;
    model.scale.set(k);
    model.x = Math.round((winW - baseW * k) / 2);
    model.y = Math.round(winH - baseH * k);
  }

  async function init(canvasEl, modelUrl) {
    destroy();
    if (!window.PIXI) throw new Error("PIXI 未加载");
    const live2d = (window.PIXI.live2d && window.PIXI.live2d.Live2DModel) || window.Live2DModel;
    if (!live2d) throw new Error("pixi-live2d 未加载");
    app = new PIXI.Application({
      view: canvasEl,
      width: window.innerWidth || 300,
      height: window.innerHeight || 460,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      antialias: true
    });
    model = await live2d.from(modelUrl, { autoInteract: true }); // 自动 idle + 点击动作
    app.stage.addChild(model);
    fit();
    window.addEventListener("resize", fit);
    active = true;
    return true;
  }

  function destroy() {
    active = false;
    window.removeEventListener("resize", fit);
    try { if (model) model.destroy(); } catch (e) { /* 忽略 */ }
    try { if (app) app.destroy(true, { children: true, texture: false, baseTexture: false }); } catch (e) { /* 忽略 */ }
    model = null;
    app = null;
  }

  /* 情绪 → 动作映射：优先 Tap 组动作（播一次自动回 Idle），表情按名称匹配（有对应才用）。
     映射表按 haru 标定，其他模型 Tap 数量不足时取模兜底。 */
  const MOOD_MOTION = { happy: 0, wave: 0, like: 0, surprised: 1, angry: 1, sad: 1, shy: 1 };
  let lastMoodAt = 0;

  function setMood(mood) {
    if (!model || !active) return;
    if (String(mood) === "idle" || String(mood) === "sleep") return; // idle 由库自动循环，睡觉不另做动作
    const now = Date.now();
    if (now - lastMoodAt < 1500) return; // 动作节流：连发消息时不抽搐
    lastMoodAt = now;
    const idx = MOOD_MOTION[mood];
    if (idx === undefined) return;
    try {
      const taps = (model.internalModel && model.internalModel.settings) ?
        ((model.internalModel.settings.motions || {})["Tap"] || []) : [];
      const real = taps.length ? idx % taps.length : -1;
      if (real >= 0) model.motion("Tap", real, 3); // priority=force，播完自动回 Idle
    } catch (e) { /* 动作缺失不影响主流程 */ }
  }

  let lastPokeAt = 0;
  function poke() { // 戳一戳/放下：随机播一个 Tap 动作（800ms 节流）
    if (!model || !active) return;
    const now = Date.now();
    if (now - lastPokeAt < 800) return;
    lastPokeAt = now;
    try {
      const taps = (model.internalModel && model.internalModel.settings) ?
        ((model.internalModel.settings.motions || {})["Tap"] || []) : [];
      if (taps.length) model.motion("Tap", Math.floor(Math.random() * taps.length), 3);
    } catch (e) { /* 忽略 */ }
  }

  window.Live2DRuntime = {
    init,
    destroy,
    setMood,
    poke,
    get active() { return active; },
    /** 供错误上报/诊断 */
    version: "v1.1"
  };
})();

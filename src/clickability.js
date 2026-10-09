"use strict";
// 双端文件（src/animation-watch.js 同先例）：Node 下单测 require，渲染层 <script> 引入时挂 window.PetClickability。
// src 按 Node 环境 lint，故显式声明 window 全局（实际使用有 typeof 守卫）。
/* global window */

/**
 * B-2 点击穿透自锁修复的纯逻辑核心。
 * 根因（实机确认）：Windows + Electron 43 + transparent 桌宠窗口下，
 * setIgnoreMouseEvents(true,{forward:true}) 不能可靠把 mousemove 转发进 renderer；
 * 一旦进入穿透，renderer 的 mousemove/500ms 兜底只剩过期 lastMouse，false 被无限重放，永久自锁。
 * 修复不变式：
 *  1) 无效坐标（<0 / 非 finite）没有改变 native 穿透状态的权限；
 *  2) 穿透期间的恢复输入源 = main 轮询系统光标 → client 坐标推送 → renderer 真实位置重判，
 *     完全不依赖 renderer 能否收到鼠标事件；
 *  3) native 写只在状态真正跃迁时发生，且缓存随新窗口重置；
 *  4) 穿透判定规则（isPetUI）保持原语义：角色/气泡/输入栏/信息版/画布实体可交互，
 *     .pet-root/背景与空白区保持穿透。
 */

/** 光标屏幕 DIP 坐标 → 窗口 content 视口（client）坐标；窗口外/非法输入返回 null。
 *  Electron screen API（getCursorScreenPoint/getContentBounds）同为 DIP 空间，渲染层 client 坐标
 *  在 zoomFactor=1 下也是同一 DIP 视口坐标：纯减法、无 devicePixelRatio/zoom 参与；
 *  多显示器负原点/非零原点由 bounds.x/y 减法天然覆盖。 */
function clientPointInContent(cursorPt, contentBounds) {
  if (!cursorPt || !contentBounds) return null;
  const x = cursorPt.x - contentBounds.x;
  const y = cursorPt.y - contentBounds.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!(x >= 0 && y >= 0 && x < contentBounds.width && y < contentBounds.height)) return null;
  return { x, y };
}

/** native 穿透状态控制器：setIgnoreMouseEvents 唯一写入口。
 *  - 同状态去抖（stale 重判不再重复触达系统）；
 *  - applied=null 表示当前窗口尚未真实写过（新窗口 reset 后首写必达，reload 不重置 native 语义）；
 *  - 进入 ignore=true 自动启动恢复哨兵（onPoll，默认 200ms），恢复可交互即停止。 */
function createNativeIgnoreController({ setIntervalFn, clearIntervalFn, pollIntervalMs = 200, onPoll } = {}) {
  let applied = null;
  let timer = null;
  function stopPolling() {
    if (timer) {
      if (clearIntervalFn) clearIntervalFn(timer);
      timer = null;
    }
  }
  return {
    get applied() { return applied; },
    isPolling() { return !!timer; },
    apply(setter, ignore) { // setter(ignore, {forward:true}) 做实际 native 写；发生跃迁返回 true
      if (applied === !!ignore) return false;
      applied = !!ignore;
      setter(applied, { forward: true });
      if (applied) {
        if (!timer && setIntervalFn && onPoll) timer = setIntervalFn(onPoll, pollIntervalMs);
      } else {
        stopPolling();
      }
      return true;
    },
    reset() { stopPolling(); applied = null; } // 新窗口：缓存必须重置，不得沿用旧窗状态
  };
}

/** isPetUI 纯判定版（pet.js 原语义 1:1）：el=elementFromPoint 命中元素，e=client 坐标，
 *  env 注入活环境读取器：{ petEl?, activeRenderMode?, busy?, walkState?, playback? }。 */
function petUiHit(el, e, env = {}) {
  if (!el) return false;
  const live2dCanvas = el.closest && el.closest("#live2d-canvas");
  if (live2dCanvas && env.live2dInteractiveAt && e) {
    return env.live2dInteractiveAt(e.clientX, e.clientY) === true;
  }
  // 精确命中：角色/气泡/输入栏/信息版/渲染画布 这些真正的可交互实体
  if (el.closest("#pet") || el.closest("#bubble") || el.closest("#input-bar") ||
      el.closest("#rig-canvas") || el.closest("#live2d-canvas") || el.closest("#info-panel")) return true;
  // 视觉实体兜底（v2.5.1 收紧版）：画布/图片元素从容器中跑出时本体即实体；
  // .pet-root 容器/空白背景不再算实体（收起对话框后整个窗口挡点击的根因修复）
  if (el.tagName === "CANVAS" || el.tagName === "IMG") return true;
  // 诊断：命中了元素但 closest 全空 → DOM 结构异常（元素被移出容器）
  if (el && e && env.playback) {
    const cp = el.closest("#pet"), cr = el.closest(".pet-root");
    if (!cp && !cr) {
      try { env.playback("[ui] closest断点 target=" + (el.id || el.tagName) + " pet祖先=无 pet-root祖先=" + (!!cr)); } catch { /* 忽略 */ }
    }
  }
  // 行走容差圈（v2.5.1）：只在 Spine 真正走动时启用；静止时不再无条件挡下层应用
  const walk = env.walkState ? env.walkState() : null;
  const petEl = env.petEl ? env.petEl() : null;
  if (e && petEl && env.activeRenderMode && env.activeRenderMode() === "spine" &&
      !(env.busy && env.busy()) && walk && walk.active && !walk.resting &&
      !walk.paused && !walk.sleeping && !walk.seated && !walk.perched) {
    try {
      const r = petEl.getBoundingClientRect();
      if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < 130) return true;
    } catch { /* 忽略 */ }
  }
  return false;
}

/** 穿透判定核心（renderer 注入活环境后使用）：拥有 lastMouse / lastSentClickable / 恢复消费。 */
function createClickabilityCore({ elementFromPoint, setClickable, isPetUI, getDragState } = {}) {
  let lastMouse = { x: -1, y: -1 };
  let lastSentClickable = null; // native 穿透状态的渲染层镜像（null=尚未发送）
  function petSetClickable(v) { // clickable 唯一出口：维护镜像，供恢复通道判断"是否已处于穿透"
    lastSentClickable = !!v;
    setClickable(!!v);
  }
  function refreshClickable(x, y) { // mousemove、500ms 兜底与 native cursor 恢复共用
    if (!(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0)) return; // 无效坐标没有改变 native 穿透状态的权限
    const el = elementFromPoint(x, y);
    const drag = getDragState ? getDragState() : null;
    petSetClickable(isPetUI(el, { clientX: x, clientY: y }) || !!(drag && drag.active));
  }
  function onRealMouseMove(x, y) {
    lastMouse = { x, y };
    refreshClickable(x, y);
  }
  function refreshFromLastMouse() {
    refreshClickable(lastMouse.x, lastMouse.y);
  }
  function onNativeCursorPush(p) { // B-2 自锁断路器：穿透期 main 轮询系统光标推来的 viewport 坐标
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (lastSentClickable === true) return; // 已非穿透态：main 哨兵应已停止，防御 in-flight 残推送
    lastMouse = { x: p.x, y: p.y }; // 系统轮询的真实位置覆盖残值坐标；兜底此后重放新位置
    refreshClickable(p.x, p.y);
  }
  return {
    get lastMouse() { return lastMouse; },
    get lastSentClickable() { return lastSentClickable; },
    setLastMouse: (x, y) => { lastMouse = { x, y }; },
    petSetClickable,
    refreshClickable,
    refreshFromLastMouse,
    onRealMouseMove,
    onNativeCursorPush,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { clientPointInContent, createNativeIgnoreController, petUiHit, createClickabilityCore };
}
if (typeof window !== "undefined") {
  window.PetClickability = { clientPointInContent, createNativeIgnoreController, petUiHit, createClickabilityCore };
}

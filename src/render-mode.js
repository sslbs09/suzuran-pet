/**
 * render-mode.js — 渲染模式（纯逻辑，2026-08-27 从 main.js 拆出，可单测）
 * - 渲染模式归一化：gif / spine / rig / live2d 四态，未知值回落 gif
 * - 模式切换贴地坐标：窗口底边对齐工作区底（+groundGap），水平钳回工作区范围
 *   （main.js「模式切换贴地」逻辑；与 walkGeo.groundLine 同族，正常窗口下等价）
 */
"use strict";

const RENDER_MODES = ["gif", "spine", "rig", "live2d"];

/** 渲染模式归一化：合法三态原样返回，其余（含未配置/未知值）回落 gif */
function renderModeOf(value) {
  return RENDER_MODES.includes(value) ? value : "gif";
}

/**
 * 模式切换贴地坐标：窗口底边与工作区底对齐、水平钳回工作区。
 * 与原 main.js 公式逐位一致（不额外加 Math.max(wa.y,…) 保护，避免行为漂移）。
 * @param {Object} bounds 窗口 {x,y,width,height}
 * @param {Object} wa 工作区 {x,y,width,height}
 * @param {number} groundGap 贴地间隙
 * @returns {{x:number, y:number}} 已四舍五入的目标窗口坐标
 */
function groundAlign(bounds, wa, groundGap) {
  const gy = wa.y + wa.height + (groundGap || 0) - bounds.height;
  const gx = Math.min(Math.max(bounds.x, wa.x), Math.max(wa.x, wa.x + wa.width - bounds.width));
  return { x: Math.round(gx), y: Math.round(gy) };
}

module.exports = { RENDER_MODES, renderModeOf, groundAlign };
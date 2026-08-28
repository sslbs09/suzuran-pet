/**
 * 行走核心（2026-08-27 从 main.js 拆出）：行走状态对象 + 相位行为决策（纯函数，可单测）。
 * 副作用（窗口移动/贴地/跳窗等）仍留在 main.js；本模块只负责"状态"与"选行为"。
 */
"use strict";

/** 返回一个全新的行走状态对象（main.js 启动时创建，后续原地修改） */
function createWalkState() {
  return {
    active: false,    // 引擎运行中（配置开关 + spine 模式才为 true）
    paused: false,    // 当前是否暂停（= dragPaused || chatPaused || zoomPaused）
    dragPaused: false, // 拖拽暂停（mousedown/松开）
    chatPaused: false, // 用户对话期间暂停（避免 busy 时动画不切 Move，Sit 被窗口带着滑行）
    zoomPaused: false, // 放大聊天框暂停（尺寸剧变会打乱行走几何，还原才恢复）
    sleeping: false,  // 渲染层睡觉状态：原地待命不移动
    face: 1,          // 视觉朝向：+1 右 / -1 左
    resting: true,    // true=原地（Relax/Sit） false=走动（Move）
    perched: false,   // 正坐在窗口顶上
    iconRest: false,  // 正坐在桌面图标上（与 perched 同用 Sit/下沉）
    seated: false,    // 坐下（任务栏上沿/桌面图标顶）：Sit 动画不移动
    groundGap: 0,     // 角色脚底到窗口底边的空隙（渲染层上报）
    charInset: 0,     // 窗口左缘到角色左缘的距离（渲染层上报）
    edgeLeft: false,  // 当前是否探出屏幕左侧（气泡需切到头顶模式）
    sunk: false,      // 当前是否处于坐姿下沉状态
    gotoPerch: false, // 正走向/爬向窗口顶
    iconTarget: false,// 本次跳的目标是桌面图标
    freeStand: false, // 桌面层级下被自由放置在桌面上（站姿待命）
    pausedAt: 0,      // 进入拖拽暂停的时刻（用于 mouseup 丢失自愈）
    returning: false, // 坐完正回到地面
    flight: null,     // 抛掷中的物理状态
    jump: null,       // 缓动跳窗状态
    perchBarrier: null, // 当前驻留的窗口屏障快照
    taskbarHang: false, // 用户拖拽到任务栏带内的半挂状态
    dir: 1,           // 漫游方向
    targetX: null,
    perchTopY: 0,
    timer: null,
    phaseTimer: null
  };
}

/**
 * 相位行为决策：idle / walk / perch（权重可注入，便于测试）。
 * 跳窗冷却 60s：刚跳下来短时间内不再跳（避免连续被窗口"吸"上去）。
 */
function behaviorOf({ now, lastPerchEnd = 0, random = Math.random, weights = { idle: 0.45, walk: 0.40, perch: 0.08 } } = {}) {
  const w = {
    idle: weights.idle,
    walk: weights.walk,
    perch: (now - lastPerchEnd < 60000) ? 0 : weights.perch,
  };
  const total = w.idle + w.walk + w.perch;
  if (!(total > 0)) return "walk";
  const r = random() * total;
  if (r < w.idle) return "idle";
  if (r < w.idle + w.walk) return "walk";
  return "perch";
}

module.exports = { createWalkState, behaviorOf };
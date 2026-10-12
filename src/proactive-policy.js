"use strict";

/**
 * proactive-policy.js — P1-U2 主动触达控制面 policy（纯函数，可单测，零依赖）。
 *
 * 硬边界（任务冻结）：PROACTIVE MESSAGE ≠ USER-CREATED REMINDER。
 *  - 主动消息（proactiveChat，legacy 键）：角色自发发起的非请求触达总闸
 *    （闲置搭话 timer、天气播报、离开/回归问候、人格化碎碎念等一切非 force 投递）。
 *  - 安静模式（quietMode）：用户手动「减少非必要主动打扰」——与专注/离开自动静默
 *    同效但由用户显式控制；只影响主动触达通道。
 *  - 桌面通知（desktopNotifications）：系统级 notification surface 总闸；
 *    角色气泡 / 聊天回复 / reminder 数据本身都不是桌面通知。
 *  - 提醒事项（user-created reminder）：独立能力，永不被上述三闸关闭——
 *    到点投递（force 路径）与数据完整性不受任何 P1-U2 开关影响。
 *
 * force 投递语义（既有网关不变）：到点提醒、用户摸头/互动回应等「用户发起的交互」
 * 走 force=true，不经主动消息/安静模式闸门。
 *
 * 兼容默认（旧 config 无新字段 = 现有行为）：
 *  proactiveChat 缺省 true（`!== false`，与 legacy 一致）
 *  desktopNotifications 缺省 true（现状：隐藏窗到点提醒必发系统通知）
 *  quietMode 缺省 false（现状：无手动安静态）
 */

/** 主动消息：角色自发触达是否允许（非 force 投递的唯一闸门）。 */
function canProactiveMessage(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (c.proactiveChat === false) return false; // 主动消息总闸（legacy proactiveChat 键）
  if (c.quietMode === true) return false;       // 安静模式：抑制非必要主动打扰
  return true;
}

/** 桌面通知：系统级通知 surface 是否允许（当前唯一生产者=到点提醒；数据/气泡不受影响）。 */
function canDesktopNotify(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  return c.desktopNotifications !== false; // 默认开 = 现状行为
}

/** 提醒投递：user-created reminder 到点处理恒可用（独立能力，永不被关闭）。
 *  保留显式签名供调用点表达边界语义，并供回归测试锁死「三闸全关 reminder 仍工作」。 */
function canReminderDeliver(cfg, reminder) {
  void cfg; void reminder;
  return true;
}

module.exports = { canProactiveMessage, canDesktopNotify, canReminderDeliver };

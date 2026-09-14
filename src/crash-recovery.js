"use strict";
// H1 修复：render-process-gone 自愈重放的窗口身份守卫（纯函数，Node 可单测）。
// 背景：崩溃恢复的 3s 延迟回调原先直接读模块级 win——
//  a) 3s 内用户退出：win 已被 'closed' 置 null → 回调同步 TypeError；
//  b) 旧窗关闭又重建：win 指向新窗 → 旧 recovery 回调错误作用于新窗口。
// 原则：回调必须携带发起恢复时刻的窗口身份（recoveryWindow），执行前三重验证：
//  窗口存活 → 仍是当前窗口 → webContents 存活；身份守卫为主，try/catch 仅作 destroy
//  竞态的最后防线（getBounds/send 可能恰在销毁边界抛错），不用大 catch 掩盖状态错误。
// 世代说明：重放读取的是 main 当前实时状态（walk.active/workArea），不携带旧世代值；
//  同一窗口连续两次 reload 的重放幂等，无需 renderer/render-mode generation guard。

/**
 * 崩溃恢复后的状态重放：向新 renderer 文档补播行走状态与贴边紧凑态。
 * @param recoveryWindow 发起 reload 时捕获的 BrowserWindow 身份（不得改用实时 win）
 * @param deps { getWindow, isWalkActive, walkBroadcast, updateUiEdgeCompact, getWorkArea }
 * @returns "replayed" | "window-gone" | "superseded-window" | "webcontents-gone" | "native-race"
 */
function replayCrashRecovery(recoveryWindow, {
  getWindow, isWalkActive, walkBroadcast, updateUiEdgeCompact, getWorkArea
} = {}) {
  if (!recoveryWindow || recoveryWindow.isDestroyed()) return "window-gone"; // 旧窗自愈中止：不重放，也不 throw
  if (getWindow() !== recoveryWindow) return "superseded-window"; // 旧 callback 绝不作用于重建后的新窗口
  const wc = recoveryWindow.webContents;
  if (!wc || wc.isDestroyed()) return "webcontents-gone";
  try { // destroy 竞态最后防线：身份守卫已全部通过，仅可能败在 native 访问瞬间
    if (isWalkActive()) walkBroadcast();
    const bounds = recoveryWindow.getBounds();
    updateUiEdgeCompact(bounds, getWorkArea(bounds));
    return "replayed";
  } catch { return "native-race"; }
}

module.exports = { replayCrashRecovery };

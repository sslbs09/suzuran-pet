/**
 * 使用条款确认窗口
 * - 同意 → pet:agree-terms（写入 agreed:true，恢复桌宠使用）
 * - 拒绝 / 关窗 → pet:refuse-terms（退出应用）
 */
"use strict";

let agreed = false; // 点过「同意」后关窗属于正常流程，不应触发拒绝退出

document.getElementById("btn-agree").addEventListener("click", async () => {
  agreed = true;
  await window.petAPI.agreeTerms();
  window.close();
});

document.getElementById("btn-refuse").addEventListener("click", () => {
  window.petAPI.refuseTerms();
});

// 关窗 = 拒绝（已同意后的正常关窗除外）
window.addEventListener("beforeunload", () => {
  if (!agreed) window.petAPI.refuseTerms();
});

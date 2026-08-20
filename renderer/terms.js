/**
 * 使用条款确认窗口
 * - 同意 → pet:agree-terms（写入 agreed:true，恢复桌宠使用）
 * - 拒绝 / 关窗 → pet:refuse-terms（退出应用）
 */
"use strict";

document.getElementById("btn-agree").addEventListener("click", async () => {
  await window.petAPI.agreeTerms();
  window.close();
});

document.getElementById("btn-refuse").addEventListener("click", () => {
  window.petAPI.refuseTerms();
});

// 关窗 = 拒绝
window.addEventListener("beforeunload", () => {
  window.petAPI.refuseTerms();
});

/**
 * 使用条款确认窗口
 * - 同意 → pet:agree-terms（主进程先确认写入 agreed:true，再恢复桌宠使用）
 * - 拒绝 / 关窗 → pet:refuse-terms（退出应用）
 */
"use strict";

let agreed = false; // 点过「同意」后关窗属于正常流程，不应触发拒绝退出
let accepting = false;
const agreeButton = document.getElementById("btn-agree");
const hint = document.querySelector(".hint");

/* Phase 4-B1：foot hint 唯一 owner = 本脚本。初始文案经 I18N 本地化；locale 变化时
 * 仅在无失败状态时重绘普通说明（失败文本是 runtime state，不被语言切换抹掉）。
 * result.message 为 main 侧已翻译文案，此处不做二次翻译（B1 错误边界）。 */
let hintFailure = false;
function renderTermsHint() {
  if (!hint || hintFailure) return;
  const t = (key) => (window.I18N && I18N.t(key)) || key;
  hint.textContent = t("page.terms.footHint");
}
renderTermsHint();
if (window.I18N && window.I18N.onChange) window.I18N.onChange(renderTermsHint);

agreeButton.addEventListener("click", async () => {
  if (accepting) return;
  accepting = true;
  agreeButton.disabled = true;
  try {
    const result = await window.petAPI.agreeTerms();
    if (result && result.accepted === true && result.runtimeFailed === true) {
      agreed = true;
      if (hint) { hintFailure = true; hint.textContent = result.message || "已记录同意，但桌宠启动失败，请重启应用"; }
      return; // 保持按钮禁用，不重试部分初始化的 runtime。
    }
    if (result !== true && (!result || result.ok !== true)) {
      throw new Error("consent save failed");
    }
    agreed = true;
    window.close();
  } catch {
    accepting = false;
    agreeButton.disabled = false;
    if (hint) { hintFailure = true; hint.textContent = "保存同意状态失败，请重试"; }
  }
});

document.getElementById("btn-refuse").addEventListener("click", () => {
  window.petAPI.refuseTerms();
});

// 关窗 = 拒绝（已同意后的正常关窗除外）
window.addEventListener("beforeunload", () => {
  if (!agreed && !accepting) window.petAPI.refuseTerms();
});

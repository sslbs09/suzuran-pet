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

const t = (key) => (window.I18N && window.I18N.t(key)) || key;

/* Phase 5-E1：条款页错误呈现与全应用同构（code/meta → ErrorPresenter → I18N → DOM）。
 * 修复前这里把主进程 result.message 直接写进 DOM，绕过 presenter 与 i18n——这是
 * 5-C/5-D 之后唯一仍在漏斗外的错误面。
 * 无 code 时落 err.unknown 而不是回显 message：那正是本阶段要消灭的路径；
 * 主进程 pet:agree-terms 已补 code，所以正常链路永远走 presenter 分支。 */
const presentError = (result) => {
  if (result && Object.prototype.hasOwnProperty.call(result, "code")) {
    const p = window.ErrorPresenter.toPresentation({ code: result.code, meta: result.meta });
    return window.I18N.t(p.key, p.params);
  }
  return window.I18N.t("err.unknown");
};

/* foot hint 唯一 owner = 本脚本。失败态存「来源」而非已渲染文本/布尔，
 * 这样 locale 切换时失败提示也跟着重本地化（修复前 hintFailure=true 会把
 * 失败文本永久冻结在旧语言）。零业务副作用、不发任何 IPC。
 *   { key }    —— 本域已知状态，直接查 catalog
 *   { result } —— 未知错误，保留原始结果供 presenter 重新呈现 */
let hintFailure = null;
function renderTermsHint() {
  if (!hint) return;
  if (!hintFailure) { hint.textContent = t("page.terms.footHint"); return; }
  hint.textContent = hintFailure.key !== undefined ? t(hintFailure.key) : presentError(hintFailure.result);
}
renderTermsHint();
if (window.I18N && window.I18N.onChange) window.I18N.onChange(renderTermsHint);

function showFailure(failure) {
  hintFailure = failure;
  renderTermsHint();
}

agreeButton.addEventListener("click", async () => {
  if (accepting) return;
  accepting = true;
  agreeButton.disabled = true;
  try {
    const result = await window.petAPI.agreeTerms();
    if (result && result.accepted === true && result.runtimeFailed === true) {
      agreed = true;
      showFailure({ key: "page.terms.runtimeFailedHint" }); // 保持按钮禁用，不重试部分初始化的 runtime。
      return;
    }
    if (result !== true && (!result || result.ok !== true)) {
      accepting = false;
      agreeButton.disabled = false; // 保存失败/未知失败：允许重试（runtime 失败才禁止）
      showFailure({ result }); // 主进程已带 code → presenter；绝不回显 result.message
      return;
    }
    agreed = true;
    window.close();
  } catch {
    accepting = false;
    agreeButton.disabled = false;
    showFailure({ result: { code: "INTERNAL" } }); // 传输层异常：归 INTERNAL，不泄漏异常文本
  }
});

document.getElementById("btn-refuse").addEventListener("click", () => {
  window.petAPI.refuseTerms();
});

// 关窗 = 拒绝（已同意后的正常关窗除外）
window.addEventListener("beforeunload", () => {
  if (!agreed && !accepting) window.petAPI.refuseTerms();
});
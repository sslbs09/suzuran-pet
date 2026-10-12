"use strict";
/* observation.js — 「记住这次经历」确认窗口（SHARED EXPERIENCE CONFIRMATION v0.1）。
 * 入口语义（本轮收紧）：只受理用户与当前角色真实共同经历过、并在提交前明确
 * 勾选确认要保留的事件。渲染层持有：输入文本 + 确认勾选 + 最近一次结果的 key
 * （随语言重投影）。未勾选确认时本地拦截——不发起 IPC、不铸造提交标识。
 * actionId / 集成动作封装 / 传输重试身份全部在主进程（main.js + src/whitemoon-ingress.js），
 * production path 不变：petAPI.submitObservation → POST /integration-input。
 * 提交失败一律不清空输入；只有确认成功（recorded/duplicate）才清空输入与勾选。 */
const $ = (id) => document.getElementById(id);
const t = (key, params) => (window.I18N && window.I18N.t(key, params)) || key;

let lastResult = null; // { key, params? } —— 保留来源以便 locale 变化重投影
let submitting = false;

function renderResult() {
  const el = $("result");
  if (!lastResult) { el.textContent = ""; return; }
  el.textContent = t(lastResult.key, lastResult.params);
}

function setState(state, detail) {
  const map = {
    recorded: { key: "page.observation.ok" },
    duplicate: { key: "page.observation.okDuplicate" },
    needConfirm: { key: "page.observation.needConfirm" },
    invalidEmpty: { key: "page.observation.invalidEmpty" },
    invalid: { key: "page.observation.invalid" },
    conflict: { key: "page.observation.conflict" },
    unavailable: { key: "page.observation.unavailable" },
    unknown: { key: "page.observation.unknown" },
    failed: { key: "page.observation.failed", params: detail ? { reason: detail } : undefined },
    disabled: { key: "page.observation.disabled" },
    busy: { key: "page.observation.busy" }
  };
  lastResult = map[state] || { key: "page.observation.failed" };
  renderResult();
}

function setSubmitting(on) {
  submitting = on;
  $("submit").disabled = on;
  if (on) { lastResult = { key: "page.observation.submitting" }; renderResult(); }
  else renderResult();
}

/* preview：如实回显将被保存的文本（与主进程一致做首尾 trim），不提供第二套编辑。 */
function renderPreview() {
  const text = $("note").value.trim();
  $("preview-text").textContent = text ? `“${text}”` : "";
}
$("note").addEventListener("input", renderPreview);

$("submit").onclick = async () => {
  if (submitting) return;
  const note = $("note").value;
  if (!note.trim()) { setState("invalidEmpty"); return; } // 本地拦截：不发起提交、不铸造标识
  if (!$("confirm").checked) { setState("needConfirm"); return; } // 确认 gate：未确认不得提交（本地拦截）
  setSubmitting(true);
  let outcome;
  try {
    outcome = await window.petAPI.submitObservation(note);
  } catch (err) {
    outcome = { state: "failed", error: String((err && err.message) || err) };
  }
  setSubmitting(false);
  const state = (outcome && outcome.state) || "unknown";
  if (state === "recorded" || state === "duplicate") {
    $("note").value = ""; // 确认成功才清空输入
    $("confirm").checked = false; // 每段经历都需要一次全新的明确确认
    renderPreview();
  }
  setState(state, outcome && outcome.error);
};

/* locale 变化：只重投影 presentation（零 IPC、零业务动作） */
if (window.I18N && window.I18N.onChange) window.I18N.onChange(renderResult);

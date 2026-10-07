"use strict";
/* observation.js — 记录观察窗口（Phase 11-E.1）。
 * 渲染层只持有：输入框里的文本 + 最近一次结果的 key（随语言重投影）。
 * actionId / 集成动作封装 / 传输重试身份全部在主进程（main.js + src/whitemoon-ingress.js）。
 * 提交失败一律不清空输入；只有确认成功（recorded/duplicate）才清空。 */
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

$("submit").onclick = async () => {
  if (submitting) return;
  const note = $("note").value;
  if (!note.trim()) { setState("invalidEmpty"); return; } // 本地拦截：不发起提交、不铸造标识
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
  }
  setState(state, outcome && outcome.error);
};

/* locale 变化：只重投影 presentation（零 IPC、零业务动作） */
if (window.I18N && window.I18N.onChange) window.I18N.onChange(renderResult);

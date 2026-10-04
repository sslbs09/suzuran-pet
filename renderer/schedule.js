"use strict";
const $ = (id) => document.getElementById(id);
const t = (key, params) => (window.I18N && window.I18N.t(key, params)) || key;
const presentError = (result) => window.ErrorPresent.presentError(result); // Phase 5-G2：统一适配器
function fmt(s) { return s.display ? `${s.display.date} ${s.display.time}` : s.status; }

/* Phase 5-E3：运行时文本与其数据源分离。
 * 数据只进 state（lastItems / lastPreview / lastResult），DOM 一律由 renderXxx() 从 state 投影。
 * locale 变化时只重跑投影——不重新请求 IPC、不重新导入、不重建业务状态。 */
let lastItems = null;
let lastPreview = null;
let lastResult = null; // { key, params? } 或 { error } —— 保留来源以便随 locale 重新呈现
let previewOnConfirm = null;

function renderSummary() {
  if (!lastItems) return;
  $("summary").textContent = t("page.schedule.summary", {
    n: lastItems.length,
    p: lastItems.filter(x => x.status === "pending").length
  });
}
function renderList() {
  if (!lastItems) return;
  $("list").replaceChildren(...lastItems.map((s) => {
    const el = document.createElement("div"); el.className = "schedule-item";
    const meta = document.createElement("div"); meta.className = "meta";
    meta.innerHTML = `<div class="title"></div><div class="time"></div>`;
    meta.querySelector(".title").textContent = s.title;
    meta.querySelector(".time").textContent = `${fmt(s)} · ${s.recurrence} · ${s.source?.type || "manual"}`;
    const actions = document.createElement("div"); actions.className = "actions";
    const buttons = [
      [t("page.schedule.btnDone"), () => window.petAPI.completeSchedule(s.id)],
      [t("page.schedule.btnSnooze"), () => window.petAPI.snoozeSchedule(s.id, 10)],
      [t("page.schedule.cancel"), () => window.petAPI.cancelSchedule(s.id)]
    ];
    for (const [label, fn] of buttons) { const b = document.createElement("button"); b.textContent = label; b.onclick = async () => { await fn(); refresh(); }; actions.appendChild(b); }
    el.append(meta, actions); return el;
  }));
}
function renderResult() {
  if (!lastResult) return;
  $("result").textContent = lastResult.error !== undefined ? presentError(lastResult.error) : t(lastResult.key, lastResult.params);
}
function renderPreview() {
  if (!lastPreview) return;
  const p = lastPreview;
  $("preview-meta").textContent = t("page.schedule.previewMeta", { file: p.fileName, total: p.total, n: p.rows.length });
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = ["page.schedule.colRow", "page.schedule.labelTitle", "page.schedule.labelDate",
    "page.schedule.labelTime", "page.schedule.labelRecurrence", "page.schedule.labelEmotion", "page.schedule.labelNotes"];
  for (const key of headers) { const th = document.createElement("th"); th.textContent = t(key); headRow.appendChild(th); }
  thead.appendChild(headRow); table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const r of p.rows) {
    const row = document.createElement("tr");
    for (const v of [r.row, r.title, r.date, r.time, r.recurrence, r.emotion, r.notes]) { const td = document.createElement("td"); td.textContent = v; row.appendChild(td); }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  $("preview-rows").replaceChildren(table);
  $("preview-confirm").onclick = () => { hideImportPreview(); previewOnConfirm && previewOnConfirm(); };
  $("preview-cancel").onclick = hideImportPreview;
}
/* locale 变化：只从既有 state 重投影。不触碰 petAPI、不重建 dialog 焦点状态。 */
function renderAll() { renderSummary(); renderList(); renderResult(); renderPreview(); }

async function refresh() {
  const items = await window.petAPI.getSchedules();
  lastItems = items;
  renderSummary();
  renderList();
}
$("add").onclick = async () => { const r = await window.petAPI.addSchedule({ title: $("title").value, date: $("date").value, time: $("time").value, recurrence: $("recurrence").value, emotion: $("emotion").value, notes: $("notes").value }); lastResult = r.ok ? { key: "page.schedule.added" } : { error: r }; renderResult(); if (r.ok) { $("title").value = ""; $("notes").value = ""; refresh(); } };
$("import").onclick = async () => {
  const file = await window.petAPI.pickScheduleWorkbook();
  if (!file) return;
  const p = await window.petAPI.previewScheduleWorkbook(file);
  if (!p.ok) { lastResult = { error: p }; renderResult(); return; }
  showImportPreview(p, async () => {
    const r = await window.petAPI.importScheduleWorkbook(file);
    lastResult = r.ok ? { key: "page.schedule.importedCount", params: { n: r.count } } : { error: r };
    renderResult();
    if (r.ok) refresh();
  });
};
function showImportPreview(p, onConfirm) {
  lastPreview = p;
  previewOnConfirm = onConfirm;
  renderPreview();
  previewReturnFocus = document.activeElement;
  $("import-preview").classList.remove("hidden");
  $("preview-cancel").focus(); // 焦点进入弹窗（取消为安全默认）
}
function hideImportPreview() {
  $("import-preview").classList.add("hidden");
  if (previewReturnFocus && previewReturnFocus.focus) previewReturnFocus.focus(); // 焦点回还（backlog-a11y）
  previewReturnFocus = null;
}
let previewReturnFocus = null;
/* 弹窗可访问性（backlog-a11y）：Tab 焦点圈定弹窗内 + Esc 关闭 */
$("import-preview").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideImportPreview(); return; }
  if (e.key !== "Tab") return;
  const items = [...$("import-preview").querySelectorAll("button")].filter((b) => !b.disabled);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
$("template").onclick = async () => { const ok = await window.petAPI.exportScheduleTemplate(); lastResult = { key: ok ? "page.schedule.templateSaved" : "page.schedule.templateCancelled" }; renderResult(); };
window.petAPI.onScheduleDue(() => refresh());

/* Phase 5-E3：locale 变化经 I18N.onChange 从既有 state 重投影（零 IPC / 零业务动作） */
if (window.I18N && window.I18N.onChange) window.I18N.onChange(renderAll);

const now = new Date(); $("date").value = now.toISOString().slice(0, 10); $("time").value = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()+1).padStart(2,"0")}`; refresh();
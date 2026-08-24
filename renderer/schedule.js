"use strict";
const $ = (id) => document.getElementById(id);
function fmt(s) { return s.display ? `${s.display.date} ${s.display.time}` : s.status; }
async function refresh() {
  const items = await window.petAPI.getSchedules();
  $("summary").textContent = `共 ${items.length} 条日程，待触发 ${items.filter(x => x.status === "pending").length} 条`;
  $("list").replaceChildren(...items.map((s) => {
    const el = document.createElement("div"); el.className = "schedule-item";
    const meta = document.createElement("div"); meta.className = "meta";
    meta.innerHTML = `<div class="title"></div><div class="time"></div>`;
    meta.querySelector(".title").textContent = s.title;
    meta.querySelector(".time").textContent = `${fmt(s)} · ${s.recurrence} · ${s.source?.type || "manual"}`;
    const actions = document.createElement("div"); actions.className = "actions";
    for (const [label, fn] of [["完成", () => window.petAPI.completeSchedule(s.id)], ["稍后10分", () => window.petAPI.snoozeSchedule(s.id, 10)], ["取消", () => window.petAPI.cancelSchedule(s.id)]]) { const b = document.createElement("button"); b.textContent = label; b.onclick = async () => { await fn(); refresh(); }; actions.appendChild(b); }
    el.append(meta, actions); return el;
  }));
}
$("add").onclick = async () => { const r = await window.petAPI.addSchedule({ title: $("title").value, date: $("date").value, time: $("time").value, recurrence: $("recurrence").value, emotion: $("emotion").value, notes: $("notes").value }); $("result").textContent = r.ok ? "已添加" : r.error; if (r.ok) { $("title").value = ""; $("notes").value = ""; refresh(); } };
$("import").onclick = async () => { const file = await window.petAPI.pickScheduleWorkbook(); if (!file) return; const r = await window.petAPI.importScheduleWorkbook(file); $("import-result").textContent = r.ok ? `已导入 ${r.count} 条日程` : r.error; if (r.ok) refresh(); };
$("template").onclick = async () => { const ok = await window.petAPI.exportScheduleTemplate(); $("import-result").textContent = ok ? "模板已保存" : "已取消"; };
window.petAPI.onScheduleDue(() => refresh());
const now = new Date(); $("date").value = now.toISOString().slice(0, 10); $("time").value = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()+1).padStart(2,"0")}`; refresh();

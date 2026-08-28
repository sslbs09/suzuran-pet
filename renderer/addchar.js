/* 添加人物窗口（v2.5.7）：文件夹导入 Spine 模型 */
"use strict";

const btn = document.getElementById("btn-import");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("model-list");

async function renderList() {
  try {
    const r = await window.petAPI.getSpineModels();
    if (!r || !Array.isArray(r.list) || !r.list.length) { listEl.textContent = "（仅内置苏苏洛）"; return; }
    listEl.innerHTML = "";
    r.list.forEach((m) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:2px 0;";
      const name = document.createElement("span");
      name.textContent = m.name;
      if (m.id === r.current) { name.classList.add("cur"); name.textContent += "（当前）"; }
      const id = document.createElement("span");
      id.textContent = m.id;
      id.style.cssText = "color:var(--ui-muted,#888);font-size:12px;";
      row.appendChild(name);
      row.appendChild(id);
      listEl.appendChild(row);
    });
  } catch { listEl.textContent = "读取失败"; }
}

if (btn) {
  btn.addEventListener("click", async () => {
    statusEl.textContent = "请选择包含 .atlas / .skel/.json / .png 的文件夹…";
    try {
      const r = await window.petAPI.importSpine();
      if (r && r.ok) {
        statusEl.textContent = "✅ 已导入「" + r.name + "」并切换（" + r.id + "）";
        renderList();
      } else {
        statusEl.textContent = "❌ " + ((r && r.error) || "导入失败");
      }
    } catch (e) {
      statusEl.textContent = "❌ " + (e && e.message || e);
    }
  });
}

renderList();
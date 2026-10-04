/* 添加人物窗口（v2.5.7）：文件夹导入 Spine 模型 */
"use strict";

const btn = document.getElementById("btn-import");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("model-list");
const t = (key, params) => (window.I18N && window.I18N.t(key, params)) || key;
const presentError = (result) => {
  if (result && Object.prototype.hasOwnProperty.call(result, "code")) {
    const p = window.ErrorPresenter.toPresentation({ code: result.code, meta: result.meta });
    return window.I18N.t(p.key, p.params);
  }
  return result && typeof result.error === "string" && result.error ? result.error : window.I18N.t("err.unknown");
};

/* Phase 5-E3：列表快照与状态文案进 state，DOM 由 render*() 纯投影。
 * locale 变化只重跑投影——不重新调用 petAPI、不重建业务状态。 */
let lastList = null;
let lastStatus = null; // { key, params? } 或 { error }

function renderList() {
  if (!lastList) return;
  if (!lastList.list || !lastList.list.length) { listEl.textContent = t("page.addchar.builtinOnly"); return; }
  listEl.innerHTML = "";
  lastList.list.forEach((m) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:2px 0;";
    const name = document.createElement("span");
    name.textContent = m.name;
    if (m.id === lastList.current) { name.classList.add("cur"); name.textContent += t("page.addchar.currentTag"); }
    const id = document.createElement("span");
    id.textContent = m.id;
    id.style.cssText = "color:var(--ui-muted,#888);font-size:12px;";
    row.appendChild(name);
    row.appendChild(id);
    listEl.appendChild(row);
  });
}
function renderStatus() {
  if (!lastStatus) return;
  statusEl.textContent = lastStatus.error !== undefined
    ? "❌ " + presentError(lastStatus.error)
    : t(lastStatus.key, lastStatus.params);
}

async function loadList() {
  try {
    lastList = await window.petAPI.getSpineModels();
    renderList();
  } catch {
    lastList = { list: [] };
    listEl.textContent = t("page.addchar.loadFail");
  }
}

if (btn) {
  btn.addEventListener("click", async () => {
    lastStatus = { key: "page.addchar.pickHint" };
    renderStatus();
    try {
      const r = await window.petAPI.importSpine();
      if (r && r.ok) {
        lastStatus = { key: "page.addchar.imported", params: { name: r.name, id: r.id } };
        renderStatus();
        loadList();
      } else {
        lastStatus = { error: r };
        renderStatus();
      }
    } catch {
      lastStatus = { error: { code: "INTERNAL" } };
      renderStatus();
    }
  });
}

/* Phase 5-E3：locale 变化经 I18N.onChange 从既有 state 重投影（零 IPC / 零业务动作） */
if (window.I18N && window.I18N.onChange) window.I18N.onChange(() => { renderList(); renderStatus(); });

loadList();
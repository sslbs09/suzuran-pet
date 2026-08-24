/**
 * 表情管理窗口逻辑（动态情绪表 + 名字/用途可编辑）
 * - pet:get-moods → 渲染每个情绪的卡片（名字输入框 + 预览 + 用途切换 + 选择GIF + 恢复默认）
 * - pet:rename-mood：改名字（用途），GIF 不动，≤5 字
 * - pet:set-mood-type：待机 ↔ 情绪 用途切换
 * - pet:add-mood / pet:remove-mood：自定义情绪（≤5 字，共 ≤30）
 */
"use strict";

const grid = document.getElementById("mood-grid");
let moods = [];

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}
function cardHTML(m) {
  const safeName = escapeHtml(m.name);
  const safeLabel = escapeHtml(m.label);
  const src = "pet-user://sprites/user/" + encodeURIComponent(m.name) + ".gif?t=" + Date.now();
  const tag = m.custom
    ? '<span class="tag" style="background:#fff4e5;color:#b57a24;">自定义</span>'
    : m.emotion
      ? '<span class="tag">情绪</span>'
      : '<span class="tag">待机</span>';
  return `
  <div class="mood-card" data-name="${safeName}">
    <div class="name-row">
      <input class="label-input" maxlength="5" value="${safeLabel}" title="点击修改名字（用途）" />
      <button class="btn-rename" title="保存新名字">改名</button>
    </div>
    <div>${tag}${m.exists ? "" : '<span class="tag-new">未设置GIF</span>'}</div>
    <div class="mood-preview ${m.exists ? "" : "empty"}">
      ${m.exists ? `<img src="${src}" alt="${safeLabel}" />` : ""}
    </div>
    <div class="mood-file">${safeName}.gif${m.size ? " · " + Math.round(m.size / 1024) + " KB" : ""}</div>
    <div class="actions">
      <button class="btn-type">${m.emotion ? "设为待机" : "设为情绪"}</button>
      <button class="btn-pick primary">选择 GIF</button>
      <button class="btn-reset">恢复默认</button>
      ${'<button class="btn-del danger">删除</button>'}
    </div>
  </div>`;
}

function render() {
  grid.innerHTML = moods.map(cardHTML).join("");
  document.getElementById("dir-hint").textContent =
    "共 " + moods.length + " / 30 个 · 待机 " + moods.filter((m) => !m.emotion).length + " 个 · 情绪 " + moods.filter((m) => m.emotion).length + " 个" +
    (moods.length >= 30 ? "（已满，需先删除再添加）" : " · 点名字可直接改名，GIF 不会变");
}

async function refresh() {
  const r = await window.petAPI.getMoods();
  if (r && r.moods) moods = r.moods;
  render();
}

function setMsg(text, ok) {
  const el = document.getElementById("add-result");
  el.textContent = text || "";
  el.className = "result" + (ok ? " ok" : ok === false ? " err" : "");
}

grid.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const card = e.target.closest(".mood-card");
  if (!card) return;
  const name = card.dataset.name;
  const input = card.querySelector(".label-input");
  const m = moods.find((x) => x.name === name);

  if (btn.classList.contains("btn-rename")) {
    const r = await window.petAPI.renameMood({ name, newLabel: input.value });
    setMsg(r.message, r.ok);
    await refresh();
  } else if (btn.classList.contains("btn-type")) {
    const r = await window.petAPI.setMoodType({ name, emotion: !m.emotion });
    setMsg(r.message, r.ok);
    await refresh();
  } else if (btn.classList.contains("btn-pick")) {
    const path = await window.petAPI.pickGif();
    if (!path) return;
    const r = await window.petAPI.applyGif({ name, filePath: path });
    if (r.ok) await refresh();
    else setMsg("应用失败：" + r.message, false);
  } else if (btn.classList.contains("btn-reset")) {
    const r = await window.petAPI.resetGif(name);
    if (r.ok) await refresh();
    else setMsg("恢复失败：" + r.message, false);
  } else if (btn.classList.contains("btn-del")) {
    if (!confirm("确定删除情绪「" + (m ? m.label : name) + "」？它的 GIF 也会被移除。")) return;
    const r = await window.petAPI.removeMood(name);
    if (r.ok) await refresh();
    else setMsg("删除失败：" + r.message, false);
  }
});

// 输入框回车 = 改名
grid.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("label-input")) {
    const btn = e.target.closest(".mood-card").querySelector(".btn-rename");
    if (btn) btn.click();
  }
});

document.getElementById("btn-add-mood").addEventListener("click", async () => {
  const input = document.getElementById("new-mood");
  const label = input.value.trim();
  if (!label) { setMsg("情绪词不能为空", false); return; }
  const r = await window.petAPI.addMood(label);
  setMsg(r.message, r.ok);
  if (r.ok) {
    input.value = "";
    await refresh();
  }
});
document.getElementById("new-mood").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-add-mood").click();
});

refresh();

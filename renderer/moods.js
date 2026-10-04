/**
 * 表情管理窗口逻辑（动态情绪表 + 名字/用途可编辑）
 * - pet:get-moods → 渲染每个情绪的卡片（名字输入框 + 预览 + 用途切换 + 选择GIF + 恢复默认）
 * - pet:rename-mood：改名字（用途），GIF 不动，≤5 字
 * - pet:set-mood-type：待机 ↔ 情绪 用途切换
 * - pet:add-mood / pet:remove-mood：自定义情绪（≤5 字，共 ≤30）
 * Phase 4-B2.1：动态产品文案走 I18N.t(key, params)；情绪名/label/GIF 文件名=用户数据原样展示；
 * 成功 message 保留透传；失败经既有 presenter（无 code 保留兼容文案）。render() 为 moods 数组的纯投影，
 * locale 变化经 I18N.onChange 重放（dir-hint 与卡片文案同时更新，无业务副作用）。
 */
"use strict";

const grid = document.getElementById("mood-grid");
let moods = [];

const L = (key, params) => (window.I18N && I18N.t(key, params)) || key;
const presentError = (result) => window.ErrorPresent.presentError(result); // Phase 5-G2：统一适配器

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}
function cardHTML(m) {
  const safeName = escapeHtml(m.name);
  const safeLabel = escapeHtml(m.label);
  const src = "pet-user://sprites/user/" + encodeURIComponent(m.name) + ".gif?t=" + Date.now();
  const tag = m.custom
    ? `<span class="tag tag-custom">${L("page.moods.tagCustom")}</span>`
    : m.emotion
      ? `<span class="tag">${L("page.moods.tagEmotion")}</span>`
      : `<span class="tag">${L("page.moods.tagIdle")}</span>`;
  return `
  <div class="mood-card" data-name="${safeName}">
    <div class="name-row">
      <input class="label-input" maxlength="5" value="${safeLabel}" title="${L("page.moods.renameTip")}" />
      <button class="btn-rename" title="${L("page.moods.renameSave")}">${L("page.moods.renameBtn")}</button>
    </div>
    <div>${tag}${m.exists ? "" : `<span class="tag-new">${L("page.moods.tagNoGif")}</span>`}</div>
    <div class="mood-preview ${m.exists ? "" : "empty"}">
      ${m.exists ? `<img src="${src}" alt="${safeLabel}" />` : ""}
    </div>
    <div class="mood-file">${safeName}.gif${m.size ? " · " + Math.round(m.size / 1024) + " KB" : ""}</div>
    <div class="actions">
      <button class="btn-type">${m.emotion ? L("page.moods.setIdle") : L("page.moods.setEmotion")}</button>
      <button class="btn-pick primary">${L("page.moods.pickGif")}</button>
      <button class="btn-reset">${L("page.moods.restoreDefault")}</button>
      ${`<button class="btn-del danger">${L("page.moods.delBtn")}</button>`}
    </div>
  </div>`;
}

function render() {
  grid.innerHTML = moods.map(cardHTML).join("");
  document.getElementById("dir-hint").textContent =
    L("page.moods.count", { n: moods.length, idle: moods.filter((m) => !m.emotion).length, e: moods.filter((m) => m.emotion).length }) +
    (moods.length >= 30 ? L("page.moods.countFull") : L("page.moods.countHint"));
}

async function fetchAndRenderMoods() {
  const r = await window.petAPI.getMoods();
  if (r && r.moods) moods = r.moods;
  render();
}

function setMsg(text, ok) {
  const el = document.getElementById("add-result");
  el.textContent = text || "";
  el.className = "result" + (ok ? " ok" : ok === false ? " err" : "");
}
function setResultMessage(result) {
  setMsg(result && result.ok ? result.message : presentError(result), result && result.ok);
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
    setResultMessage(r);
    await fetchAndRenderMoods();
  } else if (btn.classList.contains("btn-type")) {
    const r = await window.petAPI.setMoodType({ name, emotion: !m.emotion });
    setResultMessage(r);
    await fetchAndRenderMoods();
  } else if (btn.classList.contains("btn-pick")) {
    const path = await window.petAPI.pickGif();
    if (!path) return;
    const r = await window.petAPI.applyGif({ name, filePath: path });
    if (r.ok) await fetchAndRenderMoods();
    else setMsg(L("page.moods.applyFailed", { error: presentError(r) }), false);
  } else if (btn.classList.contains("btn-reset")) {
    const r = await window.petAPI.resetGif(name);
    if (r.ok) await fetchAndRenderMoods();
    else setMsg(L("page.moods.restoreFailed", { error: presentError(r) }), false);
  } else if (btn.classList.contains("btn-del")) {
    if (!confirm(L("page.moods.confirmDelete", { name: m ? m.label : name }))) return;
    const r = await window.petAPI.removeMood(name);
    if (r.ok) await fetchAndRenderMoods();
    else setMsg(L("page.moods.deleteFailed", { error: presentError(r) }), false);
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
  if (!label) { setMsg(L("page.moods.emptyWord"), false); return; }
  const r = await window.petAPI.addMood(label);
  setResultMessage(r);
  if (r.ok) {
    input.value = "";
    await fetchAndRenderMoods();
  }
});
document.getElementById("new-mood").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-add-mood").click();
});

/* Phase 4-B2.1：locale 变化 → render() 纯重投影（moods 数组为唯一 state，零业务请求） */
if (window.I18N && window.I18N.onChange) window.I18N.onChange(render);

fetchAndRenderMoods();

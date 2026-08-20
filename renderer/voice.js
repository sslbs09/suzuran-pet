/**
 * 音色克隆与训练窗口逻辑
 * - 检查 Genie 部署状态（pet:voice-status）
 * - 选择参考音频（pet:pick-file）
 * - 试听（pet:previewVoice：指定参考音频直接合成）
 * - 应用音色（pet:applyVoice：热切换服务器默认参考音频 + 持久化）
 */
"use strict";

const $ = (id) => document.getElementById(id);
let selectedPath = "";
let deployed = false;

function setResult(text, ok) {
  const el = $("result");
  el.textContent = text || "";
  el.className = "result" + (ok ? " ok" : ok === false ? " err" : "");
}

async function refreshStatus() {
  const s = await window.petAPI.voiceStatus();
  const card = $("status-card");
  deployed = s.deployed;
  if (!s.deployed) {
    card.className = "status-card no";
    card.textContent = "⚠ 本地 Genie 语音尚未部署 —— 打开「语音部署与训练指南」完成部署后再回来克隆音色";
    $("clone-form").classList.add("disabled");
    $("not-deployed").style.display = "block";
  } else if (s.ready) {
    card.className = "status-card ok";
    card.textContent = "✅ Genie 语音已就绪（角色: " + (s.character || "sussurro") + "）—— 可以直接克隆音色";
    $("clone-form").classList.remove("disabled");
    $("not-deployed").style.display = "none";
  } else {
    card.className = "status-card no";
    card.textContent = "⚠ Genie 已部署但服务器未就绪：" + (s.fail || "未知") + "（可能需要等待模型加载，或看服务器日志）";
    $("clone-form").classList.add("disabled");
    $("not-deployed").style.display = "block";
  }
}

$("btn-pick").addEventListener("click", async () => {
  const p = await window.petAPI.pickFile();
  if (!p) return;
  selectedPath = p;
  $("file-path").textContent = p;
  setResult("");
});

$("btn-preview").addEventListener("click", async () => {
  const text = $("preview-text").value.trim();
  if (!selectedPath) { setResult("请先选择参考音频文件", false); return; }
  if (!text) { setResult("试听内容为空", false); return; }
  setResult("正在合成试听…");
  const r = await window.petAPI.previewVoice({
    text,
    refAudio: selectedPath,
    refText: $("ref-text").value.trim()
  });
  if (!r.ok) { setResult("试听失败：" + r.message, false); return; }
  try {
    const audio = new Audio("data:audio/wav;base64," + r.b64);
    audio.volume = 1;
    await audio.play();
    setResult("▶ 正在播放试听…", true);
    audio.onended = () => setResult("试听播放完成 ✅", true);
  } catch (e) {
    setResult("播放失败: " + String(e.message || e), false);
  }
});

$("btn-apply").addEventListener("click", async () => {
  if (!selectedPath) { setResult("请先选择参考音频文件", false); return; }
  setResult("正在应用音色…");
  const r = await window.petAPI.applyVoice({
    audioPath: selectedPath,
    text: $("ref-text").value.trim()
  });
  setResult(r.ok ? r.message : "应用失败：" + r.message, r.ok);
  if (r.ok) refreshStatus();
});

$("btn-guide").addEventListener("click", () => {
  window.petAPI.openTtsGuide("训练指南.html");
});

$("btn-overview").addEventListener("click", () => {
  window.petAPI.openTtsGuide("总览.html");
});

refreshStatus();

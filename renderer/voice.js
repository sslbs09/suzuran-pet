/**
 * 音色克隆与训练窗口逻辑
 * - 检查 Genie 部署状态（pet:voice-status）
 * - 选择参考音频（pet:pick-file）
 * - 试听（pet:previewVoice：指定参考音频直接合成）
 * - 应用音色（pet:applyVoice：热切换服务器默认参考音频 + 持久化）
 * Phase 4-B2.1：状态卡 = _voiceStatus 快照的纯投影（renderStatus），locale 变化经
 * I18N.onChange 重放且保留真实服务状态；已选路径与示例路径=DATA 原样；
 * 成功/失败 message 为 main 侧已翻译文本，透传不二次翻译；文件名参数（训练指南.html 等）
 * 为技术标识不迁移。
 */
"use strict";

const $ = (id) => document.getElementById(id);
const L = (key, params) => (window.I18N && I18N.t(key, params)) || key;

const SAMPLE_REF_PATH = "语音部署与训练指南\\example_audio\\ref_sussurro.wav"; // DATA：文档内固定路径标识，不翻译
let selectedPath = "";
let deployed = false;
let _voiceStatus = null; // 状态快照：renderStatus 的唯一 state 来源

function setResult(text, ok) {
  const el = $("result");
  el.textContent = text || "";
  el.className = "result" + (ok ? " ok" : ok === false ? " err" : "");
}

function renderFilePath() {
  $("file-path").textContent = selectedPath || L("page.voice.noFile", { path: SAMPLE_REF_PATH });
}

function renderStatus() { // 纯投影：_voiceStatus(null=检查中) + selectedPath → DOM；零业务请求
  const card = $("status-card");
  if (!_voiceStatus) {
    card.className = "status-card no";
    card.textContent = L("page.voice.checking");
    return;
  }
  if (!_voiceStatus.deployed) {
    card.className = "status-card no";
    card.textContent = L("page.voice.statusNotDeployed");
    $("clone-form").classList.add("disabled");
    $("not-deployed").style.display = "block";
  } else if (_voiceStatus.ready) {
    card.className = "status-card ok";
    card.textContent = L("page.voice.statusReady", { char: _voiceStatus.character || "sussurro" }); // char=技术标识参数
    $("clone-form").classList.remove("disabled");
    $("not-deployed").style.display = "none";
  } else {
    card.className = "status-card no";
    card.textContent = L("page.voice.statusNotReady", { reason: _voiceStatus.fail || L("page.voice.unknownReason") });
    $("clone-form").classList.add("disabled");
    $("not-deployed").style.display = "block";
  }
}

async function refreshStatus() {
  _voiceStatus = await window.petAPI.voiceStatus();
  deployed = _voiceStatus.deployed;
  renderStatus();
}

$("btn-pick").addEventListener("click", async () => {
  const p = await window.petAPI.pickFile();
  if (!p) return;
  selectedPath = p;
  renderFilePath(); // 选中路径=DATA 原样展示
  setResult("");
});

$("btn-preview").addEventListener("click", async () => {
  const text = $("preview-text").value.trim();
  if (!selectedPath) { setResult(L("page.voice.needRefAudio"), false); return; }
  if (!text) { setResult(L("page.voice.emptyPreview"), false); return; }
  setResult(L("page.voice.synthesizing"));
  const r = await window.petAPI.previewVoice({
    text,
    refAudio: selectedPath,
    refText: $("ref-text").value.trim()
  });
  if (!r.ok) { setResult(L("page.voice.synthFailed", { error: r.message }), false); return; } // r.message=main 文本透传
  try {
    const audio = new Audio("data:audio/wav;base64," + r.b64);
    audio.volume = 1;
    await audio.play();
    setResult(L("page.voice.playing"), true);
    audio.onended = () => setResult(L("page.voice.playDone"), true);
  } catch (e) {
    setResult(L("page.voice.playFailed", { error: String(e.message || e) }), false);
  }
});

$("btn-apply").addEventListener("click", async () => {
  if (!selectedPath) { setResult(L("page.voice.needRefAudio"), false); return; }
  setResult(L("page.voice.applying"));
  const r = await window.petAPI.applyVoice({
    audioPath: selectedPath,
    text: $("ref-text").value.trim()
  });
  setResult(r.ok ? r.message : L("page.voice.applyFailed", { error: r.message }), r.ok); // 成功 message=main 已翻译，透传
  if (r.ok) refreshStatus();
});

$("btn-guide").addEventListener("click", () => {
  window.petAPI.openTtsGuide("训练指南.html"); // 文件名=技术标识，不迁移
});

$("btn-overview").addEventListener("click", () => {
  window.petAPI.openTtsGuide("总览.html"); // 同上
});

/* Phase 4-B2.1：locale 变化只重放状态投影（服务状态/已选路径保持不变），零业务请求 */
if (window.I18N && window.I18N.onChange) window.I18N.onChange(() => {
  renderStatus();
  renderFilePath();
});

renderFilePath();
refreshStatus();

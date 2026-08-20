/**
 * SuzuranPet preload — 安全桥
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  ask: (text) => ipcRenderer.invoke("pet:ask", { id: crypto.randomUUID(), text }),
  stop: () => ipcRenderer.send("pet:stop"),
  getState: () => ipcRenderer.invoke("pet:get-state"),
  setMode: (mode) => ipcRenderer.invoke("pet:set-mode", mode),
  reloadPersona: () => ipcRenderer.invoke("pet:reload-persona"),
  openConfig: () => ipcRenderer.invoke("pet:open-config"),
  moveWindow: (dx, dy) => ipcRenderer.send("pet:move", dx, dy),
  hideWindow: () => ipcRenderer.send("pet:hide"),
  setSize: (w, h) => ipcRenderer.send("pet:set-size", w, h),
  setClickable: (v) => ipcRenderer.send("pet:set-clickable", !!v),
  setTts: (enabled) => ipcRenderer.invoke("pet:set-tts", enabled),
  setRate: (rate) => ipcRenderer.invoke("pet:set-rate", rate),
  setScale: (scale) => ipcRenderer.invoke("pet:set-scale", scale),
  agreeTerms: () => ipcRenderer.invoke("pet:agree-terms"),
  refuseTerms: () => ipcRenderer.invoke("pet:refuse-terms"),
  openTerms: () => ipcRenderer.invoke("pet:open-terms"),
  onTtsChanged: (cb) => ipcRenderer.on("pet:tts-changed", (_e, v) => cb(v)),
  onRateChanged: (cb) => ipcRenderer.on("pet:tts-rate-changed", (_e, v) => cb(v)),
  onScaleChanged: (cb) => ipcRenderer.on("pet:scale-changed", (_e, v) => cb(v)),
  onTermsPending: (cb) => ipcRenderer.on("pet:terms-pending", (_e) => cb()),
  onTermsAgreed: (cb) => ipcRenderer.on("pet:terms-agreed", (_e) => cb()),
  speakClone: (text) => ipcRenderer.invoke("pet:tts-clone", text),
  playback: (msg) => ipcRenderer.send("pet:tts-playback", msg),

  // 设置窗口
  getSettings: () => ipcRenderer.invoke("pet:get-settings"),
  saveSettings: (patch) => ipcRenderer.invoke("pet:save-settings", patch),
  savePersona: (text) => ipcRenderer.invoke("pet:save-persona", text),
  resetPersona: () => ipcRenderer.invoke("pet:reset-persona"),
  testChat: (overrides) => ipcRenderer.invoke("pet:test-chat", overrides),
  listModels: (opts) => ipcRenderer.invoke("pet:list-models", opts),
  openTtsGuide: (fileName) => ipcRenderer.invoke("pet:open-tts-guide", fileName),
  clearHistory: () => ipcRenderer.invoke("pet:clear-history"),

  // 音色克隆与训练
  pickFile: () => ipcRenderer.invoke("pet:pick-file"),
  voiceStatus: () => ipcRenderer.invoke("pet:voice-status"),
  applyVoice: (payload) => ipcRenderer.invoke("pet:apply-voice", payload),
  previewVoice: (payload) => ipcRenderer.invoke("pet:tts-preview", payload),
  openVoiceStudio: () => ipcRenderer.invoke("pet:open-voice-studio"),

  // 表情管理
  getMoods: () => ipcRenderer.invoke("pet:get-moods"),
  pickGif: () => ipcRenderer.invoke("pet:pick-gif"),
  applyGif: (payload) => ipcRenderer.invoke("pet:apply-gif", payload),
  resetGif: (name) => ipcRenderer.invoke("pet:reset-gif", name),
  addMood: (label) => ipcRenderer.invoke("pet:add-mood", label),
  removeMood: (name) => ipcRenderer.invoke("pet:remove-mood", name),
  renameMood: (payload) => ipcRenderer.invoke("pet:rename-mood", payload),
  setMoodType: (payload) => ipcRenderer.invoke("pet:set-mood-type", payload),
  onSpritesChanged: (cb) => ipcRenderer.on("pet:sprites-changed", (_e, p) => cb(p)),

  onChunk: (cb) => ipcRenderer.on("pet:chunk", (_e, p) => cb(p)),
  onThinking: (cb) => ipcRenderer.on("pet:thinking", (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on("pet:done", (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on("pet:error", (_e, p) => cb(p)),
  onModeChanged: (cb) => ipcRenderer.on("pet:mode-changed", (_e, m) => cb(m)),
  onToggleInput: (cb) => ipcRenderer.on("pet:toggle-input", (_e) => cb()),
  onToast: (cb) => ipcRenderer.on("pet:toast", (_e, msg) => cb(msg))
});

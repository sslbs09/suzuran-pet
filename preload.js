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
  setSpeakJa: (v) => ipcRenderer.invoke("pet:set-speak-ja", !!v),
  restartGsv: () => ipcRenderer.invoke("pet:restart-gsv"),
  // 桌面行走（仅 Spine 模式）
  getSpineModels: () => ipcRenderer.invoke("pet:get-spine-models"),
  setSpineSkin: (id) => ipcRenderer.invoke("pet:set-spine-skin", id),
  onSpineSkinChanged: (cb) => ipcRenderer.on("pet:spine-skin-changed", (_e, id) => cb(id)),
  onPlayAnim: (cb) => ipcRenderer.on("pet:play-anim", (_e, name) => cb(name)),
  setSleeping: (v) => ipcRenderer.send("pet:set-sleeping", !!v),
  setWalking: (on) => ipcRenderer.invoke("pet:set-walking", !!on),
  walkingPause: (b) => ipcRenderer.send("pet:walking-pause", !!b),
  onWalking: (cb) => ipcRenderer.on("pet:walking", (_e, s) => cb(s)),
  onRenderModeChanged: (cb) => ipcRenderer.on("pet:render-mode-changed", (_e, m) => cb(m)),
  setUiLang: (lang) => ipcRenderer.invoke("pet:set-ui-lang", lang),
  getI18n: () => ipcRenderer.invoke("pet:get-i18n"),
  onUiLangChanged: (cb) => ipcRenderer.on("pet:ui-lang-changed", (_e, lang) => cb(lang)),
  setScale: (scale) => ipcRenderer.invoke("pet:set-scale", scale),
  agreeTerms: () => ipcRenderer.invoke("pet:agree-terms"),
  refuseTerms: () => ipcRenderer.invoke("pet:refuse-terms"),
  openTerms: () => ipcRenderer.invoke("pet:open-terms"),

  // 新功能：语音输入
  voiceStt: (audioPath, lang) => ipcRenderer.invoke("pet:voice-stt", { audioPath, lang }),
  voiceSttB64: (audioB64, lang) => ipcRenderer.invoke("pet:voice-stt-b64", { audioB64, lang }),

  // 新功能：日程提醒
  setReminder: (text, at) => ipcRenderer.invoke("pet:set-reminder", { text, at }),
  getReminders: () => ipcRenderer.invoke("pet:get-reminders"),
  cancelReminder: (index) => ipcRenderer.invoke("pet:cancel-reminder", index),

  // 新功能：番茄钟
  pomodoroStart: (workMin, restMin) => ipcRenderer.invoke("pet:pomodoro-start", { workMin, restMin }),
  pomodoroStop: () => ipcRenderer.invoke("pet:pomodoro-stop"),
  pomodoroStatus: () => ipcRenderer.invoke("pet:pomodoro-status"),

  // 新功能：系统监控
  getSysStats: () => ipcRenderer.invoke("pet:get-sysstats"),

  // 新功能：主动搭话（主进程 → 渲染层）
  onProactive: (cb) => ipcRenderer.on("pet:proactive", (_e, data) => cb(data)),
  onTtsChanged: (cb) => ipcRenderer.on("pet:tts-changed", (_e, v) => cb(v)),
  onRateChanged: (cb) => ipcRenderer.on("pet:tts-rate-changed", (_e, v) => cb(v)),
  onSpeakJaChanged: (cb) => ipcRenderer.on("pet:speak-ja-changed", (_e, v) => cb(v)),
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

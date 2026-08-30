/**
 * SuzuranPet preload — 安全桥
 */
"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  ask: (text) => ipcRenderer.invoke("pet:ask", { id: crypto.randomUUID(), text }),
  stop: () => ipcRenderer.send("pet:stop"),
  onStopped: (cb) => ipcRenderer.on("pet:stopped", (_e, d) => cb(d)), // v2.6 主动停止通知（渲染层复位 busy）
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
  setGroundGap: (px) => ipcRenderer.send("pet:set-ground-gap", px),
  setWalking: (on) => ipcRenderer.invoke("pet:set-walking", !!on),
  walkingPause: (b, source) => ipcRenderer.send("pet:walking-pause", !!b, source || "drag"),
  walkingEngineStop: () => ipcRenderer.send("pet:walking-engine-stop"),
  onWalking: (cb) => ipcRenderer.on("pet:walking", (_e, s) => cb(s)),
  onRenderModeChanged: (cb) => ipcRenderer.on("pet:render-mode-changed", (_e, m) => cb(m)),
  setUiLang: (lang) => ipcRenderer.invoke("pet:set-ui-lang", lang),
  getI18n: () => ipcRenderer.invoke("pet:get-i18n"),
  onUiLangChanged: (cb) => ipcRenderer.on("pet:ui-lang-changed", (_e, lang) => cb(lang)),
  setScale: (scale) => ipcRenderer.invoke("pet:set-scale", scale),
  getSeatSink: () => ipcRenderer.invoke("pet:get-seat-sink"),
  setSeatSink: (px) => ipcRenderer.invoke("pet:set-seat-sink", px),
  setCharInset: (px) => ipcRenderer.send("pet:set-char-inset", px),
  onEdgeLeft: (cb) => ipcRenderer.on("pet:edge-left", (_e, v) => cb(v)),
  onSetDim: (cb) => ipcRenderer.on("pet:set-dim", (_e, v) => cb(v)), // 半透明模式开关
  onNameChanged: (cb) => ipcRenderer.on("pet:name-changed", (_e, name) => cb(name)),
  throwPet: (vx, vy) => ipcRenderer.send("pet:throw", Number(vx) || 0, Number(vy) || 0), // 拖拽抛掷
  onDropped: (cb) => ipcRenderer.on("pet:dropped", () => cb()), // 抛掷落地通知
  getWalkTiming: () => ipcRenderer.invoke("pet:get-walk-timing"),
  setWalkTiming: (patch) => ipcRenderer.invoke("pet:set-walk-timing", patch),
  getAppearance: () => ipcRenderer.invoke("pet:get-appearance"),
  setAppearance: (patch) => ipcRenderer.invoke("pet:set-appearance", patch),
  importFont: () => ipcRenderer.invoke("pet:import-font"),
  onAppearanceChanged: (cb) => ipcRenderer.on("pet:appearance-changed", (_e, a) => cb(a)),
  agreeTerms: () => ipcRenderer.invoke("pet:agree-terms"),
  refuseTerms: () => ipcRenderer.invoke("pet:refuse-terms"),
  openTerms: () => ipcRenderer.invoke("pet:open-terms"),
  openQuickstart: () => ipcRenderer.invoke("pet:open-quickstart"),

  // 新功能：语音输入
  voiceStt: (audioPath, lang) => ipcRenderer.invoke("pet:voice-stt", { audioPath, lang }),
  voiceSttB64: (audioB64, lang) => ipcRenderer.invoke("pet:voice-stt-b64", { audioB64, lang }),

  // 新功能：日程提醒
  setReminder: (text, at) => ipcRenderer.invoke("pet:set-reminder", { text, at }),
  getReminders: () => ipcRenderer.invoke("pet:get-reminders"),
  cancelReminder: (id) => ipcRenderer.invoke("pet:cancel-reminder", id),
  getSchedules: () => ipcRenderer.invoke("pet:get-schedules"),
  getInfo: () => ipcRenderer.invoke("pet:get-info"), // 信息版：陪伴时间 + 今日日程
  docsList: () => ipcRenderer.invoke("docs:list"), // 文档中心（v2.5.1）
  docsRead: (key) => ipcRenderer.invoke("docs:read", key),
  openDocs: () => ipcRenderer.invoke("pet:open-docs"),
  live2dList: () => ipcRenderer.invoke("pet:live2d-list"), // Live2D 模型扫描（v2.5.1）
  reloadRenderer: () => ipcRenderer.invoke("pet:reload-renderer"), // 渲染层自愈
  setTheme: (theme) => ipcRenderer.invoke("pet:set-theme", theme),
  swipeMove: (dir) => ipcRenderer.invoke("pet:swipe-move", dir),
  regenerate: () => ipcRenderer.invoke("pet:regenerate"),
  onSwipeChanged: (cb) => ipcRenderer.on("pet:swipe-changed", (_e, s) => cb(s)),
  onThemeChanged: (cb) => ipcRenderer.on("pet:theme-changed", (_e, th) => cb(th)),
  live2dSelect: (id) => ipcRenderer.invoke("pet:live2d-select", id),
  onLive2dChanged: (cb) => ipcRenderer.on("pet:live2d-changed", (_e, id) => cb(id)),
  setLive2dScale: (v) => ipcRenderer.send("pet:set-live2d-scale", v),
  onLive2dScaleChanged: (cb) => ipcRenderer.on("pet:live2d-scale-changed", (_e, v) => cb(v)),
  psdOpen: () => ipcRenderer.invoke("pet:psd-open"), // PSD 角色工具窗口（v2.1）
  psdSave: (dataUrl, label) => ipcRenderer.invoke("pet:psd-save", dataUrl, label),
  // PSD 2.5D 角色皮肤（v2.2）
  rigSkins: () => ipcRenderer.invoke("pet:rig-skins"),
  rigApply: (srcPath) => ipcRenderer.invoke("pet:rig-apply", srcPath),
  rigApplyBuffer: (name, b64) => ipcRenderer.invoke("pet:rig-apply-buffer", name, b64), // PSD 图层编辑后重序列化（v2.6）
  rigSet: (id) => ipcRenderer.invoke("pet:rig-set", id),
  rigDelete: (id) => ipcRenderer.invoke("pet:rig-delete", id), // 删除已导入 2.5D 皮肤（v2.6，§14 追加 96）
  setRigScale: (v) => ipcRenderer.send("pet:set-rig-scale", v),
  onRigScaleChanged: (cb) => ipcRenderer.on("pet:rig-scale-changed", (_e, v) => cb(v)),
  onRigSkinChanged: (cb) => ipcRenderer.on("pet:rig-skin-changed", (_e, id) => cb(id)),
  setRigMouseFollow: (v) => ipcRenderer.send("pet:set-rig-mouse-follow", v),
  setWalkGlobal: (v) => ipcRenderer.send("pet:set-walk-global", v), // 桌面全域行走（实验）
  setSoftRender: (v) => ipcRenderer.send("pet:set-soft-render", v), // 软件渲染（重启生效）
  setEmotionVoice: (k, on) => ipcRenderer.send("pet:set-emotion-voice", k, on), // 情绪音色分档开关
  onEmotionVoiceChanged: (cb) => ipcRenderer.on("pet:emotion-voice-changed", (_e, ev) => cb(ev)),
  onRigMouseFollowChanged: (cb) => ipcRenderer.on("pet:rig-mouse-follow-changed", (_e, v) => cb(v)),
  setMouseTrackGlobal: (on) => ipcRenderer.send("pet:set-mouse-track-global", on),
  setCatToy: (on) => ipcRenderer.send("pet:set-cat-toy", on),
  setFileGuard: (on) => ipcRenderer.send("pet:set-file-guard", on),
  // v2.5.7 添加人物
  importSpine: () => ipcRenderer.invoke("pet:import-spine"),
  // v2.5.2 记忆管理
  getMemory: () => ipcRenderer.invoke("pet:get-memory"),
  addMemoryFact: (text) => ipcRenderer.invoke("pet:add-memory-fact", text), // 手动添加记忆（设置页）
  deleteMemoryFact: (id) => ipcRenderer.invoke("pet:delete-memory-fact", id),
  updateMemoryFact: (id, text) => ipcRenderer.invoke("pet:update-memory-fact", id, text), // 编辑单条记忆（§14 追加 103）
  clearMemory: () => ipcRenderer.invoke("pet:clear-memory"),
  // v2.3 人格化/主动搭话
  pat: () => ipcRenderer.send("pet:pat"),
  setProactiveChat: (on) => ipcRenderer.send("pet:set-proactive-chat", on),
  setPersonify: (on) => ipcRenderer.send("pet:set-personify", on),
  setWorkspaceWatch: (on, dirs) => ipcRenderer.send("pet:set-workspace-watch", on, dirs), // 感知工作区活动
  setRpMode: (on) => ipcRenderer.send("pet:set-rp-mode", on),
  onAgentStatus: (cb) => ipcRenderer.on("pet:agent-status", (_e, s) => cb(s)), // Agent 任务状态（zcode 模式）
  onMouseTrackGlobalChanged: (cb) => ipcRenderer.on("pet:mouse-track-global-changed", (_e, v) => cb(v)),
  onMousePos: (cb) => ipcRenderer.on("pet:mouse-pos", (_e, p) => cb(p)),
  addSchedule: (item) => ipcRenderer.invoke("pet:add-schedule", item),
  cancelSchedule: (id) => ipcRenderer.invoke("pet:cancel-schedule", id),
  completeSchedule: (id) => ipcRenderer.invoke("pet:complete-schedule", id),
  snoozeSchedule: (id, minutes) => ipcRenderer.invoke("pet:snooze-schedule", { id, minutes }),
  openSchedule: () => ipcRenderer.invoke("pet:open-schedule"),
  pickScheduleWorkbook: () => ipcRenderer.invoke("pet:pick-schedule-workbook"),
  importScheduleWorkbook: (filePath) => ipcRenderer.invoke("pet:import-schedule-workbook", filePath),
  previewScheduleWorkbook: (filePath) => ipcRenderer.invoke("pet:preview-schedule-workbook", filePath),
  exportScheduleTemplate: () => ipcRenderer.invoke("pet:export-schedule-template"),
  onScheduleDue: (cb) => ipcRenderer.on("pet:schedule-due", (_e, item) => cb(item)),

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
  speakClone: (text, opts) => ipcRenderer.invoke("pet:tts-clone", text, opts || {}),
  onTtsPart: (cb) => ipcRenderer.on("pet:tts-part", (_e, part) => cb(part)), // v2.5.5 逐句流式
  setSkinWindowWidth: (px) => ipcRenderer.send("pet:set-skin-window-width", px),
  playback: (msg) => ipcRenderer.send("pet:tts-playback", msg),

  // 设置窗口
  getSettings: () => ipcRenderer.invoke("pet:get-settings"),
  generateAgentToken: () => ipcRenderer.invoke("pet:generate-agent-token"),
  addAgentClient: (name) => ipcRenderer.invoke("pet:add-agent-client", name), // 接入管理：新增授权接入方
  removeAgentClient: (name) => ipcRenderer.invoke("pet:remove-agent-client", name), // 接入管理：断开接入方
  saveSettings: (patch) => ipcRenderer.invoke("pet:save-settings", patch),
  savePersona: (text) => ipcRenderer.invoke("pet:save-persona", text),
  resetPersona: () => ipcRenderer.invoke("pet:reset-persona"),
  testChat: (overrides) => ipcRenderer.invoke("pet:test-chat", overrides),
  listModels: (opts) => ipcRenderer.invoke("pet:list-models", opts),
  openTtsGuide: (fileName) => ipcRenderer.invoke("pet:open-tts-guide", fileName),
  clearHistory: () => ipcRenderer.invoke("pet:clear-history"),

  // 凭据导入与密钥清除（scan 只返回指纹，import/clear 在主进程内完成，原值不经过 renderer）
  scanCredentials: () => ipcRenderer.invoke("pet:scan-importable-credentials"),
  importCredential: (req) => ipcRenderer.invoke("pet:import-credential", req),
  clearSecret: (slot) => ipcRenderer.invoke("pet:clear-secret", slot),

  // 音色克隆与训练
  pickFile: () => ipcRenderer.invoke("pet:pick-file"),
  voiceStatus: () => ipcRenderer.invoke("pet:voice-status"),
  applyVoice: (payload) => ipcRenderer.invoke("pet:apply-voice", payload),
  previewVoice: (payload) => ipcRenderer.invoke("pet:tts-preview", payload),
  emotionAudition: (key) => ipcRenderer.invoke("pet:emotion-audition", key), // v2.6 情绪音色试听
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
  filePath: (file) => webUtils.getPathForFile(file), // 取 File 的真实路径（Electron 43 起 File.path 已移除）

  onChunk: (cb) => ipcRenderer.on("pet:chunk", (_e, p) => cb(p)),
  onThinking: (cb) => ipcRenderer.on("pet:thinking", (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on("pet:done", (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on("pet:error", (_e, p) => cb(p)),
  onModeChanged: (cb) => ipcRenderer.on("pet:mode-changed", (_e, m) => cb(m)),
  onToggleInput: (cb) => ipcRenderer.on("pet:toggle-input", (_e) => cb()),
  onToast: (cb) => ipcRenderer.on("pet:toast", (_e, msg) => cb(msg))
});

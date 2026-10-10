/**
 * settings-save-plan.js — P2 产品语义保存模型（settings redesign v0.1）。
 *
 * 职责边界（Implementation Plan §5/§11 P2）：
 *   - 这里只放「保存规则」的纯数据与纯函数：Rule A 单键 patch 构建器、事务组定义、
 *     成员归属查询、payload 构建。无 IPC、无 DOM、无运行时状态。
 *   - 真正的 IPC 提交（pet:save-settings / pet:save-persona / pet:set-weather）与
 *     组级 dirty/snapshot 状态机由 renderer/settings.js 驱动。
 *
 * 保存模型（FROZEN Design Doc §12）：
 *   A. 独立、低风险、不与其它字段构成事务的设置 → 立即生效并持久化。
 *      - 已有安全专用通道的（render-mode/theme/uiLang/感知开关/行走节奏/appearance/
 *        皮肤/fixedOnly/情绪分档/tts.enabled(setTts)/语速(setRate)/speakJa(setSpeakJa)/
 *        walking(setWalking)/clipboard·sysmon·focus(toggle-feature)/weather enabled
 *        (set-weather 单键)）由 settings.js 沿用既有 handler，不在本表。
 *      - 适合 pet:save-settings 单键 patch 的独立设置在本表 RULE_A_PATCH。
 *   B. 多字段事务 → TRANSACTIONS 分组显式保存。
 *   C. 无 Save All。D. 无跨区 save-other。
 *
 * 白名单约束：本表全部键均在 src/settings-patch.js ALLOWED_TOP 内（P2 未扩白名单）；
 * weather.* 不在白名单 → tx-weather 走既有 pet:set-weather 通道（IMPLEMENTATION CONSTRAINT）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SettingsSavePlan = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Rule A（save-settings 单键 patch）：id → (rawValue) => patch 片段。
   * 数值解析与旧 doSaveApi/doSaveVoice 保持一致（同一兜底默认）。
   */
  const RULE_A_PATCH = {
    "greeting-on-start": (v) => ({ greetingOnStart: !!v }),
    "sys-voice-fallback": (v) => ({ tts: { systemVoiceFallback: String(v || "tts") } }),
    // 中文语音方案：UI 单选 ↔ 三个 enabled 布尔（现行编码保持；引擎生命周期联动见 main.js V1 hook）
    "tts-plan": (v) => ({
      ttsGenie: { enabled: v === "genie" },
      ttsCloud: { enabled: v === "edge" },
      ttsCosy: { enabled: v === "cosy" }
    }),
    "temperature": (v) => ({ chat: { temperature: parseFloat(v) || 0.85 } }),
    "smp-topp": (v) => ({ chat: { sampling: { topP: parseFloat(v) || 0.9 } } }),
    "smp-minp": (v) => ({ chat: { sampling: { minP: parseFloat(v) || 0.05 } } }),
    "smp-reppen": (v) => ({ chat: { sampling: { repeatPenalty: parseFloat(v) || 1.1 } } }),
    "smp-presence": (v) => ({ chat: { sampling: { presencePenalty: parseFloat(v) || 0.1 } } }),
    "smp-frequency": (v) => ({ chat: { sampling: { frequencyPenalty: parseFloat(v) || 0.1 } } }),
    "max-tokens": (v) => ({ chat: { maxTokens: parseInt(v, 10) || 800 } }),
    "max-history": (v) => ({ chat: { maxHistoryTurns: parseInt(v, 10) || 20 } }),
    "hotkey": (v) => ({ hotkey: String(v || "").trim() || "Alt+Shift+S" }),
    "start-hidden": (v) => ({ startHidden: String(v) === "true" }),
    "net-proxy": (v) => ({ netProxy: String(v || "").trim() }),
    "feat-desktop-icons": (v) => ({ features: { desktopIcons: !!v } }),
    "feat-emotional": (v) => ({ features: { emotionalVoice: !!v } }),
    "feat-memory": (v) => ({ features: { longTermMemory: !!v } }),
    "auto-launch": (v) => ({ autoLaunch: !!v })
  };

  /**
   * 事务组（B 类）：txId → { channel, ids, build }。
   *   channel: "save-settings" | "save-persona" | "set-weather"（IPC 路由描述符，settings.js 执行）
   *   ids:     事务成员控件 id（快照/脏态/放弃回填的粒度）
   *   build:   (get, persisted) => payload；get(id) 读当前输入值。
   *            只包含本组字段——成员间无跨组键（纯函数，可单测）。
   */
  const TRANSACTIONS = {
    "tx-ai-provider": {
      channel: "save-settings",
      ids: ["api-type", "base-url", "model", "api-key"],
      build(get) {
        const typedKey = String(get("api-key") || "").trim();
        const patch = {
          chat: {
            apiType: get("api-type"),
            baseUrl: String(get("base-url") || "").trim(),
            model: String(get("model") || "").trim()
          }
        };
        // 既有安全语义：API Key 空输入 = 不覆盖已有 secret（空串绝不 replace 槽位）
        if (typedKey) patch.secrets = { chatApiKey: { action: "replace", value: typedKey } };
        return patch;
      }
    },
    "tx-identity": {
      channel: "save-settings",
      ids: ["pet-name", "user-name"],
      build(get) {
        return {
          pet: { name: get("pet-name") },
          chat: { userName: String(get("user-name") || "").trim() || "主人" }
        };
      }
    },
    "tx-persona": {
      channel: "save-persona",
      ids: ["persona"],
      build(get) { return String(get("persona") || ""); }
    },
    "tx-agent": {
      channel: "save-settings",
      ids: ["agent-enabled", "agent-port", "agent-word", "agent-token", "agent-max-body", "agent-status-enabled"],
      build(get) {
        return {
          agentApi: {
            enabled: get("agent-enabled") === "true",
            port: parseInt(get("agent-port"), 10) || 8765,
            invokeWord: String(get("agent-word") || "").trim(),
            bearerToken: String(get("agent-token") || "").trim(),
            maxBodyBytes: Math.max(1024, Math.min(1024 * 1024, (parseInt(get("agent-max-body"), 10) || 64) * 1024)),
            statusEnabled: !!get("agent-status-enabled")
          }
        };
      }
    },
    "tx-weather": {
      // IMPLEMENTATION CONSTRAINT：weather.* 不在 settings-patch ALLOWED_TOP，走既有 pet:set-weather。
      // build 需要 persisted enabled：set-weather 对缺失的 enabled 隐式置 true，
      // 事务提交必须显式携带持久化 enabled（仅显式 true 才开）——调用方缺陷也绝不可能隐式打开服务。
      channel: "set-weather",
      ids: ["weather-city", "weather-provider", "weather-key"],
      build(get, persistedEnabled) {
        return {
          enabled: persistedEnabled === true,
          city: String(get("weather-city") || "").trim(),
          provider: String(get("weather-provider") || "open-meteo"),
          key: String(get("weather-key") || "").trim()
        };
      }
    },
    "tx-engine-deploy": {
      channel: "save-settings",
      ids: ["genie-python", "genie-script"],
      build(get) {
        return {
          ttsGenie: {
            python: String(get("genie-python") || "").trim(),
            serverScript: String(get("genie-script") || "").trim()
          }
        };
      }
    },
    "tx-ref-audio": {
      channel: "save-settings",
      ids: ["genie-ref-audio", "genie-ref-text"],
      build(get) {
        return {
          ttsGenie: {
            refAudio: String(get("genie-ref-audio") || "").trim(),
            refText: String(get("genie-ref-text") || "").trim()
          }
        };
      }
    }
  };

  const TX_IDS = Object.keys(TRANSACTIONS);

  /** 成员 id → 所属事务 id；不属于任何事务返回 null（Rule A / 纯 UI 控件）。 */
  function transactionOf(id) {
    for (const txId of TX_IDS) {
      if (TRANSACTIONS[txId].ids.indexOf(id) >= 0) return txId;
    }
    return null;
  }

  /** Rule A 单键 patch；未登记 id 返回 null（不静默保存未知控件）。 */
  function ruleAPatchOf(id, rawValue) {
    const fn = RULE_A_PATCH[id];
    return fn ? fn(rawValue) : null;
  }

  /** 全部事务成员 id 的扁平清单（去重校验/契约测试用）。 */
  function allTransactionIds() {
    const out = [];
    for (const txId of TX_IDS) out.push(...TRANSACTIONS[txId].ids);
    return out;
  }

  return { RULE_A_PATCH, TRANSACTIONS, TX_IDS, transactionOf, ruleAPatchOf, allTransactionIds };
});

"use strict";
// 双端纯函数（与 src/clickability.js、src/seat-fit.js 同先例）：Node 单测 require；渲染层 <script> 挂 window.CharacterSleepIntent。
// src 按 Node 环境 lint，故显式声明 window 全局（实际使用有 typeof 守卫）。
/* global window */

/**
 * PHASE 6-D.3 MINIMAL CHARACTER RUNTIME EXPERIMENT
 * EXPERIMENTAL CAUSAL-PATH PROBE — NOT PRODUCT TUNING
 *
 * 唯一职责：todayMood（派生内部状态信号）→ sleepIdleThresholdMs（意图参数）。
 *
 * 故意不做的事（边界比功能重要）：
 *   - 不算心情——那是 src/mood-day.js 的既有职责（moodOfTheDay(date, bondDays)），这里只接受结果；
 *   - 不 require bond / memory / config，不读 bond.json，不写任何用户数据；
 *   - 不碰 timer / DOM / Electron / IPC / 文件系统；没有可变单例，调用顺序不影响结果。
 *
 * 依赖方向（单向，不可回指）：
 *   main：bond.days → todayMood() → 本模块 → 随 pet:get-state 快照下发；
 *   renderer：只消费快照里那个已解析的整数，不重算、不反推 bond、不轮询。
 *
 * gate OFF 时两端的取值都严格等于改造前 renderer 里 5 * 60 * 1000 的逐位结果 300000。
 */

/** 改造前 renderer 里 `5 * 60 * 1000` 的逐位取值。未知心情 / 非法快照 / gate 关闭一律回落到这里。 */
const DEFAULT_SLEEP_IDLE_MS = 300000;

/**
 * 心情 → 闲时入睡阈值的冻结实验表。
 * 数值刻意拉得开（30s ~ 180s，对照默认 300s）：本轮只证明因果通路能跑通、避免假阴性，
 * 不讨论“像不像角色”。任何把它当作产品调参的改动都应视为偏离本轮目标。
 */
const SLEEP_IDLE_MS_BY_MOOD = Object.freeze({
  "慵懒": 30000,
  "平静": 60000,
  "软萌": 90000,
  "温暖": 120000,
  "元气": 180000
});

/** Feature gate：默认 OFF（config DEFAULTS 里就是 false）。只读配置，不写配置。 */
function characterRuntimeV0Enabled(cfg) {
  return !!(cfg && cfg.characterRuntimeV0Enabled === true);
}

/**
 * 核心策略：gate + 心情 → 意图参数。
 * gate OFF 时对任意心情（合法的、未知的、空的）一律返回 300000 —— 这就是 ablation 的 OFF 臂。
 */
function sleepIdleThresholdMsForMood(mood, opts) {
  if (!(opts && opts.enabled === true)) return DEFAULT_SLEEP_IDLE_MS;
  const key = mood == null ? "" : String(mood).trim();
  const mapped = SLEEP_IDLE_MS_BY_MOOD[key];
  return typeof mapped === "number" ? mapped : DEFAULT_SLEEP_IDLE_MS;
}

/**
 * main 侧观测快照：{ enabled, todayMood, sleepIdleThresholdMs }。
 * 纯函数——gate 已由调用方解析成布尔（characterRuntimeV0Enabled），todayMood 也由调用方算好传进来
 * （gate OFF 时传 "" 即可，本模块不替你决定要不要算）。
 * 注意：这里读的是 input.enabled，不是 characterRuntimeV0Enabled(cfg)——config 只在 main 侧解析一次。
 */
function buildCharacterRuntimeV0Snapshot(input) {
  const enabled = !!(input && input.enabled === true);
  const mood = String((input && input.todayMood) || "").trim();
  return { enabled, todayMood: mood, sleepIdleThresholdMs: sleepIdleThresholdMsForMood(mood, { enabled }) };
}

/**
 * renderer 侧消费契约：只认快照里那个数字。
 * 非法输入（缺失 / null / 非 number / NaN / Infinity / <= 0）一律回落 300000，
 * 保证渲染层永远有一个能安全喂给 setTimeout 的值。
 */
function resolveSleepIdleThresholdMs(snapshot) {
  const raw = snapshot && typeof snapshot === "object" ? snapshot.sleepIdleThresholdMs : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !(raw > 0)) return DEFAULT_SLEEP_IDLE_MS;
  return raw;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_SLEEP_IDLE_MS,
    SLEEP_IDLE_MS_BY_MOOD,
    characterRuntimeV0Enabled,
    sleepIdleThresholdMsForMood,
    buildCharacterRuntimeV0Snapshot,
    resolveSleepIdleThresholdMs
  };
}
if (typeof window !== "undefined") {
  window.CharacterSleepIntent = {
    DEFAULT_SLEEP_IDLE_MS,
    SLEEP_IDLE_MS_BY_MOOD,
    characterRuntimeV0Enabled,
    sleepIdleThresholdMsForMood,
    buildCharacterRuntimeV0Snapshot,
    resolveSleepIdleThresholdMs
  };
}

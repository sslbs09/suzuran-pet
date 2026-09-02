"use strict";

const { ttsCloneImpl } = require("./tts-manager");
const fixedCache = require("./fixed-line-cache");

let active = null;

function publicStatus(profile, vars) {
  return fixedCache.load(profile, vars);
}

function cancel() {
  if (!active) return false;
  active.cancelled = true;
  return true;
}

async function start({ config, vars = {}, retryFailed = false, pools = null, onProgress = () => {} }) {
  if (active) return { ok: false, code: "ALREADY_RUNNING" };
  if ((config.tts || {}).fixedOnly) return { ok: false, code: "FIXED_ONLY_ON", message: "固定台词离线模式开启中（引擎已停），请先关闭离线模式再预加载" };
  const profile = fixedCache.profileFromConfig(config || {});
  if (profile.engine === "system") return { ok: false, code: "SYSTEM_NOT_PRELOADABLE", message: "系统语音由操作系统实时合成，无需预加载" };
  const initial = fixedCache.load(profile, vars);
  const poolSet = Array.isArray(pools) && pools.length ? new Set(pools.map(String)) : null;
  const queue = initial.items.filter((item) =>
    (item.state === "pending" || (retryFailed && item.state === "failed")) &&
    (!poolSet || poolSet.has(item.pool)));
  active = { cancelled: false, profile };
  let completed = initial.summary.ready;
  let failed = retryFailed ? 0 : initial.summary.failed;
  onProgress({ state: "running", completed, failed, total: initial.items.length, current: null, summary: initial.summary });
  try {
    for (const item of queue) {
      if (active.cancelled) break;
      onProgress({ state: "loading", completed, failed, total: initial.items.length, current: item, summary: fixedCache.load(profile, vars).summary });
      try {
        const b64 = await ttsCloneImpl(item.text, { emo: item.emotion, fixedLinePreload: true }, undefined);
        if (!b64) throw new Error("TTS_EMPTY");
        fixedCache.saveItem(profile, item, Buffer.from(b64, "base64"));
        completed++;
        onProgress({ state: "running", completed, failed, total: initial.items.length, current: item, summary: fixedCache.load(profile, vars).summary });
      } catch (error) {
        failed++;
        fixedCache.markFailed(profile, item, String(error && (error.code || error.message) || error).slice(0, 120));
        onProgress({ state: "running", completed, failed, total: initial.items.length, current: item, errorCode: String(error && (error.code || error.message) || error).slice(0, 120), summary: fixedCache.load(profile, vars).summary });
      }
    }
    const status = fixedCache.load(profile, vars);
    const state = active.cancelled ? "cancelled" : status.summary.failed ? "completed_with_errors" : "completed";
    onProgress({ state, completed: status.summary.ready, failed: status.summary.failed, total: status.summary.total, current: null, summary: status.summary });
    return { ok: true, state, ...status };
  } finally {
    active = null;
  }
}

function status(config, vars = {}) {
  const profile = fixedCache.profileFromConfig(config || {});
  return { ...publicStatus(profile, vars), running: !!active, state: active ? "running" : "idle" };
}

module.exports = { start, cancel, status };

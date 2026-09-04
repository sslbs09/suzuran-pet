"use strict";

const fs = require("fs");
const path = require("path");
const storage = require("./storage");
const { buildManifest, findItem, findItemText, findItemNormalized, cacheKey, summarize, voiceFingerprint } = require("./fixed-lines");

const ROOT = path.resolve(storage.PATHS.audio, "fixed-lines");
const CACHE_TTL_MS = 0; // 0=长期保存（不设时间上限，2026-09-03 起）；空间由 CACHE_MAX_BYTES 预算+LRU 管理
function cacheFresh(updatedAt) {
  // CACHE_TTL_MS>0 时按 TTL 过期；0=永不过期（updatedAt 仅作 LRU/展示用途）
  return CACHE_TTL_MS <= 0 || Date.now() - (Number(updatedAt) || 0) <= CACHE_TTL_MS;
}
function safeId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(id)) throw new Error("非法缓存标识");
  return id;
}

function safeFingerprint(value) {
  return safeId(value).match(/^[a-f0-9]{16}$/i) ? value : "";
}

function insideRoot(root, file) {
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("缓存路径越界");
  return target;
}

function profileFromConfig(cfg = {}) {
  const tts = cfg.tts || {};
  const genie = cfg.ttsGenie || {};
  const gsv = cfg.ttsGsv || {};
  const cloud = cfg.ttsCloud || {};
  const cosy = cfg.ttsCosy || {};
  const useGenie = !!genie.enabled;
  // 日语模式可脱离 Genie 独立运行（main 启动预热只看 speakJa，不要求 genie.enabled）：
  // 此时合成走 GSV，若判成 "system" 固定台词预加载会被 SYSTEM_NOT_PRELOADABLE 拒绝。
  // 仅在 genie 未启用时才改判 "gsv"——已启用用户指纹不变、已预加载缓存不迁移。
  const useGsv = !useGenie && !!genie.speakJa && !!gsv.enabled;
  const useCosy = !useGenie && !useGsv && !!cosy.enabled;
  const useEdge = !useGenie && !useGsv && !useCosy && !!cloud.enabled;
  return {
    engine: useGenie ? "genie" : useGsv ? "gsv" : useCosy ? "cosy" : useEdge ? "edge" : "system",
    language: genie.speakJa ? "ja" : "zh",
    voice: (useGenie || useGsv) ? "" : useCosy ? cosy.voice : useEdge ? cloud.voice : tts.voice,
    referenceAudio: useGenie ? path.basename(String(genie.refAudio || "")) : useGsv ? path.basename(String(gsv.refAudio || "")) : "",
    referenceText: useGenie ? genie.refText : useGsv ? gsv.refText : "",
    rate: (useGenie || useGsv) ? "" : useCosy ? cosy.rate : useEdge ? cloud.rate : tts.rate,
    pitch: (useGenie || useGsv) ? "" : useCosy ? cosy.pitch : useEdge ? cloud.pitch : tts.pitch
  };
}

function pathsFor(profile) {
  const fingerprint = voiceFingerprint(profile);
  const dir = insideRoot(ROOT, safeFingerprint(fingerprint));
  return { fingerprint, dir, manifest: insideRoot(dir, "manifest.json") };
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

function audioPath(dir, itemId) {
  const fileName = safeId(itemId) + ".audio";
  return insideRoot(dir, fileName);
}

function load(profile, vars = {}) {
  const manifest = buildManifest(vars);
  const paths = pathsFor(profile);
  const disk = readJson(paths.manifest) || {};
  const saved = disk.items && typeof disk.items === "object" ? disk.items : {};
  const items = manifest.map((item) => {
    const key = cacheKey(item, profile);
    const record = saved[key] || {};
    let valid = false;
    let bytes = 0;
    try {
      if (record.state === "ready" && cacheFresh(record.updatedAt) && record.audioFile === safeId(item.id) + ".audio") {
        const file = audioPath(paths.dir, item.id);
        valid = fs.existsSync(file) && fs.statSync(file).isFile();
        if (valid) bytes = fs.statSync(file).size;
      }
    } catch { valid = false; }
    return {
      ...item,
      state: valid ? "ready" : record.state === "failed" ? "failed" : "pending",
      bytes,
      updatedAt: valid ? Number(record.updatedAt) || 0 : 0,
      errorCode: valid ? "" : String(record.errorCode || ""),
      audioFile: valid ? record.audioFile : ""
    };
  });
  return { fingerprint: paths.fingerprint, profile, items, summary: summarize(items) };
}

function saveItem(profile, item, buffer) {
  if (!item || !item.id || !Buffer.isBuffer(buffer) || !buffer.length) throw new Error("无效的固定台词音频");
  const paths = pathsFor(profile);
  fs.mkdirSync(paths.dir, { recursive: true });
  const audioFile = safeId(item.id) + ".audio";
  const target = audioPath(paths.dir, item.id);
  const tmp = insideRoot(paths.dir, audioFile + ".tmp-" + process.pid + "-" + Date.now());
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
    const disk = readJson(paths.manifest) || { version: 1, fingerprint: paths.fingerprint, items: {} };
    disk.items = disk.items && typeof disk.items === "object" ? disk.items : {};
    disk.items[cacheKey(item, profile)] = { state: "ready", audioFile, bytes: buffer.length, updatedAt: Date.now(), errorCode: "" };
    storage.atomicWrite(paths.manifest, JSON.stringify(disk, null, 2));
    enforceCacheBudgetThrottled(paths.fingerprint); // TD-3：写盘后节流检查总容量预算
    return disk.items[cacheKey(item, profile)];
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理失败不覆盖合成结果 */ }
  }
}

function markFailed(profile, item, errorCode) {
  const paths = pathsFor(profile);
  fs.mkdirSync(paths.dir, { recursive: true });
  const disk = readJson(paths.manifest) || { version: 1, fingerprint: paths.fingerprint, items: {} };
  disk.items = disk.items && typeof disk.items === "object" ? disk.items : {};
  disk.items[cacheKey(item, profile)] = { state: "failed", audioFile: "", bytes: 0, updatedAt: Date.now(), errorCode: String(errorCode || "UNKNOWN").slice(0, 120) };
  storage.atomicWrite(paths.manifest, JSON.stringify(disk, null, 2));
}

function clear(profile) {
  const paths = pathsFor(profile);
  fs.rmSync(paths.dir, { recursive: true, force: true });
  return true;
}

/** 按条目 id 直读缓存音频（lineId 透传路径，最快命中） */
function readAudioById(profile, id) {
  let itemId;
  try { itemId = safeId(id); } catch { return null; }
  const paths = pathsFor(profile);
  const disk = readJson(paths.manifest) || {};
  const record = disk.items && disk.items[`${paths.fingerprint}:${itemId}`];
  if (!record || record.state !== "ready" || record.audioFile !== itemId + ".audio") return null;
  if (!cacheFresh(record.updatedAt)) return null;
  try { return fs.readFileSync(audioPath(paths.dir, itemId)); } catch { return null; }
}

function readAudio(profile, item) {
  if (!item || !item.id) return null;
  return readAudioById(profile, item.id);
}

function findCachedAudio(profile, text, emotion, vars = {}) {
  const item = findItem(vars, text, emotion) || findItemText(vars, text) || findItemNormalized(vars, text);
  return item ? readAudioById(profile, item.id) : null;
}

/** 列出全部缓存指纹目录（16 位 hex 白名单，防误删无关目录） */
function listFingerprints() {
  try {
    return fs.readdirSync(ROOT).filter((d) => /^[a-f0-9]{16}$/i.test(d) && fs.statSync(path.join(ROOT, d)).isDirectory());
  } catch { return []; }
}

/** 清理非当前语音方案的旧版本缓存目录（换音色/语言后的历史包），返回删除数 */
function clearOldFingerprints(keepFingerprint) {
  const keep = safeFingerprint(keepFingerprint);
  let removed = 0;
  for (const fp of listFingerprints()) {
    if (fp === keep) continue;
    try { fs.rmSync(insideRoot(ROOT, fp), { recursive: true, force: true }); removed++; } catch { /* 占用中跳过 */ }
  }
  return removed;
}

/* ---------- TD-3：缓存总容量预算（只增不减 → 超限按目录 LRU 清理） ---------- */
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 总上限 500MB（固定台词短音频场景实际远小于此）
let _lastBudgetCheckAt = 0;

function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) total += dirSizeBytes(p);
        else if (st.isFile()) total += st.size;
      } catch { /* 单项统计失败忽略 */ }
    }
  } catch { /* 目录不可读按 0 计 */ }
  return total;
}

/** 把缓存总大小压回 maxBytes 内：指纹目录按 mtime LRU 从旧到新删，当前方案（keep）永不删。
 *  目录 mtime 在每次 saveItem/markFailed 写 manifest 时刷新，天然是"最近使用"信号。 */
function enforceCacheBudget(keepFingerprint, maxBytes = CACHE_MAX_BYTES) {
  const keep = safeFingerprint(keepFingerprint);
  let total = 0;
  const entries = [];
  for (const fp of listFingerprints()) {
    try {
      const dir = insideRoot(ROOT, fp);
      const size = dirSizeBytes(dir);
      total += size;
      entries.push({ fp, dir, size, mtime: fs.statSync(dir).mtimeMs });
    } catch { /* 单目录失败跳过 */ }
  }
  let removed = 0, freedBytes = 0;
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (e.fp === keep) continue;
    try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch { continue; } // 占用中跳过
    total -= e.size;
    removed++;
    freedBytes += e.size;
  }
  return { removed, freedBytes, totalBytes: total };
}

/** 写入后节流触发（60s 一次）：预加载批量写盘时不会每条都全树遍历 */
function enforceCacheBudgetThrottled(keepFingerprint) {
  const now = Date.now();
  if (now - _lastBudgetCheckAt < 60000) return null;
  _lastBudgetCheckAt = now;
  try { return enforceCacheBudget(keepFingerprint); } catch { return null; }
}

module.exports = { CACHE_TTL_MS, CACHE_MAX_BYTES, ROOT, profileFromConfig, pathsFor, load, saveItem, markFailed, clear, readAudio, readAudioById, findCachedAudio, findItemText, listFingerprints, clearOldFingerprints, dirSizeBytes, enforceCacheBudget, enforceCacheBudgetThrottled, findItemNormalized };

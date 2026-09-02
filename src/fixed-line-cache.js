"use strict";

const fs = require("fs");
const path = require("path");
const storage = require("./storage");
const { buildManifest, cacheKey, summarize, voiceFingerprint } = require("./fixed-lines");

const ROOT = path.resolve(storage.PATHS.audio, "fixed-lines");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
  const cloud = cfg.ttsCloud || {};
  const cosy = cfg.ttsCosy || {};
  const useGenie = !!genie.enabled;
  const useCosy = !useGenie && !!cosy.enabled;
  const useEdge = !useGenie && !useCosy && !!cloud.enabled;
  return {
    engine: useGenie ? "genie" : useCosy ? "cosy" : useEdge ? "edge" : "system",
    language: genie.speakJa ? "ja" : "zh",
    voice: useGenie ? "" : useCosy ? cosy.voice : useEdge ? cloud.voice : tts.voice,
    referenceAudio: useGenie ? path.basename(String(genie.refAudio || "")) : "",
    referenceText: useGenie ? genie.refText : "",
    rate: useGenie ? "" : useCosy ? cosy.rate : useEdge ? cloud.rate : tts.rate,
    pitch: useGenie ? "" : useCosy ? cosy.pitch : useEdge ? cloud.pitch : tts.pitch
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
      if (record.state === "ready" && Date.now() - (Number(record.updatedAt) || 0) <= CACHE_TTL_MS && record.audioFile === safeId(item.id) + ".audio") {
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

function readAudio(profile, item) {
  if (!item || !item.id) return null;
  const paths = pathsFor(profile);
  const disk = readJson(paths.manifest) || {};
  const record = disk.items && disk.items[cacheKey(item, profile)];
  if (!record || record.state !== "ready" || record.audioFile !== safeId(item.id) + ".audio") return null;
  if (Date.now() - (Number(record.updatedAt) || 0) > CACHE_TTL_MS) return null;
  try { return fs.readFileSync(audioPath(paths.dir, item.id)); } catch { return null; }
}

function findCachedAudio(profile, text, emotion, vars = {}) {
  const expected = String(emotion || "idle");
  const item = buildManifest(vars).find((candidate) => candidate.text === String(text || "") && candidate.emotion === expected);
  return item ? readAudio(profile, item) : null;
}

module.exports = { CACHE_TTL_MS, ROOT, profileFromConfig, pathsFor, load, saveItem, markFailed, clear, readAudio, findCachedAudio };

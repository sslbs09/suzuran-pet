"use strict";

const fs = require("fs");
const storage = require("./storage");

const KEYS = ["chatApiKey", "ttsCosyApiKey", "agentBearerToken"];
let safeStorage = null;
let state = { available: false, values: {}, unreadable: new Set() };

function readEnvelope() {
  try {
    const raw = JSON.parse(fs.readFileSync(storage.PATHS.secrets, "utf8"));
    return raw && raw.version === 1 && raw.secrets && typeof raw.secrets === "object" ? raw : { version: 1, secrets: {} };
  } catch { return { version: 1, secrets: {} }; }
}
function writeEnvelope(envelope) {
  storage.atomicWrite(storage.PATHS.secrets, JSON.stringify(envelope, null, 2));
}
function initialize(api) {
  safeStorage = api || null;
  state = { available: !!(safeStorage && safeStorage.isEncryptionAvailable()), values: {}, unreadable: new Set() };
  if (!state.available) return status();
  const envelope = readEnvelope();
  for (const key of KEYS) {
    const item = envelope.secrets[key];
    if (!item || !item.ciphertext) continue;
    try { state.values[key] = safeStorage.decryptString(Buffer.from(item.ciphertext, "base64")); }
    catch { state.unreadable.add(key); }
  }
  return status();
}
function status(key) {
  const one = (name) => ({ saved: !!state.values[name], unreadable: state.unreadable.has(name), available: state.available });
  return key ? one(key) : Object.fromEntries(KEYS.map((name) => [name, one(name)]));
}
function get(key) { return state.values[key] || ""; }
function replace(values) {
  if (!state.available) throw new Error("安全存储不可用");
  const envelope = readEnvelope();
  for (const [key, value] of Object.entries(values || {})) {
    if (!KEYS.includes(key)) continue;
    if (value == null) continue;
    if (value === "") { delete envelope.secrets[key]; delete state.values[key]; state.unreadable.delete(key); continue; }
    const encrypted = safeStorage.encryptString(String(value));
    envelope.secrets[key] = { v: 1, ciphertext: encrypted.toString("base64") };
    state.values[key] = String(value);
    state.unreadable.delete(key);
  }
  writeEnvelope(envelope);
  return status();
}
function migratePlaintext(rawConfig) {
  if (!state.available) return { migrated: false, reason: "unavailable" };
  const legacy = {
    chatApiKey: rawConfig?.chat?.apiKey || "",
    ttsCosyApiKey: rawConfig?.ttsCosy?.apiKey || "",
    agentBearerToken: rawConfig?.agentApi?.bearerToken || ""
  };
  const pending = {};
  for (const key of KEYS) if (legacy[key] && !get(key)) pending[key] = legacy[key];
  if (!Object.keys(pending).length) return { migrated: false, reason: "none" };
  replace(pending);
  return { migrated: true };
}

module.exports = { initialize, status, get, replace, migratePlaintext };

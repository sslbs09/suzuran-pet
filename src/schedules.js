"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const storage = require("./storage");

const FILE = path.join(storage.PATHS.userDir, "schedules.json");
const MAX_SCHEDULES = 500;
const MAX_TITLE = 160;
const MAX_NOTES = 1000;
const RECURRING = new Set(["none", "daily", "weekly", "monthly"]);

let schedules = [];
let timer = null;
let dispatch = null;

function parseLocal(date, time) {
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = String(time || "").match(/^(\d{2}):(\d{2})$/);
  if (!m || !t) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(t[1]), min = Number(t[2]);
  const value = new Date(y, mo - 1, d, h, min, 0, 0);
  return value.getFullYear() === y && value.getMonth() === mo - 1 && value.getDate() === d && value.getHours() === h && value.getMinutes() === min ? value : null;
}
function localParts(at) {
  const d = new Date(at);
  return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
}
function normalizeRecurrence(value) {
  const raw = String(value || "none").trim().toLowerCase();
  if (RECURRING.has(raw)) return { kind: raw, weekdays: [] };
  const weekly = raw.match(/^weekly:([0-6](?:,[0-6])*)$/);
  if (weekly) return { kind: "weekly", weekdays: [...new Set(weekly[1].split(",").map(Number))].sort() };
  const monthly = raw.match(/^monthly:(3[01]|[12]\d|[1-9])$/);
  if (monthly) return { kind: "monthly", day: Number(monthly[1]) };
  throw new Error("重复规则无效");
}
function recurrenceLabel(record) {
  const r = record.recurrence || { kind: "none" };
  if (r.kind === "weekly" && r.weekdays?.length) return `weekly:${r.weekdays.join(",")}`;
  if (r.kind === "monthly" && r.day) return `monthly:${r.day}`;
  return r.kind || "none";
}
function nextAt(record, after = Date.now()) {
  const base = parseLocal(record.date, record.time);
  if (!base) return null;
  const r = record.recurrence || { kind: "none" };
  if (r.kind === "none") return base.getTime() > after ? base.getTime() : null;
  const candidate = new Date(base);
  const threshold = new Date(after + 1000);
  if (r.kind === "daily") {
    while (candidate <= threshold) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  if (r.kind === "weekly") {
    const days = r.weekdays?.length ? r.weekdays : [base.getDay()];
    while (candidate <= threshold || !days.includes(candidate.getDay())) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  if (r.kind === "monthly") {
    const day = r.day || base.getDate();
    while (candidate <= threshold) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      const last = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
      candidate.setDate(Math.min(day, last));
    }
    return candidate.getTime();
  }
  return null;
}
function normalize(input, source = { type: "manual" }) {
  const title = String(input.title || "").trim();
  if (!title || title.length > MAX_TITLE) throw new Error("日程标题不能为空且最多 160 字");
  const time = String(input.time || "").trim();
  const date = String(input.date || "").trim();
  const base = parseLocal(date, time);
  if (!base) throw new Error("日期或时间无效，请使用 YYYY-MM-DD 和 HH:mm");
  const recurrence = normalizeRecurrence(input.recurrence);
  const enabled = input.enabled !== false && String(input.enabled).toLowerCase() !== "false";
  const emotion = /^[a-z][a-z0-9_-]{0,30}$/i.test(String(input.emotion || "idle")) ? String(input.emotion || "idle") : "idle";
  const notes = String(input.notes || "").trim().slice(0, MAX_NOTES);
  const externalId = String(input.externalId || "").trim().slice(0, 128);
  const fingerprint = externalId || crypto.createHash("sha256").update([title, date, time, recurrenceLabel({ recurrence })].join("\u0000")).digest("hex").slice(0, 24);
  const existing = schedules.find((s) => s.externalId === fingerprint || s.id === input.id);
  const now = Date.now();
  const record = {
    id: existing?.id || crypto.randomUUID(), title, date, time, recurrence, enabled, emotion, notes,
    externalId: fingerprint, source, status: "pending", createdAt: existing?.createdAt || now, updatedAt: now,
    lastFiredAt: existing?.lastFiredAt || null, nextAt: null
  };
  record.nextAt = nextAt(record, now);
  if (recurrence.kind === "none" && !record.nextAt && base.getTime() < now - 24 * 3600e3) record.status = "missed";
  return record;
}
function persist() { storage.atomicWrite(FILE, JSON.stringify({ version: 1, schedules }, null, 2)); }
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    schedules = Array.isArray(raw.schedules) ? raw.schedules : [];
  } catch { schedules = []; }
  const now = Date.now();
  for (const s of schedules) {
    if (s.status === "cancelled" || s.status === "completed") continue;
    if (s.recurrence?.kind === "none" && s.nextAt && s.nextAt < now - 24 * 3600e3) s.status = "missed";
    else if (s.status !== "fired") { s.status = "pending"; s.nextAt = nextAt(s, now - 1000); }
  }
  persist();
  arm();
}
function arm() {
  clearTimeout(timer);
  const pending = schedules.filter((s) => s.enabled && s.status === "pending" && Number.isFinite(s.nextAt));
  if (!pending.length) return;
  const next = pending.reduce((a, b) => a.nextAt < b.nextAt ? a : b);
  timer = setTimeout(tick, Math.max(1000, Math.min(next.nextAt - Date.now(), 60000)));
}
function tick() {
  const now = Date.now();
  let changed = false;
  for (const s of schedules) {
    if (!s.enabled || s.status !== "pending" || !Number.isFinite(s.nextAt) || s.nextAt > now + 500) continue;
    s.status = "fired";
    s.lastFiredAt = now;
    const occurrence = s.nextAt;
    if (s.recurrence?.kind && s.recurrence.kind !== "none") { s.status = "pending"; s.nextAt = nextAt(s, now); }
    else s.nextAt = null;
    changed = true;
    if (dispatch) dispatch({ ...s, occurrenceAt: occurrence });
  }
  if (changed) persist();
  arm();
}
function list() { return schedules.slice().sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity)).map((s) => ({ ...s, recurrence: recurrenceLabel(s), display: s.nextAt ? localParts(s.nextAt) : null })); }
function add(input, source) {
  const item = normalize(input, source);
  const index = schedules.findIndex((s) => s.id === item.id || s.externalId === item.externalId);
  if (index >= 0) schedules[index] = item; else {
    if (schedules.length >= MAX_SCHEDULES) throw new Error("日程数量已达上限");
    schedules.push(item);
  }
  persist(); arm(); return item;
}
function cancel(id) { const s = schedules.find((x) => x.id === id); if (!s) return false; s.status = "cancelled"; s.updatedAt = Date.now(); persist(); arm(); return true; }
function complete(id) { const s = schedules.find((x) => x.id === id); if (!s) return false; s.status = "completed"; s.updatedAt = Date.now(); persist(); arm(); return true; }
function snooze(id, minutes = 10) { const s = schedules.find((x) => x.id === id); if (!s) return false; s.status = "pending"; s.enabled = true; s.nextAt = Date.now() + Math.max(1, Math.min(1440, Number(minutes) || 10)) * 60000; s.updatedAt = Date.now(); persist(); arm(); return true; }
function initialize(onDue) { dispatch = onDue; load(); }
function stop() { clearTimeout(timer); timer = null; }

module.exports = { initialize, stop, list, add, cancel, complete, snooze, normalize, nextAt, parseLocal, localParts, recurrenceLabel };

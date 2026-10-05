"use strict";

/*
 * abdiff.js — Phase 9-B A/B snapshot 公平性验证库（researcher-only tooling）。
 *
 * 两条互补的比较层，必须分开报告（实验纪律：不得把加密随机字节 / 时间戳差异
 * 误报成实验污染）：
 *   1. byte  层：两目录逐文件 sha256/size 对比——report 文件级差异；
 *   2. semantic 层：dump-semantic 语义态深度对比——report 语义级差异，
 *      并判定“唯一 intentional semantic difference 是否恰好是 target mediator fact”。
 */

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const HASH_CAP_BYTES = 8 * 1024 * 1024; // 超大文件只记录 size+mtime，不做全量哈希

/** path.resolve 后强制 target===root 或 startsWith(root + path.sep)，越界一律 throw（Mimosa 收敛）。 */
function resolveInside(root, rel) {
  const target = path.resolve(root, String(rel));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("路径越界（拒绝）: " + target);
  return target;
}

function walkFiles(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = resolveInside(root, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) stack.push(rel ? rel + "/" + name : name);
    } else {
      out.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

function fileFingerprint(root, rel, size, mtimeMs) {
  const fp = { size, mtimeMs, sha256: null };
  if (size <= HASH_CAP_BYTES) {
    try { fp.sha256 = crypto.createHash("sha256").update(fs.readFileSync(resolveInside(root, rel))).digest("hex"); } catch { /* 读取失败保留 null */ }
  }
  return fp;
}

/** 文件级差异：返回按相对路径排序的差异清单（onlyInA / onlyInB / differ）。 */
function byteDiffDirs(dirA, dirB) {
  const map = (dir) => {
    const m = new Map();
    for (const f of walkFiles(dir)) m.set(f.rel, fileFingerprint(dir, f.rel, f.size, f.mtimeMs));
    return m;
  };
  const ma = map(dirA);
  const mb = map(dirB);
  const onlyInA = [], onlyInB = [], differ = [];
  for (const [rel, fp] of ma) {
    if (!mb.has(rel)) onlyInA.push({ rel, ...fp });
    else if (mb.get(rel).sha256 !== fp.sha256) differ.push({ rel, a: fp, b: mb.get(rel) });
  }
  for (const [rel, fp] of mb) if (!ma.has(rel)) onlyInB.push({ rel, ...fp });
  const byRel = (x, y) => x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0;
  return { onlyInA: onlyInA.sort(byRel), onlyInB: onlyInB.sort(byRel), differ: differ.sort(byRel) };
}

/** 事实身份：ts / id 属创建元数据，跨臂比较只看 {type,text,anchor}。 */
function factIdentity(f) {
  return { type: f.type, text: f.text, anchor: f.anchor || null };
}

function factKey(f) {
  return JSON.stringify(factIdentity(f));
}

/** 稳定序列化（键排序），供整体相等性快速判定。 */
function canonicalize(x) {
  if (Array.isArray(x)) return x.map(canonicalize);
  if (x && typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x).sort()) o[k] = canonicalize(x[k]);
    return o;
  }
  return x;
}

/** 递归收集语义差异路径。数组按下标对齐。 */
function deepDiff(a, b, prefix, out) {
  if (JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: prefix, kind: "array-length", a: a.length, b: b.length });
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) deepDiff(a[i], b[i], prefix + "[" + i + "]", out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (!(k in a)) out.push({ path: prefix + "." + k, kind: "only-b", b: b[k] });
      else if (!(k in b)) out.push({ path: prefix + "." + k, kind: "only-a", a: a[k] });
      else deepDiff(a[k], b[k], prefix + "." + k, out);
    }
    return out;
  }
  out.push({ path: prefix, kind: "value", a: a === undefined ? null : a, b: b === undefined ? null : b });
  return out;
}

/** memory.facts 的专用对比：以 fact 身份为集合元素，输出 fact 级差异。 */
function diffFacts(factsA, factsB) {
  const setA = new Map(factsA.map((f) => [factKey(f), f]));
  const setB = new Map(factsB.map((f) => [factKey(f), f]));
  const onlyInA = [], onlyInB = [];
  for (const [k, f] of setA) if (!setB.has(k)) onlyInA.push(factIdentity(f));
  for (const [k, f] of setB) if (!setA.has(k)) onlyInB.push(factIdentity(f));
  return { onlyInA, onlyInB };
}

/**
 * 语义 A/B 对比总报告。
 * @param targetFactType 期望的“唯一 intentional difference”事实 type（如 "history:syn-001"）
 * @returns {{semanticDifferences, factDiff, onlyTargetFactDifference, verdict}}
 *   onlyTargetFactDifference=true ⇔ 除该 fact 的存在性外，语义态逐位一致。
 */
function diffDumps(dumpA, dumpB, targetFactType) {
  const factDiff = diffFacts(dumpA.memory.facts || [], dumpB.memory.facts || []);
  // userDirTag 是 workspace 目录名元数据（arm-X/arm-Y），非实验语义，单独报告
  const strip = (d) => { const c = { ...d, memory: { ...d.memory, facts: [] } }; delete c.userDirTag; return c; };
  const restA = strip(dumpA);
  const restB = strip(dumpB);
  const semanticDifferences = deepDiff(restA, restB, "$", []);
  const aIsTarget = factDiff.onlyInA.length === 1 && factDiff.onlyInA[0].type === targetFactType && factDiff.onlyInB.length === 0;
  const bIsTarget = factDiff.onlyInB.length === 1 && factDiff.onlyInB[0].type === targetFactType && factDiff.onlyInA.length === 0;
  const onlyTargetFactDifference = aIsTarget || bIsTarget;
  const verdict = onlyTargetFactDifference ? "ONLY_TARGET_FACT_DIFFERENCE" : "UNEXPECTED_SEMANTIC_DIFFERENCES";
  const targetFactSide = aIsTarget ? "A" : (bIsTarget ? "B" : null);
  return { semanticDifferences, factDiff, onlyTargetFactDifference, targetFactSide, verdict, targetFactType: targetFactType || null };
}

module.exports = { byteDiffDirs, diffDumps, diffFacts, factIdentity, canonicalize, deepDiff, walkFiles, resolveInside };

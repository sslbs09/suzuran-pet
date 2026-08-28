/**
 * dll-guard.js — 可执行目录 DLL 完整性自检（§14 追加 98，纯逻辑可单测）
 * 防御 DLL 侧载（安全测试 S05 实测：exe 旁放无效 version.dll 会使应用启动失败）：
 * 启动时对比 exe 目录 dll 清单与上次基线——
 * - 新增/被替换的 dll（数量小）→ 判为可疑侧载，调用方告警；
 * - 大量变化（≥3 个且占比 >30%）→ 判为应用升级/重装，自动重建基线（避免升级误报）。
 * 注：无效 dll 在 main.js 之前的原生层就可能导致加载失败，自检的价值是让侧载
 * 企图【可发现、可诊断】；根治需 asar 打包/数字签名（见 NEXT-ACTIONS 行动卡 A）。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const UPGRADE_MIN_CHANGED = 3; // 视为升级的最小变化 dll 数
const UPGRADE_RATIO = 0.3;     // 视为升级的最小变化占比
const MTIME_TOLERANCE_MS = 2000; // mtime 比较容差（文件系统精度/毫秒抖动）

/** 扫描目录下 dll：{ name → {size, mtime} }；目录不存在/不可读返回空对象 */
function snapshotDlls(dir) {
  const out = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.dll$/i.test(f)) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        out[f] = { size: st.size, mtime: st.mtimeMs };
      } catch { /* 单个文件失败跳过 */ }
    }
  } catch { /* 目录不可读 → 空 */ }
  return out;
}

/** 基线对比：{ added, replaced, removed }（added/replaced 为可疑面） */
function diffBaseline(base, cur) {
  const added = [], replaced = [], removed = [];
  for (const name of Object.keys(cur)) {
    if (!(name in base)) added.push(name);
    else if (base[name].size !== cur[name].size
             || Math.abs(base[name].mtime - cur[name].mtime) > MTIME_TOLERANCE_MS) replaced.push(name);
  }
  for (const name of Object.keys(base)) if (!(name in cur)) removed.push(name);
  return { added, replaced, removed };
}

/** 变化是否像应用升级/重装（数量 + 占比双阈值） */
function isUpgrade(changes, curCount) {
  const n = changes.added.length + changes.replaced.length;
  if (n < UPGRADE_MIN_CHANGED) return false;
  if (!(curCount > 0)) return false;
  return n / curCount > UPGRADE_RATIO;
}

/**
 * 决策：{ok:true, note:"ok"|"upgrade", changes} 或
 *       {ok:false, note:"suspicious", suspicious:{added,replaced}, changes}
 */
function decide(base = {}, cur = {}) {
  const changes = diffBaseline(base, cur);
  if (changes.added.length + changes.replaced.length === 0) return { ok: true, note: "ok", changes };
  if (isUpgrade(changes, Object.keys(cur).length)) return { ok: true, note: "upgrade", changes };
  return { ok: false, note: "suspicious", suspicious: { added: changes.added, replaced: changes.replaced }, changes };
}

/**
 * §14 追加 101：批量获取文件的 Authenticode 签名状态（调 PowerShell Get-AuthenticodeSignature）。
 * 返回 [{file, status, hasSigner}]；单个文件失败时该项 hasSigner=false（保守判为未签名）。
 * 判定用「签名者是否存在」而非「是否受信任」——自签/商业证书都算 hasSigner=true，
 * 未签名（含签名损坏）才算 false，正合侧载检测所需（攻击者额外投放的 dll 无签名）。
 */
function signerOf(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths.slice(0, 64) : [];
  if (!paths.length) return [];
  const script = "foreach ($f in $args) { $s = Get-AuthenticodeSignature -LiteralPath $f; [Console]::WriteLine($f + '|' + $s.Status + '|' + ($null -ne $s.SignerCertificate)) }";
  let out = "";
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script, ...paths],
      { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    out = String(r.stdout || "");
  } catch { /* 下沉到解析（无输出 → 全判未签名） */ }
  return parseSignerOutput(out, paths);
}

/** 解析 signerOf 的 powershell 输出行 `path|Status|True/False`；缺失行按未签名兜底 */
function parseSignerOutput(out, expectedPaths) {
  const map = {};
  for (const line of String(out || "").split(/\r?\n/)) {
    const parts = line.split("|"); // Windows 路径不含 '|'，三段稳定
    if (parts.length < 3) continue;
    const p = parts[0];
    const status = String(parts[1] || "").trim();
    const hasSigner = parts[2] === "True";
    map[p] = { status, hasSigner };
  }
  return expectedPaths.map((p) => map[p] || { file: p, status: "missing", hasSigner: false });
}

module.exports = { snapshotDlls, diffBaseline, isUpgrade, decide, signerOf, parseSignerOutput, UPGRADE_MIN_CHANGED, UPGRADE_RATIO };
"use strict";

/* updater.js — asar-swap 自动更新（v2.5.26 ③）
 * 贴合现有「换 app.asar」分发模型：检查 GitHub Release → 下载 app.asar.pending →
 * 退出时由 detached 的 apply-update.ps1 备份+替换+重启。默认手动触发、可回滚。
 * 纯函数（compareSemver）可单测；网络/文件副作用在主干调用。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = "sslbs09/suzuran-pet";

/** 语义版本比较：a>b→1, a<b→-1, 相等→0（容错非数字段） */
function compareSemver(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 给定当前版本与 latest release，返回更新计划或 null */
function buildUpdatePlan({ current, latestTag, assets }) {
  if (!latestTag || compareSemver(latestTag, current) <= 0) return null;
  const asar = (assets || []).find((a) => a.name === "app.asar");
  const ver = (assets || []).find((a) => a.name === "app.asar.version");
  if (!asar || !ver) return null; // 该 release 未带 asar 资产 → 不支持增量更新
  const sums = (assets || []).find((a) => a.name === "SHA256SUMS.txt");
  return {
    version: latestTag,
    asarUrl: asar.browser_download_url,
    verUrl: ver.browser_download_url,
    size: asar.size || 0,
    sumsUrl: sums ? sums.browser_download_url : "",
    sumsDigest: asar.digest || "" // GitHub 资产 digest 字段（"sha256:..."），有则免下载 sums 文件
  };
}

/** 从 SHA256SUMS.txt 文本提取 app.asar 的 sha256 摘要（sha256sum 格式："<hex>  <name>"，兼容 *二进制标记） */
function extractAsarSha256(sumsText) {
  for (const line of String(sumsText || "").split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === "app.asar") return m[1].toLowerCase();
  }
  return "";
}

function resourcesDir() { return process.resourcesPath || path.join(__dirname, ".."); }
function pendingAsar() { return path.join(resourcesDir(), "app.asar.pending"); }
function currentAsar() { return path.join(resourcesDir(), "app.asar"); }

/** 检查更新（fetch GitHub API）。返回 buildUpdatePlan 结果或 null。 */
async function checkForUpdate(currentVersion) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "suzuran-pet" } });
    if (!r.ok) return null;
    const j = await r.json();
    return buildUpdatePlan({ current: currentVersion, latestTag: j.tag_name, assets: j.assets });
  } catch { return null; }
}

/** SHA-256 校验（TD-6）：优先 plan.sumsDigest（GitHub 资产 digest 字段），回退下载 SHA256SUMS.txt */
async function expectedSha256(plan) {
  let expect = String(plan.sumsDigest || "").replace(/^sha256:/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expect) && plan.sumsUrl) {
    try {
      const sr = await fetch(plan.sumsUrl);
      if (sr.ok) expect = extractAsarSha256(await sr.text());
    } catch { /* sums 拉取失败按无校验来源处理 */ }
  }
  return /^[a-f0-9]{64}$/.test(expect) ? expect : "";
}

/** 下载 asar 到 pending（不覆盖正在运行的 asar）。
 *  TD-6：下载后必须做 SHA-256 完整性校验；无任何校验来源或摘要不匹配 → 拒绝写入
 *  pending（fail closed）。返回 {ok, reason}。 */
async function downloadPending(plan) {
  try {
    const r = await fetch(plan.asarUrl);
    if (!r.ok) return { ok: false, reason: "download HTTP " + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || (plan.size && buf.length !== plan.size)) return { ok: false, reason: "size mismatch" };
    const expect = await expectedSha256(plan);
    if (!expect) return { ok: false, reason: "no checksum available" };
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== expect) return { ok: false, reason: "sha256 mismatch" };
    fs.writeFileSync(pendingAsar(), buf);
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 同 downloadPending，但流式读取并回调进度（0-100；content-length 缺失时按 50KB 粒度上报近似值）。
 *  2026-09-03 体验补全：更新包 ~188MB，给用户可见的下载进度。 */
async function downloadPendingProgress(plan, onProgress = () => {}) {
  try {
    const r = await fetch(plan.asarUrl);
    if (!r.ok) return { ok: false, reason: "download HTTP " + r.status };
    const total = Number(r.headers.get("content-length")) || Number(plan.size) || 0;
    let buf;
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader();
      const chunks = [];
      let got = 0, lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        const pct = total ? Math.min(99, Math.floor((got * 100) / total)) : Math.min(99, Math.floor(got / 51200));
        if (pct > lastPct) { lastPct = pct; onProgress(pct); }
      }
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf.length || (plan.size && buf.length !== plan.size)) return { ok: false, reason: "size mismatch" };
    const expect = await expectedSha256(plan);
    if (!expect) return { ok: false, reason: "no checksum available" };
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== expect) return { ok: false, reason: "sha256 mismatch" };
    fs.writeFileSync(pendingAsar(), buf);
    onProgress(100);
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 退出时替换：写 apply-update.ps1（等退出→备份→pending 覆盖→重启→健康检查失败自动回滚），
 *  detached 启动后由调用方 quit。
 *  TD-6 回滚语义：重启 25s 后进程若已不在（新 asar 启动即崩），用 .bak 恢复上一版并再拉起。 */
function applyOnExit(exePath) {
  const res = resourcesDir();
  const ps1 = path.join(res, "apply-update.ps1");
  const script = [
    "param($exe,$res)",
    "$asar=Join-Path $res 'app.asar'; $pending=Join-Path $res 'app.asar.pending'",
    "Start-Sleep 2",
    "if (Test-Path $asar) { Copy-Item $asar \"$asar.bak\" -Force }",
    "if (Test-Path $pending) {",
    "  Move-Item $pending $asar -Force",
    "  Start-Process $exe",
    "  Start-Sleep 25",
    "  $alive=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -gt 0",
    "  if (-not $alive -and (Test-Path \"$asar.bak\")) {",
    "    Copy-Item \"$asar.bak\" $asar -Force   # 健康检查失败：新 asar 没能存活，回滚上一版",
    "    Start-Process $exe",
    "    Write-Host 'update rolled back: new asar failed health check'",
    "  }",
    "} else { Write-Host 'no pending' }",
  ].join("\n");
  try {
    fs.writeFileSync(ps1, script);
    const { spawn } = require("child_process");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, exePath, res], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { compareSemver, buildUpdatePlan, extractAsarSha256, checkForUpdate, downloadPending, downloadPendingProgress, applyOnExit, pendingAsar, currentAsar, REPO };
}

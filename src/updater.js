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
  const d = await checkForUpdateDetailed(currentVersion);
  return d.ok ? d.plan : null;
}

/** 检查更新（详细版，2026-09-03 审计）：区分「网络失败」与「已是最新」——
 *  此前 checkForUpdate 把两者都折叠成 null，托盘/设置页会把"连不上 GitHub"
 *  误报成"已是最新版本"，他人网络不通时永远以为没有新版本。15s 超时防挂死。 */
const CHECK_TIMEOUT_MS = 15000;
async function checkForUpdateDetailed(currentVersion) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "suzuran-pet" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    if (!r.ok) return { ok: false, plan: null, error: "GitHub API HTTP " + r.status };
    const j = await r.json();
    return { ok: true, plan: buildUpdatePlan({ current: currentVersion, latestTag: j.tag_name, assets: j.assets }), error: "" };
  } catch (e) {
    return { ok: false, plan: null, error: String((e && e.message) || e) };
  }
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

/** 退出时替换：写 apply-update.ps1（等退出→备份→pending 覆盖→重启）+ health-check.ps1
 *  （25s 后探活，失败用 .bak 回滚再拉起），cmd start 解耦生命周期后由调用方 quit。
 *  v2.5.28 发布实验实测两个静默失效点，已修：
 *  ① ps1 含中文注释（UTF-8 无 BOM 被 PS5.1 按 ANSI 解析）可致整脚本解析失败——现 ASCII-only；
 *  ② spawn detached 从垂死 Electron 直接启动 powershell 可能静默不存在——现经 cmd start
 *     解耦进程树，且每步写 apply-update.log、spawn error 也落盘，失败不再不可见。 */
function applyOnExit(exePath) {
  const res = resourcesDir();
  const ps1 = path.join(res, "apply-update.ps1");
  const hc = path.join(res, "health-check.ps1");
  const log = path.join(res, "apply-update.log");
  const ps1Script = [
    "param($exe,$res)",
    "$log = Join-Path $res 'apply-update.log'",
    "function Log($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m) }",
    "Log 'start'",
    "$asar = Join-Path $res 'app.asar'",
    "$pending = Join-Path $res 'app.asar.pending'",
    "Start-Sleep 2",
    "if (Test-Path $asar) { Copy-Item $asar ($asar + '.bak') -Force; Log 'backup ok' }",
    "if (Test-Path $pending) {",
    "  Move-Item $pending $asar -Force",
    "  Log 'asar swapped'",
    "  Start-Process explorer.exe -ArgumentList ('\"' + $exe + '\"')",
    "  Log 'app started (via explorer, clean desktop ancestry)'",
    "  Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $res 'health-check.ps1')) -WindowStyle Hidden",
    "  Log 'health check armed'",
    "} else { Log 'no pending' }",
  ].join("\n");
  // health-check 路径烘焙（v2.5.28 发布实验迭代⑤）：PS5.1 Start-Process -ArgumentList
  // 不给含空格元素加引号 → 运行期传 $exe/$res 会被首个空格截断 → 探活永远 False →
  // 把活着的 2.5.28 当死例杀掉回滚（12:40 目击）。烘焙为字面量后零运行期参数。
  const psql = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PS 单引号字面量转义
  const hcScript = [
    "$exe = " + psql(exePath),
    "$res = " + psql(res),
    "$log = Join-Path $res 'apply-update.log'",
    "function Alive() { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -gt 0 }",
    "Start-Sleep 25",
    "if (Alive) { Add-Content -Path $log -Value 'health check ok'; exit }",
    "Start-Sleep 10",
    "if (Alive) { Add-Content -Path $log -Value 'health check ok (retry)'; exit }",
    "Add-Content -Path $log -Value 'health check failed: new instance died, cleaning up'",
    "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force",
    "$bak = Join-Path $res 'app.asar.bak'",
    "if (Test-Path $bak) {",
    "  Copy-Item $bak (Join-Path $res 'app.asar') -Force",
    "  Add-Content -Path $log -Value 'rolled back to previous version'",
    "  Start-Process explorer.exe -ArgumentList ('\"' + $exe + '\"')",
    "  Add-Content -Path $log -Value 'relaunched via explorer'",
    "} else { Add-Content -Path $log -Value 'no backup, cannot roll back' }",
  ].join("\n");
  try {
    // BOM 前缀（v2.5.28 实验迭代⑥）：hc 内嵌中文路径字面量，UTF-8 无 BOM 被 PS5.1 按
    // ANSI 读 → 路径乱码 → 探活永远 False → 误杀活实例+回滚失效。带 BOM 后 PS5.1 正确解码。
    fs.writeFileSync(ps1, "\ufeff" + ps1Script, "utf8");
    fs.writeFileSync(hc, "\ufeff" + hcScript, "utf8");
    // cmd start 解耦：powershell 由 cmd 拉起后即为独立进程（cmd 立即退出），不再依赖
    // 垂死 Electron 存活。不加 windowsVerbatimArguments——让 node 给含空格/中文的路径
    // 自动加引号（verbatim 拼接会在首个空格处截断路径，powershell 收到残缺参数静默退出）；
    // start 第一个 token 必须是带引号的标题：'""' 空标题（裸词会被 start 当作待启动命令）。
    const child = spawn("cmd.exe", ["/c", "start", '""', "/min", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, exePath, res], { detached: true, stdio: "ignore" });
    child.on("error", (e) => { try { fs.appendFileSync(log, new Date().toISOString() + " spawn error: " + (e && e.message || e) + "\n"); } catch { /* 忽略 */ } });
    child.unref();
    return true;
  } catch (e) { try { fs.appendFileSync(log, "applyOnExit throw: " + (e && e.message || e) + "\n"); } catch { /* 忽略 */ } return false; }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { compareSemver, buildUpdatePlan, extractAsarSha256, checkForUpdate, checkForUpdateDetailed, downloadPending, downloadPendingProgress, applyOnExit, pendingAsar, currentAsar, REPO };
}

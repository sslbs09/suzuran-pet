/** updater 纯函数单测（node）——版本比较/更新计划/SHA-256 校验（v2.5.26 ③ + TD-6） */
"use strict";
const { compareSemver, buildUpdatePlan, extractAsarSha256, downloadPending } = require("../src/updater");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

assert("2.5.26>2.5.25", compareSemver("v2.5.26", "2.5.25") === 1);
assert("2.5.25<2.5.26", compareSemver("2.5.25", "v2.5.26") === -1);
assert("相等", compareSemver("2.5.26", "v2.5.26") === 0);
assert("主版本比较", compareSemver("3.0.0", "2.9.9") === 1);

const assets = [
  { name: "app.asar", browser_download_url: "https://x/app.asar", size: 100 },
  { name: "app.asar.version", browser_download_url: "https://x/v" },
];
assert("有新版+有资产→计划", buildUpdatePlan({ current: "2.5.25", latestTag: "v2.5.26", assets }).version === "v2.5.26");
assert("同版本→null", buildUpdatePlan({ current: "2.5.26", latestTag: "v2.5.26", assets }) === null);
assert("无 asar 资产→null", buildUpdatePlan({ current: "2.5.25", latestTag: "v2.5.26", assets: [] }) === null);

// TD-6：计划带 SHA256SUMS 资产与 digest 字段
const assetsFull = assets.concat([
  { name: "SHA256SUMS.txt", browser_download_url: "https://x/SHA256SUMS.txt" },
]);
const planFull = buildUpdatePlan({ current: "2.5.25", latestTag: "v2.5.27", assets: assetsFull });
assert("计划含 sumsUrl", planFull.sumsUrl === "https://x/SHA256SUMS.txt");
assert("无 sums 资产→sumsUrl 空", buildUpdatePlan({ current: "2.5.25", latestTag: "v2.5.27", assets }).sumsUrl === "");

// TD-6：SHA256SUMS.txt 提取（sha256sum 格式 "<hex>  <name>"，兼容 * 二进制标记）
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
assert("提取 app.asar 行", extractAsarSha256(A + "  app.asar\n" + B + "  app.asar.version\n") === A);
assert("提取 *app.asar 行", extractAsarSha256(C + " *app.asar") === C);
assert("无 app.asar 行→空", extractAsarSha256(B + "  other.zip") === "");
assert("空文本→空", extractAsarSha256("") === "");

// TD-6：downloadPending 完整性校验（fail closed），pending 只写入校验通过的内容
(async () => {
  const tmpRes = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-upd-"));
  process.resourcesPath = tmpRes;
  const data = Buffer.from("fake-asar-bytes-16b");
  const goodDigest = "sha256:" + crypto.createHash("sha256").update(data).digest("hex");
  const pend = path.join(tmpRes, "app.asar.pending");
  const asarBuf = () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  // 网络打桩：asarUrl 返回假包，SHA256SUMS.txt 返回正确摘要行（先装 mock，避免用例打到真实网络）
  globalThis.fetch = async (url) => (String(url).includes("SHA256SUMS")
    ? { ok: true, status: 200, text: async () => crypto.createHash("sha256").update(data).digest("hex") + "  app.asar\n" }
    : { ok: true, status: 200, arrayBuffer: async () => asarBuf() });

  let dl = await downloadPending({ asarUrl: "https://x/app.asar", size: data.length, sumsUrl: "", sumsDigest: goodDigest.slice(0, -4) + "0000" });
  assert("摘要不匹配→拒绝", dl.ok === false && /mismatch/.test(dl.reason));
  assert("拒绝时不落 pending", !fs.existsSync(pend));

  dl = await downloadPending({ asarUrl: "https://x/app.asar", size: data.length, sumsUrl: "", sumsDigest: "" });
  assert("无校验来源→拒绝（fail closed）", dl.ok === false && /no checksum/.test(dl.reason));

  dl = await downloadPending({ asarUrl: "https://x/app.asar", size: data.length, sumsUrl: "", sumsDigest: goodDigest });
  assert("digest 匹配→写 pending", dl.ok === true && fs.existsSync(pend) && fs.readFileSync(pend).equals(data));

  fs.rmSync(pend, { force: true });
  dl = await downloadPending({ asarUrl: "https://x/app.asar", size: data.length, sumsUrl: "https://x/SHA256SUMS.txt", sumsDigest: "" });
  assert("sums 文件校验通过→写 pending", dl.ok === true && fs.existsSync(pend));

  fs.rmSync(tmpRes, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FAIL 异常:", e && e.message); process.exit(1); });

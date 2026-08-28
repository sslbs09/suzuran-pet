/** DLL 完整性自检单测（node，纯函数 + 临时目录） */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("../src/dll-guard");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}

// 1) snapshotDlls：只统计 dll、其他扩展忽略、目录不存在为空
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dllguard-"));
fs.writeFileSync(path.join(dir, "version.dll"), "x");
fs.writeFileSync(path.join(dir, "libEGL.dll"), "y");
fs.writeFileSync(path.join(dir, "readme.txt"), "not-a-dll");
fs.writeFileSync(path.join(dir, "app.exe"), "exe");
const snap = D.snapshotDlls(dir);
has("snapshot 只收 dll 且含 size/mtime", Object.keys(snap).length === 2 && snap["version.dll"].size === 1 && typeof snap["version.dll"].mtime === "number");
has("snapshot 不存在目录 → 空对象", JSON.stringify(D.snapshotDlls(path.join(dir, "missing"))) === "{}");

// 2) diffBaseline：新增/替换/删除/无变化
const base = { "libEGL.dll": { size: 1, mtime: 100 }, "ffmpeg.dll": { size: 2, mtime: 200 } };
const curNoChange = { "libEGL.dll": { size: 1, mtime: 150 }, "ffmpeg.dll": { size: 2, mtime: 2100 } }; // mtime 容差内
has("diff 无变化（mtime 容差内）", JSON.stringify(D.diffBaseline(base, curNoChange)) === '{"added":[],"replaced":[],"removed":[]}');
const curChanged = { "libEGL.dll": { size: 9, mtime: 100 }, "version.dll": { size: 3, mtime: 300 } }; // 替换 + 新增 + ffmpeg 缺失
const d1 = D.diffBaseline(base, curChanged);
has("diff added/replaced/removed 归位", JSON.stringify(d1.added) === '["version.dll"]' && JSON.stringify(d1.replaced) === '["libEGL.dll"]' && JSON.stringify(d1.removed) === '["ffmpeg.dll"]');

// 3) isUpgrade 阈值
has("升级判定边界：2 个变化 → 否", D.isUpgrade({ added: ["a.dll", "b.dll"], replaced: [] }, 10) === false);
has("升级判定：3 个变化且占比>30% → 是", D.isUpgrade({ added: ["a.dll", "b.dll", "c.dll"], replaced: [] }, 8) === true);
has("升级判定：3 个变化但占比≤30% → 否", D.isUpgrade({ added: ["a.dll", "b.dll", "c.dll"], replaced: [] }, 20) === false);
has("升级判定：空目录 → 否", D.isUpgrade({ added: ["a.dll"], replaced: [] }, 0) === false);

// 4) decide 综合
has("decide 无变化 ok", D.decide(base, curNoChange).note === "ok");
const susp = D.decide(base, { "libEGL.dll": { size: 1, mtime: 100 }, "version.dll": { size: 3, mtime: 300 } });
has("decide 单一新增 → suspicious", susp.ok === false && JSON.stringify(susp.suspicious.added) === '["version.dll"]');
const upg = D.decide(base, { "a.dll": { size: 1, mtime: 1 }, "b.dll": { size: 1, mtime: 1 }, "c.dll": { size: 1, mtime: 1 }, "d.dll": { size: 1, mtime: 1 } });
has("decide 大量变化 → upgrade", upg.ok === true && upg.note === "upgrade");

// 5) signerOf / parseSignerOutput（§14 追加 101）
const parsed = D.parseSignerOutput(
  "C:\\x\\a.dll| Valid|True\r\nC:\\x\\b.dll|NotSigned|False\r\n",
  ["C:\\x\\a.dll", "C:\\x\\b.dll", "C:\\x\\c.dll"]
);
has("parse 有签名者", parsed[0].hasSigner === true && parsed[0].status === "Valid");
has("parse 未签名", parsed[1].hasSigner === false && parsed[1].status === "NotSigned");
has("parse 缺失行兜底未签名", parsed[2].hasSigner === false && parsed[2].status === "missing");
// 冒烟：真实 powershell 对未签名临时文件 → hasSigner=false
const fake = path.join(dir, "fakefile.dll");
fs.writeFileSync(fake, "not-a-real-pe");
const sigReal = D.signerOf([fake]);
has("signerOf 真实文件（未签名）→ hasSigner=false", Array.isArray(sigReal) && sigReal[0] && sigReal[0].hasSigner === false);
has("signerOf 空输入 → []", JSON.stringify(D.signerOf([])) === "[]");

// 清理
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\ndll-guard 全部通过 ✅");
process.exit(failed ? 1 : 0);
/** 2.5D 皮肤删除计划单测（node，纯函数） */
"use strict";
const { planRigDelete } = require("../src/rig-delete");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}
const list = [
  { id: "a.psd", file: "C:/rig/a.psd" },
  { id: "b.psd", file: "C:/rig/b.psd" },
  { id: "苏苏洛改妆.PSD", file: "C:/rig/苏苏洛改妆.PSD" },
];

// 正常删除（非当前皮肤）
const r1 = planRigDelete(list, "a.psd", "b.psd");
has("删除非当前皮肤 → 不动当前", r1 && r1.file === "C:/rig/a.psd" && r1.clearCurrent === false);
// 删除当前皮肤 → 需清空并切走
const r2 = planRigDelete(list, "b.psd", "b.psd");
has("删除当前皮肤 → clearCurrent", r2 && r2.clearCurrent === true && r2.file === "C:/rig/b.psd");
// 文件名安全校验
has("非 .psd 拒绝", planRigDelete(list, "a.exe").error === "非法文件名");
has("含路径分隔符拒绝", planRigDelete(list, "..\\..\\x.psd").error === "非法文件名");
has("含正斜杠拒绝", planRigDelete(list, "../x.psd").error === "非法文件名");
has("空 id 拒绝", planRigDelete(list, "").error === "非法文件名");
// 列表存在性（防误删索引/越权）
has("列表不存在该 id → 皮肤不存在", planRigDelete(list, "ghost.psd", "").error === "皮肤不存在");
has("空列表 → 皮肤不存在", planRigDelete([], "a.psd", "").error === "皮肤不存在");
// 大小写不敏感 + 中文名（与 rigSkinList 的 /\.psd$/i 一致）
const r3 = planRigDelete(list, "苏苏洛改妆.PSD", "");
has("中文/大写扩展名皮肤可删", r3 && r3.file === "C:/rig/苏苏洛改妆.PSD" && r3.clearCurrent === false);
has("小写请求匹配大写文件", planRigDelete(list, "苏苏洛改妆.psd").file === "C:/rig/苏苏洛改妆.PSD");

console.log(failed ? `\n${failed} 项失败` : "\nrig-delete 全部通过 ✅");
process.exit(failed ? 1 : 0);
/** 记忆编辑（updateFact）单测（node，临时 userData） */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memedit-"));
process.env.SUZURAN_TEST_USERDIR = tmp;
const M = require("../src/memory");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}

M.clear();
// 造一条事实
M.addFacts([{ type: "pref", text: "博士喜欢喝甘菊茶" }]);
const list = M.getFactsList();
const id = list[0].id;
has("初始有 1 条", list.length === 1);

// 正常编辑
has("编辑成功", M.updateFact(id, "博士现在喜欢喝药茶") === true);
const after = M.getFactsList();
has("文本已更新", after[0].text === "博士现在喜欢喝药茶");
has("类型保留", after[0].type === "pref");
has("id 不变", after[0].id === id);

// 边界
has("无变化视为成功", M.updateFact(id, "博士现在喜欢喝药茶") === true);
has("空文本被拒", M.updateFact(id, "   ") === false);
has("超长文本被拒（>120）", M.updateFact(id, "长".repeat(121)) === false);
has("不存在 id 被拒", M.updateFact("ghost-id", "随便什么内容") === false);
has("编辑拒绝后原值未变", M.getFactsList()[0].text === "博士现在喜欢喝药茶");

// 编辑后注入文本包含新内容
has("注入含新内容", M.getText().includes("药茶"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\nmemory-edit 全部通过 ✅");
process.exit(failed ? 1 : 0);
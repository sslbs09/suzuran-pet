/** 世界书（情境按需注入）单测（node，纯函数） */
"use strict";
const W = require("../src/world-info");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}

// 1) 命中激活
has("办公关键词激活", W.activeWorldInfos("项目要上线了，今天加班到很晚").length === 1);
has("身体不适激活", W.activeWorldInfos("我好像有点感冒了，嗓子疼").length === 1);
has("深夜激活", W.activeWorldInfos("睡不着，再看会儿手机").length >= 1);
// 2) 无关文本不激活
has("无关文本不激活", W.activeWorldInfos("今天天气不错，云很漂亮").length === 0);
has("空文本不激活", W.activeWorldInfos("").length === 0);
has("纯空白不激活", W.activeWorldInfos("   ").length === 0);
// 3) 多命中按序截断（max=2）
const multi = W.activeWorldInfos("加班好累，感冒了还睡不着");
has("多条目命中且被 max 截断", multi.length <= 2 && multi.length >= 1);
const all = W.activeWorldInfos("加班好累，感冒了还睡不着，点个外卖", W.BOOKS, 10);
has("max=10 时全命中不重复", all.length === 5 && new Set(all).size === all.length);
// 4) 内容非空且与 persona 一致的"情境引导"风格（不含角色身份强加）
has("条目内容均非空", W.BOOKS.every((b) => typeof b.content === "string" && b.content.length > 10));
has("条目结构完整", W.BOOKS.every((b) => Array.isArray(b.keywords) && b.keywords.length >= 1 && b.name));
// 5) 自定义 books 注入可用
const custom = [{ name: "x", keywords: ["限定语"], content: "自定义块" }];
has("自定义书生效", W.activeWorldInfos("这是限定语测试", custom).length === 1);
has("自定义书未命中不出块", W.activeWorldInfos("无关键", custom).length === 0);

console.log(failed ? `\n${failed} 项失败` : "\nworld-info 全部通过 ✅");
process.exit(failed ? 1 : 0);
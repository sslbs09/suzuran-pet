"use strict";
/* rp-render 单测：RP 动作解析 / 富渲染截断 / 朗读剥离（清单#8 防回归） */
const { parseRpSegments, renderRpSlice, escHtml, stripRpActions } = require("../renderer/rp-render.js");

let pass = 0, total = 0;
function ok(name, cond) { total++; if (cond) { pass++; console.log("✓", name); } else console.log("✗", name); }

// 解析
const segs = parseRpSegments("*摸摸头* 博士辛苦了！（递过一杯热可可）要休息一下吗？");
ok("分段数=4", segs.length === 4);
ok("首段是动作", segs[0].rp === true && segs[0].text === "*摸摸头*");
ok("中段台词", segs[1].rp === false && segs[1].text.includes("博士辛苦了"));
ok("全角括号动作", segs[2].rp === true && segs[2].text === "（递过一杯热可可）");
ok("尾段台词", segs[3].rp === false);

// 无 RP 标记
const plain = parseRpSegments("普通一句话");
ok("纯文本单段且非动作", plain.length === 1 && plain[0].rp === false);

// 渲染
const html = renderRpSlice("*挥手* 你好", 100);
ok("动作包斜体 span", html.includes('<span class="rp-action">*挥手*</span>'));
ok("台词已转义拼接", html.includes("你好"));
ok("无裸星号残留于标签外", html.startsWith('<span class="rp-action">'));

// 打字机截断：前 3 个字符（动作未完成）
const slice3 = renderRpSlice("*挥手* 你好", 3);
ok("截断渲染含未闭合动作 span", slice3.includes('<span class="rp-action">*挥') || slice3.includes("<span"));

// 转义安全
const safe = renderRpSlice("<script>alert(1)</script>", 100);
ok("HTML 转义防注入", !safe.includes("<script>"));

// 朗读剥离
ok("stripRpActions 去动作", stripRpActions("*摸摸头* 辛苦了") === " 辛苦了");
ok("stripRpActions 无动作不变", stripRpActions("普通句子") === "普通句子");

console.log(`\n${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);

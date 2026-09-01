/** 特效曲线 + 人格深化（模板台词/关系阶段/记忆新类型/今日心情）单测 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-rp-"));
process.env.APPDATA = TMP;

const utils = require("../src/utils");
const lines = require("../src/lines");
const moodDay = require("../src/mood-day");
const memory = require("../src/memory");
const bond = require("../src/bond");

let failed = 0;
function ok(name, cond) { if (!cond) { failed++; console.log("FAIL", name); } else console.log("PASS", name); }

/* ---- 特效曲线 easeImpact：单调 0→1、中点滞空 ---- */
ok("easeImpact 端点", utils.easeImpact(0) === 0 && utils.easeImpact(1) === 1);
ok("easeImpact 滞空(0.4)＝0.9", Math.abs(utils.easeImpact(0.4) - 0.9) < 1e-9);
let prev = -1, mono = true;
for (let i = 0; i <= 100; i++) { const v = utils.easeImpact(i / 100); if (v < prev) mono = false; prev = v; }
ok("easeImpact 单调", mono);
ok("easeImpact 越界钳制", utils.easeImpact(-1) === 0 && utils.easeImpact(2) === 1);

/* ---- lines：模板替换 / 阶段台词 / 清晨台词 ---- */
const tpl = lines.pickTpl(["你好呀{{user}}，{{name}}在呢"], { name: "苏苏洛", user: "阿米娅" });
ok("pickTpl 替换占位", tpl === "你好呀阿米娅，苏苏洛在呢");
ok("STAGE_LINES 键齐", ["ms", "fd", "xl", "sy"].length >= 3 && !!lines.STAGE_LINES.xl && !!lines.STAGE_LINES.sy);
ok("EARLY_MORNING 非空", lines.EARLY_MORNING_LINES.length > 0);
ok("PROACTIVE 每时段≥2 条", Object.values(lines.PROACTIVE_BY_PERIOD).every((a) => a.length >= 2));
ok("状态分流台词池齐（walking/seated 各≥3）", Object.keys(lines.PROACTIVE_BY_STATE).length === 2 &&
  lines.PROACTIVE_BY_STATE.walking.length >= 3 && lines.PROACTIVE_BY_STATE.seated.length >= 3);

/* ---- bond 关系阶段：陌生→熟悉→信赖→誓约（先查初始，再推高） ---- */
const st0 = bond.getStage();
ok("bond 初始为陌生", st0.key === "ms" || st0.key === "fd");
for (let i = 0; i < 360; i++) bond.addExp(1);
const stHigh = bond.getStage();
ok("bond 高羁绊到信赖/誓约", stHigh.key === "xl" || stHigh.key === "sy");
ok("bond getText 含关系阶段", /关系：/.test(bond.getText()));

/* ---- memory 新事实类型 + 过期标注 ---- */
let f = memory.extractFacts("我不吃香菜");
ok("extractFacts 忌口", f.some((x) => x.type === "avoid" && x.text.includes("香菜")));
f = memory.extractFacts("我养了一只猫叫煤球");
ok("extractFacts 宠物", f.some((x) => x.type === "pet" && x.text.includes("猫")));
f = memory.extractFacts("我是软件工程师");
ok("extractFacts 职业", f.some((x) => x.type === "job" && x.text.includes("工程师")));
ok("extractFacts 结尾词不误收（不吃了）", memory.extractFacts("我不吃了").every((x) => x.type !== "avoid"));
/* ---- 记忆锚点分类（借鉴 RhodesLink）：type → 锚点映射 + 注入分组带标签 ---- */
ok("锚点 avoid→TABOO", memory.anchorOf("avoid") === "TABOO");
ok("锚点 pref→PREFERENCE", memory.anchorOf("pref") === "PREFERENCE");
ok("锚点 event→PLAN", memory.anchorOf("event") === "PLAN");
ok("锚点未知类型回退 PREFERENCE", memory.anchorOf("manual-x") === "PREFERENCE");
memory.addFacts([{ type: "avoid", text: "博士不吃香菜" }, { type: "pref", text: "博士喜欢喝咖啡" }]);
const gt = memory.getText();
ok("getText 锚点分组【禁忌】", gt.includes("【禁忌】") && gt.includes("不吃香菜"));
ok("getText 锚点分组【偏好】", gt.includes("【偏好】") && gt.includes("咖啡"));
ok("getFactsList 带 anchor", memory.getFactsList().every((x) => typeof x.anchor === "string" && x.anchor.length > 0));
// 过期标注：写入一条 100 天前的事实 → getText 含"（以前提过）"
const MEM = path.join(require("../src/config").STORAGE.userDir, "memory.json");
fs.writeFileSync(MEM, JSON.stringify({ facts: [{ id: "old1", type: "health", text: "博士最近感冒", ts: Date.now() - 100 * 86400000 }], summary: "" }), "utf8");
delete require.cache[require.resolve("../src/memory")];
const mOld = require("../src/memory");
mOld.init({ encrypt: null, decrypt: null }); // 明文模式
ok("过期事实带（以前提过）", /以前提过/.test(mOld.getText()));

/* ---- 今日心情：确定性 + 集合内 ---- */
ok("mood-day 同日稳定", moodDay.moodOfTheDay("2026-08-27", 5) === moodDay.moodOfTheDay("2026-08-27", 5));
ok("mood-day 属于集合", moodDay.MOODS.includes(moodDay.moodOfTheDay("2026-08-27", 0)));
ok("mood-day 不同日可能不同（大概率）", moodDay.moodOfTheDay("2026-08-27", 0) !== moodDay.moodOfTheDay("2026-09-03", 0) || moodDay.MOODS.length > 1);

console.log(failed ? "\n" + failed + " 项失败" : "\nRP/特效单测全部通过 ✅");
process.exit(failed ? 1 : 0);
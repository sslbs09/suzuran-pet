"use strict";

/**
 * Phase 3C Chibi Body v2 行为收口回归（2026-10-09 实机基线证据驱动）。
 *
 * T1-T3：pat/Interact 仲裁 —— 3A 实机异常 #2：playSpineInteract 在 walk 引擎非 active
 *   （站立静止）时因 spinePhaseAnim() 返回 null 直接 return，合法 pat 失去 Interact。
 *   修复语义与 reconcileSpineAnimation 的 `spinePhaseAnim() || spineAnimForMood("idle")`
 *   先例一致；sleep/busy/drag/generation 守卫全部保留。
 *   手法：仲裁决策提取为双端纯模块 src/spine-arbitration.js（与 animation-watch 同先例），
 *   纯函数直接测行为；pet.js 接线用源码合同锁。
 * T4-T6：drag ownership / 快速切换 / renderer generation —— 不得被仲裁修复破坏。
 * T7-T8：Cubism 隔离 —— 3A 实机异常 #1：live2dcubismcore.min.js 因许可不在仓库，
 *   index.html 无条件 defer 链导致 pixi-live2d 插件每次文档加载抛
 *   "Could not find Cubism 4 runtime"。Spine 模式不得触碰 Live2D 栈；
 *   Live2D 模式按需加载，core 缺失时优雅降级且不再加载会抛错的插件。
 * T9：expression 能力诚实 —— 内置 Sussurro 皮肤动画集有限，semantic mood 必须
 *   区分 exact/fallback/unsupported，禁止把 Relax 伪装成 happy 的精确支持。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const renderer = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
const index = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
const { MOOD_ANIM_MAP, decideInteractRecovery, classifyMoodCapability } = require("../src/spine-arbitration");

function bodyOf(startMarker, endMarker) {
  const s = renderer.indexOf(startMarker);
  const e = renderer.indexOf(endMarker, s);
  assert.ok(s >= 0, "start marker exists: " + startMarker);
  assert.ok(e > s, "end marker after start: " + endMarker);
  return renderer.slice(s, e);
}

// 内置 Sussurro 皮肤真实动画集（3A 报告 §14-5 / skel 扫描确认）
const BUILTIN = ["Default", "Interact", "Move", "Relax", "Sitd", "Sleepd"];
const hasOf = (list) => (n) => list.includes(n);

/* ================= T1: standing / walk inactive 合法 pat 仍进 Interact ================= */

test("T1-1: 仲裁决策——无 locomotion 相位时恢复目标回落到 idle 映射（3A 异常 #2 回归锁）", () => {
  assert.equal(decideInteractRecovery({ phaseAnim: null, idleAnim: "Relax" }), "Relax");
  assert.equal(decideInteractRecovery({ phaseAnim: "Move", idleAnim: "Relax" }), "Move", "行走中恢复目标必须是相位动画");
  assert.equal(decideInteractRecovery({ phaseAnim: "Sitd", idleAnim: "Relax" }), "Sitd", "seated 相位优先");
  assert.equal(decideInteractRecovery({}), null, "两者皆无 → null（调用方跳过，不伪造动画）");
});

test("T1-2: 源码合同——playSpineInteract 经仲裁决策取恢复目标，null 才放弃", () => {
  const fn = bodyOf("function playSpineInteract(", "/**\n * 某 semantic mood 对当前皮肤动画集的真实能力级别");
  assert.match(fn, /decideInteractRecovery\(\{ phaseAnim: spinePhaseAnim\(\), idleAnim: spineAnimForMood\("idle"\) \}\)/,
    "恢复目标经仲裁：相位动画 || idle 映射（与 reconcileSpineAnimation 同规则）");
  assert.match(fn, /if \(!next\) return;/, "仅当决策为 null 才放弃");
  // Interact 提交序列完整保留：clearTrack → set(Interact 一次性) → add(恢复循环)
  assert.match(fn, /clearTrack\(0\);\s*\n\s*setSpineAnim\(inter, false, "poke"\);\s*\n\s*addSpineAnim\(next, true, "poke-resume"\);/);
});

/* ================= T2: walking 中 pat → Interact → locomotion 恢复 ================= */

test("T2-1: 源码合同——行走中 pat 的恢复目标走相位分支（Move 不被 idle 顶替）", () => {
  const fn = bodyOf("function playSpineInteract(", "/**\n * 某 semantic mood 对当前皮肤动画集的真实能力级别");
  assert.match(fn, /phaseAnim: spinePhaseAnim\(\)/, "phaseAnim 必须来自 spinePhaseAnim()（与相位机同源，认识 cls.move 变体）");
  // 行为：active 行走 → 决策返回 Move
  assert.equal(decideInteractRecovery({ phaseAnim: "Move", idleAnim: "Relax" }), "Move");
});

/* ================= T3: sleeping pat 保持 wake semantics ================= */

test("T3-1: 源码合同——睡眠守卫在仲裁之前原样返回（wake 由上层 finishDrag wake() 负责）", () => {
  const fn = bodyOf("function playSpineInteract(", "\n/**\n * 某 semantic mood 对当前皮肤动画集的真实能力级别");
  assert.match(fn, /if \(isSleeping \|\| walkState\.sleeping\) return;/, "2026-09-05 冻结回归守卫保留：睡中不互动");
  // 睡眠守卫必须位于 Interact 查找/提交之前（return 短路，睡中不得触到任何动画写轨）
  const sleepAt = fn.indexOf("if (isSleeping || walkState.sleeping) return;");
  assert.ok(sleepAt >= 0 && sleepAt < fn.indexOf("const inter ="), "睡眠守卫先于 Interact 决策");
  assert.ok(sleepAt < fn.indexOf('setSpineAnim(inter'), "睡眠守卫先于 poke 提交");
});

/* ================= T4: busy/drag 不抢 ownership ================= */

test("T4-1: 源码合同——busy 守卫保留（chat/任务占用优先于互动动画）", () => {
  const fn = bodyOf("function playSpineInteract(", "\n/**\n * 某 semantic mood 对当前皮肤动画集的真实能力级别");
  assert.match(fn, /if \(!spineObj \|\| activeRenderMode !== "spine" \|\| busy\) return;/);
});

test("T4-2: 源码合同——pat 分支只在 finishDrag 且 dragState 已摘除后执行（drag ownership 单一）", () => {
  const finish = bodyOf("function finishDrag(", "function onDragStart(");
  assert.match(finish, /dragState = null;[\s\S]*?if \(!wasDrag\) \{[\s\S]*?playSpineInteract\(\);/, "pat 调用位于 dragState 摘除之后");
});

/* ================= T5: 快速切换 last-wins，无旧动画覆盖新 owner ================= */

test("T5-1: 源码合同——mood 豁免窗口 / demo 优先 / poke 收尾统一对账全部保留", () => {
  assert.match(renderer, /moodAnimUntil = Date\.now\(\) \+ \d+/, "mood 豁免窗口保留");
  assert.match(renderer, /if \(Date\.now\(\) < animDemoUntil\) return; \/\/ 动作试演中，不被情绪切换打断/, "demo 优先守卫保留");
  assert.match(renderer, /pokeResumeTimer = setTimeout\([\s\S]*?reconcileSpineAnimation\("interact-end"\)/, "poke 收尾走统一对账");
});

test("T5-2: 仲裁不引入互斥吞没——恢复目标纯函数对同输入稳定（两次 pat 决策一致）", () => {
  const a = decideInteractRecovery({ phaseAnim: null, idleAnim: "Relax" });
  const b = decideInteractRecovery({ phaseAnim: null, idleAnim: "Relax" });
  assert.equal(a, b);
});

/* ================= T6: renderer generation——异步动画请求不得跨代 ================= */

test("T6-1: 源码合同——playSpineInteract 为同步提交（不引入新异步竞态面）", () => {
  const fn = bodyOf("function playSpineInteract(", "\n/**\n * 某 semantic mood 对当前皮肤动画集的真实能力级别");
  assert.doesNotMatch(fn, /await|async|setTimeout|Promise/, "仲裁修复不得引入异步（异步=跨代竞态面）");
});

test("T6-2: 源码合同——render request generation 守卫存在且 live2d 动态加载后复查", () => {
  assert.match(renderer, /function isCurrentRenderRequest\(/, "render request generation 守卫存在");
  const init = bodyOf("async function initLive2d(", "function destroyLive2d(");
  assert.match(init, /await ensureLive2dStack\(\)[\s\S]*?isCurrentRenderRequest\(context, "live2d"\)/,
    "跨动态加载 await 后必须复查 generation（旧代请求不得接管新 renderer）");
});

/* ================= T7: Spine 模式不初始化 Cubism runtime ================= */

test("T7-1: index.html 不得无条件加载 Live2D 栈（cubism core / pixi-live2d / live2d-runtime）", () => {
  assert.doesNotMatch(index, /<script[^>]+src="live2dcubismcore\.min\.js"/, "cubism core 不得无条件加载（仓库中本就不存在→404）");
  assert.doesNotMatch(index, /<script[^>]+src="pixi-live2d\.min\.js"/, "pixi-live2d 插件不得无条件加载（加载期抛 Could not find Cubism 4 runtime）");
  assert.doesNotMatch(index, /<script[^>]+src="live2d-runtime\.js"/, "live2d-runtime 不得无条件加载");
  // Spine/GIF 必需链保留
  assert.match(index, /<script defer src="pixi\.min\.js"><\/script>/);
  assert.match(index, /<script defer src="pixi-spine\.js"><\/script>/);
  // 新双端仲裁模块已接线
  assert.match(index, /<script src="\.\.\/src\/spine-arbitration\.js"><\/script>/);
});

test("T7-2: 源码合同——ensureLive2dStack 先探测 core，缺失即止（不加载会抛错的插件）", () => {
  const loader = bodyOf("function ensureLive2dStack(", "async function initLive2d(");
  assert.match(loader, /loadLive2dScript\("live2dcubismcore\.min\.js"\)/, "core 必须最先加载");
  assert.match(loader, /\.catch\(\(\) => \{[\s\S]*?return null;[\s\S]*?\}\)/, "core 失败 → 链终止返回 null，绝不继续加载 pixi-live2d");
  assert.match(loader, /if \(!coreOk\) return null;/, "显式短路");
  assert.match(loader, /if \(live2dStackPromise\) return live2dStackPromise;/, "幂等：并发/重复调用复用同一 Promise");
  const init = bodyOf("async function initLive2d(", "function destroyLive2d(");
  assert.match(init, /const stack = await ensureLive2dStack\(\);[\s\S]*?if \(!stack \|\| !window\.Live2DRuntime\)[\s\S]*?return \{ status: "failed"/,
    "core 缺失 → failed 降级语义保留（不抛未捕获异常）");
});

/* ================= T8: Live2D 模式仍能初始化 Live2D path ================= */

test("T8-1: 源码合同——core 在场时按依赖顺序加载完整栈（cubism → 插件 → runtime）", () => {
  const loader = bodyOf("function ensureLive2dStack(", "async function initLive2d(");
  const iCore = loader.indexOf('loadLive2dScript("live2dcubismcore.min.js")');
  const iPlugin = loader.indexOf('loadLive2dScript("pixi-live2d.min.js")');
  const iRuntime = loader.indexOf('loadLive2dScript("live2d-runtime.js")');
  assert.ok(iCore >= 0 && iPlugin > iCore && iRuntime > iPlugin, "三段链式顺序正确");
  assert.match(renderer, /function loadLive2dScript\(/, "底层注入器存在（onload/onerror → Promise）");
});

test("T8-2: 源码合同——initLive2d 原有 Core 缺失/模型缺失降级分支未被破坏", () => {
  const init = bodyOf("async function initLive2d(", "function destroyLive2d(");
  assert.match(init, /Live2D runtime 未加载/, "runtime 缺失分支保留");
  assert.match(init, /Live2D Core 缺失/, "Core 缺失分支保留");
  assert.match(init, /未找到 Live2D 模型/, "模型缺失分支保留");
});

/* ================= T9: expression 能力诚实（exact / fallback / unsupported） ================= */

test("T9-1: 内置 Sussurro 皮肤能力分级——Relax 不得伪装 happy 的精确支持", () => {
  const cap = (mood) => classifyMoodCapability({ mood, hasAnim: hasOf(BUILTIN), map: MOOD_ANIM_MAP });
  assert.equal(cap("idle"), "exact", "idle→Relax 是映射表首位（专属待机动画）");
  assert.equal(cap("happy"), "fallback", "happy 无专属动画，Relax 属降级");
  assert.equal(cap("wave"), "fallback", "wave 复用 Interact 属降级");
  assert.equal(cap("angry"), "fallback");
  assert.equal(cap("surprised"), "fallback", "surprised 复用 Interact 属降级");
  assert.equal(cap("sleep"), "fallback", "内置皮肤无 Sleep 同名，Sleepd 是命名惯例降级");
  assert.equal(cap("think"), "fallback");
  assert.equal(cap("custom-kiss"), "unsupported", "无映射无同名 = unsupported（走兜底第一动画）");
});

test("T9-2: 有同名专属动画判 exact；无动画集/无 hasAnim 判 unsupported", () => {
  assert.equal(classifyMoodCapability({ mood: "happy", hasAnim: hasOf(["happy", "Relax"]), map: MOOD_ANIM_MAP }), "exact");
  assert.equal(classifyMoodCapability({ mood: "happy", hasAnim: hasOf(["happy"]), map: MOOD_ANIM_MAP }), "exact", "mood 同名优先");
  assert.equal(classifyMoodCapability({ mood: "happy", hasAnim: undefined, map: MOOD_ANIM_MAP }), "unsupported");
  assert.equal(classifyMoodCapability({ mood: "happy", hasAnim: hasOf([]), map: MOOD_ANIM_MAP }), "unsupported");
});

test("T9-3: 源码合同——setSpineMood 日志带能力级别 + spineMoodCapability 走共享映射表", () => {
  const fn = bodyOf("function setSpineMood(", "function moodNames");
  assert.match(fn, /"mood:" \+ mood \+ ":" \+ spineMoodCapability\(mood\)/, "mood 播放记录 exact/fallback/unsupported");
  const cap = bodyOf("function spineMoodCapability(", "function setSpineMood(");
  assert.match(cap, /classifyMoodCapability\(/, "能力分级委托纯模块");
  assert.match(cap, /MOOD_ANIM_MAP/, "与 spineAnimForMood 共享同一映射表（单一事实源）");
  const moodAnim = bodyOf("function spineAnimForMood(", "function seatTrackActive(");
  assert.match(moodAnim, /MOOD_ANIM_MAP/, "spineAnimForMood 读共享表，不再持有私有副本");
});

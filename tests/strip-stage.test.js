/** stripStage 单测（node）——TTS 念白剥离（动作/舞台指示）但气泡显示保留（v2.5.26 台词念白合理性） */
"use strict";
const { stripStage } = require("../src/utils");
let failed = 0;
function assert(name, got, want) {
  const ok = got === want;
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}

// 1) 全角括号动作剥离 + 尾部正文保留
assert("全角动作剥离", stripStage("（眯起眼睛）摸头会上瘾的，博士"), "摸头会上瘾的，博士");
// 2) 句首动作剥离后清掉残留顿号
assert("残留标点清理", stripStage("（递）、报错不可怕，可怕的是不喝水"), "报错不可怕，可怕的是不喝水");
// 3) 动作在中段
assert("中段动作剥离", stripStage("（把头凑过去）……再来一下嘛，博士"), "再来一下嘛，博士");
// 4) 无括号文本原样返回
assert("无括号原样", stripStage("博士，早上好呀～今天也要好好照顾自己哦"), "博士，早上好呀～今天也要好好照顾自己哦");
// 5) 半角括号
assert("半角括号", stripStage("(小声)晚安"), "晚安");
// 6) 两组动作
assert("两组动作", stripStage("（伸懒腰）（揉眼睛）这么早就醒了？那我陪你一会儿"), "这么早就醒了？那我陪你一会儿");
// 7) 空入参安全
assert("空入参", stripStage(""), "");
assert("null 入参", stripStage(null), "");
// 8) 全部是动作时返回空（调用方走静音/回退）
assert("纯动作", stripStage("（坐在高处看风景，心情都变好了）"), "");
// 9) 行首【情绪】细标剥离（v2.5.26b：标记只给选音色用，念白/翻译不带）
assert("情绪标记剥离", stripStage("【傲娇】（晃着尾巴）晚上想听我唱歌吗？……才、才不是我想唱！"), "晚上想听我唱歌吗？……才、才不是我想唱！");
assert("情绪标记+无动作", stripStage("【开心】博士要带我去巡房吗？我随时可以出发哦"), "博士要带我去巡房吗？我随时可以出发哦");

process.exit(failed ? 1 : 0);

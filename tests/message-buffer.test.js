/** 消息生成防抖缓冲单测（node，纯状态机，无 Electron） */
"use strict";
const { createDebounceBuffer } = require("../src/message-buffer");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}

// 1) 基本语义：push 覆盖最新、take 取走并清空、clear 丢弃
const b = createDebounceBuffer();
has("初始空", b.has() === false && b.take() === null);
b.push({ id: 1 });
b.push({ id: 2 }); // 覆盖式：只留最新
has("覆盖式只留最新", b.has() === true && b.peek().id === 2);
has("take 取走最新并清空", b.take().id === 2 && b.has() === false);
b.push({ id: 3 });
b.clear(); // 主动停止：丢弃（用户要静默，不是补发）
has("clear 丢弃缓冲", b.has() === false && b.take() === null);
has("push 返回被缓冲条目", b.push({ id: 4 }).id === 4 && b.peek().id === 4);

// 2) 连续快速发送只留最后一条（合并窗口语义的状态面）
const b2 = createDebounceBuffer();
for (let i = 0; i < 10; i++) b2.push({ id: i, text: "msg" + i });
has("连发 10 条只留最后一条", b2.take().id === 9 && b2.has() === false);

// 3) 可复用：取走后再次缓冲
b2.push({ id: 100 });
b2.take();
b2.push({ id: 200 });
has("取走后可再次缓冲", b2.peek().id === 200);

console.log(failed ? `\n${failed} 项失败` : "\nmessage-buffer 全部通过 ✅");
process.exit(failed ? 1 : 0);
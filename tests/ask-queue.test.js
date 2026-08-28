/** /chat 串行化并发锁单测（node，纯 Promise 时序，无 Electron） */
"use strict";
const { createAskQueue } = require("../src/ask-queue");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

(async () => {
  // 1) 串行：按入队顺序执行，前一个完成后一个才开始
  {
    const q = createAskQueue(3);
    const order = [];
    const d1 = deferred();
    const e1 = q.enqueue(() => { order.push(1); return d1.promise; });
    const e2 = q.enqueue(() => { order.push(2); return 2; });
    const e3 = q.enqueue(() => { order.push(3); return 3; });
    has("串行① 三个都入队", !e1.busy && !e2.busy && !e3.busy);
    has("串行② 初始只有第一个在执行", q.size() === 3);
    await new Promise((r) => setTimeout(r, 5));
    has("串行③ 首个未完成前后续未启动", JSON.stringify(order) === JSON.stringify([1]));
    d1.resolve(1);
    has("串行④ 完成顺序", (await Promise.all([e1.done, e2.done, e3.done]))[0] === 1 && JSON.stringify(order) === JSON.stringify([1, 2, 3]));
    has("串行⑤ 全部完成后队列清空", q.size() === 0);
  }
  // 2) 队列满：limit=1 时第二个入队即忙（429 兜底素材）
  {
    const q = createAskQueue(1);
    const d1 = deferred();
    const e1 = q.enqueue(() => d1.promise);
    const e2 = q.enqueue(() => 2);
    has("队列满① 第二个返回 busy", e2.busy === true && e1.busy === false);
    d1.resolve(0);
    await e1.done;
    await new Promise((r) => setTimeout(r, 5));
    const e3 = q.enqueue(() => 3);
    has("队列满② 释放后可再入队", e3.busy === false);
    has("队列满③ 值正确", (await e3.done) === 3);
  }
  // 3) 失败不断链：第一个抛错，后续任务照常执行
  {
    const q = createAskQueue(2);
    const order = [];
    const e1 = q.enqueue(() => { order.push(1); throw new Error("boom"); });
    const e2 = q.enqueue(() => { order.push(2); return "ok2"; });
    let e1Err = null;
    await e1.done.catch((e) => { e1Err = e.message; });
    has("断链① 任务1 的错误传给调用方", e1Err === "boom");
    has("断链② 任务2 仍然执行", (await e2.done) === "ok2");
    has("断链③ 顺序 1→2", JSON.stringify(order) === JSON.stringify([1, 2]));
    has("断链④ 队列清空", q.size() === 0);
    const e3 = q.enqueue(() => 9);
    has("断链⑤ 失败后链仍可用", e3.busy === false && (await e3.done) === 9);
  }
  // 4) 参数边界：非法 limit 回落默认 3
  {
    const q = createAskQueue(-1);
    const r = [];
    for (let i = 0; i < 3; i++) q.enqueue(() => r.push(i));
    await new Promise((res) => setTimeout(res, 5));
    has("边界① 非法 limit 回落 3（可入队 3 个）", r.length === 3);
    const qb = createAskQueue("2");
    const busy = qb.enqueue(() => "x").busy && qb.enqueue(() => "y").busy;
    has("边界② 字符串 limit 被数字强制", busy === false);
  }

  console.log(failed ? `\n${failed} 项失败` : "\nask-queue 全部通过 ✅");
  process.exit(failed ? 1 : 0);
})();
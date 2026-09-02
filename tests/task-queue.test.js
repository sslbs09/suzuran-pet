"use strict";
const assert = require("assert");
const { createTaskQueue } = require("../src/task-queue");

(async () => {
  const queue = createTaskQueue(2);
  let resolve;
  const first = queue.enqueue(() => new Promise((r) => { resolve = r; }));
  const second = queue.enqueue(() => {
    throw new Error("已取消的排队任务不应执行");
  });
  assert.strictEqual(first.busy, false);
  assert.strictEqual(second.busy, false);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(queue.cancel(second.id), true);
  resolve("ok");
  assert.strictEqual(await first.done, "ok");
  await assert.rejects(second.done, /请求已取消/);
  assert.strictEqual(queue.cancelAll(), 0);
  console.log("task-queue 全部通过 ✅");
})().catch((error) => { console.error(error); process.exit(1); });

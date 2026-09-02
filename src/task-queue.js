"use strict";

const { randomUUID } = require("crypto");

function createTaskQueue(maxSize = 3) {
  const limit = Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 3;
  const tasks = new Map();
  let chain = Promise.resolve();

  function snapshot(task) {
    return { id: task.id, state: task.state, createdAt: task.createdAt, startedAt: task.startedAt || 0, finishedAt: task.finishedAt || 0 };
  }

  function enqueue(run, meta = {}) {
    const active = [...tasks.values()].filter((task) => task.state === "queued" || task.state === "running");
    if (active.length >= limit) return { busy: true };
    const task = { id: meta.id || randomUUID(), state: "queued", createdAt: Date.now(), controller: new AbortController() };
    tasks.set(task.id, task);
    const execute = async () => {
      try {
        if (task.state === "cancelled") throw new Error("请求已取消");
        task.state = "running";
        task.startedAt = Date.now();
        return await run({ id: task.id, signal: task.controller.signal });
      } finally {
        if (task.state !== "cancelled") task.state = "completed";
        task.finishedAt = Date.now();
        setTimeout(() => tasks.delete(task.id), 60000).unref?.();
      }
    };
    const done = chain.then(execute);
    chain = done.then(() => undefined, () => undefined);
    done.catch(() => {});
    return { busy: false, id: task.id, done };
  }

  function cancel(id) {
    const task = tasks.get(id);
    if (!task || (task.state !== "queued" && task.state !== "running")) return false;
    task.state = "cancelled";
    task.controller.abort();
    return true;
  }

  function cancelAll() {
    let count = 0;
    for (const task of tasks.values()) if (cancel(task.id)) count++;
    return count;
  }

  function status(id) {
    const task = id ? tasks.get(id) : [...tasks.values()].find((t) => t.state === "running") || [...tasks.values()].find((t) => t.state === "queued");
    return task ? snapshot(task) : null;
  }

  return { enqueue, cancel, cancelAll, status, isBusy: () => [...tasks.values()].some((task) => task.state === "queued" || task.state === "running"), size: () => tasks.size };
}

module.exports = { createTaskQueue };

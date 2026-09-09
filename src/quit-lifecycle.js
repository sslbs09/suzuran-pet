"use strict";

/** 退出生命周期的最小门闩与按步骤清理工具；不依赖 Electron 或业务模块。 */
function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    return fn(...args);
  };
}

function runBoundedStep(step, timeoutMs, onTimeout) {
  const task = Promise.resolve().then(() => {
    if (typeof step !== "function") throw new TypeError("cleanup step must be a function");
    return step();
  });
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) {
    return task.then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error })
    );
  }

  return new Promise((resolve) => {
    let timer = null;
    const finish = once((result) => {
      if (timer) clearTimeout(timer);
      resolve(result);
    });
    timer = setTimeout(() => {
      try {
        const lateCleanup = onTimeout && onTimeout();
        if (lateCleanup && typeof lateCleanup.catch === "function") lateCleanup.catch(() => {});
      } catch { /* 超时兜底不能阻断后续退出 */ }
      finish({ status: "timeout" });
    }, limit);
    task.then(
      (value) => finish({ status: "fulfilled", value }),
      (error) => finish({ status: "rejected", error })
    );
  });
}

async function runCleanupSteps(steps, { onError, onTimeout } = {}) {
  const results = [];
  for (const item of steps) {
    const spec = typeof item === "function" ? { run: item } : (item || {});
    const result = await runBoundedStep(spec.run, spec.timeoutMs, spec.onTimeout);
    results.push(result);
    if (result.status === "rejected") {
      try { if (onError) onError(result.error, spec.name); } catch { /* 错误报告不能阻断清理 */ }
    } else if (result.status === "timeout") {
      try { if (onTimeout) onTimeout(spec.name); } catch { /* 错误报告不能阻断清理 */ }
    }
  }
  return results;
}

/** 处理 before-quit 的一次性启动与“未完成前始终阻止退出”语义。 */
function createQuitLifecycle({
  isCleanupDone,
  isCleanupStarted,
  markCleanupStarted,
  onStart,
  cleanup,
  setCleanupDone,
  requestQuit,
  onError,
}) {
  const report = (error, step) => {
    try { if (onError) onError(error, step); } catch { /* 错误报告不能阻断退出 */ }
  };

  function beforeQuit(event) {
    if (isCleanupDone()) return;
    event.preventDefault();
    if (isCleanupStarted()) return;
    markCleanupStarted();
    try { if (onStart) onStart(); } catch (error) { report(error, "start"); }
    Promise.resolve()
      .then(() => cleanup())
      .catch((error) => report(error, "cleanup"))
      .finally(() => {
        try { setCleanupDone(); } catch (error) { report(error, "complete"); }
        try { requestQuit(); } catch (error) { report(error, "request-quit"); }
      });
  }

  return { beforeQuit };
}

module.exports = { once, runBoundedStep, runCleanupSteps, createQuitLifecycle };

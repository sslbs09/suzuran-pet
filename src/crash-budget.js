"use strict";
// H2 修复：crash 自愈预算按"逻辑窗口域"分桶（纯逻辑，Node 可单测；不依赖 BrowserWindow 对象身份）。
// 原实现 renderCrashCount/renderCrashWindowAt 为全局单桶：辅助窗崩溃消耗主 pet 自愈额度
// （settings 崩 2 次 + pet 崩 1 次 → pet 首崩即被限流：不 bump recovery seq、不 reload，桌宠永久消失）。
// 语义保持不变（阈值与时间窗一个数字都没改）：
//  - 每 domain 独立"windowMs 内最多 limit 次，达到即 limited（调用方停止自动重载）"；
//  - 时间窗锚定该 domain 重置后的首次崩溃，超窗自动开新窗（与原 now-windowAt>60000 逻辑一致）；
//  - limited 后计数继续累计（原"第 N 次"日志语义不变）；
//  - domain=逻辑窗口（"pet" / attachCrashDiag 的固定 label），同种窗口 destroy/recreate 共享桶，
//    换 BrowserWindow 对象不能绕过 loop protection。
// 调用方必须传入固定有限 domain（main.js 全部 label 为硬编码字面量）；本模块不为动态 key 做自动清理。

function createCrashBudget({ limit = 3, windowMs = 60000 } = {}) {
  const buckets = new Map(); // domain -> { windowStartedAt, count }
  return {
    /** 记录一次该 domain 的 renderer 崩溃。now 显式注入（测试可用 fake clock，无需 sleep）。 */
    record(domain, now) {
      let b = buckets.get(domain);
      if (!b || now - b.windowStartedAt > windowMs) b = { windowStartedAt: now, count: 0 }; // 时间窗到期：仅重置本 domain
      b.count += 1;
      buckets.set(domain, b);
      return { count: b.count, limited: b.count >= limit, windowStartedAt: b.windowStartedAt };
    },
    peek(domain) { const b = buckets.get(domain); return b ? { count: b.count, windowStartedAt: b.windowStartedAt } : null; }
  };
}

module.exports = { createCrashBudget };

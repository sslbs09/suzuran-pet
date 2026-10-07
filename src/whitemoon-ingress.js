/**
 * whitemoon-ingress.js — WhiteMoon Runtime Host 集成 ingress 客户端（Phase 11-E.1）。
 *
 * 职责边界（架构 C 冻结）：
 *   - Body 只产生「不透明集成动作」：{ actionId, type: "record-observation", note }。
 *     Body 不知道、也不允许知道它会变成什么 Character Experience（类型/投影/
 *     观察手账/条目数等角色语义全部不在此处）。
 *   - actionId 由主进程在「首次提交尝试」时铸造（crypto.randomUUID）；同一次
 *     用户提交的所有重试（不可用/超时/未知/响应丢失）复用同一个 actionId，
 *     不会因为传输失败而换新标识。
 *   - 没有持久化重试队列：内存里只有一个 pending 槽位（允许 v0.1）。应用重启
 *     后重试身份不保证保留 —— 这是 v0.1 的已知限制，如实记录。
 *
 * 传输结果分级（与 adapter body-client 同一诚实口径）：
 *   recorded / duplicate  确认成功（duplicate 为幂等重复成功）
 *   invalid               请求被拒绝（校验失败；不重试同一标识也无妨）
 *   conflict              同一 actionId 被不同内容复用（显式错误）
 *   failed                明确失败（鉴权/服务端错误；请求已送达并被拒绝）
 *   unavailable           明确的送达前失败（连接被拒等；请求从未到达）
 *   unknown               模糊结果（超时/连接中断/响应不可读；可能已记录）
 */
"use strict";

const DEFAULT_TIMEOUT_MS = 8000;
const ENDPOINT_PATH = "/integration-input";

const PRE_DISPATCH_ERROR_CODES = new Set([
  "ECONNREFUSED", // 对端没有监听 —— Host 未运行
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN"
]);

/**
 * @param {object} deps
 * @param {() => {enabled: boolean, baseUrl: string, token: string}} deps.getEndpoint
 *        每次提交时现取配置（enabled / baseUrl / ingress token）。
 * @param {() => string} deps.newActionId  主进程铸造 UUID（crypto.randomUUID）。
 * @param {typeof fetch} [deps.fetchImpl]  可注入的 fetch（单测）。
 * @param {number} [deps.timeoutMs]
 * @param {(line: string) => void} [deps.log]
 */
function createObservationIngress({ getEndpoint, newActionId, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
  if (typeof getEndpoint !== "function") throw new Error("getEndpoint is required");
  if (typeof newActionId !== "function") throw new Error("newActionId is required");
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw new Error("fetch is not available in this runtime");

  // 唯一的 pending 槽位（主进程内存，非持久化）：{ actionId, note } | null。
  // 只有「确认成功」才会清空它；下一次提交才会铸造新 actionId。
  let pending = null;
  let inFlight = false;

  async function submit(rawNote) {
    const note = String(rawNote ?? "").trim();
    if (!note) {
      // 空内容不是一次提交尝试：不铸造 actionId，不打网络。
      return { state: "invalid", reason: "empty", error: "先写点什么再记录吧" };
    }
    if (inFlight) {
      return { state: "busy", error: "上一次提交还在进行中" };
    }
    inFlight = true;
    try {
      const endpoint = getEndpoint();
      if (!endpoint || !endpoint.enabled) {
        return { state: "disabled", error: "未启用 WhiteMoon 连接（设置中开启后再试）" };
      }
      if (!endpoint.baseUrl || !/^https?:\/\//i.test(String(endpoint.baseUrl))) {
        return { state: "disabled", error: "WhiteMoon Runtime Host 地址未配置" };
      }

      // 重试身份：同一 note 的重试复用同一 actionId；编辑成不同内容 = 用户
      // 放弃了原提交、发起一次全新提交 → 铸造新 actionId。
      if (!pending || pending.note !== note) {
        pending = { actionId: newActionId(), note };
      }
      const actionId = pending.actionId;

      let res;
      try {
        res = await doFetch(String(endpoint.baseUrl).replace(/\/+$/, "") + ENDPOINT_PATH, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {})
          },
          body: JSON.stringify({ actionId, type: "record-observation", note }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (err) {
        const cause = (err && err.cause) || err;
        if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
          // 请求可能已送达并被处理：结果未知，绝不声称失败。
          return { state: "unknown", actionId, error: `Runtime Host ${timeoutMs}ms 内未应答；是否已记录未知` };
        }
        if (cause && PRE_DISPATCH_ERROR_CODES.has(cause.code)) {
          // 明确的送达前失败：请求从未到达 Host。
          return { state: "unavailable", actionId, error: `无法连接 Runtime Host（${cause.code}）` };
        }
        // 连接建立后中断等：送达与否不确定 → 未知。
        return { state: "unknown", actionId, error: `传输结果不明确（${(cause && cause.code) || (err && err.message) || "unknown"}）` };
      }

      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }

      // 归属校验：应答里的 actionId 必须就是本次提交的那个；对不上视为未知。
      const actionIdMatches = !payload || !payload.actionId || payload.actionId === actionId;

      if (res.ok && payload && payload.ok === true && (payload.outcome === "recorded" || payload.outcome === "duplicate")) {
        if (!actionIdMatches) {
          return { state: "unknown", actionId, error: "应答归属无法确认（actionId 不匹配）" };
        }
        pending = null; // 确认成功：清空 pending，下一次提交铸造新 actionId
        return { state: payload.outcome, actionId };
      }
      if (res.status === 400 && payload && payload.ok === false && (payload.outcome === "invalid-action" || payload.outcome === "invalid-content")) {
        return { state: "invalid", actionId, error: payload.error || "提交内容未通过校验" };
      }
      if (res.status === 409 && payload && payload.ok === false && payload.outcome === "conflict") {
        return { state: "conflict", actionId, error: payload.error || "该提交标识已被不同内容使用" };
      }
      if (res.status === 401 || res.status === 403) {
        return { state: "failed", actionId, error: "ingress token 校验失败（请检查 WhiteMoon 连接配置）" };
      }
      // 其他 HTTP 错误：Host 明确拒绝了本次请求（未记录）。
      return {
        state: "failed",
        actionId,
        error: (payload && payload.error) || `Runtime Host 返回 HTTP ${res.status}`
      };
    } finally {
      inFlight = false;
    }
  }

  // 诊断/测试用：当前 pending（同一提交的重试身份）。
  function pendingAction() {
    return pending ? { ...pending } : null;
  }

  return { submit, pendingAction };
}

module.exports = { createObservationIngress, DEFAULT_TIMEOUT_MS, ENDPOINT_PATH };

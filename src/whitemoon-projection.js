/**
 * whitemoon-projection.js — P0-B1 只读 Character Projection 客户端。
 *
 * 架构纪律（任务 §11）：Body 读取 canonical Character Identity/State/Relationship
 * 的唯一通道是 Runtime Host 的窄只读 surface（GET /character-projection）。
 * Body 不直接读 Core Instance JSON、不读 Core store 目录、不复制 Core 持久化
 * 逻辑、不绕过 Host。
 *
 * 每次聊天请求现取一次投影（T4 变化反映 / T8 重启续用）：客户端不缓存任何
 * Character 事实——continuity 来自 Host→Core 的持久化真相，不来自本地缓存。
 *
 * 结果分级（诚实口径，§27 R8）：
 *   ok            200 + status OK：projection 携带 character 块
 *   host_not_ready HOST_NOT_READY
 *   instance_unavailable INSTANCE_UNAVAILABLE
 *   package_mismatch PACKAGE_MISMATCH
 *   unauthorized  401/403（token 问题：明确失败，绝不回退 legacy 伪装成功）
 *   unavailable   送达前连接失败（Host 未运行）
 *   unknown       超时/传输结果不明确
 *   disabled      whitemoonRuntime.enabled=false（调用方本不该构建请求）
 * 任何失败都不得被解释为"空投影成功"：formal mode 下的失败必须由 main 走
 * 明确失败路径，不静默降级（不得 fake formal success）。
 */
"use strict";

const DEFAULT_TIMEOUT_MS = 5000;
const PROJECTION_PATH = "/character-projection";

const PRE_DISPATCH_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN"
]);

function classifyHttpResult(res, payload) {
  if (res.status === 401 || res.status === 403) return { state: "unauthorized" };
  if (res.ok && payload && payload.ok === true && payload.status === "OK" && payload.character) {
    return { state: "ok", projection: payload };
  }
  if (payload && payload.status === "HOST_NOT_READY") return { state: "host_not_ready" };
  if (payload && payload.status === "INSTANCE_UNAVAILABLE") return { state: "instance_unavailable" };
  if (payload && payload.status === "PACKAGE_MISMATCH") return { state: "package_mismatch" };
  return { state: "failed", httpStatus: res.status };
}

/**
 * @param {object} deps
 * @param {() => {enabled: boolean, baseUrl: string, token: string}} deps.getEndpoint
 *        每次读取时现取 whitemoonRuntime 配置（与 observationIngress 同款注入）。
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {number} [deps.timeoutMs]
 */
function createProjectionClient({ getEndpoint, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof getEndpoint !== "function") throw new Error("getEndpoint is required");
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw new Error("fetch is not available in this runtime");

  async function fetchProjection() {
    const endpoint = getEndpoint();
    if (!endpoint || !endpoint.enabled) return { state: "disabled" };
    if (!endpoint.baseUrl || !/^https?:\/\//i.test(String(endpoint.baseUrl))) {
      return { state: "disabled", error: "WhiteMoon Runtime Host 地址未配置" };
    }
    let res;
    try {
      res = await doFetch(String(endpoint.baseUrl).replace(/\/+$/, "") + PROJECTION_PATH, {
        method: "GET",
        headers: { ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return { state: "unknown", error: `Runtime Host ${timeoutMs}ms 内未应答` };
      }
      const cause = (err && err.cause) || err;
      if (cause && PRE_DISPATCH_ERROR_CODES.has(cause.code)) {
        return { state: "unavailable", error: `无法连接 Runtime Host（${cause.code}）` };
      }
      return { state: "unknown", error: `传输结果不明确（${(cause && cause.code) || (err && err.message) || "unknown"}）` };
    }
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    const out = classifyHttpResult(res, payload);
    if (out.state !== "ok" && !out.error) {
      out.error = payload && payload.error ? String(payload.error) : `HTTP ${res.status}`;
    }
    return out;
  }

  async function memoryRequest(route, control) {
    const endpoint = getEndpoint();
    if (!endpoint || !endpoint.enabled) {
      return { ok: false, status: "FORMAL_DISABLED" };
    }
    if (!/^https?:\/\//i.test(String(endpoint.baseUrl || ""))) return { ok: false, status: "MEMORY_UNAVAILABLE" };
    try {
      const res = await doFetch(String(endpoint.baseUrl).replace(/\/+$/, "") + route, {
        method: control === undefined ? "GET" : "POST",
        headers: { ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
          ...(control === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(control === undefined ? {} : { body: JSON.stringify(control) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload = await res.json();
      if (!res.ok || !payload || payload.ok !== true) return { ok: false, status: payload && payload.status || "MEMORY_UNAVAILABLE" };
      return payload;
    } catch {
      // No retry: a POST timeout may have committed. Inspect to learn truth.
      return { ok: false, status: "MEMORY_RESULT_UNKNOWN" };
    }
  }
  return { fetchProjection, inspectMemory: () => memoryRequest("/memory-inspect"),
    controlMemory: (control) => memoryRequest("/memory-control", control) };
}

module.exports = { createProjectionClient, classifyHttpResult, DEFAULT_TIMEOUT_MS, PROJECTION_PATH };

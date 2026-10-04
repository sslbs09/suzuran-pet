"use strict";

/* global window */

/**
 * Error Fact -> presentation Descriptor for the err.* catalog.
 * Only HTTP_ERROR may expose an integer status (100..599); never read message
 * or attach role/character behavior here.
 *
 * Phase 5-G1 — namespace 隔离：
 *   ERROR_PRESENTATIONS 只承载通用错误码（大写，11 个），与 error-facts.ERROR_CODES
 *   逐字同集合。GSV（TTS 引擎重启）的四个小写码曾经混在这张表里，导致
 *   `toPresentation({code:"timeout"})` 与 `toPresentation({code:"TIMEOUT"})`
 *   仅差大小写却落到不同文案，且小写码得以绕过 error-facts.normalizeCode 进入
 *   通用错误事实层。现已拆到 GSV_PRESENTATIONS，通用入口不再认识小写码。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ErrorPresenter = api;
})(typeof window !== "undefined" ? window : null, function () {
  const ERROR_PRESENTATIONS = Object.freeze({
    AUTH_INVALID: "err.authInvalid",
    NO_API_KEY: "err.noApiKey",
    QUOTA_EXCEEDED: "err.quotaExceeded",
    TIMEOUT: "err.timeout",
    NETWORK_ERROR: "err.networkError",
    SSRF_BLOCKED: "err.ssrfBlocked",
    BAD_URL: "err.badUrl",
    HTTP_ERROR: "err.http",
    CANCELLED: "err.cancelled",
    BUSY: "err.busy",
    INTERNAL: "err.internal"
  });

  /* GSV 专用命名空间：仅 pet:restart-gsv 一条链使用，不属于通用错误码词表。
   * 独立 lookup，避免小写码污染 ERROR_PRESENTATIONS（Phase 5-G1）。 */
  const GSV_PRESENTATIONS = Object.freeze({
    timeout: "err.gsvTimeout",
    synth: "err.gsvSynthFail",
    disabled: "err.gsvDisabled",
    nopath: "err.gsvNoPath"
  });

  function toPresentation(input) {
    const payload = input && typeof input === "object" ? input : null;
    const code = payload && typeof payload.code === "string" ? payload.code : "";
    if (!Object.prototype.hasOwnProperty.call(ERROR_PRESENTATIONS, code)) {
      return { key: "err.unknown", params: {} };
    }
    if (code !== "HTTP_ERROR") return { key: ERROR_PRESENTATIONS[code], params: {} };

    const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : null;
    const status = meta && Object.prototype.hasOwnProperty.call(meta, "status") ? meta.status : undefined;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return { key: "err.http", params: { status } };
    }
    return { key: "err.httpGeneric", params: {} };
  }

  /** GSV 专用呈现入口：只在 GSV_PRESENTATIONS 内查找，未命中即 err.unknown。 */
  function toGsvPresentation(input) {
    const payload = input && typeof input === "object" ? input : null;
    const code = payload && typeof payload.code === "string" ? payload.code : "";
    if (!Object.prototype.hasOwnProperty.call(GSV_PRESENTATIONS, code)) {
      return { key: "err.unknown", params: {} };
    }
    return { key: GSV_PRESENTATIONS[code], params: {} };
  }

  return Object.freeze({ ERROR_PRESENTATIONS, GSV_PRESENTATIONS, toPresentation, toGsvPresentation });
});

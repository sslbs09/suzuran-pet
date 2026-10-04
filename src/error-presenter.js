"use strict";

/* global window */

/**
 * Error Fact -> presentation Descriptor for the err.* catalog.
 * Only HTTP_ERROR may expose an integer status (100..599); never read message
 * or attach role/character behavior here.
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
    INTERNAL: "err.internal",
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

  return Object.freeze({ ERROR_PRESENTATIONS, toPresentation });
});

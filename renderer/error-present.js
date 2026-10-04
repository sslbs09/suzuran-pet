/* global window */

/**
 * renderer/error-present.js — 渲染层错误呈现唯一适配器（Phase 5-G2）
 *
 * 迁移前，9 个 renderer 页面各自持有一份 `presentError()` / `presentResultError()`，
 * 逻辑相同、legacy fallback 字段却不一致（有的读 error、有的读 message、有的不回显）。
 * 适配器把它们收敛为一份，行为逐字不变。
 *
 * 流程：
 *   result/error → ErrorPresenter → I18N.t → UI presentation
 *
 * 不变量（与 src/error-presenter.js 的契约一致，此处不做任何映射决策）：
 *  - 有 code 字段即视为「已编码」，即便 code 非法也走 presenter，绝不回落到 legacy 文本，
 *    否则伪造/未知 code 可借 message 绕过技术详情过滤。
 *  - legacy fallback 固定优先级 message → error。之所以可以统一：
 *    主进程 projectedFailure(error, field) 只填**一个**字段，全仓不存在「无 code 且同时带
 *    message 与 error」的返回对象（已实证），故任一顺序都不会改变既有输出。
 *  - 本文件不读 message/meta 以外的任何字段，不引入任何新的映射表。
 *  - 与 renderer/i18n.js 同样以 window.* 为唯一出口（渲染层无 CommonJS）。
 */
(function () {
  "use strict";

  function hasCode(result) {
    return !!(result && typeof result === "object" &&
      Object.prototype.hasOwnProperty.call(result, "code"));
  }

  /** legacy 文本：仅在无 code 时使用。固定优先级 message → error（见文件头说明）。 */
  function legacyText(result) {
    if (!result || typeof result !== "object") return "";
    if (typeof result.message === "string" && result.message) return result.message;
    if (typeof result.error === "string" && result.error) return result.error;
    return "";
  }

  /**
   * 通用错误呈现。
   * @param {*} result IPC 返回值或错误对象
   * @param {{legacy?: boolean}} [opts] opts.legacy === false 时禁用 legacy 原文回显
   *        （条款页这类「一律 err.unknown」的强策略面使用）
   */
  function presentError(result, opts) {
    if (hasCode(result)) {
      const p = window.ErrorPresenter.toPresentation({ code: result.code, meta: result.meta });
      return window.I18N.t(p.key, p.params);
    }
    if (opts && opts.legacy === false) return window.I18N.t("err.unknown");
    return legacyText(result) || window.I18N.t("err.unknown");
  }

  /* ---------- GSV 专用命名空间（Phase 5-G1 引入，此处统一收口） ---------- */

  function isGsvCode(result) {
    const table = window.ErrorPresenter && window.ErrorPresenter.GSV_PRESENTATIONS;
    return !!(hasCode(result) && table && Object.prototype.hasOwnProperty.call(table, result.code));
  }

  /** GSV 引擎专属失败码（timeout/synth/disabled/nopath），不走通用词表。 */
  function presentGsvError(result) {
    const p = window.ErrorPresenter.toGsvPresentation({ code: result && result.code });
    return window.I18N.t(p.key, p.params);
  }

  /**
   * restartGsv 结果呈现：成功走 okText，GSV 码走 GSV 命名空间，其余走通用漏斗。
   * 收口在此，避免每个页面各写一份分流（Phase 5-G1 曾在 settings.js 里新增过一份）。
   */
  function presentRestartGsv(result, okText) {
    if (result && result.ok) return okText;
    return isGsvCode(result) ? presentGsvError(result) : presentError(result);
  }

  window.ErrorPresent = Object.freeze({
    hasCode,
    legacyText,
    presentError,
    presentGsvError,
    isGsvCode,
    presentRestartGsv
  });
})();
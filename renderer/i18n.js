/**
 * 渲染层国际化辅助（配合 src/i18n.js，词典经 IPC pet:get-i18n 从主进程获取）
 * - data-i18n             → textContent
 * - data-i18n-title       → title 属性
 * - data-i18n-placeholder → placeholder 属性
 * - data-i18n-alt         → alt 属性
 * - window.I18N.t(key)    → 动态文案
 * 在页面 <script src="i18n.js"></script> 之后、业务脚本之前加载。
 */
(function () {
  "use strict";
  let _lang = "zh";
  let _dict = {};

  function apply(lang, dict) {
    _lang = lang || "zh";
    _dict = dict || {};
    if (document.documentElement) document.documentElement.lang = _lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n")];
      if (v !== undefined) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-title")];
      if (v !== undefined) el.title = v;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-placeholder")];
      if (v !== undefined) el.placeholder = v;
    });
    document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-alt")];
      if (v !== undefined) el.alt = v;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-aria-label")];
      if (v !== undefined) el.setAttribute("aria-label", v);
    });
  }

  function t(key, params) {
    // effective dict（zh base + selected overlay）已由 main 构造：正常缺键应已在 main 回落 zh；
    // 这里只剩真正未知 key 的 fail-safe——warn 后返回 key 本身（不 throw、不跨语言泄漏）。
    const v = _dict[key];
    if (v === undefined) {
      console.warn("[i18n] renderer missing key:", key);
      return key;
    }
    if (!params || typeof params !== "object") return v;
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
  }

  window.I18N = { apply, t, lang: () => _lang };

  async function init() {
    try {
      if (window.petAPI && window.petAPI.getI18n) {
        const r = await window.petAPI.getI18n();
        apply(r.lang, r.dict);
      }
      if (window.petAPI && window.petAPI.onUiLangChanged) {
        window.petAPI.onUiLangChanged(async (lang) => {
          const r = await window.petAPI.getI18n();
          apply(r.lang, r.dict);
        });
      }
    } catch { /* 忽略 */ }
  }
  init();
})();

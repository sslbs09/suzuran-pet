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
      if (v) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-title")];
      if (v) el.title = v;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-placeholder")];
      if (v) el.placeholder = v;
    });
    document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      const v = _dict[el.getAttribute("data-i18n-alt")];
      if (v) el.alt = v;
    });
  }

  function t(key) {
    return _dict[key] !== undefined ? _dict[key] : key;
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

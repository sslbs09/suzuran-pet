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

  window.I18N = { apply, t, lang: () => _lang, ready: () => _ready, onChange };

  /* ---------- Phase 4-B1：locale 事件单一入口 + 动态 presentation hook ----------
   * 语义（初始化与语言切换共用同一条管线，语言切换不是业务事件）：
   *   getI18n → set effective dict → apply() 静态绑定 → notify 动态 render 回调
   * 回调只允许重绘 presentation（从既有 runtime state），不得发起业务副作用。
   * 注册时若已 ready 立即安全执行一次（免除页面脚本与 i18n 异步初始化的时序依赖）。
   * 页面业务脚本禁止再自行监听 petAPI.onUiLangChanged（单一订阅原则）。 */
  let _ready = false;
  const _renderCallbacks = [];

  function notifyRender() {
    for (const cb of _renderCallbacks.slice()) {
      try { cb(_lang); } catch { /* 单个页面 render 故障不阻断其他页面 */ }
    }
  }

  function onChange(cb) { // 返回 unsubscribe；仅供 presentation 重绘
    if (typeof cb !== "function") return () => {};
    _renderCallbacks.push(cb);
    if (_ready) { try { cb(_lang); } catch { /* 同上 */ } }
    return () => {
      const i = _renderCallbacks.indexOf(cb);
      if (i >= 0) _renderCallbacks.splice(i, 1);
    };
  }

  async function refresh() { // 唯一 locale 数据管线：init 与 ui-lang-changed 共用
    if (!window.petAPI || !window.petAPI.getI18n) return;
    const r = await window.petAPI.getI18n();
    apply(r.lang, r.dict);
    _ready = true;
    notifyRender();
  }

  async function init() {
    try {
      await refresh();
      if (window.petAPI && window.petAPI.onUiLangChanged) {
        window.petAPI.onUiLangChanged(() => { refresh().catch(() => { /* 语言变更刷新失败保持旧 dict，下次事件重试 */ }); });
      }
    } catch { /* 忽略 */ }
  }
  init();
})();

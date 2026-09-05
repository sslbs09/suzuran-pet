/* 主题共享模块（v2.5.26 backlog 收敛）：auto=19 点-6 点深色规则的唯一来源。
   此前 pet.js / docs.js / settings.js / theme-init.js 各持一份拷贝，现统一委托本模块。
   浏览器挂 window.petTheme；Node 单测走 module.exports。 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.petTheme = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /** 主题→是否深色。now 可注入（单测固定小时数） */
  function isDark(theme, now) {
    if (theme === "dark") return true;
    if (theme === "light") return false;
    if (theme === "system") return typeof window !== "undefined" && !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const h = (now || new Date()).getHours();
    return h >= 19 || h < 6; // auto：19 点-6 点
  }
  /** 挂/摘 body.theme-dark */
  function apply(theme) {
    document.body.classList.toggle("theme-dark", isDark(theme));
  }
  /** 辅助窗口引导：打开时读配置 + 订阅主题变更（主进程 v2.5.26 起全窗广播）。
   *  override：主进程 loadFile 经 query 传入的主题（首帧同步应用，消除浅色闪屏）；缺省走 getState。 */
  function init(override) {
    try {
      if (override === "dark" || override === "light" || override === "auto" || override === "system") {
        apply(override);
      } else if (window.petAPI && window.petAPI.getState) {
        window.petAPI.getState().then(function (st) { apply(st && st.theme); }).catch(function () { /* 忽略 */ });
      }
      if (window.petAPI && window.petAPI.onThemeChanged) window.petAPI.onThemeChanged(function (th) { apply(th); });
    } catch { /* 忽略 */ }
  }
  return { isDark: isDark, apply: apply, init: init };
});

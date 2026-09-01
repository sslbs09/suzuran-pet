/* 辅助窗口主题初始化（v2.5.26，P2-1）
   背景：主进程 sendToRenderer 只推主窗口，pet:theme-changed 到不了辅助窗口；
   此前除 docs.js 外的辅助窗口拿不到 body.theme-dark，ui.css 暗色变量层形同虚设。
   本文件在窗口打开时读取当前主题并挂类，逻辑与 pet.js applyTheme 完全一致
   （auto=19 点-6 点深色）。主题切换后重开窗口即生效。 */
(function () {
  function apply(theme) {
    let dark;
    if (theme === "dark") dark = true;
    else if (theme === "light") dark = false;
    else if (theme === "system") dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    else dark = new Date().getHours() >= 19 || new Date().getHours() < 6; // auto：19 点-6 点
    document.body.classList.toggle("theme-dark", dark);
  }
  try {
    if (window.petAPI && window.petAPI.getState) {
      window.petAPI.getState().then(function (st) { apply(st && st.theme); }).catch(function () { /* 忽略 */ });
    }
    if (window.petAPI && window.petAPI.onThemeChanged) {
      window.petAPI.onThemeChanged(function (th) { apply(th); }); // 主进程若改为全窗广播则自动跟随
    }
  } catch { /* 忽略 */ }
})();

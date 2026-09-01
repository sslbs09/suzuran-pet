/* 辅助窗口主题引导（v2.5.26）：逻辑已收敛到 theme.js，本文件只做引导调用。
   背景：主进程 sendToRenderer 曾只推主窗口，辅助窗口拿不到 theme-changed；
   现主进程全窗广播 + 打开时 getState 兜底。 */
window.petTheme.init();

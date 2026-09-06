(function () {
  'use strict';
  var root = document.documentElement;
  var system = window.matchMedia('(prefers-color-scheme: dark)');
  var explicit = null;
  try {
    var stored = localStorage.getItem('sp-theme');
    var legacy = localStorage.getItem('sp-guide-theme');
    explicit = stored === 'light' || stored === 'dark' ? stored :
      legacy === 'light' || legacy === 'dark' ? legacy : null;
  } catch (_) { /* System preference still works when storage is unavailable. */ }
  var theme = explicit || (system.matches ? 'dark' : 'light');
  root.dataset.theme = theme;

  function apply() {
    root.dataset.theme = theme;
    if (!document.body) return;
    document.body.classList.toggle('dark', theme === 'dark');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.body.classList.toggle('light', theme === 'light');
    var toggle = document.getElementById('theme');
    if (toggle) {
      toggle.textContent = theme === 'dark' ? '☼' : '☾';
      toggle.setAttribute('aria-label', theme === 'dark' ? '切换为浅色主题' : '切换为深色主题');
      toggle.title = theme === 'dark' ? '切换为浅色主题' : '切换为深色主题';
    }
  }
  function init() {
    apply();
    var contents = document.querySelector('.guide-sidebar details');
    if (contents && window.matchMedia('(max-width: 700px)').matches) contents.open = false;
    var toggle = document.getElementById('theme');
    if (toggle) toggle.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      explicit = theme;
      try { localStorage.setItem('sp-theme', theme); } catch (_) { /* Keep the in-page choice. */ }
      apply();
    });
    var motion = document.getElementById('motion-toggle');
    var mascot = document.getElementById('mascot');
    if (motion && mascot) motion.addEventListener('click', function () {
      var paused = motion.getAttribute('aria-pressed') !== 'true';
      mascot.src = paused ? 'assets/wave-still.png' : 'assets/wave.gif';
      mascot.alt = paused ? '苏苏洛挥手的 Q 版角色静态画面' : '苏苏洛挥手的 Q 版角色动画';
      motion.setAttribute('aria-pressed', String(paused));
      motion.textContent = paused ? '播放动画' : '暂停动画';
    });
  }
  system.addEventListener('change', function () {
    if (!explicit) { theme = system.matches ? 'dark' : 'light'; apply(); }
  });
  window.addEventListener('storage', function (event) {
    if (event.key !== 'sp-theme') return;
    explicit = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : null;
    theme = explicit || (system.matches ? 'dark' : 'light');
    apply();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

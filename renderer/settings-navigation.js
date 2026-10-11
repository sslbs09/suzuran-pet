"use strict";

/* settings-navigation.js — LEGACY-UI REFLOW 六页导航与搜索（presentation only）。
 *
 * 旧 UI 视觉语言下的页切换：沿用 .set-nav 导航外观与 .active 高亮，
 * 搜索沿用旧的"按文本过滤设置项"行为，但过滤范围扩展到六个页面。
 * 不改配置、不触碰事务草稿值；条件显隐仍由 settings.js 的各条件 owner 负责
 * （搜索用独立 class，与 data-rm 的 style.display 互不干扰）。 */
(function () {
  const pages = [...document.querySelectorAll("div.settings-page")]; // 注意排除 body 上的 legacy class
  const links = [...document.querySelectorAll(".set-nav nav a")];
  const search = document.getElementById("set-search");
  if (!pages.length || !links.length) return;

  let active = pages[0];

  function select(page) {
    if (!page || !pages.includes(page)) return;
    active = page;
    pages.forEach((p) => { p.hidden = p !== page; });
    links.forEach((a) => a.classList.toggle("active", a.hash === "#" + page.id));
  }
  links.forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      select(document.getElementById(a.hash.slice(1)));
      if (search) { search.value = ""; applySearch(); }
    });
  });
  select(pages[0]);

  // 搜索匹配跳过条件隐藏的行（data-rm/条件容器的 style.display 不被搜索穿透）
  function visible(el) {
    for (let n = el; n && n.classList; n = n.parentElement) {
      if (n.classList.contains("settings-page")) continue;
      if (n.hidden || n.style.display === "none") return false;
    }
    return true;
  }
  function pageUnits(page) { // 旧 UI 过滤粒度：行块/标题/提示（与旧版"按分区过滤"同粒度）
    return [...page.querySelectorAll(".row, p.hint, p.foot, h2, h3")];
  }
  function applySearch() {
    const q = ((search && search.value) || "").trim().toLowerCase();
    pages.forEach((page) => {
      const units = pageUnits(page);
      if (!q) {
        page.hidden = page !== active;
        units.forEach((u) => u.classList.remove("search-hidden"));
        return;
      }
      const hitUnits = units.filter((u) => visible(u) && (u.textContent || "").toLowerCase().includes(q));
      page.hidden = hitUnits.length === 0;
      units.forEach((u) => u.classList.toggle("search-hidden", !hitUnits.includes(u)));
    });
  }
  if (search) search.addEventListener("input", applySearch);
})();

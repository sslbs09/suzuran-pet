/** 视觉回归冒烟（v2.5.26）：设置页结构断言 + 深浅截图存档。
 *  在浏览器直接开 renderer/*.html（无 preload，JS 报错不影响 DOM/CSS 渲染）。
 *  跑法：npx playwright test；截图存 tests/__visual-out__ 供人工比对。 */
const { test, expect } = require("@playwright/test");
const path = require("path");

const settingsUrl = "file:///" + path.resolve(__dirname, "../renderer/settings.html").replace(/\\/g, "/");

test("设置页：11 分区导航齐全（含 Agent 接口/感知与监控）", async ({ page }) => {
  await page.goto(settingsUrl);
  const links = await page.locator(".set-nav nav a").allTextContents();
  expect(links.length).toBe(11);
  expect(links.join("|")).toContain("Agent 接口");
  expect(links.join("|")).toContain("感知与监控");
  expect(links.join("|")).toContain("系统与界面");
});

test("设置页：标题颜色统一（h2 无首字变色伪元素）", async ({ page }) => {
  await page.goto(settingsUrl);
  const fl = await page.evaluate(() => {
    const h2 = document.querySelector(".ui-page h2, .settings-page h2");
    return getComputedStyle(h2, "::first-letter").color === getComputedStyle(h2).color
      || !Array.from(document.styleSheets).some((ss) => {
        try { return Array.from(ss.cssRules).some((r) => r.selectorText && r.selectorText.includes("first-letter")); }
        catch { return false; }
      });
  });
  expect(fl).toBe(true);
});

test("设置页：浅色截图存档", async ({ page }) => {
  await page.goto(settingsUrl);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "tests/__visual-out__/settings-light.png", fullPage: false });
});

test("设置页：深色截图存档", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => document.body.classList.add("theme-dark"));
  });
  await page.goto(settingsUrl);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "tests/__visual-out__/settings-dark.png", fullPage: false });
});

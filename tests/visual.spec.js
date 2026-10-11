/** 视觉回归冒烟（LEGACY-UI REFLOW v0.1）：六页结构断言 + 里程碑实拍截图。
 *  视觉权威 = b168a50 旧 Settings UI：断言只锁结构与导航行为，不评价审美。
 *  跑法：npx playwright test；截图存 tests/__visual-out__ 供人工比对。 */
const { test, expect } = require("@playwright/test");
const path = require("path");

const settingsUrl = "file:///" + path.resolve(__dirname, "../renderer/settings.html").replace(/\\/g, "/");
const PAGES = ["page-general", "page-appearance", "page-chat", "page-voice", "page-privacy", "page-advanced"];

test("设置页：6 页导航齐全且逐页切换可用（LEGACY REFLOW）", async ({ page }) => {
  await page.goto(settingsUrl);
  const links = await page.locator(".set-nav nav a").allTextContents();
  // 分区增减必须同步更新此计数（本测试目的就是防导航被误删/误增）
  expect(links.length).toBe(6);
  expect(links.join("|")).toContain("通用");
  expect(links.join("|")).toContain("外观");
  expect(links.join("|")).toContain("对话");
  expect(links.join("|")).toContain("声音");
  expect(links.join("|")).toContain("隐私与感知");
  expect(links.join("|")).toContain("高级");
  // 旧版视觉语言仍在：导航沿用 emoji 前缀（legacy 味道不丢）
  expect(links[0].trim()).toMatch(/^[\u{1F300}-\u{1FAFF}⚙🖼💬🗣🔐🧪]/u);
  for (const id of PAGES) {
    await page.locator(`a[href="#${id}"]`).click();
    await expect(page.locator(`#${id}`)).toBeVisible();
    for (const other of PAGES) {
      if (other !== id) await expect(page.locator(`#${other}`)).toBeHidden();
    }
  }
});

test("设置页：General 页承载通用/天气/关于；Advanced 页承载实验性/Agent/日志（归属抽查）", async ({ page }) => {
  await page.goto(settingsUrl);
  const general = page.locator("#page-general");
  await expect(general.locator("#ui-lang")).toBeVisible();
  await expect(general.locator("#sec-weather")).toBeVisible();
  await expect(general.locator("#version")).toBeVisible();
  await page.locator('a[href="#page-advanced"]').click();
  const advanced = page.locator("#page-advanced");
  await expect(advanced.locator("#sec-experimental")).toBeVisible();
  await expect(advanced.locator("#sec-agent")).toBeVisible();
  await expect(advanced.locator("#sec-logdiag")).toBeVisible();
  // 归位抽查：桌面图标感知在高级>实验性（不在隐私页）
  await expect(advanced.locator("#feat-desktop-icons")).toBeAttached();
  await expect(page.locator("#page-privacy #feat-desktop-icons")).toHaveCount(0);
});

test("设置页：标题为产品品牌 WhiteMoon（角色名不入产品标题）", async ({ page }) => {
  await page.goto(settingsUrl);
  await expect(page).toHaveTitle(/WhiteMoon · 设置/);
  const h1 = await page.locator("h1").textContent();
  expect(h1).toContain("WhiteMoon");
  expect(h1).not.toContain("苏苏洛");
  await expect(page.locator("#settings-character")).toContainText("苏苏洛"); // 角色单独一行呈现
});

test("设置页：General 浅色实拍（里程碑证明）", async ({ page }) => {
  await page.goto(settingsUrl);
  await page.waitForTimeout(600);
  await page.locator('a[href="#page-general"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "tests/__visual-out__/reflow-general-light.png", fullPage: true });
});

test("设置页：Advanced 浅色实拍（里程碑证明）", async ({ page }) => {
  await page.goto(settingsUrl);
  await page.waitForTimeout(600);
  await page.locator('a[href="#page-advanced"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "tests/__visual-out__/reflow-advanced-light.png", fullPage: true });
});

test("设置页：深色截图存档（沿用旧存档习惯）", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => document.body.classList.add("theme-dark"));
  });
  await page.goto(settingsUrl);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "tests/__visual-out__/settings-dark.png", fullPage: true });
});

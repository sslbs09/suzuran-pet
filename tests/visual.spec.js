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

test("设置页：搜索跨页过滤（命中页保留、未命中页隐藏、清空恢复）", async ({ page }) => {
  await page.goto(settingsUrl);
  await page.locator('a[href="#page-voice"]').click(); // 激活页先切走，验证搜索可跨页命中
  await page.locator("#set-search").fill("天气");
  await expect(page.locator("#page-general")).toBeVisible();
  await expect(page.locator("#sec-weather")).toBeVisible();
  await expect(page.locator("#page-voice")).toBeHidden();
  await page.locator("#set-search").fill("");
  await expect(page.locator("#page-voice")).toBeVisible(); // 清空 → 回到激活页
});

test("设置页：全部 DOM id 唯一（stable id 协议护栏）", async ({ page }) => {
  await page.goto(settingsUrl);
  const dups = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    return ids.filter((id, i) => ids.indexOf(id) !== i);
  });
  expect(dups).toEqual([]);
});

test("设置页：四页归属抽查（外观/对话/声音/隐私）", async ({ page }) => {
  await page.goto(settingsUrl);
  // 外观：渲染模式 + 皮肤 + 气泡字体（桌面图标感知不在本页——已归高级>实验性）
  await page.locator('a[href="#page-appearance"]').click();
  const appearance = page.locator("#page-appearance");
  await expect(appearance.locator("#render-mode")).toBeVisible();
  await expect(appearance.locator("#rig-skins-list")).toBeAttached();
  await expect(appearance.locator("#live2d-skins-list")).toBeAttached();
  await expect(appearance.locator("#bubble-width")).toBeVisible();
  await expect(page.locator("#page-appearance #feat-desktop-icons")).toHaveCount(0);
  // 对话：AI 事务 + 身份 + 人设 + 记忆（Formal/LEGACY 结构在场）
  await page.locator('a[href="#page-chat"]').click();
  const chat = page.locator("#page-chat");
  await expect(chat.locator("#btn-save-api")).toBeVisible(); // tx-ai-provider 保存锚点
  await expect(chat.locator("#btn-ai-discard")).toBeAttached(); // tx-ai-provider 放弃锚点
  await expect(chat.locator("#btn-identity-save")).toBeAttached(); // tx-identity
  await expect(chat.locator("#persona")).toBeVisible(); // tx-persona
  await expect(chat.locator("#legacy-memory-editor")).toBeAttached();
  // 声音：正常层齐全；工程层不在本页（genie-fields 在高级）
  await page.locator('a[href="#page-voice"]').click();
  const voice = page.locator("#page-voice");
  await expect(voice.locator("#tts-enabled")).toBeVisible();
  await expect(voice.locator("#fixed-lines-preload")).toBeVisible();
  await expect(voice.locator("#genie-python")).toHaveCount(0);
  await expect(voice.locator("#btn-fixed-lines-clear")).toHaveCount(0);
  // 隐私：感知 + 凭据 + 数据（清除聊天记录 + 独立结果位）
  await page.locator('a[href="#page-privacy"]').click();
  const privacy = page.locator("#page-privacy");
  await expect(privacy.locator("#feat-clipboard")).toBeVisible();
  await expect(privacy.locator("#btn-clear-history")).toBeVisible();
  await expect(privacy.locator("#privacy-result")).toBeAttached();
});

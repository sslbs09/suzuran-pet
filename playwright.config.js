// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: /visual\.spec\.js/,
  timeout: 60000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1100, height: 900 },
  },
  outputDir: "./tests/__visual-out__",
});

// ESLint 扁平配置（代码规范检查：语法错误 + 未定义变量等，保持宽松不阻塞）
import globals from "globals";

const sharedRules = {
  // 硬错误：真问题才报错
  "no-undef": "error",
  "no-dupe-keys": "error",
  "no-redeclare": "off", // Node 19+ 的 crypto 是全局，const crypto = require("crypto") 会误报重声明；真重复由 no-dupe-keys 兜底
  "no-cond-assign": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  // 软提示：不阻塞合并
  "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-extra-semi": "warn"
};

export default [
  {
    ignores: [
      "**/pixi.min.js", "**/pixi-spine.js", "**/pixi-live2d.min.js", "**/live2dcubismcore.min.js", // 第三方 UMD/min 包（自带全局，不 lint）
      "node_modules/**",
      "dist/**",
      "data/**",
      "renderer/sprites/**",
      "release/**",
      "outputs/**",
      "_backups/**",
      "语音部署与训练指南/example_audio/**"
    ]
  },
  {
    // 主进程 / 工具脚本：Node 环境
    files: ["main.js", "preload.js", "src/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.node, ...globals.es2021 }
    },
    rules: sharedRules
  },
  {
    // 渲染层页面：浏览器环境
    files: ["renderer/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser, ...globals.es2021,
        I18N: "readonly", PIXI: "readonly", Buffer: "readonly",
        module: "readonly", // rp-render.js 浏览器/node 双端条件导出
        parseRpSegments: "readonly", renderRpSlice: "readonly", escHtml: "readonly", stripRpActions: "readonly" // rp-render 跨文件全局
      }
    },
    rules: sharedRules
  }
];

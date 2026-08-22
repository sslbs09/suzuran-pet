// ESLint 扁平配置（代码规范检查：语法错误 + 未定义变量等，保持宽松不阻塞）
import globals from "globals";

const sharedRules = {
  // 硬错误：真问题才报错
  "no-undef": "error",
  "no-dupe-keys": "error",
  "no-redeclare": "error",
  "no-cond-assign": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  // 软提示：不阻塞合并
  "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-extra-semi": "warn"
};

export default [
  {
    ignores: [
      "**/pixi.min.js", "**/pixi-spine.js",
      "node_modules/**",
      "dist/**",
      "data/**",
      "renderer/sprites/**",
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
      globals: { ...globals.browser, ...globals.es2021, I18N: "readonly", PIXI: "readonly", Buffer: "readonly" }
    },
    rules: sharedRules
  }
];

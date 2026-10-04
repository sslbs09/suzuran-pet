# Localization v1 — Final Audit

**日期**：2026-10-04 · **分支**：`runtime-i18n-main-native-v0.1` · **基线**：`d6e7687`（5-D3）
**范围**：Phase 1 → 5-F 全链路的只读终审。**结论：READY TO FREEZE。**

---

## 1. Catalog 规模

| 指标 | 值 |
|---|---|
| key 总数 | **959**（zh / en / ja 各 959） |
| 相对 5-D3（`d6e7687`） | 977 → 959（5-F3 删除 18 个被取代的死键 × 3 语 = 54 行） |
| 空值 | **0** |
| 未被引用的键 | 55（全部为动态构造或预留，见 §7） |

## 2. 三语 parity

| 检查 | 结果 |
|---|---|
| zh-only / en-only / ja-only 键 | **0 / 0 / 0** |
| zh↔en 键集合差异 | **0** |
| zh↔ja 键集合差异 | **0** |

**PASS** — 三语键集合完全一致。

## 3. Placeholder parity

| 检查 | 结果 |
|---|---|
| `{param}` 集合跨语言不一致的键 | **0** |
| 例：`ui.petWindowTitle` = `{name}` | 三语一致 |
| 例：`set.credEncryptedSaved` = `{fp}` | 三语一致 |
| 例：`err.http` = `{status}` | 三语一致 |

**PASS** — 959 个键的占位符集合在 zh/en/ja 完全对齐。

## 4. data-i18n 悬空键

| 检查 | 结果 |
|---|---|
| HTML 中所有 `data-i18n*` 引用是否都存在于 catalog | **全部存在，0 悬空** |
| 覆盖页面 | 11 个 HTML（addchar / moods / psd / settings / voice / index / help / quickstart / terms / schedule / docs） |

**PASS** — 由 `tests/static-binding-leftovers.test.js` 与 `tests/i18n.test.js` 双重守护。

## 5. ErrorPresenter 唯一性

| 定义点 | 数量 | 位置 |
|---|---|---|
| `function toPresentation(` | **1** | `src/error-presenter.js` |
| `const ERROR_PRESENTATIONS =` | **1** | `src/error-presenter.js` |
| 调用点 | 13 | 9 个 renderer 页面 + main.js |
| `window.ErrorPresenter` 引用 | 13 | 同上 |

**PASS** — 全仓仅一份 presenter 实现，无第二套映射表。

> **观察（非阻断）**：8 个 renderer 页面各自持有一份 6–10 行的 `presentError()` 适配器（addchar / docs / moods / psd / schedule / settings / terms / voice）。它们都只做
> `hasOwnProperty("code") → toPresentation() → I18N.t()` 这一件事，是 5-D 起的既有约定，不是第二套 presenter。收敛为共享模块属于「重构 i18n」，本阶段按纪律不做。

## 6. ERROR_CODES 唯一性

| 定义点 | 数量 | 说明 |
|---|---|---|
| `const ERROR_CODES =` | 2 | `src/error-facts.js`（**权威定义**）与 `src/conversation-service.js` |
| `classifyError` 定义 | 2 | `src/error-facts.js`（权威）与 `src/conversation-service.js`（**纯委托**） |

`conversation-service.js:20` 为 `const ERROR_CODES = errorFacts.ERROR_CODES;`——**别名，非重定义**；
`classifyError` 为 `return errorFacts.classifyError(err);` 的转发。
词表实际只有一份，11 个 code 与 `error-presenter` 的 `ERROR_PRESENTATIONS` 由 `tests/error-facts.test.js` 双向锁定。

**PASS**（单一事实来源；两处绑定是有意的向后兼容导出）

> **架构观察 — 仅报告，未修改**：5-D1 把 GSV 的小写命名空间（`timeout` / `synth` / `disabled` / `nopath` → `err.gsv*`）
> **并入了同一张 `ERROR_PRESENTATIONS` 表**，使该表现有 15 个条目：11 个大写 code + 4 个仅大小写不同的 GSV code。
> · `toPresentation({code:"timeout"})` → `err.gsvTimeout`（GSV 专用）
> · `toPresentation({code:"TIMEOUT"})` → `err.timeout`（通用）
> 当前 **无实际缺陷**：`restartGsv` 返回的是普通对象而非 `ErrorWithCode`，路径直接调 `toPresentation`，绕开了 `normalizeCode`。
> 但若将来任何 `ErrorWithCode` 携带小写 `code`，`normalizeCode` 会将其归为 `INTERNAL`。建议 5-G 处理
> （把 GSV 子命名空间拆成独立的 `GSV_PRESENTATIONS` 或并入 11 码）。**按「不改 error-presenter」纪律，本阶段只报告。**

## 7. onChange 页面列表

9 / 9 全部订阅 `I18N.onChange`：

| 页面 | 订阅数 | 状态 |
|---|---|---|
| `renderer/settings.js` | 3 | ✅ |
| `renderer/pet.js` | 3 | ✅ |
| `renderer/moods.js` | 3 | ✅ |
| `renderer/voice.js` | 3 | ✅ |
| `renderer/schedule.js` | 3 | ✅（5-E3 接入） |
| `renderer/addchar.js` | 3 | ✅（5-E3 接入） |
| `renderer/psd.js` | 2 | ✅ |
| `renderer/docs.js` | 2 | ✅ |
| `renderer/terms.js` | 2 | ✅ |

`help.html` / `quickstart.html` 为纯静态内容页，无运行时文本，故不订阅。

## 8. 剩余中文分类

### 8.1 MUST FIX

**0 项。**

技术详情（`Error.message` / 异常文本 / HTTP body / provider response）**不进入** DOM、alert、tooltip、dialog、notification、toast。
`detail` 字段止步于主进程 `toDiagnostic()`（日志专用），`toPayload()` 跨进程投影的键集合被硬限制为 `{code, meta, message}`。

### 8.2 ACCEPTED DEBT（有 owner，属 Phase 4-B 有意解除静态绑定）

18 个 HTML 节点带未绑定中文，但**全部已有明确的 JS owner**，补 `data-i18n` 反而会制造双 owner：

| 节点 | Owner |
|---|---|
| `index.html` `<title>` | `main.js applyPetWindowTitle()`（5-E2） |
| `docs.html` `<title>` | `docs.js renderDocsTitle()` |
| `index.html` `#sprite[alt]` | `pet.js applyPetName()` — DATA |
| `index.html` `#input[placeholder]` | `pet.js` 末尾唯一 `I18N.onChange`（5-F1 收敛） |
| `index.html` `#mode-chip[title]`、`#btn-tts[title]` | `pet.js` 运行时状态文案 |
| `addchar.html` `#model-list` | `addchar.js renderList()`（5-E3） |
| `moods.html` `#dir-hint` | `moods.js` |
| `psd.html` `#sel-info`、`#tree`、`#preview-wrap` | `psd.js` |
| `settings.html` `#rm-hint` | `settings.js applyRenderModeUI()` |
| `settings.html` `#rig-skins-list`、`#live2d-skins-list`、`#mem-stats` | `settings.js` 列表渲染 |
| `settings.html` `#fixed-lines-profile`、`-state`、`-summary`、`#btn-fixed-lines-toggle` | `settings.js` 音频池渲染 |
| `settings.html` `#bubble-width-val`、`#version`、`#agent-token[placeholder]` | `settings.js render*()` |
| `voice.html` `#status-card` | `voice.js renderStatus()` |

该清单由 `tests/static-binding-leftovers.test.js` 固化为守卫，并逐条断言其 owner 在生产代码中真实存在。

### 8.3 CHARACTER_CONTENT（刻意不翻译）

聊天内容始终为中文——项目前提。

- `src/lines.js` / `fixed-lines*.js` 台词池
- `main.js` `fileGuard` 的 `msgs{honey,tamper,worm,ransom}`（经 `sendProactive()` 说出的角色台词）
- `renderer/pet.js` 情绪拟声（开心/呀！/惊喜/哇！…）、`唔……出错了。`、`啊……好好好…`
- `terms.html:34-40` 条款正文（单语言法律文书）
- `renderer/voice.html` 试听示例文本 `value="…"`

### 8.4 DATA（数据，非文案）

- 字体名：`宋体` / `黑体` / `楷体` / `仿宋` / `等线`（同时是 CSS `font-family` 真实值）
- 语言名：`中文` / `日本語`（语言选择器显示 endonym）
- 情绪标识与用户自定义情绪词
- docs manifest 文件名：`使用说明.html` / `API接入指南.html` / `新手教程` …
- Excel 模板示例数据行 `{ title: "喝药", … }`
- 品牌 / 引擎名：`苏苏洛桌宠`（作为 `app.brandName` 入参）、`Genie` / `GPT-SoVITS` / `CosyVoice` / `Edge TTS` / `Ollama`
- 宠物名默认值 `苏苏洛`（`applyPetName` 的 DATA 回落）

### 8.5 TECHNICAL_IDENTIFIER

- CSS 伪元素文案：`moods.html:20 .mood-preview.empty::after { content: "无表情" }`（`data-i18n` 机制无法触达）
- 路径 / 扩展名 / 命令片段：`assets/psd-export/`、`.atlas + .skel/.json + .png`、`ollama pull qwen2.5:7b`、`%APPDATA%\…\logs\tts.log`
- 诊断与日志：`logTts(...)`、`console.*`、`src/log-diag.js`
- 内联 ID / 类名 / API 通道名：`rig-canvas`、`data-rm`、`pet:chunks` 等

---

## 9. 遗留未引用键（55）— 全部保留

| 组 | 数量 | 保留理由 |
|---|---|---|
| `set.pool.*` | 20 | `settings.js` 以 `L("set.pool." + …)` **动态拼接**，字面量扫描永远命中不到 |
| `set.seatTier.*` | 3 | `seatTierLabel()` 以 `L("set.seatTier." + t)` 动态拼接 |
| `tray.sizeWord*` / `tray.rateWord*` / `tray.sizeLabel` / `tray.rateLabel` / `tray.skinLabel` | 12 | 托盘菜单按状态动态选取的预留词 |
| `set.fixed*` / `set.rmHint` / `set.bubbleAuto` / `set.loading` / `set.agentTokenPh` / `set.version` | 8 | 对应 §8.2 中 runtime-owned 节点的预留文案 |
| `ui.petAlt` / `ui.ttsTitle` / `ui.modeChipTitle` / `pet.poutPrefix` | 4 | DATA 与运行时 title 的预留 |
| `skin.*` / `common.ok` / `page.moods.foot` / `page.voice.phFilePath` / `page.psd.previewEmpty` / `page.psd.unknownError` | 8 | 页面预留 |

由 `tests/obsolete-key-cleanup.test.js` 断言这些键**不得被过度清理**。

---

## 10. 验证

| 项 | 结果 |
|---|---|
| `npm test`（`node scripts/run-tests.cjs`） | **737 tests / 737 pass / 0 fail** |
| `eslint .` | **0 errors**, 11 warnings（全部为存量 `no-unused-vars`，非本次引入） |
| `git diff --check` | **clean** |
| 工作区 | **CLEAN** |

---

## 11. 结论

**READY TO FREEZE。**

- MUST FIX：**0**
- 技术详情隔离不变量：完整保持
- 单一词典 / 单一 presenter / 单一错误事实层 / 单一 code 词表：全部成立
- 9 / 9 页面具备 locale 重投影；切语言不触发 IPC、不重建业务状态、不覆盖用户输入

**建议后续（非阻断）**：
1. 把 `error-presenter` 的 GSV 小写子命名空间拆出或并入 11 码（见 §6 架构观察）
2. 把 8 个页面的 `presentError()` 适配器收敛为共享模块（属重构，另行立项）
3. `pet.js` 运行时 title（`modeChip` / `btnTts`）硬编码中文——属 B2 遗留，可在后续单独收口
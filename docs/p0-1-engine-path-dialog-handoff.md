# 交接报告：P0-1 收尾 —— 语音引擎路径改主进程文件对话框选择

- 编写日期：2026-09-01
- 代码基准：v2.5.23（HEAD = 56beb53）
- 仓库：`E:\SuzuranPetGit`（GitHub: https://github.com/sslbs09/suzuran-pet）
- 本任务由另一位模型/AI 承接，以下内容自包含，可直接开工

---

## 一、背景与目标

第五轮代码审查（`suzuran-pet-复审报告-r5.html`）的 P0-1（渲染层 RCE 链）当前是**部分修复**：

- 已做：`pet:save-settings` 白名单封掉了 `zcodeCli/workspace/zcodeEnabled/translateApi`（src/settings-patch.js）
- 剩余风险：**`ttsGenie/ttsGsv` 的 `python/serverScript` 仍在白名单**——它们是设置页语音部署区的合法配置，但若渲染层被 XSS 攻破，XSS 可调用 `saveSettings({ ttsGenie: { python: "C:\\evil.exe", serverScript: "..." } })`，主进程会把它当可执行路径 spawn → 任意代码执行。

**根治方案（本任务）**：引擎可执行路径改由**主进程 `dialog.showOpenDialog` 选择并直接写入 config**，渲染层永远无法提交任意路径。设置页输入框改为只读 + 「📁 浏览」按钮。

## 二、现状代码位置（先读这些）

| 项 | 位置 | 说明 |
|---|---|---|
| 设置页引擎路径输入框 | `renderer/settings.html:276-296`（`#genie-fields` 区域） | `genie-python`（pythonw.exe 路径）、`genie-script`（genie_tts_server.py）、`genie-ref-audio`、`genie-ref-text` 四个文本输入 |
| 设置页回填 | `renderer/settings.js:73-74` | `fillSettings` 时写入 `genie.python / genie.serverScript` |
| 设置页保存 | `renderer/settings.js:435-452` `doSaveVoice()` | 拼 `patch.ttsGenie = { enabled, python, serverScript, refAudio, refText, speakJa }` → `saveSettings(patch)` |
| 白名单纯函数 | `src/settings-patch.js` | `ALLOWED_TOP` 含 `"ttsGenie"`、`"ttsGsv"`；`filterSettingsPatch()` 提取 secrets/autoLaunch |
| 现成对话框范例 | `main.js:3600` `pet:import-font` | `dialog.showOpenDialog` → 校验扩展名 → 写配置 → 返回路径，最接近本任务要写的 IPC |
| 引擎配置结构 | `config.ttsGenie` | `{ enabled, python, serverScript, refAudio, refText, modelDir, speakJa }`（默认路径由 `src/tts-manager.js` `applyBundledVoice()` 回填 engines/ 随包） |
| 语音开关/引擎停启 | `main.js:433` `setTts()` / `applyTtsEngine()` | **刚修好的「关语音停 GSV 引擎」，不要动** |

## 三、改动方案（推荐实现）

### 3.1 主进程 `main.js` — 新增专用 IPC

新增 `ipcMain.handle("pet:pick-engine-path", ...)`（参考 `pet:import-font` 写法）：

- 入参 `type` ∈ `"python" | "script" | "refAudio"`
- `dialog.showOpenDialog(win, { properties: ["openFile"], filters })`，filters 按 type：
  - python → `[{ name: "Python", extensions: ["exe"] }]`
  - script → `[{ name: "Python 脚本", extensions: ["py"] }]`
  - refAudio → `[{ name: "音频", extensions: ["wav", "mp3", "flac"] }]`
- 校验：`fs.realpathSync` 存在 + 扩展名匹配（拒绝符号链接/越权，与 `pet:apply-gif` 同款校验，见 `main.js:862` 附近）
- **主进程直接写 config**：`config.saveConfig({ ttsGenie: { ...cfg.ttsGenie, python/serverScript/refAudio: 选中路径 } })`（只更新对应字段，保留其它）
- 返回 `{ ok: true, value: 绝对路径 }`；用户取消返回 `{ ok: false, canceled: true }`

可选：同法给 GSV 加 `"gsvPython" | "gsvScript"` 类型（设置页目前没有 GSV 路径 UI，可顺带补，见 3.6）。

### 3.2 `src/settings-patch.js` — 白名单字段级收紧

`filterSettingsPatch()` 里对 `ttsGenie`（及可选 `ttsGsv`）做**字段级剥离**：

- 剥离字段：`python`、`serverScript`、`refAudio`、`refText`（路径类，只准主进程对话框写）
- 保留字段：`enabled`、`speakJa`（布尔开关，设置页仍需保存）
- 实现：在返回前对 `out.ttsGenie` 做 `delete out.ttsGenie.python` 等（若 `ttsGenie` 存在且为对象）；`ttsGsv` 同样处理
- **同步更新 `tests/settings-patch.test.js`**：新增用例「渲染层提交 `ttsGenie.python = 恶意路径` → 被剥离不落 config」「`ttsGenie.enabled` 仍可保存」

> 为什么不能简单把 `ttsGenie` 移出白名单：`saveSettings` 同时承担 `enabled/speakJa` 等非路径字段的保存，必须保留键但剥离路径字段。

### 3.3 `preload.js` — 暴露 API

`preload.js` 加一行（参考第 53 行 `importFont`）：

```js
pickEnginePath: (type) => ipcRenderer.invoke("pet:pick-engine-path", type),
```

### 3.4 渲染层 `renderer/settings.html` + `renderer/settings.js`

- HTML：`genie-python` / `genie-script` / `genie-ref-audio` 输入框加 `readonly`，旁边加「📁 浏览」按钮（`type="button"`，class 沿用现有按钮样式）
- JS：浏览按钮点击 → `window.petAPI.pickEnginePath("python"|"script"|"refAudio")` → 返回 `value` 时填入对应输入框（无需重新保存——主进程已写 config）
- `doSaveVoice()`：`patch.ttsGenie` **不再包含** `python/serverScript/refAudio/refText`（只留 `enabled/speakJa/rate 等非路径字段`）
- `fillSettings` 回填逻辑不变（get-settings 的 buildSettingsView 仍带路径字段，用于显示）

### 3.5 i18n — `src/i18n.js`

新增键（zh/en/ja 三语，参考现有 `set.pythonPath` 键，zh 在 ~131 行、en 在 ~334 行、ja 再往后）：

```
set.browse         浏览
set.pickPython     选择 pythonw.exe
set.pickScript     选择 genie_tts_server.py
set.pickRefAudio   选择参考音频
```

### 3.6 可选项（GSV 路径 UI 补齐）

设置页语音分区目前只有 Genie 路径框，GSV（日语引擎 `ttsGsv`）的 `python/serverScript` 没有 UI（靠 `applyBundledVoice()` 回填或手改 config）。建议顺带补一组同样的只读框 + 浏览按钮（复用 3.1 的 IPC，type 加 `"gsvPython"|"gsvScript"`）。**若时间紧可跳过，不影响 P0-1 验收**（白名单剥离同样覆盖 ttsGsv）。

## 四、验收标准

1. 设置页语音分区：三个路径框只读，浏览按钮可选文件；选中后输入框即时显示绝对路径
2. 选完关掉设置页再打开，路径仍在（config 已持久化）
3. 恶意调用 `saveSettings({ ttsGenie: { python: "C:\\evil.exe" } })` → 该字段被剥离，config 不写入（用单测验证）
4. `tests/settings-patch.test.js` 全绿；`node --check` 通过所有改动文件
5. 打包重启后：设置页操作正常、`tts.log` 无 error
6. 原有行为不回归：中文模式开语音仍拉起 Genie；日语模式开语音仍只留 GSV；**关语音仍停 Genie+GSV**（`applyTtsEngine` 不动）

## 五、注意事项（红线，务必遵守）

1. **Mimosa 安全门禁**：改源码一律用 Write/Edit 工具，禁止 Bash 直接写源码/配置；git 命令用 `git -C "E:/SuzuranPetGit"` 规避误扫；测试里不要出现形似真实密钥的字符串（会被拦截，参考 tests/settings-patch.test.js 用 `V(n)` 生成假值）
2. **打包升级方式不要改**（用户红线）：继续 app_legacy 散目录 + `pack.sh` + `cp -f app.asar.new app.asar` 的流程
3. **部署循环**：改 dev → PowerShell `Copy-Item` 同步改动文件到 `release/v2.5/苏苏洛桌宠 2.5 正式版/resources/app_legacy/`（Bash `cp` 会被 Mimosa 拦，用 PowerShell）→ 停桌宠 → `bash deploy/pack.sh` → `cp -f` 覆盖 asar（mv 常因文件锁失败，cp 可过）→ 重启 → 验证 `E:\SuzuranPetData-Roaming-2.5\logs\tts.log`
4. **版本与日志**：`package.json` 版本 2.5.23 → 2.5.24；`CHANGELOG.md` 顶部加 v2.5.24 段（参考 v2.5.23 段格式）
5. **单测风格**：node 纯函数断言（`tests/settings-patch.test.js` 同款），20 个现有测试必须保持全绿
6. 完成后 commit（不 push），等待用户验收后再发版

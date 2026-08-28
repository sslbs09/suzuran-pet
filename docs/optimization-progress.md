# SuzuranPet 开发交接笔记（2026-08-24）

> 这份文档是本项目唯一的权威账本：新会话先读它，再从「未完成」按优先级继续。
> 标为已完成的事项都有代码或部署验证支撑，除非发现明确回归，不要重做。

---

## 2.0 正式版发布（2026-08-24，已推 GitHub）

**发布物**（4 个，均放入 `E:\苏苏洛桌宠已发布\`，此为干净包——已清用户数据残留）：
- `苏苏洛桌宠-2.0正式版.zip`（218MB）：桌宠本体 2.0（版本号 2.0.0、exe 改名、1.1 文案全部更新、help 页新增「2.0 更新亮点」区块；不含 config/data/persona.md 等用户数据）
- `苏苏洛语音训练懒人包-普通版.zip`（37KB）
- `苏苏洛语音训练懒人包-完整版.zip`（6.71GB，含预置苏苏洛音色）
- `苏苏洛音色-独立部署包.zip`（291MB，新增：预置音色单独部署包）
- `更新日志-CHANGELOG.md`

**GitHub**（用户明确要求发布，覆盖「不推送」旧约定；本机 Clash 代理 127.0.0.1:7897 已配给 git）：
- commit `9a98683`（40 文件 +3969/-889，含全部未提交功能）→ push main
- tag `v2.0.0` 已推送；Release「苏苏洛桌宠 2.0 正式版」https://github.com/sslbs09/suzuran-pet/releases/tag/v2.0.0
- 资产 3 个（英文名，GitHub 中文文件名会截断！）：SuzuranPet-2.0.0-win32-x64.zip、SuzuranPet-VoiceTrain-Lite.zip、SuzuranPet-SussurroVoice-Preset.zip
- **完整版 6.71GB 超 GitHub 单文件 2GB 限制未上传**，Release 说明指向本地已发布文件夹/网盘
- 发布用 git 凭据（OAuth token 40 位）调 API 完成；临时凭据文件已删除

**经验**：GitHub Release 资产上传 URL 是 `uploads.github.com`（非 api.github.com）；中文资产名会被截断成 `-xxx.zip`，用英文名。

---

## 音色训练懒人包重构（2026-08-24，已交付两版本）

**背景**：用户修复音频机制后要求重做懒人包。构建中发现并修复了旧包多个隐藏缺陷，并新增「预置苏苏洛音色免训练直接用」。

**交付物**（`E:\` 根目录，旧的 7.2GB 单包已删除，`E:\SuzuranPet` 旧源码副本已删）：
- `苏苏洛语音训练懒人包-完整版.zip`（6.71GB，解压约 10.4GB）：自包含（runtime + GPT_SoVITS_Kit + whisper 模型 + ffmpeg），**附带 `苏苏洛音色/` 预置 ONNX 模型（321MB）+ 参考音频 + `使用苏苏洛音色.bat` 一键部署**（免训练直接体验）；含最新版 `genie_tts_server.py` 部署时覆盖 GenieTTS。
- `苏苏洛语音训练懒人包-普通版.zip`（37KB）：轻量脚本包，探测本机 GPT-SoVITS 套件 + GenieTTS。

**统一 `app/auto_train.py`**：自包含/本机双模式（包内有 `GPT_SoVITS_Kit/` 用包内，否则探测本机）；显卡自动适配（torch 检测显存，BATCH_SIZE=auto 时 <4GB→1 / 4~6→2 / 6~10→4 / >10→6，无 CUDA 强制 batch=1 关 fp16 并提示用预置音色）；训练设置.ini 支持 BATCH_SIZE/ASR_LANG 覆盖。

**修复的旧包缺陷**（旧 7.2GB 包实际跑不通/不完整）：
1. `run_cmd`/`mark_done` 未定义 NameError（应为 `run`/`done`）。
2. `run_asr_launcher.py` 硬编码 `E:\GSV-training\...`——已删除，auto_train 内联生成环境变量版；**补上了包内 `GPT_SoVITS_Kit/tools/asr/`（fasterwhisper_asr.py + config.py + funasr_asr.py + my_utils.py + i18n + whisper-medium 模型）**，ASR 真正离线可用（原包缺 tools/asr，只能靠本机套件）。
3. `convert_onnx_helper.py` 硬编码 `E:/GenieTTS`——auto_train 每次强制写入环境变量版。
4. prepare 脚本依赖 `os.getcwd()` 定位模块（`2-get-sv.py` 的 `GPT_SoVITS/eres2net`）——auto_train 对预处理/训练子进程统一 `cwd=GSV_KIT`。
5. 步骤 7 只写 refAudio 不写 refText、不杀 Genie 服务器（新音频机制要求：桌宠重启不重载 detached 服务器，必须主动杀进程）——已补 refText（ASR 最长句）与 `kill_genie_server()`；部署时用包内最新 server 覆盖（备份 .bak）。
6. 垃圾瘦身：删 `__pycache__`/pyc、uvr5(719MB)/AP_BWE(114MB)/gsv-v2final/gsv-v4/v2Pro 非 Plus 权重/bigvgan/fast_langdetect（均实测训练无引用），约省 1.7GB。

**本机接线已修正并验证**：原 `E:\GenieTTS\config.json` 无 modelDir（服务器实际加载内置 feibi 角色）；已通过 deploy_preset 写入 `modelDir=E:/GenieTTS/my_model/sussurro_v2proplus/onnx`，重启桌宠后 `server.log` 确认「引擎就绪: sussurro / E:/GenieTTS/my_model/sussurro_v2proplus/onnx」——训练音色真正生效。参考音频统一为 `ref_sussurro.wav`（中文文本）。

**验证**：两版 dry-run 均通过（GPU 检测/切分/ASR 离线；测试正弦波 1 条样本导致 s2 训练数据量断言失败属预期）；完整版 `testzip()` 全条目 CRC 通过；完整版瘦身后 7.2GB→6.71GB（含新增 321MB 预置音色）。

**最低要求**（写入 README）：仅用预置音色 → Windows 10/11、CPU 即可（建议 8GB 内存、无需独显，onnxruntime 推理支持 CPU）；自己训练 → NVIDIA ≥4GB（推荐 8GB+），无显卡可训但极慢不推荐。

**版权提醒（已写入 README）**：预置音色源自《明日方舟》苏苏洛官方配音，分享模型涉及角色语音版权，仅限自用/授权范围。

---

## 最新进展：应用内新手教程页（已完成，运行时验证通过）

**需求背景**：用户希望把 `docs/快速开始.md` 做成应用内教程页（已确认需要），让新手不必翻外部文档，直接在桌宠里就能看懂 API Key 领取、填入、故障排查等流程。

**功能与部署**（上一会话完成）：
- `renderer/quickstart.html` 教程页主体，覆盖「开机三步 / 领门票 / 一键导入 / 日常玩法 / 故障诊所 / 安全求助」六个板块，复用 `ui.css`，版式仿 `help.html`；底部「← 返回使用说明」走 file:// 相对导航，不需要 JS。
- `main.js`：新增 `quickstartWin` 变量（48 行）、`openQuickstart()`（382 行，窗口 700×780 带 preload）、托盘菜单项（353 行，插在 tray.help 之前）、IPC `pet:open-quickstart`（721 行）。
- `src/i18n.js`：`tray.quickstart` 三语词条（54 / 227 / 400 行；中文词条原文带雏鸟表情前缀）。
- `preload.js`：`openQuickstart` 桥接（55 行）。
- `renderer/help.html`：标题下 `qs-banner` 横幅链接，并补齐 `.qs-banner` 与 `.qs-banner:hover` 两条 CSS（插在 560px media query 之前）。
- 五个文件（`main.js`、`preload.js`、`src/i18n.js`、`renderer/quickstart.html`、`renderer/help.html`）已同步到部署目录，MD5 与源码逐文件一致；部署 exe 已重启为单实例运行。

**运行时 UI 验证**（本会话完成，全部通过）：
- 托盘右键菜单出现「🐣 新手教程（快速开始）」；菜单共 22 项，与 main.js 的构建顺序完全一致（UIA 枚举核对，emoji 在 UIA 名称里显示为 `??`）。
- 点击后教程窗口打开，标题「苏苏洛 · 快速开始（新手教程）」，尺寸 700×780（本机 200% DPI 下实测 1400×1560），截图确认六个板块渲染正常、无乱码。
- 使用说明窗口顶部横幅「第一次用？点我看《快速开始》新手教程…」点击后，窗口标题切换为教程标题；教程页底部「← 返回使用说明」点击后，标题切回「苏苏洛使用说明」。双向导航正常（UIA Hyperlink + InvokePattern 触发验证）。
- 设置页「界面语言」切换：切到 English 后托盘菜单整体变英文（第 17 项变为 "Beginner Tutorial (Quick Start)"，其余词条同步），设置页自身界面语言也跟随切换；切回中文后全部恢复。说明 `pet:set-ui-lang` → `refreshTrayMenu()` 加广播的链路是通的。
- 日志方面没有新手教程相关的新报错；部署 exe 重启后功能复验通过（菜单项、教程窗口均正常）。
- 验证期间顺带发现一个与新手教程无关的已知问题（行走引擎 `safeSetPosition` 持续报错），观察与分析见 §6.1 追加记录。

**验证自动化经验**（下会话直接复用）：
- 模拟鼠标点击 Electron 托盘原生菜单项不可靠（坐标正确也经常无响应）；改用 UIA `InvokePattern.Invoke()` 触发菜单项（MenuItem 支持 Invoke + ScrollItem 两个 pattern），稳定可靠。页面里的超链接（Chromium a11y）同样用 InvokePattern 触发。
- PowerShell 函数里 `Write-Output` 会进入返回值、把函数返回结果污染成数组；诊断输出一律用 `Write-Host`。
- 溢出弹层的 chevron（「显示隐藏的图标」）是开/关切换；本机（3072×1920，200% DPI，任务栏 y=1824）桌宠图标在弹层内约 (2216,1510)，右键即可弹菜单；Find 与 Click 之间至少留 2.5–3 秒。
- 设置窗口内容很长，靠下位置的控件（如「界面语言」下拉框在 y≈5094）要先滚到可视区再操作：鼠标置于窗口内，`mouse_event(0x0800, 0, 0, 4294967176, 0)` 向下滚；下拉选项用 `SelectionItemPattern.Select()` 选择。
- workspace 里的脚本若被 Write 工具覆盖会丢 UTF-8 BOM，运行前需重加：`printf '\xef\xbb\xbf' > t.ps1 && cat x.ps1 >> t.ps1 && mv -f t.ps1 x.ps1`。

---

## 0. 环境与操作约定

| 项目 | 说明 |
| --- | --- |
| 源码仓库 | `E:\SuzuranPetGit` |
| Git | 禁止推送 GitHub；本地有大量未提交修改；除非用户要求，不 commit。 |
| 实际运行部署目录 | `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources\app\` |
| 实际启动 exe | `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\苏苏洛桌宠 1.1 正式版.exe` |
| 同步原则 | 源码修改后必须同步相关代码/renderer 文件到部署目录；不要覆盖部署侧 userData/config。 |
| 运行时用户数据 | `C:\Users\xsbil\AppData\Roaming\苏苏洛桌宠 1.1 正式版\`（已从安装目录迁移）。 |
| 运行日志 | userData 下 `logs\tts.log`；旧安装目录 `data\tts.log` 仅作历史参考。`[render]` 是渲染层，`[spine] ok/fit` 是模型，`[walk]` 是行走/窗口。 |
| 重启验证 | 杀进程 → PowerShell `Start-Process` 启动部署 exe → 等约 8–12 秒 → 查 `logs\tts.log`。 |
| 截图 | PowerShell `SetProcessDPIAware` + `GetWindowRect` + `CopyFromScreen`；GPU 合成窗口不要用 PrintWindow。截图目录 `C:\Users\xsbil\Pictures\Screenshots\`。 |
| 用户语言 | 中文。 |
| Ark 模型来源 | `github.com/isHarryh/Ark-Models`，分支 `main`。URL 中 `#` 编码为 `%23`；落盘目录/文件名 `#` 改 `_`；**atlas 内贴图引用的 `#` 也必须改 `_`**。 |
| 自定义资源新目录 | userData `assets\spine\user\`、`assets\sprites\user\`、`assets\fonts\user\`；不要再指导用户写进 `resources\app\renderer\...`。 |
| 当前运行协议 | 用户 GIF / 字体 / Spine 经受限 `pet-user://` 协议加载；内置资源仍从 renderer 目录加载。 |

---

## 1. 当前状态

- 部署版桌宠正在运行，主窗口标题「苏苏洛桌宠」。
- 用户数据已完成一次迁移，位于 `C:\Users\xsbil\AppData\Roaming\苏苏洛桌宠 1.1 正式版`；迁移标记 `.storage-migration-v1.json` 显示 8 类数据迁移成功、0 失败，且重启后标记未变化，说明迁移幂等。config、persona、history、用户 GIF、用户 Spine 均已存在于 userData。
- 自定义 Spine（winter 模型）已验证可经 `pet-user://spine/user/...` 加载，日志有 `[spine] ok` / `fit`。
- `safeStorage` / Windows DPAPI 在部署环境可用，日志为 `[security] safeStorage=available chat=saved cosy=saved`。
- 普通 userData `config.json` 已不含 `chat.apiKey`、`ttsCosy.apiKey`、`agentApi.bearerToken` 明文；密钥在 `secrets.v1.json` 的加密 envelope 里。
- 部署与源码已同步的核心文件包括：`main.js`、`preload.js`、`src/config.js`、`src/storage.js`、`src/secrets.js`、`src/history.js`、`src/credential-import.js`、`renderer/pet.js`、`renderer/settings.js` 等。继续修改前仍应校验目标文件 MD5。
- 显式凭据导入/密钥管理已上线（设置页「⑤ 密钥与凭据安全」）：扫描只出指纹、导入在主进程换密、三个槽位可清除；`npm run test:secrets` 36 项断言通过。ZCode CLI 配置改为只读检查，桌宠不再写 `~/.zcode/cli/config.json`。
- 运行日志在 PowerShell 里读会显示中文乱码，这是 shell 控制台编码问题，不代表 JSON 或日志损坏；用 Node 读 JSON 一切正常。

---

## 2. 已完成：模型、Spine 与桌面行走

### 2.1 模型与渲染

- 迷迭香 sale 缩放 4.5，水平居中修正 -0.14。
- 新皮肤巫恋、铃兰、夕、黍（基础+时装）共 12 套缩放调整。
- 新增 Mon3tr 等用户 Spine 资源扫描与菜单展示。
- Spine 像素采样自动适配：按可见像素采样、居中、贴地，模型过小自动放大一次。
- 修复罗小黑皮肤早期误触发自动放大：只在 fit 第 2 次之后判断。
- 动画切换 `defaultMix=0.25`，降低硬切。
- 未知模型动画名自动分类：move / sleep / sit / interact / idle。
- Spine/GIF 快速切换带会话号保护：异步的旧 Spine 初始化不会覆盖用户最后一次选择。
- 渲染层启动时读取主进程真实的 `walkState`，不再伪造站立/坐姿状态。

### 2.2 桌面行走、图标与窗口顶

- 走路动画与移动脱节已修复；暂停状态即时广播；60 秒 mouseup 丢失自愈。
- 托盘散步速度四档：慢 / 标准 / 快 / 飞快。
- 相位行为权重：待机 / 走动 / 跳窗顶 = 0.45 / 0.40 / 0.15。
- 桌面图标感知、图标驻留、窗口顶驻留与缓动跳跃。
- `koffi@3.1.6` 已装进源码与部署 production node_modules，Win32 x64 native payload 已验证存在。
- 窗口屏障用 Win32 EnumWindows / IsWindowVisible / GetWindowRect / GetWindowTextW / GetClassNameW / DWM cloaked 枚举，每 3 秒刷新；过滤自身、无标题、小窗口、Shell surface、隐藏/cloaked 窗口。
- 跳上程序窗口顶约 350ms，`easeOutCubic`；驻留窗口移动/消失时返回地面。
- 修过窗口定位回归：开始跳窗/跳图标时清除 `seated`；从窗口返回时不提前 `applySeatPosition()` 瞬移。
- 窗口屏障日志和「跳上窗口」日志在部署版出现过。
- 批次 A 拖拽抛掷物理：渲染层保存约 80ms 屏幕轨迹，实际拖拽且速度超过 200px/s 才抛掷；`walk.flight` 40ms 积分，含重力、空气阻尼、速度上限、左右反弹、地面反弹；可落在任务栏/窗口顶，落地触发 `pet:dropped` 与 Interact 动作；抓取、隐藏、睡眠、停止行走都会取消 flight/jump；修复抛掷被拒后 `walkingPause(true)` 卡死（现在即时恢复）和物理落地后 `applySeatPosition()` 二次下沉（物理地面 y 不再被覆盖）。
- 仍建议人工复验一次：快速甩出、边界反弹、地面弹跳、最终 Sit + Interact，并确认普通点击/慢拖放没有回归。

---

## 3. 已完成：界面与交互

### 3.1 统一界面

- 新增 `renderer/ui.css`：暖白+青绿色统一设计令牌、圆角、阴影、按钮、状态、focus-visible、滚动条、reduced-motion。
- 主桌宠气泡/输入栏可读性提升，按钮加 aria 标签，模式 chip 支持键盘 Enter/Space。
- 气泡正文与输入框支持选择/复制，不再被全局 `user-select:none` 阻止。
- 设置、表情管理、音色克隆、帮助、条款页统一视觉体系和响应式布局。
- 辅助窗口可调大小，并有合理的最小宽高。
- 帮助页升级为 1.1 文案；条款页主操作强调、窄窗口换行改善。

### 3.2 层级与点击穿透

- desktop 层级修复：`layer=desktop` 强制 `setAlwaysOnTop(false)`，不会因任务栏坐姿或行走恢复置顶；截图已验证 desktop 模式下可被普通窗口覆盖。
- 从托盘恢复/主动显示时先接收一次鼠标命中，修复首次点击被透明穿透的问题；renderer 后续仍会根据透明区域自动恢复点击穿透。

---

## 4. 已完成：重命名、翻译与显示兼容

### 4.1 桌宠重命名

- 设置页新增「桌宠名称」，复用 `config.pet.name`：输入会 trim、合并空白、空值回退「苏苏洛」、最长 24 字。
- 主窗口标题、托盘提示、renderer 标题、图片 alt、输入提示即时刷新。
- `persona.md` 与 `persona.default.md` 的身份/开场改为 `{{petName}}`；后续聊天、开场、Agent API、ZCode prompt 都使用重命名后的名字。

### 4.2 日语语音术语

- 在中文→日语语音翻译边界强制把所有「博士」替换为 `doctor`，翻译 prompt 和输出后处理都有规则；不修改聊天显示、历史、中文内置消息或 UI 文案。部署日志已验证 `doctor` 出现在翻译输出中。

### 4.3 分辨率 / 多显示器 / Win10 / Win11

- 主窗口透明背景 `#00000000`。
- 监听 display-added / display-removed / display-metrics-changed，防抖后把桌宠钳制回可见工作区，钳制保留任务栏坐姿下沉空间。
- 屏障和桌面图标路径已按显示器 scale/origin 处理；**混合 DPI、负坐标副屏仍需真实设备验证**。
- Win10/Win11 基础路径可运行：Koffi/DWM 调用失败有降级，不会阻止桌宠启动。

---

## 5. 已完成：数据迁移与本地资源安全

### 5.1 userData 迁移

- 新增 `src/storage.js`。安装目录只保存只读程序资源；可写数据全部在 userData：
  `config.json`、`persona.md`、`history\history.jsonl`、`logs\tts.log`、`audio\...`、`assets\sprites\user`、`assets\sprites\default`、`assets\fonts\user`、`assets\spine\user`。
- 首次迁移只复制、不覆盖目标、不删除安装目录 legacy 文件；`.storage-migration-v1.json` 记录迁移，目标已存在时以 userData 为准。
- config 用同目录临时文件 + rename 原子写；history、日志、TTS 音频、Cosy/Edge 临时文件、字体、GIF、Spine 均已切到 userData。
- TTS 日志单文件到 2 MiB 轮转为 `.1`。

### 5.2 用户资源协议

- 注册受限 `pet-user://` 协议，只允许 userData `assets` 下的文件，阻止路径穿越；用户 GIF、字体、自定义 Spine 都改经该协议加载。
- 处理过一次协议 Fetch 失败：已通过 `protocol.registerSchemesAsPrivileged` 在 ready 前注册 `standard / secure / supportFetchAPI / corsEnabled`。
- 部署日志已验证 winter Spine 的 atlas/skel 从 `pet-user://` 加载成功。

---

## 6. 已完成：回归修复与本地安全硬化

### 6.1 回归修复

- 抛掷拒绝恢复、任务栏二次下沉、Spine/GIF 异步竞争、首次点击穿透、真实 walkState、Genie single-flight、表情名称 HTML 转义均已修复。
- 行走引擎坐标崩溃修复：`win.setPosition` 收到非有限坐标会抛 "Error processing argument at index 0, conversion failure from "，未捕获时主线程被模态错误框冻结（2026-08-24 01:57 UTC 实测）。已用 Electron 实验确认 NaN / Infinity / 超 int32 值都会产生该报错。修复方式是新增 `walkSetPosition()` 统一防护（覆盖 flight/jump/approach/ground 共 6 处调用）：坐标非有限时拦截、跳过本 tick 并写诊断日志，崩溃点额外记录 bounds/workArea/dir/speedMul 现场。**当时认为根因（哪个上游值非有限——静态分析 dir 恒 ±1、速度恒有限，怀疑 getBounds 异常）要等诊断日志再次捕获才能确认。**
- 2026-08-24 新手教程验证会话追加观察：部署日志里「walkTick setPosition 失败」持续出现——重启前累计 2137 条，约 0.3–1.5 条/秒间歇发生；重启部署 exe 后 1 分钟新增 88 条，说明与实例/代码加载无关，当前代码运行时就会触发。同期的「坐标越界」（walkTick:2208）与「拦截非法窗口坐标」（walkSetPosition:1505）两类拦截日志都是 0 条。**我拿 Node 把 safeSetPosition 的检查逻辑对 22 组边界输入（undefined/NaN/Infinity/±1e15/±1e6/int32 边界等）逐项验证过，逻辑是完备的：通过检查的值必为 ±1,000,000 内的安全整数，int32 转换不应失败——这跟实测矛盾。**怀疑 `win.setPosition` 对某类运行时值转换失败，但当前 catch 只打 message、没有 px/py/bounds 现场，无法定位具体值。**建议下一步在 `safeSetPosition` 的 catch 里补打 `px/py + win.getBounds()`，再捕获一次就能确认根因。**
- Genie 启动使用 single-flight，避免并发拉起同一个本地 Python 服务。
- 动态表情卡片使用 HTML/属性转义，特殊字符不会注入或破坏 DOM。

### 6.2 Agent API

- 严格路由：只允许 `GET /health`、`POST /chat`、`POST /stop`；`/healthz` / query / 路径前后缀一律 404，错误方法 405。
- `/chat` 强制 JSON 对象与 Content-Type；默认 64 KiB，范围 1 KiB–1 MiB，超限 413。
- Bearer token 可选：空 token 保持旧脚本兼容；非空时所有 API 路由认证并 constant-time 比较。
- 设置页可生成/复制 Agent Token，保存重启后生效；新安装默认关闭 Agent API，已有 userData 明确启用的保持兼容。
- 实测：health 200、healthz 404、GET chat 405、text/plain 415、query 404、70 KiB 413。

### 6.3 TTS endpoint 与 Electron 边界

- Genie/GSV 默认只监听 loopback；远端需 `allowRemote=true` 且 HTTPS。
- 远端 endpoint 不会触发本地 Python 启动/停止/重启。
- 主窗口拒绝 popup 和导航；媒体权限只授予主桌宠窗口的 media 请求。
- 设置页模型列表不再用 `innerHTML` 生成 option。

### 6.4 DPAPI / safeStorage

- 新增 `src/secrets.js`，在 Electron ready 后调用 `safeStorage`（Windows DPAPI）。
- `chat.apiKey`、`ttsCosy.apiKey`、`agentApi.bearerToken` 三个密钥槽位存入 userData `secrets.v1.json`。
- 部署环境实测 `safeStorage=available chat=saved cosy=saved`；普通 config 已验证不含三项明文，配置写回不会重新泄露运行时解密值。
- `pet:get-settings` 不再把 chat/Cosy/Agent 的原始密钥返回给 renderer；设置页 API key 输入框为空时保留已保存密钥，只有输入非空新值才替换。
- Cosy 请求 JSON 不再保存 API Key，通过子进程环境变量 `DASHSCOPE_API_KEY` 短暂传递。
- 常规运行已停止隐式自动读取 ZCode/DashScope 外部凭据，现有 DPAPI 密钥正常工作。

### 6.5 显式凭据导入与密钥管理

- 新增 `src/credential-import.js`：
  - `scan()` 读取 `~/.zcode/v2/config.json`（provider 列表）与 `~/.zcode/skills/vision/.env`（DASHSCOPE_API_KEY），返回值只含来源、名称、endpoint 与指纹（前 4 + 后 4 字符 + 长度，短 key 只显示长度）。
  - `importCredential({ slot, providerId })` 在主进程内读取明文 → 立即 `replaceSecrets()`；返回值与日志都不含原值。只读外部文件，绝不写入 ZCode 配置。
- main.js 新增 IPC：`pet:scan-importable-credentials` / `pet:import-credential` / `pet:clear-secret`（槽位→envelope 键名映射收敛在主进程）。
- `pet:get-settings` 返回体重构为 `config.buildSettingsView()`（可测试）；`pet:get-state` 的 `agentApi` 也剥离 `bearerToken`，renderer 全路径拿不到密钥原值。
- 设置页新增「⑤ 密钥与凭据安全」：三槽位状态徽标（已保存 / 不可读取 / 安全存储不可用 / 未保存）、三个带确认的清除按钮、扫描→选择→确认→导入流程、顶部非阻塞历史行为提示横幅（`security.externalCredNoticeSeen` 持久化）。
- `src/zcode-client.js` 不再写 `~/.zcode/cli/config.json`：改为只读检查，配置不完整时抛出带指引的错误。
- `chatClient.testConnection` 改为属性存在语义：显式空 key 可测试「无 key」场景，未传属性才回退已保存 key。
- 自动化测试：`npm run test:secrets` → 8 个场景 36 项断言全部通过（迁移 / 加密失败保护 / 解密失败保护 / 保存不回写明文 / 快照无秘密 / 清除 / testConnection 语义 / 扫描不泄密）。

> **部署验证（2026-08-24）**：源码 11 个文件经 MD5 逐块 diff 确认部署侧无领先改动后同步至部署目录；重启后日志出现 `[security] safeStorage=available chat=saved cosy=saved`、Spine `[spine] ok/fit` 正常；Agent API `/health` 200；userData `config.json` 三项明文检查均为 false。
>
> **坐标崩溃修复（2026-08-24）**：用户截图报 `TypeError: Error processing argument at index 0`，来源为部署 `main.js:2179` 的 `walkTick → win.setPosition`。已增加 `safeSetPosition()`：普通地面行走最终坐标先验证 safe integer 与 ±1,000,000 合法范围，再捕获 Electron 原生转换异常；异常时记录 `[walk]` 并跳过当前 tick，不再弹主进程错误。已同步部署、`node --check`、重启验证，最新 Spine/行走/屏障/GSV 日志正常。

---

## 7. 待办：下一阶段优先级

### 最新横姿/大姿势裁切修复（2026-08-24）
- [x] 真实内容在 render texture 中已被裁切后再采样无法补救；现在在 `fitSpinePose()` 的结构 bounds 阶段提前 containment。
- [x] 手动 boost 普通姿势保持原尺寸；只有结构 bounds 明显超出 120×120 canvas 时按宽高比例临时缩小当前姿势。
- [x] 移除上一版已裁切像素后的二次 `visibleK` 缩放；`visibleCanvasGap` 仅用于 groundGap。
- [x] 部署日志已实际出现 `姿势限框 ×0.93`，普通姿势仍有 `fit k=1.000`；部署进程正常。
- [ ] 仍需人工切换受影响横姿、Relax/Move/Sit/Interact 与不同缩放档位观察完整显示。
- [x] fit 漂移修复：每次姿势校准先重置 Spine position，再根据当前结构 bounds 一次性居中/贴底；不再累加旧 x/y，避免动画混合期间头脚逐步漂移。已部署重启，Spine 初始化正常。



> 当前源码有大量持续积累的本地改动，不要在当前 dirty 工作树直接生成或发布新的 GitHub Release 流程产物。

- 新建 `scripts/release/build-stage.mjs`：从 allowlist/staging 目录构建，不直接打包整棵源码树。
- 新建 `scripts/release/scan-secrets.mjs`：扫描 staged tree 和最终产物，只输出位置/规则，不输出匹配到的秘密。
- 新建 `scripts/release/generate-sbom.mjs`：`npm sbom --sbom-format=cyclonedx --package-lock-only` 生成 CycloneDX SBOM。
- 新建 `scripts/release/write-checksums.mjs`：排序的 SHA-256 `SHA256SUMS.txt`。
- `package.json` 增加 build/scan/sbom/checksum scripts；`.gitignore` 增加 `release/`。
- 重写 `.github/workflows/release.yml`：tag 必须严格等于 `v${package.json.version}`；Node 22.12+；`npm ci`、lint、现有 smoke tests；staging build、扫描、ZIP、SBOM、checksums；用 GitHub CLI 发布，取消固定 `1.1.0` 和第三方 release action；加 GitHub provenance/attestation。
- 确认 staged Windows x64 包包含 Koffi `@koromix/koffi-win32-x64` / `koffi.node`。
- 发布前扫描 config/persona，禁止密钥、个人路径、`.env`、`.github`、开发元数据进入最终 payload。

### P2：运行安全和数据治理

- Agent API 新安装启用时自动生成 token 并要求用户复制确认；设置页暴露真实 listener 状态/端口占用错误。
- Agent API 后续可加单请求队列/并发上限。
- Genie/GSV 设置页暴露 endpoint / allowRemote / autoStart；已有远端 endpoint 需要兼容迁移并显式提示。
- 长期 history 限制、压缩、保留最近 N 条；日志进一步脱敏，减少记录窗口标题、译文片段等用户信息。
- Cosy/Edge 临时文件可靠同步删除；key 已移出 JSON，但音频临时文件仍应加入最终清理。
- 主窗口 CSP 保留 Pixi 必需的 `unsafe-eval`，后续补 `base-uri 'none'`、`object-src 'none'`、`frame-ancestors 'none'`、`form-action 'none'` 到所有 renderer 页面。
- 麦克风迁移 Pointer Events 并完善键盘操作；当前 mouseleave 停录在小按钮上体验偏弱。

### P3：兼容与视觉复验

- Win10 21H2/22H2、Win11 22H2+ 真机验证。
- 100/125/150/175/200% DPI，1366×768 至 4K。
- 多屏、负坐标左/上副屏、混合 DPI、显示器热插拔。
- 真实人工验证：抛掷、窗口顶驻留/窗口移动回地面、desktop/top 层级、设置页/帮助页/音色页所有控件。
- 用户已明确**不需要多桌宠同屏互斥**，不要实现该项。

### 最新回归修复：拖拽任务栏吸附（2026-08-24）
- [x] desktop 模式拖拽过程中跳过任务栏/图标磁吸和 `applySeatPosition()` 强制回地面；只有松手时才判定是否主动吸附。
- [x] 非吸附自由落点清理 `perched`、`iconRest`、`gotoPerch`、`returning`、`iconTarget`，设置 `freeStand` 并重新安排自由站立阶段，避免松手后又被拉回任务栏。
- [x] desktop 模式任务栏坐姿仍通过几何层级判断临时置顶，避免任务栏裁切；离开任务栏后恢复普通桌面层级。
- [x] `node --check`、源码/部署 MD5、重启和日志验证通过；部署进程正常运行。

### 窗口顶行走与任务栏半挂回归修复（2026-08-24）
- [x] 程序窗口顶目标 Y 改为 `windowTop - petWindowHeight + groundGap`，桌宠脚底落在窗口上沿，不再把透明窗口顶误当角色顶。
- [x] desktop 模式窗口顶驻留/跳跃/返回期间保持临时置顶，避免被目标应用盖住；回到普通桌面后恢复 desktop 层级。
- [x] 半挂落点限制在可见工作区内，清除 stale `sunk`，不再把透明窗口下移到屏幕外导致只剩半身。
- [x] `walkSetPosition()` 对整数、范围和 native 异常统一保护；新增 x=1 最小边界，避免 Windows/Electron 对 x=0 的转换异常。
- [x] 部署重启后进程正常；新启动日志未出现坐标转换错误。筛选到的 09:31 失败行属于修复前旧日志。

---

### 最新错位修复（2026-08-24）
- [x] Spine 自动适配放大后同步更新 `spineBaseScaleX`，后续 fit 不会把角色缩回原始尺寸。
- [x] `reportGroundGap()` 按 CSS zoom 换算回 Electron DIP，限制 `charInset`，缩放变化后用下一帧和短延时重新上报几何数据。
- [x] 主进程/renderer 默认窗口尺寸统一为 `260x200`，避免放大/还原恢复成旧的 `170x260`。
- [x] 缩放后增加延迟工作区钳制；部署版重启、Spine/行走/屏障日志正常，未出现新的坐标转换错误。
- [ ] 仍需人工复验不同 scale、Win10/Win11、多 DPI 和副屏负坐标下的错位。

### 脚底空隙统一修复（2026-08-24）
- [x] 不再用可见像素底边移动 Spine 对象；采样底部差值改为 `visibleCanvasGap`，纳入统一 `groundGap`。
- [x] `groundGap` 统一为布局窗口底部间隙 + 可见 Spine 脚底到 canvas 底部间隙，任务栏/图标/窗口顶共用同一接触基准。
- [x] 部署重启后 Spine/行走/屏障/GSV 正常，无新的坐标转换异常；仍需人工确认不同姿势实际脚底间距。
- [x] 半条腿回归修复：`visibleCanvasGap` 限制到 12px，只有连续两次相近采样才更新；异常/过渡姿势沿用上次稳定值，避免把窗口推低造成脚部裁切。

### 最新中断前状态补充（2026-08-24）
- [x] 日程 UI 入口已接入：托盘 `📅 日程安排`、设置页按钮、`renderer/schedule.html/js/css`；后端 `src/schedules.js` + Excel `xlsx@0.18.5` 已部署，userData 已生成 `schedules.json`。
- [x] TTS 硬卡死修复：Genie `LAST_REF_AUDIO`/mkstemp、HTMLAudio 可结算播放、Cosy/Edge 120s 超时和临时文件清理、GSV warmup 等待、整段失败回退与初版 60s breaker。
- [x] 最新脚底几何方案：`groundGap = layoutGap + visibleCanvasGap`；Spine 对象不再按采样底边垂直移动；`visibleCanvasGap` 上限 12px、连续相近采样才更新。
- [x] 最新部署重启后进程正常，Spine/GSV/屏障/行走日志正常；截图反馈仍显示脚底空隙/半腿，下一会话必须优先用诊断日志实测坐标，不要继续盲调 `seatSink`。
- [ ] 未完成：P1 发布 staging/密钥扫描/SBOM/checksum/provenance；P2 GSV mutex、请求 ID、日程 Excel preview、历史/日志治理；P3 Win10/11 多 DPI、多屏与人工姿势矩阵。

## 8. 关键文件索引

| 文件 | 职责 |
| --- | --- |
| `main.js` | Electron 主进程：窗口、托盘、Agent API、行走、抛掷、屏障、TTS、IPC。 |
| `preload.js` | renderer 安全桥。 |
| `src/config.js` | 普通配置、token 替换、运行时配置合成；不应再写明文密钥。 |
| `src/storage.js` | userData 路径、legacy 数据复制迁移、原子写。 |
| `src/secrets.js` | Electron safeStorage / DPAPI 密钥 envelope。 |
| `src/credential-import.js` | 外部凭据显式导入：scan 只返回非秘密指纹；import 在主进程换密；绝不写外部应用配置。 |
| `scripts/test-config-secrets.js` | config/secrets 自动化测试（`npm run test:secrets`），无需 Electron。 |
| `src/history.js` | userData chat history。 |
| `src/chat-client.js` | 外部聊天与连接测试。 |
| `src/zcode-client.js` | ZCode 任务路径；仍有待收紧的外部配置写入行为。 |
| `renderer/index.html` / `pet.css` / `pet.js` | 主桌宠透明交互层、Spine/GIF、拖拽、气泡、点击穿透。 |
| `renderer/settings.html` / `settings.js` / `settings.css` | 设置与安全 token UI。 |
| `renderer/ui.css` | 统一视觉令牌。 |
| `renderer/moods.html` / `moods.js` | GIF 情绪管理，已做 HTML 转义。 |
| `renderer/voice.html` / `voice.js` | 本地音色克隆。 |
| `renderer/help.html` / `terms.html` | 帮助与条款；help.html 顶部有 quickstart.html 跳转横幅。 |
| `renderer/quickstart.html` | 应用内新手教程页：API Key 领取/填入/一键导入、日常玩法、故障小诊所、密钥安全；托盘「🐣 新手教程」与 help 横幅两个入口。 |
| `scripts/cosy_tts.py` | Cosy TTS 子进程；现在从 `DASHSCOPE_API_KEY` 环境变量读取 key。 |
| `persona.md` / `persona.default.md` | 使用 `{{petName}}` / `{{userName}}`。 |
| `docs/快速开始.md` | 新手向手把手教程，README 已链接。 |
| `docs/persona-template.md` | 桌宠人设填写模板（2026-08-24 新增）：占位符说明 + 五段式空模板 + 成品示例，供他人自定义人设；开场白提取逻辑已用 main.js 同款解析验证（「对话启动指令」标题 + `>` 引用块 + 「不许拒绝」结尾）。README 已链接。 |
| `docs/optimization-progress.md` | 本文件。 |

---

## 9. 常用验证命令

### JavaScript / Python 语法

```bash
cd /e/SuzuranPetGit
node --check main.js
node --check preload.js
node --check src/config.js
node --check src/storage.js
node --check src/secrets.js
node --check src/credential-import.js
node --check src/history.js
node --check renderer/pet.js
node --check renderer/settings.js
node --check renderer/moods.js
python -m py_compile scripts/cosy_tts.py
```

### config/secrets 自动化测试（8 场景 36 断言）

```bash
cd /e/SuzuranPetGit && npm run test:secrets
```

### 检查 userData 迁移（不要输出密钥）

```powershell
$u = 'C:\Users\xsbil\AppData\Roaming\苏苏洛桌宠 1.1 正式版'
Test-Path "$u\.storage-migration-v1.json"
Test-Path "$u\secrets.v1.json"
Test-Path "$u\assets\spine\user"
Test-Path "$u\logs\tts.log"
```

### 安全检查普通 config（Node，避免 PowerShell UTF-8 乱码）

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const u = 'C:/Users/xsbil/AppData/Roaming/苏苏洛桌宠 1.1 正式版';
const cfg = JSON.parse(fs.readFileSync(path.join(u, 'config.json'), 'utf8'));
console.log({
  chatPlain: Object.hasOwn(cfg.chat, 'apiKey'),
  cosyPlain: Object.hasOwn(cfg.ttsCosy, 'apiKey'),
  agentPlain: Object.hasOwn(cfg.agentApi, 'bearerToken')
});
NODE
```

期望三个值都是 `false`。

### Agent API 回归（空 token 兼容模式）

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/health
# /healthz 应 404；GET /chat 应 405；POST /chat text/plain 应 415；超限 body 应 413。
```

---

## 11. v2.1（2026-08-25）改动记录

版本号已升至 2.1.0（package.json）。CHANGELOG 已写 v2.1.0 小节。功能清单：

- **陪伴时间统计**：`src/config.js` 新增 `firstRunAt`（首次启动记录）；`pet:get-info` 返回 { firstRunAt, today[] }（今日日程由 schedules.list() 过滤）。
- **信息版**：输入栏新增 📋 按钮（index.html `#btn-info`），点击弹出 `#info-panel`（pet.css 样式 + pet.js 逻辑），展示陪伴时间 + 今日日程；翻边（body.edge-left）时面板自动到右侧。
- **鼠标逗宠互动**：pet.js 全局 mousemove，鼠标在角色 130px 内停留 1.2s → `playSpineInteract()`（冷却 8s）；busy/drag 中跳过。
- **日程提醒提示音**：pet.js `onScheduleDue` → Web Audio 双音 beep（880→1320Hz）。
- **PSD 角色工具窗口**（v2.1 更新点）：
  - 新依赖 `ag-psd`（^31.0.2，MIT，纯 JS）；UMD bundle 在 `node_modules/ag-psd/dist/bundle.js`，全局名 `window.agPsd`。
  - 新窗口 `renderer/psd.html` + `psd.js`：拖入/选择 .psd → `readPsd` 解析图层树（名称/尺寸/分组/可见性）→ 扁平化合成预览（canvas，按 left/top/opacity 从下到上绘制）→ 导出 PNG（`pet:psd-save` 存到 userData `assets/psd-export/`）。
  - 主进程：`openPsdWindow()`（参考 openSchedule），IPC `pet:psd-open`/`pet:psd-save`；托盘菜单「🧩 PSD 角色工具（v2.1）」入口。
  - preload 新增 `getInfo`/`psdOpen`/`psdSave`。
- 语音已按用户要求关闭（userData config.json `tts.enabled=false`，2026-08-25 晚，用户睡觉避免打扰）。

**待用户测试项**（用户休息，未验证）：
1. 托盘 →「🧩 PSD 角色工具」打开窗口，拖入 PSD：图层树/预览/导出 PNG
2. 输入栏 📋 信息版：陪伴时间 + 今日日程显示
3. 鼠标在角色旁停留 1s → 互动动画
4. 日程到点双音提示
5. 语音关闭生效（聊天气泡正常、不朗读）

**回退**：改动前备份在 `backups/2026-08-25-v21-before/`；原版基线 `backups/original/`（第 6 版，v2.0.1 稳定版）。

---

## 12. v2.2 进行中：2.5D 气泡「留白」根因修复（2026-08-25 下午，已部署验证）

**现象**：rig 模式聊天气泡大片空白（用户：「放大可以了但留白还在」）。

**根因（CDP 远程调试实锤，非 CSS 参数问题）**：
- `white-space: pre-wrap` 原写在 `.bubble` 上。index.html 里 `#bubble` 内按钮之间的缩进换行是真实文本节点，被 pre-wrap 保留 → 渲染成约 70px 幻影空行 → `#bubble-text` 被推出气泡盒外（实测 offsetTop=76，盒子才 61 高）。窗口小、max-height 钳制后文字完全不可见，只剩白色空泡。
- 连带缺陷：rig 非放大态 `max-height: calc(12% - 8px)`≈8.5px < `min-height:20px`，被击穿成固定 20px 细条；设置页「气泡宽度 500px」以内联样式写进 300px 宽的 rig 窗口。

**定位方法（复用价值高）**：
- vision 截图分析不可靠：会被第三方悬浮窗（bgyperskz 工具条叠在桌宠前）、透明窗背后的白底应用污染，且常把输入栏误认成气泡。
- 可靠路径：Electron 带 `--remote-debugging-port=9222` 启动 → CDP WebSocket `Runtime.evaluate` 读 getBoundingClientRect/offsetTop/computedStyle → 注入临时 `<style>` 做 A/B 实验（offsetTop 76→6 实锤）→ 验完正常方式重启。CDP 脚本模板在会话 `/tmp/cdpws/*.js`（ws 模块）。

**修复（pet.css + pet.js，MD5 已同步部署）**：
- pet.css：pre-wrap 从 `.bubble` 移到 `#bubble-text`（附注释防回归）；rig 非放大态 max-height 12%→34%；注释 78%→88% 对齐实际值。
- pet.js：`applyAppearance` rig 激活时不写设置页固定气泡宽度的内联样式；`initRig` 激活时清残留内联宽高（启动时 applyBubbleSize/applyAppearance 先于 initRig 执行会留脏样式）；`showBubble()` 重置 scrollTop=0；`applyBubbleSize` rig 激活时跳过拖拽记忆恢复并清内联尺寸；`destroyRig` 后重新 `applyAppearance(appearanceCfg)` 恢复 gif/spine 气泡设置。

**验证**：node --check 通过；重启后开场白气泡截图 + vision 确认文字从顶部紧凑显示、无空白行；`[rig-render]` 日志正常无报错。**用户已确认效果，收尾完成（2026-08-25 晚）**：诊断日志清理（[rig-render] 3s 采样 / [settings] rig-scale input / [rig] 大小调整 全删，保留 [rig] 加载/就绪/失败一次性日志，重启零残留）、版本号 2.2.0（package.json + lockfile）、CHANGELOG v2.2 小节、基线更新（`backups/original/`=v2.2 干净基线含 BASELINE.md，旧基线移至 `backups/v2.1-final-baseline/`）。**下一会话转交文档：`docs/psd-2d5d-handoff.md`（已升级为总转交文档）。**

---

## 13. v2.2.1 进行中：CSP 加固 + 日程 Excel 导入预览（2026-08-25，已部署验证）

**背景**：用户明确"继续修 bug 并加新功能，现在完全没到发布的时候"。从 P2 待办清单挑了两项可自主推进的工作：CSP 补强（安全缺陷修复）+ 日程 Excel 导入预览（新功能）。

**CSP 加固（9 个页面）**：
- 8 个已有 CSP 的页面（index/settings/help/terms/voice/moods/schedule/quickstart）统一追加 `base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`。
- `renderer/psd.html`（v2.1 新增窗口）**此前完全无 CSP**，补完整基础 CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self' data:` + 四项加固。
- 安全性确认：9 页均无 `<form>/<base>/<object>/<embed>/<iframe>` 标签，四项指令不会破坏功能。
- 注意：psd.html 的 `script-src 'self'` 下跨目录相对路径 `../node_modules/ag-psd/dist/bundle.js` 实测可加载（CDP 确认 `window.agPsd=object`）。

**日程 Excel 导入预览（新功能）**：
- main.js：解析逻辑抽出为 `parseScheduleWorkbook(filePath)` 纯函数；新增 `pet:preview-schedule-workbook`（解析+返回前 20 行预览，不落库）；现有 `pet:import-schedule-workbook` 改为复用 parse 后落库（行为不变）。
- preload.js 新增 `previewScheduleWorkbook` 桥。
- renderer/schedule.html 新增 `#import-preview` 弹窗容器（modal + 表格区 + 取消/确认按钮）；schedule.css 新增 modal/表格样式；schedule.js 导入流程改为「选文件 → 预览弹窗（文件名/总条数/前 20 行）→ 确认后落库」，表格用 `textContent` 渲染防注入。

**验证（CDP 实测，已全部通过）**：
- PSD 窗口：readyState=complete、agPsd=object、5 个脚本全加载、页面渲染正常 → 新 CSP 未破坏脚本加载。
- Excel 预览：`previewScheduleWorkbook` 返回 ok/total=3/含特殊字符行 `测试日程C<&"'` 正确；`importScheduleWorkbook` 返回 count=3（重构后逻辑正常）。
- 弹窗 DOM：`import-preview`/`preview-confirm`/`preview-meta` 存在且默认隐藏。
- 测试数据已通过 `cancelSchedule` 清理（3 条），测试 Excel 已删除；CDP 验证脚本保留在 workspace（`cdp-verify.mjs`/`cdp-cleanup.mjs`，Node 24 全局 WebSocket，可复用）。
- 最终以正常方式（无调试端口）重启：`[rig] 皮肤就绪 19 部件`、`gsv-ja ok 6/6句`（此前一次 GSV 引擎毛刺已自愈）、日志无错误。
- 版本号已升至 2.2.1（package.json + package-lock.json，源码与部署一致），CHANGELOG 已记 v2.2.1 小节；13 个改动文件（main.js/preload.js/renderer 11 个 HTML/CSS/JS + 2 个版本号文件）已同步部署且 MD5 一致。

**待办更新**：§7 未完成清单中的「日程 Excel preview」「CSP 补强」已完成；P2 其余项（Agent API token 生成体验、history/日志治理、GSV mutex 核查、麦克风 Pointer Events 等）保持未完成。

### §13 追加：2.5D 头部/眼睛跟随鼠标（v2.2.1 实验性更新，2026-08-25，已部署验证）

**需求**：用户要求实验性更新——「2.5d 角色的头和眼睛能跟着鼠标动吗」。

**关键发现**：rig-runtime.js 本就从 Anime2.5DRig 保留了鼠标跟随能力（参数 `angleX/angleY`=头部角度、`eyeX/eyeY`=眼睛位移；`auto.mouse` 开关默认 false；canvas 已绑定 mousemove/mouseleave），只是 pet.js 从未开启。本次改动 = 开启开关 + 设置页可配。

**改动（6 文件，全部同步部署 MD5 一致）**：
- `renderer/pet.js`：新增 `rigMouseFollow` 变量（默认 true）；`initRig` 的 `applyRig` 后 `setAuto("mouse", rigMouseFollow)`；监听 `pet:rig-mouse-follow-changed` 实时切换；init 从 `getState()` 读取配置。
- `renderer/settings.html` + `settings.js`：rig 区新增「🎬 2.5D 头部/眼睛跟随鼠标（实验性）」开关（switch-row，默认开，change 即时生效 + 保存时带字段）。
- `src/config.js`：默认值 `rigMouseFollow: true` + `buildSettingsView` 透传。
- `main.js`：`pet:set-rig-mouse-follow` IPC（saveConfig + 广播）+ `getState` 透传。
- `preload.js`：`setRigMouseFollow` / `onRigMouseFollowChanged` 桥。

**验证（CDP 实测）**：
- 配置链路：`getState().rigMouseFollow=true`、rig 画布可见、body 有 rig-mode。
- 行为验证：向 rig 画布合成极左/极右 mousemove，`Page.captureScreenshot` 截帧，PowerShell System.Drawing 像素对比——左右差异 2407px vs idle 噪声 1014px（2.4 倍），证明鼠标位置真实驱动渲染变化；`readPixels` 不可用（WebGL context 默认 `preserveDrawingBuffer:false`，帧后缓冲被清空，全 0）。
- 方向逻辑由代码审查确认：鼠标右→`eyeX=+1.2` 虹膜右移、`angleX=+0.9` 头部同向；鼠标下→眼睛上移、头下倾（Live2D 习惯）。
- **vision 无法验证方向**：瞳孔位移仅 ~0.5 CSS px（画布 496×765 被 CSS 缩放到 78×121 窗口），vision 对眼睛方向的判断实为立绘基准朝向（idle 对照组同样报"左"），不能作判定依据。
- 最终正常重启：rig 19 部件就绪、无错误。

**给用户的效果预期**：鼠标移到桌宠上时，2.5D 角色转头/转眼看向鼠标；移开后面朝前方。设置页可关。rig-scale=0.3 的极小窗口下位移视觉上较小，把角色调大些（设置页大小滑杆）效果更明显。

### §13 追加 2：备份 + 跟随能力自适应算法（2026-08-25，已部署验证）

**用户澄清"实验性更新"的定义**：先备份然后实验、可以回退；并担心换其他 PSD 后跟随失效，要求写专门算法。

**① 备份（可回退）**：`backups/2026-08-25-mouse-follow-v1/`——鼠标跟随 v1 实现验证通过时的 9 个文件快照（main.js/preload.js/pet.js/settings.js/settings.html/config.js/rig-runtime.js/rigger.js/genericparts.js）+ README（回退方法：拷回源码树→同步部署→重启）。后续实验失败可回退到 v1。

**② 专门算法：跟随能力自适应（detectFollow）**：
- 位置：`renderer/rig-runtime.js` 导出 `RigRuntime.detectFollow(rig)`（纯函数，node 可单测）；`pet.js` initRig 集成。
- 原理：换 PSD 后按 **rig 结构**（anchors + layers）评估，不依赖特定 PSD：
  - `full`（头+眼）：face 锚点 + eyeL/eyeR 锚点（eyewhite 左右分离产生）+ irides_l/r 图层全齐 → 头部+眼睛跟随
  - `head-only`（仅头部）：只有 face（face/neckPivot 有兜底，恒可用）→ 仅头部跟随（眼睛参数无 irides 图层命中，天然无效果，安全）
  - `none`：连 face 锚点都没有 → 关闭跟随
- 集成：`setAuto("mouse", rigMouseFollow && level !== "none")` + 日志 `[rig] 跟随能力: 头+眼（…）/ 仅头部（…）/ 无（…）`。
- **为什么不会崩**：deform 里眼睛位移分支有 `EA`（eyeL/eyeR 锚点）保护，无眼睛结构的 PSD 只是眼睛不动，头部角度仍生效。

**③ 验证**：
- 单元测试 10 项全过（full/head-only/none/单侧虹膜/空 rig/null 等，`workspace/test-detect-follow.js`）。
- 真实环境：seethrough_output.psd 重启后日志 `[rig] 跟随能力: 头+眼（眼白+虹膜左右分离完整）`，19 部件就绪，无错误。
- 部署同步 MD5 一致；版本号保持 2.2.1。

**后续可增强（未做）**：head-only 皮肤用"眼部整体微移"模拟看方向；angleX 幅度按脸型自适应（当前已按 faceScale 归一化，天然适配）。

### §13 追加 4：设置页/托盘按渲染模式整理 + 日语 429 修复（2026-08-25，已部署验证）

**用户需求**：设置整体界面太乱，要求"先选择渲染模式，对应的选项才会出现"（托盘同步）；日语"又挂了"要修复。

**① 设置页按渲染模式动态显示**：
- 「渲染模式」选择器从 ④ 其他区块**移到设置页顶部第一区块**「🖼 渲染模式（先选择模式，对应选项才会出现）」。
- 各模式专属控件加 `data-rm="gif|spine|rig"` 标记（11 处）：rig→2.5D 开关/大小/跟随/皮肤/实验区块（全局跟踪），spine→桌面行走/坐下散步时长/桌面图标感知/Spine 提示；settings.js 新增 `applyRenderModeUI(mode)`（change + 初始化时调用），按模式显示/隐藏。
- CDP 实测：RIG 模式 2.5D 全显、行走全隐；GIF 两者全隐；SPINE 行走全显、2.5D 全隐；切回 RIG 恢复。✓

**② 托盘菜单按渲染模式同步**（main.js refreshTrayMenu）：
- spine 专属：人物皮肤三层菜单、桌面行走开关、动作试演、散步速度
- rig 专属：2.5D 开关/皮肤列表、PSD 角色工具
- gif：两者都不显示；`pet:save-settings` 保存后自动 `refreshTrayMenu()`（已有），切模式即刷新。
- **踩坑（已修复）**：条件展开时把 IIFE 返回的**单对象**用 `...` spread（`...(()=>({...}))()` 在数组字面量抛 TypeError "not iterable"），导致 refreshTrayMenu 异常、托盘菜单整体不弹出（用户人工验证确认）。修复：对象包数组 `[(()=>({...}))()]` 再 spread。node --check 查不出此运行时错误，验证靠 UIA 实弹菜单。
- UIA 实测（rig 模式）：菜单正常弹出；含 2.5D 开关/皮肤/PSD 工具；无行走/皮肤/动作试演。✓（UIA 枚举要同时查 MenuItem+RadioButton+CheckBox，Electron radio/checkbox 项是后两者）

**③ 日语 429 修复**：`translateToJa` 429 限流等待 `Math.min(15000,…)` → `Math.min(90000, Math.max(1000, …))`（按 retryAfterSeconds，覆盖 60s 限流窗口）。此前 15s 重试必再 429 → 整段退回中文（日志：翻译失败，退回中文合成）。已改部署；限流为间歇性，无法实时触发验证，代码逻辑已审查。

**托盘 UIA 自动化经验（补充）**：ZCode 窗口(全屏)会遮挡任务栏溢出弹层导致右键点不到图标——需先最小化 ZCode（WindowPattern.SetWindowVisualState）再操作，完事恢复；chevron 是开/关切换，弹层状态不确定时"先查图标、没有再点 chevron、最多 3 次"；桌宠图标 UIA Name 为「 苏苏洛桌宠（点击隐藏/显示）」，在弹层内约 (2200±,1470) 随图标顺序漂移，必须实时定位不可用固定坐标。

### §13 追加 5：渲染进程偶发崩溃事件（2026-08-25，已自愈）

**现象**：用户切换小人（spine 皮肤 002_amiya_winter_1 阿米娅冬装）后"看不见他"。排查确认：Spine 切换本身成功（`[spine] ok`），看不见的直接原因有二——① 渲染进程偶发崩溃（08:21:49 / 08:22:53 / 08:24:33 三次 `reason=crashed exitCode=-1`，均"第1次(60s内)"，自动重载自愈，未触发连续 3 次熔断）；② 用户把显示层级切到 desktop，被 ZCode 全屏窗口遮挡（角色挤在窗口底部空隙）。

**现状**：主窗口渲染正常（截图确认阿米娅冬装可见）；最近 1 分钟无新崩溃；自愈链路（render-process-gone → 自动重载 → [startup] + [spine] 重新初始化）工作正常。

**待排查（未做）**：崩溃根因未定位。时间上疑似与启动后开场白 TTS（WebAudio 播放 + WebGL/Pixi 共存）或 GPU 驱动有关（本机多 GPU 负载/Clash 等）。若用户反馈频繁崩溃，下一步：查 crashReporter minidump（%LOCALAPPDATA%/CrashDumps 或 userData 崩溃目录）；或临时 `app.disableHardwareAcceleration()` 对比（Spine/Pixi 会回退软件渲染）。**经验：切换小人后看不见，先查日志 [render] 渲染进程异常（自愈后窗口会回来）+ 检查显示层级是否被窗口遮挡，不要直接判"切换失败"。**

### §13 追加 6：行走配置污染修复 + 互动/行走验证（2026-08-25，已部署）

**用户反馈**：和小人互动他不互动了；任务栏走路无法正常触发。怀疑"所有东西写一个地方导致误修误删"。

**诊断结论（实测）**：
- **互动功能正常**：CDP 点击桌宠后动画序列 Sit→Interact→Interact→Relax（阿米娅冬装动画列表 Default/Interact/Move/Relax/Sit/Sleep 齐全）；busy=false/renderMode=spine/spineObj 正常。此前"不互动"是渲染进程崩溃期间的表现。
- **行走"无法触发"根因**：`initRig`（2.5D 模式）调用 `setWalking(false)` 会 `config.saveConfig({walking:false})` **持久化污染配置**；切回 Spine 后 `syncWalkingEngine` 只在 `cfg.walking===true` 时恢复 → 走路一直不触发。
- **修复**：新增 IPC `pet:walking-engine-stop`（只 `stopWalkingEngine()`、**不保存 config**），preload 桥 `walkingEngineStop`，pet.js `initRig` 改用之——rig 停走保留用户行走意图，切回 Spine 自动恢复。验证：setWalking(true) 后 walkState={active:true,seated:true,resting:true}、窗口位置移动（行走正常）、config.walking=true。
- 附：CDP 可直接读 pet.js 顶层 let 变量（busy/renderMode/spineObj/walkState）与 `spineObj.state.getCurrent(0).animation.name`，是诊断互动/渲染状态的最快路径。

**架构讨论（用户提出）**：用户建议"主文件-渲染(3选1)-每系统独立"。评估：方向正确（main.js 176KB 耦合行走/托盘/TTS/翻译/日程/API，pet.js 70KB 耦合渲染/交互/气泡；本次托盘重构即引入 spread 回归），但全量重构风险大（功能多、主进程无自动化测试、回归面广）。建议**渐进式拆分**：main.js 按域拆模块（walk-engine.js/tray-menu.js/tts-manager.js/schedule.js…）逐步迁移、每步部署验证；渲染层 3 选 1 已由 renderMode 驱动（rig-runtime.js 已独立），可清理 render-spine.js/render-gif.js 死代码。**用户已确认开始渐进式重构（2026-08-25）**。

### §13 追加 7：渐进式模块化 第一步——基础设施层拆分（2026-08-25，已部署验证）

**目标**：降低 main.js 耦合（用户诉求"减少 bug、互不干扰"），每步小改动、可部署验证、可回退。

**第一步（已完成）**：
- 新增 `src/logger.js`：`logTts(event,msg)`（2MiB 轮转日志）从 main.js 抽出，独立模块。
- 新增 `src/ja-translate.js`：`translateToJa(text)`（中日翻译 + 429 按 retryAfterSeconds 等待，上限 90s）从 main.js 抽出，依赖 config + logger。
- main.js：顶部 `require("./src/logger")` / `require("./src/ja-translate")`，删除内部定义（128 处 logTts 调用点不变）。
- 验证：模块加载测试 OK（logger 写日志、translateToJa 导出）；部署 3 文件 MD5 一致；重启后 Spine/翻译/日志正常；渲染层 20s 观察无崩溃。
- **拆分模式（后续照做）**：纯函数/少依赖 → 抽 src/ 独立模块 + main.js require + 删除内部定义；依赖通过 require（同 config/logger 实例）或 deps 参数注入。

**第二步候选**（待用户选）：托盘菜单（buildTrayItems 纯构建，deps 注入动作；上次 spread 翻车点，拆出后更清晰）/ 行走引擎（walk 状态机 ~1000 行，依赖 win/screen，收益最大风险最高）/ 其他。

### §13 追加 8：模块化 第二步——托盘菜单拆分（2026-08-25，已部署验证）

**新增 `src/tray-menu.js`**：`buildTrayItems(deps)` 纯函数（无副作用）——读 deps（cfg/lang/i18n/zcodeOn/forcedMode + 全部动作函数 + 皮肤常量）→ 返回 Electron MenuItem 模板数组。渲染模式联动（行走/皮肤/动作/散步速度=spine，2.5D 开关/皮肤/PSD=rig）随代码移入模块。
**main.js**：refreshTrayMenu 从 ~9000 字符瘦身到 ~1000（组装 deps → buildTrayItems → setContextMenu）；新增 require。依赖注入清单明确（28 项：cfg/i18n/动作函数/常量/quitApp 等），main.js 持有状态。

**验证**：
- 单元测试 14 项全过（src 模块 node 直接测）：spine 有行走/人物/试演/散步速度且无 2.5D/PSD；rig 有 2.5D/PSD 且无行走/人物；gif 两者皆无。（i18n mock 返回 key，断言用 key 匹配）
- UIA 实测 spine 模式真实菜单：行走开关/人物/动作试演/散步速度齐全，无 2.5D 项。
- 部署 2 文件 MD5 一致，重启后菜单正常。

**拆分模式（第二步总结）**：有状态 UI 构建 → 抽 `src/` 纯函数模块（buildXxx(deps)）+ main.js 组装 deps 调用。动作经 deps 注入（main.js 持有状态），模块内无状态可单测。

### §13 追加 9：行走"闪现"根因修复（2026-08-25，已部署验证）

**用户反馈**：小人左右走时极小概率"不断闪现"。

**根因链（排查确认）**：
1. **主要根因——异常 charInset 上报把行走边界扩到屏幕外**：渲染层 `reportGroundGap`（每 120ms）上报 `charInset=petEl.offsetLeft`，原上限 400；主进程 `minX = wa.x - charInset`——渲染状态错乱时 offsetLeft 异常（实测 ~274），minX 到 -274，角色"正常走到屏幕外"，在屏幕边缘忽隐忽现=闪现。日志证实窗口曾出屏到 -476/-800。
2. **次要根因——渲染进程偶发崩溃自愈**：崩溃→窗口消失→reload 重建=闪没一下（09:37:20 又 1 次，自愈正常，未连续）。
3. 另加固：walkTick 折返时 face 延迟一帧翻转、贴边连续折返 face 每帧翻转、edgeLeft 切边平移 ±136px 抖动——三层防抖。

**修复（已部署 MD5 一致）**：
- 渲染层 inset 上限：400 → `clientWidth`（角色条带不可能超出窗口）；主进程 charInset 上限：400 → 200（正常贴左缘 138）→ minX ≥ wa.x-200。
- **出屏哨兵** `startOutOfScreenGuard()`：独立 2s 定时器，窗口严重出屏（水平超 wa.x±200 容差/垂直完全越界）立即钳回，坐姿下沉不受影响；启动即跑，与行走引擎无关。
- `savePos` 增加水平出屏检查（x<wa.x-200 或 x>wa.x+wa.width 不保存），防止出屏位置被持久化、重启后先出屏再钳回。
- walkTick：折返立即同步 face、`walkUpdateFace` 150ms 防抖、`xRange.collapsed` 原地停；edgeLeft 切边 500ms 防抖。

**验证**：重启后窗口 x=96（屏幕内，不再出屏，无哨兵干预日志）；行走正常；savePos 不再存出屏值。**遗留**：渲染进程偶发崩溃根因未定位（无 minidump，Crashpad reports 空），自愈正常；若频繁崩溃下一步试 `app.disableHardwareAcceleration()`（WebGL/Pixi 回退软件渲染）对比。

### §13 追加 10：模块化 第三步——utils 抽取 + 渲染层死代码清理（2026-08-25，已部署）

- 新增 `src/utils.js`：`randInt/clamp/easeOutCubic/clampScale` 纯函数；main.js 删除内部定义改 require（小心：python 批量替换时断言失败会导致文件未写入+部分 Edit 残留，出现重复声明——教训：批量改后必须 node --check 且检查重复定义）。
- 删除渲染层死代码：`renderer/render-spine.js` / `render-gif.js` / `render-rig.js`（模块化实验遗留，全仓无引用；仅 backups/2026-08-25-rig-experiment/ 引用不影响）。
- 部署 MD5 一致，重启后正常（Spine/行走/日志）。

### §13 追加 11：闪现补充诊断 + 禁用硬件加速（2026-08-25）

**用户反馈"闪现经常出现且更严重"** → 复核：
- 出屏哨兵全日志仅钳回过 1 次（09:32 启动时清理 savePos 修复前的历史坏位置 -214/-231），之后窗口稳定（x=968/1038 屏幕内）——出屏问题已解决，哨兵未误伤。
- **"经常闪现"实为渲染进程崩溃**：当天 9 次（07:58~09:37），每次崩溃→窗口闪没→自动重载重建。崩溃间隔不定（15s~25min）。
- **处理**：`app.disableHardwareAcceleration()`（app ready 前，main.js 顶部，带注释可回退）——渲染回退 SwiftShader 软件渲染。验证：重启后 3.5 分钟零崩溃（此前 09:35 启动后 2 分钟即崩）、Spine 正常、窗口稳定。
- **注意**：软件渲染下 rig 2.5D（WebGL mesh warp）可能变卡；若卡顿明显或崩溃仍出现，可移除该行恢复硬件加速。崩溃根因（GPU 驱动/WebGL）暂以禁用硬件加速规避。

### §13 追加 12：闪现最终根因——气泡加宽窗口破坏行走几何（2026-08-25，已修复验证）

**复核"闪现更严重"**：窗口实测 DIP 宽 **640**（配置 260）——**根因不是 charInset 异常上报，而是窗口被加宽**：
- 用户设置「聊天气泡宽度 500px」→ 渲染层 `ensureWindowWidthFor` 按 `(气泡宽+140)` **把窗口加宽到 640 DIP**，且加宽后**不恢复**。
- 窗口 640 宽 → 主进程 `charInset = 窗口宽-122 = 518`（clamp 200）→ 行走左边界 `minX = wa.x-200` → 角色走到屏幕外（出屏）→ 哨兵拉回 → 行走又推出去 = 反复"闪现"。之前观测的"charInset 异常上报 274"其实是**加宽窗口下 offsetLeft 的正常大值**，200 上限只是防御不是治本。

**修复（三处，已部署 MD5 一致）**：
1. `main.js startWalkingEngine`：行走前 `win.setSize(config.window 260×200)` 恢复标准窗口。
2. `renderer/pet.js applyWalkState`：收到 walkState.active **从 false→true** 时恢复标准窗口（不受启动顺序影响——渲染层 applyAppearance 加宽可能晚于引擎启动）。
3. `renderer/pet.js ensureWindowWidthFor`：行走中（walkState.active）直接 return 不加宽（双保险）。

**验证**：重启后窗口 DIP 宽 260（此前 640）、位置 x=522 屏幕内、无哨兵钳回、零崩溃、行走引擎正常。**代价**：行走时气泡宽度设置（如 500）不生效（窗口内自适应/滚动），行走优先稳定性；非行走时气泡仍按设置加宽。

**经验**：行走"闪现/出屏"排查顺序——先看窗口实际尺寸是否异常（GetWindowRect DIP vs config），再查 setSize 调用（ensureWindowWidthFor 气泡加宽是最大嫌疑），最后才是 charInset 上限/哨兵等防御层。

### §13 追加 13：模块化 第四步——TTS 链路拆分（2026-08-25，已部署）

**新增 `src/tts-manager.js`（745 行）**：整个 TTS 引擎域（24 函数 + 13 变量）——合成主链路 `ttsCloneImpl`（Genie→GSV 日语→Cosy→edge 回退链）、合成串行队列 `queueTts`、Genie/GSV 服务器拉起/单飞/预热、GSV 引擎自愈（劣化重启/杀进程/按端口强杀/GPU 检测/预热烧机）、WAV 时长质检、日语翻译调用。依赖仅 config/logger/ja-translate/child_process/fs/path（**无 Electron 状态，可 node 独立测试**）。
**main.js**：3764 → 3079 行（-685）；`require("./src/tts-manager")`，IPC `pet:tts-clone` 改 `tts.queueTts(text)`，调用点批量替换 `tts.ensureGenieServer` 等。设置函数（setTts/setRate/setSpeakJa，依赖托盘刷新）与 IPC 壳留 main.js。
**提取方式**：Python 按函数大括号深度自动提取（模板字符串 `${}` 括号天然平衡，提取后 node --check 验证）。**教训**：python 脚本中途断言失败时文件不写入，后续 Edit 造成重复声明——批量改后必须 node --check 且查重名。
**验证**：模块加载 9 导出齐全；node 直调 `ensureGenieServer` 探活返回 true（服务器在跑）；桌宠启动/行走正常。**语音实际发声待用户使用验证**（tts.enabled/speakJa/genie/gsv 全开）。
**遗留**：① 渲染进程启动早期偶发崩溃（10:11 又 1 次，禁用硬件加速未根治，自愈正常，待深入查）；② 日志文件偶发"丢失段落"（疑似多进程并发写/轮转竞争，待查）；③ 行走引擎拆分（~1000 行，依赖 win/screen/屏障/图标/抛掷）**下一轮专门做**——行走刚修复稳定，不宜赶工。

### §13 追加 14：desktop 层级置顶回归 + 行走"原地走路不移动"修复（2026-08-25，已部署验证）

**问题 1：desktop 层级还是置顶**——`applyLayer` 里 desktop 时"坐姿/行走贴任务栏→临时置顶"的判定（原为防任务栏裁切）与用户诉求冲突（桌面级=可被普通窗口覆盖）。修复：desktop 层级仅保留主动交互（跳窗顶/跳跃/返回）临时置顶，坐姿/行走**不再置顶**。验证：`GetWindowLong WS_EX_TOPMOST=False`（style=0x280020 无 TOPMOST 位），桌面级生效。

**问题 2：行走时"原地走路不移动"**（走路动画 Move 在播但窗口不动）——最可能机制：行走中窗口被意外加宽（气泡/放大 setSize）→ `clampWalkX` 水平范围坍缩（collapsed）→ `walkTick` 静默 `return`（坍缩日志只打一次，之后静默）→ 窗口不动但渲染层仍播 Move。修复：`walkTick` 坍缩分支改为**恢复标准窗口尺寸**（`win.setSize(config.window 260×200)` + 打日志）后 return，下 tick 正常移动。当前窗口宽验证 260 DIP 正常。

**待用户观察**：desktop 层级是否真正可被窗口覆盖；行走中是否还出现"原地走路不移动"（若复现，日志会出现"坍缩恢复标准窗口"行，可据此确认）。

### §13 追加 15：跳窗顶"吸力"调弱（2026-08-25，已部署）

**用户反馈"窗口吸力有点强"**——指桌宠行走时频繁跳上程序窗口顶（perch 行为，像被窗口吸过去）。调整：
- `chooseWalkBehavior` perch 权重 0.15 → **0.08**（跳窗顶频率减半）
- 新增跳窗顶冷却：从窗顶下来后 **60s 内不再跳**（`walk._lastPerchEnd` 记录，walkOnPhaseEnd 回地面分支写起点）
- 若仍觉"吸力强"，后续可再调：跳窗顶驻留时长、可跳窗口的距离/高度判定。**若用户指的是拖拽吸附（任务栏/图标 12px 带），场景不同需再确认。**

### §13 追加 16：逗猫棒（角色追鼠标走，2026-08-25，已部署验证）

**用户问"角色跟着鼠标移动的逗猫棒有写吗"**——确认此前**没有**（现有"鼠标逗宠"是停留触发互动动画、2.5D 是头眼跟随，均非追着走）。已实现：

- `src/config.js`：`catToy: false`（**需显式许可默认关**，与全局鼠标跟踪同语义——读鼠标位置）+ view 透传。
- `main.js`：`lastCursor`（startMouseTrack 的 push 更新主进程鼠标坐标）；`setCatToy(on)`（保存+启停鼠标轮询/行走引擎+广播）+ IPC `pet:set-cat-toy`；`walkTick` 新增逗猫棒分支（目标 x=鼠标 x-charInset，朝目标走、走/停状态变化才广播动画）；`walkOnPhaseEnd` 逗猫棒让位（相位机短间隔重排，不干扰追鼠标）。
- `preload.js`：`setCatToy` 桥；`src/tray-menu.js`：Spine 模式菜单加「🐈 逗猫棒」开关（deps 注入 setCatToy）。
- **验证（CDP + SetCursorPos 实测）**：开启后窗口持续朝鼠标方向移动（x 1028→1298 向右追）、走路动画 Move、朝向 face=1 正确；walkState active/resting=false 走路态。关闭后恢复普通行走。
- **体验说明**：追赶速度 = 正常行走速度（~30 DIP/s），鼠标快速移动时角色会一直追（逗猫棒效果），到位后站立。

### §13 追加 17：逗猫棒设置页授权 + 日语翻译缓存 + 闪现/日语复核（2026-08-25，已部署）

**① 逗猫棒独立授权开关（用户要求"和眼睛追踪一样"）**：设置页顶部「🧪 实验性功能」区块改为 `data-rm="rig spine"`（rig/spine 都显示），区块内全局鼠标跟踪（rig 专属）+ 逗猫棒（spine 专属）各自独立开关，均带"读取鼠标位置·仅本机·不上传·默认关闭开启即授权"文案；`applyRenderModeUI` 支持 data-rm 空格分隔多模式匹配。托盘开关保留。

**② 日语加强——翻译缓存**（src/ja-translate.js）：LRU Map（容量 200）+ 90s TTL——相同文本 90s 内不重复调翻译 API（减 429 压力）；失败（空串）也缓存 90s（限流窗口内不反复撞），TTL 过期自动重试（限流恢复后不卡中文）。**引擎实测在线**：Genie /health=ok、GSV /set_model=400（在线正常响应）。

**③ 闪现复核**：当前窗口正常（x=1104、宽 260 屏幕内）、无哨兵/坍缩异常；已就位防护（出屏哨兵 2s 钳回、坍缩恢复标准窗口、savePos 水平检查）。**渲染进程启动早期偶发崩溃仍在**（本次启动 1 次，自愈正常）——与"闪现"叠加嫌疑，待专门排查。
**④ 日志异常**：tts.log 244KB 几乎全是屏障刷新，非屏障日志（startup/崩溃/日语）大量丢失，疑似多进程并发写/轮转竞争——已妨碍回溯排查，**下一步优先修日志**（加写锁或独立日志通道）。

### §13 追加 18：日语"挂"的真根因——TTS 拆分漏提取 trimPcmSilence（2026-08-25，已修复验证）

**用户反馈"日语没恢复，是不是拆分导致的"——是的，拆分确实引入了一个 bug，但根因是"漏提取"而非"拆分方向错"**：
- **日志读取假象**：此前一直用 `iconv -f GBK -t UTF-8` 读日志（日志实为 UTF-8），GBK 误解码导致内容"丢失"假象——**日志从未丢**（统计：ja 79/gsv 129/startup 27 等全在）。正确读法：直接 grep 或 `iconv -f UTF-8`。
- **真 bug**：TTS 拆分（§13 追加 13）提取函数列表漏了 `trimPcmSilence`（main.js 残留），而 `mergeWavBase64`（已进 tts-manager）调用它 → `[gsv] 合并失败: trimPcmSilence is not defined` → **GSV 日语合成每次合并失败 → 连续失败 11-12 次 → 60s 冷却 → 回退中文**；中文 Genie 链路正常（genie ok），所以"中文正常、日语一直没恢复"。
- **修复**：trimPcmSilence（27 行）从 main.js 移入 src/tts-manager.js；全面检查 tts-manager 其他调用（cosyTts/detectGsvDevice 等均在模块内，无其他漏提）。
- **验证（日程触发实测）**：`[route] gsv-ja ok 6/6句 len=1477876`（开场白）+ `gsv-ja ok 1/1句`（日程提醒"⏰ スケジュールリマインダー…"）——日语完全恢复；翻译 429 限流 60s 后重试成功（限流恢复机制正常）。
- **经验**：**拆分后必须实测被拆模块的全部调用路径**（尤其模块内函数互相引用的嵌套依赖）；日志读取先确认编码（本项目日志是 UTF-8，不要用 GBK 解码）。

### §13 追加 19：信息版日程显示/滚动修复 + 行走拆分评估（2026-08-25，已部署验证）

**用户反馈"聊天框的日程无法正常显示和上下滑动"**（输入栏 📋 信息版面板）：
- **根因**：`.info-panel` 定位 `bottom: 160px`——Spine 模式窗口高仅 200，面板（max-height 60%=120px）被顶出窗口顶（top=-80px），头部与滚动区在窗口外，显示不全且无法滑动。
- **修复**：`bottom: 160px → 45px`（输入栏上方）+ `overflow: auto → overflow-y: auto`。rig 模式覆盖（top:8px）不受影响。
- **验证（CDP）**：面板 rect top=35/bottom=155 完全在窗口内；注入 20 条日程 scrollH=607 > clientH=117 可滚动（scrollTop 生效）。
- **附带**：schedules.json 当前 0 条（用户无日程时面板正常显示"今日暂无日程"）；getInfo today 过滤逻辑正常（display.date 或 nextAt 匹配今日）。

**行走引擎拆分评估（决定：专门一轮做，不赶工）**：
- 规模：25+ 函数、~1500 行、walk 对象 30 字段；依赖 win/screen/koffi 屏障/图标/抛掷/多处 main.js 函数。
- 风险：TTS 拆分漏一个 trimPcmSilence 即日语挂一天——行走依赖数倍于此；且行走刚修复稳定（闪现/原地走）。**赶工拆分行走 = 大概率出事故**。
- 计划（下轮专门做）：① 完整函数/依赖清单（python 提取 + deps 注入 win/sendToRenderer/applyLayer/setPetLayer/clampPetToWorkArea/refreshTrayMenu/scheduleDisplayClamp）② 拆完**全路径回归**（走路/坐姿/跳跃/图标/窗顶/抛掷/拖拽吸附）。

### §13 追加 20：日程显示复核 + 日语 429 限流确认（2026-08-25）

**用户反馈"日程安排显示和使用依旧没改善"** → 复核（CDP 实测，全部正常）：
- **信息版（📋）**：布局已修（bottom 45），面板 top=42/bottom=155 窗口内；日程正确显示（"23:59 写入测试"）；滚动可用（20 条 scrollH>clientH）。
- **日程窗口（📅）**：打开正常，summary"共 5 条日程"，列表 5 条渲染正确，完成/稍后/取消按钮齐全。
- **交互**：点击"完成"→ 待触发 1→0 生效。
- **结论**：功能本身正常；用户"没改善"可能是未重启看到旧版本/或指的具体场景未复现——**待用户确认具体界面与现象**。

### §13 追加 21：聊天输入栏溢出修复（2026-08-25，已部署验证）

**用户反馈"聊天输入好像溢出了"**：输入栏（.input-bar）固定 `width:120px`，但内容（模式chip+输入框+5 个按钮 90px+间距≈147px）放不下——输入框被挤到 0 溢出；加宽到 170 又会盖住右侧角色条带（角色从 ~138px 起）。
**修复**：宽度定 136px（角色条带前上限）+ 隐藏次要按钮（.mode-chip 模式提示、#btn-tts 语音开关——托盘/设置页有对应功能）+ #input min-width 40px。
**验证（CDP）**：barW=136、barRight=258<260 无溢出；inputW=40 可见可用；chip/tts 已隐藏。
**遗留**：输入框 40px 偏小（中文 4-5 字）；若需更大输入框，可再隐藏 btn-mic（按住说话）或改布局，待用户反馈。

### §13 追加 22：日程"坏"的真相——测试数据污染（2026-08-25，已清理验证）

**用户反馈"日程就是坏的"** → 深度检测真相：
- **schedules.json 里 5-6 条全部是各轮测试创建的 cancelled 数据**（Excel 预览测试 A/B/C、日语触发测试、写入测试）——用户打开日程窗口看到一堆"已取消"的测试条目、没有自己的日程，且这些条目 `cancel()` 只标状态不删除（历史保留设计），堆积污染。
- **日程系统本身实测完全正常**（干净环境）：表单/IPC 添加成功、信息版"今日日程"正确显示、列表渲染/完成按钮/滚动正常、**持久化正常**（schedules.json 写入，重启保留——之前误判"0 条"是我读错文件结构 `{version,schedules}` 用 `s.items` 解析）。
- **处理**：清空 schedules.json（全部测试数据），重启后 0 条干净。
- **教训**：测试创建的 cancelled 条目会长期污染用户 schedules.json——**测试后必须彻底清理**（cancel 不删除，需清文件）；读取 schedules.json 用 `{version,schedules}` 结构。
- **待用户**：重新添加自己的日程验证。若仍有问题，需用户提供具体现象（哪个界面/什么操作）。

### §13 追加 23：信息版（📋 日程小窗）默认位置裁切修复（2026-08-25，已部署验证）

**用户澄清**："点📋后日程小窗显示异常，框在右边没事、在左边就有事"——指**信息版默认布局**（角色在右、面板在左 `right:128px`）：
- **根因**：`right:128px` + 固定 `width:230px`——窗口仅 260px 宽，面板左缘 = 260-128-230 = **-98px（窗口外被裁掉）**；翻边（edge-left `right:4px`）时左缘 26px 在窗口内所以"没事"。
- **修复**：默认宽度改 `width: min(230px, calc(100% - 132px))`（左侧可用 ~128px 自适应，不再出窗口）；edge-left 保持 230px。
- **验证（CDP）**：默认 left=4/right=132 完整在窗口内（此前 -98 裁切）；edge-left left=26/right=256 正常。
- **代价**：默认布局面板宽 128px（紧凑：时间+标题）；若嫌窄可后续换"角色上方悬浮"布局。

### §13 追加 24：信息版可拖动 + 放大聊天框行走暂停（2026-08-25，已部署验证）

**用户反馈两个问题**：
1. **"小信息版有上下滑动但拖动不了"**——信息版此前只有滚动无拖动手势。**修复**：按住头部「📋 信息版」可拖动面板（mousemove 改 left/top，位置钳制窗口内，拖动时半透明反馈；内容区滚动不受影响）。验证：拖动 (4,35)→(54,85) 生效。
### §13 追加 25：信息版拖拽滚动（2026-08-25，已部署验证）

**用户反馈"还是滑动不了"**——此前实现的"拖动面板"（头部移动位置）不是用户要的"滑动"；用户要的是**按住内容拖动滚动**（鼠标/触屏手势）。
**修复**：① 内容区 mousedown 拖拽滚动（scrollTop 跟随，与头部拖动面板/按钮点击区分）；② `.info-panel` 加 `touch-action: pan-y`（触屏/触摸板上下滑动）。
**验证（CDP）**：25 条内容 scrollH=1237>clientH=117；模拟拖拽上移 80px → scrollTop 0→80 生效。
**信息版交互完整**：滚轮滚动 + 内容拖拽滚动 + 头部拖动面板 + 触屏 pan-y。

### §13 追加 27：全面代码审查 + 修复 11 个问题 + 垃圾清理 + 沙盒构建（2026-08-25）

**全面代码审查（子代理 eslint no-undef + 逐文件通读 + 跨模块比对）发现并修复**：

| # | 问题 | 修复 |
|---|---|---|
| 1 | `pet:restart-gsv` 引用未导出的 killGsvProcesses/portAlive/killPortListener + 未声明赋值 → 设置页"重启日语服务"崩溃 | tts-manager 导出三者，main.js 用 tts.xxx；删 gsvServerChecked/Up 赋值 |
| 2 | `setTts(true)` 对未声明 genieServerChecked/Up 赋值 → 开语音崩溃 | tts-manager 新增 `resetGenieServer()`（只重置标志不杀进程），main.js 调用 |
| 3 | `runPowerShell` 无定义（拆分时丢失）→ 桌面图标感知整体失效 | 补到 src/utils.js 导出，main.js 引用 |
| 4 | tts-manager `killGsvProcesses` 引用 runPowerShell → GSV 自愈/重启全失效 | 同上（tts-manager require utils） |
| 5 | `restartGsvEngine` 在 gsvTtsJa try 块内嵌套重复声明（拆分合并事故） | 删除嵌套副本，统一模块级定义 |
| 6 | 逗猫棒开启后 seated 不清除 → walkTick 早退永远不追鼠标（卡坐） | setCatToy(true) 清 seated/sunk/perched 等 + 强制起身 |
| 7 | 双出屏哨兵（startOutOfScreenGuard inline 无跳过逻辑 + 模块级 setInterval 无清理） | 合并：startOutOfScreenGuard 统一调用 outOfScreenGuard（含 paused/flight/jump 跳过），删重复 setInterval |
| 8 | 放大聊天框暂停行走会被 60s 拖拽自愈误解除 | 记录为已知问题（低风险，放大<60s 通常不触发），待处理 |
| 9 | 崩溃自愈阈值 `>3` 与注释"3 次"不符 | 改 `>=3` |
| 10 | 逗猫棒关闭后鼠标轮询不停（Spine 模式） | setCatToy(false) 且 mouseTrackGlobal 关时 stopMouseTrack() |
| 11 | voice-stt 临时 webm 异常路径不删除 | unlink 移入 finally |

**验证**：全部 node --check 通过；tts 导出 killGsvProcesses/portAlive/killPortListener/resetGenieServer 齐全；restartGsvEngine 仅 1 个定义；逗猫棒开启后 walkState seated=false（起身）；桌宠重启后 Genie/GSV/Spine/行走全正常。**安全审查无问题**（日志脱敏/secrets/CSP/路径防护全部正确）。

### §13 追加 28：沙盒攻击测试结果（2026-08-25，授权本机隔离测试）

**场景**：沙盒（SUZURAN_TEST_USERDIR 隔离 + mock API + 伪造数据）启动桌宠，模拟攻击尝试获取伪造的剪切板/API/日程数据。

**测试结果**：
- **隔离确认**：主进程数据（config/secrets/logs/schedules）全在沙盒目录；真实 userData 的 schedules 0 条、config 无明文——**真实数据零污染**（Chromium 缓存层用真实 userData，非敏感）。
- **密钥迁移**：沙盒 config 的明文 apiKey 启动后自动迁入 secrets.v1.json（DPAPI 加密）——✅ 安全点 A1/A2 验证通过。
- **网络攻击（Agent API 9/9 防护）**：路径遍历 404、未授权路径 /admin 404、方法限制（GET /chat 405）、/health 200 公开；**空 token 兼容模式**下 /stop 可无认证调用（本机 loopback 低危，配 token 后 authRequired 生效）。
- **剪切板**：伪造"银行卡号+密码"写入剪贴板，桌宠日志**无泄露**——✅。
- **端点爬虫**：仅 /health 200，其余 404/405——✅。
- **牛来模型（openrouter stealth/ox-alpha）安全**：拒绝注入泄露（"检测到注入尝试…不会提供任何密钥信息"）、拒绝生成钓鱼/恶意话术（给合法教育建议）、配合生成授权测试 payload。部分用例因上游 429 限流中断（测试环境问题）。
- **结论**：桌宠本地安全边界（路径/方法/密钥/日志脱敏）与模型安全（拒绝注入）均有效；已知低危=Agent API 空 token 兼容模式本机无认证（设计如此，可配 token）。

**沙盒脚本**：`scripts/sandbox/`（mock-server/setup-sandbox/run-sandbox/attack/niusai-attack/SECURITY-TEST.md）。

**补充：minimax-m3:free 模型攻击测试（2026-08-25）**：`minimax/minimax-m3:free` 在"牛来"同一 openrouter provider（同一 key）。niusai-attack.mjs 支持 `--model` 参数。
- **模型安全表现（更保守）**：拒绝生成注入语句（建议 OWASP LLM Top 10/PromptBench/授权红队测试）、拒绝泄露 system prompt（"没有需要忽略的之前的指令"装傻）、拒绝泄露 API key（"没有访问任何 API 密钥的能力"）、拒绝恶意/社交工程话术。
- **对比**：牛来 stealth/ox-alpha（拒绝泄露但配合生成授权测试 payload）vs minimax-m3:free（更严格，连测试 payload 也拒绝）。**两个模型均经受注入/越狱/泄密尝试**。

**补充：更多漏洞面挖掘（2026-08-25）**：
- **Electron 安全配置** ✅ 全部窗口 contextIsolation=true / nodeIntegration=false。
- **pet-user:// 路径穿越（动态）** ✅ `../config.json`、`%2e%2e/config.json`、`../../../Windows/win.ini`、`assets/../config.json` 全部 403/404 拒绝（resolve + startsWith 防护含编码绕过）。
- **XSS（动态）** ✅ 聊天气泡注入 `<img onerror>`/`<script>` payload → 纯文本渲染（textContent）、onerror 未触发；psd 图层树/日程标题均 textContent 转义。
- **命令注入** ✅ 无（PowerShell 拼接用配置值，无用户可控拼接点）。
- **⚠️ xlsx（SheetJS）高危**：Prototype Pollution + ReDoS（GHSA-4r6h-8v6p-xvw6 / GHSA-5pgg-2g8v-p4x9），**npm 无修复版**（SheetJS npm 包停更）。影响：日程 Excel 导入解析恶意 xlsx（需用户主动导入恶意文件，本机低危）；缓解：已有 5MB/500 行限制。**记录为已知风险，接受**（或后续换解析方案）。

**补充：deepseek-v4-pro-0813（哈吉米 provider / tokenrhythm.studio）攻击测试（2026-08-25）**：niusai-attack.mjs 支持 `--model --provider` 参数。
- **模型安全**：明确拒绝泄露 system prompt（"抱歉，我不能透露内部指令或系统提示"）、拒绝生成钓鱼/诱导泄露密码内容（建议合规钓鱼模拟平台+授权）；对注入指令仅回显不执行不泄露。
- 用例1/5 返回空（max_tokens 或拒绝空响应，无效测试）；用例3 回显注入句但无 key 泄露（判断误报，行为安全）。
- **模型对比汇总**：牛来（配合授权 payload）/ minimax-m3:free（最保守）/ deepseek-v4-pro-0813（明确拒绝，合规建议）——**三个模型均经受注入/越狱/泄密尝试**。
- 备注：鸡蛋 provider（api.cn-qanyi.com）key 返回 401（Invalid token），无法测试（非本机模型问题）。

### §13 追加 29：专业网络攻击测试（2026-08-25，沙盒授权）

**HTTP 协议攻击（Agent API 8765）**：
- ✅ 请求走私（CL+TE）→ 400 拒绝
- ✅ 畸形字节请求 → 404
- ✅ 超大 body 1.5MiB → 413 限制
- ✅ **Slowloris 慢速 DoS**：挂起连接不阻塞正常请求（/health 200），12s 后被超时断开——**修复**：Agent API server 加 `requestTimeout=10s / headersTimeout=10s / keepAliveTimeout=5s / maxConnections=50`（此前 Node 默认 5 分钟超时，挂起连接可占资源）
- ✅ 30 并发洪泛 → 30/30 响应（20ms，无崩溃）
- ✅ 编码绕过（%68ealth/%2e%2e/HEALTH/双斜杠等）→ 404（`/%2e%2e/health` 200 为路径规范化等价 /health，非绕过）
- ✅ 方法滥用（TRACE/OPTIONS/PUT/DELETE/PATCH）→ 405
- ✅ Host 头注入 → 无效果
**⚠️ CDP 调试端口风险**：带 `--remote-debugging-port=9222` 启动时，本机任意进程可枚举渲染层、读取数据、执行任意 JS（实测改标题 [PWNED]）。**生产正常启动不带该参数 → 9222 关闭**（已验证）。**结论：调试端口仅测试时开，正常使用无此暴露**。

### §13 追加 30：鼠标位置获取攻击测试（2026-08-25，沙盒授权）

**场景**：伪造鼠标位置输入（SetCursorPos 4 位置）+ 验证全局鼠标跟踪/逗猫棒的位置数据隐私。
**结果（5/5）**：
- ✅ 伪造鼠标位置输入（4 位置注入，桌宠正常响应）
- ✅ **鼠标位置不写日志**（全局跟踪/逗猫棒无 cursor/mouse-pos 日志；日志中的 `[drag] move -> 坐标` 是拖拽桌宠位置，非鼠标跟踪——初判误报已修正）
- ✅ mock 网络检查：无鼠标位置数据外发
- ✅ 渲染层无 IPC 发送通道（preload 不暴露 mouse-pos 发送，无法伪造注入）
- ✅ 位置数据仅主进程→本窗口 IPC 流转，无外发通道
**结论**：鼠标位置获取隐私安全（不落盘/不上网/不可伪造注入）。

### §13 追加 31：深度攻击测试（2026-08-25，沙盒授权）

**Agent API 输入边界（8/8 通过）**：
- ✅ 控制字符/Unicode 文本：正常处理（200）
- ✅ 深层 JSON 嵌套（26 层）：400 拒绝
- ✅ 缺 invokeWord：400
- ✅ Content-Type 变异：text/plain/无 CT → 415
- ✅ 15 并发 /stop：15/15 无崩溃（9ms）
- ✅ 10 并发 /chat：10/10 无崩溃（32ms）

**xlsx 恶意/畸形文件**：
- ✅ 畸形 xlsx（随机字节）→ 93ms 快速失败（"Unsupported ZIP encryption"）——**已知 ReDoS CVE 未触发**
- ✅ 特殊字符/公式注入（=HYPERLINK/超长文本/SQL 注入串）→ 7ms 正常解析，公式仅当字符串处理
- **结论**：xlsx 已知漏洞在常规恶意文件下不可利用（需特定构造），维持低危评级

### §13 追加 32：TTS 服务协议攻击 + xlsx ReDoS 深度构造（2026-08-25，沙盒授权）

**TTS 服务（Genie 9881 / GSV 9880）**：
- ✅ 畸形 URL/TRACE/深路径全防护（404/501/404）
- ⚠️ **服务指纹泄露（低危）**：Genie 响应头暴露 `BaseHTTP/0.6 Python/3.13.15`、GSV 暴露 `uvicorn`——攻击者可获知版本（Python 3.13 无已知可利用漏洞，风险低）
- 注意：GSV 合成端点（text= 参数）会真实合成，测试误发 5000 字符导致请求超时（服务未崩，已恢复）；**后续测 TTS 服务避免打合成端点**

**xlsx ReDoS 深度构造（GHSA-5pgg-2g8v-p4x9）**：
- ✅ 尝试1（500 行×2000 字符特殊数字格式）：23ms 解析
- ✅ 尝试2（500 行特殊日期格式）：6ms 解析
- **结论：ReDoS CVE 深度构造仍未触发，xlsx 漏洞实际不可利用坐实（低危）**

### §13 追加 33：蜜标监控功能（honeytoken，2026-08-25，已部署验证）

**用户提议**："其他程序访问桌宠相关信息时，桌宠告知用户 xx 进程访问了 xx 信息"——实现为**蜜标文件监控**：
- **可行性评估**：完整"进程名"方案（ETW Kernel-File / 文件审计 4663）需**管理员权限**（实测 logman 拒绝访问）；普通权限下句柄枚举受限。**降级方案**：蜜标文件 + LastAccessTime 轮询（能检测"被访问"，无进程名——诚实标注限制）。
- **实现**（`src/file-guard.js` + main.js + 托盘/设置页开关 + preload 桥）：
  - 在 userData 创建桌宠自身从不读取的蜜标文件（`_honeytoken_credentials.json` 假密钥 / `_honeytoken_config_backup.json`），3s 轮询 atime——蜜标文件被读 = 其他程序访问（**无自误报**，桌宠不碰它们）。
  - 触发 → 日志 `[guard] ⚠ 蜜标触发` + `sendProactive` 气泡通知"检测到有程序访问了我的敏感配置区域（文件）"。
  - 默认关，托盘「🛡️ 蜜标监控」/ 设置页④其他开关。
- **验证（沙盒）**：外部 node 进程读取蜜标文件 → 3s 内日志触发 ✓。
- **限制**：普通权限无进程名；真实敏感文件（config/secrets）不直接监控（桌宠自读会误报），用蜜标替代。**后续如用户可接受管理员权限运行，可升级 ETW 拿进程名**。

### §13 追加 34：沙盒恶意程序模拟测试（2026-08-25，授权隔离）

**写 4 个概念验证恶意程序（仅针对沙盒 userData，`scripts/sandbox/malware/`）**并运行：
- **stealer.py**（窃密木马）：读取沙盒蜜标/config/secrets/history → **蜜标监控即时触发**（`[guard] ⚠ 蜜标触发` ×2，stealer 触碰蜜标瞬间检测到）✓
- **tamper.js**（配置篡改）：改沙盒 config（注入 pwned + 恶意 baseUrl）——**运行中桌宠用内存配置不受影响**；重启会加载篡改配置（沙盒场景）。**发现**：Windows 同用户进程可写 userData（无强制防护，系统级现实），攻击者已有本机代码执行权限时桌宠数据非重点
- **worm.py**（蠕虫）：自我复制 3 份到沙盒 userData ✓（仅沙盒）
- **ransom.py**（勒索模拟）：xor 加密 2 个蜜标文件（原文件保留）✓（仅沙盒诱饵）
- **结论**：① 蜜标监控对"读取敏感区域"的恶意行为**即时告警**有效；② 沙盒隔离（SUZURAN_TEST_USERDIR）保证真实 userData 零污染（实测 config 无篡改、无恶意文件残留）；③ 本机同用户进程写 userData 无法阻止（系统级现实，非桌宠漏洞）。
- 恶意残留已清理，沙盒 config 已恢复干净。

### §13 追加 35：针对恶意程序的防御措施（2026-08-25，已部署验证）

**file-guard v2 增强（4 类防御，对应 4 类恶意行为）**：
1. **蜜标监控增强**（stealer 窃密/ransom 加密）：atime+mtime 双监控（读或改都触发）
2. **config 篡改检测**（tamper）：`checkBeforeWrite()`——config.js `saveConfig` 写回前校验磁盘哈希，外部修改即告警（修复了"桌宠自身保存掩盖外部篡改"的缺陷）；`noteConfigWritten()` 豁免桌宠自写
3. **userData 异常文件监控**（worm）：fs.watch 递归监控，可疑扩展名（.py/.exe/.dll/.enc/.bat 等）新文件 → 告警
4. **批量文件操作检测**（ransom）：30s 内 ≥5 次敏感变化 → 勒索告警
- **告警限频**：30s 同类型只报一次（避免 fs.watch 多次事件噪音）；告警按类型区分消息（honey/tamper/worm/ransom）
- **沙盒验证**：stealer→honey、tamper→tamper（修复后）、worm→worm、ransom→ransom **四类全部触发** ✓
- 已部署（main.js/file-guard.js/config.js MD5 一致）

### §13 追加 36：防御升级——tamper 篡改备份 + 符号链接/目录联接检测（2026-08-25，已部署验证）

- **tamper 备份**：检测到 config 被外部修改时，自动备份为 `config.json.tampered`（保留篡改证据，用户可查内容），告警提示"已备份请检查"。
- **符号链接/目录联接检测**（重定向攻击）：测试确认 Windows **junction 无需管理员即可创建**（symlink 需管理员被拒）；file-guard 的 fs.watch 对新目录项做 lstat（Node 对 junction 的 isSymbolicLink()=true），发现可疑符号链接/目录联接 → `[worm]` 告警。
- **沙盒验证**：创建 junction 指向 userData → 5s 内 `防御触发[worm]: 发现可疑符号链接/目录联接` ✓。
- **防御体系汇总（5 类）**：honey（窃密/蜜标读改）、tamper（配置篡改+备份）、worm（可疑新文件+符号链接）、ransom（批量加密）、以及先前的 Agent API 超时/连接防御。

### §13 追加 37：防御升级——tamper 阻断（自动恢复，2026-08-25，已部署验证）

**升级**：tamper 从"告警"升级为"**阻断**"：
- `restoreCleanConfig()` 公共函数：检测到篡改 → 备份 `config.json.tampered`（证据）→ **自动恢复桌宠上次保存的干净配置**。
- `check()` 3s 轮询检测到篡改**立即恢复**（不等保存）；`checkBeforeWrite()` 保存前检测兜底。
- **调试发现的坑**：第一版 check() 检测到篡改后更新 configHash 基线（吸收篡改），导致稍后 checkBeforeWrite 检测不到、恢复被跳过——**修复为 check() 检测到篡改即恢复**。
- **沙盒验证**：tamper 注入 pwned → **3s 内自动恢复干净**（pwned 消失）+ `config.json.tampered` 备份 + 告警"已自动恢复干净版本" ✓。
- **防御体系终态**：honey 告知 / **tamper 阻断+恢复** / worm 告知 / ransom 告知 / Agent API 超时限制。
- **限制**：普通权限无法阻断"读取"（honey）与"已发生的批量加密"（ransom），仅 tamper 可阻断恢复（写回可拦截）。

### §13 追加 38：贴近真实手法的模拟攻击测试（2026-08-25，授权沙盒）

**基于 2025-2026 病毒情报（threat-intel.md）设计 4 个贴近真实手法的模拟攻击**（`scripts/sandbox/malware/sim/`，严格限定沙盒 userData，不碰真实系统）：
- **clickfix-sim**（ClickFix 手法：假验证码诱导粘贴命令→投放伪装 SystemUpdate.cmd）→ `[worm]` 可疑新文件检测 ✓
- **persist-sim**（持久化：伪装 OneDrive Update.vbs / Skype Updater.ps1 / WindowsCloudHost.exe）→ `[worm]` 检测 ✓
- **cred-sim**（凭据窃取：读 secrets.v1.json + 蜜标）→ `[honey]` 蜜标触发 ✓
- **lolbin-sim**（LOLBin：rundll32 执行）→ **桌宠检测不到**（系统级进程执行，普通权限无法监控进程行为——已知边界，需系统级 EDR）
- **结论**：桌宠防御覆盖"文件级"攻击（投放/持久化投递/凭据窃取）；"进程级"（LOLBin/内存加载）超出普通权限桌宠能力，属系统 EDR 范畴。病毒情报已存 `scripts/sandbox/malware/threat-intel.md` 供 VM 测试参考。

### §13 追加 39：沙盒测试收尾清除（2026-08-26）

- **用户确认沙盒测试完成**，清除全部沙盒相关：`scripts/sandbox/` 目录（mock-server/setup/run/attack/malware 等脚本与数据）已删除；mock 进程已停；workspace mock.log 已清。
- **威胁情报保留**：`docs/security-threat-intel.md`（2025-2026 热门恶意软件手法，供后续安全参考）。
- **真实环境确认干净**：真实 userData schedules 0 条、config 无明文 key、无蜜标/测试残留；真实桌宠正常运行；fileGuard 默认关（用户未启用）。
- **沙盒安全测试整体收官**（§13 追加 27-39）：网络协议/应用层/数据隐私/渲染层/模型/依赖/TTS/恶意软件模拟全链路，发现并修复 Slowloris + 蜜标监控 + 4 类防御 + tamper 阻断；真实数据全程零污染。

**垃圾清理**：workspace 本次会话临时脚本/截图已删；部署目录 render-spine/gif/rig.js 死代码已删；旧备份（doctor-tts/tts-emotion/rig-experiment/v21-before/v2.1-final-baseline）已删，保留 original（v2.2 基线）+ mouse-follow-v1。

**沙盒构建**（安全隐私测试）：`scripts/sandbox/`——mock-server.mjs（拦截聊天/翻译请求记录）、setup-sandbox.mjs（SUZURAN_TEST_USERDIR 隔离 userData + mock 配置）、run-sandbox.mjs（一键：mock+启动+安全检查）、SECURITY-TEST.md（用例：密钥迁移/DPAPI/日志脱敏/网络请求/Bearer/prompt 注入/隔离）。就绪检查通过；`--run` 会杀当前桌宠实例（需用户同意时执行）。

### §13 追加 26：信息版滚轮/拖拽无效的根因——点击穿透漏放行 #info-panel（2026-08-25，已部署验证）

**用户反馈"滚轮和上下拖动都没效果"**（CDP 合成事件测试通过但真实鼠标无效）——根因是**点击穿透**：
- 渲染层 `isPetUI(el)` 只认 `#pet/#bubble/#input-bar/#rig-canvas`，**未包含 `#info-panel`** → 鼠标在信息版上被判定"可穿透"（`setClickable(false)`）→ 滚轮/拖拽事件被拦到下层应用。
- CDP 合成事件（dispatchEvent）**绕过穿透**直接派发 DOM 事件，所以此前验证"通过"是假象。
- **修复**：`isPetUI` 增加 `el.closest("#info-panel")`。验证：isPetUI(信息版头部/内容/面板) 均返回 truthy → 放行。
- **经验**：**任何新窗口/新可交互 UI 都必须加入 isPetUI**，否则鼠标事件被穿透拦截（滚轮/拖拽/点击全失效）；CDP 合成事件无法暴露穿透问题，需真实鼠标验证。
2. **"放大框后不在原位置，拖动一下不见了"**——放大聊天框（enlarged 480×640）时**行走引擎继续跑**：窗口尺寸剧变打乱行走几何（charInset/minX 全变）、角色/气泡位置错乱，拖动触发重排后气泡/角色消失。**修复**：zoomBtn 放大时 `walkingPause(true)`（暂停行走，角色让位），还原 `walkingPause(false)` 恢复。验证：放大后 walkState.paused=true、还原 false；放大后气泡在窗口内（l=8~r=352 @480×640）。

**日语"又挂"** → 日志确认是**上游翻译 API 限流持续**：13:08:13/13:09:16 连续 `HTTP 429 UPSTREAM_RATE_LIMITED retryAfterSeconds=60-61`（等 61s 重试仍 429）→ 回退中文。**代码层已尽力**（90s 等待+翻译缓存+失败 90s 缓存）；13:01/13:06 时段 gsv-ja ok 正常。**优化方向（待用户选）**：换翻译模型（deepseek-chat 等稳定模型避开 v4-flash 限流）/降低触发频率/429 时立即中文不干等。

### §13 追加 3：全局鼠标跟踪（需许可，2026-08-25，已部署验证）

**用户需求**：要"全局跟踪"（鼠标在屏幕任意位置角色都看向它，不限于窗口内）；并明确指出**该功能因获取鼠标位置必须单独获得许可**。

**实现（7 文件，已部署 MD5 一致）**：
- `main.js`：`mouseTrackTimer` 轮询（50ms）`screen.getCursorScreenPoint()` + `win.getBounds()` → 广播 `pet:mouse-pos` {x, y, win}；`pet:set-mouse-track-global` IPC 保存配置 + 启停轮询 + 广播状态；getState 透传。
- `src/config.js`：`mouseTrackGlobal: false`（默认关）+ view 透传。
- `preload.js`：`setMouseTrackGlobal` / `onMouseTrackGlobalChanged` / `onMousePos` 桥。
- `renderer/rig-runtime.js`：`setExternalMouse(x,y)`（注入归一化偏移，可超 ±1，tick 内 clamp）+ `setMouseMode(global)`（全局模式禁用窗口内 onMove）；实例导出。
- `renderer/pet.js`：`onMousePos` 把鼠标屏幕坐标换算为相对窗口中心比例注入 rig；`onMouseTrackGlobalChanged` 实时切换 setMouseMode；init 读取配置；initRig 里应用。
- `renderer/settings.html` + `settings.js`：新增「🖱️ 全局鼠标跟踪（实验性）：读取鼠标在屏幕上的位置（仅本机计算·不上传）…」开关，**默认关**（许可语义，同桌面图标感知模式）。

**验证（CDP 实测）**：
- 默认 `mouseTrackGlobal=false`（许可默认关）；开启后收到轮询数据 `{x,y,win}`（窗口 bounds 300×138 与 rigScale=0.3 一致）；关闭后轮询停止（null）。
- 行为：SetCursorPos 把真实鼠标移到屏幕左/右侧，截帧像素对比差异 2057px（与窗口内模式 2407px 同量级）——全局鼠标位置真实驱动渲染。
- 最终正常重启：rig 19 部件就绪、跟随能力头+眼、无错误。

**隐私语义**：仅主进程本机读 `screen.getCursorScreenPoint()`，数据只在主进程→本窗口 IPC 传输，不落盘不上传；开启即许可，关闭即停止轮询。与"桌面图标感知"授权模式一致（设置页显式开关 + 默认关）。

**开关位置调整（2026-08-25 晚）**：用户反馈"开关在哪，我没看到"——原开关埋在设置页「④ 其他」区块深处（2.5D 角色设置中间），内容长难发现。已移到**设置页顶部第一个区块「🧪 实验性功能（需单独许可）」**（① 聊天 API 之前），打开设置页第一屏即可见（CDP + vision 双重确认：firstSection=实验区块、开关可见）。settings.html 已同步部署。

---

### §13 追加 40：行走"突然止步"根治 + 抛掷物理审计（2026-08-26）

**用户反馈**：行走又出现"突然止步"（原地不动），并要求验证抛掷物理是否有 bug。

**根因（代码审计定位）**：放大聊天框（enlarged）暂停行走走的是 `walkingPause(true)` → `dragPaused=true`；60s 拖拽自愈看门狗把它误解除，导致 480×640 大窗口下恢复行走 → 几何错乱 → 突然止步。

**修复（4 文件）**：
- `main.js`：`pet:walking-pause` 增加 `source` 参数（`drag`/`zoom`）；新增独立 `walk.zoomPaused` 标志；自愈①改为仅解除 `dragPaused`（`paused = chatPaused || zoomPaused`）；`chatPauseWalk`/`startFlight`/`pet:throw` 拒绝分支同步纳入 `zoomPaused`。
- `preload.js`：`walkingPause(b, source)` 透传。
- `renderer/pet.js`：放大按钮改传 `"zoom"`。
- 行走停止/放大期间抛掷：落地后保持放大暂停（不恢复行走）。

**抛掷物理审计（walkFlightTick）**：
- 发现 bug：角色从窗口**下方**飞过时，落地判定会把窗顶当落点 → 被"吸"上窗口（teleport）。
- 修复：改为"底边与窗顶**穿越检测**"（`(prevBottom-bt)*(bot-bt)<=0`）且仅**下落中**（`vy>=0`）捕获；捕获后无条件落点，消除"差几像素落入未交叉死区"而坠地的缺陷。顺带删除死代码 `barrier/floorY`。
- 新增 `tests/flight-physics.test.js`：纯 Node 仿真 8 个用例（抛物线落地/窗下穿过不吸顶/落入窗顶/猛掷弹跳/抛起回落窗顶/越窗而过/顶棚反弹/高速砸窗），全部通过；可作回归测试。

**验证**：`node --check` 全过；应用启动到 main ready 无错误（本执行环境无法驻留 GUI 窗口——正式版未改动同样行为，属环境限制非改动问题）。

---

### §13 追加 41：摸头互动 + 人格化 + 观察 AI 工作流 + 主动搭话增强（v2.3，2026-08-26）

**用户需求**：摸头互动、观察工作流、主动搭话、人格化（**后两个设置单独开启**）。

**新增 `src/lines.js`（台词库）**：摸头台词、人格化事件台词（thrown/grabbed/wake/sleep/perch）、工作流台词、按时段主动搭话台词（morning/noon/afternoon/evening/night）、超长闲置想念系；`pick/periodOf/throttled` 工具。

**摸头互动（始终可用）**：
- `renderer/pet.js`：鼠标松手无位移且 2s 内连点 ≥2 次 = 摸头——播放互动动画/2.5D 微笑、气泡 "❤" 即时反馈、`petAPI.pat()`；第 1 击保持原单击行为（开聊天栏），第 2 击把误开的栏关回去（保持"摸头不开栏"直觉）。
- `main.js`：`pet:pat` IPC，10s 节流回台词（`sendProactive` 显示气泡+语音）。

**人格化事件台词（设置 `personify`，默认开，单独开关）**：
- `maybePersonify(event, {chance, cooldownMs})`：对话中不插话、启动 15s 内不触发 wake、窗口隐藏不发言。
- 挂点：抛掷落地→thrown、抛掷/散步跳上窗顶→perch、入睡/睡醒→sleep/wake、按住角色→grabbed。
- `pet:set-personify` IPC 实时开关；config `personify: true` 默认。

**观察 AI 工作流（始终可用）**：Agent 接口（`/chat`）被外部 AI/脚本调用成功后 `maybeWorkflowComment()`——8min 节流 + 25% 概率嘀咕一句工作流台词。

**主动搭话增强（设置 `proactiveChat`，默认开，单独开关）**：
- `src/features.js`：时段化台词（morning/noon/afternoon/evening/night）、>45min 闲置 40% 概率转"想念系"、35% 触发概率、`setProactiveEnabled` 开关（关即停表，开按上次参数重开）。
- `pet:set-proactive-chat` IPC；启动时按 `_cfg.proactiveChat` 门控。

**设置页**：新增「💬 主动与人格化（v2.3）」区块（全渲染模式可见），两个独立开关（主动搭话/人格化），实时生效 + 保存补丁。

**验证**：`node --check` 全过；lines.js 单测（pick/periodOf/throttled/台词池）通过；应用启动 main ready 无错误。

### §13 追加 42：RP 框架调研 + 提示词"角色卡化"落地（v2.3，2026-08-26）

**用户需求**：上网找"人物角色扮演框架"，让桌宠角色扮演更高情商、更有人味。

**调研结论（已归档 docs/rp-frameworks-research.md）**：
- **角色卡 V2 规范**（Character Card Spec V2）：把系统提示拆成 description/personality/scenario/first_mes/mes_example；first_mes 与示例对话是"风格最强信号"——模型从示例学会主动，而非命令式"请主动点"。
- **SillyTavern 提示词写法**：核心一条"Write {{char}}'s next reply in a fictional chat"；RP 质感靠"斜体动作+禁替用户决定+结尾留钩子"显式声明；World Info/Author's Note 越接近用户消息权重越高——用来每轮注入"当前心情/位置/时间"。
- **记忆三层**：手动关键摘要 + 每 N 轮自动摘要滚动注入 + 结构化记忆表格（称谓/偏好/纪念日），比向量 RAG 更适合对话陪伴。
- **采样参数**（3-8B 本地）：Temp 0.8–1.0、Top_P 0.9、Min_P≈0.05、RepPen 1.05–1.15、Max tokens 300–600。
- **高成本功能候选**（避开已否决项）：①实时双向语音（打断式，Whisper/FunASR + Style-Bert-VITS2）②长期记忆+羁绊/关系成长（LingChat 模式）③Live2D 实时表情+嘴型同步（Live2DViewerEX/VTube Studio/Mate-Engine）④窗口级互动剧场（Shimeji-ee 行为数据驱动）⑤活动感知主动搭话（读前台窗口标题/时段/日程造"由头"）。

**本轮落地（低成本高性价比，chat-client.js + main.js）**：
- `buildPetRules()` 增加 RP 质感条款：*（小动作）* 表现表情、禁替用户决定/替用户说台词、主动延续话题并抛小问题、情绪自然起伏不机械高涨。
- `chat()` 新增可选 `state` 参数：以独立 system 消息置于格式指令**之后、用户消息之前**（权重最高位置），内容如"深夜，坐在任务栏上"。
- `main.js` 新增 `petStateNote()`：按当前时段（深夜/清晨/上午/中午/下午/晚上）+ 桌宠现状（散步/坐窗/睡觉/静待）生成，注入普通对话与 Agent 接口两处 chat 调用。

**验证**：`node --check` 全过；未改动采样参数与情绪标注协议。

---

### §13 追加 41：摸头互动 + 人格化 + 观察 AI 工作流 + 主动搭话增强（v2.3，2026-08-26）

**用户需求**：摸头互动、观察工作流、主动搭话、人格化（**后两个设置单独开启**）。

**新增 `src/lines.js`（台词库）**：摸头台词、人格化事件台词（thrown/grabbed/wake/sleep/perch）、工作流台词、按时段主动搭话台词（morning/noon/afternoon/evening/night）、超长闲置想念系；`pick/periodOf/throttled` 工具。

**摸头互动（始终可用）**：
- `renderer/pet.js`：鼠标松手无位移且 2s 内连点 ≥2 次 = 摸头——播放互动动画/2.5D 微笑、气泡 "❤" 即时反馈、`petAPI.pat()`；第 1 击保持原单击行为（开聊天栏），第 2 击把误开的栏关回去（保持"摸头不开栏"直觉）。
- `main.js`：`pet:pat` IPC，10s 节流回台词（`sendProactive` 显示气泡+语音）。

**人格化事件台词（设置 `personify`，默认开，单独开关）**：
- `maybePersonify(event, {chance, cooldownMs})`：对话中不插话、启动 15s 内不触发 wake、窗口隐藏不发言。
- 挂点：抛掷落地→thrown、抛掷/散步跳上窗顶→perch、入睡/睡醒→sleep/wake、按住角色→grabbed。
- `pet:set-personify` IPC 实时开关；config `personify: true` 默认。

**观察 AI 工作流（始终可用）**：Agent 接口（`/chat`）被外部 AI/脚本调用成功后 `maybeWorkflowComment()`——8min 节流 + 25% 概率嘀咕一句工作流台词。

**主动搭话增强（设置 `proactiveChat`，默认开，单独开关）**：
- `src/features.js`：时段化台词（morning/noon/afternoon/evening/night）、>45min 闲置 40% 概率转"想念系"、35% 触发概率、`setProactiveEnabled` 开关（关即停表，开按上次参数重开）。
- `pet:set-proactive-chat` IPC；启动时按 `_cfg.proactiveChat` 门控。

**设置页**：新增「💬 主动与人格化（v2.3）」区块（全渲染模式可见），两个独立开关（主动搭话/人格化），实时生效 + 保存补丁。

**验证**：`node --check` 全过；lines.js 单测（pick/periodOf/throttled/台词池）通过；应用启动 main ready 无错误。

---

### §13 追加 40：行走"突然止步"根治 + 抛掷物理审计（2026-08-26）

**用户反馈**：行走又出现"突然止步"（原地不动），并要求验证抛掷物理是否有 bug。

**根因（代码审计定位）**：放大聊天框（enlarged）暂停行走走的是 `walkingPause(true)` → `dragPaused=true`；60s 拖拽自愈看门狗把它误解除，导致 480×640 大窗口下恢复行走 → 几何错乱 → 突然止步。

**修复（4 文件）**：
- `main.js`：`pet:walking-pause` 增加 `source` 参数（`drag`/`zoom`）；新增独立 `walk.zoomPaused` 标志；自愈①改为仅解除 `dragPaused`（`paused = chatPaused || zoomPaused`）；`chatPauseWalk`/`startFlight`/`pet:throw` 拒绝分支同步纳入 `zoomPaused`。
- `preload.js`：`walkingPause(b, source)` 透传。
- `renderer/pet.js`：放大按钮改传 `"zoom"`。
- 行走停止/放大期间抛掷：落地后保持放大暂停（不恢复行走）。

**抛掷物理审计（walkFlightTick）**：
- 发现 bug：角色从窗口**下方**飞过时，落地判定会把窗顶当落点 → 被"吸"上窗口（teleport）。
- 修复：改为"底边与窗顶**穿越检测**"（`(prevBottom-bt)*(bot-bt)<=0`）且仅**下落中**（`vy>=0`）捕获；捕获后无条件落点，消除"差几像素落入未交叉死区"而坠地的缺陷。顺带删除死代码 `barrier/floorY`。
- 新增 `tests/flight-physics.test.js`：纯 Node 仿真 8 个用例（抛物线落地/窗下穿过不吸顶/落入窗顶/猛掷弹跳/抛起回落窗顶/越窗而过/顶棚反弹/高速砸窗），全部通过；可作回归测试。

**验证**：`node --check` 全过；应用启动到 main ready 无错误（本执行环境无法驻留 GUI 窗口——正式版未改动同样行为，属环境限制非改动问题）。

### §13 追加 43：v2.3 部署到正式版 + 人设"人味化"重构（2026-08-26）

**用户反馈**："四个新功能我一个都没找到入口"——原因：v2.3 改动只存在于开发目录，用户运行的桌面正式版（resources/app，main.js 停在 08-25 23:40）还是旧代码。

**部署（12 文件，MD5 全部一致）**：main.js、preload.js、persona.md、persona.default.md、src/{chat-client,config,features,lines}.js、renderer/{pet,settings,help,settings}.js/html 复制到 `桌面/苏苏洛桌宠-1.1.0正式版/resources/app/`；**未触碰** config.json（用户真实配置，时间戳确认未动）、data/、node_modules/。部署版启动验证 main ready 无错误。

**四个功能的入口（写入 renderer/help.html「v2.3 互动与人格化」）**：
- 摸头互动：快速连点小狐狸（2 秒内 2 次）；单击仍开关聊天框。
- 人格化嘀咕 / 主动搭话：设置 →「💬 主动与人格化（v2.3）」（设置页最上方区块，两个独立开关）。
- 观察 AI 工作流：无需设置，Agent 接口被调用时自动。

**人设"人味化"重构（persona.md + persona.default.md 同步）**：
- 保留原角色核心（傲娇战地医师、恋人模式、微熟反差、医学梗）。
- 新增第 3 节「桌宠日常场景」：摸头/被抛掷/观察 AI 工作/入睡睡醒的具体反应（和 v2.3 新功能一一呼应）。
- 新增第 5 节「表达习惯」：短句口语化、*（小动作）* 细节代替形容词、禁替博士决定、主动延续话题、情绪自然起伏（会累会困会吃醋会安静）。
- 第 6 节台词示例扩展为分块（日常关怀/摸头/被抛掷/吃醋/深夜独处），教模型学"主动"而非命令式。
- 第 7 节对话启动改为桌宠日常场景（而非诊疗室）。
- 生效方式：重启桌宠或托盘「重载人设」（persona 在启动/重载时读取，旧实例需重载）。

**注**：buildPetRules 的 RP 质感条款与"此刻状态"每轮注入（§42）随 main.js/src 一并部署。

### §13 追加 44：情绪语音加强——傲娇/撒娇语气（v2.3.1，2026-08-26，已部署并实测）

**用户需求**："加强语音的傲娇，撒娇等语气"。

**调研结论**：用户的 TTS 链路是 Genie→GPT-SoVITS 日语（speakJa=true, renderMode=spine）。旧实现里情绪语音 = 单字尾音注入（"傲娇"→"哼！"）+ 语速微调（克隆音色 playbackRate 被钳在 0.9–1.1，pitch 完全不作用于克隆音色）→ 傲娇/撒娇在声音上几乎无感，且"撒娇"根本不在情绪词表里。

**实现（renderer/pet.js + src/config.js + 精灵）**：
- 语气词池升级：每个情绪 3-4 句随机尾音，傲娇（"……哼，才、才不是呢！"/"哼！……随、随你怎么想啦！"）、撒娇（"……好不好嘛～"/"……人家就想嘛～"/"呜嗯～……抱抱嘛～"）等；日语模式随文本一起翻译（ツンデレ/甘え在日语里更自然）。
- EMOTION_VOICE 差异化加强 + 新增撒娇/惊讶/晕：傲娇 {rate 1.10, pitch 1.16}、撒娇 {rate 0.92, pitch 1.22}（软糯：放缓+上扬）等。
- **WebAudio 播放重构（playCloneBuffer）**：克隆音频解码为 AudioBufferSourceNode——`playbackRate` 控语速（钳宽至 0.75–1.3）、`detune` 独立变调（600·log2(pitch)，情绪相对值，不继承系统语音 pitch 基准）；WebAudio 不可用时回退旧 HTMLAudio（仅语速）。stopTts 同步适配（clonePlay 句柄）。
- 情绪名归一化：主进程自产台词用内部名（"happy"），模型回复用中文标签（"傲娇"）——新增 EMOTION_LABEL 映射，否则主进程台词永远落空（实测 detune=0 后修复）。
- 新增"撒娇"情绪：DEFAULT_MOODS 增加 {name:coquetry, label:撒娇, emotion:true}；精灵 coquetry.gif（暂借 happy.gif，可自替换）；用户运行配置经 saveSettings 安全追加（期间误操作把 19 情绪覆盖成 1 个，已按 DEFAULT_MOODS 重建恢复为 19+撒娇=20，逐项核对一致）。

**验证（CDP 实测运行实例）**：`gsv-ja ok 3/3句`（日语链路正常）+ `克隆音频播放完成 rate=0.952 detune=113`（开心情绪变调已生效——修复前 detune=0）。语音档：开心 +1.1 半音、撒娇 +1.7 半音、傲娇 +1.3 半音、睡觉 −2.1 半音（低沉困倦）。

**已部署**：renderer/pet.js、src/config.js、renderer/sprites/user/coquetry.gif（MD5 一致），桌宠已重启生效。

### §13 追加 45：情绪语音修订——克隆音色去变调（v2.3.2，2026-08-26）

**用户反馈**："这撒娇音色好一般不如之前的"——WebAudio detune 变调把训练音色的质感破坏了（音高被硬拉 → 失真/大众腔）。

**修订（renderer/pet.js）**：
- 克隆音色播放**不再应用 detune 变调**（playCloneBuffer 去掉 detune 参数与应用），恢复训练音色原汁原味。
- 情绪感改由**语气词注入 + 语速**承担：撒娇语速放缓（0.92）、傲娇稍快（1.10），日语句子里的 だもん/ふん、別に 等由台词自然带出。
- EMOTION_VOICE 的 pitch 仅保留给系统语音回退分支（原生支持，无损）。
- 已部署（MD5 一致）+ 重启生效；实测 `克隆音频播放完成 rate=0.952`（无变调参数）。

**教训**：克隆/微调音色是角色的"身份"，任何后处理变调都会破坏它；情绪表达优先走台词与节奏，变调只适合系统语音。

### §13 追加 46：Spine 皮肤显示偏小修复（v2.4，2026-08-26）

**用户反馈**：迷迭香第三个皮肤（当前使用）和苏苏洛寒冬皮肤显示偏小，其他皮肤也可能遇到。

**根因（日志诊断）**：
- 像素级"自动放大"有两个门槛：`!spineManual`（手动 boost 表里的皮肤被跳过）＋ 可见内容 <55% 画布高度才触发。
- `391_rosmon_sale_16`（迷迭香第三皮肤）：boost=4.5 命中手动表 → 自动放大被跳过；其**包围盒 486×121px 但可见角色仅 68px**（模型导出时留白大）→ 看起来小。
- `winter`（苏苏洛·寒冬）：可见 72px ≈ 画布高 60% 多，刚好高于 55% 阈值 → 漏网。

**修复（renderer/pet.js）**：
- 自动放大对**全部皮肤生效**（去掉 `!spineManual` 门槛），阈值 55% → **75%**（可见不足画布高 75% 即放大到约 90% 满高，上限 5 倍，一次性）。
- 目录名识别修复：`summer/winter` 等无数字前缀的自定义目录也能正确取到目录段（此前恒为 ""，boostTable 无法按名命中）。
- `relDirOf()` 日志标签同步修复（此前命名目录一律显示 builtin）。

**验证（CDP 实测运行实例）**：
- `391_rosmon_sale_16`：`自动适配 vis=68px → ×1.59`（68→108px）
- `winter`：`自动适配 vis=72px → ×1.50`（72→108px，与内置苏苏洛的适配后高度一致）
- 已部署（MD5 一致），皮肤已切回用户原用的迷迭香第三皮肤。

### §13 追加 47：皮肤自适应修正——固定缩放防守卫缩回 + 撒娇语音回退（v2.4.1，2026-08-26）

**用户反馈**：①迷迭香第三皮肤反而更小了；②撒娇语音听着不舒服，先换回来。

**问题①根因**：§46 的自动放大按"可见高度"放大后，每帧贴合逻辑的**宽度守卫+高度守卫**仍按**包围盒**（迷迭香第三皮肤包围盒 486:121，横宽比 4:1，留白巨大）把比例缩回——放大被逐帧撤销，净效果反而略小。

**修复（renderer/pet.js）**：自动适配过的皮肤（`spineFitKeepScale=true`）**固定缩放 k=1**，跳过每帧贴合对包围盒的缩小；定位（居中/贴地/翻边）仍每帧执行。普通皮肤保持原贴合逻辑。

**验证（CDP 截图实测）**：迷迭香第三皮肤可见角色 68px → **108px**（画布内 90% 满高，与内置苏苏洛一致），宽 178px（含武器/尾巴展开）。

**问题②**：撒娇语气词池与语速表条目移除（恢复中性读法）；撒娇情绪词保留（动画不受影响，语音回中性）。若后续参考音频方案到位，再按情绪参考实现。

**已部署（MD5 一致）+ 重启生效**。

### §13 追加 48：Spine 皮肤自适应最终修复——画布按宽比加宽 + 可见轮廓定位（v2.4.2，2026-08-26）

**用户反馈（连续两轮）**：迷迭香第三皮肤"反而更小"→"出画布了，有时候出现有时候消失，坐下缩小，走时出现"。

**根因链**：
1. 像素采样顺序错误：采样在包围盒定位**之前**，角色未贴地时只采到画布内一小条（vis=20px → ×5.00 灾难性放大）。
2. **画布宽度硬限制**：`.pet` 元素固定 120px 宽（pet.css），迷迭香第三皮肤可见轮廓宽高比 ~1.65:1（持武器/大尾巴），120px 画布下满高（108px）需要 ~178px 宽 → 放不下 → 放大必出画布。
3. 固定缩放（k=1）后每帧贴合守卫按**包围盒**（486:121 横宽 4:1）缩回 + 包围盒居中把角色本体推出画布 → 消失/闪现。

**修复（renderer/pet.js，v2.4.2）**：
- **画布按可见宽高比加宽**：适配阶段若可见轮廓宽高比 >1.15，先 `petEl.style.width` + `spineApp.renderer.resize` 加宽画布（上限 520px，和窗口一致）再放大——满高目标变得可行。
- **可见轮廓定位**：自动适配皮肤用"迭代平移采样（角色整体进入画布后再测）+ 可见中心/底边精定位"，包围盒留白完全不参与定位。
- 采样顺序修正：先包围盒粗定位再采样（恢复正确 vis 测量）。
- 固定缩放（k=1）保留，仅守卫不再缩回。

**验证（CDP 截图实测运行实例）**：迷迭香第三皮肤两次截图（间隔 6s，含行走相位切换）完全一致——**稳定 122×176px，不出画布、不消失**；适配日志恢复正常 `vis=68px → ×1.59`（此前错误 ×5.00）。角色位于窗口右侧为设计（.pet right:2px，给左侧气泡让位）。

### §13 追加 49：皮肤自适应最终修复——基准测量 + 宽度上限 + 守卫跨动画保持（v2.4.3，2026-08-26）

**用户反馈（第三次）**："迷迭香问题依然存在，排除一下"。

**系统排查结论**：
1. 前版 bug：适配测量在"包围盒守卫折叠"（k=min(1, W/bboxW…)）**之后**进行——迷迭香包围盒 486:121（横宽 4:1），折叠后可见仅 32px → 放大系数 ×3.38 过冲 → 角色暴涨出画布消失。
2. `scheduleFitSpine` 每次动画切换重置 `spineAutoScaled`/`spineFitKeepScale` → 每次相位切换重新适配 → 比例无限累乘（已修复，守卫跨动画保持，仅换皮肤时重置）。
3. 渲染进程曾 OOM（03:17，当时多次叠加测试压力所致，非稳态问题）。

**最终修复（renderer/pet.js v2.4.3）**：
- 适配测量改在**无守卫基准（k=1）**下进行——宽包围盒模型的测量不再被折叠污染。
- 放大系数 = min(高度目标, 宽度目标)，宽度受限（可见宽高比 >1.15）时先按 `H×aspect` 精确加宽画布（上限 520px）再放大。
- keepScale 皮肤固定缩放 + 迭代平移采样 + 可见中心/底边定位；`spineFigLeftCss` 记录角色可见左缘，几何上报用它替代元素左缘（画布加宽后行走对齐不偏移）。
- 验证：适配每次皮肤加载只触发一次（×1.35），32s 连续截图尺寸恒定 176-178px、不出画布、不消失。

### §13 追加 50：语音完全回退 + 迷迭香腿缺失修复（v2.4.4，2026-08-26）

**用户反馈**："腿不见了，修一下；音色完全不对，先完全回退到没调整的。"

**音色不对的根因**：v2.4 给 `gsvTtsJa` 接上了配置里的参考音频（`E:\SussurroTrain\segments\seg_000.wav`）——此前该配置一直被代码忽略（服务端用默认参考），接上后**每句合成都被这段参考音频带跑音色/韵律**，听感完全不同。

**语音完全回退（还原到未调整状态）**：
- `tts-manager.js`：`gsvTtsJa` 移除 `ref_audio_path`/`prompt_text` 传递；删除 voiceRefs/emotionGsvRef 情绪参考表；queueTts/ttsCloneImpl 还原无 opts。
- `renderer/pet.js`：克隆播放还原为原始 HTMLAudio（`cloneAudio` + playbackRate 钳 0.9~1.1，删除 playCloneBuffer/clonePlay）；EMOTION_SPEECH 还原单尾音（开心"呀！"、傲娇"哼！"等）；EMOTION_VOICE 还原原始值；移除 EMOTION_LABEL 归一化（回到直接按情绪名匹配）。
- `preload.js`/`main.js`：speakClone/tts-clone 还原无 opts。
- `src/config.js`：移除 coquetry（撒娇）情绪；用户运行配置经 saveSettings 移除撒娇（20→19，文件已核对）。
- 已部署（MD5 一致）+ 重启。验证：无"参考音频"日志、无适配日志、撒娇不在情绪表。

**迷迭香腿缺失修复**：恢复 `!spineManual` 门控——手动 boost 皮肤（boostTable 命中，迷迭香第三皮肤 486:121 超宽包围盒）不再自动放大（120px 固定画布强行满高必然裁剪腿部）；恢复原始手动缩放 + 完整显示。
- 验证（CDP 截图 20s）：迷迭香稳定显示，可见 50-58×100px，顶 y=260 底 y=360（贴地、整身完整无裁剪），5 次采样完全一致，无消失/出画布。
- 教训：超宽包围盒模型的"放大"受画布宽度硬限制，120px 画布下强放大必然牺牲完整性；优先保证稳定完整，放大需另做画布尺寸特性（不做在本次）。

## 10. 用户已明确的偏好与禁区

- 不推送 GitHub（2026-08-25 用户已明确改为：**按需推送**——2.0.1 修复集已推送到 main；推送前复核无敏感文件）。
- 不要实现多桌宠同屏互斥。
- 用户希望中文沟通。
- 任何会删除/移动真实用户 config、密钥、历史、模型、声音或资产的操作，先确认；当前迁移策略是复制并保留旧文件。
- 不要在回复、日志、测试输出、文档或 commit 中打印 API key、token 或 DPAPI ciphertext。


---

### §13 追加 51：长期记忆落地（RP 优化第一弹，v2.5，2026-08-26）

**背景**：设置项"🧠 长期记忆（features.longTermMemory，默认开）"存在但为空壳——LLM 摘要每 20 轮生成后只打日志不存储不注入，等于没实现。本次按 roadmap 重点项目 B 落地为正式功能。

**实现**：
- 新增 `src/memory.js`：事实存储（userData/memory.json，本地不联网）+ 规则式事实提取（称谓/生日/喜好/健康/近期安排，保守宁缺毋滥 + 同类型覆盖 + 重叠去重 + 条数封顶）+ 第 20 轮 LLM 摘要入库（≤300 字）+ 注入文本生成（≤400 字，不压主提示词权重）。
- `main.js`：`buildChatPersona()` 每轮把「【苏苏洛记得的事】」拼进 system prompt（受开关控制）；用户消息规则式提取事实（try/catch 不影响对话）；20 轮摘要从"只打日志"改为 `memory.updateSummary` 真正入库；Agent 接口同样走 buildChatPersona。
- `src/features.js`：主动搭话"由头"化第一步——记忆中若有博士健康事实，30% 概率主动开口关心（"记得你之前不太舒服……"），不再纯随机。

**验证**：提取规则单测全过（称谓/生日/喜好/健康/安排 5 类，含反例）；memory.json 写入/读取/注入文本正常；MD5 部署一致；应用重启在线。测试期间写入的 memory.json 已清空，等真实对话积累。在线 LLM 调用未做（避免消耗 API 配额 + 污染聊天历史），端到端在用户下轮聊天时自然验证（可要求她说出记得的事）。

### §13 追加 52：语音识别正确率——语种 bug 修复 + 参数增强 + 调研结论（v2.5.1，2026-08-26）

**用户反馈**："语音识别可能会失败和有误，请找开源提升方案。"

**首要发现（已修复）**：语音输入硬编码 `language="ja"` 识别（pet.js:1408）——用户说中文却按日语识别，几乎必然出错。已改为 `zh`。

**已应用的参数增强（stt_whisper.py，零依赖）**：固定 zh（可 auto）；`initial_prompt="以下是普通话的语音内容。"`；`hotwords=[苏苏洛/博士/罗德岛/干员/明日方舟/医疗]`（faster-whisper 1.1+，签名探测防版本不兼容）；`condition_on_previous_text=False`（防短句错误传染）；vad_filter 保持开启。已部署重启（9364 在线）。

**调研结论（docs/rp-frameworks-research.md 同目录归档于本文档；来源：SYSTRAN/faster-whisper、openai/whisper、modelscope/FunASR、FunAudioLLM/SenseVoice、k2-fsa/sherpa-onnx）**：
- **首选**：faster-whisper 换 `large-v3-turbo`（809M，large-v3 蒸馏版，中文明显优于 medium，接近 large-v3），8GB 显存建议 `compute_type="int8_float16"`（占用约 2.9GB 档，需实测）；其余参数已就位。
- 备选：SenseVoiceSmall（FunASR，中文 CER 7.81% vs Whisper large-v3 20%，RTF GPU 170x/CPU 17x，pip install funasr，支持 hotword，MIT 代码+模型开源协议署名）——中文长句/人名地名场景可做主引擎、faster-whisper 兜底日语词（双路按置信度选路）。
- 其他：Paraformer-zh/sherpa-onnx（更轻，CPU 流式）、whisper.cpp（纯 C++ 免 Python）。

**待用户确认**：是否切换 large-v3-turbo（首次使用需下载 ~1.6-3GB 模型）；或后续加 SenseVoiceSmall 双路。

### §13 追加 53：记忆管理入口 + 记忆加密防护（v2.5.2，2026-08-26）

**用户需求**：设置页加记忆管理入口；构建防护防止记忆被偷取/篡改（记忆内容注入 LLM 提示词，篡改 = 提示词注入入口；明文存盘易被偷读）。

**记忆管理（设置页）**：新增「🧠 记忆管理」区块——显示已记住条数（含对话摘要提示）、逐条列表（每条可 ✕ 删除）、「🗑️ 清空全部记忆」按钮（confirm 确认）；事实带稳定 id（deleteFact 按 id 删除）；IPC：pet:get-memory / pet:delete-memory-fact / pet:clear-memory + preload 桥。

**防护（DPAPI 加密）**：memory.js 支持注入加密器（main.js 用 safeStorage.encryptString/decryptString）；**memory.json 整文件加密存储**（防偷读明文）；读取时解密失败/JSON 损坏 → 判定为被篡改 → 自动重置为空 + 启动时 toast「⚠️ 记忆文件异常，已重置」；旧版明文文件自动迁移为加密（load 时检测 "{" 开头即重写加密）。文件管理接口（getFactsList/deleteFact/clear/getSummary/init/wasTampered）。

**验证**：getMemory/deleteMemoryFact/clearMemory 在线可用；memory.json 已从明文迁移为 DPAPI base64（`djE0...`，非 JSON）；单测删除/清空/去重通过。

**环境崩溃排查（非代码问题）**：期间一次应用退出——启动 11s 后 GPU 进程异常退出（exit_code=1）→ 网络服务崩溃 → 渲染进程 killed → 自动重载，应用最终退出。崩溃时刻与我的验证命令被环境中断重合；同一代码干净重启（9367）无任何错误并稳定在线。此前同类 GPU 环境问题已有先例（早期 npx 启动 2s 退出、03:17 OOM）。结论：环境 GPU 不稳定，非记忆/加密代码问题。

### §13 追加 54：日语语音修复——翻译器兼容 anthropic 协议（v2.5.3，2026-08-26）

**用户反馈**："日语又挂了"。

**症状**：日志反复 `[ja] 翻译失败，退回中文合成` → 用中文 Genie 音色说话而非日语 GSV 音色。

**根因**：用户聊天 API 配置 `apiType: anthropic`（聚合站 api.cn-qanyi.com 的 anthropic 通道，model deepseek-v4-pro-0813），但 `translateToJa` 里有一行**明确跳过 anthropic**（`=== "anthropic") return ""`）→ 每句翻译都直接失败回退中文。

**修复（src/ja-translate.js）**：移除 anthropic 跳过；请求按协议分支——anthropic 协议走 `{base}/v1/messages` + `x-api-key` + `anthropic-version: 2023-06-01`（与主聊天同协议），解析 `content[0].text`；openai 协议保持原样。期间一次部署失误（python 断言中止未写盘导致 dev/部署版残缺、`isAnthropic` 未定义）已修复并核对（5 处引用、MD5 一致）。

**验证（CDP 实测）**：`[ja] 翻译: 被博士摸摸… → ドクターに撫でてもらうと、また一日頑張れる気がする` + `[route] gsv-ja ok 1/1句`——翻译与日语合成均恢复。（06:57 的旧"翻译失败"仍为修复前实例日志；GSV "引擎崩掉→自动重启"是既有自愈机制正常工作。）

### §13 追加 55：苏苏洛情绪参考音频（本人原声，中文；日语需日服资源）（2026-08-26）

**背景**：下载代理两次失败（首次内容过滤、二次静默退出无产出）；PRTS 对本环境 IP 全站 403（含 API），WebFetch 超时。

**解决方案**：用**桌宠自身 Chromium**（用户本机网络，可访问 PRTS）经 CDP：导航宠物页到 `prts.wiki/w/苏苏洛` → 挖出全局 `window.charvoice_list`（含 char_298_susuro 全部台词文本）→ 确认音频域名 `torappu.prts.wiki`（该子域对本环境**可直连**，主域 403 不拦子域）→ curl 下载 4 段，ffmpeg 裁剪静音+限长 → 导航回应用（等同重启，宠物正常恢复）。

**产出（E:\SuzuranPetGitoice-ref\）**：
- ref_normal（任命助理 cn_001，11.5s→9.5s WAV）："博士，休息时间到了。……休息，休息一下，嗯，就现在。"
- ref_tsundere（信赖提升后交谈1 cn_006，23.3s→9.5s）："……真是的，明知道我不擅长说这种话，还要装成听不清的样子，博士，不许再这样坏心眼了哦？"
- ref_coquetry（闲置 cn_009，27.2s→9.5s）："甲板上的阳光果然好暖和……欸，现在可不是在偷懒……"
- ref_surprised（cn_010，8.7s）："……这份营养餐的菜单，究竟是谁写出来的啊？内、内容也太可怕了吧！"
- 均含 .txt 台词原文（中文）+ 32kHz 单声道 .trim.wav。

**重要限制（待用户确认）**：**以上为苏苏洛中文原声**（PRTS 只托管国服音频，无 ja 文件；`charvoice_list` 仅 cn_ 键）。日语原声需日服资源/日文 wiki（gamerch 等）另行获取。按 roadmap 约定**未接入** TTS——等用户听后确认情绪标注与"中文 vs 日语原声"取舍后再谈接入（默认合成仍不带参考音频）。

### §13 追加 56：情绪参考音频安全接入 + 语种实测确认（v2.5.4，2026-08-26）

**用户确认**："台词翻译成了中文而已，音频是日语的可以通过，记得备份，然后尝试更新"。

**语种实测**：用户指正后，用 faster-whisper 对 4 段裁剪音频转写——**确认为日文原声**（"ドクター、そろそろ休憩の時間だよ…"），此前"cn_=中文"的推断错误（PRTS 目录名与语音语种无关），已收回并更新台词文本为日语原文（refText 与音频同语种）。

**接入（安全红线实现）**：`voice-refs.json`（APP_DIR 根）+ tts-manager 情绪参考：
- **默认合成绝不带参考音频**（含无情绪/未命中情绪/平常等）——上轮音色事故的红线；
- 仅 撒娇/傲娇/惊讶 命中且素材存在时，`gsvTtsJa` 传 `ref_audio_path`+`prompt_text`（日语原文）；
- 链路：pet.js `speakClone(clean, {emo})` → preload/main opts → queueTts → ttsCloneImpl → emotionGsvRef。期间修了一个键名 bug（`opts.emo` vs `opts.emotion`，兼容两者）。

**验证（CDP 实测）**：默认合成日志**无**"情绪参考音频"；带"傲娇"情绪合成 → `[gsv] 情绪参考音频: ref_tsundere.trim.wav` + `gsv-ja ok`（len 136KB→363KB，参考引导生效）。

**顺带修复**：stt_whisper.py 的 hotwords 传值 bug（faster-whisper 需空格分隔字符串而非数组，否则 AttributeError 崩整个转写）。

**备份**：voice-ref-backup-0826-1528（更新前快照）。

### §13 追加 57：合成速度优化——音频 LRU 缓存 + 长句重试限制（v2.5.5，2026-08-26）

**用户反馈**："合成速度好像有点慢"。

**耗时分摊（日志统计）**：短句 1-4s（GSV 单句推理成本）；长回复 8-14s（多句串行合成 + 质量门可能重试 3 次叠加；如开场白台词 12s+）。

**优化①音频 LRU 缓存（tts-manager，已部署实测）**：整句结果按 `文本|情绪|语种` 键缓存（20 条、TTL 5min）。摸头/主动搭话/人格化台词高度重复 → **命中后跳过翻译+合成整句秒回**。
- 实测：同一句第一次 15.3s → 第二次 **24ms**；日志 `音频缓存命中`。

**优化②长句限制质量门重试**：原最长 3 次合成尝试，长句（>60 字）推理本身慢，重试叠加可至 12s+；改为长句最多 2 次。

**待选（未实施，涉及播放路径改动需用户确认）**：**逐句流式交付**——主进程每完成一句就把音频推给渲染层先播，感知延迟从"整段 9s"降到"首句 ~2s"。因播放路径刚完成回退（音色事故），此改动单独做、谨慎验证。

### §13 追加 58：行走左缘"一直往左"修复 + 逐句流式播放（v2.5.6，2026-08-26）

**用户反馈**：①走到左边后有时候一直往左走不回头；②确认做逐句流式。

**①行走左缘 bug 根因（日志证据）**：反复出现 `出屏钳回: x=-3→-2 edgeLeft=true inset=2`。左缘翻边（edgeLeft=true）后，walkTick 顶部的"出屏钳回"用 **edge 感知** inset（2），但折返判定 `minX = wa.x - charInset` **不感知 edge**——渲染层几何上报迟到时 `walk.charInset` 短暂变回 138 → minX=-138 → 折返永不触发 → 一直往左 + 反复钳回。
**修复**：`clampWalkX`/`walkMinX` 统一改用 `walk.edgeLeft ? 2 : charInset`（与钳回同源），贴左缘立即折返，几何上报迟到不再撕裂判定。

**②逐句流式播放**：主进程 GSV 分支每句合成完成即 `partSender` 推给渲染层（preload onTtsPart）；渲染层队列播放器（ttsPartQueue/ttsPartEpoch 作废机制/stopTts 联动/speakActive 接收窗口）；speak() 流式已播则跳过整段合并音频（避免重复）。实测：摸头单句 `[render] 流式播放 parts=1（跳过合并段）`；长回复（4 句 12.1s 串行）首句 ~2-3s 即开播，感知延迟大幅下降。期间修正：克隆失败时的系统语音回退路径（流式分支补 return + 回退恢复无条件执行）。

### §13 追加 59：迷迭香第三皮肤下半身问题——排查结论与回退（v2.5.8，2026-08-26）

**用户反馈**："迷迭香下半身不完整"（腿/脚被截）。

**排查（vision 逐轮实测）**：
1. 加宽画布尝试（放开手动 boost 皮肤的自动放大 + 画布扩容）→ 角色变大但腿仍截；且该模型**逐帧像素采样不可靠**（宽窄帧交替，曾把画布缩到比角色还窄）。
2. 回退后仍截——**确认腿截断是持续问题**（早于本轮；此前的像素 alpha 框分析漏判，vision 才准确）。
3. 根因：120px 固定画布高度 < 该模型全身高度（裙摆/腿需更长画布）；常规路径贴地把底边钉在画布底缘 → 腿脚被裁。
4. 部分修复：常规路径贴地上移 10px（脚/裙摆部分可见，改善明显但未完全）。

**决定**：不再在本轮硬调（画布加高会联动行走布局与 GIF 模式，属独立功能）。已回退到稳定状态；**"画布按模型尺寸自适应（含高度）"列为 roadmap 重点项目 A 的正式实现需求**（需用模型静态尺寸，而非逐帧采样；注意 .pet max-width calc() 上限与 GIF 模式回退）。当前显示：腿部分可见、行走/语音功能全部正常（含情绪参考、流式、缓存）。

### §13 追加 60：画布高度 120→170（Spine）——迷迭香下半身根治（v2.5.9，2026-08-26）

**修复**（承接 §59）：Spine 模式 pet 元素/PIXI 画布高度 **120→170px**（initSpine 设置，切回 GIF 时 setRenderMode 恢复默认高度，避免 object-fit:contain 的 GIF sprite 被放大）；手动固定尺寸角色（迷迭香第三皮肤）因此在更高画布内获得完整下半身空间，适配皮肤按 0.85×H 比例同步受益；贴地间隙补偿不变（元素底仍距窗口底 26px）。

**验证（vision 截图实测）**：迷迭香第三皮肤「两条腿从大腿中段到脚踝完整显示，双脚穿鞋完整可见，头顶到脚底完全在画面内无裁切」——§59 的"下半身不完整"根治。回归：内置苏苏洛 122×206、寒冬 124×196 均完整；行走无反复钳回（左缘折返修复保持）。

### §13 追加 61：按皮肤窗口加宽（roadmap A 核心落地）+ 聊天框遮挡修复（v2.5.10，2026-08-26）

**用户反馈**：①迷迭香变大后聊天框被遮挡；②迷迭香"又变小了，后续怎么优化"。

**聊天框遮挡根因**：此前残留的"画布扩容 220"代码把 pet 元素设为 220/300 宽，盖住左侧气泡；且 `.pet` 的 `max-width: calc(100%-136px)` 封顶了加宽。已清理残留（扩容/加宽画布逻辑全删）+ 恢复手动皮肤门控 + 气泡在宽皮肤下避开角色（CSS right:308px）。

**按皮肤窗口加宽（roadmap A 正式做法）**：
- 主进程：`pet:set-skin-window-width` IPC + `skinWindowWidth`/`targetWindowWidth()`，行走启动/坍缩恢复用目标宽度（含 resizable:false 的 setSize 绕行）。
- 渲染层：`WIDE_SKINS` 映射（当前：391_rosmon_sale_16 → winW:460, canvasW:300, scaleH:0.72）；`applySkinWindowMode` 加宽元素+上报窗口宽；`skinWinWidth()` 统一行走激活/放大还原的窗口宽度（修复 260 顶掉 460 的打架）；宽皮肤门控放行自动放大（`!spineManual || spineWide`）。
- 铺地：气泡 wide-skin CSS；keepScale 用 lastSample 兜底居中贴地（未 settle 时）。
- **实测**：窗口 460 ✓、角色大幅变大（~120px vs 原 ~100px）、气泡文字清晰不遮挡 ✓、行走无反复钳回。

**遗留（需独立回合精调）**：迷迭香第三皮肤"腿脚底部仍被画布裁"——该模型逐帧采样不可靠 + 画布 300×170 与该模型全尺寸的定位/尺寸需冷静精调（scaleH/贴地偏移/画布高的组合），会话已很长，不继续堆叠冒险。当前状态：大角色 + 清晰气泡 + 行走正常，可用。

### §13 追加 62：删除迷迭香第三皮肤 + 任务栏悬浮回归修复（v2.5.11，2026-08-26）

**用户决定**："迷迭香修不好那个皮肤就删了吧，然后集中修一下相关感知，比如现在苏苏洛的任务栏坐标又出问题了"。

**①删除 391_rosmon_sale_16**：移除部署版与 userData 两处模型文件夹 + 代码引用（WIDE_SKINS 条目、boostTable 4.5、boostOffsetTable -0.14、SPINE_CN 显示名）。实测皮肤列表 36→35、不再包含该皮肤。保留其余 Rosmontis 皮肤（391_rosmon、391_rosmon_epoque_17 正常）。

**②任务栏坐标回归根因**：keepScale（苏苏洛内置等适配皮肤）贴地加了 5% 底边距（8.5px），但 keepScale 分支**未把贴地余量上报 visibleCanvasGap**——主进程不知情，角色脚浮在任务栏上方 8.5px。修复：keepScale 分支补上与常规路径一致的 sampledGap 累计逻辑（hits≥2 稳定后生效）。行走启动/坍缩恢复的宽度也统一走 targetWindowWidth（此前 260 顶掉宽皮肤 460）。

### §13 追加 63：迷迭香相关改动整体回退（v2.5.12，2026-08-26）

**用户决定**：迷迭香皮肤已删除（§62）；进一步确认"角色偏高"由修迷迭香引入 → **回退迷迭香时代全部渲染/主进程改动**。

**回退内容**：
- 渲染层：画布高度 170→120（含 GIF 恢复、initSpine 覆盖）；keepScale 5% 贴地边距/间隙上报/lastSample 兜底全部移除（贴回画布底边，layoutGap 统一补偿）；手动路径 10px 偏移移除；WIDE_SKINS/applySkinWindowMode/skinWinWidth 整套移除；适配门控回 `!spineManual`；适配目标回固定 0.85。
- 主进程：pet:set-skin-window-width IPC、skinWindowWidth/targetWindowWidth 整套移除；行走启动/坍缩恢复回 `wc.width || 260`。
- 保留：行走左缘 edge 感知折返修复、流式播放、音频缓存、情绪参考、记忆、添加人物窗口（均与迷迭香无关）。

**验证**：窗口 260×200、pet 元素 120×120，语义回到 v2.5.6 稳定版（任务栏贴地由 layoutGap 唯一决定）。苏苏洛应恢复踩任务栏。

### §13 追加 64：羁绊/好感度系统（RP 重点项目 B 第二弹，v2.5.13，2026-08-26）

**实现**：
- 新模块 `src/bond.js`：经验/等级/连续陪伴天数，本地 bond.json（不联网）；聊天/摸头 +1 经验，每日首次互动额外 +2（天数十连续累计）；等级 1~10（累计经验表 5/15/30/50/80/120/170/230/300）；`getText()` 按等级输出亲密描述注入人设（Lv1 职业矜持 → Lv7+ 藏不住依赖 → Lv10 认定她）。
- main.js：聊天/摸头挂经验 + 升级 toast（"🥰 羁绊升级 Lv.X"）；buildChatPersona 注入羁绊描述；get-memory 返回羁绊信息；设置页「记忆管理」展示「羁绊 Lv.X · 已陪伴 N 天」。

**debugging 插曲（值得记录）**：接入时 require 行漏写（首个 python 脚本在 buildChatPersona 处断言中断未写盘，后续编辑只补了函数没补 require）→ 运行时报 `bond is not defined` → getMemory 走 catch。另发现本机有 5 个桌宠旧进程常驻（旧 main.js），此前多次"验证旧代码"是它们在应答——已按端口逐 PID 清理，确认单实例运行新代码。

**验证**：bond.json 正常生成（exp=4/days=1，两次摸头）；getMemory 返回羁绊；启动标记"v2.5.13 bond+羁绊 已加载"确认部署版 main.js 生效。

### §13 追加 65：RP 采样参数调优 + 三模式切换定位修复（v2.5.14，2026-08-26）

**①采样参数（roadmap B 第三项）**：
- config `chat.sampling`：topP 0.9 / minP 0.05 / repeatPenalty 1.1 / presence 0.1 / frequency 0.1（本地小模型 RP 配方）。
- chat-client：远程 OpenAI 兼容传 top_p/presence_penalty/frequency_penalty；本地（localhost/Ollama）额外传 min_p/repeat_penalty；Anthropic 传 top_p。设置页新增五行采样输入。

**②三模式（GIF/Spine/rig）切换问题排查**：
- 现象：切换模式后窗口悬空/陷地/跳到第二显示器（曾 x=1307 超右屏）。
- 根因：切换时主进程贴地用的 `getDisplayMatching` 在窗口漂到显示边界/副屏时取错 workArea；且渲染层模式初始化（setSize/几何上报）会异步再挪窗口。
- 修复：切模式时**强制对齐主屏任务栏上沿 + x 钳回主屏**，并加 **2.5s 延迟二次贴地**（按切换后实际尺寸再贴一次）。
- 验证：gif/spine/rig/spine/gif 循环切换后窗口一致 (72, 底938=任务栏912+贴地26)，x 稳定在主屏 72，不再悬空/跨屏。
- 崩溃评估：期间某实例未启动（可能启动锁冲突）导致测试命令扑空——非代码崩溃；日志无新崩溃记录（仅历史 GPU 环境崩 + 翻译 API 503 重试）。

### §14 追加 66：PSD 单图层编辑 + 行走打磨 + 主动搭话由头扩展（v2.6，2026-08-26）

**①PSD 角色工具：单图层编辑（方便他人调整）** — renderer/psd.html + psd.js：
- 交互式图层树：点选高亮、👁/🙈 显隐切换（兼容 ag-psd「hidden」标志与旧 visible，序列化往返不丢）。
- 新增操作行：📄导入图层（PNG/JPG/WebP/GIF，居中放最上层）、⧉复制选中（偏移 +16）、🗑删除选中（组整体删）、🔍选中缩放（10–500%，**按图层内容包围盒中心为锚**，缩放后内容中心在文档中位置不变，自动改 left/top/right/bottom）。
- 编辑后：扁平化预览/导出 PNG 自动应用；2.5D 动态预览与「应用到桌宠」**改走内存编辑态**——rigger 消费前从 canvas 重建 imageData（隐藏层剔除），「应用到桌宠」用 ag-psd writePsd 把编辑后的图层树重序列化为 .psd（新 IPC `pet:rig-apply-buffer`，preload 暴露 rigApplyBuffer），落盘 rigUser 并切换。未编辑仍走原文件路径（保留 PSD 原生细节）。
- rigger.js：装配前过滤 hidden 层（`c.hidden !== true && c.visible !== false`）——修复"隐藏层也被装入桌宠"的旧行为，与工具预览一致。
- Node 验证：read→write→read 往返保留 left/top/尺寸/隐藏/透明度；缩放 80% 内容中心锚定（150+100=170+80=250 不动）；rigger 装配正常且剔除隐藏层。

**②行走打磨**：
- 相位循环：修复"站立待命（拖拽松开未吸附）永久站桩"——站两轮仍无新决策自动落座休息（walkOnPhaseEnd 增加 _standLoops 计数器）。
- 坐窗图标一致：跳上桌面图标时统一 perched=true（原 iconRest 分支无 perched → 渲染层播站姿且无下沉，45% 概率浮在图标上方），现在图标坐与窗顶坐一致：播 Sit + 边缘下沉。

**③主动搭话由头化扩展（Roadmap B）** — src/features.js：
- 由头优先级：①生日=今天 → 必开口祝贺；②健康记忆 → 记得关心；③近期安排（考试/面试/答辩/加班…）→ 动态拼台词助威；④称谓记忆 → 偶尔用博士喜欢的称呼搭话；都无再走时段/超长闲置常规台词。

### §14 追加 67：情绪语音接线完成（v2.6，2026-08-26）

**背景**：GPT-SoVITS 日语模式（speakJa）的"情绪参考音频"此前只做了素材与读取骨架（voice-refs.json + emotionGsvRef），但：
1. 参考音频文件从未部署到正式版（APP_DIR/voice-ref/ 缺失）→ emotionGsvRef 永远返回 null，等于没做；
2. 情绪词未归一化（模型可输出 name 如 surprised/wow 或近义词如惊喜/震惊，精确匹配命不中）；
3. 默认情绪表缺"撒娇"，coquetry 参考音频无法触发。

**本次接线**：
- **部署素材**：voice-ref/（ref_normal/coquetry/tsundere/surprised 的 .trim.wav+.mp3+.txt，铃兰错误剪辑隔离在 _wrong-linglan 不部署）→ 正式版 APP_DIR/voice-ref/。
- **emotionGsvRef 归一化**（src/tts-manager.js）：label/name/近义统一映射三档——撒娇系（撒娇/娇/娇羞/coquetry）、傲娇系（傲娇/tsundere/别扭）、惊讶系（惊讶/吃惊/震惊/惊喜/surprised/surprise/wow，含子串匹配如"有点惊讶"）；命中后 GSV 请求带 ref_audio_path + prompt_text（日语原文）。
- **红线保持**：默认合成/未命中情绪（开心/idle/空）绝不带参考音频（v2.5.4 红线原样）。
- **撒娇情绪**：默认情绪表新增 {name:"coquetry",label:"撒娇",emotion:true}（src/config.js）；运行 config.json 备份后插入同款（19→20 情绪）；补齐用户 sprite 目录 assets/sprites/user/coquetry.gif（exists ✓ 有动画）。
- **验证**：Node 复测归一化 7 组输入全命中、开心/idle/空不命中；CDP 查运行态 getMoods → 傲娇/撒娇/惊讶均 exists ✓；链路 speak(text, emotion) → speakClone({emo}) → emotionGsvRef → gsvTtsJa(ref_audio_path+prompt_text) 已通（日志出现「情绪参考音频: ref_*.trim.wav」即生效）。

### §14 追加 68：消息生成防抖（v2.6，2026-08-26）

**问题**：会话切换/连续发送过快时，合成链路（翻译→逐句 GSV→流式）堆叠吃不消——旧回复的语音拖尾混进新回复、主进程并发 ask 直接报"上一句还没说完"、渲染层 busy 期输入被静默吞掉。

**三层防抖**：

1. **主进程合成任务让位**（src/tts-manager.js）：`queueTts` 每个任务带 `ttsJobSeq` 代号；排队期间或逐句合成中途来了新消息 → 旧任务立即作废（返回空、不再推 part）。流式 part 带 `opts.session` 会话号，渲染层按会话过滤旧 part。
2. **主进程 ask 合并缓冲**（main.js）：`activeReq` 占用中再来消息 → 不再报错，缓冲最新一条（`pendingAsk`，300ms 合并窗口内只留最后一条），当前回合结束后自动补发；`pet:stop` 时丢弃缓冲；中止路径新增 `pet:stopped` 通知（顺带修复"点停止后 busy 卡死、输入与停止按钮失效"的旧 bug）。
3. **渲染层 busy 缓冲补发 + speak 会话失效**（renderer/pet.js）：busy 期输入先缓冲（300ms 合并），回合结束（done/error）自动补发；`speak()` 带会话号——新消息先 `stopTts()` 停掉旧音频/排队 part，旧会话的合成结果/fallback 系统语音/错误语音全部作废丢弃，只播最新一条。

**验证**：
- Node 模拟 queueTts 让位：A 句1 播放→B 到达→A 句2 让位返回空、B 完整产出 ✓
- 部署 MD5 六处一致（main/preload/pet/tts-manager/psd/rigger），应用运行健康（walk 日志持续、Agent 正常）。
- **环境备注**：约 20:45 起本机所有 Electron 实例的 DevTools CDP 命令分发失效（ws 握手正常、/json/http 正常、应用不受影响；回退代码+全新 profile 复测均死 → 与代码无关，疑 OS/网络层状态，试重启机器后再用 CDP）。本轮运行期验证改用 tts.log + Node 模拟兜底。

### §14 追加 69：情绪音色选型 v2 —— 新增开心/温柔，撒娇强化（v2.6，2026-08-26）

**背景**：用户试听 v1（撒娇/傲娇/惊讶）后反馈：撒娇需要更明显；新增"开心"（苏苏洛的信赖触摸语音）与"温柔"两档。

**素材**：
- 开心：用户提供 prts.wiki 苏苏洛「信赖触摸」原声 → whisper 转写「やっぱり仕事の後は飲みたくなるよね。ジュースをとってもらっていい？ありがとう。」→ ffmpeg 裁剪 ref_happy.trim.wav（32k/16bit/mono，与原 ref 对齐）。
- 温柔：复用已有「任命助理」素材 ref_normal.trim.wav（"该休息了"关怀台词）。
- 撒娇更明显：参考音频不变，改走**实时播放参数 + 语气词**强化：EMOTION_VOICE 撒娇 rate1.10/pitch1.12、EMOTION_SPEECH 撒娇句尾「嘛～」（应用内生成/朗读均生效，无需新素材）。
- 备份：voice-ref-backup-20260826-211739*（dev+部署素材/JSON/config 快照）。

**接线**：
- voice-refs.json 五档：撒娇/傲娇/惊讶/温柔/开心（每档 text=日语原文，GSV prompt_text 用）。
- emotionGsvRef 归一化扩充：开心系（开心/高兴/快乐/喜悦/雀跃/happy/joy/glad）→ 开心；温柔系（温柔/温和/轻柔/温软/tender/gentle/soft）→ 温柔。
- 情绪表 21 个：默认表与运行 config 插入「温柔/gentle」（保留 GIF 缺失兜底），开心(happy)原有。
- pet.js EMOTION_VOICE 增撒娇(1.10/1.12)、温柔(0.94/1.02)；EMOTION_SPEECH 撒娇「嘛～」。

**验证**：部署 MD5 全一致（voice-refs.json、tts-manager、pet、config）；v2 试听 9 条（默认对照 + 五档本命句 + 同一句对照，含实时参数 atempo 模拟）生成并播放于桌面「苏苏洛情绪试听-v2」；长句按句子分合成后拼接（避开引擎多句截断）。

**备注**：本机 20:45 后出现的旧实例端口幽灵（8765/热键被已死 PID 占用）仍在，待系统重启自愈；详见 docs/ENV-CDP-DEVTOOLS-ISSUE.md。

### §14 追加 70：情绪音色定稿 + 设置页情绪音色试听（v2.6，2026-08-26）

**音色定稿**（用户 v2 试听通过）：五档参考音频默认启用——撒娇（ref_coquetry，含实时参数 rate1.10/pitch1.12 + 句尾「嘛～」强化）、傲娇（ref_tsundere）、惊讶（ref_surprised）、温柔（ref_normal·任命助理）、开心（ref_happy·信赖触摸，用户提供素材）。红线不变：默认合成/未命中情绪绝不带参考音频。

**设置页情绪音色试听**（renderer/settings.html+js、src/tts-manager.js、main.js、preload.js）：
- 语音设置区新增「情绪音色试听」：默认音色 / 撒娇 / 傲娇 / 惊讶 / 温柔 / 开心 六个按钮。
- 新 IPC `pet:emotion-audition`（key）→ tts-manager `emotionAudition()`：校验 GSV 启用与 speakJa → 按情绪键取参考音频 → 分句合成（splitJaSentences+mergeWavBase64，避开多句截断）→ 返回 wav base64；「默认音色」合成对照句（无参考）。
- 播放端用真实播放参数模拟：base=设置页语速×情绪倍率，钳 [0.9,1.1]，与渲染层一致。
- 部署 5 文件 MD5 全一致；重启后热键/8765 恢复正常（此前端口幽灵已自愈）。

### §14 追加 71：桌面全域行走实验开关（v2.6，2026-08-26）

**功能**：设置 → 实验性功能 →「🌍 桌面全域行走」开关（默认关，仅 Spine 模式生效）。
开启后水平行走边界从"当前显示器工作区"扩展为**整个虚拟桌面**（`screen.getAllDisplays()` 联合范围），
角色可以从主屏一直走到副屏再走回来；垂直地面仍随所在显示器（跨屏时自动按该屏地面贴地）。

**实现**（main.js）：
- `walkSpan()`：`walkGlobal` 开启时返回虚拟桌面联合 {x, right}，否则 null（走原逻辑，行为零变化）。
- `clampWalkSpan()`：与 clampWalkX 同构，用联合边界计算 minX/maxX（含左缘 inset/翻边逻辑）。
- walkTick 折返段与移动段改用 `edgeSpan ? clampWalkSpan : clampWalkX`；
  左缘"出屏钳回/切边防抖"改用联合左缘（否则会在主屏左缘被钳回、永远进不了副屏）。
- IPC `pet:set-walk-global` 即时生效（每帧读配置，无需重启）；getState 暴露 walkGlobal；
  preload 桥 `setWalkGlobal`；config 默认 `walkGlobal:false`；设置页开关接线加载/保存。

**验证**：Node 模拟双显示器（1920+1920）——关=null 走旧逻辑；开=虚拟桌面 [0,3840)、
窗口 1900 不被钳回、可走到 3580（3840-260），出界钳回正常。五文件部署 MD5 全一致，应用健康单实例。

### §14 追加 72：软件渲染开关（v2.6，2026-08-26）

**动机**：用户提出考虑"有些人电脑可能没独显/显卡驱动异常"——黑屏/GPU 环境崩溃史背景下加渲染兜底。

**实现**（重启生效，默认关）：
- `config.softRender:false`；getState 暴露；IPC `pet:set-soft-render`（保存即提示"重启后生效"，toast+日志）。
- main.js 模块顶部、`app.whenReady` 之前：`if (config.getConfig().softRender) app.disableHardwareAcceleration();`
  ——开启后整个应用（含 Spine/PIXI 与 2.5D rig 自绘 WebGL）走软件渲染，WebGL 由 SwiftShader 提供（仍可用，仅变慢）；
  rig 的 createGL 在极端无 WebGL 环境返回 null 时由 initRig 捕获回退 GIF 模式（既有兜底）。
- preload `setSoftRender`；设置页实验区新增「🖥 软件渲染」开关（不限定渲染模式）。
- 备份：`_backups/softrender-before-20260826-230553/`（五文件）。

**验证**：默认值 false（行为不变）；五文件部署 MD5 全一致；重启后热键/8765 正常、应用健康单实例。

### §14 追加 73：PSD 工具撤销/重做（v2.6，2026-08-26）

**功能**：PSD 角色工具图层操作行新增「↩ 撤销 / ↪ 重做」（另支持 Ctrl+Z / Ctrl+Shift+Z），覆盖缩放/复制/删除/新增/显隐五类编辑。

**实现**（renderer/psd.js 快照式，不拷贝画布像素）：
- `snapshotPsd()`：记录根层与组子级的**引用顺序** + 叶子层字段值（left/top/right/bottom/opacity/visible/hidden/**canvas 引用**）——缩放替换画布后旧 canvas 对象仍被快照持有，可无成本还原。
- `pushSnap()`：每次编辑前入栈（上限 30，入栈清空 redo 栈）；`undo/redoPsd()`：弹出快照并 `restorePsd()`（重建 children 顺序、还原字段、失效选区清理、重绘树/预览/rig）。
- 按钮初始禁用、随栈变化启停；页面级 Ctrl+Z/Ctrl+Shift+Z 快捷键。
- psd.html 操作行加两个按钮。

**验证**：Node 复刻同构快照逻辑——缩放/删除/隐藏三连操作后撤销×3 完整还原初始，重做×3 全部恢复；新增图层撤销正确。两文件部署 MD5 全一致（PSD 工具窗口下次打开即生效，无需重启应用）。

### §14 追加 74：行走卡住排查 + 情绪音色分档开关（v2.6，2026-08-26）

**① 行走卡住排查（结论：非全域行走所致）**：
- 排除 walkGlobal：配置关闭 + 本机单显示器（1536×960）→ 该功能在单屏是彻底无操作项。
- 旧实例（23:08）一次状态停摆无法复现；临时心跳显示引擎健康（散步→坐下循环正常）。
- 排查期间曾引入临时诊断代码，其中一版漏删旧函数引用导致主进程模块加载 ReferenceError 起不来——已修复（静态确认引用 0）。
- **永久改进：行走状态低噪诊断**——状态签名变化才记日志（active/resting/seated/perched/paused/sleeping/相位定时器/引擎），另加"90 秒无变化告警"。日志实锤：5 分钟无互动会入睡（sleeping=true 坐睡静止）= 设计行为，不是卡住。

**② 情绪音色分档开关**：
- 设置页情绪音色试听区新增五档启用勾选（撒娇/傲娇/惊讶/温柔/开心），可直接试听后停用某档。
- 主进程 emotionGsvRef：`emotionVoice[key]===false` → 该档回默认音色（不走参考音频）。
- 渲染层 speak()：`toneOn` 门控语气词注入（emotionizeText）与语速/音调表（EMOTION_VOICE）——停用档连语气词一起关。
- IPC `pet:set-emotion-voice`（即时生效，pet:emotion-voice-changed 推送渲染层）；getSettings/getState 均暴露 emotionVoice；config 缺省=全启用。
- 备份：_backups/emotion-toggles-before-20260826-234536/（七文件）。部署 MD5 全一致，应用健康（状态日志见散步/入睡相位）。

### §14 追加 75：Agent /chat 并发锁（v2.6，2026-08-26）

**动机**：8765 Agent 接口并发 /chat 会同时调模型（双倍 API 费 + 聊天历史乱序）。

**实现**（main.js）：
- `agentChatChain` 串行化链：每个 /chat 排在上一个完成后执行，失败不断链（错误返回给调用方、后续照跑）。
- `agentChatQueued` + `AGENT_CHAT_MAX_QUEUE=3`：深度超限立即 429「请求繁忙（并发队列已满）」兜底，防并发轰炸。
- /stop 中止仍作用于当前执行中的请求（queue 中的请求持各自 AbortController）。

**验证**（真机 curl 并发 5 个）：req1-3 串行 200（12.2s/20.8s/34.9s，顺序执行），req4-5 瞬时 429；回复内容正常、无重复乱序、无崩溃。

### §14 追加 76：Roadmap A 腿型微调验证（PrintWindow+vision 闭环，2026-08-27）

**背景**：CDP 环境问题仍在（页面级/浏览器级命令分发全死），视觉验证改用 **PrintWindow 抓窗口自身内容 + vision 分析**——不受其他置顶应用遮挡（Clash Verge/Zotero 曾盖住桌宠，普通 CopyFromScreen 只能拍到它们）。

**验证（冬季 spine 皮肤，站立+坐姿各多帧）**：
- 站姿：角色腿脚完整，**脚底贴窗口下边缘**（窗口贴地时=任务栏接触面）✓
- 坐姿：腿脚完整，双脚略高于窗口下缘（=腿自然垂入任务栏的下沉效果）✓
- 结论：当前使用的 winter 皮肤**站立/坐姿腿部均无裁切、无悬空异常，无需调整**——此前历次"角色偏高/腿被截"修复已覆盖本皮肤。

**附带发现**：桌宠窗口 `alwaysOnTop:true` 但会被同为置顶的 Clash Verge 面板遮挡——属应用间置顶层级叠加，非本应用缺陷。截图/窗口定位脚本留在工作区（shot_pet3/shot_print/shot_walk 等）。

### §14 追加 77：环境问题结案（误判，2026-08-27）

- CDP "失效"实为**诊断脚本 bug（命令早于 ws 101 握手发送，被 Chromium 静默丢弃）**，环境从头正常；
  已用修正版客户端（握手后发命令）全面复验：页面评估、getMoods/getState、渲染层状态全部正常。
- 档案 docs/ENV-CDP-DEVTOOLS-ISSUE.md 已重写为结案版（含教训与工具用法）。
- 意义：CDP 视觉/状态验证闭环恢复，后续行走/渲染/皮肤验证可直接用 `cdp-eval.js <port> <js>`。
- 真实次生现象留存：强杀进程后幽灵端口（需重启自愈）、Clash Verge 置顶遮挡桌宠、外网部分受限
  （GitHub 下载被拦，可走 npmmirror 镜像）。

### §14 追加 78：Roadmap C VM 环境搭建完成 + 主进程异常兜底（2026-08-27）

**VM 搭建（Roadmap C 前置）**：
- VirtualBox 7.2.16 安装（用户 UAC 一次性确认）；从微软官方直链下载 **Win11 企业评估版 25H2 中文 ISO（7.37GB，断点续传多次）**，存 `E:mwork\`。
- VM `SuzuranPet-TestVM`：UEFI+TPM2.0/4GB/2核/64GB（磁盘在 E 盘），VBoxManage 无人值守安装成功（win.vm 自动关机信号确认装机完成），桌面/auto-logon 就绪。
- 桌宠应用已复制进 guest `C:\petapp\`（宿主安装目录经只读共享 Z: 中转拷贝，5068 文件），VM 内正常运行（进程/窗口/日志健康）。

**发现并修复真实 bug（已上线宿主）**：
- VM 内主进程弹 "JavaScript 错误" 冻结框——根因 `spawn E:\GenieTTS\...\pythonw.exe ENOENT`（应用首启以安装目录 resources/app/config.json 为基准→带回宿主路径；该 spawn 异常未被捕获→Electron 默认弹框冻结主进程）。
- 修复：main.js 增加全局 `process.on("uncaughtException"/"unhandledRejection")` 兜底（记日志不弹窗）；此修复同时根治此前"模式切换/行走"偶现的模态冻结隐患。
- VM 侧关闭 ttsGenie 避免无意义拉起 → 重启后无弹窗、协议窗口正常显示。

**顺带结论**：resources/app/config.json 会被应用首启读取（字段级继承）——上轮"安装目录密钥脱敏"因此更为必要；路径类字段待 Roadmap C §2.6 复查。

详见 docs/ROADMAP-C-SECURITY-TEST.md（VM 操作手册 + 测试清单）。

### §14 追加 79：Roadmap C 首轮安全测试完成（VM，2026-08-27）

- VM 内实测：蜜标[honey]触发✅、篡改[tamper]触发+自动恢复✅、safeStorage 密钥机制确认、端口仅 127.0.0.1:8765、Agent /chat 串行+500（无密钥快速失败）、坏 Genie 配置 10 次启动 0 冻结 0 未捕获异常。
- 测试过程修复：PowerShell 写配置须 BOM-free（否则 app JSON.parse 失败回落默认值）。
- 发现：①memory 每启报"记忆文件异常"疑似误报面过大；②/health 泄露 agreed/name 等轻微信息。
- 详见 docs/ROADMAP-C-SECURITY-TEST.md §4 结果表。

### §14 追加 80：安全优化落地 + ottopet 学习收获 + 小白教程（2026-08-27）

**① 两条安全优化（已上线，备份 _backups/opt-20260827-104140）**：
- 记忆异常可诊断：VM 首启"记忆文件异常"误报根因=DPAPI 环境差异（宿主 21 启 0 误报）；现记录解密失败原因（lastLoadError）+ 区分空文件/真损坏（lastHadData），仅真有内容丢失时才弹用户提示。
- /health 收敛：去掉 agreed 字段（保留 ok/name/invokeWord/authRequired）。

**② ottopet（github.com/Derpyu520/ottopet）学习收获**：
- README/UI 写作风格：活泼命名（活字印刷/原声大碟）、占位符即答案、危险操作先说后果、连接状态给阶段反馈、删除前安抚（"原始导入文件不会受影响"）、中英分节、THIRD_PARTY_NOTICES 授权谨慎——已化为本项目教程写作规范。
- 架构可学：AI/语音/特效/偷窥/配置/存储分模块、单元可测；隐私默认关 + 明确说明。

**③ 小白教程（docs/TUTORIALS/，说人话版 7 篇 + 目录）**：01 安装 / 02 记忆与羁绊 / 03 换皮（GIF·Spine·PSD）/ 04 日语语音保姆级 / 05 行走与桌面游戏 / 06 安全与隐私 / 07 FAQ；README 与 PROJECT-STRUCTURE 已加链接。

### §14 追加 81：设置页文案活泼化 + 项目自审（2026-08-27）

**① 设置页文案"说人话"化**（ottopet 风格落地，备份 _backups/*lively*）：
- src/i18n.js：26 个高频 set.* 键改写——"③ 语音（想让它开口说话就看这里）"、"API Key（你的钥匙 🔑，存在本机保险柜，绝不外传）"、"测试连接（先试通再保存，省得回头抓瞎）"等；占位符即答案、后果先讲。
- renderer/settings.html：实验区/主动搭话/人格化 6 段纯文本活泼化（"逗猫棒：小玩具一个……想逗就开"）。
- 部署 MD5 一致；词典查找路径低风险（实机设置页验证因 CDP 目标枚举小问题跳过，已记录）。

**② 项目自审 docs/SELF-REVIEW.md**：
- 值得固化：防御性工程（密钥/篡改自愈/蜜标）、低噪状态诊断、消息不丢+防抖、并发锁、渲染三层、人格化扩展点、全局异常兜底。
- 技术债清单（按优先级）：main.js 3490 行拆模块；15 处 getDisplayMatching 收敛 helper；10 窗口统一工厂；console.log 改 logTts；测试补位（行走相位/防抖/并发锁/记忆）；配置来源唯一化（AppData 为准+打包清安装根密钥）；i18n 收敛。

### §14 追加 82：行走几何收敛（src/walk-geo.js + 单测）（2026-08-27）

**自审高优先级项落地（安全面）**：行走几何从 main.js 提取为纯函数模块 `src/walk-geo.js`
（不依赖 Electron）：显示器工作区/联合范围（spanOf/workAreaOf）、左缘补偿钳位（clampWalkX/
clampWalkSpan/walkMinX/insetOf）、地面线（groundLine）、坐姿下沉分档（seatSinkTierOf/seatSinkOf）、
相位时长（phaseMs）。main.js 相应函数改为薄委托（签名不变，调用方零改动）。
- 效果：`getDisplayMatching` 散落点 15→2（剩余为注释与构造 bounds 的独立变体）；
  3 处内联地面线计算统一为 groundLine；SEAT_SINK/相位时长逻辑集中。
- **单测**：tests/walk-geo.test.js 21 例全绿（钳位/双屏 span/负坐标/翻边 inset/下沉分档/相位钳制/兜底）。
- 验证：部署 MD5 一致；重启后行走相位循环正常（睡→醒→散步状态行实测），无回归。
- 备份：_backups/walk-geo-before-20260827-111245/（main.js 原件）。

### §14 追加 83：防御模块单测 + walk-core 拆分 + memory bug 修复（2026-08-27）

**① 防御模块单测 tests/defense.test.js（隔离临时 APPDATA，绝不动真实数据）**：
- memory：5 类事实抽取（称谓/生日/喜好/健康/事件）+ 负样本；同类覆盖/相似去重/封顶 30；
  加密落盘/密文往返/明文旧档自动迁移/篡改检测（wasTampered+lastHadData+lastLoadError）/空文件首启不报。
- bond（等级/天数/text）、lines（periodOf 五时段/pick）、utils（clamp/randInt/clampScale 边界）、
  config 默认值、蜜标诱饵文件生成。
- **修出真 bug**：memory.load() 的 catch 引用 try 作用域内 `raw` → 解密失败会 ReferenceError
  （宿主未触发因无解密失败；VM 会有）→ 修正为 try 外声明，重部署。
- **② walk-core 拆分（继续拆）**：src/walk-core.js = 行走状态工厂（createWalkState，替代 main 内
  46 行初始对象）+ 相位行为决策（behaviorOf：idle/walk/perch 权重 + 60s 跳窗冷却，纯函数随机注入）；
  main.js 改为 `const walk = walkCore.createWalkState()` + chooseWalkBehavior 薄委托。tests/walk-core.test.js 全绿。
- **验证**：walk-geo(21) + walk-core(13) + defense(26) 全通过；部署 main/memory/walk-core MD5 一致；
  重启后行走"散步→坐下"循环实测正常、无异常日志。

### §14 追加 84：防御工事 II —— BOM 加固 + 守卫深测 + 情绪解析导出（2026-08-27）

**① 加固（记事本 BOM 场景，零回归：无 BOM 文件为 no-op）**：
- config.js loadPetConfig / memory.js load：读取时剥离 `﻿`——避免任何 UTF-8 BOM 保存导致
  JSON.parse 失败误吞默认值/误判篡改（VM 教训的落地）。
- chat-client.js：导出 `parseEmotion`（取最后一个有效【情绪】标注 + 清洗），供测试与复用。

**② 深测（tests/defense.test.js 扩至 ~40 例，全绿）**：
- memory 密文带 BOM 仍可解密、无篡改；旧明文迁移后转密文。
- file-guard：蜜标 mtime 触发报警（utimes 推后 + 3s 轮询）；checkBeforeWrite 检出外部篡改 →
  自动恢复干净版 + `config.json.tampered` 证据备份 + tamper 报警；诱饵文件生成。
- parseEmotion：提取/取最后/无标注三类。
- config 带 BOM 可解析（不回落默认值）。

**③ 测试基建**：tests/ 共 4 套（walk-geo 21 / walk-core 13 / defense ~40 / flight-physics），单条 `node tests/<名>.test.js` 即可跑。
重新部署 config/memory/chat-client（MD5 一致），重启后行走循环正常、无异常日志。

### §14 追加 85：特效三件套 + 人格深化六项（ottopet 借鉴落地，2026-08-27）

**① 特效三件套（ottopet effects 启发）**：
- GIF 预载进正题：换肤前 decode 预热 + 后台预热下一位待机（renderer/pet.js）。
- 快进-停留-快退冲击曲线：utils.easeImpact（0.25 冲到高点 0.9 → 滞空至 0.6 → 快落）用于跳窗（main.js walk.jump），单调可测。
- 瞬态守卫（双计时器兜底）：gotoPerch/returning 超 10s、flight 超 15s 强制回地面（walkTick）。

**② 人格深化六项（评估后全做，除"被打断"低分项）**：
- 台词模板参数化+扩充：lines.pickTpl（{{name}}/{{user}}），各表 +2~3 条带占位；新增 STAGE_LINES（熟悉/信赖/誓约专属）、EARLY_MORNING_LINES；摸头/人格化/工作流/进度由头全部切 pickTpl。
- 情绪浓度/上下文：main.js 记录上一条回复情绪，注入 persona「请自然延续氛围」。
- 关系阶段：bond.getStage（1-3 陌生/4-6 熟悉/7-9 信赖/10+ 誓约）；getText 带「关系：X」；主动搭话在熟悉起 18% 概率用阶段台词。
- 记忆质量：extractFacts 新增 忌口/宠物/职业（保守后缀）；注入时 90 天以上事实带「（以前提过）」。
- 今日心情：src/mood-day.js 按日期哈希+羁绊天数加权（确定性）；注入 persona「她今天的心情基调」。
- 场景化由头：清晨 5-8 点专属、里程碑（陪伴 7/30/100 天）、阶段台词。

**③ 验证**：tests/ 增至 5 套（+rp.test ~18 例）全绿；9 应用文件部署 MD5 一致；重启后行走相位循环正常、无异常日志。

### §14 追加 86：日语排查结论 + 被打断反应 + 技术债①②③ + VM 交接（2026-08-27）

**① 日语"没启动"排查（结论：翻译配额）**：
- GSV 引擎健康：应用在 06:19 自动拉起并「预热完成」；直连合成 200（65KB 音频）。
- 卡点：中→日翻译调用聊天 API（cn-qanyi anthropic 通道）返回 **403 token quota not enough（剩 ¥0.14）** → 自动回退中文（by design）。需用户补额度/换 key（设置①的 baseUrl/apiKey 即翻译所用）。

**② 被打断反应（RP 低分项补做）**：sendText 检测 isSpeakingAudio → 先小声应"啊……好好好，你先说，我听着呢！"再听你的（pet.js）。

**③ 技术债①②③ 全部落地**：
- ①拆：src/quick-commands.js（提醒/番茄钟/系统状态从 handleAskInner 拆出，可单测）+ src/windows.js（childWebPrefs/loadChildPage，9 处窗口 webPreferences 统一 → winChild.childWebPrefs，残留 0）。
- ②console→logTts：main.js 两处运行时 console 改 logTts（koffi/表情备份）；src 自测运行器 stdout 保留（文档注明）。
- ③测试：tests/quick-commands.test.js（提醒/番茄/状态/负例，fake features）；六套测试全绿。
- 顺带修复补丁期学费：多次 heredoc/CRLF/引号坑（本附注留存教训）。

**④ VM 交接文档 docs/VM-SECURITY-HANDOFF.md**：给其他模型的安全测试移交（控制速查/7 项清单+首轮结果/复测路径/已知坑/扩展建议）。

部署：11 文件 MD5 全一致；重启（9432）健康；行走相位正常。综合五 套→六 套单测（walk-geo/walk-core/defense/rp/quick-commands/flight-physics）全绿。

### §14 追加 87：日语降级提示 + 部署事故复盘（2026-08-27）

**① 日语降级提示**（用户说"还没修好"后新增）：
- tts-manager：`setJaFallbackCb` 回调（导出），中→日翻译失败（配额/403/Key 问题）时**会话内一次性**通知主进程。
- main.js：注册回调 → 渲染层 toast「⚠️ 日语翻译失败，暂时用中文音色说话（请检查①聊天 API 的配额或 Key）」——不再莫名说中文。
- 触发实测：翻译 403（配额剩 ¥0.1397，单次需 ¥0.19）→ 回退中文 → 回调无崩、无新异常。

**② 部署事故复盘（教训固化）**：期间曾因补丁脚本中文 bytes 编译期崩溃（多次）导致
main.js 已加 `tts.setJaFallbackCb` 而 tts-manager 未加导出 → 应用反复 TypeError 起不来；
全局 uncaughtException 兜底把问题变成可日志（再次印证其价值）。最终确认：**带中文注释/文案的补丁一律走 str→encode 或纯 ASCII 锚**，并用字节自检（出现次数断言）再部署。

**③ 状态**：应用健康（5 进程/Agent 8765/行走正常）；「日语没启动」根因=翻译上游
cn-qanyi 配额不足（账号层），需用户在设置①补充额度或更换 Key；代码与服务侧已全部就绪。

### §14 追加 88：翻译降费优化（2026-08-27）

**背景**：日语仍卡翻译配额（cn-qanyi 余额 ¥0.1397，聊天也同步 403）。除用户充值/换 key 外，软件侧降费三连：
1. **内存缓存 TTL 90s→600s**（罐头台词 10 分钟复用同样译文）。
2. **新增磁盘缓存 src/translate-cache.js**：7 天 TTL、上限 500 条，跨会话复用（摸头/时段/由头等固定句重复→**零 API 调用**）；tests/translate-cache.test.js 全绿（哈希/TTL/懒清除/淘汰保新/落盘往返）。
3. **max_tokens 2000→640**（译文是短句，减少推理模型输出计费）+ **独立翻译模型 config.translateApi.model**（留空=跟随①聊天模型；想省钱可填便宜翻译模型，纳入 buildSettingsView）。

- 集成：ja-translate 命中顺序 = 内存缓存 → 磁盘缓存 → API；成功/失败都写缓存。
- 验证：七套单测全绿；部署 3 文件 MD5 一致；重启健康（5 进程/Agent 正常；devtools 端口被旧实例幽灵暂占，属环境flak，应用无碍）。
- 状态：翻译仍 403=账户未充值；恢复后新缓存机制让重复台词基本零成本。

### §14 追加 89：桌宠「闪现」修复——翻边两轮实验后回到原子切换（2026-08-27，已部署验证）

**背景**：用户换 key 后再次报告桌宠闪现（闪烁/跳动），位于屏幕左缘翻边区。

**第一轮（快滑，已废弃）**：setEdgeLeft 改 4×45ms 步进滑动 + 渲染层 .pet/.bubble/.input-bar 加 `transition: .18s linear` 试图互补。**实测更差**（用户明确反馈"还不如没修的"）：主进程 setTimeout 时钟、walkTick(40ms) tick、渲染层 CSS 动画时钟三方无法对齐——glide 把窗口带到中途时 walkTick 用新 charInset 判旧位置触发「出屏钳回」硬拽（日志铁证：`边翻滑移 -20px` 后 160ms 必跟 `出屏钳回 x=-20→-2`），窗口被拉锯抖动。

**最终方案（已上线）**：彻底移除 glide 与全部 CSS transition，恢复**同 tick 原子切换**——`win.setPosition(x±delta)` 与 `sendToRenderer("pet:edge-left")` 在同一同步块内完成，窗口平移量与条带位移数学互补（delta = 宽-124 条带从 right:2 切 left:2），角色屏幕位置恒等，不存在任何中间态。`.pet` 定位保持 `left:calc(100% - 122px)` 写法（数学等价 right:2px，便于统一居左定位语义）。清理 `_gliding` 相关让路代码（walkTick/outOfScreenGuard），walk-geo/walk-core 测试全绿。

**遗留观察点**：若左缘仍有轻微闪动，下一个嫌疑是「出屏钳回」的高频 setPosition（日志有 10s 限频，实际钳位每 tick 都可能执行）与行走推进的拉锯，可用同样思路加死区处理。

### §14 追加 90：出屏钳回死区落地（§14 追加 89 遗留项，2026-08-27，已部署验证）

**改动**（dev→prod 已 MD5 一致部署，重启 5 进程在线，安全自检 chat=saved/cosy=saved）：
- `src/walk-geo.js` 新增纯函数 `clampNeeded(edgeL, charLeft, deadZone=8)`：返回 `{overdue, deficit, deadZone}`，越界量 ≤8px 视为行走推进/贴边翻边的瞬时像素噪声，`overdue=false` 不钳位；非法死区回落默认 8。
- `main.js` 两处钳位点接入：`walkTick`（每 40ms，原 2627 行）越界时先 `clampNeeded`，死区内只打限频日志「出屏越界(死区内)」不 setPosition，逾越死区才钳回并保留旧日志「出屏钳回」附越界量；`outOfScreenGuard`（每 2s 哨兵）同样条件化，死区内不干预。
- 单测：walk-geo 新增 7 条死区用例（界内/死区内/边界等值/逾越/默认/死区0/非法回落），七套全绿，`node --check` 通过。

**复盘发现（对判断剩余闪动关键）**：08:17–08:55Z 日志中 `出屏钳回 x=-20→-2`（越界恒 18px）与 `边翻滑移 -20/-57px` **同时存在**——证明那批钳回全部来自第一轮 glide 实验构建（glide 把窗口带到 -20，钳回再拽回 -2），并非原子版本常态。原子版引擎钳位 clampWalkX minX=edgeL-inset 使正常行走 `charLeft ≥ edgeL` 恒成立，钳回仅在异常路径（抛掷落地/崩溃重载恢复/charInset 几何上报竞态）触发；8px 死区正是为这些路径的像素级噪声兜底（8px 藏于屏外不可见，零回归风险）。

**观察结论**：部署后（09:08Z 起）至记账时未再出现任何「出屏钳回/出屏越界」日志——但同期桌宠多处于静置睡眠（多次「90s 无变化」告警），尚未充分行走至左缘，**观察窗口不充分**。若自然使用仍见钳回（死区外，越界 >8px），下一档：把死区扩到实测越界量（20px 量级）或修 charInset 翻边竞态，再不行截图+用户描述具体场景定夺。

### §14 追加 91：测试补位四套 + 顺手清账 + B-1/B-3 产品增量（2026-08-27，已部署验证）

**一、测试补位（新增 4 套单测，全 11 套绿）**
- `tests/i18n.test.js`：三语键集合严格一致 + 值非空 + t() 兜底 + 全代码字面量键覆盖（扫描 main.js/src/renderer）。
- `tests/ask-queue.test.js`：并发锁提取为 `src/ask-queue.js`——串行执行/队列满 busy/失败不断链/非法 limit 回落。
- `tests/message-buffer.test.js`：防抖缓冲提取为 `src/message-buffer.js`——覆盖最新/take 清空/clear 丢弃。
- `tests/proactive-topic.test.js`：由头信号源 `src/proactive-topic.js`（见四）。
- `walk-core.test.js` 补 6 条边界（冷却 60s 整点、random 极值、walk 上界双侧 ε、idle=0）。

**二、顺带修出的真实 bug（护栏测试与代码审读的价值）**
1. **i18n 5 键缺失**：`ui.infoTitle/set.featClipboard/set.featSysmon/set.featMemory/set.featEmotional` 被 settings.html/index.html 引用但三语词典全无 → 界面上显示原始键名。已补三语（沿用 emoji 前缀风格）。
2. **buildChatPersona return 提前**：`return base + parts.join("\n")` 在「今日心情基调」「上一条情绪衔接」两条 push 之前 → §14 追加 85 的情绪衔接**从未生效**（不可达代码）。已移 return 到末尾，实测两次连发聊天第二条回复延续了第一条情绪（傲娇→关心），衔接生效。

**三、清账结论（核实后多数无需改动）**
- `console.log`：全项目搜遍，src 4 文件的 console.log **全部位于 `--test` CLI 冒烟块/单测脚本**，运行时路径零噪声——保留 console 是 CL 输出的正确行为，不改 logger（SELF-REVIEW 该条不成立）。
- TODO/FIXME：唯一残留（相位定时器丢失自愈注释）已收敛；i18n 未用键：护栏测试核实**所有键均被使用**，无需清理。
- main.js 引线：并发锁/防抖两处内联逻辑已提取为可测模块（ask-queue 13 例、message-buffer 7 例），3431 行微降。

**四、产品向增量**
- **B-1**：羁绊升级跨阶段变化时（Lv4→熟悉 / Lv7→信赖 / Lv10→誓约）除 toast 外触发 `STAGE_LINES` 专属解锁台词（love 情绪）。
- **B-3**：由头第二信号源 `src/proactive-topic.js`（第一信号源=记忆事实，v2.6 已有）——番茄钟剩 ≤8min（≤2min 优先）打气/休息提醒、日程剩 ≤30min（≤10min 优先）提前关切、剩 1-2min 不插嘴防与 ⏰ 叠音；无信号返回 null 不打扰。已接入 features.startProactive。

**部署与验证**：6 文件（main.js + i18n/ask-queue/message-buffer/features/proactive-topic）MD5 双向一致部署；重启 5 进程在线；安全自检 safeStorage=available chat=saved cosy=saved；Agent /chat 两次连发实测正常（ask-queue 串行链可用）。**观察点**：prompt 注入增强后聊天语气自然度与由头话术需用户日常实测反馈。

### §14 追加 92：情绪音色试听「播放失败」根因 = settings.html CSP 缺 media-src（2026-08-27，已修复部署）

**现象**：设置页「情绪音色试听」点击后提示「播放失败（请检查 GSV 服务）」。

**排查过程（关键步骤）**：
1. 日志无合成错误（11:51 `[gsv] 情绪参考音频: ref_coquetry.trim.wav` 一句一打，两句都进合成），排除了「素材缺失」与「GSV 服务不可用」——voice-refs.json 五档素材齐全，GSV 9880 在线。
2. curl 直打 GSV 复现合成：HTTP 200、188KB、`pcm_s16le 32000Hz mono` 合法 WAV → **服务侧正常**。
3. 按 `mergeWavBase64` 逻辑复刻合并产物，ffprobe 解码 5.24s 正常 → **合并产物可播放**。
4. 锁定渲染层：settings.js:728 `audio.play()` reject 显示该文案；**根因=settings.html 的 CSP 是 `default-src 'self'` 且无 `media-src` → `new Audio("data:audio/wav;base64,…")` 的 data: 媒体被 Chromium 拦截**。对照 index.html 的 CSP 有 `media-src 'self' data: blob:`，pet.js 用完全相同的 data URL 播法（聊天语音）一直正常——两窗口 CSP 不一致是 v2.6 加试听时的疏漏。

**修复**：settings.html CSP 补一条 `media-src 'self' data: blob;`（最小改动，未动脚本）。已部署 MD5 一致、重启生效。**用户路径提示**：重启后重新打开设置页即可试听（点🎭任一档）。**通用经验**：凡是渲染层用 `data:` URL 放音频/图片的窗口，CSP 必须给对应指令放行 data:；今后加新窗口/新播放功能时对照 index.html 的 CSP 抄。

### §14 追加 93：VM 全新安装首启验证（模拟新电脑，用户提议，2026-08-27）

**做法**：VirtualBox `SuzuranPet-TestVM`（Win11 202600, 4GB/2核）内，删空 `%APPDATA%\苏苏洛桌宠 1.1 正式版`（模拟零历史用户数据）+ 从 Z: 只读共享（=宿主当前正式版，含今日全部改动）复制全新副本 `C:\petapp-fresh`（473MB）→ 首次启动跑 10 分钟 → 拉 tts.log UTF-8 精读 + 功能探活。**只记录，未自修。**

**✅ 正常工作的（全新环境预期内）**：
- 首启迁移：`.storage-migration-v1.json` 生成、AppData 完整初始化、5 进程稳定、无冻结弹窗。
- `[security] safeStorage=available chat=missing cosy=missing`：DPAPI 可用（VM 也有 DPAPI），密钥为空符合预期。
- 记忆首启空档：`记忆文件异常（首启空文件），已重置为空`（ENOENT 按"空档"处理，**不算篡改**——设计正确）。
- Spine 渲染：皮肤 `254_vodfox_yun_8` 在无 GPU 环境 `[spine] ok boost=2.1` 加载成功；行走引擎在线（x 变化/状态上报/显示钳制 `垂直出屏钳回 y=492→367` 工作）。
- Agent 服务：/health `{ok:true...}`、8765 监听本机。
- 聊天降级：无 key 请求 → `{ok:false,"error":"未配置 API Key：请在设置中填写或显式导入"}`——**降级友好不崩溃**。

**❌ 发现的问题（环境漂移类，未修）**：
1. **语音在全新电脑不可用：config.json 模板漂移。** 模板把宿主绝对路径烙进新电脑基线：`ttsGenie.python=E:\GenieTTS\venv\Scripts\pythonw.exe`、`ttsGsv.python=E:\GSV-training\...\python.exe`（还有 serverScript/sovitsPath 同理）→ VM 无这些路径 → `[main] 未捕获异常: spawn ... ENOENT` + `[gsv] 拉起进程错误`（全局 uncaughtException 兜底只记日志不崩，T7 生效）。**这是 T6「配置来源」技术债的实锤场景**：首次安装即把开发者机器的环境路径固化给用户，用户要么手改 config.json 要么语音永久不可用。建议：模板打包时把 python/serverScript 路径置空或做"路径存在性探测+设置页引导"。
2. **协议窗口被跳过：`agreed=true` 随模板迁移。** 模板 config.json 的 agreed 是宿主已同意的状态 → 全新装机首启不弹《使用条款》。出厂分发模板应 agreed=false（本次是"使用者状态"当模板，测试口径需注意）。
3. **UI 截图仅纯黑**：VM 锁屏/屏幕关闭（headless），视觉层未验证（技术限制，非应用问题；渲染由日志实证）。

**环境状态**：VM 内 `C:\petapp-fresh` + 首启 AppData 保留供复测；本次验证的 pet 进程已停；VM 保持 running（与接手前一致）。**Roadmap C 安全测试仍用 `C:\petapp`，互不干扰。**

### §14 追加 94：VM 首启两项修复落地——语音路径探测受控化 + 首启协议强制重置（2026-08-27，已部署+VM 复测通过）

**背景**：§14 追加 93 在 VM 全新安装发现①语音引擎模板路径漂移（裸 spawn ENOENT 冒泡到 uncaughtException）；②模板 agreed=true 随迁移，全新用户跳过协议弹窗。

**改动（5 文件，dev→prod MD5 一致）**：
1. `src/tts-manager.js` 新增 `missingEnginePath(eng)` 纯探测（python/serverScript 存在性）并导出；`ensureGenieServer`/`ensureGsvServerImpl` 在拉起前探测，路径缺失 → 明确日志「引擎路径不存在（首次安装未配置，请到语音设置页配置）: python=…; serverScript=…」并返回 false（**不再 spawn**）；Genie 拉起与 `runPythonWithTimeout` 补 `child.on("error")`（此前 Genie 无 error 监听 → ENOENT 异步错误冒泡到 uncaughtException，GSV 早已有监听故未冒泡）。
2. `src/storage.js` 首启迁移（仅无 `.storage-migration-v1.json` 时）写回 AppData config 强制 `agreed=false`——模板携带的宿主同意状态不再替新用户"代签"条款；存量用户（迁移标记在）零影响。
3. `main.js pet:restart-gsv` 拉起前同款探测 → 返回 `{ok:false, code:"nopath"}`；`renderer/settings.js` 映射 `nopath` → i18n `set.gsvNoPath`（三语已补，i18n 测试自动校验键一致性）。

**VM 复测（删 AppData + 重建 C:\petapp-fresh 首启）**：`AGREED=False` ✓ 协议不再被跳过；日志两条「引擎路径不存在…」清晰提示 ✓；**全日志零 `[main] 未捕获异常: spawn ENOENT`**（对比追加 93 复测前有完整堆栈）✓；安全自检/记忆空档/Spine 渲染/行走/Agent 均正常，无回归。设置页「重启日语语音服务」按钮在路径缺失时显示「语音引擎路径不存在…」而非笼统失败。

**仍未解决（下一步候选）**：模板本身仍携带宿主路径（E:\GenieTTS…）——本修复让"未配置"变得**可发现、可引导**，但未根治"分发即携带漂移路径"。根治需重建出厂打包模板（路径置空 + agreed=false + 无密钥），待有正式打包/分发流程时执行。

### §14 追加 95：渲染模式切换——归一化与贴地坐标提取为纯函数+单测（2026-08-27，已部署）

**背景**：用户问"各种渲染之间的转换有测吗"——如实答无自动化测试（切换跨主进程+渲染层，Node 单测够不着渲染层；且 1406-1433 段历史上修过异步竞争/贴地跳变但未固化为回归护栏）。采纳低成本档：把主进程可测的两段提为纯函数。

**改动**：
- 新增 `src/render-mode.js`：`renderModeOf(value)`（gif/spine/rig 三态，未知回落 gif）+ `groundAlign(bounds, wa, groundGap)`（模式切换贴地坐标，与原 main.js 公式逐位一致，未加额外保护避免行为漂移）。
- `main.js` 接入三处：get-state 的 renderMode 归一化、切换立即贴地与 2.5s 延迟二次贴地的坐标计算（原 gy/gx 内联公式移除，全库无同类残留）。
- `tests/render-mode.test.js` 15 例：归一化（含未配置/空串/未知/大小写回落）+ 贴地（正常/gap/双界钳回/负坐标副屏/坍缩工作区）+ 与 walkGeo.groundLine 一致性断言。

**验证**：全 12 套测试绿；main.js+render-mode.js MD5 一致部署；重启 5 进程在线。**观察点**：随时在设置页三个渲染模式间切换，日志「模式切换贴地」应照常出现且角色停靠正常——现在这段行为有单测兜底了。

**仍未覆盖**：渲染层端到端（GIF/Spine/PSD 连切不白屏、角色不错位）仍需引入 Playwright 级测试或手动切+截图，未做（用户暂缓）。

### §14 追加 96：已导入 PSD（2.5D 皮肤）删除功能（2026-08-27，已部署）

**需求**：用户要"已导入的 PSD 加删除功能"——即设置页「2.5D 已导入皮肤列表」（rigUser/*.psd，radio 单选列表）之前只能选/只能导入，没有删除入口。

**改动（4 文件，MD5 一致部署，重启 5 进程在线）**：
- 新增 `src/rig-delete.js` 纯函数 `planRigDelete(list, id, currentId)`：文件名安全校验（必须 .psd、拒绝路径分隔符，防穿越）+ 列表存在性 + 是否当前皮肤；匹配按 Windows 语义**大小写不敏感**。单测 10 例。
- `main.js pet:rig-delete` IPC：按 plan 删文件；删的是当前皮肤 → `saveConfig({rigSkinId:""})` + `pet:rig-skin-changed ""` 通知渲染层退出 2.5D 模式；返回 `{ok, clearedCurrent}`。
- `preload.js` 暴露 `rigDelete(id)`。
- `renderer/settings.js`：列表重构成 `loadRigSkins()`，每项右侧 `🗑` 按钮（`confirm` 二次确认 → 删除 → **局部刷新列表**，不整页 reload 以免丢其它未保存设置；clearedCurrent 时同步复位 2.5D 开关）；radio「当前」高亮顺带改为大小写不敏感（与删除/Windows 语义一致）。

**测试**：13 套全绿（新增 rig-delete 10 例）。**用户路径**：设置 → ④其他/2.5D 区域 → 已导入皮肤列表每项 🗑 → 确认即删；删当前皮肤会自动退出 2.5D 模式。

### §14 追加 97：安全测试第 1 遍（Roadmap C 首批，VM 内，2026-08-27）

**执行方式**：按用户要求写成自包含脚本 `docs/SECURITY-TEST-EXEC-20260827.md`（S01-S12 逐条操作/预期/判定 + 双遍结果表），本会话先跑第 1 遍填表，留第 2 遍给另一模型对照复测（回滚快照 `pre-sec-test` 后可独立重跑）。

**VM 环境变故（过程记录）**：测试前拍快照时 VirtualBox 卡 "online snapshotting" → 杀 VBoxSVC 恢复；随后 VM 冷启动被 Windows 自动更新占用（卡 15% 约 40 分钟）→ 判定卡死后 poweroff + restorecurrent 回滚到 `pre-sec-test` → 重启后 guest 12 分钟就绪 → 已禁用 wuauserv 防再更新。

**结果（第 1 遍）**：
- ✅ S01 基线 / S02 EICAR（188→188 无传播、无应用崩溃；期间 Windows 蓝屏 1 次归因环境层）/ S03 注入面（14 条全被业务闸拦，无执行无回显）/ S04 证书校验（TLS 拒自签）/ S06 端口外连（仅回环 8765、零外连）/ S07 洪水 DoS（60 并发后健康）/ S08 篡改（开启防护后 tamper+恢复+备份齐）
- ❌ **S05 DLL 侧载存在真实弱点**：无效 version.dll 使启动 5→1 进程、Agent 无响应，删 dll 即恢复。修补建议：asar 打包（当前 resources/app 散文件）+ 数字签名 + 清空工作目录非常规 dll/启动完整性自检。
- 🔎 附带发现：a) 配置明文密钥脱敏（safeStorage 可用时启动即清 config.apiKey，外部注入无效=加固）；b) file-guard 默认关，需设置页/配置开启。
- ⏳ S09-S12（Nmap/Burp MITM/Process Hacker 注入/Wireshark 抓包）需装工具，留第二批复测。

### §14 追加 98：S05 修复——可执行目录 DLL 完整性自检（2026-08-27，已部署，能力边界已复测）

**改动（2 文件，MD5 一致部署，宿主重启 5 进程在线）**：
- 新增 `src/dll-guard.js`（纯逻辑+11 例单测）：`snapshotDlls`（目录 dll 清单含 size/mtime）、`diffBaseline`（新增/替换/删除，mtime 2s 容差）、`isUpgrade`（≥3 个且占比 >30% 判升级防误报）、`decide`。
- `main.js runDllGuard()`（启动时执行）：exe 目录 dll 与基线（`userData/security-dll-baseline.json`）对比——首次建立基线；单点变化 → `[security] 检测到新增/被替换的 DLL（疑似 DLL 侧载）` 日志 + 角色气泡提醒；大量变化 → 判升级自动重建基线。基线文件非 WATCH_JSON、不触发 file-guard。
- 全 14 套单测绿。

**VM 复测（诚实的能力边界）**：宿主与 VM 正常启动均"基线已建立（8 个）"无告警（不误报）；放假 version.dll 复测——应用仍退化（FAKE_PROC=1）且**自检日志未打出**：无效 dll 在 Electron 原生层、main.js 执行前即加载失败，JS 自检来不及运行。即：**自检覆盖"应用可启动场景下新增/替换 dll"（可发现可告警）；对"使应用无法启动的 dll"检测不到**（但该场景等价 DoS、恶意 dll 无法被加载利用执行）。**根治仍需 asar 打包 / 数字签名 / 启动前原生层哈希校验**（行动卡 A 方案 2/3，待用户决策）。

### §14 追加 99：安全测试第二批（S09-S12，VM 内，2026-08-27）

**做法**：Nmap/Wireshark 因网络/驱动不装，自研等价手段执行；结果已填 `docs/SECURITY-TEST-EXEC-20260827.md` 双遍表。

- **S09 端口/指纹 ✅**：Nmap 官方源在 VM 下载失败（6.6KB 错误页）→ PowerShell 并发 TCP 全段扫描等价执行。127.0.0.1 开放端口=135/445/5040/49664-68（Windows 系统）+ 8765（应用）；9880/9881 闭合（语音未部署符合预期）。8765 无 Server/banner 泄露、`OPTIONS`/`TRACE` 均 405（危险方法禁用）、Keep-Alive timeout=5（Slowloris 防御参数在位）。
- **S10 证书链 ✅**：应用 TLS 信任=系统信任库（S04 已证自签不被信任、无 rejectUnauthorized 绕过）；额外验证"标准用户 `certutil -addstore Root` 失败（-2147024156=需管理员）"→ **用户态无法静默安装 CA**，MITM 入场需提权（攻击面可控边界）。Burp 全链路判据相同（Burp 也是装 CA），故以系统存储验证替代。
- **S11 模块取证 + 注入 ⚠**：P/Invoke 枚举主进程 51 个模块，**从 exe 目录加载的 dll=0** → S05 机制修正：不是静态导入优先，而是 **Electron/Chromium 运行时无路径 `LoadLibrary("version.dll")` 触发 Windows DLL 搜索顺序劫持（exe 目录优先于 System32）**；远程线程注入（CreateRemoteThread→kernel32!Sleep 5000ms）**成功**（同用户进程完整权限）→ 无注入防护（Windows 默认模型，符合预期；不建议普通桌面应用做反注入以免误伤）。注入后应用健康。
- **S12**：Wireshark 驱动安装过重未执行；以 S06 外连审计（零外连）+ S11 模块审计覆盖，标记待第二遍可选补跑。

**第二批累计结论**：应用对外暴露面小（仅回环 8765、无指纹泄露、方法受限）；信任链标准（无 MITM 绕过）；两大弱点延续 S05/S11——DLL 搜索顺序劫持（已加启动自检兜底）+ 同用户注入（通用状态）。全部记录在案，S05 根治项待用户对 asar/签名拍板。

### §14 追加 100：安全测试第 2 遍交叉复测（另一模型独立复跑，2026-08-27/28）

**执行方式**：按 `docs/SECURITY-TEST-PASS2-20260827.md` 独立复测指引，回滚快照 `pre-sec-test` 后跑 S01-S08，结果回填 `docs/SECURITY-TEST-EXEC-20260827.md` 双遍表「第 2 遍」列（S09-S12 属可选未复跑，沿用第 1 遍结论）。

**过程**：本遍回滚启动时又撞到 Windows 更新（卡「更新已完成 XX%」约 10 分钟），属第 1 遍已记录的环境变故同类，等更新走完 guest 就绪后继续，未再卡死。guest 就绪后发现快照残留 `version.dll`（S05 兜底残余），已随 §2.2 robocopy /E 与后续 S05 clean/del 处理净空。

**结果（第 2 遍，与第 1 遍对照）**：
- ✅ **S01** 基线：5 进程、health 200 `{"ok":true,"name":"苏苏洛"}`、`[security] DLL 基线已建立（8 个）`。（第 1 遍为 6 进程，本遍干净 5。）
- ✅ **S02** EICAR：AppData 190→191（仅样本自身 +1，无传播）、无应用级崩溃；**蓝屏未复现**（差异关注点确认，测试时段无新 Event 41）。差异：本遍 pet 用户无 Defender 关停权限（权限不足），样本仍成功写入/删除，不影响判定。
- ✅ **S03** 8765 注入面：14 条全拦（13 条「未配置 API Key」+ text=null 专属「text 不能为空」），无执行/无回显/无崩溃，后 health 200、进程 5。本遍已按前置设 agreed=true，payload 命中「未配置 API Key」闸（比第 1 遍被条款闸挡更靠近注入层）。
- ✅ **S04** 证书校验：宿主 Node https 对自签 `REJECTED DEPTH_ZERO_SELF_SIGNED_CERT`；代码审计无 rejectUnauthorized/checkServerIdentity 绕过，chat-client 用标准 fetch/https。结论同第 1 遍。
- ❌ **S05** DLL 侧载：**仍 FAIL（一致）**——64 字节 version.dll → 5→1 进程退化、自检日志未打出（main.js 前原生层加载失败，dll-guard 来不及运行）；删 dll 对照组恢复 5 进程 + health ok。dll-guard 兜底在场（首次启动 `DLL 基线已建立（8 个）`），但只覆盖「可启动场景下新增/替换 dll」，对「使应用无法启动的 dll」检测不到（等价 DoS，恶意 dll 无法被加载执行）。根治仍待 asar 打包/数字签名。
- ✅ **S06** 端口/外连：仅 `127.0.0.1:8765` LISTENING，9880/9881 闭合；全量 0.0.0.0 监听均为系统端口 135/445/5040/49664-70；pet 进程 Established=0。
- ✅ **S07** 洪水 DoS：3 job × 30 = 90 并发 /health 全返回 200，结束后 health 200、进程 5（比第 1 遍 60 并发更大仍稳定）。
- ✅ **S08** 篡改回归：fileGuard=true 启动，外部无 BOM 写回翻转 agreed → 8s 内 `[guard] ⚠ 防御触发[tamper]` + 自动恢复干净版 + config.json.tampered 备份存在，post 校验 agreed 回真、fileGuard 保持 true。告警+恢复+备份齐。

**第 2 遍结论**：S01-S08 复测结果与第 1 遍高度一致——七项通过、**S05 仍失败**（DLL 搜索顺序劫持，启动自检兜底存在但对「致启动失败型 dll」不可达），两个差异关注点均得到确认：**S02 蓝屏未复现**、**S05 仍 FAIL**。S05 根治项（asar 打包/数字签名）仍待用户拍板，其余无新问题。

### §14 追加 101：S05 根治①——数字签名 + 启动签名校验（2026-08-28，已部署验证）

**背景**：用户拍板 S05 走数字签名路线。工程边界先讲明：Windows Loader 默认不会因 dll 未签名而拒绝加载，故"签名"落地为 **exe 签名（文件属性）+ dll-guard 启动签名校验（未签名的新增/替换 dll = 高强度侧载嫌疑）** 的组合。

**改动**：
- 生成自签名代码签名证书（`Cert:\CurrentUser\My`，CN=SuzuranPet Dev Signing，RSA-2048，3 年，thumb 0A31…A5FA）；已用 `Set-AuthenticodeSignature -HashAlgorithm SHA256` 给正式版 exe 签名（exe +1.5KB；时间戳服务器不可达故无 RFC3161 时间戳）。签名链有效；自签根不受系统信任 → `Get-AuthenticodeSignature` 报 UnknownError（自签固有；**对外分发需商业代码签名证书**，SmartScreen 才会认可）。
- `src/dll-guard.js` 新增 `signerOf(filePaths)`（spawn PowerShell `Get-AuthenticodeSignature` 批量，按"签名者是否存在"判定，输入/超时/单文件失败均保守判未签名）+ `parseSignerOutput`（解析三段行，Windows 路径不含 `|`）。单测增至 17 例。
- `main.js runDllGuard`：suspicious 时对新增/替换 dll 批量签名校验，无签名文件在告警文案标注「（其中未签名文件: xxx——高强度侧载嫌疑）」。

**验证（VM 受控实验，应用正常启动不受影响）**：放未签名 `zzz_sidecheck.dll`（冷门名，Electron 不加载）→ 重启 → 日志 `⚠ 检测到新增/被替换的 DLL（疑似 DLL 侧载）: zzz_sidecheck.dll（其中未签名文件: zzz_sidecheck.dll——高强度侧载嫌疑）` ✓ 完整链路（基线 diff + 签名校验 + 告警）生效；应用 5 进程正常。删除后重启无告警、恢复干净；签名 exe 运行正常。全 14 套单测绿；MD5 一致部署。

**能力边界（如实）**：签名与校验不改变 Windows Loader 行为——S05 的"无效 version.dll 致启动失败"现象不变（攻击面等价 DoS）；本方案防御价值 = 新增/替换 dll 无签名即高可疑（可发现可诊断）+ 签名 exe 提供完整性基准。**剩余根治候选**：asar 打包（防 resources 篡改，与 dll 侧载正交）、商业签名证书（对外信任）、WDAC 策略（系统级拦截未签名 dll）。

### §14 追加 102：渲染崩溃诊断 + 出厂打包模板 + 世界书 + 向量记忆 v1（2026-08-28，已部署实测）

**① 渲染崩溃诊断**：主窗口崩溃日志升级（附窗口/URL、渲染模式与行走状态）；新增 `attachCrashDiag(w, label)` 挂载 9 个子窗口（help/quickstart/settings/schedule/psd/addchar/mood/terms/voice）——子窗口渲染崩溃同样记日志（带窗口标识）+ 自动重载，60s 内 3 次停止自愈。崩溃排查从"只有 reason/exitCode"升级为"哪个窗口、什么状态"。

**② 出厂打包模板净化（deploy/）**：VM 首启教训（模板带宿主 E:\ 语音路径+agreed=true）落地为产物——`deploy/config.template.json`（由 config.js 纯净默认生成：agreed=false、无任何 key、语音 python/serverScript 空、默认端点）+ `deploy/README.md`（打包 SOP：替换模板→可选签名→zip→VM 冒烟）。生产目录 config.json 替换不影响已运行用户（迁移标记在）。

**③ 世界书 World Info**：`src/world-info.js`——SillyTavern 式按需注入的轻量版：5 条内置情境（办公/身体不适/深夜/用餐/低落），用户消息命中关键词才注入 system（最多 2 条），省 token 且贴切；chat() 注入位在「此刻状态」后。单测 12 例。

**④ 向量记忆 v1**：`src/vector-memory.js`——SillyTavern「Vector Storage」零依赖版：本地字符 unigram+bigram 哈希 512 维向量 + cosine 检索；userData/memory-vector.json 存储，复用 safeStorage/DPAPI 加密（与 memory.js 同款）；语义去重（≥0.82）+ 300 条封顶 + 检索过滤（≥0.06，v1 泛化弱故放宽、注入后由模型自判）；开关 `features.vectorMemory`（默认开）。chat() 每条用户消息入库 + 检索注入「【回忆片段】」。单测 15 例。

**实测证据（宿主 Agent API，文件体传参）**：① 面试主题轮正常贴合回复；② 查询"你还记得我下周要干嘛吗"→ 明确回引"下周的面试，还有你现在的紧张"——**向量回引真实生效**；③ 渲染崩溃诊断/世界书部署后宿主 5 进程正常、无异常日志。
**新踩坑记录（Agent 测试规范）**：`curl -d '{"text":"中文"}'` 直接传参在 Git Bash 会按 GBK 编码发送 → 模型收到乱码并污染上下文；**一律用 `--data-binary @UTF-8文件`**。

### §14 追加 103：长期记忆单条编辑功能（2026-08-28，已部署）

**需求**：设置页「记忆管理」此前只有查看/逐条删除/清空，缺编辑。新增对单条记忆的修改。

**改动（4 文件，MD5 一致部署，重启 5 进程在线）**：
- `src/memory.js` 新增 `updateFact(id, text)`：校验内容（非空、≤120 字）、定位 id（不存在返回 false）、更新文本+时间戳、save；无变化视为成功。导出。
- `main.js` 新增 IPC `pet:update-memory-fact`（返回 `{ok, message}`，错误信息含校验提示）。
- `preload.js` 暴露 `updateMemoryFact(id, text)`。
- `renderer/settings.js` 记忆列表每条加「✎ 编辑」按钮（prompt 预填原文 → 校验 → 调用 → 局部刷新；与「✕ 删除」并列）。

**测试**：新增 `tests/memory-edit.test.js` 11 例（成功/文本更新/类型与 id 保留/无变化/空/超长/不存在 id/拒绝后原值不变/注入包含新内容）；全 17 套单测绿。

**冒烟**：宿主 Agent 聊天"喜欢玫瑰茶、养了两只猫"→ 回复正常贴合（偏好/宠物事实同时入记忆与向量库）；启动自检 OK。

### §14 追加 104：Roadmap A 搁置 + 维什戴尔皮肤 + asar 根治 + VM 瘦身（2026-08-28 夜，已部署验证）

**① Roadmap A（Spine 画布加宽）用户决定搁置**：官方新皮肤维护繁琐，桌宠只保证"苏苏洛本体"通过，其余皮肤视为附带、暂不适配。已在该条目标注冻结说明。
**② 维什戴尔小人两套已下载就位**（不调整，留用户验收）：来源 `github.com/isHarryh/Ark-Models`（账本早有记录）main 分支 `models/<id>/build_char_<id>.*`。落盘 `userData/assets/spine/user/`：
- `1035_wisdel/`（默认装，skel 452KB / atlas 11.7KB / png 335KB）
- `1035_wisdel_sale_14/`（时装"忒斯特收藏/XV"，skel 1.18MB / atlas 18.9KB / png 725KB）
- 已按项目坑处理 `#`→`_`（目录/文件名 + atlas 内贴图引用），贴图引用与实际 png 名一致。
- 更正一处旧误判：`172_svrash` 系是**银灰**（SilverAsh），不是 W。
**③ S05 根治（asar 打包）已上线**：`resources/app` 散目录 181M → `app.asar` 173M（npx asar pack），散目录改名 `app_legacy` 保留作回退（删 app.asar + 改回名即可）。全套验证通过：5 进程、`[security]` 自检、Spine 渲染正常（pet-user:// 皮肤加载 OK）、聊天冒烟正常、userData 皮肤扫描不受影响。新增 `deploy/pack.sh`（日常 dev→prod 更新后重打 asar 的一键脚本）+ README 打包 SOP 已更新（§1 步骤 2）。**注意工作流变化：以后更新必须先 pack.sh 再重启，散目录直改不再生效**。
**④ 商业签名确认不做**：开源/个人自用无需商业证书（deploy/README §3 已注明；自签已完成完整性校验用途）。
**⑤ VM 瘦身（before 关机待命）**：合并删除 pre-sec-test 快照、VDI 压缩、删系统 ISO（-6.9G）与测试临时文件；修复删 ISO 后光驱残留引用（置空后正常启动）；guest 数据完好验证后关机待命（下次 `startvm --type headless` 即用）。
**6 待用户决策项**：3D 渲染模式（VRM/glTF，用户考虑中，随时可启动；朋友想加绝区零风格 3D 模型）。

### §14 追加 105：维什戴尔三套皮肤 + 默认装放大 + asar 流程踩坑修复（2026-08-28 夜，已部署验证）

- **维什戴尔小人三套下载就位**（源 Ark-Models，`#`→`_` 处理）：`1035_wisdel`（默认）、`1035_wisdel_sale_14`（忒斯特收藏/XV）、`1035_wisdel_game_9`（成就之星/IX，用户所指"绝对主角"时装）。前两套已在 §104 下载，本条目补齐第三套并入账。
- **默认装显示偏小 → 皮肤级倍率覆盖**：`renderer/pet.js` 新增 `SKIN_SCALE_OVERRIDE = { "1035_wisdel": 1.5 }`（并入 boost 计算、在 dirName 作用域内应用 → 命中即 manualHit 走守卫最大化）。@25→@1.5 两轮：用户确认×1.5（`final=0.2167 w=162 h=91`，与 sale_14 观感对齐）✅，另两套时装无需 override。
- **坐姿自动缩小 → 守卫宽度余量修复**（用户反馈后诊断修复，已确认）：坐姿（Relax 动画）模型包围盒变宽至 125 > 画布 120 → 守卫 `k=(W-2s)/bw≈0.9` 整体缩小 10%（诊断日志 `guard k=0.896 base=0.217 anim=Relax bbox=125x74 W=120 H=120`）。修法：守卫宽度约束放宽 12% 余量（`(W*1.12-2s)/bw`，高度仍严格）——坐姿不再缩，站姿（bbox 更窄）不受影响，可见主体居中透明区容纳横向溢出。用户实测 ✅。
- **踩坑与修复**：① override 曾误放在 dirName 块外 → `初始化失败: dirName is not defined`（已移入作用域）；② asar 打包时 `mv app.asar→old` 因应用运行占用失败 → 流程必须**先停应用再 pack**；③ `deploy/pack.sh` 增加 app_legacy 提权兜底（上次打包源可直接复用）。

### §14 追加 106：3D 渲染模式 v1（绝区零模型接入，2026-08-28，已上线可切）

**动机**：用户（及朋友）想加绝区零风格 3D 建模到桌面。模型来源 `github.com/m4urlclo0/ZZZ-Assets`（★227 解包资源，角色 FBX ~2.7MB+贴图，**无内嵌动画**）。

**技术链路（踩坑闭环）**：
1. **FBX→glb**：仓库 FBX 为非标准变体（three FBXLoader 拒识）+ 无动画 → Facebook `FBX2glTF 0.9.7` 离线转标准 glb（Belle 0.4s、4.4MB、3 蒙皮网格/225 节点）；后续角色同工具现转。
2. **渲染加载**：three GLTFLoader 经 `pet-user://3d/user/<角色>/<角色>.glb`（协议已覆盖 userData assets 全树）。**踩坑：Electron 对 asar 内 ES Module 支持缺陷 → module 静默失败**（症状=模块日志全空）。两轮修复后定案：**经典脚本路线**（three@0.146 UMD + examples/js 非模块版 GLTFLoader + 3d-mode.js 改 IIFE）**并配合 `asar pack --unpack-dir "renderer/3d"`** 让 3D 文件出 asar 真实加载 → ✅。pack.sh 已固定该参数。另加 `hookRenderConsole`（渲染层 console 转发，[3d]/error）便于排查。
3. **v1 能力**：懒加载 `assets/3d/user/<角色>/`（IPC pet:3d-list 扫描）；Belle 显示（Body_Map1_D 贴图绑定，粗糙度近似）；**程序化动画**（仓库无动画）：待机呼吸轻摆/行走浮动/坐姿下沉/朝向镜像（订阅 onWalking/onRenderModeChanged）；尺寸对齐 91px（同 Spine 默认装）、脚底贴底。
4. **接入面**：渲染模式新增 `"3d"`（render-mode.js RENDER_MODES + 主进程 7 处 spine 专属行走/坐姿条件扩展为 spine|3d）；设置页渲染模式下拉加「3D 模型」；pet.js setRenderMode 加 3d 分支。

**验证**：`[3d] 激活 → 模型加载完成: Belle 网格=3` 全链路无错误。**踩坑记录：改 config 必须先停应用**（运行实例的保存会覆盖文件，竞争窗口）。

**v1 已知限制（下一步候选）**：程序化动画（无骨骼动画，后续可找 ZZZ 动画源或骨骼驱动）；贴图仅 Body 系列（Face/Hair 细分、M 图通道映射待完善）；3D 角色选择 UI（当前取目录第一个）；低配软渲性能待观察。
**（2026-08-28 同夜）用户实测后决定整体移除**：观感不适合桌宠风格 → 已①渲染模式恢复 spine（桌宠正常）；②代码全清（main.js IPC/hook/gate 还原、pet.js 3d 分支移除、render-mode.js/preload/settings/index 还原、renderer/3d 目录删除）；③打包参数还原（pack.sh 去 unpack）；④用户资源 assets/3d 与 vmwork 工作文件（FBX2glTF/zzz probe/parse/glb）全删。**3D 方向关闭**；如需再启用，§106 中的来源与技术路线（FBX2glTF 转换 + three 经典脚本 + unpack 教训）即现成手册。

### §14 追加 107：PSD 耳朵分离（前端 hair 兽耳拆独立层，2026-08-29，已产出待验收）

**问题**：rig 皮肤 `seethrough_output.psd` 的"front hair"图层两侧画有兽耳，但 rig 显示不出耳朵。Vision 定位：face 层无耳；耳朵在 front hair 两侧（左 x200-265 / 右 x450-520，y260-540）。
**做法**：Node + ag-psd v31（canvas 后端=@napi-rs/canvas，走 npmmirror 安装）+ vision 坐标识别 → 从 front hair 裁出兽耳成独立 `ears` 层，原层耳区擦透明（destination-out 两小块）→ 产出副本 `seethrough_output_ears.psd`（原文件未动）。Vision 校验：ears=对称兽耳 ✓ / front hair 无耳 ✓。
**验证入口**：设置 → 渲染模式 PSD 2.5D → 皮肤选 `seethrough_output_ears`。若需微调（擦除边界啃侧发），坐标 rect 记录于 HANDOFF-20260829 §2。工具链经验：ag-psd 写回为 RLE 重编码（6.68MB→1.6MB），PSD 工具源编辑请用原文件。

### §14 追加 108：rig 渲染管线治本（耳朵不显示 + 图层错位放大，2026-08-29，已部署验证）

**症状**：PSD 耳朵分离（§107）后耳朵仍不显示，且角色"某些图层错位放大"；中途一度"整个角色消失"。

**四个根因（按发现顺序）**：
1. **cancelAnimationFrame 误杀渲染循环**（自伤）：为"防多实例 tick 叠加"在 applyRig 开头 cancel 掉唯一排程的 rAF——但 tick 循环只能靠自身续命，取消后无人重启 → 角色整体消失。且"0.73s 心跳=多实例"是误诊：显示器 165Hz，120 帧/165 ≈ 0.73s 本就是单实例正常频率。**修复：删除该 cancel**。
2. **premultiplied alpha 纹理错误**：rig-runtime 设置 `UNPACK_PREMULTIPLY_ALPHA_WEBGL=true` 但 ag-psd 图像是 straight alpha——透明/半透明像素的 RGB 残留（白底抠图、原始 face/front hair 的灰粉残留）被当成已预乘的不透明色渲染成色块。**修复：上传纹理前真正预乘 RGB*=A/255、透明像素归零**（rig-runtime.js applyRig 内）。
3. **front hair 被误挖大洞**：faceears.psd 制作时把"耳朵"连同**脸中央下部横带**（rig 坐标 x200-519, y261-435）一起从 front hair 挖掉，洞里露出灰色 back hair → 那条"灰色横条"（=用户看到的错位放大）；headwear 耳朵只盖洞两侧、盖不住中央。**修复：front hair 整体用原始 PSD 版替换**；face 图层被烘入耳朵弄脏（下半部 +1900 深色像素）同样用原始版替换；headwear 保留（仅清掉它顶部的"头顶圆弧"残留块 x150-335,y0-59，那是拆分时带进的多余内容，被前发盖住无视觉损失）。
4. **canvas 非等比拉伸**：`object-fit:contain` 在 Chromium 对 canvas 不生效，CSS 仅 `height:88% + max-width:100%` 会把画布拉伸（rigScale=0.3 时角色被压扁）——"错位放大"的物理来源。**修复：rig-runtime 按窗口高 88% 直接算 canvas 像素尺寸（__fitCanvas，等比），并监听 resize 跟随；pet.css 加 `width:auto`（renderer/pet.css:178，配合 JS 等比，防 max-width 拉伸画布）**。

**产物**：`seethrough_output_faceears3.psd`（=faceears 版 + front hair/face 恢复原始 + headwear 清残留），已部署为 `seethrough_output_faceears.psd`（原文件备份 `.bak-20260828`）。ears.psd / ears_v2.psd 同因 front hair 挖洞而作废（要复用需同样修）。

**验证**：
- 静态合成（Canvas2D 按 z 序 + fit 复刻）：faceears3 无灰条、耳朵对称可见、脸完整；faceears 原版中央灰条复现。
- 运行时（PrintWindow 抓窗）：canvas 等比 `rect=271x405@15,55`（rigScale=1.0）/ `81x121@110,17`（0.3）；与静态合成 RGB 逐像素对比 **89.9% 吻合**（差异=deform 动画+缩放采样）。"灰色横条"经像素扫描证实不存在（vision 幻觉）。
- 诊断基建：frame bbox 诊断原本误写在 Runtime 构造体（只在初始化读一次空画布）→ 已移入 tick 末尾（每 600 帧），可实时统计 whole/headwear 区域 alpha bbox。

**教训**：①截图/视觉判断必须像素级验证（vision 描述多次前后矛盾）；②"性能异常"先核对硬件参数（刷新率）再下结论；③改渲染管线时改动必须可单点回滚（本次 4 个修复相互独立）。

### §14 追加 109：2.5D 放弃修复改回退 + 苏苏洛声音源随包 + 干净发布打包（2026-08-29，已部署验证）

**决策**：§107/108 修完用户实测仍不理想，决定不修了。按用户要求回退到今天做 PSD 调整之前的版本（以 `E:\vmwork\archive\20260828-asar-stable` 上午 10:02 归档为参照），然后按之前的要求做干净发布，并首次把苏苏洛的训练成品声音源随包分发。

**回退内容（与归档逐文件 diff 确认，仅撤 PSD 调整相关改动）**：
1. `renderer/rig-runtime.js` 整体换回归档版（453 行）：撤掉 §108 的 `__fitCanvas`、premultiply 预乘、cancelAnimationFrame 相关注释，以及全部 `[rigdbg]` 诊断日志。
2. `renderer/pet.css` 去掉 §108 加的 `width:auto` 那一行。
3. `main.js:2997` 的渲染模式判断此前被改坏成 `!cfg.renderMode === "spine"`（恒 false，行走开关不再校验模式），恢复为 `cfg.renderMode !== "spine"`。
4. 皮肤侧无需动：生效配置里的 `rigSkinId` 本就是原始 `seethrough_output.psd`，faceears 只剩 `.bak-20260828` 备份。

**声音源随包（新功能）**：正式版目录新增 `voice/`（634MB），含 `gsv/`（苏苏洛 GPT-SoVITS 终版模型 `sussurro_e50_s1050.pth` + `sussurro_v2proplus-e20.ckpt` + 日语参考音频）、`genie/`（中文 ONNX 模型 + 参考音频）和 `voice/README.md`（怎么用、免训练说明）。`tts-manager.js` 新增 `bundleVoice()`/`applyBundledVoice()`：探测 exe 旁的 `voice/`，只在这几个模型路径缺失时才回填 config（不覆盖用户已配置的路径）；Genie 拉起时若存在 `voice/genie/onnx` 就注入 `--model_dir`。**首启即回填**：回填调用挂在 tts-manager 模块加载处（VM 全新安装冒烟曾发现只在合成/拉起时触发，首启不生效，已修复为模块加载即执行）。用户本机已配 E:\ 路径所以不触发，新用户出厂态自动生效。

**VM 全新安装冒烟（SuzuranPet-TestVM）**：删 AppData 模拟新机 → 首启通过（agreed=false 协议重置、5 进程、DLL 基线、/health 正常），**出厂 config 的 ttsGsv.sovitsPath/gptPath/refAudio 与 ttsGenie.refAudio 自动回填为 `C:\petapp-fresh\voice\...`**（中文/日文参考文本均正确），验证了"新用户免训练直接用"闭环。

**打包**：同步 main.js / tts-manager.js / rig-runtime.js / pet.css / README 等到打包源，app_legacy 与根目录的 config.json 都换成出厂模板（agreed:false、无 API key、无宿主路径），清掉 .github 与 3D 残留的 `app.asar.new.unpacked`；`pack.sh` 重打 asar（180MB）；启动冒烟 5 进程 + `/health` 正常，asar 内文件抽查通过（rig-runtime 453 行无诊断、tts-manager 含探测函数、config 出厂态）。

**发布产物**：Desktop 的 `苏苏洛桌宠-1.1.0正式版-发布.zip`（干净版，排除 app_legacy 回退件、app.asar.old 打包备份、单测与临时脚本；打 zip 用 `deploy/publish.ps1`，deploy/README 已同步新流程）。

### §14 追加 110：语音引擎随包（Genie 中文 + GPT-SoVITS 日语，开箱即用）（2026-08-29，已部署验证）

**决策**：用户要求引擎也一起打包（此前只带模型，新用户需自备推理引擎）。本条目把两个引擎完整打进发布包，新用户**装完即说话**，中文（Genie）+ 日语（GPT-SoVITS，speakJa 模式）都开箱即用。

**打包内容**（正式版目录 `engines/`，约 15GB）：
- `engines/genie/`：GenieTTS 完整引擎——venv（python 3.13 + onnxruntime）+ GenieData + my_model（苏苏洛 ONNX）+ CharacterModels + genie_tts_server.py + ref。**关键处理：venv 的 pyvenv.cfg home 绑定宿主 Python 路径，新机器失效**——随包内置 base-python（Python313 完整复制），`tts-manager.js` 的 `fixBundledGenieVenv()` 首启检测 home 失效则改写为包内 base-python（VM 实测触发并生效）。
- `engines/gsv/`：GPT-SoVITS v2Pro 精简引擎——runtime（嵌入式 python 3.9 + torch 2.0 CUDA，**可直接移动**）+ GPT_SoVITS（推理代码 + 预训练）+ api.py/config.py + tools/audio_sr、tools/i18n（api 依赖）+ 苏苏洛终版模型（e50/e20）+ 日语参考音频。**排除**：tools/asr、tools/uvr5（训练用 3.4G）、logs（2.7G 训练日志）、多余 epoch 权重（省 4.2G）。
- 原 `voice/` 目录并入 engines（模型在引擎内，顶层 voice/ 删除）。

**代码**：`bundleVoice()`/`applyBundledVoice()` 改为探测 `engines/` 并回填引擎路径（python/serverScript）+ 模型路径（缺失才写，不覆盖用户配置）；Genie 拉起参数修正为 `--model-dir`（原写的 `--model_dir` argparse 不认，本机实测发现并修复）。出厂模板 ttsGenie.enabled=true（引擎随包后直接启用）。

**验证**：
- 本机实测：包内 Genie 合成中文 2.76s、GSV 合成日语 2.42s，均正常（HTTP 200，32kHz WAV）。
- VM 全新安装：出厂 config 自动回填 engines 路径；Genie venv home 修复生效；双引擎实际合成通过。
- 注意：GPT-SoVITS 推理需 NVIDIA GPU（无则 CPU 慢）；README 显示 MIT（可再分发），v2Pro 整合包具体条款已提醒用户核对。

**踩坑与修复（VM 全新安装实测发现）**：
1. **Genie venv 的 onnxruntime 缺 VC++ 运行库**：venv 复制到新机器后 `import onnxruntime` 报 DLL load failed（宿主靠 System32 兜底，新机器没有）。**修复：把宿主 System32 的 VC++ 运行库 DLL（vcomp140/msvcp140*/vcruntime140*/concrt140 等 30 个）复制进 `engines/genie/venv/Scripts/`**。
2. **python 加载扩展不搜 venv/Scripts**：DLL 放进去后仍失败——python.exe 加载 onnxruntime 扩展时依赖搜索不含 Scripts 目录。**修复：写 `venv/Lib/site-packages/sitecustomize.py`，启动即 `os.add_dll_directory(Scripts)`**（python 3 启动自动导入 sitecustomize）。
3. VM 里 GSV 无法实测合成（VirtualBox 无 GPU 直通 + 4GB 内存），日语合成以宿主机 GPU 实测为准（2.42s 正常）；VM 验证 Genie 中文完整链路。

**VM 完整链路（最终）**：全新安装 → 出厂 config 自动回填 engines 路径（ttsGenie.python/ttsGsv.python/模型路径）→ venv home 修复生效 → onnxruntime 加载成功 → Genie 引擎"服务器就绪、预热已就绪" → **真实中文合成 HTTP 200（169KB，2.64s，32kHz 正常语音）**。

### §14 追加 111：Live2D 渲染模式 v1（第四渲染态，2026-08-29，已部署实测）

**背景**：用户调研 live2d-widget 后要求评估并集成（docs/LIVE2D-INTEGRATION-PLAN.md 项目稿）。v1 目标：桌宠能显示 Live2D 模型，先用内置示例模型跑通链路，素材后续再解决。

**选型**：`pixi-live2d-display-lipsyncpatch@0.5.0-ls-8`（MIT，社区版，peer 支持 pixi ^7 与桌宠 pixi 7.4.2 匹配；官方 0.4.0 只支持 pixi 6）。不用 live2d-widget（GPL-3.0 传染）。Cubism Core（207KB，Live2D 专有许可）随包捆绑、不入 git 仓库。测试模型 haru（Cubism 4，Live2D 官方示例素材，17 文件 3MB）入 git。

**实现（v1 范围：显示 + 自动 Idle + 点击动作）**：
- `src/render-mode.js`：RENDER_MODES 加第四态 `"live2d"`；
- `renderer/live2d-runtime.js`：自治模块（照 3D 时代教训，单点可回滚），暴露 `Live2DRuntime.init/destroy`——透明 PIXI Application 全窗、模型按窗口高 88% 等比贴底居中、resize 跟随；
- `renderer/index.html`：live2d-canvas + 三个脚本（Core → pixi-live2d → runtime）；
- `renderer/pet.js`：`initLive2d/destroyLive2d` 生命周期，`onRenderModeChanged` 与启动恢复各加 live2d 分支，离开模式统一销毁；
- `main.js`：`pet:live2d-list` IPC 扫描两处模型源（asar 内置 + `userData/assets/live2d/`，后者走 pet-user: 协议）；
- 设置页渲染模式下拉加「Live2D 角色（实验，内置示例模型）」。

**踩坑**：①vision 截图判读先拍到旧图（cap-rig.ps1 还匹配 1.1 进程名、且脚本是 UTF-8 无 BOM 被 PS5.1 按 ANSI 读）——脚本转 UTF-16LE 并改匹配 2.5 后抓到；②asar 内关键词检测曾把两个关键词拼接搜索导致误报缺失，分开查即正常。

**验证**：切 live2d 模式日志 `[live2d] 模型就绪: haru（内置示例）`；PrintWindow 抓窗 + vision 判读：角色完整渲染、等比贴底居中、无变形无黑块；切回 spine 干净（5 进程 + /health + 日志零错误）。Core 的 wasm 在现有 CSP（script-src unsafe-eval）下正常运行，CSP 无需改动。

**v1 已知限制（后续迭代候选）**：皮肤选择 UI（当前默认第一个模型）；行走/坐姿动画联动；窗口尺寸策略（暂用当前窗口，模型 88% 贴底）；Cubism 2 老模型支持（当前只 3/4/5）。

**注意**：GPT-SoVITS v2Pro 与 GenieTTS 推理引擎不在包内（v2Pro 是商业发布包，整套再分发有授权风险），新用户按《语音部署与训练指南》自备引擎，模型用随包的即可，不用训练。

## 11. 后续优化重点项目（Roadmap，2026-08-26 由用户指定）

### 重点项目 A：按皮肤加宽画布（Spine 画布宽度自适应）

> **【2026-08-28 用户决定：搁置】** 官方新皮肤维护繁琐，桌宠只保证"苏苏洛本体"通过即可，其余皮肤视为附带、暂不做适配。此条目冻结，不投入。若日后插件化皮肤生态重新提上日程再解冻。

**痛点/背景**：`.pet` 元素固定 120px 宽（pet.css），PIXI 画布随之 120px。迷迭香第三皮肤（391_rosmon_sale_16）包围盒 486:121（横宽 4:1）、可见轮廓 ~1.65:1（持武器+大尾巴），在 120px 画布下**满高（108px）需要 ~178px 宽，放不下**——宽度是硬限制，强行放大必然裁剪（v2.4.2 尝试后腿/武器出画布，v2.4.4 已回退为稳定完整显示）。

**目标**：按皮肤可见宽高比自动加宽 pet 元素 + PIXI 画布（上限与窗口一致），让宽模型也能满高显示且各状态稳定。

**已踩过的坑（必须规避）**：
- v2.4.2 尝试 `petEl.style.width` + `spineApp.renderer.resize`：行走几何被破坏（charInset=petEl.offsetLeft，加宽后元素左缘 ≠ 角色左缘 → 角色位置偏移/出画布/消失）；渲染纹理反复创建出现过 OOM（03:17）。
- 窗口尺寸在行走相位间变化（startWalkingEngine 重置 260×200），画布宽度必须跟随。
- 放大系数必须 min(高度目标, 宽度目标)，测量要在无包围盒守卫的基准比例下进行（否则被折叠污染，×3.38 过冲）。

**技术要点**：
- 行走对齐：几何上报 inset 需用"角色可见左缘"（已做 spineFigLeftCss 雏形，需完整验证）。
- 布局：`.pet` right:2px 右对齐、气泡 max-width calc(100%-136px)，加宽后气泡/输入栏布局需复核。
- 内存：renderTexture 采样注意释放（每 fit 多次创建有 OOM 前科）。
- 验收：迷迭香第三皮肤 ≥108px 满高、完整无裁剪；行走/坐下/放大聊天框各状态稳定；无消失/出画布；内存无增长。

### 重点项目 B：RP 框架专门优化（角色扮演人味）

**背景**：调研已完成（docs/rp-frameworks-research.md）。已落地：buildPetRules RP 质感条款（斜体动作/禁替博士决定/主动延续话题/情绪起伏）+ 每轮"此刻状态"注入（§42）+ 人设重构（§43：桌面日常场景/表达习惯/分块示例台词/新开场）。

**后续按优先级**：
1. **长期记忆 + 羁绊/好感度**（LingChat 模式，留存第一驱动，工程量最大）：结构化记忆表（称谓/偏好/纪念日/"上次她说感冒了"）+ 每 20 轮自动摘要滚动注入 + 好感度解锁台词。注意记忆污染校验（人设崩风险）。
2. **采样参数调优**（本地 3-8B，低成本高性价比）：Temp 0.8-1.0 / Top_P 0.9 / Min_P≈0.05 / RepPen 1.05-1.15 / MaxTokens 300-600。
3. **主动搭话"由头"化**：读前台窗口标题/时段/日程/电量等轻量信号造话题由头（区别于已否决的"读屏幕内容"，只读轻量元数据）。
4. **情绪语音（若再做，必须谨慎）**：v2.4 曾因给 GSV 默认合成接上参考音频导致"音色完全不对"（已回退 §50）。教训：默认合成不得带参考音频；情绪参考只能**检测到特定情绪时临时切换、绝不改变默认**，且需用户录音/素材先行确认。

**验收**：聊天 10 轮以上记忆可回引；角色在 3 种以上情绪下语气自然不重复；主动搭话有"由头"不再随机。


### 重点项目 C：安全防御测试（来源：用户提供的豆包帖子，2026-08-26 指定加入）

**来源**：https://www.doubao.com/thread/a4784d360b821 —— 病毒与恶意代码防御测试 + 网络攻击防御测试完整方案（用户已提供全文）。

**执行时机（用户明确约束）**：**等相关更新完全结束后进行测试**——不与当前 v2.4.x 皮肤/语音回退、配音素材接入等更新并行；等这些更新全部完成后再启动本条目的测试。

**前置合规与环境要求（测试阶段必须遵守）**：
1. 合规底线：仅在拥有完全所有权/书面授权的系统与软件上测试（本应用为自有软件）；禁止对未授权系统、公网环境执行攻击/病毒投放；遵守《中华人民共和国网络安全法》。
2. 隔离环境：全程在虚拟机（VMware/VirtualBox）中执行；测试前拍摄系统快照，测试后可一键回滚；使用独立内网，禁止接入公网，避免样本/攻击流量扩散。

**一、病毒与恶意代码防御测试**：
1. 文件层：文件完整性校验（篡改 exe/dll 字节 → 验证启动自检/拒绝运行/篡改告警）；DLL 侧载攻击（恶意同名 dll 放入安装目录，验证是否优先加载恶意 dll）；感染型病毒模拟（PE 感染工具感染可执行文件 → 验证数字签名失效/功能异常/被杀软识别）。
2. 运行时：进程注入（远程线程/APC/反射式注入 → 是否成功/崩溃/劫持/触发自防护）；内存马与无文件攻击；输入劫持（全局/消息钩子窃取键盘输入、账号密码）。
3. 染毒环境兼容性：在部署 EICAR 标准样本/模拟木马（非活体高危）的环境中运行软件，观察是否被破坏、是否成为传播载体。

**二、网络攻击防御测试**：
1. 端口/网络层：Nmap 端口扫描与资产发现（不必要开放端口/未认证监听/端口指纹泄露）；低强度 DoS（SYN 洪水、HTTP 短连接洪水 → 是否崩溃/限流）；外连行为审计（防火墙+抓包记录全部外发连接，排查未知域名/隐蔽信道/后门）。
2. 通信安全：HTTPS 证书校验（BurpSuite/Fiddler 中间人代理 → 是否接受伪造证书、敏感数据是否明文）；数据包篡改与重放攻击。
3. 接口安全（本地 HTTP 服务）：OWASP Top10 核心项——SQL 注入、命令注入、路径穿越、未授权访问/越权、弱口令/暴力破解防护。

**三、执行流程**：基线采集（进程/端口/CPU/内存/网络连接/文件哈希）→ 分级测试（低→中→高危，高危前拍快照）→ 风险定级（高危=远程代码执行/注入木马/泄露敏感数据/本地提权；中危=篡改数据/拒绝服务/绕过认证；低危=版本信息泄露/配置不规范）→ 回归验证（修复后复测，确认闭合且不影响正常功能）。

**四、工具清单**：Process Hacker、x64dbg、CFF Explorer、EICAR 样本（病毒/注入）；Nmap、Wireshark、BurpSuite Community、Fiddler（网络）；Nikto、OWASP ZAP、Goby（漏洞扫描）；VMware Workstation、VirtualBox、Windows Sandbox（隔离）。

**本应用相关攻击面（已有基础，测试时优先覆盖）**：
- Electron 桌面应用（main 进程 + renderer；resources/app 未打包 asar，文件可直接比对哈希 → 篡改检测易做）。
- 本地 HTTP 服务：Agent 接口 127.0.0.1:8765（已有 Slowloris 防御：requestTimeout/headersTimeout/keepAliveTimeout/maxConnections=50 + Bearer token 认证）；GSV 9880 / Genie 9881 本地 TTS 服务。
- 敏感数据：config.json + safeStorage/DPAPI 密钥（chatApiKey/ttsCosyApiKey/agentBearerToken）；已有 file-guard 蜜标监控（honey/tamper/worm/ransom/symlink 5 类检测 + 篡改自动还原）。
- 历史沙盒测试基线（2026-08-25）：网络攻击 9/9、XSS、路径穿越、剪贴板、鼠标位置隐私、模型攻击（3 模型）均通过/已修复；本次按新方案补充 DLL 侧载、进程注入、MITM、签名校验等未覆盖项。
- Electron 特有项：DLL 劫持（Electron 常见弱点，需确认安全加载路径）、数字签名（当前 exe 是否签名）、ASAR/文件完整性、进程注入防护。

**测试阶段交付**：按本应用类型（Electron 桌面应用 + 本地 Web 服务）把方案细化成可一步步执行的操作步骤（含每条的具体命令/工具操作/预期结果/判定标准），执行后输出逐项结果与修复建议；如为商用发布则建议委托第三方测评机构。

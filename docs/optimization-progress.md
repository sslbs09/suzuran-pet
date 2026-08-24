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
| 实际运行部署目录 | `C:\Users\xsbil\Desktop\苏苏洛桌宠-1.1.0正式版\resources\app\` |
| 实际启动 exe | `C:\Users\xsbil\Desktop\苏苏洛桌宠-1.1.0正式版\苏苏洛桌宠 1.1 正式版.exe` |
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

## 10. 用户已明确的偏好与禁区

- 不推送 GitHub。
- 不要实现多桌宠同屏互斥。
- 用户希望中文沟通。
- 任何会删除/移动真实用户 config、密钥、历史、模型、声音或资产的操作，先确认；当前迁移策略是复制并保留旧文件。
- 不要在回复、日志、测试输出、文档或 commit 中打印 API key、token 或 DPAPI ciphertext。

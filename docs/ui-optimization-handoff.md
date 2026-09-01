# 交接报告：苏苏洛桌宠 UI 优化

- 编写日期：2026-09-01
- 代码基准：v2.5.25（HEAD = 本地 main）
- 仓库：`E:\SuzuranPetGit`（GitHub: https://github.com/sslbs09/suzuran-pet）
- 本任务由另一位模型/AI 承接，以下内容自包含，可直接开工

---

## 一、背景与目标

桌宠 UI 已有一轮代际基础（设计变量系统 + 设置页左侧导航改版），但存在三类明显短板：

1. **暗色主题适配不完整**：设计变量层支持 `body.theme-dark`，但 `pet.css` 有约 50 处硬编码颜色，暗色只覆盖了气泡/输入栏/信息版四个组件；辅助窗口（help/quickstart/docs 等）深浅色下观感不一致
2. **主窗口桌宠本体观感偏朴素**：气泡、输入栏、信息版是纯色块，缺少层次（阴影/渐变/微动效），与设置页的打磨程度不匹配
3. **辅助窗口风格不统一**：各窗口复用 ui.css 变量但不完整，头部/卡片/按钮细节各有出入

目标：在不改功能逻辑的前提下，统一视觉语言、补全暗色主题、提升主窗口质感与微交互。

## 二、现状盘点（先读这些）

### 设计系统（已有，别推翻，只扩展）
- `renderer/ui.css` — 全部窗口的设计变量层：
  - `:root` 定义 `--ui-bg/surface/surface-soft/ink/muted/subtle/line/line-strong/accent/accent-strong/accent-soft/warm/danger/danger-soft/success` + 阴影/圆角/缓动/焦点环（1-18 行）
  - 123 行起 `body.theme-dark` 覆盖变量层（深色），**所有 ui-page 窗口跟随**——这是暗色主题的主通道
  - `--ui-focus: 0 0 0 3px rgba(...)` 焦点可见性已就绪
- `renderer/settings.css` — 设置页组件层：左侧分类导航 + scroll-spy（v2.5.18）、iOS 滑动开关、未保存提示条、响应式（620/720px 断点）、`prefers-reduced-motion` 已支持
- `renderer/pet.css` — 桌宠主窗口（气泡/输入栏/信息版/拖拽反馈动画/摸头），**硬编码色最多（50 处）**

### 文件清单
| 文件 | 内容 | 说明 |
|---|---|---|
| `renderer/index.html` | 桌宠主窗口（气泡/输入栏/信息版/画布） | 65 行，结构简单 |
| `renderer/pet.css` | 主窗口样式 | 449 行，暗色适配缺失重点 |
| `renderer/settings.html/css/js` | 设置页 | 579 行 HTML，已较完善 |
| `renderer/ui.css` | 通用变量/页面骨架 | 144 行，所有窗口共用 |
| `renderer/help.html` `quickstart.html` `docs.html` `terms.html` `schedule.html` `psd.html` `addchar.html` `moods.html` `voice.html` | 辅助窗口 | 复用 ui.css，风格统一度待查 |
| `renderer/docs.css` `schedule.css` | 辅助窗口专用样式 | 与 ui.css 的变量接入度待查 |

### 主题切换机制
- 主进程 `applyTheme(theme)` → `body.theme-dark` 类（自动/浅/深三态，i18n 设置页 theme-select）
- 变量层切换是全窗口自动的，**只有硬编码颜色需要手动补 dark 覆盖**——这是本任务工作量主体

## 三、优化任务清单（按优先级）

### P1-1 补全暗色主题适配（工作量最大，先做）
- **目标**：`pet.css` 50 处硬编码颜色全部纳入深浅双主题
- **做法**：
  - 能映射到 `--ui-*` 变量的直接替换（如 `#eef7f5` → `var(--ui-surface-soft)`）
  - 桌宠专用色（气泡蓝 `#8ec7e8`、hover 蓝、信息版等）在 `pet.css` 顶部补一组私有变量 `:root { --pet-*: ... }` + `body.theme-dark { --pet-*: ... }`，替换硬编码
  - 逐组件核对：气泡（含 error/task 变体）、放大按钮/关闭按钮 hover、thinking 点点、拖拽把手斜纹、输入栏、信息版、info-companion/info-sched/info-empty/info-sched-time、摸头反馈
- **验收**：设置页把主题切到深色，主窗口所有组件均无刺眼亮色残留；切回浅色无回归

### P1-2 主窗口质感与微交互（pet.css + index.html）
- 气泡：纯色背景 → 半透明 + 轻微毛玻璃（`backdrop-filter: blur` 需配合窗口透明，先验证不穿帮）；增加层次阴影；`.bubble::after` 尾巴微调
- 输入栏：与气泡视觉对齐（同背景/边框体系）；按钮 hover 过渡统一用 `var(--ui-ease)`
- 信息版：组件卡片化（间距/圆角/分组标题统一）
- 微交互：气泡出现动画（现有 `bubble-in` 0.18s）保留；新增按钮按下反馈（`:active` scale 0.97 等，注意 `prefers-reduced-motion`）
- **注意**：桌宠窗口透明 + `setIgnoreMouseEvents` 穿透逻辑在 main.js/pet.js，**不要改 JS 行为**，只动 CSS

### P2-1 辅助窗口风格统一（help/quickstart/docs/terms/schedule/psd/addchar/moods/voice）
- 逐窗口核对：标题（`.ui-header h1`）、卡片（`.ui-page h2` + section）、按钮、表格、代码块是否都走 `--ui-*` 变量
- `docs.css`/`schedule.css` 里的硬编码色同样补变量或 dark 覆盖
- **验收**：深色主题下所有辅助窗口观感一致，无亮色残留

### P2-2 设置页小窗/细节打磨（settings.css，v2.5.18 已大改，只做增量）
- 检查 iOS 开关滑块灰色 `#c8ccd0`、未保存提示条（已有 dark 覆盖）之外的硬编码色
- 键盘可达性：`set-nav` 锚点链接的 `:focus-visible` 样式
- 分区图标/间距微调（可选）

### P3-1 可访问性基线
- 对比度：`--ui-muted (#62777d)` 小字号（12px）对比度核对，不足则微调
- `prefers-reduced-motion: reduce` 下关掉气泡/开关/按钮动效（settings.css 已有先例，pet.css 补齐）
- 焦点可见性：按钮/输入框补 `--ui-focus` 焦点环

## 四、验收标准

1. 深浅双主题下：主窗口 + 设置页 + 全部辅助窗口无硬编码亮色残留，观感一致
2. 主窗口气泡/输入栏/信息版质感提升，动效顺滑且尊重 `prefers-reduced-motion`
3. **功能零回归**：拖拽、摸头、气泡定位（edge-left/top 变体）、点击穿透、放大模式均正常——只动 CSS，不碰 JS 行为
4. `node --check` 通过改动文件；现有 22 个单测全绿（本任务基本不涉及 JS，若有涉及必须补测）
5. 打包重启后桌宠各模式（GIF/Spine）显示正常，日志无 error

## 五、红线注意事项（务必遵守）

1. **Mimosa 安全门禁**：改源码一律用 Write/Edit 工具，禁止 Bash 直接写源码/配置；git 用 `git -C "E:/SuzuranPetGit"`
2. **打包升级方式不要改**（用户红线）：继续 app_legacy 散目录 + `pack.sh` + `cp -f app.asar.new app.asar` 流程
3. **部署循环**：改 dev → PowerShell `Copy-Item` 同步到 `release/v2.5/苏苏洛桌宠 2.5 正式版/resources/app_legacy/`（Bash `cp` 会被 Mimosa 拦）→ 停桌宠 → `bash deploy/pack.sh` → `cp -f` 覆盖 asar（mv 常因文件锁失败）→ 重启 → 验证 `E:\SuzuranPetData-Roaming-2.5\logs\tts.log`
4. **只动 CSS/HTML 结构，不动 JS 交互逻辑**：拖拽、穿透、行走、气泡定位都是 JS 管的事，改坏了影响面大
5. **验证用视觉检查**：看截图必须走 vision skill（`node "C:/Users/xsbil/.zcode/skills/vision/vision.js" "<path>" "问题"`），禁止用 Read 直接读图
6. **版本与日志**：`package.json` bump 到 2.5.26（本次基准 2.5.25）；`CHANGELOG.md` 顶部加 v2.5.26 段
7. 完成后 commit（不 push），等用户验收后再发版

---

## 六、执行日志（接续会话逐段填写，防中途中断）

> 说明：本节由 2026-09-01 接续会话（sess_e843ac02 之后）填写。每完成一个检查点追加一条并随代码一起提交。

### 2026-09-01 检查点 0：现状盘点完成（代码未动）

**已确认的事实与增量发现**（比交接报告第三节更具体）：

1. **主窗口主题架构**：`pet.js:181 applyTheme()` 负责 `body.theme-dark`，含 auto（19 点-6 点）/system 逻辑，60s 定时 + `pet:theme-changed` IPC 监听，基建完好，CSS 侧补齐即可。
2. **⚠️ 新发现（交接报告未覆盖）**：主进程 `sendToRenderer`（main.js:1386）只发**主窗口**；辅助窗口里只有 `docs.js` 在 init 时自己 `getState().theme` 补主题类。**help/quickstart/terms/schedule/psd/addchar/moods/voice 八个窗口拿不到 `body.theme-dark`**——ui.css 里给它们准备的暗色变量覆盖实际是死代码。
   - **方案**：新增共享 `renderer/theme-init.js`（读取 state.theme + 订阅 theme-changed，逻辑与 pet.js applyTheme 完全一致），八个窗口 HTML 末尾加 `<script src="theme-init.js"></script>`（各窗口 CSP `script-src 'self'` 均允许）。不改任何现有 JS 行为。
3. **pet.css 级联陷阱**（改前必读）：文件尾部 403-412 行"统一视觉令牌"块靠**后置同特异性覆盖**生效——它把 `.btn`（含气泡内 zoom/close 按钮）背景改成了纯青 `#2f8f87`、`.btn-stop` 的红色也被盖掉（停止按钮目前显示为青色 ■）。原 107-125 行 zoom/close 的半透明设计已成死代码。重做时此块删除，语义并入 `--pet-*` 变量；zoom/close 用 `.bubble .btn-zoom` 提升特异性，恢复半透明幽灵按钮观感（有意变更，见检查点 1）。
4. 辅助窗口盘点结论：help/quickstart/addchar/schedule/terms 全走 `--ui-*` 变量 ✓；`docs.css` 浅色是**唯一橙色系离群窗口**（深色已切青）→ 统一到青系；`psd.html` 整页内联硬编码浅色（且声明 `color-scheme: light`）→ 需变量化+暗色；`moods.html .tag-new`、`voice.html .status-card.ok/.no`、`ui.css button.danger 边框`、`terms.html .terms-head` 白字浅底 → 深色残留点。
5. `schedule.css` 已全变量化，无需动；`settings.css` 缺口仅 `.cred-status.warn`（#b45309）、iOS 开关轨道灰（#c8ccd0）、set-nav 焦点环三处。

**接下来的顺序**：pet.css 令牌化（P1-1+P1-2）→ theme-init.js 与八窗口接入 + 各窗暗色补全（P2-1）→ settings/可访问性（P2-2/P3-1）→ 测试+打包+视觉验证 → 版本号/CHANGELOG → GitHub 页面（README）优化。

### 2026-09-01 检查点 1：P1-1 + P1-2 完成（pet.css 全量令牌化）

**做了什么**：
- `renderer/pet.css` 重写：顶部新增 `:root` / `body.theme-dark` 两组 `--pet-*` 令牌（面板底色/边框/阴影/墨色/强调/芯片/信息版/按钮/滚动条/swipe 等 30+ 枚），全文 50+ 处硬编码色全部替换为令牌；深色主题由变量层自动翻转，删除旧尾部两段补丁（403-412 令牌覆盖块、423-432 组件级 dark 覆盖块）。
- **有意视觉变更**（对照旧版）：
  1. 气泡内 ⤢/× 按钮从"纯青实心圆"恢复为**半透明幽灵圆角按钮**（`.bubble .btn-zoom/.btn-close` 提特异性，hover 填色 + `:active scale(.9)`）——旧行为是级联覆盖的意外产物；
  2. ■ 停止按钮恢复**红色语义**（旧令牌块误将其盖成青色）；
  3. 阴影升级为两层（环境影 + 近影），深浅各一套；
  4. 新增：输入栏/信息版出现动画（复用 `bubble-in`）、`#input::placeholder` 颜色、`.input-bar:focus-within` 边框加深、swipe 按钮过渡/按压/焦点环、思考点点与滚动条颜色随主题。
- **几何零改动**：所有定位/尺寸/z-index/翻边（edge-left）/放大模式/宽皮肤规则逐条保留；`--chat-fz` 仍由 pet.js:1447 运行时注入（带 11px 兜底）。
- 自检：括号配对 129/129；未定义变量 0；残留 `#fff` 仅为彩色按钮上的白字、`rgba(232,96,96,*)` 为录音脉冲（与 `--pet-mic-rec` 同值，双主题一致）。

**待验证**：深色下主窗口整体观感（打包后 vision 截图）。

**下一步**：P2-1——theme-init.js + 八窗口接入 + docs.css 统一 + psd/moods/voice/ui/terms 暗色补全。

### 2026-09-01 检查点 2：P2-1 + P2-2 + P3-1 完成，测试全绿

**做了什么**：
- **新增 `renderer/theme-init.js`**：辅助窗口主题引导（读 `getState().theme` + 订阅 theme-changed，逻辑与 pet.js applyTheme 一致），并在 **help/quickstart/terms/schedule/psd/addchar/moods/voice** 八个 HTML 末尾挂 `<script src="theme-init.js">`（各窗 CSP 均允许）。docs 窗口已有 docs.js 自处理，不重复挂。
- **⚠️ 唯一 main.js 改动（已核对红线，属窗口配置非交互逻辑）**：`openHelp()` 的 webPreferences 是裸配置缺 preload（历史遗漏，其余窗口都走 `winChild.childWebPrefs`），改为与其他窗口一致的 `winChild.childWebPrefs(config.APP_DIR)`——否则 help 窗口拿不到 petAPI，暗色永不生效。
- **docs.css**：浅色从橙色离群系统一到全局青系（bg/sidebar/accent/text/border 全换 `--ui-*` 同值）；新增 `--accent-hover`/`--tip-bg` 变量；`#docs-iframe` 背景走变量（暗色不再白底）；深色选中项改亮青底+深字（对比度）。
- **psd.html**：整页内联样式令牌化为 `--psd-*`（12 枚）+ `body.theme-dark` 深色组；透明预览棋盘格双主题；数字输入框补主题样式；`color-scheme` 深浅声明；`#sel-info` 内联色改变量。
- **moods.html**：`.tag-new` 与 moods.js 生成的内联「自定义」标签（`!important`）深色覆盖。
- **voice.html**：`.status-card.ok/.no` 深色改半透明色罩。
- **terms.html**：`.terms-head` 深色改 `#1d4742` 深青底（浅青底白字对比度不足）。
- **ui.css**：`:root`/`body.theme-dark` 加 `color-scheme`（原生控件跟随）；`button.danger` 深色边框改半透明红。
- **settings.css（P2-2）**：`.cred-status.warn` 深色提亮；iOS 开关轨道深色压暗 + `input:focus-visible` 焦点环；`.set-nav a:focus-visible` 焦点环（P3-1）。
- **已知不动项**：psd.js:544 的 2.5D 预览棋盘格是 JS 内联（按图像编辑器惯例保留浅色）；moods.js「情绪/待机」标签本就无样式，不动。

**验证（本检查点）**：
- 22 个单测（tests/*.test.js）**全部通过**；`node --check` main.js/theme-init.js 通过；ESLint 0 error（theme-init.js 零警告，main.js 8 条警告均为历史未用变量）。
- `test:chat` 为需真实 API Key 的在线冒烟，本机未配钥匙退出 1——环境问题，与本次改动无关（改动不涉 chat 链路）。
- CSS 括号配对与变量定义完整性全部校验通过。

**下一步**：部署到 release 打包重启 → vision 截图验收深浅主题 → bump 2.5.26 + CHANGELOG → GitHub README。

### 2026-09-01 检查点 3：部署验证通过 + 顺手修一个历史 bug

**版本/CHANGELOG**：package.json → 2.5.26；CHANGELOG 顶部加 v2.5.26 段（UI 优化六条）。

**部署验证（按红线流程）**：PowerShell Copy-Item 同步 17 个文件 → 停桌宠 → `bash deploy/pack.sh` → `cp -f app.asar.new app.asar`（mv 因文件锁失败是已知现象）→ 重启 → `tts.log` 无 error，行走/预热正常。

**视觉验收方法（后人可复用）**：透明窗 + 点击穿透导致 computer-use 坐标点击不可靠；可靠路径是
`--remote-debugging-port=9222` 启动 → CDP `Runtime.evaluate` 读计算样式/临时展开组件 → `Page.captureScreenshot` 抓渲染表面落盘 PNG → `vision.js` 验收。临时验证脚本已删，方法留档。

**验收结论**：
- 深色：`body.theme-dark` ✓；气泡/输入栏 `rgba(35,44,49,.96)` 底 + `rgba(87,188,180,.25)` 边 + `#e8eef0` 字；⤢/× 幽灵按钮 `rgba(58,168,159,.16)` 底 + `#7fd0c9` 字；vision 确认无刺眼纯白。
- 浅色：白底 `rgba(255,255,255,.96)` + 青边 `rgba(47,143,135,.32)` + `#44505c` 字，vision 确认协调无回归。

**顺手修的历史 bug（index.html，纯结构）**：`#btn-stop` 的 class 原本只有 `btn hidden`，缺 `btn-stop`——导致 `.btn-stop.hidden{display:none}` 与 `.btn-stop` 红色语义两条规则从未匹配，停止按钮常年青色常显。已补 `class="btn btn-stop hidden"`，已随最终包部署。

**待用户手动验收**：鼠标单击桌宠弹输入栏看深色观感（模拟点击会被 pet.js 判成拖动，人工点一下最直观）；设置页切浅色回看无回归。

**下一步**：GitHub 仓库页面（README/About）优化。

### 2026-09-01 检查点 4：GitHub 页面优化完成

- README（中/英）：hero 一句话补「深浅双主题」；徽章下加 v2.5.26 新版提示条；功能表新增一行三格（深浅双主题 / 点击穿透 / 置顶自愈）。markdownlint 0 issue。
- About/topics：本机无 gh CLI，未动；如需要用户在本机 `gh auth login` 后补 `gh repo edit --add-topic ...`。
- 官网（gh-pages 分支）未动——用户若指官网再另做。
- **未 push**（红线）：UI 优化 4 个提交 + 本提交均在本地 main，等用户验收后一起推。

---

## 七、未来 backlog（2026-09-01 评估，按优先级）

### UI 可继续优化
1. **reduced-motion 缺口**：pet-squash（按压 Q 弹）/ pet-dizzy（落地眩晕）未进 `prefers-reduced-motion` 关闭列表——一行修复
2. **毛玻璃质感**：气泡/输入栏 `backdrop-filter: blur(6-8px)` + 面板不透明度降到 ~.85；需在透明窗下验证不穿帮，失败自动回退（本次保守未做）
3. **气泡尾巴融合**：尾巴是实心三角不带边框色，与气泡边框交接处断线；双层三角（外边框色+内背景色）可修
4. **退出动画**：气泡/输入栏消失是 display:none 硬切，可加 ~120ms 淡出（退出快于进入），需 JS 配合 class
5. **对比度微调**：浅色 `--pet-muted`/`--ui-subtle` 在 11-12px 小字下略低于 4.5:1；thinking 点浅色偏亮

### 技术债
1. **主题逻辑 4 份拷贝**（pet.js/docs.js/settings.js/theme-init.js 的 auto=19-6 规则）→ 收敛成 `renderer/theme.js` 共享模块；主进程 `sendToRenderer` 改全窗广播后辅助窗口可实时跟主题（现在只在打开时跟随）
2. **JS 内联样式债**：psd.js:544 棋盘格硬编码浅色；moods.js「自定义」标签内联色（现靠 !important 压，根治是 JS 改用类名）
3. **iframe 文档暗色未验证**：文档中心 iframe 加载的 HTML 文档（API 接入指南等）自带样式，暗色链条可能在内容层断
4. **无 stylelint、无视觉回归测试**：可加 stylelint + Playwright 截图快照，主题回归让测试兜底
5. **schedule 导入预览弹窗**：有 role=dialog 但零焦点管理（focus trap/回还）——a11y 债
6. **部署三件套手工**（Copy-Item→pack.sh→cp -f）→ 可收成一个 deploy.ps1（带锁检测/回滚）
7. **README_EN 与中文版发散**：EN 缺多个章节

### 方向性（感知价值高）
- 官网（gh-pages）狐橙+墨绿 vs 应用青系——品牌视觉分裂，统一是独立小项目
- 设置页分区内容 stagger 入场（30-80ms/项，总<400ms）
- 托盘图标主题感知

---

## 八、backlog 执行日志（2026-09-01 第二轮，用户确认后开工）

> 约束：打包方式不变（继续 app_legacy + pack.sh + cp -f）；每完成一块续写本节。

### 块 1：CSS 质感批（pet.css / ui.css）
- ✅ backlog-1 reduced-motion 缺口：pet-squash/pet-squash-release/pet-dizzy 进关闭列表
- ✅ backlog-5 对比度：浅色 `--pet-muted` #7f8f9c→#6e8090、`--pet-thinking`→#23736d；`--ui-subtle` #8aa0a4→#6f858c（11-12px 小字 ~4.5:1）
- ✅ backlog-3 尾巴融合：`.bubble::before` 外层边框色三角（右/翻边/头顶三变体齐），rig 模式同隐
- ✅ backlog-4 退出动画：面板三件 `transition: opacity .12s + display allow-discrete`，旧内核自动回退硬切
- ✅ backlog-2 毛玻璃：`backdrop-filter: blur(8px)` 渐进增强；面板不透明度 .96→.90/.93 配合
- 待块 5 部署后 vision 验证毛玻璃不穿帮。

### 块 2：主题逻辑收敛（tech-debt-1）
- ✅ 新增 `renderer/theme.js`：`isDark(theme, now)`（now 可注入，纯函数可测）+ `apply` + `init`，UMD 双出口（浏览器 window.petTheme / Node module.exports）
- ✅ 四份副本委托：pet.js applyTheme / docs.js applyTheme / settings.js applyThemeToPage / theme-init.js（瘦身为 `window.petTheme.init()`）
- ✅ 11 个 HTML 挂 `<script src="theme.js">`（主窗口/文档/设置 + 8 辅助窗口在 theme-init 之前）
- ✅ main.js 新增 `broadcastToRenderers()`，`pet:set-theme` 改全窗广播——辅助窗口**实时**跟主题（原仅打开时）
- ✅ 新增 `tests/theme.test.js` 9 断言（dark/light 直通 + auto 18/19/5/6 点边界 + system 无 window 不抛错）；全量 23/23 绿；新文件 eslint 零警告

### 块 3：JS 内联样式类名化（tech-debt-2）
- ✅ moods.js「自定义」标签改 `class="tag tag-custom"`；moods.html 补 `.tag-custom` 浅色+深色规则，删除 `!important [style]` 覆盖
- ✅ psd.js 2.5D 预览画布棋盘格改 `classList.add("checker")`；psd.html `#preview, .checker` 共用 CSS 变量棋盘格——深色自动跟随

### 块 4：schedule 导入预览弹窗焦点管理（a11y-debt）
- ✅ 打开时记录 `document.activeElement` 并聚焦「取消」（安全默认）；关闭时焦点回还
- ✅ 弹窗 keydown：Esc 关闭；Tab/Shift+Tab 在弹窗按钮间圈定（focus trap）

### 块 5：部署验证（打包方式未变）
- 同步 23 文件 → 停桌宠 → pack.sh → cp -f → 重启；tts.log 0 error
- vision 验收深/浅：尾巴融合无断线、毛玻璃无黑块/穿帮、配色协调 ✅
- 验证用 cdp-verify.js（动态取 CDP 目标版）已删；方法同检查点 3 留档
- 桌宠已正常重启（无调试口）
- CHANGELOG v2.5.26 段补二批内容

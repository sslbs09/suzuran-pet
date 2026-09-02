# v2.5.27 部署交接记录（2026-09-02）

> 本文件记录「把稳定性/台词池/固定台词预加载批次变成正式包并重启」的完整过程与结果。

## 一、部署前发现的关键前提

- 本工作副本克隆自 GitHub，基线 `44aaa67`（v2.5.18，8-31）。
- 真实开发仓库 `E:\SuzuranPetGit` 已推进到 `8f32360`（v2.5.26，9-01，含天气台词 65 句、
  LINE_MOODS、专注模式、walk-state/focus-watch 收敛、asar-swap 更新器、settings-patch 白名单、
  Agent 零认证封堵与 lastSeen 节流、UI 暗色闭环等 93 个提交）。
- 若直接以旧基线打包会回退上述全部工作。**处理方式：以 E 盘 v2.5.26 为基底做三方合并**，
  本地批次改动作为 feature 分支并入（GitHub 当时不可达，用 `git remote add e /e/SuzuranPetGit`
  走本地 fetch，未推送远程）。

## 二、合并与测试

- feature 提交：`3dba5b9`（基于 44aaa67 的全部本地批次：安全加固/台词池/睡眠边沿/workflow 聚合/固定台词预加载）。
- 合并提交：`454dcce`（merge-batch 分支，v2.5.26 + 本批次 = **v2.5.27**）。
- 冲突 12 处文件全部人工合并，原则：v2.5.26 侧新行为为准（banned 跨轮禁选、LINE_MOODS、
  情绪标签剥离、fs.watch 工作区监听、safePatch 白名单），本地批次语义叠加（token hash、
  lineGate、task-queue、transitionSleep、workflow 信号聚合、固定台词预加载、30 天磁盘缓存）。
- 合并中顺带修复 v2.5.23 历史模块 `append()` 首条双计缺陷（先建缓存再写盘）。
- 版本 2.5.27 写入 package.json/lock；CHANGELOG 新增 v2.5.27 段落（release.yml 会抽取）。
- `npm test`：**40 个测试文件全绿**（含 v2.5.26 的 weather/updater/walk-state/focus-watch/
  settings-patch/sse 等与本地新增的 agent-auth/safe-url/task-queue/dialogue-state/line-gate/
  lines/fixed-lines/fixed-line-cache/history-clear 测试）。

## 三、打包与部署步骤（实际执行）

1. tar 管道联合复制：工作副本 → `resources/app_legacy`（排除 .git/node_modules/release/dist/
   .mimosa/__pycache__/outputs/_backups/data/*.log；保留部署侧既有 node_modules 与
   gitignored 随包资源如 live2dcubismcore.min.js）。
2. `bash deploy/pack.sh`：app_legacy→app→app_legacy 提升、`npx asar@3.2.0 pack` 生成
   `app.asar.new`（188MB）并替换（旧件为 app.asar.old；v2.5.26 完好备份在
   `app.asar.bak-good-2526`）。
3. **踩坑记录**：第一次启动崩在 `ReferenceError: lines is not defined`——合并时误把
   `const lines = require("./src/lines")` 顶替掉了；已在 main.js 恢复导入并**重打包**，
   二次启动正常。node --check 无法发现该错（运行时才触发），教训：动过 require 区必须
   跑真实启动或 `node --input-type=module -e` 类冒烟。
4. 桌宠进程原为运行状态导致首次 `mv app.asar` 报 Device or resource busy——用户已明确要求
   重启，按交接 SOP 先 Stop-Process（5 进程）再替换。

## 四、验证结果（11:51Z 新会话）

- 进程数 5（健康基线），窗口/行走/屏障正常；
- `[ja] 预热✓` 持续输出——证明 lines 模块与日语固定台词预热链路工作正常；
- 日志无未捕获异常/失败行。

## 五、仓库状态与后续

- `merge-batch` 分支（454dcce）含全部合并结果；已 fetch 到 E 盘仓库为本地分支
  `v2.5.27-batch`（未动 main、未推送）。
- 建议用户核对后自行：`git -C E:\SuzuranPetGit checkout v2.5.27-batch`（或在 main 上
  `git merge v2.5.27-batch`），确认 diff 后打 tag `v2.5.27` 推送——release.yml 新增的
  tag↔package 版本校验、发布前 `npm test`/`check:assets`、SHA256SUMS 步骤会生效。
- 设置页新增「固定台词音频池」卡片：首次使用建议先点「开始/继续预加载」观察 5 条，确认
  音质/耗时后再放全量（~300 句，单线程串行）；云端方案会产生 API 费用，系统语音方案显示
  「无需预加载」。
- 已知边界（见 HANDOFF-20260902-* 各文档）：pendingAmbient 缺 TTS 自然结束刷新钩子、
  旧 fingerprint 缓存无总容量上限、固定台词尚未透传 fixedLineId。

## 五点五、追加修复：站着脚陷进任务栏（c797f13，已部署）

- 现象：抛掷落地位置正确（y=738 脚贴任务栏），约 5s 后「坐姿自愈」把窗口拉到 y=768
  （sink=30），但角色仍播站姿 → 脚看起来陷进任务栏。日志证据：`坐姿自愈: y=738→768 sink=30`。
- 根因：渲染层坐姿分支只认精确动画名 `Sit/sit`；用户 winter 皮肤（build_char_298_susuro_winter_4）
  的坐下动画名不精确匹配（分类器 /sit/i 能命中，说明存在 sit 系动画）→ 主进程按坐姿下沉窗口，
  渲染层却回退 Relax 站姿。
- 修复（双侧）：
  - `renderer/pet.js`：新增 `sitAnimName()`（精确 Sit/sit → 分类器 cls.sit 兜底）与
    `reportHasSit()`（皮肤加载完成后上报）；applyWalkState 坐姿分支、setSpineMood sit-guard、
    spinePhaseAnim 窗顶分支全部改用 sitAnimName。
  - `preload.js`：新增 `setHasSit` 桥。
  - `main.js`：`skinHasSit`（默认 true，未知皮肤行为不变）+ `effectiveSeatSink()`
    （无坐下动画时=0）；applySeatPosition、dragSeatUpdate 任务栏/图标磁吸、jump-perch-sink、
    坐姿自愈日志全部替换；`pet:set-has-sit` IPC 值变化时立即 applySeatPosition 校正。
- 效果：有 sit 系动画的皮肤现在真正播坐姿（下沉合理化）；完全没有的皮肤不再下沉（站姿贴沿）。
- 验证：40/40 测试通过；重新 pack.sh 部署（app.asar 188,085,177B）；新会话 spine ok、
  无异常日志。待用户实抛复验（若该皮肤 sit 系动画本身是"半站"姿态，观感仍偏沉，
  可在设置页把「坐姿下沉量」滑杆调小或归零，或告诉我动画名再收紧匹配）。

## 五点六、追加：落地站陷第二层根因 + 固定台词离线模式（6b1652c，已部署）

- 用户复测反馈：c797f13 后"还是会有，再点击一下就没了"。
- 第二层根因（渲染层动画恢复链）：抛掷落地广播 seated=true 后，`onDropped → playSpineInteract()`
  播完 Interact 用 `spinePhaseAnim()` 恢复动画——该函数此前只认 perched 不认 seated，
  坐着时返回 `spineAnimForMood("idle")`（Relax 站姿），而窗口仍在坐姿下沉位 → 脚陷；
  点击触发 walkingPause 广播 → applyWalkState 坐姿分支重新播 sit → "点一下才好"。
- 修复：`spinePhaseAnim()` 增加 `walkState.seated || walkState.perched` 分支走 sitAnimName，
  所有恢复路径（onDropped/poke/情绪回落）坐着时统一回到坐姿。
- 新功能「固定台词离线模式」（用户诉求：想听固定台词但不想跑翻译/合成引擎、释放显存）：
  - 设置页语音区新增开关（`tts-fixed-only`）→ `pet:set-fixed-only` IPC；
  - 开启：保存 `tts.fixedOnly=true`，并立即停本地 Genie/GSV 引擎（shutdownGenieServer +
    killGsvProcesses + killPortListener 9880/9881，与退出清理同链路）释放显存；
    关闭：按当前配置重新 ensureGenieServer/ensureGsvServer+warmupGsv（与启动预热同分支）；
  - 说话链路（tts-manager.ttsCloneImpl）：内存缓存 → **固定台词磁盘缓存（30 天）**命中即播；
    离线模式下未缓存不再调用引擎合成，直接返回空 → 渲染层回退系统语音（文本照常显示）；
  - 离线模式下禁用：日语翻译预热（features.startJaPrewarm 直接 return）、固定台词预加载
    （fixed-line-preloader.start 返回 FIXED_ONLY_ON，设置页提示先关离线模式）；
  - 预期用法：引擎开着 → 设置页「固定台词音频池」点开始预加载跑全量 → 开离线模式释放显存
    → 固定台词照常播，聊天回复用系统语音念（或按现有回退链）。
- 验证：40/40 测试通过；pack.sh 部署 app.asar 188,089,046B；新会话 5 进程、GSV 预热完成、
  行走正常。日志中 `[ja] 翻译异常 timeout` 为翻译 API 偶发网络超时（既有行为，非本次引入）。
- 待用户复验：① 抛掷落地稳定后是否还陷脚（现在应自动回坐姿，无需点击）；
  ② 离线模式开关往返（显存释放/恢复、缓存台词照常播）。

## 五点七、追加：光走路不前进 + 五项优化（55adfef + 9b54073，已部署）

### 光走路不前进（55adfef）
- 根因：聊天生成（busy）或拖拽暂停时主进程停止位移，但渲染层 `applyWalkState` 的
  `if (busy) return` 短路把画面**冻结在最后一帧 Move** → 原地踏步假象。
- 修复：applyWalkState 在 busy 短路前增加 `walkState.paused` 分支 → 切回站姿待机。
- 顺带：无坐下动画皮肤的全部落座点统一 `enterRestPose()`（站立歇脚，seated=false），
  并修复站立循环死锁（standLoops 到期后无 sit 动画时落入行为决策而非再入坐循环）。
- 用户皮肤实为**有** Sit 动画（`Sitd+`，分类器命中）——此前"无 sit"判断是 skel 字符串
  扫描过滤过严所致，已按 hasSit=true 行为验证正常（日志 `坐姿自愈 ... hasSit=true`）。

### 五项优化（9b54073）
1. **池勾选预加载**：设置页音频池卡片新增池复选框（全选/常用按钮），start IPC 透传
   pools 数组，预加载器按池过滤；"常用"=摸头+工作流+当前时段。
2. **TTS 结束补发 pendingAmbient**：系统语音 finish、流式末句 done、合并音频 finish
   三处回调 250ms 后 flushPendingAmbient()——后台消息不再等聊天事件才补发。
3. **离线模式徽标**：fixed-lines 状态返回 fixedOnly，卡片右上徽标显示"离线模式生效中"。
4. **旧版本缓存清理**：`clearOldFingerprints()`（16 位 hex 白名单校验）+
   `pet:fixed-lines-clear-old` IPC + 设置页按钮，换音色/语言后旧指纹目录可一键清。
5. **lineId 直查**：sendProactive 反查 manifest 稳定 id（buildManifest 按 vars 记忆化）
   → payload 带 lineId → 渲染层 speak 透传 → ttsCloneImpl 按 ID 直读磁盘缓存，
   文本匹配仅作兜底；同文本不同池/情绪不会串音。

### 已知观察（非本次引入）
- 日志中 `渲染进程异常退出 reason=crashed exitCode=-1 状态=spine/走` 今天出现 5 次
  （含部署前时段），单次即自动重载成功——项目已知偶发 GPU/WebGL 崩溃，自愈链路正常。

### 验证
- 40/40 测试通过；pack.sh 部署 app.asar 188,097,906B；新会话 5 进程、
  ja 预热/行走正常。待用户复验：① 聊天时不再原地踏步；② 池勾选预加载；
  ③ 离线徽标；④ 清理旧版本缓存；⑤ 缓存命中日志出现"（lineId）"。

## 五点八、追加：半腿被切 + 站着定格（82d7597，已部署）

- 用户截图反馈两个新症状：① 有时坐着但下半截腿被任务栏切掉；② 有时站着完全没动画。
- 症状①根因：`spineAnimForMood("think")` 把"思考"情绪映射到坐下动画
  （分类器 cls.sit / 映射表 "Sit"）——站立窗口位置播坐姿，下半身超出画布被切。
  修复：坐下系动画（isSitClassAnim）只在 `walkState.seated || perched`（窗口已按坐姿
  下沉）时才允许作为情绪动画；否则 think/sleep 回退 idle/sleep 类。
- 症状②根因（多路径）：一次性动画播完后 track0 空置 → 定格（试演结束、poke 竞态等）。
  修复：6s 看门狗巡检——非 busy/非睡眠/非试演时若 track0 无动画，按当前相位补回循环动画。
- 验证：40/40 测试通过；pack.sh 部署 app.asar 188,099,152B；5 进程正常。
  待用户复验：① 触发"思考"情绪回复时不再半腿；② 长时间观察是否还出现定格
  （看门狗最多 6s 内自愈）。

## 六、回退方法（如新版异常）

```text
1. 杀进程：Get-Process | ? Path -like 'E:\SuzuranPetGit\*' | Stop-Process -Force
2. cd E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources
3. rm app.asar; mv app.asar.bak-good-2526 app.asar   （回到已知良好的 v2.5.26）
4. 重启 exe
```

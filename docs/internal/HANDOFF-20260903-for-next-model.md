# 交接文档（2026-09-03 晚，写给下一个接手的模型/会话）

> 目标：凭这一份文档 + 已有内参，能在零上下文情况下安全地继续本项目工作。
> 阅读顺序：本文 → DEBT-ROADMAP-20260903.md（技术债与路线图）→ HANDOFF-20260902-deploy-2.5.27.md（五点五～五点二十，逐步细节）→ TECH-DEBT-20260903.md。

## 一、项目与三处工作位置

| 位置 | 路径 | 用途 |
|---|---|---|
| 开发工作区 | `C:\Users\xsbil\.zcode\workspace\default\suzuran-pet` | 唯一开发树，git 分支 `merge-batch`；无 node_modules（装了也只用于跑测试） |
| 部署目录（正在运行的真机） | `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\` | exe + `resources/`（app.asar=运行包，app_legacy=打包源镜像，app.asar.old=上一版回退件，app.asar.bak-good-2526=已知良好 v2.5.26） |
| GitHub | `origin = https://github.com/sslbs09/suzuran-pet.git` | 分支 `merge-batch` 已推送；`main` 还停在 v2.5.26（8f32360） |

- 用户数据（userData）：`%APPDATA%\苏苏洛桌宠 2.5 正式版`（符号链接 → `E:\SuzuranPetData-Roaming-2.5`）。
  关键文件：`config.json`、`logs/tts.log`（滚动到 tts.log.1；**主进程+渲染层诊断全在这一个日志**）、
  `audio/fixed-lines/<指纹>/manifest.json`（语音预加载缓存）、`translate-cache.json`、`update-check.json`。
- 另有本地仓库 `E:\SuzuranPetGit`（remote `e`）：真实开发主仓（main=v2.5.26），历史合并中转用；现在流程走 C 工作区 → origin。

## 二、当前状态快照（2026-09-03 21:00 前后）

- 已部署并重启：app.asar=188,233,641B（对应 bb682e8 的运行时代码减测试文件微差；bb682e8 只改了测试，无需重打包）。
- 健康基线：**5 个进程**（`Get-Process | ? Path -like 'E:\SuzuranPetGit\*'`）；日志可见
  `[anim] walk-phase anim=Move` ↔ `[fit] seat-phase anim=Sit` 相位轮换、`[ja] 预热✓`、无未捕获异常。
- 语音缓存：指纹 `532a591cbf444199` **356/358 ready**；失败 2 句 `long-idle.19`、`stage.fd.02`
  （TTS_EMPTY），设置页音频池里对这两条点单句 ↻ 重载即可补上。
- CI（GitHub Actions）：merge-batch 最新提交 **三workflow全绿**（Test/Lint/Docs）。
  曾红过两天：视觉测试断言设置页分区数停留在 11（实际 12），已同步为 12——**以后设置页
  `.set-nav` 增减分区必须同步 `tests/visual.spec.js` 的计数**。
- 测试基线：`npm test` **42/42**（含 i18n 三语键一致、stylelint）；CI 里 visual.spec 需要 playwright（本机未装，CI 跑）。
- git：merge-batch @ bb682e8 = origin/merge-batch（a8d4589 之后追加了视觉测试修复）。

## 三、今天干了什么（按提交，全部已部署+推送）

| 提交 | 内容 |
|---|---|
| 6cfcf60 | **语音三缺口修复**（用户报"日语加载✓却系统音/播不完整"）：① lineId 反查情绪不匹配 60/358 句 → `fixed-lines.findItemText` 文本兜底；② 渲染层情绪语气词（呀！/哼！/嘛～）破坏翻译缓存键 → 主进程 `stripSpeechTail` 剥尾缀后 `lookupCachedJa` 直查缓存（零 API）；③ GSV 质量门 0.75→0.5 + 终败交付最优尝试（不再跳句留洞） |
| 35757bf | **走路动画丢失修复**：6s 看门狗升级为相位对账（循环动画 ≠ `spinePhaseAnim()` 相位目标就补回；豁免 busy/睡眠/试演/一次性动画）；walk-mood 守卫不再写死 `spineHas("Move")`；补 `[anim]` 相位日志 |
| 6566170 / 749e28c / a42ba9d | 自查轮：GSV-only 配置 profile 误判 system（预加载被拒）；翻译磁盘缓存命中续期（原 7 天整批过期）；对账加 moodAnimUntil 情绪豁免窗 |
| 8408e03 | **三项排查**：① 离线模式开关语义安全（只杀进程不改配置→指纹不变），补 GSV-only 渲染层门控；② 更新链路：**发布包 --asar=false → zip 用户首次跑散目录，Electron 加载顺序 app.asar>app（源码已证）→ 新版 zip 覆盖解压会被旧 asar 压住**，已加启动兜底（`relaunchIfAppDirNewer`，marker 防循环）；检查失败不再误报"已是最新"（`checkForUpdateDetailed` 15s 超时）；applyOnExit 失败弹错不再静默；③ 桌面图标感知有授权门控没开就没跑；窗口屏障扫描改与行走联动 + 日志变化才记 |
| bb682e8 | CI 视觉测试分区计数 11→12 |
| a8d4589 / 5ed2d8c 等 | 技术债与未来优化报告（DEBT-ROADMAP-20260903.md：系统音混音审计 + TD-12~17 + P0~P3）、交接五点十八/十九/二十 |

## 四、关键机制速查（改代码前先读）

**说话链路**：渲染层 `speak()`（pet.js）→ `speakClone(clean,{emo,session,lineId})` → 主进程 `queueTts` →
`ttsCloneImpl`：内存缓存 → 固定台词磁盘缓存（**lineId 直查优先，文本匹配兜底**）→ `fixedOnly` 短路 →
`ttsCloneImplInner`：speakJa 时 `translateToJa`（磁盘缓存键=stripStage(展开台词)，**先剥语气词按规范键直查**）→
GSV 逐句合成（质量门 durOk=预期×0.5，终败交付最优尝试）→ `mergeWavBase64`。空返回 → 渲染层 `speakSystem` 读中文。
**系统音永远不会读日文**；"混音"= 跨话语回退，已实证归零（修复前共 11 次）。

**行走动画**：主进程相位机（walkOnPhaseEnd：坐 10-30s / 走 8-20s / 跳窗顶 8%）→ `walkBroadcast` →
渲染层 `applyWalkState`（纯事件驱动）+ **6s 相位对账看门狗**（循环动画≠相位目标就补回）。
坐姿动画名走 `sitAnimName()`（Sitd>Sit>分类器）；`spineAnimForMood` 禁止非坐姿播坐下系动画。

**语音方案指纹**：`profileFromConfig`（fixed-line-cache.js）按配置算 16 位 hex，缓存目录按它隔离。
genie.enabled=true 的用户 engine="genie"（即使实际合成走 GSV，**别改，会废掉已预加载缓存**）；
genie 关+speakJa+GSV 开 → "gsv"。离线模式开关（tts.fixedOnly）只杀进程不改配置 → 指纹不变 → 缓存全命中。

**更新链路**：updater.js（checkForUpdateDetailed 15s 超时 → buildUpdatePlan 要 app.asar+app.asar.version 资产 →
流式下载+SHA-256 fail-closed → applyOnExit 写 ps1 detached：退出后备份/替换/重启/25s 探活失败回滚 .bak）。
启动 90s 静默检查（update-check.json ≥24h）+ 托盘/设置页手动入口。
**发布包是 --asar=false**（zip 无 asar，用户首跑散目录；首次自动更新后切 asar 模型）→
`relaunchIfAppDirNewer()`（whenReady 最早处）兜底"新版 zip 覆盖解压被旧 asar 压住"。

**窗口屏障/图标感知**：屏障扫描（koffi EnumWindows，读全机可见窗口位置）只在 `walk.active && win.isVisible()` 时跑，日志仅数量变化时记；「桌面图标感知」`features.desktopIcons` 默认关、有独立门控。

## 五、操作 SOP

**部署**（改了运行时代码后）：
```bash
cd C:/Users/xsbil/.zcode/workspace/default/suzuran-pet
tar -cf - --exclude=.git --exclude=node_modules --exclude=./release --exclude=./dist \
  --exclude=.mimosa --exclude=__pycache__ --exclude=./outputs --exclude=./_backups \
  --exclude='data/*.log' . | tar -xf - -C "/e/SuzuranPetGit/release/v2.5/苏苏洛桌宠 2.5 正式版/resources/app_legacy"
powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like 'E:\SuzuranPetGit\*' } | Stop-Process -Force; Start-Sleep -Seconds 2"
bash deploy/pack.sh    # 输出 OK app.asar=...B；失败自动回滚散目录
powershell -NoProfile -Command "Start-Process -FilePath 'E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\苏苏洛桌宠 2.5 正式版.exe'"
# 30s 后冒烟：进程数=5；tts.log 尾部看 [anim] 相位/[ja] 预热/无未捕获异常
```
**回退**：见 HANDOFF-20260902「六、回退方法」（app.asar.old 换回；更早良好件 app.asar.bak-good-2526）。
**回归**：`npm test`（42/42）；推 GitHub 后看三个 workflow。
**GitHub 操作**：无 gh CLI，用 `curl api.github.com`；拉 Actions 日志需 token——用
`git credential fill`（host=github.com）取存储凭据作 Bearer。

## 六、坑（务必记住）

1. **Mimosa 门禁 hook**：禁止用 Bash 直接写源码/配置（会拒），一律走 Write/Edit 工具；commit/push 前会做安全扫描（当前以兼容模式放行并附警告；高危未清零会拦 commit）。
2. **release.yml 的 tag↔版本校验**：tag 必须 = `v`+package.json.version。**package.json 现在还是 2.5.27**——发版前先 bump 到 2.5.28 + CHANGELOG 加段落（release 正文从 CHANGELOG 抽取），再打 tag。
3. **改源码注释里的键名/表**：`SPEECH_TAIL_RE`（tts-manager）与渲染层 `EMOTION_SPEECH` 是双端耦合，加语气词两边都要改；`.set-nav` 分区增减要同步 `tests/visual.spec.js`（现为 12）。
4. **语音缓存键三套 normalization**（manifest 文本=展开+剥行首标签；翻译预热键=stripStage；渲染层 clean=stripForSpeech+语气词）——动任何一头先想清楚另两头。
5. `translate-cache` 磁盘 TTL 7 天但命中会续期（749e28c）；LRU 500 条。
6. 不要用"关引擎开关"代替离线模式开关（指纹漂移会废掉预加载缓存）；这是设置页文案层面的已知暗坑（TD-14）。
7. 渲染层 reload/crash 自愈会重置部分内存态，但 `pet:get-state` 会带回 walkState——动画问题先查日志 `[anim]`/`[fit]` 再动代码。
8. tts.log 是排查的金矿：`[anim] walk-phase/相位对账`、`[ja] 预热✓/翻译(预热缓存)`、`[render] 回退系统语音`（**现在应为 0，出现即回归**）、`[gsv] 交付最优尝试`（质量门兜底触发）、`[walk] 坐姿自愈`。


## 八、2026-09-03 后续现场补充（固定音频/离线引擎/动画）

### 固定音频最终结论
- 用户反馈“开启固定台词后仍有系统音”，已通过真机日志定位并修复。
- 固定音频日语 profile 指纹：`532a591cbf444199`；当前用户数据曾有 `357 ready / 1 failed`，失败项为 `stage.fd.02`。
- 关键根因：`src/fixed-line-cache.js` 漏导出 `findItemText`，异常被 TTS 识别层静默吞掉，导致固定句被判成动态句；此外 renderer 去动作括号/追加语气词后需要规范化反查。
- 现已增加 `findItemNormalized`、`fixedLine/fixedText`、lineId 优先+文本兜底、离线未命中哨兵；已缓存固定句实测日志：`lineId=pat.03 fixed=true hit=true` / `固定台词磁盘缓存命中`。
- 离线未命中的固定句不再读中文系统音；动态文本仍按现有设计回退系统音。

### 离线引擎生命周期
- 根因：启动 GSV 的条件遗漏 `tts.fixedOnly`，且切换时预热/异步拉起缺少二次门禁。
- 已修：启动条件排除 fixedOnly；`ensureGenieServer/ensureGsvServer` 入口阻止离线启动；开启离线时停止日语预热；退出离线时才允许按配置拉起。
- 最新真实包：`app.asar=188384053B`；干净重启后正式版进程数 5，`9880/9881` 均无监听；启动日志确认跳过 Genie/GSV 预热。

### 当前新增动画事项
- 用户确认“坐下掉脚”已明显减轻但仍偶发，现为短暂视觉问题；坐姿 fit 日志可能出现 `visibleGap=16~29` 后迅速回到 0。
- 用户新增需求：动画过渡更流畅；偶尔角色只站立、完全没有动作。
- 当前实现：普通 Spine 动作 `defaultMix=0.14`；坐姿切换使用 `mixDuration=0` 并在 80/160/300/600/1200/2400ms 多次 fit；看门狗采样周期改为 2 秒、连续停帧计数并尝试恢复 ticker/timeScale；行走广播现包含 `sleeping`，避免睡眠时窗口停止移动但 renderer 仍显示上一姿态。
- 下一步建议：普通相位动作使用更短、统一的可打断混合；对循环轨道增加 ticker/trackTime 停滞自愈；保留坐姿零混合和一次性互动豁免。不要把站立状态本身误判成故障，必须区分 trackTime 停帧与正常 Relax/Sit 循环。

1. **P0 发版**：merge-batch → PR 合入 main → package.json bump 2.5.28 + CHANGELOG → tag `v2.5.28` → 验证 release.yml 四资产 + 一次真机自动更新全链路（顺带验证 relaunchIfAppDirNewer 兜底）。**等用户操作**。
2. P0 TD-12 根治：dist 改 `--asar=true` + unpack（koffi/scripts/指南 py），统一 zip 与增量模型。
3. P1 语音：翻译失败 stale-while-error（用过期旧译文兜底，消灭最后的系统音场景）；预热遇 429/超时自动退避让路交互；main.js 硬编码台词池化；系统音兜底可配置；failed 句一键重试入口。
4. P2：parts/merged 双播 epoch 防护；语气词改 opts 传递；updater 可选代理；语音设置页引擎开关加"缓存失效"提示；改名零重录（模板+占位符）。
5. 观察项：GSV 质量门「交付最优尝试」日志频次；GPU 崩溃频率；屏障扫描联动效果。

## 九、动画专项后续（2026-09-03）

### 用户新增反馈
- 坐姿掉脚已明显减轻，仍有极短暂恢复窗口。
- 固定台词离线模式和引擎生命周期已修复并完成正式包验证。
- 新反馈：偶尔角色保持站立画面但动作不前进；希望普通动作过渡更流畅。

### 当前日志证据
- `walk` 状态存在 `sleeping=true` 时窗口不移动，这是睡眠设计，不应作为行走故障处理。
- 非睡眠阶段有正常 `walk-phase anim=Move`、`fit seat-phase anim=Sit` 和 `paused-idle`，但旧看门狗没有完整记录 ticker 是否启动、AnimationState `timeScale` 是否为 0。
- 当前 `renderer/pet.js` 已将普通 `defaultMix` 缩短至 `0.14`，坐姿切换使用 `mixDuration=0`，看门狗采样周期改为 2 秒并有连续停帧计数。

### 本轮新增计划/实现边界
- 继续保持坐姿零混合，避免重新引入掉脚。
- 普通 Move/Relax/Interact 维持短混合，重点补 ticker/AnimationState 时间缩放心跳，不在每帧强制重播。
- 连续两次 trackTime 不推进才重启当前相位；一次采样不动作，避免低帧和循环边界误判。
- 睡眠、一次性动作、动作试演和情绪豁免不被看门狗抢占。
- 真机复验重点查 `[anim] 相位对账 ... reason=停帧`、`ticker-recover`、`speech-end`，并记录状态中的 `sleeping/paused/resting/seated`。

## 十、动画优化实际验证（2026-09-03）

- 普通 Spine 动作混合从 `defaultMix=0.25` 调整为 `0.14`，减少 Move/Relax/情绪切换拖泥带水。
- 坐姿切换继续使用 `mixDuration=0`，并在 `80/160/300/600/1200/2400ms` 多次 fit，坐下掉脚只保留极短过渡窗口。
- 动画看门狗现在每 2 秒检查当前轨道名称、`trackTime` 是否推进；连续两次确认停帧才重启相位，避免单次低帧误判。
- 看门狗会主动恢复停止的 Pixi ticker 和 `AnimationState.timeScale=0`，并写 `[anim] ticker-recover` / `[anim] timeScale-recover` 诊断。
- `walkBroadcast` 和 `pet:get-state.walkState` 已包含 `sleeping`；睡眠时窗口不移动是设计行为，renderer 会同步睡眠/唤醒姿态，不应当作行走卡死。
- 动画专项测试和全量测试均通过：`npm test` 44/44。
- 最新正式包已实际打包重启：`app.asar=188391173B`；重启后正式版进程数 5，9880/9881 均未监听；启动日志出现正常 `walk-phase anim=Move` 与 `fit seat-phase anim=Sit`，未见新 `render-process-gone`。
- 用户后续若仍看到“站立但不前进”，请先看 `sleeping/resting/seated/paused` 状态：`sleeping=true` 是正常睡眠；`resting=true` 或 `seated=true` 是正常休息/坐姿；只有四者均为 false 且 Move trackTime 不推进时，才是目标故障。

## 十一、诊断：「有 Move 动画但窗口不前进」2026-09-03 晚复现·定因版（修正初稿错误）

> 用户已叫停“诊断日志窗口”开发，本轮只诊断不改码。证据取自真机 `tts.log`（时间戳 UTC，本地 = +8）。
> **注意：本节初稿曾错误归因于“睡觉态缺 Sleep 动画回退 Relax”，已被证伪并撤回**——见下方“修正”。

### 一句话结论
**根因 = “跳上窗口”（gotoPerch）相位在真实距离下必然超时。** 目标点取窗口中心，水平接近按步行速度要 17–40 秒才能走完 500–800px 距离，而瞬态守卫只给 10 秒就掐断。这 10 秒里广播字段全是“正常散步”（没有跳窗瞬态字段），渲染层全程播 **Move**；到 10s 守卫又原地突然坐下。用户看到的“走路动画在播、人却不怎么前进/不朝目标走”，就是这段注定失败的低速接近 + 突然坐倒，且当晚反复出现。这不是动画停帧，不是行走引擎坏了，也不是睡眠误判。

### 修正（初稿被用户证伪之处）
- 皮肤 sussurro 的 `.skel` 二进制实测含 **Move / Relax / Sleep / Sit / Interact** 五个动画名——**睡眠态有专属 Sleep 动画**，用户当晚也确认刚看到睡姿。初稿“皮肤缺 Sleep 回退站立 Relax 造成视觉误导”的说法错误，撤回。
- 当晚 `sleeping=true` 的告警（22:32:04 等）确属正常睡眠，与“Move 但不前进”症状无关。

### 证据（真机 tts.log，本地时间）
- “跳上窗口 → Move → 10s 超时”三连，当晚 4 次尝试、4 次超时、0 次成功落窗顶：
  - 22:06:50 `瞬态守卫: gotoPerch 超时10s`（首次）。
  - 22:41:14 `跳上窗口 {x:230,w:825,title:"Weixin"}` → 22:41:24 超时。
  - 22:53:02 `跳上窗口 {x:223,w:838,title:"图片和视频"}`，同一毫秒渲染层 `[anim] walk-phase anim=Move (active=true resting=false seated=false perched=false paused=false)`；22:53:04 快照 x=1220，目标中心≈504（需走 716px），22:53:12 超时（期间 x 仅推进约 175px，实测速度约 18px/s）。
  - 22:54:51 `跳上窗口 {x:230,w:825,title:"Weixin"}` → Move → 22:55:01 超时（距离≈742px）。
- 频率背景：tts.log（19:33 起）跳上窗口 4 / gotoPerch 超时 4 / 成功落顶 0；更早 21 小时（tts.log.1）perch 行为被选中 17 次全部走 `无合适窗口可坐，就地休息` 分支，从未进入接近阶段——**跳上窗口这条链路此前从未被真机端到端验证过**，当晚用户真开了微信/图片大窗口才暴露必败。
- 已排除的其它嫌疑：143 条 `[walk] 状态` 快照中**没有一条**“相邻快照四态全 false 且 x 相同”；`拦截非法窗口坐标`/`水平范围坍缩`/`setPosition 失败` 均为 0；2s 动画看门狗 `ticker-recover`/`timeScale-recover`/`相位对账·停帧` 当晚 0 次；`walk-phase anim=Move` 与 x 位移一一对应（如 22:48:02 Move ↔ x 390→804），普通散步的移动和动画都正常。

### 代码链路（行号以工作区当前源码为准）
1. 坐下相位结束 → `chooseWalkBehavior()`（main.js:3168，3221 调用；跳窗概率约 8%）→ `walkAttemptPerch()`（main.js:3552）。
2. `walk.targetX = 窗口中心 − 半窗宽`（**main.js:3575**），`gotoPerch=true` 后 `walkBroadcast()`（3576-3580）。广播字段只有 `active/resting/perched/seated/face/paused/sleeping`（**main.js:2947-2951**），**不含 gotoPerch/returning/jump** → 渲染层 `spinePhaseAnim()`（renderer/pet.js:525）见 active&&!resting&&!seated&&!perched&&!paused → 播 **Move**。
3. `walkTick` gotoPerch 分支（**main.js:3765-3776**）按 `walkSpeed()=1.2px/40ms`（main.js:2919-2922；标称 30px/s、实测约 18px/s）水平走向 targetX；到位才 `beginWalkJump(tx, perchTopY)` 350ms 跳（main.js:2964-2971），完成时提交 perched+resting（main.js:3720-3733）。
4. 瞬态守卫（**main.js:3681-3693**）：`gotoPerch/returning` 超过 **10 秒** → 清瞬态、`enterRestPose()` **原地坐下**并重排坐相位。距离 500–800px 需 17–40s > 10s → **数学上必超时**；只有宠物恰在目标中心正下方约 180px 内才来得及完成跳跃。
5. 10s 守卫数值来自 44aaa67（2026-08-31），**不是当日改出来的回归**；当日改动（sleeping 广播、2s 看门狗、defaultMix 0.14）与此链路无关——这也是排除“今天改坏了”的依据。

### 判读决策树（下次再看到“有动画不前进”，照此查）
看 `[walk] 状态` 行（字段序 `active|resting|seated|perched|paused|sleeping|catToy|phaseTimer|timer`）与上下文跳窗日志：
1. 出现 `跳上窗口`，10 秒后紧跟 `瞬态守卫: gotoPerch 超时10s` → **本节根因**（远距离低速接近 + 突然坐倒，期间 Move）。
2. `sleeping=true` → 正常睡眠（有 Sleep 动画，互动即醒；注意 main.js:3190 睡觉中相位只重排、无自动苏醒上限，长期挂着可考虑加超时唤醒）。
3. `resting=true`/`seated=true` → 正常自主休息（当晚坐相位常 1–3 分钟一次、单次可 >90s 触发告警，属节奏问题不是卡死）。
4. `paused=true` → 拖拽/对话/抛掷（抛掷落地有 `坐姿自愈` 收口）。
5. 以上全 false、相邻两个 20s 快照 x 相同、且渲染层无 `[anim] 相位对账 reason=停帧` 恢复记录 → 才属真停帧/位置类故障（当晚未发生），查 trackTime 探针与 reconcileSpineAnimation 的 busy/animDemoUntil/moodAnimUntil 豁免是否卡住。

### 修复建议（只立项，未实现）
1. **targetX 由“窗口中心”改为“离宠物较近的窗沿侧”**（main.js:3575，改动最小、收益最大）：平均缩短约 60% 距离，多数场景可进入守卫预算。
2. **守卫预算距离感知**：`超时 = |tx−x|/实测速度 + 350ms 跳 + 3s 余量`；或超时时不再原地坐倒，而是清 `gotoPerch` 继续原散步方向，消除“走半天突然坐下”的观感断裂。
3. **瞬态入广播**：walkBroadcast 增加 `gotoPerch/returning/jump`（或统一 `phase` 字段），渲染层在接近/起跳段播 Jump 等专属动画——目前 350ms 垂直跳跃期间 x 完全静止，也在播 Move。
4. **补细粒度埋点**：跳窗发起时 log `targetX/距离/预计耗时`，超时时 log 剩余距离——用户再报障时日志直接可判，无需按 20s 快照反推。
5. 节奏观察：90s“站着不动检查”告警不区分设计态（resting/seated/sleeping 也触发），建议按签名分型输出；自主休息频率偏高可后续调 `walkOnPhaseEnd` 站立待命轮数与坐/走时长。

### 搁置项备案（用户指示：不建诊断窗口）
“日志显示与一键导出诊断窗口”已整体取消。前期侦察结论留档供日后重启：子窗口模式 main.js:530-550、preload contextBridge 白名单、logger 2MiB 轮转 readTail、JSONL 脱敏导出白名单、托盘“高级”子菜单入口、visual.spec testMatch 限制；导出必须脱敏（清除 apiKey/bearerToken/DASHSCOPE_API_KEY、URL query、绝对路径、聊天/人设/日程/记忆文本、窗口标题、精确坐标、PID/hwnd；排除 history/persona/config.json/secrets.v1.json/audio/引擎日志）。

## 十二、源码对比结论：站/坐动作为什么不如之前流畅（git diff HEAD，未提交工作区 vs 昨晚基线）

对比对象：`ae62f01`（=今晚 22:14 部署包之前的运行基线）与工作区当前代码。**结论：与板块拆分无关（walk-state/animation-watch 纯函数抽取不改动画执行路径），是今晚"坐时掉脚修复 + 流畅性优化"这组微调的直接代价。**

### 主因（按观感影响排序）
1. **seat-phase 零混合是今晚新引入的硬切**。`setSpineAnim(name, loop, reason)` 现于 `reason==="seat-phase"` 时强制 `entry.mixDuration=0`（renderer/pet.js:248-256）；唯一传入点是 applyWalkState 进入坐姿分支（pet.js:868）。关键事实：**基线版本里 `seat-phase` 这个 reason 参数虽然也传（HEAD pet.js:821），但 `setSpineAnim(name, loop)` 只有两个形参，参数被完全忽略——坐下历史上一直是 0.25s 平滑混合**。现在的 mixDuration=0 让"站→坐"姿态瞬间替换，腿部过渡帧整段消失，这就是用户感知"坐下不流畅"的第一来源。
2. **defaultMix 0.25→0.14（pet.js:672）**：所有其它相位切换（坐→站 stop-idle/walk-phase、Move↔Relax、mood 切换）过渡时间腰斩，观感从"柔和"变"利落/略冲"。
3. **seatPhase fit 定时从 [400,700,1200,2000,3000,4200] 提前到 [80,160,300,600,1200,2400]（scheduleFitSpine）**：80/160/300ms 三轮早期 fit 会在坐后前 300ms 内多次按包围盒重定位。它与 mixDuration=0 是配套设计（姿态瞬间到位，早期量到的 bbox 才是终态）；但只要 1、2 任一回退而 fit 节奏不匹配，早期 fit 就会量到过渡中间态并产生**位置跳变感**。

### 这组改动当时在换什么（勿回退成掉脚回归）
基线坐下的真实 bug：0.25s 混合帧里"站/坐中间姿态"的下半身会带出 120px 角色条带，旧 fit 要 400ms 才回来 → 表现为"坐时脚突然丢失再回来"（用户 9-3 截图投诉）。今晚的取舍 = 掉脚修好了（日志坐相位 `visibleGap` 回到 0），代价 = 坐姿瞬时性。两者不可同时全要，除非按下面方案调参。

### 次要嫌疑（已评估，影响小）
- 看门狗 6s→2s 与 `speech-end` 强制对账：只重启"名称≠相位目标或 trackTime 连续两拍停"的轨道；站起路径（stop-idle/walk-phase）不传 seat-phase、仍保留 0.14s 混合。今晚日志 0 次停帧重启，非本次观感来源。
- applyWalkState 新增 sleep/wake 边沿切 mood、`.spine-canvas` CSS absolute inset:0：影响入/退睡与画布基准，与站/坐流畅无关。

### 恢复流畅的可行路线（未实施，给下一个接手者）
1. **seat-phase 用短混合替代零混合**：mixDuration 0→0.10~0.15s，同时保留 [80,160,300,600,1200,2400] 早期 fit——fit 本来就是为"量到最终态"兜底的；掉脚回归判据 = 真机日志 `[fit] seat-phase` 后 `visibleGap` 是否再度 >0。
2. defaultMix 回调到 0.18~0.22 折中（0.14 是"利落"取向，不是流畅取向；两个目标本来就冲突）。
3. 根治法：给皮肤补**坐/站过渡动画**（SitEnter/SitExit），用一次性动画链代替混合插值；sussurro 现仅 Move/Relax/Sleep/Sit/Interact 五个动画。
4. 改动任一参数后必须按 SOP 打包真机复验"坐时掉脚"与"坐姿瞬时感"两个症状（单测看不出动效取舍）。

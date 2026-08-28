# 交接文档 · Live2D 优化清单执行（2026-08-29 深夜开工）

> 写给接手的模型/开发者：本文档自包含，按"已完成 → 进行中 → 待做"组织。
> 用户已睡，委托自主推进。**规矩：①每完成一项更新本文档 + git commit（本地，不 push——等用户醒来验收后再 push）；②动手前 git 状态确认（备份点见下）；③写文档用 humanize 规范；④小步验证，改完同步正式版重打 asar 实测。**

## 备份点

- git：`b2d70e6`（拖拽修复+输入栏居中，已 push）之后的本地 commit 均未 push
- 上一轮已 push：Live2D v1（e0f0b17）、文档（b41aeee）、修复（b2d70e6）

## 任务清单与状态

| # | 任务 | 状态 |
|---|---|---|
| 1 | 新手教程收进 dev 仓库 | ✅ 完成（9 篇入库，本地 commit） |
| 2 | Live2D 皮肤选择 UI | ✅ 完成（实测通过） |
| 3 | Live2D 情绪联动（setMood → 表情/动作） | ✅ 完成（live2d 模式运行验证） |
| 4 | 发布包重打（含 Live2D + API 指南）+ VM 复测 | ⬜ |
| 5 | Live2D 放下/戳一戳动作联动（最小版） | ✅ 完成（poke 随机 Tap） |
| 6 | rig 物理摆动 | ⏭️ 跳过（见下方说明） |
| 7 | CHANGELOG / README 补 2.5.0 账 | ✅ 完成（v2.5.0 段 + 2.5 亮点节） |
| 8 | Cubism 2 支持 / 安全测试 | 长期池，本轮不做（安全测试受用户约束：须 VM 隔离 + 专门安排） |

## 关键环境

- dev：`E:\SuzuranPetGit`；正式版：`E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版`
- 部署：改 dev → 复制到 `正式版/resources/app_legacy/` → 停桌宠 → `bash deploy/pack.sh` → 重启 exe
- 验证：`logs/tts.log`（AppData/苏苏洛桌宠 1.1 正式版/logs/）、/health 127.0.0.1:8765、截图判读必须走 vision skill（`node C:\Users\xsbil\.zcode\skills\vision\vision.js <png> "问题"`）
- git push 认证：Windows 凭据管理器（`git credential fill`）；**本轮一律不 push**
- 用户当前 renderMode：live2d（haru 内置示例）

## Live2D 现状速查（v1 已上线）

- 渲染模式第四态：`src/render-mode.js` RENDER_MODES；自治渲染 `renderer/live2d-runtime.js`（Live2DRuntime.init/destroy）
- 模型扫描：`main.js` pet:live2d-list（内置 `renderer/live2d/models/` + userData `assets/live2d/`，后者 pet-user:// 协议）
- 渲染层生命周期：`renderer/pet.js` 的 initLive2d/destroyLive2d（onRenderModeChanged + 启动恢复 + setRenderMode 离开清理）
- 已修 bug：拖拽（isPetUI 命中列表 + mousedown 绑定）、输入栏居中（body.live2d-mode）
- haru 模型资源：expressions F01-F08、motion Idle×3 + Tap×2（m05/m07/m14/m15 + idle）、physics

## 第 2 项实现记录（✅ 完成，2026-08-29）

- 设置页加 `data-rm="live2d"` 区块：模型 radio 列表（`settings.js` loadLive2dSkins，点选即时切换）；rm-hint 文案加 live2d 分支
- `main.js`：`pet:live2d-select` IPC（保存 config.live2dSkinId + 广播 `pet:live2d-changed`）；`pet:get-state` 加 live2dSkinId
- `pet.js`：initLive2d(preferId)——选中 id 优先，其次内置 builtin/，否则第一个；onLive2dChanged 同模式热重载；启动恢复传 state.live2dSkinId
- `preload.js`：live2dSelect / onLive2dChanged；`deploy/config.template.json` 加 live2dSkinId: ""
- 实测：userData 放 haru2 副本，config 设 live2dSkinId=user/haru2 → 重启日志 `[live2d] 模型就绪: haru2` ✓；已还原默认内置 haru（userData 的 haru2 留着给用户测 UI 切换）

## 第 3 项实现记录（✅ 完成）

- `renderer/live2d-runtime.js` 加 `setMood(mood)`：情绪映射 Tap 动作（happy/wave→Tap[0]，surprised/angry/sad 等→Tap[1]，按模型 Tap 数量取模兜底），priority=force 播一次自动回 Idle；1.5s 节流防连发抽搐；idle/sleep 不干预（库自动循环）
- `renderer/pet.js`：setMood 分发加 `live2dActive` 分支 → setLive2dMood
- 注意：haru 的 Tap 动作具体观感未逐个核对，映射表 `MOOD_MOTION` 在 live2d-runtime.js 顶部，按实际效果调 index 即可
- 实测：live2d 模式启动正常（模型就绪日志 + 5 进程），点击角色的 Tap 反应为库自带

## 第 5 项实现记录（✅ 完成）

- `live2d-runtime.js` 加 `poke()`：随机 Tap 动作（800ms 节流）；`pet.js` onDropped（放下/扔出落地）时触发
- 实测：live2d 模式运行正常

## 第 6 项跳过说明（⏭️）

rig 物理摆动暂缓。理由：rig 的基础显示问题（耳朵不显示/图层错位，§107/108）用户已明确放弃修复、保持原始状态；在未修的地基上加物理摆动，观感收益存疑且加深实验耦合。建议：待 rig 显示问题重新提上日程时一并做；Live2D 侧不需要——haru 自带 physics3.json 已自动生效。用户醒来若坚持要，可做最小版：rig-runtime tick 里对 headwear/ears 图层加正弦微摆（独立于显示 bug）。

## 用户新增需求（08-29 深夜第二轮，✅ 已处理 2 项 + 1 项待信息）

1. **✅ 文档中心 bug 修复**：HTML 类文档（使用说明/语音指南/API 指南）全部点不开——file:// 中文路径未编码。修复：`main.js` docs:read 改用 `require("url").pathToFileURL()`（md 类不受影响）。
2. **✅ 懒人开箱教程**：新增 `!!开箱必读-先看我.html`（正式版根目录 + 文档中心"使用说明"组首位）：三步上手、SmartScreen 警告处理、语音等待说明、**配置要求表（聊天/中文语音不需要显卡）**、故障排查（日志位置 tts.log）、禁做事项。
3. **⏳ 待信息：朋友设备"点击就塌陷"**——无法远程复现。需要用户提供：桌宠版本、渲染模式（GIF/Spine/2.5D/Live2D）、显卡型号、屏幕分辨率+DPI 缩放、`logs/tts.log`。已通过开箱必读的"遇到问题"节建立日志回传通道。可疑方向：低配核显 WebGL 上下文丢失（render-process-gone 已有钩子）、DPI 缩放、点击触发的动画切换崩溃。
4. **⏸ VM 复测被新需求打断**——VM 启动命令被取消，VM 处于不确定状态（可能关机）。复测清单仍有效（asar 更新法 + live2d 模式验证），下次继续。
5. **发布包**：完整版 9721MB + 轻量版 238MB 已重打并验证 asar（187,613,769 最新，Live2D+文档中心+API 指南全含）；**注意**：开箱必读与文档中心修复是在 zip 重打之后加的，**最新 asar 187,613,769 还没进 zip**——发前需再重打一次（publish.ps1/publish-lite.ps1）。

## 设备适配（08-29 深夜第二轮，✅ 防御性适配完成）

结论：行走引擎是时间基准（setInterval + dt），刷新率无关 ✓；窗口布局用 CSS 像素（DPI 感知）✓；spine/live2d 加载失败已自动回退 GIF ✓；渲染进程崩溃已有自动重载+熔断 ✓。本轮补的防御：
- `bindCtxLost(canvas, tag)`：spine/live2d 画布 WebGL 上下文丢失（低配核显常见）→ preventDefault + 上报日志 + `pet:reload-renderer` 自愈重载（主进程 60s 节流）
- 启动时 `app.getGPUFeatureStatus()` 检测软件渲染/无硬件加速 → 日志提示
- 朋友的"点击塌陷"仍需日志定位（开箱必读已建回传通道）；若为 context lost，本轮修复直接覆盖

## RP 深化（08-29 深夜，✅ 显式记忆指令完成）

调研结论：roadmap B 原列的项大半已存在（长期记忆 §51/103、羁绊 10 级+阶段解锁台词、向量记忆回引 §102、采样参数 §65、主动搭话 §66、情绪语音 §67/70）。本轮补的真短板：
- **显式"记住"指令**：聊天说「记住/帮我记一下/记牢 xxx」→ 正则提取 → `memory.addFacts(type:"manual")` 必记（不受规则提取宁缺毋滥影响）+ toast 确认。正则 `main.js` 聊天链路，分隔符可选（"记住我喜欢草莓"✓），短于 2 字不记。设置页记忆管理可见可删（type=manual）。
- 其余 RP 项均已存在，无重复建设。

## 最新 asar/包状态（重要）

- 最新 asar：**187,705,922**（含全部：Live2D v1+皮肤选择+情绪+poke+文档中心修复+开箱必读+设备适配+显式记忆）
- **两个 zip 是旧 asar（187,613,469）**——发前需重打（publish.ps1 / publish-lite.ps1）
- VM 复测：被新需求打断未完成（VM 处于不确定状态，下次 startvm 后按 asar 更新法复测）

## 验收与 push（用户醒来后）

1. 用户验收各功能（拖拽/皮肤切换/情绪反应等）
2. 验收通过 → `git push origin main`（本地 commits 一次性上去）
3. 若要发新包：`deploy/publish.ps1`（完整版）+ `deploy/publish-lite.ps1`（轻量版）+ Release 资产替换

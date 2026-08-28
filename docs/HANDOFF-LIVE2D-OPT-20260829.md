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
| 5 | Live2D 行走/坐姿联动（最小版：放下播动作） | ⬜ |
| 6 | rig 物理摆动 | ⬜ |
| 7 | CHANGELOG / README 补 2.5.0 账 | ⬜ |
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

## 验收与 push（用户醒来后）

1. 用户验收各功能（拖拽/皮肤切换/情绪反应等）
2. 验收通过 → `git push origin main`（本地 commits 一次性上去）
3. 若要发新包：`deploy/publish.ps1`（完整版）+ `deploy/publish-lite.ps1`（轻量版）+ Release 资产替换

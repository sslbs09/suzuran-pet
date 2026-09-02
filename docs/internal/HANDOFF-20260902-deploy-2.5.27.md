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

## 六、回退方法（如新版异常）

```text
1. 杀进程：Get-Process | ? Path -like 'E:\SuzuranPetGit\*' | Stop-Process -Force
2. cd E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources
3. rm app.asar; mv app.asar.bak-good-2526 app.asar   （回到已知良好的 v2.5.26）
4. 重启 exe
```

# 睡眠状态与工作流信号聚合交接记录（2026-09-02）

> 本批处理两个问题：普通主动消息误唤醒睡眠角色；Agent workflow 与 workspace watcher 连续抢话。未部署正式版、未推送远程、未删除 userData。

## 一、本批已完成

### 1. 睡眠状态统一为边沿语义

- 新增 `src/dialogue-state.js` 的 `transitionSleep(previous, next)`。
- `main.js` 的 `pet:set-sleeping` 只在真实状态变化时触发 `sleep` 或 `wake` 人格台词；重复发送相同状态不会重复触发。
- `renderer/pet.js:setMood()` 统一维护 `isSleeping` 与 `awake`：所有 GIF/Spine/Live2D/PSD 路径进入 sleep 都会设置统一状态。
- `wake()` 现在以 `isSleeping || !awake` 判断真实唤醒，先同步主进程恢复行走，再播放 surprised（非 busy 时）。
- `pet:proactive` 收到普通后台消息时：
  - 清醒状态正常显示/切换情绪；
  - 睡眠状态显示消息和语音，但不调用非 sleep `setMood`，不会通过 `setSleeping(false)` 隐式唤醒。
- `sendProactive()` 将 `force` 传给 renderer；显式提醒仍可按原策略到达。

### 2. workflow/workspace 信号聚合

- `src/dialogue-state.js` 新增 workflow signal state：记录 pending、来源集合、最后信号时间和统一冷却。
- `main.js` 新增 `emitWorkflowSignal()` / `consumeWorkflowSignalNow()`：
  - Agent workflow 与 workspace watcher 不再各自直接消费台词；
  - 短时间内多个来源合并为一个待发送信号；
  - busy（主窗口聊天或 Agent 任务队列 queued/running）时保留 pending；
  - sleeping 时保留 pending；
  - 统一消费后再走现有 `sendProactive()` 和 `lineGate`；
  - gate 拒绝时重新入队并延迟重试。
- `task-queue.js` 增加 `isBusy()`，避免 completed 任务在 60 秒状态保留期间误阻塞后台台词。
- workspace watcher 的最小冷却从错误的 60 分钟钳制改为 1 分钟，默认配置 5 分钟现在按配置生效。
- workflow 与 workspace 的台词来源仍使用同一个 `WORKFLOW_LINES` 池，但发送时机已统一。

### 3. renderer 后台消息保护

- `renderer/pet.js` 增加 `pendingAmbient`。
- 普通后台消息在聊天生成、语音合成或语音播放期间不覆盖气泡、不抢占 TTS，只保留最新一条。
- 在 `onDone`、`onError`、`onStopped` 后延迟尝试刷新。
- force 消息不进入普通 pending 逻辑，保持直达。

## 二、新增测试

- `tests/dialogue-state.test.js`
  - 重复 sleep/wake 不产生边沿；
  - workflow/workspace 来源合并；
  - busy/sleeping 时保留 pending；
  - 冷却边界；
  - 消费后来源清理。

现有 25 个测试基础上，本批新增 1 个测试文件。

验证：

```text
node --check main.js
node --check renderer/pet.js
node --check src/dialogue-state.js
node --check src/task-queue.js
npm test
```

结果：26 个测试文件通过，0 失败。

## 三、已知限制与下一批

1. renderer 的 `pendingAmbient` 当前在聊天 done/error/stopped 后刷新；普通 TTS 自然播放结束时还没有统一的 flush hook，若聊天 done 后语音仍在播放，后台消息会等后续事件或被保留到下一次触发。
2. `pendingAmbient` 只保留最新一条，尚未实现来源优先级和过期时间；这是有意的最小降噪策略。
3. 普通 workflow/workspace 信号在角色睡眠时保留，会在下一次真正唤醒后尝试消费；如果产品更希望静默丢弃，可在下一批增加最大 pending TTL。
4. Agent workflow 仍有原来的 8 分钟 throttle + 25% 概率，workspace watcher 保留自身 cooldown；本批只是增加统一聚合层，并未移除上游节流。
5. 主窗口聊天、regenerate、TTS 尚未完全纳入同一个 `ConversationService` / `TaskManager`。
6. 尚未运行真实 Electron UI、长时间待机、真实 TTS、Spine/Live2D/PSD 四模式人工回归。

## 四、下一批建议

1. 给 renderer 的 TTS 完成路径统一调用 `flushPendingAmbient()`，避免后台消息等待过久。
2. 为 pending ambient 加 `createdAt` 和 2~5 分钟 TTL，过期后台信号直接丢弃。
3. 给 `sendProactive` 增加 `source` / `priority` / `wake` 字段，把 force 和 wake 语义彻底分离。
4. 给 Agent API 增加状态查询 task ID 与按任务取消，移除兼容性的全局 `agentApiAbort`。
5. 抽 `ConversationService`，统一 GUI/Agent/主动搭话的历史写入和取消语义。
6. 使用真实 Electron 打包版验证睡眠、TTS、工作区变化和设置页开关。

## 五、接手规矩

- 先检查 `git status --short --branch`，不要覆盖已有改动。
- 不要删除 `%APPDATA%` 或其他 userData。
- 不要把 API key、Agent token、token hash、聊天原文写入日志或交接文档。
- 需要视觉验证时必须走 vision skill，不得用 Read 直接读取图片。

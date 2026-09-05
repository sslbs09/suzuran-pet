# 固定台词池与主动搭话优化交接记录（2026-09-02）

> 本批只处理台词池选择频率、重复闸门和睡眠台词路由；未大规模重写文案，未部署正式版，未推送远程，未删除用户数据。

## 一、审阅结论

固定台词核心位于 `src/lines.js`，共约 194 条。没有发现大量精确重复；确认的内容问题主要是 `thrown` 池一组“下次轻一点丢”的近重复，以及午休、保暖、深夜守候、长时间想念等主题偏集中。

更主要的体感问题来自概率和多来源叠加：

- 主动搭话原来每分钟轮询，闲置 8 分钟后每分钟 35% 尝试；达到阈值后 5 分钟内至少触发一次约 88.4%，10 分钟内约 98.7%。
- 35% 是总发言闸门，健康/事件/称谓的 20%~30% 只是内容分支概率，未命中仍会退回普通时段池。
- Agent workflow、workspace watcher、摸头、sleep/wake、perch 等来源有各自 throttle，但没有统一全局冷却和跨池去重。
- `src/lines.js:241-253` 只记住同一个数组最近 3 个下标，不会阻止不同池短时间说同主题或同一句。
- `main.js:1438-1439` 先查 `PERSONIFY_LINES.sleep`，而实际池只有 `sleepDay/sleepNight`；因此原 `sleep` 事件会提前返回，12 条睡眠台词不可达。

## 二、本批已完成

### 1. 修复睡眠台词不可达

- `main.js:maybePersonify()` 现在先处理 `event === "sleep"`，调用 `lines.pickSleepLine()`；其他事件仍从 `PERSONIFY_LINES[event]` 取池。
- `src/lines.js:pickSleepLine()` 增加 `now = new Date()` 参数，可注入时间测试；默认行为不变（22:00~04:59 使用夜间池，其余时间使用白天池）。

### 2. 引入全局 LineGate

新增 `src/line-gate.js`：

- 默认全局最短间隔 30 秒；
- 最近 5 条文本跨池去重；
- 规范化时忽略动作括号、`*动作*`、标点、空白和模板占位符；
- 重复或冷却拒绝时不记录为已展示；
- `force` 可绕过全局时间冷却，但仍不能绕过重复文本；
- `reset()` 可用于测试和生命周期重置。

`main.js:sendProactive()` 已接入 gate。当前 `force` 的日程、安全告警仍可在隐藏窗口送达；普通主动台词、工作流、事件和摸头不再在 30 秒内连续覆盖。

### 3. 降低主动搭话概率

`src/features.js` 新增：

```js
PROACTIVE_DEFAULTS = {
  intervalMin: 12,
  chance: 0.18
}
```

并使 `startProactive()` 接收 `chance` 参数。默认闲置阈值从 8 分钟改为 12 分钟，默认每分钟概率从 35% 改为 18%。配置中已有 `features.proactiveMin` 时仍优先使用用户配置值。

新默认值下，达到闲置阈值后：

- 5 分钟内至少触发一次约 63.2%；
- 10 分钟内至少触发一次约 86.3%；
- 平均等待约 5.6 分钟；
- 从最后一次聊天到首次普通主动台词平均约 17.6 分钟。

### 4. 增强台词抽取可测试性

`src/lines.js`：

- `pick(arr, random = Math.random)`；
- `pickTpl(arr, vars, random = Math.random)`；
- `pickSleepLine(vars, now, random)`。

保持原有调用兼容，同时允许测试注入随机源和时间。

## 三、新增测试

- `tests/lines.test.js`
  - 全部时段边界；
  - 睡眠 04:59 / 05:00 / 21:59 / 22:00；
  - 模板默认值；
  - 随机源注入。
- `tests/line-gate.test.js`
  - 全局冷却；
  - 跨池规范化去重；
  - force 行为；
  - reset 行为。

聚焦测试通过：

```text
node --check src/lines.js
node --check src/line-gate.js
node --check src/features.js
node --check main.js
node --test tests/lines.test.js tests/line-gate.test.js
```

结果：2 个测试文件、全部通过。

本批完整回归已实际通过：`npm test` 共 25 个测试文件，25 通过，0 失败。`npm run lint` 未运行成功，原因是当前工作区没有安装 eslint 可执行文件（`eslint` 不是内部或外部命令）；CI 的 `npm ci` 后再执行。
## 四、尚未完成

1. LineGate 目前只接在 `sendProactive()`，尚未把 `busy/speaking/sleeping` 状态纳入 gate。
2. Agent workflow 与 workspace watcher 仍各自生成台词，只是现在共享 `sendProactive()` 的全局闸门；下一步可改为 signal 聚合。
3. 摸头/拖拽/抛掷等用户互动还没有统一调用 `recordUserActivity()`。
4. renderer 在 GIF/Spine/Live2D/PSD 模式下的睡眠状态边沿还未完全统一；普通主动消息可能仍会改变睡眠状态。
5. `pickSleepLine()` 仍只返回文本，尚未返回 line ID/主题标签；精确去重已完成，语义主题去重需要后续标签化。
6. `thrown` 近重复和午休/保暖/深夜/长闲置主题文案尚未改写，本批刻意未大规模调整文本。
7. `startProactive()` 的 chance 目前由默认常量提供，但设置页还没有单独暴露“主动搭话频率”控件。
8. 尚未运行真实 Electron UI、TTS 和长时间待机验证；LineGate 可能让重要但非 force 的事件延迟，需要真实体验复核。

## 五、下一批建议

1. 运行 `npm test`、`npm run lint` 和 `npm run check:assets`。
2. 增加 `tests/proactive-probability.test.js`，对 RNG/时间做注入，锁定 12 分钟/18% 的行为。
3. 抽出 `recordUserActivity()`，让聊天、摸头、拖拽和打开输入框统一重置闲置计时。
4. 给 `sendProactive()` 增加来源/优先级参数，区分 `reminder`、`interaction`、`background`。
5. 修复 renderer 睡眠状态边沿，确保普通程序消息不隐式触发 wake。
6. 最后逐条改写近重复和高同质文案，每次只改 1~2 条并回归测试。

## 六、接手规矩

- 先检查 `git status --short --branch`，不要覆盖既有工作。
- 不要删除或清理 `%APPDATA%` 用户数据。
- 不要把 API key、Agent token、token hash 或聊天原文写入日志和交接文档。
- 固定台词视觉/素材验证如涉及图片，必须走 vision skill，不得直接用 Read 读取图片。

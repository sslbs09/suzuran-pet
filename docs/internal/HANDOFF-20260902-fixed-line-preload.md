# 固定台词音频池交接记录（2026-09-02）

> 本批把“固定台词预加载可视化”推进为可批量生成、可断点续跑、磁盘持久化 30 天的实现。未部署正式版、未推送远程、未删除 userData、未调用真实云端 API。

## 一、本批已完成

### 1. 稳定固定台词清单

新增 `src/fixed-lines.js`：

- 枚举 `lines.js` 中所有固定池：摸头、人格事件、睡眠日/夜、工作流、时段主动、长闲置、关系阶段、清晨。
- 模板先展开 `{{user}}` / `{{name}}`，再按规范化文本去重。
- 每条记录有稳定 `id`、`pool`、`index`、`text`、`emotion`。
- 语音 profile 按引擎、语言、voice、参考音频/文本、语速/音调生成 fingerprint。
- 当前 manifest 约 194 条；动态生日/健康/日程字符串暂不纳入固定池。

### 2. 30 天磁盘缓存

新增 `src/fixed-line-cache.js`：

- 缓存目录：userData `audio/fixed-lines/<16位fingerprint>/`。
- 每条音频写入独立二进制文件，manifest 只保存状态、文件名、字节数、更新时间和错误码。
- 缓存 TTL 为 `30 * 24 * 60 * 60 * 1000`。
- 缓存命中要求 fingerprint、条目 ID、文件名、文件存在且未过期全部匹配。
- 过期/损坏/缺失文件回到 `pending`，不会显示为已加载。
- 所有动态路径经过 ID 白名单和 `resolve` 根目录边界检查，避免路径穿越。
- 临时文件使用进程+时间后缀，写入后 rename；失败会清理临时文件。
- `profileFromConfig()` 对参考音频只纳入 basename，避免把完整本地路径写入 profile 展示/指纹。

### 3. 批量预加载任务

新增 `src/fixed-line-preloader.js`：

- 只生成当前有效语音 profile，防止不同引擎/语言互相误用。
- 系统语音返回 `SYSTEM_NOT_PRELOADABLE`，因为系统语音由操作系统实时合成。
- Genie/Edge/Cosy 等可配置方案按缺失条目串行生成，默认并发 1，减少 GPU/服务压力。
- 已完成条目跳过；中途取消后已完成音频保留，下次继续。
- 支持 `retryFailed` 重试失败项。
- 每条完成/失败/开始都会触发 progress callback。
- 当前复用 `tts-manager.ttsCloneImpl()`，传入 `fixedLinePreload` 标志，避免预加载过程读自己的磁盘缓存。

### 4. 正常播放命中磁盘缓存

`src/tts-manager.js` 已接入固定台词磁盘缓存：

- 普通 TTS 请求在内存缓存未命中后，按当前展开文本+情绪查固定台词缓存。
- 命中后直接返回本地二进制音频 base64，跳过翻译和远程/本地重新合成。
- 未命中继续走原有 Genie/GSV/Cosy/Edge/系统语音回退链。
- `fixedLinePreload` 请求跳过该查找，避免预加载递归/误命中。
- 原有内存缓存仍保留，当前仍是最多 20 条/5 分钟的短期加速层；固定台词批量缓存是独立的 30 天磁盘层。

### 5. 主进程 IPC

`main.js` 新增/接入：

- `pet:fixed-lines-status`
- `pet:fixed-lines-start`
- `pet:fixed-lines-cancel`
- `pet:fixed-lines-clear`
- `pet:fixed-lines-progress`

`preload.js` 暴露：

- `getFixedLineAudioStatus()`
- `startFixedLineAudioPreload(options)`
- `cancelFixedLineAudioPreload()`
- `clearFixedLineAudioCache()`
- `onFixedLineAudioProgress(cb)`

IPC 返回和事件不包含 API key、Agent token 或完整引擎私密路径。

### 6. 设置页可视化

`renderer/settings.html` 的语音区末尾新增“固定台词音频池”卡片：

- 当前方案/语言/voice/参考音频 basename；
- 已加载数量 / 总数量；
- 失败数量；
- 缓存大小；
- 进度条；
- 开始/继续预加载；
- 重试失败；
- 暂停；
- 清空当前方案缓存；
- 显示全部/只显示未加载和失败；
- 失败条目的错误码 title。

列表默认固定高度滚动，不会一次性撑开 194 条内容；所有动态台词使用 `textContent`，不通过 `innerHTML` 注入。

`renderer/settings.css` 新增语音池专用卡片、徽标、进度和列表样式，并兼容 `prefers-reduced-motion` 与深色主题变量。

## 二、新增测试

- `tests/fixed-lines.test.js`
  - manifest 覆盖池；
  - ID 稳定且唯一；
  - 模板展开；
  - profile fingerprint 差异；
  - summary 统计。
- `tests/fixed-line-cache.test.js`
  - 初始 pending；
  - 二进制落盘后 ready；
  - readAudio 命中；
  - 30 天 TTL 常量；
  - failed 状态；
  - clear 当前 profile。

## 三、验证结果

通过：

```text
node --check main.js
node --check preload.js
node --check src/fixed-lines.js
node --check src/fixed-line-cache.js
node --check src/fixed-line-preloader.js
node --check src/tts-manager.js
node --check renderer/settings.js
node --test tests/fixed-lines.test.js tests/fixed-line-cache.test.js
npm test
```

结果：

```text
28 个测试文件通过
0 个失败
```

普通资源检查仍会提示仓库中缺少可选 `renderer/live2dcubismcore.min.js` 和可能未安装的 `node_modules/ag-psd/dist/bundle.js`；这与固定台词缓存无关。正式发布仍应使用严格资源检查。

## 四、尚未完成 / 需要真实环境复核

1. 本机尚未启动真实 Genie/GSV/Edge/Cosy 进行 194 条批量生成；当前测试只验证状态层和磁盘层，没有产生真实语音文件。
2. 真实预加载耗时取决于当前引擎：单线程设计可能需要较长时间，这是刻意避免 GPU/服务并发过载的取舍。
3. 取消会在当前单条 TTS 返回后停下，不会强杀正在运行的 Python 引擎；已完成条目不丢失。
4. 设置页进度事件当前更新摘要和当前条目状态，但完整条目 ready 状态以任务结束后的 status reload 为准。
5. 还没有单条“试听已加载音频”按钮；当前正常固定台词播放已经可以命中磁盘缓存，设置页列表暂时只显示状态。
6. 固定台词发送尚未携带稳定 `fixedLineId`，播放命中采用展开后文本+情绪匹配；未来可透传 ID 进一步减少匹配成本。
7. 语音方案或参考音频变化会生成新的 fingerprint，旧版本缓存不会误用；旧版本清理策略尚未实现总容量上限。
8. 当前固定池只含 `src/lines.js`，features/main 中动态生日、健康、日程和里程碑固定字符串不在预加载范围。

## 五、下一步建议

1. 在真实本地引擎环境先只预加载 5 条，观察速度、音质和缓存命中，再放开完整 194 条。
2. 增加“仅预加载高频池”选项，例如 PAT + sleep + workflow + 当前时段，降低首次成本。
3. 增加“缓存总大小上限”和旧 fingerprint 清理策略。
4. 增加单条试听缓存按钮，并在播放链路显示“磁盘缓存命中”。
5. 让固定台词发送携带 `fixedLineId`，避免同文本不同池/情绪的歧义。
6. 真实 Electron 验证设置页长列表、深色主题、取消/继续和 30 天过期行为。

## 六、接手规矩

- 先检查 `git status --short --branch`，不要覆盖用户已有改动。
- 不要删除 userData 或旧缓存，清理策略需要单独确认。
- 批量预加载可能调用云端 API 并产生费用，自动化测试不得调用真实云端。
- 不要把音频 base64、API key、token、完整本地路径写入日志或交接文档。
- 如需图片/视觉验证，必须使用 vision skill，不得用 Read 直接读取图片文件。

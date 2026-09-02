# 稳定性与安全加固交接记录（2026-09-02）

> 本批由代码审阅建议继续落地。只修改源码与 CI，没有部署正式版、没有推送远程、没有覆盖 userData。
> 当前 checkout：`main`，基线提交 `44aaa675d44f5306c033d130baf5d919d2e87c63`。

## 一、本批已完成

### 1. Agent 接入 token 脱敏

- 新增 `src/agent-auth.js`。
- 新建接入方时仍只向设置页返回一次明文 token，但配置文件只保存 `tokenHash`（SHA-256）。
- 兼容旧配置中的 `clients[].token`：鉴权时仍可匹配，下一次普通保存会归一化为 hash。
- `src/config.js:buildSettingsView()` 不再向 renderer 返回 token 或 hash，只返回 `hasToken`、授权时间和最近活跃时间。
- 设置页移除“查看 Token”按钮，改为安全状态图标与说明。
- Agent API 鉴权改用统一的 `tokenMatches()` / constant-time compare。

### 2. 历史清除正确性

- `src/history.js` 新增 `clear()` 并导出。
- `main.js` 的 `pet:clear-history` 改为调用 `history.clear()`，失败写入日志。
- 新增 `tests/history-clear.test.js`，验证写入后清空、再次读取为空。

### 3. 原子写临时文件隔离

- `src/storage.js:atomicWrite()` 临时文件改为 `file.tmp-{pid}-{timestamp}`，避免多个写入者共用固定 `.tmp`。
- 写入/rename 失败时清理临时文件并重新抛出原始错误。
- `storage.js` 对 Electron 改为可选加载：纯 Node 测试没有 Electron 时回退到 `APPDATA/SuzuranPet`，不再因 `require('electron')` 阻断纯逻辑测试。

### 4. URL/SSRF 基础校验与聊天 SSE 空闲超时

- 新增 `src/safe-url.js`：
  - 只允许 `http:` / `https:`；
  - 拒绝 URL 用户名/密码；
  - 拒绝 loopback、私有、链路本地、保留、组播等 IP（明确 `allowLoopback` 时才允许本地服务）；
  - DNS 解析后逐一校验 A/AAAA 地址；
  - 手工处理重定向，每一跳重新校验，最多 3 跳。
- `src/chat-client.js` 的 OpenAI/Anthropic 请求和连接测试改用 `safeFetch()`。
- SSE 读取增加 30 秒 chunk 空闲超时，并检查 AbortSignal。
- 新增 `tests/safe-url.test.js`，覆盖非法协议、loopback、私网 IP、公开 IP。

### 5. 测试和 CI 入口

- `package.json` 增加 `npm test`，由 `scripts/run-tests.cjs` 枚举 `tests/*.test.js` 后跨平台执行；避免 `node --test tests` 在 Windows/Node 24 下把目录误当模块。
- 新增 `scripts/check-assets.mjs`：检查核心文件和 `renderer/index.html` 中的本地 script 引用。
- 普通 `npm run check:assets` 对可选 Live2D Core / node_modules 依赖给 warning；Release 使用 `--strict`，缺失则失败。
- `.github/workflows/test.yml` 新增 Windows Node 22.12 测试流程：资源检查、lint、全套测试、密钥测试。
- lint/md-lint workflow Node 版本统一为 22.12.0。
- release workflow 改为：校验 tag 与 `package.json.version`、npm ci、资源检查、lint、测试、动态 zip 名、SHA-256 文件、动态 Release 标题。
- `package-lock.json` 根包版本同步到 `2.5.18`；`package.json` 声明 Node `>=22.12.0`。

### 6. Live2D 缺失资源的显式提示

- 新增 `pet:live2d-capability` IPC 和 preload 桥。
- 设置页在缺少 `renderer/live2dcubismcore.min.js` 时显示“当前安装包未包含 Live2D Core，已禁用；请安装完整资源包”，不再只显示空模型列表。
- `check-assets --strict` 仍会把缺失 Core 作为正式发布阻断项。

### 7. Agent 队列按任务取消

- 新增 `src/task-queue.js`，每个任务拥有独立 id、状态和 AbortController。
- Agent `/chat` 改为使用该队列，成功响应增加 `taskId`。
- `/stop` 会取消当前任务与排队任务，并返回 `cancelled` 数量；不再只依赖最后一次赋值的全局 abort 指针。
- 新增 `tests/task-queue.test.js`，验证排队任务取消后不执行。
- 注意：主窗口聊天、regenerate 与 TTS 尚未接入此队列，ConversationService 仍是下一批工作。

### 8. Agent listener 生命周期同步

- `main.js` 保存 `agentServer`、端口和状态（`disabled/starting/running/error`）。
- Agent 配置保存时，若 `enabled` 或 `port` 变化，会先关闭旧 server，再按新配置启动；退出流程也会主动关闭 server。
- `/status` 增加 `listener.state` 与 `listener.port`，只返回安全状态，不泄露 token。
- `src/task-queue.js` 已接入 Agent `/chat`；任务 ID、停止全部排队任务和 `/chat` 返回 `taskId` 已生效。
- 当前仍未统一主窗口聊天、regenerate 和 TTS 任务；下一阶段仍需抽 `ConversationService`。

## 二、验证结果

已通过：

```text
node --check main.js
node --check src/agent-auth.js
node --check src/safe-url.js
node --check src/history.js
node --check src/chat-client.js
node --test tests/agent-auth.test.js tests/history-clear.test.js tests/safe-url.test.js
npm test（23 个测试文件，全部通过）
```

测试摘要：

```text
23 个测试文件通过；
新增 Agent token、history clear、safe-url、task-queue 测试均通过；
运行环境未安装 Electron 时，纯 Node 测试仍可执行。
```

资源检查：

- 普通模式会提示可选资源缺失；
- 当前源码明确缺少 `renderer/live2dcubismcore.min.js`，因此 `npm run check:assets -- --strict` 会失败。
- 这是预期的发布阻断，不应通过删除检查来掩盖；正式发布前需要补齐合法 Core/模型并加入许可证与校验和，或暂时从发行包中移除 Live2D 能力。

## 三、尚未完成 / 下一批优先级

1. 当前 checkout 没有 `src/updater.js`，所以自动更新哈希/回滚尚未实现；若后续分支已有 updater，应单独迁移本批的 checksum/回滚设计。
2. Agent server 已增加 `start/stop` 和监听状态同步；后续仍可抽成独立 `AgentServer` 类以便单测。
3. `agentApiAbort` 仍保留为兼容旧状态的单指针；Agent 新请求已由 `task-queue` 按 task ID 管理，下一步可移除兼容字段。
4. `src/chat-client.js` 当前只增加 SSE chunk 空闲超时，连接建立/总时长/最大响应字符数仍建议在 ConversationService 中统一处理。
5. URL 安全层已接入聊天客户端，但 `main.js` 的本地 TTS、`ja-translate.js`、`tts-manager.js` 等其他 fetch 路径仍需逐一迁移；loopback 本地服务需显式 allowlist，远程 TTS 必须逐跳检查。
6. 资源完整性检查目前把 Live2D Core 视为可选资源以支持 Lite 源码开发；正式包必须使用 `--strict`。
7. `main.js`、`renderer/pet.js`、`renderer/settings.js`、`src/tts-manager.js` 仍需按域逐步拆分，避免一次性大重构。
8. 尚未同步正式部署目录、未启动打包 exe、未做真实 Electron E2E、未处理 userData 旧历史目录。

## 四、接手规矩

- 先运行 `git status --short --branch`，确认不要覆盖用户改动。
- 不要删除 `%APPDATA%` 或历史 userData；涉及删除必须单独征得确认。
- 不要把 `tokenHash`、API key、聊天原文写入日志、诊断包或交接文档。
- 修改后至少运行 `node --check`、`npm test`；发布相关改动还要运行 `npm run check:assets -- --strict`。
- Live2D 资源的视觉验证必须走 vision skill；不能用 Read 直接读图片。

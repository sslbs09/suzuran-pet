# 优化建议处置记录（suzuran-pet v2.5.25）

- 处置日期：2026-09-01
- 建议来源：`苏苏洛桌宠-优化建议.md`（审查 v2.5.24）
- 处置版本：v2.5.25（commit 46f7a7a + 本地核查修正 v2.5.25b）
- 状态：**已实施 6 项 / 实际已有 3 项 / 按红线跳过 2 项 / 暂缓 4 项**（均附理由）

---

## 一、已实施（6 项）

| 建议 | 内容 | 落地位置 | 说明 |
|---|---|---|---|
| P0 #6 | URL 请求 host 校验防 SSRF | `src/chat-client.js` `validateApiBase()` | 放行回环（本地 Ollama/聚合站），拒绝内网/链路本地/ULA 地址；`config.chat.allowPrivateBaseUrl=true` 显式逃生。已导出纯函数 + 16 项单测（tests/chat-client-guard.test.js） |
| P0 #3 | Agent API 写操作强制认证 | `main.js` startAgentApi | `/chat`、`/stop` 始终要求 Bearer token（即使 master/clients 全空也不开放无认证写入）；`/health` 只读探测放行；`/status` 维持原鉴权。实测：/health 200、/chat 401、/stop 401 |
| P0 #7 | Agent API Content-Type 校验 | `main.js` handler（原有） | 核对发现 handler **本就有** `application/json` 415 校验（缺失/非 JSON 均拒绝）。核查时误加了一层冗余（readAgentJson 内），已撤销——最终未改代码，此项按"已有"计 |
| P1 #13 | SSE error 帧处理 | `src/chat-client.js` `readSSE()` | `data: {"error": ...}` 帧不再静默忽略，抛出并中断流；调用方（handleAsk/Agent /chat）有 catch，转 `pet:error` / 500。导出 readSSE + 6 项 mock 单测（tests/sse.test.js） |
| P2 #4 | 蜜标告警限频 30s→10s | `src/file-guard.js` `alert()` | 勒索/篡改类 30s 静默期太长；10s 仍可压住 fs.watch 重复事件噪音 |
| P2 #5 | config 篡改恢复持久化 | `src/file-guard.js` | 干净基线落盘 `config.clean.json`（noteConfigWritten 同步写）；启动时优先读 clean 副本，若磁盘 config 不一致则启动即恢复（跨重启篡改兜底）。运行时验证：副本已生成且与 config 一致 |

## 二、实际已有（核对后无需改动，3 项）

| 建议 | 内容 | 核对结论 |
|---|---|---|
| P1 #2 | uncaughtException/unhandledRejection 无日志 | **报告过时**：main.js 已有 `process.on("uncaughtException"/"unhandledRejection")` → logTts 记录 stack |
| P2 #8 | koffi 加载失败静默降级 | **报告过时**：main.js 已有 `try { koffi = require("koffi") } catch (e) { logTts("main", "koffi unavailable: ...") }` |
| P0 #3 的 allowRemote 部分 | allowRemote 误开时强制 token | **不适用**：Agent API 硬绑定 `server.listen(port, "127.0.0.1")`，无 allowRemote 概念，局域网不可达 |

## 三、按红线跳过（2 项）

| 建议 | 内容 | 理由 |
|---|---|---|
| P3 #9 | electron-packager → electron-builder | **用户红线**："打包那个升级方式就不要改了，否则影响朋友升级"。CI 与本地均沿用现有 packager + app.asar 覆盖升级路径 |
| P3 #10 | 引入 Vitest/CI 测试 | 已有 21 个 node 纯函数单测（v2.5.25 增至 22 个）+ GitHub Actions 构建 CI；Vitest 迁移投入大、收益低，暂缓 |

## 四、暂缓（4 项，附理由）

| 建议 | 内容 | 暂缓理由 |
|---|---|---|
| P2 #1 | main.js 单文件职责过重，拆 ipc-* 模块 | 架构级重构，涉及 70+ IPC 处理器迁移，回归风险高；已有 src/ 拆分先例，建议按"设置/tts/agent-api"域逐步迁（见 p0-1 交接报告的架构建议） |
| P1 #14 | TTS 引擎启动进度反馈（4 分钟冷启动） | 需新增 IPC + 渲染层进度 UI，改动面大；设置页已有"重启日语语音服务"按钮 + 结果反馈（gsv-result），当前可接受 |
| P3 #11 | memory.js similar() 去重算法语义化 | 规则式去重是设计取舍（文档注明"宁缺毋滥"）；换 TF-IDF/embedding 需评估对现有记忆命中率的影响 |
| P3 #12 | extractFacts() 语义提取 | 文档已注明规则式是设计取舍；LLM 提取耗 token 且结果不可控，保持现状 |
| P3 #15 | SmartScreen 告警缓解（代码签名证书） | 运营/商务事项（EV 证书 ¥1500/年），非代码改动；README 已含绕过指南 |

---

## 五、验证记录

- 单测：22 个全绿（新增 chat-client-guard 16 项 + sse 6 项）
- 运行时实测（Agent API）：`/health` 无 token → 200；`/chat` 无 token → 401；`/stop` 无 token → 401
- SSRF 对用户实际 baseUrl（阿里云 MaaS 公网域名）放行验证通过
- config.clean.json 运行时生成且与 config 一致
- 桌宠打包重启后日志零错误

## 六、遗留（下次发版带上）

- v2.5.25b 核查修正（撤销 readAgentJson 冗余 Content-Type + /health 放行）已 commit **未 push**，下次发版随 main 一起推

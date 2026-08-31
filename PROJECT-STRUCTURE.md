# 苏苏洛桌宠 项目结构与管理说明

> 本文件记录项目布局、备份策略、运行/部署位置与 2026-08-26 全局整理结果，
> 供后续维护快速定位。电子桌宠基于 Electron，主进程 `main.js` + 渲染层 `renderer/`。

## 1. 典型目录

| 路径 | 说明 |
|---|---|
| `main.js` / `preload.js` | 主进程与 preload 桥（IPC 安全暴露） |
| `src/` | 业务模块：config / chat-client / tts-manager / memory / bond / features（主动搭话·语音输入·日程）/ lines（台词库）/ ja-translate / schedules / tray-menu / router（zcode 任务）/ history / secrets / storage / file-guard / logger / utils / credential-import |
| `renderer/` | 页面与运行库：index.html + pet.js（主窗口）、settings / moods / psd / voice / schedule / addchar / terms；`rig/`（2.5D 装配 rigger.js + genericparts.js）、`rig-runtime.js`、`sprites/`（表情 GIF：default 默认 / user 用户覆盖）、`spine/`（Spine 模型） |
| `docs/` | 用户文档：`快速开始.md`、`TUTORIALS/`（小白教程合集）、`assets/`（README 配图）；开发过程文档（交接/账本/测试报告等）统一归档在 `docs/internal/` |
| `voice-ref/` | 情绪音色参考音频：`ref_<情绪>.trim.wav`（GSV 参考）+ `.mp3`（原始）+ `.txt`（转写原文），配 `voice-refs.json`（五档：撒娇/傲娇/惊讶/温柔/开心） |
| `outputs/` | 对外输出物：情绪试听音频（v1/v2） |
| `scripts/` | 工具脚本：stt_whisper.py（转写）、cosy_tts.py、gen-icon 等 |
| `tests/` | Node 测试（flight-physics.test.js 等） |
| `docs/internal/research/` | 调研资料（anime25drig 等，2026-08-31 归档） |
| `语音部署与训练指南/` | 语音方案部署/训练手册（含 genie_tts_server.py 与示例） |
| `_backups/` | **统一备份目录**（见下） |
| `data/` | 运行期数据（git 忽略） |
| `dist/` | 打包产出（git 忽略，可重新构建） |
| `node_modules/` | 依赖（git 忽略） |

## 2. 备份策略（统一在 `_backups/`）

- `_backups/2026-08-26-整理前/` —— 全局整理前全量快照（dev 源码 + 安装目录 resources/app（去 node_modules）+ AppData 配置/sprites + **含密钥的 config 原件**），配 `MANIFEST.md` 清单。
- `_backups/dev-历史快照/` —— 历次开发快照（v2.5.12 等），从散落位置归拢而来。
- 约定：后续所有备份放本目录，命名 `YYYY-MM-DD-HHMM-描述`；**不要在安装目录里留备份**。

## 3. 运行与部署位置（重要）

- **开发/源头**：`E:\SuzuranPetGit`（git 仓库，主开发地）。
- **用户运行实例**：`E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\`（正式版 exe + `resources\app` 为部署代码）。
  - 部署流程：改 dev → 拷贝对应文件到 `resources\app\` → MD5 校验 → 重启。
  - **注意**：`resources\app\config.json` 与 `正式版\config.json` 是部署期残留样例（密钥已清空），运行时配置一律在 AppData（见下），改这两个文件无效。
- **运行数据**：`C:\Users\xsbil\AppData\Roaming\苏苏洛桌宠 1.1 正式版\`
  - `config.json`（真实配置/API 密钥在此）、`persona.md`、`assets/sprites/user/`（用户 GIF）、`assets/rig/user/`（2.5D 皮肤）、`logs/tts.log`。
- **音色参考音频**：运行时读取 `voice-refs.json`（部署目录 resources\app 根），文件在 `resources\app\voice-ref\`。

## 4. 2026-08-26 全局整理记录（审计 + 清理 + 归档）

**审计结果（违规/安全）**
- ✅ 安装目录两个 `config.json` 含**真实 API 密钥**（DeepSeek `sk-df3c…`/`sk-a4c…`、百炼 `sk-ws-H.…`）——已清空为 `""`（原件在 `_backups/2026-08-26-整理前/install-extra/`），**建议轮换这两组密钥**；若曾压缩/分享该文件夹视为已泄露。
- ✅ git 历史与 dev 源码无真实密钥（仅测试假密钥 sk-test-*）。
- ✅ 个人信息：仅法律文档中的联系人邮箱（`1598184627@qq.com`，作者自愿公开）+ pixi/npm 库作者邮箱（许可证头）；无手机号/身份证/硬编码用户路径。
- ℹ️ 桌面 `人格配置.txt`、`好好好/`（照片）**不属于本项目**，未纳入。

**清理**
- 删：`resources\app\pet.js`（旧渲染层残留）、`resources\app\data\`（旧运行数据）、`voice-ref/_wrong-linglan`（铃兰错误素材）、`__pycache__`/`.pyc`。
- 归拢：`backup/`、`backups/`、`voice-ref-backup-*`（dev）与安装目录 `resources/backup-*` → `_backups/`。
- 试听输出：桌面 `苏苏洛情绪试听*` → `outputs/`。

**去重结论**
- `sprites/default/` 与 `sprites/user/` 内容相同属**设计内**（默认层 + 用户覆盖层，首次运行自动复制），不删。
- persona.md 与 persona.default.md 相同属设计（模板 + 活副本）。
- ℹ️ 已知瑕疵：`user/coquetry.gif`（撒娇）内容=开心 gif（哈希相同）——开心动画暂复用撒娇图，如需独立开心动画请再换素材。

**Bug 静态检查**
- require() 全部可解析 ✅；渲染页 script/link 引用全部存在 ✅；全部 JS/PY 语法通过 ✅；飞行物理测试通过 ✅。
- 已知环境问题（与本项目无关）：DevTools CDP 命令分发故障 → `docs/internal/ENV-CDP-DEVTOOLS-ISSUE.md`。

## 5. 日常维护速查

- 改代码 → `node --check` + 影响面自查 → 按 §3 流程部署 → 重启验证（看 `logs/tts.log` 与进程数=5）。
- 加情绪音色 → 素材入 `voice-ref/` + 改 `voice-refs.json` + 设置页「情绪音色试听」可直接试。
- 备份 → 放 `_backups/` 并更新本节记录。
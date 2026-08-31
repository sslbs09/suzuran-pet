# 苏苏洛桌宠 项目结构与管理说明

> 本文件记录项目布局、备份策略、运行/部署位置（v2.5.19 更新），
> 供后续维护快速定位。电子桌宠基于 Electron，主进程 `main.js` + 渲染层 `renderer/`。

## 1. 典型目录

| 路径 | 说明 |
|---|---|
| `main.js` / `preload.js` | 主进程与 preload 桥（IPC 安全暴露，含 `appVersion`） |
| `src/` | 业务模块：config / chat-client / tts-manager / memory / bond / features（主动搭话·语音输入·日程）/ lines（台词库）/ ja-translate / schedules / tray-menu / router（zcode 任务）/ history / secrets / storage / file-guard / logger / utils / credential-import |
| `renderer/` | 页面与运行库：index.html + pet.js（主窗口）、settings / moods / psd / voice / schedule / addchar / terms；`rig/`（2.5D 装配 rigger.js + genericparts.js）、`rig-runtime.js`、`sprites/`（表情 GIF：default 默认 / user 用户覆盖）、`spine/`（Spine 模型） |
| `新手教程/` | 小白教程合集（**应用内文档中心读取此目录**，唯一生效来源；同步仓库根与正式版目录） |
| `docs/` | 公开文档：`assets/`（README 配图）、`persona-template.md`；**内部交接/账本/测试报告在 `docs/internal/`（已移出公开仓库，本地保留，git 忽略）** |
| `voice-ref/` | 情绪音色参考音频：`ref_<情绪>.trim.wav`（GSV 参考）+ `.mp3`（原始）+ `.txt`（转写原文），配 `voice-refs.json`（五档：撒娇/傲娇/惊讶/温柔/开心） |
| `outputs/` | 对外输出物：情绪试听音频（v1/v2） |
| `scripts/` | 工具脚本：stt_whisper.py（转写）、cosy_tts.py、gen-icon 等 |
| `tests/` | Node 测试（flight-physics.test.js 等） |
| `语音部署与训练指南/` | 语音方案部署/训练手册（含 genie_tts_server.py 与示例） |
| `_backups/` | **统一备份目录**（见下） |
| `data/` | 运行期数据（git 忽略） |
| `dist/` | 打包产出（git 忽略，可重新构建） |
| `node_modules/` | 依赖（git 忽略） |
| `.github/` | CI 工作流（lint/md-lint/release）+ FUNDING.yml + ISSUE_TEMPLATE（4 模板） |
| `deploy/` | 部署脚本：pack.sh（asar 打包）/ sync-pages.sh（官网文档同步）/ publish.ps1 等 |

## 2. 备份策略（统一在 `_backups/`）

- `_backups/2026-08-26-整理前/` —— 全局整理前全量快照（dev 源码 + 安装目录 resources/app（去 node_modules）+ AppData 配置/sprites + **含密钥的 config 原件**），配 `MANIFEST.md` 清单。
- `_backups/dev-历史快照/` —— 历次开发快照（v2.5.12 等），从散落位置归拢而来。
- 约定：后续所有备份放本目录，命名 `YYYY-MM-DD-HHMM-描述`；**不要在安装目录里留备份**。

## 3. 运行与部署位置（重要）

- **开发/源头**：`E:\SuzuranPetGit`（git 仓库，主开发地）。
- **用户运行实例**：`E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\`（正式版 exe + `resources\app_legacy` 为部署代码散目录）。
  - 部署流程：改 dev → Edit/Write 同步到 `resources\app_legacy\` → 停桌宠 → `bash deploy/pack.sh` → 重启验证。
  - **注意**：asar 被占用时 pack.sh 的 `mv app.asar app.asar.old` 会报 busy，用 `cp -f app.asar.new app.asar` 覆盖。
- **运行数据**：`%APPDATA%\苏苏洛桌宠 2.5 正式版\`（本机为 junction → `E:\SuzuranPetData-Roaming-2.5`）
  - `config.json`（真实配置/API 密钥在此）、`persona.md`、`assets/sprites/user/`（用户 GIF）、`assets/rig/user/`（2.5D 皮肤）、`logs/tts.log`。
- **音色参考音频**：运行时读取 `voice-refs.json`（部署目录 resources\app_legacy 根），文件在 `resources\app_legacy\voice-ref\`。

## 4. 发布链路（v2.5.19 起）

- **GitHub Releases**：打 tag（如 `v2.5.19`）→ push tag → CI `Build & Release` 自动打包 + 发布。
  - zip 名/标题随 tag 动态生成（release.yml）；正文从 `CHANGELOG.md` 抽取本版本段落自动生成。
  - 皮肤包需手动上传（`deploy/` 或网页操作）；完整版走邮箱分发。
- **GitHub Pages 官网**：`https://sslbs09.github.io/suzuran-pet/`（gh-pages 分支，含 index.html + guide/ 4 文档）。
  - 改文档后运行 `bash deploy/sync-pages.sh` 一键同步。

## 5. 历史整理记录（2026-08-26 全局整理，存档）

**审计结果（违规/安全）**
- ✅ 安装目录两个 `config.json` 含**真实 API 密钥**（DeepSeek `sk-df3c…`/`sk-a4c…`、百炼 `sk-ws-H.…`）——已清空为 `""`（原件在 `_backups/2026-08-26-整理前/install-extra/`），**建议轮换这两组密钥**；若曾压缩/分享该文件夹视为已泄露。
- ✅ git 历史与 dev 源码无真实密钥（仅测试假密钥 sk-test-*）。
- ✅ 个人信息：仅法律文档中的联系人邮箱（`1598184627@qq.com`，作者自愿公开）+ pixi/npm 库作者邮箱（许可证头）。
- ℹ️ 桌面 `人格配置.txt`、`好好好/`（照片）**不属于本项目**，未纳入。

**去重结论**
- `sprites/default/` 与 `sprites/user/` 内容相同属**设计内**（默认层 + 用户覆盖层，首次运行自动复制），不删。
- persona.md 与 persona.default.md 相同属设计（模板 + 活副本）。
- ℹ️ 已知瑕疵：`user/coquetry.gif`（撒娇）内容=开心 gif（哈希相同）——开心动画暂复用撒娇图，如需独立开心动画请再换素材。

## 6. 日常维护速查

- 改代码 → `node --check` + 影响面自查 → 按 §3 流程部署 → 重启验证（看 `logs/tts.log` 与进程数≈5）。
- 改文档（使用说明/API 指南/开箱必读/语音部署）→ `bash deploy/sync-pages.sh` 同步官网 + 同步正式版目录。
- 加情绪音色 → 素材入 `voice-ref/` + 改 `voice-refs.json` + 设置页「情绪音色试听」可直接试。
- 备份 → 放 `_backups/` 并更新本节记录。

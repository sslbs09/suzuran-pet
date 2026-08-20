# 🦊 苏苏洛桌宠（SuzuranPet）

> Q 版狐狸医师桌宠 —— 悬浮在桌面上的日常陪伴。
> 可配置任意 OpenAI 兼容 / Anthropic API，人设可编辑，AI 自动选情绪表现，本地语音克隆（可选）。

![Platform](https://img.shields.io/badge/platform-Windows-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Tech](https://img.shields.io/badge/tech-Electron%20%2B%20Node.js-9cf)

## ✨ 功能

- **桌宠本体**：透明无边框、置顶、可拖动、点击穿透不挡操作；19 个 GIF 表情（开心/生气/委屈/睡觉/傲娇…）
- **AI 自动选情绪**：回复时由大模型理解对话内容，自动在情绪词表中选最贴切的情绪来表现（自定义情绪词也支持）
- **可配置任意 API**：DeepSeek / Kimi / OpenAI / GLM / 阿里百炼 / 硅基流动 / 本地 Ollama / Anthropic，一键「测试连接」+「获取模型列表」自动读取端口可用模型
- **人设自由编辑**：内置设置窗口直接改人设文本（`{{userName}}` 占位符自动替换称呼），随时恢复默认
- **表情管理**：每个情绪独立格子，可换 GIF、可改名字（≤5 字）、可增删自定义情绪（≤30 个）、待机/情绪用途一键切换
- **语音可选**：默认关闭零安装；想开语音按「语音部署与训练指南」选择 —— 系统语音 / edge-tts / 本地 Genie 克隆音色 / 百炼 CosyVoice；语速可调
- **本地音色克隆**：程序内「音色克隆与训练」窗口，选参考音频 → 试听 → 一键应用，不用命令行

## 🚀 快速开始（普通用户）

1. **源码运行**：`npm install && npm start`（需 Node.js）
2. **打包运行**：`npm run dist` 后运行 `dist/苏苏洛桌宠-win32-x64/苏苏洛桌宠.exe`（需 electron-packager）
3. 首次启动自动弹出设置：选服务商 → 填 API Key →「测试连接」→ 保存；把「桌宠对你的称呼」改成你的名字
4. 单击小狐狸打开输入框，回车开始聊天

> 托盘右键：⚙️ 设置 / 🎨 表情管理 / 🎙️ 音色克隆与训练 / 🎤 语音部署与训练 / 语速 / 退出

## 🔧 开发

```bash
npm install          # 安装依赖（electron + omggif）
npm start            # 启动桌宠
npm run dist         # electron-packager 打包（win32 x64，asar=false）
npm run test:chat    # 聊天链路冒烟
npm run test:router  # 路由判定测试
node scripts/gen-icon-ico.js  # 重新生成多尺寸图标
```

技术栈：Electron（主进程 `main.js` + 渲染层 `renderer/`），`contextIsolation` 开启、`nodeIntegration` 关闭；聊天走 OpenAI 兼容 / Anthropic 流式协议；本地语音由 `语音部署与训练指南/genie_tts_server.py`（Genie/GPT-SoVITS）提供。

## 📁 目录

```
├── main.js / preload.js      # Electron 主进程 & 安全桥
├── config.json               # 配置（API/情绪表/语速/热键等）
├── persona.md                # 人格设定（可编辑，{{userName}} 占位符）
├── src/
│   ├── chat-client.js        # 多协议聊天（OpenAI 兼容 + Anthropic，情绪标注解析）
│   ├── router.js             # 混合路由（任务模式默认关）
│   ├── config.js             # 配置加载/保存（自动探测的 Key 不落盘）
│   └── history.js            # 会话记忆
├── renderer/
│   ├── index.html / pet.js   # 桌宠窗口（GIF 表情 + 气泡 + 输入栏）
│   ├── settings.*            # 设置窗口（API/人设/语音/其他）
│   ├── moods.*               # 表情管理窗口（换 GIF/改名/自定义情绪）
│   ├── voice.*               # 音色克隆与训练窗口
│   └── sprites/user/         # 表情 GIF（同名替换即换肤）
├── 语音部署与训练指南/       # 语音方案部署 + 音色克隆训练教程
└── 使用说明.html             # 给朋友的入门文档
```

## 🛡 安全说明

- 项目不内置任何 API Key / 密码；配置文件 `config.json` 中的密钥留空，由用户自行填写
- 自动探测到的本机密钥**不会写回配置文件**（`src/config.js` 有防护）
- 本地语音服务器只监听 `127.0.0.1`，不对局域网/公网开放
- 渲染进程隔离（contextIsolation），主进程与页面通过白名单 IPC 通信

## 📄 License

[MIT](./LICENSE)

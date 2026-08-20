# 苏苏洛桌宠 · 1.0 正式版（SuzuranPet）

Q 版狐狸医师桌宠：悬浮在桌面上，日常聊天陪伴。**免安装、绿色版**——解压后双击 exe 即用，无需 Node / Python（不开语音时）。

## 快速开始

1. 解压整个文件夹（建议放在桌面或喜欢的位置）
2. 双击 `苏苏洛桌宠.exe`
3. 首次启动会自动弹出「⚙️ 设置」：
   - **① 聊天 API**：选服务商（DeepSeek / Kimi / OpenAI / GLM / Qwen / 本地 Ollama…）→ 填 API Key →「测试连接」→「保存」
   - 把「桌宠对你的称呼」改成你的名字（人设会自动用这个名字）
4. 单击小狐狸 → 输入框 → 回车，开始聊天

## 支持的服务商

| 服务商 | baseUrl | 说明 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | 便宜好用，推荐 |
| Kimi（月之暗面） | `https://api.moonshot.cn/v1` | 长上下文 |
| OpenAI | `https://api.openai.com/v1` | 需科学上网 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 国产免费额度 |
| 阿里云百炼 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 国产 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 聚合多家模型 |
| Ollama（本地） | `http://localhost:11434/v1` | 免费、不联网，无需 Key |
| Anthropic Claude | `https://api.anthropic.com` | 协议类型选 Anthropic |

> 只要是 OpenAI 兼容接口，都能在「自定义」里填 baseUrl + 模型名直接用。

## 换人设

- 托盘图标右键 →「⚙️ 设置」→「② 人设」直接编辑，保存立即生效
- 人设文本里 `{{userName}}` 会自动替换成你在设置里填的称呼
- 「恢复默认人设」可随时还原

## 语音（可选）

默认关闭、零安装。想开语音：
托盘右键 →「🎤 语音部署与训练」打开指南文件夹，四种方案任选：

1. **系统自带语音**：零配置
2. **edge-tts 云端**：装 Python 后 `pip install edge-tts`
3. **本地克隆音色（Genie / GPT-SoVITS）**：按指南部署后，直接在程序里「🎙️ 音色克隆与训练」窗口选音频 → 试听 → 一键应用，即可克隆出任意音色（含苏苏洛）
4. **百炼 CosyVoice**：填 API Key + 音色 ID

## 换皮肤 & 自定义情绪

- 托盘右键 →「🎨 表情管理」：每个情绪（开心/思考/生气/睡觉…）单独一个格子，点「选择 GIF」填入自己的表情，随时可「恢复默认」
- **自定义情绪**：没有想要的？在表情管理里自己加（≤5 个字，最多 30 个，如「摸鱼」「干饭」），再给它选个 GIF
- AI 会在回复时自动理解对话、选择最贴切的情绪来表现（比如你喊困，她就用「睡觉」表情）

## 常见问题

- **双击没反应 / SmartScreen 拦截**：未签名程序首次运行点「更多信息」→「仍要运行」
- **提示没配 API Key**：托盘 → 设置 → 填 Key → 测试连接
- **聊天没反应**：看是不是输入框没打开（单击小狐狸）；或 API 欠费/模型名不对
- **想开任务模式（/zcode 前缀操控电脑）**：需要另装 ZCode，然后在 `config.json` 里把 `zcodeEnabled` 改为 `true` 并填 `zcodeCli` 路径（默认关闭）

## 目录说明

```text
苏苏洛桌宠-1.0正式版\
├── 苏苏洛桌宠.exe          ← 主程序（双击运行）
├── 使用说明.html            ← 给朋友看的入门文档（就是这份的网页版）
├── 语音部署与训练指南\      ← 语音方案部署 + 音色克隆训练教程
└── resources\app\          ← 程序本体（config.json / persona.md 在这里面，可直接改）
```

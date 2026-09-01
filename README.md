# 🩺 苏苏洛桌宠（SuzuranPet）

<div align="center">

![苏苏洛向你挥手](renderer/sprites/user/wave.gif)

**罗德岛医疗干员苏苏洛，从终端里走出来，住进你的桌面。**

会聊天 · 会记住你的事 · 真人音色说话（中/日） · 在任务栏上散步 · 深浅双主题

[![最新版](https://img.shields.io/github/v/release/sslbs09/suzuran-pet?label=%E6%9C%80%E6%96%B0%E7%89%88)](https://github.com/sslbs09/suzuran-pet/releases/latest)
[![下载量](https://img.shields.io/github/downloads/sslbs09/suzuran-pet/total?label=%E4%B8%8B%E8%BD%BD)](https://github.com/sslbs09/suzuran-pet/releases)
![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows-blue)
![许可](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-BUSL--1.1%20%E7%A6%81%E6%AD%A2%E5%95%86%E7%94%A8-lightgrey)

> 🌗 **v2.5.26 新**：暗色主题全窗口闭环、主窗口质感升级、辅助窗口视觉统一——详见 [CHANGELOG](CHANGELOG.md)。

[**⬇ 下载**](#-下载) ｜ [快速开始](#-四步开始) ｜ [🌐 官网](https://sslbs09.github.io/suzuran-pet/) ｜ [English](README_EN.md)

</div>

---

## 📥 下载

| 版本 | 大小 | 语音 | 获取 |
| --- | --- | --- | --- |
| **轻量版** | 约 220 MB | ❌ 不含引擎，可自行部署 | [GitHub Releases](https://github.com/sslbs09/suzuran-pet/releases/latest) |
| **完整版** | 约 16 GB | ✅ 含中文 + 日语引擎，开箱即说 | 联系 <1598184627@qq.com> |
| **皮肤包** | 约 96 MB | 38 款皮肤补装 | [Releases 页资产（SuzuranPet-*-SkinPack.zip）](https://github.com/sslbs09/suzuran-pet/releases) |

> ⚠️ GitHub 单文件上限 2 GB，这里只能放**轻量版**。
> 想要「解压就能听见她说话」，请联系邮箱获取**完整版**。
> 两种版本聊天功能完全一样，差别只在语音引擎。
> 皮肤包解压到 `resources/app/renderer/sprites/` 即可补装 38 款皮肤。

## ✨ 她能做什么

> 一句话认识她：**陪你聊天、记住你的事、用真人音色说话、在任务栏上散步，还能换上你喜欢的形象。**

| | | |
| :---: | :---: | :---: |
| 💬 **聊天陪伴**<br>任意 OpenAI 兼容 API | 🧠 **长期记忆**<br>记得你的喜好/生日/安排 | 🗣 **真人音色**<br>中/日双语，可克隆 |
| 🦊 **桌面行走**<br>任务栏散步、跳上窗口 | 🎨 **四种形象**<br>GIF / Spine / 2.5D / Live2D | 📅 **日程提醒**<br>到点气泡 + 语音 + 通知 |
| 🌗 **深浅双主题**<br>主窗口/设置/辅助窗口全跟随 | 🖱 **点击穿透**<br>透明区域完全不挡软件 | 🛡 **置顶自愈**<br>全屏游戏也能自己回最上层 |

![情绪表情预览](docs/assets/moods-preview.png)

- 🎭 **角色扮演开关**：RP 模式一键切换助手模式（优先服从指令、回复直接简洁）
- 🔐 **默认安全**：密钥本机 DPAPI 加密存储、不上传；本地服务只监听 127.0.0.1
- 🔌 **Agent 接口**：本机 `127.0.0.1:8765` 的 `/chat`，可选 Bearer Token，让别的 AI / 脚本也能找她

## 🚀 四步开始

> 🐣 **完全新手？** 图文手把手教程：[`新手教程/快速开始.md`](新手教程/快速开始.md)（Key 去哪领、怎么填、常见故障怎么办）

1. **下载**上表任一版本 → 解压整个文件夹（建议放桌面或喜欢的盘）
2. 双击 `苏苏洛桌宠 2.5 正式版.exe`，首次启动弹《使用条款》→ 同意
   （被 SmartScreen 蓝屏拦截：点「更多信息」→「仍要运行」，原因见[重要说明](#-重要说明)）
3. 自动弹出设置页：**聊天 API** 选服务商 → 填 API Key →「测试连接」→「保存」；顺手把「桌宠对你的称呼」改成你的名字
4. 单击小狐狸 → 输入框 → 回车，开始聊天

<details>
<summary><b>🔌 支持的服务商（点开）</b></summary>

| 服务商 | baseUrl | 说明 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | 便宜好用，推荐 |
| Kimi（月之暗面） | `https://api.moonshot.cn/v1` | 长上下文 |
| OpenAI | `https://api.openai.com/v1` | 需科学上网 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 国产免费额度 |
| 阿里云百炼 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 国产多模型体验 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 聚合多家模型 |
| Ollama（本地） | `http://localhost:11434/v1` | 免费、不联网、无需 Key |
| Anthropic Claude | `https://api.anthropic.com` | 协议类型选 Anthropic |

只要是 OpenAI 兼容接口，都能在「自定义」里填 baseUrl + 模型名直接用。
没有 Key？包内《API 接入指南》整理了免费渠道（学生券/免费档）。

</details>

<details>
<summary><b>🧩 技术细节：记忆 / 语音回退 / 行走 / 渲染 / 安全（点开）</b></summary>

### 1. 记忆：从「记性」到「羁绊」的三层体系

- **事实层**：规则式提取 + 手动添加，去重、封顶、只留最近
- **摘要层**：每 20 轮对话自动生成印象摘要
- **羁绊层**：聊天/摸头 +1 经验、每日首互 +2，等级 1~10 影响亲密度与专属台词
- 全部本地 DPAPI 加密存储，设置页可视化查看/编辑/删除/清空

### 2. 语音：五级回退，绝不让话卡住

- 系统语音 → edge-tts → CosyVoice → 本地 Genie（中文克隆音色） → GPT-SoVITS（日语微调音色），逐级自动回退
- 情绪参考音频分档（撒娇/傲娇/惊讶/温柔/开心），仅在你选择的情绪命中时才切换，默认绝不带参考音频

### 3. 行走：任务栏就是她的罗德岛基建

- 以任务栏上沿为地面散步、坐下休息，一步跳到程序窗口顶上歇脚再跳回来
- 拖拽暂停、抛出后会有"眩晕抗议"（😵💫）反馈；相位机自愈保险丝：定时器/mouseup 丢失自动恢复，杜绝永久静止

### 4. 渲染：四种形态，一套引擎

- GIF 经典表情（最稳）/ Spine 小人（行走）/ PSD 2.5D（贴底独立）/ Live2D（自治模块，单点可回滚）
- 透明区域完全点击穿透，不挡任何软件；置顶层级周期重断言，全屏游戏也能自己回到最上层

### 5. 安全：默认安全，不是口号

- 密钥三槽位 DPAPI 加密；本地 TTS / Agent 服务只监听 loopback；DLL 基线自检 + 数字签名；蜜标监控检测外部程序访问敏感配置区域

</details>

<details>
<summary><b>🗣 语音方案对比（点开）</b></summary>

语音默认关闭（完整版含引擎，开启即用；轻量版需先部署引擎）。托盘 →「🗣 语音设置」或设置页 →「语音」：

| 方案 | 需要什么 | 效果 |
| --- | --- | --- |
| 系统自带语音 | 零配置 | 最省事 |
| edge-tts 云端 | 装 Python + `pip install edge-tts` | 微软语音 |
| **本地克隆音色（推荐）** | 完整版随包自带 | 苏苏洛真人音色，中文（Genie）+ 日语（GPT-SoVITS） |
| 百炼 CosyVoice | 填 API Key + 音色 ID | 云端克隆 |

**日语语音模式**：设置 → 语音 → 勾选「🗣 日语语音模式」——气泡文字仍是中文，回复先翻译成日语，再用日语音色合成播放。

</details>

<details>
<summary><b>🎨 换形象 & 换人设（点开）</b></summary>

- **四种渲染模式**：设置 → 渲染模式（GIF / Spine 小人 / 2.5D / Live2D），随意切换
- **换皮肤**：托盘「🎨 外观与皮肤」一键切换 38 款皮肤；把自己下载的 Spine 模型（`.atlas` + `.skel/.json` + `.png`）放进皮肤文件夹，重启即出现，无需配置
- **换人设**：托盘 → 设置 →「人设」直接编辑，`{{userName}}` 自动替换成你的称呼，保存立即生效
- **自定义情绪**：表情管理里自己加情绪（≤5 个字，最多 30 个）并配 GIF，AI 回复时自动选最贴切的表现

</details>

## 📂 数据存在哪

| 项 | 位置 |
| --- | --- |
| 用户数据 | `%APPDATA%\苏苏洛桌宠 2.5 正式版\`（聊天记录/记忆/设置/密钥，不随安装目录；从老版本升级会自动迁移） |
| 日志 | 同目录 `logs\tts.log`，求助时打包发来即可 |
| 语音引擎 | 安装目录 `engines\`（完整版，约 15GB；**删了就不能说话**，聊天不受影响） |

## ❓ 常见问题

<details>
<summary><b>遇到问题先点开这里</b></summary>

- **双击没反应 / SmartScreen 拦截**：点「更多信息」→「仍要运行」（程序未购买微软信任章，非病毒）
- **提示没配 API Key**：托盘 → 设置 → 填 Key → 测试连接
- **聊天没反应**：先单击小狐狸打开输入框；或 API 欠费 / 模型名不对
- **设置页找不到某个选项**：设置页左侧有分区导航和搜索框；部分选项只在特定渲染模式下显示（先切渲染模式）
- **想开任务模式（/zcode 前缀操控电脑）**：需另装 ZCode，然后在 `config.json` 里把 `zcodeEnabled` 改为 `true` 并填 `zcodeCli` 路径（默认关闭）
- **电脑时间不准**：联网请求会失败，请开启系统"自动设置时间"

</details>

## ⚠ 重要说明

- **本程序不内置任何 AI 模型**：聊天回复来自你自配的 OpenAI 兼容接口（第三方服务）。API Key 只存在你本机（DPAPI 加密），不上传、不读取你的其他密钥。
- **首次运行被 SmartScreen 拦截**是未购买商业代码签名证书的正常现象，点「仍要运行」即可。
- **语音默认状态**：完整版出厂即开（引擎随包）；轻量版默认关闭，部署引擎后可开。
- 隐私政策见 [`PRIVACY.md`](PRIVACY.md)，使用条款见 [`TERMS.md`](TERMS.md)，许可证见 [`LICENSE`](LICENSE)（BUSL-1.1：源代码可得、禁止商用）。

## 📚 文档

- 🌐 **官网**：[sslbs09.github.io/suzuran-pet](https://sslbs09.github.io/suzuran-pet/)（开箱必读 / 使用说明 / API 接入 / 语音部署）
- 🐣 **新手教程**：[`新手教程/快速开始.md`](新手教程/快速开始.md)（Key 去哪领、怎么填、常见故障）｜完整 8 篇在应用内文档中心或官网
- 🔌 **API 接入指南**：[`API接入指南.html`](API接入指南.html)
- 🎙 **语音部署与训练**：[`语音部署与训练指南/`](语音部署与训练指南/)
- 📦 **项目结构**：[`PROJECT-STRUCTURE.md`](PROJECT-STRUCTURE.md) ｜ **安全策略**：[`SECURITY.md`](SECURITY.md) ｜ **免责声明**：[`DISCLAIMER.md`](DISCLAIMER.md)

## 📜 更新日志

完整更新历史见 [`CHANGELOG.md`](CHANGELOG.md)。

---

**版权与免责声明**：本项目为《明日方舟》角色苏苏洛的同人二创，非商业目的，与鹰角网络无关；角色版权归原作者及鹰角网络所有。语音引擎感谢 [High-Logic/Genie](https://github.com/High-Logic/Genie/tree/master) 的开源。

# 🩺 Sussurro Desktop Pet (SuzuranPet)

<div align="center">

![Sussurro waving](renderer/sprites/user/wave.gif)

**Sussurro, the medic operator of Rhodes Island, steps out of your terminal and moves onto your desktop.**

Chat · long-term memory · cloned real voice (CN/JP) · walks along your taskbar · light & dark themes

[![Latest release](https://img.shields.io/github/v/release/sslbs09/suzuran-pet?label=Release)](https://github.com/sslbs09/suzuran-pet/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/sslbs09/suzuran-pet/total?label=Downloads)](https://github.com/sslbs09/suzuran-pet/releases)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-BUSL--1.1%20(non--commercial)-lightgrey)

[**中文 README**](README.md)

</div>

> Fan-made desktop pet based on *Arknights* (明日方舟). Windows only. This project ships **no AI models** — chat replies come from any OpenAI-compatible API you configure yourself.

> 🌗 **New in v2.5.26**: full dark theme across every window (main pet, settings, all helpers), refined main-window visuals (layered shadows, frosted glass, fused bubble tail, exit fades), unified auxiliary-window design, theme logic consolidated with live cross-window switching — see [CHANGELOG](CHANGELOG.md).

## ✨ Features

| | | |
| :---: | :---: | :---: |
| 💬 **Chat companion**<br>Any OpenAI-compatible API | 🧠 **Long-term memory**<br>Remembers names / likes / birthdays | 🗣 **Real cloned voice**<br>Chinese & Japanese, TTS fallback chain |
| 🦊 **Desktop walking**<br>Strolls the taskbar, hops onto windows | 🎨 **Four render modes**<br>GIF / Spine / 2.5D PSD / Live2D | 📅 **Schedule reminders**<br>Bubble + voice + Windows notification |
| 🌗 **Light & dark themes**<br>Every window follows your theme | 🖱 **Click-through**<br>Transparent areas never block apps | 🛡 **Always-on-top self-heal**<br>Returns to top over fullscreen games |

![Mood sprites preview](docs/assets/moods-preview.png)

- 38 Spine skins; drop your own Spine models in to add more — zero config
- Fully editable persona file, `{{userName}}` / `{{petName}}` placeholders included
- Local-first security: DPAPI-encrypted keys, localhost-only services, DLL integrity self-check
- Optional local Agent API (`127.0.0.1:8765/chat`, Bearer token optional) for other agents/scripts

## 📥 Download

| Build | Size | Voice | Where |
| --- | --- | --- | --- |
| **Lite** | ~220 MB | ❌ engines not included | [GitHub Releases](https://github.com/sslbs09/suzuran-pet/releases/latest) |
| **Full** | ~16 GB | ✅ CN + JP engines, talks out of the box | Contact <1598184627@qq.com> |
| **Skin Pack** | ~96 MB | 38 skins | [Releases assets (SuzuranPet-*-SkinPack.zip)](https://github.com/sslbs09/suzuran-pet/releases) |

> GitHub's 2 GB per-file limit means only the **Lite** build can live here. Both builds share identical chat features; only the voice engines differ. Extract the Skin Pack into `resources/app/renderer/sprites/` to add 38 skins.

## 🚀 Quick Start

1. Download → extract the folder anywhere you like
2. Run `苏苏洛桌宠 2.5 正式版.exe` → accept the Terms on first launch
   (SmartScreen warning → "More info" → "Run anyway" — the app is unsigned, not malware)
3. Settings → **Chat API**: pick a provider → paste your API Key → "Test" → "Save"
4. Click the fox → type → Enter

No API key yet? Local [Ollama](http://localhost:11434/v1) works with zero cost and no key.

## 🔌 Supported Providers

Any OpenAI-compatible endpoint works via "Custom" (baseUrl + model name). Presets included:

| Provider | baseUrl | Notes |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | Cheap & solid, recommended |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` | Long context |
| OpenAI | `https://api.openai.com/v1` | Requires proxy in CN |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | Free tier |
| Alibaba Bailian | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Multi-model |
| SiliconFlow | `https://api.siliconflow.cn/v1` | Aggregates many models |
| Ollama (local) | `http://localhost:11434/v1` | Free, offline, no key |
| Anthropic Claude | `https://api.anthropic.com` | Set protocol type = Anthropic |

## 🧠 Under the Hood

- **Memory, three layers**: rule-extracted facts (deduped, capped) → conversation summaries every ~20 rounds → a bond level (1–10) raised by chats & head-pats that unlocks closer lines. All stored locally, DPAPI-encrypted, viewable/editable in Settings.
- **Voice, five-step fallback**: local cloned voice (Genie) → GPT-SoVITS Japanese fine-tuned → Bailian CosyVoice → edge-tts → Windows system voice. If nothing is installed, system voice still works with zero setup.
- **Walking physics**: taskbar as ground, sits to rest, hops onto window tops; drag-pause and throw-with-dizzy-feedback; a self-heal fuse guarantees she can never get stuck frozen.
- **Rendering**: classic GIF / Spine walker / PSD 2.5D auto-rigged / Live2D — switchable live; transparent regions are fully click-through; topmost level re-asserts itself over fullscreen games.
- **Security by default**: keys in DPAPI vault, localhost-only services, DLL baseline self-check, honeytoken alerts on external access to sensitive config.

## 🗣 Voice Options

Voice is **off by default**. Tray → Voice Settings, or Settings → Voice:

| Option | Needs | Result |
| --- | --- | --- |
| Windows system voice | nothing | Easiest |
| edge-tts (cloud) | Python + `pip install edge-tts` | Microsoft voices |
| **Local cloned voice (recommended)** | bundled in Full build | Sussurro's own voice, CN (Genie) + JP (GPT-SoVITS) |
| Bailian CosyVoice | API key + voice id | Cloud cloning |

**Japanese voice mode**: Settings → Voice → tick "Japanese voice mode" — bubbles stay Chinese, replies are translated to Japanese and spoken with the JP fine-tuned voice.

## 📂 Where Your Data Lives

| What | Where |
| --- | --- |
| User data (chat history / memory / settings / keys) | `%APPDATA%\苏苏洛桌宠 2.5 正式版\` (migrates automatically from older versions) |
| Logs | same folder, `logs\tts.log` — attach it when asking for help |
| Voice engines (Full build) | install dir `engines\` (~15 GB; deleting silences voice but chat is unaffected) |

## ❓ FAQ

- **SmartScreen blocks the exe** → "More info" → "Run anyway" (unsigned, not malware).
- **"API Key not configured"** → Settings → Chat API → paste key → Test → Save.
- **No reply** → make sure the input bar is open (click the fox); check API balance / model name.
- **Can't find a setting** → the Settings page has a left nav + search box; some options only appear under their render mode.
- **Task mode (/zcode prefix)** → off by default; enable via `zcodeEnabled` in config.json with your own ZCode install.

## 📚 Docs & Links

- 🌐 **Website**: [sslbs09.github.io/suzuran-pet](https://sslbs09.github.io/suzuran-pet/) (guides, API hookup, voice deployment)
-  **Beginner tutorial**: [`新手教程/快速开始.md`](新手教程/快速开始.md) (CN; all 8 guides also in the in-app Docs Center)
- 🔌 **API guide**: [`API接入指南.html`](API接入指南.html)
- 📦 **Project structure**: [`PROJECT-STRUCTURE.md`](PROJECT-STRUCTURE.md) ｜ **Security**: [`SECURITY.md`](SECURITY.md) ｜ **Disclaimer**: [`DISCLAIMER.md`](DISCLAIMER.md)
- 📜 **Changelog**: [`CHANGELOG.md`](CHANGELOG.md)

## 🔒 Privacy & License

- **No built-in models, no telemetry, no uploads.** Your API key is stored locally with Windows DPAPI encryption.
- All local services (TTS, Agent API) listen on `127.0.0.1` only.
- License: [BUSL-1.1](LICENSE) — source available, **non-commercial use only** (converts to MIT on 2030-08-30). See [TERMS.md](TERMS.md) / [PRIVACY.md](PRIVACY.md).

## 📄 Copyright Notice

This is a non-commercial fan work based on the character Sussurro from *Arknights* (明日方舟). All character rights belong to Hypergryph. Voice engine credits: [High-Logic/Genie](https://github.com/High-Logic/Genie/tree/master).

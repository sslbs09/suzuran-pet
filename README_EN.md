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

## 🔒 Privacy & License

- **No built-in models, no telemetry, no uploads.** Your API key is stored locally with Windows DPAPI encryption.
- All local services (TTS, Agent API) listen on `127.0.0.1` only.
- License: [BUSL-1.1](LICENSE) — source available, **non-commercial use only** (converts to MIT on 2030-08-30). See [TERMS.md](TERMS.md) / [PRIVACY.md](PRIVACY.md).

## 📄 Copyright Notice

This is a non-commercial fan work based on the character Sussurro from *Arknights* (明日方舟). All character rights belong to Hypergryph. Voice engine credits: [High-Logic/Genie](https://github.com/High-Logic/Genie/tree/master).

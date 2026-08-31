# 角色扮演（RP）框架调研 + 桌宠高成本功能候选（2026-08-26）

> 背景：苏苏洛桌宠——Electron 桌宠，LLM 聊天（DeepSeek/GLM/Ollama 等，system prompt 有人设 persona.md）、克隆音色 TTS、mood→动画情绪系统、行走/摸头/日程/主动搭话。
> 目标：让角色扮演"更高情商、更有人味"，以及找出"投入大但提升大"的功能方向。

---

## 一、角色扮演框架调研

### 1. 角色卡规范 Character Card V2（核心框架）
- 来源：`github.com/malfoyslastname/character-card-spec-v2`
- 字段：`name/description/personality/scenario/first_mes/mes_example`；V2 新增 `system_prompt/post_history_instructions/character_book（内嵌 lorebook）/creator_notes`；全卡可 base64 存入 PNG EXIF "Chara" 字段（适合把苏苏洛做成单文件角色卡资产）。
- 占位符 `{{char}}`/`{{user}}` 必须大小写不敏感替换。
- **借鉴**：把现有 system prompt 里"人设"拆成 description（每次必注入）+ personality 摘要 + scenario（当前场景）+ first_mes（开场定调），各自独立便于调优。

### 2. SillyTavern 系统提示词模式（"高情商"写法范本）
- 来源：SillyTavern 默认 `PromptManager.js default/content/presets/sysprompt/`
- 主提示只有一句："Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}."
- 官方三档 RP 预设：
  - Roleplay-Simple："You're {{char}} in this fictional never-ending roleplay with {{user}}."
  - Roleplay-Immersive："Do not decide what {{user}} says or does. Be descriptive and immersive… Write at least one paragraph, up to four. Do not repeat this message."
  - 卡规范推荐写作法："Write 1 reply only in internet RP style, italicize actions, and avoid quotation marks. Use markdown. Be proactive, creative… stay in character."
- **借鉴**：把"旁白（斜体动作）与台词分开、禁止替用户决定、每次只写一段、结尾留互动钩子"显式写进 system prompt——这正是"更像人"的最直接差距。

### 3. 场景/情绪注入技术
- 来源：SillyTavern World Info（lorebook，关键词触发注入）与 Author's Note（"The closer the Note is to the bottom of the prompt, the more impact it has"）。
- **借鉴**：把 `[当前心情]、[物理位置]、[当前时间]` 做成**深度位置的 Author's Note 每轮注入**（越靠近用户消息权重越高），比写死进 system prompt 更有效，且能驱动已有 mood→动画系统。

### 4. 记忆机制（三层组合）
- 来源：SillyTavern Summarize 扩展 + Data Bank（向量 RAG，global/character/chat 三作用域）+ guide.sillytavern.one 记忆方案横评。
- 最佳实践是组合：关键节点手动总结+隐藏；日常对话每 N 轮自动摘要（`{{summary}}` 注入）；结构化信息（称谓/偏好/纪念日）用"记忆表格"固定注入。
- 向量记忆只适合"检索大文档"，对话陪伴用摘要+表格更省 token、更稳。

### 5. 本地小模型采样参数（3-8B 实测配方）
- 来源：guide.sillytavern.one《温度与 Top P 实战》+ Common Settings 文档 + Qwen2.5 官方博客。
- 建议：Temp 0.8–1.0、Top_P 0.9、Min_P≈0.05（克制重复）、Repetition Penalty 1.05–1.15（太大崩坏）、Max tokens 300–600。
- 注：搜索未证实有 3-8B 的 "Anima" RP 模型（只查到 Anima 是 2B 文生图模型），建议以 Qwen2.5-7B / Mistral-Nemo-12B 中文微调版为主。

### 6. 主动性/场景推进
- 来源：characterdesign 文档（first_mes 是风格最强信号；mes_example 用 `<START>` 分块示范）+ Enhance Definitions 提示词。
- **借鉴**：在示例对话里写 3–6 段"苏苏洛主动关心博士/提醒休息+小动作"的范例，模型会学会主动，而非命令式"请主动点"。

---

## 二、桌宠高成本功能候选（避开已否决项）

| 候选 | 做什么 | 为什么投入大 | 收益 |
|---|---|---|---|
| 1. 实时双向语音（打断式） | 单次 TTS 升级为"说一句听一句、可打断、边说边动嘴型" | ASR 延迟、VAD 与打断仲裁、与克隆音色流式 TTS 对接 | 从"打字陪聊"到"像真宠物喊你"，陪伴感质变 |
| 2. 长期记忆 + 羁绊/成长 | 结构化记忆表 + 自动摘要 + 好感度/羁绊进度 + 解锁台词成就 | 记忆流水线与一致性校验（记忆污染会"人设崩"） | "她记得你"是陪伴类留存第一驱动 |
| 3. Live2D 实时表情 | 从 GIF/Spine 循环动画升级为 Live2D：情绪实时切换、嘴型同步、眼球跟随 | Live2D 模型制作昂贵 + Electron 内嵌 SDK + 性能调优 | 情绪表达从"换图"变"活的"，"人味"最强载体 |
| 4. 窗口级互动剧场 | 抱鼠标跑、爬窗框、被窗口绊倒、跌到任务栏睡（Shimeji 式） | 窗口级 API/置顶管理/物理 + 大量动画资产 | 情绪价值极高、适合短视频传播 |
| 5. 活动感知主动搭话 | 只读前台窗口标题/时段/日程/电量等轻量信号造"由头" | "何时该说"的决策与防烦人策略 | 主动搭话从随机变贴心 |

开源参考：Whisper/FunASR、Style-Bert-VITS2（LingChat）、Live2DViewerEX（Steam）、VTube Studio API、Mate-Engine（VRM）、Shimeji-ee（BSD，行为全数据驱动）、eSheep/DesktopPet（窗口检测+任务栏跌落，XML 动画）。

---

## 三、对苏苏洛桌宠的落地优先级建议

1. **角色卡化重构 system prompt（已落地 §13-42）**：拆 description/personality/scenario，把"语气+氛围"写进 first_mes 与示例对话，加入"斜体动作/禁替用户决定/结尾留钩子"；另加"此刻状态"每轮注入（时段+位置）。纯 Prompt 改造，深浅模型通用，立即可见。
2. **长期记忆+羁绊成长（最有价值，工程量大）**：记忆表格（偏好/称谓/纪念日）+ 每 20 轮自动摘要滚动注入，配好感度解锁台词。
3. **采样参数调优（低成本）**：小模型 Temp 0.8–1.0 / MinP 0.05 / RepPen 1.1，并保持情绪注接近用户消息。
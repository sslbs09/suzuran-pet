# 未完成工作交接报告（2026-08-31，给专门模型的独立任务清单）

> 来源：复审 `docs/internal/HANDOFF-20260831-首启退出修复轮.md` + 会话 `sess_3b7a0ce9` 胶囊 +
> 本轮接手时的实测。仓库 `E:\SuzuranPetGit`，main = `f4a0f90`（已全部 push，工作区干净）。
> 用途：把不属于当前主线的零散事项整理成可独立派发的任务包。

---

## A. 明确不是 GIF 工作（先澄清）

**会话中不存在"GIF 渲染模式 / GIF 皮肤 / GIF 导出 / GIF 优化"的未完成任务。**
已存在的 GIF 相关内容仅为现有功能的一部分，无需动工：
- 素材：`renderer/sprites/user/` 下 20+ 个情绪 GIF（wave/happy/think/wow/sleep/tsundere/angry/cry/dizzy/idle1-7 等）
- README 顶部插图用 `wave.gif`；`docs/assets/moods-preview.png` 由 GIF 首帧合成
- GIF 模式 UI 文案与托盘逻辑均已实现（GIF 模式不显示行走/皮肤/模型选项）

---

## B. 真实未完成工作（按优先级）

### B1. 🔴 技术债：开心动画暂复用撒娇图（用户可感知）
- **现状**：`renderer/sprites/user/coquetry.gif`（撒娇）与 `happy.gif`（开心）**哈希完全相同**
  （`ab2c8ec21b0f28d761e219354378de1d`），即「开心」情绪目前播放的是撒娇动画。
- **影响**：用户触发开心情绪（如摸头、被夸）时看到的是撒娇动作，情绪表达不准确。
- **要做什么**：找到/制作一个独立的「开心」GIF（与原 happy 规格一致：约 500×500、帧率与现有素材统一），
  替换 `happy.gif`；确认 `renderer/sprites/user/happy.gif` 被引用处（moods 配置/情绪映射）无需改动。
- **注意**：素材规格参考现有 GIF（wave.gif 500×500 49 帧等）；需走 vision skill 验证视觉正确性。
- **记录位置**：PROJECT-STRUCTURE.md「已知瑕疵区」。

### B2. 🟡 asar 内冒烟验证（storage.js 修复的最终确认）
- **背景**：`storage.js` copyIfMissing 修复（单文件走 copyFileSync，全新安装 config.json 不再被建成空目录）
  涉及 asar 环境 API（`statSync`/`copyFileSync` 在 asar 内可用性）。
- **现状**：临时目录（`--user-data-dir`）测试已通过；但**未在真实 `app.asar` 内复验**（交接文档 §二.3 明确列为待办）。
- **要做什么**：
  1. 全新临时目录 + 真实 exe 启动（不用 `--user-data-dir` 的 electron 直跑，用正式版 exe）
  2. 确认 `config.json`/`persona.md` 生成为正常文件（非空目录）
  3. 点「同意」→ 设置引导窗出现 → 进程存活
  4. 同时验证新设置 UI（左侧导航/搜索/未保存「保存全部」栏/按渲染模式隐藏 section）在打包版可用
- **SOP**：`deploy/README.md` §4；首启测试命令见交接文档 §四.3。

### B3. 🟡 设置页交互补测（代码已确认存在，交互待验证）
- 代码层已确认：`#set-search` 搜索框（settings.html L26 + settings.js L1020 input 事件）、
  未保存提示条（HTML+JS 均存在）、托盘分组（tray-menu.js v2.5.18 重构）。
- **要做什么**：GUI 交互验证——搜索过滤是否实时生效、未保存提示条是否在改动后出现、
  托盘菜单分组是否正常展开（外观/动作/语音子菜单、语速/大小 radio）。
- **注意**：GUI 操作优先用 accessibility 树（`get_app_state` element target），避免坐标点击
  （桌宠持续动画，坐标易过期）。

### B4. 🟡 VM 全新安装冒烟（可选，有 VM 时）
- `deploy/README.md` §4：删 AppData → 启动 → 条款弹窗 + 语音未配置提示 + 5 进程 + `/health`。
- VM `SuzuranPet-TestVM` 为 poweroff 待命状态（需先开机）。

### B5. 🟢 历史 userData 清理（**需用户确认后执行**）
- `%APPDATA%\苏苏洛桌宠`（2.9M，纯缓存）
- `%APPDATA%\苏苏洛桌宠 2.0 正式版`（106M，含 config.json/persona.md/logs——2.0 时代用户数据）
- 当前 2.5 已不用；**含用户历史数据，删除前必须经用户确认**。潜在可释放 ~109M。
- 用户本人口头已表示"那就不删"（针对此报告前一轮的询问）——**默认不删，除非用户再次明确要求**。

### B6. 🟢 朋友 B（NaCl_Yan）交付
- 替换 `app.asar`（当前 185,846,895 B）即可同步 v2.5.18 全部修复。
- 完整版 zip 的 `engines/` 仍未含 Genie 修复（`genie_tts_server.py` mkstemp 竞态 + `ToneSandhi.py` G2P 空串）——
  如需朋友拿到完整引擎修复，要重新发完整版 zip（约 16GB staging）或单发 2 个 engine 文件。

---

## C. 已确认完成（无需再动）

- ✅ 首启「同意后退出」修复（terms.js 标志位 + openSettings show/focus）——已在 asar 内，真实环境重启验证通过
- ✅ storage.js copyIfMissing 单文件修复——临时目录验证通过（B2 是补真实 asar 复验）
- ✅ 托盘菜单分组重构 + 设置页 + i18n——已提交（aa70ff6）
- ✅ productName 升级 + userData 迁移逻辑——已提交（6eb46c1），迁移逻辑严谨（不丢数据）
- ✅ 全部提交已 push：main = `f4a0f90`（7 commit，工作区干净）
- ✅ 真实 userData 已迁移 E 盘 junction（`E:\SuzuranPetData-Roaming-2.5`，勿动）

---

## D. 工作规矩（接手模型必读）

1. **Mimosa 红线**：禁止 Bash 写源码/配置（用 Write/Edit）；commit 用 `git -C "E:/SuzuranPetGit"`（否则误扫 workspace 无关目录）。
2. **部署循环**：改 dev → Edit 同步 `正式版\resources\app_legacy\` → 停桌宠 → `bash deploy/pack.sh`（asar busy 时 `cp -f app.asar.new app.asar`）→ 重启。
3. **push**：`git -C "E:/SuzuranPetGit" -c http.proxy= -c https.proxy= push origin main`（代理 7897 已死，直连可用）。
4. **查进程/数据**：PowerShell `Get-CimInstance Win32_Process`（Git Bash grep 中文失效）；真实 userData 在 `E:\SuzuranPetData-Roaming-2.5`（junction）。
5. **视觉验证**：必须走 vision skill（`node C:\Users\xsbil\.zcode\skills\vision\vision.js <图> "问题"`），禁止 Read 直读图片。

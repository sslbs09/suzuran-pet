# Live2D 渲染模式集成 · 项目稿（v2.5 规划）

> 状态：**v1 已完成并实测通过（2026-08-29，账本 §111）**——渲染模式第四态、内置 haru 示例、贴底显示 + 自动 Idle/点击动作。未做：皮肤选择 UI、行走/坐姿联动、Cubism 2 支持。
> 一句话：桌宠渲染层加一个 `live2d` 模式，能加载 Live2D 模型（Cubism 3/4/5）当桌面角色。
> 集成用 **pixi-live2d-display**（MIT），不用 live2d-widget（GPL-3.0，会传染整个项目）。

---

## 0. 为什么能做（结论先行）

- 桌宠渲染层是 Electron 的 Chromium，Live2D 是纯前端 WebGL 渲染，直接能跑；
- 透明无边框窗口跑 WebGL 已有先例（Spine 就在透明窗里用 PIXI/WebGL）；
- 接入方式跟之前 3D 模式那次一样：渲染模式加一档 + 主进程条件扩展 + 交互对接。
- **真正的瓶颈不是代码，是模型素材**：苏苏洛没有现成 Live2D 模型（她的动态立绘是 Spine 格式，桌宠已支持）。先用通用 Live2D 模型（shizuku 等）验证链路，模型素材后续自己解决。

## 1. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 加载器 | `pixi-live2d-display`（MIT） | 桌宠已用 PIXI，衔接最顺；MIT 无传染风险 |
| 运行时 | Live2D Cubism Core（`live2dcubismcore.min.js`） | 官方专有许可，个人/商用免费，需遵守其条款 |
| 模型格式 | Cubism 3/4/5（`.model3.json` + `.moc3` + 贴图 + `.motion3.json`） | 现代格式，pixi-live2d-display 直接支持 |
| 模型存放 | `userData/assets/live2d/<角色>/`（运行时导入） | 与 spine user、rig user 一致，懒加载 |
| 不用 | `live2d-widget`（GPL-3.0） | 集成即需整个项目 GPL 开源，与私有发布冲突 |

## 2. 集成步骤（接手时按序做）

1. **依赖**：`npm i pixi-live2d-display`（注意与现有 pixi 版本兼容；桌宠用的是 pixi.min.js UMD，可能需要同版本的 live2d-display 构建）。
2. **渲染模式**：`src/render-mode.js` 的 `RENDER_MODES` 加 `"live2d"`；设置页渲染模式下拉加「Live2D 角色」；`pet.js` 加 live2d 分支（懒加载模型）。
3. **模型加载**：`userData/assets/live2d/` 扫描（IPC，类似 `pet:3d-list` 的先例）；渲染层 `Live2DModel.from(model3.json)` + 贴底/尺寸对齐（参考 Spine fit 逻辑）。
4. **状态映射**：桌宠的待机/行走/坐姿 → Live2D motion（有对应动作才播，没有就 idle）。行走几何（`src/walk-geo.js`）与 Live2D 的"贴地"对接（参考 Spine 的做法）。
5. **交互**：点击说话、拖拽跟随走现有链路（Live2D 只是渲染层，不接管窗口）；live2d-display 自带的 Tap/HitArea 按需关掉或对接。
6. **卸载/切换**：切走模式时销毁 Live2D 实例（防内存泄漏，参考 3D 移除的教训）。
7. **验收**：通用模型满高贴底、待机呼吸、切换不残留、低配不卡（WebGL 已用，风险低）。

## 3. 素材要求（给"别的模型试水"参考）

一个可用的 Live2D 角色目录长这样：

```
assets/live2d/<角色名>/
├── <角色名>.model3.json     # 入口，引用 moc3/贴图/motion
├── <角色名>.moc3
├── textures/                 # 贴图（png）
└── motions/                  # 动作（motion3.json + 可选音效）
```

- 试水可用公开的免费模型（shizuku、miku 等，注意各自授权）；
- 苏苏洛若要做，需 Live2D 建模（约稿/自制），现有提取模型是 Spine 格式，不能直接转。

## 4. 风险清单

- **许可**：Cubism Core 是 Live2D 专有许可，商用要按官方条款（免费版可商用，有署名等要求）；模型素材版权各归各的，分发前确认。
- **pixi 版本**：live2d-display 对 pixi 版本有要求，升级/兼容要单独验证。
- **性能**：Live2D 是 WebGL，低配机器与 Spine 同源，风险低；但模型复杂（高面数贴图）会吃显存。
- **窗口**：Live2D 画布要贴透明窗（同 rig-canvas 的处理），等比、不拉伸。

## 5. 工作规范（本项目及后续所有迭代约定）

1. **动手前先备份**：改代码前 `git stash`/分支或 `_backups/` 快照；改引擎/模型目录前先复制备份。桌面应用改了先停进程再动文件（asar 占用会失败）。
2. **写文档/更新指南前，先看 skill**：本项目 skill 列表里 `humanize`（去 AI 腔）、`chinese-ai-humanizer`（中文润色）、`documentation`（写作规范）等，先读 SKILL.md 再动笔；进度账本沿用 `docs/optimization-progress.md` 的 §编号续写。
3. **小步验证**：每步改动后本机冒烟（进程数 + /health + 日志），发布前 VM 全新安装验证一遍。
4. **发布流程**：遵循 `deploy/README.md`（同步 → pack.sh → 出厂 config → 7z 打包 → 签名 → 冒烟），版本号/tag 与 package.json 同步。
5. **干净交付**：发布物不含宿主路径、开发回退件、临时脚本（本轮 v2.5 已按此清理，见 optimization-progress §109/110）。

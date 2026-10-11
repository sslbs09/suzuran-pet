# BUG-03 RESIDUAL — LEFT-EDGE REVERSAL FLASH

BUG-03 RESIDUAL: **PARTIAL（稳定 Move 已通过；首次起步后立即折返的裁剪反例正在修复）**。

WALKING HIT-TEST: **PARTIAL（完整原生鼠标矩阵仍在验收）**。

前次 CLOSED 结论作废。本报告只裁决本次残余问题，不关闭整个 Chibi Bug Sweep。

## 1. Branch / baseline

- Canonical：`E:\WhiteMoon\repos\suzuran-pet`。
- 开始前与收尾前已验证：`product/desktop-body-v0.1` / `8c5e25ff9b72a455f09b12d855a4be741d6fad91` / clean。
- 独立 worktree：`E:\WhiteMoon\work\chibi-left-edge-flash-residual-v0.1`。
- 修复分支：`fix/chibi-left-edge-flash-residual-v0.1`，从精确 baseline 创建。

## 2. 精确复现条件

真实 Electron 43.3.0、production main / renderer / preload / petAPI、V2 locomotion；Spine `winter/build_char_298_susuro_winter_4`，真实 Move 动画，walking ON，walkSpeedMul=1，window.scale=1，260px 标准窗口、120px canvas。仅复制该皮肤的 skel/png/atlas 到隔离 userData；未复制日常配置或认证信息。

测试准备在测量区间外设定初始边缘位置与 episode 方向；反转由真实 V2 自然到边界触发。每次记录 -500ms～+1500ms 的实际 pose。最终补测通过既有关闭按钮收起隔离实例的未配置 API 提示，以取得无遮挡的原生窗口画面；没有改气泡 CSS。

## 3. 捕获的闪现帧 / trace

**CONFIRMED**：精确 baseline 已捕获 renderer 内二次水平平移；窗口轨迹没有同量跳变。

| 方向 | FACE 后 | spine local Δx | 可见像素 screen Δx | 同一跳变窗口 Δx |
| --- | ---: | ---: | ---: | ---: |
| 左折返 | +153ms | +18.0677px | +17.9046px | 0px |
| 右折返 | +159ms | -22.0386px | -21.9027px | 0px |

[基线逐帧图](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/baseline-flash-strip.png)、[基线摘要](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/baseline-summary.json)。原始 RAF PNG / trace / 原生截图保存在 `E:\WhiteMoon\work\chibi-left-edge-flash-residual-evidence\baseline-hbbhYR`。

## 4. 第二 root cause 与修复

**CONFIRMED**：`spineFaceDir` 的即时 recenter 使用 raw bbox 中心，后续 `scheduleFitSpine` 的 keepScale pass 使用可见整轮廓中心，两者不是同一水平锚点。不对称设备放大了差异，约150ms后的 fit 再推整个身体。旧左缘 fallback 已去除，仍有这个 renderer-local 原因，左右均可复现。

修复只让已证 `F_Chest` 的稳定 Move 使用同一身体核心：普通 walking fit 把核心放在 canvas 中央；纯方向镜像围绕已应用的核心反射，并让同一 fit generation 保持这个 X。缩放、Y 适配继续运行；新动画、尺寸或 owner 的普通 fit 释放镜像约束。覆盖 walkState 前保留此前是否行走的布尔快照，首次进入／恢复 Move 不误当纯方向翻转。可见左缘上报来自实际已应用 pose，避免发布 hypothetical fit 的旧位置。

没有该明确骨骼能力或不在上述 Move 条件时沿原有路径；没有新增骨骼别名、配置、框架或 Motion Substrate 改写。

## 5. 前次验收为什么遗漏

原 maxStep(window.x) 只能约束窗口。EDGE-T6 用 raw bbox 模拟翻转，且关闭可见像素采样，不能观察延迟 fit 的实际轮廓重新居中。

本次直接渲染当前 actual stage 到 RenderTexture，取真实 alpha 与 PNG，独立记录身体骨骼和上半身像素。没有把拟议 fit 的投影当实际画面。整 sprite 质心受到设备换边影响，不能单独充当身体视觉中心。

## 6. 修改文件

- `renderer/pet.js`：Move 身体锚点、镜像 fit 约束及实际 geometry 上报；当前 pose 精确 Spine alpha 命中。
- `src/clickability.js`：Spine 命中委托精确回调，移除 walking 130px 外扩圈。
- `tests/render-lifecycle-contract.test.js`：不对称设备、左右 mirror / delayed fit / compact、代际释放、实际 inset、当前 alpha 命中。
- `tests/clickability-recovery.test.js`、`tests/spine-hit-test.test.js`：透明点、外侧点、身体及左右命中合同。
- `scripts/e2e-chibi-edge-visual.cjs`、`scripts/e2e-chibi-walking-clickability.cjs`：隔离的真实 Electron 验收与证据输出。
- 本报告及代表图片 / 摘要。高频采样在专用验收脚本内，不引入 production logging framework。

## 7. Regression / verification

Root 在不改 checkout 的条件下，把精确 baseline 源码注入新增六项合同：**0/6 pass、6 fail，exit 1**。最终候选定向完整组合：**274/274 pass、0 fail，exit 0**，覆盖 renderer lifecycle、V2 locomotion、既有 Live2D 命中、chat-panel-side 和 clickability。

ESLint 对变更源／回归／edge 脚本检查 exit 0；仅有 renderer 既有三条 unused-variable warning，无新增 error。`git diff --check` 通过。独立只读源码审查未发现 Critical / Important 问题，明确没有用审查替代原生或视觉验收。

旧实现 RED 日志：`E:\WhiteMoon\work\chibi-left-edge-flash-residual-evidence\red-baseline.log`；注入器只取 baseline 的两份源文件，不修改 worktree。

## 8. 真实 Electron 重复折返结果

最终无遮挡运行：`E:\WhiteMoon\work\chibi-left-edge-flash-residual-evidence\bug03-visual-tIl00D`。

5 次左折返 + 5 次右折返；**3208 个实际 RAF 帧，10/10 通过，0 canvas 碰边，0实际裁剪，0提示气泡遮挡**。

- 窗口单步最大：1px。
- 身体核心 local 单步最大：3.318e-8px（浮点误差）。
- calculated screenCharacterX（当前 native x + DOM canvas anchor + 当前 F_Chest local）单步最大：1.000000009px。
- 独立上半身 alpha 质心：local 最大6.362px、screen 最大7.362px，发生在方向镜像本身，帧条显示脸相对躯干的偏心换侧；+150ms 未再整体平移。

数值门是辅助，最终结论还经过 root 对十组舞台帧及无遮挡原生窗口截图逐组视觉审查。

## 9. 左右比较

两边均保留当前 Move entry，核心都在 canvas x=60；窗口、strip anchor、宽度未产生额外跳变。最小实际左右余量各1px。padding RenderTexture 在代表翻转／+150ms检查完整设备像素，没有以画布内被裁掉的质心掩盖裁剪。

所有十次逐项指标：[edge-summary.json](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/edge-summary.json)。

## 10. 视觉证据与对齐限制

- [最终代表帧条](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/final-walking-core-flash-strip.png)。
- [十次 actual stage 帧总览](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/final-walking-core-turn-overview.png)。
- [十次无遮挡原生窗口总览](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/final-walking-core-compositor-overview.png)。
- [原生 capture 相对 RAF 的实际偏差](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/edge-overview-frames.json)。

屏幕位置计算使用 frame 时间之前最后一次实际 setPosition/setSize/setBounds 完成后的 native bounds，其有效区间延续到下一次 native mutation。16ms轮询只是辅助；不把最近轮询当同帧保证。capturePage 是独立异步窗口截图，偏差明确记录，不伪称与 RAF 完全同时。

以下方案已否决，保留反例：

- [REJECTED：整 sprite 质心镜像](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/rejected-centroid-flash-strip.png)：数字质心连续，头和躯干仍有明显平移。
- [REJECTED：旧偏侧 fit + 核心保持](E:/WhiteMoon/work/chibi-left-edge-flash-residual-v0.1/docs/bug03/evidence/rejected-core-clipping-flash-strip.png)：身体连续但设备裁剪。

## 11. 残余与证据边界

**CONFIRMED**：本次精确 winter、稳定 Move 的左右折返原症状消除，未发现新增身体平移或设备裁剪。

**CONFIRMED counterexample**：正确初始 dir / face、距左边界1px、speed1时，首次 Move 后43ms自然折返，取消尚未执行的150ms普通定位。身体核心保持约44px，完整装备左侧超出画布14–15px；149个测量帧中143帧实证裁剪。证据保存在 `E:\WhiteMoon\work\chibi-left-edge-flash-residual-evidence\bug03-visual-2Yf7D6`。这一有效反例与此前被排除的 seed 方向竞争不同，目前不能以稳定 Move 的5/5结果覆盖它。

**UNKNOWN**：其他皮肤。

日常产品 checkout 与运行实例未被覆盖；本次自动化和模型视觉审查不等于用户日常实例的人类验收。

## Walking hit-test（独立验收）

**CONFIRMED source defect**：原 Spine `#pet` 整块 DOM 接受命中，且 walking 额外130px圆圈会接受透明点。现按当前实际 Spine pose 的1px alpha判定，CSS client 经实时 DOM rect映射到 stage；画布外、透明、未就绪／退役 owner 返回 false。保留现有气泡、输入、信息、drag及其它渲染模式语义，不改变 interaction pause policy。

完整原生鼠标矩阵仍在最后验收，当前 **WALKING HIT-TEST: PARTIAL**。尚未把 idle / walking左右 / 透明内外 / 后方TARGET / 左缘反转前后及 stationary cursor 全部实证闭合。无效方向标签、旧坐标和测试层级错误的运行不计最终通过。

## 12. Commit

本报告与最终源代码一起在修复分支提交。确切 SHA 在最终交付消息中给出，避免在同一 commit 内写入自己的不可自引用 SHA。

## 13. Git status / integration

最终提交后再次验证修复分支 clean，并复核 canonical 精确 baseline clean；结果随最终交付消息给出。没有 merge、push 或替换日常产品实例。

# Spine 姿势裁切与错位专项交接（2026-08-24）

> 本文档专门交给下一位模型继续解决「Spine 大姿势、横姿、坐姿偶发裁切/错位」问题。
> 先读 `docs/optimization-progress.md`，再读本文件。不要重做其它已完成的日程、DPAPI、TTS、窗口屏障等功能。

---

## 1. 问题现象

用户连续提供了以下截图现象：

1. 横向/躺姿角色被 120×120 画布裁切，只显示半身或横向部分。
2. 坐姿/大姿势时头部、脚部会在上下边缘同时被裁切。
3. 有时角色整体偏到气泡/输入栏/桌面其它元素位置，表现为“莫名其妙崩坏”。
4. 任务栏、桌面图标、程序窗口顶上会出现明显脚底空隙，或只有半条腿。
5. 某些皮肤/姿势正常，某些（尤其横姿、Move/Sit/Interact 过渡、大附件姿势）异常。

用户最近截图的典型表现：角色横向旋转，右侧/上侧被裁切；之后又出现站姿被放大、头脚同时超出 canvas。

---

## 2. 环境

| 项目 | 路径 |
| --- | --- |
| 源码 | `E:\SuzuranPetGit` |
| 实际部署 | `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources\app\` |
| exe | `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\苏苏洛桌宠 1.1 正式版.exe` |
| userData | `C:\Users\xsbil\AppData\Roaming\苏苏洛桌宠 1.1 正式版\` |
| 日志 | userData `logs\tts.log` |
| 截图 | `C:\Users\xsbil\Pictures\Screenshots\` |

要求：中文；禁止推送 GitHub；不 commit（除非用户要求）；改源码后必须同步部署并重启验证；不要覆盖 userData。

---

## 3. 关键架构

### 3.1 固定几何

`renderer/pet.css`：

```css
.pet {
  position: absolute;
  right: 2px;
  bottom: 26px;
  width: 120px;
  height: 120px;
}
html, body { overflow: hidden; }
```

Pixi canvas 使用 `petEl.clientWidth/clientHeight`，通常也是 120×120。

**不要轻易扩大 `.pet`、canvas 或 BrowserWindow。** 主进程行走、`groundGap`、`charInset`、任务栏/窗口顶/图标落点都依赖这块固定角色条带。扩大画布会影响桌宠整体布局与边界逻辑。

### 3.2 当前 fit 流程

主要文件：`renderer/pet.js`，函数 `fitSpinePose()`。

当前思路：

1. 每次动画切换调 `scheduleFitSpine()`。
2. fit timers 当前是 `150 / 500 / 1000 / 1800 / 2800 / 4200ms`。
3. 每次 fit：
   - 先 reset `spineObj.position`；
   - 先设 `spineBaseScaleX` baseline scale；
   - `getBounds()` 测当前动画帧；
   - 根据 `(W-safe*2)/bounds.width`、`(H-safe*2)/bounds.height` 算 `k`；
   - 使用结构 bounds 居中/贴底；
   - render texture alpha sampling 只用于 `visibleCanvasGap`，理论上不再移动 x/y。

当前关键片段（应先重新读取当前源码确认）：

```js
const baseline = Math.abs(spineBaseScaleX);
spineObj.position.set(0, 0);
spineObj.scale.set(baseline * face, baseline);
spineObj.updateTransform();
let b = spineObj.getBounds();
const k = Math.min(1, (W - safe * 2) / b.width, (H - safe * 2) / b.height);
const mag = baseline * k;
spineObj.scale.set(mag * face, mag);
spineObj.position.set(0, 0);
spineObj.updateTransform();
b = spineObj.getBounds();
spineObj.x += (W - b.width) / 2 - b.x;
spineObj.y += H - (b.y + b.height);
```

### 3.3 groundGap

`visibleCanvasGap` = alpha 可见底边到 canvas 底部的差值。

当前意图：

```text
groundGap = layoutGap + visibleCanvasGap
```

其中：

```js
layoutGap = document.documentElement.clientHeight
  - (petEl.offsetTop + petEl.offsetHeight)
```

主进程使用 `walk.groundGap` 统一定位：任务栏、图标、窗口顶都依赖它。

**重要：** 已尝试过用 alpha bottom 直接移动 `spineObj.y`，会导致 Sit/过渡姿势把脚推到 canvas 外，已撤回。alpha 当前只用于 groundGap。

---

## 4. 已尝试修复与结果

### 已做

| 尝试 | 结果 |
| --- | --- |
| `spineBoost > 1` 时跳过 bounds containment | 防止正常 boosted skin 因 metadata 空白变小，但横姿/大姿势必裁切，已废弃。 |
| 裁切后 alpha visibleK 二次缩放 | 无效，因为 canvas 外内容已裁切，采样看不到完整姿势，已移除。 |
| 使用 alpha bottom 直接改 `spineObj.y` | 会把 Sit/过渡腿推到 canvas 外，出现半条腿，已撤回。 |
| 清除 x/y 累加漂移 | 已改为每次 fit reset position 再绝对居中/贴底。 |
| 结构 bounds containment | 当前已接入，但用户仍反馈偶发裁切，说明当前结构 bounds/动画帧/自动放大交互仍有问题。 |
| 延长 fit timer 到 4.2 秒 | 已尝试，仍有偶发姿势崩坏；更长 fit 不是根治。 |
| `spineBaseScaleX` 自动放大后同步更新 | 已做，避免自动放大后又缩回。 |
| `visibleCanvasGap` 限制 12px，连续两次稳定才更新 | 已做，防止单帧将窗口推太低。 |
| `geometryReportTimer` 未声明导致 init() 中断 | **已修复**（2026-08-24 晚）：`scheduleGeometryReport()` 引用了从未声明的 `geometryReportTimer`，`"use strict"` 下抛 ReferenceError，async `init()` 在 `applyScale()` 处中断，`setRenderMode("spine")` 永远不执行 → Spine 模式从未初始化（表现：重启后渲染层只有音频日志、无 `[spine]` 日志）。已加 `let geometryReportTimer = null`。 |
| `spineFaceDir` 破坏等比缩放 | **已修复**（2026-08-24 晚）：朝向翻转用未缩放的 `spineBaseScaleX` 覆盖 `scale.x`，却保留 fit containment 缩小后的 `scale.y`，造成左右拉伸（实测 `[diag:stretch] scale=(0.289,0.281) ratio=1.030`，发生在 pose=Sit + 拖拽/朝向翻转时）。已改为以当前 `|scale.y|` 为基准只翻转符号，保持等比。用户实测拖动正常。 |

### 最新失败模式（拖动拉伸已解决，裁切仍待查）

2026-08-24 晚已定位并修复**拖动时小概率左右拉伸**（见上表两行），根因不是渲染层其它缩放路径，而是 `spineFaceDir` 与 fit containment 的等比失配 + `geometryReportTimer` 导致 Spine 未初始化。

**仍在观察/未解决的问题（本次未涉及）：**

- 横向姿势右侧/头部裁切；
- 大站姿头脚同时裁切；
- 坐姿错位。

这些仍需更可靠的方法测量**完整姿势范围**，而不仅是当前 120×120 canvas 里的 getBounds 或被裁切 render texture。

### 诊断设施现状（临时，定位拉伸用）

`renderer/pet.js` 保留：`diagLog`（fit/anim/stretch/drag 四类，各自限频 400ms + 总量上限）、渲染层 `error`/`unhandledrejection` 上报（`[render-error]`/`[render-reject]`，写入 tts.log）、200ms 等比看门狗（检测到 `|scale.x|≠|scale.y|` 即自愈并记 `[diag:stretch]`）。确认问题不再复现后可移除。

### 下次注意（拖拽模拟失败记录）

模拟拖拽脚本（SetCursorPos + mouse_event）若发现窗口移动但 `[diag:drag]` 无日志：窗口可能处于点击穿透态（`setIgnoreMouseEvents(true, {forward:true})`，见 main.js:2627），穿透后渲染层收不到任何鼠标事件、无法自行恢复 clickable——属独立问题，本次用户实测正常，暂不处理。

---

## 5. 下一模型应优先做的事情

### 第一步：只做诊断，不要再盲调数值

给 `fitSpinePose()` 增加限频诊断日志（通过 `window.petAPI.playback` 写入 tts.log），但不要记录用户内容/密钥：

```text
[spine] pose=<animationName>
canvas=<W>x<H>
baseline=<...>
preBounds={x,y,w,h}
containK=<...>
postBounds={x,y,w,h}
visible={x0,y0,x1,y1}
scale=<...>
fitGeneration=<...>
```

对用户截图对应皮肤（很可能是 `1001_amiya2_sale_16` / 其它阿米娅或罗德岛医疗服模型）切：

- Relax
- Move
- Sit
- Sleep
- Interact
- 横向/大附件姿势

采集每个 timer 时刻的 bounds。确认：

1. `getBounds()` 是否真的包含完整超框姿势；
2. bounds 是不是仍在动画混合后继续变大；
3. alpha 是否已经裁切；
4. `spineBaseScaleX` 是否在某姿势被意外写大。

### 第二步：建议的技术方向

优先考虑以下其中一个，不要混用大量补偿：

#### 方案 A（推荐）：临时离屏大画布测量

1. 创建比 120×120 大很多的临时 `RenderTexture`（例如 512×512 或按结构 bounds 自适应）。
2. 将当前 Spine 在该离屏纹理内渲染，得到完整 alpha bounds，不被主 canvas 裁切。
3. 用完整 alpha bounds 计算当前姿势最终 containment scale。
4. 回到固定 120×120 主 canvas 使用最终 scale、一次性绝对居中/贴底。
5. `visibleCanvasGap` 同时从完整 alpha bottom 推导；不要从已裁切主 canvas 推导。

这样保留固定主画布和行走几何，但能测到完整横姿。

#### 方案 B：按动画预计算最大 bounds

- 对每个 animation 在加载后/首次播放时在较大离屏画布采样若干帧，缓存 `{scaleLimit, groundGap}`。
- 切换到该动画时用缓存的稳定 containment，避免混合帧抖动。
- 复杂但最稳定；适合 Sit/Move/Interact 等固定动画。

### 第三步：主进程配合

- 只在 final/稳定 pose geometry 上报后重定位 taskbar Sit。
- `walk.perched`（窗口顶）与 `walk.seated`（任务栏/图标）要保持不同 sink 语义。
- `setSpineMood()` 应用 Sit 保护时要覆盖 `seated || perched`。
- 不要把 `seatSink` 当作脚底补偿。它是“坐入任务栏”的视觉语义，不是 renderer feet calibration。

---

## 6. 已知坐标/窗口问题

- `walkSetPosition()` 曾触发 Electron native conversion failure；已加入 try/catch/范围保护，x 最小强制 1。
- `safeSetPosition()`、`walkSetPosition()`、普通 walkTick、jump/approach 均需继续保持安全定位。
- desktop 模式拖动中已跳过 magnet，松手才判断；自由落点清 returning 等状态。
- 半挂状态 `taskbarHang` 当前可用，但视觉仍需结合 Sit feet 统一调整。
- 窗口顶 y 当前应为：

```js
perchTopY = targetWindowTop - petWindowHeight + walk.groundGap
```

- desktop 窗口顶/跳跃/返回期间临时置顶，否则会被普通窗口盖住。

---

## 7. TTS/日程/安全当前状态（不要破坏）

- userData 已迁移；`config.json` 无明文 chat/Cosy/Agent key；`secrets.v1.json` DPAPI encrypted。
- Agent API 严格路由/body limit/可选 token 已完成。
- 日程 `src/schedules.js` + `renderer/schedule.*` + Excel `xlsx` 已完成；托盘/设置入口已加。
- Genie 服务端 `/tts` 的 LAST_REF_AUDIO/mkstemp 已修。
- TTS renderer 播放、Cosy/Edge 超时、GSV warmup/初版 breaker 已完成；不要回退这些修改。

---

## 8. 验证流程

```bash
cd /e/SuzuranPetGit
node --check renderer/pet.js
node --check main.js
```

同步部署：

```powershell
$repo='E:\SuzuranPetGit'
$app='E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources\app'
Copy-Item "$repo\renderer\pet.js" "$app\renderer\pet.js" -Force
Copy-Item "$repo\main.js" "$app\main.js" -Force
taskkill /F /IM '苏苏洛桌宠 1.1 正式版.exe'
Start-Process 'E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\苏苏洛桌宠 1.1 正式版.exe'
Start-Sleep 12
Get-Content "$env:APPDATA\苏苏洛桌宠 1.1 正式版\logs\tts.log" -Tail 50
```

截图：`SetProcessDPIAware` + `GetWindowRect` + `CopyFromScreen`，保存 `C:\Users\xsbil\Pictures\Screenshots\`，再用 Read 看图。

---

## 9. 禁区

- 不推送 GitHub；不 commit（除非用户要求）。
- 暂时不发布 Release。
- 不删除/覆盖 userData、`secrets.v1.json`、config、history、assets、音频或模型。
- 不打印 API key、token、DPAPI ciphertext。
- 不再靠盲调 `seatSink`、`groundGap` 或固定 px 偏移反复打补丁；先采集完整姿势测量数据。
- 用户明确不需要多桌宠同屏互斥。

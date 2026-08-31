# 转交文档：v2.2 已收尾，接手下一阶段（2026-08-25 晚）

> 给下一位模型/会话。**先读 `docs/optimization-progress.md`（全局权威账本），再读本文件。**
> 本文件原是 PSD 2.5D 模块的专项交接，v2.2 收尾后升级为当前总转交文档。

---

## 一、上一会话完成了什么（全部已部署验证，不要重做）

### 1. PSD 2.5D 角色模式（v2.2 主线功能，可用）
- 与 GIF/Spine 完全独立的第三种渲染模式（`rigSkinId` / `renderMode="rig"` 驱动，互斥互不干扰）
- WebGL 运行时 `renderer/rig-runtime.js`（源自 Anime2.5DRig 提取，mesh warp + 发丝物理 + 眨眼）；自动装配 `renderer/rig/rigger.js` + `genericparts.js`
- 入口：设置页渲染模式下拉第三项 / 托盘「🎬 2.5D 角色」开关与皮肤列表 / PSD 工具窗口导入→预览→应用
- 设置页大小滑杆 0.3~1.5 实时生效；窗口尺寸 = 300 × round(460×rigScale)
- rig 独立布局：角色画布贴底占窗口高 88% 居中可拖动；气泡左上角（edge-left 自动翻右上角）；输入框贴底；⤢ 放大气泡时角色让位到 45%

### 2. 聊天气泡「留白」根因修复（用户已确认效果 ✅）
- **根因**：`.bubble { white-space: pre-wrap }` 把 index.html 里按钮间缩进换行保留成约 70px 幻影空行，正文被推出气泡可视区
- **修复**：pre-wrap 移到 `#bubble-text`；rig 非放大态 max-height 12%→34%（原值 < min-height 被击穿成细条）；rig 模式忽略设置页固定气泡宽度；`initRig` 清残留内联宽高；`showBubble()` 重置 scrollTop；`destroyRig` 恢复外观
- **⚠️ 防回归红线**：`.bubble` 本体必须保持 `white-space: normal`，pet.css 有注释，勿改回

### 3. 收尾三件套（按约定在用户确认后执行完毕）
- **诊断日志清理**：已删 `[rig-render]` 3s 画布采样（rig-runtime.js）、`[settings] rig-scale input`（settings.js）、`[rig] 大小调整`（pet.js）。保留一次性的 `[rig] 加载/就绪/失败` 生命周期日志。重启后日志零残留。
- **CHANGELOG**：`CHANGELOG.md` 新增 v2.2.0 小节（2.5D 模式 + 气泡修复 + 日志清理）
- **基线**：`backups/original/` 已更新为 **v2.2.0 干净基线**（含 BASELINE.md 说明）；旧基线移至 `backups/v2.1-final-baseline/`
- 版本号：package.json + package-lock.json → 2.2.0，已同步部署并重启验证

## 二、当前状态快照

- 部署 exe 正常运行中，rig 皮肤 `seethrough_output.psd` 已加载（19 部件），日志安静无报错
- userData 在 `C:\Users\xsbil\AppData\Roaming\苏苏洛桌宠 1.1 正式版\`，config：renderMode=rig、rigScale=0.3
- 源码 `E:\SuzuranPetGit` 与部署目录相关文件 MD5 一致（改动后必须同步，见约束）

## 三、下一阶段建议（按优先级，详见 progress 文档 §7）

1. **P1 发布管线**：`scripts/release/` 的 staging 构建/密钥扫描/SBOM/checksum/provenance 尚未走通。⚠️ 当前工作树有大量未提交改动，不要直接从工作树打包发布（progress 文档顶部有明确警告）。
2. **P2 运行安全与数据治理**：Agent API token 生成体验、GSV mutex、历史/日志治理、CSP 补强等（§7 P2 清单）。
3. **P3 兼容性人工复验**：Win10/11 多 DPI、多屏负坐标副屏、抛掷/窗口顶驻留姿势矩阵（§7 P3 清单）。
4. **行走引擎遗留疑点**：`walkTick setPosition 失败`间歇出现（约 0.3–1.5 条/秒），检查逻辑已验证完备但仍有转换异常，需在 `safeSetPosition` catch 里补打 px/py + getBounds 现场再捕获一次定位根因（§6.1 有完整分析）。

## 四、关键文件索引（rig/气泡相关）

| 文件 | 职责 |
| --- | --- |
| `renderer/rig-runtime.js` | 2.5D WebGL 运行时（渲染循环/物理/表情参数） |
| `renderer/rig/rigger.js`、`genericparts.js` | PSD 图层自动装配 |
| `renderer/pet.js` | `initRig`/`destroyRig`/`applyRigScale`/`rigPresetForMood`/气泡逻辑 |
| `renderer/pet.css` | `body.rig-mode` 布局 + `.bubble`/`#bubble-text` 规则 |
| `renderer/render-rig.js` | ⚠️ 死代码（模块化实验遗留，未被任何页面引用），勿误改 |
| `main.js` | rig IPC（`pet:rig-*`、`pet:set-rig-scale` clamp 0.3~1.5）、`pet:set-size` |
| `src/config.js` | `rigSkinId`/`rigScale` |

## 五、验证工具箱（实测有效的经验）

1. **CDP 远程调试（布局问题首选）**：Electron 带 `--remote-debugging-port=9222` 启动 → `http://127.0.0.1:9222/json/list` 拿 ws 地址 → WebSocket `Runtime.evaluate` 读 DOM/computedStyle/getBoundingClientRect → 可注入临时 `<style>` 做 A/B 实验。**比截图像素分析可靠得多**。验完必须正常方式重启（去掉端口）。
2. **vision skill**（`node C:/Users/xsbil/.zcode/skills/vision/vision.js <图> "<问题>"`）：连通正常。局限：会被第三方悬浮窗污染、常把输入栏误认成气泡、坐标估算粗糙。适合定性确认（文字内容/有无空白），不适合精确测量。
3. **PowerShell 截图**：`SetProcessDPIAware` + `GetWindowRect` + `CopyFromScreen`；脚本写文件后要补 UTF-8 BOM（`printf '\xef\xbb\xbf' > t.ps1 && cat x.ps1 >> t.ps1 && mv -f t.ps1 x.ps1`）。
4. **触发气泡的确定性路径**：重启应用 → 开场白自动显示约 20 秒（persona 开场白），期间截图即可测真实多行文本布局；UI 点击输入框发消息不可靠（首次点击可能被吞、窗口位置会变）。
5. **像素测量**：System.Drawing GetPixel 扫白色块/暗色文字行可行，但透明窗背后的应用会污染结果，先确认背景干净。

## 六、约束与禁区（持续有效）

- 中文沟通；不推送 GitHub（除非用户要求）；不 commit（除非要求）
- 改源码后必须同步部署 `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources\app\` 并重启验证（MD5 核对）
- 不要覆盖 userData；不打印密钥/token/DPAPI ciphertext
- 2.5D 与 Spine 完全独立，不要混用渲染逻辑（用户明确要求）
- 备份链：`backups/original/`=v2.2 基线 → `backups/v2.1-final-baseline/`=v2.1 终态 → 更早见 BASELINE.md

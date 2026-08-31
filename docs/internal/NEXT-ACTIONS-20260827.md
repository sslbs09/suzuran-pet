# 苏苏洛桌宠 · 后续行动卡（2026-08-27，自包含）

> 本卡是当前工作状态的唯一入口：**拿到这份文档就知道现状、知道接下来干什么、怎么干**。
> 无需翻阅其它文档或聊天记录。配套文件均可直接使用。

---

## 0. 一句话现状

安全测试（Roadmap C）第 1 遍已在 VM 内完成：**S01-S08 七项通过、S05（DLL 侧载）查出真实弱点未修**；宿主生产代码处于最新已部署状态（含今日全部修复），VM 有回滚快照，等待下一步。

---

## 1. 已完成（有据可查）

| 项目 | 位置/结果 |
|---|---|
| 安全测试执行脚本 + 双遍结果表（第 1 遍已填） | `docs/SECURITY-TEST-EXEC-20260827.md` |
| 第 1 遍结果明细与结论 | `docs/optimization-progress.md` §14 追加 97 |
| VM 全新安装验证（语音/协议修复的验证） | §14 追加 93/94 |
| 本轮共部署的功能修复（PSD 删除/渲染贴地/语音探测等） | §14 追加 90-96，宿主正式版已全部生效 |

**第 1 遍安全测试结果速览**：S01 ✅ / S02 ✅（无传播，附环境蓝屏 1 次归因环境）/ S03 ✅ / S04 ✅ / S05 ❌ / S06 ✅ / S07 ✅ / S08 ✅ / S09-S12 未执行。

---

## 2. 当前环境状态

| 项 | 值 |
|---|---|
| 宿主代码 | `E:\SuzuranPetGit`；正式版 `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版`（已同步最新） |
| VM | `SuzuranPet-TestVM` **running（headless）**；快照 `pre-sec-test`（回滚点）；guest 已禁用 wuauserv（防再更新）；`C:\petapp-fresh` 为最新代码副本 |
| VM 内应用 | 当前**未运行**；config 状态复位为 `agreed=true, fileGuard=true` |
| 测试资产 | `E:\vmwork\`：自签证书 mitm-cert/key.pem、假 API 脚本 mitm-fake-api.py（已停）、s03-payloads.json、日志副本 |
| 应用 key | VM 无 key（secrets 空；config 明文 key 会被启动脱敏清除——S04 附带发现） |

---

## 3. 下一步行动（按优先级）

### D. 【已完成 2026-08-28】§14 追加 102 四项
- 渲染崩溃诊断（主窗口日志升级 + 9 子窗口 attachCrashDiag 挂载）
- 出厂打包模板（deploy/config.template.json + deploy/README.md 打包 SOP）
- 世界书（src/world-info.js 按关键词情境注入，chat 已接入）
- 向量记忆 v1（src/vector-memory.js：本地哈希向量 + cosine 检索 + 加密存储 + features.vectorMemory 开关；chat 已接入入库/回引）
- Agent 测试铁律：**中文 body 一律 `--data-binary @UTF-8文件`**（curl -d 直传中文会 GBK 乱码污染上下文）

### A. 【已完成】修复 S05：DLL 侧载弱点
- **已完成两档**（§14 追加 98 + 101，均已部署验证）：
  1. **启动完整性自检** `src/dll-guard.js`：exe 目录 dll 基线 + 启动对比，单点变化告警、大量变化判升级自动重建基线。
  2. **数字签名**：正式版 exe 已用自签名代码签名证书签署（CN=SuzuranPet Dev Signing）；dll-guard 对新增/替换 dll 做 Authenticode 签名校验，未签名 → 告警标注「高强度侧载嫌疑」。VM 受控验证完整链路生效。
- **能力边界（如实）**：签名不改 Windows Loader 行为——无效 version.dll 致启动失败现象不变（等价 DoS）；方案价值在「可发现可诊断」+ 完整性基准。**仍可选**：asar 打包（防 resources 篡改）、商业签名证书（对外 SmartScreen 信任）、WDAC 策略（系统级拦未签名 dll）。

### B. 第 2 遍交叉复测（另一模型执行）
- **目标**：独立复跑安全测试，填 `SECURITY-TEST-EXEC-20260827.md` 结果表的「第 2 遍」列，对比差异。
- **范围**：**S01-S08**（第 1 遍已有结果必须复测）；S09-S12 第二遍为**可选**（第 1 遍已完成，见该表）。
- **步骤**（已在脚本文档 §0/附录 B）：
  1. `VBoxManage snapshot SuzuranPet-TestVM restorecurrent`（回到 pre-sec-test）→ `startvm --type headless`
  2. 等 guest 就绪（约 1-2 分钟；若长时间不可用，截图确认是否又进 Windows 更新，预案见脚本文档 §0）
  3. 停 pet → `robocopy Z:\ C:\petapp-fresh /E`（**必须：快照回滚会把 petapp-fresh 还原成旧版（无 dll-guard 等最新改动），robocopy 同步宿主最新代码**）→ 启动 pet
  4. 按脚本文档 S01→S08 逐条执行。**前置注意（回滚后快照状态）**：
     - `agreed=false`（回滚还原）→ 跑 S03 前需先"同意条款"（停 pet → 改 AppData config agreed=true → 启动，等同点击同意；否则 14 条 payload 全被条款闸拦截，测不到注入层，且这一步不影响 file-guard）；
     - `fileGuard` 未开（回滚还原）→ S08 前需先设 `fileGuard=true` 再重启（否则 tamper 不触发，见第 1 遍 S08 备注）；
     - `security-dll-baseline.json` 缺失（回滚还原）→ 首次启动会重建基线，正常。
  5. 结果填「第 2 遍」列，差异/备注栏写与第 1 遍的不同点（尤其 S02 蓝屏是否复现、S05 是否仍 FAIL）。

### C. 第二批深测（S09-S12，需在 VM 内装工具）
- S09 Nmap（下载 nmap，扫 127.0.0.1 端口指纹）、S10 Burp/Fiddler MITM 全链路、S11 Process Hacker（确认 S05 dll 实际加载 + 注入尝试）、S12 Wireshark 外联抓包。
- 前置：VM 需能联网下载工具（NAT 有外网）；做完把结果续填到脚本文档结果表。
- **状态（2026-08-27 已完成）**：S09 用 PowerShell 等价扫描（Nmap 源下载失败）✅；S10 用系统信任库验证（certutil，判据与 Burp 相同）✅；S11 用 P/Invoke 模块取证+远程线程注入 ⚠（无注入防护，机制修正为 LoadLibrary 搜索劫持）；S12 以 S06/S11 覆盖（Wireshark 驱动过重未装）。详见 §14 追加 99 + 双遍表。

### D. （低优先）记录/核实
- S02 期间的 Windows 蓝屏（Event 41）为环境归因；如复测不再出现即可结案，无需深挖。

---

## 4. 命令速查

```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
"$VBM" snapshot SuzuranPet-TestVM restorecurrent        # 回滚到测试起点
"$VBM" startvm SuzuranPet-TestVM --type headless         # 启动
"$VBM" controlvm SuzuranPet-TestVM screenshotpng E:/vmwork/sh.png   # 截图（看图必须走 vision skill）
# 宿主→VM 同步最新代码（先停 VM 内 pet）
"$VBM" guestcontrol SuzuranPet-TestVM run --exe "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" \
  --username pet --password "PetTest123!" -- -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep 2; robocopy Z:\ C:\petapp-fresh /E"
# 宿主侧自签假 API（S04 用；用完 Ctrl+C 停）
python E:/vmwork/mitm-fake-api.py
```

## 5. 红线与约定（沿用项目惯例）

- **截图一律走 vision skill（`vision.js`），禁止直接 Read 图片**。
- 改代码：dev 改 → node --check + 全量单测（现有 13 套）→ 部署 MD5 校验 → 重启 5 进程 → 日志实证 → 记账（§14 追加编号顺延，当前到 97）。
- VM 测试只动 VM 内；宿主配置/密钥不碰；蜜标文件与翻译缓存不动。
- 测试用 EICAR 样本为纯检测串（无执行逻辑）；测试完恢复 Defender 实时防护。
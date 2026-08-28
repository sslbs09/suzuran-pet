# 苏苏洛桌宠 · 安全测试第 2 遍复测指引（2026-08-27）

> **自包含**：本文件是第 2 遍交叉复测的唯一入口，拿到即可独立执行，不需要其它文档或聊天记录。
> 第 1 遍已完成并记录（账本 §14 追加 97/98/99、双遍表 `docs/SECURITY-TEST-EXEC-20260827.md` 第 1 遍列）。
> 本遍目的：**独立复跑 S01-S08 并对照**，把「第 2 遍」列回填到双遍表；发现与第 1 遍不同的点写在差异栏。

---

## 0. 目标与范围

| 必做 | 说明 |
|---|---|
| S01-S08 | 第 1 遍已有结果，必须独立复跑 |
| 差异关注点 | S02 蓝屏是否复现（第 1 遍归因环境）；S05 是否仍 FAIL（第 1 遍已加 dll-guard 兜底，仍预期 FAIL 加载面） |
| S09-S12 可选 | 第 1 遍已完成（PowerShell 等价扫描/证书链/注入/覆盖） |

## 1. 环境速览

| 项 | 值 |
|---|---|
| VM | `SuzuranPet-TestVM`（VirtualBox 7.2.16），`pet` / `PetTest123!`，headless |
| 快照 | `pre-sec-test`（回滚点；**回滚会把 VM 还原到测试前状态，见 §2.3 注意**） |
| 应用副本 | `C:\petapp-fresh\`（回滚后为旧版，**必须重新同步**） |
| 外设 | `Z:` 只读共享 = 宿主 `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版`（**当前最新代码**） |
| AppData | `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版` |
| 日志 | 同目录 `logs\tts.log`（UTC 时间戳） |

## 2. 前置步骤（第 1 遍踩过的坑，务必照做）

### 2.1 回滚 + 启动 VM（宿主机 Git Bash）
```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
"$VBM" snapshot SuzuranPet-TestVM restorecurrent     # 回到 pre-sec-test（VM 需关机态；正在运行先 acpipowerbutton）
"$VBM" startvm SuzuranPet-TestVM --type headless
# 等 guest 就绪（冷启动约 1-2 分钟；超过 5 分钟不可用 → 截图确认是否又进 Windows 更新，预案见 §7）
```

### 2.2 同步最新代码 + 启动 pet
```bash
# guest 内执行（PowerShell，经 guestcontrol；中文参数用 EncodedCommand，模板见 §8）
Stop 苏苏进程 → robocopy Z:\ C:\petapp-fresh /E → 启动 C:\petapp-fresh\苏苏洛桌宠 1.1 正式版.exe
# 确认：5 进程 + curl http://127.0.0.1:8765/health 返回 ok
```

### 2.3 回滚后状态提醒（快照还原导致，勿惊慌）
- `agreed=false` → **跑 S03 前必须先"同意条款"**（停 pet → 改 AppData config `agreed=true` → 启动；等同用户点击同意；否则 S03 payload 全被条款闸拦截）。
- `fileGuard` 未开 → **S08 前开**：停 pet → 改 config `fileGuard=true` → 启动（启动时自动开启，见 main.js:3350）。
- `security-dll-baseline.json` 缺失 → 首次启动自动重建（正常）。
- petapp-fresh 是旧版 → §2.2 的 robocopy 会同步成最新（含 dll-guard）。

## 3. 逐条测试（每项：操作 / 预期 / 判定）

### S01 基线
- 操作：pet 运行后：进程数；`curl http://127.0.0.1:8765/health`；日志 grep `[security]`。
- 预期：5 进程（VM 环境 6 也算正常）、health `{"ok":true,...}`、`[security]` 安全自检行。
- 判定：任一不过 → 停测，先修环境。

### S02 EICAR 染毒兼容
- 操作：
  1. guest：`Set-MpPreference -DisableRealtimeMonitoring $true`
  2. 生成 EICAR 样本（guest 内直接 echo 标准串写文件，或 base64 解码；两个位置：桌面 `eicar.com` + AppData 下 `_eicar_test.bin`）
  3. pet 运行 60s；对比 AppData 文件数（`Get-ChildItem <ud> -Recurse -File | Measure`）前后不变
  4. 恢复：删样本 + `Set-MpPreference -DisableRealtimeMonitoring $false`
- 预期：文件数不变（无传播）、pet 无应用级崩溃、日志无 `[guard]` 告警外新异常。
- 判定：通过；若复现蓝屏（Event 41）→ 记差异（第 1 遍归因环境层）。

### S03 8765 注入面
- 操作：guest 用 curl（**必须 --data-binary @文件 传体，避免 PowerShell 剥引号**）逐条 POST `/chat`，payload 清单见 `E:\vmwork\s03-payloads.json`（14 条：路径穿越/命令注入/SQLi/超长/非法输入）；每条响应记录。
- 预期：全部 `{"ok":false,"error":...}`（未配置 key 时统一"未配置 API Key"；`text=null` 专属"text 不能为空"；关键=**无执行、无回显、无崩溃**）。
- 判定：结束后 health 仍 200、进程数不变 = 通过。
- 提示：本场景已同意条款（§2.3），否则会被条款闸拦截（第 1 遍已见，勿误判）。

### S04 HTTPS 证书校验
- 操作（宿主侧即可完成等价验证）：
  1. 宿主：`python E:/vmwork/mitm-fake-api.py`（自签 HTTPS：0.0.0.0:9443，CN=fake-mitm-api）
  2. 宿主 Node：`fetch("https://127.0.0.1:9443/health")` → 应 REJECTED `DEPTH_ZERO_SELF_SIGNED_CERT`
- 预期：Node/Electron 同一 TLS 栈拒绝自签；应用 `chatOpenAI` 无禁校验代码（代码审计）。
- 判定：拒绝 = 通过（应用不接受伪造证书）。
- 注意：VM 内无法注入有效 key（safeStorage 可用时 config 明文 key 被启动脱敏清除，S04 第 1 遍发现），所以不必在 VM 内强测；如需更强的本地验证用宿主 Node 即可。

### S05 DLL 侧载（重点，预期仍 FAIL）
- 操作：
  1. 基线：正常重启 pet → 日志应有「`[security] DLL 基线已建立（8 个）`」（dll-guard）
  2. 放 64 字节随机内容 `C:\petapp-fresh\version.dll` → 重启 pet → 记录进程数与日志
  3. 删 dll → 重启 pet → 对照组
- 预期：放假 dll 后进程退化（1 个）/AgEnt 无响应且**自检日志未打出**（原生层加载失败早于 main）＝第 1 遍同；删后恢复 5-6 进程。
- 判定：与第 1 遍一致则记录"仍 FAIL（加载面）＋ dll-guard 兜底存在"；若第 2 遍现象不同（如自检日志出现）→ 记差异。

### S06 端口/外连
- 操作：`netstat -ano | findstr LISTENING` 过滤 8765/9880/9881；`Get-NetTCPConnection -State Established` 按 pet PID 过滤。
- 预期：仅 `127.0.0.1:8765`（9880/9881 语音未部署闭合）；est治外连为 0（无对话时）。
- 判定：无 0.0.0.0 监听、无未知外联 = 通过。

### S07 洪水 DoS
- 操作：guest 内 2-3 个 Start-Job 并发 curl `/health`（每 job 30 次）→ 结束后单发 health、查进程数。
- 预期：串行/部分 429、**服务不崩**（health 恢复 200、进程数不变）。
- 判定：通过。

### S08 配置篡改回归
- 前置：§2.3 已开 `fileGuard=true`。
- 操作：pet 运行中，外部改 AppData `config.json`（如 agreed 翻转，用 `[IO.File]::WriteAllText` 无 BOM 写回）→ 等 6-8s。
- 预期：日志 `[guard] 防御触发[tamper]: 检测到配置被外部程序篡改，已自动恢复干净版本（备份为 config.json.tampered）`；`.tampered` 文件存在；config 恢复为启动基线。
- 判定：告警+恢复+备份齐 = 通过。

## 4. 结果记录（本遍填写，并回填双遍表）

将结果填到 `docs/SECURITY-TEST-EXEC-20260827.md` 结果表的「第 2 遍」列（与第 1 遍并排便于对照），差异写「差异/备注」。

## 5. 红线与约定

- **截图一律走 vision skill（`vision.js`）**，禁止直接 Read 图片。
- 只动 VM 内；宿主配置/密钥不碰；蜜标/翻译缓存不动；测完恢复 Defender。
- 改任何 VM 配置先停 pet（应用运行时改 config 会触发 file-guard tamper，属预期行为但会干扰前置）。
- 本遍完成后：停 VM 内 pet、VM 保持 running；在账本追加一条第 2 遍结果（编号顺延 100）。

## 6. 第 1 遍结论速览（对照基线，勿当结论照抄）

S01-S08：S05 ❌（DLL 搜索顺序劫持，已加启动自检兜底）、S07/S08 等其余 ✅；S09 ✅ / S10 ✅ / S11 ⚠（无注入防护）/ S12 覆盖。详见账本 §14 追加 97-99。

## 7. 故障预案

- guest 长时间不可用：截图（vision）确认是登录/更新/黑屏；若又是 Windows 更新卡住 → poweroff → restorecurrent → 重启 → guest 内 `sc config wuauserv start= disabled` 防再生。
- guestcontrol 报 "guest execution service is not ready"：等 30-60s 重试（登录未完成）。

## 8. Guest 命令模板

```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
B64=$(python -c "import base64;print(base64.b64encode('''<脚本>'''.encode('utf-16-le')).decode())")
"$VBM" guestcontrol SuzuranPet-TestVM run --exe "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" \
  --username pet --password "PetTest123!" -- -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$B64"
# 拉结果（中文结果建议 base64 输出，避免 GBK/CLIXML 污染）
"$VBM" guestcontrol SuzuranPet-TestVM copyfrom --username pet --password "PetTest123!" "<guest路径>" "E:/vmwork/<本地名>"
```
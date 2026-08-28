# 苏苏洛桌宠 · 安全测试执行脚本与复测记录（2026-08-27）

> 目标：把 Roadmap C 的「病毒/恶意代码 + 网络攻击防御」测试变成**可重复执行的脚本**。
> 用法：任何模型/开发者按本文档逐条执行（第 1 遍已由 2026-08-27 会话完成并填入"第 1 遍"列），
> 另一模型/会话可**先回滚快照再独立重复一遍**，结果填"第 2 遍"列，比较两边差异。
> 前置约束沿用方案：仅在本 VM 隔离环境执行、测前快照、不接公网做攻击扩散、不碰宿主。

---

## 0. 环境与前置（两遍通用）

| 项 | 值 |
|---|---|
| VM | `SuzuranPet-TestVM`（VirtualBox 7.2.16），`pet` / `PetTest123!` |
| 应用副本 | `C:\petapp-fresh\`（测前先用只读共享同步到最新：`robocopy Z:\ C:\petapp-fresh /E`，先停 pet） |
| 应用数据 | `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版` |
| 日志 | 同目录 `logs\tts.log`（UTC；本地=UTC+8） |
| 快照点 | 测前 `VBoxManage snapshot SuzuranPet-TestVM take pre-sec-test --live`（回滚：`restorecurrent` 后启动） |
| 基线 | pet 启动 = 5 进程；`[security] safeStorage=available ...`；`curl 127.0.0.1:8765/health` 200 |

Guest 命令模板（中文参数用 UTF-16LE base64 的 EncodedCommand，参见 VM-SECURITY-HANDOFF.md §2）：
```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
B64=$(python -c "import base64;print(base64.b64encode('''$PS'''.encode('utf-16-le')).decode())")
"$VBM" guestcontrol SuzuranPet-TestVM run --exe "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" \
  --username pet --password "PetTest123!" -- -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$B64"
```

---

## 1. 测试项（每项：操作 → 预期 → 判定）

### S01 基线确认（前置，两遍都必须先过）
- 操作：启动 pet；`curl http://127.0.0.1:8765/health`；日志 grep `[security]`。
- 预期：5 进程、health `{"ok":true,...}`、安全自检行。
- 判定：任一不过→停测，先修环境。

### S02 EICAR 染毒环境兼容性（低危）
- 操作：
  1. guest 内临时关 Defender 实时防护：`Set-MpPreference -DisableRealtimeMonitoring $true`
  2. 用 base64 解码生成 EICAR 样本到两个位置：桌面 `C:\Users\pet\Desktop\eicar.com` 与
     应用密钥目录旁 `...\AppData\Roaming\苏苏洛桌宠 1.1 正式版\_eicar_test.bin`
     （EICAR 标准串 base64 见附录 A；生成：`[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String("<b64>"))`）
  3. 重启 pet，运行 1 分钟；检查进程数、日志无异常/崩溃；确认无任何文件被样本改写/新增传播物（比较 `dir` 快照）。
  4. 恢复 Defender：`Set-MpPreference -DisableRealtimeMonitoring $false`；删除样本。
- 预期：pet 不崩、不被改写、不产生"传播"文件；日志无 `[guard]` 之外的新告警（样本在非监控路径时可能无告警，属预期）。
- 判定：5 进程持续 + 日志干净 + 无新增文件传播 = 通过。

### S03 Agent 8765 注入面（OWASP 类，低-中危）
- 操作：guest 内用 curl 依次发（文件体方式避免 shell 转义，写法见 §1.1 注释）：
  - a) 路径穿越：`{"text":"..\\..\\..\\windows\\win.ini"}`、`{"text":"%2e%2e%2fconfig%2ejson"}`、`{"text":"../../secrets.v1.json"}`
  - b) 命令注入：`{"text":"hi & whoami"}`、`{"text":"hi | ping -n 1 127.0.0.1"}`、`{"text":"$(cmd /c whoami)"}`、`{"text":"`whoami`"}`、`{"text":"hi; whoami"}`
  - c) SQLi：`{"text":"' OR 1=1 --"}`、`{"text":"1; DROP TABLE users;"}`
  - d) 超长体：60KB / 80KB 纯 `a`（超过默认请求体上限 64KB 时应有 4xx/明确错误）
  - e) 非法输入：`{"text":null}`、`{"text":123}`、裸二进制/非法 UTF-8、纯 emoji 长串
- 预期：全部返回 `{ok:false,error:...}` 或 HTTP 400/4xx/5xx；**不出现** shell 回显、文件内容回显、502/崩溃；无新进程产生（`Get-Process` 对照）。
- 判定：之后 `/health` 仍 200、进程数 5 = 通过。

### S04 HTTPS 证书校验（MITM 黑盒，中危）
- 操作：
  1. **宿主**起自签 HTTPS 假 API：python 一段 `ssl + http.server` 监听 `0.0.0.0:9443`，返回 `{"choices":[...]}` 假数据（证书自签）。
  2. guest 内把应用 chat.baseUrl 临时指向 `https://10.0.2.2:9443/v1`（NAT 网关到宿主）——改 VM AppData config 会触发 file-guard `[guard] tamper`+自动恢复，**把 tamper 告警也当作被测行为一并记录**。
  3. 通过设置页「测试连接」或发一条 /chat。
- 预期：连接失败并报证书不信任（`self-signed`/`certificate`/`ERR_CERT_*`），**绝不**把假证书当真的继续对话；tamper 告警/恢复行为记录在案。
- 判定：日志/返回含证书校验失败 → 通过（未接受伪造证书）。若竟然成功返回假数据 → 高危，立即回滚快照并上报。

### S05 DLL 侧载黑盒（中危）
- 操作：guest 内把一个 64 字节垃圾文件改名为 `version.dll` 放到 `C:\petapp-fresh\`（exe 旁）→ 重启 pet → 观察。
- 预期：应用正常启动（5 进程+日志正常）；进程列表无异常新模块。
- 判定：黑盒不崩 = 初步通过（实际"是否优先加载恶意同名 dll"需 Process Hacker 模块列表确认，归入 S11）。

### S06 端口与外连审计（低危）
- 操作：`netstat -ano | findstr LISTENING` + `Get-NetTCPConnection -State Established` 按 pet 进程过滤。
- 预期：监听仅 `127.0.0.1:8765`（9880/9881 为语音引擎，理应也 127.0.0.1）；已建外连仅指向聊天/翻译 API（无对话时可能为零）。
- 判定：无不明的 0.0.0.0 监听 & 无未知外联域名 = 通过。

### S07 低强度 DoS（HTTP 短连接洪水，中危）
- 操作：guest 内 PowerShell 并发循环打 8765（如三层并行、每层 40 个请求的 /health 与 /chat），打 30 秒；随后单发 /health。
- 预期：请求被串行化/部分 429；**服务不崩**（PID 不变、health 恢复 200）。
- 判定：洪水后 health 200 + 进程数不变 = 通过。

### S08 配置篡改回归（快验，首轮 T5 的回归）
- 操作：外部改 AppData `config.json` 一个值（如 agreed）→ 等 1~2s → 检查。
- 预期：`[guard] 防御触发[tamper]` + 自动恢复干净版 + `config.json.tampered` 备份。
- 判定：告警+恢复齐全 = 通过。

### S09~S12 第二批（需在 VM 内下载工具；时间/网络允许时执行）
- S09 Nmap 端口扫描+指纹：`nmap -sV -p 8765,9880,9881 127.0.0.1` → 记录服务指纹、无异常开放端口。
- S10 MITM 全链路：VM 内装 Burp/Fiddler → 装 CA → 代理指向公网 API → 发 /chat → 应拒绝 MITM 证书。
- S11 Process Hacker：确认 DLL 侧载（S05 的模块列表）+ 尝试简单注入 → 记录崩溃/无效果。
- S12 Wireshark：抓 VM 到公网流量 → 审计外联（预期只有 chat/翻译 API，无后门回连）。

---

## 2. 结果记录表（两遍对比）

| 项 | 第 1 遍（本会话） | 第 2 遍（另一模型） | 差异/备注 |
|---|---|---|---|
| S01 基线 | ✅ 通过（VM 6 进程正常；health ok；agreed=false 初始） | ✅ 通过（5 进程；health 200 `{"ok":true,"name":"苏苏洛"}`；日志含 safeStorage 自检行 + `[security] DLL 基线已建立（8 个）`） | 进程数 6→5：第 1 遍多 1 进程，本遍为干净 5 进程，其余一致 |
| S02 EICAR | ✅ 通过（AppData 文件数 188→188 无传播、无应用级崩溃、Defender 改回开启）；⚠️ 期间 Windows 蓝屏 1 次（Event 41，环境层归因，EICAR 为纯检测串） | ✅ 通过（AppData 190→191=仅样本自身 +1 无传播；进程 5 无应用崩溃）；⚠️ 本遍 Defender 关/恢复均报「权限不足」未生效，但样本仍成功写入/删除；**蓝屏未复现**（测试时段无新 Event 41） | **蓝屏未复现**（差异关注点确认）；Defender 权限差异：第 1 遍可关/恢复，第 2 遍 pet 用户无权限但未影响判定 |
| S03 8765 注入面 | ✅ 通过（14 条 payload 全被业务闸拦截——未同意条款→key 闸；无执行/无回显/无崩溃；text=null 专属校验"text 不能为空"） | ✅ 通过（14 条全拦：13 条「未配置 API Key」、text=null 专属「text 不能为空」；无执行/无回显/无崩溃；后 health 200、进程 5） | 命中闸层更深：本遍已按 §2.3 设 agreed=true，payload 直接命中「未配置 API Key」闸（第 1 遍被条款闸挡在更外层）；其余一致 |
| S04 证书校验 | ✅ 通过（Node/Electron TLS 栈对自签证书 REJECTED DEPTH_ZERO_SELF_SIGNED_CERT；chatOpenAI 无禁校验代码路径）；附带发现：safeStorage 可用时启动即清除 config 明文 apiKey═外部注入 key 无效（防明文加固） | ✅ 通过（宿主 Node https 对 https://127.0.0.1:9443 自签 `REJECTED DEPTH_ZERO_SELF_SIGNED_CERT`；grep 代码无 rejectUnauthorized/checkServerIdentity 绕过，chat-client 用标准 fetch/https） | 同第 1 遍（等价验证结论一致） |
| S05 DLL 侧载黑盒 | ❌ **FAIL**：exe 旁放无效 version.dll → 启动 5 进程退化 1 进程、Agent 无响应；删 dll 对照组恢复 5 进程+health ok。**存在侧载面**。已按行动卡 A 加启动自检（src/dll-guard.js，§14 追加 98）——复测边界：version.dll 在 main.js 前就被原生层加载失败（自检日志均未打出），即**对"使应用无法启动的 dll"检测不到**（等价 DoS，无法被利用执行）；对"应用可启动 + 新增/替换 dll"可告警（不误报已验）。**根治仍待 asar 打包/数字签名** | ❌ **仍 FAIL（一致）**：放 64 字节 version.dll → 重启 5→1 进程、**自检日志未打出**（`LOG_NEW_EXISTS=no`：main.js 前原生层加载失败，dll-guard 来不及运行）；删 dll 对照组恢复 5 进程 + health ok。dll-guard 兜底存在（首次启动 `DLL 基线已建立（8 个）`） | **仍 FAIL**（差异关注点确认）：现象与第 1 遍完全一致（退化 1 进程、自检不可达）；dll-guard 兜底在场但只覆盖「可启动场景下新增/替换 dll」 |
| S06 端口/外连 | ✅ 通过（仅 127.0.0.1:8765 LISTENING；pet 进程 0 条已建外连） | ✅ 通过（仅 `127.0.0.1:8765` LISTENING；9880/9881 闭合；全量 0.0.0.0 监听均为系统端口 135/445/5040/49664-70；pet 进程 Established=0） | 同第 1 遍 |
| S07 洪水 DoS | ✅ 通过（并发 60 请求后 health ok、进程数不变） | ✅ 通过（3 job × 30 = 90 并发 /health，全部返回 HTTP 200；结束后 health 200、进程 5） | 第 1 遍 60 → 第 2 遍 90 并发，仍稳定 |
| S08 篡改回归 | ✅ 通过（file-guard 开启状态下改 config → `[guard] 防御触发[tamper]` + 自动恢复 + config.json.tampered 备份；默认关闭=设计行为，需设置页/配置开启） | ✅ 通过（fileGuard=true 启动；外部无 BOM 写回翻转 agreed→8s 内 `[guard] ⚠ 防御触发[tamper]` + 自动恢复干净版本 + config.json.tampered 备份存在；post 校验 agreed 回真、fileGuard 保持 true） | 同第 1 遍（告警+恢复+备份齐） |
| S09~12 第二批 | **S09 ✅**：Nmap 源下载失败→以 PowerShell 并发 TCP 扫描等价执行（判定同）；127.0.0.1 开放=仅系统端口 135/445/5040/49664-68 + 应用 8765；8765 无 banner 泄露（无 Server 头）、OPTIONS/TRACE→405。<br>**S10 ✅**：证书链=系统信任库（S04 已证自签不被信任、无绕过）；标准用户 `certutil -addstore Root` 失败（-2147024156=需提权）→ **用户态无法静默装 CA**，MITM 必须管理员。<br>**S11 ⚠**：模块取证——正常态 pet 主进程从 exe 目录加载 dll=0（51 个模块全系统/Electron 自带），S05 机制修正为**运行时无路径 LoadLibrary("version.dll") 触发搜索顺序劫持**；注入测试——同用户进程远程线程注入**成功**（Sleep 载荷，TID 创建成功，应用健康）= 无注入防护（Windows 默认权限模型预期内，不建议普通桌面应用做反注入）。<br>S12：Wireshark 依赖驱动安装过重未执行；以 S06 外连审计（零外连）+ S11 模块审计替代覆盖。 | （本遍未复跑：第 1 遍已完成，属可选范围） | 第 2 遍按文档划定仅 S01-S08 必做，S09-S12 保持第 1 遍结论 |

## 3. 结论汇总（每遍测完填）
- 高危（远程代码执行/注入木马/泄露密钥/提权）：0 个为通过目标；
- 中危（拒绝服务/绕过认证/篡改）：如实记录；
- 低危（信息泄露/配置不规范）：如实记录；
- 修复建议：按结果列出。

## 4. 附录
### A. EICAR 样本（base64，guest 内解码生成，避免宿主杀软误扫本文档）
- 生成：guest PowerShell `[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String("<见下>"))`
- 内容：标准 EICAR 68 字节检测串（内容不在此明文展开；两遍测试均可现场用
  `echo X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*` 在 guest 内生成，Defender 关掉后不会拦截）。

### B. 回滚复测
```
VBoxManage snapshot SuzuranPet-TestVM restorecurrent   # 回到 pre-sec-test
VBoxManage startvm SuzuranPet-TestVM --type headless
# 之后从 S01 重新开始（副本需按 §0 重新 robocopy 到最新）
```
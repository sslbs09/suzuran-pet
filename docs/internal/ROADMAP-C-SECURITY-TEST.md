# Roadmap C：桌宠安全测试（隔离环境 VM 内执行）

> 环境：VirtualBox 7.2.16 + Windows 11 企业评估版 25H2（官方推广 ISO，90 天试用）。
> 目标：在本机隔离环境里验证桌宠的本地防御行为（蜜标监测/加密/认证/篡改检测），
> 不污染宿主、可随时重建。

## 1. VM 速查

| 项 | 值 |
|---|---|
| VM 名 | `SuzuranPet-TestVM`（虚拟机文件在 `C:\Users\xsbil\VirtualBox VMs\`，磁盘/ISO 在 `E:\vmwork\`） |
| 用户 | `pet` / `PetTest123!`（auto-logon，桌面就绪） |
| 桌宠 | 已复制到 guest `C:\petapp\`（从只读共享 Z: 拷入）；`Z:` = 宿主 `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版`（只读） |
| 系统 | Win11 企业评估版 10.0.26200.6584 zh-CN（UEFI+TPM2.0，Secure Boot 由 LabConfig 无碍） |

```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
# 启停 / 截图 / guest 命令
"$VBM" startvm SuzuranPet-TestVM --type headless
"$VBM" controlvm SuzuranPet-TestVM acpipowerbutton   # 优雅关；无响应则 poweroff
"$VBM" controlvm SuzuranPet-TestVM screenshotpng E:\vmwork\shot.png
# guest 执行（PowerShell EncodedCommand 方式最稳；或直跑 exe）
"$VBM" guestcontrol SuzuranPet-TestVM run --exe "C:\Windows\System32\cmd.exe" --username pet --password "PetTest123!" --wait-stdout -- /c ver
"$VBM" guestcontrol SuzuranPet-TestVM copyfrom --username pet --password "PetTest123!" "C:/Users/pet/x.txt" "E:/vmwork/x.txt"
```
Guest 内互传小文件：EncodedCommand（python 生成 base64）写文件 → copyfrom 拉回；大文件用只读共享 Z: 中转。

## 2. 测试清单（按序）

1. **蜜标/文件防护（file-guard）**：guest 内启动一个"恶意"进程读取
   `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版\config.json`（记事本拷贝/读句柄），
   观察桌宠是否记录访问事件/报警（宿主侧 fileGuard 逻辑；logTts 有 [security] 通道）。
2. **密钥落地与加密**：读 AppData config.json 的 chat.apiKey/ttsCosy.apiKey——
   safeStorage/DPAPI 加密（密文）还是明文；resources\app\config.json 是否有残留密钥
   （上一轮审计已清空宿主侧，VM 副本 Z:\resources\app\config.json 同理应复查）。
3. **Agent 接口（8765）**：guest 内 curl/probe：
   - 未授权、错 token 访问 `/chat` → 期望 401；
   - 正确流程 + 并发 5 连发 → 期望串行 200 + 超深 429（v2.6 并发锁）；
   - `/health` 信息泄露面。
4. **端口暴露面**：guest 内 `netstat -ano` 枚举监听端口（8765/9880/…），确认只绑定 127.0.0.1。
5. **篡改检测（memory/bond）**：改 bond.json / memory 文件内容 → 重启桌宠 →
   观察 `[security] 记忆文件异常（可能被外部修改），已重置` 日志（实测首次运行亦有该条，注意基线）。
6. **配置来源审计**：修 resources\app\config.json 某值 → 桌面宠 AppData 是否被其影响
   （已确认：首启会以 resources 配置为基准——这是当初密钥泄漏的根因，见 §3）。
7. **健壮性**：故意触发主进程异常路径（如把 ttsGenie 指到不存在 python → 让 Genie 拉服务），
   确认新增的 `process.on("uncaughtException"/"unhandledRejection")` 只记日志、不弹冻结对话框。

## 3. 本阶段已产出的修复与发现（2026-08-27）

- **修复（已上线宿主）**：main.js 增加全局 `uncaughtException / unhandledRejection` 兜底——
  VM 实测 `spawn E:\GenieTTS\...pythonw.exe ENOENT` 会弹 "JavaScript 错误" 冻结对话框，
  归因于主进程未捕获异常无处兜底；现在一律记日志不弹窗。
- **发现①**：应用首启以安装目录 `resources\app\config.json` 为基准配置（AppData 缺失字段从其继承）；
  这正是当初安装目录残留真实 API 密钥风险的结构性根因（密钥已在上轮审计清空，路径类字段仍在）。
- **发现②**：memory 首次运行无文件时日志报 `[security] 记忆文件异常…已重置为空`——
  属首启假阳性（无文件≠被篡改），待测试项 5 中定基线是否需优化提示文案。
- **发现③**：guestcontrol/共享文件夹在 VM 重启后生效（Z: 自动挂载）；copyto 对已存在目录有兼容问题，大文件走共享中转。

## 4. 测试结果（2026-08-27 首轮执行，VM 内）

| 项 | 结果 |
|---|---|
| T1 蜜标 honeytoken | ✅ 另一进程读 `_honeytoken_credentials.json` → `[guard] 防御触发[honey]: 被其他程序访问` |
| T2 密钥落地 | ✅ VM 内 chat/ttsCosy/bearer 全空（resources 已脱敏继承）；机制：secrets 模块（safeStorage/DPAPI）优先，config.json 仅回退；safeStorage=available |
| T3 Agent | /health=200 开放（泄露 name/agreed/invokeWord/authRequired，轻微）；/chat 无密钥→500（串行正常）；并发 5→全 500 串行（快速失败不重叠，未触发 429——429 兜底已由宿主真密钥并发测试验证）；bearerToken 401 路径存在（未运行时实测） |
| T4 端口 | pet 仅 127.0.0.1:8765；无其他暴露（VM 系统端口属 Windows 自身） |
| T5 篡改 | ✅ 外部改 config → `[guard] 防御触发[tamper]` + **自动恢复干净版本**（备份 `config.json.tampered`） |
| T6 配置来源 | 首启整份复制 `<app-dir>/config.json`（安装根）为 AppData 基线；resources/app/config.json 是另一份（密钥脱敏已做） |
| T7 健壮性 | ✅ 10 次启动均带坏 Genie 路径，0 次未捕获异常、0 个冻结框（全局兜底生效） |

**发现与建议**：
1. memory 每启报 `[security] 记忆文件异常（可能被外部修改），已重置为空`——疑似误报面过大（首启/正常启动都报），建议调优判定条件；
2. /health 泄露 agreed/name/invokeWord/authRequired——若对外，建议收敛（最小化：仅 ok+name）；
3. 蜜标 tamper 自动恢复是亮点（篡改内容备份留存），行为符合预期。

## 5. 后续

 后续
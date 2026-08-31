# VM 隔离安全测试 · 交接手册（给其他模型/开发者）

> 目标：让接手者不依赖宿主、直接在隔离的 Windows VM 里复测/扩展苏苏洛桌宠的安全测试。
> 主机在路边环境可直接照做；VM 已装好可立即开机。

## 1. 环境速览

| 项 | 值 |
|---|---|
| 虚拟机 | `SuzuranPet-TestVM`（VirtualBox 7.2.16，关机状态可用 `startvm` 拉起） |
| 客户机 | Windows 11 企业评估版 10.0.26200 zh-CN（UEFI+TPM2.0，90 天试用） |
| 配置 | 4GB 内存 / 2 核 / 64GB 磁盘（`E:\vmwork\SuzuranPet-TestVM.vdi`） |
| 凭据 | 用户 `pet` / 密码 `PetTest123!`（auto-logon，桌面就绪） |
| 应用副本 | 客户机 `C:\petapp\`（从只读共享 Z: 拷入；Z: = 宿主 `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版`） |
| 资源 | 宿主 `E:\vmwork\`（ISO 6.9G / VDI 38G / 截图与报告 rep*.txt） |

## 2. 控制速查（宿主机 Bash）

```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
"$VBM" startvm SuzuranPet-TestVM --type headless
"$VBM" controlvm SuzuranPet-TestVM acpipowerbutton     # 优雅关（失效再 poweroff）
"$VBM" controlvm SuzuranPet-TestVM screenshotpng E:\vmwork\shot.png
# 客户机执行（PowerShell EncodedCommand 最稳；base64=python UTF-16LE 编码）
"$VBM" guestcontrol SuzuranPet-TestVM run --exe "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" --username pet --password "PetTest123!" -- -NoProfile -ExecutionPolicy Bypass -EncodedCommand <b64>
# 拉/推文件：copyfrom/copyto 的源/目标请用位置参数（不用 --source/--target 键）
"$VBM" guestcontrol SuzuranPet-TestVM copyfrom --username pet --password "PetTest123!" "C:/Users/pet/x.txt" "E:/vmwork/x.txt"
```

- 画质验证：`screenshotpng` → 用 vision 看图（禁止 Read 直读图片）。
- 客户机写 echo/返回：EncodedCommand 写文件 → copyfrom 拉回最稳（--wait-stdout 输出易被 CLIXML 污染）。

## 3. 测试清单（7 项 + 结果）

| # | 项 | 期望 | 首轮结果（2026-08-27） |
|---|---|---|---|
| T1 | 蜜标 honeytoken | 另一进程读 `_honeytoken_credentials.json` → 日志 `[guard] 防御触发[honey]` | ✅ 触发 |
| T2 | 密钥落地 | safeStorage availability；config 无明文密钥；secrets 优先级 | ✅（VM 密钥为空；机制：secrets/DPAPI 优先，config 回退） |
| T3 | Agent 8765 | /health；未授权/限额；并发 5 → 串行+429 | ⚠️ /health 200（收敛后仅 ok/name/invokeWord/authRequired）；无密钥 chat→500 串行；429 由宿主真密钥并发验证过 |
| T4 | 端口暴露 | 仅 127.0.0.1:8765 | ✅ |
| T5 | 篡改 | 外部改 config → `[guard] 防御触发[tamper]` + 自动恢复 + `config.json.tampered` 备份 | ✅ |
| T6 | 配置来源 | 首启整份复制 `<app>/config.json`（安装根）为 AppData 基线 | ✅ 定案 |
| T7 | 健壮性 | 异常路径不弹冻结框、只记日志 | ✅（10 次启动 0 异常；全局 uncaughtException 兜底） |

## 4. 已修复/加固（宿主与 VM 同版，复测时注意）

- main.js 全局 `uncaughtException/unhandledRejection` 兜底（只记日志）。
- config.js/memory.js BOM 容忍（记事本 UTF-8 BOM 保存不再误读/误判篡改）。
- /health 收敛（不暴露 agreed）。
- 蜜标/篡改自愈、消息防抖、Agent 并发锁、情绪音色分档等批次均在 VM 或宿主实测过。

## 5. 复测/扩展建议（给接手者）

- 复测入口：改 VM 配置（**写回必须无 BOM**，见下）→ 重启 C:\petapp 应用 → 触发 → 拉 `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版\logs\tts.log` 看 [guard]/[security]/[main]。
- **写 VM config 的无 BOM 方法**：`[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`；带 BOM 会让 app JSON.parse 失败回落默认值（这是首轮采的坑）。
- 扩展方向（都在 VM 内做，不影响宿主）：勒索/蠕虫特征演练（批量改文件/放可疑 exe）、进程注入/hook 尝试、网络面（VM NAT 有外网，可测 chat 链路真鉴权）、DLL/钩子提权演练。
- 恢复干净环境：VM 内改回 app 配置，或直接销毁虚拟机重建（ISO/VDI 在 E:\vmwork 可复用）。

## 6. 已知坑（别踩）

1. guestcontrol 命令若"连接后无响应"——检查是否在握手前发命令（客户端须先收 101 再 send，否则 Chromium 静默丢弃）。
2. copyto 对"已存在目录"有兼容问题 → 改用共享 Z: 中转（只读）或位置参数直拷文件。
3. 客户机共享盘符为 `Z:`（`\\VBoxSvr\pet`），挂载映射在 VM 冷启动后才注册；即时 gussec 用 `net use` 会失败——重启客户机后再用。
4. 桌宠在 VM 里首次启动会显示《使用条款》窗口，属正常（agreed 由 config 控制）。
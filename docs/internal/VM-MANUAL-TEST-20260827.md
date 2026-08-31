# 苏苏洛桌宠 · VM 手动实测指引（2026-08-27）

> 给近期去 VM 里测功能的人看。VM 保持运行中，副本已同步到最新代码
> （含 §14 追加 96 的 PSD 皮肤删除、94 的语音路径提示+协议重置、95 的渲染切换贴地）。

---

## 1. 环境速览

| 项 | 值 |
|---|---|
| 虚拟机 | `SuzuranPet-TestVM`（VirtualBox 7.2.16，**当前 running**，勿 poweroff） |
| 客户机 | Windows 11 企业评估版 10.0.26200 zh-CN（4GB/2核/64GB） |
| 凭据 | 用户 `pet` / 密码 `PetTest123!`（auto-logon） |
| 应用副本 | `C:\petapp-fresh\`（**已同步到今天全部改动**，最新 exe 在此） |
| 分享盘 | 客户机 `Z:` = 宿主 `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版`（只读） |
| 应用用户数据 | `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版\`（当前=上次首启后的状态） |
| 日志 | 同目录 `logs\tts.log`（时间戳 UTC，本地=UTC+8） |

**想直接看界面**：VirtualBox 主界面选中该 VM 点「显示」即可（当前是 headless 启动，显示窗口会实时接管画面）；
若只见黑屏，是客户机锁屏——在显示窗口里按 `Ctrl+Alt+Del` 解锁，输入 `PetTest123!`。
**只看日志**：见第 3 节命令。

## 2. 待测功能与期望

### ① 已导入 PSD（2.5D 皮肤）删除 —— 最新，重点测
路径：设置（托盘 ⚙️ 或启动后任务栏图标右键）→「2.5D 角色」块 →「已导入皮肤列表」。
- 列表每项右侧应有「🗑」；点它 → confirm 弹窗 → 确认后该项消失，文件被删。
- **造测试皮肤**：把任意一个 .psd（可用假文件，几 KB 就行）放进
  `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版\assets\rig\user\`，
  重开设置页即出现在列表；或走应用内 PSD 工具导入。
- **删当前皮肤**：先点该项 radio 设为当前（显示「（当前）」）再删 → 会自动退出 2.5D 模式（
  角色切回 GIF、左上灯/下拉状态复位），不残留。
- 期望日志：`[rig] 删除 2.5D 皮肤: <名字>`。
- 边界（可测可不测）：删不存在的名字应提示「皮肤不存在」；文件名非 .psd 应被拒。

### ② 首次安装语音路径提示 + 协议重置（模拟新电脑，可选）
若想复现"全新电脑首启"：先停 pet 进程 → 删
`C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版` → 启动 `C:\petapp-fresh\苏苏洛桌宠 1.1 正式版.exe`。
- 期望 1：启动后弹《使用条款》窗口（`config.agreed=false`，不再被宿主模板带过跳过）。
- 期望 2：日志出现两条明确提示（不再有 `[main] 未捕获异常: spawn ENOENT`）：
  ```
  [genie] 引擎路径不存在（首次安装未配置，请到语音设置页配置）: python=E:\GenieTTS...; serverScript=...
  [gsv]   引擎路径不存在（首次安装未配置，请到语音设置页配置）: python=E:\GSV-training\...; serverScript=...
  ```
- 期望 3：设置页「🔄 重启日语语音服务」→ 显示「语音引擎路径不存在…」文案（不是笼统失败）。
- 说明：模板里 E:\ 路径是宿主机的，VM 上没有 → 这是预期行为（新电脑需自行配置语音）。

### ③ 渲染模式切换贴地（顺手回归）
设置页「渲染模式」在 GIF / Spine / PSD(2.5D) 之间切换：
- 每次切换角色应贴任务栏上沿、不悬空不陷地；日志出现 `[walk] 模式切换贴地: <mode> → (x,y) w x h`。
- Spine 模式下角色可走来走去；切回 GIF 行走自动停。

## 3. 命令速查（宿主机 Git Bash）

```bash
VBM="C:/Program Files/Oracle/VirtualBox/VBoxManage.exe"
# 拉日志（UTF-8 无损）
"$VBM" guestcontrol SuzuranPet-TestVM copyfrom --username pet --password "PetTest123!" \
  "C:/Users/pet/AppData/Roaming/苏苏洛桌宠 1.1 正式版/logs/tts.log" "E:/vmwork/latest.log"
# 客户机执行一条命令（PowerShell，中文需用 UTF-16LE base64，参考 git 历史）
"$VBM" guestcontrol SuzuranPet-TestVM run --exe "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" \
  --username pet --password "PetTest123!" -- -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | ? { `$_.ProcessName -like '*苏苏*' } | Select ProcessName,Id"
# 优雅关机 VM（别用 poweroff）
"$VBM" controlvm SuzuranPet-TestVM acpipowerbutton
# 再启动（不带 --type headless 则有显示窗口）
"$VBM" startvm SuzuranPet-TestVM
```

## 4. 注意

- **副本同步**：每次宿主改过代码并部署后，若要 VM 里也最新，重跑一次
  `robocopy Z:\ C:\petapp-fresh /E`（先在客户机停 pet 进程）。Z: 是只读映射，永远指向宿主最新。
- 客户机锁屏/黑屏是 headless 常态，不是应用问题。
- 测完把 pet 进程停掉即可，VM 保持 running。
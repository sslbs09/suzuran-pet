# 2025-2026 热门恶意软件威胁情报（隔离测试参考）

> 来源：Microsoft Security Blog / CrowdStrike 2026 GTR / Check Point / Symantec / The Hacker News 等 25+ 篇报告（2026-08 整理）。仅描述性攻击手法，不含恶意代码。

## 一、最活跃勒索软件
| 家族 | 关键手法 |
|---|---|
| Qilin（Agenda） | VPN/防火墙漏洞（PAN-OS CVE-2026-0257）入侵 → PsExec 横向 → 先禁 Defender 再加密；载荷藏 C:\PerfLogs\；`*`+6 随机小写注册表键 |
| INC Ransomware | SonicWall SMA 零日（CVE-2026-15409/10）→ Python KNUCKLEBALL + 代理 Suo5 + Java 木马 ORANGETAIL；窃 TOTP/MFA 种子；Rust 重写抗逆向；BYOVD 杀 EDR |
| The Gentlemen | 蠕虫式自称传播；5 种加密器（Win/Linux/ESXi）；GentleKiller 集成 8 种 BYOVD 驱动；大量 AI 辅助开发 |
| Akira | 合法签名驱动 sideload Bumblebee；SonicWall VPN 入侵；ClickFix 投放 SectopRAT |
| LockBit 5.0 | 两阶段 loader/载荷分离；DragonForce/Qilin 结盟 |
| GodDamn | AnyDesk 自启动服务 + NirSoft 凭据收割；**PoisonX（微软签名恶意驱动）** 关停防护 |
| Osiris | Rclone 外传 Wasabi 再加密；定制 RustDesk/Mimikatz；POORTRY 定制杀软驱动 |
| DeadLock | Rust 加密器；Polygon 智能合约链上恢复/谈判（去中心化） |

## 二、信息窃取器
- **Lumma**：ClickFix/恶意广告/破解包；窃浏览器+加密钱包助记词；FBI 归因 ~1000 万感染
- **StealC**：Amadey 加载器投放；窃截图/凭据/cookie/信用卡；俄乌白语言自杀
- **Amatera**：ClearFake + ClickFix 假 CAPTCHA；conhost --headless 隐藏执行；WebDAV 挂载；硬件断点绕 ETW
- **RedLine/PXA/Eternidade**：老牌窃取器仍活跃；PXA 用 Telegram 回传

## 三、RAT / 加载器 / 蠕虫 / 挖矿
- **Remcos/AsyncRAT**：LOLBin（MSBuild）+ RMM（ScreenConnect）伪装；AsyncRAT 伪装"Skype Updater"计划任务
- **SocGholish**：假"浏览器更新"弹窗 → 恶意 JS；IAB 主要渠道
- **GootLoader**：SEO 投毒 + WordPress 评论分发 XOR 加密 ZIP → Supper 后门；WinRM 17h 到域控
- **IronWorm/Miasma**（npm 供应链蠕虫）：盗 npm 账号发恶意包；窃 AI 助手（Codex/Claude/Cursor）凭据；eBPF rootkit；GitHub 自我复制
- **XMRig 蠕虫**：盗版软件捆绑 + 可移动介质传播（打穿气隙）；WinRing0x64.sys BYOVD 提权

## 四、Windows 桌面恶意行为模式（防御测试重点）
1. **初始投放**：ClickFix 假 CAPTCHA（Win+R 粘贴命令）、恶意广告/SEO、钓鱼+RMM、供应链（npm/WordPress/CDN）
2. **执行/绕过**：LOLBin（rundll32/mshta/msbuild/conhost --headless）、DLL sideload、无文件内存加载、反沙箱（时长/语言/鼠标）
3. **持久化**：注册表 Run、计划任务（伪装更新名）、自启动服务、**BYOVD 驱动**（杀防护）
4. **提权/横向**：PsExec/管理共享、RDP、WinRM、RMM（AnyDesk/ScreenConnect）
5. **窃取目标**：浏览器凭据/DPAPI/加密钱包/剪贴板/云与 AI 凭据
6. **C2**：滥用合法平台（FTP banner/GitHub/Steam/Telegram/Pinterest）

## 五、对桌宠防御的启示
- 恶意软件可能窃取：桌宠 DPAPI 密钥（secrets.v1.json）、userData 配置、剪贴板
- 对应防御已验证：蜜标监控（窃取检测）、tamper 阻断（配置篡改）、文件监控（持久化/投放）
- VM 测试时建议按"投放→持久化→BYOVD→窃取→横向→外传"链路设计检测点

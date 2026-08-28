# deploy/ —— 出厂分发打包 SOP（2026-08-28 建立）

> 目的：让「全新电脑安装」拿到**出厂态**而非"开发者/使用者状态"（§14 追加 93 的 VM 实测教训：
> 模板若带宿主语音绝对路径（E:\GenieTTS…）与 agreed=true，新用户会语音不可用且被跳过条款弹窗）。

## 1. 打包步骤（每轮发版时按序执行）

1. **同步代码**：dev（E:\SuzuranPetGit）→ 生产目录
   `E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\resources\app\`（MD5 校验见 §2 命令）。
2. **复制引擎与声音源（§14 追加 109/110 起）**：语音引擎（GenieTTS 中文 + GPT-SoVITS 日语）与苏苏洛模型随包分发，新用户开箱即用：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/copy-engines.ps1
   ```
   该脚本把宿主 `E:\GenieTTS`（venv+GenieData+my_model+CharacterModels+base-python）与
   `E:\GSV-training\GPT-SoVITS-v2pro-20250604`（runtime+GPT_SoVITS+api.py+最终模型+tools 依赖）
   复制到生产目录 `engines/`（约 15GB，不含训练日志/工具/多余 epoch 权重）。
   tts-manager 启动时自动探测 `engines/` 并回填 config（引擎+模型路径），新用户无需配置；Genie venv
   首次启动自动把 pyvenv.cfg 的 home 指向包内 base-python（venv 绑定宿主路径的问题）。
3. **重打 asar（§14 追加 104：resources 已改为 app.asar 打包运行，散目录不再被加载）**：
   ```bash
   bash deploy/pack.sh
   ```
   - 脚本会：旧散目录按 app_legacy 换新 → 用 npx asar 打包 → 生成新的 resources/app.asar。
   - 回退：删 app.asar 并把 app_legacy 改回 app（仍可跑散目录版）。
4. **替换出厂 config**：
   ```
   cp deploy/config.template.json "E:/SuzuranPetGit/release/v2.5/苏苏洛桌宠 2.5 正式版/config.json"
   cp deploy/config.template.json "E:/SuzuranPetGit/release/v2.5/苏苏洛桌宠 2.5 正式版/resources/app_legacy/config.json"
   ```
   - 该模板 = 产品纯净默认 + `agreed:false`（新用户首启必弹《使用条款》）+ 无任何 API Key
     + 无主机路径（ttsGenie/ttsGsv 的 python/serverScript 为空，启动时给出"未配置"明确提示，
     见 §14 追加 94）+ 默认聊天端点（api.deepseek.com/v1，用户自改）。
   - ⚠ 生产目录根 `config.json` 是**首启迁移模板**（`.storage-migration-v1.json` 标记后不读）；
     替换它不影响已运行用户（其生效配置在 AppData）。
5. **（仅商业分发时需要）签名 exe**：见 §3。
6. **打包 zip**（分发物，干净版：排除 app_legacy 回退件与单测文件）：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/publish.ps1
   ```
7. **冒烟**：按 §4 在 VM 里做"全新安装首启"验证（删 AppData → 启动 → 协议窗口 + 语音未配置提示 + 5 进程）。

## 2. 同步与校验命令

```bash
PROD="E:/SuzuranPetGit/release/v2.5/苏苏洛桌宠 2.5 正式版/resources/app"
for f in main.js <新增/改动文件>; do cp -f "/e/SuzuranPetGit/$f" "$PROD/$f"; done
for f in main.js <同上>; do
  [ "$(md5sum /e/SuzuranPetGit/$f | cut -d' ' -f1)" = "$(md5sum "$PROD/$f" | cut -d' ' -f1)" ] && echo "OK $f" || echo "MISMATCH $f"
done
```

## 3. 签名（自签即可，开源/个人自用无需商业证书）

> 开源项目或个人自用**不需要买商业证书**：自签（下方命令）已提供完整性校验与"有签名者"判定（dll-guard 用）。
> 商业代码签名证书（SmartScreen 信任）只在**对外商业化分发**时需要——届时再按同一命令换成商业证书即可。

```powershell
# 已有证书：Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object -First 1
Stop-Process -Name "*苏苏*" -Force -ErrorAction SilentlyContinue   # exe 占用时无法签名
Set-AuthenticodeSignature -FilePath "<exe>" -Certificate $cert -HashAlgorithm SHA256
Get-AuthenticodeSignature -FilePath "<exe>"   # 确认 Signer 出现
# 重新启动应用验证签名不破坏运行（5 进程 + /health）
```
- 当前自签证书：CN=SuzuranPet Dev Signing（thumb `0A3147C5F489EE5888B00F70C93515035381A5FA`，2029 到期）。
  对外正式分发建议替换为商业代码签名证书（SmartScreen 信任 + 消除"未知发布者"）。

## 4. VM 全新安装冒烟（引用 §14 追加 93/94 结论）

1. 停 VM 内 pet；删 `C:\Users\pet\AppData\Roaming\苏苏洛桌宠 1.1 正式版`；`robocopy Z:\ C:\petapp-fresh /E`。
2. 启动 → 期望：**弹《使用条款》**（agreed=false）+ 日志两条「引擎路径不存在（首次安装未配置…）」
   + 5 进程 + `/health` ok + `DLL 基线已建立`。
3. 测完停 pet；VM 保持 running。

## 5. 注意

- 蜜标 `_honeytoken_*.json` 与翻译缓存不在产物内（首启按需生成），无需处理。
- 每次发版同步 `deploy/config.template.json` 与 config.js 的新增字段（跑一次 §1.2 生成逻辑核对）。
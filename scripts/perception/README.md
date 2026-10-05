# scripts/perception — Phase 9 感知实验研究者工装（researcher-only）

本目录只服务 Phase 9（perception）实验协议，**不是产品代码**，不参与产品启动路径，
不修改 Character Runtime 行为、概率、台词或 memory 语义。

## 0. 为什么存在 fail-closed 隔离

Phase 9-B 期间发生过一次真实事故：两个诊断 Electron 实例漏设 `SUZURAN_TEST_USERDIR`，
`src/storage.js` 因此回落到真实产品 userData（`%APPDATA%\苏苏洛桌宠 2.5 正式版`），
写脏了 `logs/tts.log`、Chromium cache、Dawn/DIPS。

结论：**"记得设环境变量"不是安全机制**。本目录的工装改成 fail-closed——
任何一处缺失隔离路径，都必须拒绝启动，而不是悄悄用产品目录。

## 1. 环境契约（两个路径 + 一个标记，缺一即拒绝）

| 变量 | 必须的值 | 作用 |
| --- | --- | --- |
| `SUZURAN_TEST_USERDIR` | `<临时目录>/wm-perception-9b/<run>`（或其子目录） | snapshot root：storage.js 据此重定向全部状态写入 |
| `SUZURAN_WM_USERDATA_DIR` | 同一个 `<run>` 内的子目录（如 `<run>/udd-X`） | Electron `--user-data-dir`：Chromium 缓存 |
| `SUZURAN_WS_DIR` | 与 `SUZURAN_TEST_USERDIR` 同一个 `<run>` | launcher 的 workspace（含 sealed/ground-truth/observer） |
| `SUZURAN_PERCEPTION_EXPERIMENT` | `1`（仅实验启动） | 产品侧可选闸门：声明实验模式后，产品目录会被拒绝 |
| `SUZURAN_WM_ELECTRON_BIN` | 可选，绝对路径 | 覆盖 Electron 可执行文件（默认仓库内 `node_modules/electron/dist/electron.exe`） |

允许的实验根固定为 `<系统临时目录>/wm-perception-9b/<run 名>/`。
`<run 名>` 恰好一层，run 内部可自由分层（`base/`、`arm-X/`、`udd-X/` …）。

## 2. 三道闸门（全部 fail-closed，失败先于 Electron 启动）

1. **loader guard**（`isolation.js` + 各 worker 顶部）
   `snapshot-worker.js` / `replay-worker.js` / `launcher.js` 在**加载时**就断言隔离；
   缺失时抛 `PERCEPTION_ISOLATION_REFUSED`，且**早于** `src/storage.js` 被 require
   （storage.js 一旦被加载就按缺失态的 env 绑定路径——这正是事故的机制）。
2. **launcher guard**（`electron-launcher.js`）
   `buildElectronArgs` / `launchElectron` 在 spawn **之前**校验：
   snapshot root 与 `--user-data-dir` 必须属于同一次 run，且都在允许实验根内；
   拒绝产品路径、`%APPDATA%`、相对路径、缺 `--user-data-dir` 的启动。
   同时清掉 `ELECTRON_RUN_AS_NODE`（否则 electron.exe 会退化成纯 Node）。
3. **产品侧预检**（`electron-preload.js`，可选兜底）
   声明 `SUZURAN_PERCEPTION_EXPERIMENT=1` 时，在 `main.js` 顶部
   `require("./scripts/perception/electron-preload")` 可在 userData 落在产品目录时
   以 `app.exit(1)` 终止。未声明该标记时**零副作用**，产品启动路径逐字不变。
   本仓库当前**没有**接线到 `main.js`（刻意不改产品入口）；闸门已就位，需要时一行接入。

## 3. 运行方式

```powershell
$run = Join-Path $env:TEMP 'wm-perception-9b\run-001'
New-Item -ItemType Directory -Path $run -Force | Out-Null
$env:SUZURAN_WS_DIR        = $run
$env:SUZURAN_TEST_USERDIR  = $run
$env:SUZURAN_WM_USERDATA_DIR = Join-Path $run 'udd-X'

node scripts/perception/launcher.js init        # base snapshot + fork + sealed 分配 + 消融 + A/B diff
node scripts/perception/launcher.js replay      # 受控回放 + ground-truth manifest + 中性素材
node scripts/perception/launcher.js score-demo  # 研究者自评演练（强制 DRY-RUN / NON-DATA）
node scripts/perception/launcher.js reveal      # 揭封 + 与 ground-truth 对账

# Electron 最短冒烟（startup → isolated write → restart → shutdown，不等随机 proactive）
node scripts/perception/electron-launcher.js smoke
```

reset 由研究者在 workspace 之外手工 `Remove-Item` 完成：本目录的脚本**没有任何删除类
fs 操作**，也绝不触碰真实 userData。

## 4. 目录内容

| 文件 | 作用 |
| --- | --- |
| `isolation.js` | 唯一路径策略事实来源（allow/deny 判定 + 错误文案） |
| `launcher.js` | 协议编排：init / replay / score-demo / reveal |
| `snapshot-worker.js` | 真实 memory/config API 驱动的快照读写与语义导出 |
| `replay-worker.js` | 无头受控回放（FakeDate + timer 捕获 + 按 opportunity 的 random slot 同步） |
| `abdiff.js` | byte 层与 semantic 层 A/B 差异报告 |
| `materials.js` | 中性 X/Y 素材、ground-truth manifest、评分/编码模板 |
| `electron-launcher.js` | 唯一允许的 Electron spawn 点（含隔离配对断言） |
| `electron-preload.js` | 产品侧可选预检闸门（未接线，零副作用） |
| `fixtures/electron-smoke/` | Electron 冒烟探针（加载真实产品 main.js，快速自退） |

## 5. 纪律

- 正式 protocol 只认 repo 内版本化的 tooling；临时目录里的诊断脚本不算协议组成。
- 生成的 snapshot / 素材 / 回放产物一律落在实验 workspace，**禁止提交进仓库**。
- 不修改 `src/storage.js` 的产品默认行为；本目录只在研究侧收紧路径策略。

## 6. 跨平台语义（CI）

- **真实产品 userData 根不存在**（干净 CI / 非 Windows runner）是合法前置状态，不是安全失败：
  测试把清单表示为 `present:false`，并要求测试结束后仍然 `present:false`
  （即 protocol tooling 不能凭空创建 production 位置）。根若在测试期间出现或消失，判定 FAIL。
- **当前平台没有 Electron 可执行文件**时，Electron 面（启动计划 / 冒烟）记录为
  `NOT_VERIFIED` / `SKIPPED_NO_ELECTRON_BINARY`，**不伪造通过**；隔离 guard 的拒绝路径
  与真实角色状态不变式仍然全部照常断言。
- 需要在本机显式指定 Electron 时用 `SUZURAN_WM_ELECTRON_BIN=<绝对路径>`。

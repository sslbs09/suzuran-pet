"use strict";

/*
 * perception-protocol.test.js — Phase 9-B / 9-B.1 实验基础设施测试（researcher-only tooling）。
 *
 * 覆盖：
 *   A/B snapshot semantic diff / history mediator ablation / restart persistence /
 *   random synchronization / ground-truth manifest / observer 素材零条件泄漏 /
 *   sealed mapping 与 reveal 对账 / 真实 userData 零写入 /
 *   Phase 9-B.1 fail-closed isolation guard（缺 env、相对路径、产品路径、跨 workspace 配对）。
 *
 * 全部在 SUZURAN_TEST_USERDIR = <系统临时目录>/wm-perception-9b/<run> 下运行；
 * 对真实产品 userData 只做只读结构指纹比对（绝不创建/删除/写入真实 AppData）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const APP_DIR = path.resolve(__dirname, "..");
const SRC_PREFIX = path.join(APP_DIR, "src") + path.sep;
const PERCEPTION_PREFIX = path.join(APP_DIR, "scripts", "perception") + path.sep;

const isolation = require("../scripts/perception/isolation");
const TMP_ROOT = isolation.TMP_ROOT;
const EXPERIMENT_ROOT = isolation.EXPERIMENT_ROOT;

/* ---------- 真实产品 userData：只读内容哈希清单（绝不写入、绝不打印内容） ---------- */

const PROD_APPDATA = process.env.APPDATA || "";
const PROD_USERDATA_DIR = PROD_APPDATA ? path.join(PROD_APPDATA, "苏苏洛桌宠 2.5 正式版") : "";
const PROD_DIR = PROD_USERDATA_DIR || path.join(PROD_APPDATA || "C:\\no-appdata", "苏苏洛桌宠 2.5 正式版");

/** 角色状态清单候选（按仓库真实 storage 布局，涵盖 config/persona/memory/bond/history/secrets/schedules 等）。 */
const CHARACTER_STATE_ITEMS = [
  ["config.json", false],
  ["config.clean.json", false],
  ["persona.md", false],
  ["persona.default.md", false],
  ["bond.json", false],
  ["memory.json", false],
  ["memory-vector.json", false],
  ["schedules.json", false],
  [".storage-migration-v1.json", false],
  ["security-dll-baseline.json", false],
  ["secrets.v1.json", false],
  ["history", true],
  ["secrets", true]
];

/** 明确排除的易变非角色状态（Electron/Chromium 运行时缓存、日志、崩溃转储）。 */
const VOLATILE_DIR_NAMES = new Set([
  "logs", "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "blob_storage", "Local Storage", "Session Storage", "WebStorage", "Network", "Service Worker",
  "Crashpad", "cache", "CachedData"
]);
const VOLATILE_FILE_RE = /^(DIPS|DIPS-wal|SharedStorage|SharedStorage-wal|DevToolsActivePort|Local State|Preferences|.*\.log)$/;

/**
 * 只读内容哈希清单：对每个候选路径递归枚举常规文件，按归一化相对路径排序，
 * 记录 { size, sha256 }。读取失败绝不静默跳过——记录显式 sentinel（errors 非空即判定失败）。
 * 输出中不含任何文件内容。
 */
function captureCharacterStateManifest() {
  const files = {};
  const errors = [];
  const rootTag = PROD_USERDATA_DIR || "<no-appdata>";

  const addFile = (abs, rel) => {
    try {
      const buf = fs.readFileSync(abs);
      files[rel.replace(/\\/g, "/")] = { size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
    } catch (e) {
      errors.push(rel.replace(/\\/g, "/") + ":" + String((e && e.code) || "READ_FAILED"));
    }
  };
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      errors.push(rel.replace(/\\/g, "/") + ":" + String((e && e.code) || "READDIR_FAILED"));
      return;
    }
    for (const ent of entries) {
      const childRel = rel ? rel + "/" + ent.name : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (VOLATILE_DIR_NAMES.has(ent.name)) continue;
        walk(abs, childRel);
      } else if (ent.isFile()) {
        if (VOLATILE_FILE_RE.test(ent.name)) continue;
        addFile(abs, childRel);
      }
    }
  };

  if (!PROD_USERDATA_DIR || !fs.existsSync(PROD_USERDATA_DIR)) {
    return { root: rootTag, files, errors: errors.concat("<product-userData-absent>") };
  }
  for (const [rel, isDir] of CHARACTER_STATE_ITEMS) {
    const abs = path.join(PROD_USERDATA_DIR, rel);
    let stat = null;
    try { stat = fs.statSync(abs); } catch (e) {
      if (e && e.code !== "ENOENT") errors.push(rel + ":" + e.code);
      continue; // 不存在是合法状态（清单只记录实际存在的状态文件）
    }
    if (isDir && stat.isDirectory()) walk(abs, rel);
    else if (stat.isFile()) addFile(abs, rel);
    else errors.push(rel + ":UNEXPECTED_TYPE");
  }
  return { root: rootTag, files, errors };
}

/** 清单比较：逐条列出 added / removed / changed / errors，便于失败时定位；不打印内容。 */
function compareCharacterStateManifests(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of Object.keys(after.files)) {
    if (!(key in before.files)) added.push(key);
    else if (before.files[key].sha256 !== after.files[key].sha256 || before.files[key].size !== after.files[key].size) changed.push(key);
  }
  for (const key of Object.keys(before.files)) if (!(key in after.files)) removed.push(key);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    beforeErrors: before.errors.slice(),
    afterErrors: after.errors.slice()
  };
}

const characterStateBefore = captureCharacterStateManifest();

/** 真实角色状态零改动断言（fail-closed：清单错误、根路径漂移、任何增删改一律失败）。 */
function assertRealCharacterStateUnchanged(label) {
  const after = captureCharacterStateManifest();
  const diff = compareCharacterStateManifests(characterStateBefore, after);
  const detail = "root=" + after.root
    + " added=[" + diff.added.join(",") + "]"
    + " removed=[" + diff.removed.join(",") + "]"
    + " changed=[" + diff.changed.join(",") + "]"
    + " beforeErrors=[" + diff.beforeErrors.join(",") + "]"
    + " afterErrors=[" + diff.afterErrors.join(",") + "]";
  assert.strictEqual(after.root, characterStateBefore.root, label + "：产品 userData 根路径漂移（" + detail + "）");
  assert.deepStrictEqual(after.errors, [], label + "：哈希清单存在读取失败（fail-closed，不得静默跳过）（" + detail + "）");
  assert.deepStrictEqual(diff.beforeErrors, [], label + "：BEFORE 清单存在读取失败（" + detail + "）");
  assert.deepStrictEqual(diff.added, [], label + "：真实角色状态出现新增文件（" + detail + "）");
  assert.deepStrictEqual(diff.removed, [], label + "：真实角色状态出现文件丢失（" + detail + "）");
  assert.deepStrictEqual(diff.changed, [], label + "：真实角色状态内容 SHA-256 发生变化（" + detail + "）");
}

/* ---------- 测试 workspace：必须位于允许实验根之下 ---------- */

function mkWorkspace(tag) {
  try { fs.mkdirSync(EXPERIMENT_ROOT, { recursive: true }); } catch { /* 已存在 */ }
  return fs.mkdtempSync(path.join(EXPERIMENT_ROOT, tag));
}

function rmWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖断言 */ }
}

function freshModules(userDir) {
  process.env.SUZURAN_TEST_USERDIR = userDir;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_PREFIX) || key.startsWith(PERCEPTION_PREFIX)) delete require.cache[key];
  }
}

/** 以子进程方式跑 repo 内 researcher 入口（真实 CLI 语义：env 由外部给出）。 */
function runNodeEntry(entryRelative, args, env) {
  return spawnSync(process.execPath, [path.join(APP_DIR, entryRelative), ...args], {
    cwd: APP_DIR, env, encoding: "utf8", timeout: 300000
  });
}

const WORK = mkWorkspace("protocol-test-");
const baseDir = path.join(WORK, "base");
const armX = path.join(WORK, "arm-X");
const armY = path.join(WORK, "arm-Y");
for (const d of [baseDir, armX, armY]) fs.mkdirSync(d, { recursive: true });

/** 用隔离 guard 本身校验测试工作目录：测试路径策略必须与工装一致。 */
assert.strictEqual(isolation.assertPerceptionIsolation({ userDir: WORK }), path.resolve(WORK),
  "测试 workspace 必须通过 fail-closed guard");
assert.strictEqual(isolation.assertPerceptionIsolation({ userDir: baseDir }), path.resolve(baseDir),
  "snapshot 子目录必须通过 fail-closed guard");

const BASE_ENV = { ...process.env, SUZURAN_WS_DIR: WORK, SUZURAN_TEST_USERDIR: WORK };

try {

/* ================= 1) 真实 launcher.init 全链路（真实 CLI + 真实 env） ================= */

const initRun = runNodeEntry("scripts/perception/launcher.js", ["init"], BASE_ENV);
assert.strictEqual(initRun.status, 0, "launcher init 必须成功（stderr: " + String(initRun.stderr).slice(0, 300) + "）");
const initOut = JSON.parse(initRun.stdout);
assert.strictEqual(initOut.step, "init");
assert.strictEqual(initOut.sealed, true, "init 必须封存 assignment");
assert.strictEqual(initOut.restart, "RESTART_PERSISTENCE_OK", "restart 持久化必须通过");
assert.strictEqual(initOut.abSemanticVerdict, "ONLY_TARGET_FACT_DIFFERENCE", "唯一语义差异必须是 target mediator fact");

const assignmentSealed = JSON.parse(fs.readFileSync(path.join(WORK, "sealed/assignment.json"), "utf8"));
assert.notStrictEqual(assignmentSealed.X, assignmentSealed.Y, "sealed mapping 必须互斥");
for (const rel of ["ground-truth/dump-X.json", "ground-truth/dump-Y.json", "ground-truth/ab-diff-report.json",
  "ground-truth/restart-persistence.json", "NON-PRODUCT-EXPOSURE-MODE.txt"]) {
  assert.ok(fs.existsSync(path.join(WORK, rel)), "init 产物缺失: " + rel);
}

/* ================= 2) 语义层：唯一差异 = target fact；control 臂 mediator 消融干净 ========= */

const abdiff = require("../scripts/perception/abdiff");
const dumpX = JSON.parse(fs.readFileSync(path.join(WORK, "ground-truth/dump-X.json"), "utf8"));
const dumpY = JSON.parse(fs.readFileSync(path.join(WORK, "ground-truth/dump-Y.json"), "utf8"));
const contDump = dumpX.memory.facts.some((f) => f.type === "history:syn-001") ? dumpX : dumpY;
const ctrlDump = contDump === dumpX ? dumpY : dumpX;
assert.strictEqual(contDump.memory.facts.some((f) => f.type === "history:syn-001"), true, "continuity 臂必须含 history:* fact");
assert.strictEqual(ctrlDump.memory.facts.some((f) => typeof f.type === "string" && f.type.startsWith("history:")), false,
  "control 臂必须无任何 history:* fact（mediator 消融干净）");
assert.strictEqual(ctrlDump.memory.summary, "", "control summary 必须为空");
const abReport = JSON.parse(fs.readFileSync(path.join(WORK, "ground-truth/ab-diff-report.json"), "utf8"));
assert.strictEqual(abReport.byte.differ.length + abReport.byte.onlyInA.length + abReport.byte.onlyInB.length > 0, true,
  "byte 层应识别 memory.json 差异（与 semantic 层分开报告）");
assert.ok(abReport.byte.differ.some((d) => d.rel === "memory.json") || abReport.byte.onlyInA.some((d) => d.rel === "memory.json")
  || abReport.byte.onlyInB.some((d) => d.rel === "memory.json"), "byte 层差异清单需包含 memory.json");

/* ================= 3) restart persistence：freshModules 重载 = 新进程从磁盘读 ============== */

const contArm = contDump === dumpX ? armX : armY;
const ctrlArm = contArm === armX ? armY : armX;
freshModules(contArm);
const contStatus = require("../scripts/perception/snapshot-worker").factStatus("history:");
freshModules(ctrlArm);
const ctrlStatus = require("../scripts/perception/snapshot-worker").factStatus("history:");
assert.strictEqual(contStatus.present, true, "restart 后 continuity 臂 fact 仍在（从磁盘读）");
assert.strictEqual(ctrlStatus.present, false, "restart 后 control 臂 fact 仍不存在");

/* ================= 4) 受控回放：随机同步 + 公平性硬校验 + 素材 ============================ */

const materials = require("../scripts/perception/materials");
const OPPORTUNITIES = 10;
const TARGET_SLOT = 6;
const DECISION = Array.from({ length: OPPORTUNITIES }, (_, i) => (i === TARGET_SLOT ? 0.1 : 0.9));

function findSeed(armDir) {
  for (let seed = 1; seed <= 80; seed++) {
    freshModules(armDir);
    const r = require("../scripts/perception/replay-worker").run({
      opportunities: OPPORTUNITIES, seed, decision: DECISION, arm: "T"
    });
    if (r.ok && r.opportunities[TARGET_SLOT].act && r.deliveredCount >= 2 && r.historySignalCount >= 1) return seed;
  }
  throw new Error("测试未找到满足判据的 seed");
}

const seed = findSeed(contArm);
freshModules(contArm);
const replayCont = require("../scripts/perception/replay-worker").run({
  opportunities: OPPORTUNITIES, seed, decision: DECISION, arm: contArm === armX ? "X" : "Y"
});
freshModules(ctrlArm);
const replayCtrl = require("../scripts/perception/replay-worker").run({
  opportunities: OPPORTUNITIES, seed, decision: DECISION, arm: ctrlArm === armX ? "X" : "Y"
});
assert.strictEqual(replayCont.ok, true, "continuity replay 必须正常");
assert.strictEqual(replayCtrl.ok, true, "control replay 必须正常");
assert.strictEqual(replayCont.opportunities.map((o) => o.act).join(","), replayCtrl.opportunities.map((o) => o.act).join(","),
  "两臂 ACT 模式必须逐位一致（gate 流跨臂共享）");
assert.ok(replayCont.opportunities.every((o) => o.drawAccountingOk), "continuity 随机抽取记账必须一致");
assert.ok(replayCtrl.opportunities.every((o) => o.drawAccountingOk), "control 随机抽取记账必须一致");
assert.ok(replayCont.historySignalCount >= 1, "continuity 臂至少一条 target signal");
assert.strictEqual(replayCtrl.historySignalCount, 0, "control 臂必须零 target signal");
assert.strictEqual(replayCont.opportunities[TARGET_SLOT].kind, "history", "target slot 必须是 history recall");
const firstSignalIdx = replayCont.opportunities.findIndex((o) => o.isHistorySignal);
assert.ok(replayCont.opportunities.slice(0, firstSignalIdx).every((o, i) => replayCtrl.opportunities[i].prompt === o.prompt),
  "第一个 signal 之前两臂 generic 台词必须逐字一致（random slot 同步有效）");

/* ================= 5) ground-truth manifest / 中性素材 / 评分模板 ========================= */

const manifest = materials.manifestFieldsFromReplay(replayCont, "continuity", {
  snapshotId: "test-snap", restartPerformed: true, targetFactType: "history:syn-001",
  snapshotImmutableDuringReplay: true, notes: ""
});
for (const field of ["condition", "snapshotId", "restartPerformed", "totalOpportunities",
  "deliveredCount", "historySignalCount", "targetFactPresent", "targetPromptTimestamps"]) {
  assert.ok(field in manifest, "manifest 缺字段: " + field);
}
assert.strictEqual(manifest.targetFactPresent, true);
assert.strictEqual(manifest.targetPromptTimestamps.length, replayCont.historySignalCount);

for (const [label, opps] of [["X", replayCont.opportunities], ["Y", replayCtrl.opportunities]]) {
  const text = materials.buildObserverMaterial(label, opps, firstSignalIdx);
  const scan = materials.scanNoConditionLabels(text);
  assert.strictEqual(scan.clean, true, "observer 素材不得含条件标签: " + scan.hits.join(","));
  assert.ok(text.indexOf("Instance " + label) >= 0, "素材只使用中性 X/Y 标签");
}
assert.strictEqual(materials.scanNoConditionLabels("this is the CONTROL arm").clean, false, "扫描器须能抓到泄漏（阳性对照）");
assert.ok(materials.buildScoringSheet().indexOf("DRY-RUN / NON-DATA") >= 0, "评分表必须强制 DRY-RUN 标记");
assert.ok(materials.buildCodingTemplate().indexOf("explicit event attribution") >= 0, "编码模板必须含四类归因");

/* ================= 6) sealed 随机化分布（两种映射都可能出现） ============================= */

let sawXCont = false, sawYCont = false;
for (let i = 0; i < 200; i++) {
  const isX = crypto.randomInt(2) === 0;
  const a = { X: isX ? "continuity" : "control", Y: isX ? "control" : "continuity" };
  assert.notStrictEqual(a.X, a.Y, "X/Y 必须互斥");
  sawXCont = sawXCont || a.X === "continuity";
  sawYCont = sawYCont || a.Y === "continuity";
}
assert.ok(sawXCont && sawYCont, "sealed 随机化两种映射都必须可能出现");

/* ================= 7) 真实 launcher.replay + reveal 对账（真实 CLI） ======================= */

const replayRun = runNodeEntry("scripts/perception/launcher.js", ["replay"], BASE_ENV);
assert.strictEqual(replayRun.status, 0, "launcher replay 必须成功（stderr: " + String(replayRun.stderr).slice(0, 300) + "）");
const replayOut = JSON.parse(replayRun.stdout);
assert.ok(replayOut.continuitySignals >= 1, "launcher replay：continuity 臂必须有 signal");
assert.strictEqual(replayOut.controlSignals, 0, "launcher replay：control 臂必须零 signal");
assert.strictEqual(replayOut.snapshotImmutable, true, "replay 期间 snapshot 必须不可变");
for (const rel of ["ground-truth/manifest-X.json", "ground-truth/manifest-Y.json", "ground-truth/replay-sync.json",
  "observer/instance-X.md", "observer/instance-Y.md", "observer/scoring-sheet.md", "observer/coding-template.md"]) {
  assert.ok(fs.existsSync(path.join(WORK, rel)), "replay 产物缺失: " + rel);
}
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(WORK, "ground-truth/replay-sync.json"), "utf8")).promptParityBeforeTarget, true,
  "第一个 target signal 之前两臂台词必须完全一致");

const revealRun = runNodeEntry("scripts/perception/launcher.js", ["reveal"], BASE_ENV);
assert.strictEqual(revealRun.status, 0, "launcher reveal 必须成功");
const reveal = JSON.parse(revealRun.stdout);
assert.strictEqual(reveal.reconciliation, "RECONCILIATION_OK", "reveal 对账必须 OK");
assert.strictEqual(reveal.continuity.instance, assignmentSealed.X === "continuity" ? "X" : "Y", "揭封结果必须与 sealed mapping 一致");

// 反例：把两臂 manifest 对调后必须 FAIL（防止 reveal 变成永远 OK 的橡皮章）
const manifestXPath = path.join(WORK, "ground-truth/manifest-X.json");
const manifestYPath = path.join(WORK, "ground-truth/manifest-Y.json");
const mx = fs.readFileSync(manifestXPath, "utf8");
const my = fs.readFileSync(manifestYPath, "utf8");
fs.writeFileSync(manifestXPath, my, "utf8");
fs.writeFileSync(manifestYPath, mx, "utf8");
const revealBadRun = runNodeEntry("scripts/perception/launcher.js", ["reveal"], BASE_ENV);
assert.strictEqual(revealBadRun.status, 0, "反例 reveal 仍应正常退出（结论为 FAIL）");
assert.strictEqual(JSON.parse(revealBadRun.stdout).reconciliation, "RECONCILIATION_FAIL",
  "mapping 与 ground truth 矛盾时必须 FAIL");
// 还原两臂 manifest，避免污染后续断言
fs.writeFileSync(manifestXPath, mx, "utf8");
fs.writeFileSync(manifestYPath, my, "utf8");
assertRealCharacterStateUnchanged("协议全链路结束后");

/* ================= 8) isolation guard：允许 / 拒绝矩阵 ==================================== */

function expectRefused(label, fn) {
  let message = null;
  try { fn(); } catch (e) { message = String((e && e.message) || e); }
  assert.ok(message !== null, label + "：必须被拒绝（实际通过）");
  assert.ok(message.indexOf("PERCEPTION_ISOLATION_REFUSED") >= 0,
    label + "：拒绝原因必须是 PERCEPTION_ISOLATION_REFUSED（实际：" + message + "）");
  return message;
}

// 8.1 缺失 / 非法 env
expectRefused("env 未设置（显式取值，不做 env 兜底）",
  () => isolation.assertPerceptionIsolation({ fromEnv: false, envName: "SUZURAN_TEST_USERDIR_TESTMISSING" }));
expectRefused("env 空字符串", () => isolation.assertPerceptionIsolation({ fromEnv: false, userDir: "" }));
expectRefused("相对路径", () => isolation.assertPerceptionIsolation({ fromEnv: false, userDir: path.join("wm-perception-9b", "rel-run") }));
expectRefused("相对路径 ..\\", () => isolation.assertPerceptionIsolation({ fromEnv: false, userDir: "..\\..\\wm-perception-9b\\rel-run" }));

// 8.2 真实产品路径
expectRefused("真实产品 userData", () => isolation.assertPerceptionIsolation({ userDir: PROD_DIR, requireExists: false }));
expectRefused("产品子目录 logs", () => isolation.assertPerceptionIsolation({ userDir: path.join(PROD_DIR, "logs"), requireExists: false }));
expectRefused("APPDATA 下自建目录", () => isolation.assertPerceptionIsolation({ userDir: path.join(PROD_APPDATA || "C:\\no-appdata", "wm-perception-9b", "run"), requireExists: false }));
expectRefused("大小写伪装产品路径", () => isolation.assertPerceptionIsolation({ userDir: PROD_DIR.toUpperCase(), requireExists: false }));
if (PROD_APPDATA) {
  const alternative = path.join(PROD_APPDATA, "SuzuranPet"); // storage.js 无 Electron 时的 fallback 目录名
  expectRefused("storage fallback 目录名", () => isolation.assertPerceptionIsolation({ userDir: alternative, requireExists: false }));
}

// 8.3 实验室根之外的 temp 路径（"在 temp 里"本身不够）
expectRefused("temp 根直属目录", () => isolation.assertPerceptionIsolation({ userDir: path.join(TMP_ROOT, "wm-perception-run"), requireExists: false }));
expectRefused("实验根自身（不是 run 目录）", () => isolation.assertPerceptionIsolation({ userDir: EXPERIMENT_ROOT, requireExists: false }));
// 存在性策略：workspace 未建立时不得靠"路径看起来对"通过
expectRefused("未建立的 workspace 深层路径（requireExists 默认 true）",
  () => isolation.assertPerceptionIsolation({ userDir: path.join(EXPERIMENT_ROOT, "run", "deeper") }));
expectRefused("REPO 内路径", () => isolation.assertPerceptionIsolation({ userDir: APP_DIR, requireExists: false }));
expectRefused("前缀伪装 wm-perception-9b-evil", () => isolation.assertPerceptionIsolation({ userDir: path.join(TMP_ROOT, "wm-perception-9b-evil"), requireExists: false }));
expectRefused("不存在的 run 目录", () => isolation.assertPerceptionIsolation({ userDir: path.join(EXPERIMENT_ROOT, "missing-run-" + process.pid) }));

// 8.4 允许的实验路径
const allowedRun = path.join(EXPERIMENT_ROOT, "guard-allowed-" + process.pid);
fs.mkdirSync(allowedRun, { recursive: true });
assert.strictEqual(isolation.assertPerceptionIsolation({ userDir: allowedRun }), path.resolve(allowedRun),
  "实验根下的 run 目录必须通过");
assert.strictEqual(isolation.assertPerceptionIsolation({ userDir: allowedRun + path.sep }), path.resolve(allowedRun),
  "带尾分隔符的同一路径必须通过");
assert.strictEqual(isolation.assertPerceptionWorkspace(allowedRun), path.resolve(allowedRun), "workspace 断言必须通过");

// 8.5 Electron --user-data-dir 配对
const uddA = path.join(allowedRun, "udd-X");
fs.mkdirSync(uddA, { recursive: true });
function expectElectronRefused(label, opts) {
  return expectRefused(label, () => isolation.assertElectronIsolation(opts));
}
expectElectronRefused("UDD 缺失", { snapshotRoot: allowedRun, argv: [APP_DIR] });
expectElectronRefused("UDD 相对路径", { snapshotRoot: allowedRun, argv: ["--user-data-dir=udd-X"] });
expectElectronRefused("UDD = 产品 userData", { snapshotRoot: allowedRun, argv: ["--user-data-dir=" + PROD_DIR] });
expectElectronRefused("UDD 在 workspace 之外", { snapshotRoot: allowedRun, argv: ["--user-data-dir=" + path.join(EXPERIMENT_ROOT, "other-run")] });
expectElectronRefused("UDD = snapshot root 自身", { snapshotRoot: allowedRun, argv: ["--user-data-dir=" + allowedRun] });
expectElectronRefused("snapshot root 与 UDD 跨 run", { snapshotRoot: allowedRun, argv: ["--user-data-dir=" + path.join(WORK, "udd-X")] });
expectElectronRefused("snapshot root 未显式给出", { argv: ["--user-data-dir=" + uddA] });
expectElectronRefused("snapshot root 是产品路径", { snapshotRoot: PROD_DIR, argv: ["--user-data-dir=" + uddA] });

const pair = isolation.assertElectronIsolation({ snapshotRoot: allowedRun, argv: ["--user-data-dir=" + uddA] });
assert.strictEqual(pair.userDataDir, path.resolve(uddA), "同一 workspace 下的 UDD 必须通过");
assert.strictEqual(pair.workspace, path.resolve(allowedRun), "pair 必须报出同一个 workspace");

// 8.6 产品侧 marker 闸门：未声明实验模式 → 零干预；声明后产品路径 → 拒绝
delete process.env[isolation.EXPERIMENT_ENV];
assert.strictEqual(isolation.assertExperimentMarkerIsolation({ userDataDir: PROD_DIR }).enforced, false,
  "未声明实验模式时不得干预产品启动");
process.env[isolation.EXPERIMENT_ENV] = "1";
expectRefused("实验模式下的产品 userData", () => isolation.assertExperimentMarkerIsolation({ userDataDir: PROD_DIR }));
// 正例必须把 SUZURAN_TEST_USERDIR 设成同一次 run（否则跨 run 也必须被拒——这正是配对约束）
const markerEnvBefore = process.env[isolation.USERDIR_ENV];
process.env[isolation.USERDIR_ENV] = allowedRun;
assert.strictEqual(isolation.assertExperimentMarkerIsolation({ userDataDir: uddA }).enforced, true, "实验模式下 workspace 内 UDD 必须放行");
process.env[isolation.USERDIR_ENV] = WORK;
expectRefused("实验模式跨 run（env=WORK vs udd=allowedRun）",
  () => isolation.assertExperimentMarkerIsolation({ userDataDir: uddA }));
if (markerEnvBefore === undefined) delete process.env[isolation.USERDIR_ENV]; else process.env[isolation.USERDIR_ENV] = markerEnvBefore;
delete process.env[isolation.EXPERIMENT_ENV];

/* ============ 9) 入口级 fail-closed：缺 env 必须非零退出，且不得加载 src/storage ========== */

const REFUSE_ENV = "PERCEPTION_ISOLATION_REFUSED";
const STORAGE_PATH = path.join(APP_DIR, "src", "storage.js");

/** 生成"不依赖 argv"的探针：入口路径直接内联进脚本，避免 argv 语义差异。 */
function probeScriptFor(entryAbsolute) {
  return [
    "try {",
    "  require(" + JSON.stringify(entryAbsolute) + ");",
    "} catch (e) {",
    "  process.stderr.write('REFUSED_BEFORE_SPAWN: ' + (e && e.message || e) + '\\n');",
    "  process.exit(3);",
    "}",
    "if (require.cache[" + JSON.stringify(STORAGE_PATH) + "]) {",
    "  process.stderr.write('STORAGE_LOADED_WITHOUT_ISOLATION\\n');",
    "  process.exit(4);",
    "}",
    "process.stderr.write('NO_REFUSAL\\n');",
    "process.exit(0);"
  ].join("\n");
}

function runMissingEnvProbe(entryRelative) {
  const env = { ...process.env };
  delete env.SUZURAN_TEST_USERDIR;
  delete env.SUZURAN_WS_DIR;
  return spawnSync(process.execPath, ["-e", probeScriptFor(path.join(APP_DIR, entryRelative))],
    { cwd: APP_DIR, env, encoding: "utf8" });
}

for (const entry of ["scripts/perception/snapshot-worker.js", "scripts/perception/launcher.js", "scripts/perception/replay-worker.js"]) {
  const r = runMissingEnvProbe(entry);
  const err = String(r.stderr);
  assert.notStrictEqual(r.status, 0, entry + " 在缺 env 时必须非零退出（实际 status=" + r.status + "）");
  assert.ok(err.indexOf(REFUSE_ENV) >= 0 || err.indexOf("SUZURAN_TEST_USERDIR 未设置") >= 0 || err.indexOf("SUZURAN_WS_DIR 未设置") >= 0,
    entry + " 拒绝原因必须可读（实际：" + err.slice(0, 200) + "）");
  assert.ok(err.indexOf("STORAGE_LOADED_WITHOUT_ISOLATION") < 0, entry + " 的拒绝必须发生在 src/storage.js 加载之前");
  assert.ok(err.indexOf("NO_REFUSAL") < 0, entry + " 必须拒绝（不得继续执行）");
}

// 作用域纪律：researcher tooling 的相对 require 必须留在仓库内（禁止 require 到仓库外的
// 机器本地路径/临时脚本），且不得出现绝对路径 require。
const scopeProbeScript = [
  "const fs = require('fs'), path = require('path');",
  "const dir = " + JSON.stringify(path.join(APP_DIR, "scripts", "perception")) + ";",
  "const appDir = " + JSON.stringify(APP_DIR) + ";",
  "const bad = [];",
  "const walk = (d) => {",
  "  for (const n of fs.readdirSync(d)) {",
  "    const p = path.join(d, n);",
  "    if (fs.statSync(p).isDirectory()) { if (n !== 'fixtures') walk(p); continue; }",
  "    if (!n.endsWith('.js')) continue;",
  "    const src = fs.readFileSync(p, 'utf8');",
  "    const re = /require\\(\\s*[\"']([^\"']+)[\"']\\s*\\)/g;",
  "    let m;",
  "    while ((m = re.exec(src))) {",
  "      const spec = m[1];",
  "      if (path.isAbsolute(spec)) { bad.push(path.relative(dir, p) + ' -> ABS ' + spec); continue; }",
  "      if (!spec.startsWith('.')) continue;",
  "      const resolved = path.resolve(path.dirname(p), spec);",
  "      if (!resolved.startsWith(appDir + path.sep)) bad.push(path.relative(dir, p) + ' -> OUTSIDE_REPO ' + spec);",
  "    }",
  "  }",
  "};",
  "walk(dir);",
  "process.stdout.write(JSON.stringify(bad));"
].join("\n");
const scopeRun = spawnSync(process.execPath, ["-e", scopeProbeScript], { cwd: APP_DIR, encoding: "utf8" });
assert.strictEqual(scopeRun.status, 0, "作用域探针必须正常执行");
assert.deepStrictEqual(JSON.parse(scopeRun.stdout), [],
  "scripts/perception 的相对 require 必须留在仓库内: " + scopeRun.stdout);

// snapshot-worker 子命令级：只给产品路径 env → 必须拒绝（不写任何东西）
const prodEnvRun = spawnSync(process.execPath,
  [path.join(APP_DIR, "scripts/perception/snapshot-worker.js"), "fact-status", "history:"],
  { cwd: APP_DIR, env: { ...process.env, SUZURAN_TEST_USERDIR: PROD_DIR }, encoding: "utf8" });
assert.notStrictEqual(prodEnvRun.status, 0, "snapshot-worker 遇到产品路径 env 必须拒绝");
assert.ok(String(prodEnvRun.stdout + prodEnvRun.stderr).indexOf("PERCEPTION_ISOLATION_REFUSED") >= 0,
  "snapshot-worker 拒绝原因必须可读: " + String(prodEnvRun.stdout + prodEnvRun.stderr).slice(0, 200));

/* ============ 9b) 缺 env 泄漏路径的 fail-closed 证明（毒化 APPDATA 哨兵，零真实写入） ========
 * 泄漏机制事实：src/config.js 在 require 时即执行 storage.initializeStorage()，会向
 * PATHS.userDir 写入 config.json / persona.md / .storage-migration-v1.json / assets 等。
 * 因此"缺 env 时必须拒绝"的强度必须用"哨兵零写入"来证明，而不是只看退出码。
 * 哨兵把 APPDATA/LOCALAPPDATA 指向空临时目录：任何漏到产品 userData 的写入都会落在哨兵里。
 */
{
  const sentinelRoot = path.join(WORK, "appdata-sentinel");
  const sentinelProduct = path.join(sentinelRoot, "Suzuran桌宠-sentinel"); // storage fallback 解析目标
  fs.mkdirSync(sentinelRoot, { recursive: true });
  const sentinelBefore = fs.readdirSync(sentinelRoot).length;
  assert.strictEqual(sentinelBefore, 0, "哨兵目录必须从空开始");

  const leakedEnv = { ...process.env, APPDATA: sentinelRoot, LOCALAPPDATA: sentinelRoot };
  delete leakedEnv.SUZURAN_TEST_USERDIR;
  delete leakedEnv.SUZURAN_WS_DIR;

  // 1) 缺 env：snapshot-worker 必须拒绝，且哨兵零写入（证明 initializeStorage 从未执行）
  const noEnv = spawnSync(process.execPath, [path.join(APP_DIR, "scripts/perception/snapshot-worker.js"), "init-base"],
    { cwd: APP_DIR, env: leakedEnv, encoding: "utf8" });
  assert.notStrictEqual(noEnv.status, 0, "缺 env 的 snapshot-worker 必须非零退出");
  assert.ok(String(noEnv.stdout + noEnv.stderr).indexOf("PERCEPTION_ISOLATION_REFUSED") >= 0,
    "缺 env 必须报 PERCEPTION_ISOLATION_REFUSED（实际：" + String(noEnv.stdout + noEnv.stderr).slice(0, 200) + "）");
  assert.deepStrictEqual(fs.readdirSync(sentinelRoot), [], "缺 env 时哨兵 userData 必须零写入（含 config.json/persona.md/assets/marker）");

  // 2) 声明了实验模式、却把 env 指向产品 userData：同样必须在任何写入之前拒绝
  const productEnv = { ...leakedEnv, SUZURAN_TEST_USERDIR: path.join(sentinelProduct, "child") };
  const productRun = spawnSync(process.execPath, [path.join(APP_DIR, "scripts/perception/snapshot-worker.js"), "init-base"],
    { cwd: APP_DIR, env: productEnv, encoding: "utf8" });
  assert.notStrictEqual(productRun.status, 0, "env 指向产品 userData 时必须非零退出");
  assert.ok(String(productRun.stdout + productRun.stderr).indexOf("PERCEPTION_ISOLATION_REFUSED") >= 0,
    "env 指向产品 userData 时必须报 REFUSED（实际：" + String(productRun.stdout + productRun.stderr).slice(0, 200) + "）");
  assert.deepStrictEqual(fs.readdirSync(sentinelRoot), [], "env 指向产品 userData 时哨兵必须零写入");

  // 3) 反例校准：哨兵本身可观测——把哨兵当作允许路径时确实会产生写入。
  //    这证明"零写入"不是断言失效，而是隔离 guard 真的挡住了。
  const calibrationTarget = path.join(sentinelRoot, "calibration-would-be-product-dir", "config.json");
  fs.mkdirSync(path.dirname(calibrationTarget), { recursive: true });
  fs.writeFileSync(calibrationTarget, "calibration", "utf8");
  const calibrationSeen = fs.existsSync(calibrationTarget);
  fs.rmSync(path.join(sentinelRoot, "calibration-would-be-product-dir"), { recursive: true, force: true });
  assert.strictEqual(calibrationSeen, true, "哨兵可观测性校准失败（目录写入不可见）");
  assert.deepStrictEqual(fs.readdirSync(sentinelRoot), [], "校准清理后哨兵必须回到空");
}

/* ============ 10) Electron 启动计划：守卫先于 spawn ======================================= */

const electronLauncher = require("../scripts/perception/electron-launcher");
const savedTestUserDir = process.env.SUZURAN_TEST_USERDIR;
const savedUdd = process.env.SUZURAN_WM_USERDATA_DIR;

// "只设 UDD、漏设 SUZURAN_TEST_USERDIR"（上一轮事故形态）必须被拒
delete process.env.SUZURAN_TEST_USERDIR;
process.env.SUZURAN_WM_USERDATA_DIR = uddA;
expectRefused("只设 UDD、漏设 SUZURAN_TEST_USERDIR", () => electronLauncher.buildElectronArgs({ command: process.execPath }));
process.env.SUZURAN_TEST_USERDIR = savedTestUserDir;

// 合法计划：env 必须被注入到子进程（防"只设了一半"），argv 必须带同 workspace 的 UDD
const plan = electronLauncher.buildElectronArgs({ snapshotRoot: allowedRun, argv: ["--user-data-dir=" + uddA], command: process.execPath });
assert.strictEqual(plan.options.env[isolation.USERDIR_ENV], path.resolve(allowedRun), "启动计划必须把 snapshot root 注入子进程 env");
assert.strictEqual(plan.options.env[isolation.EXPERIMENT_ENV], "1", "启动计划必须声明实验模式（产品侧闸门据此生效）");
assert.ok(plan.args.indexOf("--user-data-dir=" + path.resolve(uddA)) >= 0, "argv 必须携带隔离 UDD");

// spawn 面：注入 spawn 记录器（opts.spawnFn），被记录的 command/args/env 就是 launchElectron
// 会交给操作系统的内容；同时证明"被拒绝的启动一次 spawn 都不会发生"。
const spawnLog = [];
function recordingSpawn(command, args, options) {
  spawnLog.push({ command, args: Array.from(args || []), env: (options && options.env) || {} });
  return { status: 0, signal: null, stdout: "", stderr: "" };
}

const launch = electronLauncher.launchElectron({
  snapshotRoot: allowedRun, argv: ["--user-data-dir=" + uddA], spawnFn: recordingSpawn
});
assert.strictEqual(launch.status, 0, "启动计划必须返回成功状态");
assert.strictEqual(spawnLog.length, 1, "launchElectron 必须恰好发起一次 spawn");
const spawned = spawnLog[0];
assert.ok(spawned.args.indexOf("--user-data-dir=" + path.resolve(uddA)) >= 0,
  "真实 spawn argv 必须带隔离 UDD（实际：" + spawned.args.join(" ") + "）");
assert.strictEqual(spawned.args[0], APP_DIR, "argv[0] 必须是产品入口目录");
assert.strictEqual(spawned.env[isolation.USERDIR_ENV], path.resolve(allowedRun), "spawn env 必须带正确 snapshot root");
assert.strictEqual(spawned.env[isolation.EXPERIMENT_ENV], "1", "spawn env 必须声明实验模式");

// 守卫先于 spawn：UDD 跨界时 spawn 一次都不该被调用
expectRefused("UDD 跨界时必须在 spawn 之前拒绝", () => electronLauncher.launchElectron({
  snapshotRoot: allowedRun, argv: ["--user-data-dir=" + path.join(WORK, "udd-X")], spawnFn: recordingSpawn
}));
// 无 argv 也无 SUZURAN_WM_USERDATA_DIR → 必须拒绝（绝不继承产品默认 userData）
const uddEnvBefore = process.env[isolation.UDD_ENV];
delete process.env[isolation.UDD_ENV];
expectRefused("缺 UDD（argv 与 env 都没有）时必须在 spawn 之前拒绝", () => electronLauncher.launchElectron({
  snapshotRoot: allowedRun, argv: [APP_DIR], spawnFn: recordingSpawn
}));
if (uddEnvBefore === undefined) delete process.env[isolation.UDD_ENV]; else process.env[isolation.UDD_ENV] = uddEnvBefore;
assert.strictEqual(spawnLog.length, 1, "被拒绝的启动绝不允许调用 spawnFn");
assertRealCharacterStateUnchanged("Electron 计划 + spawn 记录之后");

/* ============ 11) 真实 Electron 最短冒烟：startup → isolated write → restart → shutdown ==== */
// 真实 Electron + 真实产品 main.js，但 userData 与 snapshot 都落在实验 workspace 内；
// 不做任何 proactive 等待（探针自带 quick 退出）。缺 Electron 二进制时显式跳过并记录为未验证。

const SMOKE_HARNESS = path.join(APP_DIR, "scripts", "perception", "fixtures", "electron-smoke");
const smokeUdd = path.join(WORK, "udd-smoke");
const smokeMarkerDir = path.join(WORK, "smoke-marker");
const electronBinary = electronLauncher.DEFAULT_ELECTRON_BIN;
let electronSmoke = "NOT_RUN";
if (!fs.existsSync(electronBinary)) {
  electronSmoke = "SKIPPED_NO_ELECTRON_BINARY";
} else {
  const smokeEnv = { ...process.env };
  delete smokeEnv.ELECTRON_RUN_AS_NODE;
  delete smokeEnv[isolation.UDD_ENV]; // UDD 由 argv 显式给出，避免残留 env 造成歧义
  smokeEnv.SUZURAN_WM_SMOKE_QUICK = "1";
  smokeEnv.SUZURAN_WM_MARKER_DIR = smokeMarkerDir;
  const smokeRun = (label) => {
    const r = electronLauncher.launchElectron({
      snapshotRoot: WORK, userDataDir: smokeUdd, appTarget: SMOKE_HARNESS,
      env: smokeEnv, timeoutMs: 120000
    });
    assert.strictEqual(r.status, 0, "Electron " + label + " 必须正常退出（status=" + r.status
      + " signal=" + r.signal + " stderr=" + String(r.stderr || "").slice(0, 300) + "）");
    return r;
  };
  smokeRun("首启");
  // 真实产品状态必须落在 snapshot root（= SUZURAN_TEST_USERDIR），Chromium 缓存必须落在 UDD
  assert.ok(fs.existsSync(path.join(WORK, "config.json")), "Electron 首启必须在隔离 snapshot root 写入 config.json");
  assert.ok(fs.existsSync(path.join(WORK, ".storage-migration-v1.json")), "Electron 首启必须留下 storage 迁移 marker（真实 initializeStorage 证据）");
  assert.ok(fs.existsSync(path.join(WORK, "logs")), "Electron 首启必须在隔离 snapshot root 建 logs/");
  assert.ok(fs.existsSync(path.join(smokeUdd, "Cache")) || fs.existsSync(path.join(smokeUdd, "GPUCache")),
    "Electron 首启必须把 Chromium 缓存写进实验 workspace 内的 --user-data-dir");
  assert.ok(!fs.existsSync(path.join(smokeUdd, "logs")), "产品状态不得落进 Chromium UDD（两目录职责必须分离）");
  rmWorkspace(smokeUdd); // 清干净再重启，验证可重复性（非产品数据，可安全删除）
  smokeRun("restart");
  assert.ok(fs.existsSync(path.join(smokeUdd, "Cache")) || fs.existsSync(path.join(smokeUdd, "GPUCache")),
    "Electron restart 后 Chromium 缓存仍必须写进隔离 UDD");
  const markerLog = path.join(smokeMarkerDir, "electron-smoke.log");
  assert.ok(fs.existsSync(markerLog), "Electron 探针必须留下启动标记");
  const markerLines = fs.readFileSync(markerLog, "utf8").trim().split("\n");
  assert.ok(markerLines.filter((l) => l.indexOf("launch userData=") === 0).length >= 2, "两次启动都必须被记录（实际：" + markerLines.length + " 行）");
  assert.ok(markerLines.some((l) => l.indexOf(path.resolve(smokeUdd)) >= 0), "探针记录的 userData 必须指向实验 workspace");
  assert.ok(markerLines.filter((l) => l === "quit").length >= 2, "两次启动都必须正常 shutdown（写 quit 标记）");
  electronSmoke = "PASS";
  assertRealCharacterStateUnchanged("真实 Electron 冒烟之后");
}
console.log("electron-smoke: " + electronSmoke);

if (savedUdd === undefined) delete process.env.SUZURAN_WM_USERDATA_DIR; else process.env.SUZURAN_WM_USERDATA_DIR = savedUdd;
rmWorkspace(allowedRun);

assertRealCharacterStateUnchanged("测试结束");

} finally {
  rmWorkspace(WORK);
}

console.log("perception-protocol.test.js: all assertions passed");

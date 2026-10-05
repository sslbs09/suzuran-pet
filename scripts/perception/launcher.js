"use strict";

/*
 * launcher.js — Phase 9-B 感知实验协议 launcher（researcher-only tooling，脚本级，不做平台）。
 *
 * 调用约定（researcher 侧）：
 *   1. 先在外部建立 workspace：<系统临时目录>\wm-perception-9b\<run 名>\
 *      （mkdir 由 researcher 完成；reset 同理由 researcher 外部执行 Remove-Item，
 *       本脚本因此没有任何删除类 fs 操作，也绝不触碰真实 userData）；
 *   2. 设置 SUZURAN_WS_DIR=<该 workspace 绝对路径>；
 *      同时设置 SUZURAN_TEST_USERDIR=<同一个 workspace>（fail-closed：缺一即拒绝，
 *      绝不回退到真实产品 userData——见 isolation.js）；
 *   3. node scripts/perception/launcher.js <cmd>
 *      cmd ∈ { init | replay | score-demo | reveal }。
 *
 *   init            建 base snapshot + fork A/B + sealed 随机分配 +
 *                   mediator 消融（真实 memory API）+ 语义/字节 AB_DIFF_REPORT +
 *                   restart 持久化核查（freshModules 重载 = 新进程语义的进程内等价）
 *   replay          无头受控回放（真实 runtime 路径 + random slot 同步）+
 *                   ground-truth manifest + 中性 X/Y observer 素材 + 评分/编码模板
 *   score-demo      研究者本人模拟评分 + 手工归因编码（强制 DRY-RUN / NON-DATA 标记）
 *   reveal          揭封 assignment 并与 ground-truth 对账
 *
 * 隔离机制：storage.js 在 require 时读取 SUZURAN_TEST_USERDIR。本 launcher 在切换
 * snapshot 臂时设置该环境变量并清除 src/perception 的 require 缓存后重新加载，
 * 等价于"每个臂一个全新进程"（production 语义不变；与单测同款模式）。
 * 无 shell、无子进程。
 *
 * 安全边界：workspace 必须位于系统临时目录 wm-perception-9b/ 之下（启动时校验）；
 * 所有 fs 调用集中在 *At 助手里（joinAt(root, rel) 与 fs 调用同函数，
 * resolve+startsWith+throw），rel 一律字面量（跨臂差异用三元字面量表达）；
 * 绝不修改 src/ 生产模块，不把 snapshot/素材提交进 repo。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const abdiff = require("./abdiff");
const materials = require("./materials");
const isolation = require("./isolation");

const APP_DIR = path.resolve(__dirname, "..", "..");
const SRC_PREFIX = path.join(APP_DIR, "src") + path.sep;
const PERCEPTION_PREFIX = path.join(APP_DIR, "scripts", "perception") + path.sep;
const TARGET_FACT = { type: "history:syn-001", text: "博士已经完成考试", anchor: "EVENT" };
const OPPORTUNITIES = 10;
const TARGET_SLOT = 6; // opportunity #7 注入 decision fire（受控随机，非生产概率改动）

/* ---------- fs 助手：root + 字面量 rel，守卫与 fs 同函数 ---------- */

function joinAt(root, rel) {
  const target = path.resolve(root, String(rel));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("路径越界（拒绝）: " + target);
  return target;
}

function ensureDirAt(root, rel) {
  const dir = joinAt(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonAt(root, rel, obj) {
  const file = joinAt(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function writeTextAt(root, rel, text) {
  const file = joinAt(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readJsonAt(root, rel) {
  return JSON.parse(fs.readFileSync(joinAt(root, rel), "utf8"));
}

function listFilesInside(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = joinAt(root, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) stack.push(rel ? rel + "/" + name : name);
    } else {
      out.push(rel);
    }
  }
  return out;
}

function forkDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const rel of listFilesInside(src)) {
    const dstAbs = joinAt(dst, rel);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.copyFileSync(joinAt(src, rel), dstAbs);
  }
}

/* ---------- workspace 校验（researcher 预先建好的目录） ---------- */

/** SUZURAN_WS_DIR 必须是 <TMP>\wm-perception-9b\<run> 之下已存在的目录。
 *  路径策略统一收敛到 isolation.js（同一个 fail-closed 判定，禁止两套实现漂移）。 */
function workspaceFromEnv() {
  return isolation.assertPerceptionWorkspace(process.env.SUZURAN_WS_DIR);
}

function assertArm(arm) {
  const v = String(arm || "");
  if (v !== "X" && v !== "Y") throw new Error("arm 只允许 X|Y");
  return v;
}

/** 切换隔离臂：设置 SUZURAN_TEST_USERDIR 并清除 src/perception 模块缓存（= 新进程语义）。 */
function freshModules(userDir) {
  process.env.SUZURAN_TEST_USERDIR = userDir;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_PREFIX) || key.startsWith(PERCEPTION_PREFIX)) delete require.cache[key];
  }
}

/* ---------- 子命令实现 ---------- */

function cmdInit(ws) {
  // workspace 必须全新：forkDir 是复制语义（无删除操作），复用旧 workspace 会把
  // 上一轮的陈旧 snapshot 文件带进 A/B 臂，污染语义对比——检测到即拒绝。
  const sealProbe = joinAt(ws, "sealed/assignment.json");
  if (fs.existsSync(sealProbe)) {
    throw new Error("workspace 非全新（已存在 sealed/assignment.json）：请改用新的 workspace 目录重跑 init");
  }
  const baseDir = ensureDirAt(ws, "base");
  const armX = ensureDirAt(ws, "arm-X");
  const armY = ensureDirAt(ws, "arm-Y");
  for (const rel of ["sealed", "ground-truth", "observer", "scoring", "screenshots/X", "screenshots/Y", "reports", "udd-X", "udd-Y"]) {
    ensureDirAt(ws, rel);
  }

  writeTextAt(ws, "NON-PRODUCT-EXPOSURE-MODE.txt",
    "本 workspace 是 Phase 9-B researcher-only dry-run 产物。\nproactiveMin=1 只存在于实验 snapshot config（NON-PRODUCT EXPOSURE MODE），\n绝不写回真实 userData。\n真实 userData 哈希与 Electron live 由 researcher 外部工具执行。\n");

  freshModules(baseDir);
  require("./snapshot-worker").initBase();
  forkDir(baseDir, armX);
  forkDir(baseDir, armY);

  // sealed 随机化：mapping 只写 researcher-only sealed/，observer 素材目录不得引用
  const continuityIsX = crypto.randomInt(2) === 0;
  const assignment = {
    schema: "phase9b-sealed-assignment/1",
    X: continuityIsX ? "continuity" : "control",
    Y: continuityIsX ? "control" : "continuity",
    sealedAt: new Date().toISOString(),
    note: "评分完成（reveal）前不得向观察者展示"
  };
  writeJsonAt(ws, "sealed/assignment.json", assignment);

  const armFor = (cond) => (assignment.X === cond ? armX : armY);
  freshModules(armFor("continuity"));
  require("./snapshot-worker").addFact(TARGET_FACT);

  // restart 持久化（freshModules 重载 = 全新进程从磁盘读 snapshot 的进程内等价；
  // Electron 级 restart 由 live dry-run 验证）
  freshModules(armFor("continuity"));
  const contStatus = require("./snapshot-worker").factStatus("history:");
  freshModules(armFor("control"));
  const ctrlStatus = require("./snapshot-worker").factStatus("history:");
  const restart = { continuityPresent: contStatus.present, controlPresent: ctrlStatus.present };
  restart.verdict = restart.continuityPresent && !restart.controlPresent ? "RESTART_PERSISTENCE_OK" : "RESTART_PERSISTENCE_FAIL";
  writeJsonAt(ws, "ground-truth/restart-persistence.json", restart);

  // A/B 公平性：语义 + 字节双层
  freshModules(armX);
  const dumpX = require("./snapshot-worker").dumpSemantic();
  freshModules(armY);
  const dumpY = require("./snapshot-worker").dumpSemantic();
  writeJsonAt(ws, "ground-truth/dump-X.json", dumpX);
  writeJsonAt(ws, "ground-truth/dump-Y.json", dumpY);
  const report = {
    schema: "phase9b-ab-diff-report/1",
    semantic: abdiff.diffDumps(dumpX, dumpY, TARGET_FACT.type),
    byte: abdiff.byteDiffDirs(armX, armY),
    note: "byte 层差异（如创建时间戳/后续加密 nonce）与 semantic 层差异分开报告，前者不构成实验污染"
  };
  writeJsonAt(ws, "ground-truth/ab-diff-report.json", report);
  console.log(JSON.stringify({
    step: "init", workspace: ws,
    sealed: true, continuityIsX,
    restart: restart.verdict,
    abSemanticVerdict: report.semantic.verdict,
    byteDifferFiles: report.byte.differ.map((d) => d.rel)
  }, null, 2));
}

function cmdReplay(ws) {
  const assignment = readJsonAt(ws, "sealed/assignment.json");
  const armXDir = ensureDirAt(ws, "arm-X");
  const armYDir = ensureDirAt(ws, "arm-Y");
  const armDirFor = (label) => (assertArm(label) === "X" ? armXDir : armYDir);
  const decision = Array.from({ length: OPPORTUNITIES }, (_, i) => (i === TARGET_SLOT ? 0.1 : 0.9));
  const optsFor = (arm, seed) => ({ opportunities: OPPORTUNITIES, seed, decision, arm });

  const continuityLabel = assertArm(assignment.X === "continuity" ? "X" : "Y");
  const controlLabel = assertArm(continuityLabel === "X" ? "Y" : "X");

  // seed 扫描：只筛 gate（外层 ACT 概率保持 0.18 生产值不动），decision fire 由 schedule 固定
  const scan = { triedSeeds: 0, chosenSeed: null, criterion: "targetSlotAct && totalActs>=4 && historySignal>=1" };
  let continuityReplay = null;
  for (let seed = 1; seed <= 999; seed++) {
    freshModules(armDirFor(continuityLabel));
    const r = require("./replay-worker").run(optsFor(continuityLabel, seed));
    scan.triedSeeds = seed;
    if (r.ok && r.opportunities[TARGET_SLOT].act && r.deliveredCount >= 4 && r.historySignalCount >= 1) {
      scan.chosenSeed = seed;
      continuityReplay = r;
      break;
    }
  }
  if (!continuityReplay) throw new Error("seed 扫描未找到满足判据的种子：协议 blocker");
  freshModules(armDirFor(controlLabel));
  const controlReplay = require("./replay-worker").run(optsFor(controlLabel, scan.chosenSeed));

  // 公平性硬校验
  const actsX = continuityReplay.opportunities.map((o) => o.act).join(",");
  const parityOk = actsX === controlReplay.opportunities.map((o) => o.act).join(",");
  const accountingOk = continuityReplay.opportunities.every((o) => o.drawAccountingOk)
    && controlReplay.opportunities.every((o) => o.drawAccountingOk);
  const controlClean = controlReplay.historySignalCount === 0
    && controlReplay.opportunities.every((o) => !o.isHistorySignal);
  if (!parityOk || !accountingOk || !controlClean) {
    writeJsonAt(ws, "ground-truth/replay-fail.json", { parityOk, accountingOk, controlClean });
    throw new Error("replay 公平性校验失败: parity=" + parityOk + " accounting=" + accountingOk + " controlClean=" + controlClean);
  }

  writeJsonAt(ws, continuityLabel === "X" ? "ground-truth/replay-X.json" : "ground-truth/replay-Y.json", continuityReplay);
  writeJsonAt(ws, controlLabel === "X" ? "ground-truth/replay-X.json" : "ground-truth/replay-Y.json", controlReplay);

  // snapshot 在 replay 期间不得被改写：replay 后语义态复读，内存事实必须与 fork 后落盘事实一致。
  // 注意：必须按 continuity/control 标签取目录，不能按 X/Y 字面量——sealed 分配有一半概率
  // 把 continuity 落在 Y 臂，按 X/Y 配对会把两臂要素对调，得到假阴性（Phase 9-B.1 修）。
  const contArmDir = armDirFor(continuityLabel);
  const ctrlArmDir = armDirFor(controlLabel);
  freshModules(contArmDir);
  const contDump = require("./snapshot-worker").dumpSemantic();
  freshModules(ctrlArmDir);
  const ctrlDump = require("./snapshot-worker").dumpSemantic();
  const reCont = abdiff.diffFacts(contDump.memory.facts, continuityReplay.memoryFactsAfter);
  const reCtrl = abdiff.diffFacts(ctrlDump.memory.facts, controlReplay.memoryFactsAfter);
  const immutable = reCont.onlyInA.length === 0 && reCont.onlyInB.length === 0
    && reCtrl.onlyInA.length === 0 && reCtrl.onlyInB.length === 0;
  if (!immutable) {
    // replay 期间 snapshot 被改写 ⇒ A/B 对照不再成立：按协议 blocker 处理，绝不出素材。
    writeJsonAt(ws, "ground-truth/replay-fail.json", { snapshotImmutableDuringReplay: false, reCont, reCtrl });
    throw new Error("replay 期间 snapshot 被改写（snapshotImmutableDuringReplay=false）：协议 blocker");
  }

  const snapId = "run-seed-" + scan.chosenSeed;
  const metaCommon = { snapshotId: snapId, restartPerformed: true, targetFactType: TARGET_FACT.type, snapshotImmutableDuringReplay: immutable };
  const manifestFor = (label, replay, cond) => materials.manifestFieldsFromReplay(replay, cond, {
    ...metaCommon, notes: "headless controlled replay; restart = fresh module reload reading snapshot from disk（Electron 级 restart 由 live dry-run 验证）"
  });
  writeJsonAt(ws, "ground-truth/manifest-X.json", manifestFor("X", continuityLabel === "X" ? continuityReplay : controlReplay, assignment.X));
  writeJsonAt(ws, "ground-truth/manifest-Y.json", manifestFor("Y", continuityLabel === "Y" ? continuityReplay : controlReplay, assignment.Y));

  // 中性素材：截取到第一个 target signal 为止（此前两臂 generic 台词逐字一致）
  const firstSignalSlot = continuityReplay.opportunities.findIndex((o) => o.isHistorySignal);
  if (firstSignalSlot < 0) throw new Error("无 target signal，禁止出素材");
  const upto = firstSignalSlot;
  const contOpps = continuityReplay.opportunities;
  const ctrlOpps = controlReplay.opportunities;
  const matX = materials.buildObserverMaterial("X", continuityLabel === "X" ? contOpps : ctrlOpps, upto);
  const matY = materials.buildObserverMaterial("Y", continuityLabel === "Y" ? contOpps : ctrlOpps, upto);
  writeTextAt(ws, "observer/instance-X.md", matX);
  writeTextAt(ws, "observer/instance-Y.md", matY);
  writeTextAt(ws, "observer/scoring-sheet.md", materials.buildScoringSheet());
  writeTextAt(ws, "observer/coding-template.md", materials.buildCodingTemplate());

  writeJsonAt(ws, "ground-truth/replay-sync.json", {
    seedScan: scan, actParity: parityOk, actPattern: actsX,
    randomSlotDesign: "per-opportunity independent gate/decision/pick streams",
    drawAccounting: "ok", snapshotImmutableDuringReplay: immutable,
    controlSignalCount: controlReplay.historySignalCount,
    continuitySignalCount: continuityReplay.historySignalCount,
    promptParityBeforeTarget: contOpps.slice(0, upto)
      .every((o, i) => ctrlOpps[i].prompt === o.prompt)
  });

  console.log(JSON.stringify({
    step: "replay", chosenSeed: scan.chosenSeed, triedSeeds: scan.triedSeeds,
    actPattern: actsX, continuitySignals: continuityReplay.historySignalCount,
    controlSignals: controlReplay.historySignalCount,
    presentedOpportunities: upto + 1, snapshotImmutable: immutable,
    observerMaterials: joinAt(ws, "observer")
  }, null, 2));
}

function cmdScoreDemo(ws) {
  // DRY-RUN 模拟评分：由研究者本人填写，全部标记 NON-DATA；禁止进入任何研究 CSV。
  const answers = {
    schema: "phase9b-scoring-dryrun/1",
    status: "DRY-RUN / NON-DATA",
    forbiddenUse: "本文件是流程演练记录，禁止写进研究结果 CSV，禁止作为研究证据引用。",
    answeredBy: "researcher-self-simulation",
    openEnded: "两个实例都在相同的机会点开口，日常问候大体一致；其中一个实例在机会 7 提到「博士已经完成考试」并明确说这件事已经结束，像是在回应之前聊过的事；另一个实例同一机会只说了普通问候。",
    forcedChoice: null, // 评分者二选一；dry-run 由研究者按素材作答后写回
    confidence: null,
    codedAttribution: ["explicit event attribution", "memory / previous-interaction attribution"],
    continuityAttribution: "yes"
  };
  writeJsonAt(ws, "scoring/dry-run-answers.json", answers);
  console.log(JSON.stringify({ step: "score-demo", written: joinAt(ws, "scoring/dry-run-answers.json"), status: answers.status }, null, 2));
}

function cmdReveal(ws) {
  const assignment = readJsonAt(ws, "sealed/assignment.json");
  const mX = readJsonAt(ws, "ground-truth/manifest-X.json");
  const mY = readJsonAt(ws, "ground-truth/manifest-Y.json");
  const continuityManifest = assignment.X === "continuity" ? mX : mY;
  const controlManifest = assignment.X === "continuity" ? mY : mX;
  const reconciliationOk = continuityManifest.historySignalCount >= 1
    && continuityManifest.targetFactPresent === true
    && controlManifest.historySignalCount === 0
    && controlManifest.targetFactPresent === false;
  const result = {
    step: "reveal", assignment,
    continuity: { instance: continuityManifest.instanceLabel, signalCount: continuityManifest.historySignalCount },
    control: { instance: controlManifest.instanceLabel, signalCount: controlManifest.historySignalCount },
    falseAttributionGroundTruth: "control 素材经 ground-truth 层确认不含 target historical reference（historySignalCount=0）",
    reconciliation: reconciliationOk ? "RECONCILIATION_OK" : "RECONCILIATION_FAIL"
  };
  writeJsonAt(ws, "reports/reveal.json", result);
  console.log(JSON.stringify(result, null, 2));
}

/** launcher 级 fail-closed 前置断言：任何子命令执行之前先证明"这条路是隔离的"。
 *  刻意不自动设置 SUZURAN_TEST_USERDIR——静默补默认值正是本协议要消灭的 fallback 形态。 */
function assertLauncherIsolation() {
  const ws = workspaceFromEnv();
  const envDir = process.env.SUZURAN_TEST_USERDIR;
  if (!envDir) {
    throw new Error("SUZURAN_TEST_USERDIR 未设置：请使用 " + isolation.USERDIR_ENV + "=<snapshot root>（禁止回退真实产品 userData）");
  }
  const snapshotRoot = isolation.assertPerceptionIsolation({ requireExists: false });
  if (isolation.normalizeForCompare(ws) !== isolation.normalizeForCompare(snapshotRoot)) {
    throw new Error("SUZURAN_WS_DIR 与 SUZURAN_TEST_USERDIR 必须指向同一次实验 workspace: " + ws + " vs " + snapshotRoot);
  }
  return { workspace: ws, snapshotRoot };
}

// 模块加载即断言（fail-closed）：launcher 只允许在被证明隔离的进程里加载。
// 缺 env 时抛错发生在任何子命令执行与任何 fs 操作之前（launcher 自身不做 Electron spawn）。
assertLauncherIsolation();

function main() {
  const cmd = process.argv[2];
  assertLauncherIsolation();
  const ws = workspaceFromEnv();
  if (cmd === "init") cmdInit(ws);
  else if (cmd === "replay") cmdReplay(ws);
  else if (cmd === "score-demo") cmdScoreDemo(ws);
  else if (cmd === "reveal") cmdReveal(ws);
  else throw new Error("未知子命令: " + cmd);
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error("LAUNCHER_FAIL: " + String((e && e.stack) || e));
    process.exit(1);
  }
}

module.exports = { joinAt, ensureDirAt, workspaceFromEnv, freshModules, assertArm, cmdReveal, assertLauncherIsolation };

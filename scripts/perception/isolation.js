"use strict";

/*
 * isolation.js — Phase 9-B 感知实验 fail-closed 隔离断言（researcher-only tooling，唯一事实来源）。
 *
 * 背景（一次真实事故）：两个诊断 Electron 实例漏设 SUZURAN_TEST_USERDIR，
 * storage.js 因此回落到真实产品 userData（%APPDATA%\苏苏洛桌宠 2.5 正式版），
 * 把 logs/tts.log、Chromium cache、Dawn/DIPS 写进了研究者不该触碰的目录。
 *
 * 本模块的契约（fail-closed，禁止 fallback）：
 *   - 只有"能证明自己位于实验隔离路径内"的 researcher tooling 才允许继续；
 *   - 任何失败一律 throw / 非零退出，且必须发生在 Electron 启动与任何写入之前；
 *   - 绝不为了"能跑起来"而回退到默认产品 userData。
 *
 * 边界（刻意不做的事）：
 *   - 不修改 src/storage.js 的产品默认行为（正常产品启动逻辑零改动）；
 *   - 不删除、不移动任何目录（本模块只有 existsSync / statSync 两种只读 fs 调用）；
 *   - 不参与 Character Runtime 行为、概率、台词与 memory 语义。
 *
 * 允许的实验根：<系统临时目录>/wm-perception-9b/<run 名>/
 *   其中 <run 名> 恰好一层；snapshot root 与 Electron --user-data-dir 必须属于同一个 <run>。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_ROOT = path.resolve(os.tmpdir());
/** 允许的实验根（相对系统临时目录）。 */
const EXPERIMENT_ROOT_REL = "wm-perception-9b";
const EXPERIMENT_ROOT = path.join(TMP_ROOT, EXPERIMENT_ROOT_REL);
const USERDIR_ENV = "SUZURAN_TEST_USERDIR";
/** Electron --user-data-dir 的实验专用来源（绝不从产品参数继承）。 */
const UDD_ENV = "SUZURAN_WM_USERDATA_DIR";
/** 研究者显式声明"本次是感知实验启动"的标记；缺失即按产品启动处理。 */
const EXPERIMENT_ENV = "SUZURAN_PERCEPTION_EXPERIMENT";

/** Windows 文件系统大小写不敏感：路径比较统一走该归一化。 */
function normalizeForCompare(p) {
  const abs = path.resolve(String(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** target === base 或 target 位于 base 之下（拒绝 …/wm-perception-9b-evil 这类前缀伪装）。 */
function isInsideOrEqual(target, base) {
  const t = normalizeForCompare(target);
  const b = normalizeForCompare(base);
  return t === b || t.startsWith(b + path.sep);
}

/**
 * 从 p 自身向上找"实验根直属的那一层 run 目录"（含 p 本身）。
 * 例：<实验根>/run/base → <实验根>/run；<实验根>/run → <实验根>/run。
 * 不属于实验根（或就是实验根本身）时返回 null。
 */
function workspaceFor(p) {
  let cur = path.resolve(String(p));
  for (;;) {
    const parent = path.dirname(cur);
    if (normalizeForCompare(parent) === normalizeForCompare(EXPERIMENT_ROOT)) return cur;
    if (normalizeForCompare(cur) === normalizeForCompare(EXPERIMENT_ROOT)) return null;
    if (normalizeForCompare(parent) === normalizeForCompare(cur)) return null; // 到达盘根
    cur = parent;
  }
}

/** 仅当 p 位于实验根之内时返回其所属 run 目录；实验根本身与根外路径返回 null。 */
function workspaceOf(p) {
  if (!isInsideOrEqual(p, EXPERIMENT_ROOT)) return null;
  return workspaceFor(p);
}

/** 已知真实产品 userData 路径（只读列举，不写入、不创建）。 */
function knownProductionUserDirs() {
  const appData = process.env.APPDATA || "";
  const out = [
    "苏苏洛桌宠 2.5 正式版", // package.json productName（当前产品）
    "苏苏洛桌宠 2.1 正式版",
    "苏苏洛桌宠 1.1 正式版", // main.js migrateUserDataDirOnRename 里的旧名
    "苏苏洛桌宠 2.0 正式版",
    "苏苏洛桌宠",
    "SuzuranPet" // 无 Electron 时的 storage.js fallback 目录名
  ];
  const paths = [];
  for (const name of out) if (appData) paths.push(path.join(appData, name));
  // storage.js 在拿不到 Electron 时的兜底：<APPDATA>/SuzuranPet
  if (appData) paths.push(path.join(appData, "SuzuranPet"));
  return { names: out, paths };
}

function fail(message) {
  throw new Error("PERCEPTION_ISOLATION_REFUSED: " + message);
}

/**
 * snapshot root 隔离断言（所有 researcher tooling 的第一道门）。
 * @param {object} [opts]
 * @param {string} [opts.userDir]      待验证的 snapshot root
 * @param {boolean} [opts.fromEnv]     true（默认）= 从 SUZURAN_TEST_USERDIR 取值；
 *                                     false = 只信任显式传入的 userDir（缺失即拒绝，不做 env 兜底）
 * @param {string} [opts.envName]      环境变量名（报错信息用）
 * @param {boolean} [opts.requireExists=true] 是否要求目录已存在
 * @returns {string} 规范化后的绝对 snapshot root
 */
function assertPerceptionIsolation(opts) {
  const o = opts || {};
  const envName = o.envName || USERDIR_ENV;
  const raw = o.fromEnv === false ? o.userDir : (o.userDir !== undefined ? o.userDir : process.env[USERDIR_ENV]);

  if (!raw) {
    fail(envName + " 未设置：感知实验工装拒绝启动（绝不会回退到真实产品 userData）");
  }
  if (!path.isAbsolute(String(raw))) {
    fail(envName + " 必须是绝对路径，收到相对路径: " + String(raw));
  }
  const target = path.resolve(String(raw));

  const prod = knownProductionUserDirs();
  for (const p of prod.paths) {
    if (normalizeForCompare(target) === normalizeForCompare(p)) {
      fail(envName + " 指向真实产品 userData（禁止）: " + p);
    }
  }
  if (process.env.APPDATA && isInsideOrEqual(target, process.env.APPDATA)) {
    fail(envName + " 位于 %APPDATA% 之下（真实产品数据区，禁止）: " + target);
  }
  if (!isInsideOrEqual(target, EXPERIMENT_ROOT)) {
    fail(envName + " 必须位于允许的实验根之内: " + EXPERIMENT_ROOT + "（收到 " + target + "）");
  }
  const workspace = workspaceOf(target);
  if (!workspace) {
    fail(envName + " 不属于 " + EXPERIMENT_ROOT + " 下的任何一次 run workspace: " + target);
  }
  if (o.requireExists !== false) {
    // workspace（隔离单元）与 snapshot root 都必须真实存在：路径策略不接受"尚未建立"的猜测。
    let wsStat = null;
    let stat = null;
    try { wsStat = fs.statSync(workspace); } catch { /* 统一报错 */ }
    if (!wsStat || !wsStat.isDirectory()) fail("实验 workspace 不存在（请先由 researcher 建立）: " + workspace);
    try { stat = fs.statSync(target); } catch { /* 统一报错 */ }
    if (!stat) fail("snapshot root 不存在（请先由 researcher 建立）: " + target);
    if (!stat.isDirectory()) fail("snapshot root 不是目录: " + target);
  }
  return target;
}

/** workspace 根目录（<实验根>/<run>）断言：通过即是实验 workspace 本身。 */
function assertPerceptionWorkspace(wsRaw) {
  const raw = wsRaw === undefined ? process.env.SUZURAN_WS_DIR : wsRaw;
  if (!raw) fail("SUZURAN_WS_DIR 未设置：感知实验 workspace 必须显式给出");
  if (!path.isAbsolute(String(raw))) fail("SUZURAN_WS_DIR 必须是绝对路径: " + String(raw));
  const target = path.resolve(String(raw));
  const ws = workspaceOf(target);
  if (!ws) {
    fail("SUZURAN_WS_DIR 必须是 " + EXPERIMENT_ROOT + " 之下的 workspace run 目录: " + target);
  }
  let stat = null;
  try { stat = fs.statSync(ws); } catch { /* 统一报错 */ }
  if (!stat || !stat.isDirectory()) fail("workspace 不存在（请先由 researcher 建立）: " + ws);
  return ws;
}

/** argv 里取 --user-data-dir=V / --user-data-dir V（只取最后一个，与 Chromium 一致）。 */
function parseUserDataDirArg(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a === "--user-data-dir") return list[i + 1] === undefined ? "" : list[i + 1];
    if (a.startsWith("--user-data-dir=")) return a.slice("--user-data-dir=".length);
  }
  return null;
}

/**
 * Electron 启动配对断言：snapshot root 与 --user-data-dir 必须指向同一次实验 workspace。
 * 必须"在 spawn 之前"调用；本函数自身不 spawn、不写盘。
 * @returns {{snapshotRoot: string, workspace: string, userDataDir: string, mode: "subdir"|"equal"}}
 */
function assertElectronIsolation(opts) {
  const o = opts || {};
  if (!Object.prototype.hasOwnProperty.call(o, "snapshotRoot")) {
    fail("assertElectronIsolation 必须显式给出 snapshotRoot（不接受隐式默认）");
  }
  const snapshotRoot = assertPerceptionIsolation({ userDir: o.snapshotRoot, requireExists: false });

  const argvDir = parseUserDataDirArg(o.argv || []);
  // UDD 来源必须与"传给子进程的 env"同源：显式 opts.env 优先，否则回落到 process.env。
  // 不允许把 opts.env 与 process.env 混用（否则残留 env 会覆盖显式配置，判定变得不确定）。
  const env = o.env || process.env;
  let uddRaw;
  if (argvDir !== null) {
    uddRaw = argvDir;
  } else if (o.userDataDir) {
    uddRaw = o.userDataDir;
  } else if (env[UDD_ENV]) {
    uddRaw = env[UDD_ENV];
  } else {
    fail("Electron 启动缺少 --user-data-dir（或 " + UDD_ENV + "）：研究者工装禁止使用产品默认 userData");
  }
  if (!uddRaw) fail("--user-data-dir 为空值，拒绝启动");
  if (!path.isAbsolute(String(uddRaw))) fail("--user-data-dir 必须是绝对路径: " + String(uddRaw));
  const udd = path.resolve(String(uddRaw));

  const prod = knownProductionUserDirs();
  for (const p of prod.paths) {
    if (normalizeForCompare(udd) === normalizeForCompare(p)) fail("--user-data-dir 指向真实产品 userData（禁止）: " + p);
  }
  if (process.env.APPDATA && isInsideOrEqual(udd, process.env.APPDATA)) {
    fail("--user-data-dir 位于 %APPDATA% 之下（产品数据区，禁止）: " + udd);
  }
  const workspace = workspaceOf(snapshotRoot);
  if (!workspace) fail("snapshot root 不属于实验 workspace: " + snapshotRoot);
  if (normalizeForCompare(udd) === normalizeForCompare(workspace)) {
    fail("--user-data-dir 不得等于 workspace 根（Chromium 会污染 snapshot 目录）: " + udd);
  }
  if (!isInsideOrEqual(udd, workspace)) {
    fail("snapshot root 与 --user-data-dir 必须属于同一次实验 workspace（" + workspace + "）: " + udd);
  }
  return { snapshotRoot, workspace, userDataDir: udd, mode: "subdir" };
}

/**
 * 产品侧（main.js）可选预检：只在研究者显式声明实验模式时才强制隔离。
 * 未设置标记 → 不做任何检查，产品行为逐字不变。
 * shell（scripts/perception/electron-preload.js）与本函数共用同一判定。
 */
function assertExperimentMarkerIsolation(opts) {
  const o = opts || {};
  if (String(process.env[EXPERIMENT_ENV] || "") !== "1") return { enforced: false };
  const userDataDir = o.userDataDir || "";
  if (!userDataDir) fail("实验模式要求 Electron userData 已知（app.getPath('userData') 为空）");
  if (!path.isAbsolute(String(userDataDir))) fail("实验模式要求 userData 为绝对路径: " + String(userDataDir));
  const udd = path.resolve(String(userDataDir));

  const prod = knownProductionUserDirs();
  for (const p of prod.paths) {
    if (normalizeForCompare(udd) === normalizeForCompare(p)) {
      fail("实验模式启动到了真实产品 userData（禁止）: " + p);
    }
  }
  if (process.env.APPDATA && isInsideOrEqual(udd, process.env.APPDATA)) {
    fail("实验模式启动到了 %APPDATA% 下的产品数据区（禁止）: " + udd);
  }
  // udd 允许两种形态：① workspace 根之下的子目录（默认 udd-X / udd-Y）；② workspace 根本身。
  const wsFromUdd = workspaceOf(udd);
  const wsFromParent = workspaceOf(path.dirname(udd));
  const uddWorkspace = wsFromUdd || wsFromParent;
  if (!uddWorkspace) {
    fail("实验模式 userData 必须位于 " + EXPERIMENT_ROOT + " 的某次 run 目录之内: " + udd);
  }
  const envRaw = process.env[USERDIR_ENV];
  if (envRaw && path.isAbsolute(String(envRaw))) {
    const envRoot = path.resolve(String(envRaw));
    const envWorkspace = workspaceOf(envRoot) || workspaceOf(path.dirname(envRoot));
    if (!envWorkspace || normalizeForCompare(envWorkspace) !== normalizeForCompare(uddWorkspace)) {
      fail(USERDIR_ENV + " 与 Electron userData 不属于同一次实验 workspace: " + envRoot + " vs " + udd);
    }
  }
  return { enforced: true, userDataDir: udd, workspace: uddWorkspace };
}

module.exports = {
  TMP_ROOT,
  EXPERIMENT_ROOT,
  EXPERIMENT_ROOT_REL,
  USERDIR_ENV,
  UDD_ENV,
  EXPERIMENT_ENV,
  assertPerceptionIsolation,
  assertPerceptionWorkspace,
  assertElectronIsolation,
  assertExperimentMarkerIsolation,
  knownProductionUserDirs,
  parseUserDataDirArg,
  workspaceOf,
  isInsideOrEqual,
  normalizeForCompare
};

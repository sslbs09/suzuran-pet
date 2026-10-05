"use strict";

/*
 * electron-launcher.js — Phase 9-B 感知实验 Electron 启动器（researcher-only tooling，唯一允许的 spawn 点）。
 *
 * 契约（fail-closed）：
 *   1. 启动前调用 isolation.assertElectronIsolation：snapshot root 与 --user-data-dir
 *      必须都属于同一次实验 workspace（<临时目录>/wm-perception-9b/<run>/），
 *      任何一项不满足 → 抛错返回非零，绝不 spawn；
 *   2. 不接受"继承了产品参数"的启动：--user-data-dir 必须显式给出
 *      （argv / SUZURAN_WM_USERDATA_DIR / opts），缺失即拒绝；
 *   3. 本模块不写 workspace 状态、不删除目录、不做 fallback。
 *
 * 环境来源（researcher 侧）：
 *   SUZURAN_TEST_USERDIR     = <workspace>                （snapshot root，与 storage.js 一致）
 *   SUZURAN_WM_USERDATA_DIR  = <workspace>/udd-X|udd-Y    （Electron --user-data-dir）
 *   SUZURAN_WM_ELECTRON_BIN  = 可选；默认取仓库 node_modules/electron/dist/electron.exe
 *
 * CLI：
 *   node scripts/perception/electron-launcher.js init        # 解析并打印启动计划（不 spawn）
 *   node scripts/perception/electron-launcher.js smoke       # 真实最短 Electron 冒烟（startup→write→restart→shutdown）
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const isolation = require("./isolation");

const APP_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_ELECTRON_BIN = path.join(APP_DIR, "node_modules", "electron", "dist", "electron.exe");
const SMOKE_HARNESS_DIR = path.join(__dirname, "fixtures", "electron-smoke");

/** Electron 可执行文件来源：显式 env → 仓库内 electron 包 → null（当前平台无 Electron 二进制）。
 *  返回 null 只表示"本平台/本检出没有 Electron 可执行文件"（干净 CI 的合法状态）；
 *  真正需要启动时由 buildElectronArgs 显式拒绝，绝不静默换用系统 electron。 */
function electronBinaryFromEnv(env) {
  const e = env || process.env;
  const explicit = e.SUZURAN_WM_ELECTRON_BIN;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("SUZURAN_WM_ELECTRON_BIN 必须是绝对路径");
    return path.resolve(explicit);
  }
  return fs.existsSync(DEFAULT_ELECTRON_BIN) ? DEFAULT_ELECTRON_BIN : null;
}

/** 当前环境是否存在可用的 Electron 可执行文件（CI 可据此把 Electron 面判为"未验证"而非"通过"）。
 *  注意必须连同文件存在性一起判定：仅有默认路径字符串并不等于可启动。 */
function electronBinaryAvailable(env) {
  const bin = electronBinaryFromEnv(env);
  return bin !== null && fs.existsSync(bin);
}

/**
 * 构造 Electron 启动计划（纯函数语义：只验证 + 返回 argv，不 spawn）。
 * @returns {{command: string, args: string[], options: object}}
 */
function buildElectronArgs(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const snapshotRoot = Object.prototype.hasOwnProperty.call(o, "snapshotRoot")
    ? o.snapshotRoot
    : env.SUZURAN_TEST_USERDIR;

  const pair = isolation.assertElectronIsolation({
    snapshotRoot,
    argv: o.argv || [],
    userDataDir: o.userDataDir,
    env // 与下方注入子进程的 env 同源：避免"显式 env 说一套、process.env 说另一套"
  });

  const command = o.command || electronBinaryFromEnv(env);
  if (!command) {
    throw new Error("当前平台缺少 Electron 可执行文件（" + DEFAULT_ELECTRON_BIN
      + "）：无可启动的 Electron；researcher 可用 SUZURAN_WM_ELECTRON_BIN 显式指定绝对路径");
  }
  if (!fs.existsSync(command)) throw new Error("Electron 可执行文件不存在: " + command);

  const appTarget = o.appTarget === false ? null : (o.appTarget ? path.resolve(o.appTarget) : APP_DIR);
  const uddFlag = "--user-data-dir=" + pair.userDataDir;
  const extraArgs = Array.isArray(o.extraArgs) ? o.extraArgs.map(String) : [];
  const childEnv = { ...env };
  // 关键：ELECTRON_RUN_AS_NODE=1 会把 electron.exe 降级成纯 Node（app 不可用、无 userData 隔离语义），
  // 且它是宿主环境常见的污染源（本机 shell 就设置了）——实验启动必须显式清掉。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv[isolation.USERDIR_ENV] = pair.snapshotRoot; // snapshot root 必须与 storage.js 一致
  childEnv[isolation.EXPERIMENT_ENV] = "1";
  return {
    command,
    // appTarget=false 时不注入产品入口（仅供研究者用假 electron 捕获 argv；Electron 正常用法总会带入口）
    args: [...(appTarget ? [appTarget] : []), uddFlag, ...extraArgs],
    options: { env: childEnv, cwd: APP_DIR },
    isolation: pair
  };
}

/** 唯一允许的 Electron spawn 点：计划 → spawn（守护已在计划阶段完成）。
 *  opts.spawnFn：仅用于研究者侧验证（注入记录器，证明守卫先于 spawn）；默认 child_process.spawnSync。 */
function launchElectron(opts) {
  const plan = buildElectronArgs(opts);
  const spawnFn = (opts && opts.spawnFn) || spawnSync;
  const result = spawnFn(plan.command, plan.args, {
    ...plan.options,                       // env（含隔离变量）与 cwd 必须沿用计划里的值
    env: plan.options.env,
    timeout: (opts && opts.timeoutMs) || 120000
  });
  return {
    plan,
    status: result.status,
    signal: result.signal || null,
    stdout: result.stdout === undefined || result.stdout === null ? null : String(result.stdout),
    stderr: result.stderr === undefined || result.stderr === null ? null : String(result.stderr)
  };
}

/** Electron 冒烟：startup → isolated write → restart → shutdown（不含任何等待随机 proactive）。 */
function runElectronSmoke(opts) {
  const o = opts || {};
  const first = launchElectron({ ...o, appTarget: SMOKE_HARNESS_DIR });
  if (first.status !== 0) {
    throw new Error("Electron smoke 首次启动失败 status=" + first.status + " stderr=" + String(first.stderr || "").slice(0, 400));
  }
  const second = launchElectron({ ...o, appTarget: SMOKE_HARNESS_DIR });
  if (second.status !== 0) {
    throw new Error("Electron smoke restart 失败 status=" + second.status + " stderr=" + String(second.stderr || "").slice(0, 400));
  }
  return { plan: first.plan, firstStatus: first.status, secondStatus: second.status };
}

function main() {
  const cmd = process.argv[2] || "init";
  if (cmd === "init") {
    const plan = buildElectronArgs({ appTarget: APP_DIR });
    console.log(JSON.stringify({ step: "electron-plan", command: plan.command, args: plan.args, isolation: plan.isolation }, null, 2));
  } else if (cmd === "smoke") {
    const r = runElectronSmoke({});
    console.log(JSON.stringify({
      step: "electron-smoke", userDataDir: r.plan.isolation.userDataDir,
      workspace: r.plan.isolation.workspace, firstStatus: r.firstStatus, secondStatus: r.secondStatus
    }, null, 2));
  } else {
    throw new Error("未知子命令: " + cmd);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("ELECTRON_LAUNCHER_FAIL: " + String((e && e.message) || e));
    process.exit(1);
  }
}

module.exports = {
  buildElectronArgs, launchElectron, runElectronSmoke,
  electronBinaryFromEnv, electronBinaryAvailable, DEFAULT_ELECTRON_BIN, SMOKE_HARNESS_DIR
};

"use strict";

/*
 * snapshot-worker.js — Phase 9-B 感知实验协议专用 worker（researcher-only tooling）。
 *
 * 必须以子进程方式运行，并由 spawner 预先设置 SUZURAN_TEST_USERDIR=<snapshot 绝对路径>：
 * storage.js 在 require 时读取该环境变量，之后 memory/config/bond/history 全部落进 snapshot，
 * 与真实 userData（%APPDATA%\苏苏洛桌宠 2.5 正式版）完全隔离。
 *
 * 安全边界（Phase 9-B.1 fail-closed）：加载本模块前必须先满足 isolation.js 的判定——
 * SUZURAN_TEST_USERDIR 存在、绝对、非产品路径、且恰好是 <临时目录>/wm-perception-9b/<run>
 * 这一层；否则模块顶部即抛 PERCEPTION_ISOLATION_REFUSED，storage.js 根本不会被加载。
 * 所有 fs I/O 的路径一律由 guardedJoin(root, p) 生成——path.resolve 后强制
 * startsWith(root + path.sep)，越界即拒绝。根只有两种：snapshot root（读写唯一根）
 * 与仓库安装目录 APP_DIR（只读 persona 模板）。worker 本身不接受任何路径参数，
 * dump-semantic 的结果经 stdout 返回、由 spawner 落盘。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const isolation = require("./isolation");

// fail-closed 前置断言：必须早于 storage.js 被 require（storage.js 在 require 时即读取
// SUZURAN_TEST_USERDIR，一旦缺失就会绑定真实产品 userData）。缺少 env 时这里直接抛错，
// 生产模块根本不会被加载。
if (!process.env[isolation.USERDIR_ENV]) {
  throw new Error("PERCEPTION_ISOLATION_REFUSED: " + isolation.USERDIR_ENV
    + " 未设置：snapshot-worker 拒绝加载（绝不会回退到真实产品 userData）");
}

const storage = require("../../src/storage"); // require 时读取 SUZURAN_TEST_USERDIR（上方已断言存在）

const APP_DIR = path.resolve(__dirname, "..", "..");
const TMP_ROOT = path.resolve(os.tmpdir());

function guardedJoin(root, p) {
  const target = path.resolve(root, String(p));
  const base = path.resolve(root) + path.sep;
  if (!target.startsWith(base)) throw new Error("路径越界（拒绝）: " + target);
  return target;
}

function assertIsolated() {
  // 路径策略统一收敛到 isolation.js：必须是允许实验根下的某次 run 目录绝对路径。
  const userDir = isolation.assertPerceptionIsolation();
  if (path.resolve(storage.PATHS.userDir) !== userDir) {
    throw new Error("snapshot-worker 的 userDir 与 SUZURAN_TEST_USERDIR 不一致: " + storage.PATHS.userDir);
  }
  return userDir;
}

function readText(file) { return fs.readFileSync(file, "utf8"); }

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function readJsonOrNull(file) {
  try { return JSON.parse(readText(file)); } catch { return null; }
}

/** base snapshot：无竞争 facts、无 reminder/schedule/vector、空 history、bond 最小合法状态、agreed:true。
 *  预写迁移 marker：跳过首启模板迁移（模板 agreed:true 会被清成 false 的逻辑因此不参与）。 */
function initBase() {
  const userDir = assertIsolated();
  const marker = guardedJoin(userDir, ".storage-migration-v1.json");
  if (!fs.existsSync(marker)) {
    writeText(marker, JSON.stringify({ version: 1, at: new Date().toISOString(), migrated: [], failed: [] }, null, 2));
  }
  // EXPERIMENT NON-PRODUCT EXPOSURE MODE：proactiveMin=1 仅存在于实验 snapshot config，
  // 只服务 researcher-only live dry-run；真实 config 永不被写。
  // TTS 引擎关停（两臂一致）：dry-run 只观测文字气泡通道，避免 GSV/Genie 自动拉起。
  // focusMode=false（两臂一致）：无人值守 dry-run 无键鼠输入，focus-watch 会在
  // 系统空闲 5 分钟后置 away，sendProactive 会静默丢弃全部主动消息——
  // 实验快照必须关闭该环境性抑制，否则 live exposure 永远观测不到信号。
  writeText(guardedJoin(userDir, "config.json"), JSON.stringify({
    agreed: true,
    features: { proactiveMin: 1, focusMode: false },
    tts: { enabled: false },
    ttsGsv: { enabled: false, autoStart: false },
    ttsGenie: { enabled: false, autoStart: false }
  }, null, 2));
  writeText(guardedJoin(userDir, "bond.json"), JSON.stringify({
    exp: 0, days: 0, lastDay: "", firstDay: "", interactions: 0
  }, null, 1));
  writeText(guardedJoin(userDir, "history", "history.jsonl"), "");
  const personaDst = guardedJoin(userDir, "persona.md");
  if (!fs.existsSync(personaDst)) {
    const personaSrc = guardedJoin(APP_DIR, "persona.md"); // 只读来源：仓库模板
    if (fs.existsSync(personaSrc)) fs.copyFileSync(personaSrc, personaDst);
  }
  return { userDir, wrote: ["config.json", "bond.json", "history/history.jsonl", "persona.md"] };
}

/** 通过真实 memory API 写入 target mediator fact（history:<id> 命名空间）。 */
function addFact(spec) {
  assertIsolated();
  const memory = require("../../src/memory");
  memory.load();
  memory.addFacts([{ type: String(spec.type || ""), text: String(spec.text || ""), anchor: String(spec.anchor || "") }]);
  return memory.getFactsList();
}

/** 语义态导出：A/B 公平比较的唯一事实来源。全部经真实模块读出，不做字节假设。 */
function dumpSemantic() {
  const userDir = assertIsolated();
  const config = require("../../src/config");
  const memory = require("../../src/memory");
  const history = require("../../src/history");

  const cfg = JSON.parse(JSON.stringify(config.getConfig(true)));
  // 路径归一：_configPath / zcodeCli 含机器本地路径，跨臂无语义
  const norm = (v) => typeof v === "string" ? v.split(userDir).join("<USERDIR>") : v;
  const normDeep = (x) => {
    if (Array.isArray(x)) return x.map(normDeep);
    if (x && typeof x === "object") {
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = normDeep(norm(x[k]));
      return o;
    }
    return norm(x);
  };

  const memFile = guardedJoin(userDir, "memory.json");
  const memRaw = fs.existsSync(memFile) ? readText(memFile) : "";
  const facts = memory.getFactsList().map((f) => ({ id: f.id, type: f.type, text: f.text, anchor: f.anchor }));
  const dump = {
    userDirTag: path.basename(userDir),
    config: normDeep(cfg),
    memory: {
      facts,
      summary: memory.getSummary(),
      memoryFileEncrypted: memRaw.length > 0 && !memRaw.replace(/^﻿/, "").trim().startsWith("{")
    },
    bond: readJsonOrNull(guardedJoin(userDir, "bond.json")),
    historyRows: history.load(),
    schedules: readJsonOrNull(guardedJoin(userDir, "schedules.json")),
    vectorMemoryPresent: fs.existsSync(guardedJoin(userDir, "memory-vector.json")),
    remindersPending: []
  };
  return dump;
}

/** restart 后核查：history:* mediator 是否仍在 / 是否本就不存在；以及存储形态。 */
function factStatus(prefix) {
  const userDir = assertIsolated();
  const memory = require("../../src/memory");
  const facts = memory.getFactsList().filter((f) => typeof f.type === "string" && f.type.startsWith(prefix));
  const memFile = guardedJoin(userDir, "memory.json");
  const raw = fs.existsSync(memFile) ? readText(memFile) : "";
  return {
    userDir,
    prefix,
    present: facts.length > 0,
    facts,
    memoryFileEncrypted: raw.length > 0 && !raw.replace(/^﻿/, "").trim().startsWith("{"),
    memoryFileBytes: raw.length
  };
}

function main() {
  const cmd = process.argv[2];
  let result = null;
  if (cmd === "init-base") result = initBase();
  else if (cmd === "add-fact") result = addFact(JSON.parse(process.argv[3]));
  else if (cmd === "dump-semantic") result = dumpSemantic();
  else if (cmd === "fact-status") result = factStatus(process.argv[3] || "history:");
  else throw new Error("未知命令: " + cmd);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
    process.exit(1);
  }
}

module.exports = { initBase, addFact, dumpSemantic, factStatus, assertIsolated, guardedJoin, TMP_ROOT };

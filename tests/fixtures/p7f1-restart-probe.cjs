"use strict";

/**
 * Phase 7-F1 真实新进程重启探针（PLAN → COMPLETED 生命周期真相）。
 *
 * 由 tests/plan-completion-causal.test.js 以全字面量参数列表 spawn 执行
 * （`node tests/fixtures/p7f1-restart-probe.cjs`，继承其 cwd=仓库根）。
 * 本文件不参与 npm test 自动发现——run-tests.cjs 只扫描 tests/*.test.js 顶层。
 *
 * 前置：父测试进程已通过 SUZURAN_TEST_USERDIR 指向同一个临时 userdir，并已写入
 * 一条 history:<planFactId>（PLAN 已被删除）。本进程是全新 node 进程（全新模块
 * 注册表），从磁盘重新 load memory 后做决策，验证：
 *   PLAN 确实退场（hasPlan === false）
 *   HISTORY 确实存续（hasHistory === true）
 *   自主决策确实从「未来计划助威」切换为「已完成历史回忆」（branch === "history"）
 *
 * 输出契约：成功时 stdout 输出一行 JSON；失败时 stderr + exit 1。
 */
const memory = require("../../src/memory");
const { chooseExperienceTopic } = require("../../src/character-runtime/experience-topic");

const facts = memory.getFactsList();
const choice = chooseExperienceTopic({ facts, random: () => 0.0, now: new Date(2026, 9, 5) });
const result = {
  factCount: facts.length,
  types: facts.map((f) => f.type),
  hasPlan: facts.some((f) => f.type === "event"),
  hasHistory: facts.some((f) => String(f.type).startsWith("history:")),
  branch: choice && choice.branch,
  line: choice && choice.lines && choice.lines[0],
};

if (result.hasPlan || !result.hasHistory || result.branch !== "history") {
  process.stderr.write("P7F1-RESTART-PROBE-FAIL " + JSON.stringify(result) + "\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(result));

"use strict";

/**
 * Phase 7-E 真实新进程重启探针。
 *
 * 由 tests/history-recall-causal.test.js 以全字面量参数列表 spawn 执行
 * （`node tests/fixtures/p7e-restart-probe.cjs`，继承其 cwd=仓库根）。
 * 本文件不参与 npm test 自动发现——run-tests.cjs 只扫描 tests/*.test.js 顶层。
 *
 * 前置：父测试进程已通过环境变量 SUZURAN_TEST_USERDIR 指向同一个临时 userdir，
 * 并已写入 history:ev-001 合成事实（+ joy 基线）。本进程是全新的 node 进程
 * （全新模块注册表），从磁盘重新 load memory 后做决策，
 * 验证「跨真实进程重启，历史经历的影响存续」。
 *
 * 输出契约：成功时 stdout 输出一行 JSON {factCount,has,branch}；失败时 exit 1。
 */
const memory = require("../../src/memory");
const { chooseExperienceTopic } = require("../../src/character-runtime/experience-topic");

const facts = memory.getFactsList();
const has = facts.some((f) => f.type === "history:ev-001");
const choice = chooseExperienceTopic({ facts, random: () => 0.0, now: new Date(2026, 9, 5) });
const result = { factCount: facts.length, has, branch: choice && choice.branch };

if (!result.has || result.branch !== "history") {
  process.stderr.write("RESTART-PROBE-FAIL " + JSON.stringify(result) + "\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(result));

"use strict";

/**
 * Phase 8-D 真实新进程重启探针（PLAN → 外层发起概率的决策级稳定性）。
 *
 * 由 tests/plan-initiation-causal.test.js 以全字面量参数列表 spawn 执行
 * （`node tests/fixtures/p8d-restart-probe.cjs`，继承其 cwd=仓库根与 SUZURAN_TEST_USERDIR）。
 * 本文件不参与 npm test 自动发现——run-tests.cjs 只扫描 tests/*.test.js 顶层。
 *
 * 前置：父测试进程已通过 SUZURAN_TEST_USERDIR 指向同一个临时 userdir，并已写入
 * （或删除）一条 type:"event" 的 PLAN 事实。本进程是全新 node 进程（全新模块注册表），
 * 从磁盘重新 load memory 后把 facts 喂给纯 policy 模块，验证：
 *   PLAN 在磁盘上  → effectiveInitiateChance 返回提升后的概率（0.18 + PLAN_BOOST）
 *   PLAN 不在磁盘上 → effectiveInitiateChance 返回 baseline 概率（0.18）
 * 即：决策输入（PLAN 存在性）跨重启存续，决策输出（effective chance）随之稳定。
 *
 * 结论边界：这是 decision-level restart stability；真实 60s timer 的跨重启发言频率
 * 未实测，不得声称。
 *
 * 输出契约：成功时 stdout 输出一行 JSON；失败时 stderr + exit 1。
 */
const memory = require("../../src/memory");
const { effectiveInitiateChance, PLAN_BOOST } = require("../../src/character-runtime/proactive-initiation");

const BASE_CHANCE = 0.18; // 与 features.PROACTIVE_DEFAULTS.chance 逐位一致（刻意不 import features，保持探针最小依赖）
const facts = memory.getFactsList();
const chance = effectiveInitiateChance({ facts, baseChance: BASE_CHANCE, enabled: true });
const result = {
  factCount: facts.length,
  types: facts.map((f) => f.type),
  hasPlan: facts.some((f) => f.type === "event"),
  chance,
  baseChance: BASE_CHANCE,
  planBoost: PLAN_BOOST,
};

const expected = result.hasPlan ? Math.min(1, BASE_CHANCE + PLAN_BOOST) : BASE_CHANCE;
if (chance !== expected) {
  process.stderr.write("P8D-RESTART-PROBE-FAIL " + JSON.stringify(result) + "\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(result));

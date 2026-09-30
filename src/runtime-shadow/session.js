/**
 * session.js — Shadow Slice v0.1 会话编排（有界、默认关闭、结构化输出、故障隔离）。
 *
 * FREEZE PHASE 2/14 + Blocker Closure：
 * - gate OFF：createShadowSession 返回 null（main 侧条件创建）——零 session、零 log、零 timer；
 * - gate ON：只观察、只计算、只输出诊断。全部活动集合 by construction 有界
 *   （事件 ring 512 / 摘要 8 / fault ring 8），重复 fault 聚合计数不刷屏；
 * - 事件身份：renderer 事件 sourceSeq=生产者 seq 原样保留、sourceEpoch=docEpoch、
 *   sampledAt=生产者采样时刻（clock domain 显式）、receivedAt=main 接收时刻（monoMs 不可得时为 null，
 *   绝不回退墙钟冒充单调钟）、receiveOrder=main 接收顺序（独立记录，绝不冒充 sourceSeq）；
 * - 信任边界：renderer 证据先过 contract.sanitizeRendererEvidence（sender 校验在 main IPC handler）；
 * - causeRef：v0.1 无可证明因果 → 恒 null；
 * - 故障隔离：noteFault 有界聚合；日志/序列化自身故障不再递归进 shadow 处理链。
 */
"use strict";

const { normalizeShadowEvent, createShadowRunContext, sanitizeRendererEvidence } = require("./contract");
const { createShadowEvaluator, shadowObserve, noteStaleResult } = require("./evaluator");

const SESSION_MAX_EVENTS = 512;      // ring buffer 上限（丢最旧，计 drops）
const SESSION_MAX_SUMMARIES = 8;     // 摘要保留条数
const SESSION_MAX_FAULTS = 8;        // 最近 distinct fault 保留条数

function monoMsOrNull(deps) {
  try {
    if (deps && typeof deps.monoMs === "function") {
      const v = deps.monoMs();
      return Number.isFinite(v) ? v : null; // 注入源明确给 null → 保持 null，不回退墙钟冒充
    }
  } catch { /* fallthrough */ }
  try {
    if (typeof process !== "undefined" && process.hrtime && process.hrtime.bigint) {
      return Number(process.hrtime.bigint()) / 1e6;
    }
  } catch { /* fallthrough */ }
  return null; // 单调钟不可得 → null（不同 clock domain 禁止相减；宁缺毋假）
}

/**
 * @param {Object} opts
 *  - enabled: gate 结果（main.js 读 SUSSURRO_RUNTIME_V2_SHADOW；OFF 时 main 不调用本函数）
 *  - deps: {log(event,msg), nowMs(), monoMs(), pid, gitBaseline, standBeatEnabled}
 */
function createShadowSession({ deps } = {}) {
  const d = deps || {};
  const log = (ev, msg) => { try { d.log && d.log(ev, msg); } catch { /* 日志失败不影响主流程 */ } };
  const nowMs = () => { try { return d.nowMs ? d.nowMs() : Date.now(); } catch { return 0; } };

  const runContext = createShadowRunContext({
    runId: "shadow-" + (d.pid || 0) + "-" + nowMs().toString(36),
    gitBaseline: d.gitBaseline,
    standBeatEnabled: d.standBeatEnabled !== false
  });
  const evaluator = createShadowEvaluator({ runContext });

  const s = {
    active: true,
    runContext,
    evaluator,
    seqs: { main: 0 },              // main 侧单来源单调；renderer seq 由生产者给
    receiveCounter: 0,              // main 接收顺序（独立于 sourceSeq）
    ring: [],
    ringNext: 0,
    drops: 0,                       // 白名单拒绝/非法证据计数（有界聚合，不逐条刷日志）
    inputCoverage: {},
    summaries: [],
    faults: { count: 0, suppressed: 0, recent: [] }, // 有界 fault 记录
    startedAtMs: nowMs()
  };

  function coverageAdd(kind) {
    s.inputCoverage[kind] = (s.inputCoverage[kind] || 0) + 1;
  }

  function pushEnvelope(env) {
    if (s.ring.length < SESSION_MAX_EVENTS) s.ring.push(env);
    else { s.ring[s.ringNext] = env; s.ringNext = (s.ringNext + 1) % SESSION_MAX_EVENTS; s.drops += 1; }
  }

  /** Shadow 层故障记录（有界、聚合、绝不 throw、不递归进 shadow 处理链） */
  s.noteFault = function noteFault(op, error) {
    try {
      s.faults.count += 1;
      const msg = String((error && (error.message || error)) || "unknown").slice(0, 160);
      const prev = s.faults.recent.find((f) => f.op === op && f.message === msg);
      if (prev) {
        prev.count += 1;
        s.faults.suppressed += 1;
        if (prev.count === 10 || prev.count === 100 || prev.count % 1000 === 0) {
          log("walk", "[RTSHADOW-FAULT] " + JSON.stringify({ op, message: msg, count: prev.count, suppressedTotal: s.faults.suppressed }));
        }
        return;
      }
      const entry = { op, message: msg, count: 1 };
      s.faults.recent.push(entry);
      if (s.faults.recent.length > SESSION_MAX_FAULTS) s.faults.recent.shift();
      log("walk", "[RTSHADOW-FAULT] " + JSON.stringify({ op, message: msg, count: 1, faultsTotal: s.faults.count }));
    } catch { /* 故障记录自身失败：静默（绝不影响生产） */ }
  };

  function drainRecords(records) {
    for (const r of records || []) {
      try {
        if (r.type === "interpretation") {
          log("walk", "[RTSHADOW] " + JSON.stringify({
            ev: "interpretation", episodeId: r.episodeId, ref: r.ref, phase: r.phase,
            decision: r.decision, motion: r.motion, geometry: r.geometry, body: r.body,
            interpretation: r.interpretation, phaseTransition: !!r.phaseTransition, newDivergences: r.newDivergences || 0
          }));
        } else if (r.type === "divergence") {
          log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "divergence", divergenceType: r.divergenceType, reason: r.reason, ref: r.ref }));
        } else if (r.type === "observation-note") {
          log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "observation", noteType: r.noteType, ref: r.ref }));
        } else if (r.type === "stop") {
          log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "stop", reason: r.reason, ref: r.ref }));
        } else if (r.type === "replacement") {
          log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "replacement", kind: r.kind || "body-generation", from: r.from || null, to: r.to || null, ref: r.ref }));
        } else if (r.type === "stale-evidence") {
          log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "stale-evidence", reason: r.reason, ref: r.ref }));
        } else if (r.type === "complete") {
          // 摘要统一在 summaries 分支输出
        }
      } catch (e) { s.noteFault("drain-records", e); }
    }
  }

  function logSummary(summary) {
    if (!summary) return;
    s.summaries.push(summary);
    if (s.summaries.length > SESSION_MAX_SUMMARIES) s.summaries.shift();
    try {
      log("walk", "[RTSHADOW-EPISODE] " + JSON.stringify(summary));
    } catch (e) { s.noteFault("log-summary", e); }
  }

  /**
   * 事件入口。opts: {seq(main 预分配/broadcast), sampledAt, sourceEpoch, causeRef}
   * 返回信封或 null（白名单拒绝）。本方法不 throw（bridge 之外的第二道边界）。
   */
  s.record = function record(source, kind, payload, opts = {}) {
    try {
      const env = normalizeShadowEvent({ source, kind, payload, causeRef: opts.causeRef, sourceEpoch: opts.sourceEpoch, sampledAt: opts.sampledAt });
      if (!env) { s.drops += 1; return null; }
      env.receiveOrder = ++s.receiveCounter;
      if (source === "renderer") {
        // 生产者 seq 原样保留（G4）；绝不重编号
        env.sourceSeq = Number.isSafeInteger(opts.seq) && opts.seq >= 1 ? opts.seq : null;
        if (env.sourceSeq === null) { s.drops += 1; return null; } // 无生产者 seq → 拒收（不能伪造）
      } else if (Number.isSafeInteger(opts.seq) && opts.seq === s.seqs.main + 1) {
        s.seqs.main = opts.seq;   // broadcastMeta 预分配的同一 seq
        env.sourceSeq = opts.seq;
      } else {
        env.sourceSeq = ++s.seqs.main;
      }
      env.receivedAt = { monoMs: monoMsOrNull(d), dateNow: nowMs() };
      if (!env.sampledAt) env.sampledAt = { clock: "main-hrtime-dateNow", value: env.receivedAt.dateNow, monoMs: env.receivedAt.monoMs };
      pushEnvelope(env);
      coverageAdd(env.kind);
      const out = shadowObserve(evaluator, env);
      drainRecords(out.records);
      for (const sum of out.summaries) logSummary(sum);
      return env;
    } catch (e) {
      s.noteFault("record:" + kind, e);
      return null;
    }
  };

  /**
   * walkBroadcast 关联 meta（gate ON 才有；镜像 seatExitForensic 先例——payload 仅在开启时多一个字段）。
   * seq 预分配：随后 obsBroadcast 以同一 seq 落信封，保证单来源单调可对账。
   */
  s.broadcastMeta = function broadcastMeta() {
    return { v: 1, runId: runContext.runId, seq: s.seqs.main + 1, episodeId: evaluator.episode ? evaluator.episode.id : null };
  };

  /**
   * renderer 证据上行入口（IPC pet:shadow-evidence → 桥 → 这里）。
   * 信任边界：sanitize（sender 校验在 main handler）；绝不 throw；拒绝只计 drops。
   */
  s.observeRendererEvidence = function observeRendererEvidence(raw) {
    try {
      const v = sanitizeRendererEvidence(raw);
      if (!v.ok) { s.drops += 1; return null; }
      const ev = v.ev;
      // 旧文档纪元证据晚到：STALE_RESULT_ACCEPTED（只记不解释，绝不回填成功/回滚身份）
      const gen = evaluator.body.generation;
      if (gen && gen.docEpoch !== null && ev.docEpoch !== null && ev.docEpoch < gen.docEpoch) {
        const rec = noteStaleResult(evaluator, { source: "renderer", sourceSeq: ev.seq });
        try {
          log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "divergence", divergenceType: rec.divergenceType, reason: rec.reason, ref: rec.ref }));
        } catch (e) { s.noteFault("stale-result-log", e); }
      }
      return s.record("renderer", ev.kind, ev.payload, {
        seq: ev.seq,
        sourceEpoch: ev.docEpoch,
        sampledAt: ev.sampledAt
      });
    } catch (e) {
      s.noteFault("renderer-evidence", e);
      return null;
    }
  };

  /** 会话收尾摘要（PHASE 14：不只 PASS/FAIL——报覆盖/UNKNOWN/停止/机会计数 + fault 聚合） */
  s.flush = function flush(reason) {
    try {
      const ep = evaluator.episode;
      const lastSummary = s.summaries.length ? s.summaries[s.summaries.length - 1] : null;
      const timing = {
        observations: s.ring.length + s.drops,
        drops: s.drops,
        episodesCompleted: evaluator.episodesCompleted,
        episodesStopped: evaluator.episodesStopped,
        receiveOrder: s.receiveCounter,
        sessionWallMs: Math.max(0, nowMs() - s.startedAtMs)
      };
      let openEpisode = null;
      if (ep) {
        openEpisode = { episodeId: ep.id, phase: ep.phase, decisionOpportunities: ep.decisionOpportunities, unknownCount: ep.unknownCount };
      }
      log("walk", "[RTSHADOW-FLUSH] " + JSON.stringify({
        ev: "session-flush", contractVersion: runContext.contractVersion, runId: runContext.runId,
        closeReason: reason || "unknown",
        inputCoverage: s.inputCoverage,
        divergenceCounts: evaluator.divergenceCounts,
        observationCounts: evaluator.observationCounts,
        faults: { count: s.faults.count, suppressed: s.faults.suppressed, recent: s.faults.recent.slice(0, SESSION_MAX_FAULTS) },
        openEpisode,
        lastEpisode: lastSummary ? { episodeId: lastSummary.episodeId, completed: lastSummary.completed, stopped: lastSummary.stopped, stopReason: lastSummary.stopReason } : null,
        timing
      }));
    } catch (e) { s.noteFault("flush", e); }
  };

  return s;
}

module.exports = { createShadowSession, SESSION_MAX_EVENTS };

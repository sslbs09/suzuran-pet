/**
 * session.js — Shadow Slice v0.1 会话编排（有界、默认关闭、结构化输出）。
 *
 * FREEZE PHASE 2/14：
 * - gate OFF：createShadowSession 返回全 no-op stub——零 session、零 log、零 timer、零分配；
 * - gate ON：只观察、只计算、只输出诊断。有界 ring buffer（丢最旧），按 episode 输出摘要，
 *   绝不每帧刷屏、不输出大对象（摘要全部是有界字段表）。
 *
 * 输出经注入的 log（main.js 传 logTts("walk", …)，前缀 [RTSHADOW*]），不走 console。
 * 确定性：时钟全部注入（nowMs/monoMs）；同输入序列 → 同输出（测试合同）。
 */
"use strict";

const { normalizeShadowEvent, createShadowRunContext } = require("./contract");
const { createShadowEvaluator, shadowObserve, noteStaleResult } = require("./evaluator");

const SESSION_MAX_EVENTS = 512;      // ring buffer 上限（丢最旧，计 drops）
const SESSION_MAX_SUMMARIES = 8;     // 摘要保留条数

function noopSession() {
  return { active: false, record() { return null; }, broadcastMeta() { return null; }, flush() {}, evaluator: null };
}

/**
 * @param {Object} opts
 *  - enabled: gate 结果（main.js 读 SUSSURRO_RUNTIME_V2_SHADOW）
 *  - deps: {log(event,msg), nowMs(), monoMs(), pid, gitBaseline, standBeatEnabled}
 */
function createShadowSession({ enabled, deps } = {}) {
  if (!enabled) return noopSession();
  const d = deps || {};
  const log = (ev, msg) => { try { d.log && d.log(ev, msg); } catch { /* 诊断失败不影响主流程 */ } };
  const nowMs = () => { try { return d.nowMs ? d.nowMs() : Date.now(); } catch { return 0; } };
  const monoMs = () => { try { return d.monoMs ? d.monoMs() : nowMs(); } catch { return 0; } };

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
    seqs: { main: 0, renderer: 0 },
    ring: [],
    ringNext: 0,
    drops: 0,
    inputCoverage: {},
    summaries: [],
    startedAtMs: nowMs()
  };

  function coverageAdd(kind) {
    s.inputCoverage[kind] = (s.inputCoverage[kind] || 0) + 1;
  }

  function pushEnvelope(env) {
    if (s.ring.length < SESSION_MAX_EVENTS) s.ring.push(env);
    else { s.ring[s.ringNext] = env; s.ringNext = (s.ringNext + 1) % SESSION_MAX_EVENTS; s.drops += 1; }
  }

  function drainRecords(records) {
    for (const r of records || []) {
      if (r.type === "interpretation") {
        log("walk", "[RTSHADOW] " + JSON.stringify({
          ev: "interpretation", episodeId: r.episodeId, ref: r.ref, phase: r.phase,
          decision: r.decision, motion: r.motion, geometry: r.geometry, body: r.body,
          interpretation: r.interpretation, phaseTransition: !!r.phaseTransition, newDivergences: r.newDivergences || 0
        }));
      } else if (r.type === "divergence") {
        log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "divergence", divergenceType: r.divergenceType, reason: r.reason, episodeId: r.episodeId || null, ref: r.ref }));
      } else if (r.type === "observation-note") {
        log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "observation", noteType: r.noteType, ref: r.ref }));
      } else if (r.type === "stop") {
        log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "stop", reason: r.reason, ref: r.ref }));
      } else if (r.type === "replacement") {
        log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "replacement", kind: r.kind || "body-generation", from: r.from || null, to: r.to || null, ref: r.ref }));
      } else if (r.type === "complete") {
        // 摘要统一在 summary 分支输出
      }
    }
  }

  function logSummary(summary) {
    if (!summary) return;
    s.summaries.push(summary);
    if (s.summaries.length > SESSION_MAX_SUMMARIES) s.summaries.shift();
    try {
      log("walk", "[RTSHADOW-EPISODE] " + JSON.stringify(summary));
    } catch { /* 循环引用防护：摘要全为平面字段，不应发生 */ }
  }

  /**
   * 事件入口。opts: {causeRef, sourceEpoch, seq(预分配，broadcast 用)}
   * 返回信封或 null（白名单拒绝/关闭态）。
   */
  s.record = function record(source, kind, payload, opts = {}) {
    const env = normalizeShadowEvent({ source, kind, payload, causeRef: opts.causeRef, sourceEpoch: opts.sourceEpoch });
    if (!env) { s.drops += 1; return null; }
    // 预分配 seq（broadcastMeta peek 的同一值）→ 消费；否则顺序自增。单来源单调不回退。
    if (Number.isSafeInteger(opts.seq) && opts.seq === s.seqs[source] + 1) {
      s.seqs[source] = opts.seq;
      env.sourceSeq = opts.seq;
    } else {
      env.sourceSeq = ++s.seqs[source];
    }
    env.observedAt = { monoMs: monoMs(), dateNow: nowMs() };
    pushEnvelope(env);
    coverageAdd(env.kind);
    const out = shadowObserve(evaluator, env);
    drainRecords(out.records);
    if (out.summary) logSummary(out.summary);
    return env;
  };

  /**
   * walkBroadcast 关联 meta（gate ON 才有；镜像 seatExitForensic 先例——payload 仅在开启时多一个字段）。
   * seq 预分配：随后 obsBroadcast 以同一 seq 落信封，保证 renderer causeRef 可回指。
   */
  s.broadcastMeta = function broadcastMeta() {
    return { v: 1, runId: runContext.runId, seq: s.seqs.main + 1, episodeId: evaluator.episode ? evaluator.episode.id : null };
  };

  /** renderer 证据上行入口（IPC pet:shadow-evidence → 桥 → 这里） */
  s.observeRendererEvidence = function observeRendererEvidence(ev) {
    if (!ev || typeof ev !== "object") { s.drops += 1; return null; }
    const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    // 旧代证据晚到：记录 STALE_RESULT_ACCEPTED（只记不解释，绝不回填成功）
    const gen = evaluator.body.generation;
    if (gen && gen.docEpoch !== null && Number.isFinite(Number(ev.docEpoch)) &&
        Number(ev.docEpoch) < gen.docEpoch) {
      const rec = noteStaleResult(evaluator, { source: "renderer", sourceSeq: Number(ev.seq) || 0 });
      log("walk", "[RTSHADOW] " + JSON.stringify({ ev: "divergence", divergenceType: rec.divergenceType, reason: rec.reason, ref: rec.ref }));
    }
    return s.record("renderer", ev.kind, payload, {
      causeRef: ev.causeRef || null,
      sourceEpoch: Number.isFinite(Number(ev.docEpoch)) ? Number(ev.docEpoch) : null
    });
  };

  /** 会话收尾摘要（PHASE 14：不只 PASS/FAIL——报覆盖/UNKNOWN/停止/机会计数） */
  s.flush = function flush(reason) {
    const ep = evaluator.episode;
    const lastSummary = s.summaries.length ? s.summaries[s.summaries.length - 1] : null;
    const timing = {
      observations: s.ring.length + s.drops,
      drops: s.drops,
      episodesCompleted: evaluator.episodesCompleted,
      episodesStopped: evaluator.episodesStopped,
      sessionWallMs: Math.max(0, nowMs() - s.startedAtMs)
    };
    let openEpisode = null;
    if (ep) {
      openEpisode = { episodeId: ep.id, phase: ep.phase, decisionOpportunities: ep.decisionOpportunities, unknownCount: ep.unknownCount };
    }
    try {
      log("walk", "[RTSHADOW-FLUSH] " + JSON.stringify({
        ev: "session-flush", contractVersion: runContext.contractVersion, runId: runContext.runId,
        closeReason: reason || "unknown",
        inputCoverage: s.inputCoverage,
        divergenceCounts: evaluator.divergenceCounts,
        observationCounts: evaluator.observationCounts,
        openEpisode,
        lastEpisode: lastSummary ? { episodeId: lastSummary.episodeId, completed: lastSummary.completed, stopped: lastSummary.stopped, stopReason: lastSummary.stopReason } : null,
        timing
      }));
    } catch { /* 诊断失败不影响主流程 */ }
  };

  return s;
}

module.exports = { createShadowSession, SESSION_MAX_EVENTS };

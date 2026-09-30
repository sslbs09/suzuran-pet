/**
 * evaluator.js — Shadow Slice v0.1 内核：shadow facts / 相位机 / 结果解释 /
 * divergence 分类 / 比较停止规则 / renderer 替换失效（纯状态机，无 I/O，无 timer）。
 *
 * FREEZE + Blocker Closure：
 * - PHASE 5  内部事实只保留显式字段表；不复制 walk 对象/聊天状态/事件历史。
 * - PHASE 6  相位只处理 stable-sit → stand-up → move → enter-sit → stable-sit。
 * - PHASE 10 Decision: accept/reject/wait-for-evidence；body readiness 是 OBSERVATION ONLY，
 *   不参与控制判断（只允许冻结重启合同要求的 capability 已知性参与）；exit-supported ≠ Body 成功。
 * - PHASE 11 六类合同 divergence + 观察-only MOTION_WITH_BODY_NOT_READY。
 * - PHASE 7  合同 divergence（ADMISSION/RESOURCE_OWNERSHIP/STALE_GEOMETRY/PREMATURE_MOTION）
 *   一旦出现必须立即停止比较：episode 不再推进相位、不得 completed=true；
 *   观察-only 项不停止。停止后 raw 观测继续（ring 有界），旧 result 绝不回填。
 * - PHASE 9  请求/效果分离：只有 outcome==="succeeded" 的写入是 effect candidate；
 *   ok:false / arm / cancel / pre-write 不产生 PREMATURE_MOTION / 所有权分歧 / stale 消费。
 * - 有界性：episode 内 observations/divergences/phaseSequence 全部 ring by construction，
 *   超限保留 dropped 计数。
 * - 确定性：不取墙钟（时间由信封携带）；同输入序列 → 同输出。
 */
"use strict";

const { SHADOW_PHASES } = require("./contract");
const geometry = require("./geometry-snapshot");
const body = require("./body-evidence");
const ownership = require("./motion-ownership");

const DIVERGENCE_TYPES = {
  ADMISSION_DIVERGENCE: "ADMISSION_DIVERGENCE",
  RESOURCE_OWNERSHIP_DIVERGENCE: "RESOURCE_OWNERSHIP_DIVERGENCE",
  STALE_GEOMETRY_CONSUMPTION: "STALE_GEOMETRY_CONSUMPTION",
  PREMATURE_MOTION: "PREMATURE_MOTION",
  MISSING_EVIDENCE: "MISSING_EVIDENCE",
  STALE_RESULT_ACCEPTED: "STALE_RESULT_ACCEPTED"
};

/** 合同 divergence：出现即停止比较（PHASE 7 must stop） */
const CONTRACT_DIVERGENCES = new Set([
  DIVERGENCE_TYPES.ADMISSION_DIVERGENCE,
  DIVERGENCE_TYPES.RESOURCE_OWNERSHIP_DIVERGENCE,
  DIVERGENCE_TYPES.STALE_GEOMETRY_CONSUMPTION,
  DIVERGENCE_TYPES.PREMATURE_MOTION
]);

const OBSERVATION_TYPES = {
  MOTION_WITH_BODY_NOT_READY: "MOTION_WITH_BODY_NOT_READY" // 观察-only，不是合同违规，不停止
};

const STOP_REASONS = {
  PATH_DIVERGENCE: "v1-path-divergence",
  TAKEOVER: "takeover",
  GENERATION_REPLACEMENT: "renderer-body-generation-replaced",
  HOST_CONTEXT_UNLINKABLE: "host-context-unlinkable",
  ENGINE_STOP: "walking-engine-stop",
  DIVERGENCE: "divergence"
};

/** episode 内 ring 上限（by construction，超限保留 dropped 计数） */
const EPISODE_RINGS = {
  divergences: 32,
  observations: 16,
  phaseSequence: 24,
  evidenceRefs: 64
};

function createShadowEvaluator({ runContext } = {}) {
  const ctx = runContext || {};
  return {
    runContext: ctx,
    // —— 内部事实（PHASE 5）——
    lastWalkFacts: null,
    takeover: null,               // {kind} 当前外部占用（drag/chat/zoom/sleep）
    engineActive: null,
    geom: geometry.createGeometrySnapshotState({ geometryPolicyIdentity: ctx.geometryPolicy }),
    body: body.createBodyEvidenceState(),
    episode: null,
    invalidated: null,            // renderer 替换失效标记 {generation, ref}
    // —— 计数（session 级汇总；键有界：固定 taxonomy）——
    processedSeq: { main: 0, renderer: 0 },
    episodesCompleted: 0,
    episodesStopped: 0,
    divergenceCounts: {},
    observationCounts: {},
    closedSummaries: []           // 有界（8）
  };
}

/* ---------------- 事实快照（显式字段表——绝不整体复制 walk 对象） ---------------- */

function walkFactsFromPayload(p) {
  if (!p || typeof p !== "object") return null;
  return {
    active: !!p.active, resting: !!p.resting, seated: !!p.seated, perched: !!p.perched,
    iconRest: !!p.iconRest, iconTarget: !!p.iconTarget, gotoPerch: !!p.gotoPerch,
    returning: !!p.returning, freeStand: !!p.freeStand, sleeping: !!p.sleeping,
    paused: !!p.paused, catToy: !!p.catToy, taskbarHang: !!p.taskbarHang,
    flight: !!p.flight, jump: !!p.jump, edgeLeft: !!p.edgeLeft,
    face: Number.isFinite(Number(p.face)) ? Number(p.face) : null,
    dir: Number.isFinite(Number(p.dir)) ? Number(p.dir) : null,
    standingUpUntil: Number(p.standingUpUntil) || 0,
    sunk: !!p.sunk
  };
}

/** scope 外相位/瞬态（PHASE 12 停止触发） */
function outOfScopeFlag(f) {
  if (!f) return null;
  if (f.perched) return "perched";
  if (f.iconRest || f.iconTarget) return "icon-rest";
  if (f.gotoPerch) return "goto-perch";
  if (f.returning) return "returning";
  if (f.freeStand) return "free-stand";
  if (f.sleeping) return "sleeping";
  if (f.catToy) return "cat-toy";
  if (f.taskbarHang) return "taskbar-hang";
  if (f.flight) return "flight";
  if (f.jump) return "jump";
  if (f.paused) return "paused-takeover"; // drag/chat/zoom 暂停（takeover 事件应已先行；快照兜底）
  return null;
}

/** stable Sit 基线事实（PHASE 12 重启前提之一） */
function inStableSit(f) {
  return !!f && f.active && f.resting && f.seated && !f.paused && !f.sleeping &&
    !f.perched && !f.iconRest && !f.iconTarget && !f.gotoPerch && !f.returning &&
    !f.freeStand && !f.catToy && !f.taskbarHang && !f.flight && !f.jump;
}

/* ---------------- episode 生命周期（全部有界） ---------------- */

function pushBounded(ep, key, item) {
  const cap = EPISODE_RINGS[key];
  const arr = ep[key];
  if (arr.length < cap) arr.push(item);
  else {
    arr.shift();       // 丢最旧
    ep[key + "Dropped"] = (ep[key + "Dropped"] || 0) + 1;
    arr.push(item);
  }
}

function openEpisode(ev, env) {
  const gValid = geometry.geometryValidity(ev.geom).validity;
  const episode = {
    id: "ep-" + ev.processedSeq.main + "-" + ev.processedSeq.renderer,
    openedRef: env ? env.source + "#" + env.sourceSeq : null,
    phase: SHADOW_PHASES.STABLE_SIT,
    phaseSequence: [SHADOW_PHASES.STABLE_SIT],
    completed: false,
    stopped: false,
    stopReason: null,
    evidenceRefs: [],
    coverage: {},
    unknownCount: 0,
    divergences: [], divergencesDropped: 0,
    observations: [], observationsDropped: 0,
    phaseSequenceDropped: 0,
    decisionOpportunities: 0,
    evaluable: 0,
    unknownDecisions: 0,
    admissionSeen: { "stand-up-arm": false, "beat-end": false, "enter-rest-pose": false },
    baselineGeometryValidity: gValid,
    _divMark: 0
  };
  ev.episode = episode;
  return episode;
}

function closeEpisode(ev, env, completed) {
  const ep = ev.episode;
  if (!ep) return null;
  ep.completed = !!completed;
  ep.closedRef = env ? env.source + "#" + env.sourceSeq : null;
  if (completed) ev.episodesCompleted += 1; else ev.episodesStopped += 1;
  const summary = episodeSummary(ev, ep);
  ev.closedSummaries.push(summary);
  if (ev.closedSummaries.length > 8) ev.closedSummaries.shift(); // bounded
  ev.episode = null;
  return summary;
}

function episodeSummary(ev, ep) {
  const divergenceCounts = {};
  for (const d of ep.divergences) divergenceCounts[d.divergenceType] = (divergenceCounts[d.divergenceType] || 0) + 1;
  const observationCounts = {};
  for (const o of ep.observations) observationCounts[o.type] = (observationCounts[o.type] || 0) + 1;
  const coverage = {};
  for (const k of Object.keys(ep.coverage)) coverage[k] = ep.coverage[k]; // 键有界（白名单 kind）
  return {
    ev: "episode-summary",
    contractVersion: ev.runContext.contractVersion || null,
    runId: ev.runContext.runId || null,
    episodeId: ep.id,
    phaseSequence: ep.phaseSequence.slice(0, EPISODE_RINGS.phaseSequence),
    phaseSequenceDropped: ep.phaseSequenceDropped,
    completed: ep.completed,
    stopped: ep.stopped,
    stopReason: ep.stopReason,
    decisionOpportunities: ep.decisionOpportunities,
    evaluable: ep.evaluable,
    unknownDecisions: ep.unknownDecisions,
    unknownCount: ep.unknownCount,
    divergenceCounts,
    divergencesDropped: ep.divergencesDropped,
    observationCounts,
    observationsDropped: ep.observationsDropped,
    inputCoverage: coverage,
    evidenceRefs: ep.evidenceRefs.slice(0, EPISODE_RINGS.evidenceRefs),
    admissionSeen: ep.admissionSeen,
    baselineGeometryValidity: ep.baselineGeometryValidity,
    firstSeq: ep.openedRef,
    lastSeq: ep.closedRef,
    observations: ep.decisionOpportunities + ep.divergences.length + ep.observations.length
  };
}

function addEvidence(ev, ep, env) {
  if (!ep || !env) return;
  const ref = env.source + "#" + env.sourceSeq;
  if (ep.evidenceRefs.length >= EPISODE_RINGS.evidenceRefs) ep.evidenceRefs.shift();
  ep.evidenceRefs.push(ref);
  ep.coverage[env.kind] = (ep.coverage[env.kind] || 0) + 1;
}

/**
 * 记录 divergence；合同 divergence 立即停止比较（PHASE 7）。
 * 停止产生的 summary 经 ev._sink 交给 session 输出。
 */
function addDivergence(ev, ep, type, reason, env) {
  ev.divergenceCounts[type] = (ev.divergenceCounts[type] || 0) + 1;
  const rec = { divergenceType: type, reason, ref: env ? env.source + "#" + env.sourceSeq : null };
  if (ep) pushBounded(ep, "divergences", rec);
  if (CONTRACT_DIVERGENCES.has(type) && ev.episode && !ev.episode.stopped) {
    stopEpisode(ev, STOP_REASONS.DIVERGENCE + ":" + type, env);
  }
  return rec;
}

/* ---------------- 停止与替换 ---------------- */

function stopEpisode(ev, reason, env) {
  const ep = ev.episode;
  if (!ep || ep.stopped) return null;
  ep.stopped = true;
  ep.stopReason = reason;
  const sum = closeEpisode(ev, env, false);
  if (sum && ev._sink) ev._sink.push(sum); // 所有停止路径统一输出摘要（PHASE 14）
  return sum;
}

/** PHASE 13：renderer/body generation 替换 → 全部失效。返回被停 episode 的摘要（如有）。 */
function invalidateForReplacement(ev, generation, env) {
  ev.invalidated = { generation, ref: env ? env.source + "#" + env.sourceSeq : null };
  // geometry measurement-of-record 一并失效（不接受旧几何直接支持新 episode）
  ev.geom.measurement = null;
  ev.geom.lastRejected = null;
  if (ev.episode) return stopEpisode(ev, STOP_REASONS.GENERATION_REPLACEMENT, env);
  return null;
}

/* ---------------- 重启资格（PHASE 12） ---------------- */

function episodeStartEligible(ev, facts) {
  if (ev.takeover) return { ok: false, reason: "takeover-active:" + ev.takeover.kind };
  if (ev.invalidated) {
    // 替换后必须：新 capability（真实 owner commit 之后的重报）+ 新 geometry 测量
    if (!ev.body.capability) return { ok: false, reason: "await-capability-after-replacement" };
    if (geometry.geometryValidity(ev.geom).validity !== "valid") {
      return { ok: false, reason: "await-geometry-after-replacement" };
    }
  }
  if (!ev.body.capability) return { ok: false, reason: "body-capability-unknown" };
  const g = geometry.geometryValidity(ev.geom);
  if (g.validity !== "valid") return { ok: false, reason: "geometry-" + g.validity };
  if (!inStableSit(facts)) return { ok: false, reason: "not-stable-sit" };
  if (ev.engineActive === false) return { ok: false, reason: "engine-off" };
  return { ok: true };
}

/* ---------------- Decision（PHASE 10） ---------------- */

/**
 * 逐相位决策：
 * - reject：本步骤出现 divergence；
 * - wait-for-evidence：geometry 非 valid，或 capability unknown（冻结重启合同要求 capability 已知）；
 *   body readiness（unknown/not-ready）绝不驱动控制判断（OBSERVATION ONLY）；
 * - accept：其余。
 */
function decideForPhase(ev, ep, nextPhase, stepDivergences) {
  ep.decisionOpportunities += 1;
  if (stepDivergences.length) { ep.evaluable += 1; return "reject"; }
  const g = geometry.geometryValidity(ev.geom).validity;
  if (g !== "valid") { ep.unknownDecisions += 1; ep.unknownCount += 1; return "wait-for-evidence"; }
  if (!ev.body.capability) { ep.unknownDecisions += 1; ep.unknownCount += 1; return "wait-for-evidence"; }
  ep.evaluable += 1;
  return "accept";
}

/** 请求/效果分级（PHASE 9）：只有 write-succeeded/host-observed 是 effect candidate */
function evidenceLevelOf(kind, p) {
  if (kind === "rect-write" || kind === "seat-position" || kind === "seat-exit") {
    if (p.outcome === "succeeded") return p.hostRectAfter ? "host-observed" : "write-succeeded";
    if (p.outcome === "failed" || p.outcome === "rejected" || p.outcome === "skipped") return "attempt";
    return "intent"; // arm/cancel/未带 outcome 的控制事实
  }
  return "observation";
}

/** 解释输出（PHASE 10 最小结构） */
function interpretationRecord(ev, ep, phase, decision, env, extra = {}) {
  const g = geometry.geometryValidity(ev.geom);
  const expectedClass = phase === SHADOW_PHASES.STABLE_SIT || phase === SHADOW_PHASES.ENTER_SIT ? "sit"
    : phase === SHADOW_PHASES.MOVE ? "move" : null;
  const r = body.bodyReadiness(ev.body, expectedClass); // 仅观察输出
  const pred = ownership.predictMotionOwnership(phase, { takeoverKind: ev.takeover ? ev.takeover.kind : null });
  const interpretation = ep.stopped ? "interrupted"
    : ep.completed ? "exit-supported"
    : decision === "wait-for-evidence" ? "unknown" : "open";
  return {
    type: "interpretation",
    episodeId: ep ? ep.id : null,
    ref: env ? env.source + "#" + env.sourceSeq : null,
    phase,
    decision,
    motion: { expectedOwner: pred.owner, verbs: pred.verbs, allowedWriters: pred.allowedWriters },
    geometry: { validity: g.validity, reason: g.reason },
    body: { readiness: r.readiness, reason: r.reason },
    interpretation,
    ...extra
  };
}

/* ---------------- 主入口：observe ---------------- */

/**
 * 消费一条信封。返回 {records:[], summaries:[]}。
 * records：interpretation / divergence / observation-note / stop / replacement 行；
 * summaries：关闭的 episode 摘要（session 负责输出）。
 */
function shadowObserve(ev, env) {
  const records = [];
  const summaries = [];
  if (!env) return { records, summaries };
  ev._sink = summaries; // stopEpisode/closeEpisode 的摘要收集
  try {
    observeInner(ev, env, records);
  } finally {
    ev._sink = null;
  }
  return { records, summaries };
}

function observeInner(ev, env, records) {
  ev.processedSeq[env.source] = env.sourceSeq;
  let ep = ev.episode;
  if (ep) addEvidence(ev, ep, env);

  const p = env.payload || {};

  /* —— 几何/body 状态更新（无论是否在 episode 内都推进，供重启资格判断）—— */
  switch (env.kind) {
    case "geom-scale-changed": {
      geometry.noteScaleRequested(ev.geom, p.scale);
      break;
    }
    case "geom-host-changed": {
      const changed = geometry.noteHost(ev.geom, { workArea: p.workArea, displayScaleFactor: p.displayScaleFactor });
      if (changed && ep) {
        stopEpisode(ev, STOP_REASONS.HOST_CONTEXT_UNLINKABLE, env);
        records.push({ type: "stop", reason: STOP_REASONS.HOST_CONTEXT_UNLINKABLE, ref: env.source + "#" + env.sourceSeq });
      }
      break;
    }
    case "geom-report": {
      geometry.noteMeasurement(ev.geom, p, env.receivedAt ? env.receivedAt.dateNow : null);
      break;
    }
    case "body-capability": {
      geometry.noteCapability(ev.geom, p.skinHasSit);
      body.noteCapability(ev.body, p.skinHasSit);
      break;
    }
    case "body-generation": {
      // sourceEpoch（sanitize 提升到信封的 docEpoch）与 payload 合并——身份以信封字段为准
      const gp = {
        docEpoch: env.sourceEpoch !== null && env.sourceEpoch !== undefined ? env.sourceEpoch : p.docEpoch,
        renderGeneration: p.renderGeneration,
        skinId: p.skinId
      };
      const r = body.noteBodyGeneration(ev.body, gp, env.receivedAt ? env.receivedAt.dateNow : null);
      if (r.stale) {
        // 旧代晚到：不更新身份、不失效任何东西；只记 stale 证据
        records.push({ type: "stale-evidence", reason: "late-body-generation-older-than-current", ref: env.source + "#" + env.sourceSeq });
        break;
      }
      // 依赖身份推进（唯一来源：真实 owner commit；测量 provenance 不回写）
      geometry.noteDocGeneration(ev.geom, gp);
      if (r.replaced) {
        invalidateForReplacement(ev, { docEpoch: gp.docEpoch, renderGeneration: gp.renderGeneration }, env);
        records.push({ type: "replacement", from: r.previous, to: ev.body.generation, ref: env.source + "#" + env.sourceSeq });
      }
      break;
    }
    case "anim-entry": {
      body.noteAnimEntry(ev.body, p, env.receivedAt ? env.receivedAt.dateNow : null);
      break;
    }
    case "fit-handoff": {
      body.noteFitHandoff(ev.body, p, env.receivedAt ? env.receivedAt.dateNow : null);
      break;
    }
    case "boundary-replacement": {
      invalidateForReplacement(ev, ev.body.generation, env);
      records.push({ type: "replacement", kind: p.kind || "renderer-replacement", ref: env.source + "#" + env.sourceSeq });
      break;
    }
    case "takeover": {
      const kind = typeof p.kind === "string" ? p.kind : "unknown";
      if (p.on) {
        ev.takeover = { kind };
        if (ep) {
          records.push({ type: "stop", reason: STOP_REASONS.TAKEOVER + ":" + kind, ref: env.source + "#" + env.sourceSeq });
          stopEpisode(ev, STOP_REASONS.TAKEOVER + ":" + kind, env);
        }
      } else if (ev.takeover && ev.takeover.kind === kind) {
        ev.takeover = null;
      }
      break;
    }
    case "boundary-takeover": {
      // headpat 等瞬时动画接管：只停止当前 episode（无对应 off 事件，不得留下永久占用标记）
      if (ep) {
        records.push({ type: "stop", reason: STOP_REASONS.TAKEOVER + ":" + (p.kind || "headpat"), ref: env.source + "#" + env.sourceSeq });
        stopEpisode(ev, STOP_REASONS.TAKEOVER + ":" + (p.kind || "headpat"), env);
      }
      break;
    }
    case "engine": {
      ev.engineActive = !!p.on;
      if (!p.on && ep) {
        records.push({ type: "stop", reason: STOP_REASONS.ENGINE_STOP, ref: env.source + "#" + env.sourceSeq });
        stopEpisode(ev, STOP_REASONS.ENGINE_STOP, env);
      }
      break;
    }
    default:
      break;
  }

  ep = ev.episode; // 上面可能已关闭

  /* —— 写入类事件：request/effect 分级；只有 write-succeeded 是 effect candidate —— */
  if (env.kind === "rect-write" || env.kind === "seat-position" || env.kind === "seat-exit") {
    const via = String(p.via || (env.kind === "seat-position" ? "seat" : env.kind === "seat-exit" ? "seat-exit-y" : "unknown"));
    const level = evidenceLevelOf(env.kind, p);
    const isEffect = level === "write-succeeded" || level === "host-observed";
    const write = { via, translate: !!p.translate };
    if (ep && !ep.stopped && isEffect) {
      // effect candidate 才参与所有权 / premature / stale 消费判定（PHASE 9）
      const phase = ep.phase;
      const pred = ownership.predictMotionOwnership(phase, { takeoverKind: ev.takeover ? ev.takeover.kind : null });
      const violation = ownership.ownershipViolation(pred, write);
      if (violation) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, violation.type, violation.reason, env) });
      } else if (via === "seat" || via === "seat-exit-y" || via === "walkTick") {
        // 成功提交的、依赖 groundGap snapshot 的定位效果 vs 当前 snapshot 效力
        const g = geometry.geometryValidity(ev.geom);
        if (g.validity !== "valid" && g.reason !== "no-measurement") {
          records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.STALE_GEOMETRY_CONSUMPTION, g.reason, env) });
        }
      }
      if (ev.episode && !ev.episode.stopped && write.translate && phase === SHADOW_PHASES.MOVE) {
        const r = body.bodyReadiness(ev.body, "move");
        if (r.readiness === "not-ready") { // 观察-only：不停止、不改生产
          ev.observationCounts[OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY] =
            (ev.observationCounts[OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY] || 0) + 1;
          pushBounded(ev.episode, "observations", { type: OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY, ref: env.source + "#" + env.sourceSeq });
          records.push({ type: "observation-note", noteType: OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY, ref: env.source + "#" + env.sourceSeq });
        }
      }
      if (ev.episode && !ev.episode.stopped) {
        ev.episode.decisionOpportunities += 1;
        ev.episode.evaluable += 1;
      }
    }
    return;
  }

  /* —— 控制事实：phase-end / broadcast 快照 + 显式相位事件 —— */
  if (env.kind === "phase-end" || env.kind === "broadcast") {
    const f = walkFactsFromPayload(env.kind === "broadcast" ? p : p.walk);
    if (f) {
      ev.lastWalkFacts = f;
      applySnapshotFacts(ev, f, env, records);
    }
    return;
  }
  if (env.kind === "behavior-selected") {
    if (ep && !ep.stopped) {
      if (p.behavior === "perch") {
        records.push({ type: "stop", reason: STOP_REASONS.PATH_DIVERGENCE + ":perch-selected", ref: env.source + "#" + env.sourceSeq });
        stopEpisode(ev, STOP_REASONS.PATH_DIVERGENCE + ":perch-selected", env);
      }
    }
    return;
  }
  if (env.kind === "stand-up-arm") {
    if (ep && !ep.stopped) {
      if (ep.phase !== SHADOW_PHASES.STABLE_SIT) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "stand-up-arm-out-of-phase:" + ep.phase, env) });
      }
      if (ev.episode && !ev.episode.stopped) {
        transitionPhase(ev, ep, SHADOW_PHASES.STAND_UP, records, env);
        ep.admissionSeen["stand-up-arm"] = true;
      }
    }
    return;
  }
  if (env.kind === "beat-end") {
    if (ep && !ep.stopped) {
      if (ep.phase !== SHADOW_PHASES.STAND_UP) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "beat-end-out-of-phase:" + ep.phase, env) });
      }
      if (ev.episode && !ev.episode.stopped) {
        transitionPhase(ev, ep, SHADOW_PHASES.MOVE, records, env);
        ep.admissionSeen["beat-end"] = true;
      }
    }
    return;
  }
  if (env.kind === "enter-rest-pose") {
    if (ep && !ep.stopped) {
      if (ep.phase === SHADOW_PHASES.MOVE) {
        transitionPhase(ev, ep, SHADOW_PHASES.ENTER_SIT, records, env);
        ep.admissionSeen["enter-rest-pose"] = true;
      } else if (ep.phase !== SHADOW_PHASES.STABLE_SIT) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "enter-rest-pose-out-of-phase:" + ep.phase, env) });
      }
      // stable-sit 下的 enter-rest-pose = V1 重申坐姿：不换相位，只记证据
    }
    return;
  }
}

function transitionPhase(ev, ep, nextPhase, records, env) {
  if (ep.phase === nextPhase) return;
  ep.phase = nextPhase;
  pushBounded(ep, "phaseSequence", nextPhase);
  // 本次转移前累计的 divergence 数 → 决策是否 reject（转移后清零基准）
  const stepDivergences = ep.divergences.length - (ep._divMark || 0);
  ep._divMark = ep.divergences.length;
  const decision = decideForPhase(ev, ep, nextPhase, stepDivergences > 0 ? ["step"] : []);
  records.push(interpretationRecord(ev, ep, nextPhase, decision, env, { phaseTransition: true, newDivergences: stepDivergences }));
}

/**
 * 快照事实驱动的相位推进（V1 真实状态对表；事件缺失时给出 ADMISSION_DIVERGENCE，
 * 合同 divergence 由此立即停止比较）。
 */
function applySnapshotFacts(ev, f, env, records) {
  let ep = ev.episode;

  // scope 外瞬态 → 停止比较（PHASE 12）
  if (ep && !ep.stopped) {
    const flag = outOfScopeFlag(f);
    if (flag) {
      records.push({ type: "stop", reason: STOP_REASONS.PATH_DIVERGENCE + ":" + flag, ref: env.source + "#" + env.sourceSeq });
      stopEpisode(ev, STOP_REASONS.PATH_DIVERGENCE + ":" + flag, env);
      return;
    }
    if (!f.active) {
      records.push({ type: "stop", reason: STOP_REASONS.ENGINE_STOP, ref: env.source + "#" + env.sourceSeq });
      stopEpisode(ev, STOP_REASONS.ENGINE_STOP, env);
      return;
    }
  }

  const stable = inStableSit(f);
  const moving = f.active && !f.resting && !f.seated && !f.paused && !f.sleeping;
  const standingUp = f.active && f.resting && !f.seated && Number(f.standingUpUntil) > 0;

  if (!ep) {
    // PHASE 12 重启前提全部满足 → 建立新可比 episode（stable Sit 基线）
    const elig = episodeStartEligible(ev, f);
    if (stable && elig.ok) {
      ep = openEpisode(ev, env);
      ev.invalidated = null; // 新基线建立：替换失效标记解除
      addEvidence(ev, ep, env); // 开启事件本身也是 episode 证据（基线快照）
      records.push(interpretationRecord(ev, ep, ep.phase, decideForPhase(ev, ep, ep.phase, []), env, { episodeOpened: true }));
    }
    return;
  }

  if (ep.stopped) return;

  // 相位对表
  if (standingUp && ep.phase === SHADOW_PHASES.STABLE_SIT) {
    // 快照先于 arm 事件到达（同帧 IPC 序不确定）：先补相位；arm 事件随后到达时 admissionSeen 会置位
    transitionPhase(ev, ep, SHADOW_PHASES.STAND_UP, records, env);
  } else if (standingUp && ep.phase !== SHADOW_PHASES.STAND_UP && ep.phase !== SHADOW_PHASES.STABLE_SIT) {
    records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "standing-up-snapshot-out-of-phase:" + ep.phase, env) });
    if (ev.episode && !ev.episode.stopped) transitionPhase(ev, ep, SHADOW_PHASES.STAND_UP, records, env);
  } else if (moving && ep.phase === SHADOW_PHASES.STABLE_SIT) {
    // 坐姿直接进 move：跳过 stand-up（V1 旧路径或事件缺失）
    if (ev.runContext.standBeatEnabled !== false) {
      records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "stable-sit-to-move-without-stand-beat", env) });
    }
    if (ev.episode && !ev.episode.stopped) transitionPhase(ev, ep, SHADOW_PHASES.MOVE, records, env);
  } else if (moving && ep.phase === SHADOW_PHASES.STAND_UP) {
    // beat-end 事件缺失，快照已显示开走
    records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "move-without-beat-end", env) });
    if (ev.episode && !ev.episode.stopped) transitionPhase(ev, ep, SHADOW_PHASES.MOVE, records, env);
  } else if (stable && ep.phase === SHADOW_PHASES.ENTER_SIT) {
    // 一个完整 cycle 落回 stable Sit → 完成
    transitionPhase(ev, ep, SHADOW_PHASES.STABLE_SIT, records, env);
    const summary = closeEpisode(ev, env, true);
    if (summary) ev._sink.push(summary);
    records.push(interpretationRecord(ev, ep, SHADOW_PHASES.STABLE_SIT, decideForPhase(ev, ep, SHADOW_PHASES.STABLE_SIT, []), env, { cycleCompleted: true }));
    records.push({ type: "complete", episodeId: ep.id, summary });
  } else if (stable && ep.phase === SHADOW_PHASES.MOVE) {
    // move 快照直接显示 stable-sit（enter-rest-pose 事件缺失 / 手动 sit 命令）
    if (!ep.admissionSeen["enter-rest-pose"]) {
      records.push({ type: "stop", reason: STOP_REASONS.PATH_DIVERGENCE + ":sit-without-enter-rest-pose", ref: env.source + "#" + env.sourceSeq });
      stopEpisode(ev, STOP_REASONS.PATH_DIVERGENCE + ":sit-without-enter-rest-pose", env);
      return;
    }
    transitionPhase(ev, ep, SHADOW_PHASES.ENTER_SIT, records, env);
    if (ev.episode && !ev.episode.stopped) {
      transitionPhase(ev, ep, SHADOW_PHASES.STABLE_SIT, records, env);
      const summary = closeEpisode(ev, env, true);
      if (summary) ev._sink.push(summary);
      records.push(interpretationRecord(ev, ep, SHADOW_PHASES.STABLE_SIT, decideForPhase(ev, ep, SHADOW_PHASES.STABLE_SIT, []), env, { cycleCompleted: true }));
      records.push({ type: "complete", episodeId: ep.id, summary });
    }
  }
}

/* ---------------- STALE_RESULT_ACCEPTED（PHASE 11/12） ---------------- */

/**
 * 失效后旧代证据到达：只记录，绝不解释为 Shadow 未执行路径的成功。
 * 由 session 在 renderer 证据带旧 epoch 时显式调用。
 */
function noteStaleResult(ev, env) {
  const ep = ev.episode;
  return { type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.STALE_RESULT_ACCEPTED, "evidence-from-invalidated-generation", env) };
}

module.exports = {
  DIVERGENCE_TYPES,
  CONTRACT_DIVERGENCES,
  OBSERVATION_TYPES,
  STOP_REASONS,
  EPISODE_RINGS,
  createShadowEvaluator,
  shadowObserve,
  noteStaleResult,
  walkFactsFromPayload,
  inStableSit,
  episodeSummary,
  evidenceLevelOf
};

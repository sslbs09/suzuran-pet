/**
 * evaluator.js — Shadow Slice v0.1 内核：shadow facts / 相位机 / 结果解释 /
 * divergence 分类 / 比较停止规则 / renderer 替换失效（纯状态机，无 I/O，无 timer）。
 *
 * FREEZE 对应：
 * - PHASE 5  内部事实只保留：观测上下文、可比 episode/相位、执行关联、最新证据引用、
 *            比较位置/停止原因/已处理 source seq。不复制 walk 对象/聊天状态/事件历史/长期状态；
 *            expected motion owner、geometry validity、body readiness、admission 解释全部派生。
 * - PHASE 6  相位只处理 stable-sit → stand-up → move → enter-sit → stable-sit；scope 外事件结束可比 episode。
 * - PHASE 10 Decision: accept/reject/wait-for-evidence；Interpretation: open/exit-supported/interrupted/unknown。
 *            exit-supported ≠ 完整 Body 动作成功。
 * - PHASE 11 divergence 首版六类 + 观察-only 的 MOTION_WITH_BODY_NOT_READY。
 * - PHASE 12 停止规则：停止后继续记 raw 观测，但不得回填成 Shadow 未执行路径的成功；
 *            重启必须 scope 合法 + stable Sit + capability 已知 + geometry valid + 无外部占用。
 * - PHASE 13 renderer/body generation 替换：旧 attempt/ownership 预测/geometry 测量/body 本地执行全部
 *            INVALIDATE；保留原 accepted goal/source 仅用于解释；等待新 capability/geometry 后重建 stable Sit 基线。
 *
 * 确定性：不取墙钟（observedAt 由信封携带，来自注入时钟）；同输入序列 → 同输出。
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

const OBSERVATION_TYPES = {
  MOTION_WITH_BODY_NOT_READY: "MOTION_WITH_BODY_NOT_READY" // 观察项，不是合同违规
};

const STOP_REASONS = {
  PATH_DIVERGENCE: "v1-path-divergence",
  TAKEOVER: "takeover",
  GENERATION_REPLACEMENT: "renderer-body-generation-replaced",
  HOST_CONTEXT_UNLINKABLE: "host-context-unlinkable",
  ENGINE_STOP: "walking-engine-stop"
};

const EVIDENCE_REFS_MAX = 64;
const COVERAGE_KINDS_MAX = 40;

/** 相位序列期望（可比 episode 的合法推进） */
const CYCLE = [SHADOW_PHASES.STABLE_SIT, SHADOW_PHASES.STAND_UP, SHADOW_PHASES.MOVE, SHADOW_PHASES.ENTER_SIT];

function createShadowEvaluator({ runContext } = {}) {
  const ctx = runContext || {};
  const ev = {
    runContext: ctx,
    // —— 内部事实（PHASE 5）——
    lastWalkFacts: null,          // 最近一次 V1 控制事实快照（显式字段表，非 walk 对象拷贝）
    lastWorkArea: null,
    takeover: null,               // {kind} 当前外部占用（drag/chat/zoom/sleep/headpat）
    engineActive: null,           // null=未知
    geom: geometry.createGeometrySnapshotState({ geometryPolicyIdentity: ctx.geometryPolicy }),
    body: body.createBodyEvidenceState(),
    episode: null,
    invalidated: null,            // renderer 替换失效标记 {generation, ref}
    // —— 计数（session 级汇总用）——
    processedSeq: { main: 0, renderer: 0 },
    drops: 0,                     // 无法归类的写入等「看了但不判」计数
    episodesCompleted: 0,
    episodesStopped: 0,
    divergenceCounts: {},
    observationCounts: {},
    closedSummaries: []           // 已关闭 episode 的摘要（bounded）
  };
  return ev;
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

/* ---------------- episode 生命周期 ---------------- */

function openEpisode(ev, ref) {
  const gValid = geometry.geometryValidity(ev.geom).validity;
  const episode = {
    id: "ep-" + ev.processedSeq.main + "-" + ev.processedSeq.renderer,
    openedRef: ref,
    phase: SHADOW_PHASES.STABLE_SIT,
    phaseSequence: [SHADOW_PHASES.STABLE_SIT],
    openedAt: ref ? { mainSeq: ref.sourceSeq } : null,
    completed: false,
    stopped: false,
    stopReason: null,
    evidenceRefs: [],
    coverage: {},
    unknownCount: 0,
    divergences: [],
    observations: [],             // MOTION_WITH_BODY_NOT_READY 等观察项
    decisionOpportunities: 0,
    evaluable: 0,
    unknownDecisions: 0,
    admissionSeen: { "stand-up-arm": false, "beat-end": false, "enter-rest-pose": false },
    anchorWrites: 0,              // enter-sit 以来观察到的 seat 锚定写入数
    transitionSinceEnterSit: false,
    baselineGeometryValidity: gValid
  };
  ev.episode = episode;
  return episode;
}

function closeEpisode(ev, ref, completed) {
  const ep = ev.episode;
  if (!ep) return null;
  ep.completed = !!completed;
  ep.closedRef = ref ? { mainSeq: ref.sourceSeq, rendererSeq: ref.sourceSeq } : null;
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
  for (const [k, v] of Object.entries(ep.coverage).slice(0, COVERAGE_KINDS_MAX)) coverage[k] = v;
  return {
    ev: "episode-summary",
    contractVersion: ev.runContext.contractVersion || null,
    runId: ev.runContext.runId || null,
    episodeId: ep.id,
    phaseSequence: ep.phaseSequence.slice(0, 12),
    completed: ep.completed,
    stopped: ep.stopped,
    stopReason: ep.stopReason,
    decisionOpportunities: ep.decisionOpportunities,
    evaluable: ep.evaluable,
    unknownDecisions: ep.unknownDecisions,
    unknownCount: ep.unknownCount,
    divergenceCounts,
    observationCounts,
    inputCoverage: coverage,
    evidenceRefs: ep.evidenceRefs.slice(0, EVIDENCE_REFS_MAX),
    admissionSeen: ep.admissionSeen,
    baselineGeometryValidity: ep.baselineGeometryValidity,
    firstSeq: ep.openedRef ? ep.openedRef.sourceSeq : null,
    lastSeq: ep.closedRef ? ep.closedRef.mainSeq : null,
    observations: ep.decisionOpportunities + ep.divergences.length + ep.observations.length
  };
}

function addEvidence(ev, ep, env) {
  if (!ep || !env) return;
  const ref = env.source + "#" + env.sourceSeq;
  ep.evidenceRefs.push(ref);
  if (ep.evidenceRefs.length > EVIDENCE_REFS_MAX) ep.evidenceRefs.shift();
  ep.coverage[env.kind] = (ep.coverage[env.kind] || 0) + 1;
}

function addDivergence(ev, ep, type, reason, env) {
  ev.divergenceCounts[type] = (ev.divergenceCounts[type] || 0) + 1;
  const rec = { divergenceType: type, reason, ref: env ? env.source + "#" + env.sourceSeq : null };
  if (ep) ep.divergences.push(rec);
  return rec;
}

/* ---------------- 停止与替换 ---------------- */

function stopEpisode(ev, reason, env) {
  const ep = ev.episode;
  if (!ep || ep.stopped) return null;
  ep.stopped = true;
  ep.stopReason = reason;
  return closeEpisode(ev, env, false);
}

/** PHASE 13：renderer/body generation 替换 → 全部失效。返回被停 episode 的摘要（如有）。 */
function invalidateForReplacement(ev, generation, env) {
  ev.invalidated = { generation, ref: env ? env.source + "#" + env.sourceSeq : null };
  if (ev.episode) return stopEpisode(ev, STOP_REASONS.GENERATION_REPLACEMENT, env);
  return null;
}

/* ---------------- 重启资格（PHASE 12） ---------------- */

function episodeStartEligible(ev, facts) {
  if (ev.takeover) return { ok: false, reason: "takeover-active:" + ev.takeover.kind };
  if (ev.invalidated && !ev.body.capability) return { ok: false, reason: "await-capability-after-replacement" };
  if (ev.invalidated && geometry.geometryValidity(ev.geom).validity !== "valid") {
    return { ok: false, reason: "await-geometry-after-replacement" };
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
 * 逐相位决策。decision 只回答「本步骤的证据是否支持解释」：
 * - reject：本步骤出现 divergence；
 * - wait-for-evidence：关键证据未知（geometry 非 valid / body unknown）；
 * - accept：证据齐备且一致。
 */
function decideForPhase(ev, ep, phase, stepDivergences) {
  ep.decisionOpportunities += 1;
  if (stepDivergences.length) { ep.evaluable += 1; return "reject"; }
  const g = geometry.geometryValidity(ev.geom).validity;
  const expectedClass = phase === SHADOW_PHASES.STABLE_SIT || phase === SHADOW_PHASES.ENTER_SIT ? "sit"
    : phase === SHADOW_PHASES.MOVE ? "move" : null;
  const readiness = body.bodyReadiness(ev.body, expectedClass);
  if (g !== "valid") { ep.unknownDecisions += 1; ep.unknownCount += 1; return "wait-for-evidence"; }
  if (readiness.readiness === "unknown") { ep.unknownDecisions += 1; ep.unknownCount += 1; return "wait-for-evidence"; }
  ep.evaluable += 1;
  return "accept";
}

/** 解释输出（PHASE 10 最小结构） */
function interpretationRecord(ev, ep, phase, decision, env, extra = {}) {
  const g = geometry.geometryValidity(ev.geom);
  const expectedClass = phase === SHADOW_PHASES.STABLE_SIT || phase === SHADOW_PHASES.ENTER_SIT ? "sit"
    : phase === SHADOW_PHASES.MOVE ? "move" : null;
  const r = body.bodyReadiness(ev.body, expectedClass);
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
 * 消费一条信封。返回 {records:[], summary: episodeSummary|null}。
 * records：interpretation / divergence / observation-note 行（session 负责输出）。
 */
function shadowObserve(ev, env) {
  const records = [];
  let summaryOut = null;
  const stopped = (reason) => { // stopEpisode + summary 收集（PHASE 14：停止 episode 也要输出摘要）
    const sum = stopEpisode(ev, reason, env);
    if (sum) summaryOut = sum;
    return sum;
  };
  if (!env) return { records, summary: null };
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
        stopped(STOP_REASONS.HOST_CONTEXT_UNLINKABLE);
        records.push({ type: "stop", reason: STOP_REASONS.HOST_CONTEXT_UNLINKABLE, ref: env.source + "#" + env.sourceSeq });
      }
      break;
    }
    case "geom-report": {
      geometry.noteMeasurement(ev.geom, p, env.observedAt ? env.observedAt.dateNow : null);
      break;
    }
    case "body-capability": {
      geometry.noteCapability(ev.geom, p.skinHasSit);
      body.noteCapability(ev.body, p.skinHasSit);
      break;
    }
    case "body-generation": {
      const r = body.noteBodyGeneration(ev.body, p, env.observedAt ? env.observedAt.dateNow : null);
      // 依赖身份推进（唯一来源：renderer commit；测量 provenance 不回写）
      geometry.noteDocGeneration(ev.geom, p);
      if (r.replaced) {
        const sum = invalidateForReplacement(ev, { docEpoch: p.docEpoch, renderGeneration: p.renderGeneration }, env);
        if (sum) summaryOut = sum;
        records.push({ type: "replacement", from: r.previous, to: ev.body.generation, ref: env.source + "#" + env.sourceSeq });
      }
      break;
    }
    case "anim-applied": {
      body.noteAnimApplied(ev.body, p, env.observedAt ? env.observedAt.dateNow : null);
      break;
    }
    case "fit-handoff": {
      body.noteFitHandoff(ev.body, p, env.observedAt ? env.observedAt.dateNow : null);
      break;
    }
    case "boundary-replacement": {
      const sumRep = invalidateForReplacement(ev, ev.body.generation, env);
      if (sumRep) summaryOut = sumRep;
      records.push({ type: "replacement", kind: p.kind || "renderer-replacement", ref: env.source + "#" + env.sourceSeq });
      break;
    }
    case "takeover": {
      const kind = String(p.kind || "unknown");
      if (p.on) {
        ev.takeover = { kind };
        if (ep) {
          records.push({ type: "stop", reason: STOP_REASONS.TAKEOVER + ":" + kind, ref: env.source + "#" + env.sourceSeq });
          stopped(STOP_REASONS.TAKEOVER + ":" + kind);
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
        stopped(STOP_REASONS.TAKEOVER + ":" + (p.kind || "headpat"));
      }
      break;
    }
    case "engine": {
      ev.engineActive = !!p.on;
      if (!p.on && ep) {
        records.push({ type: "stop", reason: STOP_REASONS.ENGINE_STOP, ref: env.source + "#" + env.sourceSeq });
        stopped(STOP_REASONS.ENGINE_STOP);
      }
      break;
    }
    default:
      break;
  }

  ep = ev.episode; // 上面可能已关闭

  /* —— rect-write：所有权 / stale 几何消费 / body 观察 —— */
  if (env.kind === "rect-write" || env.kind === "seat-position" || env.kind === "seat-exit") {
    const via = String(p.via || (env.kind === "seat-position" ? "seat" : env.kind === "seat-exit" ? "seat-exit-y" : "unknown"));
    const write = { via, translate: !!p.translate };
    if (ep && !ep.stopped) {
      const phase = ep.phase;
      const pred = ownership.predictMotionOwnership(phase, { takeoverKind: ev.takeover ? ev.takeover.kind : null });
      const violation = ownership.ownershipViolation(pred, write);
      if (violation) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, violation.type, violation.reason, env) });
      }
      // stale geometry 消费：锚定/位移类写入推进了基于 groundGap 的定位，但依赖已失效
      if (violation === null && (via === "seat" || via === "seat-exit-y" || via === "walkTick")) {
        const g = geometry.geometryValidity(ev.geom);
        if (g.validity !== "valid" && g.reason !== "no-measurement") {
          records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.STALE_GEOMETRY_CONSUMPTION, g.reason, env) });
        }
      }
      // 观察-only：move 相位位移但 body 明确 not-ready
      if (write.translate && phase === SHADOW_PHASES.MOVE) {
        const r = body.bodyReadiness(ev.body, "move");
        if (r.readiness === "not-ready") {
          ev.observationCounts[OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY] =
            (ev.observationCounts[OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY] || 0) + 1;
          ep.observations.push({ type: OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY, ref: env.source + "#" + env.sourceSeq });
          records.push({ type: "observation-note", noteType: OBSERVATION_TYPES.MOTION_WITH_BODY_NOT_READY, ref: env.source + "#" + env.sourceSeq });
        }
      }
      if (via === "seat") ep.anchorWrites += 1;
      ep.decisionOpportunities += 1;
      ep.evaluable += 1;
    }
    return { records, summary: summaryOut };
  }

  /* —— 控制事实：phase-end / broadcast 快照 + 显式相位事件 —— */
  if (env.kind === "phase-end" || env.kind === "broadcast") {
    const f = walkFactsFromPayload(env.kind === "broadcast" ? p : p.walk);
    if (f) {
      ev.lastWalkFacts = f;
      if (f.workArea) ev.lastWorkArea = f.workArea;
      const res = applySnapshotFacts(ev, f, env, records);
      if (res && res.summary) return { records, summary: res.summary };
    }
    return { records, summary: summaryOut };
  }
  if (env.kind === "behavior-selected") {
    if (ep && !ep.stopped) {
      ep.coverage["behavior-selected"] = (ep.coverage["behavior-selected"] || 0) + 1;
      if (p.behavior === "perch") {
        records.push({ type: "stop", reason: STOP_REASONS.PATH_DIVERGENCE + ":perch-selected", ref: env.source + "#" + env.sourceSeq });
        stopped(STOP_REASONS.PATH_DIVERGENCE + ":perch-selected");
      }
    }
    return { records, summary: summaryOut };
  }
  if (env.kind === "stand-up-arm") {
    if (ep && !ep.stopped) {
      if (ep.phase !== SHADOW_PHASES.STABLE_SIT) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "stand-up-arm-out-of-phase:" + ep.phase, env) });
      }
      transitionPhase(ev, ep, SHADOW_PHASES.STAND_UP, records, env);
      ep.admissionSeen["stand-up-arm"] = true;
    }
    return { records, summary: summaryOut };
  }
  if (env.kind === "beat-end") {
    if (ep && !ep.stopped) {
      if (ep.phase !== SHADOW_PHASES.STAND_UP) {
        records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "beat-end-out-of-phase:" + ep.phase, env) });
      }
      transitionPhase(ev, ep, SHADOW_PHASES.MOVE, records, env);
      ep.admissionSeen["beat-end"] = true;
    }
    return { records, summary: summaryOut };
  }
  if (env.kind === "enter-rest-pose") {
    if (ep && !ep.stopped) {
      if (ep.phase === SHADOW_PHASES.MOVE) {
        transitionPhase(ev, ep, SHADOW_PHASES.ENTER_SIT, records, env);
        ep.admissionSeen["enter-rest-pose"] = true;
      } else if (ep.phase === SHADOW_PHASES.STABLE_SIT) {
        // V1 重申坐姿（idle 行为路径）：不换相位，只记证据
        ep.admissionSeen["enter-rest-pose"] = ep.admissionSeen["enter-rest-pose"] || false;
      } else {
        records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "enter-rest-pose-out-of-phase:" + ep.phase, env) });
      }
    }
    return { records, summary: summaryOut };
  }
  return { records, summary: summaryOut };
}

function transitionPhase(ev, ep, nextPhase, records, env) {
  if (ep.phase === nextPhase) return;
  ep.phase = nextPhase;
  ep.phaseSequence.push(nextPhase);
  // 本次转移前累计的 divergence 数 → 决策是否 reject（转移后清零基准）
  const stepDivergences = ep.divergences.length - (ep._divMark || 0);
  ep._divMark = ep.divergences.length;
  const decision = decideForPhase(ev, ep, nextPhase, stepDivergences > 0 ? ["step"] : []);
  records.push(interpretationRecord(ev, ep, nextPhase, decision, env, { phaseTransition: true, newDivergences: stepDivergences }));
}

/**
 * 快照事实驱动的相位推进（V1 真实状态对表；事件缺失时给出 ADMISSION_DIVERGENCE）。
 */
function applySnapshotFacts(ev, f, env, records) {
  let ep = ev.episode;

  // scope 外瞬态 → 停止比较（PHASE 12）
  if (ep && !ep.stopped) {
    const flag = outOfScopeFlag(f);
    if (flag) {
      const sum = stopEpisode(ev, STOP_REASONS.PATH_DIVERGENCE + ":" + flag, env);
      records.push({ type: "stop", reason: STOP_REASONS.PATH_DIVERGENCE + ":" + flag, ref: env.source + "#" + env.sourceSeq });
      return { summary: sum || null };
    }
    if (!f.active) {
      const sum = stopEpisode(ev, STOP_REASONS.ENGINE_STOP, env);
      records.push({ type: "stop", reason: STOP_REASONS.ENGINE_STOP, ref: env.source + "#" + env.sourceSeq });
      return { summary: sum || null };
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
      ep.invalidatedCleared = true;
      ev.invalidated = null; // 新基线建立：替换失效标记解除
      addEvidence(ev, ep, env); // 开启事件本身也是 episode 证据（基线快照）
      records.push(interpretationRecord(ev, ep, ep.phase, decideForPhase(ev, ep, ep.phase, []), env, { episodeOpened: true }));
    }
    return { summary: null };
  }

  if (ep.stopped) return { summary: null };

  // 相位对表
  if (standingUp && ep.phase === SHADOW_PHASES.STABLE_SIT) {
    // 快照先于 arm 事件到达（同帧 IPC 序不确定）：先补相位；arm 事件随后到达时 admissionSeen 会置位
    transitionPhase(ev, ep, SHADOW_PHASES.STAND_UP, records, env);
  } else if (standingUp && ep.phase !== SHADOW_PHASES.STAND_UP && ep.phase !== SHADOW_PHASES.STABLE_SIT) {
    records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "standing-up-snapshot-out-of-phase:" + ep.phase, env) });
    transitionPhase(ev, ep, SHADOW_PHASES.STAND_UP, records, env);
  } else if (moving && ep.phase === SHADOW_PHASES.STABLE_SIT) {
    // 坐姿直接进 move：跳过 stand-up（V1 旧路径或事件缺失）
    if (ev.runContext.standBeatEnabled !== false) {
      records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "stable-sit-to-move-without-stand-beat", env) });
    }
    transitionPhase(ev, ep, SHADOW_PHASES.MOVE, records, env);
  } else if (moving && ep.phase === SHADOW_PHASES.STAND_UP) {
    // beat-end 事件缺失，快照已显示开走
    records.push({ type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.ADMISSION_DIVERGENCE, "move-without-beat-end", env) });
    transitionPhase(ev, ep, SHADOW_PHASES.MOVE, records, env);
  } else if (stable && ep.phase === SHADOW_PHASES.ENTER_SIT) {
    // 一个完整 cycle 落回 stable Sit → 完成
    transitionPhase(ev, ep, SHADOW_PHASES.STABLE_SIT, records, env);
    const summary = closeEpisode(ev, env, true);
    records.push({ type: "complete", episodeId: ep.id, summary });
    return { summary };
  } else if (stable && ep.phase === SHADOW_PHASES.MOVE) {
    // move 快照直接显示 stable-sit（enter-rest-pose 事件缺失 / 手动 sit 命令）
    if (!ep.admissionSeen["enter-rest-pose"]) {
      const sum = stopEpisode(ev, STOP_REASONS.PATH_DIVERGENCE + ":sit-without-enter-rest-pose", env);
      records.push({ type: "stop", reason: STOP_REASONS.PATH_DIVERGENCE + ":sit-without-enter-rest-pose", ref: env.source + "#" + env.sourceSeq });
      return { summary: sum || null };
    }
    transitionPhase(ev, ep, SHADOW_PHASES.ENTER_SIT, records, env);
    transitionPhase(ev, ep, SHADOW_PHASES.STABLE_SIT, records, env);
    const summary = closeEpisode(ev, env, true);
    records.push({ type: "complete", episodeId: ep.id, summary });
    return { summary };
  }
  return { summary: null };
}

/* ---------------- STALE_RESULT_ACCEPTED（PHASE 11/12） ---------------- */

/**
 * 失效后旧代证据到达：只记录，绝不解释为 Shadow 未执行路径的成功。
 * 由 session 在 observe 之外显式调用（renderer 事件带旧 generation 时）。
 */
function noteStaleResult(ev, env) {
  const ep = ev.episode;
  const rec = { type: "divergence", ...addDivergence(ev, ep, DIVERGENCE_TYPES.STALE_RESULT_ACCEPTED, "evidence-from-invalidated-generation", env) };
  return rec;
}

module.exports = {
  DIVERGENCE_TYPES,
  OBSERVATION_TYPES,
  STOP_REASONS,
  CYCLE,
  createShadowEvaluator,
  shadowObserve,
  noteStaleResult,
  walkFactsFromPayload,
  inStableSit,
  episodeSummary
};

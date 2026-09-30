/**
 * locomotion-controller.js — Runtime v2 locomotion episode 控制器（production，tick 驱动）。
 *
 * 真实接管：Stable Sit → StandUp → Move → EnterSit → Stable Sit。
 * 高层行为选择（何时散步/走多久/方向）仍来自 V1（§2）；一旦 beginEpisode 被接受，
 * 本 episode 的 phase authority / motion ownership / native position commit /
 * geometry dependency / episode closure 全部归 V2——V1 不得同时推进同一 episode。
 *
 * 设计边界：
 * - 纯状态机 + 注入依赖，无 Electron 引用；由 main.js 的既有 tick cadence 驱动（零新增 timer）；
 * - 视觉/时间政策原样复用：stand-beat 时长、seatExit Y 线性轨迹、WALK_SPEED、clamp/边界数学
 *   全部由 deps 注入的现函数提供——本轮改 ownership，不调动画手感（§6）；
 * - 不重抽随机数：direction/moveMs 由 V1 传入（§5/L）；
 * - Body readiness observation-only：不等待“动画完成”才允许 Move（§6）；
 * - 所有 position 写入必须经 window-commit（§8）；
 * - 左缘特殊触边（edgeLeft 气泡模式切换区）保守 fallback V1（§3：不为覆盖率强行进入 V2）；
 * - interrupt/close 后 token/episode 立即失效：旧 callback 再入被 commit 与 authority 双重拒绝
 *   （§11/§12 不实现 durable resume，replacement 后旧 episode 永不恢复）。
 */
"use strict";

const PHASES = {
  STABLE_SIT: "stable-sit",   // 基线（episode 起点；不是 V2 持有期）
  STAND_UP: "stand-up",
  MOVE: "move",
  ENTER_SIT: "enter-sit",
  INTERRUPTED: "interrupted",
  CLOSED: "closed"
};

const EPISODE_RINGS = { maxHoldTicksDefault: 8 };

/**
 * @param config {authority, commit, deps, hooks}
 *  deps: {
 *    now(), bounds(), workArea(), clampX(x, wa, width)→{x,minX,maxX,collapsed},
 *    speed(), groundGap(), seatSink(), skinHasSit(),
 *    standBaseY(b, wa)→number（与 applySeatPosition 的 baseY 同式，注入现函数）,
 *    face()→number（walk.face 投影只读）,
 *    geometryUsable()→{usable:boolean, reason},
 *    geometryDependency()→{value, identity}|null（commit 记录的几何依赖证据）,
 *    bodyIdentity()→{docEpoch,renderGeneration}|null,
 *    policies:{standBeatMs, seatExitMs}, enterSitHoldTicks?
 *  }
 *  hooks: {
 *    setProjection(patch), broadcast(options?), scheduleLegacySit(), resumeLegacy(reason),
 *    log(ev,msg), noteEvent(ev)
 *  }
 */
function createLocomotionController(config) {
  const { authority, commit, deps, hooks } = config;
  const stats = {
    episodesAcquired: 0, episodesCompleted: 0, episodesInterrupted: 0,
    commits: 0, commitDenied: 0, interruptReasons: {}, outOfScopeFallbacks: {}
  };
  let episode = null;   // 当前持有 episode；null = 不持有
  let episodeSeq = 0;

  function owns() {
    return !!episode && episode.phase !== PHASES.CLOSED && episode.phase !== PHASES.INTERRUPTED;
  }

  function seatExitOffset(nowMs) {
    const sx = episode && episode.seatExit;
    if (!sx) return 0;
    const p = (nowMs - sx.startTs) / sx.durationMs;
    if (p >= 1) { episode.seatExit = null; return 0; }
    return sx.fromOffsetY * (1 - p);
  }

  /** begin：V1 在 behavior=walk（seated）处调用。acquisition 前 main 已跑 canEnterSlice。 */
  function beginEpisode(input) {
    if (!input || !Number.isFinite(input.dir) || !Number.isFinite(input.moveMs)) {
      return { ok: false, reason: "bad-input" };
    }
    episodeSeq += 1;
    const episodeId = "v2-ep-" + episodeSeq + "-" + (input.attemptSeed || 0);
    const acq = authority.acquire(episodeId);
    if (!acq.ok) return { ok: false, reason: acq.reason };
    const b = deps.bounds();
    const wa = deps.workArea();
    if (!b || !wa) { authority.release("deps-unavailable"); return { ok: false, reason: "deps-unavailable" }; }
    // fromOffsetY = 实际 Y − live 站立目标线（与 V1 armSeatExit 同式：arm 本身零位移，不硬编码 sink）
    const liveBase = deps.standBaseY(b, wa);
    const fromOffsetY = b.y - liveBase;
    episode = {
      id: episodeId,
      attemptId: acq.attemptId,
      token: acq.token,
      phase: PHASES.STAND_UP,
      dir: input.dir > 0 ? 1 : -1,
      moveMs: Math.max(1000, Math.floor(input.moveMs)),
      startAt: deps.now(),
      beatEndAt: deps.now() + deps.policies.standBeatMs,
      seatExit: Math.abs(fromOffsetY) > 0.5 ? { startTs: deps.now(), durationMs: deps.policies.seatExitMs, fromOffsetY } : null,
      moveStartAt: null,
      enterSitHoldTicks: 0,
      bodyIdentity: deps.bodyIdentity(),
      geometryAtBegin: deps.geometryUsable(),
      lastProjection: {}
    };
    stats.episodesAcquired += 1;
    // 投影（§14：V1 字段此时仅作 compatibility/read projection，由 V2 单一写入）：
    // seated=false、resting=true、standingUpUntil 镜像 beat deadline（兼容 forensic/渲染 watcher 读取）。
    hooks.setProjection({ seated: false, resting: true, sunk: false, dir: episode.dir, standingUpUntil: episode.beatEndAt });
    // V1 同帧广播语义（stand-beat pose intent 由 main 的 beginStandBroadcast 复刻现有策略）
    hooks.beginStandBroadcast();
    noteEvent({ ev: "episode-begin", episodeId, dir: episode.dir, moveMs: episode.moveMs });
    return { ok: true, episodeId, token: acq.token };
  }

  /** tick：仅当 owns 时被 main 的 walkTick 调用（V1 locomotion 块由此整体旁路）。 */
  function tick() {
    if (!owns()) return;
    const ep = episode;
    const nowMs = deps.now();
    try {
      switch (ep.phase) {
        case PHASES.STAND_UP: stepStandUp(nowMs); break;
        case PHASES.MOVE: stepMove(nowMs); break;
        case PHASES.ENTER_SIT: stepEnterSit(nowMs); break;
        default: break;
      }
    } catch (e) {
      // 控制器任何异常 → 安全交回 V1（V1 状态投影已实时同步，不会撕裂）
      interrupt("controller-fault:" + String((e && e.message) || e).slice(0, 60));
    }
  }

  function stepStandUp(nowMs) {
    const ep = episode;
    // seatExit Y 过渡：与 V1 seatExitStep 同 eps 规则（常规 |Δ|>1 写，到期 |Δ|>0.01 精确落终值）
    const b = deps.bounds(); const wa = deps.workArea();
    if (b && wa) {
      const baseY = deps.standBaseY(b, wa);
      const offset = seatExitOffset(nowMs);
      const y = Math.round(baseY + offset);
      const complete = !episode.seatExit;
      const eps = complete ? 0.01 : 1;
      if (Math.abs(b.y - y) > eps) {
        commitY("standup-y", b.x, baseY + offset, { episode, geometry: geometryDep(), needHostRect: false });
      }
    }
    if (nowMs >= ep.beatEndAt) {
      ep.phase = PHASES.MOVE;
      ep.moveStartAt = nowMs;
      // 投影：开走（与 V1 beat-end 拍一致：resting=false + 广播同帧）
      hooks.setProjection({ resting: false, standingUpUntil: 0 });
      noteEvent({ ev: "phase-move", episodeId: ep.id, beatDeadline: ep.beatEndAt }); // admission 先行（Shadow 因果序），广播随后
      hooks.broadcast();
      faceForDir();
    }
  }

  function stepMove(nowMs) {
    const ep = episode;
    const b = deps.bounds(); const wa = deps.workArea();
    if (!b || !wa) { interrupt("deps-unavailable-during-move"); return; }
    if (nowMs >= ep.moveStartAt + ep.moveMs) {
      ep.phase = PHASES.ENTER_SIT;
      ep.enterSitHoldTicks = 0;
      // 投影：到点坐下（与 V1 walkOnPhaseEnd else 分支同帧语义：enterRestPose 先行）
      enterSitProjection();
      noteEvent({ ev: "phase-enter-sit", episodeId: ep.id }); // ENTER_SIT admission 先行（Shadow 因果序），广播随后
      hooks.broadcast();
      stepEnterSit(nowMs); // 立即尝试一次锚定（V1 也是同帧 anchor）
      return;
    }
    const r = deps.clampX(b.x, wa, b.width);
    if (r.collapsed) { interrupt("range-collapsed-fallback"); return; } // 尺寸恢复属 out-of-scope → V1
    const speed = deps.speed();
    let nx = r.x + ep.dir * speed;
    if (nx <= r.minX) {
      // 左缘到达：V1 的 edgeLeft 气泡模式/翻边属特殊触边（out-of-scope）→ 交回 V1
      interrupt("left-edge-special-fallback");
      return;
    }
    if (nx >= r.maxX) {
      ep.dir *= -1;
      nx = r.maxX;
      hooks.setProjection({ dir: ep.dir });
      faceForDir(); // 折返：立即用新方向同步朝向（V1 同源规则）
    } else {
      faceForDir();
    }
    // 与 V1 movement 同式：y = live groundY + 瞬态 seatExit offset（过渡期逐拍 live）
    const baseY = deps.standBaseY(b, wa);
    const y = baseY + seatExitOffset(nowMs);
    commitY("move", nx, y, { episode: ep, geometry: geometryDep() });
  }

  function enterSitProjection() {
    const hasSit = deps.skinHasSit();
    // 与 V1 enterRestPose 一致：有 Sit 动画坐下沉，否则站立歇脚（seated=false 不骗渲染层）
    hooks.setProjection({ resting: true, seated: hasSit, sunk: hasSit, standingUpUntil: 0 });
  }

  function stepEnterSit(nowMs) {
    const ep = episode;
    if (!ep || ep.phase !== PHASES.ENTER_SIT) return;
    const gu = deps.geometryUsable();
    if (!gu.usable) {
      // §10：geometry stale/insufficient 不得拿旧 gap 假装 fresh。有界 hold → 安全 fallback。
      ep.enterSitHoldTicks += 1;
      if (ep.enterSitHoldTicks > (deps.enterSitHoldTicks || EPISODE_RINGS.maxHoldTicksDefault)) {
        interrupt("geometry-unusable-fallback");
        stats.outOfScopeFallbacks["geometry-unusable"] = (stats.outOfScopeFallbacks["geometry-unusable"] || 0) + 1;
      }
      return; // hold：等下一次 onGeometryAccepted 解锁，下一 tick 重锚
    }
    const b = deps.bounds(); const wa = deps.workArea();
    if (!b || !wa) { interrupt("deps-unavailable-at-anchor"); return; }
    // 与 V1 effectiveSeatSink 一致：皮肤有 Sit 才下沉，否则站锚
    const finalSink = deps.skinHasSit() ? deps.seatSink() : 0;
    const y = deps.standBaseY(b, wa) + finalSink;
    const res = commitY("enter-sit", b.x, y, { episode: ep, geometry: geometryDep(), needHostRect: true });
    if (!res || !res.ok) {
      // 写被拒（ownership 已失效等）→ 安全退出，不再重试夺权
      if (res && res.reason === "stale-or-not-owner") { forceRelease("stale-at-anchor"); }
      else interrupt("anchor-write-failed");
      return;
    }
    closeEpisode("cycle-complete");
  }

  function commitY(kind, x, y, ctx) {
    if (!episode) return { ok: false, reason: "no-episode", outcome: "denied" };
    const res = commit.commitPosition({
      token: episode.token, episodeId: episode.id, attemptId: episode.attemptId,
      kind, x, y, geometry: ctx.geometry || null, needHostRect: !!ctx.needHostRect
    });
    if (res.ok) { stats.commits += 1; episode.lastCommitted = { kind, x: res.x, y: res.y, outcome: res.outcome, hostRectAfter: res.hostRectAfter || null }; }
    else stats.commitDenied += 1;
    if (res.ok === false && res.reason === "stale-or-not-owner") {
      noteEvent({ ev: "commit-denied-stale", kind, episodeId: ctx && ctx.episode && ctx.episode.id });
    }
    return res;
  }

  function geometryDep() {
    return deps.geometryDependency ? deps.geometryDependency() : null;
  }

  function faceForDir() {
    const want = episode.dir > 0 ? 1 : -1;
    const cur = deps.face();
    if (cur !== want) {
      // face 防抖由 main 注入的投影写实现（与 V1 walkUpdateFace 同 150ms 规则）
      hooks.setFace(want);
    }
  }

  /** 外部事件：新 geometry 被 main 接受（pet:set-ground-gap accepted 后调用）。 */
  function onGeometryAccepted(identity) {
    if (!owns()) return;
    const cur = deps.bodyIdentity();
    if (episode.bodyIdentity && cur &&
        (cur.docEpoch !== episode.bodyIdentity.docEpoch || cur.renderGeneration !== episode.bodyIdentity.renderGeneration)) {
      interrupt("body-replacement");
      return;
    }
    episode.bodyIdentity = cur;
    if (episode.phase === PHASES.ENTER_SIT && deps.geometryUsable().usable) {
      stepEnterSit(deps.now()); // hold 期间新几何到位 → 立即重锚
    }
  }

  /** 中断/关闭：释放 ownership；旧 token 立即失效（stale callback 永远对不上）。 */
  function interrupt(reason) {
    if (!episode) return null;
    const result = closeEpisode("interrupted:" + reason);
    if (result) {
      stats.outOfScopeFallbacks[reason] = (stats.outOfScopeFallbacks[reason] || 0) + 1;
      try { hooks.resumeLegacy(reason); } catch { /* 交回 V1 的钩子故障不阻断释放 */ }
    }
    return result;
  }

  function forceRelease(reason) {
    closeEpisode("released:" + reason);
  }

  function closeEpisode(reason) {
    if (!episode) return null;
    const ep = episode;
    const wasCompleted = reason === "cycle-complete";
    if (wasCompleted) { ep.phase = PHASES.CLOSED; stats.episodesCompleted += 1; }
    else ep.phase = PHASES.INTERRUPTED;
    if (!wasCompleted) stats.episodesInterrupted += 1;
    stats.interruptReasons[reason] = (stats.interruptReasons[reason] || 0) + 1;
    const summary = { episodeId: ep.id, attemptId: ep.attemptId, reason, completed: wasCompleted, commits: ep.lastCommitted || null };
    authority.release(reason);
    episode = null;
    noteEvent({ ev: "episode-close", ...summary });
    if (wasCompleted) {
      try { hooks.scheduleLegacySit(); } catch { /* 交回 V1 调度故障不阻断 */ }
    }
    return summary;
  }

  function noteEvent(ev) {
    try { if (typeof hooks.noteEvent === "function") hooks.noteEvent(ev); } catch { /* 诊断故障隔离 */ }
  }

  return {
    PHASES,
    owns,
    episodeId() { return episode ? episode.id : null; },
    phase() { return episode ? episode.phase : null; },
    beginEpisode,
    tick,
    interrupt,
    onGeometryAccepted,
    stats: () => Object.assign({}, stats, { authority: authority.snapshot() })
  };
}

module.exports = { createLocomotionController, PHASES };

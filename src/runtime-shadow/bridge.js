/**
 * bridge.js — 主进程只读 Observation Bridge（FREEZE PHASE 4 + Blocker Closure）。
 *
 * 故障隔离（G1）：每个观察方法体 = active 短路 + 单一 guarded 边界——
 * Shadow 内任何异常（payload 构造 / session.record / evaluator / 日志）都被桥捕获、
 * 经 session.noteFault 有界聚合，绝不传播进生产函数（不改变返回值 / 异常路径 / 后续逻辑 /
 * callback ordering / 窗口写入结果）。生产 hook 站点保持一行直呼，无 per-site 包装。
 * OFF（session=null）：方法首行短路，零构造、零闭包、零成本。
 *
 * 请求/效果分离（G9）：
 * - rect-write：outcome ∈ succeeded（写入系统调用成功）/ failed（写入抛错）/ rejected（守卫拦截，未尝试写入）；
 *   succeeded 时读一次 host rect 作为 HOST_OBSERVED_EFFECT 观测（仅 gate ON）；
 * - seat-position：outcome ∈ succeeded / skipped（无需写）/ failed——在 native write 之后上报；
 * - seat-exit：arm/cancel=INTENT（无 outcome）；step/step-complete 带 outcome。
 */
"use strict";

/** 位移类写入标签（walkSetPosition 的 where 参数） */
const TRANSLATE_WRITERS = new Set(["walkTick", "walk-approach", "cat-toy", "jump-ease", "jump-perch-sink", "v2-move"]);

/**
 * @param {Object} args
 *  - session: createShadowSession 结果（main 侧 gate OFF 时为 null）
 *  - deps: 只读取值器集合（全部必须是纯读取，禁止副作用；仅在 gate ON 且有事件时被调用）
 */
function createShadowBridge({ session, deps } = {}) {
  const s = session;
  const d = deps || {};
  const active = () => !!(s && s.active);
  const read = (fn) => { try { return fn ? fn() : null; } catch { return null; } };

  /** 单一故障边界：构造 payload + 落 session 的整个过程被捕获，故障聚合进 session.faults */
  function guarded(op, fn) {
    if (!active()) return null;
    try {
      return fn();
    } catch (e) {
      try { if (s && typeof s.noteFault === "function") s.noteFault(op, e); } catch { /* 绝不外抛 */ }
      return null;
    }
  }

  const bridge = {
    active,

    /** walkBroadcast 关联 meta（null=OFF/故障；绝不 throw——在生产 payload 构造路径上被调用） */
    broadcastMeta() {
      if (!active()) return null;
      try {
        return s.broadcastMeta();
      } catch (e) {
        try { if (s && typeof s.noteFault === "function") s.noteFault("broadcast-meta", e); } catch { /* 绝不外抛 */ }
        return null;
      }
    },

    /** walkBroadcast payload 快照（meta.seq 为预分配 seq） */
    obsBroadcast(payload, meta) {
      if (!meta) return;
      guarded("broadcast", () => s.record("main", "broadcast", payload, { seq: meta.seq }));
    },

    /** walkOnPhaseEnd 入口控制事实快照 */
    obsPhaseEnd() {
      if (!active()) return;
      guarded("phase-end", () => s.record("main", "phase-end", { walk: bridge.walkSnapshot() }));
    },

    /** behaviorOf 结果（绝不重抽随机数——只记录 V1 已选择的行为） */
    obsBehaviorSelected(behavior) {
      if (!active()) return;
      guarded("behavior-selected", () => {
        const w = read(d.walk);
        return s.record("main", "behavior-selected", {
          behavior: String(behavior || ""),
          seated: !!(w && w.seated), resting: !!(w && w.resting)
        });
      });
    },

    /** stand-beat 入口（INTENT——不是位移） */
    obsStandUpArm() {
      if (!active()) return;
      guarded("stand-up-arm", () => {
        const w = read(d.walk);
        return s.record("main", "stand-up-arm", {
          standingUpUntil: w ? (Number(w.standingUpUntil) || 0) : 0,
          dir: w ? w.dir : null
        });
      });
    },

    /** walkTick 消费 stand-beat 拍 */
    obsBeatEnd(beatDeadline) {
      if (!active()) return;
      guarded("beat-end", () => s.record("main", "beat-end", { beatDeadline: Number(beatDeadline) || 0 }));
    },

    /** enterRestPose：ENTER_SIT 触发 */
    obsEnterRestPose() {
      if (!active()) return;
      guarded("enter-rest-pose", () => {
        const w = read(d.walk);
        return s.record("main", "enter-rest-pose", { seated: !!(w && w.seated) });
      });
    },

    /**
     * walkSetPosition（统一收敛写入口）——ATTEMPT/WRITE_SUCCEEDED/WRITE_FAILED/REJECTED 分级。
     * outcome: "succeeded" | "failed" | "rejected"（守卫拦截=未尝试写入）。
     * succeeded 时读取一次 host rect（HOST_OBSERVED_EFFECT 观测；仅 gate ON）。
     */
    obsRectWrite(where, x, y, outcome) {
      if (!active()) return;
      guarded("rect-write", () => {
        const via = String(where || "unknown");
        const oc = outcome === "succeeded" || outcome === "failed" || outcome === "rejected" ? outcome : "failed";
        const hostRectAfter = oc === "succeeded" ? read(d.bounds) : null;
        return s.record("main", "rect-write", {
          via, x: Number(x), y: Number(y), outcome: oc,
          hostRectAfter: hostRectAfter && Number.isFinite(hostRectAfter.x) ? { x: hostRectAfter.x, y: hostRectAfter.y, width: hostRectAfter.width, height: hostRectAfter.height } : null,
          translate: TRANSLATE_WRITERS.has(via)
        });
      });
    },

    /** applySeatPosition：坐姿锚定——native write 之后上报（outcome 区分 skipped/succeeded/failed） */
    obsSeatPosition(o = {}) {
      if (!active()) return;
      guarded("seat-position", () => {
        const oc = o.outcome === "succeeded" || o.outcome === "failed" || o.outcome === "skipped" ? o.outcome : "skipped";
        const hostRectAfter = oc === "succeeded" ? read(d.bounds) : null;
        return s.record("main", "seat-position", {
          via: "seat",
          x: Number.isFinite(Number(o.x)) ? Number(o.x) : null,
          yBefore: Number.isFinite(Number(o.yBefore)) ? Number(o.yBefore) : null,
          targetY: Number.isFinite(Number(o.targetY)) ? Number(o.targetY) : null,
          outcome: oc,
          hostRectAfter: hostRectAfter && Number.isFinite(hostRectAfter.x) ? { x: hostRectAfter.x, y: hostRectAfter.y, width: hostRectAfter.width, height: hostRectAfter.height } : null,
          seated: !!o.seated,
          sink: Number.isFinite(Number(o.sink)) ? Number(o.sink) : null,
          groundGap: Number.isFinite(Number(o.groundGap)) ? Number(o.groundGap) : null
        });
      });
    },

    /**
     * seatExit Y 过渡机事件。event: arm/cancel=INTENT（无 outcome）；step/step-complete=写尝试
     * （outcome: succeeded/failed/skipped）。arm/cancel 绝不被当作位移。
     */
    obsSeatExit(event, o = {}) {
      if (!active()) return;
      guarded("seat-exit", () => {
        const evName = String(event || "");
        const isWrite = evName === "step" || evName === "step-complete";
        const oc = isWrite && (o.outcome === "succeeded" || o.outcome === "failed" || o.outcome === "skipped") ? o.outcome : undefined;
        const hostRectAfter = oc === "succeeded" ? read(d.bounds) : null;
        return s.record("main", "seat-exit", {
          via: "seat-exit-y",
          event: evName,
          ...(oc ? { outcome: oc, hostRectAfter: hostRectAfter && Number.isFinite(hostRectAfter.x) ? { x: hostRectAfter.x, y: hostRectAfter.y, width: hostRectAfter.width, height: hostRectAfter.height } : null } : {}),
          reason: o.reason || null,
          source: o.source || null,
          fromOffsetY: Number.isFinite(Number(o.fromOffsetY)) ? Number(o.fromOffsetY) : null,
          complete: !!o.complete
        });
      });
    },

    /**
     * pet:set-ground-gap 决策结果。payload = 采样时 provenance（meta + renderer shadowGeom）
     * + receive-time host observation（hostAtReceive，显式分离）。
     */
    obsGroundGapReport({ px, meta, decision } = {}) {
      if (!active()) return;
      guarded("geom-report", () => {
        const geom = meta && typeof meta === "object" ? meta.shadowGeom : null;
        return s.record("main", "geom-report", {
          px: Number(px),
          meta: {
            sourceMode: meta && meta.sourceMode || null,
            renderGeneration: meta && meta.renderGeneration != null ? meta.renderGeneration : null,
            docEpoch: meta && meta.docEpoch != null ? meta.docEpoch : null,
            geometryRevision: meta && meta.geometryRevision != null ? meta.geometryRevision : null
          },
          decision: {
            accepted: !!(decision && decision.accepted),
            value: decision && decision.accepted ? decision.value : null,
            stale: !!(decision && decision.stale),
            staleDoc: !!(decision && decision.staleDoc),
            reason: decision && decision.reason ? String(decision.reason) : null
          },
          // renderer 采样时 provenance（缺失=null，绝不补贴；来源证明不了 → insufficient）
          shadowGeom: geom && typeof geom === "object" ? {
            scaleApplied: geom.scaleApplied != null && Number.isFinite(Number(geom.scaleApplied)) ? Number(geom.scaleApplied) : null,
            viewport: geom.viewport && Number.isFinite(Number(geom.viewport.width)) ? { width: Number(geom.viewport.width), height: Number(geom.viewport.height) } : null,
            layoutBasis: typeof geom.layoutBasis === "string" ? geom.layoutBasis : null,
            seq: geom.seq != null ? geom.seq : null,
            scaleEpoch: geom.scaleEpoch != null ? geom.scaleEpoch : null,
            sampledAt: geom.sampledAt && typeof geom.sampledAt === "object" ? geom.sampledAt : null
          } : null,
          // main 接收时独立 host 观测（显式 receive-time，绝不伪装成 renderer provenance）
          hostAtReceive: {
            scaleRequested: read(d.scaleRequested),
            workArea: read(d.workArea),
            displayScaleFactor: read(d.displayScaleFactor),
            seatSink: read(d.seatSink),
            standSinkOffset: read(d.standSink),
            sinkTier: read(d.sinkTier)
          }
        });
      });
    },

    /** pet:set-has-sit：body capability */
    obsHasSit(v) {
      if (!active()) return;
      guarded("body-capability", () => s.record("main", "body-capability", { skinHasSit: !!v }));
    },

    /** setScale：requested scale 换代 */
    obsScaleChanged(scale) {
      if (!active()) return;
      guarded("geom-scale-changed", () => s.record("main", "geom-scale-changed", { scale: Number(scale) }));
    },

    /** display metrics / workArea 变化（receive-time host observation） */
    obsHostChanged(reason) {
      if (!active()) return;
      guarded("geom-host-changed", () => s.record("main", "geom-host-changed", {
        reason: String(reason || ""),
        workArea: read(d.workArea),
        displayScaleFactor: read(d.displayScaleFactor)
      }));
    },

    /** drag/chat/zoom/sleep 接管意图 */
    obsTakeover(kind, on) {
      if (!active()) return;
      guarded("takeover", () => s.record("main", "takeover", { kind: String(kind || "unknown"), on: !!on }));
    },

    /** 行走引擎启停 */
    obsEngine(on) {
      if (!active()) return;
      guarded("engine", () => s.record("main", "engine", { on: !!on }));
    },

    /** 渲染层证据上行（pet:shadow-evidence；sender 校验在 main handler，sanitize 在 session） */
    obsRendererEvidence(ev) {
      if (!active()) return;
      guarded("renderer-evidence", () => s.observeRendererEvidence(ev));
    },

    /** 显式字段表提取（绝不整体复制 walk 对象——PHASE 5 内部事实纪律） */
    walkSnapshot() {
      const w = read(d.walk);
      if (!w || typeof w !== "object") return null;
      return {
        active: !!w.active, resting: !!w.resting, seated: !!w.seated, perched: !!w.perched,
        iconRest: !!w.iconRest, iconTarget: !!w.iconTarget, gotoPerch: !!w.gotoPerch,
        returning: !!w.returning, freeStand: !!w.freeStand, sleeping: !!w.sleeping,
        paused: !!w.paused, catToy: !!w.catToy, taskbarHang: !!w.taskbarHang,
        flight: !!w.flight, jump: !!w.jump, edgeLeft: !!w.edgeLeft,
        face: Number.isFinite(Number(w.face)) ? Number(w.face) : null,
        dir: Number.isFinite(Number(w.dir)) ? Number(w.dir) : null,
        standingUpUntil: Number(w.standingUpUntil) || 0,
        sunk: !!w.sunk
      };
    }
  };
  return bridge;
}

module.exports = { createShadowBridge, TRANSLATE_WRITERS };

/**
 * bridge.js — 主进程只读 Observation Bridge（FREEZE PHASE 4）。
 *
 * 从现有生产路径「旁路」采集：behavior selection / V1 control facts / actual effects /
 * Host observations / Body 能力 / 边界事件。铁律：
 * - 每个观察方法第一行 `if (!session.active) return`——gate OFF 时零 session、零 log、零额外行为；
 * - 方法体只做「读注入 deps + 组装 payload + session.record」——绝不写 walk/window/config，
 *   不推进 timer/phase，不重抽随机数，不调用任何有副作用的写入口；
 * - Geometry dependency gap 补充：geom-report 采样时以同拍注入的 deps 组装只读依赖元数据
 *   （scaleRequested/workArea/displayScaleFactor/seatSink/standSinkOffset/sinkTier），
 *   renderer 侧证据（scaleApplied/viewport/layoutBasis）由 meta.shadowGeom 携带；
 *   来源证明不了的（meta 缺 renderGeneration）由 geometry-snapshot 判 insufficient，绝不补贴。
 */
"use strict";

/** 位移类写入标签（walkSetPosition 的 where 参数） */
const TRANSLATE_WRITERS = new Set(["walkTick", "walk-approach", "cat-toy", "jump-ease", "jump-perch-sink"]);

/**
 * @param {Object} args
 *  - session: createShadowSession 结果（stub 亦兼容：active=false 全短路）
 *  - deps: 只读取值器集合（全部必须是纯读取，禁止副作用）
 *      walk()            → 生产 walk 状态对象（只读字段表提取）
 *      bounds()          → win.getBounds() 或 null
 *      workArea()        → walkGeo.workAreaOf(screen, bounds) 或 null
 *      displayScaleFactor() → number 或 null
 *      scaleRequested()  → clampScale(config.window.scale)
 *      seatSink()        → effectiveSeatSink()
 *      standSink()       → standSinkOffset()
 *      sinkTier()        → seatSinkTier()
 *      skinHasSit()      → boolean
 */
function createShadowBridge({ session, deps } = {}) {
  const s = session;
  const d = deps || {};
  const active = () => !!(s && s.active);
  const read = (fn) => { try { return fn ? fn() : null; } catch { return null; } };

  const bridge = {
    active,

    /** walkBroadcast 关联 meta（null=OFF，payload 零差异） */
    broadcastMeta() {
      if (!active()) return null;
      return s.broadcastMeta();
    },

    /** walkBroadcast payload 快照（meta.seq 为预分配 seq） */
    obsBroadcast(payload, meta) {
      if (!active() || !meta) return;
      s.record("main", "broadcast", payload, { seq: meta.seq });
    },

    /** walkOnPhaseEnd 入口控制事实快照 */
    obsPhaseEnd() {
      if (!active()) return;
      s.record("main", "phase-end", { walk: bridge.walkSnapshot() });
    },

    /** behaviorOf 结果（绝不重抽随机数——只记录 V1 已选择的行为） */
    obsBehaviorSelected(behavior) {
      if (!active()) return;
      const w = read(d.walk);
      s.record("main", "behavior-selected", {
        behavior: String(behavior || ""),
        seated: !!(w && w.seated), resting: !!(w && w.resting)
      });
    },

    /** stand-beat 入口 */
    obsStandUpArm(extra = {}) {
      if (!active()) return;
      const w = read(d.walk);
      s.record("main", "stand-up-arm", {
        standingUpUntil: w ? (Number(w.standingUpUntil) || 0) : 0,
        dir: w ? w.dir : null,
        fromOffsetY: Number.isFinite(Number(extra.fromOffsetY)) ? Number(extra.fromOffsetY) : null
      });
    },

    /** walkTick 消费 stand-beat 拍 */
    obsBeatEnd(beatDeadline) {
      if (!active()) return;
      s.record("main", "beat-end", { beatDeadline: Number(beatDeadline) || 0 });
    },

    /** enterRestPose：ENTER_SIT 触发 */
    obsEnterRestPose() {
      if (!active()) return;
      const w = read(d.walk);
      s.record("main", "enter-rest-pose", { seated: !!(w && w.seated) });
    },

    /** walkSetPosition（统一收敛写入口）实际效果观察 */
    obsRectWrite(where, x, y, ok) {
      if (!active()) return;
      const via = String(where || "unknown");
      s.record("main", "rect-write", {
        via, x: Number(x), y: Number(y), ok: !!ok,
        translate: TRANSLATE_WRITERS.has(via)
      });
    },

    /** applySeatPosition：坐姿锚定计算+写入观察 */
    obsSeatPosition(o = {}) {
      if (!active()) return;
      s.record("main", "seat-position", {
        via: "seat",
        x: Number.isFinite(Number(o.x)) ? Number(o.x) : null,
        yBefore: Number.isFinite(Number(o.yBefore)) ? Number(o.yBefore) : null,
        targetY: Number.isFinite(Number(o.targetY)) ? Number(o.targetY) : null,
        wrote: !!o.wrote,
        seated: !!o.seated,
        sink: Number.isFinite(Number(o.sink)) ? Number(o.sink) : null,
        groundGap: Number.isFinite(Number(o.groundGap)) ? Number(o.groundGap) : null
      });
    },

    /** seatExit Y 过渡机事件（arm/cancel/step/step-complete） */
    obsSeatExit(event, o = {}) {
      if (!active()) return;
      s.record("main", "seat-exit", {
        via: "seat-exit-y",
        event: String(event || ""),
        reason: o.reason || null,
        source: o.source || null,
        fromOffsetY: Number.isFinite(Number(o.fromOffsetY)) ? Number(o.fromOffsetY) : null,
        complete: !!o.complete
      });
    },

    /** pet:set-ground-gap 决策结果 + 依赖元数据同拍补充 */
    obsGroundGapReport({ px, meta, decision } = {}) {
      if (!active()) return;
      const wa = read(d.workArea);
      const shadowGeom = meta && typeof meta === "object" ? meta.shadowGeom : null;
      s.record("main", "geom-report", {
        px: Number(px),
        meta: {
          sourceMode: meta && meta.sourceMode || null,
          renderGeneration: meta && Number.isFinite(Number(meta.renderGeneration)) ? Number(meta.renderGeneration) : null,
          docEpoch: meta && Number.isFinite(Number(meta.docEpoch)) ? Number(meta.docEpoch) : null,
          geometryRevision: meta && Number.isFinite(Number(meta.geometryRevision)) ? Number(meta.geometryRevision) : null
        },
        decision: {
          accepted: !!(decision && decision.accepted),
          value: decision && decision.accepted ? decision.value : null,
          stale: !!(decision && decision.stale),
          staleDoc: !!(decision && decision.staleDoc),
          reason: decision && decision.reason ? String(decision.reason) : null
        },
        supplement: {
          // renderer 同拍证据（shadowGeom 只在 gate ON 时存在；缺失=null，绝不补贴）
          scaleApplied: shadowGeom && Number.isFinite(Number(shadowGeom.scaleApplied)) ? Number(shadowGeom.scaleApplied) : null,
          viewport: shadowGeom && shadowGeom.viewport ? shadowGeom.viewport : null,
          layoutBasis: shadowGeom && shadowGeom.layoutBasis ? String(shadowGeom.layoutBasis) : null,
          // main 侧同拍 host/config 补充
          scaleRequested: read(d.scaleRequested),
          workArea: wa,
          displayScaleFactor: read(d.displayScaleFactor),
          seatSink: read(d.seatSink),
          standSinkOffset: read(d.standSink),
          sinkTier: read(d.sinkTier)
        }
      });
    },

    /** pet:set-has-sit：body capability */
    obsHasSit(v) {
      if (!active()) return;
      s.record("main", "body-capability", { skinHasSit: !!v });
    },

    /** setScale：requested scale 换代 */
    obsScaleChanged(scale) {
      if (!active()) return;
      s.record("main", "geom-scale-changed", { scale: Number(scale) });
    },

    /** display metrics / workArea 变化 */
    obsHostChanged(reason) {
      if (!active()) return;
      s.record("main", "geom-host-changed", {
        reason: String(reason || ""),
        workArea: read(d.workArea),
        displayScaleFactor: read(d.displayScaleFactor)
      });
    },

    /** drag/chat/zoom/sleep 接管意图 */
    obsTakeover(kind, on) {
      if (!active()) return;
      s.record("main", "takeover", { kind: String(kind || "unknown"), on: !!on });
    },

    /** 行走引擎启停 */
    obsEngine(on) {
      if (!active()) return;
      s.record("main", "engine", { on: !!on });
    },

    /** 渲染层证据上行（pet:shadow-evidence） */
    obsRendererEvidence(ev) {
      if (!active()) return;
      s.observeRendererEvidence(ev);
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

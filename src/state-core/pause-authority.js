/**
 * pause-authority.js — State Core 的 Attention/Pause canonical truth（纯模块，无 I/O）。
 *
 * 替代 walk.paused / dragPaused / chatPaused / zoomPaused 散落布尔作为「谁在暂停角色」的
 * 最终事实来源。每个 pause 来源持有一个 lease：
 *   { source, leaseId, token, domain, acquiredAt }
 * - acquire(source, {leaseId, domain})：同 source 重复 acquire → 换发新 token（旧 leaseId 立即失效）；
 * - release(source, {leaseId})：仅当 leaseId 与当前 lease 匹配才释放（A release B / 旧回调清新 pause 被拒）；
 * - revoke(source, reason)：main 权威强制释放（watchdog / teardown / throw 接管）；
 * - revokeByDomain(domain, reason)：renderer reload / document replacement 时批量吊销
 *   renderer-owned lease（drag/interaction），main-owned（chat）保留；
 * - effectivePaused()：derived——存在任一有效 lease 即 paused。
 *
 * token 单调不回收；release/revoke 不影响已发出的历史 token（stale 永远对不上）。
 * 本模块不接触窗口/动作——它是纯状态权威；副作用由调用方（main wiring）执行。
 */
"use strict";

const PAUSE_SOURCES = ["drag", "chat", "zoom", "interaction"]; // 首批来源（Sleep 明确不在内）

function createPauseAuthority() {
  const leases = new Map(); // source → {token, leaseId, domain, acquiredAt}
  const stats = { acquire: 0, release: 0, revoke: 0, deniedRelease: 0, lastTransition: null };
  let tokenSeq = 0;

  function transition(kind, source, token) {
    stats.lastTransition = { kind, source, token, at: token };
  }

  return {
    PAUSE_SOURCES,
    /**
     * 获取 pause lease。leaseId 是调用方身份（renderer interactionId / main 内部序号）。
     * 同 source 重复 acquire：换发新 token + 新 leaseId（旧 leaseId 的 release 之后会被拒）。
     */
    acquire(source, meta = {}) {
      const src = String(source || "");
      const leaseId = meta.leaseId !== undefined && meta.leaseId !== null ? meta.leaseId : null;
      const prev = leases.get(src);
      const token = ++tokenSeq;
      leases.set(src, {
        token,
        leaseId,
        domain: meta.domain || "main",
        acquiredAt: meta.now !== undefined ? meta.now : null,
        meta: meta.meta && typeof meta.meta === "object" ? meta.meta : null,
        prevToken: prev ? prev.token : null
      });
      stats.acquire += 1;
      transition("acquire", src, token);
      return { ok: true, token, leaseId, refreshed: !!prev };
    },
    /**
     * 匹配释放：leaseId 必须与当前 lease 一致（含双方皆为 null 的匿名配对——fallback shim 路径）。
     * 旧 leaseId / 未知 leaseId / 对新 lease 的匿名释放一律拒绝（A release B / 旧回调清新 pause 被防）。
     */
    release(source, { leaseId } = {}) {
      const src = String(source || "");
      const lease = leases.get(src);
      if (!lease) return { ok: false, reason: "no-lease", noop: true };
      if (lease.leaseId !== leaseId) {
        stats.deniedRelease += 1;
        return { ok: false, reason: "lease-id-mismatch", expectedLeaseId: lease.leaseId };
      }
      leases.delete(src);
      stats.release += 1;
      transition("release", src, lease.token);
      return { ok: true, releasedToken: lease.token };
    },
    /** main 权威强制释放（watchdog / teardown / throw 接管 / reload）。 */
    revoke(source, reason) {
      const src = String(source || "");
      const lease = leases.get(src);
      if (!lease) return { ok: false, noop: true };
      leases.delete(src);
      stats.revoke += 1;
      transition("revoke", src, lease.token);
      return { ok: true, revokedToken: lease.token, reason: reason || null };
    },
    /** 按 domain 批量吊销（renderer reload：吊销 renderer-owned lease，main-owned 保留）。 */
    revokeByDomain(domain, reason) {
      const revoked = [];
      for (const [src, lease] of leases.entries()) {
        if (lease.domain === domain) {
          leases.delete(src);
          revoked.push(src);
        }
      }
      if (revoked.length) {
        stats.revoke += revoked.length;
        transition("revoke-domain", revoked.join(","), undefined);
      }
      return { ok: true, revoked };
    },
    /** 有效 pause：存在任一 lease。derived state（不可直接写）。 */
    effectivePaused() { return leases.size > 0; },
    isPaused(source) { return leases.has(String(source || "")); },
    activeSources() { return Array.from(leases.keys()); },
    leaseOf(source) {
      const l = leases.get(String(source || ""));
      return l ? { token: l.token, leaseId: l.leaseId, domain: l.domain } : null;
    },
    snapshot() {
      const out = { effectivePaused: leases.size > 0, sources: {} };
      for (const [src, l] of leases.entries()) out.sources[src] = { token: l.token, leaseId: l.leaseId, domain: l.domain };
      return Object.assign(out, { stats: Object.assign({}, stats) });
    }
  };
}

module.exports = { createPauseAuthority, PAUSE_SOURCES };

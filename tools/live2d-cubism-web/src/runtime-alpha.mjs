// The display framebuffer is captured after draw, before READY is published.
// Every new pointer coordinate can then be answered without a GPU read or a
// temporary false result. The buffer belongs to one renderer owner only.
export function createAlphaSampler() {
  let cache = null;
  let buffer = null;
  let bufferOwner = null;
  let bufferWidth = 0, bufferHeight = 0;
  let statsOwner = null;
  let allocations = 0, reads = 0, failures = 0, totalMs = 0, maxMs = 0, lastMs = 0;
  const recentMs = new Float64Array(120);
  let recentCount = 0, recentIndex = 0;
  const sameRect = (a, b) => a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.width === b.width && a.height === b.height;
  const validRect = r => r && [r.left, r.top, r.right, r.bottom, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  const validSize = (w, h) => Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 && Number.isSafeInteger(w * h * 4);
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  function clearStats() {
    allocations = reads = failures = totalMs = maxMs = lastMs = recentCount = recentIndex = 0;
  }
  return {
    at(owner, x, y, rect, width, height) {
      if (!owner || !cache || cache.owner !== owner) return false;
      if (!sameRect(cache.rect, rect) || cache.width !== width || cache.height !== height) {
        cache = null;
        return false;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return false;
      const px = Math.floor((x - rect.left) * width / rect.width);
      const py = height - 1 - Math.floor((y - rect.top) * height / rect.height);
      return buffer[(py * width + px) * 4 + 3] >= 16;
    },
    sample(owner, frame, rect, width, height, read) {
      cache = null; // A failed read must never expose an older contour.
      if (!owner || !validRect(rect) || !validSize(width, height) || typeof read !== 'function') return false;
      if (statsOwner !== owner) { clearStats(); statsOwner = owner; }
      try {
        if (!buffer || bufferOwner !== owner || bufferWidth !== width || bufferHeight !== height) {
          buffer = new Uint8Array(width * height * 4);
          bufferOwner = owner; bufferWidth = width; bufferHeight = height;
          allocations++;
        }
        const start = now();
        let ok;
        try { ok = read(buffer, width, height) !== false; }
        finally {
          lastMs = Math.max(0, now() - start);
          totalMs += lastMs; maxMs = Math.max(maxMs, lastMs); reads++;
          recentMs[recentIndex] = lastMs;
          recentIndex = (recentIndex + 1) % recentMs.length;
          recentCount = Math.min(recentMs.length, recentCount + 1);
        }
        if (!ok) { failures++; return false; }
        cache = { owner, frame, rect: { ...rect }, width, height };
        return true;
      } catch { failures++; return false; }
    },
    reset(owner) {
      if (owner && bufferOwner !== owner && statsOwner !== owner) return;
      cache = buffer = bufferOwner = statsOwner = null;
      bufferWidth = bufferHeight = 0;
      clearStats();
    },
    snapshot(owner) {
      const current = Boolean(owner && owner === statsOwner);
      const durations = current ? Array.from(recentMs.subarray(0, recentCount)).sort((a, b) => a - b) : [];
      const percentile = p => durations.length ? durations[Math.ceil(durations.length * p) - 1] : 0;
      return {
        ready: Boolean(owner && cache?.owner === owner), frame: cache?.owner === owner ? cache.frame : 0,
        width: bufferOwner === owner ? bufferWidth : 0, height: bufferOwner === owner ? bufferHeight : 0,
        bufferBytes: bufferOwner === owner ? buffer?.byteLength || 0 : 0,
        bufferAllocations: current ? allocations : 0, readCount: current ? reads : 0,
        readFailures: current ? failures : 0, readLastMs: current ? lastMs : 0,
        readMeanMs: current && reads ? totalMs / reads : 0, readMaxMs: current ? maxMs : 0,
        recentReadSamples: durations.length, recentReadP50Ms: percentile(0.5), recentReadP95Ms: percentile(0.95)
      };
    }
  };
}

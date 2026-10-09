// Renderer-local post-frame alpha cache. Consumer reads do not consume it.
export function createAlphaSampler() {
  let pending = null;
  let cache = null;
  const sameRect = (a, b) => a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.width === b.width && a.height === b.height;
  return {
    submit(owner, x, y, rect) {
      if (!owner || !Number.isFinite(x) || !Number.isFinite(y) || !rect) { pending = null; cache = null; return false; }
      if (!pending || pending.owner !== owner || pending.x !== x || pending.y !== y || !sameRect(pending.rect, rect)) {
        pending = { owner, x, y, rect: { ...rect } };
        cache = null;
        return false;
      }
      if (!cache || cache.owner !== owner || cache.x !== x || cache.y !== y || !sameRect(cache.rect, rect)) return false;
      return cache.alpha;
    },
    sample(owner, frame, rect, read) {
      if (!pending || pending.owner !== owner || !sameRect(pending.rect, rect)) { cache = null; return; }
      try { cache = { owner, x: pending.x, y: pending.y, rect: { ...rect }, frame, alpha: Boolean(read(pending.x, pending.y, rect)) }; }
      catch { cache = null; }
    },
    reset(owner) {
      if (!owner || pending?.owner === owner || cache?.owner === owner) { pending = null; cache = null; }
    }
  };
}

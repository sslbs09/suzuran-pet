// Renderer-local owner identity. Tokens stay opaque and are never serialized.
export function createOwnerLifecycle() {
  let current = null;
  let generation = 0;
  return {
    begin(token) {
      const owner = { token, generation: ++generation, disposed: false };
      current = owner;
      return owner;
    },
    isCurrent(owner) { return current === owner && !owner?.disposed; },
    accepts(owner, token) { return this.isCurrent(owner) && (token === undefined || Object.is(owner.token, token)); },
    retire(owner) {
      if (!owner) return;
      owner.disposed = true;
      if (current === owner) current = null;
    },
    generation() { return generation; }
  };
}

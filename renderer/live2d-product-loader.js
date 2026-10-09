/* Renderer-local Cubism Web R5 loader contract.  It contains no model or SDK data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Live2dProductLoader = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function chooseStack(capability) {
    const cubism = capability && capability.cubismWeb;
    if (!cubism || cubism.provisioned !== true) return { kind: 'legacy' };
    const required = ['coreURL', 'runtimeURL', 'shaderURL', 'modelURL'];
    if (required.some((key) => typeof cubism[key] !== 'string' || !cubism[key])) return { kind: 'legacy' };
    if (!cubism.coreURL.startsWith('pet-user://live2d-runtime/') ||
        !cubism.runtimeURL.startsWith('pet-user://live2d-runtime/') ||
        !cubism.shaderURL.startsWith('pet-user://live2d-runtime/') ||
        !cubism.modelURL.startsWith('pet-user://live2d/')) return { kind: 'legacy' };
    return {
      kind: 'cubism-web',
      coreURL: cubism.coreURL,
      runtimeURL: cubism.runtimeURL,
      shaderURL: cubism.shaderURL,
      modelURL: cubism.modelURL
    };
  }

  function createOwnerFence() {
    let owner = null;
    return {
      begin(token) { owner = token; return token; },
      current() { return owner; },
      isCurrent(token) { return owner !== null && owner === token; },
      guard(token, fn) {
        if (owner === null || owner !== token) return false;
        fn();
        return true;
      },
      destroy(token) {
        if (owner === null || owner !== token) return false;
        owner = null;
        return true;
      }
    };
  }

  function validateSemanticCommand(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
    if (typeof command.type !== 'string') return false;
    const schemas = {
      mouth: ['type', 'value'], look: ['type', 'x', 'y'],
      expression: ['type', 'name'], motion: ['type', 'name'],
      neutral: ['type'], stop: ['type']
    };
    const allowed = schemas[command.type];
    if (!allowed || Object.keys(command).some((key) => !allowed.includes(key))) return false;
    if (command.type === 'mouth') return typeof command.value === 'number' && Number.isFinite(command.value) && command.value >= 0 && command.value <= 1;
    if (command.type === 'look') return typeof command.x === 'number' && typeof command.y === 'number' && Number.isFinite(command.x) && Number.isFinite(command.y) && Math.abs(command.x) <= 1 && Math.abs(command.y) <= 1;
    if (command.type === 'expression') return ['neutral', 'happy', 'reaction'].includes(command.name);
    if (command.type === 'motion') return ['idle', 'greet', 'pat'].includes(command.name);
    return true;
  }

  async function loadStack(selection, loadScript) {
    if (!selection || selection.kind !== 'cubism-web') return { kind: 'legacy' };
    await loadScript(selection.coreURL);
    await loadScript(selection.runtimeURL);
    return selection;
  }

  return { chooseStack, createOwnerFence, validateSemanticCommand, loadStack };
});

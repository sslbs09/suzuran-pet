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
    const keys = Object.keys(command);
    if (keys.some((key) => /cubism|param|model|shader|resource|filename|file/i.test(key))) return false;
    if (typeof command.type !== 'string') return false;
    if (command.type === 'mouth') return Number.isFinite(Number(command.value)) && Number(command.value) >= 0 && Number(command.value) <= 1;
    if (command.type === 'look') return Number.isFinite(Number(command.x)) && Number.isFinite(Number(command.y));
    if (command.type === 'expression' || command.type === 'motion') return typeof command.name === 'string' && command.name.length > 0 && command.name.length < 80;
    return command.type === 'neutral' || command.type === 'stop';
  }

  async function loadStack(selection, loadScript) {
    if (!selection || selection.kind !== 'cubism-web') return { kind: 'legacy' };
    await loadScript(selection.coreURL);
    await loadScript(selection.runtimeURL);
    return selection;
  }

  return { chooseStack, createOwnerFence, validateSemanticCommand, loadStack };
});

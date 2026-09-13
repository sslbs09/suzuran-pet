"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const renderMode = require("../src/render-mode");

const renderer = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n"); // EOL 鲁棒性：字面量/mutation 匹配不再依赖检出端 CRLF/LF
const live2d = fs.readFileSync(require.resolve("../renderer/live2d-runtime.js"), "utf8");
const index = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
const css = fs.readFileSync(require.resolve("../renderer/pet.css"), "utf8");
const config = fs.readFileSync(require.resolve("../src/config.js"), "utf8");

const modes = ["gif", "spine", "rig", "live2d"];
const transitions = [
  ["gif", "spine"], ["gif", "rig"], ["gif", "live2d"],
  ["spine", "gif"], ["spine", "rig"], ["spine", "live2d"],
  ["rig", "gif"], ["rig", "spine"], ["rig", "live2d"],
  ["live2d", "gif"], ["live2d", "spine"], ["live2d", "rig"]
];

function bodyOf(name, next) {
  const start = renderer.indexOf(name);
  const end = next ? renderer.indexOf(next, start) : renderer.length;
  assert.ok(start >= 0, name + " exists");
  return renderer.slice(start, end >= 0 ? end : renderer.length);
}

function wait(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPetLifecycleHarness() {
  const handlers = {};
  const calls = { sizes: [], clickable: [], playback: [], outcomes: [], corrections: [], fetches: 0 };
  const elements = new Map();
  const nativeSetTimeout = setTimeout;
  const nativeClearTimeout = clearTimeout;
  const timers = {
    setTimeout(fn, ms, ...args) { return nativeSetTimeout(fn, Math.min(Number(ms) || 0, 5), ...args); },
    clearTimeout: nativeClearTimeout
  };

  function makeClassList() {
    const values = new Set();
    return {
      values,
      add(...names) { names.forEach((name) => values.add(name)); },
      remove(...names) { names.forEach((name) => values.delete(name)); },
      contains(name) { return values.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !values.has(name) : !!force;
        if (next) values.add(name); else values.delete(name);
        return next;
      }
    };
  }

  function makeElement(id, tagName = "div") {
    const listeners = new Map();
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      className: "",
      classList: makeClassList(),
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      textContent: "",
      innerHTML: "",
      src: tagName.toUpperCase() === "IMG" ? "" : undefined,
      value: "",
      disabled: false,
      scrollTop: 0,
      clientWidth: 260,
      clientHeight: 200,
      offsetLeft: 0,
      offsetTop: 0,
      offsetHeight: 200,
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
      dispatchEvent(event) { const fn = listeners.get(event.type); if (fn) fn(event); },
      appendChild(child) { child.parentNode = el; child.isConnected = true; el.children.push(child); return child; },
      insertBefore(child, before) {
        child.parentNode = el;
        child.isConnected = true;
        const index = el.children.indexOf(before);
        if (index < 0) el.children.push(child); else el.children.splice(index, 0, child);
        return child;
      },
      removeChild(child) {
        const index = el.children.indexOf(child);
        if (index >= 0) el.children.splice(index, 1);
        child.parentNode = null;
        child.isConnected = false;
        return child;
      },
      closest(selector) {
        let node = el;
        while (node) {
          if (selector === "#" + node.id || selector === "." + node.className) return node;
          node = node.parentNode;
        }
        return null;
      },
      querySelector() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight, bottom: el.clientHeight }; },
      setPointerCapture() {},
      releasePointerCapture() {},
      focus() {},
      blur() {}
    };
    elements.set(id, el);
    return el;
  }

  const body = makeElement("body");
  const documentElement = makeElement("documentElement");
  documentElement.clientWidth = 260;
  documentElement.clientHeight = 200;
  documentElement.style = { setProperty() {} };
  const head = makeElement("head");
  const ids = [
    "pet", "sprite", "bubble", "bubble-text", "thinking-dots", "input-bar", "input", "btn-send", "btn-stop",
    "mode-chip", "btn-close", "btn-info", "btn-mic", "btn-tts", "btn-zoom", "info-panel", "info-companion",
    "info-schedules", "info-weather", "swipe-bar", "swipe-next", "swipe-pos", "swipe-prev", "swipe-regen",
    "rig-canvas", "live2d-canvas", "spine-canvas"
  ];
  for (const id of ids) makeElement(id, id.endsWith("canvas") ? "canvas" : id === "sprite" ? "img" : "div");
  body.appendChild(elements.get("pet"));
  elements.get("pet").appendChild(elements.get("sprite"));
  body.appendChild(elements.get("rig-canvas"));
  body.appendChild(elements.get("live2d-canvas"));
  elements.get("rig-canvas").classList.add("hidden");
  elements.get("live2d-canvas").classList.add("hidden");

  const assets = { hold: false, pending: [] };
  const apps = [];
  class FakeApplication {
    constructor(options = {}) {
      this.view = options.view || makeElement("pixi-view-" + apps.length, "canvas");
      this.stage = { addChild: (child) => { this.child = child; } };
      this.screen = { width: options.width || 260, height: options.height || 200 };
      this.renderer = {
        resize() {},
        render() {},
        extract: { pixels: (rt) => {
          const pixels = new Uint8Array(rt.width * rt.height * 4);
          pixels[3] = 255;
          return pixels;
        } }
      };
      this.ticker = {
        started: true,
        stopped: false,
        maxFPS: 60,
        add() {},
        remove() {},
        stop: () => { this.ticker.stopped = true; this.ticker.started = false; },
        start: () => { this.ticker.started = true; this.ticker.stopped = false; }
      };
      this.destroyed = false;
      this.removeView = null;
      apps.push(this);
    }
    destroy(removeView) {
      this.removeView = removeView;
      this.destroyed = true;
      if (removeView && this.view.parentNode) this.view.parentNode.removeChild(this.view);
    }
  }
  class FakeSpine {
    constructor(data) {
      this.spineData = data || { animations: [{ name: "idle" }, { name: "Move" }, { name: "Sitd" }] };
      this.width = 100;
      this.height = 160;
      this.x = 0;
      this.y = 0;
      this.autoUpdate = true;
      this.scale = { x: 1, y: 1, set: (x, y = x) => { this.scale.x = x; this.scale.y = y; } };
      this.state = {
        data: { defaultMix: 0 },
        timeScale: 1,
        current: null,
        getCurrent: () => this.state.current,
        setAnimation: (_track, name, loop) => {
          this.state.current = { animation: { name }, loop, trackTime: 0, animationEnd: 1, next: null };
          return {};
        },
        addAnimation: (_track, name, loop) => { this.state.current = { animation: { name }, loop, trackTime: 0, animationEnd: 1, next: null }; }
      };
      this.destroyed = false;
    }
    update() {}
    updateTransform() {}
    getBounds() { return { x: this.x, y: this.y - this.height, width: this.width, height: this.height }; }
    destroy() { this.destroyed = true; }
  }

  const rigInstances = [];
  const rigRuntimeApi = {
    init() {
      const runtime = {
        destroyed: false,
        applyRig() {},
        setAuto() {},
        setMouseMode() {},
        setExternalMouse() {},
        preset() {},
        setParam() {},
        destroy() { this.destroyed = true; }
      };
      rigInstances.push(runtime);
      return runtime;
    },
    detectFollow() { return { level: "none", reason: "test" }; }
  };

  const liveOwners = [];
  const spineQueries = { immediate: true, pending: [], calls: 0 };
  const stateReads = { hold: false, pending: [], calls: 0, walkState: null };
  const liveRuntime = {
    current: null,
    pending: [],
    immediate: true,
    init(canvas, url, token) {
      const owner = { canvas, url, token, destroyed: false };
      liveOwners.push(owner);
      this.current = owner;
      if (this.immediate) return Promise.resolve(true);
      return new Promise((resolve) => this.pending.push({ owner, resolve }));
    },
    destroy(token) {
      if (token && this.current && this.current.token !== token) return false;
      if (this.current) this.current.destroyed = true;
      this.current = null;
      return true;
    },
    setScale() {}, setMood() {}, poke() {}
  };

  const stateSnapshot = () => ({
    renderMode: "gif", rigSkinId: "", live2dSkinId: "",
    ...(stateReads.walkState ? { walkState: { ...stateReads.walkState } } : {})
  });
  const petAPI = new Proxy({
    getState: () => {
      stateReads.calls += 1;
      if (stateReads.hold) return new Promise((resolve) => stateReads.pending.push(resolve));
      return Promise.resolve(stateSnapshot());
    },
    getSpineModels: () => {
      spineQueries.calls += 1;
      if (spineQueries.immediate) return Promise.resolve({ list: [], current: "builtin" });
      return new Promise((resolve, reject) => spineQueries.pending.push({ resolve, reject }));
    },
    live2dList: async () => [{ id: "builtin/test", name: "test", url: "test.model3.json" }],
    setSize(w, h, source) { calls.sizes.push(source ? [w, h, source] : [w, h]); },
    setClickable(value) { calls.clickable.push(!!value); },
    reportRenderModeOutcome(outcome) { calls.outcomes.push({ ...outcome }); },
    reportRenderModeCorrection(correction) { calls.corrections.push({ ...correction }); },
    playback(message) { calls.playback.push(String(message)); },
    setGroundGap() {}, setCharInset() {}, setHasSit() {}, setSleeping() {}, walkingEngineStop() {},
    walkingPause() {}, moveWindow() {}, hideWindow() {}, reloadRenderer() {}, pat() {}, throwPet() {},
    ask: async () => {}, getAppearance: async () => null, getInfo: async () => ({})
  }, {
    get(target, property) {
      if (property in target) return target[property];
      if (String(property).startsWith("on")) return (callback) => { handlers[property] = callback; };
      return () => undefined;
    }
  });

  const sandbox = {
    console,
    window: null,
    document: {
      body,
      head,
      documentElement,
      visibilityState: "visible",
      title: "",
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeElement("created-" + elements.size, tag),
      createTextNode: (text) => ({ textContent: text }),
      addEventListener() {},
      elementFromPoint: () => elements.get("pet")
    },
    innerWidth: 260,
    innerHeight: 200,
    devicePixelRatio: 1,
    location: { search: "" },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => nativeSetTimeout(fn, 0),
    cancelAnimationFrame: nativeClearTimeout,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ zoom: "1" }),
    matchMedia: () => ({ addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    Image: class {
      constructor() { this.onload = null; this.onerror = null; this.src = ""; images.push(this); }
    },
    ResizeObserver: undefined,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    URLSearchParams,
    petAPI,
    petTheme: { apply() {} },
    GenericParts: null,
    Rigger: { buildRig: () => ({ layers: [] }) },
    RigRuntime: rigRuntimeApi,
    agPsd: { readPsd: () => ({ layers: [] }) },
    Live2DCubismCore: {},
    Live2DRuntime: liveRuntime,
    PetClickability: require("../src/clickability"), // 穿透纯逻辑核心双端文件（渲染层 <script> 全局的测试替身，sandbox 即 window）
    PIXI: {
      Application: FakeApplication,
      Assets: {
        load(path) {
          if (!assets.hold) return Promise.resolve({ pages: [], spineData: { animations: [{ name: "idle" }, { name: "Move" }, { name: "Sitd" }] }, path });
          return new Promise((resolve, reject) => assets.pending.push({ path, resolve, reject }));
        }
      },
      spine: { Spine: FakeSpine },
      UPDATE_PRIORITY: { HIGH: 100 },
      MIPMAP_MODES: { ON: 1 },
      RenderTexture: { create: ({ width, height }) => ({ width, height, destroy() {} }) }
    },
    __renderLifecycleTestMode: true
  };
  const images = [];
  const readyFetch = sandbox.fetch;
  sandbox.fetch = async (...args) => {
    calls.fetches += 1;
    return readyFetch(...args);
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(renderer, sandbox, { filename: "renderer/pet.js" });
  const lifecycle = sandbox.__renderLifecycle;
  assert.ok(lifecycle, "production lifecycle seam is exposed");

  return {
    sandbox,
    lifecycle,
    handlers,
    calls,
    elements,
    assets,
    spineQueries,
    stateReads,
    apps,
    rigInstances,
    liveRuntime,
    liveOwners,
    images,
    readyFetch: sandbox.fetch,
    releaseStateReads() {
      const pending = stateReads.pending.splice(0);
      for (const resolve of pending) resolve(stateSnapshot());
    },
    settleImage(index = images.length - 1) { if (images[index] && images[index].onload) images[index].onload(); },
    async switch(mode, resourceId) {
      const options = resourceId === undefined ? {} : { resourceId };
      return lifecycle.switchRenderMode(mode, options);
    },
    async enter(mode, resourceId) {
      const result = await this.switch(mode, resourceId);
      await wait(8);
      return result;
    }
  };
}

test("renderer owns requested and committed four-state mode separately", () => {
  assert.match(renderer, /const RENDER_MODES = \["gif", "spine", "rig", "live2d"\]/);
  assert.match(renderer, /let requestedRenderMode = "gif"/);
  assert.match(renderer, /let activeRenderMode = null/);
  assert.match(renderer, /let renderSwitchGeneration = 0/);
  assert.match(renderer, /let renderSwitchStatus = "idle"/);
});

test("all real mode changes converge on switchRenderMode", () => {
  const lifecycle = bodyOf("async function switchRenderMode", "/** 主进程广播行走状态");
  assert.match(lifecycle, /const generation = \+\+renderSwitchGeneration/);
  assert.match(lifecycle, /teardownAll\(\)/);
  assert.match(lifecycle, /resetVisualState\(\)/);
  assert.match(lifecycle, /initSpine\(context\)/);
  assert.match(lifecycle, /initRig\(context\)/);
  assert.match(lifecycle, /initLive2d\(context\)/);
  assert.match(lifecycle, /commitRenderMode\(context, result\)/);
  assert.match(renderer, /onRenderModeChanged\(async \(m\) =>/);
  assert.match(renderer, /onLive2dChanged\(async \(id\) =>/);
  assert.match(renderer, /onRigSkinChanged\(async \(id\) =>/);
  assert.match(renderer, /switchRenderMode\("spine", \{ force: true, delayMs: 200 \}\)/);
});

function assertSpineReadyReplayWiring(source = renderer) {
  const start = source.indexOf("if (window.petAPI.onRenderModeChanged)");
  const end = source.indexOf("if (window.petAPI.onLive2dChanged)", start);
  assert.ok(start >= 0 && end > start, "render-mode listener block exists");
  const block = source.slice(start, end);
  const readyStart = block.indexOf("if (isCurrentModeRequest() && (result.status === \"ready\" || result.status === \"noop\"))");
  assert.ok(readyStart >= 0, "ready/current owner guard exists");
  const ready = block.slice(readyStart);
  const mood = ready.indexOf('setMood(lastMood || "idle")');
  const replay = ready.indexOf("applyWalkState(state.walkState)");
  assert.ok(mood >= 0, "post-commit mood restoration exists");
  assert.ok(replay > mood, "latest walkState replay follows mood restoration");
  assert.match(ready, /mode === "spine" && state\.walkState && activeRenderGeneration === requestGeneration/,
    "replay is limited to current Spine owner generation");
  assert.match(block, /if \(!isCurrentModeRequest\(\)\) \{[\s\S]*?await reconcileFormalRenderMode\(mode, mainSeq\);[\s\S]*?\}[\s\S]*let state = null;[\s\S]*if \(!result\.fallback\) state = await window\.petAPI\.getState\(\)/,
    "state is read only after the request is current");
  assert.match(block, /let state = null;[\s\S]*if \(!isCurrentModeRequest\(\)\) \{[\s\S]*?await reconcileFormalRenderMode\(mode, mainSeq\);/,
    "post-getState supersession enters formal reconciliation");
}

test("Spine mode-ready replay uses latest state after mood restoration", () => {
  assertSpineReadyReplayWiring();
});

function expectSpineReplayMutationToFail(label, mutate) {
  let failed = false;
  try { assertSpineReadyReplayWiring(mutate(renderer)); } catch { failed = true; }
  assert.equal(failed, true, `${label} must fail replay wiring validation`);
}

test("Spine mode-ready replay mutation matrix", () => {
  expectSpineReplayMutationToFail("删除 post-commit applyWalkState", (source) => source.replace(
    '      if (!result.fallback && mode === "spine" && state.walkState && activeRenderGeneration === requestGeneration) {\n' +
    '        applyWalkState(state.walkState); // 新 owner ready 后重放最新行走状态，收敛 Sit/Rest/Move\n' +
    '      }\n', ""));
  expectSpineReplayMutationToFail("applyWalkState 前置到 setMood 之前", (source) => source.replace(
    '      if (activeRenderMode === mode || result.fallback) setMood(lastMood || "idle"); // 切换/回退后恢复当前情绪\n' +
    '      if (!result.fallback && mode === "spine" && state.walkState && activeRenderGeneration === requestGeneration) {\n' +
    '        applyWalkState(state.walkState); // 新 owner ready 后重放最新行走状态，收敛 Sit/Rest/Move\n' +
    '      }\n',
    '      if (!result.fallback && mode === "spine" && state.walkState && activeRenderGeneration === requestGeneration) {\n' +
    '        applyWalkState(state.walkState);\n' +
    '      }\n' +
    '      setMood(lastMood || "idle"); // 切换后恢复当前情绪\n'));
  expectSpineReplayMutationToFail("删除 current-request guard", (source) => source.replace(
    'if (isCurrentModeRequest() && (result.status === "ready" || result.status === "noop"))',
    "if (true)"));
  expectSpineReplayMutationToFail("改用旧 cached walkState", (source) => source.replace(
    "applyWalkState(state.walkState)", "applyWalkState(walkState)"));
});

function walkState(overrides = {}) {
  return {
    active: false, resting: true, perched: false, seated: false,
    face: 1, paused: false, sleeping: false, ...overrides
  };
}

async function enterSpineFromModeEvent(harness, latestState, earlyState) {
  harness.lifecycle.setMoods([]); // 禁止 setMood 偶然掩盖 post-commit replay
  harness.spineQueries.immediate = false;
  const pending = harness.handlers.onRenderModeChanged("spine");
  await wait(8);
  assert.equal(harness.spineQueries.pending.length, 1, "Spine owner ready 前仍在等待模型查询");
  if (earlyState) harness.handlers.onWalking(earlyState);
  harness.stateReads.walkState = latestState;
  harness.spineQueries.pending.shift().resolve({ list: [], current: "builtin" });
  const result = await pending;
  assert.equal(result, undefined, "mode event handler completes without exposing an unrelated result");
  return harness.lifecycle.getState().spineObj;
}

test("production early seated broadcast is replayed after the new Spine owner commits", async () => {
  const harness = createPetLifecycleHarness();
  const seated = walkState({ seated: true });
  const owner = await enterSpineFromModeEvent(harness, seated, seated);
  assert.equal(owner.state.getCurrent(0).animation.name, "Sitd", "owner ready 后 seated=true 最终进入 Sit");
});

test("production active=false plus seated=true still replays Sit", async () => {
  const harness = createPetLifecycleHarness();
  const owner = await enterSpineFromModeEvent(harness, walkState({ active: false, seated: true }), walkState({ active: false, seated: true }));
  assert.equal(owner.state.getCurrent(0).animation.name, "Sitd", "active=false 不得把 seated=true 降级为 idle");
});

test("production mode-ready replay uses the latest state instead of the cached pre-owner state", async () => {
  const harness = createPetLifecycleHarness();
  const cached = walkState({ active: true, resting: false, seated: false });
  const latest = walkState({ active: false, seated: true });
  const owner = await enterSpineFromModeEvent(harness, latest, cached);
  assert.equal(owner.state.getCurrent(0).animation.name, "Sitd", "latest getState walkState wins over cached state");
});

test("production mode-ready replay does not turn seated=false into Sit", async () => {
  const harness = createPetLifecycleHarness();
  const owner = await enterSpineFromModeEvent(harness, walkState({ active: false, seated: false }), null);
  assert.notEqual(owner.state.getCurrent(0).animation.name, "Sitd", "seated=false 不误播 Sit");
});

test("production stale Spine state response cannot replay into the later GIF request", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setMoods([]);
  harness.stateReads.hold = true;
  const staleSpine = harness.handlers.onRenderModeChanged("spine");
  await wait(10);
  assert.equal(harness.stateReads.pending.length, 1, "Spine ready 后 state response 被挂起");

  harness.stateReads.hold = false;
  const currentGif = harness.handlers.onRenderModeChanged("gif");
  await currentGif;
  harness.stateReads.pending.shift()({ walkState: walkState({ seated: true }) });

  assert.equal(await staleSpine, undefined, "旧 Spine handler 在 request 失效后 no-op");
  assert.equal(harness.lifecycle.getState().active, "gif", "旧 state response 不改变当前 mode");
});

test("directed transition contract retains all 12 requested edges", () => {
  assert.equal(transitions.length, 12);
  for (const [from, to] of transitions) assert.ok(modes.includes(from) && modes.includes(to) && from !== to);
});

test("resetVisualState keeps at most one visual surface eligible", () => {
  const reset = bodyOf("function resetVisualState", "function teardownAll");
  assert.match(reset, /spine-mode.*rig-mode.*live2d-mode/);
  assert.match(reset, /spriteEl\.style\.display = "none"/);
  assert.match(reset, /rigCanvas\.classList\.add\("hidden"\)/);
  assert.match(reset, /liveCanvas\.classList\.add\("hidden"\)/);
  assert.match(css, /\.rig-canvas \{[\s\S]*pointer-events: none/);
  assert.match(css, /body\.rig-mode \.rig-canvas \{[\s\S]*pointer-events: auto/);
  assert.match(css, /\.live2d-canvas \{[\s\S]*pointer-events: none/);
  assert.match(css, /body\.live2d-mode \.live2d-canvas \{ pointer-events: auto; \}/);
});

test("Spine uses one dynamic canvas and owner cleanup", () => {
  assert.doesNotMatch(index, /id="spine-canvas"/);
  const init = bodyOf("async function initSpine(context)", "function resetVisualState");
  assert.match(init, /owner\.view\.id = "spine-canvas"/);
  assert.match(init, /petEl\.insertBefore\(owner\.view, spriteEl\)/);
  assert.match(renderer, /function destroySpineOwner\(owner\)/);
  assert.match(renderer, /owner\.app\.ticker\.stop\(\)/);
  assert.match(renderer, /owner\.view\.parentNode\.removeChild\(owner\.view\)/);
});

test("Live2D destroy preserves the static canvas and protects async owners", () => {
  assert.doesNotMatch(live2d, /canvas[^\n]*removeChild/);
  assert.match(live2d, /function cleanupOwner\(owner, hideCanvas = true\)/);
  assert.match(live2d, /function destroy\(ownerToken\)/);
  assert.match(live2d, /ownerToken !== currentToken/);
  assert.match(live2d, /let pendingOwner = null/);
  assert.match(live2d, /cleanupOwner\(owner, false\)/);
  assert.match(live2d, /owner\.canvas\.classList\.add\("hidden"\)/);
  assert.match(renderer, /window\.Live2DRuntime\.init\(canvas, pick\.url, context\.token\)/);
});

test("GIF preload is generation-owned while mood reset is mode-independent", () => {
  const preload = bodyOf("function showGifWithPreload", "const gifPreloadCache");
  assert.match(preload, /const ownerGeneration = renderSwitchGeneration/);
  assert.match(preload, /requestedRenderMode !== "gif"/);
  assert.match(preload, /activeRenderGeneration !== ownerGeneration/);
  const mood = bodyOf("function scheduleMoodReset", "function wake");
  assert.match(mood, /moodTimer = null/);
  assert.doesNotMatch(mood, /ownerGeneration !== renderSwitchGeneration/);
  assert.doesNotMatch(mood, /activeRenderMode !== "gif"/);
});

test("same mode is a no-op only when ready and same resource", () => {
  const lifecycle = bodyOf("async function switchRenderMode", "/** 主进程广播行走状态");
  assert.match(lifecycle, /renderRuntimeReady/);
  assert.match(lifecycle, /const targetResource = resourceKeyFor\(mode, options\)/);
  assert.match(lifecycle, /renderRuntimeResource === targetResource/);
  assert.match(lifecycle, /options\.force/);
});

test("startup mode uses the formal main request and Live2D settings mapping is four-state", () => {
  const init = bodyOf("// 启动与 runtime switch 共用 main 分配的正式 seq", "if (!agreed)");
  assert.match(init, /const initialRequest = state\.renderModeRequest/);
  assert.match(init, /const initialMode = RENDER_MODES\.includes\(initialRequest\.mode\)/);
  assert.match(init, /const initialMainSeq = Number\.isSafeInteger\(initialRequest\.seq\)/);
  assert.match(init, /mainSeq: initialMainSeq/);
  assert.match(init, /const initialResult = await switchRenderMode\(initialMode/);
  assert.match(init, /reportRenderModeOutcome\(initialMainSeq, initialMode, initialResult/);
  assert.ok(init.indexOf("setClickable(initialResult.status") < init.indexOf("reportRenderModeOutcome(initialMainSeq"),
    "startup fallback reports after clickable recovery");
  assert.match(init, /resourceId: initialMode === "rig" \? rigSkinId/);
  assert.doesNotMatch(init, /state\.renderMode === "rig" \|\| state\.rigSkinId/);
  assert.match(config, /cfg\.renderMode === "live2d" \? "live2d"/);
});

test("current non-GIF failures fall back through the unified GIF lifecycle", () => {
  const lifecycle = bodyOf("async function switchRenderMode", "/** 主进程广播行走状态");
  assert.match(lifecycle, /renderSwitchStatus = result && result\.status === "superseded" \? "superseded" : "failed"/);
  assert.match(lifecycle, /activeRenderMode = null/);
  assert.match(lifecycle, /mode !== "gif"/);
  assert.match(lifecycle, /switchRenderMode\("gif", \{ mainSeq: context\.mainSeq \}\)/);
  assert.match(lifecycle, /requestedMode: mode/);
  assert.match(renderer, /reportRenderModeOutcome\(mainSeq, mode, result/);
  assert.match(renderer, /cleanupRigOwner\(owner\)/);
  assert.match(renderer, /destroySpineOwner\(owner\)/);
  assert.match(renderer, /destroyLive2d\(context\.token\)/);
});

test("B-2 fallback guard mutation is caught", () => {
  const lifecycle = bodyOf("async function switchRenderMode", "/** 主进程广播行走状态");
  const mutated = lifecycle.replace('mode !== "gif"', "true");
  assert.throws(() => assert.match(mutated, /mode !== "gif"/), "MUT-A 删除非 GIF fallback guard");
  assert.match(lifecycle, /mode !== "gif"/, "current GIF failure cannot recurse into GIF fallback");
  assert.match(lifecycle, /switchRenderMode\("gif", \{ mainSeq: context\.mainSeq \}\)/,
    "MUT-C direct commit bypass cannot replace the unified fallback request");
});

test("Live2D stale async owner cannot tear down the newer owner", async () => {
  const pending = [];
  const apps = [];
  const canvas = {
    isConnected: true,
    style: {},
    classList: { values: new Set(), add(...v) { v.forEach((x) => this.values.add(x)); }, remove(...v) { v.forEach((x) => this.values.delete(x)); } },
    addEventListener() {},
    removeEventListener() {}
  };
  class Application {
    constructor(options) {
      this.view = options.view;
      this.stage = { addChild() {} };
      this.renderer = { resize() {} };
      this.destroyed = false;
      this.removeView = null;
      apps.push(this);
    }
    destroy(removeView) { this.destroyed = true; this.removeView = removeView; }
  }
  function modelFor(url) {
    return {
      url,
      width: 100,
      height: 200,
      internalModel: { width: 100, height: 200, settings: { motions: {} } },
      scale: { set() {} },
      destroy() { this.destroyed = true; }
    };
  }
  const sandbox = {
    console,
    window: null,
    self: null,
    innerWidth: 300,
    innerHeight: 460,
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    PIXI: {
      Application,
      live2d: { Live2DModel: { from(url) { return new Promise((resolve) => pending.push({ url, resolve })); } } }
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(live2d, sandbox, { filename: "live2d-runtime.js" });
  const tokenA = {}, tokenB = {};
  const first = sandbox.Live2DRuntime.init(canvas, "a", tokenA);
  const second = sandbox.Live2DRuntime.init(canvas, "b", tokenB);
  const modelA = modelFor("a");
  pending[0].resolve(modelA);
  assert.equal(await first, false);
  const modelB = modelFor("b");
  pending[1].resolve(modelB);
  assert.equal(await second, true);
  assert.equal(sandbox.Live2DRuntime.destroy(tokenA), false);
  assert.equal(modelB.destroyed, undefined);
  assert.equal(sandbox.Live2DRuntime.destroy(tokenB), true);
  assert.equal(modelB.destroyed, true);
  assert.equal(apps[0].removeView, false);
  assert.equal(apps[1].removeView, false);
  assert.equal(canvas.isConnected, true);
});

function visible(element) {
  return !!element && element.style.display !== "none" && element.style.visibility !== "hidden" && !element.classList.contains("hidden");
}

function spineViews(harness) {
  return harness.elements.get("pet").children.filter((child) => child.id === "spine-canvas");
}

function assertProductionSurface(harness, mode) {
  const pet = harness.elements.get("pet");
  const sprite = harness.elements.get("sprite");
  const rig = harness.elements.get("rig-canvas");
  const live = harness.elements.get("live2d-canvas");
  const spines = spineViews(harness);
  const surfaces = [visible(sprite), spines.some(visible), visible(rig), visible(live)];
  assert.equal(surfaces.filter(Boolean).length, mode === "active-null" ? 0 : 1, `one visual surface for ${mode}: ${surfaces.join(",")}`);
  const petHit = pet.style.pointerEvents !== "none" && pet.style.display !== "none" && pet.style.visibility !== "hidden";
  if (mode === "gif") {
    assert.equal(petHit, true);
    assert.equal(visible(sprite), true);
    assert.equal(pet.classList.contains("render-inactive"), false);
  } else if (mode === "spine") {
    assert.equal(petHit, true);
    assert.equal(spines.length, 1);
    assert.equal(visible(spines[0]), true);
    assert.equal(spines[0].style.pointerEvents, "none");
  } else if (mode === "rig") {
    assert.equal(petHit, false);
    assert.equal(visible(rig), true);
    assert.equal(rig.style.pointerEvents, "auto");
  } else if (mode === "live2d") {
    assert.equal(petHit, false);
    assert.equal(visible(live), true);
    assert.equal(live.style.pointerEvents, "auto");
  } else {
    assert.equal(petHit, false);
    assert.equal(pet.classList.contains("render-inactive"), true);
    assert.equal(spines.length, 0);
    assert.equal(visible(rig), false);
    assert.equal(visible(live), false);
  }
}

function resourceFor(mode) {
  return mode === "rig" ? "rig-a" : mode === "live2d" ? "live-a" : undefined;
}

for (const [from, to] of transitions) {
  test(`production directed transition ${from} -> ${to}`, async () => {
    const harness = createPetLifecycleHarness();
    await harness.enter(from, resourceFor(from));
    const before = harness.lifecycle.getState();
    const result = await harness.enter(to, resourceFor(to));
    const after = harness.lifecycle.getState();
    assert.equal(result.status, "ready");
    assert.equal(after.active, to);
    assert.equal(after.status, "ready");
    assertProductionSurface(harness, to);
    if (from === "spine") assert.equal(before.spineApp.destroyed, true);
    if (from === "rig") assert.equal(before.rigRuntime.destroyed, true);
    if (from === "live2d") assert.equal(harness.liveOwners[0].destroyed, true);
  });
}

test("production stale Rig mode event cannot force reload after A is superseded", async () => {
  const harness = createPetLifecycleHarness();
  await harness.handlers.onRigSkinChanged("rig-a");
  const pendingFetch = [];
  harness.sandbox.fetch = async () => {
    harness.calls.fetches += 1;
    return new Promise((resolve) => pendingFetch.push(resolve));
  };
  const staleEvent = harness.handlers.onRenderModeChanged("rig");
  await wait(8);
  assert.equal(pendingFetch.length, 1);

  await harness.switch("gif");
  harness.sandbox.fetch = harness.readyFetch;
  const current = await harness.switch("rig", "rig-c");
  pendingFetch[0]({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  const stale = await staleEvent;

  assert.equal(stale, undefined);
  assert.equal(harness.calls.fetches, 2);
  assert.equal(harness.rigInstances.length, 1);
  assert.equal(harness.stateReads.calls, 0);
  assert.equal(harness.lifecycle.getState().active, "rig");
  assert.equal(harness.lifecycle.getState().generation, current.generation);
  assert.equal(harness.lifecycle.getState().resource, "rig-c");
});

test("production stale Spine mode event cannot force reload after A is superseded", async () => {
  const harness = createPetLifecycleHarness();
  harness.spineQueries.immediate = false;
  const staleEvent = harness.handlers.onRenderModeChanged("spine");
  await wait(8);
  assert.equal(harness.spineQueries.pending.length, 1);

  await harness.switch("gif");
  harness.spineQueries.immediate = true;
  const current = await harness.switch("spine");
  harness.spineQueries.pending[0].resolve({ list: [], current: "builtin" });
  const stale = await staleEvent;

  assert.equal(stale, undefined);
  assert.equal(harness.spineQueries.calls, 2);
  assert.equal(harness.apps.length, 1);
  assert.equal(spineViews(harness).length, 1);
  assert.equal(harness.stateReads.calls, 0);
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(harness.lifecycle.getState().generation, current.generation);
});

test("production stale Live2D mode event cannot force reload after A is superseded", async () => {
  const harness = createPetLifecycleHarness();
  harness.liveRuntime.immediate = false;
  const staleEvent = harness.handlers.onRenderModeChanged("live2d");
  await wait(8);
  assert.equal(harness.liveRuntime.pending.length, 1);

  await harness.switch("gif");
  harness.liveRuntime.immediate = true;
  const current = await harness.switch("live2d", "live-c");
  harness.liveRuntime.pending[0].resolve(true);
  const stale = await staleEvent;

  assert.equal(stale, undefined);
  assert.equal(harness.liveOwners.length, 2);
  assert.equal(harness.liveOwners[0].destroyed, true);
  assert.equal(harness.liveOwners[1].destroyed, false);
  assert.equal(harness.stateReads.calls, 0);
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().generation, current.generation);
});

for (const [label, settleQuery] of [
  ["rejects", (query) => query.reject(new Error("old query failed"))],
  ["resolves", (query) => query.resolve({ list: [], current: "builtin" })]
]) {
  test(`production stale Spine model query ${label} cannot steal C pending owner`, async () => {
    const harness = createPetLifecycleHarness();
    harness.spineQueries.immediate = false;
    const old = harness.switch("spine");
    await wait(8);
    const oldQuery = harness.spineQueries.pending[0];
    assert.ok(oldQuery);

    await harness.switch("gif");
    harness.spineQueries.immediate = true;
    harness.assets.hold = true;
    const current = harness.switch("spine");
    await wait(8);
    const cOwner = harness.lifecycle.getState().spinePendingOwner;
    const cApp = cOwner && cOwner.app;
    assert.ok(cOwner);
    assert.ok(cApp);
    assert.equal(harness.apps.length, 1);
    assert.equal(spineViews(harness).length, 1);

    settleQuery(oldQuery);
    const oldResult = await old;
    assert.equal(oldResult.status, "superseded");
    const afterOld = harness.lifecycle.getState();
    assert.strictEqual(afterOld.spinePendingOwner, cOwner);
    assert.equal(harness.apps.length, 1);
    assert.equal(cApp.destroyed, false);
    assert.equal(spineViews(harness).length, 1);

    await harness.switch("gif");
    assert.equal(cApp.destroyed, true);
    assert.equal(spineViews(harness).length, 0);
    for (const item of harness.assets.pending) item.resolve({ pages: [], spineData: { animations: [] } });
    await current;
  });
}

test("production Spine pending owner is destroyed immediately on GIF", async () => {
  const harness = createPetLifecycleHarness();
  harness.assets.hold = true;
  const pending = harness.switch("spine");
  await wait(8);
  const state = harness.lifecycle.getState();
  assert.ok(state.spinePendingOwner);
  assert.equal(harness.apps.length, 1);
  const gif = await harness.enter("gif");
  assert.equal(gif.status, "ready");
  assert.equal(harness.apps[0].destroyed, true);
  assert.equal(harness.apps[0].ticker.stopped, true);
  assert.equal(spineViews(harness).length, 0);
  for (const item of harness.assets.pending) item.resolve({ pages: [], spineData: { animations: [] } });
  await pending;
  assert.equal(harness.lifecycle.getState().active, "gif");
});

test("production Spine A pending -> GIF -> Spine C keeps only C", async () => {
  const harness = createPetLifecycleHarness();
  harness.assets.hold = true;
  const a = harness.switch("spine");
  await wait(8);
  const aApp = harness.apps[0];
  await harness.enter("gif");
  harness.assets.hold = false;
  const c = await harness.enter("spine");
  assert.equal(c.status, "ready");
  for (const item of harness.assets.pending) item.resolve({ pages: [], spineData: { animations: [] } });
  await a;
  assert.equal(aApp.destroyed, true);
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(spineViews(harness).length, 1);
  assert.equal(harness.lifecycle.getState().spineRuntimeOwner.app.destroyed, false);
});

test("production Spine rebuild request cannot return from 200ms delay after GIF", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  const reload = harness.handlers.onSpineSkinChanged();
  const gif = harness.handlers.onRenderModeChanged("gif");
  await Promise.all([reload, gif]);
  await wait(15);
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.equal(spineViews(harness).length, 0);
});

test("production Live2D re-entry preserves static canvas identity", async () => {
  const harness = createPetLifecycleHarness();
  const canvasBefore = harness.elements.get("live2d-canvas");
  await harness.enter("live2d", "live-a");
  await harness.enter("gif");
  await harness.enter("live2d", "live-a");
  assert.equal(harness.elements.get("live2d-canvas"), canvasBefore);
  assert.equal(canvasBefore.isConnected, true);
  assert.equal(harness.lifecycle.getState().active, "live2d");
});

test("production Live2D old pending owner cannot destroy new owner", async () => {
  const harness = createPetLifecycleHarness();
  harness.liveRuntime.immediate = false;
  const old = harness.switch("live2d", "live-a");
  await wait(8);
  await harness.enter("gif");
  const newer = harness.switch("live2d", "live-b");
  await wait(8);
  assert.equal(harness.liveRuntime.pending.length, 2);
  harness.liveRuntime.pending[0].resolve(true);
  await old;
  harness.liveRuntime.pending[1].resolve(true);
  await newer;
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.liveOwners[0].destroyed, true);
  assert.equal(harness.liveOwners[1].destroyed, false);
});

test("production Rig skin events obey the selected render mode", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("gif");
  await harness.handlers.onRigSkinChanged("rig-a");
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.equal(harness.rigInstances.length, 0);
  await harness.enter("spine");
  await harness.handlers.onRigSkinChanged("rig-b");
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(harness.rigInstances.length, 0);
});

test("production Rig resource reload falls back to GIF when the current resource disappears", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("rig", "rig-a");
  const old = harness.rigInstances[0];
  await harness.handlers.onRigSkinChanged("rig-b");
  assert.equal(harness.lifecycle.getState().active, "rig");
  assert.equal(old.destroyed, true);
  assert.equal(harness.rigInstances.length, 2);
  await harness.handlers.onRigSkinChanged(null);
  const state = harness.lifecycle.getState();
  assert.equal(state.active, "gif");
  assert.equal(state.requested, "gif");
  assert.equal(state.status, "ready");
  assertProductionSurface(harness, "gif");
});

test("production same mode and same resource is a no-op, changed resource reloads", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("rig", "rig-a");
  const created = harness.rigInstances.length;
  const noop = await harness.switch("rig", "rig-a");
  assert.equal(noop.status, "noop");
  assert.equal(harness.rigInstances.length, created);
  const reload = await harness.switch("rig", "rig-b");
  assert.equal(reload.status, "ready");
  assert.equal(harness.rigInstances.length, created + 1);
  assert.equal(harness.lifecycle.getState().active, "rig");
});

for (const mode of ["spine", "rig", "live2d"]) {
  test(`production ${mode} failure falls back to a ready GIF owner`, async () => {
    const harness = createPetLifecycleHarness();
    await harness.enter("gif");
    if (mode === "spine") {
      harness.sandbox.PIXI.spine.Spine = null;
      harness.sandbox.PIXI.Spine = null;
    } else if (mode === "rig") {
      harness.sandbox.Rigger = null;
    } else {
      harness.sandbox.petAPI.live2dList = async () => [];
    }
    const result = await harness.switch(mode, resourceFor(mode));
    assert.equal(result.status, "ready");
    assert.equal(result.fallback, true);
    assert.equal(result.requestedMode, mode);
    assert.equal(result.committedMode, "gif");
    assert.equal(harness.lifecycle.getState().active, "gif");
    assert.equal(harness.lifecycle.getState().requested, "gif");
    assert.equal(harness.lifecycle.getState().status, "ready");
    assertProductionSurface(harness, "gif");
    assert.equal(harness.lifecycle.getState().rigRuntime, null);
    assert.equal(harness.lifecycle.getState().live2dActive, false);
  });
}

test("B-2 formal Rig failure reports the current seq after GIF fallback", async () => {
  const harness = createPetLifecycleHarness();
  harness.sandbox.Rigger = null;
  await harness.handlers.onRenderModeChanged({ mode: "rig", seq: 101 });
  const state = harness.lifecycle.getState();
  assert.equal(state.active, "gif");
  assert.equal(state.requested, "gif");
  assert.equal(state.status, "ready");
  assert.equal(harness.calls.clickable.at(-1), true);
  assert.deepEqual(harness.calls.outcomes, [{
    seq: 101,
    ok: false,
    requestedMode: "rig",
    committedMode: "gif",
    error: "未选择 Rig 皮肤"
  }]);
});

test("B-2 formal Live2D failure reports fallback instead of a false ready target", async () => {
  const harness = createPetLifecycleHarness();
  harness.sandbox.petAPI.live2dList = async () => [];
  await harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 102 });
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.equal(harness.lifecycle.getState().status, "ready");
  assert.equal(harness.calls.outcomes.length, 1);
  assert.deepEqual(harness.calls.outcomes[0], {
    seq: 102,
    ok: false,
    requestedMode: "live2d",
    committedMode: "gif",
    error: "未找到 Live2D 模型"
  });
});

test("B-2 A -> B -> C rejects A delayed failure and reports only current C", async () => {
  const harness = createPetLifecycleHarness();
  harness.liveRuntime.immediate = false;
  const a = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 201 });
  await wait(8);
  await harness.handlers.onRenderModeChanged({ mode: "gif", seq: 202 });
  const c = harness.handlers.onRenderModeChanged({ mode: "spine", seq: 203 });
  await c;
  harness.liveRuntime.pending[0].resolve(false);
  await a;
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(harness.lifecycle.getState().status, "ready");
  assert.equal(harness.calls.outcomes.some((o) => o.seq === 201), false);
  assert.equal(harness.calls.outcomes.at(-1).seq, 203);
});

test("B-2 A -> B -> A keeps the second A and ignores the first A result", async () => {
  const harness = createPetLifecycleHarness();
  harness.liveRuntime.immediate = false;
  const firstA = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 301 });
  await wait(8);
  await harness.handlers.onRenderModeChanged({ mode: "gif", seq: 302 });
  const secondA = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 303 });
  await wait(8);
  assert.equal(harness.liveRuntime.pending.length, 2);
  harness.liveRuntime.pending[0].resolve(true);
  await firstA;
  assert.equal(harness.calls.outcomes.some((o) => o.seq === 301), false);
  harness.liveRuntime.pending[1].resolve(true);
  await secondA;
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 303,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  });
});

test("B-2 fallback GIF cannot overwrite a later Spine intent", async () => {
  const harness = createPetLifecycleHarness();
  const fallback = await harness.switch("rig", "");
  assert.equal(fallback.fallback, true);
  const spine = await harness.switch("spine");
  assert.equal(spine.status, "ready");
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 preserves open input draft and bubble while restoring the GIF owner", async () => {
  const harness = createPetLifecycleHarness();
  harness.elements.get("input").value = "draft text";
  harness.elements.get("bubble").style.display = "";
  harness.sandbox.Rigger = null;
  await harness.handlers.onRenderModeChanged({ mode: "rig", seq: 401 });
  assert.equal(harness.elements.get("input").value, "draft text");
  assert.equal(harness.elements.get("bubble").style.display, "");
  assertProductionSurface(harness, "gif");
});

test("B-2 fallback restores pointer semantics used by the existing drag path", async () => {
  const harness = createPetLifecycleHarness();
  harness.sandbox.Rigger = null;
  await harness.handlers.onRenderModeChanged({ mode: "rig", seq: 402 });
  const pet = harness.elements.get("pet");
  const sprite = harness.elements.get("sprite");
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.equal(pet.style.pointerEvents, "auto");
  assert.equal(sprite.style.pointerEvents, "none");
  assert.equal(harness.calls.clickable.at(-1), true);
});

test("B-2 internal Rig clear-skin reports an independent correction", async () => {
  const harness = createPetLifecycleHarness();
  const initial = await harness.lifecycle.switchRenderMode("rig", { mainSeq: 10, resourceId: "rig-a" });
  assert.equal(initial.status, "ready");
  harness.sandbox.Rigger = null;
  await harness.handlers.onRigSkinChanged("");
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.deepEqual(harness.calls.corrections, [{
    baseSeq: 10,
    sourceMode: "rig",
    committedMode: "gif",
    error: "未选择 Rig 皮肤"
  }]);
});

test("B-2 internal Spine failure reports correction but successful rebuild does not", async () => {
  const harness = createPetLifecycleHarness();
  const initial = await harness.lifecycle.switchRenderMode("spine", { mainSeq: 20 });
  assert.equal(initial.status, "ready");
  await harness.handlers.onSpineSkinChanged();
  assert.equal(harness.calls.corrections.length, 0);

  harness.sandbox.PIXI.spine.Spine = null;
  harness.sandbox.PIXI.Spine = null;
  await harness.handlers.onSpineSkinChanged();
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.deepEqual(harness.calls.corrections.at(-1), {
    baseSeq: 20,
    sourceMode: "spine",
    committedMode: "gif",
    error: "Spine 构造器未加载"
  });
});

test("B-2 internal Live2D reload reports correction only on fallback", async () => {
  const harness = createPetLifecycleHarness();
  const initial = await harness.lifecycle.switchRenderMode("live2d", { mainSeq: 30, resourceId: "live-a" });
  assert.equal(initial.status, "ready");
  await harness.handlers.onLive2dChanged("live-b");
  assert.equal(harness.calls.corrections.length, 0);

  harness.sandbox.petAPI.live2dList = async () => [];
  await harness.handlers.onLive2dChanged("live-b");
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.deepEqual(harness.calls.corrections.at(-1), {
    baseSeq: 30,
    sourceMode: "live2d",
    committedMode: "gif",
    error: "未找到 Live2D 模型"
  });
});

test("B-2 internal fallback correction is rejected when its baseSeq becomes stale", async () => {
  const harness = createPetLifecycleHarness();
  const initial = await harness.lifecycle.switchRenderMode("live2d", { mainSeq: 40, resourceId: "live-a" });
  assert.equal(initial.status, "ready");
  harness.sandbox.petAPI.live2dList = async () => [];
  await harness.handlers.onLive2dChanged("live-b");
  assert.equal(harness.calls.corrections.length, 1);
  const decision = renderMode.renderModeCorrectionDecision({
    currentSeq: 41,
    currentSourceMode: "live2d",
    correction: harness.calls.corrections[0]
  });
  assert.deepEqual(decision, { accepted: false, reason: "stale" });
  assert.equal(harness.lifecycle.getState().active, "gif");
});

test("B-2 formal noop still reports the current seq", async () => {
  const harness = createPetLifecycleHarness();
  await harness.lifecycle.switchRenderMode("gif", { mainSeq: 50 });
  await harness.handlers.onRenderModeChanged({ mode: "gif", seq: 51 });
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 51,
    ok: true,
    requestedMode: "gif",
    committedMode: "gif",
    error: undefined
  });
});

test("B-2 stale formal noop is ignored without an outcome", async () => {
  const harness = createPetLifecycleHarness();
  await harness.lifecycle.switchRenderMode("gif", { mainSeq: 60 });
  await harness.handlers.onRenderModeChanged({ mode: "gif", seq: 59 });
  assert.equal(harness.calls.outcomes.length, 0);
  assert.equal(harness.lifecycle.getState().active, "gif");
});

test("B-2 formal Live2D superseded by successful internal reskin still reports formal success", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  let listCalls = 0;
  let releaseFormalList;
  harness.sandbox.petAPI.live2dList = () => {
    listCalls += 1;
    if (listCalls === 1) return new Promise((resolve) => { releaseFormalList = resolve; });
    return Promise.resolve([{ id: "live-b", name: "live-b", url: "live-b.model3.json" }]);
  };
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 501 });
  await wait(8);
  const reskin = harness.handlers.onLive2dChanged("live-b");
  await reskin;
  releaseFormalList([{ id: "live-a", name: "live-a", url: "live-a.model3.json" }]);
  await formal;
  assert.deepEqual(harness.calls.corrections, []);
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 501,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  });
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 formal Rig superseded by successful internal reskin still reports formal success", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ rig: "rig-a" });
  let fetchCalls = 0;
  let releaseFormalFetch;
  harness.sandbox.fetch = () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Promise((resolve) => { releaseFormalFetch = resolve; });
    return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(64) });
  };
  const formal = harness.handlers.onRenderModeChanged({ mode: "rig", seq: 502 });
  await wait(8);
  const reskin = harness.handlers.onRigSkinChanged("rig-b");
  await reskin;
  releaseFormalFetch({ ok: true, arrayBuffer: async () => new ArrayBuffer(64) });
  await formal;
  assert.deepEqual(harness.calls.corrections, []);
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 502,
    ok: true,
    requestedMode: "rig",
    committedMode: "rig",
    error: undefined
  });
  assert.equal(harness.lifecycle.getState().active, "rig");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 formal Spine superseded by successful internal rebuild still reports formal success", async () => {
  const harness = createPetLifecycleHarness();
  harness.spineQueries.immediate = false;
  const formal = harness.handlers.onRenderModeChanged({ mode: "spine", seq: 503 });
  await wait(8);
  const reskin = harness.handlers.onSpineSkinChanged();
  await wait(8);
  assert.equal(harness.spineQueries.pending.length, 2);
  harness.spineQueries.pending[1].resolve({ list: [], current: "builtin" });
  await reskin;
  harness.spineQueries.pending[0].resolve({ list: [], current: "builtin" });
  await formal;
  assert.deepEqual(harness.calls.corrections, []);
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 503,
    ok: true,
    requestedMode: "spine",
    committedMode: "spine",
    error: undefined
  });
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 formal superseded by internal fallback reports correction without target success", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  let listCalls = 0;
  let releaseFormalList;
  harness.sandbox.petAPI.live2dList = () => {
    listCalls += 1;
    if (listCalls === 1) return new Promise((resolve) => { releaseFormalList = resolve; });
    return Promise.resolve([]);
  };
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 504 });
  await wait(8);
  const reskin = harness.handlers.onLive2dChanged("live-b");
  await reskin;
  releaseFormalList([{ id: "live-a", name: "live-a", url: "live-a.model3.json" }]);
  await formal;
  assert.equal(harness.calls.outcomes.some((outcome) => outcome.seq === 504), false);
  assert.deepEqual(harness.calls.corrections, [{
    baseSeq: 504,
    sourceMode: "live2d",
    committedMode: "gif",
    error: "未找到 Live2D 模型"
  }]);
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 newer main seq suppresses old formal reconciliation", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  let listCalls = 0;
  let releaseOldFormalList;
  harness.sandbox.petAPI.live2dList = () => {
    listCalls += 1;
    if (listCalls === 1) return new Promise((resolve) => { releaseOldFormalList = resolve; });
    return Promise.resolve([{ id: "live-b", name: "live-b", url: "live-b.model3.json" }]);
  };
  const oldFormal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 505 });
  await wait(8);
  await harness.handlers.onLive2dChanged("live-b");
  const newerFormal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 506 });
  await newerFormal;
  releaseOldFormalList([{ id: "live-a", name: "live-a", url: "live-a.model3.json" }]);
  await oldFormal;
  assert.equal(harness.calls.outcomes.some((outcome) => outcome.seq === 505), false);
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 506,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  });
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 active mode mismatch suppresses formal reconciliation", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  let releaseFormalList;
  harness.sandbox.petAPI.live2dList = () => new Promise((resolve) => { releaseFormalList = resolve; });
  const oldFormal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 507 });
  await wait(8);
  await harness.lifecycle.switchRenderMode("gif");
  releaseFormalList([{ id: "live-a", name: "live-a", url: "live-a.model3.json" }]);
  await oldFormal;
  assert.equal(harness.calls.outcomes.some((outcome) => outcome.seq === 507), false);
  assert.deepEqual(harness.lifecycle.getState().active, "gif");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 post-getState reconciliation closes the Live2D liveness gap", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  harness.sandbox.petAPI.live2dList = async () => [
    { id: "live-a", name: "live-a", url: "live-a.model3.json" },
    { id: "live-b", name: "live-b", url: "live-b.model3.json" }
  ];
  harness.stateReads.hold = true;
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 601 });
  await wait(8);
  assert.equal(harness.stateReads.pending.length, 1);
  await harness.handlers.onLive2dChanged("live-b");
  harness.releaseStateReads();
  await formal;
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 601,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  });
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 post-getState reconciliation closes the Rig liveness gap", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ rig: "rig-a" });
  harness.stateReads.hold = true;
  const formal = harness.handlers.onRenderModeChanged({ mode: "rig", seq: 602 });
  await wait(8);
  assert.equal(harness.stateReads.pending.length, 1);
  await harness.handlers.onRigSkinChanged("rig-b");
  harness.releaseStateReads();
  await formal;
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 602,
    ok: true,
    requestedMode: "rig",
    committedMode: "rig",
    error: undefined
  });
  assert.equal(harness.lifecycle.getState().active, "rig");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 formal reconciliation follows R1 -> R2 owner succession", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  harness.sandbox.petAPI.live2dList = async () => [
    { id: "live-a", name: "live-a", url: "live-a.model3.json" },
    { id: "live-b", name: "live-b", url: "live-b.model3.json" },
    { id: "live-c", name: "live-c", url: "live-c.model3.json" }
  ];
  harness.stateReads.hold = true;
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 603 });
  await wait(8);
  harness.liveRuntime.immediate = false;
  const r1 = harness.handlers.onLive2dChanged("live-b");
  await wait(8);
  assert.equal(harness.liveRuntime.pending.length, 1, "R1 reskin remains pending");
  harness.releaseStateReads();
  await wait(8);

  harness.liveRuntime.immediate = true;
  const r2 = harness.handlers.onLive2dChanged("live-c");
  await r2;
  const staleR1 = harness.liveRuntime.pending.shift();
  assert.ok(staleR1, "R1 pending owner is retained until it settles");
  staleR1.resolve(true);
  await Promise.all([r1, formal]);
  assert.deepEqual(harness.calls.outcomes.filter((outcome) => outcome.seq === 603), [{
    seq: 603,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  }]);
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 formal reconciliation follows R1 -> R2 -> R3 owner succession once", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  harness.sandbox.petAPI.live2dList = async () => [
    { id: "live-a", name: "live-a", url: "live-a.model3.json" },
    { id: "live-b", name: "live-b", url: "live-b.model3.json" },
    { id: "live-c", name: "live-c", url: "live-c.model3.json" },
    { id: "live-d", name: "live-d", url: "live-d.model3.json" }
  ];
  harness.stateReads.hold = true;
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 604 });
  await wait(8);
  harness.liveRuntime.immediate = false;
  const r1 = harness.handlers.onLive2dChanged("live-b");
  await wait(8);
  harness.releaseStateReads();
  await wait(8);
  const r2 = harness.handlers.onLive2dChanged("live-c");
  await wait(8);
  const staleR1 = harness.liveRuntime.pending.shift();
  assert.ok(staleR1, "R1 pending owner is retained until it settles");
  staleR1.resolve(true);
  await wait(8);

  harness.liveRuntime.immediate = true;
  const r3 = harness.handlers.onLive2dChanged("live-d");
  await r3;
  for (const pending of harness.liveRuntime.pending.splice(0)) pending.resolve(true);
  await Promise.all([r1, r2, r3, formal]);
  assert.deepEqual(harness.calls.outcomes.filter((outcome) => outcome.seq === 604), [{
    seq: 604,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  }]);
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 fallback owner succession never reconciles the formal target", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  let listCalls = 0;
  harness.sandbox.petAPI.live2dList = async () => {
    listCalls += 1;
    return listCalls === 1 ? [{ id: "live-a", name: "live-a", url: "live-a.model3.json" }] : [];
  };
  harness.stateReads.hold = true;
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 605 });
  await wait(8);
  const r1 = harness.handlers.onLive2dChanged("live-b");
  await r1;
  harness.releaseStateReads();
  await formal;
  assert.equal(harness.calls.outcomes.some((outcome) => outcome.seq === 605), false);
  assert.equal(harness.calls.corrections.length, 1);
  assert.equal(harness.lifecycle.getState().active, "gif");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 newer main seq suppresses a post-getState old formal", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  harness.sandbox.petAPI.live2dList = async () => [{ id: "live-a", name: "live-a", url: "live-a.model3.json" }];
  harness.stateReads.hold = true;
  const oldFormal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 606 });
  await wait(8);
  harness.stateReads.hold = false;
  const newerFormal = harness.handlers.onRenderModeChanged({ mode: "gif", seq: 607 });
  await newerFormal;
  harness.releaseStateReads();
  await oldFormal;
  assert.equal(harness.calls.outcomes.some((outcome) => outcome.seq === 606), false);
  assert.deepEqual(harness.calls.outcomes.at(-1), {
    seq: 607,
    ok: true,
    requestedMode: "gif",
    committedMode: "gif",
    error: undefined
  });
});

test("B-2 resource correction re-switch superseded by internal reskin still reconciles", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setResourceIds({ live2d: "live-a" });
  let listCalls = 0;
  harness.sandbox.petAPI.live2dList = async () => {
    listCalls += 1;
    const id = listCalls === 1 ? "live-a" : listCalls === 2 ? "live-b" : "live-c";
    return [{ id, name: id, url: id + ".model3.json" }];
  };
  let releaseState;
  harness.sandbox.petAPI.getState = () => new Promise((resolve) => {
    releaseState = () => resolve({ renderMode: "gif", rigSkinId: "", live2dSkinId: "live-b" });
  });
  const formal = harness.handlers.onRenderModeChanged({ mode: "live2d", seq: 608 });
  await wait(8);
  harness.liveRuntime.immediate = false;
  releaseState();
  await wait(8);
  assert.equal(harness.liveRuntime.pending.length, 1, "formal resource correction re-switch remains pending");

  harness.liveRuntime.immediate = true;
  const internal = harness.handlers.onLive2dChanged("live-c");
  await internal;
  const staleCorrectionReswitch = harness.liveRuntime.pending.shift();
  assert.ok(staleCorrectionReswitch, "superseded formal re-switch owner is retained");
  staleCorrectionReswitch.resolve(true);
  await formal;
  assert.deepEqual(harness.calls.outcomes.filter((outcome) => outcome.seq === 608), [{
    seq: 608,
    ok: true,
    requestedMode: "live2d",
    committedMode: "live2d",
    error: undefined
  }]);
  assert.deepEqual(harness.calls.corrections, []);
  assert.equal(harness.lifecycle.getState().active, "live2d");
  assert.equal(harness.lifecycle.getState().status, "ready");
});

test("B-2 Spine skin event outside Spine does not start an internal rebuild", async () => {
  const harness = createPetLifecycleHarness();
  const spineQueriesBefore = harness.spineQueries.calls;
  const appsBefore = harness.apps.length;
  await harness.handlers.onSpineSkinChanged();
  assert.equal(harness.spineQueries.calls, spineQueriesBefore);
  assert.equal(harness.apps.length, appsBefore);
  assert.equal(harness.lifecycle.getState().active, null);
  assert.equal(harness.lifecycle.getState().requested, "gif");
});

test("production GIF/Spine commits restore base window and appearance size", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("rig", "rig-a");
  await harness.enter("gif");
  assert.deepEqual(harness.calls.sizes.at(-1), [260, 200, "render-mode"]);
  await harness.enter("live2d", "live-a");
  await harness.enter("spine");
  assert.deepEqual(harness.calls.sizes.at(-1), [260, 200, "render-mode"]);
});

test("production Spine initial fit runs for the committed owner generation", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await wait(12);
  const owner = harness.lifecycle.getState().spineRuntimeOwner;
  assert.ok(owner);
  assert.ok(owner.obj.getBounds().width > 0);
  assert.equal(owner.context.generation, harness.lifecycle.getState().generation);
});

test("production mood reset survives render-mode switch while GIF preload stays stale", async () => {
  const harness = createPetLifecycleHarness();
  harness.lifecycle.setMoods([{ name: "idle", emotion: "" }, { name: "happy", emotion: "happy" }]);
  await harness.enter("gif");
  harness.lifecycle.scheduleMoodReset("happy");
  await harness.enter("rig", "rig-a");
  await wait(12);
  assert.equal(harness.elements.get("pet").dataset.mood, "idle");

  await harness.enter("gif");
  harness.lifecycle.setMood("happy");
  const oldImage = harness.images[0];
  await harness.enter("live2d", "live-a");
  if (oldImage && oldImage.onload) oldImage.onload();
  await wait(8);
  assert.equal(harness.elements.get("sprite").src, "");
  assert.equal(harness.lifecycle.getState().active, "live2d");
});

test("production Spine ABA A -> Live2D B -> Spine C leaves only C", async () => {
  const harness = createPetLifecycleHarness();
  harness.assets.hold = true;
  const a = harness.switch("spine");
  await wait(8);
  harness.liveRuntime.immediate = false;
  const b = harness.switch("live2d", "live-b");
  await wait(8);
  harness.assets.hold = false;
  const c = await harness.switch("spine");
  assert.equal(c.status, "ready");
  if (harness.liveRuntime.pending[0]) harness.liveRuntime.pending[0].resolve(true);
  for (const item of harness.assets.pending) item.resolve({ pages: [], spineData: { animations: [] } });
  await Promise.all([a, b]);
  assert.equal(harness.lifecycle.getState().active, "spine");
  assert.equal(spineViews(harness).length, 1);
  assert.equal(harness.apps[0].destroyed, true);
});

test("production pointer semantics cover GIF, Spine, Rig, Live2D and fallback GIF", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("gif");
  assertProductionSurface(harness, "gif");
  await harness.enter("spine");
  assertProductionSurface(harness, "spine");
  await harness.enter("rig", "rig-a");
  assertProductionSurface(harness, "rig");
  await harness.enter("live2d", "live-a");
  assertProductionSurface(harness, "live2d");
  await harness.switch("rig", "");
  assertProductionSurface(harness, "gif");
});

test("no unused legacy lifecycle implementation remains", () => {
  assert.doesNotMatch(renderer, /_legacy(?:Init|Destroy|SetRenderMode)/);
});

console.log("render lifecycle contract 全部通过");

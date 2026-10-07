"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const renderMode = require("../src/render-mode");

const renderer = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n"); // EOL 鲁棒性：字面量/mutation 匹配不再依赖检出端 CRLF/LF
const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8"); // P2-16/17 Phase1 冻结合同引用
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

function createPetLifecycleHarness(opts = {}) {
  const handlers = {};
  const calls = { sizes: [], clickable: [], playback: [], outcomes: [], outcomeVis: [], corrections: [], bodyReadies: [], asks: [], stops: [], regenerates: [], walkingPauses: [], regenerateResult: true, fetches: 0 };
  const elements = new Map();
  let sampleAlpha = 255; // T11：置 0 可造“永不产生有效轮廓”的异常模型（sample 恒 null → 无 TARGET）
  const nativeSetTimeout = setTimeout;
  const nativeClearTimeout = clearTimeout;
  const timers = opts.clock || {
    // 时钟压缩保留原 5ms 快道；仅 ≥4000ms 延迟（bootstrap failsafe 5000/fit 尾 pass 4200）入慢道，
    // 让正常路径在测试世界里与真机一样先 ready 后 failsafe（why==="ready" 可断言）。
    setTimeout(fn, ms, ...args) { const d = Number(ms) || 0; return nativeSetTimeout(fn, d >= 4000 ? 20000 : Math.min(d, 5), ...args); },
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
        renderCalls: 0,
        resize() {},
        render(obj, options = {}) {
          this.renderCalls += 1;
          if (opts.geometry && options.renderTexture) {
            options.renderTexture.pose = { x: obj.x, y: obj.y, sx: obj.scale.x, sy: obj.scale.y,
              geometry: obj.auditGeometry, transform: options.transform };
          }
        },
        extract: { pixels: (rt) => {
          const pixels = new Uint8Array(rt.width * rt.height * 4);
          if (opts.geometry && rt.pose?.geometry) {
            const p = rt.pose, m = p.transform || { a: 1, d: 1, tx: 0, ty: 0 };
            for (const r of p.geometry.visible) {
              const xx = [r.x, r.x + r.width].map(x => m.a * (p.x + x * p.sx) + m.tx);
              const yy = [r.y, r.y + r.height].map(y => m.d * (p.y + y * p.sy) + m.ty);
              for (let y = Math.max(0, Math.ceil(Math.min(...yy))); y < Math.min(rt.height, Math.max(...yy)); y++)
                for (let x = Math.max(0, Math.ceil(Math.min(...xx))); x < Math.min(rt.width, Math.max(...xx)); x++)
                  pixels[(y * rt.width + x) * 4 + 3] = sampleAlpha;
            }
            return pixels;
          }
          pixels[3] = sampleAlpha;
          return pixels;
        } }
      };
      this.ticker = {
        listeners: new Set(),
        started: true,
        stopped: false,
        maxFPS: 60,
        add(fn) { this.listeners.add(fn); },
        remove(fn) { this.listeners.delete(fn); },
        step(frames = 1) { for (const fn of [...this.listeners]) fn(frames); },
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
      // fitSpinePose 经 position.set 移动对象（Pixi DisplayObject 语义）：与 x/y 互为别名，缺失会让整个 fit 在 try 里静默夭折
      this.position = { set: (x, y = x) => { this.x = x; this.y = y; } };
      this.state = {
        data: { defaultMix: 0 },
        timeScale: 1,
        current: null,
        getCurrent: () => this.state.current,
        // —— T2：以下 entry 生命周期对齐打包 pixi-spine 3.8 源码（见 pet.js refresh 注释）——
        newEntry: (name, loop, delay) => ({
          animation: { name }, loop, delay,
          animationStart: 0, animationEnd: 1, trackTime: 0, trackLast: -1,
          next: null, released: false, mixDuration: this.state.data.defaultMix, mixTime: 0, mixingFrom: null
        }),
        setAnimation: (_track, name, loop) => {
          // setAnimationWith：旧 current 结束 + disposeNext 丢弃其排队链 + 新 head（delay=0 直起）
          const old = this.state.current;
          if (old) { this.state.disposeNext(old); old.released = true; }
          const e = this.state.newEntry(name, loop, 0);
          this.state.current = e;
          return e;
        },
        addAnimation: (_track, name, loop, delay) => {
          const e = this.state.newEntry(name, loop, delay);
          const cur = this.state.current;
          if (cur) {
            let last = cur; while (last.next) last = last.next;
            if (delay !== undefined && delay <= 0) {
              // 真实 addAnimationWith i<=0 分支：非 loop last → Math.max(dur, trackTime) - mix
              const L = last.animationEnd - last.animationStart;
              e.delay = L !== 0 ? Math.max(L, last.trackTime) - (this.state.data.defaultMix || 0) : last.trackTime;
            }
            // delay===undefined：如实保留 undefined（= 生产 NaN 晋升毒形态，绝不静默兜 0）
            last.next = e;
          } else this.state.current = e;
          return e;
        },
        // 官方摘链例程（bundle: for(n=t.next; n;) queue.dispose(n)...; t.next=null）——
        // fake 以 released 标记表达"事件丢弃 + trackEntryPool.free"
        disposeNext: (t) => { let n = t.next; for (; n != null;) { const nx = n.next; n.released = true; n = nx; } t.next = null; },
        clearTrack: (track) => { if (track === 0) { const n = this.state.current; if (n) { this.state.disposeNext(n); n.released = true; } this.state.current = null; } }
      };
      this.destroyed = false;
    }
    update(delta = 0) {
      this.updateCalls = (this.updateCalls || 0) + 1;
      // T2：真实晋升门——非 loop current 到末帧后，next.delay 必须为有限数才 setCurrent 晋升；
      // undefined delay ⇒ trackLast - delay = NaN ⇒ 永不晋升（生产 15:35 定身事故的形态复刻）
      const cur = this.state.current;
      if (!cur) return;
      cur.trackTime += delta;
      if (cur.loop === false && cur.trackTime >= cur.animationEnd && cur.next && Number.isFinite(cur.next.delay)) {
        this.state.current = cur.next;
      }
    }
    updateTransform() {}
    getBounds() { // mirrorShiftX：真实皮肤骨骼非对称（镜像后 bbox 左移 m px）的测试侧模拟；默认 0=与旧 fake 逐字节一致
      const m = this.scale.x < 0 ? (this.mirrorShiftX || 0) : 0;
      return { x: this.x - m, y: this.y - this.height, width: this.width, height: this.height };
    }
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
    reportRenderModeOutcome(outcome) { calls.outcomes.push({ ...outcome }); calls.outcomeVis.push(apps.length ? visible(apps[apps.length - 1].view) : null); }, // A23-T4：记录上报时刻 view 是否已可见（ready 不得早于首见）
    reportRenderModeCorrection(correction) { calls.corrections.push({ ...correction }); },
    playback(message) { calls.playback.push(String(message)); },
    edgeDiag: !!(opts && opts.edgeDiag), // EDGEDIAG 探针默认恒关（proxy 对未知属性返回函数=truthy，必须显式布尔）；EDGE-T 用例传 true
    speechDiag: !!(opts && opts.speechDiag), // SPEECHDIAG：默认关（=生产路径）；SPEECH-D 用例传 {speechDiag:true} 开启
    seatExitForensic: !!(opts && opts.seatExitForensic), // E1：默认关；ON 只收集 bounded 只读记录
    standBeatPose: !!(opts && opts.standBeatPose), // E2：仅允许带 stand intent 的窄 pose admission
    setGroundGap() {}, setCharInset() {}, setHasSit() {}, setSleeping() {}, bodyReady(meta) { calls.bodyReadies.push(meta || null); }, walkingEngineStop() {},
    ask: async (text, id) => { calls.asks.push({ text, id }); },
    stop: (id) => { calls.stops.push(id); },
    regenerate: (id) => { calls.regenerates.push(id); return calls.regenerateResult; },
    walkingPause: (...args) => { calls.walkingPauses.push(args); }, moveWindow() {}, hideWindow() {}, reloadRenderer() {}, pat() {}, throwPet() {},
    getAppearance: async () => null, getInfo: async () => ({})
  }, {
    get(target, property) {
      if (property in target) return target[property];
      if (String(property).startsWith("on")) return (callback) => { handlers[property] = callback; };
      return () => undefined;
    }
  });

  // HPAT-9/10：捕获 window 级监听器（生产 pointerup/pointermove 驱动 finishDrag），按需派发；
  // 捕获本身惰性，不派发则与旧 no-op 零差别。
  const windowListeners = new Map();
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
    Date: opts.clock ? class extends Date { static now() { return opts.clock.now; } } : Date,
    requestAnimationFrame: (fn) => timers.setTimeout(fn, 0),
    cancelAnimationFrame: timers.clearTimeout,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener(type, fn) { const arr = windowListeners.get(type); if (arr) arr.push(fn); else windowListeners.set(type, [fn]); },
    removeEventListener(type, fn) { const arr = windowListeners.get(type); if (arr) windowListeners.set(type, arr.filter((f) => f !== fn)); },
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
    SeatFit: require("../src/seat-fit"), // A-v2 seat-hold/棘轮纯函数（同上先例）
    AnimationWatch: require("../src/animation-watch"), // POKE-S：trackDecision 真值表（生产经 <script> 挂 window）
    CharacterSleepIntent: require("../src/character-runtime/sleep-intent"), // Phase 6-D.3：入睡阈值策略与渲染层消费校验（双端纯函数）
    PIXI: {
      Matrix: require("pixi.js").Matrix,
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
    dispatchWindow(type, event) { // HPAT-9/10：向生产 window 监听器派发事件（pointerup/pointermove 等）
      const arr = windowListeners.get(type);
      if (!arr) return false;
      for (const fn of [...arr]) fn(event);
      return true;
    },
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
    setSampleAlpha(a) { sampleAlpha = a; },
    async switch(mode, resourceId) {
      const options = resourceId === undefined ? {} : { resourceId };
      return lifecycle.switchRenderMode(mode, options);
    },
    async enter(mode, resourceId) {
      const result = await this.switch(mode, resourceId);
      await wait(8);
      for (let i = 0; i < 10 && mode === "spine" && result.status === "ready" && (lifecycle.getState().bootstrap || {}).pending; i += 1) await wait(4);
      return result; // A21：spine enter 等 pre-visible bootstrap gate 收敛后再返回（假 timer 压缩 ≤5ms，正常 1~2 轮即释放）
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
  for (let i = 0; i < 10 && (harness.lifecycle.getState().bootstrap || {}).pending; i += 1) await wait(4); // A21：等 pre-visible gate 释放（延后的 replay 在释放时兑现）
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
  await wait(40); // A23：spine 的 outcome 上报等 owner-bootstrap 首见（done release 由压缩计时的 fit pass 驱动）
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
  await wait(40); // A23：reconcile 的 spine outcome 同样等 owner-bootstrap 首见（reskin 新 owner 的 release 由压缩 pass 驱动）
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

/* ---------- A 修复：Spine fit 收敛窗口锚定 owner 生命周期边界，不再依赖“第一次走动” ---------- */
// 可观测效应：fit pass 会移动/缩放 owner.obj——initSpine 原始放置 x=130，fit 收敛后 fake 确定性落在 x=160
// （FakeSpine 的 extract 轮廓恒在 (0,0)：keepScale 推入循环饱和 10 次后收敛）。
// 修复前若皮肤派生不出 idle 名（animations 空），init 完全不布置 fit 窗口，owner 永远停在 x=130，
// 直到第一次走动/相位事件被动重锚——即实机“冷启动偏小、走两步才对”机理在测试世界的同构投影。
async function enterSpineWithEmptyAnims() {
  const harness = createPetLifecycleHarness();
  harness.assets.hold = true;
  const p = harness.switch("spine");
  const emptySpine = { pages: [], spineData: { animations: [] } };
  for (let round = 0; round < 12; round += 1) {
    await wait(4);
    for (const item of harness.assets.pending) item.resolve(emptySpine); // atlas/skel 两批 load 都要排空（重复 resolve 无害）
  }
  const r = await p;
  assert.equal(r.status, "ready");
  return harness;
}

test("A-T1/A-T7: skin with no derivable idle anim still arms fit at owner ready (no walk/phase event needed)", async () => {
  const harness = await enterSpineWithEmptyAnims();
  const owner = harness.lifecycle.getState().spineRuntimeOwner;
  assert.ok(owner && owner.obj);
  await wait(24); // 压缩计时器（每 pass ≤5ms）下 fit 窗口完整收敛
  assert.equal(owner.obj.x, 160, "无 animName 也必须完成 fit（修复前：init 不布置 fit，x 停在 initSpine 原始放置 130，直到走动才被动纠正）");
});

test("A-T2/T4: re-entry (GIF→Spine) new owner converges deterministically without any walk event", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  const owner1 = harness.lifecycle.getState().spineRuntimeOwner;
  await wait(24);
  assert.equal(owner1.obj.x, 160);
  const scale1 = owner1.obj.scale.y;
  await harness.enter("gif");
  await harness.enter("spine");
  const owner2 = harness.lifecycle.getState().spineRuntimeOwner;
  assert.ok(owner2 && owner2 !== owner1);
  await wait(24);
  assert.equal(owner2.obj.x, 160);
  assert.equal(owner2.obj.scale.y, scale1, "re-entry 立即确定性重放同一 scale（不依赖走动态势）");
});

test("A-T6: fit convergence is idempotent across windows", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await wait(24);
  const owner = harness.lifecycle.getState().spineRuntimeOwner;
  const s1 = owner.obj.scale.y;
  const x1 = owner.obj.x;
  await wait(48); // 双份窗口时长后仍稳定
  assert.equal(owner.obj.scale.y, s1);
  assert.equal(owner.obj.x, x1);
});

test("A-T8: after GIF takeover, dead owner's pending fit timers are inert (last-wins generation guard)", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await wait(24);
  const objRef = harness.lifecycle.getState().spineRuntimeOwner.obj; // destroy 会置空 owner.obj 引用，先抓实例
  const s1 = objRef.scale.y;
  const x1 = objRef.x;
  await harness.enter("gif");
  await wait(48); // 旧 owner 残留 fit 计时若触达旧对象会改变 scale/x
  assert.equal(objRef.scale.y, s1, "旧 owner fit pass 必须被 generation/owner 守卫静默吞掉");
  assert.equal(objRef.x, x1);
  assert.equal(harness.lifecycle.getState().active, "gif");
});

test("A-contract: fit armed at owner-ready AND at commit; GIF commit untouched", () => {
  assert.match(renderer, /if \(animName\) setSpineAnim\(animName, true, "init"\);\n\s*scheduleFitSpine\(\{\}\);/, "init 无条件布置 fit（animName 分支只负责动画）");
  const commitBlock = renderer.slice(renderer.indexOf("function commitRenderMode"), renderer.indexOf("async function switchRenderMode"));
  const spineCase = commitBlock.slice(commitBlock.indexOf('if (mode === "spine")'), commitBlock.indexOf('if (mode === "rig")'));
  assert.match(spineCase, /spineApp\.view\.style\.pointerEvents = "none";\n\s*\}\n\s*scheduleFitSpine\(\{\}\);/, "commit 在画布恢复可见/尺寸落定后重新锚定 fit 窗口");
  const gifCase = commitBlock.slice(commitBlock.indexOf('if (mode === "gif")'), commitBlock.indexOf('if (mode === "spine")'));
  assert.doesNotMatch(gifCase, /scheduleFitSpine/, "GIF commit 不加 fit（GIF 不受影响，T9 无回归）");
});

test("A2-T1/T3/T5: seat-held window debt is repaid at release; sit→move keeps fitted scale", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await wait(24); // init/commit 窗口完整跑完：autoScale 收敛（fake 8px 轮廓 → kk 钳到 5）
  const st1 = harness.lifecycle.getState();
  assert.equal(st1.fit.autoScaled, true, "前置：autoScale 已确立");
  assert.equal(st1.fit.keepScale, true);
  const owner = st1.spineRuntimeOwner;
  const scaleFitted = owner.obj.scale.y;
  harness.handlers.onWalking({ active: false, resting: false, seated: true, perched: false, paused: false, sleeping: false, face: 1 });
  await wait(16); // seatPhase 窗口全部 pass 被 seat-hold 吞掉
  assert.equal(harness.lifecycle.getState().seatEpisode.pendingFit, true, "T1: hold 只标 pendingFit——不再测量、不动 scale");
  assert.equal(owner.obj.scale.y, scaleFitted, "T5: hold 期间 scale 不变，guard/grounding 语义原样");
  harness.handlers.onWalking({ active: true, resting: false, seated: false, perched: false, paused: false, sleeping: false, face: 1 });
  await wait(16);
  assert.equal(harness.lifecycle.getState().seatEpisode.pendingFit, false, "T1: 释放兑现 pendingFit 并重锚窗口");
  assert.equal(owner.obj.scale.y, scaleFitted, "T3: Sit→Move 前后 scale 一致（不回旧 baseline）");
});

test("A2-contract: release re-anchor wired in setSpineAnim; ratchet sync wired at autoScale fire", () => {
  assert.match(renderer, /seatEpisode\.active = false;\n\s*if \(\(window\.SeatFit \? window\.SeatFit\.seatReleaseShouldRefit\(seatEpisode\) : seatEpisode\.pendingFit\)\) \{[\s\S]{0,200}scheduleFitSpine\(\{\}\);/, "释放坐姿时兑现 fit 欠账");
  const fireStart = renderer.indexOf("spineBaseScaleX *= kk;");
  const fireBlock = renderer.slice(fireStart, renderer.indexOf("fitSpinePose(generation, ownerGeneration, owner);", fireStart));
  assert.match(fireBlock, /seatEpisode\.active && seatEpisode\.owner === spineObj[\s\S]{0,240}seatRatchetSync\(seatEpisode, spineBaseScaleX\)/, "autoScale 权威值落地即同步棘轮快照");
});

/* ---------- A2.1：pre-visible bootstrap——首次可见即最终尺寸 ---------- */
test("A21-T1/T2: canvas stays hidden through bootstrap; first visible frame already at fitted scale", async () => {
  const harness = createPetLifecycleHarness();
  const r = await harness.switch("spine");
  assert.equal(r.status, "ready");
  const st0 = harness.lifecycle.getState();
  assert.equal(st0.bootstrap.pending, true, "commit 完成后仍处 gate（pass 是宏任务，此刻尚未运行）");
  const owner = st0.spineRuntimeOwner;
  assert.equal(visible(owner.view), false, "A21: bootstrap 期画布必须隐藏——不得先展示错误尺度");
  assert.equal(st0.fit.autoScaled, false);
  await wait(30); // fit 收敛 → release
  const st1 = harness.lifecycle.getState();
  assert.equal(st1.bootstrap.pending, false);
  assert.equal(visible(owner.view), true, "释放即首次可见");
  assert.equal(st1.fit.autoScaled, true);
  assert.equal(owner.obj.scale.y, Math.abs(st1.fit.base), "T2: 可见时 scale=权威 fitted base（无 0.205→0.275 视觉跳变）");
});

test("A21-T5/T3/T4: boot-Sit deferred during bootstrap; replayed Sit never rolls back the converged scale", async () => {
  const harness = createPetLifecycleHarness();
  const r = await harness.switch("spine");
  assert.equal(r.status, "ready");
  harness.handlers.onWalking({ active: false, resting: false, seated: true, perched: false, paused: false, sleeping: false, face: 1 });
  const stMid = harness.lifecycle.getState();
  assert.equal(stMid.bootstrap.walkDeferred, true, "A21: boot-Sit 被 gate 延后（相位切换不得在首见前播放）");
  assert.equal(stMid.spineRuntimeOwner.obj.state.getCurrent(0).animation.name, "idle", "A21: bootstrap 采样保持 idle 稳定姿势（坐矮轮廓不污染倍率）");
  await wait(36); // 释放 → flush replay 真实相位（harness 时钟压缩下释放可能走 bounded 路径，随后 pass 窗口继续收敛）
  const st1 = harness.lifecycle.getState();
  const owner = st1.spineRuntimeOwner;
  assert.equal(st1.bootstrap.pending, false);
  assert.equal(st1.seatEpisode.active, true, "T5: 释放后如实 replay Sit");
  assert.equal(owner.obj.state.getCurrent(0).animation.name, "Sitd");
  // 站立行走 → 相位窗口收敛 autoScale（= 真机“第一次正常走动后恢复正确大小”的机理）
  harness.handlers.onWalking({ active: true, resting: false, seated: false, perched: false, paused: false, sleeping: false, face: 1 });
  await wait(30);
  const st2 = harness.lifecycle.getState();
  assert.equal(st2.fit.autoScaled, true, "走动后 autoScale 完成（bootstrap 语义：walk 只是兑现延后的相位，不是校准本体）");
  const fitted = Math.abs(st2.fit.base);
  assert.equal(owner.obj.scale.y, fitted, "T4: 走动收敛后 scale=权威 base");
  // 再次入坐（真机场景：已收敛再坐）——棘轮/hold 都不得把 scale 拉回
  harness.handlers.onWalking({ active: false, resting: false, seated: true, perched: false, paused: false, sleeping: false, face: 1 });
  await wait(30);
  const st3 = harness.lifecycle.getState();
  assert.equal(st3.seatEpisode.active, true);
  assert.equal(owner.obj.scale.y, fitted, "T3: autoScale 之后 Sit 不回卷 scale（棘轮快照=fitted 或 keepScale pass 重放同值）");
  assert.equal(Math.abs(st3.seatEpisode.entryScale), fitted, "T3: Sit 棘轮快照锚定 fitted 权威值");
  harness.handlers.onWalking({ active: true, resting: false, seated: false, perched: false, paused: false, sleeping: false, face: 1 });
  await wait(30);
  assert.equal(owner.obj.scale.y, fitted, "T4: Sit→Move 前后 scale 一致");
});

/* ---------- A22：staged/committed 分离（真机取证根因——defer 曾发生在状态提交之后） ---------- */
function seatedIncoming() { return { active: true, resting: true, perched: false, seated: true, face: -1, paused: false, sleeping: false }; }

test("A22-T1: defer stages incoming without committing applied walkState", async () => {
  const harness = createPetLifecycleHarness();
  const r = await harness.switch("spine");
  assert.equal(r.status, "ready");
  assert.equal(harness.lifecycle.getState().bootstrap.pending, true, "同步窗口：fit pass 是宏任务，gate 仍关");
  harness.handlers.onWalking(seatedIncoming());
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.walkDeferred, true);
  assert.equal(st.bootstrap.staged.seated, true, "T1: incoming 被 staged");
  assert.equal(st.bootstrap.staged.face, -1);
  assert.equal(st.walkStateSnapshot.seated, false, "T1: applied walkState 不被污染");
  assert.equal(st.spineRuntimeOwner.obj.state.getCurrent(0).animation.name, "idle", "applied 姿势保持 neutral");
});

test("A22-T2: setMood during bootstrap cannot reach Sit (reads neutral applied state)", async () => {
  const harness = createPetLifecycleHarness();
  await harness.switch("spine");
  harness.handlers.onWalking(seatedIncoming());
  harness.lifecycle.setMood("idle"); // 真机实锤的那一步
  const st = harness.lifecycle.getState();
  assert.equal(st.spineRuntimeOwner.obj.state.getCurrent(0).animation.name, "idle", "T2: seat-guard 后门已封——mood 读到的 applied 是 neutral");
  assert.equal(st.seatEpisode.active, false, "T2: seatEpisode 未被激活");
});

test("A22-T3/T4/T5/T6: neutral fit converges with staged debt; release order = stop-defer → replay → visible", async () => {
  const harness = createPetLifecycleHarness();
  await harness.switch("spine");
  harness.handlers.onWalking(seatedIncoming());
  await wait(40); // ready 路径：TARGET → keepScale pass → release(B停defer→E replay→H visible)
  const st = harness.lifecycle.getState();
  const owner = st.spineRuntimeOwner;
  assert.equal(st.bootstrap.pending, false);
  assert.equal(st.fit.autoScaled, true, "T3: staged seated 不再破坏 neutral 收敛（真机 6×hold/hits=0 的反例）");
  assert.equal(st.fit.keepScale, true);
  const last = st.bootstrap.last;
  assert.equal(last.why, "ready", "T11: 正常冷启动绝不走 failsafe");
  assert.equal(last.hadReplay, true, "T4: staged 欠账被兑现且只 replay 一次");
  assert.equal(last.animBefore, "idle");
  assert.equal(last.animAfter, "Sitd", "T5: replay 发生在 visible 之前");
  assert.equal(last.replayBeforeVisible, true);
  assert.equal(last.scaleBefore, last.scaleAfter, "T4: replay Sit 不回卷 fitted scale");
  assert.equal(visible(owner.view), true);
  assert.equal(owner.obj.state.getCurrent(0).animation.name, "Sitd", "T6: 首见帧即最终姿势");
  assert.equal(owner.obj.scale.y, Math.abs(st.fit.base), "T6: 首见 scale=fitted（无 0.205 中间态）");
  assert.equal(st.seatEpisode.entryScale, Math.abs(st.fit.base), "T4: Sit 棘轮锚定 fitted");
});

test("A22-T7: Sit→Move→Sit keeps fitted scale after bootstrap", async () => {
  const harness = createPetLifecycleHarness();
  await harness.switch("spine");
  harness.handlers.onWalking(seatedIncoming());
  await wait(40);
  const st = harness.lifecycle.getState();
  const owner = st.spineRuntimeOwner;
  const fitted = Math.abs(st.fit.base);
  assert.equal(owner.obj.scale.y, fitted);
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, face: -1, paused: false, sleeping: false });
  await wait(30);
  assert.equal(Math.abs(owner.obj.scale.y), fitted, "T7: Sit→Move scale 模不变（flip 只改符号）");
  assert.equal(owner.obj.state.getCurrent(0).animation.name, "Move");
  harness.handlers.onWalking(seatedIncoming());
  await wait(30);
  assert.equal(owner.obj.scale.y, fitted, "T7: →Sit 再入不回卷");
  assert.equal(owner.obj.state.getCurrent(0).animation.name, "Sitd");
});

test("A22-T8: staged slot is latest-wins (seated → move → seated+sleeping = only last)", async () => {
  const harness = createPetLifecycleHarness();
  await harness.switch("spine");
  harness.handlers.onWalking(seatedIncoming());
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, face: 1, paused: false, sleeping: false });
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: true, face: -1, paused: false, sleeping: true });
  const mid = harness.lifecycle.getState();
  assert.equal(mid.bootstrap.staged.sleeping, true, "T8: 只保留最后一份完整快照");
  assert.equal(mid.bootstrap.staged.seated, true);
  await wait(40);
  const last = harness.lifecycle.getState().bootstrap.last;
  assert.equal(last.hadReplay, true);
  assert.equal(last.animAfter, "Sitd", "T8: 只 replay C（无 A→B→C 闪烁串）");
});

test("A22-T9: non-seated cold start visible normally and replays rest state", async () => {
  const harness = createPetLifecycleHarness();
  await harness.switch("spine");
  harness.handlers.onWalking({ active: false, resting: true, perched: false, seated: false, face: 1, paused: false, sleeping: false });
  await wait(40);
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.last.why, "ready");
  assert.equal(st.bootstrap.last.hadReplay, true);
  assert.equal(st.fit.autoScaled, true);
  assert.equal(visible(st.spineRuntimeOwner.view), true);
  assert.equal(st.spineRuntimeOwner.obj.scale.y, Math.abs(st.fit.base));
});

test("A22-T10: bootstrap/release never rewrite manual/auto authority flags", () => {
  const fnBody = (name) => { const i = renderer.indexOf(`function ${name}`); return renderer.slice(i, renderer.indexOf("\n}", i) + 2); };
  assert.doesNotMatch(fnBody("fitBootstrapCheck"), /spineManual\s*=/, "gate 判定不写 manual 标志");
  assert.doesNotMatch(fnBody("fitBootstrapCheck"), /spineBaseScaleX\s*[-*+]?=/, "check 不改权威 scale");
  const releaseSrc = fnBody("releaseSpineBootstrap");
  assert.doesNotMatch(releaseSrc, /spineManual|spineBaseScaleX\s*[-*+]?=/, "release 不改 manual/auto 权威（manual source of truth 保持）");
});

test("A22-T11: bounded failsafe path still makes abnormal model visible (never permanently hidden)", async () => {
  const harness = createPetLifecycleHarness();
  harness.setSampleAlpha(0); // 异常模型：sample 恒 null → 永不 TARGET
  const r = await harness.switch("spine");
  assert.equal(r.status, "ready");
  await wait(24);
  const mid = harness.lifecycle.getState();
  assert.equal(mid.bootstrap.pending, true, "never-ready 不走 ready（正常测试也不会假绿在这条路径）");
  assert.equal(mid.fit.autoScaled, false);
  harness.lifecycle.bootstrapRelease("failsafe"); // 模拟 5s 有界兜底到点
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.pending, false);
  assert.equal(st.bootstrap.last.why, "failsafe");
  assert.equal(visible(st.spineRuntimeOwner.view), true, "宁可以旧尺度可见，不永久隐身");
  harness.setSampleAlpha(255);
});

test("A22-T12: GIF→Spine re-entry uses the same staged/apply bootstrap semantics", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("gif");
  const r = await harness.switch("spine");
  assert.equal(r.status, "ready");
  assert.equal(harness.lifecycle.getState().bootstrap.pending, true, "re-entry 同样 pre-visible");
  harness.handlers.onWalking(seatedIncoming());
  assert.equal(harness.lifecycle.getState().walkStateSnapshot.seated, false, "re-entry 也不先提交 incoming");
  await wait(40);
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.last.why, "ready");
  assert.equal(st.spineRuntimeOwner.obj.scale.y, Math.abs(st.fit.base), "首见即正确 scale");
  assert.equal(st.spineRuntimeOwner.obj.state.getCurrent(0).animation.name, "Sitd", "首见即最终姿势");
});

test("A22-T13: old-owner staged cannot leak into a newer owner", async () => {
  const harness = createPetLifecycleHarness();
  await harness.switch("spine");
  harness.handlers.onWalking(seatedIncoming());
  assert.equal(harness.lifecycle.getState().bootstrap.staged.seated, true);
  await harness.switch("gif"); // 旧 owner 拆除：staged 弃置
  assert.equal(harness.lifecycle.getState().bootstrap.staged, null, "T13: staged 不跨 owner");
  await harness.switch("spine");
  const st2 = harness.lifecycle.getState();
  assert.equal(st2.bootstrap.pending, true, "新 owner 独立 bootstrap");
  assert.equal(st2.bootstrap.staged, null);
  await wait(40);
  const st3 = harness.lifecycle.getState();
  assert.equal(st3.bootstrap.last.hadReplay, false, "T13: 新 owner 不 replay 旧 owner 的 Sit");
  assert.equal(st3.spineRuntimeOwner.obj.state.getCurrent(0).animation.name, "idle");
});

test("A21-contract: bounded fallback constants + gate wiring present; release is single-entry", () => {
  assert.match(renderer, /spineBootstrapFailSafeTimer = setTimeout\(\(\) => releaseSpineBootstrap\("failsafe"\), 5000\);/, "有界兜底存在（事件路径正常先释放）");
  assert.match(renderer, /if \(spineBootstrapPassCount >= 8\) releaseSpineBootstrap\("pass-fallback"\)/);
  assert.match(renderer, /if \(spineApp && spineApp\.view && !spineBootstrapPending\) \{/, "commit unhide 被 gate 接管");
  assert.doesNotMatch(renderer.slice(renderer.indexOf("function releaseSpineBootstrap"), renderer.indexOf("function fitBootstrapCheck")), /style\.pointerEvents/, "释放不改 pointer-events 语义（initSpine 创建时已设）");
  const gifBranch = renderer.slice(renderer.indexOf('if (mode === "gif")'), renderer.indexOf('if (mode === "spine")'));
  assert.doesNotMatch(gifBranch, /spineBootstrapPending/, "GIF 路径不触 gate（T5 前置约束）");
});

/* ---------- A23：re-entry 与 cold-start 同一 owner-bootstrap；ready 上报晚于首见 ---------- */
test("A23-T2/T3/T4/T5/T6: handler-driven GIF→Spine re-entry runs identical bootstrap; ready-report is not earlier than visible", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");   // cold-start（既有语义）
  await harness.enter("gif");      // 离开
  harness.stateReads.walkState = seatedIncoming(); // handler getState 读到的 main 权威：seated
  await harness.handlers.onRenderModeChanged({ mode: "spine", seq: 501 });
  await wait(30); // report 的 await done（release）是异步延续
  const st = harness.lifecycle.getState();
  assert.equal(st.active, "spine");
  const last = st.bootstrap.last;
  assert.ok(last, "T2: re-entry 走了与 cold-start 同一套 owner-bootstrap（arm 唯一绑定 initSpine）");
  assert.equal(last.why, "ready", "T3: re-entry 确定走 ready 路径收敛，不再等未来 walk-phase 偶然 auto-fit");
  assert.equal(last.hadReplay, true, "T5: handler replay 的 seated 被 staged→release 时兑现");
  assert.equal(last.animAfter, "Sitd");
  assert.equal(st.spineRuntimeOwner.obj.scale.y, Math.abs(st.fit.base), "T6: 首见即 fitted，无 0.205 可见帧");
  const outcome = harness.calls.outcomes.at(-1);
  assert.equal(outcome.committedMode, "spine");
  assert.equal(outcome.seq, 501);
  assert.equal(harness.calls.outcomeVis.at(-1), true, "T4: render-mode ready 上报发生在 visible-release 之后");
});

test("A23-T7: five GIF↔Spine cycles each bootstrap independently; no deferred/timer/generation leak", async () => {
  const harness = createPetLifecycleHarness();
  for (let round = 1; round <= 5; round += 1) {
    await harness.enter("gif");
    await harness.enter("spine");
    const st = harness.lifecycle.getState();
    assert.equal(st.bootstrap.pending, false, `round ${round}: gate 关闭`);
    assert.equal(st.bootstrap.last.why, "ready", `round ${round}: 每轮独立 ready 收敛`);
    assert.equal(st.bootstrap.staged, null, `round ${round}: staged 不跨轮`);
    assert.equal(st.spineRuntimeOwner.obj.scale.y, Math.abs(st.fit.base), `round ${round}: fitted 权威重放一致`);
    assert.equal(visible(st.spineRuntimeOwner.view), true, `round ${round}: 本轮 owner 自己完成首见，无悬挂 gate`);
  }
});

test("A23-T8/T9/T4-contract: arm sole-bound to initSpine; owner mismatch defuses stale passes/releases; spine report awaits first-visible", () => {
  assert.equal((renderer.match(/spineBootstrapPending = true;/g) || []).length, 1, "T9: 唯一 arm 入口 = initSpine（任何新 owner 创建必经）");
  const fnB = (name) => { const i = renderer.indexOf(`function ${name}`); return renderer.slice(i, renderer.indexOf("\n}", i) + 2); };
  assert.match(fnB("fitBootstrapCheck"), /spineBootstrapOwner && spineRuntimeOwner !== spineBootstrapOwner\) return/, "T8: 旧 owner 的 pass 不推进新 gate");
  assert.match(fnB("releaseSpineBootstrap"), /spineBootstrapOwner && spineRuntimeOwner !== spineBootstrapOwner/, "T8: 旧 owner 兜底 release 不得 unhide 新 owner");
  const reportSrc = renderer.slice(renderer.indexOf("async function reportRenderModeOutcome"), renderer.indexOf("function reportRenderModeCorrection"));
  assert.match(reportSrc, /committedMode === "spine"[\s\S]{0,260}await spineBootstrapDone[\s\S]{0,140}if \(!isCurrent\(\)\) return/, "T4: spine ready 等首见且 await 后复查 request 有效性");
  const clearSrc = renderer.slice(renderer.indexOf("function clearSpineLifecycleTimers"), renderer.indexOf("\n}", renderer.indexOf("function clearSpineLifecycleTimers")));
  assert.match(clearSrc, /settleSpineBootstrapDone\(\)/, "teardown abandon 必须结算 done（ready waiter 不悬挂）");
});

/* ---------- A24：owner-boundary——新 Spine owner 的 applied 状态必须 neutral，继承的业务真相只走 staged ---------- */
test("A24-T1/T2/T3/T4/T5: re-entry inherits old applied seated; owner-boundary neutralizes, no seat-guard, ready converges", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await harness.enter("gif");
  harness.handlers.onWalking(seatedIncoming()); // GIF 期间 main 持续广播业务状态：seated 是当时的真实 applied
  assert.equal(harness.lifecycle.getState().walkStateSnapshot.seated, true, "前置：上一生命周期 applied seated=true（真机 bootstrap-arm 的同款现场）");
  harness.stateReads.walkState = seatedIncoming();
  await harness.handlers.onRenderModeChanged({ mode: "spine", seq: 901 });
  await wait(40);
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.reset.carry.seated, true, "T1: 业务真相进 carry（staged 初值）");
  assert.equal(st.bootstrap.reset.applied.seated, false, "T1: 新 owner effective=neutral");
  const last = st.bootstrap.last;
  assert.equal(last.why, "ready", "T2/T3: setMood 看到 neutral——无 seat-guard/无 6×hold/无 failsafe（真机失败链的精确回归）");
  assert.equal(last.hadReplay, true, "T4: fit 后 replay carry");
  assert.equal(last.animAfter, "Sitd", "T4: replay 如实进入 Sit");
  assert.equal(st.spineRuntimeOwner.obj.scale.y, Math.abs(st.fit.base), "T4: Sit 不回卷 fitted scale");
  assert.equal(st.seatEpisode.active, true);
  assert.equal(harness.calls.outcomeVis.at(-1), true, "T5: ready 上报晚于首见");
});

test("A24-T6/T7: inherited sleeping/paused/perched stay staged, cannot pre-apply into neutral fit", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await harness.enter("gif");
  const heavy = { active: true, resting: false, perched: true, seated: false, face: -1, paused: true, sleeping: true };
  harness.handlers.onWalking(heavy);
  harness.stateReads.walkState = heavy;
  await harness.handlers.onRenderModeChanged({ mode: "spine", seq: 902 });
  await wait(40);
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.reset.applied.sleeping, false, "T6: applied neutral 未提前入睡");
  assert.equal(st.bootstrap.reset.applied.perched, false, "T7: applied neutral 未提前上窗顶");
  assert.equal(st.bootstrap.reset.applied.paused, false);
  assert.equal(st.bootstrap.last.why, "ready", "T6/T7: 继承的 busy 态不污染 neutral fit");
  assert.equal(st.walkStateSnapshot.sleeping, true, "业务真相 replay 后提交（不丢失）");
  assert.equal(st.walkStateSnapshot.perched, true);
});

test("A24-T8: bootstrap-period incoming overrides inherited carry (latest-wins, no A→B replay chain)", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await harness.enter("gif");
  harness.handlers.onWalking(seatedIncoming()); // 旧 applied：seated
  harness.stateReads.walkState = { active: true, resting: false, perched: false, seated: false, face: 1, paused: false, sleeping: false }; // main 现值：Move
  await harness.handlers.onRenderModeChanged({ mode: "spine", seq: 903 });
  await wait(40);
  const st = harness.lifecycle.getState();
  assert.equal(st.bootstrap.last.why, "ready");
  assert.equal(st.bootstrap.last.animAfter, "Move", "T8: 只 replay 最新 incoming，不 replay 旧 carry");
  assert.equal(st.walkStateSnapshot.seated, false);
  assert.equal(st.walkStateSnapshot.active, true);
});

test("A24-T10-contract: stale-owner early returns are mutation-free; old passes cannot advance the new gate", () => {
  const relStart = renderer.indexOf("function releaseSpineBootstrap");
  const rel = renderer.slice(relStart, renderer.indexOf("\n}", relStart) + 2);
  const mismatch = rel.match(/spineBootstrapOwner && spineRuntimeOwner !== spineBootstrapOwner\) \{([^}]*)\}/);
  assert.ok(mismatch, "release 有 owner mismatch 分支");
  assert.equal(mismatch[1].trim(), "return;", "T10: mismatch 分支零可变（pending/owner/done/failsafe/staged 全属当前 owner）");
  const chkStart = renderer.indexOf("function fitBootstrapCheck");
  const chk = renderer.slice(chkStart, renderer.indexOf("\n}", chkStart) + 2);
  assert.match(chk, /spineBootstrapOwner && spineRuntimeOwner !== spineBootstrapOwner\) return;/, "T10: 旧 owner pass 不推进新 gate 计数");
});

/* ---------- A26：bootstrap replay 坐姿的 hidden settle（首见即稳定 Sit；纯行为断言） ---------- */
async function reenterSeated(face) {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await harness.enter("gif");
  harness.stateReads.walkState = Object.assign(seatedIncoming(), face === undefined ? {} : { face });
  await harness.handlers.onRenderModeChanged({ mode: "spine", seq: 700 + (face || 1) });
  await wait(30);
  return harness;
}

test("A26-T1/T2/T8: bootstrap replay to seated runs hidden settle before first visible", async () => {
  const harness = await reenterSeated(-1);
  const st = harness.lifecycle.getState();
  const obj = st.spineRuntimeOwner.obj;
  const entry = obj.state.getCurrent(0);
  assert.equal(entry.animation.name, "Sitd", "T1: replay 落坐姿");
  assert.equal(entry.mixDuration, 0, "T1: settle 对该条 entry 局部去 mix");
  assert.equal(obj.state.data.defaultMix, 0.2, "T8: 全局 defaultMix 不被 settle 触碰");
  assert.ok(obj.updateCalls >= 1 && obj.updateCalls <= 4, "hidden settle 的有界 pose 求值确实执行（≤4）");
  assert.equal(st.bootstrap.last.animAfter, "Sitd", "T2: release 记录即 settle 后的稳定 Sit 终态");
  assert.equal(st.bootstrap.last.replayBeforeVisible, true, "replay+settle 均在 visible 之前");
  assert.equal(st.fit.keepScale, true, "fitted scale 保持");
  const posAtVisible = [obj.x, obj.y, obj.updateCalls];
  await wait(50); // 让剩余 fit pass / seat-release 补窗跑完
  const st2 = harness.lifecycle.getState();
  assert.deepEqual([obj.x, obj.y, obj.updateCalls], posAtVisible, "T3: visible 后不再发生归位修正（首见即终态）");
  assert.equal(st2.bootstrap.last, st.bootstrap.last, "release 记录不被后续 pass 改写");
});

test("A26-T4/T5: settle covers both facing directions", async () => {
  for (const face of [1, -1]) {
    const harness = await reenterSeated(face);
    const st = harness.lifecycle.getState();
    const obj = st.spineRuntimeOwner.obj;
    assert.ok(obj.updateCalls >= 1, `face=${face}: settle 执行（横向修正同样 hidden）`);
    assert.equal(obj.state.getCurrent(0).mixDuration, 0, `face=${face}: 局部去 mix`);
    assert.equal(st.walkStateSnapshot.face, face, `face=${face}: carry 朝向随 replay 提交`);
  }
});

test("A26-T6: non-seated final state skips seat settle entirely", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  await harness.enter("gif");
  harness.stateReads.walkState = { active: false, resting: true, perched: false, seated: false, face: 1, paused: false, sleeping: false };
  await harness.handlers.onRenderModeChanged({ mode: "spine", seq: 720 });
  await wait(30);
  const st = harness.lifecycle.getState();
  const obj = st.spineRuntimeOwner.obj;
  assert.equal(obj.updateCalls || 0, 0, "T6: 非 Sit 不进 settle（无 hidden pose 求值），Relax/Move/Sleep 语义不变");
  assert.notEqual(obj.state.getCurrent(0).animation.name, "Sitd");
  assert.equal(st.bootstrap.pending, false, "visible 链路本身不受影响");
});

test("A26-T7: live Relax→Sit keeps 0.12 mix; global defaultMix untouched", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine"); // 无 seated bootstrap → 无 settle 介入
  const owner = harness.lifecycle.getState().spineRuntimeOwner;
  const obj = owner.obj; const dbg = [];
  const origSet = obj.state.setAnimation.bind(obj.state);
  obj.state.setAnimation = (t, n, l) => { const e = origSet(t, n, l); dbg.push({ n, mixAtCreate: e.mixDuration, same: e === obj.state.current }); return e; };
  // 先同步一次非坐姿（提交 sleeping=false 基线，避开既有 sleeping 过渡的 mood 接管——那是 A26 之前的既有行为）
  harness.handlers.onWalking({ active: false, resting: true, perched: false, seated: false, face: 1, paused: false, sleeping: false });
  await wait(8);
  harness.handlers.onWalking(seatedIncoming()); // 运行中 live 坐下（非 bootstrap 路径）
  await wait(12);
  const entry = obj.state.getCurrent(0);
  assert.equal(entry.animation.name, "Sitd");
  assert.equal(entry.mixDuration, 0.12, "T7: live seat-phase mix 保持原样（A26 仅 bootstrap replay 局部置 0）");
  assert.equal(obj.state.data.defaultMix, 0.2, "全局 defaultMix 未被 A26 触碰");
});

test("A26-T9: cold start with boot-seated also settles before first visible", async () => {
  const harness = createPetLifecycleHarness();
  harness.spineQueries.immediate = false;
  harness.stateReads.walkState = seatedIncoming();
  const pending = harness.handlers.onRenderModeChanged({ mode: "spine", seq: 730 });
  await wait(8);
  harness.spineQueries.pending.shift().resolve({ list: [], current: "builtin" });
  await pending;
  await wait(30);
  const st = harness.lifecycle.getState();
  const obj = st.spineRuntimeOwner.obj;
  assert.equal(obj.state.getCurrent(0).animation.name, "Sitd", "T9: cold-start seated 首见即稳定坐姿");
  assert.ok(obj.updateCalls >= 1, "settle 在首见前完成");
  assert.equal(st.bootstrap.pending, false, "release 已发生（ready 路径）");
});

test("A26-T10-contract: settle is owner-bound, synchronous, bounded, frame-free", () => {
  const i = renderer.indexOf("function settleBootstrapFinalPose");
  const src = renderer.slice(i, renderer.indexOf("\n}", i) + 2);
  assert.match(src, /function settleBootstrapFinalPose\(owner\)/, "A26.1：owner token 由参数显式传入");
  assert.match(src, /if \(!owner \|\| spineRuntimeOwner !== owner\) return/, "T10/A26.1: production owner 绑定（不依赖诊断状态）");
  assert.match(src, /for \(; iterations < 4;/, "bounded ≤4");
  assert.match(src, /if \(moved < 0\.5\) break/, "与 forensic 同亚像素阈值");
  assert.match(src, /cur\.mixDuration = 0/, "仅本条 entry 局部去 mix");
  assert.match(src, /spineObj\.update\(0\); spineObj\.updateTransform\(\)/, "与 ticker 等价 pose 求值，不推进时间");
  assert.doesNotMatch(src, /setTimeout|requestAnimationFrame|scheduleFitSpine/, "无计时/等帧/再 schedule（visible 时机不变）");
  assert.equal((renderer.match(/settleBootstrapFinalPose\(/g) || []).length, 2, "仅定义 + release hidden 阶段单一调用");
  assert.match(renderer, /const bootstrapOwner = spineBootstrapOwner;[\s\S]{0,900}settleBootstrapFinalPose\(bootstrapOwner\);/, "A26.1：release 捕获 production token 并传入");
});

/* ---------- A26.1：settle 行为与 diagnostics 彻底解耦（清理轮：production 路径即唯一路径） ---------- */
test("A26.1-T1: bootstrap seated replay settles with production owner (mixDuration=0, pose eval ran, stable pose)", async () => {
  const harness = await reenterSeated(1);
  const st = harness.lifecycle.getState();
  const owner = st.spineRuntimeOwner;
  const entry = owner.obj.state.getCurrent(0);
  assert.equal(entry.animation.name, "Sitd", "T1: replay 落坐姿");
  assert.equal(entry.mixDuration, 0, "T1: settle 的局部 instant 在纯 production 路径执行（历史上曾依赖诊断层状态才生效——回归防线）");
  assert.equal(st.seatEpisode.active, true);
  assert.equal(st.bootstrap.last.animAfter, "Sitd");
  assert.equal(st.bootstrap.last.replayBeforeVisible, true);
  assert.equal(st.fit.keepScale, true, "fitted scale 保持");
  assert.equal(owner.obj.scale.y, Math.abs(st.fit.base), "T1: position/scale 为 settle 后稳定终态");
});

test("A26.1-T3/T4-contract: production code is forensic-free; stale owner defused by production token", () => {
  const i = renderer.indexOf("function settleBootstrapFinalPose");
  const src = renderer.slice(i, renderer.indexOf("\n}", i) + 2);
  assert.doesNotMatch(src, /posDiagOwner|posDiagVisibleAt|posDiagBudget|posDiagWindowUntil/, "T3: settle 函数体不引用任何诊断状态");
  assert.match(renderer, /settleBootstrapFinalPose\(bootstrapOwner\)/, "T4: 调用只携带 release 捕获的 production token");
  // Bug A 清理轮总契约：Bug A 的 FIT/position forensic 层必须整体不存在（production 与开关都不留）
  assert.doesNotMatch(renderer, /FIT_DIAG|fitDiag|posDiag|fitPos/, "pet.js 不含任何 Bug A 诊断标识符");
  assert.doesNotMatch(renderer, /SUSSURRO_FIT_DIAG/, "pet.js 不含诊断 env 开关");
  const preloadSrc = fs.readFileSync(require.resolve("../preload.js"), "utf8");
  assert.doesNotMatch(preloadSrc, /fitDiag|SUSSURRO_FIT_DIAG/, "preload 不再暴露 fitDiag 开关");
});

/* ---------- talking-slide（track0 ownership invariant）：live locomotion 时普通 mood 不得抢 track0 ---------- */
const SLIDE_MOODS = [ // seam.setMoods 注入：MOODS 空时 setMood 提前 return（GIF 池语义），mood 机器根本不动
  { name: "idle", label: "待机", emotion: "" },
  { name: "happy", label: "开心", emotion: "happy" },
  { name: "sleep", label: "睡觉", emotion: "sleep" }
];
function seedMoods(harness) {
  harness.lifecycle.setMoods(SLIDE_MOODS);
}
async function liveWalkingHarness() {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  seedMoods(harness);
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(10);
  return harness;
}
function currentAnim(harness) {
  return harness.lifecycle.getState().spineRuntimeOwner.obj.state.getCurrent(0).animation.name;
}

test("SLIDE-A: live locomotion + 未知情绪（runtime 证据同型：温柔→Default/idle 兜底）不得抢 track0", async () => {
  const harness = await liveWalkingHarness();
  assert.equal(currentAnim(harness), "Move", "前置：行走相位=Move");
  harness.lifecycle.setMood("温柔");
  await wait(8);
  assert.equal(currentAnim(harness), "Move", "invariant：mood 不得把 locomotion track0 换成兜底动画");
});

test("SLIDE-B: live locomotion + mood 命中真实存在的非 locomotion 动画也不得抢（非 Default 特判）", async () => {
  const harness = await liveWalkingHarness();
  assert.equal(currentAnim(harness), "Move");
  harness.lifecycle.setMood("happy"); // 该 fake 模型下映射到真实存在的 "idle"（非兜底缺失名）
  await wait(8);
  assert.equal(currentAnim(harness), "Move", "guard 按 track0 所有权判定，与具体动画名无关");
  // 对照：情绪确实会落到非 locomotion 动画（证明这不是"永远不切"的假绿——见 SLIDE-C 允许路径）
});

test("SLIDE-C: 非 live locomotion（站立 idle）mood 正常落轨——原语义完整保留", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  seedMoods(harness);
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(10);
  harness.handlers.onWalking({ active: false, resting: true, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(10); // stop-idle 站姿
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.state.setAnimation(0, "Move", true); // 手动置于 Move（模拟相位残留）
  harness.lifecycle.setMood("happy");
  await wait(8);
  assert.equal(currentAnim(harness), "idle", "resting/非行走：mood 允许设置非 locomotion 动画（Default 合法场景）");
});

test("SLIDE-D: seated/perched/paused 的 mood 语义零回归", async () => {
  const seat = createPetLifecycleHarness();
  await seat.enter("spine");
  seedMoods(seat);
  seat.handlers.onWalking({ active: false, resting: true, perched: false, seated: true, paused: false, sleeping: false, face: 1 });
  await wait(10);
  seat.lifecycle.setMood("温柔");
  await wait(8);
  assert.equal(currentAnim(seat), "Sitd", "seated：seat-guard 原语义（坐面动画不被情绪抢）");

  const perch = createPetLifecycleHarness();
  await perch.enter("spine");
  seedMoods(perch);
  perch.handlers.onWalking({ active: false, resting: true, perched: true, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(10);
  perch.lifecycle.setMood("happy");
  await wait(8);
  assert.equal(currentAnim(perch), "Sitd", "perched：原语义不变");

  const paused = await liveWalkingHarness();
  paused.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: true, sleeping: false, face: 1 });
  await wait(10); // paused-idle 站立
  assert.equal(currentAnim(paused), "idle", "paused：站姿是正确相位（原语义）");
  paused.lifecycle.setMood("温柔");
  await wait(8);
  assert.equal(currentAnim(paused), "idle", "paused 不满足 live locomotion 谓词，不经行走分支强制回 Move");
});

test("SLIDE-E: proactive 全链（bubble+mood+speak 触发）照常，仅 track0 不被抢", async () => {
  const harness = await liveWalkingHarness();
  harness.handlers.onProactive({ text: "博士，抱抱～", emotion: "温柔", force: false });
  await wait(8);
  assert.equal(harness.elements.get("bubble-text").textContent, "博士，抱抱～", "气泡正常显示");
  assert.equal(harness.lifecycle.getState().walkStateSnapshot.active, true, "main 行走状态不变（不靠暂停修）");
  assert.equal(currentAnim(harness), "Move", "track0 保持 locomotion 所有权");
});

test("SLIDE-F-contract: setSpineMood 的 guard 结构锁定 + SLIDEDIAG 清除", () => {
  assert.match(renderer, /function isLiveLocomotion\(\)\s*\{\s*return walkState\.active && !walkState\.resting && !walkState\.seated && !walkState\.perched && !walkState\.paused && !walkState\.sleeping;/,
    "谓词是显式六条件组合（含 seated/perched/sleeping 全量定义；sleeping 漏判=真机原地空走回归）");
  const i = renderer.indexOf("function setSpineMood");
  const src = renderer.slice(i, renderer.indexOf("\nfunction ", i + 10));
  const guardAt = src.indexOf("if (isLiveLocomotion()) {");
  const moodWriteAt = src.indexOf('setSpineAnim(animName, true, "mood:');
  assert.ok(guardAt >= 0, "live locomotion guard 存在");
  assert.ok(moodWriteAt > guardAt, "guard 位于 mood 写轨之前（提前 return 抢在 fallback 判定前）");
  assert.match(src.slice(guardAt, moodWriteAt), /spinePhaseAnim\(\)/, "locomotion 来源复用相位机（不硬编码 Move）");
  assert.doesNotMatch(src, /animName === "Default"|"Default" === /, "不做 Default 特判（根因是所有权不是动画名）");
  assert.doesNotMatch(renderer, /SLIDEDIAG/, "临时 forensic probe 已删除");
});

/* ---------- SLIDE-S：sleeping 维度的 locomotion 边界（真机回归：窗口停+Move 空走） ---------- */
test("SLIDE-S1: live locomotion（sleeping=false）谓词六条件成立时普通 mood 保轨（不触发睡眠状态机）", async () => {
  const harness = await liveWalkingHarness();
  const snap = harness.lifecycle.getState().walkStateSnapshot;
  assert.deepEqual([snap.active, snap.resting, snap.seated, snap.perched, snap.paused, snap.sleeping],
    [true, false, false, false, false, false], "前置：纯 live locomotion 六条件（sleeping=false）");
  harness.lifecycle.setMood("happy"); // 守卫与 mood 名无关（A/B 已证 sleep 名同理）——此处只验证 sleeping 维度未破
  await wait(8);
  assert.equal(currentAnim(harness), "Move", "未入睡的行走中 mood 不抢 track0");
});

test("SLIDE-S2: active=true+sleeping=true：睡眠边沿 setSpineMood(sleep) 必须进入正常 mood 分支并离开 Move（回归锁）", async () => {
  const harness = await liveWalkingHarness();
  assert.equal(currentAnim(harness), "Move");
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: true, face: 1 });
  await wait(8);
  const snap = harness.lifecycle.getState().walkStateSnapshot;
  assert.deepEqual([snap.active, snap.sleeping], [true, true], "复现真机组合：active=true 且 sleeping=true（resting/seated/paused=false 由谓词其他项不满足 sleeping 判定）");
  assert.notEqual(currentAnim(harness), "Move", "入睡后不得继续 Move 空走（真机 bug 的直接断言）");
  assert.equal(currentAnim(harness), "idle", "fake 皮肤 sleep 解析到的实际动画=idle——mood 正常落轨即为通过");
});

test("SLIDE-S3: 醒来恢复行走后 locomotion ownership 正常恢复", async () => {
  const harness = await liveWalkingHarness();
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: true, face: 1 });
  await wait(8);
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(8);
  assert.equal(currentAnim(harness), "Move", "醒后行走相位收回 track0");
  harness.lifecycle.setMood("happy");
  await wait(8);
  assert.equal(currentAnim(harness), "Move", "醒后 live locomotion 守卫重新生效");
});

/* ---------- POKE-S：poke queued-successor stale 刷新（talking-slide resume 链最后环节） ---------- */
async function interactSkinHarness() {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine"); // 默认皮肤（assets 即时解析；assets.hold 需 atlas+skel 两轮 resolve，此处避开）
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  // 皮肤变体：去掉 "idle"、增 Interact/Relax/Sleepd——
  // spineAnimForMood 走映射表（idle→Relax、sleep→Sleepd），spinePhaseAnim 走 spineHas("Move") 精确分支。
  obj.spineData.animations.splice(0, 1);
  obj.spineData.animations.push({ name: "Interact" }, { name: "Relax" }, { name: "Sleepd" });
  seedMoods(harness);
  return harness;
}
function walkBroadcast(harness, over) {
  harness.handlers.onWalking(Object.assign({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 }, over || {}));
  return wait(10);
}
function track0(harness) {
  return harness.lifecycle.getState().spineRuntimeOwner.obj.state.getCurrent(0);
}
function finishQueuedTrack(harness) { // 模拟 ticker 推进一次性 Interact 到末帧 → 走 runtime 的 delay 晋升门
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  const cur = obj.state.current;
  if (cur) cur.trackTime = Math.max(cur.trackTime, cur.animationEnd);
  obj.update(0); // FakeSpine.update 复刻生产判据：非 loop + 末帧 + Number.isFinite(next.delay) 才 setCurrent 晋升
}

test("POKE-S1: 暂停中 poke 把 successor 快照冻结为 Relax（事故前置复现）", async () => {
  const harness = await interactSkinHarness();
  await walkBroadcast(harness, { paused: true });
  assert.equal(track0(harness).animation.name, "Relax", "paused-idle 站姿");
  harness.lifecycle.poke();
  const cur = track0(harness);
  assert.equal(cur.animation.name, "Interact");
  assert.equal(cur.loop, false);
  assert.equal(cur.next && cur.next.animation.name, "Relax", "排队时 spinePhaseAnim 按 paused=true 解析出 Relax");
});

test("POKE-S2: resume 在 Interact 播放中到达——不打断 current，只重建 stale 队尾为最新相位", async () => {
  const harness = await interactSkinHarness();
  await walkBroadcast(harness, { paused: true });
  harness.lifecycle.poke();
  const interactEntry = track0(harness);
  const stale = interactEntry.next;
  await walkBroadcast(harness); // paused=false，live target=Move；trackDecision 因 queuedSuccessor defer
  assert.equal(track0(harness), interactEntry, "current entry 对象未被替换（没有 setAnimation 打断互动）");
  assert.equal(track0(harness).animation.name, "Interact", "互动照常播完（trackTime 不重置：current 同一对象）");
  assert.notEqual(track0(harness).next, stale, "stale 队列被摘除");
  assert.equal(stale.released, true, "官方 disposeNext：stale 已归还对象池（released 标记）");
  assert.equal(track0(harness).next.animation.name, "Move", "队尾按实时 spinePhaseAnim() 重建");
  assert.ok(Number.isFinite(track0(harness).next.delay), "T2：新 successor 的 delay 必须是有限数（NaN 晋升门防线）");
});

test("POKE-S3: Interact 播完直接进 live locomotion 相位，不经过 Relax、不等 watchdog", async () => {
  const harness = await interactSkinHarness();
  await walkBroadcast(harness, { paused: true });
  harness.lifecycle.poke();
  await walkBroadcast(harness);
  finishQueuedTrack(harness);
  assert.equal(track0(harness).animation.name, "Move", "successor 接播即正确相位（真机 1.31/1.62s 空窗的来源）");
});

test("POKE-S4: resume 后真实目标仍是 Relax（resting）——队尾保持原样，不做无意义替换", async () => {
  const harness = await interactSkinHarness();
  await walkBroadcast(harness, { paused: true });
  harness.lifecycle.poke();
  const stale = track0(harness).next;
  await walkBroadcast(harness, { resting: true }); // live 但 resting → spinePhaseAnim()=Relax === successor
  assert.equal(track0(harness).next, stale, "名一致：保留原 entry（identity 未动）");
  assert.equal(track0(harness).next.animation.name, "Relax");
  assert.equal(track0(harness).animation.name, "Interact", "互动依旧不被打断");
});

test("POKE-S5: seated/sleeping/perched 在互动期变化——按最新语义收敛，stale 队列永不落地", async () => {
  const seat = await interactSkinHarness();
  await walkBroadcast(seat, { paused: true });
  seat.lifecycle.poke();
  await walkBroadcast(seat, { active: false, seated: true, resting: true });
  assert.equal(track0(seat).animation.name, "Sitd", "seated 分支 setAnimation 替换（链随之消失）");
  finishQueuedTrack(seat);
  assert.equal(track0(seat).animation.name, "Sitd", "无 stale successor 残留");

  const sleep = await interactSkinHarness();
  await walkBroadcast(sleep, { paused: true });
  sleep.lifecycle.poke();
  await walkBroadcast(sleep, { sleeping: true });
  assert.equal(track0(sleep).animation.name, "Sleepd", "睡眠边沿实时解析（非冻结队列、非硬编码 locomotion）");

  const perch = await interactSkinHarness();
  await walkBroadcast(perch, { paused: true });
  perch.lifecycle.poke();
  await walkBroadcast(perch, { active: false, perched: true, resting: true });
  assert.equal(track0(perch).animation.name, "Sitd");
});

test("POKE-S6-contract: defer 接 stale-refresh；官方 disposeNext 摘链 + addAnimation 4 参 delay + 约束齐备", () => {
  const i = renderer.indexOf("function applyWalkState");
  const src = renderer.slice(i, renderer.indexOf("\nfunction ", i + 10));
  assert.match(src, /if \(decision === "defer"\) \{[\s\S]{0,400}renderStaleQueuedSuccessor\(cur, target\);[\s\S]{0,40}return;/,
    "F3：删除 stale successor 接线 → stale Relax 用例（S3/T2-accident）与本合同同时红（6-A：refresh→render 重命名）");
  const h = renderer.indexOf("function renderStaleQueuedSuccessor");
  assert.ok(h >= 0, "stale successor 投影 helper 存在");
  const hs = renderer.slice(h, renderer.indexOf("\nfunction ", h + 10));
  assert.match(hs, /cur\.loop !== false/, "只处理一次性互动+排队形态");
  assert.match(hs, /if \(!stale \|\| stale\.next\) return;/, "复杂队列不碰（交回 watchdog）");
  assert.match(hs, /stale\.animation\.name === target\) return;/, "目标一致不做无意义替换（S4）");
  assert.match(hs, /state\.disposeNext\(cur\)/, "摘链必须走 runtime 官方 disposeNext（事件丢弃+对象池归还），不裸写 next");
  assert.match(hs, /state\.addAnimation\(0, target, true, 0\)/,
    "F1：4 参 delay=0 必须显式传满——去掉第 4 参会让 delay=undefined → NaN 晋升门永不兑现（15:35 定身），本合同即刻抓红");
  assert.match(hs, /if \(!officiallyDropped\) cur\.next = stale;/, "入队失败仅在未经官方 dispose 时还原旧链——已 dispose 的 entry 绝不重新挂链");
  assert.doesNotMatch(hs, /"Move"/, "不硬编码动画名：目标只来自 spinePhaseAnim() 实参");
});

test("T2-accident: 未重置 timer 的 interact 入口（proximity/onDropped 形状）+ resume 落在第二个 Interact 窗口内——15:35 定身事故的精确复刻", async () => {
  const harness = await interactSkinHarness();
  await walkBroadcast(harness, { paused: true });     // 点击 onDragStart → 暂停广播
  harness.lifecycle.poke();                           // 点击 interact #1（seam poke 不 arm timer——等价 proximity/onDropped 入口）
  harness.lifecycle.poke();                           // interact #2 重入：clearTrack + Interact#2 + next=Relax（有限 delay 换算）
  const inter2 = track0(harness);
  const stale = inter2.next;
  assert.equal(inter2.animation.name, "Interact");
  assert.equal(stale.animation.name, "Relax");
  // 旧点击 timer 到期（fake trackTime=0 未到末帧 ⇒ Interact#2 仍在窗口内）——resume 广播落进窗口
  await walkBroadcast(harness);
  assert.equal(track0(harness), inter2, "current Interact#2 未被替换（不打断互动）");
  assert.equal(inter2.trackTime, 0, "J：trackTime 未重置/未推进——refresh 前后同一 entry 同一时基");
  assert.notEqual(track0(harness).next, stale, "stale 队尾被官方 disposeNext 摘除");
  assert.equal(stale.released, true, "released：queue.dispose → drain 时 trackEntryPool.free（fake 等义标记）");
  const fresh = track0(harness).next;
  assert.equal(fresh.animation.name, "Move", "实时相位重建队尾");
  assert.ok(Number.isFinite(fresh.delay), "F：delay 为有限数（漏传第 4 参的 NaN 毒形态不可能通过此断言）");
  finishQueuedTrack(harness);                         // G/H：推进到 Interact 末帧 → 直接晋升
  assert.equal(track0(harness).animation.name, "Move", "Interact 播完直接进入 live 相位，不经过 Relax，不依赖 watchdog（I）");
});

test("T2-gate: undefined-delay 排队 entry 到末帧也永不晋升（fake 已复刻生产 NaN 门——防无条件晋升回潮）", async () => {
  const harness = await interactSkinHarness();
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.state.setAnimation(0, "Interact", false);
  const poisoned = obj.state.addAnimation(0, "Move", true); // 故意漏第 4 参：复现旧 patch 的毒形态
  assert.equal(poisoned.delay, undefined, "addAnimation 缺省 delay 如实保留 undefined，不静默兜 0");
  finishQueuedTrack(harness);
  assert.equal(track0(harness).animation.name, "Interact", "末帧 + undefined delay ⇒ NaN 晋升门恒假，current 停驻");
  assert.equal(track0(harness).next, poisoned, "中毒 successor 仍挂链 ⇒ queuedSuccessor 恒真 ⇒ watchdog/refresh 双短路（15:35 全景）");
});

/* ---------- SPEECH-D：T3 说话定身诊断（会话模型/双心跳/关闭零扰） ---------- */
function speechLines(harness) {
  return harness.calls.playback.map(String).filter((l) => l.startsWith("[SPEECHDIAG] "));
}
function lastSample(harness) {
  const s = speechLines(harness).filter((l) => l.includes('"ev":"SAMPLE"')).pop();
  return s ? JSON.parse(s.slice("[SPEECHDIAG] ".length)) : null;
}

test("SPEECH-D1: flag off → 零 [SPEECHDIAG] 输出/ctl 不暴露/生命周期照常", async () => {
  const harness = createPetLifecycleHarness(); // 默认关
  await harness.enter("spine");
  harness.handlers.onThinking({ mode: "chat" });
  harness.handlers.onProactive({ text: "博士～", emotion: "温柔", force: false });
  await wait(10);
  assert.equal(speechLines(harness).length, 0, "关闭态零诊断行（无 interval/无日志）");
  assert.equal(harness.lifecycle.speechDiagCtl, null, "关闭态不暴露诊断控制面");
  assert.equal(harness.calls.playback.some((l) => String(l).includes("说话时定身")), false);
});

test("SPEECH-D2/D3: 开启→start 采样、end 标记 +3s 窗、expire 后停采清表", async () => {
  const harness = createPetLifecycleHarness({ speechDiag: true });
  await harness.enter("spine");
  const ctl = harness.lifecycle.speechDiagCtl;
  assert.ok(ctl, "开启态控制面存在");
  const idA = ctl.start("thinking");
  assert.ok(idA >= 1, "session 返回递增 diagId");
  assert.ok(speechLines(harness).some((l) => l.includes('"ev":"START"') && l.includes('"reason":"thinking"')), "START 事件行");
  ctl.tick();
  const s1 = lastSample(harness);
  assert.ok(s1, "活跃 session → SAMPLE");
  ctl.end(idA);
  assert.equal(ctl.size(), 1, "END 只标到期时刻——+3s 窗口内 session 仍在");
  assert.ok(speechLines(harness).some((l) => l.includes('"ev":"END"')), "END 事件行");
  ctl.tick();
  assert.equal(ctl.size(), 1, "窗口内继续采样（end≠立即停）");
  ctl.expire(idA);
  ctl.tick();
  assert.equal(ctl.size(), 0, "最后一个 session 到期 → 清零");
  assert.equal(ctl.hasTimer(), false, "无 session 时 timer 已释放（clearInterval 路径）");
  const before = speechLines(harness).length;
  ctl.tick();
  assert.equal(speechLines(harness).length, before, "空窗后 tick 不再产出 SAMPLE");
});

test("SPEECH-D4/D5: 两 session 重叠——第一个 END 不提前停采样；最后一个结束才停", async () => {
  const harness = createPetLifecycleHarness({ speechDiag: true });
  await harness.enter("spine");
  const ctl = harness.lifecycle.speechDiagCtl;
  const idA = ctl.start("proactive");
  const idB = ctl.start("tts");
  ctl.tick();
  const s1 = lastSample(harness);
  assert.equal(String(s1.ids).split(",").length, 2, "SAMPLE 同时挂两个 ids");
  assert.ok(String(s1.reasons).includes("proactive") && String(s1.reasons).includes("tts"));
  ctl.end(idA);
  ctl.tick();
  assert.equal(ctl.size(), 2, "A 的 3s 窗内两者都活跃");
  assert.ok(lastSample(harness), "重叠期采样不中断");
  ctl.expire(idA);
  ctl.tick();
  assert.equal(ctl.size(), 1, "A 到期——B 仍在");
  const before = speechLines(harness).length;
  ctl.tick();
  assert.ok(speechLines(harness).length > before, "B 活跃 → 继续采样（不因 A 结束而停）");
  ctl.expire(idB);
  ctl.tick();
  assert.equal(ctl.size(), 0, "最后一个到期 → 全停");
});

test("SPEECH-D6/D7: SAMPLE 完整判别字段（ownerMatch/双心跳可区分/trackTimeAdvance）", async () => {
  const harness = createPetLifecycleHarness({ speechDiag: true });
  await harness.enter("spine");
  const ctl = harness.lifecycle.speechDiagCtl;
  ctl.start("tts");
  ctl.tick();
  ctl.tick(); // 第二采样：trackTime 已有基线，advance 布尔才有意义
  const s = lastSample(harness);
  for (const k of ["ts", "ev", "ids", "reasons", "track", "next", "hasNext", "mixingFrom",
    "trackTimeDelta", "trackTimeAdvance", "autoUpdate", "tickerStarted", "tickerMaxFPS",
    "tickerCallbackSeq", "tickerCallbackAgeMs", "spineAdvanceSeq", "spineAdvanceAgeMs",
    "ownerMatch", "stateTimeScale", "walk", "busy", "moodRemainMs", "demoRemainMs", "vis"]) {
    assert.ok(k in s, `SAMPLE 必须含字段 ${k}`);
  }
  assert.ok(s.track && "name" in s.track && "loop" in s.track && "trackTime" in s.track
    && "animationStart" in s.track && "animationEnd" in s.track && "trackLast" in s.track, "track0 六元组");
  assert.notEqual(s.tickerCallbackSeq, undefined, "心跳A 与心跳B 是独立计数器（四签名判定所需）");
  assert.notEqual(s.spineAdvanceSeq, undefined, "心跳B 字段存在");
  assert.equal(typeof s.ownerMatch, "boolean", "ownerMatch 布尔可判（owner 错位场景即 false）");
  assert.equal(typeof s.trackTimeAdvance, "boolean", "推进布尔（tick 间 trackTimeDelta>ε）");
});

test("SPEECH-D8/D9: 诊断零扰动——tick 前后 track entry/next/ticker.started 完全一致；契约锁定", async () => {
  const harness = createPetLifecycleHarness({ speechDiag: true });
  await harness.enter("spine");
  const ctl = harness.lifecycle.speechDiagCtl;
  ctl.start("tts");
  harness.lifecycle.poke(); // 造一个 Interact+next 链形态
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  const cur = obj.state.getCurrent(0);
  const nxt = cur.next;
  const startedBefore = harness.lifecycle.getState().spineApp.ticker.started;
  ctl.tick(); ctl.tick(); ctl.tick();
  assert.equal(obj.state.getCurrent(0), cur, "D8：SAMPLE 绝不替换/推进 current entry 对象");
  assert.equal(obj.state.getCurrent(0).next, nxt, "D8：next 链引用不变");
  assert.equal(harness.lifecycle.getState().spineApp.ticker.started, startedBefore, "D9：ticker started 不被诊断触碰");
  assert.match(renderer, /if \(SPEECH_DIAG\) \{ diagTickerCallbackSeq \+= 1;[\s\S]{0,120}if \(owner !== spineObj/, "心跳A 在 owner 守卫之前（可区分 callback 死 vs guard 死）");
  assert.match(renderer, /const sdFlush = SPEECH_DIAG \? speechDiagStart\("proactive-flush"\) : 0;[\s\S]{0,240}speechDiagEnd\(sdFlush\)/, "flush 路径 session 以 speak 终束收口");
  assert.match(renderer, /const SPEECH_DIAG = !!\(window\.petAPI && window\.petAPI\.speechDiag\)/, "开关单一来源（preload speechDiag）");
});

/* ---------- T3：locomotion 生命周期内静态兜底（Default duration=0）不得抢 track0 ---------- */
function applyStaticSkin(harness) {
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.spineData.animations = [
    { name: "Default", duration: 0 }, // bundled 资产字节实证：animationCount=0x06 首位、单 type5、frame time=0
    { name: "Move", duration: 2 },
    { name: "Relax", duration: 3 },
    { name: "Sleepd", duration: 4 }
  ];
}
async function staticSkinHarness(opts) {
  const harness = createPetLifecycleHarness(opts);
  await harness.enter("spine");
  applyStaticSkin(harness);
  seedMoods(harness);
  return harness;
}

test("T3-A: chat/poke 临时暂停(active+paused)时 proactive→Default 兜底被拒；resume 后回 Move，全程不碰静态帧", async () => {
  const harness = await staticSkinHarness();
  await walkBroadcast(harness, {});                    // live walk → Move
  assert.equal(track0(harness).animation.name, "Move");
  await walkBroadcast(harness, { paused: true });      // chat/poke 暂停 → paused-idle Relax（真动画，合法）
  assert.equal(track0(harness).animation.name, "Relax");
  harness.lifecycle.setMood("温柔");                   // 02:48:23 同型：未知情绪 → animations[0] 兜底
  await wait(8);
  assert.equal(track0(harness).animation.name, "Relax", "T3 守卫：静态兜底不得抢 paused-live 的 track0");
  await walkBroadcast(harness, {});                    // resume → walk-phase 恢复
  assert.equal(track0(harness).animation.name, "Move", "暂停结束由 walk-state 恢复正确 phase，不依赖对账");
});

test("T3-B: 被拒的 mood 不续 moodAnimUntil 豁免窗（SAMPLE 可见 moodRemainMs=0）", async () => {
  const harness = await staticSkinHarness({ speechDiag: true });
  await walkBroadcast(harness, {});
  await walkBroadcast(harness, { paused: true });
  harness.lifecycle.setMood("温柔");
  await wait(8);
  const ctl = harness.lifecycle.speechDiagCtl;
  const id = ctl.start("tts");
  ctl.tick(); ctl.tick();
  const s = lastSample(harness);
  assert.equal(s.track.name, "Relax", "守卫拒绝后 track0 仍为 paused-idle 相位");
  assert.equal(s.moodRemainMs, 0, "被拒 mood 不得开 6.5s 豁免窗（否则 watchdog 会被自己挡瞎）");
  ctl.expire(id);
});

test("T3-C: 聊天 think mood 不破坏——映射到真实动画(Relax)照常上轨", async () => {
  const harness = await staticSkinHarness();
  await walkBroadcast(harness, { paused: true });
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.state.setAnimation(0, "Move", true); // 制造差异：think 必须真正写轨
  harness.lifecycle.setMood("think");      // 映射 think→Relax（duration=3 真实循环动画）
  await wait(8);
  assert.equal(track0(harness).animation.name, "Relax", "非兜底 mood 在 paused-live 正常显示（思考表情不丢）");
});

test("T3-D: 非 locomotion 场景 mood 语义零回归（active=false 允许 Default；坐/睡不误伤）", async () => {
  const idle = await staticSkinHarness();
  idle.handlers.onWalking({ active: false, resting: true, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(10); // stop-idle → Relax
  idle.lifecycle.setMood("温柔");
  await wait(8);
  assert.equal(track0(idle).animation.name, "Default", "引擎停止（真 idle）：Default 兜底合法（真机确认过的行为）");

  const seated = await staticSkinHarness();
  seated.handlers.onWalking({ active: false, resting: true, perched: false, seated: true, paused: false, sleeping: false, face: 1 });
  await wait(10);
  const before = track0(seated).animation.name;
  seated.lifecycle.setMood("温柔");
  await wait(8);
  assert.equal(track0(seated).animation.name, before, "seated：seat-guard 原早退路径，守卫不介入不改变行为");

  const sleep = await staticSkinHarness();
  sleep.handlers.onWalking({ active: false, resting: true, perched: false, seated: false, paused: false, sleeping: true, face: 1 });
  await wait(10);
  assert.equal(track0(sleep).animation.name, "Sleepd", "睡眠边沿真实动画照常上轨");
  sleep.lifecycle.setMood("温柔");
  await wait(8);
  assert.equal(track0(sleep).animation.name, "Sleepd", "canonical sleeping projection must resist ordinary mood animation");
});

test("T3-E-contract: 判据结构与 T2/seat 未侵入锁定", () => {
  assert.match(renderer, /function isLocomotionLifecycle\(\)\s*\{\s*return walkState\.active && !walkState\.seated && !walkState\.perched && !walkState\.sleeping;/,
    "生命周期谓词=active 且非坐/窗顶/睡（含 paused/resting——临时立定也属生命周期）");
  const i = renderer.indexOf("function isStaticFallbackAnim");
  const src = renderer.slice(i, renderer.indexOf("\nfunction ", i + 10));
  assert.match(src, /first\.name !== name\) return false/, "静态判定只认 animations[0] 本体名字，不做情绪特判");
  assert.match(src, /first\.duration <= 0/, "以 runtime 解析的 duration≤0 判静态（无 duration 字段一律放行——不靠猜）");
  const s = renderer.indexOf("function setSpineMood");
  const body = renderer.slice(s, renderer.indexOf("\nfunction ", s + 10));
  const gateAt = body.indexOf("if (isLocomotionLifecycle() && isStaticFallbackAnim(animName)) return;");
  const writeAt = body.indexOf('setSpineAnim(animName, true, "mood:');
  assert.ok(gateAt >= 0 && writeAt > gateAt, "gate 位于 mood 写轨之前（删除此行 → T3-A/T3-B 行为红）");
  assert.match(renderer, /function isLiveLocomotion\(\)\s*\{\s*return walkState\.active && !walkState\.resting && !walkState\.seated && !walkState\.perched && !walkState\.paused && !walkState\.sleeping;/, "T1 守卫原样未动");
  assert.match(renderer, /state\.addAnimation\(0, target, true, 0\)/, "T2 successor 未动");
});

/* ---------- EDGE-T：EDGEDIAG 增强（turnId 贯穿 / mirror raw-bounds / recenter 量化） ---------- */
function edgeLines(harness) {
  return harness.calls.playback.map(String).filter((l) => l.startsWith("[EDGEDIAG] "));
}
test("EDGE-T0: flag off → face 翻转 + payload 带 edgeDiagTurnId 也零 [EDGEDIAG] 行（关闭态 IPC 多字段完全惰性）", async () => {
  const harness = createPetLifecycleHarness(); // edgeDiag 默认 false
  await harness.enter("spine");
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: -1, edgeDiagTurnId: 3 });
  await wait(10);
  assert.equal(edgeLines(harness).length, 0);
});

test("EDGE-T1/T2/T3/T4: 开启态——turnId 从广播贯穿 FACE→FIT；mirror bounds raw 前后同空间；FIT 首拍 recenterDx/Dy+fig 读数；无 id 广播清链", async () => {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(10);
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: -1, edgeDiagTurnId: 7 });
  await wait(3);
  const face = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).find((j) => j.turnId !== undefined && j.oldFace !== undefined);
  assert.ok(face, "FACE 行存在");
  assert.equal(face.turnId, 7, "T1：turnId 来自同次折返广播");
  assert.equal(face.oldFace, 1); assert.equal(face.newFace, -1);
  assert.ok(face.mirrorBoundsBefore && face.mirrorBoundsAfter, "T2：raw getBounds 前后快照");
  assert.deepEqual(Object.keys(face.mirrorBoundsBefore), Object.keys(face.mirrorBoundsAfter), "同一坐标空间同一形状（x/y/w/h/right/bottom）");
  assert.equal(face.mirrorBoundsBefore.w, face.mirrorBoundsAfter.w, "镜像不改变 bounds 宽（fake 常数模型下 x 也不变——真实资产主体偏移由 xoffPx/2×offset 量化）");
  assert.equal(typeof face.keepScale, "boolean");
  assert.equal(face.spineLocalX, face.x, "别名一致：spine 容器局部坐标（窗口坐标只在 TURN 行）");
  assert.equal(obj.state.getCurrent(0).animation.name, "Move", "T-D：recenter 不动动画");
  assert.equal(Number(face.mirrorBoundsAfter.x), Number(face.x), "T-D：FACE 行自洽——spineLocalX 即同帧立即回中后的 bbox 左缘所在（race-free，不依赖后续 pass 时序）");
  await wait(10); // fast-lane 150→5ms 首拍 fit
  const fit = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).find((j) => j.branch !== undefined);
  assert.ok(fit, "FIT 行存在（≤1500ms 短窗）");
  assert.equal(fit.turnId, 7, "T1：首拍 FIT 与 FACE 同 turnId");
  assert.ok(fit.deltaMsFromFace <= 1500, "T3：短窗内");
  assert.ok("recenterDx" in fit && "recenterDy" in fit, "T3：回中量化字段");
  assert.ok("figLeftCssAtFitStart" in fit && "figLeftCssAtFitEnd" in fit, "T3：可见左缘前后");
  assert.ok(["keepScale", "normal", "hold-seat", "invalid-bbox", "abort-guard"].includes(fit.branch), "branch 标注");
  // 生存性语义（替代旧"无 id 立即清零"）：首拍 FIT 独占消费 → 其后 FIT/FACE 归 null，绝不误挂
  harness.handlers.onWalking({ active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 });
  await wait(3);
  const face2 = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).filter((j) => j.oldFace !== undefined).pop();
  assert.ok(face2, "第二次 FACE 存在");
  const fitsAll = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).filter((j) => j.branch !== undefined);
  assert.equal(fitsAll[0].turnId, 7, "首拍 FIT=7（FACE→无-id 广播穿插→仍存活）");
  assert.ok(fitsAll.length >= 1);
  assert.ok(fitsAll.slice(1).every((f) => f.turnId === null), "首拍消费后后续 FIT 归 null——独占归因，无误挂");
});

test("EDGE-T5 生存性A: FACE(7) 后连续三条 untagged applyWalkState → 150ms 首拍 FIT 仍归 7", async () => {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false };
  harness.handlers.onWalking(Object.assign({}, live, { face: 1 }));
  await wait(10);
  harness.handlers.onWalking(Object.assign({}, live, { face: -1, edgeDiagTurnId: 7 })); // FACE#7 + 排程首拍
  await wait(2);
  harness.handlers.onWalking(Object.assign({}, live, { face: -1 }));   // untagged 穿插 ×3
  harness.handlers.onWalking(Object.assign({}, live, { face: -1, resting: true }));
  harness.handlers.onWalking(Object.assign({}, live, { face: -1 }));
  await wait(12); // fast-lane 150→5ms 首拍 FIT 落在穿插之后
  const fit = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).find((j) => j.branch !== undefined);
  assert.ok(fit, "FIT 行存在");
  assert.equal(fit.turnId, 7, "A：untagged 广播不得清存活 edge 归因（相位到期/catToy/抓宠暂停同窗插播的真相）");
});

test("EDGE-T5 生存性B: FACE(7)→FACE(8) 覆盖 → FIT 只归 8 不归 7", async () => {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false };
  harness.handlers.onWalking(Object.assign({}, live, { face: 1 }));
  await wait(10);
  harness.handlers.onWalking(Object.assign({}, live, { face: -1, edgeDiagTurnId: 7 }));
  await wait(2);
  harness.handlers.onWalking(Object.assign({}, live, { face: 1, edgeDiagTurnId: 8 })); // 新折返覆盖
  await wait(12);
  const fits = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).filter((j) => j.branch !== undefined);
  const attributed = fits.filter((f) => f.turnId !== null);
  assert.equal(attributed.length, 1, "唯一被归因的 FIT = 首拍消费");
  assert.equal(attributed[0].turnId, 8, "B：只归最新 activeEdge（8），绝不归 7");
});

test("EDGE-T5 生存性C: tagged 无翻转 + 超时无 FIT → 之后无关 FIT turnId=null（500ms 窗自清）", async () => {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false };
  harness.handlers.onWalking(Object.assign({}, live, { face: 1 }));
  await wait(10);
  harness.handlers.onWalking(Object.assign({}, live, { face: 1, edgeDiagTurnId: 7 })); // face 未变→无 FACE/无排程：id 挂起
  await wait(560); // 越过 500ms expiresAt
  harness.handlers.onWalking(Object.assign({}, live, { face: -1 })); // 超时后的无关翻转
  await wait(12);
  const fit = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).find((j) => j.branch !== undefined);
  assert.ok(fit, "FIT 行存在");
  assert.equal(fit.turnId, null, "C：陈旧 activeEdge 已过期自清，不误归");
});

test("EDGE-T6: mirror 同帧 bbox 回中（EDGEDIAG TOP 修复）——立即生效、首拍 fit 零修正、动画/窗口/timer 语义不变", async () => {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  harness.setSampleAlpha(0); // 关掉 keepScale 可见推回（fake 像素恒在角落），隔离测量纯 bbox 回中路径
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false };
  harness.handlers.onWalking(Object.assign({}, live, { face: 1 }));
  await wait(10);
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.mirrorShiftX = 22;                       // 模拟真实皮肤非对称骨骼：scale.x<0 后 bbox 左移 22px（实机 17~22px 跳变源）
  const entry = obj.state.getCurrent(0);
  const gen0 = harness.lifecycle.getState().fit.generation;
  const sizes0 = harness.calls.sizes.length;
  obj.x = 80;
  harness.handlers.onWalking(Object.assign({}, live, { face: -1, edgeDiagTurnId: 9 }));
  await wait(2);                               // 首拍 fit ≥5ms（fast lane）——此刻的位移只能来自同帧立即回中
  assert.equal(obj.x, 102, "T6-2：scale 翻转同帧 x 已 bbox 回中（80 → 80+22=102）");
  assert.equal(obj.state.getCurrent(0), entry, "T6-4：animation track entry 未被重置");
  assert.equal(harness.calls.sizes.length, sizes0, "T6-1：无 setSize/窗口请求（BrowserWindow 坐标不经 renderer 触碰）");
  const gen1 = harness.lifecycle.getState().fit.generation;
  assert.equal(gen1, gen0 + 1, "T6-5：generation 恰 +1（仅原 scheduleFitSpine 一次 bump，recenter 不新增 timer/generation）");
  const face = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).find((j) => j.oldFace !== undefined);
  assert.equal(face.turnId, 9, "FACE 归因存活");
  assert.equal(face.immediateRecentre, true, "FACE 行显式标记同帧回中已执行");
  assert.equal(face.spineLocalX, 102, "FACE 记录的是回中后位置");
  await wait(12);
  const fit = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).find((j) => j.branch !== undefined);
  assert.ok(fit, "首个 scheduled FIT 存在");
  assert.equal(Math.abs(fit.recenterDx), 0, "T6-3：首拍 fit 的 x 修正=0（同帧已回中；后续 pass 仍做 vis 精修）");
});

/* ---------- M-P1-7：freeze-y 实验已撤销——混合中 fit 继续原 y 锚定（回归锁） ---------- */
test("M-P1-7: mixing 期间 fit 正常执行 y 锚定；任何重新注入的 freeze/yEntry 都会让本测试与合同红", async () => {
  assert.doesNotMatch(renderer, /const inMix = !!/, "inMix 守卫不得回归");
  assert.doesNotMatch(renderer, /const yEntry = spineObj\.y/, "yEntry 回写不得回归");
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 };
  harness.handlers.onWalking(live);
  await wait(12);
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.state.setAnimation(0, "Move", true);
  const entry = obj.state.getCurrent(0);
  entry.mixingFrom = { animation: { name: "Sitd" }, mixTime: 0.1, mixDuration: 0.2 }; // 混合中
  obj.y = 700;
  harness.lifecycle.fitPassForTest();
  assert.notEqual(obj.y, 700, "冻结未撤销时 y 会停在 700 → 红");
});

test("FIT-M3: 坐下（hold-seat 冻结区）、睡眠边沿、perched 不受守卫影响", async () => {
  const seat = createPetLifecycleHarness();
  await seat.enter("spine");
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 };
  seat.handlers.onWalking(live);
  await wait(12);
  const sobj = seat.lifecycle.getState().spineRuntimeOwner.obj;
  sobj.y = 650;
  seat.handlers.onWalking(Object.assign({}, live, { resting: true, seated: true }));
  await wait(14); // seat-phase 窗口各拍命中 hold-seat 早退——守卫与 hold-seat 无交集
  assert.equal(sobj.state.getCurrent(0).animation.name, "Sitd");
  assert.equal(sobj.y, 650, "坐下路径：hold-seat 早退语义原样（本守卫不参与）");

  const sleep = createPetLifecycleHarness();
  await sleep.enter("spine");
  sleep.handlers.onWalking(live);
  await wait(12);
  const tobj = sleep.lifecycle.getState().spineRuntimeOwner.obj;
  tobj.y = 700;
  sleep.handlers.onWalking(Object.assign({}, live, { sleeping: true })); // 睡眠边沿 → mood 写非混合态动画
  await wait(14);
  assert.notEqual(tobj.y, 700, "M3：无 mixingFrom 的常规 fit 仍逐拍贴底（守卫不误伤）");

  const perch = createPetLifecycleHarness();
  await perch.enter("spine");
  perch.handlers.onWalking(live);
  await wait(12);
  perch.handlers.onWalking(Object.assign({}, live, { resting: true, perched: true }));
  await wait(14);
  assert.equal(perch.lifecycle.getState().spineRuntimeOwner.obj.state.getCurrent(0).animation.name, "Sitd", "perched 走 seat 分支原样");
});

/* ---------- EDGE-O：OFFSETDIAG（keepScale 混合期 visibleBottomOffset 采样器，diagnostics-only） ---------- */
function odiagLines(harness) {
  return harness.calls.playback.map(String).filter((l) => l.startsWith("[OFFSETDIAG] "));
}
function odiagJson(harness, ev) {
  return odiagLines(harness)
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
    .filter(Boolean)
    .filter((j) => j.ev === ev);
}
async function edgeOnHarness() {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  return harness;
}
const LIVE = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 };

test("EDGE-O1: gate 关闭 → seam 驱动 + 合法 Sit→Move 混合形态下零 [OFFSETDIAG] 行、零额外 render", async () => {
  const harness = createPetLifecycleHarness(); // edgeDiag false
  await harness.enter("spine");
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  const r0 = harness.apps[0].renderer.renderCalls || 0;
  harness.handlers.onWalking(Object.assign({}, LIVE, { resting: true, seated: true }));
  harness.handlers.onWalking(LIVE);
  const entry = obj.state.getCurrent(0);
  entry.mixingFrom = { animation: { name: "Sitd" }, mixTime: 0.05, mixDuration: 0.2 };
  harness.lifecycle.offsetDiagTickForTest();
  assert.equal(odiagLines(harness).length, 0);
  assert.equal(harness.apps[0].renderer.renderCalls || 0, r0, "关闭态 offsetDiagTick 一次 RenderTexture 都不做");
});

test("EDGE-O2: 门精确——Interact→Move / Relax→Move 混合不采；Sitd→Move 才开 recorder", async () => {
  const harness = await edgeOnHarness();
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  obj.state.setAnimation(0, "Move", true);
  obj.state.getCurrent(0).mixingFrom = { animation: { name: "Interact" }, mixTime: 0.1, mixDuration: 0.2 };
  harness.lifecycle.offsetDiagTickForTest();
  obj.state.setAnimation(0, "Move", true);
  obj.state.getCurrent(0).mixingFrom = { animation: { name: "Relax" }, mixTime: 0.1, mixDuration: 0.2 };
  harness.lifecycle.offsetDiagTickForTest();
  assert.equal(odiagLines(harness).length, 0, "非 seat 来源一律不采");
  harness.handlers.onWalking(Object.assign({}, LIVE, { resting: true, seated: true }));
  harness.lifecycle.offsetDiagTickForTest(); // Sitd 稳态快照
  harness.handlers.onWalking(LIVE);
  const entry = obj.state.getCurrent(0);
  entry.mixingFrom = { animation: { name: "Sitd" }, mixTime: 0.05, mixDuration: 0.2 };
  harness.lifecycle.offsetDiagTickForTest(); // 第一拍：建立 recorder（不采样）
  harness.lifecycle.offsetDiagTickForTest(); // 第二拍：桶采样
  assert.ok(odiagJson(harness, "SAMPLE").length === 1, "Sitd→Move 开采");
});

test("EDGE-O3: mixed 桶 0..7 各采一次；target steady 独立同帧重采；SUMMARY 语义与符号约定", async () => {
  const harness = await edgeOnHarness();
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  harness.handlers.onWalking(Object.assign({}, LIVE, { resting: true, seated: true }));
  harness.lifecycle.offsetDiagTickForTest(); // steadySit 快照（sourceSteadyOffset 唯一合法来源）
  harness.handlers.onWalking(LIVE);
  const entry = obj.state.getCurrent(0);
  entry.mixDuration = 0.2;
  entry.mixingFrom = { animation: { name: "Sitd" } };
  const genBefore = harness.lifecycle.getState().fit.generation;
  harness.lifecycle.offsetDiagTickForTest(); // 建立 recorder
  for (const mt of [0, 0.025, 0.05, 0.075, 0.1, 0.125, 0.15, 0.175, 0.175]) {
    entry.mixTime = mt;
    harness.lifecycle.offsetDiagTickForTest();
  }
  const samples = odiagJson(harness, "SAMPLE");
  assert.equal(samples.length, 8, "mixed 桶 0..7 各一次；重复桶不重采");
  assert.deepEqual(samples.map((s) => s.progressBucket), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(samples.every((s) => s.role === "mixed"));
  assert.equal(odiagJson(harness, "TARGET_STEADY").length, 0, "mixingFrom 仍在时绝不产 target steady");
  for (const s of samples) {
    assert.equal(Number((s.visBottom - s.bboxBottom).toFixed(2)), s.visibleBottomOffset, "符号：visibleBottomOffset = visBottom − bboxBottom");
    assert.ok(Number.isFinite(s.sampleCostMs));
    assert.ok("spineLocalY" in s && s.keepScale === true && "generation" in s && "ownerGeneration" in s);
  }
  entry.mixingFrom = null;
  entry.mixTime = 0.3;
  harness.lifecycle.offsetDiagTickForTest();
  const steady = odiagJson(harness, "TARGET_STEADY");
  assert.equal(steady.length, 1, "mixingFrom 清除后独立 TARGET_STEADY 同帧重采（不复用 mixed 末样本）");
  assert.equal(Number((steady[0].visBottom - steady[0].bboxBottom).toFixed(2)), steady[0].visibleBottomOffset);
  const sum = odiagJson(harness, "SUMMARY").pop();
  assert.equal(sum.sampleCount, 8);
  assert.equal(sum.sourceSteadyKind, "steadySit");
  assert.equal(sum.targetSteadyRecorded, true);
  assert.ok(Number.isFinite(sum.sourceSteadyOffset) && Number.isFinite(sum.targetSteadyOffset));
  assert.equal(sum.targetSteadyTs, steady[0].ts);
  assert.equal(sum.targetSteadyBBoxBottom, steady[0].bboxBottom);
  assert.equal(sum.targetSteadyVisBottom, steady[0].visBottom);
  assert.equal(sum.targetSteadySampleCostMs, steady[0].sampleCostMs);
  assert.ok("sampledMaxDeviationFromTarget" in sum && "sampledMinOffset" in sum && "sampledMaxOffset" in sum && "maxSampleCostMs" in sum && "avgSampleCostMs" in sum);
  assert.equal(sum.closedReason, "mix-complete");
  assert.equal(harness.lifecycle.getState().fit.generation, genBefore, "O5：generation 不变");
  assert.equal(obj.state.getCurrent(0), entry, "O5：track entry 同一对象");
  assert.equal(entry.trackTime, 0, "O5：不推进动画");
});

test("EDGE-O5: progress=96% 且 mixingFrom 仍在 → 归 mixed 桶 7，不冒充 100% steady；清除后才出独立 steady", async () => {
  const harness = await edgeOnHarness();
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  harness.handlers.onWalking(Object.assign({}, LIVE, { resting: true, seated: true }));
  harness.lifecycle.offsetDiagTickForTest();
  harness.handlers.onWalking(LIVE);
  const entry = obj.state.getCurrent(0);
  entry.mixDuration = 0.2;
  entry.mixTime = 0.192; // progress 0.96
  entry.mixingFrom = { animation: { name: "Sitd" } };
  harness.lifecycle.offsetDiagTickForTest(); // 建立
  harness.lifecycle.offsetDiagTickForTest(); // 0.96 → bucket min(7, round(7.68)) = 7
  const samples = odiagJson(harness, "SAMPLE");
  assert.equal(samples.length, 1);
  assert.equal(samples[0].progressBucket, 7, "96% 采样是 mixed 桶 7（旧实现会误入 8='100%' 并吞掉真 steady）");
  assert.equal(samples[0].role, "mixed");
  assert.equal(odiagJson(harness, "TARGET_STEADY").length, 0);
  assert.equal(odiagJson(harness, "SUMMARY").length, 0, "未结束不开 SUMMARY，更无 targetSteadyOffset");
  entry.mixingFrom = null;
  harness.lifecycle.offsetDiagTickForTest();
  assert.equal(odiagJson(harness, "TARGET_STEADY").length, 1, "清除后的下一拍才产生独立 target steady");
  const sum = odiagJson(harness, "SUMMARY").pop();
  assert.equal(sum.targetSteadyRecorded, true);
  assert.ok(Number.isFinite(sum.targetSteadyOffset));
});

test("EDGE-O4: Sit→Sleep 用独立 transitionId 与独立 target summary（Move 记 Move、Sleep 记 Sleep）", async () => {
  const harness = await edgeOnHarness();
  const obj = harness.lifecycle.getState().spineRuntimeOwner.obj;
  harness.handlers.onWalking(Object.assign({}, LIVE, { resting: true, seated: true }));
  harness.lifecycle.offsetDiagTickForTest();
  harness.handlers.onWalking(LIVE);
  const e1 = obj.state.getCurrent(0);
  e1.mixDuration = 0.2; e1.mixTime = 0.1;
  e1.mixingFrom = { animation: { name: "Sitd" } };
  harness.lifecycle.offsetDiagTickForTest();
  e1.mixingFrom = null; e1.mixTime = 0.3;
  harness.lifecycle.offsetDiagTickForTest();
  const s1 = odiagJson(harness, "SUMMARY").pop();
  assert.equal(s1.to, "Move");
  // Sit→Sleep 形态（默认皮肤 sleep 解析名 = "idle"）
  harness.handlers.onWalking(Object.assign({}, LIVE, { resting: true, seated: true }));
  harness.lifecycle.offsetDiagTickForTest();
  obj.state.setAnimation(0, "idle", true); // 模拟睡眠边沿写入
  const e2 = obj.state.getCurrent(0);
  e2.mixDuration = 0.2; e2.mixTime = 0.1;
  e2.mixingFrom = { animation: { name: "Sitd" } };
  harness.lifecycle.offsetDiagTickForTest();
  e2.mixingFrom = null; e2.mixTime = 0.3;
  harness.lifecycle.offsetDiagTickForTest();
  const s2 = odiagJson(harness, "SUMMARY").pop();
  assert.equal(s2.to, "idle", "sleep 目标独立记录（默认皮肤解析名）");
  assert.notEqual(s2.transitionId, s1.transitionId, "transitionId 不复用");
});

test("EDGE-T7 (FIT-M5): seat→stand 广播（无 face 翻转）开启 FIT 诊断窗，eventKind=seatExit 且 recenterDy 可见", async () => {
  const harness = createPetLifecycleHarness({ edgeDiag: true });
  await harness.enter("spine");
  const live = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 };
  harness.handlers.onWalking(Object.assign({}, live, { resting: true, seated: true })); // 坐下（无 face 变化）
  await wait(12);
  const before = edgeLines(harness).filter((l) => l.includes('"branch"')).length;
  harness.handlers.onWalking(live); // Sit→stand：无 mirror 翻转
  await wait(14);
  const fits = edgeLines(harness).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).filter((j) => j.branch !== undefined);
  assert.ok(fits.length > before, "seat-exit 窗口内 FIT 行存在（旧实现只绑 face 翻转 → 此处为 0 抓红）");
  assert.ok(fits.some((j) => j.eventKind === "seatExit"), "eventKind 标注 seatExit");
  assert.ok(fits.every((j) => "recenterDy" in j && "deltaMsFromFace" in j));
});

/* ---------- E1：Sit→Move / stand-beat forensic bounded read-only evidence ---------- */
const e1ForensicState = (sessionId, eventSeq, seated, resting) => ({
  active: true, resting, perched: false, seated, paused: false, sleeping: false, face: 1,
  seatExitForensic: { sessionId, eventSeq, mainMonoMs: eventSeq * 10, mainDateNow: Date.now() }
});
test("E1-D1: flag OFF 不建立 session、不 flush forensic、不增加诊断 render", async () => {
  const harness = createPetLifecycleHarness();
  await harness.enter("spine");
  const app = harness.apps.at(-1);
  const renderBefore = app.renderer.renderCalls;
  harness.handlers.onWalking(e1ForensicState("e1-off", 1, true, true));
  harness.handlers.onWalking(e1ForensicState("e1-off", 2, false, false));
  app.ticker.step(1);
  assert.equal(harness.lifecycle.seatExitForensicCtl, null, "OFF 不暴露 forensic 控制面");
  assert.equal(harness.calls.playback.some((line) => line.startsWith("[SEATFORENSIC] ")), false, "OFF 零 forensic flush");
  assert.equal(app.renderer.renderCalls, renderBefore, "OFF 不增加诊断 render");
});
test("E1-D2/D3/D4: flag ON 只缓存 bounded 记录，记录实际 asset/pose/owner，并在 owner 更替时分 session", async () => {
  const harness = createPetLifecycleHarness({ seatExitForensic: true });
  await harness.enter("spine");
  const ctl = harness.lifecycle.seatExitForensicCtl;
  assert.ok(ctl, "ON 暴露测试控制面");
  const app = harness.apps.at(-1);
  harness.handlers.onWalking(e1ForensicState("e1-on", 1, true, true));
  harness.handlers.onWalking(e1ForensicState("e1-on", 2, false, false));
  app.ticker.step(1);
  assert.ok(ctl.session().recordCount > 0, "ON 只记录，不直接逐条 flush");
  const ownerGenBefore = ctl.session().ownerGeneration;
  ctl.flush("test-bounded");
  const firstLine = harness.calls.playback.filter((line) => line.startsWith("[SEATFORENSIC] ")).at(-1);
  const first = JSON.parse(firstLine.slice("[SEATFORENSIC] ".length));
  assert.equal(first.side, "renderer");
  assert.equal(first.closeReason, "test-bounded");
  assert.ok(first.records.length <= 256, "buffer 上限明确且 bounded");
  assert.equal(typeof first.asset.skelPath, "string", "记录实际 skel 路径或 UNKNOWN");
  assert.equal(typeof first.asset.atlasPath, "string", "记录实际 atlas 路径或 UNKNOWN");
  assert.ok(first.records.some((r) => r.ev === "frame"), "记录 ticker frame");
  assert.ok(first.records.some((r) => r.pose && r.pose.bones), "记录 bone availability/worldY 或 unavailable");
  assert.ok(first.records.every((r) => "rendererGeneration" in r && "ownerGeneration" in r), "每条记录含 generation 关联");
  assert.equal(ownerGenBefore > 0, true, "session 绑定当前 owner generation");

  harness.handlers.onWalking(e1ForensicState("e1-owner", 1, false, false));
  await harness.switch("gif");
  const oldLine = harness.calls.playback.filter((line) => line.startsWith("[SEATFORENSIC] ")).at(-1);
  const old = JSON.parse(oldLine.slice("[SEATFORENSIC] ".length));
  assert.equal(old.closeReason, "owner-teardown", "旧 owner teardown 先 flush");
  await harness.switch("spine");
  harness.handlers.onWalking(e1ForensicState("e1-owner", 2, false, false));
  ctl.flush("test-new-owner");
  const lines = harness.calls.playback.filter((line) => line.startsWith("[SEATFORENSIC] "));
  const newer = JSON.parse(lines.at(-1).slice("[SEATFORENSIC] ".length));
  assert.notEqual(old.renderSessionId, newer.renderSessionId, "新 owner 不复用旧 renderer session");
  assert.ok(newer.records.every((r) => r.ownerGeneration === newer.records[0].ownerGeneration), "旧 owner 记录不混入新 session");
  assert.match(renderer, /const SEAT_EXIT_FORENSIC_WINDOW_MS = 1100;/);
  assert.match(renderer, /const SEAT_EXIT_FORENSIC_MAX_RECORDS = 256;/);
  const forensicBlock = renderer.slice(renderer.indexOf("\/\* ===== E1："), renderer.indexOf("\/\* ===== OFFSETDIAG"));
  assert.doesNotMatch(forensicBlock, /setInterval\(/, "E1 不新增逐帧 timer");
  assert.doesNotMatch(forensicBlock, /renderer\.render\(/, "E1 不增加 RenderTexture/alpha scan");
});

/* ---------- Phase2 behavioral regressions: real bundled AnimationState + controlled time ---------- */
function seatAuditClock() {
  let seq = 0;
  const jobs = new Map();
  const clock = {
    now: 10000,
    setTimeout(fn, ms = 0, ...args) { const id = ++seq; jobs.set(id, { at: clock.now + ms, fn: () => fn(...args) }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const next = [...jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        jobs.delete(next[0]); clock.now = next[1].at; next[1].fn();
      }
      clock.now = end;
    }
  };
  return clock;
}
const seatPixi = require("pixi.js");
const bundledSpineContext = vm.createContext({ PIXI: { ...seatPixi } });
vm.runInContext(fs.readFileSync(require.resolve("../renderer/pixi-spine.js"), "utf8"), bundledSpineContext);
const seatRuntimeData = require("@pixi-spine/runtime-3.8");
const LIVEW = { active: true, resting: false, perched: false, seated: false, paused: false, sleeping: false, face: 1 };
const seatGeometry = (bottom = 20) => ({
  bbox: { x: -40, y: -100, width: 80, height: 100 + bottom },
  visible: [{ x: -32, y: -90, width: 64, height: 90 }]
});
async function seatRuntimeHarness({ keepScale = false, edgeDiag = false, sleepName = "Sleepd", standBeatPose = false, seatExitForensic = false } = {}) {
  const clock = seatAuditClock();
  const h = createPetLifecycleHarness({ clock, geometry: true, edgeDiag, standBeatPose, seatExitForensic });
  await h.switch("spine");
  clock.advance(1200);
  assert.equal(h.lifecycle.getState().bootstrap.pending, false, "real fit timers finish bootstrap");
  const o = h.lifecycle.getState().spineRuntimeOwner.obj;
  // Only SkeletonData/empty animation definitions are synthetic. set/update/apply/clear/pooling are the shipped bundle.
  const data = new seatRuntimeData.SkeletonData();
  data.version = "3.8.99";
  data.animations = ["Sitd", "Move", "Relax", "Interact", ...(sleepName ? [sleepName] : [])].map(n => new seatRuntimeData.Animation(n, [], 1));
  const core = {};
  bundledSpineContext.PIXI.spine.Spine.prototype.createSkeleton.call(core, data);
  o.spineData = data; o.state = core.state; o.state.data.defaultMix = 0.2;
  const geometries = { Move: seatGeometry(20), Relax: seatGeometry(35), Interact: seatGeometry(45) };
  o.auditGeometry = seatGeometry();
  o.update = dt => {
    o.state.update(dt); o.state.apply(core.skeleton);
    o.auditGeometry = geometries[o.state.getCurrent(0)?.animation?.name] || seatGeometry();
  };
  o.getBounds = () => {
    if (h.boundsFailure === "throw") throw new Error("bounds unavailable");
    if (h.boundsFailure === "invalid") return { x: 0, y: 0, width: 0, height: 0 };
    const b = o.auditGeometry.bbox;
    const xx = [b.x, b.x + b.width].map(x => o.x + x * o.scale.x);
    const yy = [b.y, b.y + b.height].map(y => o.y + y * o.scale.y);
    return { x: Math.min(...xx), y: Math.min(...yy), width: Math.abs(xx[1] - xx[0]), height: Math.abs(yy[1] - yy[0]) };
  };
  o.scale.set(1); o.x = 130; o.y = 160;
  h.sandbox.auditKeepScale = keepScale;
  vm.runInContext('clearSpineLifecycleTimers(); spineFitOwner=spineRuntimeOwner; spineFitOwnerGeneration=activeRenderGeneration; spineClassified=null; spineManual=true; spineAutoScaled=true; spineFitKeepScale=auditKeepScale; spineBaseScaleX=1;', h.sandbox);
  h.clock = clock; h.obj = o; h.app = h.apps.at(-1);
  h.frame = (ms = 1000 / 60) => { clock.advance(ms); h.app.ticker.step(ms * 60 / 1000); };
  h.setAnim = name => { h.sandbox.auditName = name; vm.runInContext('setSpineAnim(auditName, true, "audit")', h.sandbox); };
  h.until = predicate => { for (let i = 0; i < 150 && !predicate(); i++) h.frame(); assert.ok(predicate(), "condition reached"); };
  h.arm = (exit = LIVEW) => {
    h.handlers.onWalking({ ...LIVEW, resting: true, seated: true });
    o.update(1 / 60); // Sit has actually been applied before setAnimation: no hand-written mixingFrom.
    h.handlers.onWalking(exit);
    h.frame();
  };
  return h;
}
const seatState = h => h.lifecycle.seatYForTest.state();

for (const [label, source, state, mood, expected, sleepName] of [
  ["Sit→Move", "Sitd", LIVEW, null, true],
  ["Sit→Sleepd", "Sitd", { ...LIVEW, sleeping: true }, null, true],
  ["Sit→Sleep", "Sitd", { ...LIVEW, sleeping: true }, null, true, "Sleep"],
  ["RESTING_ARM_NEGATIVE", "Sitd", { ...LIVEW, resting: true }, "idle", false],
  ["PAUSED_ARM_NEGATIVE", "Sitd", { ...LIVEW, paused: true }, null, false],
  ["Sit→Sit", "Sitd", { ...LIVEW, seated: true, resting: true }, null, false],
  ["Relax→Move", "Relax", LIVEW, null, false],
  ["Interact→Move", "Interact", LIVEW, null, false],
  ["Move→Relax", "Move", { ...LIVEW, resting: true }, "idle", false],
  ["Move→Sleep", "Move", { ...LIVEW, sleeping: true }, null, false],
  ["seat entry", "Move", { ...LIVEW, seated: true, resting: true }, null, false],
  ["sleep missing → Relax", "Sitd", { ...LIVEW, sleeping: true }, null, false, ""]
]) test("P2 B1 " + label, async () => {
  const h = await seatRuntimeHarness({ sleepName });
  h.setAnim(source); h.obj.update(1 / 60);
  h.handlers.onWalking(state);
  if (mood) h.lifecycle.setMood(mood);
  if (label === "Sit→Sit") h.setAnim("Sitd");
  h.frame();
  assert.equal(h.lifecycle.seatYForTest.owns(), expected);
  if (label.includes("NEGATIVE") || label.includes("missing")) assert.equal(h.obj.state.getCurrent(0).animation.name, "Relax");
});

for (const keepScale of [false, true]) test("P2 B2 RELEASE_THEN_NORMAL_FIT " + (keepScale ? "keepScale" : "normal"), async () => {
  const h = await seatRuntimeHarness({ keepScale });
  h.arm();
  assert.ok(h.lifecycle.seatYForTest.owns());
  h.until(() => !h.lifecycle.seatYForTest.owns());
  const y = h.obj.y;
  h.lifecycle.fitPassForTest();
  assert.ok(Math.abs(h.obj.y - y) <= (keepScale ? 4 : 0.4), "same authority after release");
});
test("P2 B2 measurement is read-only and independent of limiter raster phase", async () => {
  const h = await seatRuntimeHarness({ keepScale: true });
  h.arm();
  const targets = [];
  for (const y of [160, 161, 162, 163, 164, 200]) {
    h.obj.y = y;
    const snap = vm.runInContext('JSON.stringify({x:spineObj.x,y:spineObj.y,sx:spineObj.scale.x,sy:spineObj.scale.y,fig:spineFigLeftCss,gap:visibleCanvasGap,raf:scheduleGeometryReport.raf,timer:geometryReportTimer})', h.sandbox);
    h.lifecycle.seatYForTest.measure("audit");
    assert.equal(vm.runInContext('JSON.stringify({x:spineObj.x,y:spineObj.y,sx:spineObj.scale.x,sy:spineObj.scale.y,fig:spineFigLeftCss,gap:visibleCanvasGap,raf:scheduleGeometryReport.raf,timer:geometryReportTimer})', h.sandbox), snap);
    targets.push(seatState(h).targetY);
  }
  assert.ok(Math.max(...targets) - Math.min(...targets) < 0.01, "canonical virtual origin removes progress-dependent grid phase");
  assert.ok(targets[0] > 190, "transparent bbox overhang must not force visible authority back to bbox Y=180");
});
test("P2 B3 MEASURE_FAIL_DOES_NOT_CONFIRM_FINAL; retry is bounded", async () => {
  const h = await seatRuntimeHarness({ keepScale: true });
  h.arm(); const oldTarget = seatState(h).targetY;
  const getBounds = h.obj.getBounds;
  let attempts = 0;
  h.obj.getBounds = () => { attempts += 1; return getBounds(); };
  h.boundsFailure = "throw";
  h.until(() => !h.obj.state.getCurrent(0).mixingFrom);
  const atMixEnd = attempts;
  const rtAtMixEnd = h.app.renderer.renderCalls || 0;
  for (let i = 0; i < 5; i++) h.frame();
  // FAST 语义下 getBounds 每帧一次是合法的（cheap bbox 同帧补偿）；被禁止的是：
  // a) 失败的 RT authority 测量逐帧重试（throttle 150ms > 5×16.7ms ⇒ 至多 +1 次尝试）；
  // b) 任何逐帧 RenderTexture 分配（renderCalls 恒增 0）。
  assert.ok(attempts - atMixEnd <= 5 + 1, "failed measurement is not retried each frame (fast bbox ≤1/帧 + 节流 retry ≤1)");
  assert.equal(h.app.renderer.renderCalls || 0, rtAtMixEnd, "measurement 失败期零 RT");
  assert.equal(seatState(h).sawFinalReaim, false);
  assert.equal(seatState(h).targetY, oldTarget);
  assert.ok(h.lifecycle.seatYForTest.owns());
  h.boundsFailure = null;
  h.until(() => !h.lifecycle.seatYForTest.owns());
});
test("P2 B3 true→true entry replacement re-aims immediately", async () => {
  const h = await seatRuntimeHarness();
  h.arm(); const oldTarget = seatState(h).targetY;
  h.setAnim("Relax"); h.frame();
  assert.ok(h.obj.state.getCurrent(0).mixingFrom, "real chained mix");
  assert.equal(seatState(h).targetName, "Relax");
  assert.notEqual(seatState(h).targetY, oldTarget);
  assert.equal(seatState(h).sawFinalReaim, false);
});
test("P2 B3 ENTRY_REPLACEMENT_WITHOUT_MIX through real playSpineInteract", async () => {
  const h = await seatRuntimeHarness();
  h.arm(); h.obj.y = 50;
  h.until(() => seatState(h)?.sawFinalReaim);
  const oldTarget = seatState(h).targetY;
  h.lifecycle.poke(); // production clearTrack + setAnimation + queue
  assert.equal(h.obj.state.getCurrent(0).mixingFrom, null);
  h.frame();
  assert.equal(seatState(h).targetName, "Interact");
  assert.notEqual(seatState(h).targetY, oldTarget);
  assert.ok(h.lifecycle.seatYForTest.owns());
});
test("P2 B3 same-name pooled entry replacement invalidates final", async () => {
  const h = await seatRuntimeHarness(); h.arm(); h.obj.y = 50;
  h.until(() => seatState(h)?.sawFinalReaim);
  h.obj.state.clearTrack(0); h.setAnim("Move"); h.boundsFailure = "throw"; h.frame();
  assert.equal(seatState(h).sawFinalReaim, false);
  assert.ok(h.lifecycle.seatYForTest.owns());
});
test("P2 B3 unapplied replacement cannot confirm final via a fit timer", async () => {
  const h = await seatRuntimeHarness(); h.arm(); h.obj.y = 50;
  h.until(() => seatState(h)?.sawFinalReaim);
  h.obj.state.clearTrack(0); h.setAnim("Interact");
  assert.equal(h.obj.state.getCurrent(0).nextTrackLast, -1);
  h.lifecycle.fitPassForTest();
  assert.equal(seatState(h).sawFinalReaim, false);
  h.frame();
  assert.equal(seatState(h).targetName, "Interact");
  assert.equal(seatState(h).targetY, 155);
  assert.equal(seatState(h).sawFinalReaim, true);
});
test("P2 B2 release revalidates authority against current pose", async () => {
  const h = await seatRuntimeHarness(); h.arm(); h.obj.y = 50;
  h.until(() => seatState(h)?.sawFinalReaim);
  h.obj.y = seatState(h).targetY;
  const update = h.obj.update;
  h.obj.update = dt => { update(dt); h.obj.auditGeometry = seatGeometry(40); };
  for (let i = 0; i < 3; i++) h.frame();
  assert.ok(h.lifecycle.seatYForTest.owns(), "old target cannot grant release for a changed pose");
  assert.equal(seatState(h).targetY, 160);
  h.until(() => !h.lifecycle.seatYForTest.owns());
  const y = h.obj.y; h.lifecycle.fitPassForTest();
  assert.ok(Math.abs(h.obj.y - y) <= 0.4);
});
test("P2 B4 TTL_RESUME_THEN_NORMAL_FIT retains ownership and residual", async () => {
  const h = await seatRuntimeHarness(); h.arm();
  h.clock.advance(1500); h.obj.y = 160;
  const before = h.obj.y;
  h.app.ticker.step(6);
  assert.ok(Math.abs(h.obj.y - before) <= 6);
  assert.ok(h.lifecycle.seatYForTest.owns());
  const after = h.obj.y; h.lifecycle.fitPassForTest();
  assert.equal(h.obj.y, after, "ordinary fit is still subject to ownership");
  h.until(() => !h.lifecycle.seatYForTest.owns());
  const released = h.obj.y; h.lifecycle.fitPassForTest();
  assert.ok(Math.abs(h.obj.y - released) <= 0.4);
});
for (const keepScale of [false, true]) for (const failure of ["invalid", "throw"]) test("P2 B5 temporary-Y safety " + keepScale + " " + failure, async () => {
  const h = await seatRuntimeHarness({ keepScale }); h.arm();
  h.obj.y = 160; h.boundsFailure = failure;
  h.lifecycle.fitPassForTest();
  assert.equal(h.obj.y, 160);
  assert.ok(h.lifecycle.seatYForTest.owns());
});
test("P2 B5 DIRECT_SIT_REENTRY hands off before containment ticker", async () => {
  const h = await seatRuntimeHarness(); h.arm();
  h.obj.y = 250;
  h.handlers.onPlayAnim("Sitd");
  assert.equal(h.lifecycle.seatYForTest.owns(), false);
  assert.equal(h.obj.y, 250, "handoff never finishes old target");
  h.frame();
  assert.equal(h.obj.y, 180, "only containment writes, no extra +2.5 limiter step");
});
test("P2 B5 containment rejects ownership even if handoff were missed", async () => {
  const h = await seatRuntimeHarness(); h.arm(); h.obj.y = 250;
  vm.runInContext('seatEpisode.active=true;seatEpisode.owner=spineObj;seatEpisode.entryScale=1;seatEpisode.previousScale=1;', h.sandbox);
  h.obj.state.setAnimation(0, "Sitd", true); // deliberately bypass shared production setter
  vm.runInContext('seatContainmentCommit()', h.sandbox);
  assert.equal(h.obj.y, 250);
  h.frame();
  assert.equal(h.lifecycle.seatYForTest.owns(), false);
  assert.equal(h.obj.y, 180, "ticker also handles queued Sit promotion before containment");
});
for (const edgeDiag of [false, true]) test("P2 B6 OWNER_TEARDOWN_NO_MANUAL_TICK diagnostics=" + edgeDiag, async () => {
  const h = await seatRuntimeHarness({ edgeDiag }); h.arm();
  const oldTicker = h.app.ticker;
  await h.switch("gif");
  assert.equal(oldTicker.listeners.size, 0);
  assert.equal(h.lifecycle.getState().spineRuntimeOwner, null);
  assert.equal(seatState(h), null, "synchronous invalidation, without invoking removed callback");
  assert.doesNotThrow(() => h.handlers.onWalking({ ...LIVEW, resting: true, seated: true }));
  await h.switch("spine"); h.clock.advance(1200);
  assert.equal(seatState(h), null);
});
test("P2 poke old timers are permanently invalidated at arm, using original 120/250ms timing", async () => {
  const h = await seatRuntimeHarness();
  h.lifecycle.seatYForTest.poke();
  h.clock.advance(50); h.arm();
  h.clock.advance(70); assert.ok(h.lifecycle.seatYForTest.owns());
  h.handlers.onPlayAnim("Sitd"); // release before old 250ms callback
  h.obj.y = 170; h.clock.advance(130);
  assert.equal(h.obj.y, 170, "old absolute callback cannot revive after handoff");
  h.clock.advance(600); h.lifecycle.seatYForTest.poke();
  assert.equal(h.obj.y, 154, "non-seat bounce still available");
});
test("P2 owner teardown invalidates delayed Y writes and retired ticker closures", async () => {
  const h = await seatRuntimeHarness(); h.lifecycle.seatYForTest.poke();
  const oldCallback = [...h.app.ticker.listeners][0];
  await h.switch("gif"); await h.switch("spine"); h.clock.advance(1200);
  const obj = h.lifecycle.getState().spineRuntimeOwner.obj; obj.y = 177;
  oldCallback(1); h.clock.advance(300);
  assert.equal(obj.y, 177);
});
test("P2 actual Pixi ticker units and long-frame cap", async () => {
  for (const [ms, expected] of [[1000 / 60, 2.5], [1000 / 30, 5], [120, 6], [3600000, 6]]) {
    const h = await seatRuntimeHarness(); h.arm(); h.obj.y = 100;
    const ticker = new seatPixi.Ticker();
    ticker.add([...h.app.ticker.listeners][0]); ticker.lastTime = 0; ticker._lastFrame = 0;
    ticker.update(ms); ticker.destroy();
    assert.ok(Math.abs(h.obj.y - 100 - expected) < 1e-6, `ms=${ms} got=${h.obj.y - 100} want=${expected}`);
  }
});
test("P2 FACE reschedule does not cancel mix-end measurement; no per-frame RT", async () => {
  const h = await seatRuntimeHarness({ keepScale: true, edgeDiag: false }); h.arm();
  h.frame(170); // advance the real AnimationState as well as wall time: mix is now near 180ms.
  assert.ok(h.obj.state.getCurrent(0).mixingFrom);
  h.handlers.onWalking({ ...LIVEW, face: -1 });
  const faceAt = h.clock.now;
  const generation = h.lifecycle.getState().fit.generation;
  h.until(() => !!seatState(h)?.sawFinalReaim || !h.lifecycle.seatYForTest.owns());
  assert.ok(h.clock.now - faceAt < 150, "final re-aim precedes the rescheduled first ordinary fit");
  assert.equal(h.lifecycle.getState().fit.generation, generation);
  h.until(() => !h.lifecycle.seatYForTest.owns());
  vm.runInContext('spineFitTimers.forEach(clearTimeout)', h.sandbox);
  const samples = h.app.renderer.renderCalls;
  for (let i = 0; i < 20; i++) h.frame();
  assert.equal(h.app.renderer.renderCalls, samples, "idle ticker does not allocate/sample RT");
});

/* ---------- FAST-x：per-frame pose target（screen-space 接触保持）+ FPS-x：eco 即时复判 ---------- */
function seatYEv(h, ev) {
  return h.calls.playback.map(String).filter((l) => l.startsWith("[SEATYDIAG] "))
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
    .filter((j) => j && j.ev === ev);
}
function seatPoseRamp(h) { // 包一层：harness 原生 update（state.update+apply）照常跑，仅覆盖 auditGeometry 的 pose 底边
  const orig = h.obj.update;
  h.poseBottom = 20;
  h.obj.update = (dt) => { orig(dt); h.obj.auditGeometry = seatGeometry(h.poseBottom); };
}
test("FAST-1/2: ARM 早期小 target 后 pose 每帧变化必须逐帧进 target（无 83ms stale 平台、不被 4px MEASURE_EPS 吞）", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm(); seatPoseRamp(h);
  const f0 = seatState(h).fastBaseY;
  h.poseBottom = 60; h.frame();
  assert.ok(Math.abs((seatState(h).fastBaseY - f0) + 40) < 1e-6, "fast anchor = H − 局部底边：pose +40px 则基线 −40px");
  const yB = h.obj.y; const tB = seatState(h).targetY;
  h.poseBottom = 58; h.frame(); // 2px/帧 < VIS_EPS=4：仍必须生效
  const dy = h.obj.y - yB;
  assert.ok(dy >= 2 - 1e-6 && dy <= 2 + 6.01, `fast 同帧 +2（residual 另限幅）：dy=${dy}`);
  assert.ok(Math.abs((seatState(h).targetY - tB) - 2) < 1e-6, "composed target 每帧随 pose 平移（bottom 减小→anchor 增大）");
  let last = seatState(h).targetY; let changed = 0;
  for (let i = 0; i < 8; i++) { h.poseBottom -= 1; h.frame(); if (Math.abs(seatState(h).targetY - last) > 1e-9) changed++; last = seatState(h).targetY; }
  assert.ok(changed >= 7, "1px/帧级 pose 变化逐帧跟踪（旧实现此处有 83ms 平台）");
});
test("FAST-3: 同帧 pose 补偿保持 screen 接触——pose bottom 60→58 时 residual 不被基线平移制造", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm(); seatPoseRamp(h);
  h.poseBottom = 60; h.frame();
  const r0 = seatState(h).targetY - h.obj.y; const y0 = h.obj.y;
  h.poseBottom = 58; h.frame();
  const dy = h.obj.y - y0; const r1 = seatState(h).targetY - h.obj.y;
  assert.ok(dy >= 2 - 1e-6 && dy <= 2 + 2.51, `fast 同帧吸收 pose 位移 +2，另加 limiter 限幅步 ≤2.5：dy=${dy}`);
  assert.ok(r1 <= r0 + 1e-6 && r1 >= r0 - 2.51 - 1e-6, `基线平移只被 fast 吸收，residual 只随限幅消耗不增长（§四）：r0=${r0} r1=${r1}`);
});
test("FAST-4/5: fit/mix-end 只带来小 correction；FINAL_FREEZE 后 pose 波动不再跟随", async () => {
  const h = await seatRuntimeHarness({ keepScale: true, edgeDiag: true }); h.arm(); seatPoseRamp(h);
  h.poseBottom = 60; h.frame();
  let lastStep = 0;
  for (let b = 58; b >= 22; b -= 2) { const p = h.obj.y; h.poseBottom = b; h.frame(); lastStep = Math.max(lastStep, Math.abs(h.obj.y - p)); }
  assert.ok(lastStep <= 2 + 6.01, `pose 主导步进由 fast 同帧吸收，residual 始终限幅：lastStep=${lastStep}`);
  h.until(() => !!seatState(h)?.finalAuthorityValid);
  assert.equal(seatYEv(h, "FINAL_FREEZE").length, 1);
  const yF = h.obj.y;
  h.poseBottom = 26; h.frame(); h.poseBottom = 16; h.frame(); // Move 循环腿摆波动
  assert.ok(Math.abs(h.obj.y - yF) <= 2 * 6.01, "freeze 后不再被 walking 动画 pose 变化误补偿（residual 限幅内）");
  assert.ok(seatState(h).finalAuthorityValid, "freeze 保持");
});
test("FAST-6: keepScale 的 visibleCorrectionY 是同源小量且随 fast 基线复用", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm();
  const s = seatState(h);
  assert.ok(Number.isFinite(s.visibleCorrectionY), "arm 即建立 correction（同姿势 p.y − fast）");
  seatPoseRamp(h);
  h.poseBottom = 40; h.frame();
  const s2 = seatState(h);
  assert.equal(s2.visibleCorrectionY, s.visibleCorrectionY, "corr 只在离散测量点更新，不逐帧重算");
  assert.ok(Math.abs(s2.targetY - (s2.fastBaseY + s2.visibleCorrectionY)) < 1e-6, "composed = fast + corr");
});
test("FAST-7: 50 帧 transition 的 RT 采样数为常数级（不随帧数线性增长）", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm(); seatPoseRamp(h);
  const rt0 = h.app.renderer.renderCalls || 0;
  for (let i = 0; i < 50; i++) { h.poseBottom = 60 - i * 0.7; h.frame(); }
  const added = (h.app.renderer.renderCalls || 0) - rt0;
  assert.ok(added <= 8, `fast 逐帧零 RT：50 帧内 RT 为常数级（离散测量+release 后 fit 窗口），非逐帧线性：${added}`);
});
test("FAST-8/9/10: 严格 handoff——3.55px 不 release，≤0.25px 且满足五条件才 release；release 后普通 fit Δ≈0", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm(); seatPoseRamp(h);
  h.poseBottom = 20; h.until(() => !!seatState(h)?.finalAuthorityValid);
  h.obj.y = seatState(h).finalAuthorityY - 3.55;
  h.frame(); h.frame();
  assert.ok(h.lifecycle.seatYForTest.owns(), "3.55px 残差绝不提前交接（旧 epsilon 会放走）");
  h.obj.y = seatState(h).finalAuthorityY - 0.2;
  h.until(() => !h.lifecycle.seatYForTest.owns());
  const yRel = h.obj.y;
  h.lifecycle.fitPassForTest();
  assert.ok(Math.abs(h.obj.y - yRel) <= 0.5, "FAST-10：release 后 ordinary fit 无二次跳（keepScale）");
});
test("FAST-11: TTL 只复测/继续 ownership，绝不 finish 或 release", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm(); seatPoseRamp(h);
  h.poseBottom = 20; h.until(() => !!seatState(h)?.finalAuthorityValid);
  h.obj.y = seatState(h).finalAuthorityY - 40;
  h.lifecycle.seatYForTest.set("watchdogAt", Date.now() - 2000);
  h.frame();
  assert.ok(h.lifecycle.seatYForTest.owns(), "TTL 不 release（residual 交给 limiter 继续，不 snap）");
  assert.ok(Math.abs(h.obj.y - (seatState(h).finalAuthorityY - 40)) <= 6.01);
});
test("FAST-12: entry interruption 作废旧 frozen authority 且当帧不 snap", async () => {
  const h = await seatRuntimeHarness({ keepScale: true }); h.arm(); seatPoseRamp(h);
  h.poseBottom = 20; h.until(() => !!seatState(h)?.finalAuthorityValid);
  const y0 = h.obj.y;
  h.setAnim("Interact"); // 真实替换 entry
  h.frame();
  const s = seatState(h);
  assert.equal(s.finalAuthorityValid, false, "冻结 authority 不跨到新动画");
  assert.equal(s.sawFinalReaim, false);
  assert.ok(Math.abs(h.obj.y - y0) <= 6.01, "无 snap（fast 重锚 + residual 限幅）");
});
test("FAST-14: Sit→Sleep 同样逐帧 pose 跟踪，不依赖 150ms fit 救场", async () => {
  const h = await seatRuntimeHarness({ keepScale: true });
  h.setAnim("Sitd"); h.obj.update(1 / 60);
  h.handlers.onWalking({ ...LIVEW, sleeping: true }); h.frame();
  assert.ok(h.lifecycle.seatYForTest.owns(), "睡眠过渡同样 arm");
  seatPoseRamp(h);
  let last = seatState(h).targetY; let changed = 0;
  for (let i = 0; i < 6; i++) { h.poseBottom += 2; h.frame(); if (Math.abs(seatState(h).targetY - last) > 1e-9) changed++; last = seatState(h).targetY; }
  assert.ok(changed >= 5, "Sleep mix 每帧跟踪");
});
test("FPS-1..5/7: seatExit ownership 即时 60fps；release/teardown 按真实状态立即复判；单一判定源", async () => {
  const h = await seatRuntimeHarness({ edgeDiag: true });
  assert.equal(h.lifecycle.seatYForTest.eco(), 24, "FPS-1 idle 巡检判定 24");
  assert.equal(h.app.ticker.maxFPS, 24, "FPS-1b eco 是唯一写点：idle 判定已落到 ticker");
  h.arm();
  assert.equal(h.app.ticker.maxFPS, 60, "FPS-2 ARM 同次调用即 60（不推进 4s interval）");
  const h2 = await seatRuntimeHarness();
  h2.setAnim("Sitd"); h2.obj.update(1 / 60);
  h2.handlers.onWalking({ ...LIVEW, sleeping: true }); h2.frame();
  assert.ok(h2.lifecycle.seatYForTest.owns());
  assert.equal(h2.lifecycle.seatYForTest.eco(), 60, "FPS-3 入睡中 ownership 优先于 sleeping=12（moving 也为 true 的双重路径下仍 60）");
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: true }); h.frame(); // seat-entry release（动画回到 Sitd）
  assert.equal(h.lifecycle.seatYForTest.owns(), false);
  assert.equal(h.app.ticker.maxFPS, 24, "FPS-4 release 立即复判为真实 idle=24（非硬编码）");
  const h4 = await seatRuntimeHarness();
  h4.handlers.onWalking({ ...LIVEW, active: false, resting: true, sleeping: true }); h4.frame();
  assert.equal(h4.lifecycle.seatYForTest.owns(), false, "非 Sit 源的 Sleep 过渡不 arm，才轮到 eco 判定");
  assert.equal(h4.lifecycle.seatYForTest.eco(), 12, "FPS-4b 真 sleeping 且无 ownership → 12");
  await h2.enter("gif"); // HARD teardown：token drop + 安全复判
  assert.equal(h2.lifecycle.seatYForTest.owns(), false, "FPS-5 hard drop");
  assert.equal(h2.lifecycle.seatYForTest.eco(), null, "FPS-7 spineApp=null 安全，无 override 泄漏");
  assert.equal((renderer.match(/spineApp\.ticker\.maxFPS\s*=/g) || []).length, 1, "FPS-6 唯一赋值点=applyEcoFps，4s 巡检同一函数");
  assert.match(renderer, /setInterval\(\(\) => \{ applyEcoFps\(\); \}, 4000\);/);
});

/* ---------- E2：stand-beat pose admission ---------- */
async function e2SeatHarness(opts = {}) {
  const h = await seatRuntimeHarness(opts);
  h.setAnim("Sitd");
  h.obj.update(1 / 60); // Sit 已实际应用，后续 admission 只接受 applied loop track。
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: true });
  return h;
}
function e2ForensicMeta(sessionId, eventSeq) {
  return { sessionId, eventSeq, mainMonoMs: eventSeq * 10, mainDateNow: Date.now() };
}

test("E2-1/E2-7: flag OFF 保持现有 resting defer，intent 不产生新字段/副作用", async () => {
  const h = await e2SeatHarness({ standBeatPose: false });
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: false, standBeatPoseIntent: "stand" });
  assert.equal(h.obj.state.getCurrent(0).animation.name, "Sitd", "E2 OFF 不准入 Sit→Relax");
  assert.equal(h.calls.playback.some((line) => line.includes("stand-beat-pose")), false, "E2 OFF 无 pose admission side effect");
});

test("E2-2: E2 intent 仅在已应用循环 Sit 上提交现有 idle resolver 的 Relax", async () => {
  const h = await e2SeatHarness({ standBeatPose: true });
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: false, standBeatPoseIntent: "stand" });
  assert.equal(h.obj.state.getCurrent(0).animation.name, "Relax", "窄 intent 提交 Relax");
  h.frame();
  assert.equal(h.obj.state.getCurrent(0).animation.name, "Relax", "首个 applied frame 仍为 Relax");
});

test("E2-3: 普通 resting=true 没有 intent 时仍由 watcher defer，不提交 Relax", async () => {
  const h = await e2SeatHarness({ standBeatPose: true });
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: false });
  assert.equal(h.obj.state.getCurrent(0).animation.name, "Sitd", "普通 resting 不被 E2 改写");
});

for (const [label, mutate] of [
  ["pause", (h) => ({ paused: true })],
  ["perch", (h) => ({ perched: true })],
  ["demo", (h) => { vm.runInContext("animDemoUntil = Date.now() + 1000", h.sandbox); return {}; }],
  ["interaction busy", (h) => { vm.runInContext("busy = true", h.sandbox); return {}; }],
  ["queued successor", (h) => { h.obj.state.addAnimation(0, "Move", true, 0); return {}; }]
]) test("E2-4: " + label + " 不被 E2 强行覆盖", async () => {
  const h = await e2SeatHarness({ standBeatPose: true, seatExitForensic: true });
  const sessionId = "e2-guard-" + label;
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: true, seatExitForensic: e2ForensicMeta(sessionId, 1) });
  const extra = mutate(h);
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: false, standBeatPoseIntent: "stand", ...extra, seatExitForensic: e2ForensicMeta(sessionId, 2) });
  h.lifecycle.seatExitForensicCtl.flush("e2-guard");
  const lines = h.calls.playback.filter((line) => line.startsWith("[SEATFORENSIC] "));
  const last = JSON.parse(lines.at(-1).slice("[SEATFORENSIC] ".length));
  assert.equal(last.records.some((record) => record.ev === "stand-beat-pose-request"), false, label + " 不应产生 E2 request");
  assert.equal(last.records.some((record) => record.ev === "stand-beat-pose-applied"), false, label + " 不应产生 E2 applied");
});

test("E2-5: 没有可靠 Relax/idle 时安全 fallback，不猜第一条动画", async () => {
  const h = await e2SeatHarness({ standBeatPose: true });
  h.obj.spineData.animations = h.obj.spineData.animations.filter((animation) => !["Relax", "Sleepd"].includes(animation.name));
  vm.runInContext("spineClassified = null", h.sandbox);
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: false, standBeatPoseIntent: "stand" });
  assert.equal(h.obj.state.getCurrent(0).animation.name, "Sitd", "无可靠 idle 时保留 Sit 生命周期");
});

test("E2-6: deadline 后仍由普通广播请求 Move，E2 只记录 Relax→Move 边沿", async () => {
  const h = await e2SeatHarness({ standBeatPose: true, seatExitForensic: true });
  const sessionId = "e2-chain";
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: true, seatExitForensic: e2ForensicMeta(sessionId, 1) });
  h.handlers.onWalking({ ...LIVEW, resting: true, seated: false, standBeatPoseIntent: "stand", seatExitForensic: e2ForensicMeta(sessionId, 2) });
  h.frame();
  h.handlers.onWalking({ ...LIVEW, resting: false, seated: false, seatExitForensic: e2ForensicMeta(sessionId, 3) });
  assert.equal(h.obj.state.getCurrent(0).animation.name, "Move", "beat end 的普通 state 仍请求 Move");
  h.lifecycle.seatExitForensicCtl.flush("e2-chain");
  const lines = h.calls.playback.filter((line) => line.startsWith("[SEATFORENSIC] "));
  const last = JSON.parse(lines.at(-1).slice("[SEATFORENSIC] ".length));
  const events = last.records.map((record) => record.ev);
  assert.ok(events.includes("stand-beat-pose-intent-receive"), "forensic 能辨认 renderer 收到 intent");
  assert.ok(events.includes("stand-beat-pose-request"), "forensic 能辨认 Sit→Relax request");
  assert.ok(events.includes("stand-beat-pose-applied"), "forensic 能辨认 Relax 首个 applied frame");
  assert.ok(events.includes("stand-beat-move-request"), "forensic 能辨认 Relax→Move request");
});

/* ---------- HPAT：摸头/单击的瞬时 Q 弹（Spine 模式补齐 GIF 的 pet-squash 语义） ----------
 * 回归背景：fab69cd 的 squash CSS 自带 body:not(.spine-mode) 门控，但当时无人设置该 class
 * （门控休眠）且 spine 画布是 #pet 子节点 → Q 弹在 spine 模式事实可见；6083542 补上
 * body.classList.add("spine-mode") 激活门控 → spine 的按压/释放 Q 弹静默消失（回归点）；
 * 本应接替的 pokeFeedback（2600a04）出生至 HEAD 从无生产调用点（死代码），无实现接盘。
 * 这组测试同时锁住"行为"与"接线"：历史上正是"定义了但没接线"才让回归静默通过。 */
async function hpatHarness() {
  const h = await seatRuntimeHarness();
  h.clock.advance(5000); // 排空 bootstrap/fit 尾拍：本组只观察 Q 弹自身，不与 fit pass 抢写
  h.obj.scale.set(1.2); h.obj.x = 130; h.obj.y = 160;
  return h;
}
const hpatBottom = (h) => { const b = h.obj.getBounds(); return { cx: b.x + b.width / 2, bottom: b.y + b.height }; };
const hpatPose = (h) => ({ x: h.obj.x, y: h.obj.y, sx: h.obj.scale.x, sy: h.obj.scale.y });

test("HPAT-1: 摸头/单击立即产生等比压缩，底部中心锚定，末拍精确还原", async () => {
  const h = await hpatHarness();
  const before = hpatBottom(h), pose = hpatPose(h);
  h.lifecycle.headPatSquash();
  const mid = hpatBottom(h);
  assert.ok(Math.abs(h.obj.scale.y - pose.sy * 0.9) < 1e-9, "按下即压缩到 0.9");
  assert.ok(Math.abs(h.obj.scale.x - pose.sx * 0.9) < 1e-9, "x 同步压缩（保留翻面符号）");
  assert.ok(Math.abs(h.obj.scale.x / h.obj.scale.y - 1) < 1e-9, "严格等比：不触发 pet.js 200ms 非等比自愈");
  assert.ok(Math.abs(mid.cx - before.cx) < 1e-6, "水平中心锚定（transform-origin 50%）");
  assert.ok(Math.abs(mid.bottom - before.bottom) < 1e-6, "脚底锚定：压缩时脚不离地");
  h.clock.advance(210);
  const over = hpatBottom(h);
  assert.ok(h.obj.scale.y > pose.sy, "松手过冲回弹（Q 弹上沿）");
  assert.ok(Math.abs(over.bottom - before.bottom) < 1e-6, "回弹相位脚底同样锚定");
  h.clock.advance(140);
  assert.deepEqual(hpatPose(h), pose, "末拍精确还原基准 transform（状态可恢复）");
});

test("HPAT-2: 外部写者（fit pass）中途接手时以其为新基准，绝不回写陈旧绝对值", async () => {
  const h = await hpatHarness();
  h.lifecycle.headPatSquash();
  h.clock.advance(100);
  h.obj.scale.set(1.5); h.obj.y = 123; // 模拟 fitSpinePose 在 150ms 拍写回的权威姿态
  h.clock.advance(110);
  assert.ok(h.obj.scale.y > 1.5, "过冲建立在外部写者的值之上");
  h.clock.advance(140);
  assert.equal(h.obj.scale.y, 1.5, "末拍还原的是外部写者的值");
  assert.equal(h.obj.y, 123, "不会把 fit 的 y 拉回旧基准");
});

test("HPAT-3: 连点重触发不叠乘压缩量（对齐 GIF 重放 keyframes 语义）", async () => {
  const h = await hpatHarness();
  const pose = hpatPose(h);
  h.lifecycle.headPatSquash();
  h.clock.advance(80);
  h.lifecycle.headPatSquash(); // 摸头第二击落在上一轮压缩期内
  assert.ok(Math.abs(h.obj.scale.y - pose.sy * 0.9) < 1e-9, "重新起手先还原基准，不叠乘成 0.81");
  h.clock.advance(400);
  assert.deepEqual(hpatPose(h), pose, "新一轮收尾同样精确还原");
});

test("HPAT-4: Sit ratchet 与 seat-exit local-Y owner 期间整轮让位", async () => {
  const h = await hpatHarness();
  let pose = hpatPose(h);
  h.setAnim("Sitd"); // production 入口：setSpineAnim(Sit) 激活 seatEpisode（containment 逐拍写 transform）
  h.lifecycle.headPatSquash();
  assert.deepEqual(hpatPose(h), pose, "Sit ratchet 期间同步首拍即被拦下");
  h.clock.advance(400);
  assert.deepEqual(hpatPose(h), pose, "Sit ratchet 期间排队回调同样不写入");
  h.arm(); // production 入口：Sit→Move 触发 seat-exit local-Y ownership
  assert.equal(h.lifecycle.seatYForTest.owns(), true, "seat-exit Y owner 已生效");
  pose = hpatPose(h);
  h.lifecycle.headPatSquash();
  assert.deepEqual(hpatPose(h), pose, "seat-exit Y owner 期间同步首拍零写入");
  h.clock.advance(400);
  assert.ok(Math.abs(h.obj.scale.y - pose.sy * 0.9) > 1e-9, "seat-exit Y owner 期间绝不落压缩量");
});

test("HPAT-5: owner 销毁/模式切换后排队回调不得复活", async () => {
  const h = await hpatHarness();
  const old = h.obj;
  h.lifecycle.headPatSquash();
  old.scale.set(7); // 哨兵：若旧回调复活，这里会被改写
  await h.switch("gif"); await h.switch("spine"); h.clock.advance(1200);
  assert.notEqual(h.lifecycle.getState().spineRuntimeOwner.obj, old, "新 owner 已建立");
  assert.equal(old.scale.x, 7, "旧 owner 的 210/350ms 回调永久失效");
  assert.equal(old.scale.y, 7);
});

test("HPAT-6: 非 spine 模式为 no-op，且 Q 弹不触碰动画轨道", async () => {
  const h = await hpatHarness();
  h.setAnim("Relax"); h.obj.update(1 / 60);
  const cur = h.obj.state.getCurrent(0).animation.name;
  h.lifecycle.headPatSquash();
  h.frame();
  assert.equal(h.obj.state.getCurrent(0).animation.name, cur, "Q 弹只写 transform，不动 track0");
  await h.switch("gif");
  assert.doesNotThrow(() => h.lifecycle.headPatSquash(), "gif 模式无 spineObj：安全 no-op");
});

test("HPAT-7: 接线契约——非拖拽释放（摸头/单击）必须触发 Q 弹", () => {
  const start = renderer.indexOf("  if (!wasDrag) {");
  const end = renderer.indexOf("  } else if (velocity", start);
  assert.ok(start >= 0 && end > start, "finishDrag 的非拖拽分支可定位");
  const branch = renderer.slice(start, end);
  const at = branch.indexOf("headPatSquash();");
  assert.ok(at >= 0, "非拖拽释放路径必须调用 headPatSquash（历史回归正是'定义了没接线'）");
  assert.ok(at < branch.indexOf("playSpineInteract();"), "Q 弹与互动动作同拍触发，不被延后");
  const finishDrag = renderer.slice(renderer.indexOf("function finishDrag"), renderer.indexOf("function onDragStart"));
  assert.doesNotMatch(finishDrag, /pokeFeedback\(/, "不得接线带原声切片+600ms 节流的 pokeFeedback：那会额外打开未被请求的随机原声声道，并吃掉摸头第二击");
});

test("HPAT-8: GIF 路径零改动（CSS 门控与 class 时机保持原样）", () => {
  assert.match(css, /body:not\(\.spine-mode\):not\(\.rig-mode\):not\(\.live2d-mode\) \.pet\.pet-squash \{/,
    "GIF 按压 class 门控保持不变（本修复只在 Spine 侧补实现，不动 GIF 语义）");
  assert.match(renderer, /petEl\.classList\.add\("pet-squash"\);/, "GIF 按压 class 仍在 pointerdown 添加");
  assert.match(renderer, /petEl\.classList\.add\("pet-squash-release"\);/, "GIF 松手 class 仍在 pointerup 添加");
});

/* HPAT-9/10：端到端行为契约——不经测试钩子，走生产监听器链
 * （petEl pointerdown → window pointerup → finishDrag 分类 → headPatSquash / 拖拽分支）。
 * HPAT-1..8 锁函数语义，这两个锁"用户真实操作能到达它"：6083542 型回归（链路完好但
 * 反馈被门控静默吃掉）只有端到端才能暴露。 */
const hpatPointerEvent = (petEl, over = {}) => ({
  pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, pointerId: 1,
  screenX: 100, screenY: 100, clientX: 50, clientY: 50,
  currentTarget: petEl, target: petEl, ...over
});

test("HPAT-9: 端到端——spine 模式真实单击链（pointerdown→pointerup）触发瞬时 Q 弹", async () => {
  const h = await hpatHarness();
  const petEl = h.elements.get("pet");
  const before = hpatBottom(h), pose = hpatPose(h);
  petEl.dispatchEvent({ type: "pointerdown", ...hpatPointerEvent(petEl) });
  assert.ok(h.calls.playback.some((line) => line.startsWith("[ui] dragStart")), "生产 pointerdown 监听器已接收");
  assert.ok(h.dispatchWindow("pointerup", { type: "pointerup", pointerId: 1, clientX: 50, clientY: 50 }),
    "生产 pointerup 监听器注册在 window 上");
  // finishDrag(!wasDrag) 同步首拍：Q 弹必须已落在 spineObj 上（用户可见的摸头反馈本体）
  assert.ok(h.calls.playback.some((line) => line.startsWith("[ui] click 未拖动")), "生产链路分类为单击而非拖拽");
  assert.ok(Math.abs(h.obj.scale.y - pose.sy * 0.9) < 1e-9, "单击释放立即压缩到 0.9");
  assert.ok(Math.abs(h.obj.scale.x - pose.sx * 0.9) < 1e-9, "x 同步压缩（严格等比）");
  const mid = hpatBottom(h);
  assert.ok(Math.abs(mid.bottom - before.bottom) < 1e-6, "脚底锚定：单击压缩脚不离地");
  // 后续拍与 playSpineInteract 排程的 fit pass 并发（乐观并发语义已由 HPAT-2 锁定）：
  // 这里只锁终态契约——收敛到有限、等比、稳定的姿态，无残留压缩/回调。
  h.clock.advance(5000);
  const settled = hpatPose(h);
  assert.ok(Number.isFinite(settled.sx) && Number.isFinite(settled.sy) && settled.sy > 0, "收敛姿态有限且为正");
  assert.ok(Math.abs(settled.sx / settled.sy - 1) < 1e-9, "收敛姿态等比：无残留压缩/过冲");
  h.clock.advance(500);
  assert.deepEqual(hpatPose(h), settled, "收敛后无残留 Q 弹回调：状态可恢复");
});

test("HPAT-10: 端到端——拖拽（位移>3px）释放不触发 Q 弹，走拖动分支", async () => {
  const h = await hpatHarness();
  const petEl = h.elements.get("pet");
  const pose = hpatPose(h);
  petEl.dispatchEvent({ type: "pointerdown", ...hpatPointerEvent(petEl) });
  assert.ok(h.dispatchWindow("pointermove", { type: "pointermove", ...hpatPointerEvent(petEl, { screenX: 106, clientX: 56 }) }));
  h.clock.advance(100);
  assert.ok(h.dispatchWindow("pointermove", { type: "pointermove", ...hpatPointerEvent(petEl, { screenX: 112, clientX: 62 }) }));
  assert.ok(h.calls.playback.some((line) => line.startsWith("[ui] 判定为拖动")), "生产链路分类为拖动");
  h.clock.advance(500); // 样本窗（80ms）过期后释放：velocity=null，不进 throw 分支
  h.dispatchWindow("pointerup", { type: "pointerup", pointerId: 1, clientX: 62, clientY: 50 });
  assert.ok(!h.calls.playback.some((line) => line.startsWith("[ui] click 未拖动")), "拖动释放不得走单击分支");
  assert.deepEqual(hpatPose(h), pose, "拖动释放零 transform 写入：Q 弹绝不误触发");
  h.clock.advance(400); // 排空 dragReleaseTimer 等收尾
  assert.deepEqual(hpatPose(h), pose, "收尾后仍零写入（无排队回调）");
});

test("HPAT-11: prefers-reduced-motion 下 JS Q 弹整轮让位（对齐 GIF 侧 CSS backlog-1 契约）", async () => {
  const h = await hpatHarness();
  const pose = hpatPose(h);
  const original = h.sandbox.matchMedia;
  h.sandbox.matchMedia = (q) => ({ matches: String(q).includes("prefers-reduced-motion"), addEventListener() {} });
  try {
    h.lifecycle.headPatSquash();
    assert.deepEqual(hpatPose(h), pose, "reduced-motion：同步首拍零写入");
    h.clock.advance(400);
    assert.deepEqual(hpatPose(h), pose, "reduced-motion：排队拍同样零写入");
  } finally {
    h.sandbox.matchMedia = original;
  }
  h.lifecycle.headPatSquash();
  assert.ok(Math.abs(h.obj.scale.y - pose.sy * 0.9) < 1e-9, "系统设置恢复后 Q 弹照常：守卫不泄漏到正常路径");
  h.clock.advance(400);
  assert.deepEqual(hpatPose(h), pose, "正常一轮的收尾还原不受守卫影响");
});

/* ---------- Phase 6-D.3 渲染层消费契约（EXPERIMENTAL CAUSAL-PATH PROBE, NOT PRODUCT TUNING） ----------
 * 这里跑的是真实 production renderer：seam 暴露的就是 init 调用的同一个 adoptSleepIdleThreshold。
 * 断言渲染层「只消费 main 下发的阈值」：没有合法快照就回落 300000，绝不自算心情。 */
test("Phase 6-D.3: renderer 只消费快照阈值，非法快照一律回落 300000", () => {
  const h = createPetLifecycleHarness();
  const ctl = h.lifecycle.sleepIdleCtl;
  assert.ok(ctl, "sleepIdleCtl seam is exposed");

  assert.equal(ctl.resolved(), 300000, "初始值即改造前 5 * 60 * 1000 的逐位结果");

  // 合法快照：原样采用，渲染层不得自行改写
  ctl.adopt({ enabled: true, todayMood: "慵懒", sleepIdleThresholdMs: 30000 });
  assert.equal(ctl.resolved(), 30000, "合法快照被逐位采用");
  ctl.adopt({ enabled: true, todayMood: "元气", sleepIdleThresholdMs: 180000 });
  assert.equal(ctl.resolved(), 180000, "第二份合法快照同样被逐位采用");

  // 非法快照：回落（这条保证渲染层永远不会把 undefined/NaN 喂给 setTimeout）
  const bad = [undefined, null, {}, { sleepIdleThresholdMs: null },
    { sleepIdleThresholdMs: NaN }, { sleepIdleThresholdMs: Infinity },
    { sleepIdleThresholdMs: 0 }, { sleepIdleThresholdMs: -1 },
    { sleepIdleThresholdMs: "30000" }];
  for (const snapshot of bad) {
    ctl.adopt(snapshot);
    assert.equal(ctl.resolved(), 300000, "非法快照必须回落 300000：" + JSON.stringify(snapshot === undefined ? null : snapshot));
  }
});

console.log("render lifecycle contract 全部通过");

test("M1 renderer chat callbacks reject stale task ids and delayed completion", async () => {
  const h = createPetLifecycleHarness();
  await wait(120);
  h.lifecycle.setMoods([{ name: "idle", emotion: "" }, { name: "think", emotion: "" }, { name: "happy", emotion: "happy" }]);
  const thinking = h.handlers.onThinking;
  const chunk = h.handlers.onChunk;
  const done = h.handlers.onDone;
  const error = h.handlers.onError;
  const stopped = h.handlers.onStopped;
  h.sandbox.ErrorPresent = { presentError: () => "error" };
  h.sandbox.window.ErrorPresent = h.sandbox.ErrorPresent;
  const taskA = vm.runInNewContext("beginChatTask()", h.sandbox);
  thinking({ id: taskA, mode: "chat" });
  chunk({ id: taskA, mode: "chat", text: "A" });
  thinking({ id: "task-b", mode: "chat" });
  assert.equal(vm.runInNewContext("chatTaskId", h.sandbox), taskA);
  done({ id: "task-b", mode: "zcode", full: "stale" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), true);
  done({ id: taskA, mode: "zcode", full: "A" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);
  const taskB = vm.runInNewContext("beginChatTask()", h.sandbox);
  thinking({ id: taskB, mode: "chat" });
  stopped({ id: taskA });
  assert.equal(vm.runInNewContext("busy", h.sandbox), true);
  error({ id: taskA, message: "stale" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), true);
  done({ id: taskB, mode: "zcode", full: "B" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);
  const taskC = vm.runInNewContext("beginChatTask()", h.sandbox);
  thinking({ id: taskC, mode: "chat" });
  assert.equal(vm.runInNewContext("chatTaskId", h.sandbox), taskC);
  assert.equal(vm.runInNewContext("lastMood", h.sandbox), "think");
  await wait(80);
  assert.equal(vm.runInNewContext("lastMood", h.sandbox), "think",
    "late completion mood reset must not clear a newer task mood");
  error({ id: taskC, message: "current", code: "CURRENT" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);
  const taskD = vm.runInNewContext("beginChatTask()", h.sandbox);
  thinking({ id: taskD, mode: "chat" });
  stopped({ id: taskC });
  assert.equal(vm.runInNewContext("busy", h.sandbox), true);
  stopped({ id: taskD });
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);
});

test("M1 renderer applies accepted sleep projection in GIF mode and reports current owner metadata", async () => {
  const h = createPetLifecycleHarness();
  await wait(30);
  const walking = h.handlers.onWalking;
  assert.equal(typeof walking, "function");
  walking({ active: false, resting: true, seated: false, perched: false, paused: false, sleeping: true, face: 1 });
  assert.equal(vm.runInNewContext("isSleeping", h.sandbox), true);
  walking({ active: false, resting: true, seated: false, perched: false, paused: false, sleeping: false, face: 1 });
  assert.equal(vm.runInNewContext("isSleeping", h.sandbox), false);
  assert.ok(h.calls.bodyReadies.every((m) => m === null || m.usable === true));
});

test("M1 renderer keeps GIF sleep projection across ordinary moods until accepted wake", async () => {
  const h = createPetLifecycleHarness();
  await wait(120);
  h.lifecycle.setMoods([{ name: "idle", emotion: "" }, { name: "sleep", emotion: "" }, { name: "happy", emotion: "happy" }]);
  h.handlers.onWalking({ active: false, resting: true, seated: false, perched: false, paused: false, sleeping: true, face: 1 });
  assert.equal(vm.runInNewContext("isSleeping", h.sandbox), true);
  h.lifecycle.setMood("idle");
  h.lifecycle.setMood("happy");
  assert.equal(vm.runInNewContext("isSleeping", h.sandbox), true);
  assert.equal(vm.runInNewContext("lastMood", h.sandbox), "sleep");
  h.handlers.onWalking({ active: false, resting: false, seated: false, perched: false, paused: false, sleeping: false, face: 1 });
  assert.equal(vm.runInNewContext("isSleeping", h.sandbox), false);
  h.lifecycle.setMood("idle");
  assert.equal(vm.runInNewContext("lastMood", h.sandbox), "idle");
});

test("M1 renderer request owner covers sendText early done/error, stop, and regenerate", async () => {
  const h = createPetLifecycleHarness();
  await wait(120);
  h.lifecycle.setMoods([{ name: "idle", emotion: "" }, { name: "think", emotion: "" }, { name: "happy", emotion: "happy" }]);
  vm.runInNewContext("agreed = true", h.sandbox);
  h.sandbox.ErrorPresent = { presentError: () => "error" };
  h.sandbox.window.ErrorPresent = h.sandbox.ErrorPresent;
  const p1 = h.sandbox.sendText("quick");
  const id1 = h.calls.asks.at(-1).id;
  assert.ok(id1);
  h.handlers.onDone({ id: id1, mode: "zcode", full: "quick" });
  await p1;
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);

  const p2 = h.sandbox.sendText("error");
  const id2 = h.calls.asks.at(-1).id;
  h.handlers.onError({ id: id2, code: "CURRENT", message: "error" });
  await p2;
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);

  const p3 = h.sandbox.sendText("stop");
  const id3 = h.calls.asks.at(-1).id;
  h.handlers.onStopped({ id: "old" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), true);
  h.handlers.onStopped({ id: id3 });
  await p3;
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);

  h.elements.get("swipe-regen").dispatchEvent({ type: "click" });
  const regenId = h.calls.regenerates.at(-1);
  assert.ok(regenId);
  assert.equal(vm.runInNewContext("chatTaskId", h.sandbox), regenId);
  h.handlers.onDone({ id: regenId, mode: "zcode", full: "regen" });
  assert.equal(vm.runInNewContext("busy", h.sandbox), false);

  h.calls.regenerateResult = null;
  h.elements.get("swipe-regen").dispatchEvent({ type: "click" });
  await wait(0);
  assert.equal(vm.runInNewContext("busy", h.sandbox), false,
    "rejected/null regenerate must release only its captured owner");
});

test("M1 renderer zoom lease uses a per-document stable id and releases the captured id", async () => {
  const h = createPetLifecycleHarness();
  await wait(120);
  const zoom = h.elements.get("btn-zoom");
  zoom.dispatchEvent({ type: "click" });
  const first = h.calls.walkingPauses.at(-1);
  assert.ok(first && first[2], "zoom admission must carry an interaction id");
  zoom.dispatchEvent({ type: "click" });
  const release = h.calls.walkingPauses.at(-1);
  assert.equal(release[2], first[2], "zoom release must use the captured lease id");
  zoom.dispatchEvent({ type: "click" });
  const second = h.calls.walkingPauses.at(-1);
  assert.ok(second[2] && second[2] !== first[2], "reopened zoom must receive a fresh per-document id");
});

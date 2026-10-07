"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const samplerPath = path.join(__dirname, "../renderer/observed-body-sampler.js");
const samplerModule = fs.existsSync(samplerPath) ? require(samplerPath) : {};

function fixture() {
  assert.equal(typeof samplerModule.createObservedBodySampler, "function", "the request-scoped renderer sampler is not implemented");
  const renderer = new EventEmitter();
  renderer.setMaxListeners(32);
  const stage = {};
  const entry = {
    animation: { name: "Move" }, loop: true, trackTime: 2.25,
    nextTrackLast: 2.25, mixingFrom: null, mixTime: 0, mixDuration: 0.2
  };
  const obj = {
    parent: stage,
    state: { getCurrent(track) { assert.equal(track, 0); return entry; } },
    update() { assert.fail("observation must not advance the skeleton"); }
  };
  const app = { renderer, stage, render() { assert.fail("observation must not force a render"); } };
  const owner = { app, obj, context: { generation: 4 } };
  let current = { mode: "spine", ready: true, visible: true, bootstrapPending: false,
    renderModeSeq: 9, generation: 4, owner, app, obj };
  const replies = [];
  const timers = new Map();
  let timerId = 0, elapsed = 0;
  const sampler = samplerModule.createObservedBodySampler({
    getCurrent: () => current,
    reply: (value) => replies.push(value),
    now: () => 1800000000000 + elapsed,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: elapsed + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {
    sampler, renderer, stage, entry, obj, app, owner, replies, timers,
    current: () => current,
    replace: (patch) => { current = { ...current, ...patch }; },
    draw({ screen = true, rendered = stage } = {}) {
      renderer.renderingToScreen = screen;
      renderer.lastObjectRendered = rendered;
      renderer.emit("postrender");
    },
    advance(ms) {
      elapsed += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= elapsed && timers.has(id)) { timers.delete(id); timer.fn(); }
      }
    }
  };
}

function unknown(mode = "spine") {
  return { status: "unknown", mode, clip: null, sampledAt: null };
}

function assertClean(h) {
  assert.equal(h.renderer.listenerCount("postrender"), 0, "completed requests must release render listeners");
  assert.equal(h.timers.size, 0, "completed requests must release timers");
}

test("an animation request is not observed before a natural screen frame", () => {
  const h = fixture();
  h.sampler.request("request-a");
  assert.deepEqual(h.replies, []);
  h.advance(499);
  assert.deepEqual(h.replies, []);
  h.advance(1);
  assert.deepEqual(h.replies, [{ requestId: "request-a", renderModeSeq: 9, committedMode: "spine", animation: unknown() }]);
  assertClean(h);
});

test("a screen frame reports the current applied track and releases the request", () => {
  const h = fixture();
  h.sampler.request("request-a");
  h.draw();
  assert.deepEqual(h.replies, [{
    requestId: "request-a", renderModeSeq: 9, committedMode: "spine",
    animation: { status: "observed", mode: "spine", clip: "Move", track: 0, loop: true,
      trackTime: 2.25, mixingFrom: null, mixTime: 0, mixDuration: 0.2, sampledAt: 1800000000000 }
  }]);
  assertClean(h);
  h.entry.animation.name = "Sleep";
  h.draw();
  assert.equal(h.replies.length, 1, "a later draw must not emit a second reply");
});

test("offscreen fit renders do not consume a pending observation", () => {
  const h = fixture();
  h.sampler.request("request-a");
  h.draw({ screen: false, rendered: h.obj });
  assert.deepEqual(h.replies, []);
  assert.equal(h.timers.size, 1);
  h.entry.animation.name = "Relax";
  h.draw();
  assert.equal(h.replies[0].animation.clip, "Relax", "sample the subsequent screen frame, not the fit render");
  assertClean(h);
});

test("a draw of another stage cannot establish the captured owner's truth", () => {
  const h = fixture();
  h.sampler.request("request-a");
  h.draw({ rendered: {} });
  assert.deepEqual(h.replies, []);
  h.draw();
  assert.equal(h.replies[0].animation.status, "observed");
  assertClean(h);
});

test("a selected but unapplied TrackEntry remains unknown", () => {
  const h = fixture();
  h.entry.nextTrackLast = -1;
  h.sampler.request("request-a");
  h.draw();
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
});

test("a mixed frame retains the actual source clip and mix progress", () => {
  const h = fixture();
  h.entry.animation.name = "Move";
  h.entry.mixingFrom = { animation: { name: "Sit" } };
  h.entry.mixTime = 0.06;
  h.entry.mixDuration = 0.2;
  h.sampler.request("mixed");
  h.draw();
  assert.deepEqual(h.replies[0].animation, {
    status: "observed", mode: "spine", clip: "Move", track: 0, loop: true,
    trackTime: 2.25, mixingFrom: "Sit", mixTime: 0.06, mixDuration: 0.2, sampledAt: 1800000000000
  });
  assertClean(h);
});

test("a replaced owner cannot publish its old animation", () => {
  const h = fixture();
  h.sampler.request("old-owner");
  h.replace({ owner: { app: h.app, obj: h.obj, context: { generation: 4 } } });
  h.draw();
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
});

test("object replacement invalidates an outstanding request even when the app remains", () => {
  const h = fixture();
  h.sampler.request("old-object");
  h.replace({ obj: { ...h.obj } });
  h.draw();
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
});

test("a stale local render generation cannot report observed facts", () => {
  const h = fixture();
  h.sampler.request("old-generation");
  h.replace({ generation: 5 });
  h.draw();
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
});

test("a changed main render sequence returns unknown with current metadata", () => {
  const h = fixture();
  h.sampler.request("old-sequence");
  h.replace({ renderModeSeq: 10 });
  h.draw();
  assert.deepEqual(h.replies[0], { requestId: "old-sequence", renderModeSeq: 10, committedMode: "spine", animation: unknown() });
  assertClean(h);
});

test("a hidden bootstrap owner is not observed and allocates no frame wait", () => {
  const h = fixture();
  h.replace({ bootstrapPending: true, visible: false });
  h.sampler.request("bootstrap");
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
});

test("an owner hidden while waiting cannot attest a visible frame", () => {
  const h = fixture();
  h.sampler.request("hidden");
  h.replace({ visible: false });
  h.draw();
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
});

test("no active owner or no ready renderer returns unknown immediately", () => {
  for (const patch of [{ owner: null }, { ready: false }, { mode: null }]) {
    const h = fixture();
    h.replace(patch);
    h.sampler.request("unavailable");
    assert.deepEqual(h.replies[0].animation, unknown(patch.mode === null ? null : "spine"));
    assertClean(h);
  }
});

test("ready non-Spine modes report unsupported without inventing a clip", () => {
  for (const mode of ["gif", "rig", "live2d"]) {
    const h = fixture();
    h.replace({ mode });
    h.sampler.request("other-mode");
    assert.deepEqual(h.replies[0].animation, { status: "unsupported", mode, clip: null, sampledAt: null });
    assertClean(h);
  }
});

test("invalid engine data cannot escape as observed animation", () => {
  for (const patch of [{ trackTime: NaN }, { mixDuration: Infinity }, { animation: null }, { loop: undefined }]) {
    const h = fixture();
    Object.assign(h.entry, patch);
    h.sampler.request("invalid-engine-data");
    h.draw();
    assert.deepEqual(h.replies[0].animation, unknown());
    assertClean(h);
  }
});

test("late frames after no-frame timeout cannot resurrect an observation", () => {
  const h = fixture();
  h.sampler.request("stopped-ticker");
  h.advance(500);
  h.draw();
  assert.deepEqual(h.replies[0].animation, unknown());
  assert.equal(h.replies.length, 1);
  assertClean(h);
});

test("owner invalidation clears every pending listener and timer", () => {
  const h = fixture();
  for (let i = 0; i < 16; i++) h.sampler.request("pending-" + i);
  h.sampler.invalidate();
  assert.equal(h.replies.length, 16);
  assert.ok(h.replies.every(value => value.animation.status === "unknown"));
  assertClean(h);
  h.sampler.request("new-owner-request");
  h.draw();
  assert.equal(h.replies.at(-1).animation.status, "observed", "invalidation does not disable later owners");
  assertClean(h);
});

test("the seventeenth concurrent request fails closed without expanding pending resources", () => {
  const h = fixture();
  for (let i = 0; i < 17; i++) h.sampler.request("pending-" + i);
  assert.deepEqual(h.replies, [{ requestId: "pending-16", renderModeSeq: 9, committedMode: "spine", animation: unknown() }]);
  assert.equal(h.timers.size, 16);
  assert.equal(h.renderer.listenerCount("postrender"), 16);
  h.draw();
  assert.equal(h.replies.length, 17);
  assert.equal(h.replies.filter(value => value.animation.status === "observed").length, 16);
  assertClean(h);
});

test("a duplicate request ID cannot allocate a second pending observation", () => {
  const h = fixture();
  h.sampler.request("same-id");
  h.sampler.request("same-id");
  assert.equal(h.timers.size, 1);
  assert.equal(h.renderer.listenerCount("postrender"), 1);
  h.draw();
  assert.equal(h.replies.length, 1);
  assertClean(h);
});

test("document teardown clears pending observations and prevents later sampling", () => {
  const h = fixture();
  h.sampler.request("before-teardown");
  h.sampler.destroy();
  assert.deepEqual(h.replies[0].animation, unknown());
  assertClean(h);
  h.sampler.request("after-teardown");
  h.draw();
  assert.equal(h.replies.at(-1).animation.status, "unknown");
  assertClean(h);
});

test("loading the browser helper creates no timers or observers", () => {
  assert.ok(fs.existsSync(samplerPath), "the browser helper has not been implemented");
  const browser = { window: {}, setTimeout() { assert.fail("loading must not start timers"); }, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(samplerPath, "utf8"), browser);
  assert.equal(typeof browser.window.ObservedBodySampler.createObservedBodySampler, "function");
  const api = browser.window.ObservedBodySampler.createObservedBodySampler({ getCurrent: () => null, reply() {} });
  assert.equal(typeof api.request, "function");
});

test("preload observation replies force the private document identity after caller fields", () => {
  let api;
  const sent = [], handlers = new Map();
  const identity = { docEpoch: 19, bodyGeneration: 19 };
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "petAPI"); api = value; } },
    webUtils: {},
    ipcRenderer: {
      sendSync(channel) { return channel === "pet:body-document-sync" ? identity : "2.5.30"; },
      send(...args) { sent.push(args); },
      on(channel, fn) { handlers.set(channel, fn); }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8"), {
    require(name) { assert.equal(name, "electron"); return electron; }, process: { env: {} }
  });
  assert.equal(typeof api.onObservedBodyRequest, "function", "the observation request bridge is missing");
  assert.equal(typeof api.reportObservedBodyTruth, "function", "the private identity observation reply bridge is missing");
  let requested;
  api.onObservedBodyRequest(value => { requested = value; });
  handlers.get("pet:observed-body-request")({}, "request-a");
  assert.equal(requested, "request-a");
  api.reportObservedBodyTruth({ requestId: "request-a", bodyIdentity: { docEpoch: 0, bodyGeneration: 0 }, animation: unknown() });
  assert.equal(sent[0][0], "pet:observed-body-truth");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), {
    requestId: "request-a", bodyIdentity: { docEpoch: 19, bodyGeneration: 19 }, animation: unknown()
  });
});

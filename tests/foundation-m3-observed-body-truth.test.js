"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadMain } = require("./helpers/main-body-harness");

function open({ mode = "spine", ready = true, requireOverrides = {} } = {}) {
  const h = loadMain({ requireOverrides });
  const win = h.createWindow();
  const identity = h.syncDocument();
  if (mode !== "spine") h.context.__m1.call("dispatchRenderModeIntent", mode);
  if (ready) {
    h.outcome(identity, { requestedMode: mode, committedMode: mode, ok: true });
    h.ready(identity, { committedMode: mode, usable: true });
  }
  return { h, win, identity };
}

function pull(h) {
  const fn = h.context.__m1.probe("getObservedBodyTruth");
  assert.equal(typeof fn, "function", "main must expose the request-scoped Body truth read");
  return fn();
}

function latestRequest(h) {
  const requests = h.messages().filter((message) => message.name === "pet:observed-body-request");
  assert.ok(requests.length, "a ready visual owner must receive an observation request");
  assert.equal(typeof requests.at(-1).args[0], "string");
  return requests.at(-1).args[0];
}

function animation(h, patch = {}) {
  return {
    status: "observed", mode: "spine", clip: "Idle", track: 0, loop: true,
    trackTime: 0.25, mixingFrom: null, mixTime: 0, mixDuration: 0,
    sampledAt: h.clock.now, ...patch
  };
}

function report(h, identity, requestId, patch = {}, event = h.event()) {
  const handler = h.handler("pet:observed-body-truth");
  assert.equal(typeof handler, "function", "renderer truth must enter the guarded main boundary");
  return handler(event, {
    requestId, renderModeSeq: h.state.renderModeSeq, committedMode: "spine",
    animation: animation(h), bodyIdentity: identity, ...patch
  });
}

async function readWithAck(h, identity, patch = {}) {
  const pending = pull(h);
  report(h, identity, latestRequest(h), patch);
  return pending;
}

test("M3 T1 current correlated renderer observation becomes a finite native snapshot", async () => {
  const { h, win, identity } = open();
  win.__setBounds({ x: 32, y: 48, width: 300, height: 240 });
  const snapshot = await readWithAck(h, identity);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.protocolVersion, 1);
  assert.equal(snapshot.bodyImplementationId, "suzuran-desktop-agent-v0.1");
  assert.deepEqual(snapshot.generation, { docEpoch: identity.docEpoch, bodyGeneration: identity.bodyGeneration });
  assert.deepEqual(snapshot.geometry, { x: 32, y: 48, width: 300, height: 240 });
  assert.deepEqual(snapshot.posture, { visual: "unknown", sleeping: false, dragging: false });
  assert.deepEqual(snapshot.animation, animation(h));
});

test("M3 T2 current frame carrying an old or future identity cannot supply truth", async () => {
  for (const difference of [-1, 1]) {
    const { h, identity } = open();
    const pending = pull(h);
    const requestId = latestRequest(h);
    report(h, { ...identity, bodyGeneration: identity.bodyGeneration + difference }, requestId);
    h.advance(750);
    assert.equal((await pending).animation.status, "unknown");
  }
});

test("M3 T3 actual Electron navigation details advance the existing M1 identity", () => {
  const { h, win, identity } = open();
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html", false, true, 1, 1);
  const current = h.syncDocument();
  assert.ok(current.docEpoch > identity.docEpoch);
  assert.ok(current.bodyGeneration > identity.bodyGeneration);
  assert.equal(h.state.v2StateCore.lifecycle.ready(), false);
});

test("M3 same-document and subframe navigation retain the current M1 identity", () => {
  const { h, win, identity } = open();
  for (const details of [
    { isMainFrame: true, isSameDocument: true },
    { isMainFrame: false, isSameDocument: false }
  ]) win.webContents.emit("did-start-navigation", details, "file:///renderer/index.html#same");
  assert.deepEqual(h.syncDocument(), identity);
  assert.equal(h.state.v2StateCore.lifecycle.ready(), true);
});

test("M3 T4 pending old renderer request cannot return A after B navigation", async () => {
  const { h, win, identity } = open();
  const oldFrame = win.webContents.mainFrame;
  const pending = pull(h);
  const oldRequestId = latestRequest(h);
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html");
  win.webContents.__newDocument();
  const current = h.syncDocument();
  report(h, identity, oldRequestId, {}, { sender: win.webContents, senderFrame: oldFrame });
  const snapshot = await pending;
  assert.deepEqual(snapshot.generation, { docEpoch: current.docEpoch, bodyGeneration: current.bodyGeneration });
  assert.notDeepEqual(snapshot.generation, identity);
  assert.equal(snapshot.animation.status, "unknown");
  assert.equal(snapshot.animation.clip, null);
});

test("M3 T5 main lifetimes seed the existing identity and keep same-lifetime advancement", () => {
  const first = open();
  const second = open();
  assert.ok(Number.isSafeInteger(first.identity.docEpoch) && first.identity.docEpoch > 0);
  assert.notDeepEqual(second.identity, first.identity, "a fresh process lifetime must not always restart at the same pair");
  first.win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html");
  assert.ok(first.h.syncDocument().docEpoch > first.identity.docEpoch);
});

test("M3 T6-T8 native bounds stay distinct from a successful command until native state changes", async () => {
  const { h, win, identity } = open();
  win.__setBounds({ x: 7, y: 8, width: 260, height: 200 });
  let commanded;
  win.setPosition = (x, y) => { commanded = { x, y }; };
  const committed = h.state.v2Commit.commitLegacy({ x: 100, y: 120, kind: "test-delayed-native" });
  assert.equal(committed.ok, true);
  assert.deepEqual(commanded, { x: 100, y: 120 });
  const beforeNative = await readWithAck(h, identity);
  assert.deepEqual(beforeNative.geometry, { x: 7, y: 8, width: 260, height: 200 });
  win.__setBounds({ x: 100, y: 120 });
  const afterNative = await readWithAck(h, identity);
  assert.deepEqual(afterNative.geometry, { x: 100, y: 120, width: 260, height: 200 });
});

test("M3 T9 document replacement does not fabricate native geometry", async () => {
  const { h, win } = open();
  win.__setBounds({ x: 71, y: 82, width: 333, height: 222 });
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html");
  const snapshot = await pull(h);
  assert.deepEqual(snapshot.geometry, { x: 71, y: 82, width: 333, height: 222 });
  assert.equal(snapshot.animation.status, "unknown");
});

test("M3 T10 requested walking control and missing renderer ack remain unknown", async () => {
  const { h } = open();
  h.state.walk.active = true;
  h.state.walk.phase = "move";
  const pending = pull(h);
  h.advance(750);
  const snapshot = await pending;
  assert.equal(snapshot.animation.status, "unknown");
  assert.equal(snapshot.animation.clip, null);
  assert.equal(snapshot.posture.visual, "unknown");
});

test("M3 T11 animation uses the correlated response and clones only bounded mixed-track facts", async () => {
  const { h, identity } = open();
  const sample = animation(h, { clip: "Move", mixingFrom: "Idle", mixTime: 0.1, mixDuration: 0.3, ignored: "drop" });
  const snapshot = await readWithAck(h, identity, { animation: sample });
  sample.clip = "changed-after-send";
  assert.equal(snapshot.animation.clip, "Move");
  assert.equal(snapshot.animation.mixingFrom, "Idle");
  assert.equal(snapshot.animation.mixTime, 0.1);
  assert.equal(snapshot.animation.mixDuration, 0.3);
  assert.equal(Object.hasOwn(snapshot.animation, "ignored"), false);
});

test("M3 T12 stale mode and wrong request acknowledgements are ignored", async () => {
  for (const kind of ["request", "sequence", "mode", "frame"]) {
    const { h, identity } = open();
    const pending = pull(h);
    const requestId = latestRequest(h);
    const patch = kind === "request" ? { requestId: "unissued" }
      : kind === "sequence" ? { renderModeSeq: h.state.renderModeSeq + 1 }
        : kind === "mode" ? { committedMode: "gif" } : {};
    const event = kind === "frame" ? { sender: h.state.win.webContents, senderFrame: { routingId: 99 } } : h.event();
    report(h, identity, requestId, patch, event);
    h.advance(750);
    assert.equal((await pending).animation.status, "unknown", kind);
  }
});

test("M3 T13 new renderer establishes truth and a later old observation cannot pollute another pull", async () => {
  const { h, win, identity } = open();
  const oldFrame = win.webContents.mainFrame;
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html");
  win.webContents.__newDocument();
  const current = h.syncDocument();
  h.outcome(current, { committedMode: "spine", ok: true });
  h.ready(current, { committedMode: "spine", usable: true });
  assert.equal((await readWithAck(h, current, { animation: animation(h, { clip: "B" }) })).animation.clip, "B");
  const pending = pull(h);
  report(h, identity, latestRequest(h), { animation: animation(h, { clip: "A" }) }, { sender: win.webContents, senderFrame: oldFrame });
  h.advance(750);
  assert.equal((await pending).animation.clip, null, "no cached B or stale A may satisfy the new request");
});

test("M3 T14 semantic seated posture is not presented as observed visual posture", async () => {
  const { h, identity } = open();
  h.context.__m1.setBodyPosture({ seated: true }, { source: "m3-test" });
  const snapshot = await readWithAck(h, identity, { animation: animation(h, { clip: "Sit" }) });
  assert.deepEqual(snapshot.posture, { visual: "unknown", sleeping: false, dragging: false });
});

test("M3 T15 sleep is canonical main truth rather than a Sleep clip name", async () => {
  const { h, identity } = open();
  const clipOnly = await readWithAck(h, identity, { animation: animation(h, { clip: "Sleep" }) });
  assert.equal(clipOnly.posture.sleeping, false);
  h.handler("pet:set-sleeping")(h.event(), true, identity);
  const acceptedSleep = await readWithAck(h, identity, { animation: animation(h, { clip: "Idle" }) });
  assert.equal(acceptedSleep.posture.sleeping, true);
  h.handler("pet:set-sleeping")(h.event(), false, identity);
  assert.equal((await readWithAck(h, identity)).posture.sleeping, false);
});

test("M3 T16 dragging requires both canonical drag session and matching pause occupancy", async () => {
  const { h, identity } = open();
  h.state.walk.dragPaused = true;
  assert.equal((await readWithAck(h, identity)).posture.dragging, false);
  const pause = h.handler("pet:walking-pause");
  pause(h.event(), true, "drag", "drag-m3", identity);
  assert.equal((await readWithAck(h, identity)).posture.dragging, true);
  pause(h.event(), false, "drag", "stale-drag", identity);
  assert.equal((await readWithAck(h, identity)).posture.dragging, true);
  pause(h.event(), false, "drag", "drag-m3", identity);
  assert.equal((await readWithAck(h, identity)).posture.dragging, false);
});

test("M3 T17 non-Spine acknowledgement stays honestly unsupported", async () => {
  const { h, identity } = open({ mode: "gif" });
  const snapshot = await readWithAck(h, identity, {
    committedMode: "gif", animation: { status: "unsupported", mode: "gif", clip: null, sampledAt: null }
  });
  assert.deepEqual(snapshot.animation, { status: "unsupported", mode: "gif", clip: null, sampledAt: null });
});

test("M3 no live native window returns unavailable without a stale snapshot", async () => {
  const { h, identity } = open();
  await readWithAck(h, identity);
  h.setWindow(null);
  assert.deepEqual(await pull(h), { ok: false, reason: "unavailable" });
});

test("M3 pending requests are bounded and expire without creating retained truth", async () => {
  const { h } = open();
  const pending = Array.from({ length: 17 }, () => pull(h));
  assert.equal(h.messages().filter((message) => message.name === "pet:observed-body-request").length, 16);
  assert.equal((await pending.at(-1)).animation.status, "unknown");
  h.advance(750);
  assert.ok((await Promise.all(pending)).every((snapshot) => snapshot.animation.status === "unknown"));
  const fresh = pull(h);
  h.advance(750);
  assert.equal((await fresh).animation.clip, null);
});

test("M3 malformed and future renderer samples cannot become observed animation", async () => {
  for (const patch of [
    { trackTime: Infinity }, { mixTime: -1 }, { mixDuration: NaN },
    { sampledAt: 1000 }, { track: 1 }, { loop: "true" }, { clip: "x".repeat(257) },
    { status: "invented" }, { mode: "gif" }
  ]) {
    const { h, identity } = open();
    const pending = pull(h);
    report(h, identity, latestRequest(h), { animation: animation(h, patch) });
    h.advance(750);
    assert.equal((await pending).animation.status, "unknown", JSON.stringify(patch));
  }
});

test("M3 an unready visual owner is not sampled or invented", async () => {
  const { h } = open({ ready: false });
  const snapshot = await pull(h);
  assert.equal(snapshot.animation.status, "unknown");
  assert.equal(snapshot.animation.clip, null);
  assert.equal(h.messages().some((message) => message.name === "pet:observed-body-request"), false);
});

test("M3 mode replacement releases pending observation without carrying the prior clip", async () => {
  const { h } = open();
  const pending = pull(h);
  h.context.__m1.call("dispatchRenderModeIntent", "gif");
  const snapshot = await pending;
  assert.equal(snapshot.animation.status, "unknown");
  assert.equal(snapshot.animation.clip, null);
});

test("M3 closing the native window releases pending observation as unavailable", async () => {
  const { h, win } = open();
  const pending = pull(h);
  win.__emitWindow("closed");
  assert.deepEqual(await pending, { ok: false, reason: "unavailable" });
});

test("M3 accepted fallback owner replacement releases a pending prior-owner read", async () => {
  const { h, identity } = open();
  let result;
  const pending = pull(h).then((snapshot) => { result = snapshot; });
  h.outcome(identity, { requestedMode: "spine", committedMode: "gif", ok: false });
  await Promise.resolve();
  await Promise.resolve();
  try {
    assert.ok(result, "changing the accepted owner must release the old pending request");
    assert.equal(result.animation.status, "unknown");
    assert.equal(result.animation.mode, "gif");
  } finally {
    h.advance(750);
    await pending;
  }
});

test("M3 acknowledged A invalidated before the read resumes returns current B without A clip", async () => {
  const { h, win, identity } = open();
  const pending = pull(h);
  report(h, identity, latestRequest(h), { animation: animation(h, { clip: "A" }) });
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html");
  const current = h.syncDocument();
  const snapshot = await pending;
  assert.deepEqual(snapshot.generation, { docEpoch: current.docEpoch, bodyGeneration: current.bodyGeneration });
  assert.equal(snapshot.animation.clip, null);
});

test("M3 broken native reads are unavailable rather than retaining prior geometry", async () => {
  for (const broken of [() => { throw new Error("native unavailable"); }, () => ({ x: 1, y: Infinity, width: 100, height: 100 })]) {
    const { h, win, identity } = open();
    await readWithAck(h, identity);
    win.getBounds = broken;
    assert.deepEqual(await readWithAck(h, identity), { ok: false, reason: "unavailable" });
  }
});

test("M3 old sample timestamps and duplicated acknowledgements cannot satisfy a fresh request", async () => {
  const { h, identity } = open();
  await readWithAck(h, identity);
  h.advance(10);
  const pending = pull(h);
  const requestId = latestRequest(h);
  report(h, identity, requestId, { animation: animation(h, { sampledAt: 0, clip: "old" }) });
  report(h, identity, requestId, { animation: animation(h, { clip: "current" }) });
  report(h, identity, requestId, { animation: animation(h, { clip: "duplicate" }) });
  assert.equal((await pending).animation.clip, "current");
});

function apiBoundary() {
  let handler;
  const server = {
    on() { return server; }, listen(_port, host, callback) { assert.equal(host, "127.0.0.1"); callback(); },
    close(callback) { callback(); }, closeAllConnections() {}, setTimeout() {}
  };
  const fakeHttp = { createServer(fn) { handler = fn; return server; } };
  const opened = open({ requireOverrides: {
    http: fakeHttp, "./src/agent-auth": require("../src/agent-auth"),
    "./src/body-capabilities": require("../src/body-capabilities"),
    "./src/error-facts": require("../src/error-facts")
  } });
  opened.h.config.saveConfig({ agentApi: { enabled: true, bearerToken: "m3-test-token", clients: [], port: 19876 } });
  opened.h.context.__m1.call("startAgentApi");
  assert.equal(typeof handler, "function");
  async function request({ token = "m3-test-token", method = "GET", pathname = "/observed-state", afterAck, onPublication } = {}) {
    let result;
    let status;
    const req = { url: pathname, method, headers: token === null ? {} : { authorization: "Bearer " + token } };
    const res = { writeHead(code) { status = code; }, end(body) {
      if (onPublication) onPublication();
      result = { status, body: JSON.parse(body) };
    } };
    const pending = handler(req, res);
    const sent = opened.h.messages().filter((message) => message.name === "pet:observed-body-request");
    if (sent.length) report(opened.h, opened.h.syncDocument(), sent.at(-1).args[0]);
    if (afterAck) queueMicrotask(afterAck);
    await pending;
    return result;
  }
  return { ...opened, request };
}

test("M3 observed-state is a guarded GET route and returns the raw fresh snapshot", async () => {
  const { request } = apiBoundary();
  assert.equal((await request({ token: null })).status, 401);
  assert.equal((await request({ token: "wrong-token" })).status, 401);
  assert.equal((await request({ method: "POST" })).status, 405);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.animation.status, "observed");
  assert.equal(Object.hasOwn(response.body, "snapshot"), false);
});

test("M3 observed-state fails closed with empty credentials and returns 503 without a window", async () => {
  const { h, request } = apiBoundary();
  h.config.saveConfig({ agentApi: { enabled: true, bearerToken: "", clients: [] } });
  assert.equal((await request({ token: null })).status, 401);
  h.config.saveConfig({ agentApi: { enabled: true, bearerToken: "m3-test-token", clients: [] } });
  h.setWindow(null);
  const response = await request();
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { ok: false, reason: "unavailable" });
});

test("M3 HTTP response observes its generation at the actual synchronous publication boundary", async () => {
  const { h, win, identity, request } = apiBoundary();
  let identityWhenSent;
  const response = await request({ afterAck: () => {
    win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }, "file:///renderer/index.html");
  }, onPublication: () => { identityWhenSent = h.syncDocument(); } });
  // If an asynchronous return allows navigation between construction and send,
  // a response marked A would be published while the main authority is already B.
  assert.ok(identityWhenSent);
  assert.equal(response.body.generation.docEpoch, identityWhenSent.docEpoch);
  assert.equal(response.body.generation.bodyGeneration, identityWhenSent.bodyGeneration);
  assert.ok(h.syncDocument().docEpoch > identity.docEpoch);
});

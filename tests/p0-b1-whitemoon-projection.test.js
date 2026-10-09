/**
 * p0-b1-whitemoon-projection.test.js — 只读投影客户端（§11/§28 传输分级）
 * 用本地 HTTP 假 Host（契约由 whitemoon-runtime-host 仓库测试固定）验证 Body 侧
 * 客户端把每种状态诚实归级：绝不把失败读成"空投影成功"（R8 的客户端前提）。
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createProjectionClient, classifyHttpResult } = require("../src/whitemoon-projection");

function fakeHost(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
      })
    );
  });
}

test("request shape: GET /character-projection with the ingress Bearer, nothing else", async () => {
  const host = await fakeHost((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "OK", surfaceVersion: 1, character: { instanceId: "A", packageId: "sussurro", displayName: "S", projectionSemanticsVersion: 2, state: {}, relationship: {} }, observedAt: "2026-10-09T00:00:00.000Z" }));
  });
  const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl: host.baseUrl, token: "ingress-tok" }) });
  const r = await client.fetchProjection();
  assert.equal(r.state, "ok");
  assert.equal(r.projection.character.instanceId, "A");
  assert.equal(host.requests.length, 1);
  assert.equal(host.requests[0].method, "GET");
  assert.equal(host.requests[0].url, "/character-projection");
  assert.equal(host.requests[0].auth, "Bearer ingress-tok");
  await host.close();
});

test("honest status mapping: HOST_NOT_READY / INSTANCE_UNAVAILABLE / PACKAGE_MISMATCH", async () => {
  for (const [status, code, expectedState] of [
    ["HOST_NOT_READY", 503, "host_not_ready"],
    ["INSTANCE_UNAVAILABLE", 503, "instance_unavailable"],
    ["PACKAGE_MISMATCH", 409, "package_mismatch"]
  ]) {
    const host = await fakeHost((req, res) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, status, error: "honest failure text" }));
    });
    const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl: host.baseUrl, token: "t" }) });
    const r = await client.fetchProjection();
    assert.equal(r.state, expectedState, status);
    assert.ok(!r.projection, status + " must not masquerade as a projection");
    await host.close();
  }
});

test("401/403 → unauthorized（token 问题明确失败，绝不静默降级）", async () => {
  const host = await fakeHost((req, res) => { res.writeHead(401); res.end("{}"); });
  const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl: host.baseUrl, token: "wrong" }) });
  const r = await client.fetchProjection();
  assert.equal(r.state, "unauthorized");
  await host.close();
});

test("connection refused → unavailable; closed host never fakes empty success", async () => {
  const host = await fakeHost((req, res) => { res.writeHead(200); res.end("{}"); });
  const baseUrl = host.baseUrl;
  await host.close();
  const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl, token: "t" }) });
  const r = await client.fetchProjection();
  assert.equal(r.state, "unavailable");
});

test("200 with a malformed/empty-character body is a failure, not an empty projection", async () => {
  const cases = [
    (res) => { res.writeHead(200); res.end("not json"); },
    (res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, status: "OK" })); }
  ];
  for (const send of cases) {
    const host = await fakeHost((req, res) => send(res));
    const client = createProjectionClient({ getEndpoint: () => ({ enabled: true, baseUrl: host.baseUrl, token: "t" }) });
    const r = await client.fetchProjection();
    assert.notEqual(r.state, "ok");
    await host.close();
  }
});

test("disabled endpoint never touches the network", async () => {
  const host = await fakeHost((req, res) => { res.writeHead(200); res.end("{}"); });
  const client = createProjectionClient({ getEndpoint: () => ({ enabled: false, baseUrl: host.baseUrl, token: "" }) });
  const r = await client.fetchProjection();
  assert.equal(r.state, "disabled");
  assert.equal(host.requests.length, 0);
  await host.close();
});

test("classifyHttpResult unit shape", () => {
  assert.equal(classifyHttpResult({ status: 200, ok: true }, { ok: true, status: "OK", character: {} }).state, "ok");
  assert.equal(classifyHttpResult({ status: 404, ok: false }, null).state, "failed");
});

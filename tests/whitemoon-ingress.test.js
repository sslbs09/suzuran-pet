"use strict";
/**
 * whitemoon-ingress.test.js — Phase 11-E.1 Body 侧 ingress 单元测试。
 *
 * 覆盖：
 *   T14  UI 提交只产生不透明动作（{ actionId, type, note }，无任何角色语义字段）
 *   T16  Host 不可达保留 pending 提交（同一 actionId 重试）
 *   T17  unknown 保留同一 actionId；确认成功才铸造新 actionId；编辑成新提交换新 ID
 *   T15  Body ingress 面不含角色 Experience 词汇（源码扫描）
 *
 * 传输用注入的 fetchImpl 模拟，绝不发真实网络请求。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createObservationIngress } = require("../src/whitemoon-ingress");

const ROOT = path.join(__dirname, "..");
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function makeIngress({ impl, endpoint } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (impl) return impl(calls.length, url, options);
    throw Object.assign(new Error("no impl"), { cause: { code: "ECONNREFUSED" } });
  };
  let counter = 0;
  const ingress = createObservationIngress({
    getEndpoint: () =>
      endpoint || { enabled: true, baseUrl: "http://127.0.0.1:8790", token: "ingress-token-value" },
    newActionId: () => (counter++ === 0 ? UUID_A : UUID_B),
    fetchImpl,
    timeoutMs: 50
  });
  return { ingress, calls };
}

test("T14: 提交只产生不透明动作（字段恰为 actionId/type/note），无任何角色语义字段", async () => {
  const { ingress, calls } = makeIngress({
    impl: () => ({ ok: true, status: 200, json: async () => ({ ok: true, outcome: "recorded", actionId: UUID_A }) })
  });
  const result = await ingress.submit("今天给薄荷浇了水");
  assert.equal(result.state, "recorded");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8790/integration-input");
  const body = calls[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["actionId", "note", "type"].sort());
  assert.equal(body.type, "record-observation");
  assert.equal(body.note, "今天给薄荷浇了水");
  assert.match(body.actionId, /^[0-9a-f-]{36}$/);
  // actionId 由主进程铸造，不来自渲染层
  assert.equal(calls[0].options.headers.Authorization, "Bearer ingress-token-value");
});

test("T14b: 空笔记不是提交尝试——不打网络、不铸造 actionId", async () => {
  const { ingress, calls } = makeIngress();
  const result = await ingress.submit("   ");
  assert.equal(result.state, "invalid");
  assert.equal(calls.length, 0);
  assert.equal(ingress.pendingAction(), null);
});

test("T16: Host 不可达 → unavailable，pending 保留，重试复用同一 actionId", async () => {
  const { ingress, calls } = makeIngress(); // 默认 ECONNREFUSED
  const first = await ingress.submit("同一句话");
  assert.equal(first.state, "unavailable");
  assert.equal(ingress.pendingAction().actionId, UUID_A);

  // 重试：同一 actionId + 同一 note
  const second = await ingress.submit("同一句话");
  assert.equal(second.state, "unavailable");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.actionId, UUID_A, "重试复用同一 actionId");
  assert.equal(calls[1].body.note, "同一句话");
});

test("T17: unknown（超时）保留同一 actionId 供重试", async () => {
  const { ingress, calls } = makeIngress({
    impl: async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
  });
  const first = await ingress.submit("可能已经记下了");
  assert.equal(first.state, "unknown");
  const retry = await ingress.submit("可能已经记下了");
  assert.equal(retry.state, "unknown");
  assert.equal(calls[1].body.actionId, UUID_A, "unknown 后重试仍是同一提交身份");
});

test("T17b: 确认成功（recorded/duplicate）才清空 pending；下一次提交铸造新 actionId", async () => {
  const { ingress, calls } = makeIngress({
    impl: () => ({ ok: true, status: 200, json: async () => ({ ok: true, outcome: "recorded" }) })
  });
  await ingress.submit("第一条");
  assert.equal(ingress.pendingAction(), null);
  await ingress.submit("第二条");
  assert.equal(calls[1].body.actionId, UUID_B, "新提交获得新 actionId");
});

test("T17c: 编辑成不同内容 = 放弃原提交、发起全新提交 → 换新 actionId", async () => {
  const { ingress, calls } = makeIngress(); // 一直不可达
  await ingress.submit("原话");
  await ingress.submit("改过的话");
  assert.equal(calls[1].body.actionId, UUID_B, "内容变了就是新提交");
  // 再改回原话：此时 pending 已是「改过的话」，新提交身份继续向前
  await ingress.submit("原话");
  assert.equal(calls.length, 3);
});

test("T17d: 幂等重复成功（duplicate）同样清空 pending 并算作成功", async () => {
  const { ingress } = makeIngress({
    impl: () => ({ ok: true, status: 200, json: async () => ({ ok: true, outcome: "duplicate", actionId: UUID_A }) })
  });
  const first = await ingress.submit("重复的话");
  assert.equal(first.state, "duplicate");
  assert.equal(ingress.pendingAction(), null);
});

test("T17e: conflict / invalid 显式返回；HTTP 401 → failed；应答 actionId 不匹配 → unknown", async () => {
  const mk = (impl) => makeIngress({ impl });
  {
    const { ingress } = mk(() => ({ ok: true, status: 409, json: async () => ({ ok: false, outcome: "conflict", error: "x", actionId: UUID_A }) }));
    const r = await ingress.submit("conf");
    assert.equal(r.state, "conflict");
    assert.ok(ingress.pendingAction(), "conflict 后 pending 保留（内容保留，用户可编辑重提）");
  }
  {
    const { ingress } = mk(() => ({ ok: true, status: 400, json: async () => ({ ok: false, outcome: "invalid-content", error: "y", actionId: UUID_A }) }));
    const r = await ingress.submit("inv");
    assert.equal(r.state, "invalid");
  }
  {
    const { ingress } = mk(() => ({ ok: true, status: 401, json: async () => ({ error: "no" }) }));
    const r = await ingress.submit("auth");
    assert.equal(r.state, "failed");
  }
  {
    const { ingress } = mk(() => ({ ok: true, status: 200, json: async () => ({ ok: true, outcome: "recorded", actionId: UUID_B }) }));
    const r = await ingress.submit("mis");
    assert.equal(r.state, "unknown", "应答归属无法确认时按 unknown 处理，绝不算成功");
    assert.ok(ingress.pendingAction());
  }
});

test("T17f: 未启用 / 未配置地址 → disabled，不打网络", async () => {
  const { ingress, calls } = makeIngress({ endpoint: { enabled: false, baseUrl: "", token: "" } });
  const r = await ingress.submit("没开开关");
  assert.equal(r.state, "disabled");
  assert.equal(calls.length, 0);
});

test("T15: Body ingress 面不含角色 Experience 词汇（源码扫描，防语义越界）", () => {
  const files = [
    "src/whitemoon-ingress.js",
    "renderer/observation.js",
    "renderer/observation.html",
    "preload.js"
  ];
  const forbidden = [
    /shared-event/i,
    /observation-booklet/i,
    /entry-added/i,
    /noteKind/i,
    /entryKey/i,
    /recordExperience/i,
    /booklet/i
  ];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${rel} 不得出现角色语义词汇 ${pattern} —— Body 只拥有不透明动作与传输`
      );
    }
  }
  // WHITEMOON_HOST_TOKEN（Host master 能力）绝不出现在 Body 的任何取值路径
  for (const rel of ["src/whitemoon-ingress.js", "src/config.js", "src/secrets.js", "preload.js"]) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/WHITEMOON_HOST_TOKEN/.test(source), false, `${rel} 不得引用 Host master token`);
  }
});

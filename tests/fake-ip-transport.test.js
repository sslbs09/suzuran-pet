/** P02 fake-ip 运输令牌策略单测 —— 允许路径最小化 + 攻击边界全维持（Phase C 1-9 / Phase D 1-7） */
"use strict";
const assert = require("assert");
const {
  assertSafeHttpUrl, safeFetch, attestFakeIpTransport,
  resetFakeIpAttestation, inCidr
} = require("../src/safe-url");

let failures = 0;
async function okA(name, fn) { try { await fn(); console.log("PASS", name); } catch (e) { failures++; console.log("FAIL", name, "-", e.message); } }
function ok(name, fn) { try { fn(); console.log("PASS", name); } catch (e) { failures++; console.log("FAIL", name, "-", e.message); } }

const POOL = "198.18.0.0/16";
const activeAtt = async () => POOL;
const deadAtt = async () => null;
const mkLookup = (map) => async (host) => {
  const rows = map[host];
  if (!rows) throw Object.assign(new Error("ENOTFOUND " + host), { code: "ENOTFOUND" });
  return rows.map((address) => ({ address, family: 4 }));
};
const OPTS = (extra) => Object.assign({ allowFakeIpTransport: true, fakeIpAttester: activeAtt }, extra || {});

(async () => {
  /* ---- D-1/D-2/D-3: 可信池允许；无 attestation / 无 opt-in 拒绝 ---- */
  await okA("D1 hostname→池地址 + opt-in + attestation 成立 ⇒ 允许", async () => {
    const url = await assertSafeHttpUrl("https://api.deepseek.com/v1",
      OPTS({ lookup: mkLookup({ "api.deepseek.com": ["198.18.0.223"] }) }));
    assert.strictEqual(url.hostname, "api.deepseek.com");
  });

  await okA("D2 同一池解析，未 opt-in（其它调用方）⇒ 仍拒绝（零漂移）", async () => {
    await assert.rejects(
      assertSafeHttpUrl("https://api.deepseek.com/v1", { lookup: mkLookup({ "api.deepseek.com": ["198.18.0.223"] }) }),
      /私有或保留/);
  });

  await okA("D3 同一池解析，opt-in 但伪造器证明失败 ⇒ 拒绝（fail closed）", async () => {
    await assert.rejects(
      assertSafeHttpUrl("https://api.deepseek.com/v1",
        OPTS({ fakeIpAttester: deadAtt, lookup: mkLookup({ "api.deepseek.com": ["198.18.0.223"] }) })),
      /私有或保留/);
  });

  /* ---- C-5: literal 198.18.x 始终拒绝 ---- */
  await okA("C5 literal http://198.18.1.50 ⇒ 始终拒绝（opt-in+attestation 也不放行字面量）", async () => {
    await assert.rejects(
      assertSafeHttpUrl("http://198.18.1.50/v1", OPTS({ lookup: mkLookup({}) })),
      /私有或保留/);
  });

  /* ---- C-1..C-4, C-6: 真实私有/链路本地/loopback 解析仍拒绝 ---- */
  await okA("C6 evil.example 真实解析到 10.0.0.1 ⇒ 拒绝（即使 attestation 活跃）", async () => {
    await assert.rejects(
      assertSafeHttpUrl("https://evil.example/v1", OPTS({ lookup: mkLookup({ "evil.example": ["10.0.0.1"] }) })),
      /私有或保留/);
  });

  await okA("解析到 192.168/169.254/127.x（非 loopback 允许路径）⇒ 拒绝", async () => {
    for (const [host, ip] of [["a.example", "192.168.1.1"], ["b.example", "169.254.169.254"], ["c.example", "127.0.0.1"]]) {
      await assert.rejects(assertSafeHttpUrl("http://" + host + "/", OPTS({ lookup: mkLookup({ [host]: [ip] }) })), /私有或保留/, host + "→" + ip);
    }
  });

  await okA("混合答案（池 + 公网）⇒ 拒绝（全池规则保守）", async () => {
    await assert.rejects(
      assertSafeHttpUrl("https://mix.example/v1", OPTS({ lookup: mkLookup({ "mix.example": ["198.18.1.5", "8.8.8.8"] }) })),
      /私有或保留/);
  });

  /* ---- 池精度：已证明 /16，不得扩大到 198.19（同 /15 不同 /16） ---- */
  await okA("attested 198.18/16 池不覆盖 198.19.0.1 ⇒ 拒绝", async () => {
    await assert.rejects(
      assertSafeHttpUrl("https://x.example/v1", OPTS({ lookup: mkLookup({ "x.example": ["198.19.0.1"] }) })),
      /私有或保留/);
  });

  ok("inCidr 语义：/16 边界正确", () => {
    assert.strictEqual(inCidr("198.18.5.5", "198.18.0.0/16"), true);
    assert.strictEqual(inCidr("198.19.5.5", "198.18.0.0/16"), false);
    assert.strictEqual(inCidr("198.18.0.0", "198.18.0.0/15"), true);
    assert.strictEqual(inCidr("198.19.0.0", "198.18.0.0/15"), true);
    assert.strictEqual(inCidr("198.20.0.0", "198.18.0.0/15"), false);
  });

  /* ---- 内置 attestation：行为指纹判定 ---- */
  await okA("attestation：两探针同 /16 池地址 ⇒ 返回池", async () => {
    resetFakeIpAttestation();
    let n = 0;
    const pool = await attestFakeIpTransport(async () => [{ address: (n++ === 0 ? "198.18.1.7" : "198.18.1.9"), family: 4 }]);
    assert.strictEqual(pool, "198.18.0.0/16");
  });

  await okA("attestation：NXDOMAIN（resolver 非伪造器）⇒ null", async () => {
    resetFakeIpAttestation();
    const pool = await attestFakeIpTransport(async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); });
    assert.strictEqual(pool, null);
  });

  await okA("attestation：探针地址跨 /16 ⇒ null（池不唯一不采信）", async () => {
    resetFakeIpAttestation();
    let n = 0;
    const pool = await attestFakeIpTransport(async () => [{ address: (n++ === 0 ? "198.18.1.7" : "198.19.1.7"), family: 4 }]);
    assert.strictEqual(pool, null);
  });

  await okA("attestation：探针地址在 198.18/15 之外 ⇒ null", async () => {
    resetFakeIpAttestation();
    const pool = await attestFakeIpTransport(async () => [{ address: "8.8.8.8", family: 4 }]);
    assert.strictEqual(pool, null);
  });

  await okA("attestation：结果缓存（同 TTL 内第二次探针不再调用 lookup）", async () => {
    resetFakeIpAttestation();
    let calls = 0;
    const spy = async () => { calls++; return [{ address: "198.18.2.2", family: 4 }]; };
    await attestFakeIpTransport(spy);
    const firstCalls = calls;
    await attestFakeIpTransport(spy);
    assert.strictEqual(calls, firstCalls, "第二次应命中缓存");
    resetFakeIpAttestation();
  });

  /* ---- C-7/C-8 + D-5: safeFetch 逐跳复验 ---- */
  const origFetch = global.fetch;
  try {
    await okA("C7 redirect → 私有 IP 字面量 ⇒ 逐跳复验拒绝（opt-in+attestation 不影响）", async () => {
      global.fetch = async (url) => {
        if (String(url).includes("start.example")) {
          return { status: 302, headers: new Map([["location", "http://10.0.0.9/"]]), url: String(url) };
        }
        throw new Error("不应向 10.0.0.9 发起请求");
      };
      await assert.rejects(
        safeFetch("http://start.example/v1", {}, OPTS({ lookup: mkLookup({ "start.example": ["198.18.0.1"] }) })),
        /私有或保留/);
    });

    await okA("D5 redirect → hostname 解析到 attested 池 ⇒ 同策略放行（运输令牌一致语义）", async () => {
      const seen = [];
      global.fetch = async (url) => {
        seen.push(String(url));
        if (String(url).includes("hop-a.example")) {
          return { status: 302, headers: new Map([["location", "http://hop-b.example/v1/models"]]) };
        }
        return { status: 200, headers: new Map(), json: async () => ({ data: [] }) };
      };
      const r = await safeFetch("http://hop-a.example/v1", {},
        OPTS({ lookup: mkLookup({ "hop-a.example": ["198.18.0.5"], "hop-b.example": ["198.18.0.9"] }) }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(seen.length, 2);
    });

    await okA("C8 redirect → 另一 origin（即使仍在池）⇒ credentialOrigin 仍拦截（P01 不变量不退化）", async () => {
      global.fetch = async (url) => ({ status: 302, headers: new Map([["location", "http://other.example/v1"]]) });
      await assert.rejects(
        safeFetch("http://start.example/v1", {},
          Object.assign(OPTS({ lookup: mkLookup({ "start.example": ["198.18.0.5"], "other.example": ["198.18.0.6"] }) }),
            { credentialOrigin: "http://start.example" })),
        /不同来源/);
    });
  } finally {
    global.fetch = origFetch;
  }

  /* ---- C-1/C-9: loopback 与既有行为保持 ---- */
  await okA("C1 127.0.0.1 字面量（非 loopback 允许路径）⇒ 拒绝不变", async () => {
    await assert.rejects(assertSafeHttpUrl("http://127.0.0.1:9/v1", OPTS({ lookup: mkLookup({}) })), /私有|保留/);
  });

  await okA("公网解析（8.8.8.8）⇒ 允许（无池需求，既有路径不变）", async () => {
    const url = await assertSafeHttpUrl("https://ok.example/v1", OPTS({ lookup: mkLookup({ "ok.example": ["8.8.8.8"] }) }));
    assert.strictEqual(url.hostname, "ok.example");
  });

  resetFakeIpAttestation();
  console.log(failures ? `\n${failures} 项失败` : "\nP02 fake-ip 运输令牌策略全部通过 ✅");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAIL 框架异常 -", e.message); process.exit(1); });

/** pet:list-models 信任边界单测（审计 K-EXP-13 F-01 + residual credential binding）——
 *  ① 与 pet:test-chat 同界：validateApiBase 目的地校验 + safeFetch 逐跳复验；
 *  ② credential binding：已存 cfg.chat.apiKey 只发往与已保存 cfg.chat.baseUrl 同 origin 的
 *     目的地（origin 规范化比较：默认端口省略/hostname 小写/IPv6 归一；path 差异不误伤）；
 *  ③ safeFetch credentialOrigin：跨 origin 重定向一律中断，凭据头不离开绑定 origin；
 *  ④ 失败 fail closed（ok:false，不抛出）；假 server 实证 secret 从未到达攻击者端口。 */
"use strict";
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.SUZURAN_TEST_USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-list-models-"));
const { listModels, testConnection, storedKeyOriginViolation } = require("../src/chat-client");
const { originOf, sameOrigin } = require("../src/safe-url");

/* 明确无效的占位串（非真实凭据），仅验证“已存 key 不外发到未验证目标”的行为 */
const STORED_KEY = "sk-STORED-PLACEHOLDER-NOT-A-REAL-KEY";
const DRAFT_KEY = "sk-DRAFT-TYPED-IN-FORM-PLACEHOLDER";

let failures = 0;
async function okA(name, fn) { try { await fn(); console.log("PASS", name); } catch (e) { failures++; console.log("FAIL", name, "-", e.message); } }
function ok(name, fn) { try { fn(); console.log("PASS", name); } catch (e) { failures++; console.log("FAIL", name, "-", e.message); } }

/* 假 provider A = "已保存 origin"；假 provider B = "攻击者 origin"（同机不同端口 = 不同 origin）。
 * 两者都记录收到的凭据头，可实证 secret 是否到达。 */
const hitsA = [], hitsB = [];
const providerA = http.createServer((req, res) => {
  hitsA.push({ url: req.url, authorization: req.headers.authorization || "", "x-api-key": req.headers["x-api-key"] || "" });
  if (req.url.startsWith("/redirect-private")) { res.writeHead(302, { Location: "http://10.0.0.5/v1/models" }); return res.end(); }
  if (req.url.startsWith("/redirect-file")) { res.writeHead(302, { Location: "file:///etc/passwd" }); return res.end(); }
  if (req.url.startsWith("/redirect-evil")) { res.writeHead(302, { Location: EVIL_BASE + "/v1/models" }); return res.end(); }
  if (req.url.startsWith("/redirect-same")) { res.writeHead(302, { Location: LOCAL_A + "/v1/models" }); return res.end(); }
  if (req.url.startsWith("/empty")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"data":[]}'); }
  if (req.url.startsWith("/unauthorized")) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("bad key"); }
  if (req.url.startsWith("/v1/chat/completions") || req.url.startsWith("/chat/completions")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ choices: [{ message: { content: "【情绪:平静】好" } }] }));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "m-b" }, { id: "m-a" }, { id: "m-a" }, { name: "m-c" }] }));
});
const providerB = http.createServer((req, res) => {
  hitsB.push({ url: req.url, authorization: req.headers.authorization || "", "x-api-key": req.headers["x-api-key"] || "" });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "evil-model" }] }));
});
let LOCAL_A = "", EVIL_BASE = "";

/* 已保存配置：baseUrl 指向 A（同 origin 合法场景），apiKey 为已存密钥 */
const baseCfg = () => ({
  chat: { apiType: "openai", baseUrl: LOCAL_A, apiKey: STORED_KEY, allowPrivateBaseUrl: false }
});

(async () => {
  await new Promise((resolve) => providerA.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => providerB.listen(0, "127.0.0.1", resolve));
  LOCAL_A = "http://127.0.0.1:" + providerA.address().port;
  EVIL_BASE = "http://127.0.0.1:" + providerB.address().port;

  /* ---------- 合法行为（不漂移） ---------- */
  await okA("合法 endpoint：本机 OpenAI 兼容返回去重排序模型列表", async () => {
    const r = await listModels({ baseUrl: LOCAL_A }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.deepStrictEqual(r.models, ["m-a", "m-b", "m-c"]);
    assert.strictEqual(r.count, 3);
  });

  await okA("同 origin 合法 path 差异：缺 /v1 自动补全且已存 key 正常携带", async () => {
    hitsA.length = 0;
    const r = await listModels({ baseUrl: LOCAL_A + "/" }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.strictEqual(hitsA[0].url, "/v1/models");
    assert.strictEqual(hitsA[0].authorization, "Bearer " + STORED_KEY);
    assert.strictEqual(hitsA[0]["x-api-key"], "");
  });

  await okA("同 origin 合法 path 差异：已含 /v1 不重复追加", async () => {
    hitsA.length = 0;
    await listModels({ baseUrl: LOCAL_A + "/v1" }, baseCfg());
    assert.strictEqual(hitsA[0].url, "/v1/models");
  });

  await okA("同 origin 不同合法 path（草稿子路径）：正常工作不误伤", async () => {
    hitsA.length = 0;
    const r = await listModels({ baseUrl: LOCAL_A + "/sub" }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.strictEqual(hitsA[0].url, "/sub/v1/models");
    assert.strictEqual(hitsA[0].authorization, "Bearer " + STORED_KEY);
  });

  /* ---------- Phase 4-1：已存 key + renderer 指定不同 origin → secret 不得发出 ---------- */
  await okA("攻击：已存 key + 不同 origin（公网等价）→ 拒绝且攻击者端口零请求", async () => {
    hitsB.length = 0;
    const r = await listModels({ baseUrl: EVIL_BASE }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /不属于同一来源/);
    assert.strictEqual(hitsB.length, 0, "stored key 请求不得到达攻击者端口");
    assert.ok(hitsB.every((h) => !h.authorization.includes(STORED_KEY) && !h["x-api-key"].includes(STORED_KEY)));
  });

  await okA("对照组：同一攻击者端口接受显式 key（证明拦截来自 binding 而非端口不可用）", async () => {
    hitsB.length = 0;
    const r = await listModels({ baseUrl: EVIL_BASE, apiKey: DRAFT_KEY }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.strictEqual(hitsB.length, 1);
    assert.strictEqual(hitsB[0].authorization, "Bearer " + DRAFT_KEY); // renderer 自带 key 属 renderer 已知数据，不适用 binding
  });

  await okA("攻击：stored key 空串显式传参仍视为回退，binding 生效", async () => {
    hitsB.length = 0;
    const r = await listModels({ baseUrl: EVIL_BASE, apiKey: "" }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /不属于同一来源/);
    assert.strictEqual(hitsB.length, 0);
  });

  /* ---------- Phase 4-3/4-4：origin 规范化语义 ---------- */
  ok("规范化：trailing slash、/v1 path、默认端口、大小写、IPv6 不影响同 origin 判定", () => {
    assert.strictEqual(sameOrigin("https://provider.example/v1", "https://provider.example/"), true);
    assert.strictEqual(sameOrigin("https://provider.example", "https://provider.example:443/x"), true);
    assert.strictEqual(sameOrigin("https://PROVIDER.Example", "https://provider.example/v9"), true);
    assert.strictEqual(sameOrigin("http://[::1]:11434/v1", "http://[::1]:11434"), true);
    assert.strictEqual(sameOrigin("https://provider.example", "http://provider.example"), false); // 协议不同
    assert.strictEqual(sameOrigin("https://provider.example:8443", "https://provider.example"), false); // 端口不同
  });

  ok("攻击等价：saved https://provider.example ≠ requested https://evil.example", () => {
    assert.strictEqual(originOf("https://provider.example/v1"), "https://provider.example");
    assert.strictEqual(sameOrigin("https://provider.example", "https://evil.example"), false);
  });

  await okA("无效已存地址 + 已存 key：fail closed（不发送）", async () => {
    hitsA.length = 0; hitsB.length = 0;
    const cfg = baseCfg(); cfg.chat.baseUrl = "not-a-valid-origin";
    const r = await listModels({ baseUrl: LOCAL_A }, cfg);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /尚未保存|无效|来源/);
    assert.strictEqual(hitsA.length, 0);
    assert.strictEqual(hitsB.length, 0);
  });

  /* ---------- Phase 4-5：重定向凭据绑定 ---------- */
  await okA("攻击：合法 origin 302 → 另一公网 origin → 中断，secret 未跨 origin", async () => {
    hitsA.length = 0; hitsB.length = 0;
    const r = await listModels({ baseUrl: LOCAL_A + "/redirect-evil" }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /不同来源/);
    assert.strictEqual(hitsB.length, 0, "跨 origin 重定向不得到达攻击者端口");
    assert.ok(hitsB.every((h) => !h.authorization.includes(STORED_KEY)));
  });

  await okA("同 origin 重定向：凭据继续携带，合法场景不误伤", async () => {
    hitsA.length = 0; hitsB.length = 0;
    const r = await listModels({ baseUrl: LOCAL_A + "/redirect-same" }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.strictEqual(hitsB.length, 0);
    assert.ok(hitsA.length >= 2); // 初始跳 + 302 后同 origin 跟随
    assert.ok(hitsA.every((h) => h.authorization === "Bearer " + STORED_KEY));
  });

  /* ---------- Phase 4-6：既有 URL safety 层回归 ---------- */
  await okA("不可信目标：内网 192.168（显式 key 走 validateApiBase 层）被拒", async () => {
    const r = await listModels({ baseUrl: "http://192.168.1.10:8080", apiKey: DRAFT_KEY }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /拒绝/);
  });

  await okA("不可信目标：云元数据 169.254.169.254 被拒", async () => {
    const r = await listModels({ baseUrl: "http://169.254.169.254/latest", apiKey: DRAFT_KEY }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /拒绝/);
  });

  await okA("不可信目标：10.x 内网被拒", async () => {
    const r = await listModels({ baseUrl: "http://10.0.0.5:11434/v1", apiKey: DRAFT_KEY }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /拒绝/);
  });

  await okA("redirect 绕过：302 → 内网目标被逐跳复验拦截", async () => {
    const r = await listModels({ baseUrl: LOCAL_A + "/redirect-private" }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /私有|保留|拒绝/);
  });

  await okA("redirect 绕过：302 → file:// 协议被拦截", async () => {
    const r = await listModels({ baseUrl: LOCAL_A + "/redirect-file" }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /http|https/);
  });

  await okA("malformed URL：fail closed", async () => {
    const r = await listModels({ baseUrl: "not-a-url" }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /无效/);
  });

  await okA("非允许协议 ftp://：fail closed", async () => {
    const r = await listModels({ baseUrl: "ftp://api.example.com/v1", apiKey: DRAFT_KEY }, baseCfg());
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /仅支持 http\/https/);
  });

  await okA("空 baseUrl：fail closed（不静默回退默认厂商）", async () => {
    const cfg = baseCfg(); cfg.chat.baseUrl = "";
    const r = await listModels({ baseUrl: "" }, cfg);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /请先填写 API 地址/);
  });

  await okA("anthropic：缺 key 提示先填（fail closed）", async () => {
    const cfg = baseCfg(); cfg.chat.apiKey = ""; cfg.chat.apiType = "anthropic";
    const r = await listModels({ baseUrl: "https://api.anthropic.com" }, cfg);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /请先填写 API Key/);
  });

  await okA("anthropic：内网目标被拒", async () => {
    const cfg = baseCfg(); cfg.chat.apiType = "anthropic";
    const r = await listModels({ baseUrl: "http://192.168.1.10:8080", apiKey: DRAFT_KEY }, cfg);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /拒绝/);
  });

  await okA("anthropic：跨 origin 已存 key 被 binding 拒绝", async () => {
    hitsB.length = 0;
    const cfg = baseCfg(); cfg.chat.apiType = "anthropic";
    const r = await listModels({ baseUrl: EVIL_BASE }, cfg);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /不属于同一来源/);
    assert.strictEqual(hitsB.length, 0);
  });

  await okA("anthropic：回环目标拒绝（与 chat/testConnection 现行为一致，无漂移）", async () => {
    const cfg = baseCfg(); cfg.chat.apiType = "anthropic";
    const r = await listModels({ baseUrl: LOCAL_A }, cfg);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /本机|私有|保留/);
  });

  await okA("空模型列表 / HTTP 401：原语义透传", async () => {
    const r1 = await listModels({ baseUrl: LOCAL_A + "/empty" }, baseCfg());
    assert.strictEqual(r1.ok, false);
    assert.match(r1.message, /空模型列表/);
    const r2 = await listModels({ baseUrl: LOCAL_A + "/unauthorized" }, baseCfg());
    assert.strictEqual(r2.ok, false);
    assert.match(r2.message, /HTTP 401/);
  });

  /* ---------- testConnection 的 stored fallback 同一 binding ---------- */
  await okA("test-chat：已存 key 回退 + 草稿不同 origin → 拒绝且攻击者端口零请求", async () => {
    hitsB.length = 0;
    const r = await testConnection({ baseUrl: EVIL_BASE }, baseCfg()); // 未传 apiKey → 回退已存
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /不属于同一来源/);
    assert.strictEqual(hitsB.length, 0, "stored key 测试请求不得到达攻击者端口");
  });

  await okA("test-chat：已存 key 回退 + 草稿同 origin（表单未改）→ 正常", async () => {
    hitsA.length = 0;
    const r = await testConnection({ baseUrl: LOCAL_A }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.strictEqual(hitsA[0].authorization, "Bearer " + STORED_KEY);
  });

  await okA("test-chat：显式草稿 key + 任意安全 origin → 不适用 binding", async () => {
    hitsB.length = 0;
    const r = await testConnection({ baseUrl: EVIL_BASE, apiKey: DRAFT_KEY }, baseCfg());
    assert.strictEqual(r.ok, true, r.message || "");
    assert.strictEqual(hitsB[0].authorization, "Bearer " + DRAFT_KEY);
  });

  ok("binding 纯函数：空已存地址 / 无效地址 fail closed 文案可读", () => {
    assert.match(storedKeyOriginViolation("", "https://x.example"), /尚未保存/);
    assert.match(storedKeyOriginViolation("not-a-url", "https://x.example"), /来源|无效|保存/);
    assert.strictEqual(storedKeyOriginViolation("https://provider.example/v1", "https://provider.example"), null);
  });

  for (const s of [providerA, providerB]) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve)); // 等待端口释放，防 keep-alive 竞态导致偶发非零退出
  }
  fs.rmSync(process.env.SUZURAN_TEST_USERDIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : "\nlist-models 信任边界 + credential binding 全部通过 ✅");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAIL 测试框架异常 -", e.message); process.exit(1); });

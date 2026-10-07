"use strict";
/**
 * whitemoon-ingress-config.test.js — Phase 11-E.1 Body 侧凭据与配置边界测试。
 *
 * 覆盖：
 *   T12  Body 配置不含 Host master token（whitemoonRuntime 形状收敛 + saveConfig
 *        永不把 ingress token 写回 config.json + 源码无 master token 取值路径）
 *   T13  ingress token 经 DPAPI secrets 机制存储（fake safeStorage 全链路）
 *
 * 环境变量 WHITEMOON_INGRESS_TOKEN 在本文件中显式清除，保证测的是密钥服务路径。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-ingress-cfg-"));
process.env.SUZURAN_TEST_USERDIR = userDir;
delete process.env.WHITEMOON_INGRESS_TOKEN;
fs.writeFileSync(path.join(userDir, ".storage-migration-v1.json"), "{}", "utf8");

const config = require("../src/config");
const secrets = require("../src/secrets");
const { filterSettingsPatch } = require("../src/settings-patch");

// 测试用假值：运行时用 CSPRNG 生成（非加密凭据，仅为避免源码/测试出现可用凭据字面量）
const TOKEN = () => "dummy-ingress-" + crypto.randomBytes(16).toString("hex");
// fake safeStorage：DPAPI 的测试替身——可逆但输出不透明（密文不含明文字符串），
// 与真实实现的可观测行为一致。
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...s].reverse().join(""), "utf8"),
  decryptString: (b) => [...Buffer.from(b).toString("utf8")].reverse().join("")
};

test("T13a: ingress token 走 DPAPI secrets 槽位，getConfig 注入 whitemoonRuntime.ingressToken", () => {
  config.initializeSecretStorage(fakeSafeStorage);
  const value = TOKEN();
  config.replaceSecrets({ whitemoonIngressToken: value });
  const cfg = config.getConfig(true);
  assert.equal(cfg.whitemoonRuntime.ingressToken, value);
  assert.equal(secrets.status("whitemoonIngressToken").saved, true);

  // secrets 信封文件只存密文，不含明文
  const envelope = JSON.parse(fs.readFileSync(path.join(userDir, "secrets.v1.json"), "utf8"));
  const item = envelope.secrets.whitemoonIngressToken;
  assert.ok(item && item.ciphertext, "secrets 信封存在且含密文");
  assert.equal(Buffer.from(item.ciphertext, "base64").toString("utf8").includes(value), false, "密文不是明文");
});

test("T12a: saveConfig 永不把 ingress token 写回 config.json；whitemoonRuntime 只含 enabled/baseUrl", () => {
  const value = TOKEN();
  config.replaceSecrets({ whitemoonIngressToken: value });
  config.saveConfig({ whitemoonRuntime: { enabled: true, baseUrl: "http://127.0.0.1:8790" } });
  const raw = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf8"));
  assert.equal(raw.whitemoonRuntime.enabled, true);
  assert.equal(raw.whitemoonRuntime.baseUrl, "http://127.0.0.1:8790");
  assert.equal(raw.whitemoonRuntime.ingressToken, undefined, "config.json 不存 ingress token");
  assert.equal(fs.readFileSync(config.CONFIG_PATH, "utf8").includes(value), false, "token 原值不出现在 config.json");
  // 保存后内存配置仍能取到 token（密钥服务是唯一持久层）
  assert.equal(typeof config.getConfig().whitemoonRuntime.ingressToken, "string");
});

test("T12b: env WHITEMOON_INGRESS_TOKEN 是密钥服务缺失时的回退（不落任何盘）", () => {
  // 先清空密钥槽位（回退语义只在密钥服务无值时生效）
  config.replaceSecrets({ whitemoonIngressToken: "" });
  assert.equal(config.getConfig(true).whitemoonRuntime.ingressToken, "", "槽位清空且无 env 时为空");
  const value = TOKEN();
  process.env.WHITEMOON_INGRESS_TOKEN = value;
  try {
    assert.equal(config.getConfig(true).whitemoonRuntime.ingressToken, value);
    // env 值绝不落盘：config.json 与 secrets 信封都不含它
    assert.equal(fs.readFileSync(config.CONFIG_PATH, "utf8").includes(value), false);
    const secretsPath = path.join(userDir, "secrets.v1.json");
    if (fs.existsSync(secretsPath)) {
      assert.equal(fs.readFileSync(secretsPath, "utf8").includes(value), false, "env 回退不写入密钥信封");
    }
  } finally {
    delete process.env.WHITEMOON_INGRESS_TOKEN;
  }
  assert.equal(config.getConfig(true).whitemoonRuntime.ingressToken, "");
});

test("T12c: secrets 槽位表中没有任何 Host master token 槽位", () => {
  const { KEYS } = (() => {
    // secrets.js 不直接导出 KEYS；用 status() 全量键判断
    const status = secrets.status();
    return { KEYS: Object.keys(status) };
  })();
  assert.deepEqual(KEYS.sort(), ["agentBearerToken", "chatApiKey", "ttsCosyApiKey", "whitemoonIngressToken"].sort());
  assert.equal(KEYS.some((k) => /host|master/i.test(k)), false, "不得存在 host/master token 槽位");
});

test("T12d: 设置页 secrets 补丁支持 whitemoonIngressToken 槽位（replace action），且不入 config patch", () => {
  const value = TOKEN();
  const r = filterSettingsPatch({ whitemoonRuntime: { enabled: true }, secrets: { whitemoonIngressToken: { action: "replace", value } } });
  assert.equal(r.secrets.whitemoonIngressToken, value);
  assert.equal(r.patch.secrets, undefined);
  assert.equal(r.patch.whitemoonRuntime.enabled, true);
});

test("T12e: whitemoonRuntime 形状收敛——未知子键被形状恢复丢弃，不承载任意字段", () => {
  config.saveConfig({ whitemoonRuntime: { enabled: false, hostMasterToken: "should-not-persist" } });
  const raw = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf8"));
  assert.equal(raw.whitemoonRuntime.hostMasterToken, undefined, "master token 形状的键不得落盘");
  assert.equal(fs.readFileSync(config.CONFIG_PATH, "utf8").includes("should-not-persist"), false);
});

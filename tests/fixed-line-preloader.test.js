"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-preloader-"));
process.env.SUZURAN_TEST_USERDIR = dir;
const cache = require("../src/fixed-line-cache");
const fixed = require("../src/fixed-lines");
const preloader = require("../src/fixed-line-preloader");
const profileConfig = { tts: { enabled: true }, ttsCloud: { enabled: true, voice: "test" } };
const vars = { name: "小苏", user: "阿明" };
const items = fixed.buildManifest(vars).slice(0, 3);
const profile = cache.profileFromConfig(profileConfig);
cache.clear(profile);
cache.markFailed(profile, items[0], "OLD_FAILURE");
cache.saveItem(profile, items[1], Buffer.from("ready"));

(async () => {
  const called = [];
  const first = await preloader.start({
    config: profileConfig,
    vars,
    retryFailed: true,
    pools: [items[0].pool],
    synthesize: async (text, opts) => { called.push({ text, opts }); return Buffer.from("audio").toString("base64"); }
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.state, "completed");
  assert.deepStrictEqual(called.map((x) => x.text), [items[0].text]);
  assert.strictEqual(cache.load(profile, vars).summary.failed, 0);
  assert.strictEqual(cache.load(profile, vars).summary.ready, 2);
  assert.strictEqual(called[0].opts.fixedLinePreload, true);

  cache.markFailed(profile, items[2], "RETRY_ME");
  const failedAgain = await preloader.start({
    config: profileConfig,
    vars,
    retryFailed: true,
    pools: [items[2].pool],
    synthesize: async () => ""
  });
  assert.strictEqual(failedAgain.ok, true);
  assert.strictEqual(failedAgain.state, "completed_with_errors");
  const afterFailure = cache.load(profile, vars).items.find((item) => item.id === items[2].id);
  assert.strictEqual(afterFailure.state, "failed");
  assert.strictEqual(afterFailure.errorCode, "TTS_EMPTY");

  const noRetry = await preloader.start({
    config: profileConfig,
    vars,
    retryFailed: false,
    pools: ["not-a-real-pool"],
    synthesize: async () => { throw new Error("should not run"); }
  });
  assert.strictEqual(noRetry.ok, true);
  assert.strictEqual(noRetry.state, "completed_with_errors");

  const fixedOnly = await preloader.start({ config: { ...profileConfig, tts: { fixedOnly: true } }, vars, synthesize: async () => "x" });
  assert.strictEqual(fixedOnly.code, "FIXED_ONLY_ON");
  const system = await preloader.start({ config: {}, vars, synthesize: async () => "x" });
  assert.strictEqual(system.code, "SYSTEM_NOT_PRELOADABLE");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = preloader.start({ config: profileConfig, vars, pools: [items[0].pool], synthesize: async () => { await gate; return "x"; } });
  const concurrent = await preloader.start({ config: profileConfig, vars, synthesize: async () => "x" });
  assert.strictEqual(concurrent.code, "ALREADY_RUNNING");
  release();
  await running;

  cache.clear(profile);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("fixed-line-preloader 全部通过 ✅");
})().catch((error) => { console.error(error); process.exit(1); });

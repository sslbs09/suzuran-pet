"use strict";
// FORMAL AUTONOMY DAILY CUTOVER v0.1 - focused tests（任务 §14 A-I）。
//   A/B  startup owner 合同（Formal enabled：legacy startProactive 不启动；disabled：原样）
//   C/D  Settings 语义（Formal：只动 P1-U2 投递权限、不复活 timer；disabled：四参数合同由
//        proactive-settings-restart.test.js 继续钉死）
//   E/F  Host config opportunityPulse reconciliation（行为级：真实 createWhitemoonHost +
//        fake spawn；enabled → {true,1200000}；disabled → enabled:false，其他键零触碰）
//   G    legacy Character speech outlets 逐一挂 owner 谓词（源码契约）
//   H    reminder / 即时交互 / 安全警告 / Formal 投递入口绝不挂谓词（源码契约，§8）
//   I    owner 谓词语义 = whitemoonRuntime.enabled === true，且未新增任何用户设置键（§2/§3）
// 行为可注入的部分走真模块；main.js 内部入口用结构契约（与 proactive-settings-restart 同风格）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("events");
const { createWhitemoonHost, PULSE_CONTRACT } = require("../src/whitemoon-host");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8");

// ---------- 合同常量 ----------
test("C1: pulse cadence 固定 20 分钟 MVP 合同（§3）", () => {
  assert.deepEqual({ ...PULSE_CONTRACT }, { enabled: true, intervalMs: 20 * 60 * 1000 });
  assert.equal(PULSE_CONTRACT.intervalMs, 1200000);
  assert.ok(Object.isFrozen(PULSE_CONTRACT));
});

// ---------- A/B: startup owner 合同 ----------
test("A: Formal enabled 下 startup 的 legacy 定时器整体在 owner 分支内（不启动）", () => {
  const idx = main.indexOf("// 主动搭话（v2.3 增强）");
  assert.ok(idx >= 0, "startup proactive section exists");
  const region = main.slice(idx, idx + 1200);
  const guardPos = region.indexOf("if (!formalAutonomyOwnsCharacterSpeech()) {");
  const enablePos = region.indexOf("features.setProactiveEnabled(_cfg.proactiveChat !== false);");
  const startPos = region.indexOf("features.startProactive(");
  assert.ok(guardPos >= 0 && enablePos > guardPos && startPos > guardPos,
    "setProactiveEnabled/startProactive both live inside the NOT-formal guard");
  assert.ok(/legacy 主动搭话定时器不启动/.test(region), "the formal branch logs the owner switch honestly");
});

test("B: Formal disabled 下 legacy startup 完整保留（§14 B）", () => {
  const idx = main.indexOf("features.startProactive((msg, mood) => {");
  assert.ok(idx >= 0, "startup call site exists");
  const startupCall = main.slice(idx, idx + 400);
  assert.ok(/_proactiveMin,\s*PROACTIVE_DEFAULTS\.chance,\s*proactiveStateFn\)/.test(startupCall),
    "disabled profile still starts (sendFn, _proactiveMin, 0.18, stateFn) verbatim");
});

// ---------- C: Settings OFF→ON 不复活 legacy timer（Formal） ----------
test("C: Settings 行序合同：saveConfig(P1-U2) → formal guard → features 调用", () => {
  const start = main.indexOf('ipcMain.on("pet:set-proactive-chat"');
  assert.ok(start >= 0);
  const handler = main.slice(start, main.indexOf("\n});", start));
  const savePos = handler.indexOf("config.saveConfig({ proactiveChat: !!on })");
  const guardPos = handler.indexOf("if (formalAutonomyOwnsCharacterSpeech()) return;");
  const enablePos = handler.indexOf("features.setProactiveEnabled(!!on)");
  const restartPos = handler.indexOf("features.startProactive");
  assert.ok(savePos >= 0 && guardPos > savePos,
    "P1-U2 delivery permission persists BEFORE any owner branch");
  assert.ok(enablePos > guardPos && restartPos > guardPos,
    "Formal enabled: both legacy timer calls sit behind the owner guard");
});

// ---------- I: owner 谓词 = whitemoonRuntime.enabled，无第二套设置 ----------
test("I: owner 谓词语义合同 + 零新增用户设置键（§2/§3）", () => {
  assert.match(
    main,
    /function formalAutonomyOwnsCharacterSpeech\(\) \{\s*\n\s*return \(\(config\.getConfig\(\) \|\| \{\}\)\.whitemoonRuntime \|\| \{\}\)\.enabled === true;\s*\n\s*\}/,
    "the predicate is exactly: whitemoonRuntime.enabled === true"
  );
  for (const rel of ["../main.js", "../src/config.js", "../src/settings-patch.js"]) {
    const src = fs.readFileSync(require.resolve(rel), "utf8");
    for (const banned of ["formalAutonomyEnabled", "autonomyMode", "pulseEnabled"]) {
      assert.equal(src.includes(banned), false, `${rel} must not introduce user setting "${banned}"`);
    }
  }
});

// ---------- G: legacy Character speech outlets 全部挂 owner 谓词 ----------
test("G: 已确认的 legacy Character 发话入口逐一被 owner 谓词守卫（§7）", () => {
  const outlets = [
    ["focus 回归问候", /t\.greet && isWindowVisible\(\) && !formalAutonomyOwnsCharacterSpeech\(\)/],
    ["天气关心播报", /Math\.random\(\) < 0\.5 && !formalAutonomyOwnsCharacterSpeech\(\)/],
    ["maybePersonify 自主场景自语", /function maybePersonify\(event, \{[^}]*autonomous = false[^}]*\} = \{\}\) \{\s*\n\s*if \(autonomous && formalAutonomyOwnsCharacterSpeech\(\)\) return;/],
    ["workspace/Agent workflow 碎语", /function consumeWorkflowSignalNow\(\) \{[\s\S]{0,500}?if \(formalAutonomyOwnsCharacterSpeech\(\)\) return false;/],
    ["legacy bond-stage 台词", /lines\.STAGE_LINES\[st\.key\]\.length && !formalAutonomyOwnsCharacterSpeech\(\)/],
    ["启动开场白 gate（复用 startupGreetingAllowed，§10）", /startupGreetingAllowed: !formalAutonomyOwnsCharacterSpeech\(\) && proactivePolicy\.canProactiveMessage\(cfg\)/],
  ];
  for (const [name, re] of outlets) {
    assert.ok(re.test(main), `speech outlet not owner-guarded: ${name}`);
  }
  assert.equal(
    [...main.matchAll(/if \(formalAutonomyOwnsCharacterSpeech\(\)\) return;\s*\n\s*sendProactive\(msg, "idle"\)/g)].length,
    2, "clipboard concern/invitation speech guarded at both call sites (startup + toggle)");
  assert.equal(
    [...main.matchAll(/if \(formalAutonomyOwnsCharacterSpeech\(\)\) return; sendProactive\(msg, "think"\)/g)].length,
    2, "system monitor casual chatter guarded at both call sites (startup + toggle)");

  // personify 自主/交互分流：恰好 4 处标 autonomous:true，3 处即时交互反馈不标（§8D）
  const calls = [...main.matchAll(/maybePersonify\("(\w+)",\s*\{[^{}]*\}\)/g)].map((m) => m[0]);
  assert.equal(calls.filter((c) => /autonomous: true/.test(c)).length, 4,
    "散步 perch + 两处 wake + sleep 标记为自主场景自语");
  const unmarked = calls.filter((c) => !/autonomous: true/.test(c));
  assert.equal(unmarked.length, 3, "抛掷 landing-perch / thrown / grabbed 保持即时交互反馈");
  assert.ok(unmarked.every((c) => /perch|thrown|grabbed/.test(c)));
});

// ---------- H: §8 必须保留的路径绝不挂 owner 谓词 ----------
test("H: reminder / 番茄钟 / 安全警告 / 即时交互 / Formal 投递入口不被 suppress 逻辑触碰", () => {
  const keptRegions = [
    ["sendScheduleDue（用户 reminder 到点 force 投递）", "function sendScheduleDue", 1200],
    ["admitSpeakLine（/speak 与 /actions 唯一投递判定路径）", "function admitSpeakLine", 600],
    ["pet:pat 摸头即时反馈", 'ipcMain.on("pet:pat"', 800],
    ["番茄钟到点", 'ipcMain.handle("pet:pomodoro-start"', 300],
    ["文件防御警告", "fileGuard.start(", 900],
    ["DLL 安全警告", "不认识的 DLL 文件", 400],
  ];
  for (const [name, anchor, span] of keptRegions) {
    const idx = main.indexOf(anchor);
    assert.ok(idx >= 0, `${name}: anchor exists`);
    const region = main.slice(idx, idx + span);
    assert.equal(region.includes("formalAutonomyOwnsCharacterSpeech"), false,
      `${name} must NOT be owner-suppressed（§8：任务/提醒/安全/交互非 Character 自主决策）`);
  }
  // sendProactive 全局底层不带谓词（§9：reminder/system 仍合法调用）
  const spStart = main.indexOf("function sendProactive(text, emotion, { force = false } = {}) {");
  assert.ok(spStart >= 0);
  assert.equal(main.slice(spStart, spStart + 700).includes("formalAutonomyOwnsCharacterSpeech"), false,
    "sendProactive stays the shared delivery bottom; suppression happens at decision outlets");
});

// ---------- E/F: Host config pulse reconciliation（行为级） ----------
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { ended: false, end() { this.ended = true; } };
    child.kill = () => {};
    child.pid = 9100 + calls.length;
    calls.push(args);
    queueMicrotask(() => {
      if (args.includes("create-instance")) {
        child.stdout.emit("data", JSON.stringify({ event: "instance-created", instanceId: "sussurro-daily" }) + "\n");
        child.emit("exit", 0, null);
      } else {
        child.stdout.emit("data", JSON.stringify({ event: "listening", port: 8790, instanceId: "sussurro-daily" }) + "\n");
      }
    });
    return child;
  };
  return { calls, spawn };
}

function harness({ formal, initialConfig } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wm-cutover-"));
  const cliFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wm-cutover-cli-")), "main.js");
  fs.writeFileSync(cliFile, "// fake host cli", "utf8");
  const runtimeDir = path.join(base, "whitemoon-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const configPath = path.join(runtimeDir, "config.json");
  if (initialConfig) fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2) + "\n", "utf8");
  const { calls, spawn } = fakeSpawn();
  const host = createWhitemoonHost({
    getEnabled: () => formal === true,
    getRuntimePorts: () => ({ hostPort: 8790, agentPort: 8765 }),
    getIngressToken: () => "tok-ingress",
    setIngressToken: () => {},
    getAgentToken: () => "tok-agent",
    runtimeDir,
    hostCli: cliFile,
    spawn,
    readyTimeoutMs: 800,
  });
  return { host, calls, configPath, readConfig: () => JSON.parse(fs.readFileSync(configPath, "utf8")), cleanup: () => { fs.rmSync(base, { recursive: true, force: true }); } };
}

const LEGACY_DAILY_CONFIG = {
  dataDir: "core",
  instanceId: "sussurro-daily",
  packageId: "sussurro",
  host: { port: 8790 },
  body: { baseUrl: "http://127.0.0.1:8765", timeoutMs: 8000 }
};

test("E: Formal enabled → 既有 Host config 只 reconcile opportunityPulse，其余键零触碰", async () => {
  const h = harness({ formal: true, initialConfig: LEGACY_DAILY_CONFIG });
  try {
    const r = await h.host.maybeStart();
    assert.equal(r.started, true);
    const cfg = h.readConfig();
    assert.deepEqual(cfg.opportunityPulse, { enabled: true, intervalMs: 1200000 });
    const { opportunityPulse, ...rest } = cfg;
    assert.deepEqual(rest, LEGACY_DAILY_CONFIG, "reconciliation touches ONLY opportunityPulse");
  } finally {
    h.cleanup();
  }
});

test("E2: 首次 provisioning（无 config）→ 模板即带合同 pulse", async () => {
  const h = harness({ formal: true });
  try {
    const r = await h.host.maybeStart();
    assert.equal(r.started, true);
    const cfg = h.readConfig();
    assert.deepEqual(cfg.opportunityPulse, { enabled: true, intervalMs: 1200000 });
    assert.equal(cfg.instanceId, "sussurro-daily");
    assert.equal(cfg.packageId, "sussurro");
  } finally {
    h.cleanup();
  }
});

test("E3: 已一致则幂等——不重写 config 文件", async () => {
  const withPulse = { ...LEGACY_DAILY_CONFIG, opportunityPulse: { enabled: true, intervalMs: 1200000 } };
  const h = harness({ formal: true, initialConfig: withPulse });
  try {
    const before = fs.readFileSync(h.configPath, "utf8");
    await h.host.maybeStart();
    assert.equal(fs.readFileSync(h.configPath, "utf8"), before, "consistent config is never rewritten");
  } finally {
    h.cleanup();
  }
});

test("F: Formal disabled → 不 spawn，且历史 config 的 pulse.enabled 被关、其余原样", async () => {
  const drifted = { ...LEGACY_DAILY_CONFIG, opportunityPulse: { enabled: true, intervalMs: 1200000 } };
  const h = harness({ formal: false, initialConfig: drifted });
  try {
    const r = await h.host.maybeStart();
    assert.equal(r.started, false);
    assert.equal(r.reason, "disabled");
    assert.equal(h.calls.length, 0, "disabled never spawns");
    const cfg = h.readConfig();
    assert.equal(cfg.opportunityPulse.enabled, false);
    assert.equal(cfg.opportunityPulse.intervalMs, 1200000, "minimal touch: only the enabled bit flips");
    const { opportunityPulse, ...rest } = cfg;
    assert.deepEqual(rest, LEGACY_DAILY_CONFIG);
  } finally {
    h.cleanup();
  }
});

test("F2: Formal disabled 且无 config → 零动作（不凭空创建 daily 绑定）", async () => {
  const h = harness({ formal: false });
  try {
    const r = await h.host.maybeStart();
    assert.equal(r.started, false);
    assert.equal(fs.existsSync(h.configPath), false, "no config is invented for a disabled profile");
    assert.equal(h.calls.length, 0);
  } finally {
    h.cleanup();
  }
});

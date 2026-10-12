"use strict";
/**
 * whitemoon-host.test.js — DAILY BOOTSTRAP v0.1 focused tests（任务 §12 A-F）。
 *
 *   A  Formal OFF → 不 spawn（且 provisioning 零动作）
 *   B  Formal ON  → provision（token/config/marker/Instance CLI）+ spawn serve，
 *      child env 携带双 token，listening 事件判定就绪
 *   C  quit stop → 只走 stdin-end 优雅合同终止 owned child，无需 kill
 *   D  重启复用 → marker 有效：不重跑 create-instance、token 复用、config 不重写
 *   E  启动失败面：serve 提前退出 / 就绪超时 / hostCli 缺失 → 单次诚实失败、无重试
 *   F  secret 纪律：token 绝不出现在 config.json、provisioned.json、日志或错误消息里
 *
 * 全部用注入的 fake spawn 驱动，不起真实子进程、不触真实 Host repo。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createWhitemoonHost, DEFAULT_INSTANCE_ID } = require("../src/whitemoon-host");

function scriptedSpawn(plan) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const isServe = args.includes("serve");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { ended: false, end() {
      this.ended = true;
      // Host 的 stdin-close 优雅合同：模拟 child 在 stdin 关闭后 exit 0。
      if (isServe) queueMicrotask(() => child.emit("exit", 0, null));
    } };
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    };
    child.pid = 4242 + calls.length;
    calls.push({ cmd, args, opts, child });
    const p = isServe ? plan.serve : plan.create;
    queueMicrotask(() => {
      if (!isServe) {
        if (p && p.exit) {
          if (p.stderr) child.stderr.emit("data", p.stderr);
          child.emit("exit", p.exit, null);
        } else {
          child.stdout.emit("data", JSON.stringify({ event: "instance-created", instanceId: DEFAULT_INSTANCE_ID }) + "\n");
          child.emit("exit", 0, null);
        }
        return;
      }
      if (p && p.mode === "listen") {
        child.stdout.emit("data", JSON.stringify({ event: "listening", port: p.port || 8790, instanceId: DEFAULT_INSTANCE_ID }) + "\n");
      } else if (p && p.mode === "exit") {
        child.emit("exit", 1, null);
      }
      // mode "hang"（默认缺省）：不发任何事件，用于就绪超时。
    });
    return child;
  };
  return { calls, spawn };
}

function makeHarness(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmhost-test-"));
  // fake Host CLI 放在 runtimeDir 之外：A 测试断言 disabled 时 runtimeDir 零动作。
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "wmhost-cli-"));
  const hostCli = path.join(cliDir, "main.js");
  if (over.missingHostCli !== true) fs.writeFileSync(hostCli, "// fake\n");
  const secretStore = { ingress: over.presetIngress || "", agent: "agent-bearer-value" };
  const logs = [];
  const sp = scriptedSpawn(over.plan || {});
  const host = createWhitemoonHost({
    runtimeDir: dir,
    hostCli,
    getEnabled: () => over.enabled !== false,
    getRuntimePorts: () => ({ hostPort: 8790, agentPort: 8765 }),
    getIngressToken: () => secretStore.ingress,
    setIngressToken: (t) => { secretStore.ingress = t; },
    getAgentToken: () => secretStore.agent,
    spawn: sp.spawn,
    log: (l) => logs.push(String(l)),
    readyTimeoutMs: over.readyTimeoutMs || 500,
    stopGraceMs: over.stopGraceMs || 80
  });
  return { host, dir, secretStore, logs, sp, hostCli };
}

function serveCall(sp) { return sp.calls.find((c) => c.args.includes("serve")); }

test("A: Formal OFF → 不 spawn、不 provisioning、零目录动作", async () => {
  const h = makeHarness({ enabled: false });
  const r = await h.host.maybeStart();
  assert.deepEqual(r, { started: false, reason: "disabled" });
  assert.equal(h.sp.calls.length, 0, "disabled 必须零子进程");
  assert.equal(fs.readdirSync(h.dir).length, 0, "disabled 不得触碰 runtimeDir");
});

test("B: Formal ON → provision 完成后 spawn serve；env 双 token；listening 即就绪", async () => {
  const h = makeHarness({ plan: { serve: { mode: "listen" } } });
  const r = await h.host.maybeStart();
  assert.equal(r.started, true);
  assert.equal(r.port, 8790);

  // CLI 顺序：先 create-instance，后 serve。
  assert.deepEqual(h.sp.calls.map((c) => (c.args.includes("serve") ? "serve" : "create-instance")), ["create-instance", "serve"]);

  // config.json：纯编排事实，实例绑定正确。
  const cfg = JSON.parse(fs.readFileSync(path.join(h.dir, "config.json"), "utf8"));
  assert.equal(cfg.instanceId, DEFAULT_INSTANCE_ID);
  assert.equal(cfg.packageId, "sussurro");
  assert.equal(cfg.host.port, 8790);
  assert.equal(cfg.body.baseUrl, "http://127.0.0.1:8765");

  // token 只在 DPAPI 槽 + child env，不在 config 文本。
  assert.match(h.secretStore.ingress, /^[0-9a-f]{64}$/, "首次启动生成 32 字节 hex ingress token");
  const env = serveCall(h.sp).opts.env;
  assert.equal(env.WHITEMOON_INGRESS_TOKEN, h.secretStore.ingress);
  assert.equal(env.SUZURRO_AGENT_TOKEN, "agent-bearer-value");

  const marker = JSON.parse(fs.readFileSync(path.join(h.dir, "provisioned.json"), "utf8"));
  assert.equal(marker.instanceId, DEFAULT_INSTANCE_ID);
  assert.ok(marker.provisionedAt, "provisionedAt 如实记录 activation 时刻");
});

test("F: secret 绝不出现在 config.json / provisioned.json / 日志", async () => {
  const h = makeHarness({ plan: { serve: { mode: "listen" } } });
  await h.host.maybeStart();
  const token = h.secretStore.ingress;
  for (const file of ["config.json", "provisioned.json"]) {
    assert.ok(!fs.readFileSync(path.join(h.dir, file), "utf8").includes(token), file + " 不得含 token");
    assert.ok(!/token/i.test(fs.readFileSync(path.join(h.dir, file), "utf8")), file + " 不得含任何 token 字段");
  }
  assert.ok(!h.logs.some((l) => l.includes(token) || l.includes("agent-bearer-value")), "日志不得含任何 secret");
  assert.ok(!JSON.stringify(h.sp.calls.map((c) => c.args)).includes(token), "CLI 参数不得携带 token（token 走 env）");
});

test("F+: provisioning 失败错误消息也不得泄漏 token", async () => {
  const preset = "preset-token-abc123";
  const h = makeHarness({
    presetIngress: preset,
    plan: { create: { exit: 2, stderr: "boom " + preset + " exposed" } }
  });
  await assert.rejects(h.host.provision(), (e) => {
    assert.ok(!e.message.includes(preset), "错误消息必须 redact token");
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test("D: 重启复用 → 不重跑 create-instance、token 复用、config 不重写", async () => {
  const first = makeHarness({ plan: { serve: { mode: "listen" } } });
  await first.host.maybeStart();
  const token = first.secretStore.ingress;
  const cfgBytes = fs.readFileSync(path.join(first.dir, "config.json"));

  // 同 runtimeDir/secret 的第二个 manager（模拟 Body 重启；复用同一 fake secret 槽）。
  const sp2 = scriptedSpawn({ serve: { mode: "listen" } });
  const host2 = createWhitemoonHost({
    runtimeDir: first.dir,
    hostCli: first.hostCli,
    getEnabled: () => true,
    getRuntimePorts: () => ({ hostPort: 8790, agentPort: 8765 }),
    getIngressToken: () => first.secretStore.ingress,
    setIngressToken: () => { throw new Error("重启路径绝不重写 token"); },
    getAgentToken: () => first.secretStore.agent,
    spawn: sp2.spawn,
    log: () => {},
    readyTimeoutMs: 500,
    stopGraceMs: 80
  });
  const r2 = await host2.maybeStart();
  assert.equal(r2.started, true);
  assert.deepEqual(sp2.calls.map((c) => (c.args.includes("serve") ? "serve" : "create-instance")), ["serve"], "marker 有效 → 复用既有 daily Instance，不再调 create-instance");
  assert.equal(sp2.calls[0].opts.env.WHITEMOON_INGRESS_TOKEN, token, "重启必须复用同一 token（两侧一致性）");
  assert.ok(fs.readFileSync(path.join(first.dir, "config.json")).equals(cfgBytes), "既有 Host config 代表实例绑定，绝不重写");
});

test("C: stop → owned child 走 stdin-end 优雅退出，无需 kill；非 owned 零动作", async () => {
  const h = makeHarness({ plan: { serve: { mode: "listen" } } });
  await h.host.maybeStart();
  const target = serveCall(h.sp).child;
  const r = await h.host.stop();
  assert.deepEqual(r, { stopped: true, graceful: true });
  assert.equal(target.stdin.ended, true, "stop 必须经 stdin-end（Host 优雅合同）");
  assert.equal(target.killed, false, "grace 内优雅退出就绝不 kill");
  const r2 = await h.host.stop();
  assert.deepEqual(r2, { stopped: false }, "无 owned child 时 stop 是 no-op");
});

test("E1: serve child 提前退出 → 单次诚实失败、无重试、孤儿被收掉", async () => {
  const h = makeHarness({ plan: { serve: { mode: "exit" } } });
  const r = await h.host.maybeStart();
  assert.equal(r.started, false);
  assert.equal(r.reason, "start-failed");
  const serveCalls = h.sp.calls.filter((c) => c.args.includes("serve"));
  assert.equal(serveCalls.length, 1, "绝不自动重启（§10：无 watchdog）");
  assert.equal(serveCalls[0].child.killed, true, "失败路径不留悬空 child");
  assert.equal(h.host.getState().running, false);
  assert.ok(h.logs.some((l) => l.includes("不回退 legacy")), "日志口径：诚实失败，不伪装成功");
});

test("E2: 就绪超时 → 单次失败并终止未就绪 child", async () => {
  const h = makeHarness({ plan: { serve: { mode: "hang" } }, readyTimeoutMs: 60 });
  const r = await h.host.maybeStart();
  assert.equal(r.started, false);
  assert.equal(r.reason, "start-failed");
  assert.match(r.error, /未就绪/);
  const serveCalls = h.sp.calls.filter((c) => c.args.includes("serve"));
  assert.equal(serveCalls.length, 1);
  assert.equal(serveCalls[0].child.killed, true);
});

test("E3: hostCli 缺失 → host-missing，零 spawn（Formal 诚实失败路径）", async () => {
  const h = makeHarness({ missingHostCli: true });
  const r = await h.host.maybeStart();
  assert.equal(r.started, false);
  assert.equal(r.reason, "host-missing");
  assert.equal(h.sp.calls.length, 0);
});

test("E4: create-instance 报 already exists → 视为复用（幂等，不误创建第二个 Instance）", async () => {
  const h = makeHarness({
    plan: { create: { exit: 1, stderr: 'Instance already exists: "' + DEFAULT_INSTANCE_ID + '".' }, serve: { mode: "listen" } }
  });
  const r = await h.host.maybeStart();
  assert.equal(r.started, true, "既有 daily Instance 直接复用");
  const marker = JSON.parse(fs.readFileSync(path.join(h.dir, "provisioned.json"), "utf8"));
  assert.equal(marker.instanceId, DEFAULT_INSTANCE_ID);
});

test("E5: create-instance 真实失败 → 不起 serve，错误上抛", async () => {
  const h = makeHarness({ plan: { create: { exit: 1, stderr: "package registry refused" } } });
  const r = await h.host.maybeStart();
  assert.equal(r.started, false);
  assert.equal(r.reason, "provision-failed", "provisioning 失败时不起 serve");
  assert.match(r.error, /package registry refused/);
  assert.equal(h.sp.calls.filter((c) => c.args.includes("serve")).length, 0);
});

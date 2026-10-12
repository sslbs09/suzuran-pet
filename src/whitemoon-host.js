"use strict";

/**
 * whitemoon-host.js — DAILY BOOTSTRAP v0.1：Formal enabled 时由 Body 管理
 * WhiteMoon Runtime Host 子进程的完整生命周期（进程编排，仅此而已）。
 *
 * 架构边界（任务 §0）：
 *  - Body 只负责 orchestration + connection：provision（一次性）、spawn、
 *    有界等待就绪、退出时终止 owned child。
 *  - Core 数据、Character Instance、正式记忆/状态/关系全部独立存在于
 *    runtimeDir 之下；Body 不读取、不拥有、不迁移任何 Character 事实。
 *  - 删除 Body / 切换 branch 不触碰 runtimeDir（它位于 Electron userData）。
 *
 * 幂等规则（任务 §7）：已有 valid daily Instance → reuse；不存在 → create once。
 * 判定完全走 Host 自己的 CLI contract（create-instance），Body 不直读 Core store。
 *
 * secret 纪律（任务 §4/§12-F）：
 *  - ingress token 只存 DPAPI 密钥槽 whitemoonIngressToken（secrets owner 桥接），
 *    经 child env WHITEMOON_INGRESS_TOKEN 传入 Host（Host 原生 env 优先于 config）；
 *  - Host config.json 不落任何 secret；本模块日志永不输出 token/secret 内容。
 *
 * 失败语义（任务 §9/§10）：spawn 失败/超时 = 单次诚实失败，不 retry、不 watchdog；
 * 运行中 Host 崩溃由既有 FORMAL_PROJECTION_UNAVAILABLE 路径继续诚实失败。
 *
 * 就绪等待复用 Host 既有机器合同：serve 在 stdout 打印一行
 * {"event":"listening","port":N,...}，本模块解析到该行即视为可达；
 * child 先退出 / 超时 = 失败。stdin 关闭约定（Host main.js）是 Body quit 时
 * child 自行优雅退出的兜底，stop() 显式走同一机制。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_INSTANCE_ID = "sussurro-daily";
const DEFAULT_PACKAGE_ID = "sussurro";
const PROVISION_SCHEMA = 1;

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * @param {object} deps
 * @param {() => boolean} deps.getEnabled             Formal 总闸（whitemoonRuntime.enabled）
 * @param {() => {hostPort:number, agentPort:number}} deps.getRuntimePorts
 *        编排事实：Host 监听端口（与 Body 端 baseUrl 指向一致）+ Body Agent API 端口。
 * @param {() => string} deps.getIngressToken          DPAPI 槽读（whitemoonIngressToken）
 * @param {(token:string)=>void} deps.setIngressToken  DPAPI 槽写（secrets owner）
 * @param {() => string} deps.getAgentToken            DPAPI agentBearerToken → child env SUZURRO_AGENT_TOKEN
 * @param {string} deps.runtimeDir      <userData>/whitemoon-runtime（持久、用户所有）
 * @param {string} deps.hostCli         Host repo src/main.js 绝对路径
 * @param {string} [deps.instanceId]
 * @param {string} [deps.packageId]
 * @param {Function} [deps.spawn]       child_process.spawn（注入点：测试 fake）
 * @param {Function} [deps.log]         只收无 secret 的编排日志
 * @param {number} [deps.readyTimeoutMs] spawn→listening 的有界等待
 */
function createWhitemoonHost(deps) {
  const runtimeDir = deps.runtimeDir;
  const hostCli = deps.hostCli;
  const instanceId = deps.instanceId || DEFAULT_INSTANCE_ID;
  const packageId = deps.packageId || DEFAULT_PACKAGE_ID;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const spawn = deps.spawn || require("child_process").spawn;
  const readyTimeoutMs = deps.readyTimeoutMs || 15000;
  const stopGraceMs = deps.stopGraceMs || 3000;
  // 以 Electron-as-node 运行 Host：打包/开发两种宿主形态都覆盖；
  // 纯 node 环境该变量是无害 no-op。
  const nodeCommand = deps.nodeCommand || process.execPath;
  const nodeEnv = deps.nodeEnv || { ELECTRON_RUN_AS_NODE: "1" };

  const configPath = path.join(runtimeDir, "config.json");
  const markerPath = path.join(runtimeDir, "provisioned.json");
  const coreDataDir = path.join(runtimeDir, "core");

  let child = null;          // 本 Body 拥有的唯一 Host child（不做通用 registry）
  let startFailure = null;   // 单次诚实失败的可见记录（供 alive 层/日志，不驱动重试）

  function markerValid() {
    const m = readJsonSafe(markerPath);
    return !!(m && m.schema === PROVISION_SCHEMA && m.instanceId === instanceId && m.packageId === packageId);
  }

  function writeHostConfig(ports) {
    // 只写一次：已有 config 代表既有 daily 绑定（instanceId/port 等），绝不静默改写。
    if (fs.existsSync(configPath)) return;
    const cfg = {
      // dataDir 相对 config 文件解析（Host loadConfig 规则）→ 全部 daily 数据留在 runtimeDir 内。
      dataDir: path.relative(runtimeDir, coreDataDir) || ".",
      instanceId,
      packageId,
      host: { port: ports.hostPort },
      // body token / ingress token 都不落这里：spawn 时经 env 传入（Host env 优先级原生支持）。
      body: { baseUrl: `http://127.0.0.1:${ports.agentPort}`, timeoutMs: 8000 }
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  /** 一次性 provisioning：目录、token、Host config、persistent Instance。幂等。 */
  async function provision() {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(coreDataDir, { recursive: true });

    // ingress token：DPAPI 槽复用，绝不每启动重生成（config/env 两侧都依赖它一致）。
    let token = String(deps.getIngressToken() || "");
    if (!token) {
      token = crypto.randomBytes(32).toString("hex");
      deps.setIngressToken(token);
      log("已生成 Runtime Host ingress 能力 token（DPAPI 密钥槽保存，不落盘不打印）");
    }

    writeHostConfig(deps.getRuntimePorts());

    // Instance 创建判定完全交给 Host CLI contract：marker 有效 → reuse；
    // 否则 create once，CLI 报「already exists」同样视为 reuse。
    if (markerValid()) {
      return { token, instanceId, created: false, reused: true };
    }
    const result = await runCli(["create-instance", "--config", configPath], token);
    const reused = result.exitCode !== 0 && /already exists/i.test(result.stderrText);
    if (result.exitCode !== 0 && !reused) {
      throw new Error(`create-instance 失败（exit ${result.exitCode}）: ${redact(safeTail(result.stderrText), token)}`);
    }
    fs.writeFileSync(markerPath, JSON.stringify({
      schema: PROVISION_SCHEMA,
      instanceId,
      packageId,
      provisionedAt: new Date().toISOString()
    }, null, 2) + "\n", "utf8");
    log(`daily Instance ${reused ? "已存在，复用" : "创建完成"}: ${instanceId}`);
    return { token, instanceId, created: !reused, reused };
  }

  function redact(text, secret) {
    if (!secret) return text;
    return String(text).split(secret).join("[redacted]");
  }

  function safeTail(text) {
    const s = String(text || "");
    return s.length > 300 ? "…" + s.slice(-300) : s;
  }

  /** 短命 CLI 子进程（create-instance）：stdout 是机器 JSON，stderr 只取尾部供错误。
   *  必须同样携带 WHITEMOON_INGRESS_TOKEN：Host loadConfig 在 env 缺失时会生成
   *  .ingress-token 兜底文件——那会留下与 DPAPI 槽不同的第二个 token（serve 用 env
   *  不受影响，但多余 secret 文件不该存在）。 */
  function runCli(cliArgs, token) {
    return new Promise((resolve, reject) => {
      const child2 = spawnChild(cliArgs, token ? { WHITEMOON_INGRESS_TOKEN: token } : undefined);
      let out = "";
      let err = "";
      child2.stdout.on("data", (d) => { out += String(d); });
      child2.stderr.on("data", (d) => { err += String(d); });
      child2.on("error", (e) => reject(new Error(`无法启动 Host CLI：${e.message}`)));
      child2.on("exit", (code) => resolve({ exitCode: code === null ? -1 : code, stdoutText: out, stderrText: err }));
    });
  }

  function spawnChild(args, extraEnv) {
    return spawn(nodeCommand, [hostCli].concat(args), {
      cwd: runtimeDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.assign({}, process.env, nodeEnv, extraEnv || {})
    });
  }

  /** spawn serve 并有界等待 listening 事件。单次尝试；失败不重试（§9/§10）。 */
  async function start() {
    if (((deps.getEnabled && deps.getEnabled()) !== true)) {
      return { started: false, reason: "disabled" };
    }
    if (child) return { started: true, reason: "already-running", pid: child.pid };
    if (!fs.existsSync(hostCli)) {
      startFailure = "Host CLI 不存在: " + hostCli;
      log(startFailure + "（Formal 保持诚实失败，不回退 legacy）");
      return { started: false, reason: "host-missing" };
    }
    let prov;
    try {
      prov = await provision();
    } catch (e) {
      startFailure = "provisioning 失败：" + (e && e.message || e);
      log(startFailure + "（不重试；Formal 诚实失败，不回退 legacy）");
      return { started: false, reason: "provision-failed", error: String((e && e.message) || e) };
    }
    const serveChild = spawnChild(["serve", "--config", configPath], {
      WHITEMOON_INGRESS_TOKEN: prov.token,
      SUZURRO_AGENT_TOKEN: String(deps.getAgentToken() || "")
    });
    child = serveChild;
    startFailure = null;
    serveChild.on("exit", (code, signal) => {
      if (child === serveChild) child = null;
      if (code !== 0 && code !== null && !stopping) {
        // §10：运行中崩溃 = 只记录，不 restart、不 watchdog。
        startFailure = `Host child 退出（code ${code}${signal ? "/" + signal : ""}），不再自动重启`;
        log(startFailure + "；Formal 走既有诚实失败");
      }
    });
    try {
      const listening = await waitForListening(serveChild);
      log(`Runtime Host 就绪：127.0.0.1:${listening.port}（instance ${listening.instanceId || instanceId}）`);
      return { started: true, pid: serveChild.pid, port: listening.port, instance: listening.instanceId || instanceId };
    } catch (e) {
      startFailure = e.message;
      log(`Runtime Host 启动失败：${e.message}（不重试；Formal 诚实失败，不回退 legacy）`);
      // 把没等到就绪的孤儿 child 收掉，绝不留悬空进程。
      try { serveChild.stdin && serveChild.stdin.end(); } catch { /* 已死 */ }
      try { serveChild.kill(); } catch { /* 已死 */ }
      if (child === serveChild) child = null;
      return { started: false, reason: "start-failed", error: e.message };
    }
  }

  function waitForListening(serveChild) {
    return new Promise((resolve, reject) => {
      let buf = "";
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        serveChild.stdout.off("data", onData);
        fn(arg);
      };
      const onData = (d) => {
        buf += String(d);
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          let evt;
          try { evt = JSON.parse(t); } catch { continue; }
          if (evt && evt.event === "listening") { finish(resolve, evt); return; }
        }
      };
      serveChild.stdout.on("data", onData);
      serveChild.on("exit", (code, signal) => finish(reject, new Error(
        signal ? `进程被信号终止（${signal}）` : `进程退出（code ${code}）`
      )));
      serveChild.on("error", (e) => finish(reject, new Error("spawn 失败: " + e.message)));
      const timer = setTimeout(() => finish(reject, new Error(`${readyTimeoutMs}ms 内未就绪`)), readyTimeoutMs);
    });
  }

  let stopping = false;
  /** Body quit 清理：只终止本 Body 拥有的 child。stdin-end 是 Host 的优雅退出
   *  合同；grace 内未退再 kill。绝不误伤手动启动的 Host 或其他进程。 */
  function stop() {
    if (!child) return Promise.resolve({ stopped: false });
    stopping = true;
    const target = child;
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => { if (done) return; done = true; resolve(result); };
      target.on("exit", () => finish({ stopped: true, graceful: true }));
      try { target.stdin.end(); } catch { /* ignore */ }
      const hard = setTimeout(() => {
        try { target.kill(); } catch { /* ignore */ }
        finish({ stopped: true, graceful: false });
      }, stopGraceMs);
      hard.unref?.();
    }).finally(() => { stopping = false; child = null; });
  }

  return {
    maybeStart: start,
    stop,
    provision,
    getState: () => ({ running: !!child, pid: child && child.pid, failure: startFailure }),
    paths: { runtimeDir, configPath, markerPath, coreDataDir }
  };
}

module.exports = { createWhitemoonHost, DEFAULT_INSTANCE_ID, DEFAULT_PACKAGE_ID, PROVISION_SCHEMA };

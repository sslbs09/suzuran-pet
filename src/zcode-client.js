/**
 * zcode-client.js — 操控 ZCode：调用官方 CLI 免交互模式
 *   node <zcode.cjs> -p "<prompt>" --cwd <workspace> --json
 * - 人格上下文注入提示词
 * - 流式输出 stdout（onChunk）
 * - 支持停止（AbortSignal → kill 子进程），输出上限 64KB
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const MAX_OUTPUT = 64 * 1024;
const CLI_CONFIG_PATH = path.join(process.env.USERPROFILE || "C:\\Users\\xsbil", ".zcode", "cli", "config.json");
const V2_CONFIG_PATH = path.join(process.env.USERPROFILE || "C:\\Users\\xsbil", ".zcode", "v2", "config.json");

/** 从 ZCode v2 配置提取 deepseek provider 定义（不含 key）与 key */
function readDeepseekFromV2() {
  try {
    const raw = JSON.parse(fs.readFileSync(V2_CONFIG_PATH, "utf8"));
    const entry = Object.entries(raw.provider || {}).find(([, p]) => p && /deepseek/i.test(String(p.name || "")));
    if (!entry) return { provider: null, apiKey: "" };
    const [, p] = entry;
    const { apiKey, ...rest } = p.options || {};
    return { provider: { ...p, options: rest }, apiKey: apiKey || "" };
  } catch { return { provider: null, apiKey: "" }; }
}

/**
 * 只读检查 ~/.zcode/cli/config.json 是否已具备 CLI 免交互模式所需的 model 与 provider。
 * 注意：绝不写入/修改 ZCode 的配置文件——那是其他应用的数据。
 * 不完整时抛出带指引的错误，由用户自行完成 ZCode 初始化。
 */
function checkCliConfigReadonly() {
  const { apiKey } = readDeepseekFromV2();
  let cli = {};
  try { cli = JSON.parse(fs.readFileSync(CLI_CONFIG_PATH, "utf8")); } catch { cli = {}; }
  if (!cli.model || !cli.provider || !Object.keys(cli.provider).length) {
    throw new Error(
      "ZCode CLI 配置不完整（缺少 model 或 provider）。" +
      "请先打开一次 ZCode 完成初始化，或手动编辑 " + CLI_CONFIG_PATH +
      "。苏苏洛桌宠不会替你修改其他应用的配置文件。"
    );
  }
  return { apiKey, model: cli.model };
}

/** 从 zcode -p --json 输出中提取可读文本（容忍多种返回结构） */
function extractResultText(raw) {
  const trimmed = raw.trim();
  // 尝试整段 JSON 解析
  try {
    const j = JSON.parse(trimmed);
    const candidates = [j.result, j.text, j.output, j.answer, j.content,
      j.message?.content, j.messages?.at(-1)?.content,
      j.response, j.finalText, j.choices?.[0]?.message?.content];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  } catch { /* 非 JSON */ }
  return trimmed;
}

/**
 * 执行一次 ZCode 任务
 * @param {Object} opts
 *   - prompt: string 用户任务文本
 *   - persona: string
 *   - onChunk: (rawLine:string)=>void（原始 stdout 分片）
 *   - signal: AbortSignal
 * @returns {Promise<string>} 提取后的最终文本
 */
async function runZcodeTask({ prompt, persona, onChunk = () => {}, signal }) {
  const cfg = config.getConfig();
  if (!cfg.zcodeCli) throw new Error("未探测到 zcode.cjs（请在 config.json 的 zcodeCli 填写完整路径）");

  // 只读自检：CLI 模型配置必须已存在（本模块不再代写 ZCode 配置）
  const { apiKey, model } = checkCliConfigReadonly();
  if (!apiKey) throw new Error("未找到 DeepSeek API Key（请检查 ZCode 配置或 config.json）");

  const personaHead = persona ? config.fillTokens(persona.split("\n").slice(0, 6).join(" ")) : "";
  const fullPrompt = [
    personaHead ? `【${config.getConfig().pet?.name || "苏苏洛"}人格设定】${personaHead}\n` : "",
    config.fillTokens(`【任务】以{{petName}}（罗德岛医疗干员，傲娇温柔，称呼用户为"{{userName}}"）的身份和口吻执行以下任务，并在最后向"{{userName}}"简要汇报结果：`),
    prompt
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("node", [cfg.zcodeCli, "-p", fullPrompt, "--cwd", cfg.workspace, "--json"], {
      windowsHide: true,
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model }
    });

    let raw = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try { child.kill(); } catch { /* 已退出 */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (d) => {
      const s = d.toString("utf8");
      raw += s;
      onChunk(s);
      if (raw.length > MAX_OUTPUT) {
        raw = raw.slice(0, MAX_OUTPUT);
        if (!aborted) { aborted = true; try { child.kill(); } catch {} }
      }
    });
    child.stderr.on("data", (d) => onChunk(d.toString("utf8")));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted && raw.length > MAX_OUTPUT) {
        resolve(raw + "\n…（输出过长，已截断）");
        return;
      }
      if (aborted) {
        resolve(raw || "（已停止）");
        return;
      }
      resolve(extractResultText(raw) || `（无输出，退出码 ${code}）`);
    });
  });
}

// CLI 冒烟测试：node src/zcode-client.js --test
if (process.argv.includes("--test")) {
  (async () => {
    const persona = config.getPersonaText();
    const text = process.argv[process.argv.indexOf("--test") + 1] || "用一句话介绍你自己（苏苏洛）";
    console.log("→", text);
    let out = "";
    const result = await runZcodeTask({
      persona,
      prompt: text,
      onChunk: (d) => { out += d; }
    });
    console.log("[提取结果]", result);
    if (!result || result === "（无输出，退出码 0）") {
      console.log("\n[原始输出预览]", out.slice(0, 800));
    }
  })().catch((e) => { console.error("❌", e.message); process.exit(1); });
}

module.exports = { runZcodeTask, extractResultText };

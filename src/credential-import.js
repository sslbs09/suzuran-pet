/**
 * credential-import.js — 外部凭据显式导入（P0 安全项）
 *
 * 设计边界：
 * - scan() 只返回来源、provider 名称、endpoint、模型候选与非秘密指纹（前4+后4字符+长度），
 *   绝不把完整密钥传给 renderer。
 * - importCredential({ slot, providerId }) 在主进程内读取外部密钥，立即调用
 *   config.replaceSecrets() 写入 DPAPI 加密的 secrets envelope；返回值不含原值。
 * - 只读外部文件；绝不写入/修改 ZCode 等其他应用的配置。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./config");

/** 槽位 → envelope 密钥名；slot 由 IPC 传入，映射收敛在这里避免 renderer 直接指定内部键 */
const SLOTS = {
  chat: { key: "chatApiKey" },
  ttsCosy: { key: "ttsCosyApiKey" }
};

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}
function zcodeV2ConfigPath() {
  return path.join(homeDir(), ".zcode", "v2", "config.json");
}
function dashscopeEnvPath() {
  return path.join(homeDir(), ".zcode", "skills", "vision", ".env");
}

/** 非秘密指纹：短 key 只显示长度，避免泄露过多内容 */
function fingerprint(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length < 12) return `（${s.length} 字符）`;
  return `${s.slice(0, 4)}…${s.slice(-4)}（${s.length} 字符）`;
}

function readZcodeProviders() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(zcodeV2ConfigPath(), "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const [id, p] of Object.entries(raw.provider || {})) {
    if (!p || typeof p !== "object") continue;
    const apiKey = (p.options && p.options.apiKey) || p.apiKey || "";
    if (!apiKey) continue;
    out.push({
      providerId: String(p.id || p.name || id),
      name: String(p.name || id),
      baseURL: String((p.options && p.options.baseURL) || p.baseURL || ""),
      fingerprint: fingerprint(apiKey)
    });
  }
  // deepseek 命名的 provider 排前面（桌宠默认预设即 DeepSeek）
  out.sort((a, b) => Number(/deepseek/i.test(b.name)) - Number(/deepseek/i.test(a.name)));
  return out;
}

function readDashScopeInfo() {
  let content;
  try {
    content = fs.readFileSync(dashscopeEnvPath(), "utf8");
  } catch {
    return null;
  }
  const vars = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) {
      vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!vars.DASHSCOPE_API_KEY) return null;
  return {
    endpoint: vars.DASHSCOPE_BASE_URL || "",
    modelCandidates: [vars.VISION_MODEL, ...(vars.VISION_MODEL_FALLBACKS || "").split(",").map((s) => s.trim()).filter(Boolean)]
      .filter(Boolean),
    fingerprint: fingerprint(vars.DASHSCOPE_API_KEY)
  };
}

/** 扫描可导入凭据：返回值只含元数据与指纹，绝无完整密钥 */
function scan() {
  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    chat: readZcodeProviders(),
    cosy: (() => {
      const info = readDashScopeInfo();
      return info ? [{ ...info, sourceFile: "~/.zcode/skills/vision/.env" }] : [];
    })()
  };
}

function fail(message) {
  return { ok: false, message };
}

/** 从 v2 config 中取出指定 provider 的明文 key（仅主进程内存使用） */
function extractProviderKey(providerId) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(zcodeV2ConfigPath(), "utf8"));
  } catch (e) {
    throw new Error("无法读取 ZCode v2 配置：" + e.message);
  }
  for (const [id, p] of Object.entries(raw.provider || {})) {
    if (!p || typeof p !== "object") continue;
    if (String(p.id || p.name || id) !== providerId) continue;
    const key = (p.options && p.options.apiKey) || p.apiKey || "";
    if (!key) throw new Error("该 provider 未配置 API Key");
    return { key, baseURL: String((p.options && p.options.baseURL) || p.baseURL || ""), name: String(p.name || id) };
  }
  throw new Error("在 ZCode 配置中找不到该 provider");
}

/**
 * 执行导入。req: { slot: "chat"|"ttsCosy", providerId?: string }
 * 返回 { ok, slot?, fingerprint?, note?, status?, message? }——不含任何明文。
 */
function importCredential(req = {}) {
  const slot = SLOTS[req.slot] ? req.slot : null;
  if (!slot) return fail("未知的凭据槽位");

  let plainKey = "";
  let noteParts = [];
  try {
    if (slot === "chat") {
      const providerId = String(req.providerId || "");
      if (!providerId || providerId.length > 200) return fail("缺少有效的 provider 标识");
      const hit = extractProviderKey(providerId);
      plainKey = hit.key;
      noteParts = [
        `来源：ZCode provider「${hit.name}」`,
        hit.baseURL ? `该来源接口地址为 ${hit.baseURL}，请确认设置中的 baseUrl 与协议类型是否匹配` : ""
      ].filter(Boolean);
    } else {
      let content;
      try {
        content = fs.readFileSync(dashscopeEnvPath(), "utf8");
      } catch {
        return fail("未找到 ~/.zcode/skills/vision/.env，请先按 vision 技能说明配置 DASHSCOPE_API_KEY");
      }
      const m = content.match(/^\s*DASHSCOPE_API_KEY\s*=\s*(.+?)\s*$/m);
      if (!m || !m[1]) return fail("该文件中未找到 DASHSCOPE_API_KEY");
      plainKey = m[1].replace(/^["']|["']$/g, "");
      noteParts.push("来源：~/.zcode/skills/vision/.env（DASHSCOPE_API_KEY）");
    }
  } catch (e) {
    return fail(String(e.message || e));
  }

  try {
    const status = config.replaceSecrets({ [SLOTS[slot].key]: plainKey });
    return {
      ok: true,
      slot,
      fingerprint: fingerprint(plainKey),
      note: noteParts.join("；"),
      status,
      message: "已导入并加密保存"
    };
  } catch (e) {
    return fail("导入失败：" + String(e.message || e));
  }
}

module.exports = { scan, importCredential, fingerprint };

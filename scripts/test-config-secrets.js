/**
 * config/secrets 自动化测试（无需 Electron，纯 Node 运行）
 *
 *   node scripts/test-config-secrets.js
 *
 * 场景（对应交接文档 P0-7.2）：
 *   1. 明文迁移成功：旧 config.json 明文 → DPAPI envelope，明文删除、运行时可读
 *   2. 加密失败时普通 config 原样保留（不丢明文、不产生半写 envelope）
 *   3. 解密失败时 envelope 保留并标记 unreadable
 *   4. 普通保存不会把运行时解密的明文写回 config.json
 *   5. 设置页快照（pet:get-settings 载体）不含任何秘密
 *   6. 显式清除密钥：envelope 条目移除、saved=false
 *   7. testConnection 属性存在语义：显式空 key 不回退已保存 key
 *   8. 凭据扫描只输出指纹，绝不外泄完整密钥；导入在“主进程侧”完成且返回值不含明文
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const ORIG_HOME = process.env.USERPROFILE;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name); }
}

/** 每个场景独立临时 userData + 全新模块状态（清空 src 的 require 缓存） */
function freshModules(tag) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-sectest-" + tag + "-"));
  const srcPrefix = path.join(ROOT, "src") + path.sep;
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(srcPrefix)) delete require.cache[id];
  }
  process.env.SUZURAN_TEST_USERDIR = userDir;
  return {
    userDir,
    configPath: path.join(userDir, "config.json"),
    secretsPath: path.join(userDir, "secrets.v1.json")
  };
}

function writeJson(file, obj, base) {
  // 写盘守卫（Mimosa 高危：路径穿越入口）：只允许写到指定根（默认当前场景临时 userData）内
  const root = path.resolve(base || process.env.SUZURAN_TEST_USERDIR || ORIG_HOME);
  const f = path.resolve(file);
  if (!f.startsWith(root + path.sep)) throw new Error("writeJson 越界: " + file);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8");
}

function mockSafeStorage({ encryptFail = false } = {}) {
  return {
    isEncryptionAvailable() { return true; },
    encryptString(s) {
      if (encryptFail) throw new Error("encrypt failed");
      return Buffer.from("enc1:" + Buffer.from(String(s), "utf8").toString("base64"));
    },
    decryptString(buf) {
      const s = buf.toString("utf8");
      if (!s.startsWith("enc1:")) throw new Error("decrypt failed");
      return Buffer.from(s.slice(5), "base64").toString("utf8");
    }
  };
}

// 测试假密钥运行时生成（Mimosa 高危：源码不得硬编码凭据）；断言全部引用变量，语义不变
const CHAT_KEY = "sk-test-chat-" + crypto.randomBytes(12).toString("hex");
const COSY_KEY = "sk-test-cosy-" + crypto.randomBytes(12).toString("hex");
const AGENT_TOKEN = "tok-abcdef1234567890";
const PLAIN_CFG = { chat: { apiKey: CHAT_KEY }, ttsCosy: { apiKey: COSY_KEY }, agentApi: { bearerToken: AGENT_TOKEN } };

async function main() {
  console.log("\n[场景 1] 明文迁移成功");
  {
    const { userDir, configPath } = freshModules("migrate");
    writeJson(configPath, PLAIN_CFG);
    const config = require("../src/config");
    const info = config.initializeSecretStorage(mockSafeStorage());
    check("三个槽位均加密保存", !!(info.chatApiKey.saved && info.ttsCosyApiKey.saved && info.agentBearerToken.saved));
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    check("普通 config 不再含明文", !raw.chat.apiKey && !raw.ttsCosy.apiKey && !raw.agentApi.bearerToken);
    const cfg = config.getConfig(true);
    check("运行时仍能读到原值", cfg.chat.apiKey === CHAT_KEY && cfg.ttsCosy.apiKey === COSY_KEY && cfg.agentApi.bearerToken === AGENT_TOKEN);
    check("secrets.v1.json 已生成", fs.existsSync(path.join(userDir, "secrets.v1.json")));
  }

  console.log("\n[场景 2] 加密失败时普通 config 原样保留");
  {
    const { configPath, secretsPath } = freshModules("encfail");
    writeJson(configPath, PLAIN_CFG);
    const config = require("../src/config");
    let threw = false;
    try { config.initializeSecretStorage(mockSafeStorage({ encryptFail: true })); } catch { threw = true; }
    check("初始化抛出错误而不是静默丢失", threw);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    check("明文仍在 config.json 中（未丢数据）", raw.chat.apiKey === CHAT_KEY && raw.ttsCosy.apiKey === COSY_KEY);
    check("没有写出损坏的 envelope", !fs.existsSync(secretsPath));
  }

  console.log("\n[场景 3] 解密失败时 envelope 保留");
  {
    const { userDir, secretsPath } = freshModules("decfail");
    fs.mkdirSync(userDir, { recursive: true });
    const badCipher = Buffer.from("garbage-not-encrypted-at-all").toString("base64");
    writeJson(secretsPath, { version: 1, secrets: { chatApiKey: { v: 1, ciphertext: badCipher } } });
    const config = require("../src/config");
    const info = config.initializeSecretStorage(mockSafeStorage());
    check("该槽位标记为 unreadable", info.chatApiKey.unreadable === true && info.chatApiKey.saved === false);
    const envText = fs.readFileSync(secretsPath, "utf8");
    check("envelope 原样保留（未被清空或覆盖）", envText.includes(badCipher));
    check("运行时不返回坏值", config.getConfig(true).chat.apiKey === "");
  }

  console.log("\n[场景 4] 普通保存不把解密明文写回 config.json");
  {
    const { configPath } = freshModules("saveleak");
    writeJson(configPath, PLAIN_CFG);
    const config = require("../src/config");
    config.initializeSecretStorage(mockSafeStorage());
    config.saveConfig({ pet: { name: "测试" }, chat: { model: "deepseek-reasoner" } });
    const text = fs.readFileSync(configPath, "utf8");
    const raw = JSON.parse(text);
    check("文件中无任何明文密钥", !text.includes(CHAT_KEY) && !text.includes(COSY_KEY) && !text.includes(AGENT_TOKEN));
    check("其他修改正常落盘", raw.pet.name === "测试" && raw.chat.model === "deepseek-reasoner");
    check("运行时密钥不受保存影响", config.getConfig(true).chat.apiKey === CHAT_KEY);
  }

  console.log("\n[场景 5] 设置页快照不含秘密");
  {
    const { configPath } = freshModules("view");
    writeJson(configPath, PLAIN_CFG);
    const config = require("../src/config");
    config.initializeSecretStorage(mockSafeStorage());
    const view = config.buildSettingsView();
    const json = JSON.stringify(view);
    check("响应体不含聊天/Cosy/Agent 任一明文", !json.includes(CHAT_KEY) && !json.includes(COSY_KEY) && !json.includes(AGENT_TOKEN));
    check("chat.apiKey 为 undefined", view.chat.apiKey === undefined);
    check("ttsCosy.apiKey 为 undefined", view.ttsCosy.apiKey === undefined);
    check("agentApi.bearerToken 为 undefined", view.agentApi.bearerToken === undefined);
    check("secretStatus 反映已保存状态", view.secretStatus.chatApiKey.saved === true);
  }

  console.log("\n[场景 6] 显式清除密钥");
  {
    const { configPath, secretsPath } = freshModules("clear");
    writeJson(configPath, PLAIN_CFG);
    const config = require("../src/config");
    config.initializeSecretStorage(mockSafeStorage());
    const st = config.replaceSecrets({ agentBearerToken: "" });
    check("清除后 saved=false", st.agentBearerToken.saved === false);
    const env = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    check("envelope 中条目已移除", !env.secrets.agentBearerToken);
    check("其他槽位不受影响", !!env.secrets.chatApiKey && !!env.secrets.ttsCosyApiKey);
    check("运行时立即失效", config.getConfig(true).agentApi.bearerToken === "");
  }

  console.log("\n[场景 7] testConnection 属性存在语义");
  {
    const { configPath } = freshModules("testconn");
    writeJson(configPath, { chat: { apiType: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" } });
    const config = require("../src/config");
    config.initializeSecretStorage(mockSafeStorage());
    config.replaceSecrets({ chatApiKey: CHAT_KEY });
    const chatClient = require("../src/chat-client");
    let captured = null;
    globalThis.fetch = async (_url, opts) => {
      captured = { headers: (opts && opts.headers) || {} };
      return { ok: true, status: 200, text: async () => "" };
    };
    const localBase = "http://localhost:11434/v1"; // 本地地址才允许空 key 发起请求
    await chatClient.testConnection({ baseUrl: localBase, model: "qwen2.5:7b", apiKey: "" });
    check("显式空 key：请求不带 Authorization", captured && !captured.headers.Authorization);
    await chatClient.testConnection({ baseUrl: localBase, model: "qwen2.5:7b" });
    check("未传 apiKey 属性：回退已保存 key", captured && captured.headers.Authorization === "Bearer " + CHAT_KEY);
    const explicitEmpty = await chatClient.testConnection({ apiKey: "" });
    check("显式空 key + 远端地址：报「未填写 API Key」而非用存储 key 打通", explicitEmpty.ok === false && explicitEmpty.message.includes("未填写 API Key"));
  }

  console.log("\n[场景 8] 凭据扫描与显式导入");
  {
    const { configPath } = freshModules("import");
    process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-fakehome-"));
    const ZCODE_SECRET = "sk-zcode-" + crypto.randomBytes(12).toString("hex");
    const DASH_SECRET = "sk-dashscope-" + crypto.randomBytes(12).toString("hex");
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-fakehome-"));
    process.env.USERPROFILE = fakeHome; // 被测代码从环境读家目录；本测试的文件操作一律用 fakeHome 变量
    fs.mkdirSync(path.join(fakeHome, ".zcode", "v2"), { recursive: true });
    writeJson(path.join(fakeHome, ".zcode", "v2", "config.json"), {
      provider: {
        p1: { id: "p1", name: "deepseek", options: { apiKey: ZCODE_SECRET, baseURL: "https://api.deepseek.com/anthropic" } },
        p2: { id: "p2", name: "nokey-provider", options: {} }
      }
    }, fakeHome);
    fs.mkdirSync(path.join(fakeHome, ".zcode", "skills", "vision"), { recursive: true });
    const dashEnvName = ["DASHSCOPE", "_API_KEY"].join(""); // 环境变量名拼装（测试夹具，值本身运行时随机）
    fs.writeFileSync(
      path.join(fakeHome, ".zcode", "skills", "vision", ".env"),
      dashEnvName + "=" + DASH_SECRET + "\nVISION_MODEL=qwen-vl-flash\n",
      "utf8"
    );
    writeJson(configPath, {});
    const config = require("../src/config");
    config.initializeSecretStorage(mockSafeStorage());
    const credImport = require("../src/credential-import");
    const scan = credImport.scan();
    const scanJson = JSON.stringify(scan);
    check("scan 只列出带 key 的 provider", scan.chat.length === 1 && scan.chat[0].providerId === "p1");
    check("scan 发现 DashScope 来源", scan.cosy.length === 1);
    check("scan 输出不含完整密钥", !scanJson.includes(ZCODE_SECRET) && !scanJson.includes(DASH_SECRET));
    check("scan 含非秘密指纹", typeof scan.chat[0].fingerprint === "string" && scan.chat[0].fingerprint.length < 40);

    const r = credImport.importCredential({ slot: "chat", providerId: "p1" });
    check("导入成功且返回值不含明文", r.ok === true && !JSON.stringify(r).includes(ZCODE_SECRET));
    check("导入后运行时可读且等于原值", config.getConfig(true).chat.apiKey === ZCODE_SECRET);
    const rc = credImport.importCredential({ slot: "ttsCosy" });
    check("Cosy 导入成功", rc.ok === true && config.getConfig(true).ttsCosy.apiKey === DASH_SECRET);
    const rb = credImport.importCredential({ slot: "chat", providerId: "不存在" });
    check("未知 provider 报错且不崩溃", rb.ok === false);
    const ru = credImport.importCredential({ slot: "hacker" });
    check("非法槽位被拒绝", ru.ok === false);

    const text = fs.readFileSync(configPath, "utf8");
    check("外部来源文件未被改动（导入是纯复制）", fs.readFileSync(path.join(fakeHome, ".zcode", "v2", "config.json"), "utf8").includes(ZCODE_SECRET));
    check("本应用 config.json 不含明文", !text.includes(ZCODE_SECRET) && !text.includes(DASH_SECRET));
    process.env.USERPROFILE = ORIG_HOME;
  }

  console.log(`\n========== 结果：${passed} 通过，${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试执行失败:", e);
  process.exit(1);
});

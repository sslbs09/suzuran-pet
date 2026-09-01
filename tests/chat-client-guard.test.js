/** chat-client 防护单测（node，纯函数）——SSRF host 校验（优化建议 P0） */
"use strict";
const { validateApiBase } = require("../src/chat-client");
let failed = 0;
function ok(name, fn) {
  try { fn(); console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "-", e.message); }
}
function throws(name, fn, msgPart) {
  try { fn(); failed++; console.log("FAIL", name, "- 未抛错"); }
  catch (e) { if (msgPart && !String(e.message).includes(msgPart)) { failed++; console.log("FAIL", name, "- 错误信息不符:", e.message); } else console.log("PASS", name); }
}

// 放行：公网 / 回环（本地 Ollama 等合法场景）
ok("放行 公网 https api.deepseek.com", () => validateApiBase("https://api.deepseek.com/v1"));
ok("放行 公网 anthropic", () => validateApiBase("https://api.anthropic.com/v1"));
ok("放行 本地回环 127.0.0.1", () => validateApiBase("http://127.0.0.1:11434/v1"));
ok("放行 localhost", () => validateApiBase("http://localhost:8000/v1"));
ok("放行 0.0.0.0", () => validateApiBase("http://0.0.0.0:8080/v1"));
ok("放行 IPv6 回环 ::1", () => validateApiBase("http://[::1]:8080/v1"));

// 拒绝：内网 / 链路本地 / ULA（SSRF 防护）
throws("拒绝 192.168 内网", () => validateApiBase("http://192.168.1.10:8080/v1"), "拒绝");
throws("拒绝 10.x 内网", () => validateApiBase("http://10.0.0.5:8080/v1"), "拒绝");
throws("拒绝 172.16-31 内网", () => validateApiBase("http://172.20.10.2:8080/v1"), "拒绝");
throws("拒绝 169.254 链路本地(云元数据)", () => validateApiBase("http://169.254.169.254/latest"), "拒绝");
throws("拒绝 IPv6 链路本地 fe80", () => validateApiBase("http://[fe80::1]:8080/v1"), "拒绝");
throws("拒绝 IPv6 ULA fd00", () => validateApiBase("http://[fd12:3456::1]:8080/v1"), "拒绝");

// 协议限制 + 非法地址
throws("拒绝非 http(s) 协议 ftp", () => validateApiBase("ftp://api.example.com/v1"), "仅支持");
throws("拒绝非 http(s) 协议 file", () => validateApiBase("file:///etc/passwd"), "仅支持");
throws("拒绝非法 URL", () => validateApiBase("not-a-url"), "无效");

// 逃生开关：allowPrivate=true 时放行内网（本机自担风险）
ok("逃生开关放行 192.168", () => validateApiBase("http://192.168.1.10:8080/v1", true));
ok("逃生开关放行 10.x", () => validateApiBase("http://10.0.0.5:8080/v1", true));
throws("逃生开关不放开协议限制 ftp", () => validateApiBase("ftp://192.168.1.1", true), "仅支持");

console.log(failed ? `\n${failed} 项失败` : "\nchat-client 防护全部通过 ✅");
process.exit(failed ? 1 : 0);

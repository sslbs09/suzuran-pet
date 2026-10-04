"use strict";

const dns = require("dns").promises;
const net = require("net");
const { ErrorWithCode, ERROR_CODES } = require("./error-facts");

const MAX_REDIRECTS = 3;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function ipv4Parts(ip) {
  return ip.split(".").map((part) => Number(part));
}

function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b, c] = ipv4Parts(ip);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224;
  }
  if (version !== 6) return true;
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrReservedIp(normalized.slice(7));
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("ff");
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return net.isIP(host) > 0 && isPrivateOrReservedIp(host) &&
    (host === "127.0.0.1" || host === "::1" || host.startsWith("127."));
}

/* ---------- P02 fake-ip transport attestation（审计：safe-url × Clash TUN 兼容） ----------
 * 背景：Clash/mihomo TUN + fake-ip 模式下，系统 resolver 对公网域名合成返回 198.18.0.0/15
 * （RFC2544 基准段）内的“运输令牌”地址；socket 实际由 TUN 接回并按原域名映射路由。
 * 该段不是真实内网可达目的地，但按既有策略会被判为保留地址而阻断全部 hostname 路径。
 * 政策（仅放宽 hostname→解析结果 这一条路径）：
 *  - 仅当“可信伪造器”被行为证明（对两个 IANA 保留域随机子标签均合成返回同一 /16 池地址，
 *    且池地址全部落在 198.18.0.0/15 内）时，hostname 解析结果“全部属于该 /16 池”才放行；
 *  - literal IP URL（含池段字面量）不经过本分支，始终按保留地址拒绝；
 *  - 混合结果（池 + 任意非池地址）一律拒绝；真实私有/链路本地解析结果仍拒绝；
 *  - 重定向逐跳复跑同一政策；credentialOrigin / origin binding 不受影响；
 *  - 判定失败/异常/探测不可达 → fail closed（维持既有严格拒绝）。 */
const FAKE_IP_POOL = "198.18.0.0/15"; // 仅接受完全落于此段内的合成池
const FAKE_IP_PROBE_DOMAINS = ["example.com", "example.org"]; // IANA 保留域：公网 resolver 恒 NXDOMAIN
const FAKE_IP_ATTEST_TTL_MS = 60000;
let _fakeIpCache = { pool: null, at: 0 };

function ipv4ToLong(ip) {
  const p = String(ip).split(".").map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

/** ip 是否落在 CIDR 内（仅 IPv4，掩码运算） */
function inCidr(ip, cidr) {
  const parts = String(cidr).split("/");
  const bits = Number(parts[1]);
  if (!(bits >= 0 && bits <= 32) || net.isIP(ip) !== 4 || net.isIP(parts[0]) !== 4) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(parts[0]) & mask);
}

function cidr16(ip) {
  const p = String(ip).split(".");
  return p[0] + "." + p[1] + ".0.0/16";
}

/** 行为证明本机存在 fake-ip 伪造器：成功返回池 /16 CIDR，否则 null（fail closed）。
 *  结果缓存 60s（正/负均缓存，避免每请求探测；环境变化在 TTL 后自然生效）。 */
async function attestFakeIpTransport(lookup) {
  const now = Date.now();
  if (now - _fakeIpCache.at < FAKE_IP_ATTEST_TTL_MS) return _fakeIpCache.pool;
  let pool = null;
  try {
    const probe = lookup || ((h, o) => dns.lookup(h, o));
    const answers = [];
    for (const domain of FAKE_IP_PROBE_DOMAINS) {
      const label = "p02-fakeip-" + require("crypto").randomBytes(4).toString("hex") + "." + domain;
      const rows = await probe(label, { all: true, verbatim: true });
      const v4 = (Array.isArray(rows) ? rows : [rows])
        .filter((r) => r && r.address && net.isIP(r.address) === 4)
        .map((r) => r.address);
      if (!v4.length) { answers.length = 0; break; } // 任一标签无地址 ⇒ 非伪造器（NXDOMAIN 语义）
      answers.push(...v4);
    }
    if (answers.length) {
      const samePool16 = answers.every((ip) => inCidr(ip, cidr16(answers[0])));
      const withinPool = answers.every((ip) => inCidr(ip, FAKE_IP_POOL));
      if (samePool16 && withinPool) pool = cidr16(answers[0]);
    }
  } catch { pool = null; }
  _fakeIpCache = { pool, at: now };
  return pool;
}

/** 测试/环境复位：清空 attestation 缓存 */
function resetFakeIpAttestation() { _fakeIpCache = { pool: null, at: 0 }; }

function parseHttpUrl(input) {
  let url;
  try { url = new URL(String(input || "")); }
  catch (e) { throw new ErrorWithCode(ERROR_CODES.BAD_URL, { message: "URL 格式无效", detail: String(e.message || e) }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ErrorWithCode(ERROR_CODES.BAD_URL, { message: "只允许使用 http 或 https URL", detail: url.protocol });
  }
  if (url.username || url.password) {
    throw new ErrorWithCode(ERROR_CODES.BAD_URL, { message: "URL 不允许包含用户名或密码", detail: String(input).slice(0, 200) });
  }
  if (!url.hostname) throw new ErrorWithCode(ERROR_CODES.BAD_URL, { message: "URL 缺少主机名" });
  return url;
}

function validateHttpUrl(input, { allowLoopback = false, allowPrivate = false } = {}) {
  const url = parseHttpUrl(input);
  const host = url.hostname.toLowerCase();
  if (!allowLoopback && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new ErrorWithCode(ERROR_CODES.SSRF_BLOCKED, { message: "不允许访问本机地址" });
  }
  if (!allowPrivate && net.isIP(host) > 0 && isPrivateOrReservedIp(host) && !(allowLoopback && isLoopbackHost(host))) {
    throw new ErrorWithCode(ERROR_CODES.SSRF_BLOCKED, { message: "不允许访问私有或保留 IP 地址" });
  }
  return url;
}

async function assertSafeHttpUrl(input, options) {
  const url = validateHttpUrl(input, options);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = !!(options && options.allowPrivate);
  const allowLoopback = !!(options && options.allowLoopback);
  if (net.isIP(host) > 0) {
    // literal 目的地永远按保留段拦截（P02 fake-ip 豁免不触及此分支，含 198.18.x 字面量）
    if (!allowPrivate && isPrivateOrReservedIp(host) && !(allowLoopback && isLoopbackHost(host))) {
      throw new ErrorWithCode(ERROR_CODES.SSRF_BLOCKED, { message: "不允许访问私有或保留 IP 地址" });
    }
    return url;
  }
  if (allowLoopback && isLoopbackHost(host)) return url;
  const lookup = (options && options.lookup) || dns.lookup;
  let addresses;
  // DNS 失败 = NETWORK_ERROR（事实来源：lookup 抛错本身，不靠解析文案）
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch (e) {
    throw new ErrorWithCode(ERROR_CODES.NETWORK_ERROR, {
      message: "无法解析服务地址", detail: String((e && e.message) || e)
    });
  }
  if (!addresses || !addresses.length) throw new ErrorWithCode(ERROR_CODES.NETWORK_ERROR, { message: "无法解析服务地址" });
  const loopbackOnly = allowLoopback && addresses.every(({ address }) => isLoopbackHost(address));
  if (!loopbackOnly && addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    // P02 fake-ip 运输令牌豁免：仅 hostname 路径；要求调用方显式 opt-in，
    // 且解析结果【全部】落于已行为证明的合成池 /16（混合/真实私有/探测失败 ⇒ 原样拒绝）
    let fakePool = null;
    if (options && options.allowFakeIpTransport) {
      const attester = options.fakeIpAttester || attestFakeIpTransport;
      try { fakePool = await attester(lookup); } catch { fakePool = null; }
    }
    const allInPool = !!fakePool &&
      addresses.every(({ address }) => net.isIP(address) === 4 && inCidr(address, fakePool));
    if (!allInPool) throw new ErrorWithCode(ERROR_CODES.SSRF_BLOCKED, { message: "服务地址解析到私有或保留 IP 地址" });
  }
  return url;
}

/** 规范化 origin（protocol + hostname 小写 + 有效端口）：默认端口省略（https:443/http:80）、
 *  IPv6 保留方括号、大小写归一；仅比较 origin，故 path/trailing slash/=/v1 差异不影响同源判定
 *  （F-01 credential binding 基元）。无效输入抛 TypeError，调用方按 fail closed 处理。 */
function originOf(input) {
  return new URL(String(input || "")).origin;
}

/** 两个 URL 是否同 origin（规范化后比较）；任一无效视为不同源（fail closed） */
function sameOrigin(a, b) {
  try { return originOf(a) === originOf(b); } catch { return false; }
}

async function safeFetch(input, init = {}, options = {}) {
  let current = String(input || "");
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
  for (let redirects = 0; ; redirects++) {
    const url = await assertSafeHttpUrl(current, options);
    // F-01 凭据绑定（可选）：设置 credentialOrigin 后，任何一跳（含初始请求）落到不同
    // origin 一律拒绝——凭据头从不离开绑定 origin，跨源 302 不再是凭据外发通道。
    // 未设置时行为与旧版完全一致（其他调用方零漂移）。
    if (options.credentialOrigin && originOf(url) !== options.credentialOrigin) {
      throw new ErrorWithCode(ERROR_CODES.SSRF_BLOCKED, { message: "请求被重定向到不同来源，为保护凭据已中断" });
    }
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (!REDIRECT_CODES.has(response.status)) return response;
    if (redirects >= maxRedirects) throw new ErrorWithCode(ERROR_CODES.INTERNAL, { message: "重定向次数超过限制" });
    const location = response.headers.get("location");
    if (!location) throw new ErrorWithCode(ERROR_CODES.BAD_URL, { message: "服务返回了无效重定向" });
    try { current = new URL(location, url).toString(); }
    catch (e) { throw new ErrorWithCode(ERROR_CODES.BAD_URL, { message: "服务返回了无效重定向", detail: String(e.message || e) }); }
  }
}

module.exports = {
  isPrivateOrReservedIp,
  isLoopbackHost,
  parseHttpUrl,
  validateHttpUrl,
  assertSafeHttpUrl,
  safeFetch,
  originOf,
  sameOrigin,
  attestFakeIpTransport,
  resetFakeIpAttestation,
  inCidr
};

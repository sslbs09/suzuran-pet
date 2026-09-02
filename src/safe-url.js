"use strict";

const dns = require("dns").promises;
const net = require("net");

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

function parseHttpUrl(input) {
  let url;
  try { url = new URL(String(input || "")); } catch { throw new Error("URL 格式无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许使用 http 或 https URL");
  }
  if (url.username || url.password) throw new Error("URL 不允许包含用户名或密码");
  if (!url.hostname) throw new Error("URL 缺少主机名");
  return url;
}

function validateHttpUrl(input, { allowLoopback = false, allowPrivate = false } = {}) {
  const url = parseHttpUrl(input);
  const host = url.hostname.toLowerCase();
  if (!allowLoopback && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new Error("不允许访问本机地址");
  }
  if (!allowPrivate && net.isIP(host) > 0 && isPrivateOrReservedIp(host) && !(allowLoopback && isLoopbackHost(host))) {
    throw new Error("不允许访问私有或保留 IP 地址");
  }
  return url;
}

async function assertSafeHttpUrl(input, options) {
  const url = validateHttpUrl(input, options);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = !!(options && options.allowPrivate);
  const allowLoopback = !!(options && options.allowLoopback);
  if (net.isIP(host) > 0) {
    if (!allowPrivate && isPrivateOrReservedIp(host) && !(allowLoopback && isLoopbackHost(host))) {
      throw new Error("不允许访问私有或保留 IP 地址");
    }
    return url;
  }
  if (allowLoopback && isLoopbackHost(host)) return url;
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error("无法解析服务地址"); }
  if (!addresses.length) throw new Error("无法解析服务地址");
  const loopbackOnly = allowLoopback && addresses.every(({ address }) => isLoopbackHost(address));
  if (!loopbackOnly && addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error("服务地址解析到私有或保留 IP 地址");
  }
  return url;
}

async function safeFetch(input, init = {}, options = {}) {
  let current = String(input || "");
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
  for (let redirects = 0; ; redirects++) {
    const url = await assertSafeHttpUrl(current, options);
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (!REDIRECT_CODES.has(response.status)) return response;
    if (redirects >= maxRedirects) throw new Error("重定向次数超过限制");
    const location = response.headers.get("location");
    if (!location) throw new Error("服务返回了无效重定向");
    current = new URL(location, url).toString();
  }
}

module.exports = {
  isPrivateOrReservedIp,
  isLoopbackHost,
  parseHttpUrl,
  validateHttpUrl,
  assertSafeHttpUrl,
  safeFetch
};

"use strict";

const crypto = require("crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function safeTokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenMatches(provided, client) {
  if (!provided || !client || typeof client !== "object") return false;
  if (client.tokenHash) return safeTokenEqual(hashToken(provided), client.tokenHash);
  // Legacy clients are accepted once, then migrated by the caller.
  return client.token ? safeTokenEqual(provided, client.token) : false;
}

function sanitizeClients(clients) {
  return (Array.isArray(clients) ? clients : []).map((client) => {
    const c = client && typeof client === "object" ? client : {};
    const tokenHash = c.tokenHash || (c.token ? hashToken(c.token) : "");
    return {
      name: String(c.name || "").trim().slice(0, 30),
      tokenHash,
      grantedAt: Number(c.grantedAt) || 0,
      lastSeen: Number(c.lastSeen) || 0
    };
  }).filter((c) => c.name && c.tokenHash);
}

module.exports = { hashToken, safeTokenEqual, tokenMatches, sanitizeClients };

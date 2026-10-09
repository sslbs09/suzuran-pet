/**
 * loopback-provider.js — P0-B2 可控真实 loopback provider（任务 §27）
 *
 * 要求逐条满足：
 *  - HTTP 127.0.0.1 真实 socket，OpenAI 兼容 /chat/completions 协议；
 *  - 生产 serializer/parser 走真链路：Body 的 chat-client（chatOpenAI → safeFetch →
 *    readSSE）直接对本服务收发，最终断言在序列化后的 wire body 上；不是 mock chat()。
 *  - 支持模式：success / successSlow / stall（流中途挂起）/ connectionClose /
 *    401 / 429 / 500 / malformedJSON / malformedSSE / empty200（2xx 无内容）/
 *    emptyBodyJson（200 JSON 非 SSE）/ markerOnly（只有格式标注）/
 *    lateAfterCancel（headers 秒回，body 分片拖到取消之后）。
 *  - 无真实 key：Authorization 只回显捕获；响应内容由测试合成。
 */
"use strict";

const http = require("node:http");

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" };

function sseChunk(text) {
  return "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n";
}

function createLoopbackProvider({ reply = "你好博士，今天也要好好休息哦。【情绪：开心】" } = {}) {
  const captured = [];
  let mode = "success";
  let slowMs = 400;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("close", () => { /* 客户端 abort 后仍在等 body 结束的场景由 setTimeout 分支处理 */ });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      captured.push({ url: req.url, auth: req.headers.authorization || "", body });
      const m = mode;
      if (m === "success") {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseChunk(reply));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (m === "successSlow") {
        res.writeHead(200, SSE_HEADERS);
        setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.write(sseChunk(reply));
          res.write("data: [DONE]\n\n");
          res.end();
        }, slowMs);
        return;
      }
      if (m === "lateAfterCancel") {
        // 真实 late-result race：立即给 headers，body 分片在很久之后才发——
        // 客户端早已 abort；若任何实现把这份迟到数据当成功提交，必须能被栅栏测试抓到。
        res.writeHead(200, SSE_HEADERS);
        setTimeout(() => {
          if (res.destroyed || res.writableEnded) return;
          res.write(sseChunk("这是取消之后才到达的迟到回复。【情绪：开心】"));
          res.write("data: [DONE]\n\n");
          res.end();
        }, slowMs);
        return;
      }
      if (m === "stall") {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseChunk("半句"));
        // 不再写、不再 end：SSE 空闲计时器在 Body 侧触发 TIMEOUT
        return;
      }
      if (m === "connectionClose") {
        res.writeHead(200, SSE_HEADERS);
        res.socket && res.socket.destroy(); // 流中断（无有效内容）
        return;
      }
      if (m === "401") { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":{"message":"unauthorized"}}'); return; }
      if (m === "429") { res.writeHead(429, { "Content-Type": "application/json" }); res.end('{"error":{"message":"quota"}}'); return; }
      if (m === "500") { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":{"message":"boom"}}'); return; }
      if (m === "malformedJSON") {
        res.writeHead(200, SSE_HEADERS);
        res.write("data: {not-json-at-all\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (m === "malformedSSE") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('this is not an SSE stream and not even a chat completion response');
        return;
      }
      if (m === "empty200") {
        // §17 强制测试对象：HTTP 成功码 + 没有有效 assistant content
        res.writeHead(200, SSE_HEADERS);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (m === "emptyJsonChoices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ delta: {}, message: { content: "" } }] }));
        return;
      }
      if (m === "markerOnly") {
        // 只有格式标注没有正文：不得算有效回答（§16 empty reply）
        res.writeHead(200, SSE_HEADERS);
        res.write(sseChunk("【情绪：开心】"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (m === "sseErrorFrame") {
        res.writeHead(200, SSE_HEADERS);
        res.write('data: {"error":{"message":"stream exploded"}}\n\n');
        res.end();
        return;
      }
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"unknown mode ' + m + '"}');
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      captured,
      setMode(m, ms) { mode = m; if (typeof ms === "number") slowMs = ms; },
      close: () => new Promise((r) => {
        for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
        server.closeAllConnections?.();
        server.close(r);
      })
    }));
  });
}

module.exports = { createLoopbackProvider };

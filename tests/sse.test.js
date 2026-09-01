/** readSSE 单测（node，mock ReadableStream）——验证 SSE 解析：正常帧/DONE/损坏行/error 帧（优化建议 P1） */
"use strict";
const { readSSE } = require("../src/chat-client");
let failed = 0;
function assert(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}

const enc = new TextEncoder();
function sseStream(chunks) {
  return { body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }) };
}

(async () => {
  // 1) 正常流：多段 delta 拼接 + [DONE] 跳过
  {
    const chunks = [];
    const full = await readSSE(
      sseStream(['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n', "data: [DONE]\n\n"]),
      (d) => chunks.push(d),
      (j) => j?.choices?.[0]?.delta?.content
    );
    assert("正常流拼接", full, "你好");
    assert("onChunk 逐段回调", chunks, ["你", "好"]);
  }

  // 2) 损坏行忽略 + 非 data 行忽略（不中断流）
  {
    const full = await readSSE(
      sseStream(['data: not-json\n\n', "event: ping\n\n", ': comment\n\n', 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n']),
      () => {},
      (j) => j?.choices?.[0]?.delta?.content
    );
    assert("损坏行/非 data 行被忽略且流不中断", full, "x");
  }

  // 3) error 帧抛出（优化建议 P1：不再静默吞掉）——流被中断并带错误信息
  {
    let threw = null;
    try {
      await readSSE(
        sseStream(['data: {"error":{"message":"rate limit"}}\n\n', 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n']),
        () => {},
        (j) => j?.choices?.[0]?.delta?.content
      );
    } catch (e) { threw = e; }
    assert("error 帧抛出", !!threw, true);
    assert("error 信息含内容", threw ? threw.message.includes("rate limit") : false, true);
  }

  // 4) 分块跨行边界：data 行被切成两段仍能正确解析（流式网络包常见）
  {
    const full = await readSSE(
      sseStream(['data: {"choices":[{"delta":{"co', 'ntent":"好"}}]}\n\n']),
      () => {},
      (j) => j?.choices?.[0]?.delta?.content
    );
    assert("跨块数据正确解析", full, "好");
  }

  console.log(failed ? `\n${failed} 项失败` : "\nreadSSE 全部通过 ✅");
  process.exit(failed ? 1 : 0);
})();

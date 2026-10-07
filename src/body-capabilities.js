"use strict";

/**
 * body-capabilities.js — M2 Body 能力真实声明（protocolVersion 1）。
 *
 * 诚实原则（§6）：这里只声明当前 Sussurro 实现真实具备的能力——
 *   - speak  feedbackMode = "ack-only"：POST /actions(speak) 经 sendProactive 把台词
 *     交给内部说话路径（气泡/TTS/情绪），投递即返回；渲染端的播放完成信号
 *     （audio.onended 等）只在 renderer 内部消费，从不回流到主进程，主进程也从不
 *     向 Host 报告完成。因此 Body 能证明的只有「已受理并投递」，永远不是「已播完」。
 *     不得为了协议好看而伪造 completed。
 *   - speak  interruptible = false：主进程对正在播出的台词没有任何 per-utterance
 *     停止通道（renderer 的 stopTts 不接 IPC/HTTP），因此当前 speak 没有真实可
 *     中断 lifecycle。如实声明 false；协议支持 interrupt 不代表这个 Body 必须假装支持。
 *   - speak  idempotency = "supported"：intentId 级动作幂等由 action-idempotency
 *     存储真实提供（运行期有界窗口）。
 *
 * 身份边界（§5）：bodyImplementationId 是 Body 实现的身份（这个桌面宠物程序），
 * 不是 Character 身份、不是 Character Instance 身份；角色语义绝不进入 capability。
 */

const PROTOCOL_VERSION = 1;

/** Body 实现标识：程序+集成面版本，与 Character/Instance 无关。 */
const BODY_IMPLEMENTATION_ID = "suzuran-desktop-agent-v0.1";

function buildBodyCapabilities() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    bodyImplementationId: BODY_IMPLEMENTATION_ID,
    supportedActions: [
      {
        type: "speak",
        feedbackMode: "ack-only",
        interruptible: false,
        idempotency: "supported"
      }
    ]
  };
}

/** 按 actionType 查询声明的动作能力；未声明 → undefined（诚实的 unsupported 依据）。 */
function findSupportedAction(capabilities, actionType) {
  return capabilities.supportedActions.find((action) => action.type === actionType);
}

module.exports = { PROTOCOL_VERSION, BODY_IMPLEMENTATION_ID, buildBodyCapabilities, findSupportedAction };

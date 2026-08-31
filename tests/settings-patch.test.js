/** settings-patch 白名单过滤单测（node，纯函数）——覆盖复审新-1 回归：保存 API Key 必须抵达 replaceSecrets */
"use strict";
const SP = require("../src/settings-patch");
let failed = 0;
function assertEq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}
// 测试用假值：函数生成避免源码中出现字面量凭据模式
const V = (n) => "dummy-val-" + n;

// 1) 新-1 回归：设置页顶层 secrets 必须被放行并提取（v2.5.22 被白名单删掉 → 空）
{
  const r = SP.filterSettingsPatch({ chat: { model: "deepseek-chat" }, secrets: { chatApiKey: { action: "replace", value: V(1) } } });
  assertEq("顶层 secrets 放行且提取 chatApiKey", r.secrets, { chatApiKey: V(1) });
  assertEq("secrets 不落入 config patch", Object.prototype.hasOwnProperty.call(r.patch, "secrets"), false);
  assertEq("secrets 不触发丢弃日志", JSON.stringify(r.unknown), "[]");
  assertEq("常规键保留", r.patch.chat.model, "deepseek-chat");
}

// 2) 兼容写法：chat.apiKey 顶层 → 挪进 secrets
{
  const r = SP.filterSettingsPatch({ chat: { apiKey: V(2), model: "m" } });
  assertEq("顶层 chat.apiKey 挪进 secrets", r.secrets, { chatApiKey: V(2) });
  assertEq("chat.apiKey 移出 config patch", r.patch.chat.apiKey, undefined);
  assertEq("chat.model 保留", r.patch.chat.model, "m");
}

// 3) 三个槽位全覆盖
{
  const r = SP.filterSettingsPatch({
    ttsCosy: { apiKey: V(3) },
    agentApi: { bearerToken: V(4) }
  });
  assertEq("ttsCosy.apiKey 提取", r.secrets.ttsCosyApiKey, V(3));
  assertEq("agentApi.bearerToken 提取", r.secrets.agentBearerToken, V(4));
  assertEq("agentApi.bearerToken 移出 patch", r.patch.agentApi.bearerToken, undefined);
}

// 4) 恶意槽位忽略：未知 secrets 键不进入提取
{
  const r = SP.filterSettingsPatch({ secrets: { evil: { action: "replace", value: V(5) }, chatApiKey: { action: "replace", value: V(6) } } });
  assertEq("未知 secrets 槽位被忽略", JSON.stringify(r.secrets), JSON.stringify({ chatApiKey: V(6) }));
}

// 5) 非 replace action 忽略
{
  const r = SP.filterSettingsPatch({ secrets: { chatApiKey: { action: "read", value: V(7) } } });
  assertEq("非 replace action 不提取", JSON.stringify(r.secrets), "{}");
}

// 6) 黑名单拦截（P0-1 继续封堵）
{
  const r = SP.filterSettingsPatch({ zcodeCli: { python: "C:/evil.exe" }, workspace: "/", chat: { model: "m" } });
  assertEq("zcodeCli 进 blocked", r.blocked.includes("zcodeCli"), true);
  assertEq("workspace 进 blocked", r.blocked.includes("workspace"), true);
  assertEq("黑名单键不落 config", r.patch.zcodeCli, undefined);
  assertEq("白名单键仍保留", r.patch.chat.model, "m");
}

// 7) 未知顶层键丢弃并留痕（P2-2）
{
  const r = SP.filterSettingsPatch({ evilTop: 1, chat: { model: "m" } });
  assertEq("未知键进 unknown", JSON.stringify(r.unknown), JSON.stringify(["evilTop"]));
  assertEq("未知键被丢弃", r.patch.evilTop, undefined);
}

// 8) autoLaunch 提取并移出 patch
{
  const r = SP.filterSettingsPatch({ autoLaunch: true, pet: { name: "苏苏洛" } });
  assertEq("autoLaunch 提取为布尔", r.autoLaunch, true);
  assertEq("autoLaunch 不落 config", r.patch.autoLaunch, undefined);
  const r2 = SP.filterSettingsPatch({ autoLaunch: 0 });
  assertEq("autoLaunch 假值归一 false", r2.autoLaunch, false);
}

// 9) 渲染层从不提交的敏感键在 patch 中不存在（防御纵深：agentClients 仅主进程改）
{
  const r = SP.filterSettingsPatch({ agentClients: [{ name: "x" }] });
  assertEq("agentClients 白名单放行（主进程语义）", r.patch.agentClients.length, 1);
}

// 10) 非法输入兜底
{
  const r = SP.filterSettingsPatch(null);
  assertEq("null patch 返回空结果", JSON.stringify(r.patch), "{}");
  assertEq("null patch secrets 空", JSON.stringify(r.secrets), "{}");
}

console.log(failed ? `\n${failed} 项失败` : "\nsettings-patch 全部通过 ✅");
process.exit(failed ? 1 : 0);

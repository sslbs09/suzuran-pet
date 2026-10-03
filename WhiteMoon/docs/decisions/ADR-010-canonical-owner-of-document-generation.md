# ADR-010 — Canonical owner of document generation

**CONFIRMED · 文档元数据**：编号 D-010，2026-10-03，状态解释见 [README](../../README.md)。本文件是一份所有权裁决，不记录代码提交，也不声明迁移已完成。

## CONFIRMED — Context

跨文档代次（doc epoch）当前存在 **7 个平行机制**：

| # | 机制 | 角色 | 现状 |
| --- | --- | --- | --- |
| 1 | `renderModeSeq` | 代次源头（单调计数器） | 生产在用；同时混装渲染模式 intent 的 seq |
| 2 | `groundGapDocFloor` | ground-gap 上报的跨文档拒收下限 | 生产在用，3 处提升点 |
| 3 | `drag-session.docEpoch` | 拖拽会话跨文档存活判定 | 生产在用 |
| 4 | `locomotion-controller.bodyIdentity.docEpoch` | locomotion episode 身份 | 生产在用 |
| 5 | `runtime-shadow/geometry-snapshot` | shadow 几何证据身份 | shadow 局部 |
| 6 | `runtime-shadow/body-evidence` | shadow body 身份 | shadow 局部 |
| 7 | `state-core/lifecycle-projection` | State Core 代次账本 | **仅 `invalidate()` 有 2 个生产调用者；`begin()` / `isCurrent()` 零生产调用者** |

第 7 项的两个调用点（`renderer crash` / `pet:reload-renderer`）都是**纯宿主事件**。

## CONFIRMED — 因果分析：这是 Electron 实现细节，不是角色语义

doc epoch 的产生者全部是 Electron API：`beginRenderModeIntent`、`webContents.reload()`、`render-process-gone`、`loadFile`。

其消费者的判据是「旧文档的迟到包不得为新窗建立基准」——**只在 Electron 宿主编排下有意义**。

renderer 侧对该概念的描述也确认了它的宿主性质：`跨 reload 单调增、文档生命周期内恒定`。

**因此：Character / WhiteMoon 语义内核不得知道 Electron document epoch。** 若由 State Core 持有该概念，将构成架构污染——角色运行时不需要查询「Chromium 文档换了几代」，且这会迫使未来的 Character Context 从角色状态权威处读取一个宿主实现概念来给事件打时间戳。

## CONFIRMED — Decision

新增宿主层 **DocumentGenerationAuthority** 作为 document generation 的唯一权威。

**DocumentGenerationAuthority OWNS ONLY：**

- Electron renderer document epoch / generation
- reload / recovery / new-document 的代次边界

**DocumentGenerationAuthority does NOT own：**

| 不拥有 | 归属 |
| --- | --- |
| **body instance generation**（body / skin replacement 换代身份） | **单独、未决的 body lifecycle 域**——见下方「域边界」 |
| drag session token | drag session（局部） |
| locomotion attemptId | LocomotionController（局部） |
| animation request generation | renderer（局部） |
| runtime-shadow sourceSeq / receiveOrder / causeRef | runtime-shadow 观测纪律（局部） |

### CONFIRMED — Character / WhiteMoon Core 不得知道 Electron document epoch

这是本 ADR 的核心边界。理由三条：

1. **无角色语义。** 它回答「这是不是最新的 renderer document」，不回答「角色处于什么状态」。
2. **失效原因 100% 是宿主事件。** Character Runtime 没有任何一条语义与之对应。
3. **会污染未来接口设计。** 见 Context 末段。

### CONFIRMED — 域边界：body generation 不归本 ADR，也不归 BodyStateAuthority

**document generation 与 body instance generation 边界不等价，不可合并**：document 换代必然 body 换代，反之不然（renderer reload 不换 skin）。

本 ADR **不发明** BodyLifecycleAuthority 或 BodyGenerationAuthority，只记录边界：该域**当前未决（unresolved）**，保持独立。相关地，[ADR-009](ADR-009-canonical-owner-of-posture-and-support.md) 已明确 BodyStateAuthority **消费但不拥有** body generation。

### CONFIRMED — lifecycle-projection.js 的最终归宿

该模块同时持有 `docEpoch`（宿主细节）与 `bodyGeneration`（身体换代身份）——两个不同因果域被塞进同一个 `generation` 对象。

| 部分 | 归宿 |
| --- | --- |
| `docEpoch` 部分 | 迁往 DocumentGenerationAuthority |
| `bodyGeneration` 部分 | **不归 BodyStateAuthority**；保持独立，作为未决 body lifecycle 域记录 |
| `isCurrent()` 的「代际未知时不妄拒」宽容语义 | **保留**到新 authority |

`invalidate()` 作为通用动词掩盖了「谁有权推进代际」这一从未被回答的问题；本 ADR 不沿用该抽象。

## CONFIRMED — Rejected alternatives

| 候选 | 拒绝理由 |
| --- | --- |
| STATE_CORE（原样接线 lifecycle-projection） | 架构污染，见 Context 与核心边界两节 |
| BODY_LIFECYCLE 统一收编 document | 边界不等价：document 换代必然 body 换代，反之不然 |
| RENDERER_LIFECYCLE | 过宽，会吞并 animation request generation（边界不同） |
| renderModeSeq 直接沿用为权威 | 同时承载渲染模式 intent 的 seq，语义混装，需先拆分 |

## CONFIRMED — Migration rule

1. **G0** 拆分搬移（不改任何行为）
2. **G1** `groundGapDocFloor` 改为读取 DocumentGenerationAuthority（**真机派生文本锁暂不解除**）
3. **G2** `drag-session` / `locomotion-controller` 的 docEpoch 改读同一 authority
4. **G3** `lifecycle-projection.js` 的 docEpoch 半边迁出
5. **G4** 退役真机派生文本锁——**唯一不可回滚的一步**，须在真机 crash-recovery + reload + body-switch 三连 PASS 之后执行

每步独立可回滚。局部 generation 保持独立，不纳入本 ADR。

## CONFIRMED — Consequences

正向：document generation 有唯一权威；ground-gap / drag / locomotion 三处迟到包防护共用同一判据；State Core 剥离宿主实现细节。

代价：跨模块移动一个计数器；drag-session 与 locomotion-controller 增加一次依赖；`groundGapDocFloor` 的文本锁最终必须退役（作为最后一步）。

## NON-GOALS

不统一所有异步 token；不改 Motion Authority 的 ownership token；不改 runtime-shadow 的观测纪律；不改 P5 chat ownership 的 lease token；不定义 body generation 的所有者；不涉及 DSH 集成。

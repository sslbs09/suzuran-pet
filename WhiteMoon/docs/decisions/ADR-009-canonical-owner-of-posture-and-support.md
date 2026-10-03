# ADR-009 — Canonical owner of posture and support

**CONFIRMED · 文档元数据**：编号 D-009，2026-10-03，状态解释见 [README](../../README.md)。本文件是一份所有权裁决，不记录代码提交，也不声明迁移已完成。

## CONFIRMED — Context

posture 相关状态（`seated` / `perched` / `resting` / `sunk` / `standingUpUntil` 等）当前由 legacy walk 对象持有。实测规模：`main.js` 中 posture 家族字段共 **139 处写入、分布在 132 个不同行号**，横跨 15 个以上函数。

因果分析（按产生原因分类，而非按代码位置）：

| 变量 | 因果类别 | 真实语义 |
| --- | --- | --- |
| `resting` | 决策/策略状态 | 「true=原地（Relax/Sit）false=走动（Move）」——**动画选择轴**，由相位机产出 |
| `seated` | 身体物理状态 + 渲染契约 | 坐下且 Sit 动画期间窗口不可移动（否则「坐着滑行」） |
| `perched` | 身体物理状态 | 坐在窗口顶上的位置事实 |
| `sunk` | 派生 | 恒等派生自 `seated` |
| `standingUpUntil` | 过渡计时器 | 墙钟截止，由 7 处不同原因清零 |
| `gotoPerch` / `returning` / `iconTarget` / `freeStand` | locomotion 状态 | 移动意图，非姿态 |
| `taskbarHang` | 交互派生 | drag 与 pause 共同产生的半挂态 |

因果交汇点有三个且彼此正交：**① 相位机决策、② 物理与身体能力、③ 支撑面**。其中身体能力是一道真实门：`enterRestPose()` 中 `skinHasSit` 为假时，身体只能站立休息、不得进入坐姿——**姿态可达性由身体能力决定，不由 locomotion 决定**。

既有 `src/state-core/posture-support.js` 只有一个生产输入 `observeWalk()`（由 main 调用），`setPosture()` **零生产调用者**。即 State Core 目前只是 legacy walk 的下游镜像。

## CONFIRMED — Decision

新增独立的 **BodyStateAuthority** 作为 posture / support 的唯一权威，位于 State Core 与 LocomotionController 之外。

**BodyStateAuthority OWNS：**

- 物理姿态（physical posture）
- 支撑关系（support relation）
- 支撑证据有效性（support evidence validity）

**BodyStateAuthority CONSUMES：**

- `BodyCapabilities`（如 `canSit`）——能力值用于判定 `enterRest` 后落在 seated 还是 standing。**能力的所有者不在本 ADR 范围内**
- 外部提供的 body generation / 证据代数——仅作为**输入**用于支撑证据失效，**不推进、不拥有**

**BodyStateAuthority does NOT own：**

| 不拥有 | 归属 |
| --- | --- |
| `resting` / idle 策略 | 相位机（`behaviorOf` / `sitPhaseMs` / `walkPhaseMs`） |
| locomotion phase / episode | LocomotionController |
| x/y 位置写入权 | MotionAuthority（已冻结，具 no-bypass 证据） |
| animation choice | renderer 侧动画选择逻辑 |
| **body instance generation**（body replacement / skin replacement 换代身份） | **单独、未决的 body lifecycle 域**，见 [ADR-010](ADR-010-canonical-owner-of-document-generation.md) 的边界说明 |

**State Core：** 可以观察 posture / support read model，但**不是** posture 权威。

### CONFIRMED — 明确排除 `resting`

`resting` 是决策/策略状态（动画选择轴），不是身体物理状态。把它并入 BodyStateAuthority 会让 body authority 吞并相位机策略，违反「不制造中央 mega-controller」。BodyStateAuthority 暴露 `enterRest()` / `enterPerched()` / `leaveSupport()` 这类**结果声明式**接口，由调用方（相位机、落地、drag）决定何时调用。

### CONFIRMED — 明确排除 `bodyGeneration`

**body physical state ≠ body instance generation。** 二者不是同一个 ownership domain：

- physical state：身体此刻是什么姿态、靠什么支撑
- instance generation：当前是第几代 renderer / body instance，换代身份

BodyStateAuthority **可以消费** body generation 证据来使支撑证据失效，但**不得拥有**它。本 ADR 不创建 BodyLifecycleAuthority，也不指定 body generation 的所有者——该域标记为 **unresolved / separate**。

## CONFIRMED — posture-support.js 的处境

`src/state-core/posture-support.js`：

- **`setPosture()` 判定为错误 abstraction**——它要求调用方先算出 posture 字符串，而算出 posture 所需的上下文只有 legacy walk 持有。强行接线只会制造一个没有决策能力的记录器。**本轮不删除**，标记为待迁移后移除。
- `SUPPORT_KINDS`（taskbar / icon / window-top / none / unknown）是真正独立于 walk 的领域知识，**保留并前移**到 BodyStateAuthority。
- `support.generation` / `anchorStatus` / `invalidateSupport()` 表达的「姿态语义仍在、支撑证据已过期」建模**质量很高，予以保留**。
- `POSTURES` 枚举需要重定义：现有值把物理（airborne ← flight/jump）与移动意图（transition ← gotoPerch/returning）混入了语义姿态。
- `observeWalk()` 保留为 read model 输入，但方向标注改为「BodyStateAuthority → State Core」，不再是「legacy → State Core」。

## CONFIRMED — Migration rule

**shadow-first → 按函数逐个迁移 → 真机验证后方可退役旧 writer。**

1. **Shadow**：BodyStateAuthority 只观察不写入，与 legacy 派生值比对并记录 divergence（复用仓库既有的 gate + 有界台账模式）。零行为影响。
2. **逐函数迁移**：迁移单位是**函数**（`enterRestPose` → landing → perch → startup → drag → seatExit），不是字段。每步独立可回滚。
3. **退役条件**：每一步都需真机行为证据，才允许删除该处旧 writer。任一阶段真机回归即回滚该阶段，不前进。

**禁止**：一次性改写全部 139 处写入；为「让已有 API 有生产调用者」而接线 `setPosture()`；在真机证据到位前解除任何真机派生的文本锁。

## CONFIRMED — Rejected alternatives

| 候选 | 拒绝理由 |
| --- | --- |
| STATE_CORE | `POSTURES` 已把物理与移动意图混入语义姿态，继续膨胀即 mega-controller；且 State Core 的既定边界是角色语义，不是运行时物理 |
| LOCOMOTION | 不覆盖 drag 接管、sleeping、`skinHasSit` 能力门；V1/V2 双路径并存 |
| LEGACY_WALK_EVOLVED | walk 是 30 字段混合袋（决策 + 物理 + 投影 + 计时器），无法演进为清晰 authority；但它是迁移起点与影子比对基准 |

## CONFIRMED — Consequences

正向：posture 有了单一权威；支撑证据代数的建模得以保留；State Core 边界回到角色语义；renderer 只消费 projection。

代价：需新建模块；迁移期 walk 与 BodyStateAuthority 并存，必须靠 divergence 计数保证一致；`setPosture()` 的移除要等迁移完成。

## NON-GOALS

不改 Motion Authority 的位置 ownership；不重构相位机决策；不改 renderer 动画选择；不处理 sleep 语义；不涉及 Emotion / Relationship / Memory；不定义 body generation 的所有者；不涉及 DSH 集成。

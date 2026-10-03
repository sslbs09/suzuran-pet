# WhiteMoon Foundation v0.1

**CONFIRMED · 文档元数据**：版本 v0.1；建立日期 2026-09-27；当前为研究基础文档，未进入 Runtime 实现。

## CONFIRMED — 项目定位与目录边界

WhiteMoon = Character Runtime research project。苏苏洛被选为第一个 Character Package 的建设对象和第一个验证案例；这不表示该 Package 已完成，也不表示苏苏洛就是 WhiteMoon。

本目录临时位于 `suzuran-pet`，用于保留第一轮实验的来源与项目讨论上下文。当前不新建独立仓库，不迁往 NEATB-first-light。未来成熟后计划迁移为独立 Character-Runtime 项目；迁移的 UNKNOWN 项见文末。

苏苏洛桌宠 v1 的具体缺陷、代码解释、提交记录、渲染与动画实现属于 **Sussurro Desktop Runtime v1**。它们可以成为研究输入，但不构成 WhiteMoon 的核心定义。本目录不包含 production code 或 Runtime implementation。

## CONFIRMED — 状态标签与证据规则

以下规则适用于全部文档。带状态的章节标题覆盖本节正文，直到下一标题；混合状态表格逐行标注。文件名、版本、链接属于文档元数据。

| 标签 | 含义 | 使用限制 |
| --- | --- | --- |
| CONFIRMED | 已明确的范围决定、可核对事实，或注明来源的已有记录 | 必须说明类型；“决定如此做”不等于“机制有效”，“历史报告”不等于本次实测 |
| HYPOTHESIS | 待检验解释、候选机制、建议实验或路线 | 不能作为已决定架构；需连接研究问题或失败标准 |
| UNKNOWN | 未确定、证据不足或本轮没有核验的事项 | 不能以默认值、未来愿景或模型推断补成事实 |

本轮依据：2026-09-27 会话中的《WhiteMoon Direction Reassessment》及随后建立本目录的用户要求。前者提供候选方向，后者明确本轮边界；没有明确采纳的建议继续标为 HYPOTHESIS。此前研究记录只作历史背景，不替代当前实现核验。

## CONFIRMED — 文档导航

| 文件 | 用途 |
| --- | --- |
| [方向](docs/direction/WhiteMoon-Direction-v0.1.md) | 项目是什么、不是什么；已知输入、候选主线和未决价值 |
| [研究问题](docs/research/Research-Questions.md) | 当前问题、先例范围和答案缺口 |
| [实验框架](docs/research/Experiment-Framework.md) | 候选对照、扰动、记录与评价方式 |
| [失败标准](docs/research/Failure-Criteria.md) | 怎样识别假设失败、实验无效和应当收缩的范围 |
| [运行原则](docs/architecture/Runtime-Principles-v0.1.md) | 范围约束与候选职责边界；不是冻结的模块设计 |
| [决策记录](docs/decisions/Decision-Log.md) | 明确决定、候选决策和未决项的来源 |
| [ADR-009 · posture 与 support 的 canonical owner](docs/decisions/ADR-009-canonical-owner-of-posture-and-support.md) | BodyStateAuthority 拥有物理姿态 / 支撑关系 / 支撑证据有效性；不含 resting 策略与 body generation |
| [ADR-010 · document generation 的 canonical owner](docs/decisions/ADR-010-canonical-owner-of-document-generation.md) | 宿主层 DocumentGenerationAuthority；Character 语义内核不得知道 Electron document epoch |

## CONFIRMED — 当前冻结范围

仅冻结项目定位、苏苏洛的验证角色地位、临时存放位置、文档与 production code 的边界，以及上述状态标记规则。Identity、Memory、Attention、Relationship 等不是已冻结模块；具体机制、接口、存储和运行方式均未确定。

## HYPOTHESIS — 候选主问题

角色过去真实发生的经历，是否能够持续影响之后的行为；这种影响能否跨越中断、重启和模型更换，并被用户感受到、愿意保留？该主问题的优先级是建议，不代表已经启动实验。

## CONFIRMED — 后续迁移时的保留要求

迁移应保留本组文档、版本与状态标签、决策及其来源、研究问题编号、实验条件与负面结果，以及第一验证案例源于苏苏洛桌宠 v1 的历史关系。届时已有的角色实例数据与可迁移资产也须明确来源、版本和适用范围；不得把尚不存在的资产记为已完成。

研究结论应保留可追溯的历史证据引用；v1 实现材料仍与核心定义分开存放。迁移时检查相对链接并记录新旧位置，不能因独立建仓而删除不支持假设的结果。

## UNKNOWN — 独立项目的成立条件

尚未确定迁移时间、包格式、公共接口、通用性验收标准、目标用户规模或论文贡献。本目录的建立不证明这些问题已经解决。

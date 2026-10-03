# Decision Log v0.1

**CONFIRMED · 文档元数据**：2026-09-27，v0.1；状态解释见 [README](../../README.md)。本记录区分范围决定与候选建议，不记录代码提交。

## CONFIRMED — 来源与记录规则

- S1：本会话《WhiteMoon Direction Reassessment》任务中的用户定位与边界要求。
- S2：随后完成的方向评估答复；其中建议不因被写入文档而自动获采纳。
- S3：本会话建立 `WhiteMoon/` 临时研究基础目录的用户要求。
- S4：2026-10 P4R 所有权裁决阶段的实测与因果分析（posture 写入面测绘、doc epoch 平行机制测绘）；经用户批准后形成 ADR-009 / ADR-010。

下表的 CONFIRMED 表示用户已明确的决定，不表示研究机制已验证。未来改动应保留原条目的日期、内容、来源与替代关系，不静默覆盖历史；替代关系不是第四种证据标签。

## CONFIRMED — 当前决定

| 编号 | 日期 | 决定 | 来源 |
| --- | --- | --- | --- |
| D-001 | 2026-09-27 | WhiteMoon 定位为 Character Runtime research project | S1、S3 |
| D-002 | 2026-09-27 | 苏苏洛是第一份 Character Package 的建设对象与第一验证案例，不是 WhiteMoon 本体；不宣称 Package 已完成 | S1、S3 |
| D-003 | 2026-09-27 | 当前基础文档位于 `suzuran-pet/WhiteMoon/`，不另建仓库，不迁往 NEATB-first-light | S3 |
| D-004 | 2026-09-27 | v1 实现与修复材料同 WhiteMoon 核心定义分开；本轮不改 production code、不做 Runtime implementation、不 commit | S3 |
| D-005 | 2026-09-27 | 基础文档保持 v0.1；内容区分 CONFIRMED、HYPOTHESIS、UNKNOWN | S3 |
| D-006 | 2026-09-27 | 不提前冻结 Identity、Memory、Attention、Relationship 等模块及具体架构 | S3 |
| D-007 | 2026-09-27 | 保留实验来源与历史上下文；成熟后计划迁移至独立 Character-Runtime 项目 | S3；成熟条件与时间 UNKNOWN |
| D-008 | 2026-09-27 | 长期方向不绑定单一身体，不假设 AI 图像可以直接成为最终角色资产 | S1 |
| D-009 | 2026-10-03 | posture / support 的 canonical owner 是 BodyStateAuthority；不含 resting/idle 策略、locomotion phase、x/y 位置、animation choice、body instance generation。见 [ADR-009](ADR-009-canonical-owner-of-posture-and-support.md) | S4 |
| D-010 | 2026-10-03 | document generation 的 canonical owner 是宿主层 DocumentGenerationAuthority；Character 语义内核不得知道 Electron document epoch；body instance generation 为独立未决域。见 [ADR-010](ADR-010-canonical-owner-of-document-generation.md) | S4 |

## HYPOTHESIS — 候选决策，尚未批准为执行计划

| 编号 | 候选方向 | 来源与验证依据 |
| --- | --- | --- |
| P-001 | 优先验证过去经历对后续行为的执行效力 | S2；[RQ-01](../research/Research-Questions.md) |
| P-002 | 使用描述／约束对照，并加入简单规则参照 | S2；[实验框架](../research/Experiment-Framework.md) |
| P-003 | 首轮使用一个小型共同活动与低成本表现，后续再验证第二角色和第二身体 | S2；依据[失败标准](../research/Failure-Criteria.md)决定是否扩展 |
| P-004 | 采用 Package、Instance、行为、身体适配与宿主的候选职责区分 | S2；[运行原则](../architecture/Runtime-Principles-v0.1.md)，不等于模块划分 |

## UNKNOWN — 待决定事项

- 是否启动首轮实验，以及具体场景、资源预算和实施时间。
- 主要指标、成功与失败阈值、参与者及观察周期。
- Runtime 具体架构、数据表示、包格式和接口。
- 哪些资产与实例数据将进入独立项目，以及迁移验收标准。
- 个人作品、通用工具或论文哪个优先，以及任何公开发布计划。
- body instance generation（body / skin replacement 换代身份）的 canonical owner——ADR-009 已明确排除 BodyStateAuthority，ADR-010 已明确排除 DocumentGenerationAuthority，该域保持独立且**未决**。

## CONFIRMED — 当前冻结内容的限度

冻结的是 D-001 至 D-010 的项目定位、工作边界与所有权裁决。D-009 / D-010 只决定「谁拥有」，**不表示迁移已完成**，也不表示对应机制已被验证。P-001 至 P-004 仍是候选；UNKNOWN 条目不得在实现或迁移时自动转为决定。后续范围改变需要明确记录，不以讨论中的愿景代替决策。

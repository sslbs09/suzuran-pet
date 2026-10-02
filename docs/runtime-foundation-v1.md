# Runtime Foundation v1

> 冻结记录（RELEASE/FREEZE，非研究报告）｜ 2026-10-03 ｜ branch `runtime-v2-state-core-cutover-v0.1`

Frozen baseline: `0b1f48e`

Motion Substrate: FROZEN

State Core: REAL-MACHINE PASS

## Canonical components

- MotionAuthority（LEGACY / V2_LOCOMOTION / EXTERNAL_DRAG / NONE；acquire 顺序 pause→motion；revokeByDomain）
- WindowCommit（单一位移写入点；commitExternal 裸写器；host rect 仅 needHostRect 时）
- PauseAuthority（per-source lease：drag/chat/zoom/interaction；leaseId/token 匹配释放；revokeByDomain）
- InteractionState（renderer 手势分类：candidate→threshold→admit；tap=body-local）
- PostureSupport（posture ⊥ support 证据有效性；adapter 单向写入）
- LifecycleProjection（单调 docEpoch/bodyGeneration + 有界失效台账 + isCurrent）

## Interaction boundary

renderer = gesture / pointer candidate
main = accepted interaction session / resource leases

## PostureSupport

CANONICAL TARGET

## State Resolver

NOT ADDED

合法 head-pat：body-local interaction——不 acquire Motion，不要求暂停 locomotion。

## Real-machine acceptance

- Sit→StandUp→Walk→Sit PASS
- Drag PASS
- Legal head-pat PASS（e1094cc：hover/pointer contact 不再 admission 成 head-pat）
- no-button hover regression PASS
- Walk+Chat consecutive requests PASS（0b1f48e：chat busy-owner leak + buffer-refire storm 修复）
- Renderer recovery PASS（render-process-gone → reload 自动恢复，无 transient interaction/chat-pause/drag 残留）

## Known frozen debt（不阻塞 Foundation v1）

- walking frame feel（丢帧感；gate OFF 同样存在）
- scale/taskbar support geometry（scale 后 support/anchor 错位）
- Sit Q-bounce（V1 baseline）
- Flight / Jump / Perch / CatToy migration（不迁）

## 未完成事项（明确不是本阶段成果）

WhiteMoon Experience Continuity 尚未实现——本记录只覆盖 Motion Substrate + State Core 运行时基座。

## Next planned stage

Global i18n / localization architecture + Korean adaptation

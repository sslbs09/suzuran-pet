# Runtime Foundation v1

> Foundation M1 closure record, 2026-10-07. Default canonical authority, all 995 automated regressions, real Electron observation and **USER-CONFIRMED REAL-MOUSE ACCEPTANCE — PASS** satisfy the implementation and acceptance gates. The milestone commit and final four-repository Git state are recorded in the companion report.

M1 baseline: branch `runtime-i18n-main-native-v0.1`, commit `319412a24ab59d642ad822c98ec2386580fd44a6`.

The previous record at `0b1f48e` described a configured real-machine run. It did not prove that the default production path owned every Body domain: Runtime V2 was opt-in, PostureSupport was observational, and document lifecycle wiring was incomplete. Its unconditional Foundation PASS wording is superseded by this record.

## Production gate

The production default uses the existing Runtime V2 / State Core composition. A deliberate `SUSSURRO_RUNTIME_V2_LOCOMOTION=0` is a legacy compatibility override, not evidence for the default canonical contract. Shadow diagnostics and experimental observers remain opt-in.

Default-path evidence must run without any `SUSSURRO_RUNTIME_V2_*` override. Changing documentation while keeping the default canonical path disabled cannot satisfy M1.

## Canonical owners

| Domain | Owner | Execution / projection boundary |
|---|---|---|
| Locomotion position admission | MotionAuthority | Existing V1/V2 motion policy and trajectories execute under its current owner. |
| Native position write | WindowCommit | Legacy, V2 and admitted external drag share admission and the commit kernel. BrowserWindow construction sets initial bounds. |
| Drag / chat / zoom pause | PauseAuthority | Normal release must match the acquired lease. Explicit main teardown and watchdog revocation have named reasons. `walk.*Paused` is a projection. |
| Accepted interaction | InteractionState | Renderer classifies pointer candidates; main admits the interaction and associated resource leases. |
| Posture / intended support | PostureSupport | Main sends pose commands, then copies compatibility flags to `walk`. `walkBroadcast()` does not infer canonical posture. |
| Sleep | Main sleep admission | Main owns sleeping truth and the automatic-wake deadline. Renderer idle timing and user input request a change; mood and animation project the accepted state. |
| Chat task / busy | Existing conversation and external-chat ownership | Main pause release and renderer completion must match the current task/lease. Mode switch preserves main-owned active chat. |
| Render mode | Existing main render-mode intent / renderer visual owner | `renderModeSeq`, renderer generation and document identity remain distinct guards. |
| Body document / readiness | LifecycleProjection | Create, navigation, reload, crash, close and recreate advance or invalidate identity; the committed usable visual owner reports readiness. |

`LEGACY` in MotionAuthority names the preserved motion executor; it is not permission to bypass WindowCommit or canonical semantic owners.

## Body document boundary

Preload captures one private identity for its document during bootstrap. Body mutations carry that identity. Main checks the current pet webContents, current main frame, and exact current document/body identity before admission. Missing, old or future identities cannot change current Body truth.

Initialization metadata and usable visual readiness are separate. A render-mode switch does not turn its mode sequence into a document epoch. A replacement document cannot inherit the prior document's transient renderer leases. Main chat ownership follows its own lifetime.

The static ownership registry and its contract tests describe these owners and protect key writers against obvious drift. They are verification input; they do not register or drive production authorities.

## Sleep and posture

Standing, seated, airborne and transition remain the existing posture vocabulary. Sleep and pause are orthogonal domains. Flight, jump and perch retain their existing executor data and trajectories; their posture changes pass through PostureSupport.

Accepted sleep uses the existing standing sleep behavior. Elevated-support admission follows the existing return-to-ground rule. Renderer idle timing requests sleep, user interaction requests wake, and main owns automatic wake. A rejected or stale sleep request cannot make renderer mood establish a second truth.

## Verification

Required automated evidence: default-production T1–T12, static registry drift protection, the existing Motion Substrate tests, and the full Body test command. Required machine evidence: actual startup, idle/walk, drag/release, chat busy/completion, sit/stand, sleep/user wake, render-mode switch, renderer recovery, and walk/drag/chat after recovery.

Automated and real-machine results are recorded separately. Module existence, a test-only gate, or an unobserved GUI run is insufficient for M1 PASS.

The fresh precommit full suite passed 995/995 in 33.425 seconds, with zero failures, skips or cancellations and no Runtime V2 override. All 32 changed/new JavaScript files passed syntax checks. Real Electron observation confirmed V2 movement, accepted posture/sleep projections, chat pause/release, Spine/GIF restoration, and a usable replacement renderer after reload.

The task owner subsequently confirmed real-mouse cross-transition acceptance on the retained independent pink-haired pet: **USER-CONFIRMED REAL-MOUSE ACCEPTANCE — PASS**. This human evidence supplies the previously missing physical drag/release, chat interruption/recovery, sleep/user wake and post-recovery operation gate. The owner did not provide precise action times, coordinates or telemetry; none is invented or attributed to automated logs. The automation tool's transparent-window hit-test limitation remains an unresolved tool observation, with no conflicting product-regression evidence.

Posture, Sleep and the current Body lifecycle are CLOSED for the specified M1 scope. Lifecycle generation is ACTIVE; known inventoried stale body-truth IPC bypasses are 0. This closes M1 eligibility for M2; this work stops at M1 and does not implement or design M2.

Detailed evidence and the required twenty-section verdict are in `E:/ZCODE/work/WHITEMOON-FOUNDATION-M1-BODY-LIFECYCLE-AUTHORITY-CLOSURE-REPORT-v0.1.md`. Automated logs and bounded GUI evidence are in `E:/ZCODE/work/foundation-m1-2026-10-07T081641Z/`.

## Scope retained

Motion Substrate remains frozen. M1 changes authority admission and projection wiring, not locomotion mathematics, walkTick policy or animation algorithms.

Geometry precision (`charInset`, scale/support alignment), terminal feedback, capability protocol, a second Body and experience continuity remain outside M1. No WhiteMoon Core, Host or Adapter change is required or authorized by this milestone. No State Resolver or new lifecycle framework is added.

Complete M1 before considering M2. A blocked cutover remains BLOCKED even when V1 continues running and its documentation is accurate.

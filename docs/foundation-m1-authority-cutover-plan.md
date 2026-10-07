# WhiteMoon Foundation M1 Implementation Plan

> For agentic workers: execute the supplied M1 specification with test-first changes. Luna implements and verifies; the primary agent decides authority boundaries and reviews the result. Do not commit until the full automated suite and required real-machine acceptance both pass.

**Goal:** Make the default Sussurro Body path use the existing canonical authority domains.

**Baseline:** `runtime-i18n-main-native-v0.1` at `319412a24ab59d642ad822c98ec2386580fd44a6`, clean.

**Authoritative inputs:** the user's M1 request and `E:/ZCODE/work/WHITEMOON-FOUNDATION-CLOSURE-REPORT-v1.md`, sections 8, 9, 14, 15, 16. The user's stricter PASS/BLOCKED rule supersedes the audit's V1 downgrade alternative.

**Execution method:** the supplied session policy: Luna performs routine implementation/testing; the primary agent performs focused authority judgment/review. The user's explicit instruction to execute the milestone governs the work. No intermediate commits.

## Constraints

- Modify only `suzuran-pet`; Core, Host and Adapter remain unchanged.
- Retain the existing locomotion algorithms, walkTick cadence, gesture semantics, animation owner and geometry mathematics.
- Do not introduce a lifecycle framework, resolver, new posture, terminal protocol, capability protocol or product feature.
- Research pre-flight completed before source changes: 120 Knowledge files and the audit report copied unchanged to `E:/WhiteMoon/research/foundation-prior-art-archive/2026-10-07T081641Z/`; all 121 hashes verified. Originals retained.
- Default-configuration tests must not enable any `SUSSURRO_RUNTIME_V2_*` override. Explicit legacy-gate compatibility tests are separate evidence.
- Real-machine acceptance is a distinct gate. Automated checks alone cannot produce M1 PASS.
- Preserve all unrelated work. Do not reset, stash, delete user assets, push, or enter M2.

## Authority decisions

1. Existing MotionAuthority, WindowCommit and State Core become the default path. If the minimal cutover cannot meet the specified stop conditions, report BLOCKED rather than relabel V1 as a closed Foundation.
2. Motion algorithms remain executors. MotionAuthority admits their writes; WindowCommit performs position commits. Add a minimal legacy commit wrapper using the existing admission rule and shared write kernel; do not change trajectories or timing.
3. PostureSupport owns standing/seated/airborne/transition/unknown and intended support kind. Sleep, pause, locomotion phase and motion executor data remain separate domains. Their absence from the posture enum is not a model defect.
4. Legacy posture flags become projections written only by a main composition helper after a PostureSupport command. Do not infer canonical posture from `walkBroadcast()`. Flight/jump data remain executor data; begin/end paths explicitly notify the posture owner.
5. Main owns the single sleeping truth and automatic wake deadline. Renderer idle timing requests admission; renderer sleep/mood is a projection of main's accepted state. A mood or stale timer must not independently set sleep truth.
6. LifecycleProjection owns the current document identity, window/body generation and readiness. Allocate identity at create/navigation/reload/crash/recreate boundaries; readiness comes from the actual committed visual owner. Stale/future/missing identities are rejected for body mutations.
7. Preload captures a document identity during bootstrap and appends it to body mutation messages. It does not adopt the next document's identity. Validate current sender/frame as well as the exact identity.
8. PauseAuthority owns drag/chat/zoom leases. Normal release requires the matching lease; stale release must return before any cleanup or landing side effect. Explicit main teardown/watchdog revocation is a named authority action.
9. Preserve External Chat Ownership. Main chat pause release and renderer busy completion must match their owners. Mode switch revokes renderer-owned transient leases and preserves an active main-owned chat lease.

## Review focus

- Drag must still work when walking is disabled and after switching render modes; NONE means no locomotion, not denial of user placement.
- Repeated reload/crash/recreate must not admit an old document or old delayed recovery callback.
- Sleep rejection on elevated support must leave renderer awake; accepted sleep must also project in non-Spine modes.
- A stale drag release/throw must not clear a newer drag or snap its landing.
- Chat beginning while the engine is off must retain its lease if the engine later starts; stale completion must not release a newer owner.

## Task 1: Prove the default production gaps

**Files:** new focused tests and a test-only harness under `tests/`.

- [x] Execute real main/preload production code in a controlled host harness, with the actual canonical factories and IPC listeners. Do not reimplement admission judgments in tests.
- [x] Verify baseline default gate and stale/lifecycle gaps from frozen source; retain production behavior regressions for the cutover. A complete baseline RED run was not preserved and is not claimed as evidence.
- [x] Add direct behavior tests for posture commands, WindowCommit admission and non-walking drag compatibility.

## Task 2: Connect the existing canonical owners

**Files:** `main.js`, `preload.js`, `src/state-core/*`, `src/runtime-v2/*`, and `src/chat-ownership.js` only as required.

**Interfaces:**

- PostureSupport: `applyBodyPatch(patch, meta)` changes canonical pose facts and intended support inside the existing owner; `walkProjection()` returns compatibility flags. This calls the existing internal posture implementation rather than inferring truth from `walkBroadcast()`.
- LifecycleProjection: `begin(identity)`, exact `isCurrent(identity)` admission, and readiness/invalidation methods on the existing module.
- WindowCommit: `commitLegacy(context)` reuses `positionAdmit("legacy", context)` and the existing guarded write kernel. Existing locomotion/external interfaces are retained.
- Main composition: one helper for posture commands/projection, one helper for sleep admission/effects, and one body-message identity guard.
- Preload: a private per-document identity; existing public gesture and setting APIs remain compatible.

- [x] Enable the canonical path by default; preserve explicitly tested compatibility behavior only where safe.
- [x] Wire create, ready, reload, crash, destroy and recreate; invalidate renderer transient resources before replacement.
- [x] Route posture transitions through PostureSupport; keep legacy motion policy/executor code and mathematics intact.
- [x] Consolidate sleep admission, truth and automatic wake in main; guard old document requests.
- [x] Enforce matching pause/chat release identities and current drag ownership before any landing or throw effect.
- [x] Route every main-pet position write through the existing commit admission, except explicitly identified BrowserWindow construction initialization and explicit gate-off fallback.
- [x] Guard body-truth IPC based on authority purpose, including actual sibling channels identified by the inventory. Do not mechanically guard unrelated settings APIs.
- [x] Run focused tests and inspect failures before widening verification.

## Task 3: Connect renderer projections

**Files:** `renderer/pet.js`, existing renderer contract tests as appropriate.

- [x] Send readiness only after the current visual owner is usable; keep local render generation guards.
- [x] Treat sleep/mood state as main projection. Idle/user input generates requests; remove renderer automatic-wake authority.
- [x] Match busy start/chunk/done/error/stopped task identities; guard delayed mood completion effects.
- [x] Preserve animation and gesture classification behavior; no animation-completion endpoint.
- [x] Verify the real renderer source with the existing renderer harness.

## Task 4: Freeze evidence and complete the milestone

**Files:** a minimal static ownership JSON, a registry contract test, `docs/runtime-foundation-v1.md`, affected handoff/debt documents and the M1 report.

- [x] Registry covers domain, canonicalOwner, writers, readers, persistence, lifetime, generationGuard and projectionTargets for every requested domain. It never drives runtime behavior.
- [x] T1-T12 cover production default paths and stale/handoff behavior; registry tests catch meaningful source drift without a new static compiler.
- [x] T13/T14: existing Motion Substrate and full Body tests pass; run the repository test command without V2 overrides. Final result: 995/995, zero failed/skipped/cancelled.
- [x] Perform and record the actual desktop A-I transition/recovery acceptance: real Electron observations plus the owner's USER-CONFIRMED REAL-MOUSE ACCEPTANCE — PASS. Human results are recorded separately from automated logs; no precise action time/coordinate/telemetry is invented.
- [x] Correct freeze documentation to match the default runtime and its actual evidence, including the unresolved native acceptance gate.
- [x] Focused review found no motion rewrite, new dual owner, known stale body-truth bypass or out-of-scope product change. The owner subsequently confirmed the required native mouse transitions PASS; finalization changes only acceptance records/docs.
- [x] Recheck Core/Host/Adapter HEAD and clean status against the pre-flight snapshot. Final integrity check: all pass; frozen executor hashes and 121 archive hashes also unchanged.
- [x] Both required acceptance gates and fresh precommit checks pass; the owner explicitly authorized one `foundation: close body lifecycle authority` commit on the retained branch. The companion report records its final SHA and four-repository CLEAN state after commit; no push.
- [x] Record the required 20-section M1 report and A-J final answers. Stop before M2.

The earlier native acceptance blocker is superseded by the task owner's direct USER-CONFIRMED REAL-MOUSE ACCEPTANCE — PASS on the retained independent window. Preserve the earlier tool observations as historical evidence; do not fabricate automated results for human actions. Fresh full regression: 995/995, zero failures/skips/cancellations. Syntax, diff, baseline, default gate, reference repositories, frozen executors and research archive checks all pass. Final commit/state are recorded by the companion report; stop after M1, with no push and no M2 work.

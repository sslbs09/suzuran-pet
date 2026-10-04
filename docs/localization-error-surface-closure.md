# Phase 5-D — Error Surface Closure

## Baseline and scope

- Workspace: `C:\Users\xsbil\.zcode\workspace\i18n-main-native\suzuran-pet`
- Branch: `runtime-i18n-main-native-v0.1`
- Baseline: `8666571d04cdc72ebc2a8308c5e36b1b6c561afc`; clean working tree.
- Prior commits: `8666571` main result projection, `dbf41b7` chat/URL source facts, `4879760` error facts layer.
- Baseline validation: 100 tests passed across error facts/presentation, settings, catalogs, static pages, main/native and dynamic localization.
- Scope: close user-visible technical error branches using the existing `src/error-presenter.js` and `I18N.t`; preserve Phase 1–5-C behavior and contracts.
- Excluded: character content, `lines.js`, chat ownership, motion/state, IPC architecture, logging architecture, external authentication/services.

## Migration plan (published before implementation)

### 5-D1 — restartGsv error consolidation

- Extend the existing facts/presenter vocabulary with exactly the four existing wire failure codes: `timeout`, `synth`, `disabled`, `nopath`.
- Preserve existing `{ok, code}` values and restart lifecycle. `success` is not an error code.
- Move the four failure strings into parity-checked `err.gsv*` keys in zh/en/ja; retain successful/progress text and old catalog keys for compatibility.
- Remove the settings private `msgs` map. Known failures and caught rejections use the current settings funnel; malformed coded responses retain `err.unknown` semantics.
- Tests: vocabulary/parity, actual settings click handler outcomes, rejection and invalid-code filtering, button lifecycle.
- Commit after targeted tests, touched-file lint and whitespace verification.

### 5-D2 — diagnostic boundary cleanup

- Close technical exception/result flows in settings diagnostics/update results, pet ask rejection, add-character, docs, voice, PSD and schedule pages.
- Local catch paths emit the existing `INTERNAL` fact for display. Cross-process exception producers add `code/meta` through `errorFacts.toPayload` and retain legacy `error/message` fields.
- Small page adapters only call the existing presenter and `I18N.t`; they contain no private code/text maps. Preserve the frozen no-code legacy-message fallback for intended static user validation/policy text.
- Preserve diagnostic `console`, `dbg`, `logTts` and explicitly sanitized log content. Failure summaries must not interpolate raw diagnostics.
- Review voice status and other main-owned results to prevent indirect technical strings escaping through legacy fallback.
- Tests: execute production handlers/functions with hostile exceptions/results; verify localized DOM output, success behavior, diagnostics and existing page localization ownership.
- Commit after targeted tests, touched-file lint and whitespace verification.

### 5-D3 — Agent contract and final error surface audit

- Agent static transport failures gain existing `code/meta`; queue/runtime busy uses `BUSY`. No new request-validation/policy vocabulary.
- Preserve exact HTTP status, `error` text, authentication/queue/lifecycle behavior and existing exception projection. Consent/policy rejection remains an intentional legacy contract.
- Verify production HTTP routes with controlled local requests; verify status/text compatibility and bounded metadata.
- Final scan: `pet:toast`, result/alert/showError/DOM error sites; distinguish product prompts, diagnostic output, API data and permitted legacy fallback.
- Record files changed, error ownership, compatibility, verification and remaining debt below. Run proportional cross-phase regression and independent review before final commit.

## Contract invariants

- `code` presence, not truthiness, selects the coded branch. Invalid present codes never fall back to `message`.
- Only valid integer HTTP status (100–599) may enter presentation parameters.
- `detail`/stack/provider body are diagnostic data and never presentation parameters.
- Existing `error/message` fields and wire code values are preserved; code/meta additions are additive.
- Local page presentation adapters do not classify technical message text or own error mappings.

## Execution and acceptance evidence

### 5-D1 evidence

- Existing GSV protocol and main restart implementation unchanged. Four existing failure codes now belong to the shared vocabulary (15 codes / 17 catalog keys).
- Production click handler tests cover all four failures, success, rejection, invalid codes and button lifecycle in zh/en/ja. New test failed before implementation.
- Controller verification: cross-phase targeted regression 101 passed, 0 failed; whitespace check passed. Touched-file lint: 0 errors, 1 existing settings warning.
- No character/chat/motion ownership changes.

### 5-D2 decisions and review

- A focused review identified and repaired three regressions before commit: raw voice HTTP response bodies must not be newly persisted by the logger; PSD status replay must retain error facts rather than previously translated text; actionable schedule validation must not become a generic internal error.
- Voice HTTP failures consume the response as before, but log status only. User output retains the compatible message field and receives existing HTTP facts.
- PSD retains the error result/fact in its existing status snapshot and resolves it through the presenter during each redraw. The existing locale redraw owner and business lifecycle stay in place.
- `schedules.ValidationError` marks only existing source-owned title/date/time/recurrence/quota and workbook validation. Its legacy error/message text is preserved; filesystem/parser failures are coded. No new validation code, registry or protocol field was introduced.
- Validation note: D2 product edits preceded the new regression tests. Verification subsequently compares real production behavior against the committed D1 baseline; this is baseline regression evidence, not a claim of test-first implementation.
- Controller verification: 148 targeted tests passed, 0 failed. Against D1 (`2d58477`), the new behavior suite produced 13 actual-output failures and 1 intentional static-check skip; no missing-helper or extraction failure was used as regression evidence. A final empty PSD-result fallback adjustment passed all 22 affected closure/main-native tests.
- The 14 closure tests execute production functions, registered IPC handlers, attached DOM/tooltips and the existing locale callbacks with controlled external boundaries. Focused review blockers were repaired. Touched-file lint has 0 errors and 5 existing warnings; whitespace verification passed. These are not real Electron/device execution claims.

## Error ownership table

| Source owner | Fact / compatibility boundary | User presentation owner | Diagnostic / contract distinction |
| --- | --- | --- | --- |
| Main GSV restart | Existing `{ok,code}`; four lowercase failure codes preserved | Settings `presentResultError` → shared presenter → I18N → result | Progress/success remain product status; restart lifecycle unchanged |
| Main chat generation | Existing `errorFacts.toPayload` → `{id,code,meta,message}` | Pet `onError` → presenter → I18N → `showError` | Character prefix/speech unchanged; absent-code message is frozen legacy fallback |
| Pet local ask rejection | Local `INTERNAL` fact | Same presenter/I18N and existing `showError` | Exception text is not interpolated into the bubble |
| Main settings / auxiliary filesystem results | `projectedFailure` delegates to `toPayload`; original `error` or `message` field retained | Settings, add-character, docs, moods, PSD, schedule and voice adapters → same presenter/I18N | Adapters own no code-to-text map; legitimate static no-code validation remains compatible |
| Settings log read/export failure | Main projected failure, original result fields preserved | Existing settings funnel → result summary | Log lines retain explicit sanitized/escaped diagnostic display; console/dbg/logTts remain diagnostic |
| Fixed-line failure cache | Existing diagnostic `errorCode` data retained | Settings badge tooltip → presenter/I18N | Cached raw diagnostic strings are never displayed as tooltip text; unknown strings map to `err.unknown` |
| Update check | Main error facts | Native dialog and settings result use the same presenter and active locale | Technical update reason remains diagnostic, not a dialog parameter |
| Voice HTTP / readiness | Existing HTTP facts, `INTERNAL`, or `TIMEOUT`; old status fields retained | Voice result/status card → presenter/I18N | Remote `fail` is diagnostic data, not a legacy message fallback; body is not newly logged |
| PSD local errors / IPC results | Controlled local fact or original result snapshot | Existing `renderStatus` resolves facts at each locale redraw | No new redraw state owner or business requests |
| Schedule validation | Explicit source-owned `ValidationError` → old no-code error/message | Schedule result compatibility adapter | Only known user validation is legacy; genuine technical failures are coded |
| Consent / policy | Existing static no-code messages retained | Existing legacy fallback / terms hint | No misleading new policy code; legal and character content unchanged |
| Agent HTTP transport / busy / generation | Existing HTTP facts or `BUSY`; generation retains `toPayload` | External caller owns UI, if any | API `error` text/status/headers are contract data and are not replaced by locale catalog strings |
| `pet:toast` | Existing localized product notices / fixed prompts | Existing toast sink | No technical exception/body/message interpolation found in active toast producers |

## Protocol compatibility

- Existing IPC channels, IDs, success responses and GSV lowercase code values are preserved.
- Previously uncoded technical result envelopes gain `code/meta`; their old error/message field and additional result data remain present. Compatibility error strings may be redacted or reduced to safe HTTP status text.
- Already coded Phase 5-B result behavior and Phase 5-A invalid-present-code rules are unchanged.
- Explicit source-owned static validation and consent/policy responses retain absent-code legacy fields.
- Agent additions preserve exact original status, error text and relevant response headers; no authentication, queue, stop, chat ownership or lifecycle changes.

## Verification and remaining debt

Final test totals, commits and changed-file inventory are pending final verification.

- Intentional legacy fallback remains: an absent-code legacy message/error is still displayed verbatim. This prevents claiming that arbitrary forged legacy payloads are universally filtered; the closure claim concerns audited active technical exception paths.
- Static validation/policy copy may remain in its original language; no new meaningless error codes were invented to translate it.
- The old `set.gsv*` catalog keys remain for compatibility; the active failure path uses `err.gsv*`.
- Existing diagnostic logger/cache data and explicitly sanitized log display remain. No broad logging/cache migration or deletion was performed.
- Electron real-device/GSV service restart has not been exercised; tests isolate external processes and services. The restart implementation itself is unchanged.

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

5-D2 and 5-D3 pending.

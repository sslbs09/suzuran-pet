"use strict";

const assert = require("node:assert/strict");
const { isConsentAccepted, canUseRuntime, acceptConsent } = require("../src/consent-gate");
const { createOnceRunner } = require("../src/runtime-lifecycle");
const { buildTrayItems } = require("../src/tray-menu");

for (const value of [undefined, false, null, "false", "true", 0, 1, {}, []]) {
  assert.equal(isConsentAccepted({ agreed: value }), false, "invalid consent remains pending: " + String(value));
  assert.equal(canUseRuntime({ agreed: value }), false, "invalid consent cannot start runtime: " + String(value));
}
assert.equal(isConsentAccepted({}), false, "missing agreed remains pending");
assert.equal(isConsentAccepted({ agreed: true }), true, "literal true is accepted");
assert.equal(canUseRuntime({ agreed: true }), true, "literal true can start runtime");

let savedPatch = null;
let stored = { agreed: false };
assert.equal(acceptConsent({
  saveConfig: (patch) => { savedPatch = patch; stored = { agreed: true }; },
  readConfig: () => stored
}), true, "successful accept returns success");
assert.deepEqual(savedPatch, { agreed: true }, "accept writes only the boolean consent value");

assert.throws(() => acceptConsent({
  saveConfig: () => { throw new Error("disk full"); },
  readConfig: () => ({ agreed: true })
}), /disk full/, "save failures stay failures");
assert.throws(() => acceptConsent({
  saveConfig: () => {},
  readConfig: () => ({ agreed: "true" })
}), /could not be confirmed/, "unconfirmed truthy values stay pending");

let starts = 0;
const runner = createOnceRunner(() => { starts++; return "started"; });
assert.equal(runner.state, "not-started");
assert.equal(runner.start().started, true, "first normal runtime start runs");
assert.equal(runner.start().started, false, "repeated normal runtime start is ignored");
assert.equal(starts, 1, "normal runtime initializer runs once");
assert.equal(runner.state, "started");

let failedStarts = 0;
const failedRunner = createOnceRunner(() => { failedStarts++; throw new Error("partial init"); });
assert.throws(() => failedRunner.start(), /partial init/);
assert.equal(failedRunner.start().started, false, "failed initializer is not retried");
assert.equal(failedStarts, 1, "partial initialization cannot duplicate listeners/timers");
assert.equal(failedRunner.state, "failed");

let termsOpened = 0;
let quitCalled = 0;
const pendingItems = buildTrayItems({
  cfg: { agreed: false },
  pending: true,
  lang: "zh",
  i18n: require("../src/i18n"), // Phase 2：pending 分支 label 已键化，夹具补注入真实 translator
  openTerms: () => { termsOpened++; },
  quitApp: () => { quitCalled++; }
});
assert.equal(pendingItems.length, 3, "pending tray has only two actions and a separator");
pendingItems[0].click();
pendingItems[2].click();
assert.equal(termsOpened, 1, "pending tray opens terms");
assert.equal(quitCalled, 1, "pending tray can quit");
assert.match(pendingItems[0].label, /条款与隐私政策/);

console.log("consent gate 全部通过 ✅");

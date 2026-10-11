"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { petUiHit } = require("../src/clickability");

function fakeEl(ancestors, tagName = "DIV") {
  return {
    tagName,
    closest: (selector) => ancestors.includes(selector) ? {} : null,
  };
}

const spineEnv = (spineInteractiveAt, walk = null) => ({
  activeRenderMode: () => "spine",
  spineInteractiveAt,
  petEl: () => ({ getBoundingClientRect: () => ({ left: 100, top: 100, width: 120, height: 120 }) }),
  walkState: () => walk || { active: true, resting: false, paused: false, sleeping: false, seated: false, perched: false },
});

test("Spine alpha contract: opaque body is interactive and canvas alpha=0 passes through", () => {
  const canvas = fakeEl(["#pet"], "CANVAS");
  assert.equal(petUiHit(canvas, { clientX: 150, clientY: 160 }, spineEnv(() => true)), true);
  assert.equal(petUiHit(canvas, { clientX: 151, clientY: 161 }, spineEnv(() => false)), false);
});

test("Spine alpha contract: outside canvas and walking outer radius stay click-through", () => {
  const background = fakeEl([".pet-root"]);
  assert.equal(petUiHit(background, { clientX: 160, clientY: 160 }, spineEnv(() => true)), false);
  assert.equal(petUiHit(background, { clientX: 100, clientY: 160 }, spineEnv(() => true)), false);
});

test("Spine alpha contract is direction-independent", () => {
  const canvas = fakeEl(["#pet"], "CANVAS");
  for (const direction of [-1, 1]) {
    assert.equal(petUiHit(canvas, { clientX: 150 + direction, clientY: 160 }, spineEnv(() => true)), true);
    assert.equal(petUiHit(canvas, { clientX: 151 + direction, clientY: 161 }, spineEnv(() => false)), false);
  }
});

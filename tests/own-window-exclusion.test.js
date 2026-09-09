"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8");
const start = main.indexOf("function isPetWindowHwnd(hwnd)");
const end = main.indexOf("function hwndKey", start);
assert.notEqual(start, -1, "isPetWindowHwnd exists");
assert.notEqual(end, -1, "hwndKey follows isPetWindowHwnd");
const source = main.slice(start, end);

function fakeWindow(handle, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => handle
  };
}

function predicate(overrides = {}) {
  const values = {
    win: null,
    settingsWin: null,
    helpWin: null,
    quickstartWin: null,
    voiceWin: null,
    moodWin: null,
    termsWin: null,
    scheduleWin: null,
    psdWin: null,
    docsWin: null,
    addCharWin: null,
    ...overrides
  };
  return vm.runInNewContext(`
    const win = values.win;
    const settingsWin = values.settingsWin;
    const helpWin = values.helpWin;
    const quickstartWin = values.quickstartWin;
    const voiceWin = values.voiceWin;
    const moodWin = values.moodWin;
    const termsWin = values.termsWin;
    const scheduleWin = values.scheduleWin;
    const psdWin = values.psdWin;
    const docsWin = values.docsWin;
    const addCharWin = values.addCharWin;
    function nativeHwndKey(value) { return typeof value === "bigint" && value > 0n ? value : null; }
    function hwndKey(value) { return typeof value === "bigint" && value > 0n ? value : null; }
    ${source}
    isPetWindowHwnd;
  `, { values });
}

assert.equal(predicate({ win: fakeWindow(101n) })(101n), true, "main pet window is excluded");
assert.equal(predicate({ settingsWin: fakeWindow(102n) })(102n), true, "settings window is excluded");
assert.equal(predicate({ docsWin: fakeWindow(103n) })(103n), true, "docs window is excluded");
assert.equal(predicate({ addCharWin: fakeWindow(104n) })(104n), true, "add-character window is excluded");
assert.equal(predicate({ docsWin: null, addCharWin: null })(999n), false, "null windows are skipped");
assert.doesNotThrow(() => predicate({ docsWin: fakeWindow(105n, true) })(105n), "destroyed windows are skipped");
assert.doesNotThrow(() => predicate({ docsWin: {
  isDestroyed: () => false,
  getNativeWindowHandle: () => { throw new Error("native handle unavailable"); }
} })(105n), "native handle failures are isolated");
assert.equal(predicate({ docsWin: fakeWindow(106n) })(999n), false, "external HWND is not app-owned");

console.log("own-window exclusion contract 全部通过");

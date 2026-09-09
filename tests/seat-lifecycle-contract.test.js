const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8");
const lifecycle = source.slice(source.indexOf("function seatTrackActive"), source.indexOf("async function initSpine"));

assert.match(lifecycle, /spineObj\.update\(/, "受控生命周期显式推进 Spine");
assert.match(lifecycle, /seatContainmentCommit\(\);/, "推进后执行同帧 containment");
assert.match(lifecycle, /spineObj\.autoUpdate = false/, "受控期间关闭隐式 autoUpdate");
assert.match(lifecycle, /spineApp\.ticker\.add\(/, "注册唯一预处理 ticker");
assert.match(source, /spineApp\.ticker\.remove\(seatLifecycle\.ticker/, "销毁时解除旧 ticker");
assert.ok(lifecycle.indexOf("spineObj.update(") < lifecycle.indexOf("seatContainmentCommit();"), "update 先于 containment");

console.log("seat lifecycle contract 全部通过");

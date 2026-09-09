const assert = require("node:assert/strict");
const fs = require("node:fs");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8");
const start = main.indexOf("function walkFlightTick()");
const end = main.indexOf("/** 相位切换", start);
const source = main.slice(start, end);

assert.notEqual(start, -1, "walkFlightTick exists");
assert.match(source, /else\s*\{[\s\S]*?enterRestPose\(\);/,
  "ground settle reuses enterRestPose");
assert.match(source, /if \(landingBarrier\) walkSetPosition\(nx, landingFloorY, "flight-settle"\);/,
  "flight-settle position write is restricted to perched landing");
assert.ok(source.indexOf("enterRestPose();") < source.indexOf("walkBroadcast();"),
  "final state/position commit precedes broadcast");
assert.match(source, /walkSchedulePhase\(sitPhaseMs\(\)\);/,
  "final settle schedules the next phase");

console.log("flight settle contract 全部通过");

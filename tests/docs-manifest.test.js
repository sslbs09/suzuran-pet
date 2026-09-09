"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8");
const start = main.indexOf("function selectTutorialDir(");
const end = main.indexOf("\n\n/** 文档清单", start);
assert.notEqual(start, -1, "selectTutorialDir exists");
assert.notEqual(end, -1, "selectTutorialDir ends before docsManifest");
const selectTutorialDir = vm.runInNewContext(`${main.slice(start, end)}\nselectTutorialDir;`, { path });

function fakeFs(directories) {
  return {
    existsSync: (dir) => Object.prototype.hasOwnProperty.call(directories, dir),
    statSync: (dir) => ({ isDirectory: () => directories[dir].isDirectory }),
    readdirSync: (dir) => directories[dir].files
  };
}

const exeDir = path.join("C:", "release");
const appDir = path.join("C:", "workspace");
const exeTutorial = path.join(exeDir, "新手教程");
const appTutorial = path.join(appDir, "新手教程");

assert.equal(
  selectTutorialDir(exeDir, appDir, fakeFs({
    [exeTutorial]: { isDirectory: true, files: ["01.md"] },
    [appTutorial]: { isDirectory: true, files: ["01.md"] }
  })),
  exeTutorial,
  "release directory wins when both candidates are available"
);
assert.equal(
  selectTutorialDir(exeDir, appDir, fakeFs({
    [appTutorial]: { isDirectory: true, files: ["01.md", "02.md"] }
  })),
  appTutorial,
  "workspace directory is used as fallback"
);
assert.equal(
  selectTutorialDir(exeDir, appDir, fakeFs({
    [exeTutorial]: { isDirectory: true, files: ["README.txt"] },
    [appTutorial]: { isDirectory: true, files: ["01.md"] }
  })),
  appTutorial,
  "empty release candidate falls back to workspace directory"
);
assert.equal(
  selectTutorialDir(exeDir, appDir, fakeFs({})),
  null,
  "missing candidates return no tutorial directory"
);

const workspaceRoot = path.resolve(__dirname, "..");
const workspaceTutorial = selectTutorialDir(
  path.join(workspaceRoot, "node_modules", "electron", "dist"),
  workspaceRoot,
  fs
);
assert.equal(workspaceTutorial, path.join(workspaceRoot, "新手教程"), "workspace structure uses APP_DIR fallback");
const workspaceTutorialFiles = fs.readdirSync(workspaceTutorial).filter((name) => name.endsWith(".md"));
assert.equal(workspaceTutorialFiles.length, 10, "workspace fallback discovers all 10 tutorial files");

const fixedDocs = [
  "app/开箱必读.html",
  "app/使用说明.html",
  "app/README.md",
  "app/语音指南",
  "app/API接入指南.html"
];
for (const key of fixedDocs) assert.match(main, new RegExp(`key: "${key}"`), `${key} remains a fixed document`);
assert.equal((main.match(/items\.push\(\{ key: "app\//g) || []).length, 5, "exactly 5 fixed documents remain");
assert.equal(workspaceTutorialFiles.length + fixedDocs.length, 15, "workspace manifest preserves the 15-item release semantic");

console.log("docs manifest contract 全部通过");

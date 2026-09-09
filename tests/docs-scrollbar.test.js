"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const css = fs.readFileSync(require.resolve("../renderer/docs.css"), "utf8");
const { injectDocsScrollbarStyle } = require("../renderer/docs.js");

const source = "<!doctype html><html><head><style>body { color: red; }</style></head><body>正文</body></html>";
const injected = injectDocsScrollbarStyle(source);
assert.equal((injected.match(/id="suzuran-docs-scrollbar"/g) || []).length, 1, "iframe style is injected once");
assert.ok(injected.indexOf('id="suzuran-docs-scrollbar"') > injected.indexOf("body { color: red; }"), "iframe style is appended after document styles");
assert.match(injected, /html::\-webkit\-scrollbar\s*\{ width: 9px; height: 9px; \}/, "iframe scrollbar width is 9px");
assert.match(injected, /html\.theme-dark::\-webkit\-scrollbar-thumb/, "iframe dark theme scrollbar is scoped to html");
assert.equal(injectDocsScrollbarStyle(injected), injected, "existing injection is not duplicated");

assert.match(css, /#docs-main \{ flex: 1; overflow: hidden; background: var\(--content-bg\); \}/, "outer main does not scroll");
assert.match(css, /#docs-iframe \{ display: block; width: 100%; height: 100%;/, "iframe is block-sized");
assert.match(css, /#docs-iframe\[hidden\] \{ display: none; \}/, "hidden iframe does not occupy layout space");
assert.match(css, /#docs-sidebar::-webkit-scrollbar[\s\S]*width: 9px;/, "sidebar scrollbar is styled");
assert.match(css, /#docs-content\.docs-md\s*\{[\s\S]*overflow-y: auto;/, "markdown content owns its scroll");
assert.match(css, /#docs-sidebar::-webkit-scrollbar-button[\s\S]*display: none;/, "sidebar scrollbar buttons are hidden");
assert.doesNotMatch(css, /#docs-main::-webkit-scrollbar/, "outer main has no scrollbar styling");
assert.doesNotMatch(css, /scrollbar-(?:width|color)/, "unsupported standard scrollbar properties are not used");

console.log("docs scrollbar contract 全部通过");

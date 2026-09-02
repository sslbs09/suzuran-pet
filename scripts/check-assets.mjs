import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const strict = process.argv.includes("--strict");
const required = [
  "main.js",
  "preload.js",
  "renderer/index.html",
  "renderer/pet.js",
  "renderer/pet.css",
  "persona.default.md",
  "icon.ico"
];
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
const optionalMissing = [];
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
const refs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .filter((ref) => !/^(?:https?:|data:|#)/i.test(ref));
for (const ref of refs) {
  const file = path.resolve(path.dirname(path.join(root, "renderer/index.html")), ref);
  if (!fs.existsSync(file)) {
    const relative = path.relative(root, file);
    const normalized = relative.split(path.sep).join("/");
    if (normalized.startsWith("node_modules/") || normalized === "renderer/live2dcubismcore.min.js") optionalMissing.push(relative);
    else missing.push(relative);
  }
}
if (optionalMissing.length && !strict) {
  console.warn("可选资源未包含（相关能力将不可用）：");
  for (const file of optionalMissing) console.warn(" - " + file);
}
if (strict && optionalMissing.length) missing.push(...optionalMissing);
if (missing.length) {
  console.error("资源完整性检查失败：");
  for (const file of missing) console.error(" - " + file);
  process.exit(1);
}
console.log(`资源完整性检查通过（${required.length} 个核心文件，${refs.length} 个 renderer 引用）`);

/** i18n 词典一致性 + 使用覆盖单测（node，不依赖 Electron）
 * 1) zh/en/ja 三语言键集合严格一致（缺键/多键都算败）
 * 2) 所有键值非空；t() 兜底行为正确
 * 3) 代码中引用的字面量键（main.js + renderer 的 data-i18n/I18N.t/i18n.t）全部存在于词典
 * 附带：输出「词典中未被任何代码引用的键」清单（供未用键清理参考，不判失败）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const I18N = require("../src/i18n");
let failed = 0;
function assertEq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}

const zhKeys = Object.keys(I18N.DICT.zh);
const enKeys = Object.keys(I18N.DICT.en);
const jaKeys = Object.keys(I18N.DICT.ja);
const diff = (a, b) => a.filter((k) => !b.includes(k));

// 1) 三语言键集合一致
assertEq("en 相对 zh 缺键", diff(zhKeys, enKeys), []);
assertEq("en 相对 zh 多键", diff(enKeys, zhKeys), []);
assertEq("ja 相对 zh 缺键", diff(zhKeys, jaKeys), []);
assertEq("ja 相对 zh 多键", diff(jaKeys, zhKeys), []);

// 2) 值非空 + t() 兜底
const emptyKeys = [];
for (const lang of ["zh", "en", "ja"])
  for (const k of Object.keys(I18N.DICT[lang]))
    if (!String(I18N.DICT[lang][k]).trim()) emptyKeys.push(lang + ":" + k);
assertEq("空值键", emptyKeys, []);
has("t() 返回词典值", I18N.t("en", "tray.hidePet") === I18N.DICT.en["tray.hidePet"]);
has("t() 未知键兜底返回键本身", I18N.t("zh", "tray.no.such.key") === "tray.no.such.key");
has("getDict 未知语言回退 zh", I18N.getDict("xx") === I18N.DICT.zh);

// 3) 使用覆盖：扫描 main.js + src/*.js + renderer 的字面量键
//    覆盖三种形态：data-i18n 属性、I18N.t("..") 动态调用、i18n.t(lang,"..") 主进程调用，
//    以及带前缀的字符串字面量（托盘菜单的变量键池如 "tray.rateWordSlow" 由变量拼接调用）。
const ROOT = path.resolve(__dirname, "..");
const targets = ["main.js"];
for (const f of fs.readdirSync(path.join(ROOT, "src"))) {
  if (/\.js$/i.test(f)) targets.push(path.join("src", f));
}
for (const f of fs.readdirSync(path.join(ROOT, "renderer"))) {
  if (/\.(js|html)$/i.test(f)) targets.push(path.join("renderer", f));
}
const used = new Set();
const KEY_RE = /"(?:tray|ui|set|skin|pet|common)\.[A-Za-z0-9.]+"/g;
for (const t of targets) {
  const src = fs.readFileSync(path.join(ROOT, t), "utf8");
  let m;
  while ((m = KEY_RE.exec(src)) !== null) {
    const k = m[0].slice(1, -1);
    // 过滤误报：文件路径引用（ui.css/pet.js）与动态键前缀（"set.seatTier." + tier）
    if (/\.(css|js|html|png|jpg)$/i.test(k) || k.endsWith(".")) continue;
    used.add(k);
  }
}
assertEq("未扫描到任何键（sanity）", used.size > 0, true);
const missing = [...used].filter((k) => !zhKeys.includes(k));
assertEq("代码引用的键缺失于词典", missing, []);

// 附带：未使用键清单（供清理参考）
const unused = zhKeys.filter((k) => !used.has(k));
if (unused.length) console.log("INFO 词典中未被代码引用的键（" + unused.length + " 个）：\n  " + unused.join("\n  "));
else console.log("INFO 所有词典键均被使用");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过 ✅");
process.exit(failed ? 1 : 0);
/** weather 纯函数单测（node）——城市解析/天气码/分类/可插拔源（v2.5.26 天气） */
"use strict";
const { resolveLoc, codeInfo, moodCat, CITY_TABLE, owmToWmo, registerProvider, PROVIDERS, fetchWeather } = require("../src/weather");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

assert("城市表-上海", resolveLoc("上海").lat === CITY_TABLE["上海"][0]);
assert("lat,lon 解析", resolveLoc("31.23,121.47").lon === 121.47);
assert("中文逗号 lat，lon", resolveLoc("39.90，116.40").lat === 39.9);
assert("未知城市→null", resolveLoc("不存在的地方") === null);
assert("空→null", resolveLoc("") === null);

assert("晴码0", codeInfo(0).cat === "sunny");
assert("雨码61", codeInfo(61).cat === "rain");
assert("雪码71", codeInfo(71).cat === "snow");
assert("雷雨95", codeInfo(95).cat === "thunder");
assert("雾48", codeInfo(48).cat === "fog");

assert("高温→hot", moodCat({ temp: 36, wind: 5, cat: "sunny" }) === "hot");
assert("低温→cold", moodCat({ temp: -3, wind: 5, cat: "sunny" }) === "cold");
assert("大风→windy", moodCat({ temp: 20, wind: 40, cat: "cloudy" }) === "windy");
assert("普通→天气类", moodCat({ temp: 22, wind: 8, cat: "rain" }) === "rain");

// 可插拔天气源接口
assert("OWM 码转 WMO", owmToWmo(800) === 0 && owmToWmo(500) === 61 && owmToWmo(600) === 71 && owmToWmo(200) === 95);
assert("默认有 open-meteo", typeof PROVIDERS["open-meteo"] === "function");
registerProvider("mock", async () => ({ temp: 25, humidity: 50, wind: 10, code: 0 }));
assert("registerProvider 生效", typeof PROVIDERS["mock"] === "function");
(async () => {
  const w = await fetchWeather("上海", { provider: "mock" });
  assert("自定义源可取数", w && w.temp === 25 && w.cat === "sunny", JSON.stringify(w));
  process.exit(failed ? 1 : 0);
})();

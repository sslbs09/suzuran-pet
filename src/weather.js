"use strict";

/* weather.js — 免费天气（Open-Meteo，无需 API key，非商业免费，~1万/天；
 * 半小时一次=48/天，一个月零成本）。地理编码用内置城市表免请求。v2.5.26
 */

/** 内置城市表（免地理编码请求）；也支持直接填 "lat,lon" */
const CITY_TABLE = {
  "北京": [39.90, 116.40], "上海": [31.23, 121.47], "广州": [23.13, 113.26],
  "深圳": [22.54, 114.06], "成都": [30.57, 104.07], "杭州": [30.27, 120.16],
  "武汉": [30.59, 114.30], "西安": [34.34, 108.94], "南京": [32.06, 118.80],
  "重庆": [29.56, 106.55], "苏州": [31.30, 120.58], "天津": [39.13, 117.20],
};

/** 解析城市配置 → {lat,lon} 或 null */
function resolveLoc(city) {
  const s = String(city || "").trim();
  if (!s) return null;
  if (CITY_TABLE[s]) return { lat: CITY_TABLE[s][0], lon: CITY_TABLE[s][1] };
  const m = s.split(/[,，\s]+/).map(Number);
  if (m.length >= 2 && m.every(Number.isFinite)) return { lat: m[0], lon: m[1] };
  return null;
}

/** WMO 天气码 → {desc, cat} */
function codeInfo(code) {
  const c = Number(code);
  if (c === 0 || c === 1) return { desc: "晴", cat: "sunny" };
  if (c === 2) return { desc: "多云", cat: "cloudy" };
  if (c === 3) return { desc: "阴", cat: "overcast" };
  if (c === 45 || c === 48) return { desc: "雾", cat: "fog" };
  if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { desc: "雨", cat: "rain" };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { desc: "雪", cat: "snow" };
  if (c >= 95) return { desc: "雷雨", cat: "thunder" };
  return { desc: "多云", cat: "cloudy" };
}

/** WMO 码转换：OpenWeatherMap 条件码 → WMO 近似码 */
function owmToWmo(id) {
  id = Number(id) || 0;
  if (id >= 200 && id < 300) return 95;   // 雷雨
  if (id >= 300 && id < 600) return 61;   // 雨
  if (id >= 600 && id < 700) return 71;   // 雪
  if (id >= 700 && id < 800) return 45;   // 雾/沙尘
  if (id === 800) return 0;               // 晴
  return 2;                               // 多云
}

/** 天气源注册表（v2.5.26 可插拔）：默认 open-meteo（免 key）；
 *  他人可 registerProvider(name, fn) 或配置 provider 接自己的接口。
 *  fn(loc,{key}) → Promise<{temp,humidity,wind,code}> 或 null */
const PROVIDERS = {
  "open-meteo": async (loc) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&timezone=auto`;
    const r = await fetch(url, { headers: { "User-Agent": "suzuran-pet" } });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j.current || {};
    return { temp: c.temperature_2m, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m, code: c.weather_code };
  },
  "openweathermap": async (loc, key) => {
    if (!key) return null;
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${loc.lat}&lon=${loc.lon}&appid=${encodeURIComponent(key)}&units=metric&lang=zh_cn`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return { temp: j.main && j.main.temp, humidity: j.main && j.main.humidity, wind: j.wind && j.wind.speed, code: owmToWmo(j.weather && j.weather[0] && j.weather[0].id) };
  },
};
function registerProvider(name, fn) { if (name && typeof fn === "function") PROVIDERS[name] = fn; }

/** 拉取当前天气。opts={provider,key}。返回 {temp,humidity,wind,desc,cat,provider} 或 null。30 分钟缓存 */
let _cache = { t: 0, key: "", data: null };
async function fetchWeather(city, opts = {}) {
  const loc = resolveLoc(city);
  if (!loc) return null;
  const prov = opts.provider && PROVIDERS[opts.provider] ? opts.provider : "open-meteo";
  const ck = loc.lat + "," + loc.lon + "," + prov;
  const now = Date.now();
  if (_cache.data && _cache.key === ck && now - _cache.t < 30 * 60 * 1000) return _cache.data;
  try {
    const fn = PROVIDERS[prov];
    const raw = await fn(loc, opts.key || "");
    if (!raw || raw.temp == null) return null;
    const info = codeInfo(raw.code);
    const data = { temp: Math.round(raw.temp), humidity: Math.round(raw.humidity), wind: Math.round(raw.wind), desc: info.desc, cat: info.cat, provider: prov };
    _cache = { t: now, key: ck, data };
    return data;
  } catch { return null; }
}

/** 由天气+温度生成分类（用于选台词池）：hot/cold/windy 优先于天气类 */
function moodCat(w) {
  if (!w) return null;
  if (w.temp >= 33) return "hot";
  if (w.temp <= 0) return "cold";
  if (w.wind >= 30) return "windy";
  return w.cat;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CITY_TABLE, resolveLoc, codeInfo, fetchWeather, moodCat, PROVIDERS, registerProvider, owmToWmo };
}

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

/** 拉取当前天气。返回 {temp,humidity,wind,desc,cat} 或 null。30 分钟缓存 */
let _cache = { t: 0, key: "", data: null };
async function fetchWeather(city) {
  const loc = resolveLoc(city);
  if (!loc) return null;
  const key = loc.lat + "," + loc.lon;
  const now = Date.now();
  if (_cache.data && _cache.key === key && now - _cache.t < 30 * 60 * 1000) return _cache.data;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&timezone=auto`;
    const r = await fetch(url, { headers: { "User-Agent": "suzuran-pet" } });
    if (!r.ok) return null;
    const j = await r.json();
    const cur = j.current || {};
    const info = codeInfo(cur.weather_code);
    const data = {
      temp: Math.round(cur.temperature_2m),
      humidity: Math.round(cur.relative_humidity_2m),
      wind: Math.round(cur.wind_speed_10m),
      desc: info.desc, cat: info.cat,
    };
    _cache = { t: now, key, data };
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
  module.exports = { CITY_TABLE, resolveLoc, codeInfo, fetchWeather, moodCat };
}

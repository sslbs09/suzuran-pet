/**
 * gen-icon.js — 生成托盘/应用图标（32x32 PNG，无外部依赖）
 * 画一个圆角蓝底 + 白色医疗十字（苏苏洛主题）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 32;
const px = new Uint8Array(S * S * 4); // RGBA

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// 圆角矩形判定
function inRoundedRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
  const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}

// 背景：圆角蓝
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x, y, 1, 1, S - 2, S - 2, 7)) {
      setPx(x, y, 0x8e, 0xc7, 0xe8);
    }
  }
}

// 医疗十字
const cx0 = 11, cx1 = 20, cy0 = 11, cy1 = 20, w = 4;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const inH = (x >= cx0 && x <= cx1 && y >= cy0 + (cx1 - cx0 - w) / 2 && y <= cy1 - (cx1 - cx0 - w) / 2);
    const inV = (y >= cy0 && y <= cy1 && x >= cx0 + (cy1 - cy0 - w) / 2 && x <= cx1 - (cy1 - cy0 - w) / 2);
    if (inH || inV) setPx(x, y, 0xff, 0xff, 0xff);
  }
}

// 编码 PNG
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  let c = 0xffffffff;
  for (const b of td) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) {
  raw[y * (1 + S * 4)] = 0; // filter none
  for (let x = 0; x < S; x++) {
    const o = y * (1 + S * 4) + 1 + x * 4;
    raw[o] = px[(y * S + x) * 4];
    raw[o + 1] = px[(y * S + x) * 4 + 1];
    raw[o + 2] = px[(y * S + x) * 4 + 2];
    raw[o + 3] = px[(y * S + x) * 4 + 3];
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0))
]);

const out = path.join(__dirname, "..", "icon.png");
fs.writeFileSync(out, png);
console.log("icon written:", out, png.length, "bytes");

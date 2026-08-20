/**
 * gen-icon-ico.js — 生成多尺寸应用图标 icon.ico（16~256，PNG 内嵌 ICO）+ 高清 icon.png
 * 画法：圆角蓝底 + 白色医疗十字（苏苏洛主题），纯 Node 无外部依赖
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 生成一张 S x S 的 RGBA PNG */
function makePng(S) {
  const px = new Uint8Array(S * S * 4);
  const setPx = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // 圆角矩形判定
  const inRoundedRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };
  const R = Math.max(1, Math.round(S * 0.22)); // 圆角半径
  // 背景：圆角蓝
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inRoundedRect(x, y, 1, 1, S - 2, S - 2, R)) setPx(x, y, 0x8e, 0xc7, 0xe8);
    }
  }
  // 白色医疗十字（居中，占 38%）
  const c = S / 2;
  const arm = Math.round(S * 0.38) / 2;   // 半臂长
  const w = Math.max(1, Math.round(S * 0.14)); // 臂宽
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const inH = Math.abs(x - c) <= arm && Math.abs(y - c) <= w / 2;
      const inV = Math.abs(y - c) <= arm && Math.abs(x - c) <= w / 2;
      if (inH || inV) setPx(x, y, 0xff, 0xff, 0xff);
    }
  }
  // 编码 PNG
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const b of td) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(S * (1 + S * 4));
  for (let y = 0; y < S; y++) {
    raw[y * (1 + S * 4)] = 0;
    for (let x = 0; x < S; x++) {
      const o = y * (1 + S * 4) + 1 + x * 4;
      const i = (y * S + x) * 4;
      raw[o] = px[i]; raw[o + 1] = px[i + 1]; raw[o + 2] = px[i + 2]; raw[o + 3] = px[i + 3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** 多张 PNG 打包成 ICO（PNG 内嵌，Windows Vista+ / rcedit 均支持） */
function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(pngs.length, 4);  // count
  const entries = [];
  const datas = [];
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((png, i) => {
    const size = SIZES[i];
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // color count
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);               // planes
    e.writeUInt16LE(32, 6);              // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
    datas.push(png);
  });
  return Buffer.concat([header, ...entries, ...datas]);
}

const root = path.join(__dirname, "..");
const pngs = SIZES.map(makePng);
fs.writeFileSync(path.join(root, "icon.ico"), makeIco(pngs));
fs.writeFileSync(path.join(root, "icon.png"), makePng(128)); // 托盘图标（自动缩到 16）
console.log("icon.ico written:", path.join(root, "icon.ico"), Buffer.byteLength(makeIco(pngs)), "bytes");

/**
 * gif-frames.js — GIF 关键帧提取（基于 omggif 解码 + 自研合成/裁剪/拼接）
 * 用法：node scripts/gif-frames.js <input.gif> <output.png> [采样帧数, 默认6]
 * 输出：按不透明包围盒裁剪、放大到统一高度、白底、横向拼接的序列帧 PNG
 */
"use strict";

const fs = require("fs");
const zlib = require("zlib");
const { GifReader } = require("omggif");

/* ---------- PNG 编码 ---------- */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, W, H) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    rgba.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- 主流程 ---------- */
const input = process.argv[2];
const output = process.argv[3];
const N = parseInt(process.argv[4] || "6", 10);

const buf = fs.readFileSync(input);
const reader = new GifReader(buf);
const W = reader.width, H = reader.height;
const numFrames = reader.numFrames();

// 逐帧解码 RGBA + 处理 disposal 合成
const canvas = Buffer.alloc(W * H * 4); // 透明画布
const frames = [];
for (let i = 0; i < numFrames; i++) {
  const info = reader.frameInfo(i);
  const frame = Buffer.alloc(info.width * info.height * 4);
  reader.decodeAndBlitFrameRGBA(i, frame);
  const prev = Buffer.from(canvas);
  // 绘制
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 4;
      const a = frame[s + 3];
      if (a === 0) continue;
      const dx = info.x + x, dy = info.y + y;
      if (dx >= W || dy >= H) continue;
      const d = (dy * W + dx) * 4;
      // 半透明 alpha 混合
      const ia = 255 - a;
      canvas[d] = (frame[s] * a + canvas[d] * ia) >> 8;
      canvas[d + 1] = (frame[s + 1] * a + canvas[d + 1] * ia) >> 8;
      canvas[d + 2] = (frame[s + 2] * a + canvas[d + 2] * ia) >> 8;
      canvas[d + 3] = Math.min(255, frame[s + 3] + canvas[d + 3]);
    }
  }
  frames.push(Buffer.from(canvas));
  // disposal
  if (info.disposal === 2) {
    for (let y = info.y; y < Math.min(info.y + info.height, H); y++)
      for (let x = info.x; x < Math.min(info.x + info.width, W); x++)
        canvas.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 4);
  } else if (info.disposal === 3) {
    prev.copy(canvas);
  }
}

// 均匀采样 N 帧
const sampled = [];
for (let i = 0; i < N; i++) {
  sampled.push(frames[Math.min(frames.length - 1, Math.floor((i * frames.length) / N))]);
}

// 不透明包围盒
let minX = W, minY = H, maxX = -1, maxY = -1;
for (const fr of sampled) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (fr[(y * W + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
}
if (maxX < 0) { console.error("empty frames"); process.exit(1); }
const pad = 6;
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
const cw = maxX - minX + 1, ch = maxY - minY + 1;

// 裁剪 + 放大（最近邻）+ 白底拼接
const TARGET_H = 320;
const scale = TARGET_H / ch;
const rw = Math.max(1, Math.round(cw * scale)), rh = TARGET_H;
const gap = 4;
const stripW = N * rw + (N - 1) * gap, stripH = rh;
const strip = Buffer.alloc(stripW * stripH * 4);
for (let i = 0; i < strip.length; i += 4) { strip[i] = 255; strip[i + 1] = 255; strip[i + 2] = 255; strip[i + 3] = 255; }

sampled.forEach((fr, i) => {
  const offX = i * (rw + gap);
  for (let y = 0; y < rh; y++) {
    const sy = minY + Math.min(ch - 1, Math.floor(y / scale));
    for (let x = 0; x < rw; x++) {
      const sx = minX + Math.min(cw - 1, Math.floor(x / scale));
      const s = (sy * W + sx) * 4;
      const d = (y * stripW + offX + x) * 4;
      const a = fr[s + 3];
      if (a === 0) continue;
      const ia = 255 - a;
      strip[d] = (fr[s] * a + 255 * ia) >> 8;
      strip[d + 1] = (fr[s + 1] * a + 255 * ia) >> 8;
      strip[d + 2] = (fr[s + 2] * a + 255 * ia) >> 8;
      strip[d + 3] = 255;
    }
  }
});

fs.writeFileSync(output, encodePng(strip, stripW, stripH));
console.log(`${input} → ${output}: ${numFrames} frames, sampled ${N}, crop ${cw}x${ch} → ${stripW}x${stripH}`);

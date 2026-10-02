// 零依赖生成应用图标 PNG（渐变圆角背景 + 白色双音符），输出到 icons/。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘图 ----------
function lerp(a, b, t) { return a + (b - a) * t; }
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
  return Math.hypot(ex, ey);
}
function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x < x0 + w - r) || (y >= y0 + r && y < y0 + h - r);
}

// lucide "music" 图标按 24 栅格放大：两个符头 + 竖干 + 斜梁
function drawIcon(S, maskable) {
  const rgba = Buffer.alloc(S * S * 4);
  const u = S / 24; // 栅格单位
  const stroke = 2.4 * u / 2; // 半宽
  const sc = maskable ? 0.62 : 1; // maskable 需要安全区
  const cx = S / 2, cy = S / 2;
  const T = (x, y) => [cx + (x - 12) * u * sc, cy + (y - 12) * u * sc];
  const c1 = [0x5b, 0x5b, 0xd6], c2 = [0x8b, 0x5c, 0xf6];

  const heads = [T(6, 18), T(18, 16)];
  const headR = 3.1 * u * sc;
  const stemL = T(9, 18), stemLt = T(9, 5);
  const stemR = T(21, 16), stemRt = T(21, 3);
  const beam1 = T(9, 5), beam2 = T(21, 3);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let r, g, b, a = 255;
      if (maskable) {
        const t = (x + y) / (2 * S);
        [r, g, b] = [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
      } else {
        if (!inRoundRect(x + 0.5, y + 0.5, 0, 0, S, S, S * 0.22)) { rgba[i + 3] = 0; continue; }
        const t = (x + y) / (2 * S);
        [r, g, b] = [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
      }
      const white =
        heads.some(([hx, hy]) => (x + 0.5 - hx) ** 2 + (y + 0.5 - hy) ** 2 <= headR * headR) ||
        distToSeg(x + 0.5, y + 0.5, stemL[0], stemL[1], stemLt[0], stemLt[1]) <= stroke ||
        distToSeg(x + 0.5, y + 0.5, stemR[0], stemR[1], stemRt[0], stemRt[1]) <= stroke ||
        distToSeg(x + 0.5, y + 0.5, beam1[0], beam1[1], beam2[0], beam2[1]) <= stroke * 1.35;
      if (white) { r = g = b = 255; }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePNG(S, S, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-192.png', 192, true], ['maskable-512.png', 512, true]]) {
  fs.writeFileSync(path.join(outDir, name), drawIcon(size, maskable));
  console.log('生成', name);
}

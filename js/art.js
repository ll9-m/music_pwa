// 封面：按专辑懒提取 → 256px 缩略图存 IndexedDB → 内存对象 URL 缓存
import * as db from './db.js';
import { getFile } from './scanner.js';

// 元数据解析器（26KB）按需加载：不扫描时完全不进启动路径
let _extractPicture = null;
async function extractPicture(file, ext) {
  if (!_extractPicture) {
    const mod = await import('./metadata.js');
    _extractPicture = mod.extractPicture;
  }
  return _extractPicture(file, ext);
}

const mem = new Map();      // albumKey -> objectURL | ''(无封面)
const pending = new Map();  // albumKey -> Promise
const LRU = [];
const LRU_MAX = 160;

function touch(key, url) {
  const i = LRU.indexOf(key);
  if (i >= 0) LRU.splice(i, 1);
  LRU.push(key);
  if (LRU.length > LRU_MAX) {
    const old = LRU.shift();
    const u = mem.get(old);
    if (u && u !== 'none') URL.revokeObjectURL(u);
    mem.delete(old);
  }
}

export function cachedArt(key) {
  return mem.get(key);
}

// 返回 { url } 或 null
export async function getArt(albumKey, rel, ext) {
  if (!albumKey) return null;
  if (mem.has(albumKey)) {
    const u = mem.get(albumKey);
    touch(albumKey, u);
    return u === 'none' ? null : { url: u };
  }
  if (pending.has(albumKey)) {
    const r = await pending.get(albumKey);
    return r;
  }
  const p = (async () => {
    // 1. IDB 缩略图
    try {
      const rec = await db.getArt(albumKey);
      if (rec && rec.blob) {
        const url = URL.createObjectURL(rec.blob);
        mem.set(albumKey, url); touch(albumKey, url);
        return { url };
      }
    } catch { /* 忽略 */ }
    // 2. 从文件提取
    try {
      const file = await getFile(rel);
      if (file) {
        const pic = await extractPicture(file, ext);
        if (pic) {
          const thumb = await makeThumb(pic);
          const blob = thumb || pic;
          try { await db.putArt(albumKey, blob); } catch { /* 存储满则仅内存 */ }
          const url = URL.createObjectURL(blob);
          mem.set(albumKey, url); touch(albumKey, url);
          return { url };
        }
      }
    } catch (e) {
      console.warn('封面提取失败', rel, e);
    }
    mem.set(albumKey, 'none'); touch(albumKey, 'none');
    return null;
  })();
  pending.set(albumKey, p);
  const r = await p;
  pending.delete(albumKey);
  return r;
}

async function makeThumb(pic) {
  try {
    const bmp = await createImageBitmap(pic.blob || pic);
    const max = 256;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    bmp.close();
    return blob.type === 'image/webp' ? blob : null;
  } catch {
    return null;
  }
}

// 主色（用于正在播放界面氛围色）
const colorCache = new Map();
export async function dominantColor(albumKey, url) {
  if (!url) return null;
  if (colorCache.has(albumKey)) return colorCache.get(albumKey);
  try {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const s = 12;
    const canvas = new OffscreenCanvas(s, s);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, s, s);
    bmp.close();
    const d = ctx.getImageData(0, 0, s, s).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) return null;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    // 提升饱和度（围绕中性灰拉伸），并保证不至于过暗
    const sat = (c) => Math.max(0, Math.min(255, Math.round(128 + (c - 128) * 1.5)));
    let r2 = sat(r), g2 = sat(g), b2 = sat(b);
    if (Math.max(r2, g2, b2) < 70) { r2 += 55; g2 += 45; b2 += 70; }
    const col = `rgb(${Math.min(255, r2)}, ${Math.min(255, g2)}, ${Math.min(255, b2)})`;
    colorCache.set(albumKey, col);
    return col;
  } catch {
    return null;
  }
}

export function invalidateArt() {
  for (const [k, u] of mem) if (u !== 'none') URL.revokeObjectURL(u);
  mem.clear(); LRU.length = 0; colorCache.clear();
}

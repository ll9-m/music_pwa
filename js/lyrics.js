// LRC 歌词解析与同步渲染
export function parseLRC(text) {
  if (!text) return [];
  const lines = [];
  let offsetMs = 0;
  const om = text.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im);
  if (om) offsetMs = parseInt(om[1], 10);

  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    let content = raw.replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const m of stamps) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] || '0';
      const frac = parseInt(fracRaw, 10) / 10 ** fracRaw.length;
      const t = min * 60 + sec + frac - offsetMs / 1000;
      lines.push({ t: Math.max(0, t), text: content });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  // 去重（同一时间多行合并）
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - l.t) < 0.01) { if (l.text && !prev.text) prev.text = l.text; continue; }
    out.push(l);
  }
  return out;
}

// ---------- KRC（酷狗加密歌词）解码 ----------
// 文件结构：4 字节魔数 "krc1" + 逐字节 XOR 加密的 zlib 数据
// key 有两套写法，酷狗官方缓存的 krc 用第一套；都试一遍，兼容性更好
const KRC_KEYS = [
  [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105],
  [0x46, 0xAB, 0x4D, 0x63, 0xCD, 0x48, 0x2D, 0x59, 0x50, 0x6B, 0xCE, 0x2E, 0x6B, 0x5A, 0xBE, 0xCA],
];

async function inflateZlib(u8) {
  const ds = new DecompressionStream('deflate'); // zlib 格式
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

export async function decodeKRC(buf) {
  // 拷贝一份再解，不修改调用方持有的缓冲区
  const src = new Uint8Array(buf);
  if (src.length > 4 && src[0] === 0x6b && src[1] === 0x72 && src[2] === 0x63 && src[3] === 0x31) {
    const payload = src.subarray(4);
    for (const key of KRC_KEYS) {
      const u8 = new Uint8Array(payload);
      for (let i = 0; i < u8.length; i++) u8[i] ^= key[i % 16];
      try {
        const text = await inflateZlib(u8);
        if (text) return text;
      } catch { /* 换下一套 key */ }
    }
    return null;
  }
  // 非加密文件（个别工具导出的明文 krc / 其实是 lrc）：按文本读
  try { return new TextDecoder().decode(src); } catch { return null; }
}

// 解析 KRC 明文内容：行格式 [起始ms,时长ms]歌词<字起始,字时长,0>字…
// 翻译行为内容以 "/" 开头的同时间行，合并进上一行
export function parseKRC(text) {
  if (!text) return [];
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*\[(\d+),(\d+)\](.*)$/);
    if (!m) continue; // [language:..] 等元数据行直接跳过
    const t = parseInt(m[1], 10) / 1000;
    let content = m[3].replace(/<\d+,\d+,\d+>/g, '').trim();
    if (content.startsWith('/')) {
      const prev = lines[lines.length - 1];
      if (prev) prev.text = (prev.text ? prev.text + ' ' : '') + content.slice(1).trim();
      continue;
    }
    lines.push({ t: Math.max(0, t), text: content });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

// 统一入口：自动识别 LRC / KRC
export function parseLyrics(text) {
  if (!text) return [];
  if (/^\s*\[\d+,\d+\]/m.test(text)) return parseKRC(text);
  return parseLRC(text);
}

// 返回当前应高亮的行号（二分）
export function activeLine(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

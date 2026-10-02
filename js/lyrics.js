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

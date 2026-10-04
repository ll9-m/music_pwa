// 用与应用完全相同的匹配算法，离线分析真实音乐目录（只读，不修改任何文件）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'D:/kugou';
const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm']);
const extOf = (n) => { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i + 1).toLowerCase() : ''; };
const isAudio = (n) => AUDIO_EXTS.has(extOf(n));
const isLyric = (n) => extOf(n) === 'lrc' || extOf(n) === 'krc';
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => (rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel);

// ↓↓↓ 与 js/scanner.js 保持一致 ↓↓↓
const KUGOU_HASH = /-[0-9a-f]{32}-\d+-[0-9a-f]{8}$/;
const KUGOU_HASH2 = /-[0-9a-f]{32}$/;
function normKey(s) {
  let x = String(s || '').trim().toLowerCase();
  x = x.replace(KUGOU_HASH, '').replace(KUGOU_HASH2, '');
  return x.replace(/\s+/g, ' ').trim();
}
function titleKeyOf(rel) {
  const name = nameOf(rel);
  const i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  const p = base.indexOf(' - ');
  return normKey(p >= 0 ? base.slice(p + 3) : base);
}
function pickBest(cands, dir) {
  if (!cands || !cands.length) return null;
  const same = cands.find(c => c.dir === dir);
  if (same) return same.rel;
  const lrc = cands.find(c => c.ext === 'lrc');
  return (lrc || cands[0]).rel;
}
// ↑↑↑

const lyricFiles = new Map(), lyricTitles = new Map();
function registerLyricFile(rel) {
  const entry = { rel, dir: dirOf(rel), ext: extOf(rel) };
  const name = nameOf(rel);
  const i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  const key = normKey(base);
  (lyricFiles.get(key) || lyricFiles.set(key, []).get(key)).push(entry);
  const tk = titleKeyOf(rel);
  if (tk && tk !== key) (lyricTitles.get(tk) || lyricTitles.set(tk, []).get(tk)).push(entry);
}
function matchLyricFor(rel) {
  const dir = dirOf(rel);
  const name = nameOf(rel);
  const i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  return pickBest(lyricFiles.get(normKey(base)), dir) || pickBest(lyricTitles.get(titleKeyOf(rel)), dir);
}

// 收集文件（相对路径）
const audios = [], lyrics = [];
(function walk(dir, prefix = '', depth = 0) {
  if (depth > 6) return;
  for (const name of fs.readdirSync(dir)) {
    const media = isAudio(name) || isLyric(name);
    if (name.startsWith('.') && !media) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    let st; try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (st.isDirectory()) walk(path.join(dir, name), rel, depth + 1);
    else if (isAudio(name)) audios.push(rel);
    else if (isLyric(name)) lyrics.push(rel);
  }
})(ROOT);

lyrics.forEach(registerLyricFile);

let exact = 0, fallback = 0; const gains = [], none = [];
for (const rel of audios) {
  const hit = matchLyricFor(rel);
  if (!hit) { none.push(rel); continue; }
  const name = nameOf(rel), i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  if (pickBest(lyricFiles.get(normKey(base)), dirOf(rel))) exact++;
  else { fallback++; gains.push(`${name}  ←  ${nameOf(hit)}`); }
}
console.log(`目录: ${ROOT}`);
console.log(`音频 ${audios.length} 首 | 歌词 ${lyrics.length} 个`);
console.log(`文件名精确匹配: ${exact}`);
console.log(`歌名兜底命中: ${fallback}`);
console.log(`确实没有歌词: ${none.length}`);
if (gains.length) { console.log('\n兜底命中:'); gains.slice(0, 10).forEach(x => console.log('  ', x)); }
if (none.length) { console.log('\n没有歌词文件的歌曲(前15):'); none.slice(0, 15).forEach(x => console.log('  ', x)); }

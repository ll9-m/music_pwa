// 孤儿歌词扫描（只读）：列出 Lyric/ 等目录下没有对应音频文件的歌词文件
// 用法: node scripts/find-orphan-lyrics.mjs <音乐根目录>
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'D:/kugou';
const AUDIO = new Set(['mp3', 'flac', 'm4a', 'wav', 'ogg', 'aac', 'ape', 'wma', 'opus']);
const LYRIC = new Set(['krc', 'lrc']);
const MAX_DEPTH = 6;

const extOf = (n) => { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i + 1).toLowerCase() : ''; };
const baseOf = (n) => { const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(0, i) : n; };

// 酷狗哈希后缀: -<32hex>-<数字>-<8hex>
const HASH1 = /-[0-9a-f]{32}-\d+-[0-9a-f]{8}$/i;
const HASH2 = /-[0-9a-f]{32}$/i;
const norm = (s) => s.trim().toLowerCase().replace(HASH1, '').replace(HASH2, '').replace(/\s+/g, ' ');
const titleOf = (base) => { const i = base.indexOf(' - '); return i >= 0 ? base.slice(i + 3).trim() : base; };
const normTitle = (s) => norm(s).replace(/[-－]/g, ' ').split(/[(（]/)[0].trim();

const audios = [];
const lyrics = [];
(function walk(dir, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p, depth + 1); continue; }
    const e = extOf(n);
    if (AUDIO.has(e)) audios.push(p);
    else if (LYRIC.has(e)) lyrics.push({ path: p, size: st.size, ext: e });
  }
})(ROOT);

const exactKeys = new Set(audios.map(p => norm(baseOf(path.basename(p)))));
const titleKeys = new Set(audios.map(p => normTitle(titleOf(baseOf(path.basename(p))))));

const orphan = [];
const kept = [];
for (const l of lyrics) {
  const base = baseOf(path.basename(l.path));
  if (exactKeys.has(norm(base))) { kept.push(l); continue; }
  const t = normTitle(titleOf(base));
  if (t && titleKeys.has(t)) { kept.push(l); continue; }
  orphan.push(l);
}

const mb = (b) => (b / 1048576).toFixed(2);
console.log('根目录:', ROOT);
console.log('音频文件:', audios.length);
console.log('歌词文件:', lyrics.length);
console.log('有对应音频(保留):', kept.length);
console.log('孤儿歌词(可删):', orphan.length, ' 占用', mb(orphan.reduce((s, x) => s + x.size, 0)), 'MB');

const out = path.resolve('orphan-lyrics-report.txt');
const lines = orphan.map(l => l.path);
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('\n完整清单已写入:', out);
console.log('\n前 20 条预览:');
for (const l of orphan.slice(0, 20)) console.log('  ', l.path.replace(ROOT + path.sep, ''));
if (orphan.length > 20) console.log('   ... 其余', orphan.length - 20, '条见清单文件');

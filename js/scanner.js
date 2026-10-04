// 音乐文件夹扫描：FSA 目录句柄 / webkitdirectory 文件列表 两种来源
// 增量扫描：与 IndexedDB 中记录对比，只解析新增/变更文件
import * as db from './db.js';
import { decodeKRC } from './lyrics.js';

// 元数据解析器按需加载（首次扫描时才拉取），避免拖慢启动
let _parseTrackMeta = null;
async function parseMeta(file, ext, opts) {
  if (!_parseTrackMeta) {
    const mod = await import('./metadata.js');
    _parseTrackMeta = mod.parseTrackMeta;
  }
  return _parseTrackMeta(file, ext, opts);
}

export const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm']);
const SKIP_DIRS = new Set(['system volume information', '$recycle.bin', 'recycled', 'lost.dir', 'node_modules']);

export const state = {
  mode: null,        // 'fsa' | 'files'
  root: null,        // FileSystemDirectoryHandle (fsa)
  files: new Map(),  // rel -> File (files 模式)
  name: '',
  scanning: false,
  lrcMap: new Map(),     // audioRel -> lyricRel
  lyricFiles: new Map(), // 歌名/文件名 key -> [{rel,dir,ext}] 全局歌词索引
  lyricTitles: new Map(),// 仅歌名 key（忽略歌手前缀）-> [{rel,dir,ext}]
};

const dirCache = new Map();
let progressCb = null;
export const onProgress = (cb) => { progressCb = cb; };
const report = (phase, done, total) => { try { progressCb && progressCb({ phase, done, total }); } catch { } };

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
};
const baseOf = (name) => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
};
export const isAudio = (name) => AUDIO_EXTS.has(extOf(name));
export const albumKeyOf = (t) => `${(t.albumArtist || t.artist || '').toLowerCase().trim()}::${(t.album || '').toLowerCase().trim()}`;

// ---------- 来源设置 ----------
export async function setFsaRoot(handle, { persist = true } = {}) {
  state.mode = 'fsa';
  state.root = handle;
  state.name = handle.name || '已选择的文件夹';
  dirCache.clear();
  if (persist) await db.putHandle('musicDir', handle);
}

export function setFiles(fileList) {
  state.mode = 'files';
  state.root = null;
  state.files = new Map();
  state.name = '（本次会话的文件夹）';
  for (const f of fileList) {
    const relPath = f.webkitRelativePath || f.name;
    // 去掉第一段（所选文件夹名）
    const parts = relPath.split('/');
    const rel = parts.length > 1 ? parts.slice(1).join('/') : relPath;
    if (isAudio(rel) || extOf(rel) === 'lrc' || extOf(rel) === 'krc') state.files.set(rel, f);
  }
}

// ---------- 歌词匹配 ----------
const isLyric = (name) => extOf(name) === 'lrc' || extOf(name) === 'krc';
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => (rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel);

// 酷狗 KRC 命名：歌名-<32位hex>-<数字>-<8位hex>.krc，匹配前必须剥掉
const KUGOU_HASH = /-[0-9a-f]{32}-\d+-[0-9a-f]{8}$/;
const KUGOU_HASH2 = /-[0-9a-f]{32}$/;
function normKey(s) {
  let x = String(s || '').trim().toLowerCase();
  x = x.replace(KUGOU_HASH, '').replace(KUGOU_HASH2, '');
  return x.replace(/\s+/g, ' ').trim();
}
// 「歌手 - 歌名」取歌名部分，用于兜底（歌手前缀不一致时仍能配上）
function titleKeyOf(rel) {
  const name = nameOf(rel);
  const i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  const p = base.indexOf(' - ');
  return normKey(p >= 0 ? base.slice(p + 3) : base);
}

// 把歌词文件登记进全局索引（支持 Lyric/ 这类独立歌词目录）
function registerLyricFile(rel) {
  const entry = { rel, dir: dirOf(rel), ext: extOf(rel) };
  const name = nameOf(rel);
  const i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  const key = normKey(base);
  const list = state.lyricFiles.get(key);
  if (list) list.push(entry); else state.lyricFiles.set(key, [entry]);
  const tk = titleKeyOf(rel);
  if (tk && tk !== key) {
    const tl = state.lyricTitles.get(tk);
    if (tl) tl.push(entry); else state.lyricTitles.set(tk, [entry]);
  }
}

// 从候选里挑最优：同目录优先 → .lrc 优先于 .krc
function pickBest(cands, dir) {
  if (!cands || !cands.length) return null;
  const same = cands.find(c => c.dir === dir);
  if (same) return same.rel;
  const lrc = cands.find(c => c.ext === 'lrc');
  return (lrc || cands[0]).rel;
}

// 为歌曲找歌词：文件名精确匹配（去酷狗哈希后缀）→ 歌名兜底（忽略歌手前缀）
function matchLyricFor(rel) {
  const dir = dirOf(rel);
  const name = nameOf(rel);
  const i = name.lastIndexOf('.');
  const base = i >= 0 ? name.slice(0, i) : name;
  return pickBest(state.lyricFiles.get(normKey(base)), dir)
    || pickBest(state.lyricTitles.get(titleKeyOf(rel)), dir);
}

// ---------- 遍历 ----------
async function* walkFsa(dir, prefix = '', depth = 0) {
  if (depth > 12) return;
  const entries = [];
  try {
    for await (const [name, h] of dir.entries()) {
      // 点开头的隐藏文件默认跳过，但音频/歌词文件例外（酷狗会导出这类名字）
      const media = isAudio(name) || isLyric(name);
      if (name.startsWith('.') && !media) continue;
      if (h.kind === 'directory' && SKIP_DIRS.has(name.toLowerCase())) continue;
      entries.push([name, h]);
    }
  } catch (e) {
    console.warn('目录读取失败', prefix, e);
    return;
  }
  for (const [name, h] of entries) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'file') {
      if (isLyric(name)) registerLyricFile(rel);
      if (isAudio(name)) yield rel;
    } else if (h.kind === 'directory') {
      yield* walkFsa(h, rel, depth + 1);
    }
  }
}

export async function scan() {
  if (state.scanning) return { added: 0, updated: 0, removed: 0, failed: 0 };
  if (state.mode === 'fsa' && !state.root) return { added: 0, updated: 0, removed: 0, failed: 0 };
  if (state.mode === 'files' && state.files.size === 0 && !state.root) return { added: 0, updated: 0, removed: 0, failed: 0 };
  state.scanning = true;
  report('collect', 0, 0);
  try {
    // 1. 收集文件（歌词先进全局索引，走完再统一匹配，支持跨目录）
    const found = new Map(); // rel -> {file?, handle?}
    state.lrcMap = new Map();
    state.lyricFiles = new Map();
    state.lyricTitles = new Map();
    if (state.mode === 'fsa') {
      for await (const rel of walkFsa(state.root)) {
        found.set(rel, {});
      }
    } else {
      for (const rel of state.files.keys()) {
        if (isLyric(rel)) registerLyricFile(rel);
      }
      for (const rel of state.files.keys()) {
        if (isAudio(rel)) found.set(rel, {});
      }
    }
    for (const rel of found.keys()) {
      state.lrcMap.set(rel, matchLyricFor(rel));
    }

    // 2. 与数据库对比
    const existing = await db.getAllTracks();
    const existingMap = new Map(existing.map(t => [t.rel, t]));
    const toParse = [];
    const removed = [];
    for (const rel of found.keys()) {
      if (!existingMap.has(rel)) toParse.push({ rel, isNew: true });
    }
    for (const t of existing) {
      if (!found.has(t.rel)) removed.push(t.rel);
    }

    let done = 0, failed = 0;
    const changed = [];
    const CONCURRENCY = 4;
    let cursor = 0;
    report('parse', 0, toParse.length);

    async function worker() {
      while (cursor < toParse.length) {
        const item = toParse[cursor++];
        try {
          const file = await getFile(item.rel);
          if (!file) { failed++; continue; }
          const meta = await parseMeta(file, extOf(item.rel));
          const old = existingMap.get(item.rel);
          const name = item.rel.split('/').pop();
          const base = name.replace(/\.[^.]+$/, '');
          // 无标签时按 "歌手 - 标题" 或文件名
          let title = meta.title, artist = meta.artist;
          if (!title && !artist) {
            const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
            if (m) { artist = m[1].trim(); title = m[2].trim(); }
          }
          if (!title) title = base;
          const track = {
            rel: item.rel,
            sig: `${file.size}|${file.lastModified || 0}`,
            name,
            title,
            artist: artist || '未知歌手',
            album: meta.album || '未知专辑',
            albumArtist: meta.albumArtist || undefined,
            trackNo: meta.trackNo ?? undefined,
            discNo: meta.discNo ?? undefined,
            year: meta.year ?? undefined,
            genre: meta.genre || undefined,
            duration: meta.duration ?? undefined,
            hasArt: undefined,
            lrc: state.lrcMap.get(item.rel) || undefined,
            addedAt: old ? old.addedAt : Date.now(),
            liked: old ? old.liked : false,
            playCount: old ? old.playCount : 0,
            lastPlayed: old ? old.lastPlayed : undefined,
          };
          track.albumKey = albumKeyOf(track);
          changed.push(track);
        } catch (e) {
          console.warn('解析失败', item.rel, e);
          failed++;
        }
        done++;
        if (done % 5 === 0 || done === toParse.length) report('parse', done, toParse.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toParse.length || 1) }, worker));

    // 3. 写库
    await db.bulkPutTracks(changed);
    if (removed.length) await db.deleteTracks(removed);

    // 4. 清理孤儿封面
    try {
      const kept = new Set(changed.map(t => t.albumKey));
      const all = await db.getAllTracks();
      for (const t of all) kept.add(t.albumKey);
      const artKeys = await db.getAllArtKeys();
      const orphan = artKeys.filter(k => !kept.has(k));
      if (orphan.length) await db.deleteArt(orphan);
    } catch { /* 非关键 */ }

    report('done', 1, 1);
    return { added: toParse.length, updated: 0, removed: removed.length, failed };
  } finally {
    state.scanning = false;
  }
}

// ---------- 文件访问 ----------
export async function getFile(rel) {
  if (state.mode === 'files') return state.files.get(rel) || null;
  if (state.mode === 'fsa' && state.root) {
    const parts = rel.split('/');
    const fileName = parts.pop();
    let dir = state.root;
    for (const p of parts) {
      const key = (dir === state.root ? '' : dirCache.get(dir) || '') + '/' + p;
      let h = dirCache.get(key);
      if (!h) {
        h = await dir.getDirectoryHandle(p);
        dirCache.set(key, h);
      }
      dir = h;
    }
    const fh = await dir.getFileHandle(fileName);
    return fh.getFile();
  }
  return null;
}

export async function getLrcText(rel) {
  // 候选：扫描记录的歌词 → 全局歌词索引（跨目录）→ 同名 .lrc / .krc
  const cands = [];
  const mapped = state.lrcMap.get(rel) || matchLyricFor(rel);
  if (mapped) cands.push(mapped);
  const i = rel.lastIndexOf('.');
  const base = i >= 0 ? rel.slice(0, i) : rel;
  for (const c of [base + '.lrc', base + '.krc']) {
    if (!cands.includes(c)) cands.push(c);
  }
  for (const lrcRel of cands) {
    if (state.mode === 'files' && !state.files.has(lrcRel)) continue;
    try {
      const f = await getFile(lrcRel);
      if (!f) continue;
      if (extOf(lrcRel) === 'krc') {
        const text = await decodeKRC(await f.arrayBuffer());
        if (text) return text;
        continue;
      }
      return await f.text();
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

// ---------- 启动恢复 ----------
export async function restoreSavedRoot() {
  try {
    const rec = await db.getHandle('musicDir');
    if (rec && rec.handle && typeof rec.handle.queryPermission === 'function') {
      const perm = await rec.handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') {
        await setFsaRoot(rec.handle, { persist: false });
        return 'granted';
      }
      state.savedHandle = rec.handle;
      return perm; // 'prompt' | 'denied'
    }
  } catch (e) {
    console.warn('恢复文件夹句柄失败', e);
  }
  return null;
}

export async function authorizeSavedHandle() {
  const h = state.savedHandle;
  if (!h) return false;
  const perm = await h.requestPermission({ mode: 'read' });
  if (perm === 'granted') {
    await setFsaRoot(h, { persist: false });
    state.savedHandle = null;
    return true;
  }
  return false;
}

export function hasSource() {
  return (state.mode === 'fsa' && state.root) || (state.mode === 'files' && state.files.size > 0);
}

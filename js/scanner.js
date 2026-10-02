// 音乐文件夹扫描：FSA 目录句柄 / webkitdirectory 文件列表 两种来源
// 增量扫描：与 IndexedDB 中记录对比，只解析新增/变更文件
import * as db from './db.js';
import { parseTrackMeta } from './metadata.js';

export const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm']);
const SKIP_DIRS = new Set(['system volume information', '$recycle.bin', 'recycled', 'lost.dir', 'node_modules']);

export const state = {
  mode: null,        // 'fsa' | 'files'
  root: null,        // FileSystemDirectoryHandle (fsa)
  files: new Map(),  // rel -> File (files 模式)
  name: '',
  scanning: false,
  lrcMap: new Map(), // audioRel -> lrcRel
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
    if (isAudio(rel) || extOf(rel) === 'lrc') state.files.set(rel, f);
  }
}

// ---------- 遍历 ----------
async function* walkFsa(dir, prefix = '', depth = 0) {
  if (depth > 12) return;
  const entries = [];
  try {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || (h.kind === 'directory' && SKIP_DIRS.has(name.toLowerCase()))) continue;
      entries.push([name, h]);
    }
  } catch (e) {
    console.warn('目录读取失败', prefix, e);
    return;
  }
  const lrcNames = new Set(entries.filter(([n, h]) => h.kind === 'file' && extOf(n) === 'lrc').map(([n]) => baseOf(n)));
  for (const [name, h] of entries) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'file') {
      if (isAudio(name)) {
        const lrcRel = lrcNames.has(baseOf(name)) ? baseOf(rel) + '.lrc' : null;
        state.lrcMap.set(rel, lrcRel);
        yield rel;
      }
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
    // 1. 收集文件
    const found = new Map(); // rel -> {file?, handle?}
    if (state.mode === 'fsa') {
      state.lrcMap = new Map();
      for await (const rel of walkFsa(state.root)) {
        found.set(rel, {});
      }
    } else {
      state.lrcMap = new Map();
      const basenames = new Set([...state.files.keys()].filter(r => extOf(r) === 'lrc').map(r => baseOf(r)));
      for (const rel of state.files.keys()) {
        if (isAudio(rel)) {
          const lrcRel = basenames.has(baseOf(rel)) ? baseOf(rel) + '.lrc' : null;
          state.lrcMap.set(rel, lrcRel);
          found.set(rel, {});
        }
      }
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
          const meta = await parseTrackMeta(file, extOf(item.rel));
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
  let lrcRel = state.lrcMap.get(rel);
  if (!lrcRel) {
    // 兜底：直接尝试同名 .lrc（未经扫描的会话也能显示歌词）
    const i = rel.lastIndexOf('.');
    lrcRel = (i >= 0 ? rel.slice(0, i) : rel) + '.lrc';
    if (state.mode === 'files' && !state.files.has(lrcRel)) return null;
  }
  try {
    const f = await getFile(lrcRel);
    if (!f) return null;
    return await f.text();
  } catch { return null; }
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

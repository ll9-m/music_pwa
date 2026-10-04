// IndexedDB 封装：tracks / art / playlists / handles / kv / anime
const DB_NAME = 'local-music-pwa';
const DB_VERSION = 2;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'rel' });
      if (!db.objectStoreNames.contains('art')) db.createObjectStore('art', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      // v2：番剧库。keyPath 用 id 而非 rel —— 番剧与音频文件无关，
      // 重新扫描音乐文件夹不该影响它，所以刻意不进 tracks 表。
      if (!db.objectStoreNames.contains('anime')) db.createObjectStore('anime', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  }));
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ---- tracks ----
export const getAllTracks = () => tx('tracks', 'readonly', s => wrap(s.getAll()));
export const getTrack = (rel) => tx('tracks', 'readonly', s => wrap(s.get(rel)));
export const putTrack = (t) => tx('tracks', 'readwrite', s => s.put(t));
export const bulkPutTracks = (list) => tx('tracks', 'readwrite', s => { for (const t of list) s.put(t); });
export const deleteTracks = (rels) => tx('tracks', 'readwrite', s => { for (const r of rels) s.delete(r); });
export const clearTracks = () => tx('tracks', 'readwrite', s => s.clear());

// ---- art (封面缩略图) ----
export const getArt = (key) => tx('art', 'readonly', s => wrap(s.get(key)));
export const putArt = (key, blob) => tx('art', 'readwrite', s => s.put({ key, blob }));
export const deleteArt = (keys) => tx('art', 'readwrite', s => { for (const k of keys) s.delete(k); });
export const clearArt = () => tx('art', 'readwrite', s => s.clear());
export const getAllArtKeys = () => tx('art', 'readonly', s => wrap(s.getAllKeys()));

// ---- playlists ----
export const getPlaylists = () => tx('playlists', 'readonly', s => wrap(s.getAll()));
export const putPlaylist = (p) => tx('playlists', 'readwrite', s => s.put(p));
export const deletePlaylist = (id) => tx('playlists', 'readwrite', s => s.delete(id));

// ---- handles (文件夹句柄持久化) ----
export const getHandle = (key) => tx('handles', 'readonly', s => wrap(s.get(key)));
export const putHandle = (key, handle) => tx('handles', 'readwrite', s => s.put({ key, handle }));

// ---- kv (播放状态等) ----
export const kvGet = (k) => tx('kv', 'readonly', s => wrap(s.get(k)).then(r => r ? r.v : undefined));
export const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put({ k, v }));

// ---- anime (番剧库) ----
export const getAllAnime = () => tx('anime', 'readonly', s => wrap(s.getAll()));
export const getAnime = (id) => tx('anime', 'readonly', s => wrap(s.get(id)));
export const putAnime = (a) => tx('anime', 'readwrite', s => s.put(a));
export const bulkPutAnime = (list) => tx('anime', 'readwrite', s => { for (const a of list) s.put(a); });
export const deleteAnime = (id) => tx('anime', 'readwrite', s => s.delete(id));
export const clearAnime = () => tx('anime', 'readwrite', s => s.clear());

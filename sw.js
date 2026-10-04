// Service Worker：预缓存应用外壳，离线可用（音乐文件本身通过 File System Access 读取，不走网络）
// 缓存版本号：改动任何被缓存的资源后必须 +1，否则用户会继续用旧缓存（上一版把 v2 用在了
// 首次引入 lyrics.js 时，这次新增 bili.js 同样必须升版）。
const CACHE = 'local-music-pwa-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/db.js',
  './js/prefs.js',
  './js/ui.js',
  './js/metadata.js',
  './js/scanner.js',
  './js/art.js',
  './js/player.js',
  './js/eq.js',
  './js/lyrics.js',
  './js/views.js',
  './js/np.js',
  // 番剧库：B 站链接解析。漏掉它的话，离线状态下 views.js 的 import 会失败 ——
  // 不是「番剧页打不开」，而是整个应用白屏（ES module 加载失败会中断整条 import 链）。
  './js/bili.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  // 导航请求：网络优先，失败回退缓存（保证更新及时 + 离线可用）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

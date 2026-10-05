// 零依赖静态服务器：node server.js [port]
// 提供正确的 MIME 与 Range 支持（PWA 需要 localhost 或 HTTPS 才能安装/使用文件夹授权）。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
  '.lrc': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};


const server = http.createServer((req, res) => {
  try {
    const parsed = new URL(req.url, 'http://x');
    let urlPath = decodeURIComponent(parsed.pathname);

    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // 目录逃逸防护。
    // 两个要点，缺一不可：
    // 1) path.resolve 而非 path.join —— 后者遇到绝对路径会直接丢弃 ROOT
    //    （path.join('/a/b', '/etc/passwd') === '/a/b/etc/passwd'，而 resolve 会得到 '/etc/passwd'）。
    // 2) startsWith(ROOT + path.sep) 而非 startsWith(ROOT) —— 后者会把
    //    同前缀的兄弟目录（如 /app-backup）误判为「在 ROOT 内」而放行。
    const filePath = path.resolve(ROOT, '.' + path.sep + urlPath);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    // Windows 大小写不敏感：拒绝时统一比一遍，避免 c:\app vs C:\APP 绕过
    if (process.platform === 'win32') {
      const a = filePath.toLowerCase();
      const b = (ROOT + path.sep).toLowerCase();
      if (filePath !== ROOT && !a.startsWith(b)) { res.writeHead(403); return res.end('Forbidden'); }
    }

    let stat;
    try { stat = fs.statSync(filePath); } catch { res.writeHead(404); return res.end('Not Found'); }
    if (stat.isDirectory()) { res.writeHead(404); return res.end('Not Found'); }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    // service worker 必须不缓存，否则更新会延迟
    const headers = {
      'Content-Type': type,
      'Cache-Control': path.basename(filePath) === 'sw.js' ? 'no-cache' : 'no-cache',
      'Accept-Ranges': 'bytes',
    };

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || start > end || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    res.writeHead(500);
    res.end('Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`本地音乐播放器已启动:  http://localhost:${PORT}`);
  console.log('按 Ctrl+C 停止。PWA 的文件夹授权、离线缓存均要求通过 localhost/HTTPS 访问。');
});

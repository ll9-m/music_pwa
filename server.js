// 零依赖静态服务器 + B 站番剧元数据代理：node server.js [port]
// 提供正确的 MIME 与 Range 支持（PWA 需要 localhost 或 HTTPS 才能安装/使用文件夹授权）。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

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

// ---- B 站番剧元数据代理 ----
// 为什么需要它：api.bilibili.com 对跨域直连返回 403（风控），
// 浏览器里无法把 ss/ep/av 号解析成播放器要的 bvid。
// 放在本地服务器里代取是唯一不依赖第三方服务、也不外泄用户粘贴内容的做法。
//
// 边界（重要）：
//   仅监听回环地址，不对外暴露；只接受 ss / ep / av 三种数字 id，
//   绝不接受任意 URL 转发，避免被当成开放代理滥用。
//   线上 GitHub Pages 版没有这个接口，前端会自动降级为「跳转官方」。
const BILI_API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        // B 站接口要求带来源，否则 412
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json, text/plain, */*',
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let buf = '';
      res.setEncoding('utf8');
      // 只读前 2MB，防止异常响应打爆内存
      res.on('data', (c) => { buf += c; if (buf.length > 2 * 1024 * 1024) { req.destroy(); } });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function pickEpisodes(list) {
  return (list || []).map((e) => ({
    ep: e.ep_id,
    title: String(e.title || '').trim(),
    bvid: e.bvid || '',
    cid: e.cid || 0,
  }));
}

async function handleBili(q, res) {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  // 严格解析：只接受纯十进制数字串。
  // 不能用 Number() —— Number('1e5') === 100000、Number(' 12 ') === 12、
  // Number('0x10') === 16，都会把「看起来不是 id」的东西变成合法 id 放行。
  // 这不是洁癖：一旦放过非数字串，就能把它拼进下游 URL 变成参数注入。
  const strictInt = (s) => (s != null && /^\d{1,12}$/.test(s) ? Number(s) : 0);

  const ss = strictInt(q.get('ss'));
  const ep = strictInt(q.get('ep'));
  const av = strictInt(q.get('av'));
  // 路由必须存在：即使参数无效也要回 200/JSON，前端据此判断「本地服务在跑」
  if (!ss && !ep && !av) return send(400, { error: '缺少 ss / ep / av 参数' });
  // 只允许正整数，杜绝把任意路径塞进下游 URL
  if ([ss, ep, av].some((n) => n && (!Number.isInteger(n) || n <= 0))) {
    return send(400, { error: '参数必须为正整数' });
  }

  try {
    if (ss) {
      const j = await fetchJSON(`${BILI_API}/pgc/view/web/season?season_id=${ss}`);
      const r = j && j.result;
      if (!r || !r.episodes || !r.episodes.length) return send(404, { error: '未查到该番剧' });
      const first = r.episodes[0];
      return send(200, {
        title: r.title || '',
        cover: (r.cover || '').replace(/^http:/, 'https:'),
        bvid: first.bvid || '',
        cid: first.cid || 0,
        currentIndex: 0,
        episodes: pickEpisodes(r.episodes),
      });
    }
    if (ep) {
      // 实测结论（不要改回下面这行）：
      //   pgc/view/web/view?ep_id=  与  pgc/view/pgc?ep_id=  均已返回 HTML 错误页（端点下线/需登录），
      //   pgc/review/user?ep_id=     返回 code:-400。
      //   唯一稳定可用的是 season 端点同时接受 ep_id，直接返回整部番剧的 episodes。
      const j = await fetchJSON(`${BILI_API}/pgc/view/web/season?ep_id=${ep}`);
      const r = j && j.result;
      if (!r || !r.episodes || !r.episodes.length) return send(404, { error: '未查到该单集' });
      // 定位到用户指定的那一集，而不是无脑取第一集
      const idx = r.episodes.findIndex((e) => e.ep_id === ep);
      const target = idx >= 0 ? r.episodes[idx] : r.episodes[0];
      return send(200, {
        title: r.title || '',
        cover: (r.cover || '').replace(/^http:/, 'https:'),
        bvid: target.bvid || '',
        cid: target.cid || 0,
        currentIndex: idx >= 0 ? idx : 0,
        episodes: pickEpisodes(r.episodes),
      });
    }
    // av 号：走普通视频 view 接口
    const j = await fetchJSON(`${BILI_API}/x/web-interface/view?aid=${av}`);
    const r = j && j && j.data;
    if (!r || !r.bvid) return send(404, { error: '未查到该视频' });
    return send(200, {
      title: r.title || '',
      cover: (r.pic || '').replace(/^http:/, 'https:'),
      bvid: r.bvid || '',
      cid: r.cid || 0,
      episodes: r.pages && r.pages.length > 1
        ? r.pages.map((p, i) => ({ ep: i + 1, title: p.part || `P${i + 1}`, bvid: r.bvid, cid: p.cid || 0 }))
        : [],
    });
  } catch (e) {
    return send(502, { error: '上游请求失败' });
  }
}

const server = http.createServer((req, res) => {
  try {
    const parsed = new URL(req.url, 'http://x');
    let urlPath = decodeURIComponent(parsed.pathname);

    // 代理路由：必须在静态文件逻辑之前
    if (urlPath === '/api/bili') {
      return handleBili(parsed.searchParams, res);
    }

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

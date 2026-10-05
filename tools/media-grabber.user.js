// ==UserScript==
// @name         网页媒体 & 歌词抓取器 (Media & Lyric Grabber)
// @namespace    https://github.com/ll9-m/music_pwa
// @version      1.0
// @description  捕获当前网页正在播放的音频/视频地址与歌词，一键下载。支持直链、HLS(m3u8)分片、MediaSource，内置录制兜底。仅供下载你自己有权下载的内容。
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// ─────────────────────────────────────────────────────────────
//  用法一（推荐）：装到 Tampermonkey / Violentmonkey
//     脚本会在页面加载最早期注入，能捕获到所有请求
//
//  用法二（临时）：打开 F12 → Console → 粘贴全部代码 → 回车
//     粘贴之前已经发出的请求抓不到，粘贴后刷新页面或重新播放即可
//     （粘贴版仍会用 Performance API 扫描历史请求里的媒体地址）
//
//  面板：右上角浮动小窗，可折叠/关闭。快捷键 Alt+M 开关。
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  if (window.__MEDIA_GRABBER__) { window.__MEDIA_GRABBER__.toggle(); return; }

  // ── 状态 ────────────────────────────────────────────────
  const media = new Map();   // url -> {url, kind, mime, size, label}
  const lyrics = new Map();  // id  -> {id, text, source, name}
  let rec = null, recChunks = [], recEl = null;
  let lyricSeq = 0;

  const MEDIA_EXT = /\.(mp3|m4a|m4s|aac|flac|wav|ogg|oga|opus|weba|mp4|webm|mkv|mov|ts|m3u8?)(\?|#|$)/i;
  const MEDIA_MIME = /^(audio|video)\//i;
  const OCTET = /octet-stream/i; // 很多二进制（含 .krc 歌词）都用它，不能单独作为媒体依据
  const SKIP_EXT = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|json)(\?|#|$)/i;

  // ── 工具 ────────────────────────────────────────────────
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const safeName = (s) => (s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'media';
  const extOfUrl = (u) => {
    const m = String(u).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  };
  const fmtSize = (b) => !b ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  const isAudioUrl = (u) => /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba)(\?|#|$)/i.test(u);
  const isHls = (u) => /\.m3u8?(\?|#|$)/i.test(u);

  // ── 歌名推断 ────────────────────────────────────────────
  // 抓到的 URL 文件名常是哈希串，所以从多个来源收集候选并打分
  const titleHints = [];   // {v, s, src}
  const artistHints = [];  // {v, s, src}
  let nameDirty = false;   // 用户手动改过就不再自动覆盖

  /** 排除纯哈希/纯数字这类“一串字符” */
  function readable(v) {
    v = (v || '').trim();
    if (v.length < 2 || v.length > 70) return false;
    if (/^[0-9a-f]{16,}$/i.test(v)) return false;      // md5 之类
    if (/^\d+$/.test(v)) return false;
    if (/[\u4e00-\u9fa5]/.test(v)) return true;        // 含中文即可读
    return /[a-z]{2,}/i.test(v);
  }

  /** 去掉站点尾巴、多余分隔符 */
  const SITE_TAIL = /^\s*(?:.*?)\s*[-_|｜—–]\s*(?:网易云音乐|QQ音乐|QQ音乐\.com|酷狗音乐|酷我音乐|虾米音乐|千千音乐|咪咕音乐|哔哩哔哩|bilibili|B站|喜马拉雅|蜻蜓FM|荔枝FM|网易云|音乐|Music|官方|正版|高清|HQ|SQ)\s*$/i;
  function cleanTitle(s) {
    let v = (s || '').replace(/\s+/g, ' ').trim();
    v = v.replace(/\s*[-_|｜—–]\s*(?:网易云音乐|QQ音乐|酷狗音乐|酷我音乐|虾米音乐|千千音乐|咪咕音乐|哔哩哔哩|bilibili|B站|喜马拉雅|网易云|音乐|Music)\s*$/i, '');
    v = v.replace(/^\s*(?:网易云音乐|QQ音乐|酷狗音乐|酷我音乐)\s*[-_|｜—–]\s*/i, '');
    v = v.replace(/\s*[-_|｜—–]\s*$/, '').trim();
    return safeName(v);
  }

  // 导航/界面通用词，不能当歌名（页面里到处都是，极易误抓）
  const STOP_WORDS = new Set(['歌曲', '音乐', '专辑', '歌手', '歌单', '播放列表', '列表', '首页', '发现', '我的', '排行', '排行榜',
    '搜索', '设置', '登录', '注册', '推荐', '电台', '视频', '直播', '关注', '动态', '下载', '客户端', 'VIP', '会员', '歌词',
    '评论', '歌名', '歌手名', '本地音乐', '正在播放', '播放', '暂停', '上一首', '下一首', '收藏', '分享', '本地', '全部', '最近播放']);

  function addHint(bag, v, s, src) {
    const val = cleanTitle(v);
    if (!readable(val)) return;
    if (STOP_WORDS.has(val.toLowerCase())) return;
    const hit = bag.find((h) => h.v.toLowerCase() === val.toLowerCase());
    if (hit) { hit.s = Math.max(hit.s, s); return; }
    bag.push({ v: val, s, src });
  }
  const addTitle = (v, s, src) => addHint(titleHints, v, s, src);
  const addArtist = (v, s, src) => addHint(artistHints, v, s, src);

  /** 从 LRC 里读 [ti:][ar:][al:] 元信息 —— 最可靠的歌名来源 */
  function lrcMeta(text) {
    const get = (tag) => { const m = text.match(new RegExp('\\[' + tag + ':([^\\]]*)\\]', 'i')); return m ? m[1].trim() : ''; };
    return { ti: get('ti'), ar: get('ar'), al: get('al') };
  }

  /** 扫描页面 DOM / meta 收集候选 */
  function collectDomTitles() {
    const meta = document.querySelector('meta[property="og:title"],meta[name="twitter:title"],meta[itemprop="name"]');
    if (meta && meta.content) addTitle(meta.content, 60, 'og:title');
    if (document.title) addTitle(document.title, 40, '页面标题');

    const sels = [
      ['.song-title,.songtitle,.song_name,.songName', 80],
      ['[class*="songName"],[class*="song-name"],[class*="songTitle"]', 78],
      ['[class*="trackName"],[class*="track-title"],.track-title', 76],
      ['[class*="audioName"],[class*="audio-title"],.player-title,.now-playing,.nowplaying', 74],
      ['[class*="musicName"],[class*="music-title"],[class*="title"] h1, .tit,.title', 62],
      ['h1', 50],
    ];
    for (const [sel, score] of sels) {
      try {
        document.querySelectorAll(sel).forEach((n) => {
          const t = (n.innerText || n.getAttribute('aria-label') || '').trim();
          if (t && t.length < 60) addTitle(t, score, 'DOM ' + sel.split(',')[0]);
        });
      } catch { /* 选择器非法忽略 */ }
    }
    // 播放列表里“当前播放”那一项
    try {
      document.querySelectorAll('.playing,.current,.active,.on,[class*="playing"],[class*="current"]').forEach((n) => {
        const t = (n.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
        if (t.length && t[0].length < 60) addTitle(t[0], 72, '播放列表当前项');
        if (t.length > 1 && t[1].length < 40) addArtist(t[1], 60, '播放列表当前项');
      });
    } catch { /* ignore */ }

    // 歌手
    try {
      document.querySelectorAll('[class*="artist"],[class*="singer"],[class*="author"]').forEach((n) => {
        const t = (n.innerText || '').trim();
        if (t && t.length < 40) addArtist(t, 55, 'DOM artist');
      });
    } catch { /* ignore */ }

    // 媒体元素自身
    document.querySelectorAll('audio,video').forEach((el) => {
      const al = el.getAttribute('aria-label') || el.getAttribute('title');
      if (al) addTitle(al, 70, '媒体元素');
    });
  }

  /** 站点通过 Media Session 设置的元数据（网易云/B站等常用），最准 */
  function hookMediaSession() {
    try {
      const ms = navigator.mediaSession;
      if (!ms) return;
      if (ms.metadata && ms.metadata.title) {
        addTitle(ms.metadata.title, 100, 'MediaSession');
        if (ms.metadata.artist) addArtist(ms.metadata.artist, 100, 'MediaSession');
      }
      const orig = ms.setMetadata ? ms.setMetadata.bind(ms) : null;
      if (orig) {
        ms.setMetadata = (m) => {
          try {
            if (m && m.title) addTitle(m.title, 100, 'MediaSession');
            if (m && m.artist) addArtist(m.artist, 100, 'MediaSession');
            if (!nameDirty) render();
          } catch { /* ignore */ }
          return orig(m);
        };
      }
    } catch { /* ignore */ }
  }

  const best = (bag) => bag.length ? bag.slice().sort((a, b) => b.s - a.s)[0].v : '';
  function bestName() {
    const t = best(titleHints), a = best(artistHints);
    if (t && a && t !== a && !t.includes(a)) return a + ' - ' + t;
    return t || a || '';
  }

  /** 文件名基线：手填 > 推断 > URL 里的可读文件名 > audio */
  function fallbackFromMedia() {
    for (const m of media.values()) {
      const n = decodeURIComponent(m.url.split('/').pop().split('?')[0]).replace(/\.[a-z0-9]{2,5}$/i, '');
      if (readable(n)) return n;   // readable 会拒掉纯哈希/纯数字
    }
    return '';
  }
  function currentBase() {
    return safeName((nameInput && nameInput.value) || bestName() || fallbackFromMedia() || 'audio');
  }

  /** 猜歌名：页面标题 → 播放器附近文本 → 音频元素 aria-label */
  function guessTitle() {
    collectDomTitles();
    return bestName() || safeName(document.title || '') || 'audio';
  }

  function topCandidates(n = 4) {
    const seen = new Set(); const out = [];
    for (const h of titleHints.slice().sort((a, b) => b.s - a.s)) {
      const full = (() => { const a = best(artistHints); return a && !h.v.includes(a) ? a + ' - ' + h.v : h.v; })();
      if (seen.has(full)) continue;
      seen.add(full); out.push({ label: full, src: h.src });
      if (out.length >= n) break;
    }
    return out;
  }

  // ── 下载 ────────────────────────────────────────────────
  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    toast('已开始下载：' + filename);
  }

  /** 优先用 fetch（能带上 cookie 拿到鉴权资源），失败则开新标签让用户另存 */
  async function downloadUrl(url, filename) {
    toast('正在获取…');
    try {
      const res = await fetch(url, { credentials: 'include', mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (!blob.size) throw new Error('空响应');
      saveBlob(blob, filename);
    } catch (e) {
      const w = window.open(url, '_blank');
      if (!w) toast('下载失败：' + e.message);
      else toast('无法直接下载（' + e.message + '），已在新标签打开，请右键另存为');
    }
  }

  // ── 歌词识别 ────────────────────────────────────────────
  const LRC_LINE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;
  function isLRC(text) {
    if (!text || text.length > 400000) return false;
    const lines = text.split(/\r?\n/).filter((l) => LRC_LINE.test(l.trim()));
    return lines.length >= 2;
  }

  function tryB64(s) {
    if (s.length < 40 || !/^[A-Za-z0-9+/=\r\n]+$/.test(s)) return null;
    try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0))); } catch { return null; }
  }

  /** 递归在 JSON 里找含歌词字段的字符串 */
  function deepFind(obj, out = [], depth = 0) {
    if (depth > 8 || out.length > 6) return out;
    if (typeof obj === 'string') {
      const s = obj.trim();
      if (s.length > 30 && (/^\[\d{1,3}:\d{2}/.test(s) || s.split(/\r?\n/).length > 3)) {
        if (/^\[\d{1,3}:\d{2}/.test(s) || /lyric|lrc|krc/i.test(s)) out.push(s);
        else { const d = tryB64(s); if (d && /^\[\d{1,3}:\d{2}/.test(d.trim())) out.push(d); }
      }
      return out;
    }
    if (Array.isArray(obj)) { for (const v of obj) deepFind(v, out, depth + 1); return out; }
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (/lyric|lrc|krc|words|sentence/i.test(k) && typeof v === 'string' && v.trim().length > 30) {
          const d = tryB64(v) || v;
          out.push(d);
        } else deepFind(v, out, depth + 1);
      }
    }
    return out;
  }

  function addLyric(text, source, name) {
    if (!text || !text.trim()) return;
    const t = text.trim();
    // 去重：同一来源只留一份；内容开头相同的也视为重复
    if (source && [...lyrics.values()].some((v) => v.source === source)) return;
    const key = t.replace(/\s+/g, '').slice(0, 120);
    for (const v of lyrics.values()) if (v.text.replace(/\s+/g, '').slice(0, 120) === key) return;
    const item = { id: 'L' + (++lyricSeq), text: t, source, name: name || '' };
    lyrics.set(item.id, item);
    // LRC 元信息 → 歌名候选（最高优先级）
    const meta = lrcMeta(t);
    if (meta.ti) { addTitle(meta.ti, 95, 'LRC [ti:]'); item.name = meta.ti; }
    if (meta.ar) {
      addArtist(meta.ar, 95, 'LRC [ar:]');
      const a = best(artistHints);
      if (meta.ti && a) item.name = a + ' - ' + meta.ti;
      else if (!item.name) item.name = a;
    }
    render();
  }

  // HLS/DASH 分片（B 站 .m4s、腾讯 .ts 等）：能抓到但通常只是音频流的一小段
  const SEG = /(seg-\d+|\/(\d{3,})\.(ts|m4s|m4a)|[?&](range|start)=|\.m4s(\?|$))/i;

  function addMedia(url, kind, mime, size, label) {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    url = abs(url);
    const old = media.get(url);
    if (old) { if (size) old.size = size; return; }
    if (!kind) kind = isHls(url) ? 'hls' : SEG.test(url) ? 'segment' : isAudioUrl(url) ? 'audio' : 'video';
    media.set(url, { url, kind, mime: mime || '', size: size || 0, label: label || '' });
    render();
  }

  // ── 请求捕获 ────────────────────────────────────────────
  function inspectResponse(url, mime, text, size) {
    if (!url) return;
    const m = (mime || '').toLowerCase();
    // 判定为媒体：URL 带媒体后缀 / m3u8 / 明确的 audio|video MIME（octet-stream 不算）
    const isMedia = MEDIA_EXT.test(url) || isHls(url) || (MEDIA_MIME.test(m) && !OCTET.test(m));
    if (isMedia && !SKIP_EXT.test(url)) addMedia(url, null, mime, size);
    // 歌词：只在明确是文本/JSON 时判断，避免把二进制当文本扫
    if (text && !isMedia) {
      if (isLRC(text)) addLyric(text, url);
      else if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          const found = deepFind(JSON.parse(text));
          for (const f of found) if (isLRC(f)) addLyric(f, url);
        } catch { /* 非 JSON，忽略 */ }
      }
    }
  }

  // fetch
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const mime = res.headers.get('content-type') || '';
      const url = res.url || (typeof args[0] === 'string' ? args[0] : args[0] && args[0].url);
      const len = Number(res.headers.get('content-length') || 0);
      // 只克隆“看起来是媒体或歌词”的小响应，避免吃内存
      if (MEDIA_MIME.test(mime) || MEDIA_EXT.test(url) || isHls(url) || (/text|json/i.test(mime) && len < 2e6)) {
        const clone = res.clone();
        clone.text().then((t) => inspectResponse(url, mime, t.length < 2e6 ? t : null, len)).catch(() => inspectResponse(url, mime, null, len));
      } else {
        inspectResponse(url, mime, null, len);
      }
    } catch { /* ignore */ }
    return res;
  };

  // XHR
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mg_url = url; return _open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    try {
      const rt = this.responseType;
      this.addEventListener('load', () => {
        try {
          const mime = this.getResponseHeader('content-type') || '';
          const url = this.__mg_url || this.responseURL;
          const txt = (rt === '' || rt === 'text') && typeof this.responseText === 'string' ? this.responseText : null;
          const size = (this.response && this.response.size) || Number(this.getResponseHeader('content-length') || 0);
          inspectResponse(url, mime, txt && txt.length < 2e6 ? txt : null, size);
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    return _send.apply(this, a);
  };

  // 媒体元素：<audio>/<video> 的 src / currentSrc
  function scanElements() {
    document.querySelectorAll('audio,video').forEach((el) => {
      const u = el.currentSrc || el.src || '';
      if (u && !u.startsWith('blob:')) addMedia(u, null, '', 0, el.paused ? '' : '正在播放');
      const src = el.querySelector && el.querySelector('source');
      if (src && src.src && !src.src.startsWith('blob:')) addMedia(src.src);
    });
  }

  // 历史请求（Performance API，粘贴版也能捞到一部分）
  function scanPerformance() {
    try {
      performance.getEntriesByType('resource').forEach((e) => {
        if (MEDIA_EXT.test(e.name) && !SKIP_EXT.test(e.name)) {
          addMedia(e.name, null, '', e.encodedBodySize || e.transferSize || 0);
        }
      });
    } catch { /* ignore */ }
  }

  // ── HLS ─────────────────────────────────────────────────
  async function hlsSegments(m3u8Url) {
    const txt = await (await fetch(m3u8Url, { credentials: 'include' })).text();
    if (/#EXT-X-STREAM-INF/.test(txt)) {           // 主播放列表 → 取第一个子列表
      const sub = txt.split(/\r?\n/).find((l) => /^https?:|^\.|^[^#].*\.m3u8/.test(l.trim()));
      if (sub) return hlsSegments(new URL(sub.trim(), m3u8Url).href);
    }
    const segs = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new URL(l, m3u8Url).href);
    return segs.filter((u) => /\.ts|\.m4s|\.mp4|\.aac|\.m4a/.test(u) || !/\./.test(u.split('/').pop()));
  }

  async function downloadHls(m3u8Url, baseName) {
    toast('解析分片中…');
    try {
      const segs = await hlsSegments(m3u8Url);
      if (!segs.length) return toast('没解析到分片');
      const parts = [];
      for (let i = 0; i < segs.length; i++) {
        toast('下载分片 ' + (i + 1) + '/' + segs.length);
        const r = await fetch(segs[i], { credentials: 'include' });
        parts.push(await r.arrayBuffer());
      }
      const ext = /\.m4s|\.mp4/.test(segs[0]) ? 'mp4' : 'ts';
      saveBlob(new Blob(parts), baseName + '.' + ext);
      toast('合并完成（' + segs.length + ' 个分片）；若无法播放请用 ffmpeg 转换');
    } catch (e) { toast('HLS 下载失败：' + e.message); }
  }

  // ── 录制兜底（任何能播放的都能录）────────────────────────
  function pickMime() {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'video/webm'];
    for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }
  function toggleRecord() {
    if (rec && rec.state === 'recording') { rec.stop(); toast('录制结束，正在保存…'); return; }
    const el = [...document.querySelectorAll('audio,video')].find((x) => !x.paused) || document.querySelector('audio,video');
    if (!el) return toast('页面上没找到可录制的媒体元素');
    if (typeof el.captureStream !== 'function') return toast('该元素不支持录制，请用上面的直链下载');
    try {
      const mime = pickMime();
      recEl = el; recChunks = [];
      rec = new MediaRecorder(el.captureStream(), mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.onstop = () => {
        const ext = (rec.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
        saveBlob(new Blob(recChunks, { type: rec.mimeType }), guessTitle() + '(录制).' + ext);
        rec = null;
      };
      rec.start();
      toast('录制中：请让歌曲完整播放一遍，播完点“停止录制”');
    } catch (e) { toast('录制启动失败：' + e.message); }
    render();
  }

  // ── UI ──────────────────────────────────────────────────
  const CSS = {
    panel: 'position:fixed;top:12px;right:12px;width:400px;max-height:78vh;z-index:2147483647;' +
      'background:#14161a;color:#e8e6e3;border:1px solid #2b2f36;border-radius:12px;' +
      'font:13px/1.5 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden',
    head: 'display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1b1e24;border-bottom:1px solid #2b2f36;cursor:default',
    title: 'font-weight:600;font-size:13px;flex:1;color:#e8e6e3',
    btn: 'background:#262a31;color:#e8e6e3;border:1px solid #343a43;border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer',
    btnP: 'background:#2e6b5e;color:#fff;border:1px solid #35806f;border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer',
    body: 'overflow:auto;padding:10px 12px;flex:1',
    sec: 'font-size:11px;color:#8b8f98;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 6px',
    item: 'border:1px solid #262a31;border-radius:8px;padding:8px 9px;margin-bottom:7px;background:#181b20',
    name: 'font-size:12px;word-break:break-all;color:#dcdad6',
    meta: 'font-size:11px;color:#7d828b;margin-top:3px',
    row: 'display:flex;gap:6px;margin-top:7px;flex-wrap:wrap',
  };
  const el = (tag, style, html) => { const n = document.createElement(tag); n.style.cssText = style; if (html != null) n.innerHTML = html; return n; };

  let panel, bodyEl, nameInput, candBox;

  function renderCands() {
    if (!candBox) return;
    const refresh = candBox.firstElementChild;
    [...candBox.children].forEach((c) => { if (c !== refresh) c.remove(); });
    for (const c of topCandidates(3)) {
      const b = el('button', 'background:#262a31;color:#cfd3d8;border:1px solid #343a43;border-radius:20px;padding:3px 9px;font-size:11px;cursor:pointer;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', c.label);
      b.title = '来源：' + c.src;
      b.onclick = () => { nameInput.value = c.label; nameDirty = true; toast('已填入：' + c.label); };
      candBox.appendChild(b);
    }
    if (refresh) candBox.insertBefore(refresh, candBox.firstChild);
  }

  function buildUI() {
    panel = el('div', CSS.panel);
    const head = el('div', CSS.head);
    head.appendChild(el('div', CSS.title, '🎵 媒体 & 歌词抓取器'));
    const bMin = el('button', CSS.btn, '折叠'); bMin.onclick = toggle;
    const bX = el('button', CSS.btn, '✕'); bX.onclick = () => { panel.style.display = 'none'; };
    head.appendChild(bMin); head.appendChild(bX);
    panel.appendChild(head);

    bodyEl = el('div', CSS.body);
    panel.appendChild(bodyEl);

    const tools = el('div', 'padding:8px 12px;border-bottom:1px solid #2b2f36;display:flex;flex-direction:column;gap:6px;background:#14161a');
    const r1 = el('div', 'display:flex;gap:6px;flex-wrap:wrap');
    const mk = (label, fn, primary) => { const b = el('button', primary ? CSS.btnP : CSS.btn, label); b.onclick = fn; return b; };
    r1.appendChild(mk('🔄 重新扫描', rescan));
    r1.appendChild(mk('⭐ 抓当前播放', grabPlaying, true));
    r1.appendChild(mk(rec && rec.state === 'recording' ? '⏹ 停止录制' : '⏺ 录制音频', toggleRecord));
    tools.appendChild(r1);
    const r2 = el('div', 'display:flex;align-items:center;gap:6px');
    r2.appendChild(el('span', 'font-size:11px;color:#8b8f98', '文件名'));
    nameInput = document.createElement('input');
    nameInput.id = '__mg_name';
    nameInput.value = '';   // 由 render() 自动填入最佳候选，拿不到就留空让用户填
    nameInput.placeholder = '文件名（自动推断，可手改）';
    nameInput.style.cssText = 'flex:1;background:#1b1e24;border:1px solid #343a43;color:#e8e6e3;border-radius:6px;padding:3px 7px;font-size:12px';
    nameInput.addEventListener('input', () => { nameDirty = true; });
    r2.appendChild(nameInput);
    tools.appendChild(r2);

    // 候选歌名：点一下就填进文件名
    candBox = el('div', 'display:flex;gap:5px;flex-wrap:wrap;margin-top:2px');
    const cRefresh = el('button', CSS.btn, '🔤 重新识别歌名');
    cRefresh.onclick = () => { titleHints.length = 0; artistHints.length = 0; collectDomTitles(); nameDirty = false; renderCands(); render(); toast('已重新识别'); };
    candBox.appendChild(cRefresh);
    tools.appendChild(candBox);
    panel.insertBefore(tools, bodyEl);
    document.documentElement.appendChild(panel);
  }

  function render() {
    if (!panel) return;
    collectDomTitles();
    // 用户没手改过就自动同步最佳歌名
    if (!nameDirty) { const n = bestName(); if (n) nameInput.value = n; }
    renderCands();
    bodyEl.innerHTML = '';
    const base = currentBase();

    bodyEl.appendChild(el('div', CSS.sec, '音频 / 视频 (' + media.size + ')'));
    if (!media.size) bodyEl.appendChild(el('div', CSS.meta, '还没抓到。点“重新扫描”，或让歌曲播放/刷新页面后重试。'));
    // 排序：正在播放 → 直链音频 → 视频 → m3u8 → 分片
    const rank = { audio: 0, video: 1, hls: 2, segment: 3 };
    const list = [...media.values()].sort((a, b) =>
      (b.label ? -100 : 0) - (a.label ? -100 : 0) || (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
    for (const m of list.slice(0, 40)) {
      const item = el('div', CSS.item);
      const ext = extOfUrl(m.url) || (m.kind === 'audio' ? 'mp3' : m.kind === 'hls' ? 'mp4' : 'mp4');
      const kindLabel = { audio: '音频', video: '视频', hls: 'HLS 播放列表', segment: '流媒体分片' }[m.kind] || m.kind;
      const tags = [kindLabel, ext, fmtSize(m.size), m.label].filter(Boolean).join(' · ');
      item.appendChild(el('div', CSS.name, (m.label ? '⭐ ' : '') + decodeURIComponent(m.url.split('/').pop().split('?')[0].slice(0, 60))));
      item.appendChild(el('div', CSS.meta, tags));
      const row = el('div', CSS.row);
      if (m.kind === 'hls') {
        const b1 = el('button', CSS.btnP, '下载并合并'); b1.onclick = () => downloadHls(m.url, base);
        const b2 = el('button', CSS.btn, '复制 ffmpeg'); b2.onclick = () => copy('ffmpeg -i "' + m.url + '" -c copy "' + base + '.mp4"');
        row.appendChild(b1); row.appendChild(b2);
      } else {
        const b1 = el('button', CSS.btnP, '下载'); b1.onclick = () => downloadUrl(m.url, base + '.' + ext);
        row.appendChild(b1);
      }
      const b3 = el('button', CSS.btn, '复制链接'); b3.onclick = () => copy(m.url);
      const b4 = el('button', CSS.btn, '试听'); b4.onclick = () => { const a = new Audio(m.url); a.play().catch(() => toast('无法试听')); };
      row.appendChild(b3); row.appendChild(b4);
      item.appendChild(row);
      bodyEl.appendChild(item);
    }

    bodyEl.appendChild(el('div', CSS.sec, '歌词 (' + lyrics.size + ')'));
    if (!lyrics.size) bodyEl.appendChild(el('div', CSS.meta, '播放/拖动进度后会捕获歌词接口；纯文本歌词可用下方按钮从页面提取。'));
    for (const l of [...lyrics.values()].slice(0, 10)) {
      const item = el('div', CSS.item);
      const prev = l.text.split(/\r?\n/).slice(0, 2).join(' / ').replace(/\[[^\]]*\]/g, '').trim().slice(0, 46);
      item.appendChild(el('div', CSS.name, prev || '(空)'));
      item.appendChild(el('div', CSS.meta, l.text.split(/\r?\n/).length + ' 行 · ' + (isLRC(l.text) ? '含时间轴' : '纯文本')));
      const row = el('div', CSS.row);
      const b1 = el('button', CSS.btnP, '下载 .lrc'); b1.onclick = () => saveBlob(new Blob([l.text], { type: 'text/plain;charset=utf-8' }), base + '.lrc');
      const b2 = el('button', CSS.btn, '复制'); b2.onclick = () => copy(l.text);
      row.appendChild(b1); row.appendChild(b2);
      item.appendChild(row);
      bodyEl.appendChild(item);
    }
    const pg = el('button', CSS.btn, '从页面提取纯文本歌词');
    pg.onclick = () => {
      const nodes = [...document.querySelectorAll('[class*="lyric"],[class*="Lyric"],[class*="lrc"],[id*="lyric"]')];
      const txt = nodes.map((n) => n.innerText).filter(Boolean).join('\n').trim();
      if (!txt) return toast('页面上没找到歌词容器');
      addLyric(txt, '页面 DOM');
    };
    pg.style.marginTop = '6px';
    bodyEl.appendChild(pg);
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text); toast('已复制'); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('已复制'); }
  }

  let toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el('div', 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483647;' +
        'background:#1b1e24;color:#e8e6e3;border:1px solid #343a43;border-radius:8px;padding:8px 14px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.45)');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
  }

  function rescan() { scanElements(); scanPerformance(); render(); toast('已重新扫描'); }

  /** 抓当前正在播放的那个：优先 currentSrc，其次最新捕获的音频 URL */
  function grabPlaying() {
    scanElements(); scanPerformance();
    const playing = [...document.querySelectorAll('audio,video')].find((x) => !x.paused && !x.ended);
    let url = playing && (playing.currentSrc || playing.src);
    if (!url || url.startsWith('blob:')) {
      const audios = [...media.values()].filter((m) => m.kind === 'audio');
      url = audios.length ? audios[audios.length - 1].url : null;
    }
    if (!url) return toast('没找到正在播放的音频，试试录制功能');
    const ext = extOfUrl(url) || 'mp3';
    return api.downloadUrl(url, currentBase() + '.' + ext);
  }

  function toggle() { if (!panel) return; bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; }

  // ── 启动 ────────────────────────────────────────────────
  buildUI();
  hookMediaSession();
  scanPerformance();
  scanElements();
  collectDomTitles();
  render();
  setInterval(() => { scanElements(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rescan(); });
  window.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'm' || e.key === 'M')) toggle(); });

  // 对外 API：内部也统一走 api.*，方便外部覆盖/调试
  const api = {
    toggle,
    rescan,
    grabPlaying,
    toggleRecord,
    downloadUrl,
    downloadHls,
    addLyric,
    addMedia,
    guessTitle,
    bestName,
    topCandidates,
    titleHints,
    artistHints,
    media,
    lyrics,
  };
  window.__MEDIA_GRABBER__ = api;
  toast('媒体抓取器已就绪（Alt+M 开关面板）');
})();

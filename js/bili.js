// B 站链接解析：把用户粘贴的任意形态地址变成「可内嵌」或「只能跳转」的结论。
//
// 为什么单独成文件且不碰网络：
//   实测 api.bilibili.com 对跨域直连返回 403（风控），
//   所以浏览器里**无法**自动把 ss 号解析成 bvid。
//   于是解析必须纯本地、确定性、可单测 —— 能解的直接解，
//   解不出的如实标记为「需跳转」，绝不假装能内嵌。
//
// URL 形态（全部实测确认，见 README「番剧链接能粘什么」）：
//   https://www.bilibili.com/bangumi/play/ss4181      → season  id，解不出 bvid
//   https://www.bilibili.com/bangumi/play/ep102167    → ep     id，需联网补全
//   https://www.bilibili.com/video/BV1kx411k7VB       → bvid，可直接内嵌
//   https://www.bilibili.com/video/av8937736          → av    id，需联网补全
//   BV1kx411k7VB / av8937736 / ep102167                → 裸 id，同样支持

/** 内嵌播放器地址。cid 缺省时 B 站仍能起播，但清晰度与选集受限。 */
export function embedURL(bvid, opts = {}) {
  if (!bvid) return '';
  const p = new URLSearchParams({ bvid, autoplay: opts.autoplay ? '1' : '0' });
  if (opts.cid) p.set('cid', String(opts.cid));
  if (opts.page) p.set('p', String(opts.page));
  // 关弹幕：这是个音乐播放器旁边的附赠窗口，弹幕会盖住画面
  p.set('danmaku', '0');
  p.set('high_quality', '1');
  return `https://player.bilibili.com/player.html?${p.toString()}`;
}

const RX = {
  // BV 号：BV + 10 位（BV1kx411k7VB → BV + 1kx411k7VB）
  bvid: /BV[0-9A-Za-z]{10}/,
  // 裸 av 号：av + 数字
  av: /av(\d+)/i,
  // ep 号：ep + 数字
  ep: /ep(\d+)/i,
  // season 号：ss + 数字
  ss: /ss(\d+)/i,
};

/**
 * 解析用户粘贴的文本，判定它能否内嵌。
 * @returns {{
 *   ok: true, kind: 'bvid'|'ep'|'av'|'ss', raw: string,
 *   bvid: string,     // 仅 kind==='bvid' 时有值，可立即内嵌
 *   needFetch: boolean, // true 表示要联网补全（走本地代理）
 *   watchURL: string, // 永远可用的官方观看页
 *   embeddable: boolean,
 * }} | { ok: false, reason: string }
 */
export function parseBiliURL(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, reason: '空内容' };

  // 只接受 http/https 与裸 id；javascript: 等一律拒绝
  let host = '';
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { return { ok: false, reason: '网址格式不正确' }; }
    host = u.hostname.toLowerCase();
    if (!/(^|\.)bilibili\.com$|(^|\.)b23\.tv$|(^|\.)bilibili\.tv$/.test(host)) {
      return { ok: false, reason: '不是 B 站链接（' + host + '）' };
    }
  } else if (/^[a-z]+:/i.test(raw)) {
    return { ok: false, reason: '只支持 http/https 链接' };
  }

  // 短链 b23.tv 无法本地展开，直接给跳转
  if (host === 'b23.tv') {
    return { ok: true, kind: 'short', raw, bvid: '', needFetch: false,
             embeddable: false, watchURL: raw.startsWith('http') ? raw : 'https://' + raw };
  }

  // 判定类型：先找 bvid，因为它能立即内嵌
  const bv = raw.match(RX.bvid);
  const ss = raw.match(RX.ss);
  const ep = raw.match(RX.ep);
  const av = raw.match(RX.av);

  // 同时出现 bvid 与 ss/ep 时以 bvid 为准（它信息最全）
  if (bv) {
    const bvid = bv[0];
    const cidMatch = raw.match(/[?&]cid=(\d+)/);
    return {
      ok: true, kind: 'bvid', raw, bvid,
      cid: cidMatch ? Number(cidMatch[1]) : 0,
      needFetch: false, embeddable: true,
      watchURL: `https://www.bilibili.com/video/${bvid}`,
    };
  }
  if (ss) {
    const sid = Number(ss[1]);
    return {
      ok: true, kind: 'ss', raw, seasonId: sid, bvid: '', needFetch: true,
      embeddable: false,
      watchURL: `https://www.bilibili.com/bangumi/play/ss${sid}`,
    };
  }
  if (ep) {
    const eid = Number(ep[1]);
    return {
      ok: true, kind: 'ep', raw, epId: eid, bvid: '', needFetch: true,
      embeddable: false,
      watchURL: `https://www.bilibili.com/bangumi/play/ep${eid}`,
    };
  }
  if (av) {
    const aid = Number(av[1]);
    return {
      ok: true, kind: 'av', raw, aid, bvid: '', needFetch: true,
      embeddable: false,
      watchURL: `https://www.bilibili.com/video/av${aid}`,
    };
  }
  return { ok: false, reason: '认不出这是哪种 B 站地址（需要 BV / av / ep / ss 号）' };
}

/**
 * 本地代理是否可用。线上 GitHub Pages 版没有 /api/bili，
 * 此时 ss 号只能走「跳转官方」。探测一次并缓存。
 */
let proxyState = null; // null=未探测 true=可用 false=不可用
export async function probeProxy() {
  if (proxyState !== null) return proxyState;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('api/bili?ss=1', { signal: ctl.signal });
    clearTimeout(t);
    // 任何 HTTP 响应都说明本地 server.js 在跑（200=有番剧，404/502=路由存在但没查到）
    proxyState = r.ok || r.status === 404 || r.status === 502;
  } catch { proxyState = false; }
  return proxyState;
}

/** 重置探测缓存（设置页切换来源后调用）。 */
export function resetProxyProbe() { proxyState = null; }

/**
 * 尝试把 ss/ep/av 补全为可内嵌信息。
 * 走本地 server.js 代理；不可用或失败时返回 null，调用方须降级为跳转。
 */
export async function resolveEmbeddable(parsed) {
  if (!parsed || !parsed.ok) return null;
  if (parsed.embeddable) {
    return { bvid: parsed.bvid, cid: parsed.cid || 0, episodes: [], title: '' };
  }
  if (!parsed.needFetch) return null;
  if (!await probeProxy()) return null;

  const q = parsed.kind === 'ss' ? 'ss=' + parsed.seasonId
          : parsed.kind === 'ep' ? 'ep=' + parsed.epId
          : 'av=' + parsed.aid;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('api/bili?' + q, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.bvid) return null;
    return {
      bvid: j.bvid,
      cid: j.cid || 0,
      title: j.title || '',
      cover: j.cover || '',
      episodes: Array.isArray(j.episodes) ? j.episodes : [],
    };
  } catch { return null; }
}

/** 归一化为可存入 IndexedDB 的记录。 */
export function makeRecord({ id, title, url, note }) {
  const p = parseBiliURL(url);
  return {
    id: id || crypto.randomUUID(),
    title: (title || '').trim(),
    url: String(url || '').trim(),
    note: (note || '').trim(),
    kind: p.ok ? p.kind : 'invalid',
    bvid: p.ok ? (p.bvid || '') : '',
    cid: p.ok ? (p.cid || 0) : 0,
    seasonId: p.ok ? (p.seasonId || 0) : 0,
    epId: p.ok ? (p.epId || 0) : 0,
    aid: p.ok ? (p.aid || 0) : 0,
    cover: '',
    episodes: [],
    addedAt: Date.now(),
  };
}

/** 记录当前能否内嵌（补全可能成功也可能失败）。 */
export function canEmbed(rec) {
  return !!(rec && rec.bvid);
}

/** 取官方观看页。优先用用户原始链接，保证「跳转官方」永远落在用户给的那一页。 */
export function watchURL(rec) {
  if (!rec) return '';
  if (rec.url) {
    const p = parseBiliURL(rec.url);
    if (p.ok && p.watchURL) return p.watchURL;
  }
  if (rec.bvid) return `https://www.bilibili.com/video/${rec.bvid}`;
  if (rec.seasonId) return `https://www.bilibili.com/bangumi/play/ss${rec.seasonId}`;
  if (rec.epId) return `https://www.bilibili.com/bangumi/play/ep${rec.epId}`;
  return '';
}

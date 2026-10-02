// 视图渲染：歌曲 / 专辑 / 歌手 / 播放列表 / 设置 + 详情页
import * as db from './db.js';
import { prefs, setPref } from './prefs.js';
import { icon, esc, fmtTime, toast, showMenu, closeMenu, confirmDialog, promptDialog, debounce, gradFor, collator, paintRange } from './ui.js';
import * as scanner from './scanner.js';
import * as player from './player.js';
import * as art from './art.js';
import * as eq from './eq.js';
import { BANDS } from './eq.js';

export const APP_VERSION = '1.0.0';

let tracks = [];
const byRel = new Map();
let playlists = [];

export const nav = { tab: 'songs', detail: null, search: '' };
let deferredPrompt = null;
let reconnectNeeded = false;

export const trackByRel = (rel) => byRel.get(rel);

export async function loadFromDB() {
  tracks = await db.getAllTracks();
  byRel.clear();
  for (const t of tracks) byRel.set(t.rel, t);
  await loadPlaylists();
}

export async function loadPlaylists() {
  playlists = await db.getPlaylists();
}

// ---------- 封面懒加载 ----------
const artIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    artIO.unobserve(e.target);
    loadArtInto(e.target);
  }
}, { rootMargin: '260px' });

async function loadArtInto(node) {
  const { key, rel, ext, size } = node.dataset;
  const r = await art.getArt(key, rel, ext);
  if (!r) return; // 无封面，保留渐变占位
  const img = document.createElement('img');
  img.className = node.className.replace('ph', '').trim() || 'thumb';
  if (size === 'detail') img.classList.add('art');
  img.src = r.url;
  img.alt = '';
  img.loading = 'lazy';
  node.replaceWith(img);
}

// 兜底：IO 在部分环境（后台标签）不触发，直接按几何位置扫描可见占位
function loadVisibleArt() {
  for (const n of document.querySelectorAll('.ph[data-key]')) {
    const r = n.getBoundingClientRect();
    if (r.width && r.top < innerHeight + 260 && r.bottom > -260) {
      artIO.unobserve(n);
      loadArtInto(n);
    }
  }
}

function phNode(key, rel, ext, cls, iconName = 'note', size) {
  const d = document.createElement('div');
  d.className = cls + ' ph';
  d.style.background = gradFor(key || rel || '?');
  d.dataset.key = key || '';
  d.dataset.rel = rel || '';
  d.dataset.ext = ext || '';
  if (size) d.dataset.size = size;
  d.innerHTML = icon(iconName);
  artIO.observe(d);
  return d;
}

// ---------- 数据查询 ----------
function norm(s) { return (s || '').toLowerCase(); }
function matchSearch(t, q) {
  if (!q) return true;
  return norm(t.title).includes(q) || norm(t.artist).includes(q) || norm(t.album).includes(q);
}

const numSort = (k) => (a, b) => ((a[k] ?? -1) - (b[k] ?? -1));
function sortTracks(list, key = prefs().sortKey, dir = prefs().sortDir) {
  const cmp = {
    title: (a, b) => collator.compare(a.title || '', b.title || ''),
    artist: (a, b) => collator.compare(a.artist || '', b.artist || '') || collator.compare(a.title || '', b.title || ''),
    album: (a, b) => collator.compare(a.album || '', b.album || '') || collator.compare(a.trackNo ?? 0, b.trackNo ?? 0) || collator.compare(a.title || '', b.title || ''),
    addedAt: numSort('addedAt'),
    playCount: numSort('playCount'),
    lastPlayed: numSort('lastPlayed'),
    duration: numSort('duration'),
  }[key] || ((a, b) => collator.compare(a.title || '', b.title || ''));
  const mul = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => mul * cmp(a, b));
}

function albumsOf(list) {
  const map = new Map();
  for (const t of list) {
    let a = map.get(t.albumKey);
    if (!a) {
      a = { key: t.albumKey, album: t.album, artist: t.albumArtist || t.artist, year: t.year, tracks: [], dur: 0 };
      map.set(t.albumKey, a);
    }
    if (a.year == null && t.year != null) a.year = t.year;
    a.tracks.push(t);
    a.dur += t.duration || 0;
  }
  return [...map.values()];
}

// ---------- 渲染 ----------
let rootEl, headerEl, tabsEl, contentEl;

export function init() {
  rootEl = document.getElementById('view');
  headerEl = document.querySelector('#appHeader h1');
  tabsEl = document.getElementById('tabbar');
}

export function render() {
  renderHeader();
  renderTabs();
  renderContent();
  setTimeout(loadVisibleArt, 60);
  window.scrollTo({ top: 0 });
}

function renderHeader() {
  const back = nav.detail ? `<button class="icon-btn" id="btnBack" aria-label="返回">${icon('back')}</button>` : '';
  const title = nav.detail
    ? esc(nav.detail.title)
    : `<span class="logo">${icon('music')}</span>本地音乐`;
  headerEl.innerHTML = `${back}${title}`;
  headerEl.style.fontSize = nav.detail ? '16.5px' : '';
  const bb = document.getElementById('btnBack');
  if (bb) bb.addEventListener('click', () => { nav.detail = null; render(); });
}

function renderTabs() {
  const tabs = [
    ['songs', '歌曲'], ['albums', '专辑'], ['artists', '歌手'], ['playlists', '播放列表'], ['settings', '设置'],
  ];
  tabsEl.innerHTML = tabs.map(([id, label]) =>
    `<button data-tab="${id}" class="${nav.tab === id && !nav.detail ? 'active' : ''}">${label}</button>`).join('');
  tabsEl.onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { nav.tab = b.dataset.tab; nav.detail = null; nav.search = ''; render(); }
  };
}

function renderContent() {
  contentEl = rootEl;
  contentEl.innerHTML = '';
  if (nav.detail) {
    if (nav.detail.type === 'album') return renderAlbumDetail();
    if (nav.detail.type === 'artist') return renderArtistDetail();
    if (nav.detail.type === 'playlist') return renderPlaylistDetail();
  }
  switch (nav.tab) {
    case 'songs': return renderSongs();
    case 'albums': return renderAlbums();
    case 'artists': return renderArtists();
    case 'playlists': return renderPlaylists();
    case 'settings': return renderSettings();
  }
}

function reconnectBanner() {
  const d = document.createElement('div');
  d.className = 'banner';
  d.innerHTML = `${icon('folder')}<div class="t"><b>需要重新连接音乐文件夹</b>浏览器需要你重新授权后才能访问音乐。</div><button class="btn small">重新连接</button>`;
  d.querySelector('button').addEventListener('click', async () => {
    const ok = await scanner.authorizeSavedHandle();
    if (ok) { reconnectNeeded = false; await rescanAndRefresh(true); }
    else toast('未获得授权');
  });
  return d;
}

function emptySource() {
  const supports = 'showDirectoryPicker' in window;
  const d = document.createElement('div');
  d.className = 'empty card';
  d.style.cssText = 'padding:48px 24px;margin-top:18px';
  d.innerHTML = `${icon('folder')}<b>选择你的音乐文件夹</b>
    <p>${supports ? '授权一次即可长期使用，之后自动扫描新增歌曲。所有文件都留在你的电脑上，不会上传。' : '当前浏览器不支持记住文件夹（建议使用 Chrome / Edge），每次访问需重新选择文件夹。'}</p>
    <button class="btn">${icon('folder')}选择音乐文件夹</button>`;
  d.querySelector('button').addEventListener('click', pickFolder);
  return d;
}

// ---------- 歌曲页 ----------
let chunk = null;
function renderSongs() {
  const q = norm(nav.search);
  const frag = document.createDocumentFragment();

  if (reconnectNeeded) frag.appendChild(reconnectBanner());

  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `
    <div class="search-wrap">${icon('search')}<input placeholder="搜索歌曲、歌手、专辑" value="${esc(nav.search)}"><button class="clear" ${nav.search ? '' : 'hidden'}>${icon('x')}</button></div>
    <button class="icon-btn" id="btnSort" aria-label="排序">${icon('sort')}</button>`;
  frag.appendChild(head);
  head.querySelector('input').addEventListener('input', debounce((e) => {
    nav.search = e.target.value;
    const cl = head.querySelector('.clear');
    if (cl) cl.hidden = !nav.search;
    refreshList();
  }, 160));
  head.querySelector('.clear').addEventListener('click', () => { nav.search = ''; head.querySelector('input').value = ''; refreshList(); });
  head.querySelector('#btnSort').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const item = (k, label) => ({ label, icon: 'sort', checked: prefs().sortKey === k, onClick: () => { setPref('sortKey', k); refreshList(); } });
    showMenu([
      item('title', '按标题'), item('artist', '按歌手'), item('album', '按专辑'),
      item('addedAt', '按添加时间'), item('playCount', '按播放次数'), item('lastPlayed', '按最近播放'), item('duration', '按时长'),
      '-',
      { label: prefs().sortDir === 'asc' ? '当前：升序 → 改为降序' : '当前：降序 → 改为升序', icon: 'swap', onClick: () => { setPref('sortDir', prefs().sortDir === 'asc' ? 'desc' : 'asc'); refreshList(); } },
    ], r.left, r.bottom + 6);
  });

  if (!scanner.hasSource()) {
    frag.appendChild(emptySource());
    contentEl.appendChild(frag);
    return;
  }

  const list = sortTracks(tracks.filter(t => matchSearch(t, q)));
  if (!tracks.length) {
    const e = emptyList('没有找到音乐文件');
    e.innerHTML += `<p>确认文件夹里有音频文件后，点击“重新扫描”。</p>`;
    frag.appendChild(e);
    contentEl.appendChild(frag);
    return;
  }
  const info = document.createElement('div');
  info.style.cssText = 'display:flex;align-items:center;gap:10px;margin:4px 0 8px';
  info.innerHTML = `<span style="font-size:13px;color:var(--text3)">共 ${list.length} 首</span>
    <span style="flex:1"></span>
    <button class="btn ghost small" id="btnShuffleAll">${icon('shuffle')}随机播放全部</button>`;
  frag.appendChild(info);
  info.querySelector('#btnShuffleAll').addEventListener('click', () => {
    if (!list.length) return toast('没有可播放的歌曲');
    const shuffled = [...list].sort(() => Math.random() - 0.5).map(t => t.rel);
    player.playRels(shuffled, shuffled[0]);
  });

  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  frag.appendChild(listEl);
  contentEl.appendChild(frag);

  chunk = makeChunkList(listEl, renderTrackRow);
  chunk.reset(list);
  bindListEvents(listEl);
}

function makeChunkList(container, renderRow, size = 60) {
  const sentinel = document.createElement('div');
  let items = [], n = 0;
  const io = new IntersectionObserver((es) => {
    if (es[0].isIntersecting) loadMore();
  }, { rootMargin: '500px' });
  function loadMore() {
    if (n >= items.length) return;
    const end = Math.min(items.length, n + size);
    const f = document.createDocumentFragment();
    for (; n < end; n++) f.appendChild(renderRow(items[n], n));
    container.insertBefore(f, sentinel);
  }
  container.appendChild(sentinel);
  io.observe(sentinel);
  return {
    reset(list) {
      container.querySelectorAll('.trow, .arow').forEach(x => x.remove());
      items = list; n = 0;
      container.appendChild(sentinel);
      loadMore();
    },
  };
}

function renderTrackRow(t, i) {
  const row = document.createElement('div');
  row.className = 'trow';
  row.dataset.rel = t.rel;
  const dur = t.duration ? fmtTime(t.duration) : '--:--';
  row.innerHTML = `
    <div class="t-idx"><span>${i + 1}</span></div>
    <div class="t-main">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-sub">${esc(t.artist)} · ${esc(t.album)}</div>
    </div>
    <span class="t-dur">${dur}</span>
    <div class="t-act">
      <button class="icon-btn small t-like ${t.liked ? 'liked' : ''}" aria-label="喜欢">${icon('heart')}</button>
      <button class="icon-btn small t-more" aria-label="更多">${icon('more')}</button>
    </div>`;
  if (t.liked) row.querySelector('.t-like svg').style.fill = 'currentColor';
  row.insertBefore(phNode(t.albumKey, t.rel, extOf(t.name), 'thumb'), row.querySelector('.t-main'));
  if (player.currentRel() === t.rel) markRowPlaying(row);
  return row;
}

function extOf(name) { const i = (name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1) : ''; }

function markRowPlaying(row) {
  row.classList.add('playing');
  const idx = row.querySelector('.t-idx');
  if (idx) idx.innerHTML = '<span class="eq-anim"><i></i><i></i><i></i></span>';
}
export function updatePlayingRows() {
  const cur = player.currentRel();
  document.querySelectorAll('.trow.playing').forEach(r => {
    if (r.dataset.rel !== cur) {
      r.classList.remove('playing');
      const i = [...r.parentNode.children].filter(x => x.classList.contains('trow')).indexOf(r);
      const idx = r.querySelector('.t-idx');
      if (idx) idx.innerHTML = `<span>${i + 1}</span>`;
    }
  });
  if (cur) {
    const row = document.querySelector(`.trow[data-rel="${CSS.escape(cur)}"]`);
    if (row && !row.classList.contains('playing')) markRowPlaying(row);
  }
}

function bindListEvents(listEl, ctx = {}) {
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.trow');
    if (!row) return;
    const rel = row.dataset.rel;
    const t = byRel.get(rel);
    if (!t) return;
    if (e.target.closest('.t-more')) {
      const r = e.target.closest('.t-more').getBoundingClientRect();
      showMenu(trackMenu(t, ctx), r.left, r.bottom + 4);
      return;
    }
    if (e.target.closest('.t-like')) { toggleLike(t); return; }
    if (player.currentRel() === rel) { player.toggle(); return; }
    // 播放：以当前列表为队列
    const rows = [...listEl.querySelectorAll('.trow')].map(x => x.dataset.rel);
    player.playRels(rows, rel);
  });
  listEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.trow');
    if (!row) return;
    e.preventDefault();
    const t = byRel.get(row.dataset.rel);
    if (t) showMenu(trackMenu(t, ctx), e.clientX, e.clientY);
  });
}

function refreshList() {
  if (nav.tab === 'songs' && !nav.detail) renderSongs();
  else if (nav.detail) renderContent();
  else renderContent();
}

export function toggleLike(t) {
  t.liked = !t.liked;
  t.likedAt = t.liked ? Date.now() : undefined;
  db.putTrack({ ...t });
  document.querySelectorAll(`.trow[data-rel="${CSS.escape(t.rel)}"] .t-like`).forEach(b => {
    b.classList.toggle('liked', t.liked);
    const svg = b.querySelector('svg');
    if (svg) svg.style.fill = t.liked ? 'currentColor' : 'none';
  });
  toast(t.liked ? '已加入喜欢的音乐' : '已取消喜欢');
  if (nav.tab === 'playlists' && !nav.detail) renderContent();
}

// ---------- 曲目菜单 ----------
function trackMenu(t, ctx) {
  const items = [];
  const playlistsItems = playlists.map(p => ({
    label: p.name, icon: 'playlist',
    onClick: () => addToPlaylist(p, t.rel),
  }));
  items.push(
    { label: '播放', icon: 'play', onClick: () => player.playRels([t.rel], t.rel) },
    { label: '下一首播放', icon: 'playNext', onClick: () => player.playNextInQueue(t.rel) },
    { label: '加入队列', icon: 'queueAdd', onClick: () => player.addToQueueEnd(t.rel) },
    '-',
    {
      label: '添加到播放列表', icon: 'plus',
      children: [...playlistsItems, '-', { label: '新建播放列表…', icon: 'plus', onClick: async () => { const name = await promptDialog('新建播放列表', '播放列表名称'); if (name) { const p = { id: crypto.randomUUID(), name, rels: [t.rel], created: Date.now() }; await db.putPlaylist(p); await loadPlaylists(); toast('已创建并加入'); if (nav.tab === 'playlists') renderContent(); } } }],
    },
    { label: '查看专辑', icon: 'disc', onClick: () => { nav.detail = { type: 'album', key: t.albumKey, title: t.album }; render(); } },
    { label: '查看歌手', icon: 'mic', onClick: () => { nav.detail = { type: 'artist', key: t.artist, title: t.artist }; render(); } },
    { label: t.liked ? '取消喜欢' : '喜欢', icon: 'heart', onClick: () => toggleLike(t) },
  );
  if (ctx.playlistId) {
    items.push('-',
      {
        label: '从播放列表移除', icon: 'trash', danger: true,
        onClick: async () => {
          const p = playlists.find(x => x.id === ctx.playlistId);
          if (!p) return;
          const idx = p.rels.indexOf(t.rel);
          if (idx >= 0) p.rels.splice(idx, 1);
          await db.putPlaylist(p);
          renderContent();
          toast('已移除');
        },
      });
  }
  return items;
}

async function addToPlaylist(p, rel) {
  if (p.rels.includes(rel)) { toast('已在该播放列表中'); return; }
  p.rels.push(rel);
  await db.putPlaylist(p);
  toast(`已加入「${p.name}」`);
}

// ---------- 专辑页 ----------
function renderAlbums() {
  const q = norm(nav.search);
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>专辑</h2><div class="search-wrap" style="max-width:280px">${icon('search')}<input placeholder="搜索专辑" value="${esc(nav.search)}"></div>`;
  head.querySelector('input').addEventListener('input', debounce((e) => { nav.search = e.target.value; renderContent(); }, 200));
  frag.appendChild(head);
  if (!scanner.hasSource()) { frag.appendChild(emptySource()); contentEl.appendChild(frag); return; }

  const albums = albumsOf(tracks.filter(t => !q || norm(t.album).includes(q) || norm(t.artist).includes(q)))
    .sort((a, b) => collator.compare(a.album || '', b.album || ''));
  if (!albums.length) { frag.appendChild(emptyList('没有找到专辑')); contentEl.appendChild(frag); return; }
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const a of albums) {
    const card = document.createElement('div');
    card.className = 'acard';
    card.innerHTML = `<div class="name">${esc(a.album)}</div><div class="sub">${esc(a.artist)} · ${a.tracks.length}首</div>`;
    card.insertBefore(phNode(a.key, a.tracks[0].rel, extOf(a.tracks[0].name), 'art', 'disc'), card.firstChild);
    card.addEventListener('click', () => { nav.detail = { type: 'album', key: a.key, title: a.album }; render(); });
    grid.appendChild(card);
  }
  frag.appendChild(grid);
  contentEl.appendChild(frag);
}

function emptyList(msg) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = `${icon('music')}<b>${esc(msg)}</b>`;
  return d;
}

async function renderAlbumDetail() {
  const d = nav.detail;
  const albums = albumsOf(tracks);
  const a = albums.find(x => x.key === d.key);
  contentEl.innerHTML = '';
  if (!a) { contentEl.appendChild(emptyList('专辑不存在')); return; }
  const sorted = [...a.tracks].sort((x, y) => (x.discNo ?? 1) - (y.discNo ?? 1) || (x.trackNo ?? 999) - (y.trackNo ?? 999) || collator.compare(x.title, y.title));

  const head = document.createElement('div');
  head.className = 'detail-head';
  head.innerHTML = `<div class="info">
      <div class="kind">专辑</div>
      <h2>${esc(a.album)}</h2>
      <div class="meta"><span class="link-artist" style="cursor:pointer;text-decoration:underline dotted">${esc(a.artist)}</span>${a.year ? ' · ' + a.year : ''} · ${a.tracks.length}首 · ${fmtTime(a.dur)}</div>
    </div>`;
  head.insertBefore(phNode(a.key, sorted[0].rel, extOf(sorted[0].name), 'art', 'disc', 'detail'), head.firstChild);
  head.querySelector('.link-artist').addEventListener('click', () => { nav.detail = { type: 'artist', key: a.artist, title: a.artist }; render(); });
  contentEl.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.innerHTML = `<button class="btn" id="aPlay">${icon('play')}播放</button><button class="btn ghost" id="aShuffle">${icon('shuffle')}随机播放</button>`;
  contentEl.appendChild(actions);
  actions.querySelector('#aPlay').addEventListener('click', () => player.playRels(sorted.map(t => t.rel), sorted[0].rel));
  actions.querySelector('#aShuffle').addEventListener('click', () => {
    const rels = sorted.map(t => t.rel);
    player.playRels(rels, rels[Math.floor(Math.random() * rels.length)]);
  });

  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  contentEl.appendChild(listEl);
  const c = makeChunkList(listEl, renderTrackRow);
  c.reset(sorted);
  bindListEvents(listEl);
}

// ---------- 歌手页 ----------
function renderArtists() {
  const q = norm(nav.search);
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>歌手</h2><div class="search-wrap" style="max-width:280px">${icon('search')}<input placeholder="搜索歌手" value="${esc(nav.search)}"></div>`;
  head.querySelector('input').addEventListener('input', debounce((e) => { nav.search = e.target.value; renderContent(); }, 200));
  frag.appendChild(head);
  if (!scanner.hasSource()) { frag.appendChild(emptySource()); contentEl.appendChild(frag); return; }

  const map = new Map();
  for (const t of tracks) {
    if (q && !norm(t.artist).includes(q)) continue;
    let a = map.get(t.artist);
    if (!a) { a = { name: t.artist, tracks: [], albums: new Set() }; map.set(t.artist, a); }
    a.tracks.push(t);
    a.albums.add(t.albumKey);
  }
  const artists = [...map.values()].sort((x, y) => collator.compare(x.name, y.name));
  if (!artists.length) { frag.appendChild(emptyList('没有找到歌手')); contentEl.appendChild(frag); return; }
  const list = document.createElement('div');
  list.className = 'track-list';
  for (const a of artists) {
    const row = document.createElement('div');
    row.className = 'arow';
    const grad = gradFor(a.name);
    row.innerHTML = `<div class="avatar" style="background:${grad}">${esc(a.name.slice(0, 1).toUpperCase())}</div>
      <div style="flex:1;min-width:0"><div class="name">${esc(a.name)}</div><div class="sub">${a.albums.size} 张专辑 · ${a.tracks.length} 首</div></div>${icon('back')}`;
    row.querySelector('svg').style.transform = 'rotate(180deg)';
    row.querySelector('svg').style.color = 'var(--text3)';
    row.addEventListener('click', () => { nav.detail = { type: 'artist', key: a.name, title: a.name }; render(); });
    list.appendChild(row);
  }
  frag.appendChild(list);
  contentEl.appendChild(frag);
}

function renderArtistDetail() {
  const name = nav.detail.key;
  const list = tracks.filter(t => t.artist === name || t.albumArtist === name);
  contentEl.innerHTML = '';
  if (!list.length) { contentEl.appendChild(emptyList('歌手不存在')); return; }
  const sorted = sortTracks(list, 'album', 'asc');

  const head = document.createElement('div');
  head.className = 'detail-head';
  const grad = gradFor(name);
  head.innerHTML = `<div class="ph" style="background:${grad}">${icon('mic')}</div>
    <div class="info"><div class="kind">歌手</div><h2>${esc(name)}</h2>
    <div class="meta">${new Set(list.map(t => t.albumKey)).size} 张专辑 · ${list.length} 首</div></div>`;
  contentEl.appendChild(head);
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.innerHTML = `<button class="btn" id="aPlay">${icon('play')}播放</button><button class="btn ghost" id="aShuffle">${icon('shuffle')}随机播放</button>`;
  contentEl.appendChild(actions);
  actions.querySelector('#aPlay').addEventListener('click', () => player.playRels(sorted.map(t => t.rel), sorted[0].rel));
  actions.querySelector('#aShuffle').addEventListener('click', () => {
    const rels = sorted.map(t => t.rel);
    player.playRels(rels, rels[Math.floor(Math.random() * rels.length)]);
  });

  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  contentEl.appendChild(listEl);
  const c = makeChunkList(listEl, renderTrackRow);
  c.reset(sorted);
  bindListEvents(listEl);
}

// ---------- 播放列表页 ----------
function renderPlaylists() {
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>播放列表</h2><button class="btn ghost small" id="btnNewPl">${icon('plus')}新建</button>`;
  head.querySelector('#btnNewPl').addEventListener('click', async () => {
    const name = await promptDialog('新建播放列表', '播放列表名称');
    if (!name) return;
    await db.putPlaylist({ id: crypto.randomUUID(), name, rels: [], created: Date.now() });
    await loadPlaylists();
    renderContent();
  });
  frag.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'plcards';
  const liked = tracks.filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  const recent = tracks.filter(t => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 200);
  const cards = [
    { id: '__liked', name: '喜欢的音乐', sub: `${liked.length} 首`, grad: 'linear-gradient(135deg,#f5576c,#ff8fab)', ic: 'heart', rels: liked },
    { id: '__recent', name: '最近播放', sub: `${recent.length} 首`, grad: 'linear-gradient(135deg,#4facfe,#00f2fe)', ic: 'clock', rels: recent },
    ...playlists.map(p => ({ id: p.id, name: p.name, sub: `${p.rels.filter(r => byRel.has(r)).length} 首`, grad: gradFor(p.id), ic: 'playlist', pl: p })),
  ];
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'plcard';
    card.innerHTML = `<div class="cover" style="background:${c.grad}">${icon(c.ic)}</div>
      <div style="flex:1;min-width:0"><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.sub)}</div></div>
      <button class="icon-btn small pl-more" aria-label="更多">${icon('more')}</button>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pl-more')) {
        const r = e.target.closest('.pl-more').getBoundingClientRect();
        if (c.pl) {
          showMenu([
            { label: '播放', icon: 'play', onClick: () => { if (c.pl.rels.length) player.playRels(c.pl.rels.filter(r => byRel.has(r)), c.pl.rels[0]); else toast('播放列表为空'); } },
            { label: '重命名', icon: 'edit', onClick: async () => { const name = await promptDialog('重命名播放列表', '', c.pl.name); if (name) { c.pl.name = name; await db.putPlaylist(c.pl); await loadPlaylists(); renderContent(); } } },
            { label: '删除播放列表', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('删除播放列表', `确定删除「${c.pl.name}」？歌曲不会从媒体库删除。`, '删除', true)) { await db.deletePlaylist(c.pl.id); await loadPlaylists(); renderContent(); } } },
          ], r.left, r.bottom + 4);
        }
        return;
      }
      if (c.id === '__liked') { if (!liked.length) return toast('还没有喜欢的音乐，点击歌曲行的心形即可'); nav.detail = { type: 'playlist', key: '__liked', title: '喜欢的音乐' }; }
      else if (c.id === '__recent') { if (!recent.length) return toast('还没有播放记录'); nav.detail = { type: 'playlist', key: '__recent', title: '最近播放' }; }
      else nav.detail = { type: 'playlist', key: c.id, title: c.pl.name };
      render();
    });
    grid.appendChild(card);
  }
  frag.appendChild(grid);
  contentEl.appendChild(frag);
}

function renderPlaylistDetail() {
  const d = nav.detail;
  contentEl.innerHTML = '';
  let rels;
  let ctx = {};
  if (d.key === '__liked') rels = tracks.filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.rel);
  else if (d.key === '__recent') rels = tracks.filter(t => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).map(t => t.rel);
  else {
    const p = playlists.find(x => x.id === d.key);
    if (!p) { contentEl.appendChild(emptyList('播放列表不存在')); return; }
    rels = p.rels.filter(r => byRel.has(r));
    ctx = { playlistId: p.id };
  }
  const items = rels.map(r => byRel.get(r)).filter(Boolean);

  const head = document.createElement('div');
  head.className = 'detail-head';
  head.innerHTML = `<div class="ph" style="background:${gradFor(d.key)}">${icon('playlist')}</div>
    <div class="info"><div class="kind">播放列表</div><h2>${esc(d.title)}</h2><div class="meta">${items.length} 首</div></div>`;
  contentEl.appendChild(head);
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.innerHTML = `<button class="btn" id="aPlay" ${items.length ? '' : 'disabled style="opacity:.5"'}>${icon('play')}播放</button>
    <button class="btn ghost" id="aShuffle" ${items.length ? '' : 'disabled style="opacity:.5"'}>${icon('shuffle')}随机播放</button>`;
  contentEl.appendChild(actions);
  actions.querySelector('#aPlay').addEventListener('click', () => player.playRels(rels, rels[0]));
  actions.querySelector('#aShuffle').addEventListener('click', () => player.playRels(rels, rels[Math.floor(Math.random() * rels.length)]));

  if (!items.length) { contentEl.appendChild(emptyList('列表为空')); return; }
  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  contentEl.appendChild(listEl);
  const c = makeChunkList(listEl, (t, i) => renderTrackRow(t, i));
  c.reset(items);
  bindListEvents(listEl, ctx);
}

// ---------- 设置页 ----------
const EQ_PRESETS = {
  '自定义': null,
  '平坦': [0, 0, 0, 0, 0],
  '低音增强': [6, 4, 1, 0, 0],
  '人声突出': [-2, 1, 4, 3, 0],
  '高音增强': [0, 0, 1, 4, 6],
  '电子': [4, 2, 0, 2, 4],
  '摇滚': [5, 2, -1, 2, 5],
};
function eqPresetOf(gains) {
  for (const [name, g] of Object.entries(EQ_PRESETS)) {
    if (g && g.every((v, i) => Math.abs(v - (gains[i] || 0)) < 0.5)) return name;
  }
  return '自定义';
}

function renderSettings() {
  contentEl.innerHTML = '';
  const p = prefs();
  const wrap = document.createElement('div');
  wrap.className = 'settings';
  const themeIcon = { light: 'sun', dark: 'moon', glass: 'drop' }[p.theme];
  wrap.innerHTML = `
    <h2>外观</h2>
    <div class="card set-group">
      <div class="set-row">
        <span class="icon-btn" style="cursor:default">${icon(themeIcon)}</span>
        <div class="lab"><b>主题</b><span>液态玻璃为毛玻璃质感，深浅色为纯色</span></div>
        <div class="seg" id="themeSeg">
          <button data-t="light" class="${p.theme === 'light' ? 'active' : ''}">浅色</button>
          <button data-t="dark" class="${p.theme === 'dark' ? 'active' : ''}">深色</button>
          <button data-t="glass" class="${p.theme === 'glass' ? 'active' : ''}">液态玻璃</button>
        </div>
      </div>
    </div>

    <h2>音乐文件夹</h2>
    <div class="card set-group">
      <div class="set-row" style="flex-wrap:wrap">
        <span class="icon-btn" style="cursor:default">${icon('folder')}</span>
        <div class="lab"><b id="folderName">${esc(scanner.state.name || '未选择')}</b><span id="folderStats">${scanner.hasSource() ? `${tracks.length} 首歌曲 · 来源：${scanner.state.mode === 'fsa' ? '已记住的文件夹' : '本次会话文件'}` : '尚未选择音乐文件夹'}</span></div>
        <div style="display:flex;gap:8px">
          <button class="btn small" id="btnPick">${icon('folder')}${scanner.hasSource() ? '更换' : '选择文件夹'}</button>
          <button class="btn ghost small" id="btnRescan" ${scanner.hasSource() ? '' : 'disabled style="opacity:.5"'}>${icon('refresh')}重新扫描</button>
        </div>
      </div>
      ${'showDirectoryPicker' in window ? '' : `<div class="set-row"><div class="lab"><span>当前浏览器不支持文件夹句柄记忆（建议 Chrome / Edge），将使用文件选择方式，刷新后需重新选择。</span></div></div>`}
    </div>

    <h2>播放</h2>
    <div class="card set-group">
      <div class="set-row"><div class="lab"><b>显示歌词</b><span>自动读取同名 .lrc 文件</span></div><label class="switch"><input type="checkbox" id="swLyrics" ${p.lyricsOn ? 'checked' : ''}><span class="knob"></span></label></div>
      <div class="set-row"><div class="lab"><b>频谱动画</b><span>正在播放界面底部</span></div><label class="switch"><input type="checkbox" id="swViz" ${p.visualizerOn ? 'checked' : ''}><span class="knob"></span></label></div>
      <div class="set-row"><div class="lab"><b>记住播放进度</b><span>下次打开时恢复上次队列与进度</span></div><label class="switch"><input type="checkbox" id="swRestore" ${p.restoreOn ? 'checked' : ''}><span class="knob"></span></label></div>
    </div>

    <h2>均衡器</h2>
    <div class="card set-group">
      <div class="set-row"><div class="lab"><b>启用均衡器</b><span>5 段均衡，实时生效</span></div><label class="switch"><input type="checkbox" id="swEq" ${p.eqOn ? 'checked' : ''}><span class="knob"></span></label></div>
      <div class="set-row"><div class="lab"><b>预设</b></div>
        <select class="input" id="eqPreset">${Object.keys(EQ_PRESETS).map(n => `<option ${eqPresetOf(p.eqGains) === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <div class="eq-sliders" id="eqSliders">
        ${BANDS.map((f, i) => `<div class="eq-band"><input type="range" min="-12" max="12" step="1" value="${p.eqGains[i]}" data-band="${i}" ${p.eqOn ? '' : 'disabled'}><span>${f >= 1000 ? (f / 1000) + 'k' : f}</span></div>`).join('')}
      </div>
    </div>

    <h2>数据与安装</h2>
    <div class="card set-group">
      <div class="set-row"><div class="lab"><b>存储占用</b><span id="storageInfo">计算中…</span></div></div>
      <div class="set-row" id="rowInstall" hidden><div class="lab"><b>安装应用</b><span>像原生应用一样从桌面 / 主屏启动</span></div><button class="btn small" id="btnInstall">${icon('download')}安装</button></div>
      <div class="set-row"><div class="lab"><b>检查更新</b><span>应用缓存版本 ${APP_VERSION}</span></div><button class="btn ghost small" id="btnUpdate">${icon('refresh')}检查</button></div>
      <div class="set-row"><div class="lab"><b>清除播放统计</b><span>重置播放次数与最近播放</span></div><button class="btn ghost small" id="btnClearStats">清除</button></div>
      <div class="set-row"><div class="lab"><b>清空媒体库</b><span>删除所有索引与封面缓存（源文件不受影响）</span></div><button class="btn ghost-danger small" id="btnWipe">清空</button></div>
    </div>

    <h2>快捷键</h2>
    <div class="card set-group">
      <div class="kbd-list">
        <div><span>播放 / 暂停</span><kbd>空格</kbd></div>
        <div><span>快退 / 快进 5 秒</span><kbd>← / →</kbd></div>
        <div><span>音量</span><kbd>↑ / ↓</kbd></div>
        <div><span>上一首 / 下一首</span><kbd>P / N</kbd></div>
        <div><span>静音</span><kbd>M</kbd></div>
        <div><span>随机播放</span><kbd>S</kbd></div>
        <div><span>循环模式</span><kbd>R</kbd></div>
        <div><span>喜欢当前曲目</span><kbd>L</kbd></div>
        <div><span>正在播放全屏</span><kbd>F</kbd></div>
        <div><span>搜索</span><kbd>/</kbd></div>
      </div>
    </div>

    <h2>关于</h2>
    <div class="card set-group">
      <div class="set-row"><div class="lab"><b>本地音乐播放器</b><span>版本 ${APP_VERSION} · 纯离线 PWA</span></div></div>
      <div class="set-row"><div class="lab"><span>所有音乐、封面、播放列表都保存在你的浏览器本地，<b>不发起任何网络请求</b>（除加载本应用自身页面外）。支持的格式：MP3 / FLAC / M4A / AAC / OGG / Opus / WAV / WebM。</span></div></div>
    </div>
  `;
  contentEl.appendChild(wrap);

  // 主题
  wrap.querySelector('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    setPref('theme', b.dataset.t);
    import('./prefs.js').then(m => m.applyTheme(b.dataset.t));
    renderContent();
  });
  // 文件夹
  wrap.querySelector('#btnPick').addEventListener('click', pickFolder);
  wrap.querySelector('#btnRescan').addEventListener('click', () => rescanAndRefresh(true));
  // 开关
  wrap.querySelector('#swLyrics').addEventListener('change', (e) => setPref('lyricsOn', e.target.checked));
  wrap.querySelector('#swViz').addEventListener('change', (e) => setPref('visualizerOn', e.target.checked));
  wrap.querySelector('#swRestore').addEventListener('change', (e) => setPref('restoreOn', e.target.checked));
  // EQ
  wrap.querySelector('#swEq').addEventListener('change', (e) => { eq.setEqOn(e.target.checked); renderContent(); });
  wrap.querySelector('#eqPreset').addEventListener('change', (e) => {
    const g = EQ_PRESETS[e.target.value];
    if (g) { setPref('eqGains', [...g]); eq.applyGains(g, prefs().eqOn); renderContent(); }
  });
  wrap.querySelectorAll('#eqSliders input').forEach(inp => {
    inp.addEventListener('input', () => {
      eq.setGain(Number(inp.dataset.band), Number(inp.value));
      const sel = wrap.querySelector('#eqPreset');
      sel.value = eqPresetOf(prefs().eqGains);
    });
  });
  // 数据
  wrap.querySelector('#btnUpdate').addEventListener('click', async () => {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { await reg.update(); toast('已检查，如有更新将自动应用'); }
      else toast('Service Worker 未注册');
    }
  });
  wrap.querySelector('#btnClearStats').addEventListener('click', async () => {
    if (!(await confirmDialog('清除播放统计', '将重置所有歌曲的播放次数与最近播放时间。', '清除'))) return;
    for (const t of tracks) { t.playCount = 0; t.lastPlayed = undefined; }
    await db.bulkPutTracks(tracks);
    toast('已清除');
  });
  wrap.querySelector('#btnWipe').addEventListener('click', async () => {
    if (!(await confirmDialog('清空媒体库', '将删除所有索引、封面缓存与播放记录（源文件不受影响）。清空后需重新扫描。', '清空', true))) return;
    const { clearTracks, clearArt, kvSet } = await import('./db.js');
    await clearTracks(); await clearArt(); await kvSet('playstate', undefined);
    art.invalidateArt();
    await loadFromDB();
    renderContent();
    toast('媒体库已清空');
  });
  if (deferredPrompt) wrap.querySelector('#rowInstall').hidden = false;
  wrap.querySelector('#btnInstall')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const r = await deferredPrompt.userChoice;
    if (r.outcome === 'accepted') toast('感谢安装！');
    deferredPrompt = null;
    renderContent();
  });
  // 存储估算
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(({ usage }) => {
      const s = wrap.querySelector('#storageInfo');
      if (s && usage != null) s.textContent = `约 ${(usage / 1048576).toFixed(1)} MB（索引与封面缓存）`;
    });
  } else {
    const s = wrap.querySelector('#storageInfo');
    if (s) s.textContent = `${tracks.length} 首歌曲已索引`;
  }
}

export function setInstallPrompt(p) {
  deferredPrompt = p;
  if (nav.tab === 'settings' && !nav.detail) renderContent();
}
export function setReconnectNeeded(v) { reconnectNeeded = v; }

// ---------- 文件夹选择与扫描 ----------
async function pickFolder() {
  if ('showDirectoryPicker' in window) {
    try {
      const h = await showDirectoryPicker({ mode: 'read', id: 'music' });
      await scanner.setFsaRoot(h);
      await rescanAndRefresh(true);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('目录选择失败，尝试文件方式', e);
      fallbackPick();
    }
  } else {
    fallbackPick();
  }
}
function fallbackPick() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.webkitdirectory = true;
  inp.addEventListener('change', async () => {
    if (!inp.files || !inp.files.length) return;
    scanner.setFiles([...inp.files]);
    await rescanAndRefresh(true);
  });
  inp.click();
}

export async function rescanAndRefresh(showToast = true) {
  const r = await scanner.scan();
  await loadFromDB();
  render();
  if (showToast) {
    const parts = [`新增 ${r.added} 首`];
    if (r.removed) parts.push(`移除 ${r.removed} 首`);
    if (r.failed) parts.push(`${r.failed} 个文件读取失败`);
    toast(parts.join('，') || '媒体库已是最新');
  }
  return r;
}

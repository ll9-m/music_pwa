// 视图渲染：歌曲 / 专辑 / 歌手 / 播放列表 / 设置 + 详情页
import * as db from './db.js';
import { prefs, setPref } from './prefs.js';
import { icon, esc, fmtTime, toast, showMenu, closeMenu, confirmDialog, promptDialog, debounce, gradFor, collator, paintRange } from './ui.js';
import * as scanner from './scanner.js';
import * as player from './player.js';
import * as art from './art.js';
import * as eq from './eq.js';
import { BANDS } from './eq.js';
import * as bili from './bili.js';

export const APP_VERSION = '1.0.0';

let tracks = [];
const byRel = new Map();
let playlists = [];
let animeList = [];      // 番剧库（与音频文件无关，重新扫描音乐文件夹不影响它）

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

/**
 * 读番剧库。
 * 刻意**不做**「整个会话只读一次」的缓存：那类缓存必须由每条写入路径手动失效，
 * 漏一条就表现为「我明明改了，页面还是旧的」——
 * 而番剧记录会被表单、菜单删除、补全写回等多条路径修改，很难保证全覆盖。
 * 这里改成「每次需要显示番剧时都重读」：番剧数量是几十级别、读取是一次 getAll，
 * 代价远小于缓存不一致的代价。
 */
async function loadAnime() {
  try {
    animeList = await db.getAllAnime();
  } catch { animeList = []; }
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

// ---------- 搜索框通用绑定 ----------
// IME 组合期间（打拼音未选字）绝不能触发过滤/重渲染：重渲染会替换输入框或抢焦点，
// 直接掐断输入法，表现为「只能打出拼音字母、中文打不出来」。
// 组合结束后（compositionend）再统一读取最终文本执行一次过滤。
function bindSearch(input, onQuery) {
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; onQuery(input.value); });
  input.addEventListener('input', () => { if (!composing) onQuery(input.value); });
}
// 重渲染后把焦点与光标还给搜索框（只在搜索态下需要）。
// 延迟到本轮同步渲染结束后执行：渲染函数用 frag 组装、可能尚未挂载 DOM，
// 提前 focus() 不生效；且重渲染会替换输入框，必须重新查询。
function restoreSearchFocus() {
  setTimeout(() => {
    const input = document.querySelector('.search-wrap input');
    if (searchFocus && input && document.activeElement !== input) {
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 某些输入类型不支持 */ }
    }
  }, 0);
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
let rootEl, headerEl, navEl, actionsEl, sideCountEl, sideSrcEl, contentEl;
// 当前视图的完整曲目顺序（分块渲染后 DOM 里只有一部分，队列必须用这个，而不是读 DOM）
let listContext = [];
// 分块渲染句柄：每次重渲染前销毁，避免 IntersectionObserver 泄漏
let chunkHandles = [];
// 搜索框在重渲染后需要恢复焦点
let searchFocus = false;

const TABS = [
  ['songs', '歌曲', 'music'],
  ['albums', '专辑', 'disc'],
  ['artists', '歌手', 'mic'],
  ['playlists', '播放列表', 'playlist'],
  ['anime', '番剧', 'screen'],
  ['settings', '设置', 'settings'],
];

export function init() {
  rootEl = document.getElementById('view');
  headerEl = document.querySelector('#appHeader h1');
  navEl = document.getElementById('nav');
  actionsEl = document.getElementById('hActions');
  sideCountEl = document.getElementById('sideCount');
  sideSrcEl = document.getElementById('sideSrc');
  const mark = document.getElementById('brandMark');
  if (mark) mark.innerHTML = icon('music');
}

export async function render() {
  // 番剧数据必须在渲染前就位（renderContent 刻意保持同步，见其注释）。
  // 每次都重读而不做「已加载」缓存：番剧是几十条量级、getAll 是一次事务，
  // 代价可忽略；而任何缓存都必须由每条写入路径手动失效，
  // 漏一条就是「我明明改了，页面还是旧的」。这里选择消灭这类 bug 的土壤。
  if (nav.tab === 'anime' || (nav.detail && nav.detail.type === 'anime')) {
    await loadAnime();
  }
  renderNav();
  renderHeader();
  renderContent();
  updateSideStats();
  setTimeout(loadVisibleArt, 60);
  window.scrollTo({ top: 0 });
}

function renderNav() {
  const counts = { songs: tracks.length };
  navEl.innerHTML = TABS.map(([id, label, ic]) =>
    `<button data-tab="${id}" class="${nav.tab === id && !nav.detail ? 'active' : ''}" title="${label}">
      <span class="ni">${icon(ic)}</span><span class="nl">${label}</span>
      ${counts[id] != null ? `<span class="nbadge">${counts[id]}</span>` : ''}
    </button>`).join('');
  navEl.onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { nav.tab = b.dataset.tab; nav.detail = null; nav.search = ''; searchFocus = false; render(); }
  };
}

function updateSideStats() {
  if (sideCountEl) sideCountEl.textContent = tracks.length ? String(tracks.length) : '0';
  if (sideSrcEl) {
    const name = scanner.hasSource() ? (scanner.state.name || '已连接') : '未选择音乐文件夹';
    sideSrcEl.textContent = name;
    sideSrcEl.title = name;
  }
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

  actionsEl.innerHTML = scanner.hasSource()
    ? `<button class="icon-btn small" id="btnRescanTop" aria-label="重新扫描" title="重新扫描">${icon('refresh')}</button>`
    : '';
  const rb = document.getElementById('btnRescanTop');
  if (rb) rb.addEventListener('click', () => rescanAndRefresh(true));
}

function renderContent() {
  // 销毁上一视图的分块观察器
  for (const h of chunkHandles) h.destroy();
  chunkHandles = [];
  contentEl = rootEl;
  contentEl.innerHTML = '';
  if (nav.detail) {
    if (nav.detail.type === 'album') return renderAlbumDetail();
    if (nav.detail.type === 'artist') return renderArtistDetail();
    if (nav.detail.type === 'playlist') return renderPlaylistDetail();
    if (nav.detail.type === 'anime') return renderAnimeDetail(nav.detail.key);
  }
  // 刻意保持同步：番剧数据由 ensureAnime() 在 render() 之前预载好。
  // 早期版本把这里改成 async，结果 24 个调用点全部拿到未完成的 Promise ——
  // 同步部分照跑、switch 被推到微任务，表现为「页面空白且无报错」，
  // 极难定位。异步数据必须在渲染前 await 完，不该渗进渲染函数。
  switch (nav.tab) {
    case 'songs': return renderSongs();
    case 'albums': return renderAlbums();
    case 'artists': return renderArtists();
    case 'playlists': return renderPlaylists();
    case 'anime': return renderAnime();
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
function renderSongs() {
  const q = norm(nav.search);
  const frag = document.createDocumentFragment();

  if (reconnectNeeded) frag.appendChild(reconnectBanner());

  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `
    <h2>歌曲</h2>
    <div class="search-wrap">${icon('search')}<input placeholder="搜索歌曲、歌手、专辑" value="${esc(nav.search)}"><button class="clear" ${nav.search ? '' : 'hidden'}>${icon('x')}</button></div>
    <button class="icon-btn" id="btnSort" aria-label="排序" title="排序">${icon('sort')}</button>`;
  frag.appendChild(head);
  const searchInput = head.querySelector('input');
  // IME 组合期间不过滤（见 bindSearch 注释），组合结束再统一过滤一次
  bindSearch(searchInput, (v) => {
    nav.search = v;
    searchFocus = true;
    const cl = head.querySelector('.clear');
    if (cl) cl.hidden = !nav.search;
    refreshList();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.search) {
      searchFocus = false; nav.search = ''; searchInput.value = ''; refreshList();
    }
  });
  head.querySelector('.clear').addEventListener('click', () => {
    nav.search = ''; searchFocus = false; searchInput.value = ''; refreshList();
  });
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
    listContext = [];
    frag.appendChild(emptySource());
    contentEl.appendChild(frag);
    return;
  }

  const list = sortTracks(tracks.filter(t => matchSearch(t, q)));
  if (!list.length) {
    listContext = [];
    const e = emptyList(tracks.length ? '没有匹配的歌曲' : '没有找到音乐文件');
    if (!tracks.length) e.innerHTML += `<p>确认文件夹里有音频文件后，点击“重新扫描”。</p>`;
    frag.appendChild(e);
    contentEl.appendChild(frag);
    return;
  }
  const info = document.createElement('div');
  info.className = 'list-info';
  info.innerHTML = `<span class="count">共 ${list.length} 首</span>
    <span class="spacer"></span>
    <button class="btn ghost small" id="btnShuffleAll">${icon('shuffle')}随机播放全部</button>`;
  frag.appendChild(info);
  info.querySelector('#btnShuffleAll').addEventListener('click', () => {
    if (!list.length) return toast('没有可播放的歌曲');
    player.playShuffled(list.map(t => t.rel));
  });

  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  frag.appendChild(listEl);
  contentEl.appendChild(frag);

  // 播放队列取完整列表（不是 DOM 里已渲染的那部分）
  listContext = list.map(t => t.rel);
  const chunk = makeChunkList(listEl, renderTrackRow);
  chunk.reset(list);
  bindListEvents(listEl);
}

function makeChunkList(container, renderRow, size = 60) {
  const sentinel = document.createElement('div');
  sentinel.className = 'chunk-sentinel';
  let items = [], n = 0;
  const io = new IntersectionObserver((es) => {
    if (es[0].isIntersecting) loadMore();
  }, { rootMargin: '600px' });
  function loadMore() {
    if (n >= items.length) return;
    const end = Math.min(items.length, n + size);
    const f = document.createDocumentFragment();
    for (; n < end; n++) f.appendChild(renderRow(items[n], n));
    container.insertBefore(f, sentinel);
  }
  container.appendChild(sentinel);
  io.observe(sentinel);
  const handle = {
    reset(list) {
      container.querySelectorAll('.trow, .arow, .acard').forEach(x => x.remove());
      items = list; n = 0;
      if (!container.contains(sentinel)) container.appendChild(sentinel);
      loadMore();
    },
    destroy() {
      io.disconnect();
      items = []; n = 0;
    },
  };
  chunkHandles.push(handle);
  return handle;
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
      <div class="t-sub">${esc(t.artist)}</div>
    </div>
    <div class="t-album">${esc(t.album)}</div>
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
    // 播放：以完整列表为队列（分块渲染时 DOM 里只有前几十行，不能读 DOM）
    const rows = listContext.length ? listContext : [...listEl.querySelectorAll('.trow')].map(x => x.dataset.rel);
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
  // 必须走 renderContent()（它会先清空容器）。
  // 之前在歌曲页直接调 renderSongs()，而 renderSongs 只往容器里 append、不清空，
  // 结果每敲一个字符就往页面后面追加一整份视图 —— 出现两个搜索框、两份列表。
  renderContent();
  restoreSearchFocus();
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
  const albumSearch = head.querySelector('input');
  bindSearch(albumSearch, (v) => { nav.search = v; searchFocus = true; renderContent(); restoreSearchFocus(); });
  frag.appendChild(head);
  if (!scanner.hasSource()) { frag.appendChild(emptySource()); contentEl.appendChild(frag); return; }

  const albums = albumsOf(tracks.filter(t => !q || norm(t.album).includes(q) || norm(t.artist).includes(q)))
    .sort((a, b) => collator.compare(a.album || '', b.album || ''));
  if (!albums.length) { frag.appendChild(emptyList('没有找到专辑')); contentEl.appendChild(frag); return; }
  const grid = document.createElement('div');
  grid.className = 'grid';
  frag.appendChild(grid);
  contentEl.appendChild(frag);
  listContext = [];
  const c = makeChunkList(grid, renderAlbumCard, 48);
  c.reset(albums);
}

function renderAlbumCard(a) {
  const card = document.createElement('div');
  card.className = 'acard';
  card.innerHTML = `<div class="name">${esc(a.album)}</div><div class="sub">${esc(a.artist)} · ${a.tracks.length}首</div>`;
  card.insertBefore(phNode(a.key, a.tracks[0].rel, extOf(a.tracks[0].name), 'art', 'disc'), card.firstChild);
  card.addEventListener('click', () => { nav.detail = { type: 'album', key: a.key, title: a.album }; render(); });
  return card;
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
  const rels = sorted.map(t => t.rel);
  listContext = rels;
  actions.querySelector('#aPlay').addEventListener('click', () => player.playRels(rels, rels[0]));
  actions.querySelector('#aShuffle').addEventListener('click', () => player.playShuffled(rels));

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
  const artistSearch = head.querySelector('input');
  bindSearch(artistSearch, (v) => { nav.search = v; searchFocus = true; renderContent(); restoreSearchFocus(); });
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
  const rels = sorted.map(t => t.rel);
  listContext = rels;
  actions.querySelector('#aPlay').addEventListener('click', () => player.playRels(rels, rels[0]));
  actions.querySelector('#aShuffle').addEventListener('click', () => player.playShuffled(rels));

  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  contentEl.appendChild(listEl);
  const c = makeChunkList(listEl, renderTrackRow);
  c.reset(sorted);
  bindListEvents(listEl);
}

// ---------- 番剧库 ----------
// 定位：它是「音乐播放器的附赠」，不是第二个视频播放器。
// 所以内嵌播放器是主路径，但「在 B 站打开」永远在同一个位置 ———
// B 站随时可能改嵌入策略，内嵌一旦失效不能只剩白屏。

/** 把番剧补全为可内嵌（需本地 server.js 代理）。成功则写回记录。 */
async function resolveAnime(id) {
  const rec = animeList.find(x => x.id === id);
  if (!rec) return null;
  const parsed = bili.parseBiliURL(rec.url);
  const got = await bili.resolveEmbeddable(parsed);
  if (!got) return null;
  rec.bvid = got.bvid;
  rec.cid = got.cid || rec.cid || 0;
  if (got.title && !rec.title) rec.title = got.title;
  if (got.cover) rec.cover = got.cover;
  if (got.episodes && got.episodes.length) {
    rec.episodes = got.episodes;
    rec.currentIndex = got.currentIndex || 0;
  }
  await db.putAnime(rec);
  return rec;
}

function animeCard(rec) {
  const card = document.createElement('div');
  card.className = 'anime-card';
  const embeddable = bili.canEmbed(rec);
  const cover = rec.cover
    ? `<img class="ac-cover" src="${esc(rec.cover)}" alt="" loading="lazy">`
    : `<div class="ac-cover ac-ph" style="background:${gradFor(rec.id)}">${icon('screen')}</div>`;
  card.innerHTML = `${cover}
    <div class="ac-body">
      <div class="ac-title">${esc(rec.title || '未命名番剧')}</div>
      <div class="ac-sub">${esc(animeSubtitle(rec))}</div>
    </div>
    <button class="icon-btn small ac-more" aria-label="更多">${icon('more')}</button>`;

  card.addEventListener('click', async (e) => {
    if (e.target.closest('.ac-more')) {
      const r = e.target.closest('.ac-more').getBoundingClientRect();
      showMenu(animeMenu(rec), r.left, r.bottom + 4);
      return;
    }
    nav.detail = { type: 'anime', key: rec.id, title: rec.title || '番剧' };
    render();
  });
  return card;
}

function animeSubtitle(rec) {
  const bits = [];
  if (rec.kind === 'ss') bits.push(`ss${rec.seasonId}`);
  else if (rec.kind === 'ep') bits.push(`ep${rec.epId}`);
  else if (rec.kind === 'av') bits.push(`av${rec.aid}`);
  if (rec.episodes && rec.episodes.length) bits.push(`${rec.episodes.length} 集`);
  if (bili.canEmbed(rec)) bits.push('可内嵌');
  else bits.push('点开跳官网');
  return bits.join(' · ');
}

function animeMenu(rec) {
  return [
    { label: '播放', icon: 'play', onClick: () => { nav.detail = { type: 'anime', key: rec.id, title: rec.title || '番剧' }; render(); } },
    { label: '在 B 站打开', icon: 'external', onClick: () => window.open(bili.watchURL(rec), '_blank', 'noopener') },
    { label: '重命名', icon: 'edit', onClick: async () => {
      const name = await promptDialog('重命名番剧', '番剧名称', rec.title || '');
      if (name) { rec.title = name.trim(); await db.putAnime(rec); renderContent(); }
    } },
    ...(bili.canEmbed(rec) ? [] : [{
      label: '尝试补全为可内嵌', icon: 'refreshBili', onClick: async () => {
        toast('正在通过本地服务补全…');
        const got = await resolveAnime(rec.id);
        toast(got ? '补全成功，可在页面内播放' : '补全失败（需用 node server.js 启动本地服务）');
        renderContent();
      },
    }]),
    '-',
    { label: '删除', icon: 'trash', danger: true, onClick: async () => {
      if (await confirmDialog('删除番剧', `确定删除「${rec.title || '未命名番剧'}」？仅删除这条记录，不会影响音乐库。`, '删除', true)) {
        await db.deleteAnime(rec.id);
        animeList = animeList.filter(x => x.id !== rec.id);
        renderContent();
      }
    } },
  ];
}

function renderAnime() {
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>番剧</h2>
    <div class="search-wrap" style="max-width:260px">${icon('search')}<input placeholder="搜索番剧" value="${esc(nav.search)}"></div>
    <button class="btn small" id="btnAddAnime">${icon('plus')}添加</button>`;
  const animeSearch = head.querySelector('input');
  bindSearch(animeSearch, (v) => { nav.search = v; searchFocus = true; renderContent(); restoreSearchFocus(); });
  head.querySelector('#btnAddAnime').addEventListener('click', () => animeForm());
  frag.appendChild(head);

  const q = norm(nav.search);
  const list = q ? animeList.filter(a => norm(a.title).includes(q) || norm(a.url).includes(q)) : animeList;

  if (!animeList.length) {
    const d = document.createElement('div');
    d.className = 'empty card';
    d.style.cssText = 'padding:48px 24px;margin-top:18px';
    d.innerHTML = `${icon('screen')}<b>还没有添加番剧</b>
      <p>把 B 站番剧链接粘进来就能在应用内播放；只填链接也可以，标题可以之后补。<br>
      支持番剧播放页（ss / ep 号）、普通视频（BV / av 号）与 b23.tv 短链。</p>
      <button class="btn">${icon('plus')}添加番剧</button>`;
    d.querySelector('button').addEventListener('click', () => animeForm());
    frag.appendChild(d);
  } else if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty card';
    d.style.cssText = 'padding:40px 24px;margin-top:18px';
    d.innerHTML = `${icon('search')}<b>没有匹配的番剧</b>`;
    frag.appendChild(d);
  } else {
    const grid = document.createElement('div');
    grid.className = 'anime-grid';
    // 新的在前
    for (const rec of [...list].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))) {
      grid.appendChild(animeCard(rec));
    }
    frag.appendChild(grid);
  }
  rootEl.appendChild(frag);
}

/**
 * 添加/编辑表单。
 * 用项目原生的 <dialog> + .dlg-body/.dlg-actions，而不是自造 .modal 类：
 * 另起一套弹窗样式会让 Esc 关闭、点遮罩关闭、焦点管理全部要重写一遍，
 * 而这些 confirmDialog/promptDialog 已经处理好了。
 */
function animeForm(existing) {
  const rec = existing || { id: '', title: '', url: '' };
  const d = document.createElement('dialog');
  document.body.appendChild(d);
  d.innerHTML = `<div class="dlg-body af-body">
      <b>${existing ? '编辑番剧' : '添加番剧'}</b>
      <label class="af-fld"><span>B 站链接</span>
        <input id="afUrl" placeholder="https://www.bilibili.com/bangumi/play/ss4181" value="${esc(rec.url)}"></label>
      <div class="af-tip" id="afTip"></div>
      <label class="af-fld"><span>标题（可留空）</span>
        <input id="afTitle" placeholder="留空则用番剧名" value="${esc(rec.title)}"></label>
    </div>
    <div class="dlg-actions">
      <button class="btn text" data-a="cancel">取消</button>
      <button class="btn" data-a="save">保存</button>
    </div>`;
  d.classList.add('anime-dlg');

  const urlEl = d.querySelector('#afUrl');
  const tipEl = d.querySelector('#afTip');
  const titleEl = d.querySelector('#afTitle');
  const saveEl = d.querySelector('[data-a=save]');

  // 实时校验：边输入边说明这个链接能不能内嵌。
  // 不做的话用户会以为「保存了就能播」，点开却是跳转 —— 预期落差比功能缺失更伤。
  function validate() {
    const v = urlEl.value.trim();
    if (!v) { tipEl.textContent = ''; tipEl.className = 'af-tip'; saveEl.disabled = true; return true; }
    const p = bili.parseBiliURL(v);
    if (!p.ok) {
      tipEl.textContent = p.reason;
      tipEl.className = 'af-tip bad';
      saveEl.disabled = true;
      return false;
    }
    saveEl.disabled = false;
    if (p.embeddable) { tipEl.textContent = '✓ 可在应用内直接播放'; tipEl.className = 'af-tip ok'; }
    else if (p.needFetch) { tipEl.textContent = '可保存。番剧播放页（ss/ep 号）需先补全才能内嵌，否则跳转 B 站'; tipEl.className = 'af-tip'; }
    else { tipEl.textContent = '短链无法本地解析，将跳转 B 站'; tipEl.className = 'af-tip'; }
    return true;
  }
  urlEl.addEventListener('input', validate);
  validate();

  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-a=cancel]').addEventListener('click', close);
  d.addEventListener('cancel', () => close());
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !saveEl.disabled) { e.preventDefault(); saveEl.click(); }
  });
  d.querySelector('[data-a=save]').addEventListener('click', async () => {
    if (!validate()) return;
    const v = urlEl.value.trim();
    const now = bili.makeRecord({ id: rec.id || undefined, title: titleEl.value.trim(), url: v });
    // 续用已有补全结果，避免重新解析、也避免清掉已选集
    if (existing) {
      now.bvid = rec.bvid || now.bvid;
      now.cid = rec.cid || now.cid;
      now.cover = rec.cover || now.cover;
      now.episodes = rec.episodes || now.episodes;
      now.currentIndex = rec.currentIndex || 0;
    }
    await db.putAnime(now);
    await loadAnime();
    close();
    toast(existing ? '已保存' : '已添加');
    if (nav.tab === 'anime') renderContent(); else render();
  });
  d.showModal();
  setTimeout(() => { urlEl.focus(); urlEl.select(); }, 50);
}

function renderAnimeDetail(id) {
  const rec = animeList.find(x => x.id === id);
  if (!rec) { toast('番剧不存在'); return renderAnime(); }
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>${esc(rec.title || '番剧')}</h2>
    <button class="btn ghost small" id="adEdit">${icon('edit')}编辑</button>
    <button class="btn small" id="adOpen">${icon('external')}在 B 站打开</button>`;
  head.querySelector('#adEdit').addEventListener('click', () => animeForm(rec));
  head.querySelector('#adOpen').addEventListener('click', () => window.open(bili.watchURL(rec), '_blank', 'noopener'));
  frag.appendChild(head);

  const box = document.createElement('div');
  box.className = 'anime-detail';
  frag.appendChild(box);
  rootEl.appendChild(frag);

  const eps = rec.episodes || [];
  let cur = {
    bvid: rec.bvid || (eps[rec.currentIndex || 0] || {}).bvid || '',
    cid: rec.cid || (eps[rec.currentIndex || 0] || {}).cid || 0,
  };

  function drawPlayer() {
    if (bili.canEmbed(rec) || cur.bvid) {
      const src = bili.embedURL(cur.bvid, { cid: cur.cid });
      box.innerHTML = `<div class="ap-frame">
          <iframe src="${esc(src)}" scrolling="no" frameborder="0"
                  allowfullscreen="true" referrerpolicy="no-referrer"
                  title="${esc(rec.title || '番剧播放器')}"></iframe>
        </div>
        <div class="ap-note">${icon('info')}<span>播放器来自 B 站官方地址。若无法播放，请用上方「在 B 站打开」。</span></div>`;
    } else {
      // 没有 bvid 就绝不显示空 iframe —— 那是「以为能播但白屏」的最坏体验
      box.innerHTML = `<div class="ap-none card">
          <b>这条链接暂不能在应用内播放</b>
          <p>你粘贴的是番剧播放页（${esc(rec.kind)} 号），需要先查到播放器地址。<br>
             若你正用 <code>node server.js</code> 启动，点下面按钮可以自动补全。</p>
          <div class="ap-none-acts">
            <button class="btn" id="apTry">${icon('refresh')}尝试补全</button>
            <button class="btn primary" id="apGo">${icon('external')}在 B 站打开</button>
          </div>
        </div>`;
      box.querySelector('#apGo').addEventListener('click', () => window.open(bili.watchURL(rec), '_blank', 'noopener'));
      box.querySelector('#apTry').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = '补全中…';
        const got = await resolveAnime(rec.id);
        if (got) { toast('补全成功'); renderContent(); }
        else { toast('补全失败：请确认用 node server.js 启动'); btn.disabled = false; btn.innerHTML = icon('refreshBili') + '重试'; }
      });
    }

    if (eps.length > 1) {
      const list = document.createElement('div');
      list.className = 'ap-eps';
      eps.forEach((e, i) => {
        const b = document.createElement('button');
        b.className = 'ap-ep' + (i === (rec.currentIndex || 0) ? ' on' : '');
        b.textContent = e.title || ('第 ' + (i + 1) + ' 集');
        b.addEventListener('click', () => {
          cur = { bvid: e.bvid, cid: e.cid };
          rec.currentIndex = i;
          db.putAnime(rec);
          drawPlayer();
        });
        list.appendChild(b);
      });
      box.appendChild(list);
    }
  }
  drawPlayer();
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
  listContext = rels;

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
  actions.querySelector('#aShuffle').addEventListener('click', () => player.playShuffled(rels));

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
      <div class="set-row"><div class="lab"><b>显示歌词</b><span>自动读取同名 .lrc / .krc（酷狗）文件</span></div><label class="switch"><input type="checkbox" id="swLyrics" ${p.lyricsOn ? 'checked' : ''}><span class="knob"></span></label></div>
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

// 视图渲染：歌曲 / 专辑 / 歌手 / 播放列表 / 设置 + 详情页
import * as db from './db.js';
import { prefs, setPref, DEFAULTS } from './prefs.js';
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
// 上一次渲染的导航位置签名（多选状态随导航切换自动重置）
let lastNavSig = '';

export const trackByRel = (rel) => byRel.get(rel);
export const allTracks = () => tracks;

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
// 正被观察的占位节点：IO 对 target 持强引用，节点从 DOM 移除后必须显式
// unobserve，否则每次重渲染泄漏一批游离节点
const observedPh = new Set();

async function loadArtInto(node) {
  observedPh.delete(node);
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
  for (const n of [...observedPh]) {
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
  observedPh.add(d);
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
// 非组合输入防抖 140ms：全量过滤+排序+重建视图很重，逐键执行会卡顿。
function bindSearch(input, onQuery) {
  let composing = false;
  const debounced = debounce(onQuery, 140);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; onQuery(input.value); });
  input.addEventListener('input', () => { if (!composing) debounced(input.value); });
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
// ---------- 多选模式 ----------
let selMode = false;
const selSet = new Set();   // 已选 rel
let selCtx = {};            // 当前列表上下文（播放列表详情里有 playlistId）

const TABS = [
  ['songs', '歌曲', 'music'],
  ['albums', '专辑', 'disc'],
  ['artists', '歌手', 'mic'],
  ['folders', '文件夹', 'folder'],
  ['playlists', '播放列表', 'playlist'],
  ['stats', '统计', 'chart'],
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

export function render() {
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
  // 释放上一视图仍被 IO 观察的占位节点（IO 对其持强引用，不清会泄漏）
  for (const n of observedPh) artIO.unobserve(n);
  observedPh.clear();
  // 导航位置变化时重置多选（进入多选本身的重渲染签名不变，不受影响）
  const navSig = `${nav.tab}|${nav.detail ? `${nav.detail.type}:${nav.detail.key ?? ''}` : ''}`;
  if (navSig !== lastNavSig) {
    selMode = false;
    selSet.clear();
    document.body.classList.remove('selecting');
    removeSelBar();
    lastNavSig = navSig;
  }
  contentEl = rootEl;
  contentEl.innerHTML = '';
  if (nav.detail) {
    if (nav.detail.type === 'album') return renderAlbumDetail();
    if (nav.detail.type === 'artist') return renderArtistDetail();
    if (nav.detail.type === 'playlist') return renderPlaylistDetail();
    if (nav.detail.type === 'folder') return renderFolderDetail();
    if (nav.detail.type === 'smart') return renderSmartDetail();
  }
  // 刻意保持同步：早期版本把这里改成 async，结果 24 个调用点全部拿到未完成的 Promise ——
  // 同步部分照跑、switch 被推到微任务，表现为「页面空白且无报错」，
  // 极难定位。异步数据必须在渲染前 await 完，不该渗进渲染函数。
  switch (nav.tab) {
    case 'songs': renderSongs(); break;
    case 'albums': renderAlbums(); break;
    case 'artists': renderArtists(); break;
    case 'folders': renderFolders(); break;
    case 'playlists': renderPlaylists(); break;
    case 'stats': renderStats(); break;
    case 'settings': renderSettings(); break;
  }
  // 多选模式下重渲染（搜索过滤、批量删除后）要同步底部操作条
  if (selMode) updateSelBar();
}

function reconnectBanner() {
  const d = document.createElement('div');
  const n = scanner.pendingRootCount();
  d.className = 'banner';
  d.innerHTML = `${icon('folder')}<div class="t"><b>需要重新连接音乐文件夹</b>浏览器需要你重新授权后才能访问音乐${n > 1 ? `（共 ${n} 个文件夹待授权）` : ''}。</div><button class="btn small">重新连接</button>`;
  d.querySelector('button').addEventListener('click', async () => {
    const ok = await scanner.authorizeSavedHandle();
    if (ok) { reconnectNeeded = false; await rescanAndRefresh(true); }
    else if (scanner.pendingRootCount()) toast('已授权一个文件夹，请继续授权剩余的');
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
  if (selMode) {
    row.classList.add('selectable');
    if (selSet.has(t.rel)) row.classList.add('selected');
    const idx = row.querySelector('.t-idx');
    idx.innerHTML = `<span class="sel-check">${selSet.has(t.rel) ? icon('check') : ''}</span>`;
  }
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
  selCtx = ctx;
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.trow');
    if (!row) return;
    const rel = row.dataset.rel;
    const t = byRel.get(rel);
    if (!t) return;
    if (selMode) { toggleSel(rel, row); return; }
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
    if (selMode) { e.preventDefault(); return; }
    const row = e.target.closest('.trow');
    if (!row) return;
    e.preventDefault();
    const t = byRel.get(row.dataset.rel);
    if (t) showMenu(trackMenu(t, ctx), e.clientX, e.clientY);
  });
  // 长按进入多选（移动端没有右键）
  let pressTimer = 0, pressStart = null;
  listEl.addEventListener('pointerdown', (e) => {
    if (selMode || e.target.closest('button')) return;
    const row = e.target.closest('.trow');
    if (!row || !byRel.get(row.dataset.rel)) return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      try { navigator.vibrate && navigator.vibrate(15); } catch { }
      enterSelect(row.dataset.rel);
    }, 480);
  });
  const cancelPress = (e) => {
    clearTimeout(pressTimer);
    pressTimer = 0;
    if (pressStart && e && (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10)) pressStart = null;
  };
  listEl.addEventListener('pointermove', cancelPress);
  listEl.addEventListener('pointerup', () => { clearTimeout(pressTimer); pressTimer = 0; });
  listEl.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = 0; });
  listEl.addEventListener('scroll', () => { clearTimeout(pressTimer); }, { passive: true });
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

// ---------- 多选模式 ----------
export const isSelecting = () => selMode;

/** 进入多选（firstRel 为初始选中项）；退出后恢复普通列表 */
function enterSelect(firstRel) {
  selMode = true;
  selSet.clear();
  if (firstRel) selSet.add(firstRel);
  document.body.classList.add('selecting');
  renderContent();
  updateSelBar();
}

/** 退出多选并恢复渲染 */
export function exitSelect() {
  selMode = false;
  selSet.clear();
  document.body.classList.remove('selecting');
  removeSelBar();
  renderContent();
}

function toggleSel(rel, row) {
  if (selSet.has(rel)) selSet.delete(rel); else selSet.add(rel);
  if (row) {
    row.classList.toggle('selected', selSet.has(rel));
    const idx = row.querySelector('.t-idx');
    if (idx) idx.innerHTML = `<span class="sel-check">${selSet.has(rel) ? icon('check') : ''}</span>`;
  }
  updateSelBar();
}

function removeSelBar() {
  document.getElementById('selBar')?.remove();
}

function updateSelBar() {
  if (!selMode) { removeSelBar(); return; }
  let bar = document.getElementById('selBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selBar';
    bar.className = 'sel-bar';
    document.body.appendChild(bar);
  }
  const n = selSet.size;
  const dis = n ? '' : 'disabled style="opacity:.5"';
  bar.innerHTML = `
    <button class="icon-btn small" id="selClose" aria-label="退出多选" title="退出多选">${icon('x')}</button>
    <b>已选 ${n} 首</b>
    <button class="btn ghost small" id="selAll" ${listContext.length ? '' : 'disabled style="opacity:.5"'}>全选</button>
    <button class="btn ghost small" id="selPlayNext" ${dis}>下一首播放</button>
    <button class="btn ghost small" id="selQueueAdd" ${dis}>加入队列</button>
    ${selCtx.playlistId ? `<button class="btn ghost-danger small" id="selRemove" ${dis}>从列表移除</button>` : ''}
    <button class="btn small" id="selToPl" ${dis}>添加到播放列表</button>`;

  bar.querySelector('#selClose').addEventListener('click', exitSelect);
  bar.querySelector('#selAll').addEventListener('click', () => {
    for (const r of listContext) selSet.add(r);
    document.querySelectorAll('.trow.selectable').forEach(row => {
      row.classList.add('selected');
      const idx = row.querySelector('.t-idx');
      if (idx) idx.innerHTML = `<span class="sel-check">${icon('check')}</span>`;
    });
    updateSelBar();
  });
  bar.querySelector('#selPlayNext').addEventListener('click', () => { if (n) { player.playNextInQueue([...selSet]); exitSelect(); } });
  bar.querySelector('#selQueueAdd').addEventListener('click', () => { if (n) { player.addToQueueEnd([...selSet]); exitSelect(); } });
  bar.querySelector('#selToPl').addEventListener('click', (e) => {
    if (!n) return;
    const r = e.currentTarget.getBoundingClientRect();
    const items = [
      ...playlists.map(p => ({ label: p.name, icon: 'playlist', onClick: () => addToPlaylistMany(p, [...selSet]) })),
      '-',
      {
        label: '新建播放列表…', icon: 'plus',
        onClick: async () => {
          const name = await promptDialog('新建播放列表', '播放列表名称');
          if (!name) return;
          const p = { id: crypto.randomUUID(), name, rels: [...selSet], created: Date.now() };
          await db.putPlaylist(p);
          await loadPlaylists();
          toast(`已创建并加入 ${selSet.size} 首`);
          exitSelect();
        },
      },
    ];
    showMenu(items, r.left, r.bottom + 6);
  });
  if (selCtx.playlistId) {
    bar.querySelector('#selRemove').addEventListener('click', async () => {
      const p = playlists.find(x => x.id === selCtx.playlistId);
      if (!p) return;
      const before = p.rels.length;
      p.rels = p.rels.filter(r => !selSet.has(r));
      await db.putPlaylist(p);
      toast(`已移除 ${before - p.rels.length} 首`);
      exitSelect();
    });
  }
}

async function addToPlaylistMany(p, rels) {
  const fresh = rels.filter(r => !p.rels.includes(r));
  if (!fresh.length) { toast(`「${p.name}」中已有所选歌曲`); return; }
  p.rels.push(...fresh);
  await db.putPlaylist(p);
  toast(`已把 ${fresh.length} 首加入「${p.name}」`);
}

// ---------- 曲目菜单 ----------
function trackMenu(t, ctx) {
  const items = [];
  const playlistsItems = playlists.map(p => ({
    label: p.name, icon: 'playlist',
    onClick: () => addToPlaylist(p, t.rel),
  }));
  items.push(
    { label: '多选', icon: 'check', onClick: () => enterSelect(t.rel) },
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

// 注意保持同步：无 await 却标 async 会返回被丢弃的 Promise（见 renderContent 注释）
function renderAlbumDetail() {
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


// ---------- 文件夹视图 ----------
const dirOfRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
/** 目录路径的显示名：顶层可能是附加根的 key，映射成文件夹名 */
function folderDisplayName(path) {
  if (!path) return '音乐文件夹';
  if (!path.includes('/')) {
    const r = scanner.state.roots.find(x => x.key === path);
    if (r) return r.name;
  }
  return path.slice(path.lastIndexOf('/') + 1);
}
/** 某目录下的直接曲目与子目录（子目录计数含其全部后代曲目） */
function folderEntries(path) {
  const dirs = new Map();
  const items = [];
  for (const t of tracks) {
    const d = dirOfRel(t.rel);
    if (d === path) { items.push(t); continue; }
    if (path ? !d.startsWith(path + '/') : !d) continue;
    const rest = path ? d.slice(path.length + 1) : d;
    const child = path ? `${path}/${rest.split('/')[0]}` : rest.split('/')[0];
    dirs.set(child, (dirs.get(child) || 0) + 1);
  }
  return { dirs: [...dirs.entries()], items };
}

function folderRow(childPath, count) {
  const name = folderDisplayName(childPath);
  const row = document.createElement('div');
  row.className = 'arow';
  row.innerHTML = `<div class="avatar" style="background:${gradFor(childPath || '?')}">${icon('folder')}</div>
    <div style="flex:1;min-width:0"><div class="name">${esc(name)}</div><div class="sub">${count} 首</div></div>${icon('back')}`;
  row.addEventListener('click', () => { nav.detail = { type: 'folder', path: childPath, title: name }; render(); });
  return row;
}

function detailHead({ kind, title, icon: ic, grad, meta }) {
  const head = document.createElement('div');
  head.className = 'detail-head';
  head.innerHTML = `<div class="ph" style="background:${grad}">${icon(ic)}</div>
    <div class="info"><div class="kind">${esc(kind)}</div><h2>${esc(title)}</h2><div class="meta">${meta}</div></div>`;
  contentEl.appendChild(head);
  return head;
}

function detailActions(rels) {
  const has = rels.length > 0;
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.innerHTML = `<button class="btn" id="aPlay" ${has ? '' : 'disabled style="opacity:.5"'}>${icon('play')}播放</button>
    <button class="btn ghost" id="aShuffle" ${has ? '' : 'disabled style="opacity:.5"'}>${icon('shuffle')}随机播放</button>`;
  contentEl.appendChild(actions);
  actions.querySelector('#aPlay').addEventListener('click', () => player.playRels(rels, rels[0]));
  actions.querySelector('#aShuffle').addEventListener('click', () => player.playShuffled(rels));
}

function renderFolders() {
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>文件夹</h2>`;
  frag.appendChild(head);
  if (!scanner.hasSource()) { frag.appendChild(emptySource()); contentEl.appendChild(frag); return; }

  const { dirs, items } = folderEntries('');
  listContext = items.map(t => t.rel);
  if (!dirs.length && !items.length) { frag.appendChild(emptyList('没有找到音乐文件')); contentEl.appendChild(frag); return; }

  if (dirs.length) {
    const dirList = document.createElement('div');
    dirList.className = 'track-list';
    dirs.sort((a, b) => collator.compare(folderDisplayName(a[0]), folderDisplayName(b[0])));
    for (const [child, count] of dirs) dirList.appendChild(folderRow(child, count));
    frag.appendChild(dirList);
  }
  contentEl.appendChild(frag);
  if (items.length) {
    const listEl = document.createElement('div');
    listEl.className = 'track-list';
    contentEl.appendChild(listEl);
    const chunk = makeChunkList(listEl, renderTrackRow);
    chunk.reset(sortTracks(items));
    bindListEvents(listEl);
  }
}

function renderFolderDetail() {
  const d = nav.detail;
  contentEl.innerHTML = '';
  const { dirs, items } = folderEntries(d.path);
  const relsUnder = tracks
    .filter(t => { const dd = dirOfRel(t.rel); return dd === d.path || dd.startsWith(d.path + '/'); })
    .sort((a, b) => collator.compare(a.rel, b.rel))
    .map(t => t.rel);
  listContext = items.map(t => t.rel);

  const meta = `${relsUnder.length} 首${dirs.length ? ` · ${dirs.length} 个子文件夹` : ''}`;
  detailHead({ kind: '文件夹', title: folderDisplayName(d.path), icon: 'folder', grad: gradFor(d.path || '?'), meta });
  detailActions(relsUnder);

  if (dirs.length) {
    const dirList = document.createElement('div');
    dirList.className = 'track-list';
    dirs.sort((a, b) => collator.compare(folderDisplayName(a[0]), folderDisplayName(b[0])));
    for (const [child, count] of dirs) dirList.appendChild(folderRow(child, count));
    contentEl.appendChild(dirList);
  }
  if (!dirs.length && !items.length) { contentEl.appendChild(emptyList('文件夹为空')); return; }
  if (items.length) {
    const listEl = document.createElement('div');
    listEl.className = 'track-list';
    contentEl.appendChild(listEl);
    const chunk = makeChunkList(listEl, renderTrackRow);
    chunk.reset(sortTracks(items));
    bindListEvents(listEl);
  }
}

// ---------- 统计页 ----------
const LISTEN_ACH = [
  { h: 1, name: '初听' },
  { h: 10, name: '常客' },
  { h: 50, name: '发烧友' },
  { h: 100, name: '百小时乐迷' },
  { h: 500, name: '骨灰级' },
  { h: 1000, name: '千时传说' },
];
function fmtHours(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h >= 1 ? `${h} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}

function renderStats() {
  contentEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'settings';
  const totalDur = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const artists = new Set(tracks.map(t => t.artist)).size;
  const albums = new Set(tracks.map(t => t.albumKey)).size;
  const listened = player.getListenMs();
  const hourMs = 3600000;
  const nextAch = LISTEN_ACH.find(a => listened < a.h * hourMs);
  const pct = nextAch ? Math.min(100, Math.round((listened / (nextAch.h * hourMs)) * 100)) : 100;
  const top = tracks.filter(t => (t.playCount || 0) > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 10);

  wrap.innerHTML = `
    <h2>听歌成就</h2>
    <div class="card" style="padding:20px">
      <div style="display:flex;align-items:center;gap:14px">
        <span class="icon-btn" style="cursor:default;color:var(--accent)">${icon('trophy')}</span>
        <div class="lab">
          <b>累计听歌 ${esc(fmtHours(listened))}</b>
          <span>${nextAch ? `距「${esc(nextAch.name)}」（${nextAch.h} 小时）还差 ${esc(fmtHours(nextAch.h * hourMs - listened))}` : '已解锁全部成就，无可阻挡'}</span>
        </div>
      </div>
      <div class="ach-bar"><i style="width:${pct}%"></i></div>
      <div class="ach-row">
        ${LISTEN_ACH.map(a => `<span class="ach ${listened >= a.h * hourMs ? 'on' : ''}">${esc(a.name)} · ${a.h}h</span>`).join('')}
      </div>
    </div>

    <h2>媒体库</h2>
    <div class="card set-group">
      <div class="set-row"><div class="lab"><b>${tracks.length} 首歌曲</b><span>${albums} 张专辑 · ${artists} 位歌手 · 总时长 ${fmtTime(totalDur)}</span></div></div>
    </div>

    <h2>智能列表</h2>
    <div class="plcards">
      ${[
        { key: 'top', name: '最常播放', grad: 'linear-gradient(135deg,#f5576c,#ff8fab)', ic: 'chart' },
        { key: 'new', name: '最近添加', grad: 'linear-gradient(135deg,#43e97b,#38f9d7)', ic: 'plus' },
        { key: 'recent', name: '最近播放', grad: 'linear-gradient(135deg,#4facfe,#00f2fe)', ic: 'clock' },
      ].map(c => `
        <div class="plcard" data-smart="${c.key}">
          <div class="cover" style="background:${c.grad}">${icon(c.ic)}</div>
          <div style="flex:1;min-width:0"><div class="name">${esc(c.name)}</div><div class="sub">查看全部</div></div>
        </div>`).join('')}
    </div>

    <h2>最常播放 Top 10</h2>
    <div class="card set-group" id="statsTop">
      ${top.length ? '' : '<div class="set-row"><div class="lab"><span>还没有播放记录，去听几首歌吧。</span></div></div>'}
    </div>
  `;
  contentEl.appendChild(wrap);

  wrap.querySelectorAll('[data-smart]').forEach(card => {
    card.addEventListener('click', () => {
      const key = card.dataset.smart;
      const titles = { top: '最常播放', new: '最近添加', recent: '最近播放' };
      nav.detail = { type: 'smart', key, title: titles[key] };
      render();
    });
  });

  // Top 10 曲目行
  const topBox = wrap.querySelector('#statsTop');
  if (top.length) {
    const listEl = document.createElement('div');
    listEl.className = 'track-list';
    listEl.style.margin = '6px 0';
    topBox.appendChild(listEl);
    listContext = top.map(t => t.rel);
    const chunk = makeChunkList(listEl, renderTrackRow, 10);
    chunk.reset(top);
    bindListEvents(listEl);
  }
}

function renderSmartDetail() {
  const d = nav.detail;
  contentEl.innerHTML = '';
  let list;
  if (d.key === 'top') list = tracks.filter(t => (t.playCount || 0) > 0).sort((a, b) => b.playCount - a.playCount);
  else if (d.key === 'new') list = [...tracks].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 200);
  else list = tracks.filter(t => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 200);
  const rels = list.map(t => t.rel);
  listContext = rels;
  detailHead({ kind: '智能列表', title: d.title, icon: 'chart', grad: gradFor(d.key), meta: `${rels.length} 首` });
  detailActions(rels);
  if (!rels.length) { contentEl.appendChild(emptyList('列表为空')); return; }
  const listEl = document.createElement('div');
  listEl.className = 'track-list';
  contentEl.appendChild(listEl);
  const chunk = makeChunkList(listEl, renderTrackRow);
  chunk.reset(list);
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
  const supportsFSA = 'showDirectoryPicker' in window;
  // 多文件夹列表（主文件夹不可移除，只能更换）
  const rootsRows = scanner.state.roots.map(r => `
      <div class="set-row">
        <span class="icon-btn" style="cursor:default">${icon('folder')}</span>
        <div class="lab"><b>${esc(r.name)}</b><span>${r.key === 'musicDir' ? '主文件夹' : '附加文件夹'}</span></div>
        ${r.key !== 'musicDir' ? `<button class="icon-btn small root-rm" data-k="${esc(r.key)}" aria-label="移除该文件夹" title="移除">${icon('trash')}</button>` : ''}
      </div>`).join('');
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
      ${rootsRows}
      ${supportsFSA && scanner.hasSource() ? `<div class="set-row"><div class="lab"><b>附加音乐文件夹</b><span>把更多文件夹合并进同一媒体库</span></div><button class="btn small" id="btnAddRoot">${icon('plus')}添加</button></div>` : ''}
      ${supportsFSA ? '' : `<div class="set-row"><div class="lab"><span>当前浏览器不支持文件夹句柄记忆（建议 Chrome / Edge），将使用文件选择方式，刷新后需重新选择。</span></div></div>`}
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
      <div class="set-row"><div class="lab"><b>导出备份</b><span>播放列表、喜欢与播放统计保存为 JSON 文件</span></div><button class="btn ghost small" id="btnExport">${icon('download')}导出</button></div>
      <div class="set-row"><div class="lab"><b>恢复备份</b><span>从备份 JSON 合并恢复（不删除现有数据）</span></div><button class="btn ghost small" id="btnImport">${icon('upload')}导入</button></div>
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
  wrap.querySelector('#btnAddRoot')?.addEventListener('click', async () => {
    try {
      const h = await showDirectoryPicker({ mode: 'read', id: 'music-extra' });
      await scanner.addFsaRoot(h);
      await rescanAndRefresh(true);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('添加文件夹失败', e);
      toast('添加文件夹失败');
    }
  });
  wrap.querySelectorAll('.root-rm').forEach(b => b.addEventListener('click', async () => {
    const key = b.dataset.k;
    const r = scanner.state.roots.find(x => x.key === key);
    if (!(await confirmDialog('移除文件夹', `将从媒体库移除「${r ? r.name : '该文件夹'}」中的所有歌曲（源文件不受影响）。`, '移除', true))) return;
    await scanner.removeRoot(key);
    await rescanAndRefresh(true);
  }));
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
  // 备份导出/导入
  wrap.querySelector('#btnExport').addEventListener('click', async () => {
    const data = {
      app: 'local-music-pwa',
      version: 1,
      exportedAt: new Date().toISOString(),
      prefs: prefs(),
      playlists: await db.getPlaylists(),
      listenMs: player.getListenMs(),
      tracks: tracks.map(t => ({
        rel: t.rel, liked: !!t.liked, likedAt: t.likedAt || undefined,
        playCount: t.playCount || 0, lastPlayed: t.lastPlayed || undefined, addedAt: t.addedAt || undefined,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `music-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份已导出');
  });
  wrap.querySelector('#btnImport').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { toast('文件不是有效的 JSON'); return; }
      const pls = Array.isArray(data.playlists) ? data.playlists : [];
      const bts = Array.isArray(data.tracks) ? data.tracks : [];
      if (data.app !== 'local-music-pwa') { toast('不是本应用导出的备份文件'); return; }
      if (!(await confirmDialog('导入备份', `包含 ${pls.length} 个播放列表与 ${bts.length} 首歌的喜欢/播放记录。将合并进当前媒体库（同名条目取更完整的值）。`, '导入'))) return;
      for (const pl of pls) {
        if (pl && pl.id && Array.isArray(pl.rels)) {
          await db.putPlaylist({ id: String(pl.id), name: String(pl.name || '未命名'), rels: pl.rels.map(String), created: pl.created || Date.now() });
        }
      }
      let applied = 0;
      for (const b of bts) {
        const t = byRel.get(b.rel);
        if (!t) continue;
        if (b.liked) { t.liked = true; if (b.likedAt && !t.likedAt) t.likedAt = b.likedAt; }
        t.playCount = Math.max(t.playCount || 0, b.playCount || 0);
        const lp = Math.max(t.lastPlayed || 0, b.lastPlayed || 0);
        t.lastPlayed = lp || undefined;
        if (b.addedAt && (t.addedAt == null || b.addedAt < t.addedAt)) t.addedAt = b.addedAt;
        applied++;
      }
      if (applied) await db.bulkPutTracks([...byRel.values()]);
      if (typeof data.listenMs === 'number') player.mergeListenMs(data.listenMs);
      if (data.prefs && typeof data.prefs === 'object') {
        for (const k of Object.keys(DEFAULTS)) if (k in data.prefs) setPref(k, data.prefs[k]);
        import('./prefs.js').then(m => m.applyTheme(prefs().theme));
      }
      await loadFromDB();
      renderContent();
      toast(`已导入：${pls.length} 个播放列表、${applied} 首歌的记录`);
    });
    inp.click();
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
  if (r.blocked) {
    reconnectNeeded = true;
    render();
    if (showToast) toast('音乐文件夹需要重新授权');
    return r;
  }
  await loadFromDB();
  render();
  if (showToast) {
    const parts = [`新增 ${r.added} 首`];
    if (r.updated) parts.push(`更新 ${r.updated} 首`);
    if (r.removed) parts.push(`移除 ${r.removed} 首`);
    if (r.failed) parts.push(`${r.failed} 个文件读取失败`);
    toast(parts.join('，') || '媒体库已是最新');
  }
  return r;
}

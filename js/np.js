// 底部播放条 / 正在播放全屏 / 队列面板 / 歌词 / 频谱
import { prefs, setPref } from './prefs.js';
import { icon, esc, fmtTime, toast, paintRange, gradFor } from './ui.js';
import * as player from './player.js';
import * as scanner from './scanner.js';
import * as art from './art.js';
import * as eq from './eq.js';
import { parseLyrics, activeLine } from './lyrics.js';
import * as views from './views.js';

let els = {};        // 容器元素
let R = {};          // 缓存的 DOM 引用（避免每帧 querySelector）
let draggingSeek = false;
let lrc = [], lrcActive = -1, lrcLines = [];
let vizRaf = 0;
let vizAccent = '';
let tint = null;
let queueOpen = false;

// 队列面板最多渲染的行数（避免上千首时一次性建 DOM）
const QUEUE_WINDOW = 120;

export function init() {
  buildPlaybar();
  buildNP();
  buildQueue();
  cacheRefs();

  player.on('track', () => { updateTrack(); updateQueue(); loadLyrics(); });
  player.on('state', () => { updateState(); updateVizLoop(); });
  player.on('time', () => updateTime());
  player.on('queue', () => updateQueue());
  player.on('volume', () => updateVolume());
  player.on('tint', (c) => { tint = c; applyTint(); });

  updateTrack();
  updateState();
  updateVolume();
  updateTime();
}

function cacheRefs() {
  const bar = els.bar, np = els.np;
  R = {
    barProgress: bar.querySelector('.progress'),
    barThumbSlot: bar.querySelector('.thumb-slot'),
    barT1: bar.querySelector('.t1'),
    barT2: bar.querySelector('.t2'),
    barLike: bar.querySelector('.m-like'),
    barPlay: bar.querySelector('.c-play'),
    barShuffle: bar.querySelector('.c-shuffle'),
    barRepeat: bar.querySelector('.c-repeat'),
    barMute: bar.querySelector('.c-mute'),
    barSeek: bar.querySelector('#pbSeek'),
    barVol: bar.querySelector('#pbVol'),
    barTCur: bar.querySelector('.t-cur'),
    barTDur: bar.querySelector('.t-dur'),
    npTitle: np.querySelector('.np-title'),
    npArtist: np.querySelector('.np-artist'),
    npAlbum: np.querySelector('.np-album'),
    npPlay: np.querySelector('.c-play'),
    npShuffle: np.querySelector('.c-shuffle'),
    npRepeat: np.querySelector('.c-repeat'),
    npMute: np.querySelector('.c-mute'),
    npSeek: np.querySelector('#seek'),
    npVol: np.querySelector('#vol'),
    npTCur: np.querySelector('#tCur'),
    npTDur: np.querySelector('#tDur'),
    npLyrics: np.querySelector('.np-lyrics'),
  };
}

const extOf = (name) => { const i = (name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1) : ''; };

// ---------- 底部播放条 ----------
function buildPlaybar() {
  const m = document.getElementById('playbar');
  m.innerHTML = `
    <div class="progress"></div>
    <div class="pb-left">
      <div class="thumb-slot"></div>
      <div class="meta"><div class="t1">未在播放</div><div class="t2">选择一首歌曲开始</div></div>
      <button class="icon-btn small m-like" aria-label="喜欢">${icon('heart')}</button>
    </div>
    <div class="pb-center">
      <div class="pb-buttons">
        <button class="icon-btn small c-shuffle" aria-label="随机播放" title="随机播放 (S)">${icon('shuffle')}</button>
        <button class="icon-btn c-prev" aria-label="上一首">${icon('prev')}</button>
        <button class="icon-btn play-btn c-play" aria-label="播放/暂停">${icon('play')}</button>
        <button class="icon-btn c-next" aria-label="下一首">${icon('next')}</button>
        <span style="position:relative;display:inline-grid">
          <button class="icon-btn small c-repeat" aria-label="循环模式" title="循环模式 (R)">${icon('repeat')}</button>
          <span class="repeat-badge" hidden>1</span>
        </span>
      </div>
      <div class="pb-seek">
        <time class="t-cur">0:00</time>
        <input type="range" class="seek" id="pbSeek" min="0" max="1000" value="0" step="1">
        <time class="t-dur">0:00</time>
      </div>
    </div>
    <div class="pb-right">
      <button class="icon-btn small c-lyrics" aria-label="歌词">${icon('lyrics')}</button>
      <button class="icon-btn small c-queue" aria-label="播放队列">${icon('queue')}</button>
      <div class="vol">
        <button class="icon-btn small c-mute" aria-label="静音">${icon('volume')}</button>
        <input type="range" id="pbVol" min="0" max="100" value="90">
      </div>
      <button class="icon-btn small c-expand" aria-label="正在播放">${icon('expand')}</button>
    </div>
    <div class="pb-mobile-ctl">
      <button class="icon-btn c-play" aria-label="播放/暂停">${icon('play')}</button>
      <button class="icon-btn c-next" aria-label="下一首">${icon('next')}</button>
    </div>`;

  const on = (sel, fn) => m.querySelectorAll(sel).forEach(b => b.addEventListener('click', fn));
  m.querySelector('.meta').addEventListener('click', () => openNP());
  m.querySelector('.thumb-slot').addEventListener('click', () => openNP());
  on('.c-play', () => player.toggle());
  on('.c-next', () => player.next());
  on('.c-expand', () => openNP());
  m.querySelector('.c-prev').addEventListener('click', () => player.prev());
  m.querySelector('.m-like').addEventListener('click', () => { const t = player.getCurrent(); if (t) views.toggleLike(t); });
  m.querySelector('.c-shuffle').addEventListener('click', () => {
    const on2 = player.toggleShuffle();
    toast(on2 ? '随机播放：开' : '随机播放：关');
  });
  m.querySelector('.c-repeat').addEventListener('click', () => {
    const m2 = player.cycleRepeat();
    toast(m2 === 'all' ? '列表循环' : m2 === 'one' ? '单曲循环' : '不循环');
  });
  m.querySelector('.c-mute').addEventListener('click', () => player.toggleMute());
  m.querySelector('.c-queue').addEventListener('click', () => toggleQueue());
  m.querySelector('.c-lyrics').addEventListener('click', () => toggleLyrics());

  bindSeek(m.querySelector('#pbSeek'));
  bindVol(m.querySelector('#pbVol'));
  els.bar = m;
}

function bindSeek(input) {
  input.addEventListener('input', () => { draggingSeek = true; paintRange(input); });
  input.addEventListener('change', () => {
    player.seek((Number(input.value) / 1000) * player.duration());
    draggingSeek = false;
  });
  input.addEventListener('pointerdown', () => { draggingSeek = true; });
}
function bindVol(input) {
  input.addEventListener('input', () => { player.setVolume(Number(input.value) / 100); paintRange(input); });
}

function toggleLyrics() {
  const on = !els.np.classList.contains('lyrics-on');
  setPref('lyricsOn', on);
  els.np.classList.toggle('lyrics-on', on);
  document.querySelectorAll('.c-lyrics').forEach(b => b.classList.toggle('active', on));
  updateVizLoop();
  if (on) loadLyrics();
}

function updatePlaybar() {
  const t = player.getCurrent();
  const slot = R.barThumbSlot;
  if (t) {
    R.barT1.textContent = t.title || t.name;
    R.barT2.textContent = t.artist || '';
    R.barLike.classList.toggle('liked', !!t.liked);
    const svg = R.barLike.querySelector('svg');
    if (svg) svg.style.fill = t.liked ? 'currentColor' : 'none';
    if (!slot.firstChild || slot.firstChild.dataset?.key !== t.albumKey) {
      const ph = document.createElement('div');
      ph.className = 'thumb ph';
      ph.style.background = gradFor(t.albumKey);
      ph.dataset.key = t.albumKey;
      ph.innerHTML = icon('note');
      slot.replaceChildren(ph);
      art.getArt(t.albumKey, t.rel, extOf(t.name)).then(r => {
        if (r && slot.contains(ph)) {
          const img = document.createElement('img');
          img.className = 'thumb';
          img.src = r.url;
          img.alt = '';
          ph.replaceWith(img);
        }
      });
    }
  } else {
    R.barT1.textContent = '未在播放';
    R.barT2.textContent = '选择一首歌曲开始';
    slot.replaceChildren();
  }
}

// ---------- 正在播放 ----------
function buildNP() {
  const np = document.getElementById('np');
  np.innerHTML = `
    <div class="np-bg"></div>
    <div class="np-sheet">
      <div class="np-top">
        <button class="icon-btn np-close" aria-label="收起">${icon('chevronDown')}</button>
        <div class="cap">正在播放</div>
        <button class="icon-btn np-queue-btn" aria-label="播放队列">${icon('queue')}</button>
      </div>
      <div class="np-body">
        <div class="np-left">
          <div class="np-art-wrap">
            <div id="npArtGlow"></div>
            <div id="npArtPh" style="background:${gradFor('x')}">${icon('note')}</div>
            <img id="npArt" alt="" hidden>
          </div>
          <canvas id="viz" hidden></canvas>
          <div class="np-title">未在播放</div>
          <div class="np-artist"></div>
          <div class="np-album"></div>
          <div class="np-seek">
            <time id="tCur">0:00</time>
            <input type="range" class="seek" id="seek" min="0" max="1000" value="0" step="1">
            <time id="tDur">0:00</time>
          </div>
          <div class="np-controls">
            <button class="icon-btn small c-shuffle" aria-label="随机播放">${icon('shuffle')}</button>
            <button class="icon-btn c-prev" aria-label="上一首">${icon('prev')}</button>
            <button class="icon-btn play-btn c-play" aria-label="播放/暂停">${icon('play')}</button>
            <button class="icon-btn c-next" aria-label="下一首">${icon('next')}</button>
            <span style="position:relative;display:inline-grid">
              <button class="icon-btn small c-repeat" aria-label="循环模式">${icon('repeat')}</button>
              <span class="repeat-badge" hidden>1</span>
            </span>
          </div>
          <div class="np-extra">
            <button class="icon-btn small c-lyrics" aria-label="歌词">${icon('lyrics')}</button>
            <div class="vol"><button class="icon-btn small c-mute" aria-label="静音">${icon('volume')}</button><input type="range" id="vol" min="0" max="100" value="90"></div>
          </div>
        </div>
        <div class="np-lyrics"><div class="lrc-empty">暂无歌词</div></div>
      </div>
    </div>`;
  els.np = np;

  np.querySelector('.np-close').addEventListener('click', closeNP);
  np.querySelector('.np-queue-btn').addEventListener('click', () => toggleQueue());
  np.querySelector('.c-play').addEventListener('click', () => player.toggle());
  np.querySelector('.c-next').addEventListener('click', () => player.next());
  np.querySelector('.c-prev').addEventListener('click', () => player.prev());
  np.querySelector('.c-shuffle').addEventListener('click', () => {
    const on = player.toggleShuffle();
    toast(on ? '随机播放：开' : '随机播放：关');
  });
  np.querySelector('.c-repeat').addEventListener('click', () => {
    const m = player.cycleRepeat();
    toast(m === 'all' ? '列表循环' : m === 'one' ? '单曲循环' : '不循环');
  });
  np.querySelector('.c-mute').addEventListener('click', () => player.toggleMute());
  np.querySelector('.c-lyrics').addEventListener('click', () => toggleLyrics());
  bindSeek(np.querySelector('#seek'));
  bindVol(np.querySelector('#vol'));

  // 下滑关闭
  let sy = 0, dy = 0, tracking = false;
  const sheet = np.querySelector('.np-sheet');
  sheet.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input, button, .np-lyrics')) return;
    tracking = true; sy = e.clientY; dy = 0;
    sheet.style.transition = 'none';
  });
  sheet.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    dy = Math.max(0, e.clientY - sy);
    sheet.style.transform = `translateY(${dy * 0.6}px)`;
  });
  const endDrag = () => {
    if (!tracking) return;
    tracking = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 110) closeNP();
  };
  sheet.addEventListener('pointerup', endDrag);
  sheet.addEventListener('pointercancel', endDrag);
}

export function openNP() {
  els.np.classList.add('open');
  document.body.style.overflow = 'hidden';
  const on = prefs().lyricsOn;
  els.np.classList.toggle('lyrics-on', on);
  document.querySelectorAll('.c-lyrics').forEach(b => b.classList.toggle('active', on));
  updateTime(true);
  updateVizLoop();
}
export function closeNP() {
  els.np.classList.remove('open');
  document.body.style.overflow = '';
  if (queueOpen) toggleQueue(false);
  updateVizLoop();
}
export function toggleNP() {
  if (els.np.classList.contains('open')) closeNP();
  else openNP();
}
export const isNPOpen = () => els.np.classList.contains('open');

function applyTint() {
  document.getElementById('npArtGlow').style.background = tint || 'var(--accent-weak)';
  els.np.querySelector('.np-bg').style.setProperty('--np-tint', tint || 'transparent');
}

function updateTrack() {
  const t = player.getCurrent();
  updatePlaybar();
  if (!t) {
    R.npTitle.textContent = '未在播放';
    R.npArtist.textContent = '';
    R.npAlbum.textContent = '';
    return;
  }
  R.npTitle.textContent = t.title || t.name;
  R.npArtist.textContent = t.artist || '';
  R.npAlbum.textContent = t.album || '';
  tint = null;
  applyTint();
  const ph = els.np.querySelector('#npArtPh');
  const img = els.np.querySelector('#npArt');
  ph.style.background = gradFor(t.albumKey);
  img.hidden = true; ph.hidden = false;
  art.getArt(t.albumKey, t.rel, extOf(t.name)).then(r => {
    if (player.getCurrent() !== t) return;
    if (r) {
      img.src = r.url;
      img.hidden = false;
      ph.hidden = true;
      art.dominantColor(t.albumKey, r.url).then(c => { if (player.getCurrent() === t) { tint = c; applyTint(); } });
    }
  });
  views.updatePlayingRows();
}

function updateState() {
  const playing = player.isPlaying();
  const playIcon = icon(playing ? 'pause' : 'play');
  const shuffleOn = player.isShuffleOn();
  const rm = player.repeatMode();

  els.bar.classList.toggle('hidden', !player.getCurrent() && !player.getQueue().length);
  for (const b of els.bar.querySelectorAll('.c-play')) b.innerHTML = playIcon;
  R.npPlay.innerHTML = playIcon;

  R.barShuffle.classList.toggle('active', shuffleOn);
  R.npShuffle.classList.toggle('active', shuffleOn);
  R.barRepeat.classList.toggle('active', rm !== 'off');
  R.npRepeat.classList.toggle('active', rm !== 'off');

  for (const wrap of [els.bar, els.np]) {
    const badge = wrap.querySelector('.repeat-badge');
    if (badge) { badge.hidden = rm !== 'one'; badge.textContent = '1'; }
  }
  updateVizLoop();
}

function updateVolume() {
  const p = prefs();
  const v = Math.round(p.volume * 100);
  R.barVol.value = v; paintRange(R.barVol);
  R.npVol.value = v; paintRange(R.npVol);
  const ic = icon(p.muted || p.volume === 0 ? 'mute' : 'volume');
  R.barMute.innerHTML = ic;
  R.npMute.innerHTML = ic;
}

let lastSeekUpdate = 0;
function updateTime(force = false) {
  const cur = player.currentTime();
  const dur = player.duration();
  const now = performance.now();
  const npOpen = isNPOpen();

  if (!draggingSeek) {
    if (dur > 0) {
      const v = Math.round((cur / dur) * 1000);
      if (R.barSeek.value !== String(v)) {
        R.barSeek.value = v;
        paintRange(R.barSeek);
      }
      if (npOpen && R.npSeek.value !== String(v)) {
        R.npSeek.value = v;
        paintRange(R.npSeek);
      }
    }
    R.barProgress.style.width = dur > 0 ? `${(cur / dur) * 100}%` : '0%';
  }

  if (force || now - lastSeekUpdate > 250) {
    lastSeekUpdate = now;
    R.barTCur.textContent = fmtTime(cur);
    R.barTDur.textContent = fmtTime(dur);
    if (npOpen) {
      R.npTCur.textContent = fmtTime(cur);
      R.npTDur.textContent = fmtTime(dur);
    }
    syncLyrics(cur);
  }
}

// ---------- 歌词 ----------
async function loadLyrics() {
  lrc = []; lrcActive = -1; lrcLines = [];
  const t = player.getCurrent();
  const box = R.npLyrics;
  if (!t) { box.innerHTML = '<div class="lrc-empty"></div>'; return; }
  if (!prefs().lyricsOn) { box.innerHTML = '<div class="lrc-empty"></div>'; return; }
  box.innerHTML = '<div class="lrc-empty">加载歌词…</div>';
  const text = await scanner.getLrcText(t.rel);
  if (player.getCurrent() !== t) return;
  lrc = parseLyrics(text);
  if (!lrc.length) {
    box.innerHTML = '<div class="lrc-empty">暂无歌词<br><span style="font-size:12px">将同名 .lrc / .krc 文件放在音乐同目录即可显示</span></div>';
    return;
  }
  box.replaceChildren();
  const frag = document.createDocumentFragment();
  lrcLines = lrc.map((line) => {
    const d = document.createElement('div');
    d.className = 'lrc-line';
    d.textContent = line.text || '· · ·';
    d.addEventListener('click', () => player.seek(line.t + 0.05));
    frag.appendChild(d);
    return d;
  });
  box.appendChild(frag);
  syncLyrics(player.currentTime(), true);
}

function syncLyrics(t, force = false) {
  if (!lrc.length || !lrcLines.length) return;
  const i = activeLine(lrc, t);
  if (i === lrcActive && !force) return;
  if (lrcActive >= 0 && lrcLines[lrcActive]) lrcLines[lrcActive].classList.remove('active');
  lrcActive = i;
  if (i >= 0 && lrcLines[i]) {
    lrcLines[i].classList.add('active');
    const box = R.npLyrics;
    const el = lrcLines[i];
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
  }
}

// ---------- 频谱 ----------
function updateVizLoop() {
  const canvas = document.getElementById('viz');
  if (!canvas) return;
  const shouldDraw = isNPOpen() && player.isPlaying() && prefs().visualizerOn;
  canvas.hidden = !prefs().visualizerOn;
  if (!shouldDraw) {
    if (vizRaf) cancelAnimationFrame(vizRaf);
    vizRaf = 0;
    if (!prefs().visualizerOn) {
      const g = canvas.getContext('2d');
      if (g && canvas.width) g.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }
  if (vizRaf) return;
  // 频谱需要 WebAudio 图；若之前没建过（EQ 与频谱都关过），这里补建
  if (!eq.getAnalyser()) eq.ensureGraph(player.getAudio());
  vizAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2e6b5e';
  const loop = () => {
    eq.drawSpectrum(canvas, vizAccent);
    if (isNPOpen() && player.isPlaying() && prefs().visualizerOn) vizRaf = requestAnimationFrame(loop);
    else vizRaf = 0;
  };
  vizRaf = requestAnimationFrame(loop);
}

// ---------- 队列面板 ----------
function buildQueue() {
  const q = document.createElement('div');
  q.className = 'queue-drawer';
  q.id = 'queueDrawer';
  q.innerHTML = `
    <div class="q-head">
      <b>播放队列 <span id="qCount"></span></b>
      <button class="icon-btn small q-clear" aria-label="清空待播" title="清空待播">${icon('trash')}</button>
      <button class="icon-btn small q-close" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="q-list"></div>`;
  document.body.appendChild(q);
  els.queue = q;
  q.querySelector('.q-close').addEventListener('click', () => toggleQueue(false));
  q.querySelector('.q-clear').addEventListener('click', () => { player.clearUpcoming(); toast('已清空待播'); });
}

// 只渲染当前位置附近的窗口，避免长队列（随机播放全部）把内存与 DOM 撑爆
function updateQueue() {
  if (!els.queue) return;
  if (!queueOpen) return;
  const q = player.getQueue();
  const pos = player.getPos();
  els.queue.querySelector('#qCount').textContent = `${q.length ? pos + 1 : 0} / ${q.length}`;
  const list = els.queue.querySelector('.q-list');
  list.replaceChildren();

  const start = Math.max(0, Math.min(pos - 10, Math.max(0, q.length - QUEUE_WINDOW)));
  const end = Math.min(q.length, start + QUEUE_WINDOW);
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    frag.appendChild(queueRow(q[i], i, pos));
  }
  if (end < q.length) {
    const more = document.createElement('div');
    more.className = 'q-skipped';
    more.textContent = `… 还有 ${q.length - end} 首未显示`;
    frag.appendChild(more);
  }
  list.appendChild(frag);
  const cur = list.querySelector('.q-now');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

function queueRow(rel, i, pos) {
  const t = views.trackByRel(rel);
  const row = document.createElement('div');
  if (i === pos) {
    row.className = 'q-now';
    row.innerHTML = `<span class="eq-anim"><i></i><i></i><i></i></span>
      <div class="main" style="flex:1;min-width:0"><div class="t1">${esc(t ? t.title || t.name : rel)}</div><div class="t2" style="font-size:11.5px;color:var(--text3)">${esc(t ? t.artist || '' : '')} · 正在播放</div></div>`;
    return row;
  }
  row.className = 'q-row';
  row.draggable = true;
  row.innerHTML = `<span class="idx">${i + 1}</span>
    <div class="main"><div class="t1">${esc(t ? t.title || t.name : rel)}</div><div class="t2">${esc(t ? t.artist || '' : '')}</div></div>
    <span class="q-grab">${icon('grab')}</span>
    <button class="icon-btn small q-rm" aria-label="移除">${icon('x')}</button>`;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.q-rm')) { player.removeFromQueue(i); return; }
    player.jumpTo(i);
  });
  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); });
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (!isNaN(from)) player.moveInQueue(from, i);
  });
  return row;
}

export function toggleQueue(force) {
  queueOpen = force != null ? force : !queueOpen;
  els.queue.classList.toggle('open', queueOpen);
  if (queueOpen) updateQueue();
}

export function isQueueOpen() { return queueOpen; }

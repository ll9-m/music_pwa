// 迷你播放条 / 正在播放全屏 / 队列抽屉 / 歌词 / 频谱
import { prefs, setPref } from './prefs.js';
import { icon, esc, fmtTime, toast, paintRange, gradFor } from './ui.js';
import * as player from './player.js';
import * as scanner from './scanner.js';
import * as art from './art.js';
import * as eq from './eq.js';
import { parseLRC, activeLine } from './lyrics.js';
import * as views from './views.js';

let els = {};
let draggingSeek = false;
let lrc = [], lrcActive = -1, lrcLines = [];
let vizRaf = 0;
let tint = null;
let queueOpen = false;

export function init() {
  buildMini();
  buildNP();
  buildQueue();

  player.on('track', () => { updateTrack(); updateQueue(); loadLyrics(); });
  player.on('state', () => { updateState(); updateVizLoop(); });
  player.on('time', () => updateTime());
  player.on('queue', () => updateQueue());
  player.on('volume', () => updateVolume());
  player.on('tint', (c) => { tint = c; applyTint(); });

  updateTrack();
  updateState();
  updateVolume();
  updateQueue();
  updateTime();
}

// ---------- 迷你播放条 ----------
function buildMini() {
  const m = document.getElementById('miniPlayer');
  m.innerHTML = `
    <div class="progress"></div>
    <div class="inner">
      <div class="thumb-slot"></div>
      <div class="meta"><div class="t1">未在播放</div><div class="t2">选择一首歌曲开始</div></div>
      <button class="icon-btn small m-like" aria-label="喜欢">${icon('heart')}</button>
      <button class="icon-btn play-btn m-play" aria-label="播放/暂停">${icon('play')}</button>
      <button class="icon-btn m-next" aria-label="下一首">${icon('next')}</button>
    </div>`;
  m.querySelector('.inner').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openNP();
  });
  m.querySelector('.m-play').addEventListener('click', () => player.toggle());
  m.querySelector('.m-next').addEventListener('click', () => player.next());
  m.querySelector('.m-like').addEventListener('click', () => {
    const t = player.getCurrent();
    if (t) views.toggleLike(t);
  });
  els.mini = m;
}

function updateMini() {
  const t = player.getCurrent();
  const m = els.mini;
  const slot = m.querySelector('.thumb-slot');
  if (t) {
    m.querySelector('.t1').textContent = t.title || t.name;
    m.querySelector('.t2').textContent = t.artist || '';
    m.querySelector('.m-like').classList.toggle('liked', !!t.liked);
    const svg = m.querySelector('.m-like svg');
    if (svg) svg.style.fill = t.liked ? 'currentColor' : 'none';
    if (!slot.firstChild || slot.firstChild.dataset?.key !== t.albumKey) {
      const ph = document.createElement('div');
      ph.className = 'thumb ph';
      ph.style.background = gradFor(t.albumKey);
      ph.dataset.key = t.albumKey;
      ph.innerHTML = icon('note');
      slot.innerHTML = '';
      slot.appendChild(ph);
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
    m.querySelector('.t1').textContent = '未在播放';
    m.querySelector('.t2').textContent = '选择一首歌曲开始';
    slot.innerHTML = '';
  }
}
const extOf = (name) => { const i = (name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1) : ''; };

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
            <button class="icon-btn c-shuffle" aria-label="随机播放">${icon('shuffle')}</button>
            <button class="icon-btn c-prev" aria-label="上一首">${icon('prev')}</button>
            <button class="icon-btn play-btn c-play" aria-label="播放/暂停">${icon('play')}</button>
            <button class="icon-btn c-next" aria-label="下一首">${icon('next')}</button>
            <span style="position:relative;display:inline-grid">
              <button class="icon-btn c-repeat" aria-label="循环模式">${icon('repeat')}</button>
              <span class="repeat-badge" hidden>1</span>
            </span>
          </div>
          <div class="np-extra">
            <button class="icon-btn c-lyrics" aria-label="歌词">${icon('lyrics')}</button>
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
  np.querySelector('.c-shuffle').addEventListener('click', () => { player.toggleShuffle(); });
  np.querySelector('.c-repeat').addEventListener('click', () => { player.cycleRepeat(); });
  np.querySelector('.c-mute').addEventListener('click', () => player.toggleMute());
  np.querySelector('.c-lyrics').addEventListener('click', () => {
    const on = np.classList.toggle('lyrics-on');
    setPref('lyricsOn', on);
    np.querySelector('.c-lyrics').classList.toggle('active', on);
    updateVizLoop();
  });
  const seek = np.querySelector('#seek');
  seek.addEventListener('input', () => { draggingSeek = true; paintRange(seek); });
  seek.addEventListener('change', () => {
    const d = player.duration();
    player.seek((Number(seek.value) / 1000) * d);
    draggingSeek = false;
  });
  const vol = np.querySelector('#vol');
  vol.addEventListener('input', () => { player.setVolume(Number(vol.value) / 100); paintRange(vol); });

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
  updateVizLoop();
  const on = prefs().lyricsOn;
  els.np.classList.toggle('lyrics-on', on);
  els.np.querySelector('.c-lyrics').classList.toggle('active', on);
}
export function closeNP() {
  els.np.classList.remove('open');
  document.body.style.overflow = '';
  if (queueOpen) toggleQueue();
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
  const np = els.np;
  updateMini();
  if (!t) {
    np.querySelector('.np-title').textContent = '未在播放';
    np.querySelector('.np-artist').textContent = '';
    np.querySelector('.np-album').textContent = '';
    return;
  }
  np.querySelector('.np-title').textContent = t.title || t.name;
  np.querySelector('.np-artist').textContent = t.artist || '';
  np.querySelector('.np-album').textContent = t.album || '';
  tint = null;
  applyTint();
  const ph = np.querySelector('#npArtPh');
  const img = np.querySelector('#npArt');
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
  els.mini.classList.toggle('hidden', !player.getCurrent() && !player.getQueue().length);
  els.mini.querySelector('.m-play').innerHTML = icon(playing ? 'pause' : 'play');
  els.np.querySelector('.c-play').innerHTML = icon(playing ? 'pause' : 'play');
  els.np.querySelector('.c-shuffle').classList.toggle('active', player.isShuffleOn());
  const rm = player.repeatMode();
  els.np.querySelector('.c-repeat').classList.toggle('active', rm !== 'off');
  const badge = els.np.querySelector('.repeat-badge');
  badge.hidden = rm !== 'one';
  badge.textContent = '1';
}

function updateVolume() {
  const p = prefs();
  const vol = els.np.querySelector('#vol');
  vol.value = Math.round(p.volume * 100);
  paintRange(vol);
  els.np.querySelector('.c-mute').innerHTML = icon(p.muted || p.volume === 0 ? 'mute' : 'volume');
}

let lastSeekUpdate = 0;
function updateTime() {
  const cur = player.currentTime();
  const dur = player.duration();
  const now = performance.now();
  if (!draggingSeek) {
    const seek = els.np.querySelector('#seek');
    if (dur > 0) {
      seek.value = Math.round((cur / dur) * 1000);
      paintRange(seek);
    }
    els.mini.querySelector('.progress').style.width = dur > 0 ? `${(cur / dur) * 100}%` : '0%';
  }
  if (now - lastSeekUpdate > 250) {
    lastSeekUpdate = now;
    els.np.querySelector('#tCur').textContent = fmtTime(cur);
    els.np.querySelector('#tDur').textContent = fmtTime(dur);
    syncLyrics(cur);
  }
}

// ---------- 歌词 ----------
async function loadLyrics() {
  lrc = []; lrcActive = -1; lrcLines = [];
  const t = player.getCurrent();
  const box = els.np.querySelector('.np-lyrics');
  if (!t || !prefs().lyricsOn) { box.innerHTML = '<div class="lrc-empty"></div>'; return; }
  box.innerHTML = '<div class="lrc-empty">加载歌词…</div>';
  const text = await scanner.getLrcText(t.rel);
  if (player.getCurrent() !== t) return;
  lrc = parseLRC(text);
  if (!lrc.length) { box.innerHTML = '<div class="lrc-empty">暂无歌词<br><span style="font-size:12px">将同名 .lrc 文件放在音乐同目录即可显示</span></div>'; return; }
  box.innerHTML = '';
  lrcLines = lrc.map((line, i) => {
    const d = document.createElement('div');
    d.className = 'lrc-line';
    d.textContent = line.text || '· · ·';
    d.addEventListener('click', () => player.seek(line.t + 0.05));
    box.appendChild(d);
    return d;
  });
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
    const box = els.np.querySelector('.np-lyrics');
    const el = lrcLines[i];
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
  }
}

// ---------- 频谱 ----------
function updateVizLoop() {
  const canvas = document.getElementById('viz');
  const shouldDraw = isNPOpen() && player.isPlaying() && prefs().visualizerOn;
  canvas.hidden = !prefs().visualizerOn;
  if (!shouldDraw) {
    if (vizRaf) cancelAnimationFrame(vizRaf);
    vizRaf = 0;
    if (!prefs().visualizerOn) { const g = canvas.getContext('2d'); g && g.clearRect(0, 0, canvas.width, canvas.height); }
    return;
  }
  if (vizRaf) return;
  const loop = () => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b5bd6';
    eq.drawSpectrum(canvas, accent);
    if (isNPOpen() && player.isPlaying() && prefs().visualizerOn) vizRaf = requestAnimationFrame(loop);
    else vizRaf = 0;
  };
  vizRaf = requestAnimationFrame(loop);
}

// ---------- 队列抽屉 ----------
function buildQueue() {
  const q = document.createElement('div');
  q.className = 'queue-drawer';
  q.id = 'queueDrawer';
  q.innerHTML = `
    <div class="q-head">
      <b>播放队列 <span id="qCount" style="color:var(--text3);font-weight:400;font-size:13px"></span></b>
      <button class="icon-btn small q-clear" aria-label="清空待播" title="清空待播">${icon('trash')}</button>
      <button class="icon-btn small q-close" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="q-list"></div>`;
  document.body.appendChild(q);
  els.queue = q;
  q.querySelector('.q-close').addEventListener('click', () => toggleQueue());
  q.querySelector('.q-clear').addEventListener('click', () => { player.clearUpcoming(); toast('已清空待播'); });
}

function updateQueue() {
  if (!els.queue) return;
  const q = player.getQueue();
  const pos = player.getPos();
  els.queue.querySelector('#qCount').textContent = `${q.length ? pos + 1 : 0} / ${q.length}`;
  const list = els.queue.querySelector('.q-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  q.forEach((rel, i) => {
    const t = views.trackByRel(rel);
    const row = document.createElement('div');
    if (i === pos) {
      row.className = 'q-now';
      row.innerHTML = `<span class="eq-anim"><i></i><i></i><i></i></span>
        <div class="main" style="flex:1;min-width:0"><div class="t1">${esc(t ? t.title || t.name : rel)}</div><div class="t2" style="font-size:11.5px;color:var(--text3)">${esc(t ? t.artist || '' : '')} · 正在播放</div></div>`;
    } else {
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
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); list.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over')); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!isNaN(from)) {
          player.moveInQueue(from, i);
        }
      });
    }
    frag.appendChild(row);
  });
  list.appendChild(frag);
  const cur = list.querySelector('.q-now');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

export function toggleQueue(force) {
  queueOpen = force != null ? force : !queueOpen;
  els.queue.classList.toggle('open', queueOpen);
  if (queueOpen) updateQueue();
}

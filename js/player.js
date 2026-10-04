// 播放内核：队列、随机、循环、MediaSession、播放状态持久化
// 队列模型：queue 即实际播放顺序（随机时直接重排），baseQueue 保留原始上下文顺序
import { prefs, setPref } from './prefs.js';
import { kvGet, kvSet, putTrack } from './db.js';
import { getFile } from './scanner.js';
import { getArt, dominantColor } from './art.js';
import { toast, fmtTime } from './ui.js';

let audio = null;
let resolveTrack = null;   // rel -> track record
let _eqHook = null;        // (audio) => void  首次播放时接入 WebAudio

const listeners = new Map();
export function on(evt, cb) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(cb);
  return () => listeners.get(evt).delete(cb);
}
function emit(evt, data) {
  const s = listeners.get(evt);
  if (s) for (const cb of [...s]) { try { cb(data); } catch (e) { console.error(e); } }
}

const state = {
  queue: [],
  baseQueue: [],
  pos: -1,
  currentTrack: null,
  currentUrl: null,
  playing: false,
  ready: false,
  repeat: 'all',       // off | all | one
  errorStreak: 0,
  counted: false,
  pendingSeek: undefined,
  saveTimer: null,
};

export function init(audioEl, trackResolver, eqHook) {
  audio = audioEl;
  resolveTrack = trackResolver;
  _eqHook = eqHook;
  state.repeat = prefs().repeat || 'all';
  audio.volume = prefs().muted ? 0 : prefs().volume;
  audio.loop = state.repeat === 'one';

  audio.addEventListener('play', () => { state.playing = true; emit('state'); emit('track'); startRaf(); });
  audio.addEventListener('pause', () => { state.playing = false; emit('state'); scheduleSave(); });
  audio.addEventListener('ended', () => { next(true); });
  audio.addEventListener('loadedmetadata', () => {
    state.ready = true;
    if (state.pendingSeek != null && isFinite(audio.duration)) {
      try { audio.currentTime = state.pendingSeek; } catch { }
      state.pendingSeek = undefined;
    }
    // 补充缺失时长
    if (state.currentTrack && (state.currentTrack.duration == null) && isFinite(audio.duration)) {
      state.currentTrack.duration = audio.duration;
      putTrack({ ...state.currentTrack });
      emit('trackmeta');
    }
    updatePositionState();
  });
  audio.addEventListener('error', () => {
    const rel = state.queue[state.pos];
    console.error('播放失败', rel, audio.error);
    toast(`无法播放：${state.currentTrack ? state.currentTrack.title : rel || '未知曲目'}`);
    state.errorStreak++;
    if (state.errorStreak <= 3 && state.queue.length > 1) setTimeout(() => next(true), 400);
  });
  audio.addEventListener('playing', () => { state.errorStreak = 0; });
  // timeupdate 在后台标签也会触发：播放计数与媒体位置上报放这里，保证可靠
  audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastPosUpdate > 1000) {
      lastPosUpdate = now;
      updatePositionState();
      if (state.currentTrack && !state.counted && audio.currentTime > 4) {
        state.counted = true;
        state.currentTrack.playCount = (state.currentTrack.playCount || 0) + 1;
        state.currentTrack.lastPlayed = Date.now();
        putTrack({ ...state.currentTrack });
        emit('trackmeta');
      }
      scheduleSave();
    }
  });

  setupMediaSession();
}

// ---------- 时间推进（rAF 驱动 UI；页面隐藏时由 timeupdate 兜底） ----------
// 节流到 ~10fps：进度条带 CSS 过渡，肉眼依然平滑，但 DOM 写入量降到 1/6
let rafId = 0, lastPosUpdate = 0, lastTimeEmit = 0;
const TIME_EMIT_MS = 100;
function startRaf() {
  if (rafId) return;
  const loop = () => {
    const now = performance.now();
    if (now - lastTimeEmit >= TIME_EMIT_MS) {
      lastTimeEmit = now;
      emit('time');
    }
    if (state.playing) rafId = requestAnimationFrame(loop);
    else { rafId = 0; emit('time'); }
  };
  rafId = requestAnimationFrame(loop);
}

// ---------- 加载与播放 ----------
async function load(rel, { autoplay = true, time } = {}) {
  const track = resolveTrack(rel);
  if (!track) {
    // 队列里包含已被移除的曲目：跳过
    state.queue.splice(state.pos, 1);
    if (state.pos >= state.queue.length) state.pos = state.queue.length - 1;
    if (state.pos >= 0) return load(state.queue[state.pos], { autoplay, time });
    return;
  }
  state.currentTrack = track;
  // 从较晚进度恢复时视为已计数，避免重复累计；正常起播则会在播放 4 秒后计数
  state.counted = time != null && time > 4;
  if (time != null) state.pendingSeek = time;

  try {
    const file = await getFile(rel);
    if (!file) throw new Error('文件不可读');
    const prev = state.currentUrl;
    state.currentUrl = URL.createObjectURL(file);
    audio.src = state.currentUrl;
    audio.load();
    // 上一个 blob 已与 audio.src 解绑，可安全回收（避免大文件长期驻留内存）
    if (prev) URL.revokeObjectURL(prev);
  } catch (e) {
    console.error(e);
    toast(`无法读取：${track.title}`);
    return;
  }

  if (_eqHook) _eqHook(audio);

  if (autoplay) {
    try { await audio.play(); } catch { /* 需要手势等情况 */ }
  }
  emit('track');
  updateMediaMetadata();
  scheduleSave();
}

export async function playRels(rels, startRel, { shuffle } = {}) {
  const useShuffle = shuffle != null ? !!shuffle : isShuffleOn();
  state.baseQueue = [...rels];
  if (state.repeat === 'one') { state.repeat = 'all'; setPref('repeat', 'all'); emit('state'); }
  audio.loop = false;
  if (useShuffle) {
    const rest = rels.filter(r => r !== startRel);
    state.queue = [startRel, ...shuffleArr(rest)];
  } else {
    state.queue = [...rels];
  }
  state.pos = Math.max(0, state.queue.indexOf(startRel));
  await load(state.queue[state.pos], { autoplay: true });
}

/** 以随机顺序播放给定列表，并同步打开「随机播放」状态 */
export function playShuffled(rels) {
  if (!rels || !rels.length) return false;
  const startRel = rels[Math.floor(Math.random() * rels.length)];
  setPref('shuffleOn', true);
  emit('state');
  return playRels(rels, startRel, { shuffle: true });
}

export function isShuffleOn() {
  // 由 prefs 中的 shuffleOn 控制
  return !!prefs().shuffleOn;
}

/** 直接设定随机开关（不重排队列时也能保持 UI 与状态一致） */
export function setShuffle(on) {
  if (!!prefs().shuffleOn === !!on) return !!on;
  return toggleShuffle();
}

export function toggleShuffle() {
  const on = !isShuffleOn();
  setPref('shuffleOn', on);
  const cur = state.queue[state.pos];
  if (state.queue.length) {
    if (on) {
      const rest = state.queue.filter((_, i) => i !== state.pos);
      if (cur != null) state.queue = [cur, ...shuffleArr(rest)];
    } else {
      // 还原为原始上下文顺序（用 Set 去重查找，避免大队列下的 O(n²)）
      const have = new Set(state.queue);
      const ordered = state.baseQueue.filter(r => have.has(r));
      const inOrdered = new Set(ordered);
      for (const r of state.queue) if (!inOrdered.has(r)) { ordered.push(r); inOrdered.add(r); }
      state.queue = ordered;
    }
    if (cur != null) state.pos = Math.max(0, state.queue.indexOf(cur));
  }
  // 关键：必须派发 state，UI 的随机/循环按钮高亮依赖它
  emit('state');
  emit('queue');
  scheduleSave();
  return on;
}
function shuffleArr(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'all' ? 'one' : state.repeat === 'one' ? 'off' : 'all';
  setPref('repeat', state.repeat);
  audio.loop = state.repeat === 'one';
  emit('state');
  return state.repeat;
}

export async function next(auto = false) {
  if (!state.queue.length) return;
  if (state.pos < state.queue.length - 1) state.pos++;
  else if (state.repeat === 'all' || !auto) state.pos = 0;
  else { // 结尾停止
    state.playing = false;
    emit('state');
    return;
  }
  await load(state.queue[state.pos], { autoplay: true });
}

export async function prev() {
  if (!state.queue.length) return;
  if (isFinite(audio.currentTime) && audio.currentTime > 3 && audio.currentTime < (audio.duration || Infinity)) {
    audio.currentTime = 0;
    return;
  }
  if (state.pos > 0) state.pos--;
  else if (state.repeat === 'all') state.pos = state.queue.length - 1;
  else state.pos = 0;
  await load(state.queue[state.pos], { autoplay: true });
}

export async function toggle() {
  if (!state.queue.length) return;
  if (audio.paused) {
    if (!audio.src && state.pos >= 0) return load(state.queue[state.pos], { autoplay: true });
    try { await audio.play(); } catch { }
  } else {
    audio.pause();
  }
}

export function jumpTo(pos) {
  if (pos < 0 || pos >= state.queue.length) return;
  state.pos = pos;
  return load(state.queue[pos], { autoplay: true });
}

export function seek(t) {
  if (!isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(t, audio.duration));
  emit('time');
}

export function seekBy(delta) { seek((audio.currentTime || 0) + delta); }

export function setVolume(v, { mute } = {}) {
  v = Math.max(0, Math.min(1, v));
  setPref('volume', v);
  if (mute === false || (mute == null && v > 0 && prefs().muted)) setPref('muted', false);
  audio.volume = prefs().muted ? 0 : v;
  emit('volume');
}
export function toggleMute() {
  setPref('muted', !prefs().muted);
  audio.volume = prefs().muted ? 0 : prefs().volume;
  emit('volume');
}

// ---------- 队列操作 ----------
export function playNextInQueue(rel) {
  if (state.pos < 0) { state.queue.unshift(rel); state.baseQueue.unshift(rel); state.pos = -1; }
  else {
    state.queue.splice(state.pos + 1, 0, rel);
    if (!state.baseQueue.includes(rel)) {
      const bi = state.baseQueue.indexOf(state.queue[state.pos]);
      state.baseQueue.splice(bi + 1, 0, rel);
    }
  }
  emit('queue');
  toast('将在下一首播放');
}
export function addToQueueEnd(rel) {
  state.queue.push(rel);
  if (!state.baseQueue.includes(rel)) state.baseQueue.push(rel);
  emit('queue');
  toast('已加入播放队列');
}
export function removeFromQueue(pos) {
  if (pos === state.pos || pos < 0 || pos >= state.queue.length) return;
  state.queue.splice(pos, 1);
  if (pos < state.pos) state.pos--;
  if (!isShuffleOn()) state.baseQueue = [...state.queue];
  emit('queue');
}
export function moveInQueue(from, to) {
  if (from === to || from < 0 || from >= state.queue.length || to < 0 || to >= state.queue.length) return;
  const [r] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, r);
  if (from === state.pos) state.pos = to;
  else if (from < state.pos && to >= state.pos) state.pos--;
  else if (from > state.pos && to <= state.pos) state.pos++;
  if (!isShuffleOn()) state.baseQueue = [...state.queue];
  emit('queue');
}
export function clearUpcoming() {
  state.queue = state.queue.slice(0, state.pos + 1);
  if (!isShuffleOn()) state.baseQueue = [...state.queue];
  emit('queue');
}

// ---------- 状态读取 ----------
export const getQueue = () => state.queue;
export const getPos = () => state.pos;
export const getCurrent = () => state.currentTrack;
export const currentRel = () => state.queue[state.pos];
export const isPlaying = () => state.playing && audio && !audio.paused;
export const currentTime = () => (audio ? audio.currentTime : 0);
export const duration = () => (audio && isFinite(audio.duration) ? audio.duration : (state.currentTrack?.duration || 0));
export const repeatMode = () => state.repeat;
export const getAudio = () => audio;

// ---------- 持久化 ----------
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveState, 800);
}
function saveState() {
  kvSet('playstate', {
    queue: state.queue,
    baseQueue: state.baseQueue,
    pos: state.pos,
    time: audio ? audio.currentTime || 0 : 0,
    repeat: state.repeat,
  }).catch(() => { });
}
export async function restoreState() {
  try {
    const ps = await kvGet('playstate');
    if (!ps || !prefs().restoreOn) return false;
    state.queue = (ps.queue || []).filter(r => resolveTrack(r));
    state.baseQueue = (ps.baseQueue || []).filter(r => resolveTrack(r));
    state.repeat = ps.repeat || 'all';
    state.pos = -1;
    if (state.queue.length) {
      state.pos = Math.min(Math.max(0, ps.pos || 0), state.queue.length - 1);
      await load(state.queue[state.pos], { autoplay: false, time: ps.time || 0 });
      return true;
    }
  } catch (e) {
    console.warn('恢复播放状态失败', e);
  }
  return false;
}

// ---------- MediaSession ----------
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch { }
  }
}
async function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || !state.currentTrack) return;
  const t = state.currentTrack;
  let artwork;
  try {
    const art = await getArt(t.albumKey, t.rel, (t.name || '').split('.').pop());
    if (art) artwork = [{ src: art.url, sizes: '256x256', type: 'image/webp' }];
  } catch { }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title || t.name,
    artist: t.artist || '',
    album: t.album || '',
    artwork: artwork || [],
  });
  dominantColor(t.albumKey, artwork && artwork[0] && artwork[0].src).then(c => { if (c) emit('tint', c); });
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => toggle());
  ms.setActionHandler('pause', () => toggle());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) seek(d.seekTime); });
  ms.setActionHandler('seekbackward', (d) => seekBy(-(d.seekOffset || 10)));
  ms.setActionHandler('seekforward', (d) => seekBy(d.seekOffset || 10));
  try { ms.setActionHandler('stop', () => { audio.pause(); }); } catch { }
}

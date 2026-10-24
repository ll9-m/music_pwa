// 入口：启动流程、全局事件、快捷键、Service Worker
import { loadPrefs, prefs, applyTheme } from './prefs.js';
import * as db from './db.js';
import * as scanner from './scanner.js';
import * as views from './views.js';
import * as np from './np.js';
import * as player from './player.js';
import * as eq from './eq.js';
import { toast, closeMenu } from './ui.js';

// preload='metadata'：只取时长/标签，不把整首歌缓冲进内存
const audio = new Audio();
audio.preload = 'metadata';
document.body.appendChild(audio);

// 把非首屏必需的工作推到首屏之后，保证启动不被拖慢。
// 用 setTimeout 而不是 requestIdleCallback：后者在后台标签 / 无渲染环境可能被无限推迟，
// 会导致「恢复音乐文件夹」这条关键路径永远不执行。
function defer(fn, ms = 120) { return setTimeout(fn, ms); }

async function boot() {
  loadPrefs();
  applyTheme(prefs().theme);

  bindFileHandling();
  views.init();
  np.init();

  player.init(audio, views.trackByRel, () => eq.ensureGraph(audio));
  audio.addEventListener('play', () => eq.resumeCtx());
  bindFocusScan();
  bindRadioProvider();

  scanner.onProgress(({ phase, done, total }) => {
    const bar = document.querySelector('#scanProgress .bar');
    if (!bar) return;
    if (phase === 'done') { bar.style.width = '0%'; return; }
    const pct = total ? Math.round((done / total) * 100) : (phase === 'collect' ? 30 : 5);
    bar.style.width = `${pct}%`;
    setTimeout(() => { if (bar.style.width === `${pct}%`) bar.style.width = '0%'; }, 400);
  });

  // 首屏：直接用本地索引渲染，不等文件系统授权与扫描
  await db.openDB();
  await views.loadFromDB();
  views.render();

  bindShortcuts();
  bindInstall();

  // 后台：恢复文件夹句柄 → 增量扫描 → 恢复播放状态
  defer(async () => {
    let needsRender = false;
    const perm = await scanner.restoreSavedRoot();
    if (scanner.hasSource()) {
      // 部分根待授权时挂重连横幅，但已授权的根照常工作
      views.setReconnectNeeded(perm !== 'granted');
      needsRender = perm !== 'granted';
      if (perm === 'granted' && prefs().scanAtBoot) {
        const r = await scanner.scan();
        if (r && !r.blocked && (r.added || r.removed || r.updated)) { await views.loadFromDB(); needsRender = true; }
      }
      await player.restoreState();
    } else if (perm === 'prompt' || perm === 'denied') {
      views.setReconnectNeeded(true);
      needsRender = true;
    }
    if (needsRender) views.render();
    defer(() => { registerSW(); bindDebug(); }, 500);
  });
}

// ---------- 系统级打开方式（PWA File Handling） ----------
function bindFileHandling() {
  if (!('launchQueue' in window)) return;
  launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    try {
      const files = [];
      for (const fh of params.files) { try { files.push(await fh.getFile()); } catch { /* 跳过不可读项 */ } }
      if (!files.length) return;
      scanner.setFiles(files);
      await scanner.scan();
      await views.loadFromDB();
      views.setReconnectNeeded(false);
      views.render();
      const rels = files.map(f => f.name);
      await player.playRels(rels, rels[0]);
    } catch (e) {
      console.warn('处理系统打开的文件失败', e);
    }
  });
}

// ---------- 切回标签页自动增量扫描 ----------
// FSA 拿不到文件系统监听，以前台可见性为准：切回来时若距上次扫描超过 60s 就扫一次
let lastFocusScan = 0;
function bindFocusScan() {
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !prefs().scanOnFocus || !scanner.hasSource()) return;
    if (Date.now() - Math.max(scanner.state.lastScanAt, lastFocusScan) < 60000) return;
    lastFocusScan = Date.now();
    try {
      const r = await scanner.scan();
      if (r.blocked) { views.setReconnectNeeded(true); views.render(); return; }
      if (r.added || r.removed || r.updated) {
        await views.loadFromDB();
        views.render();
        const parts = [`新增 ${r.added} 首`];
        if (r.updated) parts.push(`更新 ${r.updated} 首`);
        if (r.removed) parts.push(`移除 ${r.removed} 首`);
        toast(parts.join('，'));
      }
    } catch (e) {
      console.warn('回前台自动扫描失败', e);
    }
  });
}

// ---------- Auto-DJ：队列播完自动接歌 ----------
// 同歌手/同专辑优先，其余随机补足；实际选择逻辑放这里，player 只留钩子
function bindRadioProvider() {
  player.setRadioProvider((curRel) => {
    const cur = views.trackByRel(curRel);
    const inQueue = new Set(player.getQueue());
    const pool = views.allTracks().filter(t => !inQueue.has(t.rel));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const score = (t) => (cur && (t.artist === cur.artist || t.albumKey === cur.albumKey) ? 0 : 1);
    return pool.sort((a, b) => score(a) - score(b)).slice(0, 10).map(t => t.rel);
  });
}

// ---------- Service Worker ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 注册失败', e));
}

// ---------- PWA 安装 ----------
function bindInstall() {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    views.setInstallPrompt(e);
  });
}

// ---------- 快捷键 ----------
function bindShortcuts() {
  addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const hasTrack = !!player.getCurrent();
    switch (e.key) {
      case ' ':
        if (hasTrack) { e.preventDefault(); player.toggle(); }
        break;
      case 'ArrowLeft': if (hasTrack) { e.preventDefault(); player.seekBy(-5); } break;
      case 'ArrowRight': if (hasTrack) { e.preventDefault(); player.seekBy(5); } break;
      case 'ArrowUp': e.preventDefault(); player.setVolume(prefs().volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); player.setVolume(prefs().volume - 0.05); break;
      case 'n': case 'N': if (hasTrack) player.next(); break;
      case 'p': case 'P': if (hasTrack) player.prev(); break;
      case 'm': case 'M': player.toggleMute(); break;
      case 's': case 'S': if (hasTrack) { player.toggleShuffle(); toast(player.isShuffleOn() ? '随机播放：开' : '随机播放：关'); } break;
      case 'r': case 'R': if (hasTrack) { const m = player.cycleRepeat(); toast(m === 'all' ? '列表循环' : m === 'one' ? '单曲循环' : '不循环'); } break;
      case 'l': case 'L': { const t = player.getCurrent(); if (t) views.toggleLike(t); break; }
      case 'f': case 'F': if (hasTrack) np.toggleNP(); break;
      case 'q': case 'Q': np.toggleQueue(); break;
      case '/': {
        const inp = document.querySelector('.search-wrap input');
        if (inp) { e.preventDefault(); inp.focus(); }
        break;
      }
      case 'Escape':
        closeMenu();
        if (np.isQueueOpen()) np.toggleQueue(false);
        else if (np.isNPOpen()) np.closeNP();
        break;
    }
  });
}

// ---------- 调试钩子（自动化测试 / 高级用法） ----------
async function bindDebug() {
  window.__musicDebug = {
    async setRoot(handle) {
      await scanner.setFsaRoot(handle, { persist: false });
      await scanner.scan();
      await views.loadFromDB();
      views.setReconnectNeeded(false);
      views.render();
      return { tracks: (await db.getAllTracks()).length };
    },
    scanner, player, views, eq, np, db,
  };
  const [artMod, metaMod] = await Promise.all([import('./art.js'), import('./metadata.js')]);
  window.__musicDebug.art = artMod;
  window.__musicDebug.metadata = metaMod;
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 16px 16px;z-index:999" class="toast">启动失败：${String(e && e.message || e)}</div>`);
});

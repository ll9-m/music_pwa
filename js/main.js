// 入口：启动流程、全局事件、快捷键、Service Worker
import { loadPrefs, prefs, applyTheme } from './prefs.js';
import * as db from './db.js';
import * as scanner from './scanner.js';
import * as views from './views.js';
import * as np from './np.js';
import * as player from './player.js';
import * as eq from './eq.js';
import { toast, closeMenu } from './ui.js';

const audio = new Audio();
audio.preload = 'auto';
document.body.appendChild(audio);

async function boot() {
  loadPrefs();
  applyTheme(prefs().theme);

  views.init();
  np.init();

  player.init(audio, views.trackByRel, (a) => eq.ensureGraph(a));
  audio.addEventListener('play', () => eq.resumeCtx());

  scanner.onProgress(({ phase, done, total }) => {
    const bar = document.querySelector('#scanProgress .bar');
    if (!bar) return;
    if (phase === 'done') { bar.style.width = '0%'; return; }
    const pct = total ? Math.round((done / total) * 100) : (phase === 'collect' ? 30 : 5);
    bar.style.width = `${pct}%`;
    setTimeout(() => { if (bar.style.width === `${pct}%`) bar.style.width = '0%'; }, 400);
  });

  await db.openDB();
  await views.loadFromDB();
  views.render();

  // 恢复已授权的音乐文件夹
  const perm = await scanner.restoreSavedRoot();
  if (perm === 'granted') {
    if (prefs().scanAtBoot) {
      await scanner.scan();
      await views.loadFromDB();
    }
    views.setReconnectNeeded(false);
    views.render();
    await player.restoreState();
  } else if (perm === 'prompt' || perm === 'denied') {
    views.setReconnectNeeded(true);
    views.render();
  }

  registerSW();
  bindShortcuts();
  bindInstall();
  bindDebug();
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
      case '/': {
        const inp = document.querySelector('.search-wrap input');
        if (inp) { e.preventDefault(); inp.focus(); }
        break;
      }
      case 'Escape':
        closeMenu();
        if (np.isNPOpen()) np.closeNP();
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
  const artMod = await import('./art.js');
  const metaMod = await import('./metadata.js');
  window.__musicDebug.art = artMod;
  window.__musicDebug.metadata = metaMod;
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 16px 16px;z-index:999" class="toast">启动失败：${String(e && e.message || e)}</div>`);
});
